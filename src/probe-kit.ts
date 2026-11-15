// Shared plumbing for the guided hardware probes: sending segment frames,
// asking questions, repeating animations, and saving answers as JSON.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { miredsToRgb } from './shared/color.js';
import * as proto from './server/protocol.js';
import type { MaskFormat } from './server/protocol.js';

export interface ProbeIO {
  ip: string;
  dataDir: string;
  /** Print instead of sending; also skips real-time waits. */
  dry: boolean;
  send(payload: Buffer): Promise<void>;
}

export interface Answer {
  test: string;
  question: string;
  answer: string;
  note?: string;
}

const MAX_FRAMES_PER_DATAGRAM = 8;

export function createKit(io: ProbeIO, round: number, fmt: MaskFormat) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const startedAt = new Date();
  mkdirSync(io.dataDir, { recursive: true });
  const file = path.join(io.dataDir, `probe-r${round}-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
  const answers: Answer[] = [];
  const constants: Record<string, unknown> = { mask: fmt };
  let razerOn = false;

  const save = () => writeFileSync(file, JSON.stringify({ round, startedAt, ip: io.ip, constants, answers }, null, 2) + '\n');

  process.on('SIGINT', () => {
    void (async () => {
      if (razerOn) await io.send(proto.streamEnable(false)).catch(() => {});
      save();
      console.log(`\nInterrupted. Answers so far: ${file}`);
      process.exit(130);
    })();
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, io.dry ? 0 : ms));
  const mask = (groups: number[]) => proto.segmentMask(groups, fmt);

  const k = {
    rl,
    file,
    constants,
    sleep,
    save,
    // --- frames (group indices are 0-based) ---
    color: (g: number[], rgb: readonly number[]) => proto.segmentColorFrame(rgb, 0, [0, 0, 0], mask(g)),
    /** White via the kelvin field. `rgb`/`tint` default to what the service would send. */
    white: (g: number[], kelvin: number, rgb: readonly number[] = [255, 255, 255], tint: readonly number[] = miredsToRgb(1_000_000 / kelvin)) =>
      proto.segmentColorFrame(rgb, kelvin, tint, mask(g)),
    /** The same color temperature mixed from RGB only (what per-LED mode shows). */
    mixed: (g: number[], kelvin: number) => proto.segmentColorFrame(miredsToRgb(1_000_000 / kelvin), 0, [0, 0, 0], mask(g)),
    bright: (g: number[], pct: number) => proto.segmentBrightnessFrame(pct, mask(g)),
    async sendFrames(frames: Buffer[], split = false) {
      const size = split ? 1 : MAX_FRAMES_PER_DATAGRAM;
      for (let i = 0; i < frames.length; i += size) await io.send(proto.ptReal(frames.slice(i, i + size)));
    },
    async razer(on: boolean) {
      await io.send(proto.streamEnable(on));
      razerOn = on;
    },
    send: io.send,

    // --- talking to the user ---
    heading(t: string) {
      console.log(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}`);
    },
    enter: (msg = 'Press Enter when ready.') => rl.question(`  ${msg} `),
    async ask(test: string, question: string, choices: Record<string, string>, withNote = true): Promise<string> {
      console.log(`\n? ${question}`);
      for (const [key, v] of Object.entries(choices)) console.log(`   ${key}) ${v}`);
      let a = '';
      while (!(a in choices)) a = (await rl.question('  > ')).trim().toLowerCase();
      const note = withNote ? (await rl.question('  note (Enter to skip): ')).trim() : '';
      answers.push({ test, question, answer: `${a}) ${choices[a]}`, ...(note ? { note } : {}) });
      return a;
    },
    async askText(test: string, question: string): Promise<string> {
      const a = (await rl.question(`\n? ${question}\n  > `)).trim();
      answers.push({ test, question, answer: a });
      return a;
    },
    /** Run an animation, then offer to replay it until the user is ready to answer. */
    async repeatable(run: () => Promise<void>) {
      for (;;) {
        await run();
        const r = (await rl.question('  [Enter = answer, r = repeat] ')).trim().toLowerCase();
        if (r !== 'r') return;
      }
    },
    /** Step through states on Enter (wrapping) until the user types "d". */
    async stepper(label: string, steps: [string, () => Promise<void>][]) {
      console.log(`  Each Enter shows the next ${label}; type "d" + Enter when you've seen enough.`);
      for (let i = 0; ; i = (i + 1) % steps.length) {
        await steps[i][1]();
        const r = (await rl.question(`  → ${steps[i][0]}  [Enter = next, d = done] `)).trim().toLowerCase();
        if (r === 'd') return;
      }
    },
    close() {
      save();
      rl.close();
    },
  };
  return k;
}
