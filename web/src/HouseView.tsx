import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LAYOUT_WIDTH, ledPositions, type Layout, type LayoutPoint } from '../../src/shared/layout';
import { api } from './api';
import { ConfirmDelete } from './DevicesPage';
import { tagColor } from './ranges';
import { livePx, type ViewProps } from './StripPage';

type Pt = { x: number; y: number };

const emptyLayout: Layout = { height: 500, points: [] };

/** Distance from p to segment ab, and the closest point on it. */
function toSegment(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  const q = { x: a.x + t * dx, y: a.y + t * dy };
  return { d: Math.hypot(p.x - q.x, p.y - q.y), q };
}

/** Downscale a photo to ≤1600 px wide JPEG in the browser before uploading. */
async function prepPhoto(file: File): Promise<{ blob: Blob; aspect: number }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / bmp.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('could not encode photo'))), 'image/jpeg', 0.85));
  return { blob, aspect: bmp.height / bmp.width };
}

export function HouseView({ device, coverage, frame, boundaries, groupsActive, selection, tool, onSelect, onPixel, run }: ViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [layout, setLayout] = useState<Layout>(device.layout ?? emptyLayout);
  const [brush, setBrush] = useState<Set<number> | null>(null);
  const [vertexDrag, setVertexDrag] = useState<{ index: number; moved: boolean } | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [unitsPerPx, setUnitsPerPx] = useState(1);

  // Follow server changes, except while dragging a vertex.
  useEffect(() => {
    if (!vertexDrag) setLayout(device.layout ?? emptyLayout);
  }, [device.layout]);
  useEffect(() => {
    if (tool !== 'outline') setActive(null);
  }, [tool]);

  // SVG units per screen pixel, so hit targets stay finger-sized on phones.
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setUnitsPerPx(LAYOUT_WIDTH / Math.max(1, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const positions = useMemo(() => ledPositions(layout, device.ledCount), [layout, device.ledCount]);
  const placed = positions.filter(Boolean).length;
  const pathLength = useMemo(() => {
    let d = 0;
    for (let i = 1; i < layout.points.length; i++)
      d += Math.hypot(layout.points[i].x - layout.points[i - 1].x, layout.points[i].y - layout.points[i - 1].y);
    return d;
  }, [layout.points]);
  const ledR = Math.max(Math.min((pathLength / Math.max(1, placed)) * 0.42, 14), 3.5 * unitsPerPx);
  const hitR = Math.max(ledR * 1.4, 14 * unitsPerPx);

  /** Group dividers: a short tick across the path between the last LED of a group and the first of the next. */
  const dividers = useMemo(() => {
    const half = ledR * 1.7 + 3 * unitsPerPx;
    const out: { b: number; x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const b of boundaries) {
      const p0 = positions[b - 1];
      const p1 = positions[b];
      if (!p0 || !p1) continue;
      const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
      const nx = -(p1.y - p0.y) / len;
      const ny = (p1.x - p0.x) / len;
      const mx = (p0.x + p1.x) / 2;
      const my = (p0.y + p1.y) / 2;
      out.push({ b, x1: mx - nx * half, y1: my - ny * half, x2: mx + nx * half, y2: my + ny * half });
    }
    return out;
  }, [boundaries, positions, ledR, unitsPerPx]);

  const save = (next: Layout) => {
    setLayout(next);
    void run(() => api.updateDevice(device.id, { layout: next }));
  };

  const toSvg = (e: React.PointerEvent): Pt => {
    const svg = svgRef.current!;
    const m = svg.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return { x: Math.max(0, Math.min(LAYOUT_WIDTH, p.x)), y: Math.max(0, Math.min(layout.height, p.y)) };
  };

  const ledsNear = (p: Pt) => {
    const out: number[] = [];
    positions.forEach((q, i) => q && Math.hypot(q.x - p.x, q.y - p.y) <= hitR && out.push(i));
    return out;
  };
  const nearestLed = (p: Pt) => {
    let best: number | null = null;
    let bestD = hitR;
    positions.forEach((q, i) => {
      const d = q ? Math.hypot(q.x - p.x, q.y - p.y) : Infinity;
      if (d <= bestD) [best, bestD] = [i, d];
    });
    return best;
  };

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toSvg(e);
    if (tool === 'finder') {
      const i = nearestLed(p);
      if (i !== null) onPixel(i);
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'select') {
      setBrush(new Set(ledsNear(p)));
      return;
    }
    // Outline editing: grab a vertex, else insert on a nearby segment, else append.
    const pts = layout.points;
    const v = pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) <= hitR);
    if (v >= 0) {
      setVertexDrag({ index: v, moved: false });
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      const { d, q } = toSegment(p, pts[i - 1], pts[i]);
      if (d <= hitR * 0.7) {
        const next = [...pts.slice(0, i), { x: q.x, y: q.y }, ...pts.slice(i)];
        save({ ...layout, points: next });
        setActive(i);
        return;
      }
    }
    save({ ...layout, points: [...pts, p] });
    setActive(pts.length);
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (brush) {
      const near = ledsNear(toSvg(e));
      if (near.some((i) => !brush.has(i))) setBrush(new Set([...brush, ...near]));
    } else if (vertexDrag) {
      const p = toSvg(e);
      setLayout((l) => ({ ...l, points: l.points.map((q, i) => (i === vertexDrag.index ? { ...q, x: p.x, y: p.y } : q)) }));
      if (!vertexDrag.moved) setVertexDrag({ ...vertexDrag, moved: true });
    }
  };

  const onUp = () => {
    if (brush) onSelect(brush);
    if (vertexDrag) {
      if (vertexDrag.moved) save(layout);
      setActive(vertexDrag.index);
    }
    setBrush(null);
    setVertexDrag(null);
  };

  const setPoint = (i: number, patch: Partial<LayoutPoint>) =>
    save({ ...layout, points: layout.points.map((q, k) => (k === i ? { ...q, ...patch } : q)) });

  const uploadPhoto = (file: File) =>
    run(async () => {
      const { blob, aspect } = await prepPhoto(file);
      const { version } = await api.uploadBackground(device.id, blob);
      const height = Math.round(LAYOUT_WIDTH * aspect);
      // Keep traced points in place relative to the new photo's height.
      const sy = height / layout.height;
      save({ height, background: version, points: layout.points.map((q) => ({ ...q, y: q.y * sy })) });
    });

  const removePhoto = () =>
    run(async () => {
      await api.deleteBackground(device.id);
      save({ ...layout, background: undefined });
    });

  const activePoint = active !== null ? layout.points[active] : undefined;
  /** LED the active point lands on when not pinned, for the input placeholder. */
  const autoLed = activePoint ? nearestTo(positions, activePoint) : null;

  return (
    <div className="house-wrap">
      <svg
        ref={svgRef}
        className={`house tool-${tool}`}
        viewBox={`0 0 ${LAYOUT_WIDTH} ${layout.height}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => (setBrush(null), setVertexDrag(null))}
      >
        {layout.background ? (
          <image
            href={`/api/devices/${device.id}/background?v=${layout.background}`}
            width={LAYOUT_WIDTH}
            height={layout.height}
            preserveAspectRatio="none"
            opacity={tool === 'outline' ? 0.85 : 0.55}
          />
        ) : (
          <rect width={LAYOUT_WIDTH} height={layout.height} className="house-bg" />
        )}

        {layout.points.length === 0 && (
          <text x={LAYOUT_WIDTH / 2} y={layout.height / 2} className="house-empty" fontSize={16 * unitsPerPx}>
            {tool === 'outline' ? 'Tap along the roofline, starting at the LED 0 end' : 'Use “Edit outline” to trace the strip on your house'}
          </text>
        )}

        <polyline
          points={layout.points.map((q) => `${q.x},${q.y}`).join(' ')}
          className={tool === 'outline' ? 'house-path editing' : 'house-path'}
          strokeWidth={(tool === 'outline' ? 2 : 1) * unitsPerPx}
        />

        {tool !== 'outline' && dividers.length > 0 && (
          <g className={`group-dividers${groupsActive ? ' active' : ''}`}>
            {dividers.map((t) => (
              <g key={t.b}>
                <line x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} className="divider-halo" strokeWidth={4 * unitsPerPx} />
                <line x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} className="divider" strokeWidth={1.75 * unitsPerPx} />
              </g>
            ))}
          </g>
        )}

        {positions.map((q, i) => {
          if (!q) return null;
          const covering = coverage[i];
          const top = covering[covering.length - 1];
          const selected = selection.has(i) || brush?.has(i);
          return (
            <g key={i}>
              {selected && <circle cx={q.x} cy={q.y} r={ledR + 2.5 * unitsPerPx} className="led-selected" strokeWidth={2 * unitsPerPx} />}
              <circle
                cx={q.x}
                cy={q.y}
                r={ledR}
                fill={livePx(frame, i)}
                stroke={top ? tagColor(top) : 'rgb(255 255 255 / 0.25)'}
                strokeWidth={Math.max(1.5 * unitsPerPx, ledR * 0.35)}
                strokeDasharray={covering.length > 1 ? `${ledR * 0.6} ${ledR * 0.4}` : undefined}
              >
                <title>{`LED ${i}${covering.length ? ' · ' + covering.map((l) => l.name).join(' < ') : ''}`}</title>
              </circle>
              {i % 10 === 0 && (
                <text x={q.x} y={q.y - ledR - 4 * unitsPerPx} className="led-index" fontSize={10 * unitsPerPx}>
                  {i}
                </text>
              )}
            </g>
          );
        })}

        {tool === 'outline' &&
          layout.points.map((q, i) => (
            <g key={i} className={i === active ? 'vertex active' : 'vertex'}>
              <circle cx={q.x} cy={q.y} r={7 * unitsPerPx} strokeWidth={2 * unitsPerPx} />
              {(q.led !== undefined || i === 0 || i === layout.points.length - 1) && (
                <text
                  x={q.x > LAYOUT_WIDTH * 0.8 ? q.x - 10 * unitsPerPx : q.x + 10 * unitsPerPx}
                  y={q.y + 4 * unitsPerPx}
                  fontSize={11 * unitsPerPx}
                  textAnchor={q.x > LAYOUT_WIDTH * 0.8 ? 'end' : 'start'}
                >
                  {q.led ?? (i === 0 ? 0 : device.ledCount - 1)}
                  {q.led === undefined ? ' (auto)' : ''}
                </text>
              )}
            </g>
          ))}
      </svg>

      {tool !== 'outline' && layout.points.length >= 2 && placed < device.ledCount && (
        <p className="muted small">
          {device.ledCount - placed} LEDs aren't on the outline (only {placed} are placed). Pin the first/last points to change the span.
        </p>
      )}

      {tool === 'outline' && (
        <div className="outline-panel">
          <p className="muted small">
            Tap to add points along the strip in LED order. Drag points to move them; tap a line to insert a point. LEDs are
            spread evenly between points, so pin corners to their real LED number (find it with Pixel finder) for an
            accurate map.
          </p>

          {activePoint && active !== null && (
            <div className="row point-editor">
              <strong>Point {active + 1}</strong>
              <label className="inline">
                LED
                <input
                  type="number"
                  min={0}
                  max={device.ledCount - 1}
                  value={activePoint.led ?? ''}
                  placeholder={autoLed !== null ? `${autoLed} (auto)` : 'auto'}
                  onChange={(e) => setPoint(active, { led: e.target.value === '' ? undefined : Number(e.target.value) })}
                />
              </label>
              {activePoint.led !== undefined && (
                <button className="btn ghost" onClick={() => setPoint(active, { led: undefined })}>
                  Unpin
                </button>
              )}
              <button
                className="btn ghost"
                onClick={() => {
                  save({ ...layout, points: layout.points.filter((_, k) => k !== active) });
                  setActive(null);
                }}
              >
                Delete point
              </button>
            </div>
          )}

          <div className="row">
            <button className="btn ghost" onClick={() => fileRef.current?.click()}>
              {layout.background ? 'Replace photo' : 'Add house photo'}
            </button>
            {layout.background && (
              <button className="btn ghost" onClick={removePhoto}>
                Remove photo
              </button>
            )}
            <button
              className="btn ghost"
              disabled={!layout.points.length}
              onClick={() => {
                save({ ...layout, points: layout.points.slice(0, -1) });
                setActive(null);
              }}
            >
              Undo last point
            </button>
            {layout.points.length > 0 && (
              <ConfirmDelete label="Clear outline" onConfirm={() => (save({ ...layout, points: [] }), setActive(null))} />
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadPhoto(f);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function nearestTo(positions: (Pt | null)[], p: Pt): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  positions.forEach((q, i) => {
    const d = q ? Math.hypot(q.x - p.x, q.y - p.y) : Infinity;
    if (d < bestD) [best, bestD] = [i, d];
  });
  return best;
}
