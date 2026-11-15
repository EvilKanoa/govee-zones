// Per-device control loop: store → planner/compositor → lifecycle → transport.
// Each strip is driven with group (segment) commands when it can, and with
// per-LED razer streaming when something needs single LEDs.
// See docs/segment-mode-plan.md §3.
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { miredsToRgb } from '../shared/color.js';
import { groupCount, groupsUnavailable, roundToGroups } from '../shared/groups.js';
import type { ControlReason, Device, DeviceStatus, LightCommand, LightState } from '../shared/types.js';
import { applyCommand, commandTransitionMs } from './commands.js';
import {
  animating,
  applyWhiteBalance,
  composite,
  downsample,
  startTransition,
  transitionActive,
  visualAt,
  type RenderState,
  type Transition,
} from './compositor.js';
import { encodeGroups, groupPixels, packDatagrams, type SentGroup } from './groupOutput.js';
import { decide, type Action, type Decision, type Held } from './lifecycle.js';
import { groupLooks, isVisible, plan, type GroupLook, type PlanResult } from './plan.js';
import * as proto from './protocol.js';
import type { Store, StoreEvent } from './store.js';
import type { Transport } from './transport.js';

const FRAME_INTERVAL_MS = 33; // ~30 fps per-LED while animating
/** Group updates are at least this far apart; the firmware glides each change (< 0.5 s). */
export const GROUP_STEP_MS = 100;
/**
 * Re-send brightness 100 (+ razer enable in per-LED mode, + the full group state
 * in group mode) this often: undoes Govee app changes, recovers from power cycles.
 */
export const REASSERT_MS = 30_000;
const IDENTIFY_BLINK_MS = { groups: 700, per_led: 400 };

/** A temporary source that takes over a device (identify, pixel finder, test chase, white test). */
interface Override {
  name: string;
  until: number;
  animated: boolean;
  /** Needs single LEDs (forces per-LED). Otherwise `renderGroups` drives group mode. */
  needsLeds: boolean;
  render(now: number): Uint8Array;
  renderGroups?(now: number): GroupLook[];
}

interface Controller {
  held: Held;
  mode: DeviceStatus['mode'];
  reason?: ControlReason;
  detail?: string[];
  error?: string;
  ip: string;
  /** ledCount/groupSize/white balance the sent group state was built for. */
  geometry: string;
  timer: NodeJS.Timeout | null;
  lastTick: number;
  lastAssert: number;
  override?: Override;
  /** Group state we believe the strip holds (diffing base). Empty = unknown → full send. */
  sentGroups: (SentGroup | undefined)[];
  /** States of the lights that were on most recently: what gets parked when everything turns off. */
  parkSource: Record<string, LightState>;
}

const geometryOf = (d: Device) => `${d.ledCount}:${d.groupSize}:${d.whiteBalance?.join(',') ?? ''}`;

export class Engine extends EventEmitter<{
  frame: [deviceId: string, pixels: Uint8Array, realWhite?: boolean[]];
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

  /** Apply the policy to every device. Idle devices get nothing, so a restart doesn't kill a Govee scene. */
  start() {
    for (const d of this.store.devices) this.requestTick(d.id);
  }

