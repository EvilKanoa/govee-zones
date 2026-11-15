# Segment mode — implementation plan

Status: **draft, not started.** Round 1 of the hardware probe is done, and its results change
parts of this plan. The biggest change: the addressable unit is a **group of 4 LEDs**, not the
Govee app's segments. See [`segment-mode-results.md`](segment-mode-results.md) ("Impact on the
plan"). That doc overrides this one where they disagree. This plan gets rewritten once round 2
is in.

This is v0, so there's no compatibility layer anywhere: `rgb_ct` is removed, and status
modes are renamed outright.

---

## 0. Summary

Govee strips accept two local LAN commands on UDP 4003:

| | **Segments** (`ptReal` segment frames) | **Per-LED** (`razer` streaming) |
|---|---|---|
| Resolution | Per app segment | Per LED |
| White | Real white LEDs (kelvin field) | Mixed from RGB: pinker and dimmer |
| Holding state | The strip holds it on its own | Needs a keepalive forever, with brightness pinned at 100 |
| If govee-zones stops | Lights stay as they are | The strip goes back to its Govee scene after ~60 s |
| Update rate | ~10/s (fades are stepped) | ~30 fps |

Segments become the normal way to drive a strip, and per-LED becomes the precise fallback.
The service picks one per strip on every tick, using a pure planner. Users get three
settings, and the UI always says which method is active and why.

---

## 1. Assumptions

| ID | Assumption | Test | If false |
|---|---|---|---|
| A1 | The H805A accepts `ptReal` over LAN (UDP 4003, LAN Control on). | T1 | Feature dead; stop. |
| A2 | Color frame `33 05 15 01 RR GG BB KH KL TR TG TB <mask>`, mask little-endian from byte 12, bit *n* = segment *n*. | T1 | Find the real layout with `seg raw` / `--mask-bytes` / `--msb`; only the encoder changes. |
| A3 | Kelvin ≠ 0 lights the **dedicated white LEDs** (RGB/tint ignored or harmless). | T2a, T3 | Segments lose the white advantage; keep the feature only for holding state on its own, or drop it. |
| A4 | Kelvin = 0 with RGB sets an RGB color on the segment. | T3 | RGB lights always use per-LED; segment mode only for `ct`/white defaults. |
| A5 | `33 05 15 02 <0-100> <mask>` sets brightness per segment, for both RGB and white. | T2a | RGB: dim by scaling RGB. White: segment mode only when every lit segment shares one brightness (use the LAN `brightness` command); otherwise per-LED. |
| A6 | A segment can be turned fully off (RGB 0 + kelvin 0, or brightness 0). | T2b | Off segments need per-LED → segment mode only when every segment is lit. Unlikely to be acceptable. |
| A7 | Several BLE frames in one `ptReal` datagram all apply, in order (the probe sends 6 at once; the service packs up to 8). | T1 | One frame per datagram (paced 15 ms) → slower updates; raise the step interval. |
| A8 | Segment updates are applied without the firmware's own fade, at ≥ 10 updates/s without drops. | T4a | Step interval = measured rate. If firmware fades itself, use it and skip stepping. |
| A9 | The strip holds the segment state indefinitely, with no revert timer. | T5b | Add a refresh at the measured period. |
| A10 | A segment command ends a running app scene/effect. | H10 | Send a static mode command first (find via `seg raw`). |
| A11 | Switching between modes (`B1 01` / `B1 00` ↔ segment frames) shows no more than one stale frame. | T4b | Add a minimum dwell (e.g. 5 s) before switching back to segments; never switch while something is visible if a flash is reliable. |
| A12 | Segment frames sent while razer is enabled are ignored, so a switch must disable first. | T4b | If they apply, nothing breaks; we still disable first. |
| A13 | The LAN `brightness` command scales segment brightness too; pinned at 100 it's neutral. | H2 | Don't pin brightness in segment mode. |
| A14 | Segments split the LEDs evenly; the count matches the Govee app. | T1 | Add editable segment boundaries (layout becomes a list of ranges). |
| A15 | Segment frames sent while the strip is powered off are stored and shown at `turn on` (no flash of the old state). | T5a | Turn on first, then send frames; accept a short flash, or send all-off before every `turn off` (we do that anyway, see §3.4). |
| A16 | Re-sending identical segment state causes no visible change. | H5 | Only resend on change, plus a slow refresh. |
| A17 | Supported kelvin range (expected ~2000–9000 K; HA range 2000–6535 K). | T3 (range: H1) | Clamp, and advertise the measured range in HA discovery. |
| A18 | After a power cycle the strip comes back showing its last segment state (or off), and accepts segment frames again without re-entry. | H11 | Re-send the full state on every refresh (we do anyway). |
| A19 | Segment count ≤ 56 (fits a 7-byte mask). Resolved: the strip has 5. | — | Investigate a wider mask variant. |

