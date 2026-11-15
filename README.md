# govee-zones

Split one Govee RGBIC strip (e.g. H805A Permanent Outdoor Lights Elite) into independent **virtual lights**, controlled fully locally over the LAN "razer"/DreamView streaming protocol. See [`SPEC.md`](SPEC.md) for the full design.

> **Status:** the web UI, compositor, streaming lifecycle, MQTT / Home Assistant bridge, protocol CLI and Docker packaging are implemented. Without `MQTT_HOST` the service runs with the web UI only.

## Requirements

- Node 22.12+ (the repo pins Node 24 via Volta)
- pnpm

## Running locally

```sh
pnpm install
pnpm dev:sim      # simulate: logs datagrams instead of sending UDP
pnpm dev          # real UDP to your strip(s)
```

Open http://localhost:5173 (Vite dev server; it proxies `/api` and `/ws` to the backend on `WEB_PORT`, default 8080). Dev data is stored in `./data`.

Production-style:

```sh
pnpm build
DATA_DIR=./data node dist/server/server/main.js   # UI served on http://localhost:8080
```

## Docker

The image is a multi-stage `node:24-alpine` build that serves the UI on container port 8080 and keeps everything in `/data`. The compose example and Unraid template map it to host port **8737**, to avoid the usual 8080 clashes. It includes a healthcheck that polls `/healthz`. Bridge networking is fine: the container only sends UDP to `<strip-ip>:4003` and never binds UDP 4002. No UDP ports need to be published.

```sh
docker compose up -d --build     # uses docker-compose.yml; edit the MQTT settings first
# or
docker build -t govee-zones .
docker run -d --name govee-zones -p 8737:8080 -v ./data:/data \
  -e MQTT_HOST=192.168.1.10 -e MQTT_USERNAME=… -e MQTT_PASSWORD=… govee-zones
```

`docker stop` sends SIGTERM, and the service exits streaming on each strip before stopping. Keep the stop timeout at 10 s or more.

**Published image.** `.github/workflows/docker.yml` runs typecheck and tests, then pushes `ghcr.io/evilkanoa/govee-zones` for amd64 and arm64. It tags `latest` from `main`, plus `vX.Y.Z` tags and `sha-…`. GHCR packages start out private: make the package public (GitHub → Packages → govee-zones → Package settings) or `docker login ghcr.io` on the host before pulling.

### Unraid

The image must be pullable first (see *Published image* above). Give each strip a static DHCP lease, because devices are configured by IP.

**With the template**

1. Copy `unraid/govee-zones.xml` to `/boot/config/plugins/dockerMan/templates-user/` on the server. If the repo is public, this does it:
   ```sh
   wget -O /boot/config/plugins/dockerMan/templates-user/my-govee-zones.xml \
     https://raw.githubusercontent.com/EvilKanoa/govee-zones/main/unraid/govee-zones.xml
   ```
2. Go to *Docker → Add Container*, then open the **Template** dropdown and pick **govee-zones** under *User templates*.
3. Fill in the MQTT host, username and password. The port (8737) and appdata path (`/mnt/user/appdata/govee-zones`) are prefilled. The discovery prefix, base topic, log level and simulate options are under *Show more settings*.
4. *Apply*. The web UI is at `http://<unraid-ip>:8737`. The container's WebUI menu entry links there too.

**Without the template**

Go to *Docker → Add Container* and fill in the fields by hand:

| Field | Value |
|---|---|
| Name | `govee-zones` |
| Repository | `ghcr.io/evilkanoa/govee-zones:latest` |
| Network Type | `bridge` |
| WebUI | `http://[IP]:[PORT:8080]/` |
| Extra Parameters | `--stop-timeout 10` (time to exit streaming cleanly) |

Then use *Add another Path, Port, Variable, Label or Device* for each of these:

| Config type | Name | Container side | Host side / value |
|---|---|---|---|
| Port (TCP) | Web UI | `8080` | `8737` |
| Path (read/write) | Data | `/data` | `/mnt/user/appdata/govee-zones` |
| Variable | MQTT host | `MQTT_HOST` | your broker's IP or hostname |
| Variable | MQTT port | `MQTT_PORT` | `1883` |
| Variable | MQTT username | `MQTT_USERNAME` | (if your broker needs one) |
| Variable | MQTT password | `MQTT_PASSWORD` | (if your broker needs one) |

`MQTT_DISCOVERY_PREFIX`, `MQTT_BASE_TOPIC`, `LOG_LEVEL` and `SIMULATE` are optional. The defaults are in the Environment table below. *Apply*, then open `http://<unraid-ip>:8737`. You can also run `docker run` from the Unraid terminal (see above), but the container then won't appear as editable in the Docker tab.

### Moving from a local dev instance

Use *Export* in the web UI of the instance you've been testing, then *Import* into the container. IDs are preserved, so the HA entities carry over. Stop the dev instance first if it uses the same `MQTT_BASE_TOPIC`. House photos aren't included in the export. Copy `data/backgrounds/*.jpg` into the appdata `backgrounds/` folder if you want them.

### Environment

| Var | Purpose | Default |
|---|---|---|
| `MQTT_HOST` | Broker host or URL (`mqtt://`, `mqtts://`, `ws://`). The bridge is disabled when unset. | — |
| `MQTT_PORT` | Broker port | `1883` |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | Broker auth | — |
| `MQTT_DISCOVERY_PREFIX` | HA discovery prefix | `homeassistant` |
| `MQTT_BASE_TOPIC` | Topic root | `govee-zones` |
| `WEB_PORT` | Web UI / API port | `8080` |
| `DATA_DIR` | Persistent storage | `/data` (`./data` in `pnpm dev`) |
| `LOG_LEVEL` | `debug` shows every frame in simulate mode | `info` |
| `SIMULATE` | Log datagrams instead of sending | `false` |

