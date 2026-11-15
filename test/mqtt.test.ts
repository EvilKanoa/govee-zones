import net from 'node:net';
import { Aedes } from 'aedes';
import mqtt, { type MqttClient } from 'mqtt';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/server/engine.js';
import { MqttBridge, discoveryFor, parseCommand, statePayload, topics } from '../src/server/mqtt.js';
import { Store } from '../src/server/store.js';
import type { Transport } from '../src/server/transport.js';
import type { Device, VirtualLight } from '../src/shared/types.js';

const t = topics('homeassistant', 'govee-zones');
const device: Device = {
  id: 'dev1', name: 'Eaves', ip: '1.2.3.4', ledCount: 60, maxColorsPerPacket: 84, keepaliveMs: 2000,
  enabled: true, idleBehavior: 'off',
};
const light = (capability: VirtualLight['capability']): VirtualLight => ({
  id: 'l1', name: 'Front', deviceId: 'dev1', ranges: [[0, 9]], priority: 0, capability,
  defaults: { color: [255, 255, 255], brightness: 255 }, transitionMs: 0, order: 0,
});

describe('discoveryFor', () => {
  it('maps capability to supported_color_modes', () => {
    const modes = (c: VirtualLight['capability']) =>
      (discoveryFor(t, device, [light(c)]).get(t.discovery('light', 'l1')) as { supported_color_modes: string[] }).supported_color_modes;
    expect(modes('onoff')).toEqual(['onoff']);
    expect(modes('dimmable')).toEqual(['brightness']);
    expect(modes('rgb')).toEqual(['rgb']);
    expect(modes('rgb_ct')).toEqual(['rgb', 'color_temp']);
  });

  it('uses kelvin for color temperature and groups everything under one HA device', () => {
    const d = discoveryFor(t, device, [light('rgb_ct')]);
    expect(d.get('homeassistant/light/govee-zones/l1/config')).toMatchObject({
      schema: 'json', unique_id: 'govee-zones_l1', color_temp_kelvin: true, min_kelvin: 2000, max_kelvin: 6535,
      command_topic: 'govee-zones/light/l1/set', availability_topic: 'govee-zones/status',
      device: { identifiers: ['govee-zones_dev1'], name: 'Eaves' },
    });
    expect([...d.keys()]).toEqual([
      'homeassistant/light/govee-zones/l1/config',
      'homeassistant/switch/govee-zones/dev1_release/config',
      'homeassistant/sensor/govee-zones/dev1_mode/config',
    ]);
  });
});

describe('statePayload / parseCommand', () => {
  it('reports the color mode the light is in', () => {
    const s = { on: true, brightness: 128, color: [255, 0, 0] as [number, number, number] };
    expect(statePayload(light('onoff'), s)).toEqual({ state: 'ON', color_mode: 'onoff' });
    expect(statePayload(light('dimmable'), s)).toEqual({ state: 'ON', color_mode: 'brightness', brightness: 128 });
    expect(statePayload(light('rgb_ct'), s)).toMatchObject({ color_mode: 'rgb', color: { r: 255, g: 0, b: 0 } });
    expect(statePayload(light('rgb_ct'), { ...s, colorTemp: 370 })).toMatchObject({ color_mode: 'color_temp', color_temp: 2703 });
  });

  it('converts HA kelvin to mireds and rejects junk', () => {
    expect(parseCommand('{"state":"ON","color_temp":2700,"transition":2}')).toEqual({ state: 'ON', color_temp: 370, transition: 2 });
    expect(() => parseCommand('{"state":"MAYBE"}')).toThrow();
    expect(() => parseCommand('not json')).toThrow();
  });
});

// --- integration: real broker (aedes, in-process) --------------------------------

