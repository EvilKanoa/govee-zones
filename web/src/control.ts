// Pure helpers that explain group vs per-LED control in the UI (plan §4).
import { groupBoundaries, groupCount, groupsUnavailable, isAligned, roundToGroups } from '../../src/shared/groups';
import type { Device, DeviceStatus, VirtualLight } from '../../src/shared/types';
import { formatRanges, rangesToSet, setToRanges } from './ranges';

/** Group control can be used on this strip at all (ignoring what's on right now). */
export const groupsUsable = (d: Device) => !groupsUnavailable(d);

/** Group geometry is meaningful for drawing dividers (even when control is Per-LED only). */
export const hasGroups = (d: Device) => d.groupSize > 0 && groupCount(d.ledCount, d.groupSize) <= 24;

export function boundarySet(d: Device): Set<number> {
  return new Set(hasGroups(d) ? groupBoundaries(d.ledCount, d.groupSize) : []);
}

/** "groups 6–7" or "groups 1–2, 6" (1-based, like the rest of the UI). */
export function formatGroups(groups: number[]): string {
  if (!groups.length) return 'no groups';
  const ranges = setToRanges(new Set(groups.map((g) => g + 1)));
  return `group${groups.length > 1 ? 's' : ''} ${ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ')}`;
}

export interface Coverage {
  text: string;
  /** Explains rounding or the exact-LED switch. */
  note?: string;
  warn?: boolean;
}

/** How a light maps onto groups on its strip. */
export function coverageLabel(light: VirtualLight, d: Device): Coverage {
  const leds = formatRanges(light.ranges);
  if (!light.ranges.length) return { text: 'no LEDs' };
  if (!groupsUsable(d)) return { text: `LEDs ${leds}` };
  const groups = roundToGroups(light.ranges, d.ledCount, d.groupSize);
  if (isAligned(light.ranges, d.ledCount, d.groupSize)) return { text: formatGroups(groups) };
  if (d.partialGroups === 'exact')
    return { text: `LEDs ${leds}`, note: 'Uses exact LEDs: the strip switches to Per-LED while this is on.', warn: true };
  return {
    text: `LEDs ${leds} → ${formatGroups(groups)}`,
    note: `Doesn't line up with the ${d.groupSize}-LED groups, so it's rounded to whole groups in group mode.`,
  };
}

/** Expand a selection to the whole groups it rounds to. */
export function snapSelection(sel: Set<number>, d: Device): Set<number> {
  if (!hasGroups(d) || !sel.size) return sel;
  const out = new Set<number>();
  for (const g of roundToGroups(setToRanges(sel), d.ledCount, d.groupSize))
    for (let i = g * d.groupSize; i < Math.min((g + 1) * d.groupSize, d.ledCount); i++) out.add(i);
  return out;
}

export const MODE_LABEL: Record<DeviceStatus['mode'], string> = {
  groups: 'Groups',
  per_led: 'Per-LED',
  idle: 'Idle',
  released: 'Released',
  error: 'Error',
};

/** Why the strip is in its mode, in plain words (plan §4.2). */
export function modeExplanation(s: DeviceStatus | undefined): string {
  if (!s) return '';
  if (s.mode === 'error') return s.error ? `Sending failed: ${s.error}` : 'Sending failed.';
  if (s.mode === 'released') return 'Released to Govee: govee-zones isn\'t driving the strip. Light changes are saved and apply when you take it back.';
  if (s.mode === 'idle') return 'All lights are off, so the strip is off.';
  if (s.mode === 'groups') return 'Real white. The strip holds its lights on its own.';
  const names = s.detail?.join(', ');
  switch (s.reason) {
    case 'groups_off':
      return 'Group control is off for this strip (LEDs per group is 0).';
    case 'too_many_groups':
      return 'This strip has more groups than have been tested (24), so it uses per-LED control.';
    case 'per_led_setting':
      return 'Control method is set to Per-LED only.';
    case 'override':
      return `${names ? names[0].toUpperCase() + names.slice(1) : 'A test'} running. Returns to Groups when done.`;
    case 'exact_leds':
      return `${names ?? 'A light'} use${s.detail && s.detail.length > 1 ? '' : 's'} exact LEDs and ${s.detail && s.detail.length > 1 ? 'are' : 'is'} on. White is mixed from RGB until ${s.detail && s.detail.length > 1 ? 'they turn' : 'it turns'} off.`;
    case 'fade_finishing':
      return 'Finishing a fade; switches to Groups after.';
    default:
      return 'Controlling single LEDs.';
  }
}

/** Rounding applies: group control can be used and partial lights are rounded (not switched to exact LEDs). */
export const roundingActive = (d: Device) => groupsUsable(d) && d.partialGroups === 'round';

/**
 * Per LED, the lights that cover it after rounding to groups (what group control
 * actually lights), in the same paint order as `exact`.
 */
export function roundedCoverage(exact: VirtualLight[][], lights: VirtualLight[], d: Device): VirtualLight[][] {
  const byLed: VirtualLight[][] = Array.from({ length: d.ledCount }, () => []);
  const ordered = [...lights].sort((a, b) => a.priority - b.priority || a.order - b.order);
  for (const l of ordered)
    for (const g of roundToGroups(l.ranges, d.ledCount, d.groupSize))
      for (let i = g * d.groupSize; i < Math.min((g + 1) * d.groupSize, d.ledCount); i++) byLed[i].push(l);
  return byLed.length === exact.length ? byLed : exact;
}

export interface RoundingAt {
  /** Lights that light this LED only because of rounding. */
  added: VirtualLight[];
  /** Lights whose range includes this LED, but rounding leaves it out. */
  dropped: VirtualLight[];
}

export function roundingAt(exact: VirtualLight[], rounded: VirtualLight[]): RoundingAt {
  return { added: rounded.filter((l) => !exact.includes(l)), dropped: exact.filter((l) => !rounded.includes(l)) };
}

/** Tooltip suffix for an LED's owners, marking what rounding changed. */
export function ownersTitle(exact: VirtualLight[], rounded?: VirtualLight[]): string {
  if (!rounded) return exact.length ? ' · ' + exact.map((l) => l.name).join(' < ') : '';
  const { dropped } = roundingAt(exact, rounded);
  const parts = [
    ...rounded.map((l) => (exact.includes(l) ? l.name : `${l.name} (added by rounding)`)),
    ...dropped.map((l) => `${l.name} (dropped by rounding)`),
  ];
  return parts.length ? ' · ' + parts.join(' < ') : '';
}
