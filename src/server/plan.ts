// Pure group planner: which control a strip needs right now, and in group mode
// what each group shows. See docs/segment-mode-plan.md §3.2.
import { miredsToKelvin } from '../shared/color.js';
import { groupCount, groupsUnavailable, isAligned, roundToGroups } from '../shared/groups.js';
import type { ControlReason, Device, Look, RGB, VirtualLight } from '../shared/types.js';
import { paintOrder, transitionActive, visualAt, type RenderState } from './compositor.js';

export type GroupLook =
  | { kind: 'off' }
  | { kind: 'rgb'; rgb: RGB; pct: number }
  | { kind: 'white'; kelvin: number; pct: number };

export type PerLedReason = Exclude<ControlReason, 'auto' | 'fade_finishing'>;

export type PlanResult =
  | { control: 'groups'; groups: GroupLook[] }
  | { control: 'per_led'; reason: PerLedReason; detail?: string[] };

/** A running override (identify, pixel finder, …): whether it needs single LEDs. */
export interface PlanOverride {
  name: string;
  needsLeds: boolean;
}

export const isVisible = (s: RenderState | undefined, now: number) => !!s && (s.on || transitionActive(s.transition, now));

/** Decide group vs per-LED control for a device; in group mode, also the per-group looks. */
export function plan(
  device: Device,
  lights: VirtualLight[],
  states: Record<string, RenderState | undefined>,
  now: number,
  override?: PlanOverride,
): PlanResult {
  const unavailable = groupsUnavailable(device);
  if (unavailable) return { control: 'per_led', reason: unavailable };
  if (override?.needsLeds) return { control: 'per_led', reason: 'override', detail: [override.name] };
  const mine = lights.filter((l) => l.deviceId === device.id);
  if (device.partialGroups === 'exact') {
    const partial = mine.filter((l) => isVisible(states[l.id], now) && !isAligned(l.ranges, device.ledCount, device.groupSize));
    if (partial.length) return { control: 'per_led', reason: 'exact_leds', detail: partial.map((l) => l.name) };
  }
  return { control: 'groups', groups: groupLooks(device, mine, states, now) };
}

/**
 * Per-group looks: lights paint in paint order over their rounded groups. A
 * fading light blends brightness with what's beneath; its look wins from 50 %
 * opacity (or always, over an unlit group).
 */
export function groupLooks(
  device: Device,
  lights: VirtualLight[],
  states: Record<string, RenderState | undefined>,
  now: number,
): GroupLook[] {
  const layer: { look?: Look; pct: number }[] = Array.from({ length: groupCount(device.ledCount, device.groupSize) }, () => ({ pct: 0 }));
  for (const light of paintOrder(lights.filter((l) => l.deviceId === device.id))) {
    const s = states[light.id];
    if (!s) continue;
    const v = visualAt(s, now);
    if (v.alpha <= 0) continue;
    const top = Math.max(1, (v.brightness / 255) * 100);
    for (const g of roundToGroups(light.ranges, device.ledCount, device.groupSize)) {
      const below = layer[g];
      layer[g] = {
        pct: v.alpha * top + (1 - v.alpha) * below.pct,
        look: v.alpha >= 0.5 || !below.look ? v.look : below.look,
      };
    }
  }
  return layer.map(({ look, pct }): GroupLook => {
    if (!look || pct < 0.5) return { kind: 'off' };
    const p = Math.max(1, Math.min(100, Math.round(pct)));
    return look.kind === 'white' ? { kind: 'white', kelvin: miredsToKelvin(look.mireds), pct: p } : { kind: 'rgb', rgb: look.color, pct: p };
  });
}
