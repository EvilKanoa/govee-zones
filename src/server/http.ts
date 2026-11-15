// REST + WebSocket API for the web UI. LAN only, no auth (SPEC §8).
import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { MAX_KELVIN, MIN_KELVIN } from '../shared/color.js';
import type { AppSnapshot, ServerMessage } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { MqttBridge } from './mqtt.js';
import { configImport, deviceInput, devicePatch, lightCommand, lightInput, lightPatch } from './schemas.js';
import type { Store } from './store.js';

/** Live preview frames are throttled per device; the strip itself may get ~30 fps. */
const PREVIEW_INTERVAL_MS = 66;

export async function createServer(opts: {
  store: Store;
  engine: Engine;
  mqtt?: MqttBridge | null;
  log: Logger;
  webRoot?: string;
  dataDir: string;
}) {
  const { store, engine } = opts;
  // Request logs at warn+ only: sliders in the UI send many small commands.
  const app = Fastify({ loggerInstance: opts.log.child({ module: 'http' }, { level: 'warn' }) });
  await app.register(fastifyWebsocket);
  // House photos arrive as raw JPEG bodies (the browser resizes them first).
  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: z.prettifyError(err) });
    const e = err as Error & { statusCode?: number };
    reply.status(e.statusCode ?? 400).send({ error: e.message });
  });

  const snapshot = (): AppSnapshot => ({
    ...store.exportConfig(),
    states: store.states,
    flags: store.allFlags,
    status: engine.allStatus(),
    mqtt: opts.mqtt?.status ?? 'disabled',
  });
  const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/snapshot', async () => snapshot());

  // Devices
  app.post('/api/devices', async (req) => store.addDevice(deviceInput.parse(req.body)));
  app.put<{ Params: { id: string } }>('/api/devices/:id', async (req) => {
    return store.updateDevice(req.params.id, devicePatch.parse(req.body)) ?? Promise.reject(notFound());
  });
  app.delete<{ Params: { id: string } }>('/api/devices/:id', async (req) => {
    if (!store.removeDevice(req.params.id)) throw notFound();
    fs.rmSync(photoPath(req.params.id), { force: true });
    return { ok: true };
  });

  // House outline background photo, stored beside the config (not in exports).
  const photoPath = (id: string) => path.join(opts.dataDir, 'backgrounds', `${path.basename(id)}.jpg`);
  app.get<{ Params: { id: string } }>('/api/devices/:id/background', async (req, reply) => {
    const file = photoPath(req.params.id);
    if (!fs.existsSync(file)) throw notFound();
    return reply.type('image/jpeg').header('cache-control', 'max-age=31536000, immutable').send(fs.readFileSync(file));
  });
  app.put<{ Params: { id: string } }>('/api/devices/:id/background', async (req) => {
    if (!store.device(req.params.id)) throw notFound();
    if (!Buffer.isBuffer(req.body)) throw new Error('expected an image/jpeg body');
    fs.mkdirSync(path.dirname(photoPath(req.params.id)), { recursive: true });
    fs.writeFileSync(photoPath(req.params.id), req.body);
    return { version: Date.now() };
  });
  app.delete<{ Params: { id: string } }>('/api/devices/:id/background', async (req) => {
    fs.rmSync(photoPath(req.params.id), { force: true });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/devices/:id/test', async (req) => {
    engine.test(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/devices/:id/pixel', async (req) => {
    engine.pixel(req.params.id, z.object({ index: z.number().int() }).parse(req.body).index);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/devices/:id/test-white', async (req) => {
    const { kelvin, kind } = z
      .object({ kelvin: z.number().min(MIN_KELVIN).max(MAX_KELVIN).optional(), kind: z.enum(['mixed', 'real']).optional() })
      .parse(req.body ?? {});
    engine.testWhite(req.params.id, kelvin, kind);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/devices/:id/stop-override', async (req) => {
    engine.clearOverride(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/devices/:id/release', async (req) => {
    if (!store.device(req.params.id)) throw notFound();
    engine.setReleased(req.params.id, z.object({ released: z.boolean() }).parse(req.body).released);
    return { ok: true };
  });
  app.put<{ Params: { id: string } }>('/api/devices/:id/priorities', async (req) => {
    if (!store.device(req.params.id)) throw notFound();
    store.reorder(req.params.id, z.object({ order: z.array(z.string()) }).parse(req.body).order);
    return { ok: true };
  });

  // Lights
  app.post('/api/lights', async (req) => {
    const input = lightInput.parse(req.body);
    if (!store.device(input.deviceId)) throw new Error('unknown device');
    return store.addLight(input);
  });
  app.put<{ Params: { id: string } }>('/api/lights/:id', async (req) => {
    return store.updateLight(req.params.id, lightPatch.parse(req.body)) ?? Promise.reject(notFound());
  });
  app.delete<{ Params: { id: string } }>('/api/lights/:id', async (req) => {
    if (!store.removeLight(req.params.id)) throw notFound();
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/lights/:id/command', async (req) => {
    if (!store.light(req.params.id)) throw notFound();
    engine.command(req.params.id, lightCommand.parse(req.body));
    return store.state(req.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/lights/:id/identify', async (req) => {
    engine.identify(req.params.id);
    return { ok: true };
  });

  // Backup
  app.get('/api/export', async (_req, reply) => {
    reply.header('content-disposition', 'attachment; filename="govee-zones-config.json"');
    return store.exportConfig();
  });
  app.post('/api/import', async (req) => {
    const cfg = configImport.parse(req.body);
    const ids = new Set(cfg.devices.map((d) => d.id));
    const orphan = cfg.lights.find((l) => !ids.has(l.deviceId));
    if (orphan) throw new Error(`light "${orphan.name}" references unknown device ${orphan.deviceId}`);
    store.importConfig(cfg);
    return { ok: true };
  });

  // Live updates
  const clients = new Set<WebSocket>();
  const broadcast = (m: ServerMessage) => {
    const s = JSON.stringify(m);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(s);
  };
  app.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'snapshot', data: snapshot() } satisfies ServerMessage));
    socket.on('close', () => clients.delete(socket));
  });

  let snapshotPending = false;
  const pushSnapshot = () => {
    if (snapshotPending) return;
    snapshotPending = true;
    setImmediate(() => {
      snapshotPending = false;
      broadcast({ type: 'snapshot', data: snapshot() });
    });
  };
  store.on('change', pushSnapshot);
  engine.on('status', pushSnapshot);
  opts.mqtt?.on('status', pushSnapshot);

  const lastPreview = new Map<string, number>();
  engine.on('frame', (deviceId, pixels, realWhite) => {
    const now = Date.now();
    if (now - (lastPreview.get(deviceId) ?? 0) < PREVIEW_INTERVAL_MS) return;
    lastPreview.set(deviceId, now);
    broadcast({
      type: 'frame',
      deviceId,
      pixels: Buffer.from(pixels).toString('base64'),
      mode: engine.status(deviceId).mode,
      realWhite,
    });
  });

  // Built UI (production). In dev, Vite serves the UI and proxies /api and /ws here.
  if (opts.webRoot && fs.existsSync(path.join(opts.webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: opts.webRoot });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api') ? reply.status(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
    );
  }

  return app;
}
