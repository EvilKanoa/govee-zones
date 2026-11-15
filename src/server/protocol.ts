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
