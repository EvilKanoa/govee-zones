// Streaming lifecycle state machine. See SPEC.md §6.
import type { DeviceMode, IdleBehavior } from '../shared/types.js';

/**
 * `brightness_max` sets the strip's own brightness to 100%: verified on the H805A
 * that it scales razer frames, so our 0-255 brightness only reaches full output at 100.
 */
export type Action = 'turn_on' | 'brightness_max' | 'enable' | 'disable' | 'turn_off';

export interface PolicyInput {
  enabled: boolean;
  released: boolean;
  idleBehavior: IdleBehavior;
  /** Something wants pixels on the strip: a light is on/fading, or an identify/test override is running. */
  active: boolean;
  /** Whether we currently hold the strip in razer mode. */
  streaming: boolean;
}

export interface Decision {
  /** Commands to send, in order, before any frame. */
  actions: Action[];
  streaming: boolean;
  /** Frame to send this tick, if any. */
  frame: 'composite' | 'black' | null;
  mode: Exclude<DeviceMode, 'error'>;
}

/**
 * Decide what to send for one device. Never silently stops streaming: every
 * path out of streaming emits an explicit `disable` (SPEC §6.4).
 */
export function decide(p: PolicyInput): Decision {
  const exit = (afterDisable: Action[], mode: Decision['mode']): Decision => ({
    actions: p.streaming ? ['disable', ...afterDisable] : [],
    streaming: false,
    frame: null,
    mode,
  });
  const stream = (frame: 'composite' | 'black'): Decision => ({
    actions: p.streaming ? [] : ['turn_on', 'brightness_max', 'enable'],
    streaming: true,
    frame,
    mode: 'streaming',
  });

  if (!p.enabled) return exit([], 'idle');
  if (p.released) return exit([], 'released');
  if (p.active) return stream('composite');
  switch (p.idleBehavior) {
    case 'hold_black':
      return stream('black');
    case 'release':
      return exit([], 'idle');
    case 'off':
      return exit(['turn_off'], 'idle');
  }
}
