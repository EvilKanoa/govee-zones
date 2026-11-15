import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot, Device, LightCommand, ServerMessage, VirtualLight } from '../../src/shared/types';

async function req<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export const api = {
  addDevice: (d: Partial<Device>) => req<Device>('POST', '/api/devices', d),
  updateDevice: (id: string, d: Partial<Device>) => req<Device>('PUT', `/api/devices/${id}`, d),
  deleteDevice: (id: string) => req('DELETE', `/api/devices/${id}`),
  test: (id: string) => req('POST', `/api/devices/${id}/test`),
  pixel: (id: string, index: number) => req('POST', `/api/devices/${id}/pixel`, { index }),
  stopOverride: (id: string) => req('POST', `/api/devices/${id}/stop-override`),
  testWhite: (id: string, kelvin: number, kind: 'mixed' | 'real') => req('POST', `/api/devices/${id}/test-white`, { kelvin, kind }),
  release: (id: string, released: boolean) => req('POST', `/api/devices/${id}/release`, { released }),
  reorder: (id: string, order: string[]) => req('PUT', `/api/devices/${id}/priorities`, { order }),
  addLight: (l: Partial<VirtualLight>) => req<VirtualLight>('POST', '/api/lights', l),
  updateLight: (id: string, l: Partial<VirtualLight>) => req<VirtualLight>('PUT', `/api/lights/${id}`, l),
  deleteLight: (id: string) => req('DELETE', `/api/lights/${id}`),
  command: (id: string, cmd: LightCommand) => req('POST', `/api/lights/${id}/command`, cmd),
  identify: (id: string) => req('POST', `/api/lights/${id}/identify`),
  importConfig: (cfg: unknown) => req('POST', '/api/import', cfg),
  uploadBackground: async (id: string, jpeg: Blob) => {
    const res = await fetch(`/api/devices/${id}/background`, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: jpeg });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    return data as { version: number };
  },
  deleteBackground: (id: string) => req('DELETE', `/api/devices/${id}/background`),
};

export interface Live {
  snapshot: AppSnapshot | null;
  frames: Record<string, Uint8Array>;
  /** Per device, in group mode: which groups show the strip's real white. */
  realWhite: Record<string, boolean[] | undefined>;
  connected: boolean;
}

/** Snapshot + live preview frames over one WebSocket, with reconnect. */
export function useLive(): Live {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [frames, setFrames] = useState<Record<string, Uint8Array>>({});
  const [realWhite, setRealWhite] = useState<Record<string, boolean[] | undefined>>({});
  const [connected, setConnected] = useState(false);
  const retry = useRef<number>(0);

  useEffect(() => {
    let ws: WebSocket;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry.current = window.setTimeout(connect, 1500);
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data) as ServerMessage;
        if (m.type === 'snapshot') setSnapshot(m.data);
        else {
          const bin = atob(m.pixels);
          const px = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
          setFrames((f) => ({ ...f, [m.deviceId]: px }));
          setRealWhite((r) => (String(r[m.deviceId]) === String(m.realWhite) ? r : { ...r, [m.deviceId]: m.realWhite }));
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry.current);
      ws.close();
    };
  }, []);

  return { snapshot, frames, realWhite, connected };
}
