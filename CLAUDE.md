# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

`SPEC.md` is the design brief, and everything in it is implemented. Without `MQTT_HOST`, the service runs with the web UI only. The web UI and the MQTT bridge both send HA JSON-schema `LightCommand`s through `Engine.command`.

## Commands

Node 22.12+ is required (Volta pins Node 24 in `package.json`); use pnpm.

- `pnpm dev:sim` — backend (tsx watch) + Vite UI on :5173 in simulate mode (UDP is logged, not sent). Data is stored in `./data`.
- `pnpm dev` — the same, but sends real UDP.
- `pnpm test` — Vitest. Single file: `pnpm vitest run test/engine.test.ts`. Single test: add `-t "name"`.
- `pnpm typecheck` — server (`tsconfig.json`, NodeNext, `.js` import suffixes) and web (`web/tsconfig.json`, bundler resolution).
- `pnpm build` → `dist/web` + `dist/server`. Run with `node dist/server/server/main.js`.
- `docker compose up -d --build` — the container (`Dockerfile`: build → prod deps → `node:24-alpine` runtime, healthcheck on `/healthz`). `.github/workflows/docker.yml` tests, then pushes multi-arch images to `ghcr.io/evilkanoa/govee-zones`. The Unraid template is `unraid/govee-zones.xml`.
- `pnpm cli <enable|disable|on|off|fill|pixel|chase> --ip <ip> -n <count>` — protocol CLI for hardware checks.
- `pnpm cli probe --ip <ip> --segments 5` — guided segment-mode hardware probe (`docs/segment-mode-testing.md`); `pnpm cli seg …` sends raw segment (`ptReal`) commands. `--dry` prints instead of sending.

## Layout

