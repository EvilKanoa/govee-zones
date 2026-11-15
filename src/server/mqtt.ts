// MQTT / Home Assistant bridge (SPEC §5): discovery, retained state, commands, LWT.
import { EventEmitter } from 'node:events';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import type { Logger } from 'pino';
import { lookRgb, MAX_KELVIN, MIN_KELVIN } from '../shared/color.js';
import type { Device, DeviceStatus, LightCommand, LightState, VirtualLight } from '../shared/types.js';
import type { Engine } from './engine.js';
import { lightCommand } from './schemas.js';
import type { Store, StoreEvent } from './store.js';

export type MqttStatus = 'disabled' | 'connecting' | 'connected';

export interface MqttOptions {
  url: string;
  username?: string;
  password?: string;
  discoveryPrefix: string;
  baseTopic: string;
}

const MODES: DeviceStatus['mode'][] = ['groups', 'per_led', 'idle', 'released', 'error'];

/** Topic layout. `node` is the discovery node_id and the unique_id prefix. */
export function topics(discoveryPrefix: string, baseTopic: string) {
  const node = baseTopic.replace(/[^a-zA-Z0-9_-]/g, '_');
  return {
    node,
    availability: `${baseTopic}/status`,
    haStatus: `${discoveryPrefix}/status`,
    lightSet: (id: string) => `${baseTopic}/light/${id}/set`,
    lightState: (id: string) => `${baseTopic}/light/${id}/state`,
    releaseSet: (id: string) => `${baseTopic}/device/${id}/release/set`,
    releaseState: (id: string) => `${baseTopic}/device/${id}/release/state`,
    deviceStatus: (id: string) => `${baseTopic}/device/${id}/status`,
    discovery: (component: string, objectId: string) => `${discoveryPrefix}/${component}/${node}/${objectId}/config`,
    discoveryWildcard: `${discoveryPrefix}/+/${node}/+/config`,
    subscriptions: [`${baseTopic}/light/+/set`, `${baseTopic}/device/+/release/set`, `${discoveryPrefix}/status`],
  };
}
export type Topics = ReturnType<typeof topics>;

/** kelvin ↔ mireds (the conversion is its own inverse). */
const invertTemp = (x: number) => Math.round(1_000_000 / x);

function haDevice(t: Topics, d: Device) {
  return {
    identifiers: [`${t.node}_${d.id}`],
    name: d.name,
    manufacturer: 'Govee',
    model: 'RGBIC strip (govee-zones)',
  };
}

const ORIGIN = { name: 'govee-zones' };

/** Discovery configs (topic → payload) for one device and its lights. */
export function discoveryFor(t: Topics, d: Device, lights: VirtualLight[]): Map<string, object> {
  const out = new Map<string, object>();
  const device = haDevice(t, d);
  for (const l of lights) {
    const cfg: Record<string, unknown> = {
      name: l.name,
      unique_id: `${t.node}_${l.id}`,
      schema: 'json',
      command_topic: t.lightSet(l.id),
      state_topic: t.lightState(l.id),
      availability_topic: t.availability,
      supported_color_modes: l.capability === 'onoff' ? ['onoff'] : l.capability === 'rgb' ? ['rgb'] : ['color_temp'],
      device,
      origin: ORIGIN,
    };
    if (l.capability !== 'onoff') cfg.brightness = true;
    if (l.capability === 'ct') Object.assign(cfg, { color_temp_kelvin: true, min_kelvin: MIN_KELVIN, max_kelvin: MAX_KELVIN });
    out.set(t.discovery('light', l.id), cfg);
  }
  out.set(t.discovery('switch', `${d.id}_release`), {
    name: 'Release to Govee',
    unique_id: `${t.node}_${d.id}_release`,
    command_topic: t.releaseSet(d.id),
    state_topic: t.releaseState(d.id),
    availability_topic: t.availability,
    icon: 'mdi:hand-back-left',
    entity_category: 'config',
    device,
    origin: ORIGIN,
  });
  out.set(t.discovery('sensor', `${d.id}_mode`), {
    name: 'Mode',
    unique_id: `${t.node}_${d.id}_mode`,
    state_topic: t.deviceStatus(d.id),
    value_template: '{{ value_json.mode }}',
    json_attributes_topic: t.deviceStatus(d.id),
    device_class: 'enum',
    options: MODES,
    entity_category: 'diagnostic',
    availability_topic: t.availability,
    device,
    origin: ORIGIN,
  });
  return out;
}

