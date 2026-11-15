# Segment mode: testing plan

Companion to [`segment-mode-plan.md`](segment-mode-plan.md). There are three parts:

1. **Hardware probe** (done, two rounds). Guided CLI tests on the real strip; results in
   [`segment-mode-results.md`](segment-mode-results.md).
2. **Unit and engine tests** (Vitest). These pin the exact behaviour as tables and matrices, so
   any change in behaviour shows up as a failing row.
3. **Hardware acceptance checklist.** Run it after implementation, against the real strip.

---

## 1. Hardware probe CLI

Results and what they mean: [`segment-mode-results.md`](segment-mode-results.md). Round 1 found
that each mask bit drives a **group of 4 LEDs**; what round 1 calls "segments" are those groups.
Groups count **from 1** in the CLI and the probe. Protocol masks are 0-based internally.

### 1.1 Round 1: `pnpm cli probe --ip <ip> --segments 5` (done)

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

### 1.2 Round 2: `pnpm cli probe --round 2 --ip <ip>` (done)

Re-checks round 1's uncertain answers in ways that are harder to misread (large areas, A/B on
the same LEDs), and covers the rest. Every animation can be replayed (`r`) before answering.
Answers go to `$DATA_DIR/probe-r2-<time>.json`.

| # | Test | What the strip shows | Questions | Settles |
|---|---|---|---|---|
| 1 | **Groups** | All 24 mask bits lit red, green, blue, … from the start | Reaches the end? How many blocks? All 4 LEDs? | Group count and size; the rest of the round uses the counted number |
| 2 | **White** | Half real white / half RGB-mixed, swapping on Enter, at 2700 K and then 6500 K. Then a kelvin sweep (2000–9000 K). Then 5 ways of sending 2700 K (RGB and tint fields varied) | Different from mixed? Like the app's? Which is brighter? Range where kelvin stops changing? Up close, is warm white a cool LED plus RGB? Which field variants change the look? | Real white at both ends (A3), kelvin range (A17), which bytes matter |
| 3 | **Off vs minimum** | Quarters: brightness 0 · brightness 1 % · RGB 0 + kelvin 0 · on | Which are dark? Is 0 the same as 1 %? | Off method, minimum brightness (A6) |
| 4 | **Firmware glide** | Brightness jumps 5 ↔ 100 %; color jumps red ↔ blue; the same state re-sent 10× at 2/s (all repeatable) | Snap or glide (and how long)? Any blink on re-send? | Fade stepping (A8), refresh (A16) |
| 5 | **Switch back** | Warm white → per-LED blue 3 s → back, three ways: A disable then segments; B segments while per-LED is on, 1.5 s, then disable; C both together (all repeatable) | Clean, or what flashed? For B: did it change while per-LED was still on? | Switch order and dwell (A11, A12) |
| 6 | **Govee app** | You start an app scene, then warm white is sent. Then LAN brightness flips 100 ↔ 50 | Did the scene stop everywhere? Does LAN brightness dim? | A10, A13 |

### 1.3 Raw commands: `pnpm cli seg …`

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
computed by the code under test. Fixtures use the house strip: **60 LEDs, group size 4,
15 groups**. Group numbers below are 0-based (code); the UI shows them from 1. New files are
marked *(new)*. F-numbers refer to the verified facts in the plan's §1.

### 2.1 `test/protocol.test.ts`: segment encoding (partly done)

| Case | Expectation |
|---|---|
| ✅ `bleFrame` pads to 20 bytes, XOR of bytes 0–18; > 19 bytes throws | Exact bytes |
| ✅ Community 3000 K vector | Exact 20 bytes |
| ✅ `segmentMask` LSB/MSB/width | `[0]`→`01 00 00`, `[1,4]`→`12 00 00`, `[8]`→`00 01 00` |
| ✅ Brightness frame, clamping | `33 05 15 02 32 01 00 00 …` |
| ✅ `ptReal` wrapping | Exact JSON |
| New: frames as the service sends them (F5, F7) | white 2700 K = `33 05 15 01 00 00 00 0a 8c 00 00 00 <mask>`; off = `33 05 15 01 00 × 8 <mask>` |
| New: packing ≤ 6 frames per datagram (F4) | 7 frames → datagrams of 6 + 1 |
| Existing razer vector `uwABsQEK` | Unchanged |

