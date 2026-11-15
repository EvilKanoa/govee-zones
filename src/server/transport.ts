import dgram from 'node:dgram';
import type { Logger } from 'pino';
import { GOVEE_PORT } from './protocol.js';

/** Firmware is reported to drop back-to-back datagrams (SPEC §9). */
export const PACE_MS = 15;

export interface Transport {
  /**
   * Queue a datagram for `ip`. Datagrams to the same IP are sent at least
   * PACE_MS apart. A queued datagram with the same `coalesceKey` is replaced
   * instead of appended, so stale frames never pile up behind newer ones.
   */
  send(ip: string, payload: Buffer, coalesceKey?: string): Promise<void>;
  close(): Promise<void>;
}

type RawSend = (ip: string, payload: Buffer) => Promise<void>;

interface Item {
  payload: Buffer;
  key?: string;
  waiters: { resolve: () => void; reject: (e: Error) => void }[];
}

export class PacedTransport implements Transport {
  private queues = new Map<string, { items: Item[]; running: boolean; lastSent: number }>();

  constructor(private raw: RawSend, private paceMs = PACE_MS, private closer: () => Promise<void> = async () => {}) {}

  send(ip: string, payload: Buffer, coalesceKey?: string): Promise<void> {
    let q = this.queues.get(ip);
    if (!q) this.queues.set(ip, (q = { items: [], running: false, lastSent: 0 }));
    return new Promise((resolve, reject) => {
      const existing = coalesceKey ? q.items.find((i) => i.key === coalesceKey) : undefined;
      if (existing) {
        existing.payload = payload;
        existing.waiters.push({ resolve, reject });
      } else {
        q.items.push({ payload, key: coalesceKey, waiters: [{ resolve, reject }] });
      }
      if (!q.running) void this.drain(ip, q);
    });
  }

  private async drain(ip: string, q: { items: Item[]; running: boolean; lastSent: number }) {
    q.running = true;
    while (q.items.length) {
      const wait = q.lastSent + this.paceMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const item = q.items.shift()!;
      try {
        await this.raw(ip, item.payload);
        item.waiters.forEach((w) => w.resolve());
      } catch (e) {
        item.waiters.forEach((w) => w.reject(e as Error));
      }
      q.lastSent = Date.now();
    }
    q.running = false;
  }

  close() {
    return this.closer();
  }
}

/** Real UDP. Sends from an ephemeral port; never binds 4002 (govee2mqtt owns it). */
export function udpTransport(): Transport {
  const sock = dgram.createSocket('udp4');
  sock.unref();
  return new PacedTransport(
    (ip, payload) =>
      new Promise((resolve, reject) => sock.send(payload, GOVEE_PORT, ip, (err) => (err ? reject(err) : resolve()))),
    PACE_MS,
    () => new Promise((r) => sock.close(() => r())),
  );
}

/** SIMULATE=true: log datagrams instead of sending them. */
export function simulatedTransport(log: Logger): Transport {
  return new PacedTransport(async (ip, payload) => {
    const msg = JSON.parse(payload.toString()).msg;
    if (msg.cmd === 'razer') {
      const pt = Buffer.from(msg.data.pt, 'base64');
      if (pt[3] === 0xb1) log.info({ ip }, `[sim] razer ${pt[4] ? 'enable' : 'disable'}`);
      else log.debug({ ip, colors: pt[5] }, '[sim] razer frame');
    } else {
      log.info({ ip, data: msg.data }, `[sim] ${msg.cmd}`);
    }
  });
}
