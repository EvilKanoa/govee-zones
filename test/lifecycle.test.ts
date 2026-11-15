import { describe, expect, it } from 'vitest';
import { decide, type Decision, type Held, type PolicyInput } from '../src/server/lifecycle.js';

const base: PolicyInput = { enabled: true, released: false, groupsAvailable: true, want: 'none', held: 'none', fading: false };
const out = (p: Partial<PolicyInput>) => {
  const r = decide({ ...base, ...p });
  return [r.before, r.frame, r.after, r.held, r.mode];
};

describe('lifecycle.decide (plan §3.3, testing plan §2.4)', () => {
  it.each<[string, Partial<PolicyInput>, unknown[]]>([
    ['1 disabled, held per_led', { enabled: false, want: 'groups', held: 'per_led' }, [['disable'], null, [], 'none', 'idle']],
    ['2 disabled, held groups', { enabled: false, want: 'groups', held: 'groups' }, [[], null, [], 'none', 'idle']],
    ['3 released, held per_led', { released: true, want: 'per_led', held: 'per_led' }, [['disable'], null, [], 'none', 'released']],
    ['4 released, held groups', { released: true, want: 'groups', held: 'groups' }, [[], null, [], 'none', 'released']],
    ['5 R3 enter groups: frames before turn_on', { want: 'groups' }, [['brightness_max'], 'groups', ['turn_on'], 'groups', 'groups']],
    ['6 R4 stay in groups', { want: 'groups', held: 'groups' }, [[], 'groups', [], 'groups', 'groups']],
    ['7 R5 finish a fade per-LED', { want: 'groups', held: 'per_led', fading: true }, [[], 'composite', [], 'per_led', 'per_led']],
    ['8 R6 per-LED → groups', { want: 'groups', held: 'per_led' }, [['disable'], 'groups', [], 'groups', 'groups']],
    ['9 R7 enter per-LED', { want: 'per_led' }, [['turn_on', 'brightness_max', 'enable'], 'composite', [], 'per_led', 'per_led']],
    ['10 R8 groups → per-LED', { want: 'per_led', held: 'groups' }, [['enable'], 'composite', [], 'per_led', 'per_led']],
    ['10b R8 while fading too', { want: 'per_led', held: 'groups', fading: true }, [['enable'], 'composite', [], 'per_led', 'per_led']],
    ['11 R9 stay per-LED', { want: 'per_led', held: 'per_led' }, [[], 'composite', [], 'per_led', 'per_led']],
    ['12 R10 off from per-LED', { held: 'per_led' }, [['groups_dark', 'disable', 'turn_off'], null, [], 'off', 'idle']],
    ['13 R11 off from groups', { held: 'groups' }, [['turn_off'], null, [], 'off', 'idle']],
    ['14 R12 take ownership with all off (startup, un-release)', {}, [['turn_off'], null, [], 'off', 'idle']],
    ['15 R10 without group control', { held: 'per_led', groupsAvailable: false }, [['disable', 'turn_off'], null, [], 'off', 'idle']],
    ['16 R13 stay off (the engine re-sends turn_off every 30 s)', { held: 'off' }, [[], null, [], 'off', 'idle']],
    ['17 off → groups is a fresh entry (R3)', { want: 'groups', held: 'off' }, [['brightness_max'], 'groups', ['turn_on'], 'groups', 'groups']],
    ['18 off → per-LED is a fresh entry (R7)', { want: 'per_led', held: 'off' }, [['turn_on', 'brightness_max', 'enable'], 'composite', [], 'per_led', 'per_led']],
    ['19 released while off: nothing', { released: true, held: 'off' }, [[], null, [], 'none', 'released']],
    ['20 disabled while off: nothing', { enabled: false, held: 'off' }, [[], null, [], 'none', 'idle']],
  ])('%s', (_name, input, expected) => {
    expect(out(input)).toEqual(expected);
  });

  it('flags R5 as fade_finishing', () => {
    expect(decide({ ...base, want: 'groups', held: 'per_led', fading: true }).fadeFinishing).toBe(true);
    expect(decide({ ...base, want: 'groups', held: 'per_led' }).fadeFinishing).toBe(false);
  });

  it('invariants I1-I7 over the full cross-product (192 cases)', () => {
    const helds: Held[] = ['none', 'off', 'groups', 'per_led'];
    const wants = ['none', 'groups', 'per_led'] as const;
    let n = 0;
    for (const enabled of [true, false])
      for (const released of [true, false])
        for (const groupsAvailable of [true, false])
          for (const want of wants)
            for (const held of helds)
              for (const fading of [true, false]) {
                n++;
                const p = { enabled, released, groupsAvailable, want, held, fading };
                const d: Decision = decide(p);
                const all = [...d.before, ...d.after];
                // I1: leaving per-LED starts with disable (groups_dark may come first, R10).
                if (held === 'per_led' && d.held !== 'per_led') expect(d.before.filter((a) => a !== 'groups_dark')[0]).toBe('disable');
                // I2: no group frames while per-LED stays held; groups_dark only right before disable.
                if (d.held === 'per_led') expect(d.frame === 'groups' || all.includes('groups_dark')).toBe(false);
                if (all.includes('groups_dark')) expect(d.before[d.before.indexOf('groups_dark') + 1]).toBe('disable');
                // I2b: turn_off never while razer is enabled.
                if (d.before.includes('turn_off')) {
                  const i = d.before.indexOf('turn_off');
                  const razerOn = held === 'per_led' && !d.before.slice(0, i).includes('disable');
                  expect(razerOn).toBe(false);
                }
                // I3: razer frames only when per-LED is held.
                if (d.frame === 'composite') expect(d.held).toBe('per_led');
                // Nothing after turn_off: segment frames sent to a strip that is off turn it back on.
                if (all.includes('turn_off')) expect([d.before.at(-1), d.frame, d.after.length]).toEqual(['turn_off', null, 0]);
                // I4: entering groups from none/off sends frames before turn_on.
                if ((held === 'none' || held === 'off') && d.held === 'groups') expect(d.after).toContain('turn_on');
                // I5: a fade never causes a per-LED → groups switch.
                if (held === 'per_led' && want === 'groups' && fading && enabled && !released) expect(d.held).toBe('per_led');
                // I6: owned with nothing on → the strip is (kept) off; released/disabled → nothing at all.
                if (want === 'none' && enabled && !released) expect(d.held).toBe('off');
                if (held === 'off' && (released || !enabled)) expect([all.length, d.frame, d.held]).toEqual([0, null, 'none']);
              }
    expect(n).toBe(192);
  });
});
