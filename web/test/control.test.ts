import { describe, expect, it } from 'vitest';
import type { Device, VirtualLight } from '../../src/shared/types';
import { coverageLabel, modeExplanation, ownersTitle, roundedCoverage, roundingActive, roundingAt, snapSelection } from '../src/control';
import { rangesToSet } from '../src/ranges';

const dev = (p: Partial<Device> = {}): Device => ({
  id: 'd', name: 's', ip: 'x', ledCount: 60, maxColorsPerPacket: 84, keepaliveMs: 2000, enabled: true,
  groupSize: 4, control: 'auto', partialGroups: 'round', ...p,
});
let order = 0;
const light = (name: string, ranges: [number, number][], priority = 0): VirtualLight => ({
  id: name, name, deviceId: 'd', ranges, priority, capability: 'ct',
  defaults: { brightness: 255, look: { kind: 'white', mireds: 370 } }, transitionMs: 0, order: order++,
});
const exactCoverage = (lights: VirtualLight[], n = 60) => {
  const byLed: VirtualLight[][] = Array.from({ length: n }, () => []);
  for (const l of [...lights].sort((a, b) => a.priority - b.priority || a.order - b.order)) for (const i of rangesToSet(l.ranges)) byLed[i].push(l);
  return byLed;
};

describe('rounding display', () => {
  const gutter = light('Gutter', [[9, 14]]); // groups 2 (8-11, 3/4) and 3 (12-15, 3/4) → LEDs 8-15
  const tiny = light('Tiny', [[3, 4]]); // 1/4 of groups 0 and 1 → snaps to group 0 (LEDs 0-3)

  it('applies only when group control is usable and set to round', () => {
    expect(roundingActive(dev())).toBe(true);
    expect(roundingActive(dev({ partialGroups: 'exact' }))).toBe(false);
    expect(roundingActive(dev({ control: 'per_led' }))).toBe(false);
    expect(roundingActive(dev({ groupSize: 0 }))).toBe(false);
  });

  it('marks LEDs added and dropped by rounding', () => {
    const exact = exactCoverage([gutter, tiny]);
    const rounded = roundedCoverage(exact, [gutter, tiny], dev());
    const at = (i: number) => roundingAt(exact[i], rounded[i]);
    expect(at(8).added).toEqual([gutter]); // gained
    expect(at(15).added).toEqual([gutter]);
    expect(at(9)).toEqual({ added: [], dropped: [] }); // unchanged
    expect(at(16)).toEqual({ added: [], dropped: [] });
    expect(at(0).added).toEqual([tiny]); // tiny snaps onto group 0
    expect(at(4).dropped).toEqual([tiny]); // and loses LED 4
    expect(ownersTitle(exact[4], rounded[4])).toBe(' · Tiny (dropped by rounding)');
    expect(ownersTitle(exact[8], rounded[8])).toBe(' · Gutter (added by rounding)');
  });

  it('aligned lights change nothing', () => {
    const a = light('A', [[0, 7]]);
    const exact = exactCoverage([a]);
    const rounded = roundedCoverage(exact, [a], dev());
    expect(rounded.every((r, i) => roundingAt(exact[i], r).added.length + roundingAt(exact[i], r).dropped.length === 0)).toBe(true);
  });
});

describe('labels', () => {
  it('coverageLabel', () => {
    expect(coverageLabel(light('A', [[20, 27]]), dev()).text).toBe('groups 6–7');
    expect(coverageLabel(light('G', [[22, 29]]), dev()).text).toBe('LEDs 22-29 → groups 6–8');
    expect(coverageLabel(light('G', [[22, 29]]), dev({ partialGroups: 'exact' }))).toMatchObject({ text: 'LEDs 22-29', warn: true });
    expect(coverageLabel(light('G', [[22, 29]]), dev({ groupSize: 0 })).text).toBe('LEDs 22-29');
  });

  it('snapSelection expands to whole groups', () => {
    expect([...snapSelection(new Set([5, 6]), dev())].sort((a, b) => a - b)).toEqual([4, 5, 6, 7]);
  });

  it('modeExplanation', () => {
    expect(modeExplanation({ mode: 'groups', reason: 'auto' })).toBe('Real white. The strip holds its lights on its own.');
    expect(modeExplanation({ mode: 'per_led', reason: 'exact_leds', detail: ['Gutter'] })).toBe(
      'Gutter uses exact LEDs and is on. White is mixed from RGB until it turns off.',
    );
    expect(modeExplanation({ mode: 'per_led', reason: 'override', detail: ['pixel finder'] })).toBe('Pixel finder running. Returns to Groups when done.');
  });
});
