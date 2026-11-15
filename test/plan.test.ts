import { describe, expect, it } from 'vitest';
import { startTransition, visualAt, type RenderState } from '../src/server/compositor.js';
import { groupLooks, plan, type GroupLook, type PlanOverride } from '../src/server/plan.js';
import type { Device, LightState, Look, VirtualLight } from '../src/shared/types.js';

// The house strip: 60 LEDs in 15 groups of 4.
const dev = (p: Partial<Device> = {}): Device => ({
  id: 'd', name: 's', ip: 'x', ledCount: 60, maxColorsPerPacket: 84, keepaliveMs: 2000, enabled: true,
  groupSize: 4, control: 'auto', partialGroups: 'round', ...p,
});
let order = 0;
const light = (id: string, ranges: [number, number][], p: Partial<VirtualLight> = {}): VirtualLight => ({
  id, name: id, deviceId: 'd', ranges, priority: 0, capability: 'ct',
  defaults: { brightness: 255, look: { kind: 'white', mireds: 370 } }, transitionMs: 0, order: order++, ...p,
});
const white = (mireds: number): Look => ({ kind: 'white', mireds });
const rgbLook = (r: number, g: number, b: number): Look => ({ kind: 'rgb', color: [r, g, b] });
const st = (look: Look, brightness = 255, on = true): RenderState => ({ on, brightness, look });
const OFF: GroupLook = { kind: 'off' };
const offs = (n: number) => Array<GroupLook>(n).fill(OFF);

describe('plan: control decision', () => {
  const A = light('A', [[0, 7]]); // groups 0-1, aligned
  const P = light('P', [[8, 13]]); // group 2 + half of 3: not aligned
  const visibleSets = {
    none: {},
    aligned: { A: st(white(370)) },
    'aligned+partial': { A: st(white(370)), P: st(white(370)) },
  } as const;
  const overrides: Record<string, PlanOverride | undefined> = {
    none: undefined,
    identify: { name: 'identify', needsLeds: false },
    pixel: { name: 'pixel finder', needsLeds: true },
  };

  it.each([
    // size, leds, control, partial, visible, override → control, reason
    [0, 60, 'auto', 'round', 'aligned', 'none', 'per_led', 'groups_off'],
    [4, 200, 'auto', 'round', 'aligned', 'none', 'per_led', 'too_many_groups'],
    [4, 60, 'per_led', 'round', 'aligned', 'none', 'per_led', 'per_led_setting'],
    [4, 60, 'auto', 'round', 'aligned+partial', 'none', 'groups', undefined],
    [4, 60, 'auto', 'exact', 'aligned+partial', 'none', 'per_led', 'exact_leds'],
    [4, 60, 'auto', 'exact', 'aligned', 'none', 'groups', undefined],
    [4, 60, 'auto', 'exact', 'none', 'none', 'groups', undefined],
    [4, 60, 'auto', 'round', 'aligned', 'identify', 'groups', undefined],
    [4, 60, 'auto', 'round', 'aligned', 'pixel', 'per_led', 'override'],
    [0, 60, 'auto', 'round', 'aligned', 'identify', 'per_led', 'groups_off'],
  ] as const)('size %i, %i LEDs, %s, %s, %s, override %s → %s %s', (groupSize, ledCount, control, partialGroups, vis, ov, want, reason) => {
    const r = plan(dev({ groupSize, ledCount, control, partialGroups }), [A, P], visibleSets[vis], 0, overrides[ov]);
    expect(r.control).toBe(want);
    if (r.control === 'per_led') expect(r.reason).toBe(reason);
  });

  it('exact_leds names the lights that force per-LED', () => {
    const r = plan(dev({ partialGroups: 'exact' }), [A, P], visibleSets['aligned+partial'], 0);
    expect(r).toEqual({ control: 'per_led', reason: 'exact_leds', detail: ['P'] });
  });

  it('full cross-product follows the rule order (144 cases)', () => {
    let n = 0;
    for (const groupSize of [0, 4])
      for (const ledCount of [60, 200])
        for (const control of ['auto', 'per_led'] as const)
          for (const partialGroups of ['round', 'exact'] as const)
            for (const vis of Object.keys(visibleSets) as (keyof typeof visibleSets)[])
              for (const ov of Object.keys(overrides)) {
                n++;
                const r = plan(dev({ groupSize, ledCount, control, partialGroups }), [A, P], visibleSets[vis], 0, overrides[ov]);
                const expected =
                  groupSize === 0 ? 'groups_off'
                  : ledCount === 200 ? 'too_many_groups'
                  : control === 'per_led' ? 'per_led_setting'
                  : ov === 'pixel' ? 'override'
                  : partialGroups === 'exact' && vis === 'aligned+partial' ? 'exact_leds'
                  : 'groups';
                expect(r.control === 'groups' ? 'groups' : r.reason).toBe(expected);
              }
    expect(n).toBe(144);
  });
});

