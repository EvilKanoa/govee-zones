// Persisted config + runtime state, stored as one JSON file in DATA_DIR.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import type {
  ConfigSnapshot,
  Device,
  DeviceFlags,
  LightState,
  VirtualLight,
} from '../shared/types.js';
import { defaultState } from './commands.js';
import type { configImport, deviceInput, devicePatch, lightInput, lightPatch } from './schemas.js';

interface FileShape extends ConfigSnapshot {
  states: Record<string, LightState>;
  flags: Record<string, DeviceFlags>;
  nextOrder: number;
}

export type StoreEvent =
  | { kind: 'device'; id: string; removed?: boolean }
  | { kind: 'light'; id: string; deviceId: string; removed?: boolean }
  | { kind: 'state'; id: string; deviceId: string }
  | { kind: 'flags'; id: string }
  | { kind: 'reset' };

const newId = () => randomUUID().slice(0, 8);

export class Store extends EventEmitter<{ change: [StoreEvent] }> {
  private data: FileShape;
  private file: string | null;
  private saveTimer: NodeJS.Timeout | null = null;

  /** `dataDir` null keeps everything in memory (tests). */
  constructor(dataDir: string | null) {
    super();
    this.file = dataDir ? path.join(dataDir, 'govee-zones.json') : null;
    this.data = { version: 1, devices: [], lights: [], states: {}, flags: {}, nextOrder: 0 };
    if (this.file && fs.existsSync(this.file)) {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    }
  }

  // --- reads ---------------------------------------------------------------

  get devices(): Device[] {
    return this.data.devices;
  }
  get lights(): VirtualLight[] {
    return this.data.lights;
  }
  device(id: string) {
    return this.data.devices.find((d) => d.id === id);
  }
  light(id: string) {
    return this.data.lights.find((l) => l.id === id);
  }
  lightsFor(deviceId: string) {
    return this.data.lights.filter((l) => l.deviceId === deviceId);
  }
  state(lightId: string): LightState {
    const light = this.light(lightId);
    return this.data.states[lightId] ?? (light ? defaultState(light) : { on: false, brightness: 255, color: [255, 255, 255] });
  }
  get states(): Record<string, LightState> {
    return Object.fromEntries(this.data.lights.map((l) => [l.id, this.state(l.id)]));
  }
  flags(deviceId: string): DeviceFlags {
    return this.data.flags[deviceId] ?? { released: false };
  }
  get allFlags(): Record<string, DeviceFlags> {
    return Object.fromEntries(this.data.devices.map((d) => [d.id, this.flags(d.id)]));
  }
  exportConfig(): ConfigSnapshot {
    return { version: 1, devices: this.data.devices, lights: this.data.lights };
  }

  // --- writes --------------------------------------------------------------

  addDevice(input: z.infer<typeof deviceInput>): Device {
    const device: Device = { id: newId(), ...input };
    this.data.devices.push(device);
    this.changed({ kind: 'device', id: device.id });
    return device;
  }

  updateDevice(id: string, patch: z.infer<typeof devicePatch>): Device | undefined {
    const d = this.device(id);
    if (!d) return;
    Object.assign(d, stripUndefined(patch));
    this.changed({ kind: 'device', id });
    return d;
  }

  removeDevice(id: string): boolean {
    if (!this.device(id)) return false;
    for (const l of this.lightsFor(id)) this.removeLight(l.id);
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    delete this.data.flags[id];
    this.changed({ kind: 'device', id, removed: true });
    return true;
  }

  addLight(input: z.infer<typeof lightInput>): VirtualLight {
    const light: VirtualLight = { id: newId(), ...input, order: this.data.nextOrder++ };
    this.data.lights.push(light);
    this.data.states[light.id] = defaultState(light);
    this.changed({ kind: 'light', id: light.id, deviceId: light.deviceId });
    return light;
  }

  updateLight(id: string, patch: z.infer<typeof lightPatch>): VirtualLight | undefined {
    const l = this.light(id);
    if (!l) return;
    Object.assign(l, stripUndefined(patch));
    this.changed({ kind: 'light', id, deviceId: l.deviceId });
    return l;
  }

  removeLight(id: string): boolean {
    const l = this.light(id);
    if (!l) return false;
    this.data.lights = this.data.lights.filter((x) => x.id !== id);
    delete this.data.states[id];
    this.changed({ kind: 'light', id, deviceId: l.deviceId, removed: true });
    return true;
  }

  /** Set priorities from a bottom-to-top ordering of a device's light ids. */
  reorder(deviceId: string, idsLowToHigh: string[]) {
    idsLowToHigh.forEach((id, i) => {
      const l = this.light(id);
      if (l && l.deviceId === deviceId) l.priority = i;
    });
    for (const l of this.lightsFor(deviceId)) this.changed({ kind: 'light', id: l.id, deviceId });
  }

  setState(lightId: string, state: LightState) {
    const l = this.light(lightId);
    if (!l) return;
    this.data.states[lightId] = state;
    this.changed({ kind: 'state', id: lightId, deviceId: l.deviceId });
  }

  setFlags(deviceId: string, flags: Partial<DeviceFlags>) {
    this.data.flags[deviceId] = { ...this.flags(deviceId), ...flags };
    this.changed({ kind: 'flags', id: deviceId });
  }

  /** Replace all devices and lights. States for surviving light ids are kept. */
  importConfig(cfg: z.infer<typeof configImport>) {
    const ids = new Set(cfg.lights.map((l) => l.id));
    this.data.devices = cfg.devices;
    this.data.lights = cfg.lights;
    this.data.states = Object.fromEntries(Object.entries(this.data.states).filter(([id]) => ids.has(id)));
    this.data.nextOrder = Math.max(this.data.nextOrder, ...cfg.lights.map((l) => l.order + 1));
    this.changed({ kind: 'reset' });
  }

  private changed(e: StoreEvent) {
    this.scheduleSave();
    this.emit('change', e);
  }

  private scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 250);
  }

  /** Write now (atomic via rename). Called on shutdown. */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
