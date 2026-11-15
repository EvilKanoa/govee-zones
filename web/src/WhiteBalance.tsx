import { useEffect, useRef, useState } from 'react';
import type { Device, RGB } from '../../src/shared/types';
import { api } from './api';
import type { Run } from './App';
import { groupsUsable } from './control';

const CHANNELS = [
  { name: 'Red', cls: 'wb-r' },
  { name: 'Green', cls: 'wb-g' },
  { name: 'Blue', cls: 'wb-b' },
];

/**
 * Per-strip channel gains to correct the RGB-mixed white (per-LED mode) against
 * the strip's real white. With group control, flip between the two on the strip.
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
  const real = groupsUsable(device);
  const show = (kind: 'mixed' | 'real') => run(() => api.testWhite(device.id, 2700, kind));

  return (
    <details className="card wb" open={custom || undefined}>
      <summary>
        <strong>White balance</strong>
        <span className="muted small">{custom ? ` R ${gains[0]}% · G ${gains[1]}% · B ${gains[2]}%` : ' off'}</span>
      </summary>
      <p className="muted small">
        Per-LED mode mixes white from RGB, which can look pinker than the strip's real white. These gains correct everything
        sent per-LED and RGB colors in group mode (not real white, and not the preview above).{' '}
        {real
          ? 'Flip between mixed and real white on the strip, and adjust until they match. If mixed looks pink, lower red and blue; if green, lower green.'
          : 'Show the test white, then compare it with the Govee app\'s own white (Release to Govee). If ours looks pink, lower red and blue; if green, lower green.'}
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
        <button className="btn ghost" disabled={!canDrive} onClick={() => show('mixed')}>
          Show mixed white (2700 K)
        </button>
        {real && (
          <button className="btn ghost" disabled={!canDrive} onClick={() => show('real')}>
            Show real white (2700 K)
          </button>
        )}
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