### 2.2 `test/groups.test.ts` *(new)*: geometry and rounding

`groupBounds` / `groupBoundaries`:

| LEDs | Size | Bounds | Boundaries |
|---|---|---|---|
| 60 | 4 | `[0,3] [4,7] … [56,59]` (15) | `4, 8, …, 56` (14) |
| 62 | 4 | 15 × 4, then `[60,61]` | `4, …, 56, 60` |
| 60 | 0 | none | none |

`roundToGroups` (60 LEDs, size 4):

| Ranges | Groups | Why |
|---|---|---|
| `[0,3]` | `0` | Aligned |
| `[0,5]` | `0,1` | Group 1: 2/4 = 50 % → included |
| `[0,4]` | `0` | Group 1: 1/4 |
| `[1,3]` | `0` | 3/4 |
| `[2,5]` | `0,1` | 2/4 each → both |
| `[3,4]` | `0` | 1/4 each → fallback to most covered, tie → lowest |
| `[0,3],[20,23]` | `0,5` | Multi-range |
| `[56,59]` | `14` | Last group |
| `[]` | none | |

Plus: every edge moves by ≤ 2 LEDs over all ranges `[a,b]` with 0 ≤ a ≤ b < 60 (an exhaustive
sweep). `isAligned`: true for `[4,11]`, false for `[4,10]`.

### 2.3 `test/plan.test.ts` *(new)*: control decision and group looks

**Control matrix:** the cross-product of
`groupSize ∈ {0, 4}` × `ledCount ∈ {60, 200}` × `control ∈ {auto, per_led}` ×
`partialGroups ∈ {round, exact}` × `visible ∈ {none, aligned, aligned + partial}` ×
`override ∈ {none, identify, pixel}`. That's 144 rows, generated, each checked against a
hand-written rule table. Key rows written out:

| size | LEDs | control | partial | visible | override | → | reason |
|---|---|---|---|---|---|---|---|
| 0 | 60 | auto | round | aligned | none | per_led | groups_off |
| 4 | 200 | auto | round | aligned | none | per_led | too_many_groups (50 > 24) |
| 4 | 60 | per_led | round | aligned | none | per_led | per_led_setting |
| 4 | 60 | auto | round | aligned+partial | none | **groups** | auto |
| 4 | 60 | auto | exact | aligned+partial | none | per_led | exact_leds (detail = partial light) |
| 4 | 60 | auto | exact | aligned | none | groups | auto |
| 4 | 60 | auto | exact | none | none | groups | auto (all off) |
| 4 | 60 | auto | round | aligned | identify | groups | auto (blinking groups) |
| 4 | 60 | auto | round | aligned | pixel | per_led | override |
| 0 | 60 | auto | round | aligned | identify | per_led | groups_off |

**Look per capability:** one light on groups 0–1, everything else off.

| Capability | Default look | State | Groups 0–1 | Groups 2–14 |
|---|---|---|---|---|
| onoff | rgb `ff0000` | on | rgb `ff0000` 100 % | off |
| onoff | white 370 mireds | on | white 2703 K 100 % | off |
| onoff | white 370, default bri 128 | on | white 2703 K 50 % | off |
| ct | white 370 | on, bri 1 | white 2703 K **1 %** (never 0 while on) | off |
| rgb | – | on, `00ff00`, bri 255 | rgb `00ff00` 100 % | off |
| ct | white 250 | on, bri 255 | white 4000 K 100 % | off |
| any | any | off | off | off |

