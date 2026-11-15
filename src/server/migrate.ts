// One-way migration of configs from before group control (light `defaults.color`
// / `colorTemp`, capabilities `dimmable` / `rgb_ct`, device `idleBehavior`).
// Pure: takes parsed JSON, returns the converted JSON plus human-readable notes.
import { clampMireds } from '../shared/color.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const isOldLight = (l: Json) => l?.defaults && ('color' in l.defaults || 'colorTemp' in l.defaults);
const isOldState = (s: Json) => s && !('look' in s) && ('color' in s || 'colorTemp' in s);

/** The look an old color/colorTemp pair described. */
function oldLook(o: Json): Json {
  if (typeof o.colorTemp === 'number') return { kind: 'white', mireds: clampMireds(o.colorTemp) };
  return { kind: 'rgb', color: Array.isArray(o.color) ? o.color : [255, 180, 100] };
}

function newCapability(old: string, look: Json): string {
  if (old === 'rgb_ct' || old === 'dimmable') return look.kind === 'white' ? 'ct' : 'rgb';
  if (old === 'rgb' && look.kind === 'white') return 'ct';
  return old;
}

/** A state's look, made valid for the light's (new) capability. */
function stateLook(state: Json, light: Json): Json {
  if (light.capability === 'onoff') return light.defaults.look;
  const look = oldLook(state);
  if (light.capability === 'ct' && look.kind !== 'white') return light.defaults.look;
  if (light.capability === 'rgb' && look.kind !== 'rgb') return { kind: 'rgb', color: Array.isArray(state.color) ? state.color : light.defaults.look.color };
  return look;
}

/**
 * Convert an old config (the stored file, or an exported config) in place-safe
 * fashion. Returns `notes` describing each change; empty when nothing was old.
 */
export function migrateConfig<T extends Json>(raw: T): { data: T; notes: string[] } {
  const notes: string[] = [];
  const data: Json = structuredClone(raw);

  for (const d of data.devices ?? []) {
    if ('idleBehavior' in d) {
      notes.push(`device "${d.name}": removed "When all lights are off" (${d.idleBehavior}); the strip now always turns off`);
      delete d.idleBehavior;
    }
  }

  const lightsById = new Map<string, Json>();
  for (const l of data.lights ?? []) {
    lightsById.set(l.id, l);
    if (!isOldLight(l)) continue;
    const look = oldLook(l.defaults);
    const capability = newCapability(l.capability, look);
    const brightness = Math.max(1, Math.min(255, Math.round(l.defaults.brightness ?? 255)));
    const what = look.kind === 'white' ? `white ${Math.round(1_000_000 / look.mireds)} K` : `color rgb(${look.color.join(', ')})`;
    notes.push(
      `light "${l.name}": ${capability === l.capability ? capability : `${l.capability} → ${capability}`}, default look ${what}, brightness ${brightness}`,
    );
    l.capability = capability;
    l.defaults = { brightness, look };
  }

  for (const [id, s] of Object.entries((data.states ?? {}) as Record<string, Json>)) {
    if (!isOldState(s)) continue;
    const light = lightsById.get(id);
    if (!light) {
      delete data.states[id];
      continue;
    }
    data.states[id] = { on: !!s.on, brightness: Math.max(0, Math.min(255, Math.round(s.brightness ?? 255))), look: stateLook(s, light) };
  }

  return { data: data as T, notes };
}
