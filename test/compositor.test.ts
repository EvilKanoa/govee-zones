import { describe, expect, it } from 'vitest';
import {
  applyWhiteBalance,
  composite,
  downsample,
  lookAt,
  startTransition,
  targetLook,
  type RenderState,
} from '../src/server/compositor.js';
import type { Device, VirtualLight } from '../src/shared/types.js';

const device: Device = {
  id: 'd', name: 'strip', ip: '1.2.3.4', ledCount: 10, maxColorsPerPacket: 84,
  keepaliveMs: 2000, enabled: true, idleBehavior: 'off',
};

let order = 0;
const light = (id: string, ranges: [number, number][], priority = 0): VirtualLight => ({
  id, name: id, deviceId: 'd', ranges, priority, capability: 'rgb',
  defaults: { color: [255, 255, 255], brightness: 255 }, transitionMs: 0, order: order++,
});
const on = (color: [number, number, number], brightness = 255): RenderState => ({ on: true, brightness, color });
const px = (f: Uint8Array, i: number) => [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]];

describe('composite', () => {
  it('starts black and paints ranges inclusively, including non-contiguous ones', () => {
    const f = composite(device, [light('a', [[1, 2], [5, 5]])], { a: on([10, 20, 30]) }, 0);
    expect(px(f, 0)).toEqual([0, 0, 0]);
    expect(px(f, 1)).toEqual([10, 20, 30]);
    expect(px(f, 2)).toEqual([10, 20, 30]);
    expect(px(f, 3)).toEqual([0, 0, 0]);
    expect(px(f, 5)).toEqual([10, 20, 30]);
  });

  it('higher priority wins on overlap regardless of list order', () => {
    const hi = light('hi', [[3, 6]], 5);
    const lo = light('lo', [[0, 4]], 1);
    const f = composite(device, [hi, lo], { hi: on([255, 0, 0]), lo: on([0, 0, 255]) }, 0);
    expect(px(f, 2)).toEqual([0, 0, 255]);
    expect(px(f, 4)).toEqual([255, 0, 0]);
  });

  it('breaks priority ties by creation order (later created paints last)', () => {
    const first = light('first', [[0, 0]]);
    const second = light('second', [[0, 0]]);
    const f = composite(device, [second, first], { first: on([1, 1, 1]), second: on([2, 2, 2]) }, 0);
    expect(px(f, 0)).toEqual([2, 2, 2]);
  });

  it('skips lights that are off and lets lower lights show through', () => {
    const top = light('top', [[0, 3]], 9);
    const base = light('base', [[0, 9]], 0);
    const f = composite(device, [top, base], { top: { ...on([9, 9, 9]), on: false }, base: on([50, 50, 50]) }, 0);
    expect(px(f, 0)).toEqual([50, 50, 50]);
  });

  it('bakes brightness into RGB', () => {
    const f = composite(device, [light('a', [[0, 0]])], { a: on([200, 100, 0], 128) }, 0);
    expect(px(f, 0)).toEqual([100, 50, 0]);
  });

  it('clips ranges to the strip', () => {
    const f = composite(device, [light('a', [[8, 40]])], { a: on([1, 1, 1]) }, 0);
    expect(f.length).toBe(30);
    expect(px(f, 9)).toEqual([1, 1, 1]);
  });

  it('ignores lights on other devices', () => {
    const other = { ...light('x', [[0, 9]]), deviceId: 'other' };
    const f = composite(device, [other], { x: on([1, 1, 1]) }, 0);
    expect(f.every((v) => v === 0)).toBe(true);
  });
});

describe('transitions', () => {
  it('fades in from invisible at the target color', () => {
    const next = on([200, 0, 0]);
    const t = startTransition({ color: [0, 0, 0], alpha: 0 }, next, 1000, 0)!;
    expect(lookAt({ ...next, transition: t }, 0)).toEqual({ color: [200, 0, 0], alpha: 0 });
    expect(lookAt({ ...next, transition: t }, 500).alpha).toBeCloseTo(0.5);
    expect(lookAt({ ...next, transition: t }, 1000)).toEqual(targetLook(next));
  });

  it('interpolates color between two on states', () => {
    const next = on([0, 0, 200]);
    const t = startTransition({ color: [200, 0, 0], alpha: 1 }, next, 1000, 0)!;
    expect(lookAt({ ...next, transition: t }, 500)).toEqual({ color: [100, 0, 100], alpha: 1 });
  });

  it('fades out holding the current color, revealing lights underneath', () => {
    const top = light('top', [[0, 0]], 1);
    const base = light('base', [[0, 0]], 0);
    const off = { ...on([200, 200, 200]), on: false };
    const t = startTransition({ color: [200, 200, 200], alpha: 1 }, off, 1000, 0)!;
    const states = { top: { ...off, transition: t }, base: on([0, 0, 100]) };
    expect(px(composite(device, [top, base], states, 500), 0)).toEqual([100, 100, 150]);
    expect(px(composite(device, [top, base], states, 1000), 0)).toEqual([0, 0, 100]);
  });

  it('returns no transition for zero duration', () => {
    expect(startTransition({ color: [0, 0, 0], alpha: 0 }, on([1, 1, 1]), 0, 0)).toBeUndefined();
  });
});

describe('downsample', () => {
  it('is a no-op within the limit', () => {
    const f = new Uint8Array(30);
    expect(downsample(f, 84)).toBe(f);
  });

  it('averages evenly sized buckets', () => {
    const f = new Uint8Array([0, 0, 0, 100, 100, 100, 200, 0, 0, 200, 0, 0]);
    expect([...downsample(f, 2)]).toEqual([50, 50, 50, 200, 0, 0]);
  });

  it('covers every LED when the count does not divide evenly', () => {
    const f = new Uint8Array(100 * 3).fill(255);
    const out = downsample(f, 84);
    expect(out.length).toBe(84 * 3);
    expect(out.every((v) => v === 255)).toBe(true);
  });
});

describe('applyWhiteBalance', () => {
  it('scales each channel by its percentage gain', () => {
    expect([...applyWhiteBalance(new Uint8Array([255, 167, 88, 200, 200, 200]), [80, 100, 50])]).toEqual([204, 167, 44, 160, 200, 100]);
  });

  it('is a no-op at 100/100/100 or when unset', () => {
    const f = new Uint8Array([1, 2, 3]);
    expect(applyWhiteBalance(f, [100, 100, 100])).toBe(f);
    expect(applyWhiteBalance(f, undefined)).toBe(f);
  });
});