const nullTransport: Transport = { async send() {}, async close() {} };
const log = pino({ level: 'silent' });

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('MqttBridge (integration)', () => {
  let broker: Aedes;
  let server: net.Server;
  let url: string;
  let observer: MqttClient;
  let seen: Map<string, string>; // latest payload per topic, as the observer saw it
  let store: Store;
  let engine: Engine;
  let bridge: MqttBridge | null;

  beforeEach(async () => {
    broker = await Aedes.createBroker();
    server = net.createServer(broker.handle);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `mqtt://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    seen = new Map();
    observer = await mqtt.connectAsync(url);
    observer.on('message', (topic, buf) => seen.set(topic, buf.toString()));
    await observer.subscribeAsync('#');

    store = new Store(null);
    engine = new Engine(store, nullTransport, log);
    bridge = null;
  });

  afterEach(async () => {
    await bridge?.close();
    await engine.stop();
    await observer.endAsync();
    await new Promise<void>((r) => broker.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
  });

  const start = async () => {
    bridge = new MqttBridge(store, engine, log, { url, discoveryPrefix: 'homeassistant', baseTopic: 'govee-zones' });
    await until(() => seen.get('govee-zones/status') === 'online');
    return bridge;
  };
  const json = (topic: string) => JSON.parse(seen.get(topic) ?? 'null');

  it('announces discovery, retained state and availability on connect', async () => {
    const d = store.addDevice({ name: 'Eaves', ip: '1.2.3.4', ledCount: 60, maxColorsPerPacket: 84, keepaliveMs: 2000, enabled: true, idleBehavior: 'off' });
    const l = store.addLight({ name: 'Front', deviceId: d.id, ranges: [[0, 9]], priority: 0, capability: 'rgb', defaults: { color: [255, 0, 0], brightness: 255 }, transitionMs: 0 });
    await start();
    await until(() => seen.has(t.deviceStatus(d.id)));
    expect(json(t.discovery('light', l.id))).toMatchObject({ name: 'Front', schema: 'json' });
    expect(json(t.lightState(l.id))).toEqual({ state: 'OFF', color_mode: 'rgb', brightness: 255, color: { r: 255, g: 0, b: 0 } });
    expect(seen.get(t.releaseState(d.id))).toBe('OFF');
    expect(json(t.deviceStatus(d.id))).toMatchObject({ mode: 'idle' });

    // A late subscriber (HA after a restart) still gets retained state.
    const late = new Map<string, string>();
    const c = await mqtt.connectAsync(url);
    c.on('message', (topic, buf) => late.set(topic, buf.toString()));
    await c.subscribeAsync(t.lightState(l.id));
    await until(() => late.has(t.lightState(l.id)));
    await c.endAsync();
  });

  it('applies light commands and echoes state', async () => {
    const d = store.addDevice({ name: 'Eaves', ip: '1.2.3.4', ledCount: 60, maxColorsPerPacket: 84, keepaliveMs: 2000, enabled: true, idleBehavior: 'off' });
    const l = store.addLight({ name: 'Front', deviceId: d.id, ranges: [[0, 9]], priority: 0, capability: 'rgb_ct', defaults: { color: [255, 0, 0], brightness: 255 }, transitionMs: 0 });
    await start();
    await observer.publishAsync(t.lightSet(l.id), JSON.stringify({ state: 'ON', color_temp: 2700, brightness: 100 }));
    await until(() => json(t.lightState(l.id))?.state === 'ON');
    expect(store.state(l.id)).toMatchObject({ on: true, brightness: 100, colorTemp: 370 });
    expect(json(t.lightState(l.id))).toMatchObject({ color_mode: 'color_temp', color_temp: 2703, brightness: 100 });
    await until(() => json(t.deviceStatus(d.id))?.mode === 'streaming');

    await observer.publishAsync(t.lightSet(l.id), 'garbage'); // ignored, no crash
    await observer.publishAsync(t.releaseSet(d.id), 'ON');
    await until(() => seen.get(t.releaseState(d.id)) === 'ON');
    expect(store.flags(d.id).released).toBe(true);
    await until(() => json(t.deviceStatus(d.id))?.mode === 'released');
  });

  it('clears discovery for deleted lights, and stale configs from earlier runs', async () => {
    await observer.publishAsync(t.discovery('light', 'ghost'), '{"name":"old"}', { retain: true });
    const d = store.addDevice({ name: 'Eaves', ip: '1.2.3.4', ledCount: 60, maxColorsPerPacket: 84, keepaliveMs: 2000, enabled: true, idleBehavior: 'off' });
    const l = store.addLight({ name: 'Front', deviceId: d.id, ranges: [[0, 9]], priority: 0, capability: 'rgb', defaults: { color: [255, 0, 0], brightness: 255 }, transitionMs: 0 });
    await start();
    await until(() => seen.get(t.discovery('light', 'ghost')) === '');

    store.updateLight(l.id, { name: 'Porch' });
    await until(() => json(t.discovery('light', l.id))?.name === 'Porch');

    store.removeLight(l.id);
    await until(() => seen.get(t.discovery('light', l.id)) === '');
    expect(seen.get(t.lightState(l.id))).toBe('');
    expect(json(t.discovery('switch', `${d.id}_release`))).toBeTruthy(); // device entities stay
  });

  it('goes offline on close', async () => {
    await start();
    await bridge!.close();
    bridge = null;
    await until(() => seen.get('govee-zones/status') === 'offline');
  });
});
