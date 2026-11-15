# Segment mode: testing plan

Companion to [`segment-mode-plan.md`](segment-mode-plan.md). There are three parts:

1. **Hardware probe.** A CLI that checks each assumption (A1–A19) on the real strip and
   records the answers. This gates the implementation.
2. **Unit and engine tests** (Vitest). These pin the exact behaviour as tables and matrices, so
   any change in behaviour shows up as a failing row.
3. **Hardware acceptance checklist.** Run it after implementation, against the real strip.

---

## 1. Hardware probe CLI

### 1.1 Raw commands: `pnpm cli seg …`

They use the same encoder as the service (`src/server/protocol.ts`), so a passing probe also
validates our bytes. `<segs>` is a list such as `0`, `0,2`, `3-5` or `all` (`all` needs `--segments N`).

| Command | Sends |
|---|---|
| `seg color <segs> <r> <g> <b>` | Color frame, kelvin 0 |
| `seg white <segs> <kelvin> [--rgb r,g,b] [--tint r,g,b]` | Color frame with kelvin. Defaults: RGB `ff ff ff`, tint = `miredsToRgb` |
| `seg bright <segs> <0-100>` | Brightness frame |
| `seg off <segs> [--method zero\|bright0\|both]` | Off by RGB 0 + kelvin 0, by brightness 0, or both |
| `seg raw <hex> [<hex>…]` | Arbitrary BLE payloads (≤ 19 bytes each). Checksum and padding added; all in one datagram |
| `seg sweep --segments N [--ms 1500]` | Lights segment *i* red with all others off, for each *i*, printing the index. Used to find the count and boundaries |
| `seg rate <segs> --hz H --seconds S` | Alternates the brightness 20↔100 at H Hz and prints the datagrams sent. Used to find the rate at which updates are lost |
| `seg fade <segs> <kelvin> --from P --to Q --ms D --hz H` | Stepped brightness fade, to check visually |
| `seg multi <n>` | One datagram with *n* frames, each setting a different segment a different color |
| `seg switch --cycles N --segments N` | Repeats: segment state A → `enable` + one razer frame B → `disable` → state A, with 2 s pauses. Used to watch for flashes |

Global options: `--ip` (required), `--mask-order le|be`, `--mask-offset <byte>` (default 12 for
color frames and 5 for brightness frames), `--dry` (print the hex and base64 without sending).

### 1.2 Guided probe: `pnpm cli probe --ip <ip>`

An interactive script that runs P1–P18 in order. For each step it prints what it sends and what to
look for, then asks a question (y / n / other, plus a free-text note). Answers go to
`data/probe-<date>.json`: `{ probe, assumption, sent: [hex…], answer, note }`. Setup: govee-zones
stopped or released, phone with the Govee app nearby, strip visible.

| Probe | Checks | Steps | Question |
|---|---|---|---|
| P1 | A1 | `seg color 0 255 0 0` | Did anything change? |
| P2 | A2 | `seg color 0 …`, then `seg color 1 …`, then `seg color 0,1 …` | Did the right segments change? (If not, rerun with `--mask-order be` or other offsets) |
| P3 | A2 | Sweep of the first 3 segments | Does the order go along the strip from the start? |
| P4 | A3 | `seg white 0 2700` next to the app's own 2700 K on segment 1 (set in the app first), then `seg white 0 6500` | Is it the white LEDs (does it match the app)? Does kelvin change the look? |
| P5 | A4 | `seg color 0 0 0 255` after P4 | Does it switch from white to blue? |
| P6 | A5 | `seg bright 0 10`, then `100`, on an RGB segment and on a white segment | Dims for both? Other segments unchanged? |
| P7 | A6 | `seg off 0 --method zero`, then `bright0`, then `both` | Which ones go fully dark? |
| P8 | A7 | `seg multi 2`, `4`, `8`, `12` | Did all segments apply for each? Largest *n* that works? |
| P9 | A8 | `seg rate 0 --hz 5`, `10`, `20`, `30` for 5 s each; `seg fade 0 2700 --from 5 --to 100 --ms 2000 --hz 10` | Highest rate with no visible misses? Smooth or stepped? Does the firmware add its own fade? |
| P10 | A9 | Set a segment state and wait 3 minutes | Still showing after 3 minutes? |
| P11 | A10 | Start an app scene, then `seg white all 2700` | Did the scene stop and white appear? |
| P12 | A11, A12 | `seg switch --cycles 5`; also send `seg color` while razer is enabled | Any flash on switching? Do segment frames apply during razer? |
| P13 | A13 | LAN `brightness 50`, then a segment at 100 % | Is it half brightness? |
| P14 | A14, A19 | `seg sweep --segments 64` (count the last lit index), plus `pnpm cli pixel` at each boundary | Segment count? Are boundaries even (record the LED index of each)? |
| P15 | A15 | `off`; `seg white 0 2700`; `on` | When it turns on: our state immediately, or the old one first? |
| P16 | A16 | Re-send the same state 20× at 2 Hz | Any blink? |
| P17 | A17 | `seg white 0` at 1800, 2000, 2200, 2700, 4000, 6500, 9000 | Lowest and highest kelvin that change the look? |
| P18 | A18 | Pull power mid-state, restore it, then `seg bright 0 50` | State after power-up? Does the command apply without `turn on`? |

