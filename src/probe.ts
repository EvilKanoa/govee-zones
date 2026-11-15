// Guided hardware probe for segment mode (docs/segment-mode-testing.md §1).
// Each test puts the strip in a known state (or steps between states on Enter),
// then asks what you see. Answers are saved to <data dir>/probe-<time>.json
// after every test, so an interrupted run keeps what it has.
//
// Segments are numbered from 1 in everything shown to the user, like the Govee
// app; internally (protocol masks) they are 0-based.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { miredsToRgb } from './shared/color.js';
import * as proto from './server/protocol.js';
import type { MaskFormat } from './server/protocol.js';

export interface ProbeOptions {
  ip: string;
  segments: number;
  dataDir: string;
  /** Print instead of sending; also skips the real-time waits. */
  dry: boolean;
  send(payload: Buffer): Promise<void>;
}

interface Answer {
  test: string;
  question: string;
  answer: string;
  note?: string;
}

const MAX_FRAMES_PER_DATAGRAM = 8;
const WARM = 2700;
const COOL = 6500;
const HOLD_CHECK_MS = 3 * 60_000;

const RED = [255, 0, 0];
const MAP_COLORS: [string, number[]][] = [
  ['Red', RED],
  ['Yellow', [255, 200, 0]],
  ['Green', [0, 255, 0]],
  ['Blue', [0, 0, 255]],
  ['Purple', [170, 0, 255]],
  ['Cyan', [0, 255, 255]],
  ['White', [255, 255, 255]],
  ['Orange', [255, 90, 0]],
];

