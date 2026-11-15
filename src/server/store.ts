// Persisted config + runtime state, stored as one JSON file in DATA_DIR.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  ConfigSnapshot,
  Device,
  DeviceFlags,
  LightState,
  VirtualLight,
} from '../shared/types.js';
import { defaultState } from './commands.js';
import { migrateConfig } from './migrate.js';
import { checkLight, configImport, lightState, type deviceInput, type devicePatch, type lightInput, type lightPatch } from './schemas.js';

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
  /** What loading converted from an older config format (empty if nothing). The original is kept as a backup. */
  readonly migrationNotes: string[] = [];
  /** Where the pre-migration file was copied to, if a migration happened. */
  readonly migrationBackup?: string;

  /** `dataDir` null keeps everything in memory (tests). */
  constructor(dataDir: string | null) {
    super();
    this.file = dataDir ? path.join(dataDir, 'govee-zones.json') : null;
    this.data = { version: 1, devices: [], lights: [], states: {}, flags: {}, nextOrder: 0 };
    if (this.file && fs.existsSync(this.file)) {
      const original = fs.readFileSync(this.file, 'utf8');
      const { data: raw, notes } = migrateConfig(JSON.parse(original));
      if (notes.length) {
        this.migrationNotes = notes;
        this.migrationBackup = `${this.file}.pre-groups-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
        fs.writeFileSync(this.migrationBackup, original);
      }
      const parsed = configImport.safeParse({ version: 1, devices: raw.devices ?? [], lights: raw.lights ?? [] });
      if (!parsed.success) throw new Error(`invalid config in ${this.file}; fix it by hand:\n${z.prettifyError(parsed.error)}`);
      for (const l of parsed.data.lights) checkLight(l);
      // Runtime states in an old shape are just reset to the light's defaults.
      const states = Object.fromEntries(
        Object.entries((raw.states ?? {}) as Record<string, unknown>).flatMap(([id, s]) => {
          const r = lightState.safeParse(s);
          return r.success ? [[id, r.data]] : [];
        }),
      );
      this.data = { ...this.data, ...raw, devices: parsed.data.devices, lights: parsed.data.lights, states };
      if (notes.length) this.flush(); // store the converted config right away
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
    return this.data.states[lightId] ?? (light ? defaultState(light) : { on: false, brightness: 255, look: { kind: 'white', mireds: 370 } });
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
    checkLight(input);
    const light: VirtualLight = { id: newId(), ...input, order: this.data.nextOrder++ };
    this.data.lights.push(light);
    this.data.states[light.id] = defaultState(light);
    this.changed({ kind: 'light', id: light.id, deviceId: light.deviceId });
    return light;
  }

  updateLight(id: string, patch: z.infer<typeof lightPatch>): VirtualLight | undefined {
    const l = this.light(id);
    if (!l) return;
    const next = { ...l, ...stripUndefined(patch) };
    checkLight(next);
    // A capability change can make the stored state's look invalid: start from the new defaults.
    if (next.capability !== l.capability) this.data.states[id] = { ...defaultState(next), on: this.state(id).on };
    Object.assign(l, next);
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
    for (const l of cfg.lights) checkLight(l);
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
