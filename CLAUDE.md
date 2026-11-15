# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

`SPEC.md` is the design brief. Everything is implemented except Docker packaging. Without `MQTT_HOST`, the service runs with the web UI only. The web UI and the MQTT bridge both send HA JSON-schema `LightCommand`s through `Engine.command`.

## Commands

Node 22.12+ is required (Volta pins Node 24 in `package.json`); use pnpm.

- `pnpm dev:sim` — backend (tsx watch) + Vite UI on :5173 in simulate mode (UDP is logged, not sent). Data is stored in `./data`.
- `pnpm dev` — the same, but sends real UDP.
- `pnpm test` — Vitest. Single file: `pnpm vitest run test/engine.test.ts`. Single test: add `-t "name"`.
- `pnpm typecheck` — server (`tsconfig.json`, NodeNext, `.js` import suffixes) and web (`web/tsconfig.json`, bundler resolution).
- `pnpm build` → `dist/web` + `dist/server`. Run with `node dist/server/server/main.js`.
- `pnpm cli <enable|disable|on|off|fill|pixel|chase> --ip <ip> -n <count>` — protocol CLI for hardware checks.

## Layout

- `src/shared/` — types, color math and `layout` (LED positions along a traced house outline) used by both server and web (no Node imports).
- `src/server/` — `protocol` (packet encoding), `compositor` (pure), `lifecycle` (pure `decide()`), `commands` (pure HA command → state), `engine` (per-device tick loop, transitions, identify/pixel/test overrides), `transport` (15 ms pacing with frame coalescing; simulate variant), `store` (single JSON file, atomic writes, emits `change`), `http` (REST + `/ws`), `mqtt` (HA bridge: discovery is diffed against what was published, so edits and deletes update or clear configs; stale retained configs under the node id are cleared on connect; HA's `color_temp` is in kelvin on the wire and mireds internally).
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
- **Lifecycle state machine** (SPEC §6) is the subtle part. The strip reverts to its Govee app effect about 60 s after the last frame, so the service must never just stop sending while lights are on. It must always exit explicitly (`B1 00`, then follow the per-device `idleBehavior`: `off` | `hold_black` | `release`). "Release to Govee" stops rendering but still stores incoming light commands.
- Implementation decisions beyond the spec:
  - Fades interpolate per-light opacity rather than fading to black, so a high-priority light fading out reveals the lights underneath.
  - At startup an idle device gets no commands, so a restart doesn't kill a Govee scene.
  - On shutdown, `hold_black` exits like `off`.
  - Every stream entry sends `turn on` → LAN `brightness 100` → `enable`. Verified on the H805A: the strip's own brightness scales razer frames. `brightness 100` + `enable` are re-sent every 30 s while streaming.
  - Per-device `whiteBalance` gains are applied to sent frames only; the preview stays uncorrected. On the H805A, RGB 2700 K looked pinker than Govee's white-LED 2700 K.

## Gotchas

- Zod 4 applies `.default()` inside `.partial()`. Patch schemas (`devicePatch`, `lightPatch`) must come from the default-free base shapes in `schemas.ts`, or a partial update silently resets every field it doesn't mention. `test/schemas.test.ts` guards this.

## Protocol essentials

- Datagram: `{"msg":{"cmd":"razer","data":{"pt":"<base64>"}}}`.
- Packet: `BB 00 <len> <cmd> <data…> <xor-checksum of all preceding bytes>`. `B1 01`/`B1 00` enables/disables streaming. `B0 <gradient=0> <count> <RGB…>` sends a frame.
- Known-good test vector: enable = `BB 00 01 B1 01 0A` → `uwABsQEK`. Unit tests must assert this.
- `len` is one byte, so a frame holds about 84 colors (`maxColorsPerPacket` default). Whether `00` is really a length high byte is still unverified (SPEC §9 lists open questions to test on hardware).
- Brightness is baked into RGB, on top of the device brightness pinned at 100. White LEDs aren't addressable in razer mode (frames are RGB only), so color temperature is approximated in RGB and is dimmer than Govee's own white.

## Hard constraints

- **Never bind UDP 4002 by default.** govee2mqtt on the same host already uses it. Devices are configured by manual IP. LAN discovery may only be an opt-in feature with a warning.
- No cloud API usage.
- `SIMULATE=true` must run the full stack (UI + MQTT) with frames logged instead of sent.
- HA entities: one HA device per strip, one JSON-schema light per virtual light. Capability per light (`onoff`/`dimmable`/`rgb`/`rgb_ct`) drives the discovery payload. Also add per-device "Release to Govee" switch and `mode` sensor entities. State is retained, and availability uses an LWT. Deleting a light publishes an empty retained discovery payload.

## Remaining work (SPEC §12)

1. A Dockerfile, a compose example with a healthcheck (`/healthz` exists), and an Unraid template.

SPEC §10 has a Python reference script confirmed working on the real device.
