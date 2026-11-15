import { describe, expect, it } from 'vitest';
import { brightness, encodePacket, frame, MAX_COLORS_8BIT, streamEnable, turn } from '../src/server/protocol.js';

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