describe('group looks per capability (light on groups 0-1)', () => {
  it.each<[string, Partial<VirtualLight>, LightState | null, GroupLook]>([
    ['onoff, color default', { capability: 'onoff', defaults: { brightness: 255, look: rgbLook(255, 0, 0) } }, null, { kind: 'rgb', rgb: [255, 0, 0], pct: 100 }],
    ['onoff, white default', { capability: 'onoff', defaults: { brightness: 255, look: white(370) } }, null, { kind: 'white', kelvin: 2703, pct: 100 }],
    ['onoff, white default at bri 128', { capability: 'onoff', defaults: { brightness: 128, look: white(370) } }, null, { kind: 'white', kelvin: 2703, pct: 50 }],
    ['ct at bri 1 (never 0 while on)', {}, st(white(370), 1), { kind: 'white', kelvin: 2703, pct: 1 }],
    ['ct at bri 0 (still lit at the minimum)', {}, st(white(370), 0), { kind: 'white', kelvin: 2703, pct: 1 }],
    ['rgb', { capability: 'rgb' }, st(rgbLook(0, 255, 0)), { kind: 'rgb', rgb: [0, 255, 0], pct: 100 }],
    ['ct 4000 K', {}, st(white(250)), { kind: 'white', kelvin: 4000, pct: 100 }],
  ])('%s', (_name, p, state, expected) => {
    const l = light('L', [[0, 7]], p);
    const s = state ?? { on: true, brightness: l.defaults.brightness, look: l.defaults.look };
    expect(groupLooks(dev(), [l], { L: s }, 0)).toEqual([expected, expected, ...offs(13)]);
  });

  it('a light that is off leaves its groups off', () => {
    expect(groupLooks(dev(), [light('L', [[0, 7]])], { L: st(white(370), 255, false) }, 0)).toEqual(offs(15));
  });

  it('rounds partial ranges onto groups', () => {
    const looks = groupLooks(dev(), [light('L', [[2, 9]])], { L: st(white(370)) }, 0); // groups 0 (2/4), 1, 2 (2/4)
    expect(looks.slice(0, 4).map((l) => l.kind)).toEqual(['white', 'white', 'white', 'off']);
  });
});

