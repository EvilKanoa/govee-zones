# Segment mode: implementation plan

Status: **built** (backend, MQTT and UI; hardware acceptance §3 of the testing plan still to run). Two rounds of hardware probing on the real strip settled the
protocol and behaviour. The evidence is in [`segment-mode-results.md`](segment-mode-results.md),
and the tests that lock it in are in [`segment-mode-testing.md`](segment-mode-testing.md).

Scope: **this house's strip first.** An H805A, 60 LEDs, controllable in 15 groups of 4. Other
strips work as long as they fit the tested mask (≤ 24 groups); anything bigger falls back to
per-LED control with a clear reason. This is v0, so there's no compatibility layer: `rgb_ct` and
`dimmable` are removed, the idle behaviour setting is removed, and the status modes are renamed
outright.

**Dev vs deployed config:** the `./data` config used by `pnpm dev` on the laptop is a throwaway dev
setup (its devices and lights are test data). The real setup lives in the container's `DATA_DIR`
on Unraid. Any hand conversion of removed fields applies to that deployed config.

---

## 0. Summary

The strip accepts two local LAN commands on UDP 4003:

| | **Groups** (`ptReal` segment frames) | **Per-LED** (`razer` streaming) |
|---|---|---|
| Resolution | Groups of 4 LEDs | Single LEDs |
| White | Real white, matches the Govee app (2700–6500 K) | Mixed from RGB: about as bright, wrong tint |
| Holding state | The strip holds it, even across `turn off`/`on` | Holds the last frame ≥ 120 s with nothing sent (F16), but the strip stays in razer mode; we keep a keepalive |
| If govee-zones stops | Lights stay as they are | Frozen on the last frame, still in razer mode (a clean stop exits and parks, §3.5a) |
| Changes | The firmware glides every change (< 0.5 s) | Instant |

Group control becomes the normal way to drive a strip, and per-LED becomes the precise fallback.
The service picks one per strip on every tick, using a pure planner. Users get three settings,
and the UI always shows the groups, which control method is active, and why.

Naming: the UI and docs say **groups** (of 4 LEDs) and never "segments", which would be confused
with the Govee app's segments. Code uses `group` too. "Segment" only appears for the protocol
frames (`segmentColorFrame`, …) and in this plan's file name.

---

## 1. Verified facts this plan relies on

All from the two probe rounds; the rows link back to the results doc.

| ID | Fact | Used in |
|---|---|---|
| F1 | `ptReal` over UDP 4003. Color frame `33 05 15 01 RR GG BB KH KL TR TG TB <mask>`, brightness frame `33 05 15 02 <1-100> <mask>`; 20-byte BLE frames with XOR checksum | §3.4 |
| F2 | 3-byte mask, LSB first: bit *i* = group *i* from the start of the strip | §3.1 |
| F3 | A group is **4 LEDs**; the 60-LED strip has 15 | §2.2, §3.1 |
| F4 | Up to 6 frames per datagram apply in order (6 tested) | §3.4 |
| F5 | Kelvin ≠ 0 shows real white matching the app; RGB and tint are then ignored. Range 2700–6500 K | §2.1, §3.4, §3.7 |
| F6 | Per-group RGB and brightness 1–100 %; a group switches between white and RGB cleanly | §3.2 |
| F7 | **Off = RGB 0 + kelvin 0.** Brightness 0 is clamped to 1 % (not off) | §3.4 |
| F8 | Every change glides < 0.5 s; stepping at 10–20 updates/s looks smooth | §3.4 |
| F9 | State holds with nothing sent (≥ 3 min); re-sending the same state is invisible | §3.3, §3.4 |
| F10 | Frames sent while the strip is off are shown at `turn on`, with no flash | §3.3 |
| F11 | A group command ends a running Govee app scene | §3.5 |
| F12 | LAN `brightness` scales group output too | §3.4 |
| F13 | Per-LED → groups is clean in any order. Groups → per-LED is an instant hard cut (accepted, no mitigation) | §3.3 |
| F14 | Group frames take effect **even while razer is enabled** | §3.3 invariant I2, §3.5a |
| F15 | `turn off` sent while razer is enabled **doesn't stick**: after `disable` the strip is on, showing its stored groups | §3.5a |
| F16 | Razer with frames stopped (no `disable`) **holds the last frame ≥ 120 s**: no revert seen. `disable` then shows the stored groups | §3.4, §3.5a |

