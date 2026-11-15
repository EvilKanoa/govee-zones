// Control lifecycle: what to send when moving between group control, per-LED
// streaming and off. Pure. Rules R1-R13 in docs/segment-mode-plan.md §3.3.
// Unless released or disabled, govee-zones owns the strip: lights on → it shows
// them; all off → it keeps the strip off (the engine re-sends `turn_off`).

/**
 * `brightness_max` pins the strip's own brightness at 100 %: it scales both razer
 * frames and group output (verified on the H805A). `groups_dark` sets every group
 * off (one segment datagram).
 */
export type Action = 'brightness_max' | 'turn_on' | 'enable' | 'disable' | 'turn_off' | 'groups_dark';

/** What we currently hold the strip in. `off`: owned and kept off. `none`: not driving it (startup, released, disabled). */
export type Held = 'none' | 'off' | 'groups' | 'per_led';

export interface PolicyInput {
  enabled: boolean;
  released: boolean;
  /** Group frames may be sent to this strip at all (group size set, fits the mask, control = auto). */
  groupsAvailable: boolean;
  /** What the lights/overrides need now; `none` = nothing visible and no override. */
  want: 'none' | 'groups' | 'per_led';
  held: Held;
  /** A transition is running on this strip. */
  fading: boolean;
}

export interface Decision {
  /** Sent first, in order. */
  before: Action[];
  /** `groups`: the planned group looks. `composite`: a razer frame. */
  frame: 'groups' | 'composite' | null;
  /** Sent after the frame. */
  after: Action[];
  held: Held;
  mode: 'groups' | 'per_led' | 'idle' | 'released';
  /** Per-LED only because a fade must finish before switching to groups (R5). */
  fadeFinishing: boolean;
}

const d = (p: Partial<Decision> & Pick<Decision, 'held' | 'mode'>): Decision => ({ before: [], frame: null, after: [], fadeFinishing: false, ...p });

export function decide(p: PolicyInput): Decision {
  const leavePerLed: ['disable'] | [] = p.held === 'per_led' ? ['disable'] : [];

  if (!p.enabled) return d({ before: leavePerLed, held: 'none', mode: 'idle' }); // R1
  // R2: groups hold by themselves; the Govee app takes over when it's used.
  if (p.released) return d({ before: leavePerLed, held: 'none', mode: 'released' });

  const fresh = p.held === 'none' || p.held === 'off';
  if (p.want === 'groups') {
    if (fresh) return d({ before: ['brightness_max'], frame: 'groups', after: ['turn_on'], held: 'groups', mode: 'groups' }); // R3
    if (p.held === 'groups') return d({ frame: 'groups', held: 'groups', mode: 'groups' }); // R4
    if (p.fading) return d({ frame: 'composite', held: 'per_led', mode: 'per_led', fadeFinishing: true }); // R5
    return d({ before: ['disable'], frame: 'groups', held: 'groups', mode: 'groups' }); // R6
  }

  if (p.want === 'per_led') {
    if (fresh) return d({ before: ['turn_on', 'brightness_max', 'enable'], frame: 'composite', held: 'per_led', mode: 'per_led' }); // R7
    if (p.held === 'groups') return d({ before: ['enable'], frame: 'composite', held: 'per_led', mode: 'per_led' }); // R8
    return d({ frame: 'composite', held: 'per_led', mode: 'per_led' }); // R9
  }

  // Nothing visible: always turn the strip off, and send nothing after it: segment
  // frames sent to a strip that is off turn it back on (local hardware test).
  if (p.held === 'per_led') {
    // R10: darken the groups over the stream (invisible: the composite is black by now)
    // so `disable` reveals nothing, then turn off once razer is no longer enabled.
    return p.groupsAvailable
      ? d({ before: ['groups_dark', 'disable', 'turn_off'], held: 'off', mode: 'idle' })
      : d({ before: ['disable', 'turn_off'], held: 'off', mode: 'idle' });
  }
  if (p.held === 'groups') return d({ before: ['turn_off'], held: 'off', mode: 'idle' }); // R11
  // R12: take ownership with everything off (startup, un-release, re-enable): turn off.
  if (p.held === 'none') return d({ before: ['turn_off'], held: 'off', mode: 'idle' });
  return d({ held: 'off', mode: 'idle' }); // R13: already off; the engine re-sends turn_off every 30 s
}