## Home Assistant (MQTT)

Set `MQTT_HOST` (and credentials, if any) and the service announces itself through MQTT Discovery. Nothing needs to be configured in HA. To try it against your real broker before deploying:

```sh
MQTT_HOST=192.168.x.x MQTT_USERNAME=… MQTT_PASSWORD=… pnpm dev
```

The topbar shows an **MQTT** dot (green when connected). Each strip becomes one HA device with:

- **One light per virtual light**, using the JSON schema. Supported modes follow the light's capability: `onoff`, `brightness`, `rgb`, or `rgb` + `color_temp` (in kelvin, 2000–6535 K). Transitions are honoured.
- A **Release to Govee** switch (config). ON stops streaming so the Govee app or govee2mqtt can take over. Commands are still stored.
- A **Mode** sensor (diagnostic): `streaming`, `idle`, `released` or `error`. The error message is available as an attribute.

Topics, with `<base>` = `MQTT_BASE_TOPIC`:

| Topic | Payload |
|---|---|
| `<base>/status` | `online` / `offline` (retained; LWT) |
| `<base>/light/<id>/set` · `/state` | HA JSON-schema command / retained state |
| `<base>/device/<id>/release/set` · `/state` | `ON` / `OFF` |
| `<base>/device/<id>/status` | `{"mode":…,"error":…,"sent_colors":…}` (retained) |
| `<prefix>/<component>/<base>/<id>/config` | discovery |

Renaming, editing or deleting a light in the UI updates or removes its HA entity. When the service starts, it also clears retained discovery configs under its node id for anything that no longer exists. Entity IDs come from the light/device IDs, so **export your config and import it on the deployed instance** to keep the same HA entities. Only run one instance per `MQTT_BASE_TOPIC` at a time. For a throwaway test, use a different base topic (e.g. `govee-zones-dev`) and delete that HA device afterwards.

## Using the web UI

Works on phones (touch drag-select and brush-select, ▲▼ priority buttons).


1. **Devices** → *Add strip*: name, IP (use a static DHCP lease), LED count. *Test* runs a chase.
2. Open the strip. Each cell is one LED: the top shows the live output, the bottom bar shows which light(s) own it (striped where lights overlap).
3. Drag across cells to select (shift-drag to add), then *New light from selection* or add/remove the selection from an existing light.
4. **Identify** flashes a light's LEDs on the real strip. **Pixel finder** lights a single LED when you click a cell — use these to map indices to positions on the house.
5. Reorder lights by dragging, or with ▲▼ on touch screens; the top of the list wins where lights overlap.
6. **House view** (toggle *Strip / House*): *Edit outline*, optionally *Add house photo*, then tap along the roofline in LED order. LEDs are spread evenly between points; tap a point to pin it to its real LED number (find corners with the pixel finder). In the house view, drag to brush-select LEDs. The photo is stored in `DATA_DIR/backgrounds/` and isn't included in exports.
7. **Release to Govee** stops streaming so the Govee app / govee2mqtt can run scenes. Light changes made while released are saved and applied when you turn it off again.
8. *Export* / *Import* back up the device and light configuration as JSON.

## Protocol CLI (hardware verification)

```sh
pnpm cli fill 255 180 100 --ip 192.168.1.50 -n 60   # hold a color until Ctrl-C
pnpm cli pixel 12 --ip 192.168.1.50 -n 60
pnpm cli chase --ip 192.168.1.50 -n 60
pnpm cli enable|disable|on|off --ip 192.168.1.50
pnpm cli --help
```

Open questions to check against the real strip (SPEC §9):

1. **Max colors per packet** — assumed 84 (single-byte length). Only matters for strips longer than 84 LEDs.
2. **How fewer colors map onto more LEDs** — `fill`/`pixel` with `-n` smaller than the LED count.
3. ~~**Brightness**~~ — verified: the strip's own brightness scales razer output, so the service sets it to 100 when streaming starts. As a result, scenes after *Release to Govee* run at 100%.
4. **Does razer need `turn` on first?** — compare with `--no-turn` while the strip is off.
5. **Power cycle mid-stream** — the service re-sends `enable` every 30 s while streaming; check whether that's needed/enough.
6. **Keepalive** — default 2 s.

## Behavior notes

- **Whites are mixed from RGB.** Razer mode can't drive the strip's white LEDs, so whites are dimmer than Govee's own and may look tinted. Use the strip page's *White balance* panel to correct the tint: show the test white, then toggle *Release to Govee* to compare against Govee's white.
- Never binds UDP 4002, so it coexists with govee2mqtt on the same host. Devices are configured by IP only.
- While this service is streaming, **govee2mqtt's reported state for the strip will be wrong**, and govee2mqtt effects are overwritten within one keepalive. Use *Release to Govee* for scenes.
- When all lights turn off, each strip follows its *When all lights are off* setting: turn the strip off (default), hold black (stay in streaming mode), or release to the Govee app.
- On startup, lights that were on resume streaming. A strip that was idle is left alone (nothing is sent), so a restart doesn't kill a Govee scene.
- On clean shutdown (SIGINT/SIGTERM) every streaming strip exits explicitly. If the process crashes, the strip reverts to its Govee app effect within ~60 s.

## Development

```sh
pnpm test         # unit tests (vitest)
pnpm typecheck    # server + web
```