**Go/no-go:** the implementation starts when P1–P9 match the expected answers, or when the plan's
"If false" column has been applied for each one that didn't. Constants come from the probe file:
`SEGMENT_STEP_MS` (P9), maximum frames per datagram (P8), kelvin range (P17), off method (P7),
segment count and boundaries (P14).

---

## 2. Unit and engine tests

Conventions: table-driven `it.each`, with expected values written out by hand rather than
computed by the code under test. New files are marked *(new)*.

### 2.1 `test/protocol.test.ts`: segment encoding

| Case | Expectation |
|---|---|
| `bleFrame` pads to 20 bytes and XORs bytes 0–18 | Exact bytes |
| Discussion vector: `33 05 15 01 FF FF FF 0B B8 FF B9 69 01` | Exact 20 bytes + base64 (replaced with the probe-captured vector after P4) |
| `segmentMask([0])`, `[1]`, `[0,1]`, `[8]`, `[55]` | `01`, `02`, `03`, `00 01`, `… 80` |
| `segmentMask([56])` | Throws |
| Brightness frame `33 05 15 02 32 01` | Exact bytes |
| Payload > 19 bytes | Throws |
| `ptReal([a,b])` | `{"msg":{"cmd":"ptReal","data":{"command":["…","…"]}}}` |
| Existing razer vector `uwABsQEK` | Unchanged |

### 2.2 `test/segments.test.ts` *(new)*: geometry and rounding

`segmentBounds`:

| LEDs | Count | Expected |
|---|---|---|
| 60 | 6 | `[0,9] [10,19] … [50,59]` |
| 61 | 6 | Uneven split, all LEDs covered, no overlap |
| 5 | 5 | One LED each |

`roundToSegments` (60 LEDs, 6 segments of 10):

| Ranges | Expected segments | Why |
|---|---|---|
| `[0,9]` | `0` | Aligned |
| `[0,14]` | `0,1` | Seg 1 is 5/10 = 50 % → included |
| `[0,13]` | `0` | 4/10 < 50 % |
| `[3,9]` | `0` | 7/10 |
| `[3,6]` | `0` | 4/10, but the light would vanish → largest-coverage fallback |
| `[8,11]` | `0` | Tie (2 and 2) → lowest index |
| `[0,9],[30,39]` | `0,3` | Multi-range |
| `[]` | none | |

`isAligned`: true for `[10,29]`, false for `[10,28]`.

### 2.3 `test/plan.test.ts` *(new)*: control decision and segment looks

**Control matrix:** every combination of
`segmentCount ∈ {0, 6}` × `control ∈ {auto, per_led}` × `partialSegments ∈ {round, exact}` ×
`visible lights ∈ {none, aligned only, aligned + partial}` × `override ∈ {none, identify, pixel}`.
That's 72 rows, each with the expected `control` + `reason` written out. Key rows:

| segs | control | partial | lights | override | → control | reason |
|---|---|---|---|---|---|---|
| 0 | auto | round | aligned | none | per_led | no_segments |
| 6 | per_led | round | aligned | none | per_led | per_led_setting |
| 6 | auto | round | aligned+partial | none | **segments** | auto |
| 6 | auto | exact | aligned+partial | none | per_led | exact_leds (detail: partial light) |
| 6 | auto | exact | aligned only | none | segments | auto |
| 6 | auto | exact | none | none | segments | auto (all off) |
| 6 | auto | round | aligned | identify | segments | auto (blinking segments) |
| 6 | auto | round | aligned | pixel | per_led | override |
| 0 | auto | round | aligned | identify | per_led | no_segments |

**Look per capability:** one light on segments 0–1, everything else off.

| Capability | Default look | State | Segment 0–1 look | Segments 2–5 |
|---|---|---|---|---|
| onoff | rgb #ff0000 | on | rgb ff0000 100 % | off |
| onoff | white 370 mireds | on | white 2703 K 100 % | off |
| dimmable | white 370 | on, bri 128 | white 2703 K 50 % | off |
| dimmable | white 370 | on, bri 1 | white 2703 K **1 %** (never 0 while on) | off |
| rgb | n/a | on, color 00ff00, bri 255 | rgb 00ff00 100 % | off |
| ct | white 250 | on, bri 255 | white 4000 K 100 % | off |
| any | any | off | off | off |

