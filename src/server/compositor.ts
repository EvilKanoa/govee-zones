// Pure rendering: (device, lights, states, now) → frame. See SPEC.md §7.
import { lerp, scale } from '../shared/color.js';
import type { Device, LightState, RGB, VirtualLight } from '../shared/types.js';

/**
 * What a light looks like on the strip: a color painted with some opacity over
 * whatever is beneath it. Fading opacity (rather than fading to black) lets a
 * high-priority light dissolve to reveal lower-priority lights underneath.
 */
export interface Look {
  color: RGB;
  alpha: number; // 0-1
}

export interface Transition {
  from: Look;
  to: Look;
  startedAt: number;
  durationMs: number;
}

export interface RenderState extends LightState {
  transition?: Transition;
}

/** The steady-state look implied by a light's persisted state. */
export function targetLook(s: LightState): Look {
  return { color: scale(s.color, s.brightness), alpha: s.on ? 1 : 0 };
}

export function transitionActive(t: Transition | undefined, now: number): t is Transition {
  return !!t && now < t.startedAt + t.durationMs;
}

export function lookAt(s: RenderState, now: number): Look {
  const t = s.transition;
  if (!transitionActive(t, now)) return targetLook(s);
  const p = Math.max(0, (now - t.startedAt) / t.durationMs);
  return { color: lerp(t.from.color, t.to.color, p), alpha: t.from.alpha + (t.to.alpha - t.from.alpha) * p };
}

/**
 * Build the transition from whatever is visible now to a new state. When the
 * light starts invisible, it fades in at its new color rather than sweeping hue.
 */
export function startTransition(current: Look, next: LightState, durationMs: number, now: number): Transition | undefined {
  if (durationMs <= 0) return undefined;
  const to = targetLook(next);
  const from = current.alpha === 0 ? { color: to.color, alpha: 0 } : current;
  if (to.alpha === 0) to.color = from.color; // fade out holding the current color
  return { from, to, startedAt: now, durationMs };
}

/** Lights in paint order: priority ascending, then creation order. */
export function paintOrder(lights: VirtualLight[]): VirtualLight[] {
  return [...lights].sort((a, b) => a.priority - b.priority || a.order - b.order);
}

/** Full-resolution frame: `ledCount` pixels, packed RGB. */
export function composite(
  device: Device,
  lights: VirtualLight[],
  states: Record<string, RenderState | undefined>,
  now: number,
): Uint8Array {
  const out = new Uint8Array(device.ledCount * 3);
  for (const light of paintOrder(lights.filter((l) => l.deviceId === device.id))) {
    const s = states[light.id];
    if (!s) continue;
    const { color, alpha } = lookAt(s, now);
    if (alpha <= 0) continue;
    for (const [a, b] of light.ranges) {
      const lo = Math.max(0, Math.min(a, b));
      const hi = Math.min(device.ledCount - 1, Math.max(a, b));
      for (let i = lo; i <= hi; i++) {
        const o = i * 3;
        if (alpha >= 1) {
          out[o] = color[0];
          out[o + 1] = color[1];
          out[o + 2] = color[2];
        } else {
          const px = lerp([out[o], out[o + 1], out[o + 2]], color, alpha);
          out[o] = px[0];
          out[o + 1] = px[1];
          out[o + 2] = px[2];
        }
      }
    }
  }
  return out;
}

/** True if any light on this device is mid-transition (render at animation rate). */
export function animating(device: Device, lights: VirtualLight[], states: Record<string, RenderState | undefined>, now: number) {
  return lights.some((l) => l.deviceId === device.id && transitionActive(states[l.id]?.transition, now));
}

/** Scale each channel by a percentage gain (white-point correction for the LEDs). */
export function applyWhiteBalance(frame: Uint8Array, gains: RGB | undefined): Uint8Array {
  if (!gains || (gains[0] === 100 && gains[1] === 100 && gains[2] === 100)) return frame;
  const out = new Uint8Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = Math.round((frame[i] * gains[i % 3]) / 100);
  return out;
}

/**
 * Reduce a frame to at most `maxColors` by averaging evenly sized buckets of
 * neighbouring LEDs. Assumes the device stretches N colors evenly across the
 * strip (SPEC §9 item 2 — unverified).
 */
export function downsample(frame: Uint8Array, maxColors: number): Uint8Array {
  const n = frame.length / 3;
  if (n <= maxColors) return frame;
  const out = new Uint8Array(maxColors * 3);
  for (let j = 0; j < maxColors; j++) {
    const start = Math.floor((j * n) / maxColors);
    const end = Math.floor(((j + 1) * n) / maxColors);
    let r = 0, g = 0, b = 0;
    for (let i = start; i < end; i++) {
      r += frame[i * 3];
      g += frame[i * 3 + 1];
      b += frame[i * 3 + 2];
    }
    const k = end - start;
    out[j * 3] = Math.round(r / k);
    out[j * 3 + 1] = Math.round(g / k);
    out[j * 3 + 2] = Math.round(b / k);
  }
  return out;
}
