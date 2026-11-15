import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateConfig } from '../src/server/migrate.js';
import { Store } from '../src/server/store.js';

/** A config as the pre-group-control version wrote it. */
const old = () => ({
  version: 1,
  devices: [{ id: 'd1', name: 'House', ip: '192.168.2.27', ledCount: 60, maxColorsPerPacket: 84, keepaliveMs: 2000, enabled: true, idleBehavior: 'hold_black' }],
  lights: [
    { id: 'on1', name: 'Porch', deviceId: 'd1', ranges: [[0, 7]], priority: 0, capability: 'onoff', defaults: { color: [255, 180, 100], brightness: 255 }, transitionMs: 500, order: 0 },
    { id: 'on2', name: 'Eaves', deviceId: 'd1', ranges: [[8, 15]], priority: 1, capability: 'onoff', defaults: { color: [255, 255, 255], brightness: 0 }, transitionMs: 500, order: 1 },
    { id: 'dim', name: 'Back Accent', deviceId: 'd1', ranges: [[16, 23]], priority: 2, capability: 'dimmable', defaults: { color: [255, 180, 100], brightness: 200 }, transitionMs: 500, order: 2 },
    { id: 'ct', name: 'Garage', deviceId: 'd1', ranges: [[24, 31]], priority: 3, capability: 'rgb_ct', defaults: { color: [255, 160, 80], brightness: 255, colorTemp: 500 }, transitionMs: 500, order: 3 },
    { id: 'col', name: 'Accent', deviceId: 'd1', ranges: [[32, 35]], priority: 4, capability: 'rgb_ct', defaults: { color: [0, 0, 255], brightness: 255 }, transitionMs: 500, order: 4 },
  ],
  states: {
    on1: { on: true, brightness: 255, color: [255, 180, 100] },
    on2: { on: false, brightness: 0, color: [255, 255, 255] },
    dim: { on: true, brightness: 64, color: [255, 180, 100] },
    ct: { on: true, brightness: 255, color: [255, 200, 150], colorTemp: 200 },
    col: { on: false, brightness: 255, color: [0, 255, 0] },
    gone: { on: true, brightness: 255, color: [1, 2, 3] },
  },
  flags: { d1: { released: true } },
  nextOrder: 5,
});

describe('migrateConfig', () => {
  const { data, notes } = migrateConfig(old());
  const light = (id: string) => data.lights.find((l) => l.id === id)!;

  it('keeps on/off lights on/off, with their color as the look; brightness 0 becomes 1', () => {
    expect(light('on1')).toMatchObject({ capability: 'onoff', defaults: { brightness: 255, look: { kind: 'rgb', color: [255, 180, 100] } } });
    expect(light('on2').defaults).toEqual({ brightness: 1, look: { kind: 'rgb', color: [255, 255, 255] } });
    expect(light('on1')).not.toHaveProperty('defaults.color');
  });

  it('dimmable → rgb; rgb_ct → ct with a color temperature (clamped to 2700 K), else rgb', () => {
    expect(light('dim')).toMatchObject({ capability: 'rgb', defaults: { brightness: 200, look: { kind: 'rgb', color: [255, 180, 100] } } });
    expect(light('ct')).toMatchObject({ capability: 'ct', defaults: { look: { kind: 'white', mireds: 370 } } });
    expect(light('col')).toMatchObject({ capability: 'rgb', defaults: { look: { kind: 'rgb', color: [0, 0, 255] } } });
  });

  it('converts states, keeping on/off and brightness; drops states of missing lights', () => {
    expect(data.states.on1).toEqual({ on: true, brightness: 255, look: { kind: 'rgb', color: [255, 180, 100] } });
    expect(data.states.dim).toEqual({ on: true, brightness: 64, look: { kind: 'rgb', color: [255, 180, 100] } });
    expect(data.states.ct).toEqual({ on: true, brightness: 255, look: { kind: 'white', mireds: 200 } });
    expect(data.states.col).toEqual({ on: false, brightness: 255, look: { kind: 'rgb', color: [0, 255, 0] } });
    expect(data.states).not.toHaveProperty('gone');
  });

  it('drops idleBehavior and keeps everything else', () => {
    expect(data.devices[0]).not.toHaveProperty('idleBehavior');
    expect(data.devices[0]).toMatchObject({ id: 'd1', ip: '192.168.2.27' });
    expect(data.flags).toEqual({ d1: { released: true } });
    expect(notes).toHaveLength(6); // 1 device + 5 lights
    expect(notes[0]).toMatch(/House.*hold_black/);
  });

  it('is a no-op on a converted config', () => {
    expect(migrateConfig(data)).toEqual({ data, notes: [] });
  });

  it("doesn't touch the input", () => {
    const input = old();
    migrateConfig(input);
    expect(input).toEqual(old());
  });
});

describe('Store loads an old config file', () => {
  it('converts it, keeps a backup, and loads cleanly afterwards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gz-migrate-'));
    const file = path.join(dir, 'govee-zones.json');
    fs.writeFileSync(file, JSON.stringify(old()));

    const store = new Store(dir);
    expect(store.migrationNotes.length).toBeGreaterThan(0);
    expect(fs.readFileSync(store.migrationBackup!, 'utf8')).toBe(JSON.stringify(old()));
    expect(store.devices[0]).toMatchObject({ groupSize: 4, control: 'auto', partialGroups: 'round' });
    expect(store.state('on1')).toEqual({ on: true, brightness: 255, look: { kind: 'rgb', color: [255, 180, 100] } });
    expect(store.flags('d1').released).toBe(true);

    const again = new Store(dir); // the converted file was written back
    expect(again.migrationNotes).toEqual([]);
    expect(again.lights.map((l) => l.capability)).toEqual(['onoff', 'onoff', 'rgb', 'ct', 'rgb']);
    fs.rmSync(dir, { recursive: true });
  });
});
