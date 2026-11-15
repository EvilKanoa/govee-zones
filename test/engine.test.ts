import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/server/engine.js';
import { Store } from '../src/server/store.js';
import { describeSegmentFrame, type Transport } from '../src/server/transport.js';
import type { Device } from '../src/shared/types.js';

/**
 * Records datagrams as short labels: enable, disable, turn:1, turn:0, bright:100,
 * frame (razer), and one `g <groups> <what>` per segment frame (groups from 1).
 */
function recorder() {
  const sent: string[] = [];
  const ips: string[] = [];
  const t: Transport = {
    async send(ip, payload) {
      const msg = JSON.parse(payload.toString()).msg;
      ips.push(ip);
      if (msg.cmd === 'turn') sent.push(`turn:${msg.data.value}`);
      else if (msg.cmd === 'brightness') sent.push(`bright:${msg.data.value}`);
      else if (msg.cmd === 'ptReal') for (const b of msg.data.command as string[]) sent.push(`g ${describeSegmentFrame(Buffer.from(b, 'base64'))}`);
      else {
        const pt = Buffer.from(msg.data.pt, 'base64');
        sent.push(pt[3] === 0xb1 ? (pt[4] ? 'enable' : 'disable') : 'frame');
      }
    },
    async close() {},
  };
  return { sent, ips, t };
}

const isGroup = (s: string) => s.startsWith('g ');

/** The house strip: 60 LEDs in 15 groups of 4, three aligned White lights. */
function setup(p: Partial<Device> = {}, store = new Store(null)) {
  const { sent, ips, t } = recorder();
  const engine = new Engine(store, t, pino({ level: 'silent' }));
  const device = store.devices[0] ?? store.addDevice({
    name: 's', ip: '10.0.0.2', ledCount: 60, maxColorsPerPacket: 84, keepaliveMs: 2000, enabled: true,
    groupSize: 4, control: 'auto', partialGroups: 'round', ...p,
  });
  const ct = (name: string, ranges: [number, number][]) =>
    store.lights.find((l) => l.name === name) ??
    store.addLight({ name, deviceId: device.id, ranges, priority: 0, capability: 'ct', defaults: { brightness: 255, look: { kind: 'white', mireds: 370 } }, transitionMs: 0 });
  const A = ct('A', [[0, 7]]); // groups 1-2
  const B = ct('B', [[20, 27]]); // groups 6-7
  engine.start();
  return { store, engine, sent, ips, device, A, B };
}

