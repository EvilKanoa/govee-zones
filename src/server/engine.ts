// Per-device render/stream loop: store → compositor → lifecycle → transport.
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { miredsToRgb } from '../shared/color.js';
import type { Device, DeviceStatus, LightCommand } from '../shared/types.js';
import { applyCommand, commandTransitionMs } from './commands.js';
import {
  animating,
  applyWhiteBalance,
  composite,
  downsample,
  lookAt,
  startTransition,
  transitionActive,
  type RenderState,
  type Transition,
} from './compositor.js';
import { decide, type Action } from './lifecycle.js';
import * as proto from './protocol.js';
import type { Store, StoreEvent } from './store.js';
import type { Transport } from './transport.js';

const FRAME_INTERVAL_MS = 33; // ~30 fps while animating
/**
 * Periodically re-send brightness 100 + razer enable: undoes a brightness change
 * from the Govee app, and recovers if the strip power-cycled mid-stream (unverified).
 */
const REASSERT_MS = 30_000;

/** A temporary frame source that takes over a device (identify, pixel finder, test chase). */
interface Override {
  until: number;
  animated: boolean;
  render(now: number): Uint8Array;
}

interface Controller {
  streaming: boolean;
  error?: string;
  mode: DeviceStatus['mode'];
  ip: string;
  timer: NodeJS.Timeout | null;
  lastTick: number;
  lastAssert: number;
  override?: Override;
}