Not verified, handled conservatively:

| ID | Unknown | Handling |
|---|---|---|
| U1 | Strips with > 24 groups (wider masks), or group sizes other than 4 | Group control unavailable → per-LED, reason `too_many_groups`. `groupSize` is editable but defaults to 4 |
| U2 | Power cycle mid-state (A18) | Full state is re-sent every 30 s anyway; acceptance checklist H11 |
| U3 | More than 6 frames per datagram | Pack ≤ 6 |

---

## 2. Data model

### 2.1 Capabilities

`Capability = 'onoff' | 'rgb' | 'ct'`. `rgb_ct` and `dimmable` are removed: `rgb` and `ct` both
include brightness, so a dimmable fixed look is a `ct` light (white) or an `rgb` light (color).
Lights using a removed capability are changed by hand in the deployed config (no migration code);
the schema rejects them.

| Capability | HA `supported_color_modes` | Commands accepted | Turns on to |
|---|---|---|---|
| `onoff` | `onoff` | `state` | its fixed default look: a color **or** a white, at a fixed brightness |
| `rgb` | `rgb` | `state`, `brightness`, `color` | its default color and brightness |
| `ct` | `color_temp` | `state`, `brightness`, `color_temp` | its default white and brightness |

```ts
type Look = { kind: 'rgb'; color: RGB } | { kind: 'white'; mireds: number };
interface LightDefaults { brightness: number /* 1-255 */; look: Look }
interface LightState { on: boolean; brightness: number; look: Look }
```

White is limited to **2700–6500 K (154–370 mireds)** (F5): schemas reject other defaults, and
commands are clamped. `lookRgb(look)` gives the RGB form (`miredsToRgb` for white), used by
per-LED rendering and the preview.

### 2.2 Device fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `groupSize` | int 0–16 | 4 | LEDs per mask bit. 0 = group control off. |
| `control` | `'auto' \| 'per_led'` | `'auto'` | UI **Control method**: Automatic / Per-LED only. |
| `partialGroups` | `'round' \| 'exact'` | `'round'` | UI **Lights that don't line up with groups**: Round to whole groups / Use exact LEDs. |

`idleBehavior` (`off` / `hold_black` / `release`) is **removed**. When every light is off, the strip
is always turned off (§3.3). `hold_black` only existed to stop per-LED mode reverting to the
Govee scene, and groups hold by themselves. `release`-when-idle can't hand back to a scene in
group mode. The manual **Release to Govee** switch stays, and is how app scenes are reached.

Group count = ⌈ledCount / groupSize⌉. Group control is **available** when `groupSize > 0`,
group count ≤ 24 (U1), and `control = 'auto'`.

Patch schemas come from the default-free base shapes, as before (`test/schemas.test.ts`).

### 2.3 Status

```ts
type DeviceMode = 'groups' | 'per_led' | 'idle' | 'released' | 'error';
type ControlReason =
  | 'auto'             // groups: normal
  | 'groups_off'       // per_led: groupSize = 0
  | 'too_many_groups'  // per_led: more groups than the tested 24-bit mask
  | 'per_led_setting'  // per_led: control = per_led
  | 'override'         // per_led: pixel finder, test chase, white comparison
  | 'exact_leds'       // per_led: a visible light partly covers a group and partialGroups = exact
  | 'fade_finishing';  // per_led: wants groups, finishing a fade first
interface DeviceStatus {
  mode: DeviceMode;
  reason?: ControlReason;
  /** exact_leds: names of the lights forcing per-LED. override: which one. */
  detail?: string[];
  error?: string;
  /** Group count when group control is available. */
  groups?: number;
}
```

`streaming` and `sentColors` are dropped from the status.

---

## 3. Backend behaviour

### 3.1 Group geometry (`src/shared/groups.ts`, pure, used by server and web)

- `groupBounds(ledCount, groupSize)`: group *i* = LEDs `[i·size, min((i+1)·size, ledCount) − 1]`.
  The last group can be short. On the house strip: 15 × 4, none short.
- `groupBoundaries(ledCount, groupSize)`: the LED indices where a new group starts (4, 8, …, 56).
  The **only** source for the dividers drawn in both views (§4.3).
