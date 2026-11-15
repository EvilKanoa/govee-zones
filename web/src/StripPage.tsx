import { useEffect, useMemo, useState } from 'react';
import type { AppSnapshot, Device, DeviceStatus, VirtualLight } from '../../src/shared/types';
import { api } from './api';
import type { Run } from './App';
import { boundarySet, groupsUsable, hasGroups, MODE_LABEL, modeExplanation, ownersTitle, roundedCoverage, roundingActive, roundingAt, snapSelection } from './control';
import { HouseView } from './HouseView';
import { LightsList } from './LightsList';
import { WhiteBalance } from './WhiteBalance';
import { rangesToSet, setToRanges, tagColor } from './ranges';

export function ModeBadge({ status }: { status?: DeviceStatus }) {
  const mode = status?.mode ?? 'idle';
  return (
    <span className={`badge mode-${mode}`} title={modeExplanation(status)}>
      {MODE_LABEL[mode]}
    </span>
  );
}

/** Which lights cover each LED, bottom (lowest priority) first. */
export type Coverage = VirtualLight[][];

/** How a pointer gesture over LEDs should behave. */
export type Tool = 'select' | 'finder' | 'outline';

export interface ViewProps {
  device: Device;
  coverage: Coverage;
  /** Per LED, the lights that cover it after rounding to groups; set only when rounding applies. */
  rounded?: Coverage;
  frame?: Uint8Array;
  /** LED indices where a new group starts: drawn as dividers in both views. */
  boundaries: Set<number>;
  /** Dividers are bold in group mode and dimmed otherwise. */
  groupsActive: boolean;
  /** Per LED: shows the strip's real white (group mode). */
  realWhiteLeds?: boolean[];
  selection: Set<number>;
  tool: Tool;
  /** Commit a gesture's LEDs to the selection. */
  onSelect: (leds: Set<number>) => void;
  onPixel: (led: number) => void;
  run: Run;
}

interface Props {
  device: Device;
  snapshot: AppSnapshot;
  frame?: Uint8Array;
  realWhite?: boolean[];
  run: Run;
}

const VIEW_KEY = 'govee-zones:view';

