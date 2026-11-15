# Segment mode: hardware results

Results from `pnpm cli probe` against the real strip, what they establish, what is still open,
and how they change [`segment-mode-plan.md`](segment-mode-plan.md). Raw answer files are in
`data/probe-*.json` (not committed).

Strip: H805A at 192.168.2.27, 60 LEDs (the real house installation). The `./data` config on the
dev laptop is test data, not the deployed setup.

Confidence is about the *observation*. Answers are judged by eye outdoors, so a single answer
that carries a big decision gets re-checked a different way before it's relied on.

---

## Round 1 (2026-11-15)

File: `data/probe-2026-11-15T19-51-08-977Z.json`. Mask: 3 bytes, LSB first, all frames in one
packet (matched on the first attempt).

| Test | Observation | Confidence | Notes |
|---|---|---|---|
| 1 Map | Colors in exact order (red, yellow, green, blue, purple) | High | First try, no fallback needed |
| 1 Map | **Each mask bit lit 4 LEDs**, not an app segment; the rest of the strip kept its earlier white | High (observation), medium (meaning) | Only 5 bits were lit, so the total number of bits/groups isn't measured yet |
| 1 Map | Blocks equal | High | Trivially, at 4 LEDs each |
| 2a Panel | Kelvin white clearly differs from RGB-mixed 2700 K, and looks like the app's warm white | Medium | The key result, but compared on two 4-LED patches side by side. Re-checked in round 2 on half the strip, A/B on the same LEDs, warm and cool |
| 2a Panel | Per-segment brightness 20 % is clearly dimmer, for both white and red | High | Two independent answers agree |
| 2b Off | Dark: RGB 0 + kelvin 0 (seg 1), and both (seg 3). **Not dark: brightness 0 (seg 2)** | Medium | Brightness 0 is probably clamped to the minimum. Round 2 compares 0 vs 1 % directly |
| 2b Off | Other segments unaffected | High | |
| 3 Toggle | 2700 K → 6500 K clearly changes; white → blue → white are clean | High | |
| 4a Fade | Smooth at both 10 and 20 updates/s | Low–medium | Smooth at 10/s suggests a firmware glide. Round 2 tests instant jumps |
| 4b Switch | Segments → per-LED is clean. **Per-LED → segments: brief flash**, no note on what | Low | Round 2 tests three orderings and asks what flashes |
| 5a Power | Frames sent while off show straight away at power-on | High | |
| 5b Hold | Still showing after 3 min 1 s with nothing sent | High | Razer reverts after about 60 s; segment state doesn't |

### Established

- **Segment commands work over LAN** (`ptReal` on UDP 4003). Byte layout: `33 05 15 01 RGB KK KK TINT <mask>`,
  3-byte mask, LSB first (bit 0 = first group). Several frames per datagram apply in order (6 tested).
- **The addressable unit is a group of 4 LEDs**, not the Govee app's segments. With 60 LEDs that
  should be 15 groups (fits the 3-byte mask). This makes segment mode almost as fine as per-LED.
- Per-group RGB, kelvin and per-group brightness all work, and a group can switch between white and RGB cleanly.
- Turning a group off: **RGB 0 + kelvin 0**. Brightness 0 doesn't go dark.
- State holds with no keepalive (≥ 3 min) and survives `turn off` / `turn on`; frames sent
  while off are shown at power-on with no flash.

### Still open after round 1 (→ round 2)

| Question | Why it matters | Round 2 test |
|---|---|---|
| How many groups; all exactly 4 LEDs? | Group geometry in the data model | 1 |
| Is kelvin white really the white LEDs, at warm **and** cool? Is the white LED cool white, with warm mixed in from RGB? | The main point of segment mode; whether warm white is "real" | 2 |
| Which kelvin range is honored; do the RGB/tint fields change the look? | Discovery min/max; what bytes to send | 2 |
| Is brightness 0 just the minimum? | Off method and minimum brightness | 3 |
| Does the firmware glide between states? | Whether we step fades ourselves | 4 |
| Does re-sending the same state blink? | The refresh strategy | 4 |
| What flashes on per-LED → segments, and does another order avoid it? | Switch rules, minimum dwell | 5 |
| Do segment frames apply while per-LED is on? (A12) | Switch ordering | 5 |
| Does a segment command stop a running app scene? (A10) | Taking control after Release | 6 |
| Does the LAN brightness command scale segment brightness? (A13) | Whether to pin brightness 100 | 6 |

