import { describe, expect, it } from 'vitest';
import { coverage, groupBoundaries, groupBounds, groupCount, groupsUnavailable, isAligned, roundToGroups } from '../src/shared/groups.js';
import type { Range } from '../src/shared/types.js';

// The house strip: 60 LEDs, groups of 4 → 15 groups.
const N = 60;
const S = 4;

describe('group geometry', () => {
  it.each([
    [60, 4, 15, [0, 3], [56, 59], 14],
    [62, 4, 16, [0, 3], [60, 61], 15],
    [60, 0, 0, undefined, undefined, 0],
  ])('%i LEDs, size %i → %i groups', (leds, size, count, first, last, boundaries) => {
    expect(groupCount(leds, size)).toBe(count);
    const b = groupBounds(leds, size);
    expect(b[0]).toEqual(first);
    expect(b.at(-1)).toEqual(last);
    expect(groupBoundaries(leds, size)).toHaveLength(boundaries);
  });

  it('boundaries are where each group after the first starts', () => {
    expect(groupBoundaries(N, S)).toEqual([4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56]);
    expect(groupBoundaries(62, 4).at(-1)).toBe(60);
  });

  it('availability', () => {
    expect(groupsUnavailable({ ledCount: 60, groupSize: 4, control: 'auto' })).toBeNull();
    expect(groupsUnavailable({ ledCount: 60, groupSize: 0, control: 'auto' })).toBe('groups_off');
    expect(groupsUnavailable({ ledCount: 200, groupSize: 4, control: 'auto' })).toBe('too_many_groups');
    expect(groupsUnavailable({ ledCount: 96, groupSize: 4, control: 'auto' })).toBeNull(); // exactly 24
    expect(groupsUnavailable({ ledCount: 60, groupSize: 4, control: 'per_led' })).toBe('per_led_setting');
  });

  it('coverage counts LEDs per group', () => {
    expect(coverage([[2, 5]], N, S).slice(0, 3)).toEqual([2, 2, 0]);
  });
});

describe('roundToGroups (60 LEDs, size 4)', () => {
  it.each<[Range[], number[], string]>([
    [[[0, 3]], [0], 'aligned'],
    [[[0, 5]], [0, 1], 'group 1 is 2/4 = 50 % → included'],
    [[[0, 4]], [0], 'group 1 is only 1/4'],
    [[[1, 3]], [0], '3/4'],
    [[[2, 5]], [0, 1], '2/4 each → both'],
    [[[3, 4]], [0], '1/4 each → fallback to most covered, tie → lowest'],
    [[[0, 3], [20, 23]], [0, 5], 'multi-range'],
    [[[56, 59]], [14], 'last group'],
    [[], [], 'empty'],
  ])('%j → %j (%s)', (ranges, groups) => {
    expect(roundToGroups(ranges, N, S)).toEqual(groups);
  });

  it('never drops a light; moves edges ≤ 2 LEDs unless the light half-covers no group (exhaustive)', () => {
    for (let a = 0; a < N; a++)
      for (let b = a; b < N; b++) {
        const groups = roundToGroups([[a, b]], N, S);
        expect(groups.length).toBeGreaterThan(0);
        const lo = groups[0] * S;
        const hi = groups.at(-1)! * S + S - 1;
        if (coverage([[a, b]], N, S).some((n) => 2 * n >= S)) {
          expect(Math.abs(lo - a)).toBeLessThanOrEqual(2);
          expect(Math.abs(hi - b)).toBeLessThanOrEqual(2);
        } else {
          // Tiny light (≤ 3 LEDs across a boundary): it snaps onto a group it overlaps.
          expect(b >= lo && a <= hi).toBe(true);
        }
      }
  });

  it('isAligned', () => {
    expect(isAligned([[4, 11]], N, S)).toBe(true);
    expect(isAligned([[4, 10]], N, S)).toBe(false);
    expect(isAligned([], N, S)).toBe(true);
  });
});
