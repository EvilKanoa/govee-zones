import { describe, expect, it } from 'vitest';
import type { Device, VirtualLight } from '../../src/shared/types';
import { coverageLabel, markGlyph, modeExplanation, ownersChanged, ownersTitle, roundedCoverage, roundingActive, roundingMarks, snapSelection } from '../src/control';
import { rangesToSet } from '../src/ranges';

const dev = (p: Partial<Device> = {}): Device => ({
  id: 'd', name: 's', ip: 'x', ledCount: 60, maxColorsPerPacket: 84, keepaliveMs: 2000, enabled: true,
  groupSize: 4, control: 'auto', partialGroups: 'round', ...p,
});
let order = 0;
const light = (name: string, ranges: [number, number][], priority = 0): VirtualLight => ({
  id: name, name, deviceId: 'd', ranges, priority, capability: 'ct',
  defaults: { brightness: 255, look: { kind: 'white', mireds: 370 } }, transitionMs: 0, order: order++,
});
const exactCoverage = (lights: VirtualLight[], n = 60) => {
  const byLed: VirtualLight[][] = Array.from({ length: n }, () => []);
  for (const l of [...lights].sort((a, b) => a.priority - b.priority || a.order - b.order)) for (const i of rangesToSet(l.ranges)) byLed[i].push(l);
  return byLed;
};

describe('rounding display', () => {
  const gutter = light('Gutter', [[9, 14]]); // groups 2 (8-11, 3/4) and 3 (12-15, 3/4) → LEDs 8-15
  const tiny = light('Tiny', [[3, 4]]); // 1/4 of groups 0 and 1 → snaps to group 0 (LEDs 0-3)

  it('applies only when group control is usable and set to round', () => {
    expect(roundingActive(dev())).toBe(true);
    expect(roundingActive(dev({ partialGroups: 'exact' }))).toBe(false);
    expect(roundingActive(dev({ control: 'per_led' }))).toBe(false);
    expect(roundingActive(dev({ groupSize: 0 }))).toBe(false);
  });

  it('marks LEDs that rounding gives to a different light, with who had them as set', () => {
    const exact = exactCoverage([gutter, tiny]);
    const rounded = roundedCoverage(exact, [gutter, tiny], dev());
    const changed = exact.map((c, i) => ownersChanged(c, rounded[i]));
    expect(changed.flatMap((c, i) => (c ? [i] : []))).toEqual([0, 1, 2, 4, 8, 15]);
    expect(ownersTitle(exact[8], rounded[8])).toBe(' · as set: no light → rounded: Gutter');
    expect(ownersTitle(exact[4], rounded[4])).toBe(' · as set: Tiny → rounded: no light');
    expect(ownersTitle(exact[9], rounded[9])).toBe(' · Gutter');
  });

  it('adjacent lights: the boundary moves, so one light gains what the other loses', () => {
    const left = light('Left', [[0, 9]]); // group 2 (8-11) is 2/4 → included
    const right = light('Right', [[10, 19]]); // group 2 is 2/4 → included too
    const exact = exactCoverage([left, right]);
    const rounded = roundedCoverage(exact, [left, right], dev());
    // Both round onto group 2 (LEDs 8-11); the later-created light wins it, so the boundary moves left.
    expect(ownersTitle(exact[8], rounded[8])).toBe(' · as set: Left → rounded: Right');
    expect(ownersTitle(exact[9], rounded[9])).toBe(' · as set: Left → rounded: Right');
    expect(ownersTitle(exact[11], rounded[11])).toBe(' · Right'); // unchanged
  });

  it('arrows point the way the gaining light grows; ✕ where rounding leaves an LED dark', () => {
    const porch = light('Porch', [[0, 9]]); // group 2 half → Gutter (created later) wins it
    const gut = light('Gutter2', [[10, 21]]); // also takes group 5 (20-23)
    const garage = light('Garage', [[24, 40]]); // group 10 (40-43) is 1/4 → LED 40 goes dark
    const exact = exactCoverage([porch, gut, garage]);
    const marks = roundingMarks(exact, roundedCoverage(exact, [porch, gut, garage], dev()));
    const glyphs = marks.map((m, i) => (m ? `${i}${markGlyph(m)}${m.light.name}` : null)).filter(Boolean);
    expect(glyphs).toEqual(['8◀Gutter2', '9◀Gutter2', '22▶Gutter2', '23▶Gutter2', '40✕Garage']);
  });

  it('aligned lights change nothing', () => {
    const a = light('A', [[0, 7]]);
    const exact = exactCoverage([a]);
    const rounded = roundedCoverage(exact, [a], dev());
    expect(exact.some((c, i) => ownersChanged(c, rounded[i]))).toBe(false);
  });
});

describe('labels', () => {
  it('coverageLabel', () => {
    expect(coverageLabel(light('A', [[20, 27]]), dev()).text).toBe('groups 6–7');
    expect(coverageLabel(light('G', [[22, 29]]), dev()).text).toBe('LEDs 22-29 → 20-31');
    expect(coverageLabel(light('G', [[22, 29]]), dev({ partialGroups: 'exact' }))).toMatchObject({ text: 'LEDs 22-29', warn: true });
    expect(coverageLabel(light('G', [[22, 29]]), dev({ groupSize: 0 })).text).toBe('LEDs 22-29');
  });

  it('snapSelection expands to whole groups', () => {
    expect([...snapSelection(new Set([5, 6]), dev())].sort((a, b) => a - b)).toEqual([4, 5, 6, 7]);
  });

  it('modeExplanation', () => {
    expect(modeExplanation({ mode: 'groups', reason: 'auto' })).toBe('Real white. The strip holds its lights on its own.');
    expect(modeExplanation({ mode: 'per_led', reason: 'exact_leds', detail: ['Gutter'] })).toBe(
      'Gutter uses exact LEDs and is on. White is mixed from RGB until it turns off.',
    );
    expect(modeExplanation({ mode: 'per_led', reason: 'override', detail: ['pixel finder'] })).toBe('Pixel finder running. Returns to Groups when done.');
  });
});
