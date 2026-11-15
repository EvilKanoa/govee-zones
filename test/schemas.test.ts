import { describe, expect, it } from 'vitest';
import { checkLight, configImport, deviceInput, devicePatch, lightInput, lightPatch } from '../src/server/schemas.js';

describe('schemas', () => {
  it('patches contain only the fields sent (no defaults injected)', () => {
    expect(devicePatch.parse({ name: 'x' })).toEqual({ name: 'x' });
    expect(devicePatch.parse({ groupSize: 2 })).toEqual({ groupSize: 2 });
    expect(lightPatch.parse({ ranges: [[0, 3]] })).toEqual({ ranges: [[0, 3]] });
  });

  it('inputs fill defaults, including group control', () => {
    expect(deviceInput.parse({ name: 'a', ip: '1.2.3.4', ledCount: 60 })).toMatchObject({
      maxColorsPerPacket: 84, keepaliveMs: 2000, enabled: true, groupSize: 4, control: 'auto', partialGroups: 'round',
    });
    expect(lightInput.parse({ name: 'l', deviceId: 'd' })).toMatchObject({
      priority: 0, capability: 'ct', transitionMs: 500, defaults: { brightness: 255, look: { kind: 'white', mireds: 370 } },
    });
  });

  it('rejects removed capabilities and fields', () => {
    expect(() => lightInput.parse({ name: 'l', deviceId: 'd', capability: 'rgb_ct' })).toThrow();
    expect(() => lightInput.parse({ name: 'l', deviceId: 'd', capability: 'dimmable' })).toThrow();
    // idleBehavior is dropped (unknown keys are stripped), not kept.
    expect(deviceInput.parse({ name: 'a', ip: 'x', ledCount: 1, idleBehavior: 'off' })).not.toHaveProperty('idleBehavior');
  });

  it('limits white to 2700-6500 K (154-370 mireds)', () => {
    const white = (mireds: number) => lightInput.safeParse({ name: 'l', deviceId: 'd', defaults: { brightness: 255, look: { kind: 'white', mireds } } }).success;
    expect(white(154)).toBe(true);
    expect(white(370)).toBe(true);
    expect(white(153)).toBe(false);
    expect(white(500)).toBe(false);
  });

  it('checkLight: rgb needs a color default, ct a white one, onoff either', () => {
    const l = (capability: string, kind: 'rgb' | 'white') => ({ name: 'l', capability, defaults: { look: { kind } } });
    expect(() => checkLight(l('rgb', 'white'))).toThrow(/color/);
    expect(() => checkLight(l('ct', 'rgb'))).toThrow(/white/);
    expect(() => checkLight(l('onoff', 'rgb'))).not.toThrow();
    expect(() => checkLight(l('onoff', 'white'))).not.toThrow();
  });

  it('config import validates every light', () => {
    expect(configImport.safeParse({ version: 1, devices: [], lights: [{ id: 'x', name: 'n', deviceId: 'd', capability: 'dimmable' }] }).success).toBe(false);
  });
});
