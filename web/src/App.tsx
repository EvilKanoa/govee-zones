import { useEffect, useRef, useState } from 'react';
import { api, useLive } from './api';
import { DevicesPage } from './DevicesPage';
import { StripPage } from './StripPage';

export function App() {
  const live = useLive();
  const [tab, setTab] = useState<string>('devices');
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const devices = live.snapshot?.devices ?? [];

  // Open the first strip once devices load; fall back if the open one is deleted.
  useEffect(() => {
    if (!live.snapshot) return;
    if (tab !== 'devices' && !devices.some((d) => d.id === tab)) setTab(devices[0]?.id ?? 'devices');
  }, [live.snapshot]);
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current && devices.length) {
      opened.current = true;
      setTab(devices[0].id);
    }
  }, [devices.length]);

  /** Run an API call, surfacing failures in the error banner. */
  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onImport = async (file: File) => {
    await run(async () => api.importConfig(JSON.parse(await file.text())));
    if (fileInput.current) fileInput.current.value = '';
  };

  const device = devices.find((d) => d.id === tab);

  return (
    <div className="app">
      <header className="topbar">
        <h1>govee-zones</h1>
        <nav>
          {devices.map((d) => (
            <button key={d.id} className={tab === d.id ? 'tab active' : 'tab'} onClick={() => setTab(d.id)}>
              {d.name}
            </button>
          ))}
          <button className={tab === 'devices' ? 'tab active' : 'tab'} onClick={() => setTab('devices')}>
            Devices
          </button>
        </nav>
        <div className="topbar-actions">
          <a className="btn ghost" href="/api/export" download>
            Export
          </a>
          <button className="btn ghost" onClick={() => fileInput.current?.click()}>
            Import
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])}
          />
          {live.snapshot && live.snapshot.mqtt !== 'disabled' && (
            <span className="conn-status" title={`MQTT broker: ${live.snapshot.mqtt}`}>
              MQTT <span className={live.snapshot.mqtt === 'connected' ? 'dot ok' : 'dot bad'} />
            </span>
          )}
          <span className="conn-status" title={`Live connection to the server: ${live.connected ? 'connected' : 'disconnected'}`}>
            Server <span className={live.connected ? 'dot ok' : 'dot bad'} />
          </span>
        </div>
      </header>

      {error && (
        <div className="error" role="alert">
          {error}
          <button className="link" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <main>
        {!live.snapshot ? (
          <p className="muted">Connecting…</p>
        ) : device ? (
          <StripPage
            key={device.id}
            device={device}
            snapshot={live.snapshot}
            frame={live.frames[device.id]}
            realWhite={live.realWhite[device.id]}
            run={run}
          />
        ) : (
          <DevicesPage snapshot={live.snapshot} run={run} onOpen={setTab} />
        )}
      </main>
    </div>
  );
}

export type Run = (fn: () => Promise<unknown>) => Promise<void>;
