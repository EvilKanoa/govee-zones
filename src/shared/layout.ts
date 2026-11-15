// House-outline layout: where each LED sits on a traced polyline.

/** A vertex of the traced strip path. `led` pins a known LED index to this point. */
export interface LayoutPoint {
  x: number;
  y: number;
  led?: number;
}

/** Drawn in a 1000-wide coordinate space; `height` follows the background photo's aspect. */
export interface Layout {
  height: number;
  points: LayoutPoint[];
  /** Background photo version (upload timestamp); absent when there is no photo. */
  background?: number;
}

export const LAYOUT_WIDTH = 1000;

/**
 * Position of every LED along the polyline. The first and last points are
 * pinned to the first and last LEDs unless set otherwise; LEDs between two
 * pinned points are spaced evenly by distance. Pins that don't increase along
 * the path are ignored. Returns null for LEDs outside the pinned span, and
 * an empty array when there is no usable path.
 */
export function ledPositions(layout: Layout | undefined, ledCount: number): ({ x: number; y: number } | null)[] {
  const pts = layout?.points ?? [];
  if (pts.length < 2 || ledCount < 1) return [];

  const dist = [0];
  for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));

  const anchors: { d: number; led: number }[] = [];
  pts.forEach((p, i) => {
    const led = p.led ?? (i === 0 ? 0 : i === pts.length - 1 ? ledCount - 1 : undefined);
    if (led === undefined) return;
    const prev = anchors[anchors.length - 1];
    if (!prev || (led > prev.led && dist[i] > prev.d)) anchors.push({ d: dist[i], led });
  });

  const at = (d: number) => {
    let i = 1;
    while (i < dist.length - 1 && dist[i] < d) i++;
    const seg = dist[i] - dist[i - 1] || 1;
    const t = Math.max(0, Math.min(1, (d - dist[i - 1]) / seg));
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
  };

  const out: ({ x: number; y: number } | null)[] = Array(ledCount).fill(null);
  for (let a = 0; a < anchors.length - 1; a++) {
    const { d: d0, led: l0 } = anchors[a];
    const { d: d1, led: l1 } = anchors[a + 1];
    for (let k = l0; k <= Math.min(l1, ledCount - 1); k++) out[k] = at(d0 + ((k - l0) / (l1 - l0)) * (d1 - d0));
  }
  return out;
}