export function StripPage({ device, snapshot, frame, realWhite, run }: Props) {
  const lights = useMemo(
    () => snapshot.lights.filter((l) => l.deviceId === device.id),
    [snapshot.lights, device.id],
  );
  const status = snapshot.status[device.id];
  const released = snapshot.flags[device.id]?.released ?? false;

  const [view, setView] = useState<'strip' | 'house'>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'house' ? 'house' : 'strip';
    } catch {
      return 'strip';
    }
  });
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [tool, setTool] = useState<Tool>('select');
  const [additive, setAdditive] = useState(false);
  const [fine, setFine] = useState(false);
  const boundaries = useMemo(() => boundarySet(device), [device.ledCount, device.groupSize]);
  const snapping = hasGroups(device) && !fine;
  const realWhiteLeds = useMemo(
    // Marked on the first LED of each real-white group.
    () =>
      realWhite && status?.mode === 'groups'
        ? Array.from({ length: device.ledCount }, (_, i) => i % device.groupSize === 0 && !!realWhite[i / device.groupSize])
        : undefined,
    [realWhite, status?.mode, device.ledCount, device.groupSize],
  );
  const [target, setTarget] = useState<string>('');

  const coverage = useMemo(() => {
    const byLed: Coverage = Array.from({ length: device.ledCount }, () => []);
    const ordered = [...lights].sort((a, b) => a.priority - b.priority || a.order - b.order);
    for (const l of ordered) for (const i of rangesToSet(l.ranges)) if (i < device.ledCount) byLed[i].push(l);
    return byLed;
  }, [lights, device.ledCount]);
  const overlapCount = coverage.filter((c) => c.length > 1).length;
  const rounded = useMemo(
    () => (roundingActive(device) ? roundedCoverage(coverage, lights, device) : undefined),
    [coverage, lights, device.ledCount, device.groupSize, device.control, device.partialGroups],
  );
  /** LEDs whose owners change with rounding: drives the legend. */
  const roundingChanges = useMemo(() => {
    if (!rounded) return { added: 0, dropped: 0 };
    let added = 0, dropped = 0;
    coverage.forEach((c, i) => {
      const r = roundingAt(c, rounded[i]);
      if (r.added.length) added++;
      if (r.dropped.length) dropped++;
    });
    return { added, dropped };
  }, [coverage, rounded]);

  useEffect(() => {
    if (!lights.some((l) => l.id === target)) setTarget(lights[0]?.id ?? '');
  }, [lights, target]);

  const switchView = (v: 'strip' | 'house') => {
    setView(v);
    if (v === 'strip' && tool === 'outline') setTool('select');
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* per-browser convenience only */
    }
  };

  const changeTool = (t: Tool) => {
    if (tool === 'finder' && t !== 'finder') void run(() => api.stopOverride(device.id));
    setTool(t);
  };

  const onSelect = (picked: Set<number>) =>
    setSelection((sel) => {
      const leds = snapping ? snapSelection(picked, device) : picked;
      if (!additive) return leds;
      const next = new Set(sel);
      for (const i of leds) next.add(i);
      return next;
    });

  const assign = (lightId: string, mode: 'add' | 'remove') => {
    const l = lights.find((x) => x.id === lightId);
    if (!l) return;
    const cells = rangesToSet(l.ranges);
    for (const i of selection) mode === 'add' ? cells.add(i) : cells.delete(i);
    void run(async () => {
      await api.updateLight(l.id, { ranges: setToRanges(cells) });
      setSelection(new Set());
    });
  };

  const createFromSelection = () =>
    run(async () => {
      const top = Math.max(-1, ...lights.map((l) => l.priority));
      const created = await api.addLight({
        name: `Light ${lights.length + 1}`,
        deviceId: device.id,
        ranges: setToRanges(selection),
        priority: top + 1,
      });
      setTarget(created.id);
      setSelection(new Set());
    });

  const viewProps: ViewProps = {
    device,
    coverage,
    rounded,
    frame,
    boundaries,
    groupsActive: status?.mode === 'groups',
    realWhiteLeds,
    selection,
    tool,
    onSelect,
    onPixel: (i) => void run(() => api.pixel(device.id, i)),
    run,
  };
  const canDrive = !released && device.enabled;

  return (
    <section>
      <div className="section-head">
        <h2>
          {device.name} <ModeBadge status={status} />
        </h2>
        <div className="row">
          <label className="check" title="Stop driving the strip so the Govee app can use it (scenes). Light changes are still saved.">
            <input type="checkbox" checked={released} onChange={(e) => run(() => api.release(device.id, e.target.checked))} />
            Release to Govee
          </label>
          <button className="btn ghost" onClick={() => run(() => api.test(device.id))} disabled={!canDrive}>
            Test chase
          </button>
        </div>
      </div>

      {status?.error && <div className="error">Send failed: {status.error}</div>}
      {!device.enabled && <div className="notice">This device is disabled; nothing is sent to it.</div>}
      {released && (
        <div className="notice">
          Released to Govee: govee-zones isn't driving the strip.{' '}
          {groupsUsable(device)
            ? 'The lights stay as they are until you change them in the Govee app.'
            : 'The strip goes back to its Govee scene.'}{' '}
          Light changes are still saved and apply when you take it back.
        </div>
      )}
      {status?.mode === 'per_led' && <p className="muted small mode-why">Per-LED: {modeExplanation(status)}</p>}
      {device.ledCount > device.maxColorsPerPacket && (
        <div className="notice">
          Reduced resolution: {device.ledCount} LEDs are sent as {device.maxColorsPerPacket} colors per frame, so edges
          between lights may blend.
        </div>
      )}

      <div className="strip-toolbar">
        <div className="segmented" role="tablist">
          <button className={view === 'strip' ? 'on' : ''} onClick={() => switchView('strip')}>
            Strip
          </button>
          <button className={view === 'house' ? 'on' : ''} onClick={() => switchView('house')}>
            House
          </button>
        </div>
        <div className="segmented">
          <button className={tool === 'select' ? 'on' : ''} onClick={() => changeTool('select')} title="Drag across LEDs to select them">
            Select
          </button>
          <button
            className={tool === 'finder' ? 'on' : ''}
            onClick={() => changeTool('finder')}
            disabled={!canDrive}
            title="Tap an LED to light it on the real strip"
          >
            Pixel finder
          </button>
          {view === 'house' && (
            <button className={tool === 'outline' ? 'on' : ''} onClick={() => changeTool('outline')} title="Trace the strip's path on the house">
              Edit outline
            </button>
          )}
        </div>
        {tool === 'select' && (
          <label className="check">
            <input type="checkbox" checked={additive} onChange={(e) => setAdditive(e.target.checked)} />
            Add to selection
          </label>
        )}
        {tool === 'select' && hasGroups(device) && (
          <label className="check" title={`Selections snap to whole groups of ${device.groupSize} LEDs unless this is on`}>
            <input type="checkbox" checked={fine} onChange={(e) => setFine(e.target.checked)} />
            Fine (single LEDs)
          </label>
        )}
      </div>
      {tool !== 'outline' && (
        <p className="muted small hint">
          {tool === 'finder'
            ? 'Tap an LED to light just that one on the strip (switches to Per-LED while it runs).'
            : snapping
              ? `Drag across LEDs to select them; selections snap to groups of ${device.groupSize}.`
              : 'Drag across LEDs to select them.'}
          {tool === 'select' && overlapCount > 0 &&
            ` ${overlapCount} LED${overlapCount > 1 ? 's are' : ' is'} covered by more than one light (striped).`}
        </p>
      )}

      {view === 'strip' ? <StripView {...viewProps} /> : <HouseView {...viewProps} />}
      {(roundingChanges.added > 0 || roundingChanges.dropped > 0) && tool !== 'outline' && (
        <p className="muted small rounding-legend">
          Rounding to groups of {device.groupSize}: the {view === 'strip' ? 'bar under each LED' : 'ring around each LED'} shows
          what group control lights.{' '}
          {roundingChanges.added > 0 && (
            <span>
              <span className={`legend-swatch added ${view}`} /> added by rounding ({roundingChanges.added} LED{roundingChanges.added > 1 ? 's' : ''}){' '}
            </span>
          )}
          {roundingChanges.dropped > 0 && (
            <span>
              <span className={`legend-swatch dropped ${view}`} /> dropped by rounding ({roundingChanges.dropped} LED{roundingChanges.dropped > 1 ? 's' : ''})
            </span>
          )}
        </p>
      )}

      {selection.size > 0 && tool === 'select' && (
        <div className="selection-bar">
          <span>
            {selection.size} LED{selection.size > 1 ? 's' : ''} selected
          </span>
          <button className="btn" onClick={createFromSelection}>
            New light
          </button>
          {lights.length > 0 && (
            <span className="row tight">
              <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Light">
                {lights.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <button className="btn ghost" onClick={() => assign(target, 'add')}>
                Add
              </button>
              <button className="btn ghost" onClick={() => assign(target, 'remove')}>
                Remove
              </button>
            </span>
          )}
          <button className="link" onClick={() => setSelection(new Set())}>
            Clear
          </button>
        </div>
      )}

      <LightsList device={device} lights={lights} snapshot={snapshot} released={released} run={run} />
      <WhiteBalance device={device} canDrive={canDrive} run={run} />
    </section>
  );
}

