// Control lifecycle: what to send when moving between group control, per-LED
// streaming and off. Pure. Rules R1-R12 in docs/segment-mode-plan.md §3.3.

/**
 * `brightness_max` pins the strip's own brightness at 100 %: it scales both razer
 * frames and group output (verified on the H805A). `groups_dark` sets every group
 * off (one segment datagram).
 */
export type Action = 'brightness_max' | 'turn_on' | 'enable' | 'disable' | 'turn_off' | 'groups_dark';

/** What we currently hold the strip in. */
export type Held = 'none' | 'groups' | 'per_led';

export interface PolicyInput {
  enabled: boolean;
  released: boolean;
  /** Group frames may be sent to this strip at all (group size set, fits the mask, control = auto). */
  groupsAvailable: boolean;
  /** What the lights/overrides need now; `none` = nothing visible and no override. */
  want: Held;
  held: Held;
  /** A transition is running on this strip. */
  fading: boolean;
}

export interface Decision {
  /** Sent first, in order. */
  before: Action[];
  /** `groups`: the planned group looks. `composite`: a razer frame. `park`: the parked group looks (strip is off). */
  frame: 'groups' | 'composite' | 'park' | null;
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

  if (p.want === 'groups') {
    if (p.held === 'none') return d({ before: ['brightness_max'], frame: 'groups', after: ['turn_on'], held: 'groups', mode: 'groups' }); // R3
    if (p.held === 'groups') return d({ frame: 'groups', held: 'groups', mode: 'groups' }); // R4
    if (p.fading) return d({ frame: 'composite', held: 'per_led', mode: 'per_led', fadeFinishing: true }); // R5
    return d({ before: ['disable'], frame: 'groups', held: 'groups', mode: 'groups' }); // R6
  }

  if (p.want === 'per_led') {
    if (p.held === 'none') return d({ before: ['turn_on', 'brightness_max', 'enable'], frame: 'composite', held: 'per_led', mode: 'per_led' }); // R7
    if (p.held === 'groups') return d({ before: ['enable'], frame: 'composite', held: 'per_led', mode: 'per_led' }); // R8
    return d({ frame: 'composite', held: 'per_led', mode: 'per_led' }); // R9
  }

  // Nothing visible: always turn the strip off, then park the last look while it's off.
  if (p.held === 'per_led') {
    // R10: `turn_off` doesn't stick while razer is enabled, so darken the groups over
    // the stream (invisible: the composite is black by now), disable, then turn off.
    return p.groupsAvailable
      ? d({ before: ['groups_dark', 'disable', 'turn_off'], frame: 'park', held: 'none', mode: 'idle' })
      : d({ before: ['disable', 'turn_off'], held: 'none', mode: 'idle' });
  }
  if (p.held === 'groups') return d({ before: ['turn_off'], frame: 'park', held: 'none', mode: 'idle' }); // R11
  return d({ held: 'none', mode: 'idle' }); // R12: startup sends nothing
}