/** HA JSON-schema state payload for a light, shaped by its capability. */
export function statePayload(light: VirtualLight, s: LightState): Record<string, unknown> {
  const p: Record<string, unknown> = { state: s.on ? 'ON' : 'OFF' };
  switch (light.capability) {
    case 'onoff':
      p.color_mode = 'onoff';
      break;
    case 'ct':
      if (s.look.kind === 'white') Object.assign(p, { color_mode: 'color_temp', brightness: s.brightness, color_temp: invertTemp(s.look.mireds) });
      break;
    case 'rgb': {
      const [r, g, b] = lookRgb(s.look);
      Object.assign(p, { color_mode: 'rgb', brightness: s.brightness, color: { r, g, b } });
    }
  }
  return p;
}

/** Parse an HA command payload (color_temp in kelvin) into our LightCommand (mireds). */
export function parseCommand(payload: string): LightCommand {
  const raw = JSON.parse(payload) as Record<string, unknown>;
  if (typeof raw.color_temp === 'number') raw.color_temp = invertTemp(raw.color_temp);
  return lightCommand.parse(raw);
}

/**
 * Keeps the broker in sync with the store: discovery configs, retained light
 * state, release switches and mode sensors. Commands go through `Engine.command`,
 * the same path as the web UI.
 */
export class MqttBridge extends EventEmitter<{ status: [MqttStatus] }> {
  readonly t: Topics;
  private client: MqttClient;
  private published = new Map<string, string>(); // discovery topic → payload we last sent
  private syncTimer: NodeJS.Timeout | null = null;
  status: MqttStatus = 'connecting';
  private closing = false;

  constructor(
    private store: Store,
    private engine: Engine,
    private log: Logger,
    opts: MqttOptions,
    connect: (url: string, o: IClientOptions) => MqttClient = mqtt.connect,
  ) {
    super();
    this.t = topics(opts.discoveryPrefix, opts.baseTopic);
    this.client = connect(opts.url, {
      username: opts.username,
      password: opts.password,
      clientId: `${this.t.node}-${Math.random().toString(16).slice(2, 8)}`,
      will: { topic: this.t.availability, payload: Buffer.from('offline'), retain: true, qos: 1 },
      reconnectPeriod: 5000,
    });
    this.client.on('connect', () => this.onConnect());
    this.client.on('close', () => !this.closing && this.setStatus('connecting'));
    this.client.on('error', (e) => this.log.warn({ err: e.message }, 'mqtt error'));
    this.client.on('message', (topic, buf, packet) => this.onMessage(topic, buf.toString(), packet.retain));

    store.on('change', (e) => this.onStoreChange(e));
    engine.on('status', (id, s) => this.publishStatus(id, s));
  }

  private setStatus(s: MqttStatus) {
    if (s === this.status) return;
    this.status = s;
    if (s === 'connected') this.log.info('mqtt connected');
    else this.log.warn('mqtt disconnected; retrying');
    this.emit('status', s);
  }

  private onConnect() {
    this.setStatus('connected');
    this.client.subscribe([...this.t.subscriptions, this.t.discoveryWildcard], { qos: 1 });
    this.publishAll();
  }

  /** Everything, from scratch: after (re)connect and when HA comes back online. */
  private publishAll() {
    this.published.clear();
    this.syncDiscovery();
    for (const l of this.store.lights) this.publishState(l.id);
    for (const d of this.store.devices) {
      this.publishRelease(d.id);
      this.publishStatus(d.id, this.engine.status(d.id));
    }
    this.pub(this.t.availability, 'online');
  }

  private desiredDiscovery(): Map<string, string> {
    const out = new Map<string, string>();
    for (const d of this.store.devices)
      for (const [topic, cfg] of discoveryFor(this.t, d, this.store.lightsFor(d.id))) out.set(topic, JSON.stringify(cfg));
    return out;
  }

