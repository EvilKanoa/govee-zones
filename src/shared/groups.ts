// Group geometry for group (segment) control. Shared by server and web: no Node imports.
// A group is the set of LEDs one segment-mask bit drives (4 on the H805A).
import type { Device, Range } from './types.js';

/** Most groups the tested 3-byte segment mask can address. */
export const MAX_GROUPS = 24;

export function groupCount(ledCount: number, groupSize: number): number {
  return groupSize > 0 ? Math.ceil(ledCount / groupSize) : 0;
}

/** Inclusive LED range of each group. The last group can be short. */
export function groupBounds(ledCount: number, groupSize: number): Range[] {
  const out: Range[] = [];
  for (let i = 0; i < groupCount(ledCount, groupSize); i++) out.push([i * groupSize, Math.min((i + 1) * groupSize, ledCount) - 1]);
  return out;
}

/** LED indices where a new group starts (the dividers drawn in the strip and house views). */
export function groupBoundaries(ledCount: number, groupSize: number): number[] {
  return groupBounds(ledCount, groupSize)
    .slice(1)
    .map(([a]) => a);
}

/** Why group control can't be used on this device, or null if it can. Ignores overrides and lights. */
export function groupsUnavailable(d: Pick<Device, 'ledCount' | 'groupSize' | 'control'>): 'groups_off' | 'too_many_groups' | 'per_led_setting' | null {
  if (d.groupSize <= 0) return 'groups_off';
  if (groupCount(d.ledCount, d.groupSize) > MAX_GROUPS) return 'too_many_groups';
  if (d.control === 'per_led') return 'per_led_setting';
  return null;
}

/** How many LEDs of each group the ranges cover. */
export function coverage(ranges: Range[], ledCount: number, groupSize: number): number[] {
  const lit = new Uint8Array(ledCount);
  for (const [a, b] of ranges) {
    for (let i = Math.max(0, Math.min(a, b)); i <= Math.min(ledCount - 1, Math.max(a, b)); i++) lit[i] = 1;
  }
  return groupBounds(ledCount, groupSize).map(([lo, hi]) => {
    let n = 0;
    for (let i = lo; i <= hi; i++) n += lit[i];
    return n;
  });
}

/**
 * Groups a light is drawn on in group mode: every group it covers at least half
 * of. If that leaves none but the light covers any LED, the group it covers most
 * (ties → lowest index), so rounding never makes a light disappear.
 */
export function roundToGroups(ranges: Range[], ledCount: number, groupSize: number): number[] {
  const cov = coverage(ranges, ledCount, groupSize);
  const bounds = groupBounds(ledCount, groupSize);
  const out = cov.flatMap((n, i) => (n > 0 && 2 * n >= bounds[i][1] - bounds[i][0] + 1 ? [i] : []));
  if (out.length || !cov.some((n) => n > 0)) return out;
  let best = 0;
  cov.forEach((n, i) => n > cov[best] && (best = i));
  return [best];
}

/** True if the ranges cover only whole groups. */
export function isAligned(ranges: Range[], ledCount: number, groupSize: number): boolean {
  const bounds = groupBounds(ledCount, groupSize);
  return coverage(ranges, ledCount, groupSize).every((n, i) => n === 0 || n === bounds[i][1] - bounds[i][0] + 1);
}
