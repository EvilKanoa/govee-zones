// Round 2 of the segment-mode hardware probe (docs/segment-mode-results.md).
// Round 1 found that each mask bit drives a group of 4 LEDs; this round pins
// down the group count, real vs mixed white (warm AND cool), off vs minimum,
// firmware fades, the switch-back flash, and how the Govee app interacts.
// Every animation can be replayed before answering.
import { createKit, type ProbeIO } from './probe-kit.js';
import { DEFAULT_MASK } from './server/protocol.js';
import * as proto from './server/protocol.js';

const MASK_BITS = DEFAULT_MASK.bytes * 8; // 24: enough for 96 LEDs at 4 per group
const WARM = 2700;
const COOL = 6500;
const RGB_CYCLE: [string, number[]][] = [
  ['red', [255, 0, 0]],
  ['green', [0, 255, 0]],
  ['blue', [0, 0, 255]],
];

const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

export async function runProbeRound2(io: ProbeIO & { groups?: number }) {
  const k = createKit(io, 2, DEFAULT_MASK);
  const bits = range(0, MASK_BITS);

  k.heading('Segment mode probe, round 2');
  console.log(`Strip ${io.ip}.${io.dry ? ' DRY RUN: nothing is sent.' : ''}
Before starting:
  • Stop govee-zones, or switch on "Release to Govee" for this strip.
  • Stand where you can see the whole strip, ideally close enough to count LEDs.
  • Every animation can be repeated: type "r" + Enter at the prompt.
Answers are saved after each test to:
  ${k.file}`);
  await k.enter();
  await k.razer(false);
  await k.send(proto.turn(true));
  await k.send(proto.brightness(100));
  await k.sleep(500);

  // --- 1. Group count ------------------------------------------------------
  k.heading('Test 1 of 6: How many groups, and are they all 4 LEDs');
  console.log(`All ${MASK_BITS} mask bits are lit red, green, blue, red, green, blue, … from the start.`);
  await k.sendFrames([
    ...RGB_CYCLE.map(([, rgb], c) => k.color(bits.filter((b) => b % 3 === c), rgb)),
    k.bright(bits, 100),
  ]);
  await k.ask('1-groups', 'Does the red/green/blue pattern reach the end of the strip?', {
    a: 'Yes, all the way to the last LED',
    b: 'No, it stops before the end (note how many LEDs are left uncolored)',
  });
  const counted = Number.parseInt(await k.askText('1-groups', 'How many color blocks in total? (Count them, or give a best guess; "?" if unsure.)'), 10);
  await k.ask('1-groups', 'Is every block 4 LEDs, including the last one?', {
    a: 'Yes',
    b: 'No (note which blocks differ, and their size)',
  });
  const n = Number.isFinite(counted) && counted > 0 && counted <= MASK_BITS ? counted : (io.groups ?? 15);
  k.constants.groups = n;
  console.log(`Using ${n} groups for the rest of this round.`);
  k.save();

  const all = range(0, n);
  const left = range(0, Math.floor(n / 2));
  const right = range(Math.floor(n / 2), n);
  const quarter = (q: number) => range(Math.floor((q * n) / 4), Math.floor(((q + 1) * n) / 4));
  const allWarm = () => k.sendFrames([k.white(all, WARM), k.bright(all, 100)]);

  // --- 2. White ------------------------------------------------------------
  k.heading('Test 2 of 6: Real white vs RGB-mixed white, warm and cool');
  console.log(`The strip is split in half. Each Enter swaps which half uses the real white LEDs
and which half mixes the same color temperature from RGB. Watch the same spot as it swaps.`);
  for (const kelvin of [WARM, COOL]) {
    console.log(`\n${kelvin} K:`);
    await k.sendFrames([k.color(range(n, MASK_BITS), [0, 0, 0]), k.bright(all, 100)]);
    await k.stepper('swap', [
      ['LEFT half real white, RIGHT half RGB-mixed', () => k.sendFrames([k.white(left, kelvin), k.mixed(right, kelvin)])],
      ['LEFT half RGB-mixed, RIGHT half real white', () => k.sendFrames([k.mixed(left, kelvin), k.white(right, kelvin)])],
    ]);
    await k.ask('2-white', `At ${kelvin} K, how do real white and RGB-mixed white compare?`, {
      a: `Clearly different; real white looks like the app's ${kelvin} K`,
      b: `Clearly different, but real white looks ${kelvin === WARM ? 'cooler/brighter' : 'warmer'} than the app's ${kelvin} K`,
      c: 'They look the same',
      d: 'Something else (note it)',
    });
    await k.ask('2-white', `At ${kelvin} K, which is brighter?`, {
      a: 'Real white', b: 'RGB-mixed', c: 'About the same',
    });
  }

  console.log(`\nKelvin sweep: the whole strip uses real white; each Enter changes the color temperature.`);
  const sweep = [2000, 2200, 2700, 3500, 4500, 5500, 6500, 8000, 9000];
  await k.stepper('temperature', sweep.map((kv) => [`${kv} K`, () => k.sendFrames([k.white(all, kv)])] as [string, () => Promise<void>]));
  await k.askText('2-white', 'Lowest kelvin where it stopped getting warmer, and highest where it stopped getting cooler? (e.g. "2200 6500")');
  await k.ask('2-white', 'Up close, how do the WARM settings look?', {
    a: 'A pure warm white',
    b: 'A cool white LED with orange/red RGB mixed in (you can see the colors separately)',
    c: "Can't tell",
  });

  console.log(`\nWhich fields matter: the whole strip at ${WARM} K real white, sent 5 different ways.
Step 1 is what the service would send; note any step that looks different from it.`);
  const tint = [255, 167, 87];
  await k.stepper('variant', [
    ['1: RGB white + warm tint (normal)', () => k.sendFrames([k.white(all, WARM)])],
    ['2: RGB 0 + tint 0', () => k.sendFrames([k.white(all, WARM, [0, 0, 0], [0, 0, 0])])],
    ['3: RGB white + tint white', () => k.sendFrames([k.white(all, WARM, [255, 255, 255], [255, 255, 255])])],
    ['4: RGB 0 + warm tint', () => k.sendFrames([k.white(all, WARM, [0, 0, 0], tint)])],
    ['5: RGB red + warm tint', () => k.sendFrames([k.white(all, WARM, [255, 0, 0], tint)])],
  ]);
  await k.askText('2-white', 'Which steps (2-5) looked different from step 1, and how? ("none" if all the same)');
  k.save();

  // --- 3. Off vs minimum ---------------------------------------------------
  k.heading('Test 3 of 6: Off vs minimum brightness');
  await allWarm();
  await k.sleep(1000);
  await k.sendFrames([k.bright(quarter(0), 0), k.bright(quarter(1), 1), k.color(quarter(2), [0, 0, 0])]);
  console.log(`From the start, in quarters:
  1st quarter: brightness 0
  2nd quarter: brightness 1 %
  3rd quarter: RGB 0 + kelvin 0
  4th quarter: left on (warm white, 100 %)`);
  await k.askText('3-off', 'Which quarters are FULLY dark? (e.g. "1 3", or "none")');
  await k.ask('3-off', '1st quarter (brightness 0) compared with 2nd (brightness 1 %):', {
    a: '1st is darker (fully off)', b: 'They look the same (0 is clamped to the minimum)', c: '1st is brighter', d: 'Something else (note it)',
  });
  k.save();

  // --- 4. Firmware fades ---------------------------------------------------
  k.heading('Test 4 of 6: Does the firmware smooth changes by itself?');
  const glide = {
    a: 'Snaps instantly', b: 'Short glide (under half a second)', c: 'Slow glide (note roughly how long)', d: 'Something else (note it)',
  };
  console.log('\nWhole strip warm white; brightness jumps 5 % → 100 % → 5 % → 100 %, 1.5 s apart.');
  await allWarm();
  await k.enter('Press Enter to start.');
  await k.repeatable(async () => {
    for (const p of [5, 100, 5, 100]) {
      await k.sendFrames([k.bright(all, p)]);
      await k.sleep(1500);
    }
  });
  await k.ask('4-fade', 'Brightness jumps:', glide);

  console.log('\nWhole strip jumps red → blue → red → blue, 1.5 s apart.');
  await k.enter('Press Enter to start.');
  await k.repeatable(async () => {
    for (const rgb of [[255, 0, 0], [0, 0, 255], [255, 0, 0], [0, 0, 255]]) {
      await k.sendFrames([k.color(all, rgb)]);
      await k.sleep(1500);
    }
  });
  await k.ask('4-fade', 'Color jumps:', glide);

  console.log('\nWhole strip warm white; the same state is re-sent 10 times, twice a second.');
  await allWarm();
  await k.enter('Press Enter to start.');
  await k.repeatable(async () => {
    for (let i = 0; i < 10; i++) {
      await allWarm();
      await k.sleep(500);
    }
  });
  await k.ask('4-fade', 'While the same state was re-sent:', {
    a: 'Nothing visible', b: 'A flicker or blink on each re-send', c: 'Something else (note it)',
  });
  k.save();

  // --- 5. Switch-back flash ------------------------------------------------
  k.heading('Test 5 of 6: Returning from per-LED to segment control');
  const blue = proto.frame(new Uint8Array(Array.from({ length: 20 }, () => [0, 0, 255]).flat()));
  const perLedBlue = async () => {
    await k.razer(true);
    for (let t = 0; t < 3; t++) {
      await k.send(blue);
      await k.sleep(1000);
    }
  };
  const flash = {
    a: 'Clean: blue straight to warm white',
    b: 'Flash of a Govee scene or earlier app colors',
    c: 'Flash of black / off',
    d: 'Something else, or stayed blue (note it)',
  };
  const variants: [string, string, () => Promise<void>][] = [
    ['A', 'stop per-LED, then send segments (what round 1 did)', async () => {
      await k.razer(false);
      await k.sleep(100);
      await allWarm();
    }],
    ['B', 'send segments WHILE per-LED is still on, wait 1.5 s, then stop per-LED', async () => {
      await allWarm();
      console.log('    (segments sent; per-LED still on for 1.5 s)');
      await k.sleep(1500);
      await k.razer(false);
    }],
    ['C', 'send segments and stop per-LED together, no gap', async () => {
      await allWarm();
      await k.razer(false);
    }],
  ];
  for (const [id, desc, back] of variants) {
    console.log(`\nVariant ${id}: warm white → per-LED blue for 3 s → ${desc}.`);
    await k.enter('Press Enter to start.');
    await k.repeatable(async () => {
      await allWarm();
      await k.sleep(1500);
      console.log('    → per-LED blue');
      await perLedBlue();
      console.log('    → back to segments');
      await back();
      await k.sleep(2000);
    });
    await k.ask('5-switch', `Variant ${id}, switching back:`, flash);
    if (id === 'B')
      await k.ask('5-switch', 'Variant B: during the 1.5 s pause, while per-LED was still on, did the strip change from blue?', {
        a: 'No, stayed blue until the switch', b: 'Yes, it went warm white during the pause', c: 'Not sure',
      });
  }
  k.save();

  // --- 6. Govee app interaction --------------------------------------------
  k.heading('Test 6 of 6: Govee app scenes and whole-strip brightness');
  console.log('In the Govee app, start any animated scene or effect, then come back.');
  await k.enter('Press Enter once the scene is running; warm white will be sent to every group.');
  await allWarm();
  await k.ask('6-app', 'After the warm white was sent:', {
    a: 'The scene stopped; warm white everywhere',
    b: 'The scene stopped on some LEDs only (note where)',
    c: 'The scene kept running',
    d: 'Something else (note it)',
  });

  console.log('\nWhole strip warm white at 100 % per group. Each Enter flips the LAN (whole-strip) brightness between 100 and 50.');
  await allWarm();
  await k.stepper('brightness', [
    ['LAN brightness 100', () => k.send(proto.brightness(100))],
    ['LAN brightness 50', () => k.send(proto.brightness(50))],
  ]);
  await k.ask('6-app', 'Did LAN brightness 50 dim the strip?', {
    a: 'Yes, clearly', b: 'Slightly', c: 'No change',
  });
  await k.send(proto.brightness(100));
  await allWarm();

  k.close();
  k.heading('Done');
  console.log(`Answers: ${k.file}\nThe strip is left warm white. Restart govee-zones (or turn off "Release to Govee") when you're done.`);
}