describe('Engine: group control', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('E1 enters group mode: brightness, frames, then turn on; never razer', async () => {
    const { engine, sent, A, device } = setup();
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([]); // idle at start: nothing sent

    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['bright:100', 'g 1-2 white 2703K', 'g 3-15 off', 'g 1-2 100%', 'turn:1']);
    expect(engine.status(device.id)).toEqual({ mode: 'groups', reason: 'auto', groups: 15 });
  });

  it('E2 re-sends brightness, the full state and turn on every 30 s, nothing in between', async () => {
    const { engine, sent, A } = setup();
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(29_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    // turn_on last: undoes a power-off from the Govee app without leaving the strip half-off.
    expect(sent).toEqual(['bright:100', 'g 1-2 white 2703K', 'g 3-15 off', 'g 1-2 100%', 'turn:1']);
  });

  it('E3 sends only what changed', async () => {
    const { engine, sent, A, B } = setup();
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    engine.command(A.id, { brightness: 128 });
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual(['g 1-2 50%']);
    sent.length = 0;
    engine.command(B.id, { state: 'ON', color_temp: 154 });
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual(['g 6-7 white 6494K', 'g 6-7 100%']);
  });

  it('E4 all off (instant): turn off, and nothing after it', async () => {
    const { engine, sent, A, device } = setup();
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    engine.command(A.id, { state: 'OFF' });
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual(['turn:0']);
    expect(engine.status(device.id).mode).toBe('idle');
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual([]);
  });

  it('E4b fade-out in group mode: stepped brightness, then turn off as the very last datagram', async () => {
    const { engine, sent, A } = setup();
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    engine.command(A.id, { state: 'OFF', transition: 1 });
    await vi.advanceTimersByTimeAsync(1500);
    const steps = sent.filter((s) => / \d+%$/.test(s) && s !== 'g 1-2 100%');
    expect(steps.length).toBeGreaterThanOrEqual(8); // ~10 steps, 100 ms apart
    const pcts = steps.map((s) => Number(/(\d+)%$/.exec(s)![1]));
    expect(pcts).toEqual([...pcts].sort((a, b) => b - a)); // monotonic
    expect(sent.at(-1)).toBe('turn:0'); // segment frames after turn off would turn the strip back on
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual([]);
  });

  it('E6/E7 a partial light: Round keeps group mode, Exact switches to per-LED', async () => {
    for (const partialGroups of ['round', 'exact'] as const) {
      const { engine, sent, store, device } = setup({ partialGroups });
      const P = store.addLight({ name: 'Gutter', deviceId: device.id, ranges: [[8, 13]], priority: 1, capability: 'rgb', defaults: { brightness: 255, look: { kind: 'rgb', color: [255, 0, 0] } }, transitionMs: 0 });
      engine.command(P.id, { state: 'ON' });
      await vi.advanceTimersByTimeAsync(100);
      if (partialGroups === 'round') {
        expect(sent).not.toContain('enable');
        expect(sent).toContain('g 3-4 rgb #ff0000'); // [8,13] rounds to groups 3-4
      } else {
        expect(sent).toEqual(['turn:1', 'bright:100', 'enable', 'frame']);
        expect(engine.status(device.id)).toMatchObject({ mode: 'per_led', reason: 'exact_leds', detail: ['Gutter'] });
      }
      await engine.stop();
    }
  });

  it('E5 per-LED fade-out (exact light): razer to black, darken groups, disable, turn off', async () => {
    const { engine, sent, store, device } = setup({ partialGroups: 'exact' });
    const P = store.addLight({ name: 'Gutter', deviceId: device.id, ranges: [[8, 13]], priority: 1, capability: 'rgb', defaults: { brightness: 255, look: { kind: 'rgb', color: [255, 0, 0] } }, transitionMs: 0 });
    engine.command(P.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(100);
    sent.length = 0;
    engine.command(P.id, { state: 'OFF', transition: 1 });
    await vi.advanceTimersByTimeAsync(1500);
    const exit = sent.indexOf('disable');
    expect(sent.slice(0, exit - 1).every((s) => s === 'frame')).toBe(true); // R5: razer until the fade ends
    expect(sent.slice(exit - 1)).toEqual(['g 1-15 off', 'disable', 'turn:0']);
    expect(engine.status(device.id).mode).toBe('idle');
  });

  it('E5b per-LED only: all off is disable + turn off, never a segment frame', async () => {
    const { engine, sent, A } = setup({ control: 'per_led' });
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    engine.command(A.id, { state: 'OFF' });
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual(['turn:1', 'bright:100', 'enable', 'frame', 'disable', 'turn:0']);
  });

  it('fade_finishing: groups are wanted while another light is fading → finish per-LED first (R5)', async () => {
    const { engine, sent, store, device, A } = setup({ partialGroups: 'exact' });
    const P = store.addLight({ name: 'Gutter', deviceId: device.id, ranges: [[8, 13]], priority: 1, capability: 'rgb', defaults: { brightness: 255, look: { kind: 'rgb', color: [255, 0, 0] } }, transitionMs: 0 });
    engine.command(A.id, { state: 'ON' });
    engine.command(P.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(100);
    expect(engine.status(device.id)).toMatchObject({ mode: 'per_led', reason: 'exact_leds' });
    engine.command(P.id, { state: 'OFF', transition: 0 }); // the exact light is gone…
    engine.command(A.id, { brightness: 128, transition: 1 }); // …but A is fading
    await vi.advanceTimersByTimeAsync(300);
    expect(engine.status(device.id)).toMatchObject({ mode: 'per_led', reason: 'fade_finishing' });
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.slice(0, sent.indexOf('disable')).every((s) => s === 'frame')).toBe(true);
    expect(sent.slice(sent.indexOf('disable'))).toEqual(['disable', 'g 1-2 white 2703K', 'g 3-15 off', 'g 1-2 50%']);
    expect(engine.status(device.id)).toMatchObject({ mode: 'groups', reason: 'auto' });
  });

  it('E8 identify blinks the rounded groups in group mode; no razer', async () => {
    const { engine, sent, A } = setup();
    engine.identify(A.id, 3000);
    await vi.advanceTimersByTimeAsync(3500);
    expect(sent).not.toContain('enable');
    expect(sent.filter((s) => s === 'g 1-2 white 6500K').length).toBeGreaterThanOrEqual(2);
    expect(sent.filter((s) => s === 'g 1-2 off').length).toBeGreaterThanOrEqual(2);
    expect(sent.at(-1)).toBe('turn:0'); // nothing was on: back to off, nothing after
  });

  it('E9 pixel finder switches to per-LED and back, without turning off', async () => {
    const { engine, sent, A, device } = setup();
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    engine.pixel(device.id, 5, 1000);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual(['enable', 'frame']);
    expect(engine.status(device.id)).toMatchObject({ mode: 'per_led', reason: 'override', detail: ['pixel finder'] });
    await vi.advanceTimersByTimeAsync(1000);
    // I2: no segment frame between enable and disable.
    expect(sent.slice(0, sent.indexOf('disable')).some(isGroup)).toBe(false);
    expect(sent.slice(sent.indexOf('disable'))).toEqual(['disable', 'g 1-2 white 2703K', 'g 3-15 off', 'g 1-2 100%']);
    expect(sent).not.toContain('turn:0');
  });

  it('E12/E22 more than 24 groups → per-LED (too_many_groups), also when edited live', async () => {
    const { engine, store, A, device } = setup();
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    store.updateDevice(device.id, { groupSize: 2 }); // 30 groups
    await vi.advanceTimersByTimeAsync(200);
    expect(engine.status(device.id)).toMatchObject({ mode: 'per_led', reason: 'too_many_groups' });
    expect(engine.status(device.id).groups).toBeUndefined();
  });

  it('E13 release in group mode sends nothing; un-release re-sends the full state', async () => {
    const { engine, sent, A, device, store } = setup();
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    engine.setReleased(device.id, true);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([]);
    expect(engine.status(device.id).mode).toBe('released');

    engine.command(A.id, { brightness: 128 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
    expect(store.state(A.id).brightness).toBe(128);

    engine.setReleased(device.id, false);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual(['bright:100', 'g 1-2 white 2703K', 'g 3-15 off', 'g 1-2 50%', 'turn:1']);
  });

  it('E14 clean shutdown in group mode sends nothing (the strip keeps its lights)', async () => {
    const { engine, sent, A } = setup();
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    await engine.stop();
    expect(sent).toEqual([]);
  });

  it('E15 clean shutdown in per-LED mode: darken, disable, turn off', async () => {
    const { engine, sent, A, device } = setup();
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    engine.pixel(device.id, 0);
    await vi.advanceTimersByTimeAsync(100);
    sent.length = 0;
    await engine.stop();
    expect(sent).toEqual(['g 1-15 off', 'disable', 'turn:0']);
  });

  it('E16 restart with a light on: frames before turn on, no razer, no turn off', async () => {
    const first = setup();
    first.engine.command(first.A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    await first.engine.stop();
    const second = setup({}, first.store);
    await vi.advanceTimersByTimeAsync(50);
    expect(second.sent).toEqual(['bright:100', 'g 1-2 white 2703K', 'g 3-15 off', 'g 1-2 100%', 'turn:1']);
  });

  it('E18 bursts of commands coalesce to ≤ 1 update per 100 ms', async () => {
    const { engine, sent, A } = setup();
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(150);
    sent.length = 0;
    for (let i = 0; i < 20; i++) {
      engine.command(A.id, { brightness: 100 + i });
      await vi.advanceTimersByTimeAsync(2);
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(sent.length).toBeLessThanOrEqual(2);
    expect(sent.at(-1)).toBe('g 1-2 47%'); // brightness 119
  });

  it('E21 IP change in group mode: nothing to the old IP, re-entry at the new one', async () => {
    const { engine, ips, sent, A, device, store } = setup();
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    ips.length = 0;
    store.updateDevice(device.id, { ip: '10.0.0.9' });
    await vi.advanceTimersByTimeAsync(200);
    expect(new Set(ips)).toEqual(new Set(['10.0.0.9']));
    expect(sent).toEqual(['bright:100', 'g 1-2 white 2703K', 'g 3-15 off', 'g 1-2 100%', 'turn:1']);
  });

  it('applies white balance to RGB groups, not to white', async () => {
    const { engine, sent, store, device } = setup();
    store.updateDevice(device.id, { whiteBalance: [80, 100, 50] });
    const R = store.addLight({ name: 'R', deviceId: device.id, ranges: [[56, 59]], priority: 0, capability: 'rgb', defaults: { brightness: 255, look: { kind: 'rgb', color: [200, 200, 200] } }, transitionMs: 0 });
    engine.command(R.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toContain('g 15 rgb #a0c864');
  });
});

describe('Engine: per-LED only (groups off)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('E11 streams, keeps alive, and exits with disable + turn off', async () => {
    const { engine, sent, A, device } = setup({ groupSize: 0 });
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['turn:1', 'bright:100', 'enable', 'frame']);
    expect(engine.status(device.id)).toMatchObject({ mode: 'per_led', reason: 'groups_off' });

    sent.length = 0;
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent).toEqual(['frame', 'frame']); // keepalive every 2 s

    sent.length = 0;
    engine.command(A.id, { state: 'OFF' });
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['disable', 'turn:0']);
  });

  it('release stops streaming but stores commands; un-release resumes', async () => {
    const { engine, sent, A, device, store } = setup({ groupSize: 0 });
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    engine.setReleased(device.id, true);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['disable']);
    engine.command(A.id, { brightness: 10 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.state(A.id).brightness).toBe(10);
    engine.setReleased(device.id, false);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent.slice(1)).toEqual(['turn:1', 'bright:100', 'enable', 'frame']);
  });

  it('keeps streaming during a fade-out at animation rate, then exits', async () => {
    const { engine, sent, A } = setup({ groupSize: 0 });
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    engine.command(A.id, { state: 'OFF', transition: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(sent.every((s) => s === 'frame')).toBe(true);
    expect(sent.length).toBeGreaterThan(5);
    await vi.advanceTimersByTimeAsync(700);
    expect(sent.slice(-2)).toEqual(['disable', 'turn:0']);
  });

  it('re-asserts brightness 100 + enable every 30 s', async () => {
    const { engine, sent, A } = setup({ groupSize: 0 });
    engine.command(A.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(33_000);
    expect(sent.filter((s) => s !== 'frame')).toEqual(['bright:100', 'enable']);
  });

  it('applies white balance to razer frames', async () => {
    const store = new Store(null);
    const frames: number[][] = [];
    const t: Transport = {
      async send(_ip, payload) {
        const msg = JSON.parse(payload.toString()).msg;
        const pt = msg.cmd === 'razer' ? Buffer.from(msg.data.pt, 'base64') : null;
        if (pt && pt[3] === 0xb0) frames.push([...pt.subarray(6, 9)]);
      },
      async close() {},
    };
    const engine = new Engine(store, t, pino({ level: 'silent' }));
    const d = store.addDevice({
      name: 's', ip: 'x', ledCount: 1, maxColorsPerPacket: 84, keepaliveMs: 2000, enabled: true,
      groupSize: 0, control: 'auto', partialGroups: 'round', whiteBalance: [80, 100, 50],
    });
    const l = store.addLight({
      name: 'l', deviceId: d.id, ranges: [[0, 0]], priority: 0, capability: 'rgb',
      defaults: { brightness: 255, look: { kind: 'rgb', color: [200, 200, 200] } }, transitionMs: 0,
    });
    engine.command(l.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(100);
    expect(frames[0]).toEqual([160, 200, 100]);
  });
});
