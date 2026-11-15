import { describe, expect, it } from 'vitest';
import { deviceInput, devicePatch, lightInput, lightPatch } from '../src/server/schemas.js';

describe('schemas', () => {
  it('patches contain only the fields sent (no defaults injected)', () => {
    expect(devicePatch.parse({ name: 'x' })).toEqual({ name: 'x' });
    expect(lightPatch.parse({ ranges: [[0, 3]] })).toEqual({ ranges: [[0, 3]] });
  });

  it('inputs fill defaults', () => {
    expect(deviceInput.parse({ name: 'a', ip: '1.2.3.4', ledCount: 60 })).toMatchObject({
      maxColorsPerPacket: 84, keepaliveMs: 2000, enabled: true, idleBehavior: 'off',
    });
    expect(lightInput.parse({ name: 'l', deviceId: 'd' })).toMatchObject({ priority: 0, capability: 'rgb', transitionMs: 500 });
  });
});