  status(deviceId: string): DeviceStatus {
    const d = this.store.device(deviceId);
    const c = this.ctl.get(deviceId);
    return {
      mode: c?.mode ?? 'idle',
      reason: c?.reason,
      detail: c?.detail,
      error: c?.error,
      groups: d && !groupsUnavailable(d) ? groupCount(d.ledCount, d.groupSize) : undefined,
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
    const t = startTransition(visualAt(prev, now), next, commandTransitionMs(light, cmd), now);
    if (t) this.transitions.set(lightId, t);
    else this.transitions.delete(lightId);
    this.store.setState(lightId, next);
  }

  setReleased(deviceId: string, released: boolean) {
    this.store.setFlags(deviceId, { released });
  }

  /**
   * Blink a light so it can be found on the house: its rounded groups in group
   * mode (no switch, and it shows the rounding), its exact LEDs otherwise.
   */
  identify(lightId: string, durationMs = 5000) {
    const light = this.store.light(lightId);
    if (!light) throw new Error(`unknown light ${lightId}`);
    const device = this.requireDevice(light.deviceId);
    const start = this.now();
    const byGroups = !groupsUnavailable(device);
    const groups = new Set(byGroups ? roundToGroups(light.ranges, device.ledCount, device.groupSize) : []);
    const blinkOn = (now: number, period: number) => Math.floor((now - start) / period) % 2 === 0;
    this.setOverride(device, {
      name: 'identify',
      until: start + durationMs,
      animated: true,
      needsLeds: !byGroups,
      render: (now) => {
        const out = new Uint8Array(device.ledCount * 3);
        if (blinkOn(now, IDENTIFY_BLINK_MS.per_led)) {
          for (const [a, b] of light.ranges)
            for (let i = Math.max(0, a); i <= Math.min(b, device.ledCount - 1); i++) out.fill(255, i * 3, i * 3 + 3);
        }
        return out;
      },
      renderGroups: (now) => {
        const on = blinkOn(now, IDENTIFY_BLINK_MS.groups);
        return Array.from({ length: groupCount(device.ledCount, device.groupSize) }, (_, g) =>
          on && groups.has(g) ? { kind: 'white', kelvin: 6500, pct: 100 } : { kind: 'off' },
        );
      },
    });
  }

  /** Light one LED white (everything else black). Always per-LED. */
  pixel(deviceId: string, index: number, durationMs = 10_000) {
    const device = this.requireDevice(deviceId);
    if (index < 0 || index >= device.ledCount) throw new RangeError(`LED ${index} out of range`);
    const out = new Uint8Array(device.ledCount * 3);
    out.fill(255, index * 3, index * 3 + 3);
    this.setOverride(device, { name: 'pixel finder', until: this.now() + durationMs, animated: false, needsLeds: true, render: () => out });
  }

  /** Short chase along the whole strip. Always per-LED. */
  test(deviceId: string, durationMs = 6000) {
    const device = this.requireDevice(deviceId);
    const start = this.now();
    const width = Math.max(3, Math.round(device.ledCount / 20));
    this.setOverride(device, {
      name: 'test chase',
      until: start + durationMs,
      animated: true,
      needsLeds: true,
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

  /**
   * Whole strip in one color temperature, for tuning white balance: `mixed` is
   * the per-LED RGB approximation (what the gains correct), `real` is the strip's
   * own white via group control (the reference).
   */
  testWhite(deviceId: string, kelvin = 2700, kind: 'mixed' | 'real' = 'mixed', durationMs = 120_000) {
    const device = this.requireDevice(deviceId);
    if (kind === 'real' && groupsUnavailable(device)) throw new Error('real white needs group control on this strip');
    const rgb = miredsToRgb(1_000_000 / kelvin);
    const out = new Uint8Array(device.ledCount * 3);
    for (let i = 0; i < device.ledCount; i++) out.set(rgb, i * 3);
    const looks: GroupLook[] = Array.from({ length: groupCount(device.ledCount, device.groupSize) }, () => ({ kind: 'white', kelvin, pct: 100 }));
    this.setOverride(device, {
      name: `${kind} white test`,
      until: this.now() + durationMs,
      animated: false,
      needsLeds: kind === 'mixed',
      render: () => out,
      renderGroups: () => looks,
    });
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
      c = { held: 'none', mode: 'idle', ip: d.ip, geometry: geometryOf(d), timer: null, lastTick: 0, lastAssert: 0, sentGroups: [], parkSource: {} };
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
        // Explicitly release the old address before driving the new one. Groups hold by themselves.
        if (c.held === 'per_led') void this.sendActions(c.ip, ['disable'], c);
        c.held = 'none';
        c.ip = d.ip;
        c.sentGroups = [];
      }
      if (c && c.geometry !== geometryOf(d)) {
        c.geometry = geometryOf(d);
        c.sentGroups = [];
      }
      this.requestTick(e.id);
      return;
    }
    if (e.kind === 'light' && e.removed) this.transitions.delete(e.id);
    this.requestTick(e.kind === 'flags' ? e.id : e.deviceId);
  }

  private retire(id: string, c: Controller) {
    if (c.timer) clearTimeout(c.timer);
    if (c.held === 'per_led') void this.sendActions(c.ip, ['disable'], c);
    this.ctl.delete(id);
  }

  /** Coalesce change bursts into one tick, no faster than the current mode's frame rate. */
  private requestTick(deviceId: string) {
    const d = this.store.device(deviceId);
    if (!d || this.stopped) return;
    const c = this.controller(d);
    if (c.timer) clearTimeout(c.timer);
    const interval = c.held === 'groups' ? GROUP_STEP_MS : FRAME_INTERVAL_MS;
    c.timer = setTimeout(() => void this.tick(deviceId), Math.max(0, c.lastTick + interval - this.now()));
  }

  private async tick(deviceId: string) {
    const d = this.store.device(deviceId);
    if (!d || this.stopped) return;
    const c = this.controller(d);
    c.timer = null;
    const now = this.now();
    c.lastTick = now;

    if (c.override && now >= c.override.until) c.override = undefined;
    const ov = c.override;
    const lights = this.store.lightsFor(d.id);
    const states: Record<string, RenderState> = {};
    for (const l of lights) {
      states[l.id] = this.renderState(l.id);
      if (this.transitions.has(l.id) && !transitionActive(this.transitions.get(l.id), now)) this.transitions.delete(l.id);
    }
    const lit = lights.filter((l) => states[l.id].on);
    if (lit.length) c.parkSource = Object.fromEntries(lit.map((l) => [l.id, this.store.state(l.id)]));

    const groupsAvailable = !groupsUnavailable(d);
    let pl: PlanResult | undefined;
    let want: Held = 'none';
    if (ov) want = ov.needsLeds || !groupsAvailable ? 'per_led' : 'groups';
    else if (lights.some((l) => isVisible(states[l.id], now))) {
      pl = plan(d, lights, states, now);
      want = pl.control;
    }
    const fading = animating(d, lights, states, now);
    const flags = this.store.flags(d.id);
    const dec = decide({ enabled: d.enabled, released: flags.released, groupsAvailable, want, held: c.held, fading });

    const wasHeld = c.held;
    const before = [...dec.before];
    const due = now - c.lastAssert > REASSERT_MS;
    if (dec.held === 'per_led' && !before.includes('enable') && due) before.push('brightness_max', 'enable');
    if (dec.held === 'groups' && dec.frame === 'groups' && !before.includes('brightness_max') && due) before.push('brightness_max');
    if (before.includes('brightness_max') || before.includes('enable')) c.lastAssert = now;
    // Full group send on entry (the Govee app may have changed the strip meanwhile) and on every reassert.
    const fullGroups = wasHeld !== 'groups' || due;

    const prev = { mode: c.mode, error: c.error, reason: c.reason, detail: c.detail?.join('\n') };
    c.held = dec.held;
    c.mode = dec.mode;
    [c.reason, c.detail] = this.reasonFor(d, dec, ov, pl);

    let ok = await this.runActions(d, before, c);
    let preview: Uint8Array;
    let realWhite: boolean[] | undefined;
    if (dec.frame === 'composite') {
      preview = ov ? ov.render(now) : composite(d, lights, states, now);
      const corrected = applyWhiteBalance(preview, d.whiteBalance);
      ok = (await this.send(c.ip, proto.frame(downsample(corrected, d.maxColorsPerPacket)), c, 'frame')) && ok;
    } else if (dec.frame === 'park') {
      ok = (await this.sendGroups(d, c, this.parkLooks(d, c, now), false)) && ok;
      preview = new Uint8Array(d.ledCount * 3); // the strip is off
    } else if (dec.frame === 'groups') {
      const looks = ov?.renderGroups ? ov.renderGroups(now) : pl?.control === 'groups' ? pl.groups : groupLooks(d, lights, states, now);
      ok = (await this.sendGroups(d, c, looks, fullGroups)) && ok;
      preview = groupPixels(d, looks);
      realWhite = looks.map((l) => l.kind === 'white');
    } else {
      // Not driving the strip (idle, released, disabled): preview what the lights would show.
      preview = composite(d, lights, states, now);
    }
    ok = (await this.runActions(d, dec.after, c)) && ok;
    if (ok && before.length + dec.after.length + (dec.frame ? 1 : 0) > 0) c.error = undefined;
    if (c.error) c.mode = 'error';

    this.emit('frame', d.id, preview, realWhite);
    if (c.mode !== prev.mode || c.error !== prev.error || c.reason !== prev.reason || c.detail?.join('\n') !== prev.detail)
      this.emit('status', d.id, this.status(d.id));

    if (this.stopped) return;
    const fast = fading || !!ov?.animated;
    let next: number | null =
      c.held === 'per_led' ? (fast ? FRAME_INTERVAL_MS : d.keepaliveMs)
      : c.held === 'groups' ? (fast ? GROUP_STEP_MS : Math.max(GROUP_STEP_MS, REASSERT_MS - (now - c.lastAssert) + 1))
      : fast ? FRAME_INTERVAL_MS : null;
    if (ov) next = Math.min(next ?? Infinity, ov.until - now);
    if (next !== null) c.timer = setTimeout(() => void this.tick(deviceId), Math.max(0, next));
  }

  private reasonFor(d: Device, dec: Decision, ov: Override | undefined, pl: PlanResult | undefined): [ControlReason | undefined, string[] | undefined] {
    if (dec.mode === 'groups') return ['auto', undefined];
    if (dec.mode !== 'per_led') return [undefined, undefined];
    if (dec.fadeFinishing) return ['fade_finishing', undefined];
    const unavailable = groupsUnavailable(d);
    if (unavailable) return [unavailable, undefined];
    if (ov) return ['override', [ov.name]];
    if (pl?.control === 'per_led') return [pl.reason, pl.detail];
    return [undefined, undefined];
  }

  /** The lights that were on most recently, steady (no fades), rounded to groups. */
  private parkLooks(d: Device, c: Controller, now: number): GroupLook[] {
    const lights = this.store.lightsFor(d.id);
    const states: Record<string, RenderState> = {};
    for (const l of lights) {
      const s = c.parkSource[l.id];
      states[l.id] = s ? { ...s, on: true } : { ...this.store.state(l.id), on: false };
    }
    return groupLooks(d, lights, states, now);
  }

  private async sendGroups(d: Device, c: Controller, looks: GroupLook[], full: boolean): Promise<boolean> {
    const { frames, sent } = encodeGroups(looks, full ? [] : c.sentGroups, d.whiteBalance);
    c.sentGroups = sent;
    let ok = true;
    for (const datagram of packDatagrams(frames)) ok = (await this.send(c.ip, datagram, c)) && ok;
    if (!ok) c.sentGroups = []; // unknown: send everything next time
    return ok;
  }

  private async runActions(d: Device, actions: Action[], c: Controller): Promise<boolean> {
    let ok = true;
    for (const a of actions) {
      if (a === 'groups_dark') {
        const dark: GroupLook[] = Array.from({ length: groupCount(d.ledCount, d.groupSize) }, () => ({ kind: 'off' }));
        ok = (await this.sendGroups(d, c, dark, true)) && ok;
      } else ok = (await this.sendActions(c.ip, [a], c)) && ok;
    }
    return ok;
  }

  private async sendActions(ip: string, actions: Exclude<Action, 'groups_dark'>[], c: Controller): Promise<boolean> {
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

  /**
   * Clean shutdown. Group mode sends nothing: the strip keeps its lights. Per-LED
   * exits like "all off" (darken groups, disable, turn off, park), so the strip
   * isn't left in razer mode.
   */
  async stop() {
    this.stopped = true;
    const pending: Promise<unknown>[] = [];
    for (const d of this.store.devices) {
      const c = this.ctl.get(d.id);
      if (!c) continue;
      if (c.timer) clearTimeout(c.timer);
      if (c.held !== 'per_led') continue;
      const dec = decide({ enabled: true, released: false, groupsAvailable: !groupsUnavailable(d), want: 'none', held: 'per_led', fading: false });
      pending.push(
        (async () => {
          await this.runActions(d, dec.before, c);
          if (dec.frame === 'park') await this.sendGroups(d, c, this.parkLooks(d, c, this.now()), false);
        })(),
      );
      c.held = 'none';
    }
    await Promise.all(pending);
  }
}