**Layering:**

| Setup | Expected |
|---|---|
| A (prio 0, white, segs 0–3), B (prio 1, rgb red, segs 2–5), both on | 0–1 white, 2–5 red |
| Same, B off | 0–3 white, 4–5 off |
| Equal priority, B created later | B wins the overlap |
| B rounds onto a segment A covers exactly | B wins segment (rounded coverage counts like real coverage) |

**Fades** (fixed `now` at 0 / 25 / 50 / 75 / 100 % of a 1000 ms fade):

| Fade | Expected at 0/25/50/75/100 % |
|---|---|
| ct off→on, bri 255 | pct 0/25/50/75/100, kelvin constant |
| ct on→off | pct 100/75/50/25/0 → off |
| ct bri 255→51 | pct 100/80/60/40/20 |
| ct 2700→6500 K | Mireds interpolate linearly (370→154); pct constant |
| rgb red→blue | RGB lerp |
| dimmable (white default) off→on | Fades in at the white look from pct 0, with no colour sweep |
| B (white, prio 1) fading out over A (rgb, prio 0) | pct blends; kind = B's until 50 %, A's from 50 % |

### 2.4 `test/lifecycle.test.ts`: `decide()` matrix (rewritten)

All rows are explicit. Inputs default to `enabled, !released, idle=off, fading=false`.

| # | enabled | released | idle | want | held | fading | → actions | held | frame | mode |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | ✗ | | | segments | per_led | | disable | none | – | idle |
| 2 | ✗ | | | segments | segments | | – | none | – | idle |
| 3 | ✗ | | | none | none | | – | none | – | idle |
| 4 | ✓ | ✓ | | per_led | per_led | | disable | none | – | released |
| 5 | ✓ | ✓ | | segments | segments | | – | none | – | released |
| 6 | ✓ | ✓ | | none | none | | – | none | – | released |
| 7 | ✓ | | | segments | none | | turn_on, brightness_max | segments | plan | segments |
| 8 | ✓ | | | segments | segments | | – | segments | plan | segments |
| 9 | ✓ | | | segments | per_led | ✓ | – | per_led | composite | per_led (fade_finishing) |
| 10 | ✓ | | | segments | per_led | ✗ | disable | segments | plan | segments |
| 11 | ✓ | | | per_led | none | | turn_on, brightness_max, enable | per_led | composite | per_led |
| 12 | ✓ | | | per_led | segments | ✓/✗ | enable | per_led | composite | per_led |
| 13 | ✓ | | | per_led | per_led | | – | per_led | composite | per_led |
| 14 | ✓ | | off | none | per_led | | disable, turn_off | none | – | idle |
| 15 | ✓ | | off | none | segments | | segments_all_off, turn_off | none | – | idle |
| 16 | ✓ | | off | none | none | | – | none | – | idle |
| 17 | ✓ | | release | none | per_led | | disable | none | – | idle |
| 18 | ✓ | | release | none | segments | | segments_all_off | none | – | idle |
| 19 | ✓ | | release | none | none | | – | none | – | idle |
| 20 | ✓ | | hold_black (segs avail) | none | none | | turn_on, brightness_max | segments | black | idle |
| 21 | ✓ | | hold_black (segs avail) | none | segments | | – | segments | black | idle |
| 22 | ✓ | | hold_black (segs avail) | none | per_led | ✗ | disable | segments | black | idle |
| 23 | ✓ | | hold_black (no segs) | none | none | | turn_on, brightness_max, enable | per_led | black | idle |
| 24 | ✓ | | hold_black (no segs) | none | per_led | | – | per_led | black | idle |
| 25 | ✓ | | hold_black (no segs) | none | segments | | enable | per_led | black | idle |

Plus **invariant sweeps** over the full cross-product (2 × 2 × 3 × 3 × 3 × 2 × segs-available 2):

- I1: if held was `per_led` and isn't any more → `actions[0] === 'disable'`.
- I3/I2: if result held is `segments`, `enable` isn't in the actions, and frame ≠ razer.
- I4: `turn_off` with held `segments` → preceded by `segments_all_off`.
- I5: held `per_led`, want `segments`, fading → held stays `per_led`.
- I6: held `none`, want `none`, idle ≠ hold_black → no actions.

### 2.5 `test/engine.test.ts`: scenarios (fake timers, recording transport)

The recorder gains a `ptReal` decoder that writes labels such as
`seg[0-1]:white:2703:100`, `seg[2-5]:off`, `seg[0]:bri:50`. Existing razer labels are unchanged.

