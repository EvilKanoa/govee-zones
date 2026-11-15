import type { Range, VirtualLight } from '../../src/shared/types';

export function rangesToSet(ranges: Range[]): Set<number> {
  const s = new Set<number>();
  for (const [a, b] of ranges) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) s.add(i);
  return s;
}

/** Collapse a set of LED indices into sorted, inclusive, contiguous ranges. */
export function setToRanges(s: Set<number>): Range[] {
  const sorted = [...s].sort((a, b) => a - b);
  const out: Range[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else out.push([i, i]);
  }
  return out;
}

export function formatRanges(r: Range[]): string {
  return r.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/** Parse "0-9, 40-44, 50" into ranges; returns null if malformed. */
export function parseRanges(text: string): Range[] | null {
  const out: Range[] = [];
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    out.push([Math.min(a, b), Math.max(a, b)]);
  }
  return setToRanges(rangesToSet(out));
}

/** Stable, distinct UI color per light, independent of the light's actual color. */
export function tagColor(light: VirtualLight): string {
  return `hsl(${(light.order * 67 + 200) % 360} 70% 55%)`;
}