export class Engine extends EventEmitter<{
  frame: [deviceId: string, pixels: Uint8Array];
  status: [deviceId: string, status: DeviceStatus];
}> {
  private ctl = new Map<string, Controller>();
  private transitions = new Map<string, Transition>();
  private stopped = false;

  constructor(
    private store: Store,
    private transport: Transport,
    private log: Logger,
    private now: () => number = Date.now,
  ) {
    super();
    store.on('change', (e) => this.onStoreChange(e));
  }

  /** Restore persisted state and apply the policy to every device (SPEC §6.5). */
  start() {
    for (const d of this.store.devices) this.requestTick(d.id);
  }

  status(deviceId: string): DeviceStatus {
    const d = this.store.device(deviceId);
    const c = this.ctl.get(deviceId);
    return {
      mode: c?.mode ?? 'idle',
      streaming: c?.streaming ?? false,
      error: c?.error,
      sentColors: d ? Math.min(d.ledCount, d.maxColorsPerPacket) : 0,
    };
  }

  allStatus(): Record<string, DeviceStatus> {
    return Object.fromEntries(this.store.devices.map((d) => [d.id, this.status(d.id)]));
  }

  // --- commands ------------------------------------------------------------

  /** Apply an HA-style light command. Stored even while released (SPEC §6.3). */
  command(lightId: string, cmd: LightCommand) {
    const light = this.store.light(lightId);
    if (!light) throw new Error(`unknown light ${lightId}`);
    const now = this.now();
    const prev = this.renderState(lightId);
    const next = applyCommand(light, prev, cmd);
    const t = startTransition(lookAt(prev, now), next, commandTransitionMs(light, cmd), now);
    if (t) this.transitions.set(lightId, t);
    else this.transitions.delete(lightId);
    this.store.setState(lightId, next);
  }

  setReleased(deviceId: string, released: boolean) {
    this.store.setFlags(deviceId, { released });
  }

  /** Blink a light's ranges white (everything else black) so it can be found on the house. */
  identify(lightId: string, durationMs = 5000) {
    const light = this.store.light(lightId);
    if (!light) throw new Error(`unknown light ${lightId}`);
    const device = this.requireDevice(light.deviceId);
    const start = this.now();
    this.setOverride(device, {
      until: start + durationMs,
      animated: true,
      render: (now) => {
        const out = new Uint8Array(device.ledCount * 3);
        if (Math.floor((now - start) / 400) % 2 === 0) {
          for (const [a, b] of light.ranges)
            for (let i = Math.max(0, a); i <= Math.min(b, device.ledCount - 1); i++) out.fill(255, i * 3, i * 3 + 3);
        }
        return out;
      },
    });
  }

  /** Light one LED white (everything else black). */
  pixel(deviceId: string, index: number, durationMs = 10_000) {
    const device = this.requireDevice(deviceId);
    if (index < 0 || index >= device.ledCount) throw new RangeError(`LED ${index} out of range`);
    const out = new Uint8Array(device.ledCount * 3);
    out.fill(255, index * 3, index * 3 + 3);
    this.setOverride(device, { until: this.now() + durationMs, animated: false, render: () => out });
  }

  /** Short chase along the whole strip. */
  test(deviceId: string, durationMs = 6000) {
    const device = this.requireDevice(deviceId);
    const start = this.now();
    const width = Math.max(3, Math.round(device.ledCount / 20));
    this.setOverride(device, {
      until: start + durationMs,
      animated: true,
      render: (now) => {
        const out = new Uint8Array(device.ledCount * 3);
        const head = Math.floor(((now - start) / 3000) * device.ledCount) % device.ledCount;
        for (let k = 0; k < width; k++) {
          const i = (head - k + device.ledCount) % device.ledCount;
          const v = Math.round(255 * (1 - k / width));
          out[i * 3] = v;
          out[i * 3 + 1] = Math.round(v * 0.4);
          out[i * 3 + 2] = 255 - v;
        }
        return out;
      },
    });
  }

  /** Whole strip in one color temperature, for tuning white balance against Govee's own white. */
  testWhite(deviceId: string, kelvin = 2700, durationMs = 120_000) {
    const device = this.requireDevice(deviceId);
    const rgb = miredsToRgb(1_000_000 / kelvin);
    const out = new Uint8Array(device.ledCount * 3);
    for (let i = 0; i < device.ledCount; i++) out.set(rgb, i * 3);
    this.setOverride(device, { until: this.now() + durationMs, animated: false, render: () => out });
  }

  clearOverride(deviceId: string) {
    const c = this.ctl.get(deviceId);
    if (c?.override) {
      c.override = undefined;
      this.requestTick(deviceId);
    }
  }

  private setOverride(device: Device, o: Override) {
    if (!device.enabled) throw new Error('device is disabled');
    if (this.store.flags(device.id).released) throw new Error('device is released to Govee');
    this.controller(device).override = o;
    this.requestTick(device.id);
  }

  // --- loop ----------------------------------------------------------------

  private renderState(lightId: string): RenderState {
    return { ...this.store.state(lightId), transition: this.transitions.get(lightId) };
  }

  private requireDevice(id: string): Device {
    const d = this.store.device(id);
    if (!d) throw new Error(`unknown device ${id}`);
    return d;
  }

  private controller(d: Device): Controller {
    let c = this.ctl.get(d.id);
    if (!c) {
      c = { streaming: false, mode: 'idle', ip: d.ip, timer: null, lastTick: 0, lastAssert: 0 };
      this.ctl.set(d.id, c);
    }
    return c;
  }

  private onStoreChange(e: StoreEvent) {
    if (e.kind === 'reset') {
      for (const [id, c] of this.ctl) if (!this.store.device(id)) this.retire(id, c);
      for (const d of this.store.devices) this.requestTick(d.id);
      return;
    }
    if (e.kind === 'device') {
      const c = this.ctl.get(e.id);
      const d = this.store.device(e.id);
      if (e.removed || !d) {
        if (c) this.retire(e.id, c);
        return;
      }
      if (c && c.ip !== d.ip) {
        // Explicitly release the old address before streaming to the new one.
        if (c.streaming) void this.sendActions(c.ip, ['disable'], c);
        c.streaming = false;
        c.ip = d.ip;
      }
      this.requestTick(e.id);
      return;
    }
    if (e.kind === 'light' && e.removed) this.transitions.delete(e.id);
    this.requestTick(e.kind === 'flags' ? e.id : e.deviceId);
  }

  private retire(id: string, c: Controller) {
    if (c.timer) clearTimeout(c.timer);
    if (c.streaming) void this.sendActions(c.ip, ['disable'], c);
    this.ctl.delete(id);
  }

  /** Coalesce change bursts into one tick, no faster than the animation frame rate. */
  private requestTick(deviceId: string) {
    const d = this.store.device(deviceId);
    if (!d || this.stopped) return;
    const c = this.controller(d);
    if (c.timer) clearTimeout(c.timer);
    const delay = Math.max(0, c.lastTick + FRAME_INTERVAL_MS - this.now());
    c.timer = setTimeout(() => void this.tick(deviceId), delay);
  }

  private async tick(deviceId: string) {
    const d = this.store.device(deviceId);
    if (!d || this.stopped) return;
    const c = this.controller(d);
    c.timer = null;
    const now = this.now();
    c.lastTick = now;

    if (c.override && now >= c.override.until) c.override = undefined;
    const lights = this.store.lightsFor(d.id);
    const states: Record<string, RenderState> = {};
    for (const l of lights) {
      states[l.id] = this.renderState(l.id);
      if (this.transitions.has(l.id) && !transitionActive(this.transitions.get(l.id), now)) this.transitions.delete(l.id);
    }
    const visible = lights.some((l) => states[l.id].on || transitionActive(states[l.id].transition, now));
    const flags = this.store.flags(d.id);

    const decision = decide({
      enabled: d.enabled,
      released: flags.released,
      idleBehavior: d.idleBehavior,
      active: visible || !!c.override,
      streaming: c.streaming,
    });

    const actions = [...decision.actions];
    if (decision.streaming && !actions.includes('enable') && now - c.lastAssert > REASSERT_MS) actions.push('brightness_max', 'enable');
    if (actions.includes('enable')) c.lastAssert = now;
    const prevMode = c.mode;
    const prevError = c.error;
    c.streaming = decision.streaming;
    c.mode = decision.mode;

    const full = c.override ? c.override.render(now) : composite(d, lights, states, now);
    let ok = await this.sendActions(d.ip, actions, c);
    if (decision.frame) {
      const out = decision.frame === 'black' ? new Uint8Array(d.ledCount * 3) : full;
      const corrected = applyWhiteBalance(out, d.whiteBalance);
      ok = (await this.send(d.ip, proto.frame(downsample(corrected, d.maxColorsPerPacket)), c, 'frame')) && ok;
    }
    if (ok && decision.actions.length + (decision.frame ? 1 : 0) > 0) c.error = undefined;
    if (c.error) c.mode = 'error';

    this.emit('frame', d.id, decision.frame === 'black' ? new Uint8Array(d.ledCount * 3) : full);
    if (c.mode !== prevMode || c.error !== prevError) this.emit('status', d.id, this.status(d.id));

    if (this.stopped) return;
    const fast = animating(d, lights, states, now) || !!c.override?.animated;
    const next = c.override
      ? Math.min(fast ? FRAME_INTERVAL_MS : d.keepaliveMs, c.override.until - now)
      : decision.streaming
        ? fast ? FRAME_INTERVAL_MS : d.keepaliveMs
        : fast ? FRAME_INTERVAL_MS : null;
    if (next !== null) c.timer = setTimeout(() => void this.tick(deviceId), Math.max(0, next));
  }

  private async sendActions(ip: string, actions: Action[], c: Controller): Promise<boolean> {
    let ok = true;
    for (const a of actions) {
      const payload =
        a === 'turn_on' ? proto.turn(true)
        : a === 'brightness_max' ? proto.brightness(100)
        : a === 'turn_off' ? proto.turn(false)
        : proto.streamEnable(a === 'enable');
      this.log.debug({ ip, action: a }, 'lifecycle action');
      ok = (await this.send(ip, payload, c)) && ok;
    }
    return ok;
  }

  private async send(ip: string, payload: Buffer, c: Controller, coalesceKey?: string): Promise<boolean> {
    try {
      await this.transport.send(ip, payload, coalesceKey);
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (c.error !== msg) this.log.warn({ ip, err: msg }, 'send failed');
      c.error = msg;
      return false;
    }
  }

  /** Clean shutdown: exit streaming explicitly on every device (SPEC §6.5). */
  async stop() {
    this.stopped = true;
    const pending: Promise<unknown>[] = [];
    for (const d of this.store.devices) {
      const c = this.ctl.get(d.id);
      if (!c) continue;
      if (c.timer) clearTimeout(c.timer);
      if (!c.streaming) continue;
      // hold_black can't hold once we're gone, so it exits like `off`.
      const behavior = d.idleBehavior === 'release' ? 'release' : 'off';
      const { actions } = decide({ enabled: true, released: false, idleBehavior: behavior, active: false, streaming: true });
      pending.push(this.sendActions(d.ip, actions, c));
      c.streaming = false;
    }
    await Promise.all(pending);
  }
}