Left to the acceptance checklist: power cycle mid-state (A18), 24 h soak.

### Impact on the plan

| Plan area | Change |
|---|---|
| Data model (§2.2) | `segmentCount` (from the Govee app) is replaced by **`groupSize`** (LEDs per mask bit, default 4). Group count = ⌈ledCount / groupSize⌉, which must fit the mask (24 bits for 3 bytes, so ≤ 96 LEDs with 3 bytes; wider masks are still untested). |
| Geometry and rounding (§3.1) | Same rules, applied to 4-LED groups. Rounding moves a light boundary by at most 2 LEDs. |
| Partial-segment setting (§2.2, §4.1) | With 4-LED groups, "Use exact LEDs" matters much less. Keep it, default Round. |
| Off (§3.2, §3.4) | Off = RGB 0 + kelvin 0. Minimum brightness for a lit group is 1 % (pending round 2). |
| Fades (§3.4) | Stepping at 10/s looked smooth. The final step interval depends on round 2 test 4. |
| Switching (§3.3) | Per-LED → segments flashes. R5 (never switch mid-fade) stays. A minimum dwell or a different order (round 2 test 5) is likely needed. Per-LED is now rare (pixel finder, test chase, exact-LED lights), so the cost is small. |
| Holding and shutdown (§3.4, §3.5) | Confirmed: in segment mode, shutdown and Release send nothing, and the strip holds its lights. |
| UI (§4) | Boundaries and snapping are every 4 LEDs. "Segments" in UI text should say "groups of 4 LEDs" so it isn't confused with the app's segments. |
| Assumptions | A1, A2, A4, A5, A7, A9, A15 confirmed. A3 likely (re-checking). A6 confirmed with a specific method. A8, A11 partly. A14 replaced (groups, not app segments). A19 moot. |

---

## Round 2 (2026-11-15)

File: `data/probe-r2-2026-11-15T20-12-43-741Z.json`.

| Test | Observation | Confidence | Notes |
|---|---|---|---|
| 1 Groups | Pattern reaches the last LED; **15 blocks, all 4 LEDs** | High | 60 LEDs = 15 groups × 4, exactly. Bits 16–24 do nothing |
| 2 White | Kelvin white clearly differs from RGB-mixed **and matches the app at both 2700 K and 6500 K** | High | Half the strip, A/B on the same LEDs; agrees with round 1 |
| 2 White | Brightness: same at 2700 K; kelvin white barely brighter at 6500 K | Medium | The advantage of kelvin white is **accurate color**, not brightness |
| 2 White | Kelvin sweep: no change below 2700 K or above 6500 K | Medium | Read as the firmware clamping to **2700–6500 K** |
| 2 White | Up close, what warm white is made of: can't tell | — | Not needed: it matches the app |
| 2 White | RGB and tint bytes varied (5 ways): **no difference** | High | With kelvin ≠ 0 the firmware ignores RGB and tint |
| 3 Off | Only RGB 0 + kelvin 0 is dark; **brightness 0 looks the same as 1 %** | High | Agrees with round 1 (both "dark" groups there had RGB 0) |
| 4 Glide | Brightness and color jumps: **short glide (< 0.5 s)** | Medium | Explains round 1's "smooth at 10/s" |
| 4 Resend | Re-sending the same state: nothing visible | High | |
| 5 Switch | Per-LED → segments is clean (a smooth glide to white) for **all three orders A, B and C** | Medium–high | Notes on every variant: "smooth blue to white", "initial flash from white to blue" |
| 5 Switch | **The flash is when entering per-LED** (white → blue), not when returning | Medium | Contradicts round 1, which put the flash on the return. Likely a mix-up there: the hard per-LED cut looks like a flash next to the firmware glide. *What* flashes (a hard cut, or a brief other color) still needs confirming |
| 5 Switch | Variant B: segment frames sent while per-LED was on **applied straight away** (went warm white during the pause) | Medium | A12 is false: segment commands override razer streaming |
| 6 App | A segment command stopped a running app scene; warm white everywhere | High | |
| 6 App | LAN brightness 50 clearly dims segment output | High | The strip's brightness scales segment mode too |

## Where things stand (rounds 1 + 2)

### Established

- **Transport:** `ptReal` over UDP 4003, BLE frames `33 05 15 01 RR GG BB KH KL TR TG TB <mask>` and
  `33 05 15 02 <pct> <mask>`; 3-byte mask, LSB first; several frames per datagram apply in order
  (6 at once tested).