**Layering:**

| Setup | Expected |
|---|---|
| A (prio 0, white, groups 0–3), B (prio 1, red, groups 2–5), both on | 0–1 white, 2–5 red, 6–14 off |
| Same, B off | 0–3 white |
| Equal priority, B created later | B wins the overlap |
| B rounds onto a group A covers exactly | B wins that group |

**Fades** (at 0 / 25 / 50 / 75 / 100 % of a 1000 ms fade):

| Fade | Expected |
|---|---|
| ct off → on, bri 255 | pct 0→off, 25, 50, 75, 100; kelvin constant |
| ct on → off | pct 100, 75, 50, 25, then off |
| ct bri 255 → 51 | pct 100, 80, 60, 40, 20 |
| ct 2700 → 6500 K | mireds 370 → 154 linear; pct constant |
| rgb red → blue | RGB lerp |
| onoff (white default) off → on | Fades in at the white look from 0; no color sweep |
| B (white, prio 1) fading out over A (rgb, prio 0) | pct blends; kind = B's below 50 %, A's from 50 % |

### 2.4 `test/lifecycle.test.ts`: `decide()` (rewritten)

Defaults: `enabled`, not `released`, groups available, not fading. There is no idle-behaviour
input any more: all off always ends in `turn_off`. Columns: before /
frame / after → held, mode (reason).

| # | Inputs | before | frame | after | → held / mode |
|---|---|---|---|---|---|
| 1 | disabled, held per_led | disable | – | – | none / idle |
| 2 | disabled, held groups | – | – | – | none / idle |
| 3 | released, held per_led | disable | – | – | none / released |
| 4 | released, held groups, want groups | – | – | – | none / released |
| 5 | want groups, held none | brightness_max | groups | turn_on | groups / groups |
| 6 | want groups, held groups | – | groups | – | groups / groups |
| 7 | want groups, held per_led, fading | – | composite | – | per_led / per_led (fade_finishing) |
| 8 | want groups, held per_led, not fading | disable | groups | – | groups / groups |
| 9 | want per_led, held none | turn_on, brightness_max, enable | composite | – | per_led / per_led |
| 10 | want per_led, held groups (fading or not) | enable | composite | – | per_led / per_led |
| 11 | want per_led, held per_led | – | composite | – | per_led / per_led |
| 12 | none, held per_led | disable, turn_off | – | – | none / idle |
| 13 | none, held groups | turn_off | – | – | none / idle |
| 14 | none, held none | – | – | – | none / idle |
| 15 | none, held per_led, groups not available | disable, turn_off | – | – | none / idle |

**Invariant sweeps** over the full cross-product (enabled 2 × released 2 × available 2 × want 3 ×
held 3 × fading 2 = 144 cases): I1–I6 from plan §3.3.

### 2.5 `test/engine.test.ts`: scenarios (fake timers, recording transport)

The recorder decodes `ptReal` into labels such as `g[0-1]:white:2703`, `g[2-14]:off`,
`g[0-1]:pct:50`; razer and LAN labels are unchanged. Device: 60 LEDs, size 4.

