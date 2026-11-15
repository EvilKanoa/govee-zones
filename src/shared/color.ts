import type { RGB } from './types.js';

export const BLACK: RGB = [0, 0, 0];

const clamp8 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function scale(c: RGB, brightness: number): RGB {
  const f = Math.max(0, Math.min(255, brightness)) / 255;
  return [clamp8(c[0] * f), clamp8(c[1] * f), clamp8(c[2] * f)];
}

export function lerp(a: RGB, b: RGB, t: number): RGB {
  return [
    clamp8(a[0] + (b[0] - a[0]) * t),
    clamp8(a[1] + (b[1] - a[1]) * t),
    clamp8(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Approximate a color temperature (mireds) as RGB, using Tanner Helland's
 * blackbody fit. The strip's white LEDs aren't addressable in razer mode.
 */
export function miredsToRgb(mireds: number): RGB {
  const t = 1_000_000 / mireds / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return [clamp8(r), clamp8(g), clamp8(b)];
}

export function rgbToHex(c: RGB): string {
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