- **Geometry:** each mask bit drives a **group of 4 LEDs**: 15 groups on this 60-LED strip.
- **White:** kelvin white is the strip's real white and matches the Govee app at 2700 K and 6500 K.
  Range 2700–6500 K. With kelvin set, the RGB and tint bytes are ignored. RGB-mixed white has
  about the same brightness, but the wrong tint.
- **RGB and brightness** per group, both 1–100 %. A group switches between white and RGB cleanly.
- **Off** = RGB 0 + kelvin 0. Brightness 0 is clamped to the 1 % minimum.
- **Firmware glide:** every change glides over < 0.5 s. A true instant snap isn't possible in segment mode.
- **Holding:** no keepalive needed (≥ 3 min), survives `turn off`/`turn on`, re-sending the same state is invisible.
- **Govee app:** a segment command ends a running scene. LAN `brightness` scales segment output.
- **Switching:** back to segments is clean in any order. Segment commands take effect even while razer is enabled.

### Still open

| Question | Why it matters | How to settle |
|---|---|---|
| ~~Entering per-LED: hard cut or wrong color?~~ | **Answered: just the abrupt instant cut** (white → blue). No mitigation needed | — |
| Strips with more than 24 groups, or group sizes other than 4 | Not testable here; the house strip is the priority | Plan treats them as unsupported: per-LED with reason `too_many_groups` |
| More than 6 frames per datagram | Packing worst case (15 different looks) | Pack ≤ 6 per datagram; no test needed |
| Power cycle mid-state (A18), 24 h soak | Robustness | Acceptance checklist |

### Assumption status

| ID | Status |
|---|---|
| A1, A2, A4, A5, A7, A9, A10, A13, A15, A16 | ✅ Confirmed |
| A3 Real white | ✅ Confirmed at both ends (matches the app) |
| A6 Off | ✅ RGB 0 + kelvin 0 (brightness 0 is not off) |
| A8 Update rate | ⚠️ Firmware glides < 0.5 s on every change; stepping at 10/s looks smooth |
| A11 Switch flash | ✅ Return is clean; entering per-LED is an instant hard cut (accepted) |
| A12 Segments ignored during razer | ❌ False: they apply. The invariant "no segment frames while held per-LED" now prevents real glitches, not just waste |
| A14 Segment layout | 🔁 Replaced: 4-LED groups (15 here) |
| A17 Kelvin range | ✅ 2700–6500 K |
| A18 Power cycle | Open (acceptance checklist) |
| A19 Mask size | Out of scope: > 24 groups fall back to per-LED |

### Impact on the plan (cumulative)

