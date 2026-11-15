// Govee LAN "razer" / DreamView protocol. See SPEC.md §9.

export const GOVEE_PORT = 4003;

export const CMD_FRAME = 0xb0;
export const CMD_STREAM = 0xb1;

/** Binary packet: BB <lenHi=00> <len> <cmd> <data…> <xor checksum>. */
export function encodePacket(cmd: number, data: ArrayLike<number>): Buffer {
  const len = data.length;
  if (len > 0xff) throw new RangeError(`razer packet data too long: ${len} bytes (max 255)`);
  const buf = Buffer.alloc(len + 5);
  buf[0] = 0xbb;
  buf[1] = 0x00;
  buf[2] = len;
  buf[3] = cmd;
  for (let i = 0; i < len; i++) buf[4 + i] = data[i];
  let c = 0;
  for (let i = 0; i < len + 4; i++) c ^= buf[i];
  buf[len + 4] = c;
  return buf;
}

function razerDatagram(packet: Buffer): Buffer {
  return Buffer.from(JSON.stringify({ msg: { cmd: 'razer', data: { pt: packet.toString('base64') } } }));
}

export function streamEnable(on: boolean): Buffer {
  return razerDatagram(encodePacket(CMD_STREAM, [on ? 1 : 0]));
}

/** Frame of discrete pixels (gradient flag 0). `rgb` is packed R,G,B per color. */
export function frame(rgb: Uint8Array): Buffer {
  const count = rgb.length / 3;
  if (!Number.isInteger(count)) throw new RangeError('frame length must be a multiple of 3');
  const data = new Uint8Array(rgb.length + 2);
  data[0] = 0; // gradient off
  data[1] = count;
  data.set(rgb, 2);
  return razerDatagram(encodePacket(CMD_FRAME, data));
}

/** Largest color count that fits a single-byte-length packet: (255 - 2) / 3. */
export const MAX_COLORS_8BIT = Math.floor((0xff - 2) / 3);

/** Standard LAN brightness command, 1-100 (whole strip). */
export function brightness(percent: number): Buffer {
  const value = Math.max(1, Math.min(100, Math.round(percent)));
  return Buffer.from(JSON.stringify({ msg: { cmd: 'brightness', data: { value } } }));
}

/** Standard LAN power command. */
export function turn(on: boolean): Buffer {
  return Buffer.from(JSON.stringify({ msg: { cmd: 'turn', data: { value: on ? 1 : 0 } } }));
}

// --- Segment commands ("ptReal") -------------------------------------------
// The Govee app's BLE segment frames, sent over LAN on the same port. Unlike
// razer they can address the white LEDs (kelvin field) and the strip holds the
// state on its own. Format is from community captures and UNVERIFIED on the
// H805A: `pnpm cli probe` checks it (docs/segment-mode-testing.md).

/** How segment numbers map to mask bytes. The probe tries variants until one matches. */
export interface MaskFormat {
  /** Mask length in bytes (community captures show 2-3; some devices use 7). */
  bytes: number;
  /** false: segment 0 = bit 0 (LSB) of byte 0. true: segment 0 = bit 7 of byte 0. */
  msbFirst: boolean;
}
export const DEFAULT_MASK: MaskFormat = { bytes: 3, msbFirst: false };

/** 20-byte BLE frame: payload zero-padded to 19 bytes, then XOR of those 19 bytes. */
export function bleFrame(payload: ArrayLike<number>): Buffer {
  if (payload.length > 19) throw new RangeError(`BLE frame payload too long: ${payload.length} bytes (max 19)`);
  const f = Buffer.alloc(20);
  for (let i = 0; i < payload.length; i++) f[i] = payload[i];
  let c = 0;
  for (let i = 0; i < 19; i++) c ^= f[i];
  f[19] = c;
  return f;
}

export function segmentMask(segments: Iterable<number>, fmt: MaskFormat = DEFAULT_MASK): number[] {
  const mask = new Array<number>(fmt.bytes).fill(0);
  for (const s of segments) {
    if (!Number.isInteger(s) || s < 0 || s >= fmt.bytes * 8) throw new RangeError(`segment ${s} doesn't fit a ${fmt.bytes}-byte mask`);
    mask[s >> 3] |= fmt.msbFirst ? 0x80 >> (s & 7) : 1 << (s & 7);
  }
  return mask;
}

const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/**
 * `33 05 15 01 RR GG BB KH KL TR TG TB <mask>`. Kelvin 0 = plain RGB. A non-zero
 * kelvin is meant to drive the white LEDs; TR TG TB is that white's RGB look.
 */
export function segmentColorFrame(rgb: readonly number[], kelvin: number, tint: readonly number[], mask: number[]): Buffer {
  const k = Math.max(0, Math.min(0xffff, Math.round(kelvin)));
  return bleFrame([0x33, 0x05, 0x15, 0x01, ...rgb.slice(0, 3).map(byte), k >> 8, k & 0xff, ...tint.slice(0, 3).map(byte), ...mask]);
}

/** `33 05 15 02 <brightness 0-100> <mask>`: per-segment brightness. */
export function segmentBrightnessFrame(percent: number, mask: number[]): Buffer {
  return bleFrame([0x33, 0x05, 0x15, 0x02, Math.max(0, Math.min(100, Math.round(percent))), ...mask]);
}

/** LAN datagram carrying one or more BLE frames, applied in order. */
export function ptReal(frames: Buffer[]): Buffer {
  return Buffer.from(JSON.stringify({ msg: { cmd: 'ptReal', data: { command: frames.map((f) => f.toString('base64')) } } }));
}
