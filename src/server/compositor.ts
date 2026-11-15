// Pure rendering: light states → what each light looks like at `now`, and the
// per-LED frame (razer). The group planner (plan.ts) uses the same visuals.
import { lerp, lookRgb, scale } from '../shared/color.js';
import type { Device, LightState, Look, RGB, VirtualLight } from '../shared/types.js';

/**
 * A light as drawn: its look and brightness, painted with some opacity over
 * whatever is beneath it. Fading opacity (rather than fading to black) lets a
 * high-priority light dissolve to reveal lower-priority lights underneath.
 */
export interface Visual {
  look: Look;
  brightness: number; // 0-255
  alpha: number; // 0-1
}

export interface Transition {
  from: Visual;
  to: Visual;
  startedAt: number;
  durationMs: number;
}

export interface RenderState extends LightState {
  transition?: Transition;
}

/** The steady-state visual implied by a light's persisted state. */
export function targetVisual(s: LightState): Visual {
  return { look: s.look, brightness: s.brightness, alpha: s.on ? 1 : 0 };
}

export function transitionActive(t: Transition | undefined, now: number): t is Transition {
  return !!t && now < t.startedAt + t.durationMs;
}

function progress(t: Transition, now: number) {
  return Math.max(0, Math.min(1, (now - t.startedAt) / t.durationMs));
}

/** Blend two looks: RGB lerps in RGB, white in mireds; RGB ↔ white swaps at the midpoint. */
export function lerpLook(a: Look, b: Look, p: number): Look {
  if (a.kind === 'rgb' && b.kind === 'rgb') return { kind: 'rgb', color: lerp(a.color, b.color, p) };
  if (a.kind === 'white' && b.kind === 'white') return { kind: 'white', mireds: a.mireds + (b.mireds - a.mireds) * p };
  return p < 0.5 ? a : b;
}

/** The visual at `now`, for group control (looks stay looks: white stays white). */
export function visualAt(s: RenderState, now: number): Visual {
  const t = s.transition;
  if (!transitionActive(t, now)) return targetVisual(s);
  const p = progress(t, now);
  return {
    look: lerpLook(t.from.look, t.to.look, p),
    brightness: t.from.brightness + (t.to.brightness - t.from.brightness) * p,
    alpha: t.from.alpha + (t.to.alpha - t.from.alpha) * p,
  };
}

/** A visual's color with brightness applied. */
export const visualRgb = (v: Visual): RGB => scale(lookRgb(v.look), v.brightness);

/** Color + opacity at `now`, for per-LED rendering: RGB always lerps smoothly. */
export function paintAt(s: RenderState, now: number): { color: RGB; alpha: number } {
  const t = s.transition;
  if (!transitionActive(t, now)) return { color: visualRgb(targetVisual(s)), alpha: s.on ? 1 : 0 };
  const p = progress(t, now);
  return { color: lerp(visualRgb(t.from), visualRgb(t.to), p), alpha: t.from.alpha + (t.to.alpha - t.from.alpha) * p };
}

/**
 * Build the transition from whatever is visible now to a new state. When the
 * light starts invisible, it fades in at its new look rather than sweeping hue.
 */
export function startTransition(current: Visual, next: LightState, durationMs: number, now: number): Transition | undefined {
  if (durationMs <= 0) return undefined;
  let to = targetVisual(next);
  const from = current.alpha === 0 ? { ...to, alpha: 0 } : current;
  if (to.alpha === 0) to = { ...from, alpha: 0 }; // fade out holding the current look
  return { from, to, startedAt: now, durationMs };
}

/** Lights in paint order: priority ascending, then creation order. */
export function paintOrder(lights: VirtualLight[]): VirtualLight[] {
  return [...lights].sort((a, b) => a.priority - b.priority || a.order - b.order);
}

/** Full-resolution per-LED frame: `ledCount` pixels, packed RGB. */
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
    const { color, alpha } = paintAt(s, now);
    if (alpha <= 0) continue;
    for (const [a, b] of light.ranges) {
      const lo = Math.max(0, Math.min(a, b));
      const hi = Math.min(device.ledCount - 1, Math.max(a, b));
      for (let i = lo; i <= hi; i++) {
        const o = i * 3;
        const px = alpha >= 1 ? color : lerp([out[o], out[o + 1], out[o + 2]], color, alpha);
        out[o] = px[0];
        out[o + 1] = px[1];
        out[o + 2] = px[2];
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