| Plan area | Change |
|---|---|
| Data model (§2.2) | `segmentCount` → **`groupSize`** (LEDs per mask bit, default 4). Groups = ⌈ledCount / groupSize⌉, at most 24 until wider masks are tested. Longer strips: segment control disabled (per-LED only) with a clear reason. |
| Geometry and rounding (§3.1) | Same rules on 4-LED groups; rounding moves an edge by at most 2 LEDs. |
| `ct` lights and MQTT (§2.1, §3.7) | Discovery range **2700–6500 K** (was 2000–6535). Clamp commands to it. |
| Encoding (§3.4) | White = kelvin with RGB and tint zero (they're ignored; zero is simplest). Off = RGB 0 + kelvin 0. Brightness 1–100; a lit group is never sent 0. Up to 6 frames per datagram. |
| Fades (§3.4) | Keep stepping at 10/s, since the firmware's glide smooths the steps. Transition 0 still glides < 0.5 s in segment mode: document it rather than work around it. |
| Switching (§3.3) | Return to segments: no special ordering or dwell needed (R6 simplified). Entering per-LED (R8): an instant hard cut, accepted. R5 (no switch mid-fade) stays. |
| Invariant I2 | Now essential: a segment frame sent while held per-LED would visibly override the stream. Segment and razer sends stay on separate coalesce keys, and a switch flushes the other kind. |
| Brightness pin | Keep `brightness 100` on entry and every 30 s in **both** modes: LAN brightness scales segment output, so a change in the Govee app would otherwise dim everything. |
| Release / un-release | Confirmed: on un-release, sending our state takes over from an app scene. |
| Per-LED white | RGB-mixed white is about as bright, but the wrong tint. The UI says "approximate white", not "dimmer". |
| Idle behaviour | Removed: all off → `turn_off`. Groups hold by themselves, so `hold_black` is unnecessary, and `release`-when-idle can't bring back a scene in group mode |
| Capabilities | `dimmable` removed too: `rgb` and `ct` include brightness |
| UI wording | "Groups of 4 LEDs", never "segments", to avoid confusion with the Govee app. |

The plan has been rewritten around these results ([`segment-mode-plan.md`](segment-mode-plan.md) §1 lists them as facts F1–F14).

---

## Round 3: parking (2026-11-15)

File: `data/probe-r3-2026-11-15T20-39-57-991Z.json`. Only the first 4 groups were watched.
Green = old stored state, blue = per-LED, warm white = parked look.

| Test | Observation | Confidence | Notes |
|---|---|---|---|
| 1 Park | Sequence `turn off` (razer still on) → `disable` → park warm white: the strip **glided smoothly to warm white and stayed on** | High (outcome), medium (cause) | **`turn off` while razer is enabled doesn't stick** (F15). Either it's ignored during razer, or `disable` powers the strip back on; the fix is the same. Green (the stored state revealed by `disable`) may have shown for a moment and been lost in the glides |
| 1 Park | Turn-on (LAN) showed warm white | Low | The strip was already on, so this doesn't test turn-on. Frames-while-off is covered by round 1 (F10) |
| 2 Revert | Per-LED blue with frames stopped (no `disable`): **stayed blue for the full 120 s** | High | **No revert within 120 s** (F16). CLAUDE.md's "reverts ~60 s after the last frame" doesn't hold on this strip, at least not within 2 minutes |
| 2 Revert | `disable` at the end → warm white (the stored groups) | High | Agrees with round 2: `disable` reveals the stored group state |

### What changes

- **Turn-off order** (plan §3.5a, R10): darken the groups over the stream → `disable` → `turn_off` →
  park while off. Built from verified pieces (F14, F15, F10); the full sequence is acceptance
  check H4b.
- **No parking on per-LED entry.** Per-LED holds its last frame ≥ 120 s, so a crash freezes the
  last frame instead of reverting.
- Per-LED keepalive stays (2 s): cheap, and the real revert time is unknown.

### Still open

| Question | Handling |
|---|---|
| Does per-LED revert at all, and after how long? | Not needed for the design. Could be checked with a longer wait (10+ min) if it ever matters |
| The full R10 turn-off sequence on hardware | Acceptance checks H4b and H5 |

---

## Local test with the service (2026-11-15)

Running the new service against the strip (`pnpm dev`, no MQTT):

| Observation | Meaning |
|---|---|
| Turning off the last light (with a fade): it dimmed down, then **came back on**; it sometimes turned off "randomly" later | The service sent `turn off`, then the parked look. **Segment frames sent to a strip that is off turn it back on**, apparently while its power state stays off, so the firmware later turns it dark. Round 1 test 5a and round 3 test 1 are both consistent with this; they were misread as "stored silently" and "turn off doesn't stick during razer" |
| Ctrl-C (group mode sends nothing on shutdown): the light stayed on, then changed when the service restarted | Likely the same half-off state left behind by an earlier turn-off; to re-check after the fix |

Fix: parking is dropped, and nothing is sent after `turn off` (plan §3.5a, invariant I7). Round 3's
F15 ("turn off doesn't stick while razer is enabled") is unproven: the park frames that followed
may be what turned it back on. R10 keeps `turn_off` after `disable` anyway, which is safe either way.

### Follow-up: the "random" turn-offs were the prod instance (2026-11-15)

A debug log of a local run (`data/debug.log`) showed govee-zones never sent `turn off`, yet the strip
kept going dark about once a minute, even with the local instance released. The cause was the prod
instance: its web UI said "released", but it wasn't (HA's Release switch disagreed, and toggling it
in HA changed prod's mode), so prod kept driving the strip with its old `hold_black` behavior
(black razer frames, which override group output). So:

- The random turn-offs, and the "came back briefly, then off" results with the Govee app, were
  prod. They say nothing about the strip's firmware or about govee-zones.
- The first observation ("dimmed down, then came back on") is still most likely our park frames
  after `turn off` (F10); not sending anything after `turn off` (I7) stays either way. Re-check it
  once prod is out of the way.
- The UI/HA mismatch couldn't be reproduced in the current code (`test/mqtt.test.ts` covers a
  Release from the web UI reaching HA, including after a reconnect). Watch for it after redeploying.
