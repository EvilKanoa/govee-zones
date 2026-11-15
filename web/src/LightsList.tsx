import { useEffect, useRef, useState } from 'react';
import { hexToRgb, miredsToRgb, rgbToHex } from '../../src/shared/color';
import type { AppSnapshot, Capability, Device, LightCommand, LightState, VirtualLight } from '../../src/shared/types';
import { api } from './api';
import type { Run } from './App';
import { ConfirmDelete } from './DevicesPage';
import { formatRanges, parseRanges, tagColor } from './ranges';

const capLabel: Record<Capability, string> = {
  onoff: 'On/off',
  dimmable: 'Dimmable',
  rgb: 'RGB',
  rgb_ct: 'RGB + color temp',
};

interface Props {
  device: Device;
  lights: VirtualLight[];
  snapshot: AppSnapshot;
  released: boolean;
  run: Run;
}

/** Lights in priority order, highest first. Drag rows to reorder. */
export function LightsList({ device, lights, snapshot, released, run }: Props) {
  const ordered = [...lights].sort((a, b) => b.priority - a.priority || b.order - a.order);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  /** Move one step up (higher priority) or down; works on touch where drag-and-drop doesn't. */
  const move = (id: string, dir: -1 | 1) => {
    const ids = ordered.map((l) => l.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void run(() => api.reorder(device.id, ids.reverse()));
  };

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = ordered.map((l) => l.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    // API takes lowest → highest priority.
    void run(() => api.reorder(device.id, [...ids].reverse()));
  };

  return (
    <div className="lights">
      <div className="section-head">
        <h3>Lights</h3>
        <span className="muted">Top of the list wins where lights overlap.</span>
      </div>
      {ordered.length === 0 && <p className="muted">No lights yet. Drag across the strip above to select LEDs, then create one.</p>}
      {ordered.map((l, idx) => (
        <div
          key={l.id}
          className={`light-row${overId === l.id && dragId !== l.id ? ' drop-target' : ''}`}
          onDragOver={(e) => {
            if (!dragId) return;
            e.preventDefault();
            setOverId(l.id);
          }}
          onDragLeave={() => setOverId((o) => (o === l.id ? null : o))}
          onDrop={(e) => {
            e.preventDefault();
            drop(l.id);
            setDragId(null);
            setOverId(null);
          }}
        >
          <LightRow
            light={l}
            state={snapshot.states[l.id]}
            released={released}
            run={run}
            dragHandle={
              <span className="order">
              <span className="order-buttons">
                <button className="icon" onClick={() => move(l.id, -1)} disabled={idx === 0} aria-label="Raise priority">
                  ▲
                </button>
                <button className="icon" onClick={() => move(l.id, 1)} disabled={idx === ordered.length - 1} aria-label="Lower priority">
                  ▼
                </button>
              </span>
              <span
                className="handle"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  setDragId(l.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                title="Drag to change priority"
              >
                ⋮⋮
              </span>
              </span>
            }
          />
        </div>
      ))}
    </div>
  );
}

function LightRow({
  light,
  state,
  released,
  run,
  dragHandle,
}: {
  light: VirtualLight;
  state?: LightState;
  released: boolean;
  run: Run;
  dragHandle: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const send = useDebouncedCommand(light.id, run);
  const cap = light.capability;
  const on = state?.on ?? false;

  return (
    <div className="light">
      <div className="light-main">
        {dragHandle}
        <span className="tag" style={{ background: tagColor(light) }} />
        <div className="light-name">
          <strong>{light.name}</strong>
          <span className="muted small">
            {capLabel[cap]} · LEDs {formatRanges(light.ranges) || 'none'}
          </span>
        </div>

        <label className="switch" title={on ? 'Turn off' : 'Turn on'}>
          <input type="checkbox" checked={on} onChange={(e) => run(() => api.command(light.id, { state: e.target.checked ? 'ON' : 'OFF' }))} />
          <span />
        </label>

        {cap !== 'onoff' && (
          <input
            className="slider"
            type="range"
            min={1}
            max={255}
            value={state?.brightness ?? 255}
            title="Brightness"
            onChange={(e) => send({ state: 'ON', brightness: Number(e.target.value) })}
          />
        )}
        {(cap === 'rgb' || cap === 'rgb_ct') && (
          <input
            type="color"
            value={rgbToHex(state?.color ?? light.defaults.color)}
            title="Color"
            onChange={(e) => {
              const [r, g, b] = hexToRgb(e.target.value);
              send({ state: 'ON', color: { r, g, b } });
            }}
          />
        )}
        {cap === 'rgb_ct' && (
          <input
            className="slider ct"
            type="range"
            min={153}
            max={500}
            value={state?.colorTemp ?? 370}
            title="Color temperature"
            onChange={(e) => send({ state: 'ON', color_temp: Number(e.target.value) })}
          />
        )}

        <div className="row tight light-actions">
          <button className="btn ghost" onClick={() => run(() => api.identify(light.id))} disabled={released} title="Flash this light's LEDs on the real strip">
            Identify
          </button>
          <button className="btn ghost" onClick={() => setEditing((x) => !x)}>
            {editing ? 'Close' : 'Edit'}
          </button>
        </div>
      </div>
      {editing && <LightEditor light={light} run={run} onDone={() => setEditing(false)} />}
    </div>
  );
}

/** Slider/picker drags fire many events; send at most every 80 ms, without a fade. */
function useDebouncedCommand(lightId: string, run: Run) {
  const pending = useRef<LightCommand | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (cmd: LightCommand) => {
    pending.current = { ...cmd, transition: 0 };
    if (timer.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const c = pending.current;
      pending.current = null;
      if (c) void run(() => api.command(lightId, c));
    }, 80);
  };
}

function LightEditor({ light, run, onDone }: { light: VirtualLight; run: Run; onDone: () => void }) {
  const [name, setName] = useState(light.name);
  const [capability, setCapability] = useState<Capability>(light.capability);
  const [color, setColor] = useState(rgbToHex(light.defaults.color));
  const [brightness, setBrightness] = useState(light.defaults.brightness);
  const [colorTemp, setColorTemp] = useState(light.defaults.colorTemp ?? 370);
  const [useCt, setUseCt] = useState(light.defaults.colorTemp !== undefined);
  const [transitionMs, setTransitionMs] = useState(light.transitionMs);
  const [ranges, setRanges] = useState(formatRanges(light.ranges));
  const parsed = parseRanges(ranges);

  const save = () =>
    run(async () => {
      if (!parsed) throw new Error('LED ranges must look like "0-9, 40-44, 50"');
      const ct = capability === 'rgb_ct' && useCt;
      await api.updateLight(light.id, {
        name,
        capability,
        transitionMs,
        ranges: parsed,
        defaults: { color: ct ? miredsToRgb(colorTemp) : hexToRgb(color), brightness, ...(ct ? { colorTemp } : {}) },
      });
      onDone();
    });

  return (
    <form
      className="light-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid3">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
          <small>Becomes the Home Assistant entity name.</small>
        </label>
        <label>
          Capability
          <select value={capability} onChange={(e) => setCapability(e.target.value as Capability)}>
            {Object.entries(capLabel).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Fade time (ms)
          <input type="number" min={0} max={60000} step={100} value={transitionMs} onChange={(e) => setTransitionMs(Number(e.target.value))} />
        </label>
        <label>
          LED ranges
          <input value={ranges} onChange={(e) => setRanges(e.target.value)} aria-invalid={!parsed} placeholder="0-9, 40-44" />
        </label>
        <fieldset>
          <legend>Default look when turned on</legend>
          {capability === 'rgb_ct' && (
            <label className="check">
              <input type="checkbox" checked={useCt} onChange={(e) => setUseCt(e.target.checked)} />
              Use color temperature
            </label>
          )}
          <div className="row tight">
            {capability === 'rgb_ct' && useCt ? (
              <input type="range" className="slider ct" min={153} max={500} value={colorTemp} onChange={(e) => setColorTemp(Number(e.target.value))} title={`${Math.round(1e6 / colorTemp)} K`} />
            ) : (
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            )}
            <input type="range" className="slider" min={1} max={255} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} title="Brightness" />
          </div>
        </fieldset>
      </div>
      <div className="row">
        <button className="btn" type="submit" disabled={!parsed}>
          Save
        </button>
        <button className="btn ghost" type="button" onClick={onDone}>
          Cancel
        </button>
        <span className="spacer" />
        <ConfirmDelete label="Delete light" onConfirm={() => run(() => api.deleteLight(light.id))} />
      </div>
    </form>
  );
}