| ID | Scenario | Expected datagram sequence / state |
|---|---|---|
| E1 | 3 `ct` lights aligned on a 6-segment strip; turn on A | `turn:1`, `bright:100`, `seg[…]` with A's segments white, the rest off; mode segments; **no** `enable` |
| E2 | E1, then wait 10 s | Full segment refresh every `keepaliveMs`; nothing else |
| E3 | E1, change A's brightness | Only A's group re-sent (diff) |
| E4 | E1, all off with idle `off` | `seg[all]:off`, then `turn:0`; mode idle; then silence |
| E5 | E1 + an `rgb` light partly covering a segment, `exact` | `enable`, razer frames; reason exact_leds; turn the rgb off with a 1 s fade → razer frames continue until the fade ends, then `disable`, `seg[…]` |
| E6 | Same as E5 but `round` | Never `enable`; the rgb light painted on its rounded segments |
| E7 | Identify in segment mode | Blinking `seg` datagrams; never `enable`; back to the plan after 5 s |
| E8 | Pixel finder in segment mode | `enable` → razer → after 10 s `disable` → full `seg` state; **no** `turn:0` in between |
| E9 | `control = per_led` | Never `ptReal`; identical to the existing razer tests |
| E10 | `segmentCount = 0` | All existing engine tests pass unchanged (regression guard) |
| E11 | Release while in segment mode | No datagrams; commands still stored; un-release → `turn:1`, `bright:100`, full `seg` |
| E12 | `engine.stop()` in segment mode | No datagrams |
| E13 | `engine.stop()` in per-LED mode | As today (`disable`, `turn:0`, or `disable` for release) |
| E14 | Restart (new engine, same store) with a light on | `turn:1`, `bright:100`, full `seg`; no `turn:0`, no razer |
| E15 | `hold_black` + segments, all off | `seg[all]:off`; never `enable` |
| E16 | Segment-mode fade of 1 s | `seg` datagrams 100 ms apart (≈10), pct monotonic |
| E17 | 20 commands in 50 ms | Coalesced: ≤ 1 datagram per 100 ms |
| E18 | IP change in segment mode | Nothing to the old IP; re-entry to the new IP |
| E19 | `segmentCount` edited 6 → 12 while lights on | Re-planned; full state for 12 segments |
| E20 | More than 8 groups | Split across datagrams of ≤ 8 frames, paced |
| E21 | Segment datagram queued, then switch to per-LED | `disable`-before-`seg` ordering never violated (separate coalesce keys) |
| E22 | Brightness reassert in segment mode after 30 s | `bright:100`, no `enable` |
| E23 | Status emitted | `{mode, reason, detail}` matches §2.3 at each step |

### 2.6 Other suites

| File | Cases |
|---|---|
| `commands.test.ts` | `ct` accepts brightness and color_temp, ignores color; `rgb` ignores color_temp; `onoff` with a white default turns on white; `dimmable` with a white default keeps its kelvin when dimmed |
| `schemas.test.ts` | `rgb_ct` rejected; new device fields have defaults in input, none in patch (a partial patch leaves `control`/`partialSegments` alone); `ct` requires a white default |
| `mqtt.test.ts` | `ct` discovery payload (exact object); mode sensor options; status payload with `reason`/`detail`; changing a light's capability republishes the same discovery topic with a new payload |
| `transport.test.ts` | Simulated transport logs decoded `ptReal` |
| `web/` helpers *(new, pure)* | `coverageLabel(light, device)` → "segments 6–7" / "rounded to segments 6–7" / "uses exact LEDs"; `snapSelection(cells, device)`; `modeExplanation(status)` → the exact strings in plan §4.2 |

---

## 3. Hardware acceptance checklist

Run with the real H805A after implementation. Record pass/fail in the PR.

| # | Do | Pass when |
|---|---|---|
| H1 | Three `ct` zones on, at 2700 / 4000 / 6500 K | Real white LEDs (matches the app's own white); mode badge Segments |
| H2 | Dim each from HA, 100 → 10 % | Smooth enough, others unaffected |
| H3 | HA transition 2 s | No flash, visibly stepped but acceptable |
| H4 | Turn all off (idle off), then on again | Clean; no flash of the old state |
| H5 | Restart the container with lights on | **No blink** |
| H6 | Stop the container for 5 min | Lights stay on |
| H7 | Pixel finder, then wait | Switches to Per-LED, back to Segments, white returns; note any flash |
| H8 | Identify a zone | Its segments blink; no mode switch |
| H9 | `exact` + a partial RGB light on and off with a fade | Per-LED while on; fade-out finishes before switching back; badge reason correct |
| H10 | Release, change a scene in the app, un-release | App works while released; our state comes back |
| H11 | Power-cycle the strip with lights on | Lights back within one refresh |
| H12 | Leave it running 24 h | No drift, no revert, no errors in the logs |