| ID | Scenario | Expected |
|---|---|---|
| E1 | 3 aligned `ct` lights; turn on A | `bright:100`, group frames (A white, rest off, A's pct), then `turn:1`; mode groups; **no** `enable` |
| E2 | E1, then 60 s | A full re-send + `bright:100` every 30 s; nothing else |
| E3 | E1, change A's brightness | Only a brightness frame for A's groups |
| E4 | E1, all off | `turn:0` only; mode idle; then silence |
| E5 | All off while per-LED (control = per_led) | `disable`, `turn:0`; then silence |
| E6 | + `rgb` light partly covering a group, exact; then off with a 1 s fade | `enable` + razer frames; reason exact_leds; razer continues until the fade ends, then `disable` + group frames |
| E7 | Same as E6 but round | Never `enable`; the light painted on its rounded groups |
| E8 | Identify in group mode | Group datagrams alternating every 700 ms; never `enable`; back to the plan after 5 s |
| E9 | Pixel finder in group mode | `enable` → razer → `disable` → full group state; no `turn:0` |
| E10 | `control = per_led` | Never `ptReal`; matches the existing razer tests |
| E11 | `groupSize = 0` | The existing razer engine tests pass, minus the removed idle behaviours (`hold_black`, `release`) |
| E12 | 200 LEDs, size 4 | Per-LED; reason too_many_groups |
| E13 | Release in group mode | No datagrams; commands stored; un-release → full state, then `turn:1` |
| E14 | `stop()` in group mode | No datagrams |
| E15 | `stop()` in per-LED mode | `disable`, `turn:0` |
| E16 | Restart with a light on | `bright:100`, full group state, `turn:1`; no `turn:0`, no razer |
| E17 | 1 s fade in group mode | Group datagrams ~100 ms apart (≈ 10), pct monotonic |
| E18 | 20 commands in 50 ms | ≤ 1 update per 100 ms |
| E19 | 15 distinct looks | Packed ≤ 6 frames per datagram |
| E20 | Group datagrams queued, then a switch to per-LED | Queued group datagrams dropped; nothing group-related after `enable` (I2) |
| E21 | IP change in group mode | Nothing to the old IP; entry at the new IP |
| E22 | `groupSize` 4 → 2 while lights are on (30 groups → per-LED) | Switches with reason too_many_groups |
| E23 | Status at each step | `{mode, reason, detail, groups}` as plan §2.3 |

### 2.6 Other suites

| File | Cases |
|---|---|
| `commands.test.ts` | `ct` takes brightness and color_temp, ignores color; color_temp clamped to 154–370 mireds; `rgb` ignores color_temp; onoff with a white default turns on white at its fixed brightness, and ignores brightness and color_temp |
| `schemas.test.ts` | `rgb_ct`, `dimmable` and `idleBehavior` rejected; white defaults outside 2700–6500 K rejected; new device fields have defaults in input and none in patch |
| `mqtt.test.ts` | `ct` discovery payload exactly (min/max 2700/6500); mode sensor options; status with `reason`/`detail`/`groups`; a capability change republishes the same topic |
| `transport.test.ts` | Simulated transport logs decoded `ptReal` |
| `web/` helpers *(new, pure)* | `coverageLabel` → "groups 6–7" / "LEDs 22–29 → groups 6–7" / "uses exact LEDs"; `snapSelection`; `modeExplanation(status)` → the exact strings in plan §4.2; divider positions from `groupBoundaries` for both views |

---

## 3. Hardware acceptance checklist

Run on the house strip after implementation; record pass/fail in the PR.

| # | Do | Pass when |
|---|---|---|
| H1 | Three `ct` zones on at 2700 / 4000 / 6500 K | Real white matching the app; badge Groups |
| H2 | Dim each from HA, 100 → 1 % | Smooth; others unaffected; 1 % is lit |
| H3 | HA transition 2 s | Smooth (glide + 10/s steps) |
| H4 | All off (the strip turns off), then on again | No flash of the old state |
| H5 | Restart the container with lights on | **No blink** |
| H6 | Stop the container for 5 min | Lights stay on |
| H7 | Pixel finder, then wait | Per-LED (hard cut in), back to Groups cleanly |
| H8 | Identify a zone | Its groups blink; no mode switch |
| H9 | `exact` + a partial RGB light, on then off with a fade | Per-LED while on; fade finishes before switching back; badge reason correct |
| H10 | Release, use an app scene, un-release | The app works while released; our state takes over again |
| H11 | Power-cycle the strip with lights on | Lights back within 30 s |
| H12 | Run 24 h | No drift, no revert, no errors in the logs |
| H13 | Strip and house views | Dividers every 4 LEDs in both, matching the real strip (check with Identify) |
