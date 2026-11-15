// Protocol CLI for verifying SPEC §9 open questions against a real strip.
import { parseArgs } from 'node:util';
import * as proto from './server/protocol.js';
import { udpTransport, type Transport } from './server/transport.js';
import { miredsToRgb } from './shared/color.js';
import { runProbe } from './probe.js';
import { runProbeRound2 } from './probe2.js';
import { runProbeRound3 } from './probe3.js';

const USAGE = `usage: pnpm cli <command> --ip <strip-ip> [options]

commands:
  enable              razer streaming on (B1 01)
  disable             razer streaming off (B1 00)
  on | off            LAN power (turn)
  brightness <1-100>  LAN whole-strip brightness (SPEC §9 item 3)
  fill <r> <g> <b>    stream one color to every LED (holds until Ctrl-C)
  pixel <index>       light one LED white (holds until Ctrl-C)
  chase               run a dot along the strip (until Ctrl-C)

  probe               guided segment-mode probe (docs/segment-mode-testing.md)
                      --round 1 (default; needs --segments) --round 2 (finds the group count itself), or --round 3 (parking)
  seg color <segs> <r> <g> <b>   segment RGB (kelvin 0)
  seg white <segs> <kelvin>      segment white LEDs
  seg bright <segs> <0-100>      per-segment brightness
  seg off <segs>                 RGB 0 + kelvin 0, and brightness 0
  seg raw <hex> [<hex>…]         raw BLE payloads (≤19 bytes each; checksum added), one datagram
  <segs> counts from 1 like the Govee app: "1", "1,3", "2-4", or "all" (needs --segments)

options:
  --ip <addr>         strip IP (required)
  -n, --count <n>     colors per frame / LED count (default 60)
  --keepalive <ms>    resend interval while holding (default 2000)
  --no-turn           don't send LAN "turn on" before enabling (SPEC §9 item 4)
  --segments <n>      segment count (probe, "all")
  --mask-bytes <n>    segment mask length (default 3)
  --msb               segment 1 = most significant bit of the first mask byte
  --dry               print datagrams instead of sending
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ip: { type: 'string' },
    count: { type: 'string', short: 'n', default: '60' },
    keepalive: { type: 'string', default: '2000' },
    'no-turn': { type: 'boolean', default: false },
    segments: { type: 'string' },
    round: { type: 'string', default: '1' },
    'mask-bytes': { type: 'string', default: '3' },
    msb: { type: 'boolean', default: false },
    dry: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, ...args] = positionals;
if (values.help || !cmd || !values.ip) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const ip = values.ip;
const count = Number(values.count);
const keepalive = Number(values.keepalive);
const tx: Transport = values.dry ? dryTransport() : udpTransport();

const send = (b: Buffer, key?: string) => tx.send(ip, b, key);

async function begin() {
  if (!values['no-turn']) await send(proto.turn(true));
  await send(proto.streamEnable(true));
}

/** Stream frames until Ctrl-C, then exit streaming explicitly. */
async function hold(render: (t: number) => Uint8Array, intervalMs: number) {
  await begin();
  const start = Date.now();
  let stop = false;
  process.on('SIGINT', () => (stop = true));
  console.log('streaming; Ctrl-C to stop');
  while (!stop) {
    await send(proto.frame(render(Date.now() - start)), 'frame');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  await send(proto.streamEnable(false));
  console.log('\nsent razer disable');
}

/** --dry: print each datagram (BLE frames as hex) instead of sending it. */
function dryTransport(): Transport {
  return {
    async send(_ip, payload) {
      const msg = JSON.parse(payload.toString()).msg;
      if (msg.cmd === 'ptReal') {
        const frames = (msg.data.command as string[]).map((b) => Buffer.from(b, 'base64').toString('hex').replace(/(..)(?!$)/g, '$1 '));
        console.log(`  [dry] ptReal\n${frames.map((f) => `          ${f}`).join('\n')}`);
      } else if (msg.cmd === 'razer') console.log(`  [dry] razer ${Buffer.from(msg.data.pt, 'base64').toString('hex')}`);
      else console.log(`  [dry] ${msg.cmd} ${JSON.stringify(msg.data)}`);
    },
    async close() {},
  };
}

/** "1,3-5" or "all" (1-based) → 0-based segment indices. */
function parseSegs(spec: string | undefined): number[] {
  if (spec === 'all') {
    if (!values.segments) throw new Error('"all" needs --segments');
    return [...Array(Number(values.segments)).keys()];
  }
  const out: number[] = [];
  for (const part of (spec ?? '').split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad segment list "${spec}"`);
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      if (i < 1) throw new Error('segments count from 1');
      out.push(i - 1);
    }
  }
  return out;
}

