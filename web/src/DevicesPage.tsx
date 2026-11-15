import { useState } from 'react';
import type { AppSnapshot, Device, IdleBehavior } from '../../src/shared/types';
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
  idleBehavior: 'off',
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
                <dt>When idle</dt>
                <dd>{idleLabel[d.idleBehavior]}</dd>
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

const idleLabel: Record<IdleBehavior, string> = {
  off: 'Turn strip off',
  hold_black: 'Hold black (stay in streaming mode)',
  release: 'Release to Govee app',
};

function DeviceForm({ initial, onSave, onCancel }: { initial: Draft; onSave: (d: Draft) => void; onCancel?: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const num = (k: 'ledCount' | 'maxColorsPerPacket' | 'keepaliveMs') => (e: React.ChangeEvent<HTMLInputElement>) =>
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
        <label>
          When all lights are off
          <select value={d.idleBehavior} onChange={(e) => set('idleBehavior', e.target.value as IdleBehavior)}>
            {Object.entries(idleLabel).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
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
