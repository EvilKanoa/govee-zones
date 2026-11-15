import { describe, expect, it } from 'vitest';
import { applyCommand, commandTransitionMs, defaultState } from '../src/server/commands.js';
import type { Capability, VirtualLight } from '../src/shared/types.js';

const light = (capability: Capability): VirtualLight => ({
  id: 'l', name: 'l', deviceId: 'd', ranges: [], priority: 0, capability,
  defaults: { color: [255, 180, 100], brightness: 200 }, transitionMs: 500, order: 0,
});

describe('applyCommand', () => {
  it('turning on with no parameters uses defaults', () => {
    const l = light('rgb');
    const prev = { on: false, brightness: 10, color: [1, 2, 3] as [number, number, number] };
    expect(applyCommand(l, prev, { state: 'ON' })).toEqual({ on: true, brightness: 200, color: [255, 180, 100] });
  });

  it('keeps current look when already on', () => {
    const l = light('rgb');
    const prev = { on: true, brightness: 10, color: [1, 2, 3] as [number, number, number] };
    expect(applyCommand(l, prev, { state: 'ON', brightness: 50 })).toEqual({ on: true, brightness: 50, color: [1, 2, 3] });
  });

  it('off keeps stored attributes', () => {
    const prev = { on: true, brightness: 10, color: [1, 2, 3] as [number, number, number] };
    expect(applyCommand(light('rgb'), prev, { state: 'OFF' })).toEqual({ ...prev, on: false });
  });

  it('onoff ignores brightness and color', () => {
    const s = applyCommand(light('onoff'), defaultState(light('onoff')), { state: 'ON', brightness: 1, color: { r: 0, g: 0, b: 255 } });
    expect(s).toEqual({ on: true, brightness: 200, color: [255, 180, 100] });
  });

  it('dimmable takes brightness but not color', () => {
    const s = applyCommand(light('dimmable'), defaultState(light('dimmable')), { state: 'ON', brightness: 9, color: { r: 0, g: 0, b: 255 } });
    expect(s).toEqual({ on: true, brightness: 9, color: [255, 180, 100] });
  });

  it('rgb_ct converts color temperature to RGB', () => {
    const s = applyCommand(light('rgb_ct'), defaultState(light('rgb_ct')), { state: 'ON', color_temp: 370 });
    expect(s.colorTemp).toBe(370);
    expect(s.color[0]).toBe(255);
    expect(s.color[2]).toBeLessThan(s.color[1]);
  });

  it('rgb ignores color_temp', () => {
    const s = applyCommand(light('rgb'), defaultState(light('rgb')), { state: 'ON', color_temp: 370 });
    expect(s.colorTemp).toBeUndefined();
  });

  it('attribute-only command does not turn an off light on', () => {
    const s = applyCommand(light('rgb'), defaultState(light('rgb')), { brightness: 5 });
    expect(s).toMatchObject({ on: false, brightness: 5 });
  });
});

describe('commandTransitionMs', () => {
  it('uses the command transition in seconds, else the light default', () => {
    expect(commandTransitionMs(light('rgb'), { transition: 2 })).toBe(2000);
    expect(commandTransitionMs(light('rgb'), {})).toBe(500);
  });
});