describe('layering', () => {
  const A = light('A', [[0, 15]], { priority: 0 }); // groups 0-3
  const B = light('B', [[8, 23]], { priority: 1, capability: 'rgb' }); // groups 2-5
  const red: GroupLook = { kind: 'rgb', rgb: [255, 0, 0], pct: 100 };
  const w: GroupLook = { kind: 'white', kelvin: 2703, pct: 100 };

  it('higher priority wins where lights overlap', () => {
    expect(groupLooks(dev(), [A, B], { A: st(white(370)), B: st(rgbLook(255, 0, 0)) }, 0)).toEqual([w, w, red, red, red, red, ...offs(9)]);
  });

  it('a light that is off reveals the one beneath', () => {
    expect(groupLooks(dev(), [A, B], { A: st(white(370)), B: st(rgbLook(255, 0, 0), 255, false) }, 0)).toEqual([w, w, w, w, ...offs(11)]);
  });

  it('equal priority: the later-created light wins', () => {
    const X = light('X', [[0, 3]]);
    const Y = light('Y', [[0, 3]], { capability: 'rgb' });
    expect(groupLooks(dev(), [Y, X], { X: st(white(370)), Y: st(rgbLook(255, 0, 0)) }, 0)[0]).toEqual(red);
  });

  it('a rounded light wins a group another light covers exactly', () => {
    const C = light('C', [[2, 5]], { priority: 2, capability: 'rgb' }); // rounds to groups 0-1
    expect(groupLooks(dev(), [A, C], { A: st(white(370)), C: st(rgbLook(255, 0, 0)) }, 0).slice(0, 3)).toEqual([red, red, w]);
  });
});

describe('fades in group mode (1000 ms)', () => {
  const L = light('L', [[0, 3]]);
  /** Group 0's look at each checkpoint for a command taking `prev` → `next`. */
  const checkpoints = (prev: LightState, next: LightState, lights = [L], extra: Record<string, RenderState> = {}) => {
    const t = startTransition(visualAt(prev, 0), next, 1000, 0)!;
    return [0, 250, 500, 750, 1000].map((now) => groupLooks(dev(), lights, { ...extra, L: { ...next, transition: t } }, now)[0]);
  };
  const wh = (kelvin: number, pct: number): GroupLook => ({ kind: 'white', kelvin, pct });

  it('off → on fades brightness in at a constant kelvin', () => {
    expect(checkpoints(st(white(370), 255, false), st(white(370)))).toEqual([OFF, wh(2703, 25), wh(2703, 50), wh(2703, 75), wh(2703, 100)]);
  });

  it('on → off fades out, then off', () => {
    expect(checkpoints(st(white(370)), st(white(370), 255, false))).toEqual([wh(2703, 100), wh(2703, 75), wh(2703, 50), wh(2703, 25), OFF]);
  });

  it('brightness 255 → 51', () => {
    expect(checkpoints(st(white(370)), st(white(370), 51)).map((l) => (l.kind === 'white' ? l.pct : 0))).toEqual([100, 80, 60, 40, 20]);
  });

  it('2700 → 6500 K interpolates in mireds (370 → 316 → 262 → 208 → 154)', () => {
    expect(checkpoints(st(white(370)), st(white(154))).map((l) => (l.kind === 'white' ? l.kelvin : 0))).toEqual([2703, 3165, 3817, 4808, 6494]);
  });

  it('rgb red → blue lerps RGB', () => {
    expect(checkpoints(st(rgbLook(255, 0, 0)), st(rgbLook(0, 0, 255)))[2]).toEqual({ kind: 'rgb', rgb: [128, 0, 128], pct: 100 });
  });

  it('fading in from off starts at the target look, with no color sweep', () => {
    const looks = checkpoints(st(rgbLook(255, 0, 0), 255, false), st(white(370)));
    expect(looks.slice(1).every((l) => l.kind === 'white')).toBe(true);
  });

  it('a white light fading out over an RGB light: blends brightness, swaps look at half opacity', () => {
    const base = light('base', [[0, 3]], { priority: 0, capability: 'rgb' });
    const top = light('L', [[0, 3]], { priority: 1 });
    const looks = checkpoints(st(white(370), 255), st(white(370), 255, false), [base, top], { base: st(rgbLook(255, 0, 0), 51) });
    expect(looks[1]).toEqual(wh(2703, 80)); // 0.75 × 100 + 0.25 × 20
    expect(looks[3]).toEqual({ kind: 'rgb', rgb: [255, 0, 0], pct: 40 }); // 0.25 × 100 + 0.75 × 20
    expect(looks[4]).toEqual({ kind: 'rgb', rgb: [255, 0, 0], pct: 20 });
  });
});
