// Pure helpers that explain group vs per-LED control in the UI (plan §4).
import { groupBoundaries, groupCount, groupsUnavailable, isAligned, roundToGroups } from '../../src/shared/groups';
import type { Device, DeviceStatus, VirtualLight } from '../../src/shared/types';
import { formatRanges, setToRanges } from './ranges';

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
  const lit = new Set<number>();
  for (const g of groups) for (let i = g * d.groupSize; i < Math.min((g + 1) * d.groupSize, d.ledCount); i++) lit.add(i);
  return {
    text: `LEDs ${leds} → ${formatRanges(setToRanges(lit))}`,
    note: `Doesn't line up with the ${d.groupSize}-LED groups, so group mode lights ${formatGroups(groups)} (LEDs ${formatRanges(setToRanges(lit))}).`,
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
 * Per LED, the light group control actually shows there after rounding: one
 * light per group, the highest in paint order (a group can only show one look).
 */
export function roundedCoverage(exact: VirtualLight[][], lights: VirtualLight[], d: Device): VirtualLight[][] {
  const byLed: VirtualLight[][] = Array.from({ length: d.ledCount }, () => []);
  const ordered = [...lights].sort((a, b) => a.priority - b.priority || a.order - b.order);
  for (const l of ordered)
    for (const g of roundToGroups(l.ranges, d.ledCount, d.groupSize))
      for (let i = g * d.groupSize; i < Math.min((g + 1) * d.groupSize, d.ledCount); i++) byLed[i] = [l];
  return byLed.length === exact.length ? byLed : exact;
}

/** Whether rounding gives this LED to a different light: compares the light that shows (the top one). */
export function ownersChanged(exact: VirtualLight[], rounded: VirtualLight[]): boolean {
  return exact[exact.length - 1] !== rounded[rounded.length - 1];
}

/** Tooltip suffix for an LED's owners; with rounding, says who it belongs to as set and when rounded. */
export function ownersTitle(exact: VirtualLight[], rounded?: VirtualLight[]): string {
  const names = (ls: VirtualLight[]) => (ls.length ? ls.map((l) => l.name).join(' < ') : 'no light');
  if (!rounded || !ownersChanged(exact, rounded)) return exact.length ? ` · ${names(exact)}` : '';
  return ` · as set: ${names(exact.slice(-1))} → rounded: ${names(rounded)}`;
}

/**
 * How rounding changes one LED, for drawing an arrow on it:
 * `grow` = `light` gains this LED, extending toward lower (-1) or higher (+1) LED numbers
 * (0 if it has no LEDs of its own nearby); `dark` = rounding leaves the LED unlit, `light` loses it.
 */
export type RoundingMark = { kind: 'grow'; light: VirtualLight; dir: -1 | 0 | 1 } | { kind: 'dark'; light: VirtualLight };

export function roundingMarks(exact: VirtualLight[][], rounded: VirtualLight[][]): (RoundingMark | undefined)[] {
  const top = (ls: VirtualLight[]) => ls[ls.length - 1];
  return exact.map((c, i) => {
    if (!ownersChanged(c, rounded[i])) return undefined;
    const gain = top(rounded[i]);
    if (!gain) return { kind: 'dark', light: top(c) };
    // The light grows away from its nearest LED as set.
    let dir: -1 | 0 | 1 = 0;
    for (let k = 1; k < exact.length; k++) {
      if (i + k < exact.length && top(exact[i + k]) === gain) {
        dir = -1;
        break;
      }
      if (i - k >= 0 && top(exact[i - k]) === gain) {
        dir = 1;
        break;
      }
    }
    return { kind: 'grow', light: gain, dir };
  });
}

export const markGlyph = (m: RoundingMark) => (m.kind === 'dark' ? '✕' : m.dir < 0 ? '◀' : m.dir > 0 ? '▶' : '●');
