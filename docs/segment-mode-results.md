# Segment mode: hardware results

Results from `pnpm cli probe` against the real strip, what they establish, what is still open,
and how they change [`segment-mode-plan.md`](segment-mode-plan.md). Raw answer files are in
`data/probe-*.json` (not committed).

Strip: H805A at 192.168.2.27, configured as 60 LEDs.

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

## Round 2

Not run yet: `pnpm cli probe --round 2 --ip 192.168.2.27`.