- `coverage(ranges, ledCount, groupSize)`: per group, how many of its LEDs a light covers.
- `roundToGroups(ranges, …)`: a group belongs to the light when it covers ≥ 50 % of the group's
  LEDs (2 of 4 counts). If that leaves no group but the light covers at least one LED, it gets the
  group it covers most (ties → lowest index). Rounding never makes a light disappear. It moves
  an edge by at most 2 LEDs, except for tiny lights (under half a group on each side of a
  boundary, e.g. LEDs 3–4), which snap onto one group.
- `isAligned(ranges, …)`: every group is covered 0 % or 100 %.

### 3.2 Planner (`src/server/plan.ts`, pure)

```ts
plan(device, lights, states, override, now) →
  | { control: 'groups'; groups: GroupLook[] }      // one per group
  | { control: 'per_led'; reason; detail? }
GroupLook = { kind: 'off' } | { kind: 'rgb'; rgb; pct } | { kind: 'white'; kelvin; pct }
```

Decision, in order:

1. `groupSize = 0` → `per_led` / `groups_off`.
2. More than 24 groups → `per_led` / `too_many_groups`.
3. `control = per_led` → `per_led` / `per_led_setting`.
4. An override that needs single LEDs is running (pixel finder, test chase, white comparison)
   → `per_led` / `override`.