Test IDs: T = probe test (testing plan §1.1), H = hardware acceptance checklist (§3).
Implementation assumes A1–A9 pass. A10–A19 only adjust constants and edge handling.

---

## 2. Data model

### 2.1 Capabilities

`Capability = 'onoff' | 'dimmable' | 'rgb' | 'ct'`. `rgb_ct` is removed. Existing `rgb_ct` lights
in `data/config.json` must be changed by hand to `ct` (white) or `rgb`. There is no migration code.

| Capability | HA `supported_color_modes` | Commands accepted | Default look |
|---|---|---|---|
| `onoff` | `onoff` | `state` | color **or** white (kelvin) |
| `dimmable` | `brightness` | `state`, `brightness` | color **or** white |
| `rgb` | `rgb` | `state`, `brightness`, `color` | color |
| `ct` | `color_temp` | `state`, `brightness`, `color_temp` | white (required) |

`LightDefaults = { brightness, look: { kind: 'rgb', color } | { kind: 'white', mireds } }`.
`LightState` gets the same `look` union in place of `color` + `colorTemp`. Everywhere a light's
color is needed, `lookRgb(look)` gives the RGB form (`miredsToRgb` for white).

### 2.2 Device fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `segmentCount` | int 0–56 | 0 | Segments in the Govee app. 0 = segment control off. |
| `control` | `'auto' \| 'per_led'` | `'auto'` | UI: **Control method** — Automatic / Per-LED only. |
| `partialSegments` | `'round' \| 'exact'` | `'round'` | UI: **Lights that don't line up with segments** — Round to whole segments / Use exact LEDs. |

Patch schemas come from the default-free base shape, as before (`test/schemas.test.ts` covers this).

### 2.3 Status

```ts
type DeviceMode = 'segments' | 'per_led' | 'idle' | 'released' | 'error';
type ControlReason =
  | 'auto'                       // segments: normal
  | 'no_segments'                // per_led: segmentCount = 0
  | 'per_led_setting'            // per_led: control = per_led
  | 'override'                   // per_led: identify (per-LED only), pixel finder, test, white test
  | 'exact_leds'                 // per_led: a visible light partly covers a segment and partialSegments = exact
  | 'fade_finishing';            // per_led: wants segments, waiting for a running fade to end
interface DeviceStatus {
  mode: DeviceMode;
  reason?: ControlReason;
  /** For exact_leds: names of the lights forcing per-LED; for override: which one. */
  detail?: string[];
  error?: string;
  /** Per-LED only: colors per frame after downsampling. */
  sentColors?: number;
}
```