async function segCommand(sub: string | undefined, rest: string[]) {
  const fmt = { bytes: Number(values['mask-bytes']), msbFirst: values.msb };
  if (sub === 'raw') {
    await send(proto.ptReal(rest.map((h) => proto.bleFrame(Buffer.from(h.replace(/[^0-9a-f]/gi, ''), 'hex')))));
    return;
  }
  const mask = proto.segmentMask(parseSegs(rest[0]), fmt);
  const n = rest.slice(1).map(Number);
  const frames =
    sub === 'color' ? [proto.segmentColorFrame(n, 0, [0, 0, 0], mask)]
    : sub === 'white' ? [proto.segmentColorFrame([255, 255, 255], n[0], miredsToRgb(1_000_000 / n[0]), mask)]
    : sub === 'bright' ? [proto.segmentBrightnessFrame(n[0], mask)]
    : sub === 'off' ? [proto.segmentColorFrame([0, 0, 0], 0, [0, 0, 0], mask), proto.segmentBrightnessFrame(0, mask)]
    : null;
  if (!frames) {
    console.log(USAGE);
    process.exit(1);
  }
  await send(proto.ptReal(frames));
}

switch (cmd) {
  case 'probe':
    if (values.round === '3') {
      await runProbeRound3({ ip, dataDir: process.env.DATA_DIR ?? './data', dry: values.dry, send: (b) => send(b) });
      break;
    }
    if (values.round === '2') {
      await runProbeRound2({
        ip,
        dataDir: process.env.DATA_DIR ?? './data',
        dry: values.dry,
        send: (b) => send(b),
        groups: values.segments ? Number(values.segments) : undefined,
      });
      break;
    }
    if (!values.segments) throw new Error('probe needs --segments <n> (the number of segments in the Govee app)');
    await runProbe({
      ip,
      segments: Number(values.segments),
      dataDir: process.env.DATA_DIR ?? './data',
      dry: values.dry,
      send: (b) => send(b),
    });
    break;
  case 'seg':
    await segCommand(args[0], args.slice(1));
    break;
  case 'enable':
    await send(proto.streamEnable(true));
    break;
  case 'disable':
    await send(proto.streamEnable(false));
    break;
  case 'on':
  case 'off':
    await send(proto.turn(cmd === 'on'));
    break;
  case 'brightness':
    await send(proto.brightness(Number(args[0])));
    break;
  case 'fill': {
    const [r, g, b] = args.map(Number);
    const rgb = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) rgb.set([r, g, b], i * 3);
    await hold(() => rgb, keepalive);
    break;
  }
  case 'pixel': {
    const i = Number(args[0]);
    const rgb = new Uint8Array(count * 3);
    rgb.fill(255, i * 3, i * 3 + 3);
    await hold(() => rgb, keepalive);
    break;
  }
  case 'chase':
    await hold((t) => {
      const rgb = new Uint8Array(count * 3);
      const i = Math.floor(t / 100) % count;
      rgb.set([255, 255, 255], i * 3);
      return rgb;
    }, 100);
    break;
  default:
    console.log(USAGE);
    process.exit(1);
}
await tx.close();
