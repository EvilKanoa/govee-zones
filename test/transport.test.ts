import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PacedTransport } from '../src/server/transport.js';

describe('PacedTransport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('spaces datagrams to the same IP and coalesces queued frames', async () => {
    const log: [number, string][] = [];
    const t = new PacedTransport(async (_ip, p) => void log.push([Date.now(), p.toString()]), 15);
    const start = Date.now();
    void t.send('a', Buffer.from('enable'));
    void t.send('a', Buffer.from('frame1'), 'frame');
    void t.send('a', Buffer.from('frame2'), 'frame');
    await vi.advanceTimersByTimeAsync(100);
    expect(log.map(([, s]) => s)).toEqual(['enable', 'frame2']);
    expect(log[1][0] - log[0][0]).toBeGreaterThanOrEqual(15);
    expect(log[0][0]).toBe(start);
  });
});
