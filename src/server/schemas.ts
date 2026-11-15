import { z } from 'zod';
import { MAX_MIREDS, MIN_MIREDS } from '../shared/color.js';

const byte = z.number().int().min(0).max(255);
const rgb = z.tuple([byte, byte, byte]);
const mireds = z.number().int().min(MIN_MIREDS).max(MAX_MIREDS);
const pct = z.number().int().min(0).max(100);

export const look = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rgb'), color: rgb }),
  z.object({ kind: z.literal('white'), mireds }),
]);

const layout = z.object({
  height: z.number().min(50).max(5000),
  points: z.array(z.object({ x: z.number(), y: z.number(), led: z.number().int().min(0).optional() })).max(500),
  background: z.number().optional(),
});

// Base shapes carry no defaults: Zod applies defaults inside .partial() too,
// which would make a partial update reset every unmentioned field.
const deviceBase = z.object({
  name: z.string().trim().min(1),
  ip: z.string().trim().min(1),
  ledCount: z.number().int().min(1).max(2000),
  maxColorsPerPacket: z.number().int().min(1).max(255),
  keepaliveMs: z.number().int().min(250).max(50_000),
  enabled: z.boolean(),
  groupSize: z.number().int().min(0).max(16),
  control: z.enum(['auto', 'per_led']),
  partialGroups: z.enum(['round', 'exact']),
  layout: layout.optional(),
  whiteBalance: z.tuple([pct, pct, pct]).optional(),
});
export const deviceInput = deviceBase.extend({
  maxColorsPerPacket: deviceBase.shape.maxColorsPerPacket.default(84),
  keepaliveMs: deviceBase.shape.keepaliveMs.default(2000),
  enabled: deviceBase.shape.enabled.default(true),
  groupSize: deviceBase.shape.groupSize.default(4),
  control: deviceBase.shape.control.default('auto'),
  partialGroups: deviceBase.shape.partialGroups.default('round'),
});
export const devicePatch = deviceBase.partial();

const lightBase = z.object({
  name: z.string().trim().min(1),
  deviceId: z.string(),
  ranges: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])),
  priority: z.number().int(),
  capability: z.enum(['onoff', 'rgb', 'ct']),
  defaults: z.object({ brightness: z.number().int().min(1).max(255), look }),
  transitionMs: z.number().int().min(0).max(60_000),
});
export const lightInput = lightBase.extend({
  ranges: lightBase.shape.ranges.default([]),
  priority: lightBase.shape.priority.default(0),
  capability: lightBase.shape.capability.default('ct'),
  defaults: lightBase.shape.defaults.default({ brightness: 255, look: { kind: 'white', mireds: 370 } }),
  transitionMs: lightBase.shape.transitionMs.default(500),
});
export const lightPatch = lightBase.omit({ deviceId: true }).partial();

/** `rgb` lights default to a color and `ct` lights to a white; `onoff` takes either. */
export function checkLight(l: { name: string; capability: string; defaults: { look: { kind: string } } }) {
  const want = l.capability === 'rgb' ? 'rgb' : l.capability === 'ct' ? 'white' : null;
  if (want && l.defaults.look.kind !== want)
    throw new Error(`light "${l.name}": ${l.capability === 'ct' ? 'a White' : 'an RGB'} light's default look must be a ${want === 'rgb' ? 'color' : 'white'}`);
}

export const lightState = z.object({ on: z.boolean(), brightness: byte, look });

export const lightCommand = z.object({
  state: z.enum(['ON', 'OFF']).optional(),
  brightness: z.number().min(0).max(255).optional(),
  color: z.object({ r: z.number(), g: z.number(), b: z.number() }).optional(),
  color_temp: z.number().optional(),
  transition: z.number().min(0).optional(),
});

export const configImport = z.object({
  version: z.literal(1),
  devices: z.array(deviceInput.extend({ id: z.string().min(1) })),
  lights: z.array(lightInput.extend({ id: z.string().min(1), order: z.number().int().default(0) })),
});
