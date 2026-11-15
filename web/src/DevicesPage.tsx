import { useState } from 'react';
import { groupCount, MAX_GROUPS } from '../../src/shared/groups';
import type { AppSnapshot, Device } from '../../src/shared/types';
import { MODE_LABEL } from './control';
import { api } from './api';
import type { Run } from './App';
import { ModeBadge } from './StripPage';

type Draft = Omit<Device, 'id'>;

const blank: Draft = {
  name: '',
  ip: '',
  ledCount: 60,
  maxColorsPerPacket: 84,
  keepaliveMs: 2000,
  enabled: true,
  groupSize: 4,
  control: 'auto',
  partialGroups: 'round',
};

export function DevicesPage({ snapshot, run, onOpen }: { snapshot: AppSnapshot; run: Run; onOpen: (id: string) => void }) {
  const [editing, setEditing] = useState<string | 'new' | null>(snapshot.devices.length ? null : 'new');

  return (
    <section>
      <div className="section-head">
        <h2>Devices</h2>
        {editing !== 'new' && (
          <button className="btn" onClick={() => setEditing('new')}>
            Add strip
          </button>
        )}
      </div>

      {editing === 'new' && (
        <DeviceForm
          initial={blank}
          onCancel={snapshot.devices.length ? () => setEditing(null) : undefined}
          onSave={(d) =>
            run(async () => {
              const created = await api.addDevice(d);
              setEditing(null);
              onOpen(created.id);
            })
          }
        />
      )}

      <HowControlWorks />

      <div className="cards">
        {snapshot.devices.map((d) =>
          editing === d.id ? (
            <DeviceForm
              key={d.id}
              initial={d}
              onCancel={() => setEditing(null)}
              onSave={(patch) => run(async () => (await api.updateDevice(d.id, patch), setEditing(null)))}
            />
          ) : (
            <div key={d.id} className="card">
              <div className="card-head">
                <strong>{d.name}</strong>
                <ModeBadge status={snapshot.status[d.id]} />
              </div>
              <dl className="facts">
                <dt>IP</dt>
                <dd>{d.ip}</dd>
                <dt>LEDs</dt>
                <dd>
                  {d.ledCount}
                  {d.ledCount > d.maxColorsPerPacket && (
                    <span className="warn"> (sent as {d.maxColorsPerPacket} colors)</span>
                  )}
                </dd>
                <dt>Control</dt>
                <dd>{controlSummary(d)}</dd>
                <dt>Lights</dt>
                <dd>{snapshot.lights.filter((l) => l.deviceId === d.id).length}</dd>
                {!d.enabled && (
                  <>
                    <dt>Status</dt>
                    <dd className="warn">disabled</dd>
                  </>
                )}
              </dl>
              <div className="row">
                <button className="btn" onClick={() => onOpen(d.id)}>
                  Open editor
                </button>
                <button className="btn ghost" onClick={() => run(() => api.test(d.id))}>
                  Test
                </button>
                <button className="btn ghost" onClick={() => setEditing(d.id)}>
                  Edit
                </button>
                <ConfirmDelete label="Delete" onConfirm={() => run(() => api.deleteDevice(d.id))} />
              </div>
            </div>
          ),
        )}
      </div>
    </section>
  );
}

function controlSummary(d: Device): string {
  if (d.groupSize <= 0) return 'Per-LED (group control off)';
  const n = groupCount(d.ledCount, d.groupSize);
  if (n > MAX_GROUPS) return `Per-LED (${n} groups is more than the tested ${MAX_GROUPS})`;
  if (d.control === 'per_led') return 'Per-LED only';
  return `Automatic · ${n} groups of ${d.groupSize}${d.partialGroups === 'exact' ? ' · exact LEDs' : ''}`;
}

/** Collapsible explainer for the two control methods (plan §4.5). */
function HowControlWorks() {
  return (
    <details className="card help">
      <summary>
        <strong>How control works</strong>
        <span className="muted small"> Groups vs Per-LED</span>
      </summary>
      <table className="compare">
        <thead>
          <tr>
            <th />
            <th>{MODE_LABEL.groups}</th>
            <th>{MODE_LABEL.per_led}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>Resolution</th>
            <td>Groups of LEDs (4 on the H805A)</td>
            <td>Single LEDs</td>
          </tr>
          <tr>
            <th>White</th>
            <td>The strip's real white, matching the Govee app (2700–6500 K)</td>
            <td>Mixed from RGB: about as bright, slightly off-color</td>
          </tr>
          <tr>
            <th>If govee-zones stops</th>
            <td>The lights stay as they are</td>
            <td>The strip freezes on its last frame in streaming mode</td>
          </tr>
          <tr>
            <th>Changes</th>
            <td>Glide over about half a second (the strip's firmware)</td>
            <td>Instant</td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">
        Group control is the normal mode. A light that doesn't line up with the groups is rounded to whole groups (its edges
        move by at most 2 LEDs), unless the strip is set to use exact LEDs. Per-LED control is used for the pixel finder and
        test chase, for lights set to use exact LEDs, when the strip is set to Per-LED only, and for strips with more than{' '}
        {MAX_GROUPS} groups. When every light is off, the strip turns off; use Release to Govee for the app's scenes.
      </p>
    </details>
  );
}

