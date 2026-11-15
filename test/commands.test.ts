import { describe, expect, it } from 'vitest';
import { applyCommand, commandTransitionMs, defaultState } from '../src/server/commands.js';
import type { Capability, LightState, Look, VirtualLight } from '../src/shared/types.js';

const light = (capability: Capability, look: Look = capability === 'rgb' ? { kind: 'rgb', color: [255, 180, 100] } : { kind: 'white', mireds: 370 }, brightness = 200): VirtualLight => ({
  id: 'l', name: 'l', deviceId: 'd', ranges: [], priority: 0, capability,
  defaults: { brightness, look }, transitionMs: 400, order: 0,
});
const off = (l: VirtualLight): LightState => defaultState(l);

describe('applyCommand', () => {
  it('turning on with no parameters restores the defaults', () => {
    const l = light('ct');
    const prev: LightState = { on: false, brightness: 9, look: { kind: 'white', mireds: 154 } };
    expect(applyCommand(l, prev, { state: 'ON' })).toEqual({ on: true, brightness: 200, look: { kind: 'white', mireds: 370 } });
  });

  it('OFF keeps the look and brightness', () => {
    const l = light('rgb');
    const on: LightState = { on: true, brightness: 50, look: { kind: 'rgb', color: [1, 2, 3] } };
    expect(applyCommand(l, on, { state: 'OFF' })).toEqual({ ...on, on: false });
  });

  it('attribute-only commands never turn a light on', () => {
    expect(applyCommand(light('ct'), off(light('ct')), { brightness: 10 })).toMatchObject({ on: false, brightness: 10 });
  });

  it('ct: brightness and color_temp (clamped to 2700-6500 K), ignores color', () => {
    const l = light('ct');
    const s = applyCommand(l, off(l), { state: 'ON', brightness: 100, color_temp: 250, color: { r: 255, g: 0, b: 0 } });
    expect(s).toEqual({ on: true, brightness: 100, look: { kind: 'white', mireds: 250 } });
    expect(applyCommand(l, s, { color_temp: 500 }).look).toEqual({ kind: 'white', mireds: 370 });
    expect(applyCommand(l, s, { color_temp: 100 }).look).toEqual({ kind: 'white', mireds: 154 });
  });

  it('rgb: brightness and color, ignores color_temp', () => {
    const l = light('rgb');
    const s = applyCommand(l, off(l), { state: 'ON', color: { r: 300, g: -5, b: 7.6 }, color_temp: 250 });
    expect(s.look).toEqual({ kind: 'rgb', color: [255, 0, 8] });
  });

  it('onoff: always its fixed look and brightness', () => {
    const l = light('onoff', { kind: 'white', mireds: 300 }, 128);
    expect(applyCommand(l, off(l), { state: 'ON', brightness: 10, color_temp: 154, color: { r: 1, g: 2, b: 3 } })).toEqual({
      on: true, brightness: 128, look: { kind: 'white', mireds: 300 },
    });
  });
});

describe('commandTransitionMs', () => {
  it('explicit transition (s) wins over the light default', () => {
    expect(commandTransitionMs(light('ct'), {})).toBe(400);
    expect(commandTransitionMs(light('ct'), { transition: 2 })).toBe(2000);
    expect(commandTransitionMs(light('ct'), { transition: 0 })).toBe(0);
  });
});
