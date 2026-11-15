import { useEffect, useRef, useState } from 'react';
import { hexToRgb, lookRgb, MAX_MIREDS, miredsToKelvin, MIN_MIREDS, rgbToHex } from '../../src/shared/color';
import type { AppSnapshot, Capability, Device, DeviceStatus, LightCommand, LightState, Look, VirtualLight } from '../../src/shared/types';
import { api } from './api';
import type { Run } from './App';
import { coverageLabel, modeExplanation } from './control';
import { ConfirmDelete } from './DevicesPage';
import { formatRanges, parseRanges, tagColor } from './ranges';

const capLabel: Record<Capability, string> = {
  onoff: 'On/off',
  rgb: 'RGB',
  ct: 'White',
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
            device={device}
            status={snapshot.status[device.id]}
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
  device,
  status,
  state,
  released,
  run,
  dragHandle,
}: {
  light: VirtualLight;
  device: Device;
  status?: DeviceStatus;
  state?: LightState;
  released: boolean;
  run: Run;
  dragHandle: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const send = useDebouncedCommand(light.id, run);
  const cap = light.capability;
  const on = state?.on ?? false;
  const look = state?.look ?? light.defaults.look;
  const coverage = coverageLabel(light, device);
  // A white look while the strip is per-LED is mixed from RGB, not the strip's real white.
  const approximate = on && look.kind === 'white' && status?.mode === 'per_led';

  return (
    <div className="light">
      <div className="light-main">
        {dragHandle}
        <span className="tag" style={{ background: tagColor(light) }} />
        <div className="light-name">
          <strong>{light.name}</strong>
          <span className={`muted small${coverage.warn ? ' warn' : ''}`}>
            {capLabel[cap]} · {coverage.text}
            {coverage.note && (
              <span className="info" title={coverage.note} aria-label={coverage.note}>
                {coverage.warn ? ' ⚠' : ' ⓘ'}
              </span>
            )}
          </span>
          {approximate && (
            <span className="chip" title={modeExplanation(status)}>
              approximate white
            </span>
          )}
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
            value={state?.brightness ?? light.defaults.brightness}
            title="Brightness"
            onChange={(e) => send({ state: 'ON', brightness: Number(e.target.value) })}
          />
        )}
        {cap === 'rgb' && (
          <input
            type="color"
            value={rgbToHex(lookRgb(look))}
            title="Color"
            onChange={(e) => {
              const [r, g, b] = hexToRgb(e.target.value);
              send({ state: 'ON', color: { r, g, b } });
            }}
          />
        )}
        {cap === 'ct' && <KelvinSlider mireds={look.kind === 'white' ? look.mireds : MAX_MIREDS} onChange={(m) => send({ state: 'ON', color_temp: m })} />}

        <div className="row tight light-actions">
          <button className="btn ghost" onClick={() => run(() => api.identify(light.id))} disabled={released} title="Blink this light on the real strip (its groups, in group mode)">
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

/** Color temperature slider: warm (2700 K) on the left, cool (6500 K) on the right. Value in mireds. */
function KelvinSlider({ mireds, onChange }: { mireds: number; onChange: (mireds: number) => void }) {
  // Flip the mireds range so the slider runs warm → cool.
  return (
    <input
      className="slider ct"
      type="range"
      min={MIN_MIREDS}
      max={MAX_MIREDS}
      value={MIN_MIREDS + MAX_MIREDS - mireds}
      title={`${miredsToKelvin(mireds)} K`}
      onChange={(e) => onChange(MIN_MIREDS + MAX_MIREDS - Number(e.target.value))}
    />
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
  const d = light.defaults;
  const [name, setName] = useState(light.name);
  const [capability, setCapability] = useState<Capability>(light.capability);
  const [kind, setKind] = useState<Look['kind']>(d.look.kind);
  const [color, setColor] = useState(rgbToHex(lookRgb(d.look)));
  const [mireds, setMireds] = useState(d.look.kind === 'white' ? d.look.mireds : MAX_MIREDS);
  const [brightness, setBrightness] = useState(d.brightness);
  const [transitionMs, setTransitionMs] = useState(light.transitionMs);
  const [ranges, setRanges] = useState(formatRanges(light.ranges));
  const parsed = parseRanges(ranges);
  // RGB lights default to a color and White lights to a white; On/off takes either.
  const lookKind: Look['kind'] = capability === 'rgb' ? 'rgb' : capability === 'ct' ? 'white' : kind;

  const save = () =>
    run(async () => {
      if (!parsed) throw new Error('LED ranges must look like "0-9, 40-44, 50"');
      await api.updateLight(light.id, {
        name,
        capability,
        transitionMs,
        ranges: parsed,
        defaults: { brightness, look: lookKind === 'rgb' ? { kind: 'rgb', color: hexToRgb(color) } : { kind: 'white', mireds } },
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
          Type
          <select value={capability} onChange={(e) => setCapability(e.target.value as Capability)}>
            {Object.entries(capLabel).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <small>
            {capability === 'ct'
              ? 'Color temperature + brightness. Uses the strip\'s real white in group mode.'
              : capability === 'rgb'
                ? 'Any color + brightness.'
                : 'Just on and off, always with the look below.'}
          </small>
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
          <legend>{capability === 'onoff' ? 'Look when on' : 'Default look when turned on'}</legend>
          {capability === 'onoff' && (
            <div className="segmented">
              <button type="button" className={kind === 'rgb' ? 'on' : ''} onClick={() => setKind('rgb')}>
                Color
              </button>
              <button type="button" className={kind === 'white' ? 'on' : ''} onClick={() => setKind('white')}>
                White
              </button>
            </div>
          )}
          <div className="row tight">
            {lookKind === 'white' ? (
              <>
                <KelvinSlider mireds={mireds} onChange={setMireds} />
                <span className="muted small">{miredsToKelvin(mireds)} K</span>
              </>
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
