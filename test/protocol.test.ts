import { describe, expect, it } from 'vitest';
import {
  bleFrame,
  brightness,
  encodePacket,
  frame,
  MAX_COLORS_8BIT,
  ptReal,
  segmentBrightnessFrame,
  segmentColorFrame,
  segmentMask,
  streamEnable,
  turn,
} from '../src/server/protocol.js';

const pt = (datagram: Buffer) => JSON.parse(datagram.toString()).msg.data.pt as string;

describe('protocol', () => {
  it('encodes the known-good enable packet', () => {
    const p = encodePacket(0xb1, [1]);
    expect([...p]).toEqual([0xbb, 0x00, 0x01, 0xb1, 0x01, 0x0a]);
    expect(p.toString('base64')).toBe('uwABsQEK');
    expect(pt(streamEnable(true))).toBe('uwABsQEK');
  });

  it('checksum is XOR of all preceding bytes', () => {
    const p = encodePacket(0xb1, [0]);
    expect(p[p.length - 1]).toBe(0xbb ^ 0x00 ^ 0x01 ^ 0xb1 ^ 0x00);
  });

  it('frames discrete pixels with gradient off and a color count', () => {
    const raw = Buffer.from(pt(frame(new Uint8Array([1, 2, 3, 4, 5, 6]))), 'base64');
    expect([...raw.subarray(0, 6)]).toEqual([0xbb, 0x00, 8, 0xb0, 0, 2]);
    expect([...raw.subarray(6, 12)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('fits 84 colors in one packet and rejects more', () => {
    expect(() => encodePacket(0xb0, new Uint8Array(256))).toThrow(RangeError);
    expect(MAX_COLORS_8BIT).toBe(84);
    expect(() => frame(new Uint8Array(84 * 3))).not.toThrow();
    expect(() => frame(new Uint8Array(85 * 3))).toThrow(RangeError);
  });

  it('encodes LAN brightness, clamped to 1-100', () => {
    expect(JSON.parse(brightness(100).toString())).toEqual({ msg: { cmd: 'brightness', data: { value: 100 } } });
    expect(JSON.parse(brightness(0).toString()).msg.data.value).toBe(1);
  });

  it('encodes LAN turn', () => {
    expect(JSON.parse(turn(false).toString())).toEqual({ msg: { cmd: 'turn', data: { value: 0 } } });
  });
});

describe('segment protocol (ptReal)', () => {
  const xor = (b: number[]) => b.reduce((a, x) => a ^ x, 0);

  it('pads BLE frames to 20 bytes with an XOR checksum of bytes 0-18', () => {
    const f = bleFrame([0x33, 0x05, 0x15]);
    expect(f.length).toBe(20);
    expect([...f.subarray(3, 19)]).toEqual(new Array(16).fill(0));
    expect(f[19]).toBe(0x33 ^ 0x05 ^ 0x15);
    expect(() => bleFrame(new Array(20).fill(0))).toThrow(RangeError);
  });

  it('encodes the community 3000 K example byte for byte', () => {
    const body = [0x33, 0x05, 0x15, 0x01, 0xff, 0xff, 0xff, 0x0b, 0xb8, 0xff, 0xb9, 0x69, 0x01, 0x00, 0x00];
    const f = segmentColorFrame([255, 255, 255], 3000, [0xff, 0xb9, 0x69], segmentMask([0]));
    expect([...f]).toEqual([...body, 0, 0, 0, 0, xor(body)]);
  });

  it('builds masks LSB-first by default, MSB-first and wider on request', () => {
    expect(segmentMask([0])).toEqual([0x01, 0, 0]);
    expect(segmentMask([1, 4])).toEqual([0x12, 0, 0]);
    expect(segmentMask([8])).toEqual([0, 0x01, 0]);
    expect(segmentMask([0, 1], { bytes: 3, msbFirst: true })).toEqual([0xc0, 0, 0]);
    expect(segmentMask([55], { bytes: 7, msbFirst: false })).toEqual([0, 0, 0, 0, 0, 0, 0x80]);
    expect(() => segmentMask([24])).toThrow(RangeError);
  });

  it('encodes per-segment brightness', () => {
    expect([...segmentBrightnessFrame(50, segmentMask([0])).subarray(0, 8)]).toEqual([0x33, 0x05, 0x15, 0x02, 50, 1, 0, 0]);
    expect(segmentBrightnessFrame(150, [1])[4]).toBe(100);
  });

  it('wraps frames in a ptReal datagram', () => {
    const a = bleFrame([1]);
    const b = bleFrame([2]);
    expect(JSON.parse(ptReal([a, b]).toString())).toEqual({
      msg: { cmd: 'ptReal', data: { command: [a.toString('base64'), b.toString('base64')] } },
    });
  });
});
