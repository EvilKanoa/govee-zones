// Shared between server and web UI. Keep free of Node-only imports.
import type { Layout } from './layout.js';

export type RGB = [number, number, number];

/** Inclusive LED index range [start, end]. */
export type Range = [number, number];

/**
 * `onoff`: fixed look (color or white). `rgb`: color + brightness. `ct`: white
 * (color temperature) + brightness; uses the strip's real white in group mode.
 */
export type Capability = 'onoff' | 'rgb' | 'ct';

/** What a light shows, before brightness. White is in mireds (2700-6500 K → 154-370). */
export type Look = { kind: 'rgb'; color: RGB } | { kind: 'white'; mireds: number };

/**
 * `groups`: driven with segment commands (groups of LEDs, real white, the strip
 * holds state). `per_led`: razer streaming. See docs/segment-mode-plan.md.
 */
export type DeviceMode = 'groups' | 'per_led' | 'idle' | 'released' | 'error';
export type ControlMethod = 'auto' | 'per_led';
export type PartialGroups = 'round' | 'exact';

/** Why the strip is in its current mode (shown in the UI and as an HA attribute). */
export type ControlReason =
  | 'auto' // groups: normal
  | 'groups_off' // per_led: groupSize = 0
  | 'too_many_groups' // per_led: more groups than the tested mask holds
  | 'per_led_setting' // per_led: control = per_led
  | 'override' // per_led: pixel finder, test chase, mixed-white test
  | 'exact_leds' // per_led: a visible light partly covers a group and partialGroups = exact
  | 'fade_finishing'; // per_led: wants groups, finishing a fade first

export interface Device {
  id: string;
  name: string;
  ip: string;
  ledCount: number;
  maxColorsPerPacket: number;
  keepaliveMs: number;
  enabled: boolean;
  /** LEDs per segment-mask bit (4 on the H805A). 0 turns group control off. */
  groupSize: number;
  control: ControlMethod;
  partialGroups: PartialGroups;
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
  brightness: number; // 1-255
  look: Look;
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
  look: Look;
}

/** Persisted runtime flags per device. */
export interface DeviceFlags {
  released: boolean;
}

/** Live (not persisted) status per device. */
export interface DeviceStatus {
  mode: DeviceMode;
  reason?: ControlReason;
  /** exact_leds: names of the lights forcing per-LED. override: which one. */
  detail?: string[];
  error?: string;
  /** Group count when group control is available. */
  groups?: number;
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
  | {
      type: 'frame';
      deviceId: string;
      /** base64 RGB, full resolution: what the strip shows (group looks expanded to LEDs). */
      pixels: string;
      mode: DeviceMode;
      /** Group mode: per group, whether it shows the strip's real white. */
      realWhite?: boolean[];
    };