The `streaming` boolean is dropped from status (it's derivable from `mode`).

---

## 3. Backend behaviour

### 3.1 Segment geometry (`src/shared/segments.ts`, pure)

- `segmentBounds(ledCount, count)`: segment *i* = LEDs `[⌊i·n/count⌋, ⌊(i+1)·n/count⌋ − 1]`.
- `coverage(ranges, ledCount, count)`: per segment, the number of LEDs the light covers.
- `roundToSegments(ranges, …)`: a segment belongs to the light when coverage ≥ 50 % of its LEDs
  (exactly 50 % counts as covered). If that leaves the light with **no** segments but it covers at
  least one LED, it gets the single segment with the most coverage (ties → lowest index). A light
  never disappears because of rounding.
- `isAligned(ranges, …)`: every segment's coverage is 0 or 100 %.

### 3.2 Planner (`src/server/plan.ts`, pure)

```ts
plan(device, lights, states, override, now) →
  | { control: 'segments'; segments: SegLook[] }   // one entry per segment
  | { control: 'per_led'; reason; detail? }
SegLook = { kind: 'off' } | { kind: 'rgb'; rgb; pct } | { kind: 'white'; kelvin; pct }
```

Decision, in order:

1. `segmentCount = 0` → `per_led` / `no_segments`.
2. `control = per_led` → `per_led` / `per_led_setting`.
3. An override that needs single LEDs is active (pixel finder, test chase, white test; identify
   only when the strip is in per-LED mode, see §3.6) → `per_led` / `override`.
4. `partialSegments = exact` and any visible light isn't aligned → `per_led` / `exact_leds`
   (detail = those lights' names).
5. Otherwise → `segments`, with per-segment looks:
   - Start every segment as `off` (pct 0).
   - Paint visible lights in paint order (priority, then creation order) over their **rounded**
     segments. Aligned lights round to themselves.
   - A light's look at `now`: kind/color/kelvin from its current (or fading) look; `pct` =
     `max(1, round(brightness/255·100))` × opacity. Opacity comes from the existing transition
     model (fade per-light opacity, not to black).
   - Layering with opacity *a* over the look *L* beneath: `pct = a·top.pct + (1−a)·L.pct`;
     kind/color/kelvin = top's if `a ≥ 0.5`, else L's. Within one light, RGB fades interpolate in
     RGB and white fades interpolate in mireds. RGB ↔ white swaps kind at the midpoint.
   - `pct` rounds to an integer; `pct = 0` → `off`.

The planner never looks at the current mode. Fade-related deferrals live in `decide()`.

### 3.3 Lifecycle (`decide()`, pure)

Inputs: `enabled`, `released`, `idleBehavior`, `want` (`'none' | 'segments' | 'per_led'`, where
`none` = nothing visible and no override), `held` (`'none' | 'segments' | 'per_led'`), and
`fading` (a transition is in progress on this strip).

Outputs: `actions` (ordered: `segments_all_off`, `turn_on`, `brightness_max`, `enable`,
`disable`, `turn_off`), `held`, `frame` (`'plan' | 'black' | null`), `mode`.

**Rules:**

| # | Condition | Actions | Result |
|---|---|---|---|
| R1 | `!enabled` | held `per_led` → `disable` | held none, mode `idle` |
| R2 | `released` | held `per_led` → `disable`; held `segments` → nothing (the lights stay as they are, see §3.5) | held none, mode `released` |
| R3 | want `segments`, held `none` | `turn_on`, `brightness_max` | held segments, frame plan |
| R4 | want `segments`, held `segments` | — | frame plan |
| R5 | want `segments`, held `per_led`, **fading** | — (**stay per-LED**) | held per_led, frame = per-LED composite, reason `fade_finishing` |
| R6 | want `segments`, held `per_led`, not fading | `disable` | held segments, frame plan (full) |
| R7 | want `per_led`, held `none` | `turn_on`, `brightness_max`, `enable` | held per_led |
| R8 | want `per_led`, held `segments` | `enable` | held per_led (switch immediately; any light fading in starts at 0 % so it doesn't flash) |
| R9 | want `per_led`, held `per_led` | — | frame per-LED composite |
| R10 | want `none`, idle `off` | held per_led → `disable`, `turn_off`; held segments → `segments_all_off`, `turn_off` | held none, mode idle |
| R11 | want `none`, idle `release` | held per_led → `disable`; held segments → `segments_all_off` | held none, mode idle |
| R12 | want `none`, idle `hold_black`, segments available | as R3/R4/R6 with all segments off | held segments, mode idle |
| R13 | want `none`, idle `hold_black`, no segments | as R7/R9 with a black frame | held per_led, mode idle |
| R14 | want `none`, held `none`, any idle | — (startup: send nothing, so a restart doesn't kill a Govee scene) | |

"Segments available" = `segmentCount > 0 && control = auto`.

**Invariants** (asserted in tests over the full matrix):

- I1: Leaving `per_led` always starts with `disable`.
- I2: Segment frames are never sent while held = `per_led` (a `disable` comes before them).
- I3: A razer frame is never sent while held ≠ `per_led`.
- I4: `turn_off` from held `segments` always follows `segments_all_off`, so the next `turn on`
  never flashes the old state.
- I5: **A fade never causes a switch** from per-LED to segments (R5). The switch to per-LED
  happens before a fade starts (R8), when the incoming light is invisible.
- I6: Idle with nothing held sends nothing (R14).

### 3.4 Engine (`engine.ts`)

- A tick runs the planner, then `decide()`, then sends.
- **Segments output:** group segments with an identical `SegLook`. Per group: one color frame
  (white: RGB `FF FF FF`, kelvin, tint = `miredsToRgb`; rgb: RGB with white-balance gains
  applied, kelvin 0, tint 0; off: all zero) and one brightness frame. Pack them into `ptReal`
  datagrams of ≤ 8 frames (A7). Coalesce key `segments`, separate from `frame`, so a queued
  segment datagram can never jump ahead of a `disable`.
- **Diffing:** send only groups whose segments changed since the last send. Re-send the full
  state every `keepaliveMs` (A9, A16).
- **Timing:** on change → next tick at ≥ 33 ms (per-LED) / ≥ 100 ms (segments, `SEGMENT_STEP_MS`,
  tuned from P9) after the previous one. While fading: per-LED 33 ms, segments 100 ms.
- `brightness_max` is re-sent every 30 s in both modes. `enable` is re-sent with it in per-LED mode
  only.
- **Preview:** the `frame` WebSocket message shows **what is on the strip**. In segment mode, that
  means the rounded segment looks expanded to LEDs (white shown via `miredsToRgb`). The message
  gets `mode` and a `whiteLeds: boolean[]` per segment (or a compact range list) so the UI can
  mark real-white segments.
- **Shutdown:** held `per_led` → as today (`hold_black` exits like `off`). Held `segments` →
  **send nothing**: the strip keeps its lights, and the next start re-sends the same state
  (R4 with held none → R3: `turn_on` is a no-op on a lit strip). Service updates don't blink
  the lights.
- **IP change:** held `per_led` → `disable` to the old IP; held `segments` → nothing to the old IP.
  Then held = none, and the next tick re-enters at the new IP.

### 3.5 Release to Govee

- Held `per_led` → `disable`; the strip goes back to its app scene (as today).
- Held `segments` → nothing is sent. The strip keeps showing the current segments until
  something is picked in the Govee app; the app scene does **not** come back on its own. The
  UI says so (§4.4).
- Light commands keep being stored. Un-release → R3, full state.

### 3.6 Overrides

| Override | Segments available | Otherwise |
|---|---|---|
| Identify | **Blink the light's rounded segments** in segment mode (no switch; shows the user what the rounding did) | Per-LED blink, as today |
| Pixel finder | Per-LED (switch, then back) | Per-LED |
| Test chase | Per-LED | Per-LED |
| White test (WB tuning) | Per-LED; a new **"Real white" test** fills all segments with white at the same kelvin, so the two can be compared back to back | Per-LED |

### 3.7 MQTT

- Discovery: `ct` → `supported_color_modes: ['color_temp']`, `brightness: true`,
  `color_temp_kelvin: true`, min/max kelvin from A17. `rgb_ct` removed.
- State payloads: `ct` → `color_mode: 'color_temp'`, `color_temp` in kelvin. `onoff`/`dimmable`
  with a white default report as today (HA doesn't show color for those modes).
- Mode sensor: `options: ['segments', 'per_led', 'idle', 'released', 'error']`. The status topic
  payload is `{ mode, reason, detail, error }`; `reason`/`detail` show up as attributes in HA.

### 3.8 Simulate mode

`simulatedTransport` decodes `ptReal`: `[sim] segments 0-3 white 2700K 80% · 4-7 off`, and
`[sim] segments 8 rgb #ff0000 100%`.

### 3.9 CLI

Covered in the testing plan (`pnpm cli seg …`, `pnpm cli probe`).

---

## 4. UI

Goal: every setting explains its tradeoff in place, and every automatic decision is visible with
its reason.

### 4.1 Device form — new "Segments" section

- **Segments** (number). Help: *"Number of segments shown for this strip in the Govee app. Segment
  control is off until this is set."*
- **Control method** (radio, disabled with that help text while segments = 0):
  - **Automatic** (recommended). *"Uses segment control whenever it can: real white LEDs, and
    the strip keeps its lights even if govee-zones stops. Switches to per-LED control only when
    something needs single LEDs, like the pixel finder."*
  - **Per-LED only.** *"Always controls individual LEDs. Every light is exact to the LED, but
    white is mixed from RGB (pinker and dimmer), and the strip goes back to its Govee scene about
    a minute after govee-zones stops. Use this if segment control misbehaves on your strip."*
- **Lights that don't line up with segments** (radio, only for Automatic):
  - **Round to whole segments** (default). *"Keeps real white and segment control. The light grows
    or shrinks to the nearest segment boundary."*
  - **Use exact LEDs.** *"Keeps the exact LED range by switching the whole strip to per-LED control
    while that light is on. Other lights on the strip lose real white during that time."*

### 4.2 Mode badge (strip page, device card)

| Mode | Badge | Tooltip / popover text |
|---|---|---|
| segments | **Segments** | "Real white LEDs. The strip holds its lights on its own." |
| per_led / no_segments | **Per-LED** | "Segment count isn't set for this strip." + link to the setting |
| per_led / per_led_setting | **Per-LED** | "Control method is set to Per-LED only." |
| per_led / override | **Per-LED** | "Pixel finder running." / "Test running." — returns to Segments when done |
| per_led / exact_leds | **Per-LED** | "Gutter uses exact LEDs and is on. White lights are mixed from RGB until it turns off." |
| per_led / fade_finishing | **Per-LED** | "Finishing a fade; switches to Segments after." |
| idle / released / error | as today | Released (segments): "Lights stay as they are until you pick something in the Govee app." |

The popover also has a two-line "Segments vs Per-LED" explainer (same text as §0's table).

### 4.3 Strip view / house view

- **Required: group dividers are always visible in both views** whenever segment control is
  available (group size set and the strip fits the mask). A group is the smallest unit segment
  control can drive (4 LEDs on the H805A test strip).
  - **Strip view:** a divider line between every pair of groups, clearly heavier than the gaps
    between single LEDs. The cells of one group read as one block (e.g. alternating subtle
    background bands per group).
  - **House view:** a short tick across the traced outline at every group boundary, placed at
    the boundary's LED position on the path, so the dividers follow corners and bends. They
    scale with zoom, stay readable over the background photo (contrasting halo), and are
    drawn above the background and below the LED dots.
  - Both views share one helper that turns `groupSize`/`ledCount` into boundary LED indices,
    so the two views can't disagree.
  - Dividers stay visible in per-LED mode too (dimmed), so it's always clear where lights
    will round to.
- **Selection snaps to whole segments** by default when segments are set; a "Fine (single LEDs)"
  toggle in the tool bar turns snapping off.
- In segment mode the preview shows the rounded result. Segments lit with real white get a subtle
  marker (thin outline or "W" dot), so real and mixed white can be told apart.

### 4.4 Light row / editor

- Capability select: On/off · Dimmable · RGB · White (color temp).
- Default look for On/off and Dimmable: a **Color / White** toggle, then a color picker or kelvin
  slider (labelled in K).
- The light row's subtitle shows coverage:
  - Aligned: `White · segments 6–7`
  - Rounded (round mode): `White · LEDs 118–161 → rounded to segments 6–7` with a ⓘ explaining rounding
  - Partial (exact mode): `RGB · LEDs 118–161 · ⚠ uses exact LEDs: the strip switches to Per-LED while this is on`
- A `ct` light while the strip is Per-LED: a small "mixed white" chip with the reason.
- Release notice in segment mode: *"Released. govee-zones stopped sending. The lights stay as they
  are until you change them in the Govee app."*

### 4.5 "How control works" help panel

A collapsible panel on the Devices page: the §0 table, the rounding rule with a small diagram, and
"what forces Per-LED" (pixel finder/test, exact-LED lights, Per-LED only setting).

---

## 5. Build order

1. Probe CLI + run the probe on hardware (testing plan §1). **Gate:** A1–A9 confirmed, or the plan
   is revised.
2. Protocol encoder + geometry + planner + `decide()` with the full test matrix (testing plan §2).
3. Engine integration + simulate decoding + engine scenario tests.
4. Data model changes (`ct`, `look`, device fields, status) + MQTT + tests.
5. UI (§4) + manual pass in `pnpm dev:sim`.
6. Hardware acceptance checklist (testing plan §3), then update `CLAUDE.md`/`SPEC.md`/README.

---

## 6. Does this replace govee2mqtt?

For **this strip's lighting**, mostly yes: on/off, brightness, RGB and real white per zone, fully
local, plus things govee2mqtt can't do (zones as separate HA lights, priorities, per-LED fallback).

It still doesn't cover:

| Gap | Why |
|---|---|
| Govee scenes, DIY effects, music mode | Out of scope (animation/scenes). |
| Reading state back | We only send. If someone changes the strip in the Govee app, HA keeps showing our state. govee2mqtt reads device status over LAN (4002) / cloud. |
| Whole-strip entity / power state as Govee sees it | Ours are virtual lights; there's no single "the strip" light entity. |
| Other Govee devices, discovery | Manual IP per strip, by design (UDP 4002 stays with govee2mqtt). |
| Govee-side timers/schedules, cloud features | No cloud. |

So it can replace govee2mqtt **for this strip** if you don't use scenes or effects and don't
change the strip from the Govee app. Keep govee2mqtt for other Govee devices, and for scenes
reached through "Release to Govee".