  /** Publish changed configs and clear (empty retained payload) ones that no longer exist. */
  private syncDiscovery() {
    const desired = this.desiredDiscovery();
    for (const [topic, payload] of desired) {
      if (this.published.get(topic) === payload) continue;
      this.pub(topic, payload);
      this.published.set(topic, payload);
    }
    for (const topic of this.published.keys()) {
      if (desired.has(topic)) continue;
      this.pub(topic, '');
      this.published.delete(topic);
    }
  }

  private scheduleSync() {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (this.status === 'connected') this.syncDiscovery();
    }, 50);
  }

  private onStoreChange(e: StoreEvent) {
    if (this.status !== 'connected') return; // publishAll() runs on connect
    switch (e.kind) {
      case 'state':
        this.publishState(e.id);
        break;
      case 'flags':
        this.publishRelease(e.id);
        break;
      case 'light':
        this.scheduleSync();
        if (e.removed) this.pub(this.t.lightState(e.id), '');
        else this.publishState(e.id); // capability may have changed the payload shape
        break;
      case 'device':
        this.scheduleSync();
        if (e.removed) {
          this.pub(this.t.releaseState(e.id), '');
          this.pub(this.t.deviceStatus(e.id), '');
        } else {
          this.publishRelease(e.id);
          this.publishStatus(e.id, this.engine.status(e.id));
        }
        break;
      case 'reset':
        this.publishAll(); // also clears configs for lights that the import dropped
        break;
    }
  }

  private onMessage(topic: string, payload: string, retained: boolean) {
    try {
      if (topic === this.t.haStatus) {
        if (payload === 'online') this.publishAll(); // HA restarted: re-announce
        return;
      }
      if (topic.endsWith('/config')) {
        // Retained config from a previous run for something that no longer exists.
        if (payload && !this.published.has(topic) && !this.desiredDiscovery().has(topic)) {
          this.log.info({ topic }, 'clearing stale discovery config');
          this.pub(topic, '');
        }
        return;
      }
      if (retained) return; // never act on retained commands
      const parts = topic.split('/');
      const id = parts.at(-2) === 'release' ? parts.at(-3)! : parts.at(-2)!;
      if (topic === this.t.lightSet(id)) {
        if (!this.store.light(id)) return this.log.warn({ topic }, 'command for unknown light');
        this.engine.command(id, parseCommand(payload));
      } else if (topic === this.t.releaseSet(id)) {
        if (!this.store.device(id)) return this.log.warn({ topic }, 'command for unknown device');
        const v = payload.trim().toUpperCase();
        if (v !== 'ON' && v !== 'OFF') return this.log.warn({ topic, payload }, 'release payload must be ON or OFF');
        this.engine.setReleased(id, v === 'ON');
      }
    } catch (e) {
      this.log.warn({ topic, payload, err: (e as Error).message }, 'bad mqtt command');
    }
  }

  private publishState(lightId: string) {
    const l = this.store.light(lightId);
    if (l) this.pub(this.t.lightState(l.id), JSON.stringify(statePayload(l, this.store.state(l.id))));
  }

  private publishRelease(deviceId: string) {
    if (this.store.device(deviceId)) this.pub(this.t.releaseState(deviceId), this.store.flags(deviceId).released ? 'ON' : 'OFF');
  }

  private publishStatus(deviceId: string, s: DeviceStatus) {
    if (this.status !== 'connected' || !this.store.device(deviceId)) return;
    this.pub(this.t.deviceStatus(deviceId), JSON.stringify({ mode: s.mode, reason: s.reason ?? null, detail: s.detail ?? null, error: s.error ?? null, groups: s.groups ?? null }));
  }

  private pub(topic: string, payload: string) {
    this.client.publish(topic, payload, { retain: true, qos: 1 });
  }

  /** Mark offline (the LWT only fires on unclean disconnects) and disconnect. */
  async close() {
    this.closing = true;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.client.connected) await this.client.publishAsync(this.t.availability, 'offline', { retain: true, qos: 1 }).catch(() => {});
    await this.client.endAsync();
  }
}
