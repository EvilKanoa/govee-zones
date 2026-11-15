// Apply HA JSON-schema light commands to light state. Shared by web UI and MQTT.
import { miredsToRgb } from '../shared/color.js';
import type { LightCommand, LightState, RGB, VirtualLight } from '../shared/types.js';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

export function defaultState(light: VirtualLight): LightState {
  const d = light.defaults;
  const s: LightState = { on: false, brightness: d.brightness, color: [...d.color] as RGB };
  if (light.capability === 'rgb_ct' && d.colorTemp) {
    s.colorTemp = d.colorTemp;
    s.color = miredsToRgb(d.colorTemp);
  }
  return s;
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
  const next: LightState = { ...base, color: [...base.color] as RGB, on: prev.on || turningOn };

  const cap = light.capability;
  if (cap !== 'onoff' && cmd.brightness !== undefined) next.brightness = clamp(cmd.brightness, 0, 255);
  if ((cap === 'rgb' || cap === 'rgb_ct') && cmd.color) {
    next.color = [clamp(cmd.color.r, 0, 255), clamp(cmd.color.g, 0, 255), clamp(cmd.color.b, 0, 255)];
    delete next.colorTemp;
  }
  if (cap === 'rgb_ct' && cmd.color_temp !== undefined) {
    next.colorTemp = clamp(cmd.color_temp, 153, 500);
    next.color = miredsToRgb(next.colorTemp);
  }
  return next;
}

/** Transition duration for a command: explicit `transition` (seconds) wins over the light's default. */
export function commandTransitionMs(light: VirtualLight, cmd: LightCommand): number {
  return cmd.transition !== undefined ? Math.max(0, cmd.transition * 1000) : light.transitionMs;
}
