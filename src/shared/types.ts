// Shared between server and web UI. Keep free of Node-only imports.
import type { Layout } from './layout.js';

export type RGB = [number, number, number];

/** Inclusive LED index range [start, end]. */
export type Range = [number, number];

export type Capability = 'onoff' | 'dimmable' | 'rgb' | 'rgb_ct';
export type IdleBehavior = 'off' | 'hold_black' | 'release';
export type DeviceMode = 'streaming' | 'idle' | 'released' | 'error';

export interface Device {
  id: string;
  name: string;
  ip: string;
  ledCount: number;
  maxColorsPerPacket: number;
  keepaliveMs: number;
  enabled: boolean;
  idleBehavior: IdleBehavior;
  /** Traced house outline for the UI; optional. */
  layout?: Layout;
  /**
   * Per-channel output gains in percent (default 100,100,100), applied to every
   * frame sent to this strip to correct the LEDs' white point. The UI preview
   * shows uncorrected colors.
   */
  whiteBalance?: RGB;
}

export interface LightDefaults {
  color: RGB;
  brightness: number; // 0-255
  colorTemp?: number; // mireds
}

export interface VirtualLight {
  id: string;
  name: string;
  deviceId: string;
  ranges: Range[];
  priority: number;
  capability: Capability;
  defaults: LightDefaults;
  transitionMs: number;
  /** Monotonic creation counter; breaks priority ties deterministically. */
  order: number;
}

/** Persisted runtime state per virtual light. */
export interface LightState {
  on: boolean;
  brightness: number; // 0-255
  color: RGB;
  colorTemp?: number; // mireds; set when the last color came from a color temperature
}

/** Persisted runtime flags per device. */
export interface DeviceFlags {
  released: boolean;
}

/** Live (not persisted) status per device. */
export interface DeviceStatus {
  mode: DeviceMode;
  streaming: boolean;
  error?: string;
  /** Number of colors actually sent per frame (after downsampling). */
  sentColors: number;
}

/**
 * Light command, shaped like Home Assistant's MQTT JSON-schema light command so
 * the web UI and the MQTT bridge share one code path.
 */
export interface LightCommand {
  state?: 'ON' | 'OFF';
  brightness?: number;
  color?: { r: number; g: number; b: number };
  color_temp?: number; // mireds
  transition?: number; // seconds
}

export interface ConfigSnapshot {
  version: 1;
  devices: Device[];
  lights: VirtualLight[];
}

export interface AppSnapshot extends ConfigSnapshot {
  states: Record<string, LightState>;
  flags: Record<string, DeviceFlags>;
  status: Record<string, DeviceStatus>;
  mqtt: 'disabled' | 'connecting' | 'connected';
}

export type ServerMessage =
  | { type: 'snapshot'; data: AppSnapshot }
  | { type: 'frame'; deviceId: string; pixels: string /* base64 RGB, full resolution */; mode: DeviceMode };
