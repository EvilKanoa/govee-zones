# govee-zones

Split one Govee RGBIC light strip into several independent lights for Home Assistant, controlled entirely over your local network.

Permanent outdoor lights such as the Govee H805A usually run as one long strip. govee-zones lets you draw zones on it (front porch, garage, gutter, accents) and exposes each zone as its own light in Home Assistant, with on/off, brightness, color or color temperature. Zones can overlap and have priorities. A web UI lets you pick zones on a picture of your house.

- **Fully local.** It talks to the strip over the Govee LAN API. No cloud, no account.
- **Real white.** It drives the strip with the same segment commands the Govee app uses, so white comes from the strip's dedicated white LEDs and matches the Govee app (2700–6500 K).
- **Holds its own state.** In normal operation the strip keeps showing your lights even if govee-zones restarts or stops.
- **Home Assistant via MQTT Discovery.** It needs no YAML: each strip shows up as a device, with one light entity per zone.
- **Web UI that works on phones.** Select LEDs on a strip view or on a traced outline over a photo of your house.

> govee-zones is an unofficial project and isn't affiliated with Govee. It uses undocumented LAN commands, so firmware updates could change how they behave.

## Contents

- [What you need](#what-you-need)
- [How it works](#how-it-works)
- [Install](#install)
- [Set up your strip](#set-up-your-strip)
- [Home Assistant](#home-assistant)
- [Configuration](#configuration)
- [Behavior and limitations](#behavior-and-limitations)
- [Troubleshooting](#troubleshooting)
- [Upgrading](#upgrading)
- [Development](#development)

## What you need

- **A Govee RGBIC strip with LAN control.** Developed and tested on the **H805A Permanent Outdoor Lights Elite** (60 LEDs). Other RGBIC models with LAN control may work. If group control doesn't behave on yours, use the *Per-LED only* setting described below.
- **LAN Control turned on** for the strip in the Govee Home app (device settings).
- **A fixed IP address for the strip.** Give it a static DHCP lease in your router; govee-zones is configured by IP and doesn't scan the network.
- **A Docker host** (or Node.js 22.12+ to run it directly).
- **Optional: an MQTT broker and Home Assistant.** Without MQTT, the service runs with the web UI only.

## How it works

The strip understands two local commands, and govee-zones picks one per strip automatically:

| | **Groups** (normal mode) | **Per-LED** (fallback) |
|---|---|---|
| Resolution | Groups of LEDs (4 on the H805A) | Single LEDs |
| White | The strip's real white, matching the Govee app | Mixed from RGB: about as bright, slightly off-color |
| If govee-zones stops | The lights stay as they are | The strip freezes on its last frame |
| Changes | Glide over about half a second (strip firmware) | Instant |

Group mode is used whenever it can be. A zone that doesn't line up with the groups is rounded to whole groups by default: its edges move by at most 2 LEDs, and the UI shows exactly how. Per-LED mode is only used:
- for the pixel finder and test chase,
- for zones you set to *Use exact LEDs*,
- for strips set to *Per-LED only*,
- for strips with more than 24 groups (wider strips haven't been tested).

The web UI always shows which mode a strip is in, and why.

## Install

### Docker Compose

```yaml
services:
  govee-zones:
    image: ghcr.io/evilkanoa/govee-zones:latest
    container_name: govee-zones
    restart: unless-stopped
    ports:
      - "8737:8080"          # web UI on http://<host>:8737
    environment:
      MQTT_HOST: 192.168.1.10   # leave out to run without Home Assistant
      MQTT_USERNAME: ""
      MQTT_PASSWORD: ""
    volumes:
      - ./data:/data
    stop_grace_period: 10s
```

```sh
docker compose up -d
```

The repo's [`docker-compose.yml`](docker-compose.yml) builds from source instead and adds a healthcheck. No UDP ports need to be published: the container only sends to `<strip-ip>:4003`, so bridge networking works. It never binds UDP 4002, so it can run on the same host as other Govee LAN tools.

### docker run

```sh
docker run -d --name govee-zones --restart unless-stopped \
  -p 8737:8080 -v ./data:/data --stop-timeout 10 \
  -e MQTT_HOST=192.168.1.10 -e MQTT_USERNAME=… -e MQTT_PASSWORD=… \
  ghcr.io/evilkanoa/govee-zones:latest
```

Images are published for amd64 and arm64: `latest` from `main`, plus `vX.Y.Z` and `sha-…` tags.

### Unraid

1. Download the template to the server:
   ```sh
   wget -O /boot/config/plugins/dockerMan/templates-user/my-govee-zones.xml \
     https://raw.githubusercontent.com/EvilKanoa/govee-zones/main/unraid/govee-zones.xml
   ```
2. *Docker → Add Container*, then pick **govee-zones** under *User templates*.
3. Fill in the MQTT host and credentials. The port (8737) and appdata path (`/mnt/user/appdata/govee-zones`) are prefilled; the other settings are under *Show more settings*.
4. *Apply*, then open `http://<unraid-ip>:8737`.

<details>
<summary>Without the template</summary>

*Docker → Add Container*:

| Field | Value |
|---|---|
| Repository | `ghcr.io/evilkanoa/govee-zones:latest` |
| Network Type | `bridge` |
| WebUI | `http://[IP]:[PORT:8080]/` |
| Extra Parameters | `--stop-timeout 10` |
| Port (TCP) | container `8080` → host `8737` |
| Path | container `/data` → `/mnt/user/appdata/govee-zones` |
| Variables | `MQTT_HOST`, `MQTT_PORT` (1883), `MQTT_USERNAME`, `MQTT_PASSWORD` |

</details>

### Without Docker

```sh
pnpm install
pnpm build
DATA_DIR=./data node dist/server/server/main.js   # web UI on http://localhost:8080
```

## Set up your strip

1. **Add the strip.** *Devices → Add strip*: a name, its IP address and its LED count. Leave *LEDs per group* at 4 for the H805A. *How control works* on the Devices page explains the settings. *Test* runs a chase along the strip, so you can confirm it's reachable.
2. **Make zones.** Open the strip and drag across the LEDs. Selections snap to whole groups; tick *Fine* to pick single LEDs. Then click *New light*. Each light becomes one Home Assistant entity.
3. **Pick a type for each light** (*Edit*):
   - **White**: color temperature and brightness, using the strip's real white. This is the usual choice for everyday lighting.
   - **RGB**: any color and brightness.
   - **On/off**: always the same look (a color or a white), switched on and off.
4. **Map it to your house** (optional). Switch to *House*, choose *Edit outline*, optionally add a photo, and tap along the roofline in LED order. Use *Pixel finder* to find which LED is at each corner, and pin those points to their LED numbers.
5. **Check it.** *Identify* blinks a light on the real strip. Dividers in both views mark the groups. If a zone doesn't line up with them, arrows show which way each edge moves when it's rounded, and *As set / Rounded* compares the two.

Where zones overlap, the one higher in the light list wins. Drag lights to reorder them, or use ▲▼ on a phone.

## Home Assistant

Set `MQTT_HOST` (and credentials, if your broker needs them). govee-zones then announces itself through MQTT Discovery; nothing needs to be configured in Home Assistant. A dot in the web UI's top bar shows the MQTT connection.

Each strip becomes one device with:

- **One light per zone** (JSON schema), with modes matching its type: On/off, RGB with brightness, or White (`color_temp` in kelvin, 2700–6500 K) with brightness. Transitions are honored.
- **Release to Govee** switch: hands the strip back to the Govee app (for its scenes and effects). Light changes are still saved and apply when you turn it off.
- **Mode** sensor: `groups`, `per_led`, `idle`, `released` or `error`. The `reason` and `detail` attributes say why.

Renaming or deleting a light updates or removes its entity. Entity IDs come from the light IDs, so use *Export* / *Import* in the web UI to move a setup between instances without losing your entities.

<details>
<summary>MQTT topics</summary>

With `<base>` = `MQTT_BASE_TOPIC`:

| Topic | Payload |
|---|---|
| `<base>/status` | `online` / `offline` (retained; last will) |
| `<base>/light/<id>/set` · `/state` | HA JSON-schema command / retained state |
| `<base>/device/<id>/release/set` · `/state` | `ON` / `OFF` |
| `<base>/device/<id>/status` | `{"mode":…,"reason":…,"detail":…,"error":…,"groups":…}` (retained) |
| `<prefix>/<component>/<base>/<id>/config` | discovery |

</details>

## Configuration

All settings are environment variables. Everything else is configured in the web UI and stored in `DATA_DIR`.

| Variable | Purpose | Default |
|---|---|---|
| `MQTT_HOST` | Broker host or URL (`mqtt://`, `mqtts://`, `ws://`). Without it, MQTT is off. | — |
| `MQTT_PORT` | Broker port | `1883` |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | Broker credentials | — |
| `MQTT_DISCOVERY_PREFIX` | Home Assistant discovery prefix | `homeassistant` |
| `MQTT_BASE_TOPIC` | Topic root; use a different one per instance | `govee-zones` |
| `WEB_PORT` | Web UI / API port inside the container | `8080` |
| `DATA_DIR` | Config, light state and house photos | `/data` |
| `LOG_LEVEL` | `info`, or `debug` to log every command sent | `info` |
| `SIMULATE` | `true` logs commands instead of sending them | `false` |

## Behavior and limitations

- **All lights off turns the strip off.** Turning it back on from the Govee app shows whatever govee-zones last sent (after a fade-out, that's very dim).
- **While any light is on, govee-zones keeps the strip as you set it.** Every 30 s it re-sends the current state, so changes made in the Govee app (power, brightness, scenes) are undone. With every light off it sends nothing, and the app works normally. To use the app while lights are on, turn on **Release to Govee** first.
- **Restarts don't blink the lights.** At startup, strips whose lights were on pick up where they left off, and idle strips are left alone. On a clean shutdown, group mode sends nothing; per-LED mode exits and turns the strip off.
- **Per-LED white is approximate.** In group mode white is the strip's own. In per-LED mode it's mixed from RGB. *White balance* on the strip page corrects that mix: flip between *Show mixed white* and *Show real white* and adjust until they match.
- **Group changes glide** over about half a second. That's the strip's firmware, and it applies even with a transition of 0.
- **Untested hardware.** Strips with more than 24 groups (over 96 LEDs at 4 per group) automatically use per-LED control.
- **No state read-back.** govee-zones only sends commands. Changes made elsewhere aren't reflected in Home Assistant.

## Troubleshooting

- **Nothing happens.** Check that LAN Control is on in the Govee app and that the IP is right, then use *Test* on the Devices page. The error banner and the Mode sensor show send failures.
- **Lights turn off or change on their own.** Something else is controlling the strip. Common causes:
  - a second govee-zones instance (an old container, or a dev copy) that isn't released,
  - another Govee integration (e.g. govee2mqtt or a cloud integration) with automations or scenes,
  - a schedule in the Govee app.

  Run with `LOG_LEVEL=debug` to see every command govee-zones sends. If the strip changes without a matching log line, the change came from elsewhere.
- **Two instances on one broker.** Only run one instance per `MQTT_BASE_TOPIC`: they would answer the same Home Assistant commands. Use a different base topic for testing.
- **A zone looks slightly off its edges.** It's being rounded to groups. The strip view shows how; use *Fine* selections to line it up with the dividers, or set the strip to *Use exact LEDs* (that zone then uses per-LED control while it's on).

## Upgrading

Configs from older versions are converted automatically on startup. The original is kept beside it as `govee-zones.json.pre-groups-<time>.bak`, and the log lists every change:

- On/off and RGB lights keep their type and color.
- `dimmable` lights become RGB. `rgb_ct` lights become White (if their default was a color temperature) or RGB.
- The "When all lights are off" setting is dropped; the strip now always turns off.

Older exports are converted the same way when you import them. To use the strip's real white on a converted light, set its look to *White* in its editor.

## Development

Requires Node.js 22.12+ and pnpm.

```sh
pnpm install
pnpm dev:sim     # backend + UI on http://localhost:5173, logging commands instead of sending them
pnpm dev         # the same, sending real UDP; uses ./data and writes ./data/debug.log
pnpm test        # unit tests (Vitest)
pnpm typecheck   # server + web
pnpm build       # dist/web + dist/server
```

`pnpm cli` has tools for checking hardware directly. These include a guided probe for group control (`pnpm cli probe --round 2 --ip <ip>`) and raw group commands (`pnpm cli seg white 1-2 2700 --ip <ip>`); see `pnpm cli --help`.

Design notes:
- [`SPEC.md`](SPEC.md): the original design.
- [`docs/segment-mode-plan.md`](docs/segment-mode-plan.md): group control.
- [`docs/segment-mode-results.md`](docs/segment-mode-results.md): the hardware findings behind it.
- [`docs/segment-mode-testing.md`](docs/segment-mode-testing.md): test plan and probe.
