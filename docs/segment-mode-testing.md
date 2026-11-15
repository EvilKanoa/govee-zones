# Segment mode: testing plan

Companion to [`segment-mode-plan.md`](segment-mode-plan.md). There are three parts:

1. **Hardware probe.** A guided CLI (5 tests) that checks the key assumptions on the real
   strip and records the answers. This gates the implementation.
2. **Unit and engine tests** (Vitest). These pin the exact behaviour as tables and matrices, so
   any change in behaviour shows up as a failing row.
3. **Hardware acceptance checklist.** Run it after implementation, against the real strip.

---

## 1. Hardware probe CLI

The strip has **5 segments** (H805A, per the Govee app). Segments count **from 1** in the CLI
and the probe, as in the Govee app. Protocol masks are 0-based internally.

### 1.1 Guided probe: `pnpm cli probe --ip <ip> --segments 5`

Five tests. Each one puts the strip in a known state, or steps between states when you press
Enter, then asks what you see. Answers are multiple choice plus an optional note. They're saved
after every test to `$DATA_DIR/probe-<time>.json` (default `./data`), together with the mask
format and packing that test 1 found. `--dry` prints every datagram (BLE frames as hex) instead
of sending it.

Setup: govee-zones stopped, or "Release to Govee" on; LAN Control on; the whole strip in view.
The probe starts by sending razer `disable`, `turn on` and LAN `brightness 100`.

| # | Test | What the strip shows | Questions | Settles |
|---|---|---|---|---|
| 1 | **Map** | One packet: segments 1–5 red, yellow, green, blue, purple, plus brightness 100 % | Colors in order from the start? Blocks about equal length, 5 of them? | Command works (A1), mask layout (A2), several frames per packet (A7), segment count and even split (A14) |
| 2a | **Panel** | 1: white LEDs 2700 K 100 % · 2: RGB-mixed 2700 K 100 % · 3: white LEDs 2700 K 20 % · 4: red 20 % · 5: red 100 % | 1 vs 2: different, and 1 like the app's white? 3 dimmer than 1? 4 dimmer than 5? | **Real white (A3)**, per-segment dimming for white and RGB (A5) |
| 2b | **Off** | All warm white, then 1: off by RGB 0 + kelvin 0 · 2: off by brightness 0 · 3: off by both · 4, 5 left on | Which of 1–3 are fully dark? Did 4, 5 stay on? | How to turn a segment off (A6), and that other segments are left alone |
| 3 | **Toggle** | All warm white; each Enter steps segment 1 through 2700 K → 6500 K → blue → 2700 K | Warm → cool visible? Clean switch to blue and back? | Kelvin is used (A3, A17), one segment does both white and RGB (A4) |
| 4a | **Fade** | Segment 1 fades 5 → 100 % over 2 s at 10 updates/s, then at 20/s (repeatable) | Smooth, stepped, jumpy, or no change until the end? | Update rate, firmware fade (A8) |
| 4b | **Switch** | 3 cycles: all warm white (segments) → `enable` + blue razer frames for 3 s → `disable` → warm white again | Flash when switching to per-LED? When switching back (Govee scene, old colors)? | Switching cost (A11, A12) |
| 5a | **Power** | Green → `turn off` → warm white sent while off → `turn on` | White straight away, or green first? | Frames while off (A15) |
| 5b | **Hold** | Warm white, then nothing sent for ≥ 3 minutes (the probe enforces the wait) | Still warm white? | Holds with no keepalive (A9) |

**Test 1 fallbacks.** If the colors aren't exactly right, the probe retries with other layouts,
asking again each time:
1. 3-byte mask, LSB first, all frames in one packet (default);
2. same, one frame per packet (only if nothing or only some segments changed);
3. 7-byte mask, LSB first;
4. 3-byte mask, MSB first;
5. 7-byte mask, MSB first.

The first layout that matches is used for the rest of the run and recorded. If none matches,
the probe stops: the format is wrong, and `seg raw` is the tool for finding the right one.

**Go/no-go:** start the implementation when test 1 passes, test 2a shows real white (A3) and
per-segment dimming (A5), 2b finds an off method (A6), and 4a gives a usable rate (A8). Each
failed result maps to the "If false" column of the plan's §1.

Not probed up front (lower risk, covered by the acceptance checklist in §3): app scene override
(A10), LAN brightness interaction (A13), resend blink (A16), full kelvin range (A17), power cycle
(A18).

### 1.2 Raw commands: `pnpm cli seg …`

For follow-up checks after the probe. They use the same encoder as the service.

| Command | Sends |
|---|---|
| `seg color <segs> <r> <g> <b>` | Color frame, kelvin 0 |
| `seg white <segs> <kelvin>` | Color frame: RGB `ff ff ff`, kelvin, tint = RGB look of that kelvin |
| `seg bright <segs> <0-100>` | Brightness frame |
| `seg off <segs>` | RGB 0 + kelvin 0, and brightness 0 |
| `seg raw <hex> [<hex>…]` | Raw BLE payloads (≤ 19 bytes each); checksum and padding added; one datagram |

`<segs>` is `1`, `1,3`, `2-4` or `all` (with `--segments`). Options: `--mask-bytes <n>` (default 3),
`--msb`, `--dry`.

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
