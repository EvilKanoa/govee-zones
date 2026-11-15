// Protocol CLI for verifying SPEC §9 open questions against a real strip.
import { parseArgs } from 'node:util';
import * as proto from './server/protocol.js';
import { udpTransport } from './server/transport.js';

const USAGE = `usage: pnpm cli <command> --ip <strip-ip> [options]

commands:
  enable              razer streaming on (B1 01)
  disable             razer streaming off (B1 00)
  on | off            LAN power (turn)
  brightness <1-100>  LAN whole-strip brightness (SPEC §9 item 3)
  fill <r> <g> <b>    stream one color to every LED (holds until Ctrl-C)
  pixel <index>       light one LED white (holds until Ctrl-C)
  chase               run a dot along the strip (until Ctrl-C)

options:
  --ip <addr>         strip IP (required)
  -n, --count <n>     colors per frame / LED count (default 60)
  --keepalive <ms>    resend interval while holding (default 2000)
  --no-turn           don't send LAN "turn on" before enabling (SPEC §9 item 4)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ip: { type: 'string' },
    count: { type: 'string', short: 'n', default: '60' },
    keepalive: { type: 'string', default: '2000' },
    'no-turn': { type: 'boolean', default: false },
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
const tx = udpTransport();

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

switch (cmd) {
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
