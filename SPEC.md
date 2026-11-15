# govee-zones — Handoff Spec

> Working name; rename freely. This document is the brief for building the project from scratch.

## 1. Goal

Treat portions of a single Govee RGBIC permanent-light strip as **independent virtual lights** in Home Assistant, controlled **fully locally**.

Example: the LEDs above the front door act as "Front door accent" and turn on with the porch light. The run along the back acts as "Back accent" and turns on with the back porch lights. The rest of the roofline stays dark, or shows a low-priority base look.

Govee's official LAN API only controls the whole strip, and its segment and snapshot features are cloud-only. This project instead uses the undocumented **"razer" / DreamView streaming protocol** over LAN, which allows per-LED control. It has been **tested and confirmed working on the target device** (Govee Permanent Outdoor Lights Elite, H805A) with the reference script in §10.

### Non-goals (v1)
- Animated effects or scenes (Govee's own app does these well; see §6 for handing control back).
- Cloud API usage of any kind.
- Replacing govee2mqtt. It stays installed for whole-strip scenes and snapshots; this service coexists with it.

## 2. Deployment

- **One Docker container**, run on **Unraid**.
- Persistent data in a mounted volume (Unraid appdata, e.g. `/mnt/user/appdata/govee-zones` → `/data`).
- Configured with environment variables:

| Var | Purpose | Default |
|---|---|---|
| `MQTT_HOST` | Broker host | required |
| `MQTT_PORT` | Broker port | `1883` |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | Broker auth | optional |
| `MQTT_DISCOVERY_PREFIX` | HA discovery prefix | `homeassistant` |
| `MQTT_BASE_TOPIC` | This service's topic root | `govee-zones` |
| `WEB_PORT` | Web UI port | `8080` |
| `DATA_DIR` | Persistent storage | `/data` |
| `LOG_LEVEL` | Logging | `info` |
| `SIMULATE` | Don't send UDP; log frames instead (for dev) | `false` |

- **Networking:** the container only needs **outbound UDP to `<strip-ip>:4003`**. Bridge networking is fine.
  - **Do not bind UDP 4002** by default. Govee devices reply to discovery and `devStatus` on 4002, and govee2mqtt on the same Unraid host already binds it. Configure devices by **manual IP** (with a static DHCP lease). LAN discovery can be an optional, off-by-default feature with a clear warning about the conflict.
- Include: `Dockerfile`, a `docker-compose.yml` example, a container healthcheck, and an Unraid template XML (nice-to-have).

## 3. Architecture

One process, four parts:

```
          ┌────────────┐   config CRUD / live preview (WebSocket)
 Browser ─┤  Web UI    ├──────────────┐
          └────────────┘              │
                                ┌─────▼──────┐
 Home Assistant ◄──MQTT──► MQTT │   State    │  persisted in DATA_DIR
                     bridge ───►│   Store    │
                                └─────┬──────┘
                                      │ on change + keepalive tick
                                ┌─────▼──────┐        UDP 4003
                                │ Compositor ├──► Streamer ──► Govee strip
                                └────────────┘
```

**Suggested stack** (Claude Code may propose an alternative with reasoning): TypeScript on Node, Fastify for HTTP and WebSocket, `mqtt.js`, SQLite (`better-sqlite3`) or a single JSON file for storage, and a small Vite + React (or Svelte) front end built into the image.

## 4. Data model

### Device (a physical strip)
| Field | Notes |
|---|---|
| `id`, `name` | |
| `ip` | static lease recommended |
| `ledCount` | number of addressable lights on the run |
| `maxColorsPerPacket` | default 84 (see §9); used for downsampling |
| `keepaliveMs` | default 2000 |
| `enabled` | master switch per device |

### Virtual light
| Field | Notes |
|---|---|
| `id`, `name` | name becomes the HA entity name |
| `deviceId` | which strip |
| `ranges` | list of inclusive LED index ranges, e.g. `[[0,9],[40,44]]` (non-contiguous allowed) |
| `priority` | integer; higher wins where ranges overlap |
| `capability` | per light: `onoff` \| `dimmable` \| `rgb` \| `rgb_ct` (see §5) |
| `defaults` | color/brightness used when the light is turned on without parameters, and the fixed look for `onoff` lights |
| `transitionMs` | default software fade (the razer protocol snaps instantly, so fades are done in software) |

### Runtime state (per virtual light, persisted)
`on`, `brightness` (0–255), `color` (RGB), `colorTemp` (mireds, if `rgb_ct`). Restore this on restart.

### Global / per-device runtime flags
- `streaming` — whether the device is currently held in razer mode.
- `released` — the user has handed the strip back to the Govee app (see §6).

## 5. MQTT / Home Assistant integration

- Use **HA MQTT Discovery** with the JSON schema light (`schema: json`).
- Group entities as **one HA device per strip**, with one light entity per virtual light.
- **Capability is configured per light** and drives the discovery payload:
  - `onoff`: on/off only; shows the configured default color and brightness.
  - `dimmable`: adds brightness.
  - `rgb`: adds brightness and RGB color.
  - `rgb_ct`: adds color temperature, approximated in RGB (the strip's white LEDs aren't addressable in this mode; see §9).
- Support the `transition` field on commands.
- Publish state as **retained** messages. Use an availability topic with a Last Will (LWT).
- Additional per-device entities:
  - `switch` **"Hold strip"** / **"Release to Govee"** (see §6)
  - `sensor` **mode**: `streaming` | `idle` | `released` | `error`
- When a light is deleted or edited in the UI, update or remove its discovery config (empty retained payload).

## 6. Streaming lifecycle (the "do we ever leave this mode?" question)

The strip only obeys razer frames while streaming mode is on. If no frame arrives for about 60 s, it drops back to its last Govee app effect, which may light the whole roofline. So the service must be deliberate about entering and leaving.

**Recommended policy (implement this, but keep it configurable):**

1. **Any virtual light on** → make sure the strip is powered (LAN `turn` on), send razer enable (`B1 01`), and stream the composite frame. Send immediately on any change, and on a keepalive tick (default every 2 s). The keepalive also overrides anything changed from the Govee app.
2. **All virtual lights off** → choose a behavior with a per-device setting `idleBehavior`:
   - `off` (default): send razer disable (`B1 00`), then LAN `turn` off. The strip goes dark.
   - `hold_black`: keep streaming an all-black frame (never leave the mode).
   - `release`: send razer disable and leave the strip alone, so the Govee app or govee2mqtt take over.
3. **"Release to Govee" switch on** → stop streaming (`B1 00`) regardless of virtual light states, and ignore light commands for rendering. Still accept and store them, so state is correct when hold resumes. This is the holiday-scenes mode. Turning it off resumes step 1 or 2.
4. **Never just stop sending frames** while lights are on. Always exit explicitly.
5. **On service start:** restore persisted states and apply the policy. On clean shutdown, apply the idle behavior.
6. **On crash:** the device reverts within about 60 s. Use a container restart policy.

Note this in the README: while streaming, govee2mqtt's reported state for the strip will be wrong, and firing govee2mqtt effects will be overwritten within one keepalive.

## 7. Compositor

Each render produces one RGB frame of `ledCount` pixels per device:

1. Start with all black.
2. Take the lights that are **on** for that device, sorted by `priority` ascending, and paint each one's ranges with its effective color (color × brightness, with any transition in progress interpolated). Higher priority paints last, so it wins.
3. Ties are broken by a stable order (creation order) so output is deterministic.
4. If `ledCount > maxColorsPerPacket`, downsample to the packet limit (see §9). Warn in the UI that resolution is reduced.
5. Software transitions: interpolate per light over `transitionMs` at roughly 20–40 fps, then fall back to keepalive-only sending when nothing is changing.

Keep the compositor a **pure function** (`(device, lights, states, now) → frame`) so it's easy to unit-test.

## 8. Web UI (LAN only, no auth needed in v1)

- **Devices page:** add or edit strips (name, IP, LED count, settings). Include a **"Test" button** that runs a short chase.
- **Strip editor (the core screen):**
  - Render the strip as a horizontal row of `ledCount` cells. It may wrap, and an outline of the house shape is a nice-to-have later.
  - Drag-select LEDs to create or assign ranges to a virtual light. Color-code each light.
  - Show overlaps clearly.
  - **"Identify" button** per light: flash its ranges on the real strip for a few seconds. This matters most for mapping indices to physical positions on the house.
  - A "pixel finder": click a cell to light that single LED on the real strip.
- **Lights list:** drag to reorder **priority**, and edit capability, defaults, and transition.
- **Live preview:** a WebSocket feed of the current composite frame, drawn on the strip view, plus the mode and streaming status.
- Manual on/off and color control per light, for testing without HA.
- Export and import the config as JSON (for backups).

## 9. Protocol reference & known unknowns

**Transport:** UDP JSON to `<ip>:4003`:
`{"msg":{"cmd":"razer","data":{"pt":"<base64>"}}}`

**Binary packet (base64-encoded into `pt`):**
`BB 00 <len> <cmd> <data…> <checksum>`, where the checksum is the XOR of all preceding bytes. Known-good: enable = `BB 00 01 B1 01 0A` → base64 `uwABsQEK`.

| cmd | data |
|---|---|
| `B1` | `01` enable / `00` disable |
| `B0` | `<gradient flag 0/1> <color count> <R G B>…` (use gradient = 0 for discrete pixels) |

**Standard LAN commands** (also to port 4003) for power: `{"msg":{"cmd":"turn","data":{"value":1}}}` (0 = off). Pace consecutive datagrams about 15 ms apart; the firmware is reported to drop back-to-back packets.

**Things to verify early on the real H805A** (build a small CLI or debug page for these):
1. **Max colors per packet.** The `len` byte caps the data at 255 bytes, so about 84 colors. Test whether the `00` byte is really the high byte of a 16-bit length, which would allow full per-LED control on a long run.
2. **How the device maps fewer colors than LEDs** in discrete mode (even stretch?). The downsampling logic depends on this.
3. Whether the LAN `brightness` command affects razer output, or whether brightness must be baked into the RGB values (assume baked in).
4. Whether razer mode needs `turn` on first, or turns the strip on by itself.
5. How the strip behaves after a power cycle mid-stream.
6. Whether a keepalive under 60 s is enough to hold reliably (target 2 s).

**Limitation:** razer mode is RGB only, so the strip's dedicated white LEDs are unused. Warm white is mixed from RGB.

## 10. Reference test script (confirmed working)

```python
import socket, json, base64, time
IP, N = "192.168.x.x", 60          # strip IP, LED count
def pkt(cmd, data):
    b = bytes([0xBB, 0x00, len(data), cmd, *data])
    c = 0
    for x in b: c ^= x
    p = base64.b64encode(b + bytes([c])).decode()
    return json.dumps({"msg":{"cmd":"razer","data":{"pt":p}}}).encode()
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.sendto(pkt(0xB1, [1]), (IP, 4003))           # enable
frame = [0]*(N*3)
for i in range(0, 10): frame[i*3:i*3+3] = [255,180,100]  # first 10 LEDs warm
while True:
    s.sendto(pkt(0xB0, [0, N, *frame]), (IP, 4003))
    time.sleep(2)
```

## 11. Testing expectations

- Unit tests: packet encoding and checksum (assert the known `uwABsQEK`), compositor priority and overlap, downsampling, transitions, and the lifecycle state machine (§6).
- `SIMULATE=true` mode, so the whole stack (UI + MQTT) runs without a strip.
- An integration test against a local Mosquitto container for discovery payloads and command handling.

## 12. Suggested build order

1. Protocol module + CLI (`enable`, `disable`, `fill`, `pixel`, `chase`) → run the §9 verification items against the real strip.
2. Storage + compositor + streamer loop + lifecycle, with tests.
3. MQTT discovery and command/state handling → verify in HA.
4. Web UI: devices, strip editor, identify, priorities, live preview.
5. Docker image, compose example, Unraid template, README.

## 13. Context / related setup

- Home Assistant already runs govee2mqtt (API-key mode, no account login) for whole-strip control and app snapshots. Keep it; use "Release to Govee" for holiday scenes.
- The HA-side automations ("front accent follows porch light") live in HA, not in this service.
- Sources used for the protocol: the OpenRGB Govee merge request (!2172), and the DMXCore Govee plugin (README describing realtime per-segment streaming and paced commands).