/** Background for an LED's ownership bar: one color, or stripes where lights overlap. */
export function tagFill(covering: VirtualLight[]): string {
  const tags = covering.map(tagColor);
  if (tags.length === 0) return 'transparent';
  if (tags.length === 1) return tags[0];
  return `repeating-linear-gradient(90deg, ${tags.map((c, k) => `${c} ${k * 4}px ${(k + 1) * 4}px`).join(', ')})`;
}

export const livePx = (frame: Uint8Array | undefined, i: number) =>
  frame ? `rgb(${frame[i * 3]}, ${frame[i * 3 + 1]}, ${frame[i * 3 + 2]})` : '#000';

function StripView({ coverage, rounded, frame, boundaries, groupsActive, realWhiteLeds, selection, tool, onSelect, onPixel }: ViewProps) {
  const [drag, setDrag] = useState<{ anchor: number; current: number } | null>(null);

  const span = (d: { anchor: number; current: number }) => {
    const s = new Set<number>();
    for (let i = Math.min(d.anchor, d.current); i <= Math.max(d.anchor, d.current); i++) s.add(i);
    return s;
  };

  // Touch keeps targeting the first cell touched, so find the cell under the finger by position.
  const cellAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-led]');
    return el ? Number(el.dataset.led) : null;
  };

  return (
    <div
      className={`strip${boundaries.size ? ' has-groups' : ''}${groupsActive ? ' groups-active' : ''}`}
      onPointerDown={(e) => {
        const i = cellAt(e.clientX, e.clientY);
        if (i === null) return;
        if (tool === 'finder') return onPixel(i);
        e.preventDefault();
        // Capture so the drag finishes even if released outside the strip.
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ anchor: i, current: i });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const i = cellAt(e.clientX, e.clientY);
        if (i !== null && i !== drag.current) setDrag({ ...drag, current: i });
      }}
      onPointerUp={() => {
        if (drag) onSelect(span(drag));
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {coverage.map((covering, i) => {
        const selected = selection.has(i) || (!!drag && span(drag).has(i));
        let group = 0;
        for (const b of boundaries) if (b <= i) group++;
        const owners = rounded ? rounded[i] : covering;
        const { added, dropped } = rounded ? roundingAt(covering, rounded[i]) : { added: [], dropped: [] };
        const cls = [
          'cell',
          added.length > 0 && 'rounded-in',
          dropped.length > 0 && owners.length === 0 && 'rounded-out',
          selected && 'selected',
          owners.length > 1 && 'overlap',
          tool === 'finder' && 'finder',
          boundaries.has(i) && 'group-start',
          boundaries.size > 0 && group % 2 === 1 && 'band',
          realWhiteLeds?.[i] && 'real-white',
        ].filter(Boolean).join(' ');
        return (
          <div
            key={i}
            data-led={i}
            className={cls}
            title={`LED ${i}${boundaries.size ? ` · group ${group + 1}` : ''}${ownersTitle(covering, rounded?.[i])}`}
          >
            <div className="cell-live" style={{ background: livePx(frame, i) }} />
            <div
              className="cell-tag"
              style={
                owners.length || !dropped.length
                  ? { background: tagFill(owners) }
                  : { borderColor: tagColor(dropped[dropped.length - 1]) }
              }
            />
            {i % 10 === 0 && <span className="cell-index">{i}</span>}
          </div>
        );
      })}
    </div>
  );
}
