import { describe, expect, it } from 'vitest';
import { decide, type PolicyInput } from '../src/server/lifecycle.js';

const base: PolicyInput = { enabled: true, released: false, idleBehavior: 'off', active: false, streaming: false };

describe('lifecycle.decide', () => {
  it('enters streaming with turn on + brightness 100 + enable when a light comes on', () => {
    expect(decide({ ...base, active: true })).toEqual({
      actions: ['turn_on', 'brightness_max', 'enable'], streaming: true, frame: 'composite', mode: 'streaming',
    });
  });

  it('keeps streaming without repeating setup', () => {
    expect(decide({ ...base, active: true, streaming: true }).actions).toEqual([]);
  });

  it('idle "off": disable then turn off', () => {
    const d = decide({ ...base, streaming: true });
    expect(d.actions).toEqual(['disable', 'turn_off']);
    expect(d).toMatchObject({ streaming: false, frame: null, mode: 'idle' });
  });

  it('idle "release": disable only', () => {
    expect(decide({ ...base, idleBehavior: 'release', streaming: true }).actions).toEqual(['disable']);
  });

  it('idle "hold_black": keep streaming black', () => {
    expect(decide({ ...base, idleBehavior: 'hold_black' })).toMatchObject({
      actions: ['turn_on', 'brightness_max', 'enable'], streaming: true, frame: 'black',
    });
  });

  it('does nothing when idle and not streaming (e.g. at startup)', () => {
    expect(decide(base).actions).toEqual([]);
  });

  it('release overrides active lights and exits explicitly', () => {
    const d = decide({ ...base, released: true, active: true, streaming: true });
    expect(d).toEqual({ actions: ['disable'], streaming: false, frame: null, mode: 'released' });
  });

  it('resumes streaming when release is turned off', () => {
    expect(decide({ ...base, active: true, released: false, streaming: false }).actions).toEqual(['turn_on', 'brightness_max', 'enable']);
  });

  it('disabled device exits streaming', () => {
    expect(decide({ ...base, enabled: false, active: true, streaming: true }).actions).toEqual(['disable']);
  });

  it('never leaves streaming without an explicit disable', () => {
    for (const idleBehavior of ['off', 'hold_black', 'release'] as const)
      for (const released of [true, false])
        for (const enabled of [true, false])
          for (const active of [true, false]) {
            const d = decide({ enabled, released, idleBehavior, active, streaming: true });
            if (!d.streaming) expect(d.actions[0]).toBe('disable');
          }
  });
});