function DeviceForm({ initial, onSave, onCancel }: { initial: Draft; onSave: (d: Draft) => void; onCancel?: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const num = (k: 'ledCount' | 'maxColorsPerPacket' | 'keepaliveMs' | 'groupSize') => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, Number(e.target.value));

  return (
    <form
      className="card form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(d);
      }}
    >
      <label>
        Name
        <input value={d.name} onChange={(e) => set('name', e.target.value)} required autoFocus />
      </label>
      <label>
        IP address
        <input value={d.ip} onChange={(e) => set('ip', e.target.value)} placeholder="192.168.1.50" required />
        <small>Use a static DHCP lease. Discovery is off so this doesn't conflict with govee2mqtt on UDP 4002.</small>
      </label>
      <div className="grid2">
        <label>
          LED count
          <input type="number" min={1} value={d.ledCount} onChange={num('ledCount')} />
        </label>
        <label>
          Max colors per packet
          <input type="number" min={1} max={255} value={d.maxColorsPerPacket} onChange={num('maxColorsPerPacket')} />
        </label>
        <label>
          Keepalive (ms)
          <input type="number" min={250} step={250} value={d.keepaliveMs} onChange={num('keepaliveMs')} />
        </label>
      </div>
      <fieldset className="groups-form">
        <legend>Groups</legend>
        <label>
          LEDs per group
          <input type="number" min={0} max={16} value={d.groupSize} onChange={num('groupSize')} />
          <small>
            How many LEDs the strip controls together: 4 on the H805A. 0 turns group control off.{' '}
            {groupNote(d.ledCount, d.groupSize)}
          </small>
        </label>
        <div className="radio-group" role="radiogroup" aria-label="Control method">
          <span className="radio-title">Control method</span>
          <label className="radio">
            <input type="radio" checked={d.control === 'auto'} disabled={d.groupSize <= 0} onChange={() => set('control', 'auto')} />
            <span>
              <strong>Automatic</strong> (recommended)
              <small>
                Uses group control whenever it can: real white that matches the Govee app, and the strip keeps its lights even
                if govee-zones stops. Switches to per-LED control only for single-LED tools like the pixel finder.
              </small>
            </span>
          </label>
          <label className="radio">
            <input type="radio" checked={d.control === 'per_led' || d.groupSize <= 0} onChange={() => set('control', 'per_led')} />
            <span>
              <strong>Per-LED only</strong>
              <small>
                Always controls single LEDs. Changes are instant, but white is mixed from RGB (slightly off-color), and if
                govee-zones stops, the strip freezes on its last frame in streaming mode.
              </small>
            </span>
          </label>
        </div>
        {d.control === 'auto' && d.groupSize > 0 && (
          <div className="radio-group" role="radiogroup" aria-label="Lights that don't line up with groups">
            <span className="radio-title">Lights that don't line up with groups</span>
            <label className="radio">
              <input type="radio" checked={d.partialGroups === 'round'} onChange={() => set('partialGroups', 'round')} />
              <span>
                <strong>Round to whole groups</strong> (default)
                <small>Keeps real white and group control. A light's edges move to the nearest group boundary (at most 2 LEDs).</small>
              </span>
            </label>
            <label className="radio">
              <input type="radio" checked={d.partialGroups === 'exact'} onChange={() => set('partialGroups', 'exact')} />
              <span>
                <strong>Use exact LEDs</strong>
                <small>
                  Keeps exact LED ranges by switching the whole strip to per-LED control while such a light is on. Other lights
                  lose real white during that time.
                </small>
              </span>
            </label>
          </div>
        )}
        <small className="muted">The strip turns off when every light is off. Use Release to Govee for app scenes.</small>
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={d.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        Enabled
      </label>
      <div className="row">
        <button className="btn" type="submit">
          Save
        </button>
        {onCancel && (
          <button className="btn ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** Two-step delete button, so a stray click can't remove anything. */
export function ConfirmDelete({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return armed ? (
    <span className="row tight">
      <button className="btn danger" onClick={onConfirm}>
        Really delete?
      </button>
      <button className="btn ghost" onClick={() => setArmed(false)}>
        No
      </button>
    </span>
  ) : (
    <button className="btn ghost" onClick={() => setArmed(true)}>
      {label}
    </button>
  );
}

function groupNote(ledCount: number, groupSize: number): string {
  if (groupSize <= 0) return '';
  const n = groupCount(ledCount, groupSize);
  return n > MAX_GROUPS
    ? `That's ${n} groups: more than the ${MAX_GROUPS} that have been tested, so this strip uses per-LED control.`
    : `That's ${n} groups.`;
}
