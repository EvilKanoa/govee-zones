import { describe, expect, it } from 'vitest';
import { encodeGroups, groupPixels, packDatagrams } from '../src/server/groupOutput.js';
import type { GroupLook } from '../src/server/plan.js';
import { miredsToRgb } from '../src/shared/color.js';
import type { Device } from '../src/shared/types.js';

const hex = (f: Buffer) => f.subarray(0, 15).toString('hex');
const W: GroupLook = { kind: 'white', kelvin: 2700, pct: 100 };
const RED50: GroupLook = { kind: 'rgb', rgb: [255, 0, 0], pct: 50 };
const OFF: GroupLook = { kind: 'off' };

describe('encodeGroups', () => {
  it('full send: one color frame per look, then one brightness frame per level', () => {
    const { frames } = encodeGroups([W, W, OFF, RED50], []);
    expect(frames.map(hex)).toEqual([
      '330515010000000a8c000000030000', // white 2700 K, RGB and tint 0, groups 0-1
      '330515010000000000000000040000', // off = RGB 0 + kelvin 0, group 2
      '33051501ff00000000000000080000', // red, group 3
      '33051502640300000000000000000000'.slice(0, 30), // 100 %, groups 0-1
      '33051502320800000000000000000000'.slice(0, 30), // 50 %, group 3
    ]);
  });

  it('sends only what changed', () => {
    const { sent } = encodeGroups([W, W, OFF, RED50], []);
    expect(encodeGroups([W, W, OFF, RED50], sent).frames).toEqual([]);
    const dim = encodeGroups([{ ...W, pct: 40 }, W, OFF, RED50], sent).frames;
    expect(dim.map(hex)).toEqual(['330515022801000000000000000000']); // brightness only, group 0
    const lit = encodeGroups([W, W, W, RED50], sent).frames;
    expect(lit.map(hex)).toEqual(['330515010000000a8c000000040000', '330515026404000000000000000000']); // color + brightness
  });

  it('applies white-balance gains to RGB only', () => {
    const { frames } = encodeGroups([W, { kind: 'rgb', rgb: [200, 200, 200], pct: 100 }], [], [80, 100, 50]);
    expect(hex(frames[0])).toBe('330515010000000a8c000000010000');
    expect(hex(frames[1])).toBe('33051501a0c8640000000000020000');
  });

  it('never sends brightness 0 (it clamps to 1 % on the strip)', () => {
    const { frames } = encodeGroups([OFF, OFF], []);
    expect(frames.every((f) => f[3] === 0x01)).toBe(true);
  });
});

describe('packDatagrams', () => {
  it('packs ≤ 6 frames per datagram', () => {
    const frames = encodeGroups(Array.from({ length: 7 }, (_, i): GroupLook => ({ kind: 'rgb', rgb: [i, 0, 0], pct: 100 })), []).frames;
    expect(frames).toHaveLength(8);
    expect(packDatagrams(frames).map((d) => JSON.parse(d.toString()).msg.data.command.length)).toEqual([6, 2]);
  });
});

describe('groupPixels', () => {
  it('expands group looks to LEDs for the preview', () => {
    const d = { ledCount: 8, groupSize: 4 } as Device;
    const px = groupPixels(d, [W, OFF]);
    expect([...px.subarray(0, 3)]).toEqual(miredsToRgb(1_000_000 / 2700));
    expect([...px.subarray(9, 12)]).toEqual(miredsToRgb(1_000_000 / 2700));
    expect(px.subarray(12).every((v) => v === 0)).toBe(true);
  });
});
