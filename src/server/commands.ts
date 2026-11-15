// Apply HA JSON-schema light commands to light state. Shared by web UI and MQTT.
import { clampMireds } from '../shared/color.js';
import type { LightCommand, LightState, Look, VirtualLight } from '../shared/types.js';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

export const cloneLook = (l: Look): Look => (l.kind === 'rgb' ? { kind: 'rgb', color: [...l.color] } : { ...l });

export function defaultState(light: VirtualLight): LightState {
  return { on: false, brightness: light.defaults.brightness, look: cloneLook(light.defaults.look) };
}

/**
 * Turning on from off with no parameters restores the light's configured
 * defaults (SPEC §4). Parameters the light's capability doesn't support are
 * ignored, so an `onoff` light always shows its default look.
 */
export function applyCommand(light: VirtualLight, prev: LightState, cmd: LightCommand): LightState {
  if (cmd.state === 'OFF') return { ...prev, on: false };

  // A command without `state` only changes attributes; it never turns the light on.
  const turningOn = cmd.state === 'ON' && !prev.on;
  const base = turningOn ? defaultState(light) : prev;
  const next: LightState = { ...base, look: cloneLook(base.look), on: prev.on || turningOn };

  const cap = light.capability;
  if (cap !== 'onoff' && cmd.brightness !== undefined) next.brightness = clamp(cmd.brightness, 0, 255);
  if (cap === 'rgb' && cmd.color) next.look = { kind: 'rgb', color: [clamp(cmd.color.r, 0, 255), clamp(cmd.color.g, 0, 255), clamp(cmd.color.b, 0, 255)] };
  if (cap === 'ct' && cmd.color_temp !== undefined) next.look = { kind: 'white', mireds: clampMireds(cmd.color_temp) };
  return next;
}

/** Transition duration for a command: explicit `transition` (seconds) wins over the light's default. */
export function commandTransitionMs(light: VirtualLight, cmd: LightCommand): number {
  return cmd.transition !== undefined ? Math.max(0, cmd.transition * 1000) : light.transitionMs;
}