/** Mask layouts to try, most likely first. */
const MASK_VARIANTS: MaskFormat[] = [
  { bytes: 3, msbFirst: false },
  { bytes: 7, msbFirst: false },
  { bytes: 3, msbFirst: true },
  { bytes: 7, msbFirst: true },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runProbe(o: ProbeOptions) {
  if (o.segments < 5) throw new Error('the probe needs at least 5 segments (--segments)');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const startedAt = new Date();
  mkdirSync(o.dataDir, { recursive: true });
  const file = path.join(o.dataDir, `probe-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
  const answers: Answer[] = [];
  const constants: Record<string, unknown> = {};
  let fmt: MaskFormat = MASK_VARIANTS[0];
  let multiFrame = true;
  let razerOn = false;

  const save = () =>
    writeFileSync(file, JSON.stringify({ startedAt, ip: o.ip, segments: o.segments, constants: { ...constants, mask: fmt, multiFrame }, answers }, null, 2) + '\n');

  const onSigint = async () => {
    if (razerOn) await o.send(proto.streamEnable(false)).catch(() => {});
    save();
    console.log(`\nInterrupted. Answers so far: ${file}`);
    process.exit(130);
  };
  process.on('SIGINT', () => void onSigint());

  // --- sending ---------------------------------------------------------------
  const all = [...Array(o.segments).keys()];
  const mask = (segs: number[]) => proto.segmentMask(segs, fmt);
  const color = (segs: number[], rgb: number[]) => proto.segmentColorFrame(rgb, 0, [0, 0, 0], mask(segs));
  const white = (segs: number[], kelvin: number) =>
    proto.segmentColorFrame([255, 255, 255], kelvin, miredsToRgb(1_000_000 / kelvin), mask(segs));
  const bright = (segs: number[], pct: number) => proto.segmentBrightnessFrame(pct, mask(segs));

  async function sendFrames(frames: Buffer[], split = !multiFrame) {
    const size = split ? 1 : MAX_FRAMES_PER_DATAGRAM;
    for (let i = 0; i < frames.length; i += size) await o.send(proto.ptReal(frames.slice(i, i + size)));
  }

  // --- asking ------------------------------------------------------------------
  async function ask(test: string, question: string, choices: Record<string, string>, withNote = true): Promise<string> {
    console.log(`\n? ${question}`);
    for (const [k, v] of Object.entries(choices)) console.log(`   ${k}) ${v}`);
    let a = '';
    while (!(a in choices)) a = (await rl.question('  > ')).trim().toLowerCase();
    const note = withNote ? (await rl.question('  note (Enter to skip): ')).trim() : '';
    answers.push({ test, question, answer: `${a}) ${choices[a]}`, ...(note ? { note } : {}) });
    return a;
  }

  async function askText(test: string, question: string): Promise<string> {
    const a = (await rl.question(`\n? ${question}\n  > `)).trim();
    answers.push({ test, question, answer: a });
    return a;
  }

  const enter = (msg = 'Press Enter when ready.') => rl.question(`  ${msg} `);
  const heading = (t: string) => console.log(`\n${'='.repeat(60)}\n${t}\n${'='.repeat(60)}`);
  const seg = (i: number) => `segment ${i + 1}`;

  // --- setup -------------------------------------------------------------------
  heading('Segment mode probe');
  console.log(`Strip ${o.ip}, ${o.segments} segments.${o.dry ? ' DRY RUN: nothing is sent.' : ''}
Before starting:
  • Stop govee-zones, or switch on "Release to Govee" for this strip.
  • LAN Control must be on in the Govee app.
  • Stand where you can see the whole strip. Segment 1 is the first one in the Govee app.
Answers are saved after each test to:
  ${file}`);
  await enter();
  await o.send(proto.streamEnable(false)); // in case something left razer on
  await o.send(proto.turn(true));
  await o.send(proto.brightness(100));
  await sleep(o.dry ? 0 : 500);

  // --- 1. Map ------------------------------------------------------------------
  heading('Test 1 of 5: Map (does the command work, which bit is which segment)');
  const mapFrames = () => [
    ...all.map((i) => color([i], i < MAP_COLORS.length ? MAP_COLORS[i][1] : i % 2 ? [0, 0, 0] : [0, 0, 255])),
    bright(all, 100),
  ];
  const expected = all.slice(0, MAP_COLORS.length).map((i) => MAP_COLORS[i][0]).join(', ');
  const attempts: { fmt: MaskFormat; split: boolean }[] = [
    { fmt: MASK_VARIANTS[0], split: false },
    { fmt: MASK_VARIANTS[0], split: true },
    ...MASK_VARIANTS.slice(1).map((f) => ({ fmt: f, split: false })),
  ];
  let mapped = false;
  for (const [n, att] of attempts.entries()) {
    fmt = att.fmt;
    console.log(`\nAttempt ${n + 1}/${attempts.length}: mask ${fmt.bytes} bytes, ${fmt.msbFirst ? 'MSB' : 'LSB'} first, ${att.split ? 'one command per packet' : 'all commands in one packet'}.`);
    await sendFrames(mapFrames(), att.split);
    const a = await ask('1-map', `From the start of the strip, what colors do you see? Expected: ${expected}${o.segments > MAP_COLORS.length ? ', then blue/off alternating' : ''}.`, {
      a: 'Exactly that, in that order',
      b: 'Those colors, but in a different order or place (note what you see)',
      c: 'Some segments changed, others did not (note which)',
      d: 'Nothing changed',
    });
    if (a === 'a') {
      multiFrame = !att.split;
      mapped = true;
      break;
    }
    // Only retry one-command-per-packet when the multi-frame packet may be the problem.
    if (n === 0 && a !== 'c' && a !== 'd') attempts.splice(1, 1);
  }
  if (!mapped) {
    save();
    console.log(`\nNo mask layout matched, so the remaining tests would be meaningless. Stopping here.\nAnswers: ${file}`);
    rl.close();
    return;
  }
  await ask('1-map', `Are the ${o.segments} color blocks about equal length?`, {
    a: 'Yes, about equal',
    b: 'No, uneven (note which are longer or shorter)',
    c: `I count a different number of blocks than ${o.segments} (note how many)`,
  });
  save();

  // --- 2. Panel ----------------------------------------------------------------
  heading('Test 2 of 5: Panel (real white, per-segment dimming, turning a segment off)');
  console.log(`First, a reference: in the Govee app, set the whole strip to ${WARM} K white and remember how it looks.
(Skip this if you know the app's warm white well.)`);
  await enter('Press Enter to send the panel.');
  const rest = all.slice(5);
  await sendFrames([
    white([0], WARM),
    color([1], miredsToRgb(1_000_000 / WARM)),
    white([2], WARM),
    color([3, 4], RED),
    ...(rest.length ? [color(rest, [0, 0, 0])] : []),
    bright([0, 1, 4], 100),
    bright([2, 3], 20),
  ]);
  console.log(`Sent:
  ${seg(0)}: white LEDs, ${WARM} K, 100 %
  ${seg(1)}: RGB mixed to look like ${WARM} K, 100 %
  ${seg(2)}: white LEDs, ${WARM} K, 20 %
  ${seg(3)}: red, 20 %
  ${seg(4)}: red, 100 %`);
  await ask('2-panel', `Compare ${seg(0)} (white LEDs) with ${seg(1)} (mixed RGB).`, {
    a: `Clearly different, and ${seg(0)} looks like the app's warm white`,
    b: 'Clearly different, but neither looks like the app',
    c: 'They look the same',
    d: `${seg(0)} is off, or not white`,
  });
  const dimChoices = { a: 'Clearly dimmer', b: 'Slightly dimmer', c: 'Same brightness', d: 'Off, or the wrong color' };
  await ask('2-panel', `Is ${seg(2)} (white 20 %) dimmer than ${seg(0)} (white 100 %)?`, dimChoices);
  await ask('2-panel', `Is ${seg(3)} (red 20 %) dimmer than ${seg(4)} (red 100 %)?`, dimChoices);

  console.log(`\nNext: all segments go to warm white, then three are turned off in different ways.`);
  await enter('Press Enter to send.');
  await sendFrames([white(all, WARM), bright(all, 100)]);
  await sleep(o.dry ? 0 : 1500);
  await sendFrames([color([0], [0, 0, 0]), bright([1], 0), color([2], [0, 0, 0]), bright([2], 0)]);
  console.log(`Sent:
  ${seg(0)}: off by "RGB 0 + kelvin 0"
  ${seg(1)}: off by "brightness 0"
  ${seg(2)}: off by both
  ${seg(3)}, ${seg(4)}: left on (warm white)`);
  await askText('2-panel', `Which of segments 1, 2, 3 are FULLY dark? Type the numbers (e.g. "1 3"), or "none".`);
  await ask('2-panel', `Are ${seg(3)} and ${seg(4)} still warm white?`, { y: 'Yes', n: 'No (note what changed)' });
  save();

  // --- 3. Toggle ---------------------------------------------------------------
  heading('Test 3 of 5: Toggle (kelvin changes the white, one segment does both white and RGB)');
  const steps: [string, () => Buffer[]][] = [
    [`${WARM} K white`, () => [white([0], WARM)]],
    [`${COOL} K white`, () => [white([0], COOL)]],
    ['blue (RGB)', () => [color([0], [0, 0, 255])]],
    [`back to ${WARM} K white`, () => [white([0], WARM)]],
  ];
  await sendFrames([white(all, WARM), bright(all, 100)]);
  console.log(`All segments are warm white. Each Enter changes ${seg(0)} to the next step; the others stay as a reference.
Type "d" + Enter when you've seen enough.`);
  for (let i = 0; ; i = (i + 1) % steps.length) {
    await sendFrames(steps[i][1]());
    const r = (await rl.question(`  ${seg(0)}: ${steps[i][0]}  [Enter = next, d = done] `)).trim().toLowerCase();
    if (r === 'd') break;
  }
  await ask('3-toggle', `${WARM} K → ${COOL} K: did ${seg(0)} change from warm to cool white?`, {
    a: 'Yes, clearly', b: 'Slightly', c: 'No change',
  });
  await ask('3-toggle', 'White → blue: what happened?', {
    a: 'Clean switch to blue', b: 'Blue mixed with white', c: 'No change', d: 'Something else (note it)',
  });
  await ask('3-toggle', `Blue → ${WARM} K: what happened?`, {
    a: 'Clean switch back to warm white', b: 'Something else (note it)',
  });
  save();

  // --- 4. Fade and switch ------------------------------------------------------
  heading('Test 4 of 5: Fade speed, and switching between segment and per-LED control');
  await sendFrames([white(all, WARM), bright(all, 100)]);
  const fade = async (hz: number) => {
    const steps = Math.round(2 * hz);
    const start = Date.now();
    for (let k = 0; k <= steps; k++) {
      if (!o.dry) await sleep(Math.max(0, start + (k * 1000) / hz - Date.now()));
      await sendFrames([bright([0], 5 + (95 * k) / steps)], true);
    }
  };
  const fadeChoices = {
    a: 'Smooth', b: 'Visibly stepped, but even', c: 'Jumpy, or it skipped steps', d: "Didn't change until the end, or didn't change at all",
  };
  for (const hz of [10, 20]) {
    console.log(`\n${seg(0)} will fade 5 % → 100 % over 2 s, ${hz} updates per second. Type "r" + Enter to repeat it.`);
    await enter('Press Enter to start.');
    for (;;) {
      await sendFrames([bright([0], 5)], true);
      await sleep(o.dry ? 0 : 1000);
      await fade(hz);
      const r = (await rl.question('  [Enter = answer, r = repeat] ')).trim().toLowerCase();
      if (r !== 'r') break;
    }
    await ask('4-fade', `Fade at ${hz} updates/s: how did it look?`, fadeChoices);
  }

  console.log(`\nNext: 3 cycles of switching. The whole strip goes from warm white (segment control)
to blue (per-LED control) for 3 s, then back to warm white for 3 s. Watch each switch.`);
  await enter('Press Enter to start.');
  const blueFrame = proto.frame(new Uint8Array(Array.from({ length: 20 }, () => [0, 0, 255]).flat()));
  for (let c = 1; c <= 3; c++) {
    console.log(`  cycle ${c}: → per-LED blue`);
    await o.send(proto.streamEnable(true));
    razerOn = true;
    for (let t = 0; t < 3; t++) {
      await o.send(blueFrame);
      await sleep(o.dry ? 0 : 1000);
    }
    console.log(`  cycle ${c}: → segments warm white`);
    await o.send(proto.streamEnable(false));
    razerOn = false;
    await sendFrames([white(all, WARM), bright(all, 100)]);
    await sleep(o.dry ? 0 : 3000);
  }
  await ask('4-switch', 'Switching TO blue (per-LED):', {
    a: 'Clean switch', b: 'Brief flash of another color first (note what)', c: "Didn't turn blue",
  });
  await ask('4-switch', 'Switching BACK to warm white (segments):', {
    a: 'Clean switch',
    b: 'Brief flash of something else first (note what: Govee scene, old colors, off?)',
    c: 'Went to the Govee scene and stayed there',
    d: 'Stayed blue',
  });
  save();

  // --- 5. Power and hold -------------------------------------------------------
  heading('Test 5 of 5: Power on, and holding with nothing sent');
  console.log(`The strip goes green, turns off, gets warm white WHILE OFF, then turns on.`);
  await enter('Press Enter to start.');
  await sendFrames([color(all, [0, 255, 0]), bright(all, 100)]);
  await sleep(o.dry ? 0 : 2000);
  await o.send(proto.turn(false));
  await sleep(o.dry ? 0 : 2000);
  await sendFrames([white(all, WARM), bright(all, 100)]);
  await sleep(o.dry ? 0 : 1000);
  await o.send(proto.turn(true));
  await ask('5-power', 'When it turned back on:', {
    a: 'Warm white straight away',
    b: 'Green flashed first, then warm white',
    c: 'Green, and it stayed green',
    d: 'Something else (note it)',
  });
  await sendFrames([white(all, WARM), bright(all, 100)]);
  const holdFrom = Date.now();
  console.log(`\nAll segments are warm white. Nothing more will be sent. Leave the strip alone
for at least 3 minutes (the razer mode reverts after about 1 minute), then come back.`);
  for (;;) {
    await enter('Press Enter after 3 minutes.');
    const left = HOLD_CHECK_MS - (Date.now() - holdFrom);
    if (o.dry || left <= 0) break;
    console.log(`  ${Math.ceil(left / 1000)} s to go.`);
  }
  constants.holdCheckedAfterMs = Date.now() - holdFrom;
  await ask('5-hold', 'Is the strip still warm white on every segment?', {
    a: 'Yes', b: 'It went back to the Govee scene', c: "It's off", d: 'Something else (note it)',
  });
  save();
  rl.close();

  heading('Done');
  console.log(`Answers: ${file}\nThe strip is left as it is. Restart govee-zones (or turn off "Release to Govee") when you're done.`);
}