- `src/shared/` — types, color math, `groups` (group geometry: bounds, dividers, rounding) and `layout` (LED positions along a traced house outline), used by both server and web (no Node imports).
- `src/server/` — `protocol` (razer + segment/`ptReal` encoding), `compositor` (pure visuals + per-LED frame), `plan` (pure: group vs per-LED, per-group looks), `groupOutput` (looks → diffed segment datagrams, preview pixels), `lifecycle` (pure `decide()`, rules R1–R12), `commands` (pure HA command → state), `engine` (per-device tick loop, transitions, parking, identify/pixel/test overrides), `transport` (15 ms pacing with frame coalescing; simulate variant), `store` (single JSON file, atomic writes, emits `change`), `http` (REST + `/ws`), `mqtt` (HA bridge: discovery is diffed against what was published, so edits and deletes update or clear configs; stale retained configs under the node id are cleared on connect; HA's `color_temp` is in kelvin on the wire and mireds internally).
- `web/` — Vite + React UI. It gets the full state as a `snapshot` message over `/ws`, plus throttled full-resolution `frame` messages. `StripPage` owns the shared selection and the active tool, and renders either `StripView` or `HouseView` (SVG outline editor/brush select). Touch gestures use pointer capture plus hit-testing (`elementFromPoint` or SVG coordinates), never `pointerenter`.
- House photos are stored as `DATA_DIR/backgrounds/<deviceId>.jpg`, outside the JSON config. `device.layout.background` is a cache-busting version number.
- `test/` — unit tests. `engine.test.ts` drives the engine with fake timers and a recording transport. `mqtt.test.ts` runs the bridge against an in-process `aedes` broker, so no Mosquitto is needed.

## What this is

A single Docker service (deployed on Unraid) that splits one Govee RGBIC strip (target: H805A Permanent Outdoor Lights Elite) into **virtual lights** exposed to Home Assistant over MQTT Discovery. It is fully local. It drives per-LED color via the undocumented **"razer"/DreamView UDP protocol** on `<strip-ip>:4003`. It coexists with govee2mqtt and does not replace it.

Suggested stack (SPEC §3; alternatives are allowed with reasoning): TypeScript/Node, Fastify (HTTP + WebSocket), `mqtt.js`, SQLite or JSON-file storage in `DATA_DIR`, and a Vite + React/Svelte UI built into the image. Configuration comes from env vars (SPEC §2).

## Architecture (one process)

Web UI and MQTT bridge → **State Store** (persisted) → **Compositor** → **Streamer** → UDP to the strip.

- **Compositor** must stay a pure function `(device, lights, states, now) → frame`. It paints lights that are on in ascending `priority` order (ties broken by creation order) over black, applies brightness and in-progress software transitions, then downsamples if `ledCount > maxColorsPerPacket`.
- **Streamer** sends a frame immediately on change, then on a keepalive tick (default 2 s). During transitions it sends at roughly 20–40 fps. Pace datagrams about 15 ms apart, because the firmware drops back-to-back packets.
- **Group control** (`docs/segment-mode-plan.md`, evidence in `docs/segment-mode-results.md`) is the normal mode: segment commands (`ptReal`) per group of 4 LEDs, real white via the kelvin field, and the strip holds state. Per-LED razer streaming is the fallback for single-LED needs. `plan()` picks one per tick; `decide()` handles the transitions. Key hardware facts: group frames apply even while razer is enabled (never send them while per-LED is held, except `groups_dark` right before `disable`); `turn off` doesn't stick while razer is enabled; frames sent while the strip is off are stored silently.
- **Lifecycle state machine** is the subtle part. All lights off always turns the strip off and parks the last look (R10/R11); there is no idle-behavior setting. SPEC says razer reverts ~60 s after the last frame; on the H805A no revert was seen within 120 s. Per-LED mode still keeps its keepalive and always exits explicitly. "Release to Govee" stops driving the strip but still stores incoming light commands.
- Implementation decisions beyond the spec:
  - Fades interpolate per-light opacity rather than fading to black, so a high-priority light fading out reveals the lights underneath.
  - At startup an idle device gets no commands, so a restart doesn't kill a Govee scene.
  - On shutdown, group mode sends nothing (the lights stay); per-LED exits like all-off.
  - Group entry sends `brightness 100`, the frames, then `turn on`. Per-LED entry sends `turn on` → `brightness 100` → `enable`. The strip's own brightness scales both modes, so `brightness 100` is re-sent every 30 s (with `enable` per-LED, with the full group state in group mode).
  - Per-device `whiteBalance` gains are applied to sent frames only; the preview stays uncorrected. On the H805A, RGB 2700 K looked pinker than Govee's white-LED 2700 K.

## Gotchas

- `./data` (used by `pnpm dev`) is a throwaway dev config, not the deployed setup. The real config lives in `DATA_DIR` in the container on Unraid.
- `pino-pretty` is a devDependency. `main.ts` only loads it when stdout is a TTY and `NODE_ENV` isn't `production` (the image sets it), so `docker run -it` doesn't crash.
- Configs from before group control are converted at load by `src/server/migrate.ts` (pure; backup `*.pre-groups-*.bak` written by the store). Imports go through it too. New format changes need a migration step there.
- Zod 4 applies `.default()` inside `.partial()`. Patch schemas (`devicePatch`, `lightPatch`) must come from the default-free base shapes in `schemas.ts`, or a partial update silently resets every field it doesn't mention. `test/schemas.test.ts` guards this.

## Protocol essentials

- Datagram: `{"msg":{"cmd":"razer","data":{"pt":"<base64>"}}}`.
- Packet: `BB 00 <len> <cmd> <data…> <xor-checksum of all preceding bytes>`. `B1 01`/`B1 00` enables/disables streaming. `B0 <gradient=0> <count> <RGB…>` sends a frame.
- Known-good test vector: enable = `BB 00 01 B1 01 0A` → `uwABsQEK`. Unit tests must assert this.
- `len` is one byte, so a frame holds about 84 colors (`maxColorsPerPacket` default). Whether `00` is really a length high byte is still unverified (SPEC §9 lists open questions to test on hardware).
- Brightness is baked into RGB, on top of the device brightness pinned at 100. White LEDs aren't addressable in razer mode (frames are RGB only), so per-LED white is approximated in RGB.
- Segment frames: 20-byte BLE frames `33 05 15 01 RR GG BB KH KL TR TG TB <3-byte mask, LSB first>` (color; kelvin ≠ 0 = real white, RGB/tint ignored; off = RGB 0 + kelvin 0) and `33 05 15 02 <1-100> <mask>` (brightness; 0 clamps to 1 %), XOR checksum, base64 in `{"msg":{"cmd":"ptReal","data":{"command":[…]}}}`. ≤ 6 frames per datagram verified. White range 2700–6500 K.

## Hard constraints

- **Never bind UDP 4002 by default.** govee2mqtt on the same host already uses it. Devices are configured by manual IP. LAN discovery may only be an opt-in feature with a warning.
- No cloud API usage.
- `SIMULATE=true` must run the full stack (UI + MQTT) with frames logged instead of sent.
- HA entities: one HA device per strip, one JSON-schema light per virtual light. Capability per light (`onoff`/`rgb`/`ct`) drives the discovery payload. Also add per-device "Release to Govee" switch and `mode` sensor entities. State is retained, and availability uses an LWT. Deleting a light publishes an empty retained discovery payload.

## Open items

- Still unverified on hardware (SPEC §9): whether the strip recovers within the 30 s reassert after a power cycle mid-stream, and whether `00` in the packet header is a length high byte.
- White balance must be tuned per strip after deployment.

SPEC §10 has a Python reference script confirmed working on the real device.
