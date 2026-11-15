import { useEffect, useRef, useState } from 'react';
import type { Device, RGB } from '../../src/shared/types';
import { api } from './api';
import type { Run } from './App';

const CHANNELS = [
  { name: 'Red', cls: 'wb-r' },
  { name: 'Green', cls: 'wb-g' },
  { name: 'Blue', cls: 'wb-b' },
];

/**
 * Per-strip channel gains to correct the LEDs' white point. Tune while showing
 * the test white; toggle "Release to Govee" to flip to Govee's own white and compare.
 */
export function WhiteBalance({ device, canDrive, run }: { device: Device; canDrive: boolean; run: Run }) {
  const saved = device.whiteBalance ?? [100, 100, 100];
  const [gains, setGains] = useState<RGB>(saved);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!timer.current) setGains(device.whiteBalance ?? [100, 100, 100]);
  }, [device.whiteBalance]);

  const update = (next: RGB) => {
    setGains(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void run(() => api.updateDevice(device.id, { whiteBalance: next }));
    }, 120);
  };

  const custom = gains.some((g) => g !== 100);

  return (
    <details className="card wb" open={custom || undefined}>
      <summary>
        <strong>White balance</strong>
        <span className="muted small">{custom ? ` R ${gains[0]}% · G ${gains[1]}% · B ${gains[2]}%` : ' off'}</span>
      </summary>
      <p className="muted small">
        Corrects the strip's tint for everything sent to it (the preview above shows uncorrected colors). Show the test
        white, then toggle <em>Release to Govee</em> to flip between it and Govee's own white. If ours looks pink, lower
        red and blue; if green, lower green.
      </p>
      {CHANNELS.map((c, i) => (
        <label key={c.name} className="wb-row">
          <span>{c.name}</span>
          <input
            type="range"
            className={`slider ${c.cls}`}
            min={50}
            max={100}
            value={gains[i]}
            onChange={(e) => {
              const next = [...gains] as RGB;
              next[i] = Number(e.target.value);
              update(next);
            }}
          />
          <span className="wb-val">{gains[i]}%</span>
        </label>
      ))}
      <div className="row">
        <button className="btn ghost" disabled={!canDrive} onClick={() => run(() => api.testWhite(device.id, 2700))}>
          Show test white (2700 K)
        </button>
        <button className="btn ghost" disabled={!canDrive} onClick={() => run(() => api.stopOverride(device.id))}>
          Stop test
        </button>
        <button className="btn ghost" disabled={!custom} onClick={() => update([100, 100, 100])}>
          Reset
        </button>
      </div>
    </details>
  );
}
