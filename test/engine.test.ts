import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/server/engine.js';
import { Store } from '../src/server/store.js';
import type { Transport } from '../src/server/transport.js';

/** Records datagrams as short labels: enable, disable, turn:1, turn:0, bright:100, frame. */
function recorder() {
  const sent: string[] = [];
  const t: Transport = {
    async send(_ip, payload) {
      const msg = JSON.parse(payload.toString()).msg;
      if (msg.cmd === 'turn') sent.push(`turn:${msg.data.value}`);
      else if (msg.cmd === 'brightness') sent.push(`bright:${msg.data.value}`);
      else {
        const pt = Buffer.from(msg.data.pt, 'base64');
        sent.push(pt[3] === 0xb1 ? (pt[4] ? 'enable' : 'disable') : 'frame');
      }
    },
    async close() {},
  };
  return { sent, t };
}

function setup(idleBehavior: 'off' | 'hold_black' | 'release' = 'off') {
  const store = new Store(null);
  const { sent, t } = recorder();
  const engine = new Engine(store, t, pino({ level: 'silent' }));
  const device = store.addDevice({
    name: 's', ip: '10.0.0.2', ledCount: 20, maxColorsPerPacket: 84, keepaliveMs: 2000, enabled: true, idleBehavior,
  });
  const light = store.addLight({
    name: 'front', deviceId: device.id, ranges: [[0, 4]], priority: 0, capability: 'rgb',
    defaults: { color: [255, 0, 0], brightness: 255 }, transitionMs: 0,
  });
  engine.start();
  return { store, engine, sent, device, light };
}

describe('Engine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('enters streaming on light on, keeps alive, and exits with off', async () => {
    const { engine, sent, light } = setup();
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([]); // idle at start: nothing sent

    engine.command(light.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['turn:1', 'bright:100', 'enable', 'frame']);
    expect(engine.status(light.deviceId).mode).toBe('streaming');

    sent.length = 0;
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent).toEqual(['frame', 'frame']); // keepalive every 2 s

    sent.length = 0;
    engine.command(light.id, { state: 'OFF' });
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['disable', 'turn:0']);
    expect(engine.status(light.deviceId).mode).toBe('idle');

    sent.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([]);
  });

  it('release stops streaming but stores commands; un-release resumes', async () => {
    const { engine, sent, light, device, store } = setup();
    engine.command(light.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);

    sent.length = 0;
    engine.setReleased(device.id, true);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['disable']);
    expect(engine.status(device.id).mode).toBe('released');

    sent.length = 0;
    engine.command(light.id, { state: 'ON', color: { r: 0, g: 0, b: 255 } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
    expect(store.state(light.id).color).toEqual([0, 0, 255]);

    engine.setReleased(device.id, false);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['turn:1', 'bright:100', 'enable', 'frame']);
  });

  it('keeps streaming during a fade-out, then exits', async () => {
    const { engine, sent, light } = setup();
    engine.command(light.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    engine.command(light.id, { state: 'OFF', transition: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(sent.every((s) => s === 'frame')).toBe(true);
    expect(sent.length).toBeGreaterThan(5); // animation rate, not keepalive
    await vi.advanceTimersByTimeAsync(700);
    expect(sent.slice(-2)).toEqual(['disable', 'turn:0']);
  });

  it('hold_black keeps streaming when all lights are off', async () => {
    const { sent } = setup('hold_black');
    await vi.advanceTimersByTimeAsync(4100);
    expect(sent).toEqual(['turn:1', 'bright:100', 'enable', 'frame', 'frame', 'frame']);
  });

  it('identify takes over and then hands back to the idle policy', async () => {
    const { engine, sent, light } = setup();
    engine.identify(light.id, 1000);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent.slice(0, 3)).toEqual(['turn:1', 'bright:100', 'enable']);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sent.slice(-2)).toEqual(['disable', 'turn:0']);
  });

  it('re-asserts brightness 100 + enable every 30 s while streaming', async () => {
    const { engine, sent, light } = setup();
    engine.command(light.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(33_000); // first 2 s keepalive past the 30 s mark
    expect(sent.filter((s) => s !== 'frame')).toEqual(['bright:100', 'enable']);
  });

  it('applies white balance to sent frames', async () => {
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
      name: 's', ip: 'x', ledCount: 1, maxColorsPerPacket: 84, keepaliveMs: 2000, enabled: true, idleBehavior: 'off',
      whiteBalance: [80, 100, 50],
    });
    const l = store.addLight({
      name: 'l', deviceId: d.id, ranges: [[0, 0]], priority: 0, capability: 'rgb',
      defaults: { color: [200, 200, 200], brightness: 255 }, transitionMs: 0,
    });
    engine.command(l.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(100);
    expect(frames[0]).toEqual([160, 200, 100]);
  });

  it('clean shutdown exits streaming explicitly', async () => {
    const { engine, sent, light } = setup();
    engine.command(light.id, { state: 'ON' });
    await vi.advanceTimersByTimeAsync(50);
    sent.length = 0;
    await engine.stop();
    expect(sent).toEqual(['disable', 'turn:0']);
  });
});
