import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { loadConfig } from './config.js';
import { Engine } from './engine.js';
import { createServer } from './http.js';
import { MqttBridge } from './mqtt.js';
import { Store } from './store.js';
import { simulatedTransport, udpTransport } from './transport.js';

const config = loadConfig();
const log = pino({
  level: config.logLevel,
  // Pretty logs only in local dev: pino-pretty is a devDependency and isn't in the image.
  transport:
    process.stdout.isTTY && process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } }
      : undefined,
});

const store = new Store(config.dataDir);
if (store.migrationNotes.length)
  log.warn({ backup: store.migrationBackup, changes: store.migrationNotes }, 'converted the config from an older format (original kept as a backup)');
const transport = config.simulate ? simulatedTransport(log.child({ module: 'sim' })) : udpTransport();
const engine = new Engine(store, transport, log.child({ module: 'engine' }));

const here = path.dirname(fileURLToPath(import.meta.url));
// Built layout: dist/server/server/main.js → dist/web
const webRoot = path.resolve(here, '../../web');
const { url: mqttUrl, ...mqttOpts } = config.mqtt;
const mqtt = mqttUrl ? new MqttBridge(store, engine, log.child({ module: 'mqtt' }), { url: mqttUrl, ...mqttOpts }) : null;
const app = await createServer({ store, engine, mqtt, log, webRoot, dataDir: config.dataDir });

if (mqtt) log.info({ url: mqttUrl, baseTopic: config.mqtt.baseTopic }, 'mqtt bridge enabled');
else log.warn('MQTT_HOST not set: MQTT/Home Assistant bridge disabled (web UI only)');
log.info({ dataDir: config.dataDir, simulate: config.simulate }, 'starting');

engine.start();
await app.listen({ host: '0.0.0.0', port: config.webPort });
log.info(`web UI on http://localhost:${config.webPort}`);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down (group mode leaves the lights as they are)');
  await engine.stop();
  await mqtt?.close();
  store.flush();
  await app.close();
  await transport.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