5. `partialGroups = exact` and any visible light isn't aligned → `per_led` / `exact_leds`
   (detail = those lights' names).
6. Otherwise `groups`:
   - Every group starts `off`.
   - Visible lights paint in paint order (priority, then creation order) over their **rounded**
     groups.
   - A light's look at `now` comes from its state or its running fade. `pct = max(1, round(brightness / 255 × 100))`,
     scaled by the fade opacity (per-light opacity fades, as today).
   - Layering with opacity *a* over the look beneath: `pct = a·top + (1−a)·below`. Kind, color and
     kelvin come from the top look if `a ≥ 0.5`, otherwise from the one beneath. Within one light,
     RGB fades interpolate in RGB and white fades in mireds. RGB ↔ white swaps at the midpoint
     (the firmware glide softens it).
   - A result of `pct` < 0.5 becomes `off`; anything else lit is clamped to 1–100.

The planner ignores the current mode. Fade-related deferral lives in `decide()`.

### 3.3 Lifecycle (`decide()`, pure)

Inputs: `enabled`, `released`, `groupsAvailable`, `want`
(`'none' | 'groups' | 'per_led'`; none = nothing visible and no override), `held`
(`'none' | 'groups' | 'per_led'`), `fading` (a transition is running on this strip).

Output: `before` (actions), `frame` (`'groups' | 'composite' | 'park' | null`),
`after` (actions), `held`, `mode`, `reason`. Actions: `brightness_max`, `turn_on`, `enable`,
`disable`, `turn_off`, `groups_dark` (one datagram setting every group off).

| # | Condition | before | frame | after | → held / mode |
|---|---|---|---|---|---|
| R1 | `!enabled` | held per_led: `disable` | – | – | none / idle |
| R2 | `released` | held per_led: `disable`. Held groups: nothing, the lights stay (F11: the app takes over when used) | – | – | none / released |
| R3 | want groups, held none | `brightness_max` | groups | `turn_on` (F10: frames first, then power on, so no flash) | groups / groups |
| R4 | want groups, held groups | – | groups | – | groups / groups |
| R5 | want groups, held per_led, **fading** | – | composite | – | per_led / per_led (`fade_finishing`) |
| R6 | want groups, held per_led, not fading | `disable` | groups | – | groups / groups (F13: clean) |
| R7 | want per_led, held none | `turn_on`, `brightness_max`, `enable` | composite | – | per_led / per_led |
| R8 | want per_led, held groups | `enable` | composite | – | per_led / per_led (hard cut, accepted) |
| R9 | want per_led, held per_led | – | composite | – | per_led / per_led |
| R10 | want none, held per_led | groups available: `groups_dark` (all groups off; applies over the stream, F14, invisible because the composite is black by now), `disable`, `turn_off`. Otherwise: `disable`, `turn_off` | groups available: park (while off, F10) | – | none / idle |
| R11 | want none, held groups | `turn_off` | park (while off; skipped if the stored state already matches) | – | none / idle |
| R12 | want none, held none | – | – | – | none / idle (startup sends nothing, so a restart doesn't kill a Govee scene) |

**Invariants** (asserted over the full input cross-product):

- I1: Leaving `per_led` always starts with `disable`.
- I2: No group frame is sent while held is `per_led` (F14: it would override the stream), except
  `groups_dark` immediately before `disable` on the way to off (R10). R5 sends the composite instead.
- I2b: `turn_off` is never sent while razer is enabled (F15: it doesn't stick).
- I3: Razer frames only when the resulting held is `per_led`.
- I4: Entering groups from none sends frames before `turn_on`.
- I5: A fade never causes a per-LED → groups switch (R5).
- I6: Nothing held + nothing wanted → no output at all.

### 3.4 Engine (`engine.ts`)

- A tick runs the planner, then `decide()`, then sends `before`, frames and `after`, in order, on
  the per-IP paced queue.
- **Group output.** Group the groups by color look and send one color frame per distinct look:
  - white: RGB 0, kelvin, tint 0 (F5: RGB and tint are ignored);
  - rgb: RGB with the device's white-balance gains (same LEDs as per-LED, so the colors match), kelvin 0;
  - off: all 0 (F7).
  Then one brightness frame per distinct `pct` among lit groups (never 0; F7).
  Frames are packed ≤ 6 per datagram (F4).
- **Diffing.** Send only groups whose look changed since the last send. The **full state** is
  re-sent every 30 s along with `brightness_max` (F9: invisible; covers power cycles and app
  changes, U2).
- **Pacing.** Group ticks are at least `GROUP_STEP_MS = 100` apart, including fade steps
  (F8: smooth with the firmware glide). Per-LED stays at 33 ms. A transition of 0 still glides
  < 0.5 s in group mode; that's documented, not worked around.
- **Queueing.** Group datagrams aren't coalesced (one update is up to ~3 datagrams ≈ 45 ms of
  pacing, which fits in a 100 ms step). Razer frames keep the `frame` coalesce key. The per-IP
  queue is FIFO and group frames are never generated while per-LED is held, so anything queued
  before an `enable` goes out before it (I2). No queue dropping is needed.
- **Per-LED keepalive.** Kept at `keepaliveMs` (2 s) even though no revert was seen within
  120 s (F16): it's cheap, and the revert time is unknown.
- **Brightness pin.** `brightness_max` on entry and every 30 s, in both modes (F12). `enable` is
  re-sent with it in per-LED mode only.
- **Preview.** The `frame` message shows **what the strip shows**: in group mode, the rounded
  group looks expanded to LEDs (white via `miredsToRgb`), plus `mode` and a per-group
  `realWhite: boolean[]`, so the UI can mark real-white groups.
- **Shutdown.** Held per_led: the R10 sequence (dark, `disable`, `turn_off`, park). Per-LED
  would freeze on its last frame (F16), but a dead service shouldn't leave the strip in razer
  mode. Held groups: **send
  nothing**; the lights stay (F9). On the next start R3 re-sends the state; frames come before
  `turn_on`, so nothing blinks.
- **IP change.** Held per_led: `disable` to the old IP. Held groups: nothing to the old IP. Then
  held = none and the next tick enters at the new IP.

### 3.5 Release to Govee

- Held per_led: `disable`, and the strip goes back to its app scene (as today).
- Held groups: nothing is sent. The lights stay until something is picked in the Govee app.
- Light commands keep being stored. Un-release → R3; our state takes over from any app scene (F11).

### 3.5a Parking

Verified by probe round 3 (results doc). The strip's stored group state is what shows when
**something else** turns it on (the Govee app, govee2mqtt; round 3 test 1) and what `disable`
reveals (F16). Parking keeps that state deliberate: the lights' **last steady look**, rounded to
groups with real white.

- **Park look** = `plan()` over the lights' last on-states, captured when the last visible light
  turns off (not a fade's black end), with rounding forced (ignores `exact` and overrides).
- **Turning off from groups** (R11): `turn_off`, then the park frames while off (F10: stored
  silently). Skipped when the stored state already matches.
- **Turning off from per-LED** (R10), when group control is available:
  1. `groups_dark`: every group off. Group frames apply over the stream (F14); by now the
     composite is black (end of a fade-out) or about to be (instant off, which then glides
     dark), so it's invisible or intended.
  2. `disable`. The stored groups are dark, so nothing is revealed.
  3. `turn_off`. Razer is no longer enabled, so it sticks (F15).
  4. Park frames while off (F10).

  Round 3 test 1 sent `turn_off` while razer was still on: it didn't stick, and the park look
  showed. That's why `turn_off` now comes after `disable`, with the groups darkened first so
  the `disable` reveals nothing.
- When group control isn't available (`groups_off`, `too_many_groups`, `per_led_setting`): no
  group frames at all. `disable`, `turn_off`, and the old stored state may show for a moment.
- **No parking on per-LED entry.** It was meant as crash recovery for a reverting stream, but
  per-LED holds its last frame for ≥ 120 s with no revert (F16). A crash freezes the last
  frame, which is better than any approximation, and on restart R7 takes over again. Entry
  parking would also flash the approximation between `turn_on` and `enable`.

### 3.6 Overrides

| Override | Group control available | Otherwise |
|---|---|---|
| Identify | Blink the light's **rounded groups** (700 ms on / 700 ms off, slow enough for the glide) in group mode: no switch, and it shows the rounding | Per-LED blink, as today |
| Pixel finder | Per-LED (switch, then back) | Per-LED |
| Test chase | Per-LED | Per-LED |
| White balance tuning | A/B toggle: the whole strip in real white ↔ RGB-mixed white at the same kelvin, for tuning the per-LED gains against real white | Per-LED mixed white only |

### 3.7 MQTT

- Discovery: `ct` → `supported_color_modes: ['color_temp']`, `brightness: true`,
  `color_temp_kelvin: true`, `min_kelvin: 2700`, `max_kelvin: 6500`. `rgb_ct` removed.
- State: `ct` → `color_mode: 'color_temp'`, `color_temp` in kelvin.
- Mode sensor: `options: ['groups', 'per_led', 'idle', 'released', 'error']`. Status payload
  `{ mode, reason, detail, error, groups }`; `reason`/`detail` show as attributes.

### 3.8 Simulate mode

`simulatedTransport` decodes `ptReal`, e.g. `[sim] groups 1-4 white 2700K 80% · 5-15 off`.

### 3.9 CLI

`pnpm cli probe` (rounds 1 and 2) and `pnpm cli seg …` stay as hardware tools.

---

## 4. UI

Every setting explains its tradeoff in place, every automatic decision shows its reason, and the
groups are always visible.

### 4.1 Device form: "Groups" section

- **LEDs per group** (number, default 4). Help: *"How many LEDs the strip controls together.
  4 on the H805A. 0 turns group control off."* Shows the result: *"15 groups"*, or the warning
  *"31 groups: more than the 24 that have been tested. This strip uses per-LED control."*
- **Control method** (radio):
  - **Automatic** (recommended). *"Uses group control whenever it can: real white that matches
    the Govee app, and the strip keeps its lights even if govee-zones stops. Switches to per-LED
    control only for single-LED tools like the pixel finder."*
  - **Per-LED only.** *"Always controls single LEDs. Changes are instant, but white is mixed from
    RGB (slightly off-color), and if govee-zones stops, the strip freezes on its last frame
    in streaming mode."*
- **Lights that don't line up with groups** (radio, Automatic only):
  - **Round to whole groups** (default). *"Keeps real white and group control. A light's edges
    move to the nearest group boundary (at most 2 LEDs)."*
  - **Use exact LEDs.** *"Keeps exact LED ranges by switching the whole strip to per-LED control
    while such a light is on. Other lights lose real white during that time."*
- The "When all lights are off" setting is gone. The device card says instead: *"The strip turns
  off when every light is off. Use Release to Govee for app scenes."*
- A one-line note under the section: *"Group control changes glide over about half a second;
  that's the strip's firmware."*

### 4.2 Mode badge (strip page, device card)

| Mode / reason | Badge | Tooltip / popover |
|---|---|---|
| groups | **Groups** | "Real white. The strip holds its lights on its own." |
| per_led / groups_off | **Per-LED** | "Group control is off for this strip (LEDs per group = 0)." + link to the setting |
| per_led / too_many_groups | **Per-LED** | "This strip has more groups than have been tested (24)." |
| per_led / per_led_setting | **Per-LED** | "Control method is set to Per-LED only." |
| per_led / override | **Per-LED** | "Pixel finder running." / "Test running." Returns to Groups when done |
| per_led / exact_leds | **Per-LED** | "Gutter uses exact LEDs and is on. White is mixed from RGB until it turns off." |
| per_led / fade_finishing | **Per-LED** | "Finishing a fade; switches to Groups after." |
| idle / released / error | as today | Released with groups: "Lights stay as they are until you change them in the Govee app." |

The popover also has a short "Groups vs Per-LED" explainer (the §0 table in two lines).

### 4.3 Strip view and house view

- **Group dividers are required and always visible in both views** whenever group control is
  available. A group is the smallest unit group control can drive (4 LEDs here).
  - **Strip view:** a divider line between groups, clearly heavier than the gaps between single
    LEDs; the cells of one group read as one block (alternating subtle background bands).
  - **House view:** a short tick across the traced outline at every group boundary, at that
    LED's position on the path, so dividers follow corners and bends. They scale with zoom,
    have a contrasting halo over the background photo, and are drawn above the photo and below
    the LED dots.
  - Both views use `groupBoundaries()` (§3.1), so they can't disagree.
  - In per-LED mode the dividers stay, dimmed, so it's always clear where lights will round to.
- **Rounding is drawn on the LEDs** whenever it applies (group control usable, Round to whole
  groups). Rounding moves the boundaries between lights, so each LED it changes is marked with
  an amber outline (strip) or a dark disc with an amber rim (house), plus an arrow in the color of
  the light that gains the LED, pointing the way that light's edge moves (along the outline in the
  house view). ✕ in the losing light's color marks an LED that rounding leaves dark. An "As set /
  Rounded" toggle switches the light colors between the ranges as drawn and what group control
  lights (one light per group: the highest in paint order). Tooltips say "as set: X → rounded: Y",
  and light rows say "LEDs 9–14 → 8–15".
- **Selection snaps to whole groups** by default; a "Fine (single LEDs)" toggle in the toolbar
  turns snapping off.
- In group mode the preview shows the rounded result. Real-white groups get a subtle marker (a
  thin outline or "W" dot), so real and mixed white can be told apart.

### 4.4 Light row and editor

- Capability: On/off · RGB · White (color temperature).
- Default look: RGB → color + brightness; White → kelvin slider (2700–6500 K, labelled in K) +
  brightness; On/off → a **Color / White** toggle, then the picker or kelvin slider, plus the fixed
  brightness it turns on at.
- The subtitle shows coverage:
  - aligned: `White · groups 6–7`
  - rounded: `White · LEDs 22–29 → groups 6–7` with ⓘ explaining rounding
  - exact mode, partial: `RGB · LEDs 22–29 · ⚠ uses exact LEDs: the strip switches to Per-LED while this is on`
- A `ct` light while the strip is Per-LED gets a small "approximate white" chip with the reason.

### 4.5 "How control works" panel

A collapsible panel on the Devices page: the §0 table, the rounding rule with a small diagram of
a group, and what forces Per-LED (single-LED tools, exact-LED lights, the Per-LED only setting,
too many groups).

---

## 5. Build order

1. Geometry (`groups.ts`) + planner + `decide()` with the full test matrices (testing plan §2).
2. Protocol packing + engine integration + simulate decoding + engine scenarios.
3. Data model (`ct`, `look`, device fields, removed `dimmable`/`idleBehavior`, status) + commands
   + MQTT + their tests.
4. UI (§4), with the group dividers first, then a manual pass in `pnpm dev:sim`.
5. Hardware acceptance checklist (testing plan §3), then update `CLAUDE.md`, `SPEC.md` and the README.

---

## 6. Does this replace govee2mqtt?

For **this strip's lighting**, mostly yes: on/off, brightness, RGB and real white per zone, fully
local, plus things govee2mqtt can't do (zones as separate HA lights, priorities, per-LED fallback).

Still not covered:

| Gap | Why |
|---|---|
| Govee scenes, DIY effects, music mode | Out of scope (animations, scenes) |
| Reading state back | We only send. A change made in the Govee app isn't reflected in HA |
| A whole-strip power entity as Govee sees it | Ours are virtual lights |
| Other Govee devices, discovery | Manual IP per strip, by design (UDP 4002 stays with govee2mqtt) |
| Govee timers and schedules, cloud features | No cloud |

So it can replace govee2mqtt **for this strip** if scenes and effects aren't used and the strip
isn't changed from the Govee app. Keep govee2mqtt for other Govee devices, and use "Release to
Govee" to get to scenes.
