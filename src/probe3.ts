// Round 3 of the segment-mode hardware probe: "parking" (docs/segment-mode-plan.md §3.5).
// Only the first 4 groups (16 LEDs) are used; the rest of the strip is kept dark.
//  1. Park sequence: per-LED on → turn off → disable → write groups while off.
//     Is it dark the whole time, and does an outside turn-on show the parked look?
//  2. Timeout revert: stop sending per-LED frames without disable. After ~60 s,
//     does the strip show the stored groups or something else?
import { createKit, type ProbeIO } from './probe-kit.js';
import { DEFAULT_MASK } from './server/protocol.js';
import * as proto from './server/protocol.js';

const FOCUS = [0, 1, 2, 3];
const OTHERS = Array.from({ length: 20 }, (_, i) => i + 4); // rest of the 24-bit mask
const LEDS = 60;
const WARM = 2700;
const REVERT_WAIT_MS = 120_000;

export async function runProbeRound3(io: ProbeIO) {
  const k = createKit(io, 3, DEFAULT_MASK);

  /** Per-LED frame: the first 16 LEDs blue, the rest black. */
  const blue = (() => {
    const px = new Uint8Array(LEDS * 3);
    for (let i = 0; i < FOCUS.length * 4; i++) px[i * 3 + 2] = 255;
    return proto.frame(px);
  })();
  const groups = (focus: Buffer) => k.sendFrames([focus, k.color(OTHERS, [0, 0, 0]), k.bright(FOCUS, 100)]);
  const green = () => groups(k.color(FOCUS, [0, 255, 0]));
  const warm = () => groups(k.white(FOCUS, WARM, [0, 0, 0], [0, 0, 0]));
  /** Per-LED blue for `seconds`, one frame per second (keepalive). */
  const perLedBlue = async (seconds: number) => {
    await k.razer(true);
    for (let t = 0; t < seconds; t++) {
      await k.send(blue);
      await k.sleep(1000);
    }
  };

  k.heading('Segment mode probe, round 3: parking');
  console.log(`Strip ${io.ip}.${io.dry ? ' DRY RUN: nothing is sent.' : ''}
Only the first 4 groups (the first 16 LEDs) are used; the rest of the strip stays dark.
Colors used:  GREEN = an old stored state   BLUE = per-LED   WARM WHITE = the parked look
Before starting: stop govee-zones (or Release), have the Govee app open, watch the first 16 LEDs.
Answers are saved after each test to:
  ${k.file}`);
  await k.enter();
  await k.razer(false);
  await k.send(proto.turn(true));
  await k.send(proto.brightness(100));
  await k.sleep(500);

  // --- 1. Park sequence ----------------------------------------------------
  k.heading('Test 1 of 2: Park sequence, then turn on from outside');
  console.log(`What happens:
  1. groups → GREEN (an old stored state), 2 s
  2. per-LED → BLUE, 3 s
  3. turn off WHILE per-LED is still on
  4. stop per-LED (disable), while off
  5. park: groups → WARM WHITE, while off
Watch steps 3-5: it should go from blue straight to dark and stay dark.`);
  await k.enter('Press Enter to start.');
  await k.repeatable(async () => {
    await k.send(proto.turn(true));
    console.log('    1. green');
    await green();
    await k.sleep(2000);
    console.log('    2. per-LED blue');
    await perLedBlue(3);
    console.log('    3. turn off');
    await k.send(proto.turn(false));
    await k.sleep(500);
    console.log('    4. disable');
    await k.razer(false);
    await k.sleep(500);
    console.log('    5. park warm white (strip is off)');
    await warm();
    console.log('    done; the strip should be dark. A replay turns it back on first.');
  });
  await k.ask('1-park', 'From blue to dark (steps 3-5):', {
    a: 'Clean: blue straight to dark, stayed dark',
    b: 'Green flashed before going dark',
    c: 'Warm white flashed before going dark',
    d: 'Something else (note it)',
  });
  const how = (await k.rl.question(`\n  Now turn the strip ON from the Govee app (power button), then press Enter.
  (Or type "l" + Enter to have the probe send a LAN "turn on" instead.) `)).trim().toLowerCase();
  if (how === 'l') await k.send(proto.turn(true));
  k.constants.turnOnFrom = how === 'l' ? 'lan' : 'govee app';
  await k.ask('1-park', 'When it turned on, the first 16 LEDs showed:', {
    a: 'Warm white straight away (the parked look)',
    b: 'Green (the old state)',
    c: 'Blue (per-LED)',
    d: 'A Govee scene or something else (note it)',
  });
  k.save();

  // --- 2. Timeout revert ---------------------------------------------------
  k.heading('Test 2 of 2: What the strip shows when per-LED times out');
  console.log(`What happens:
  1. groups → WARM WHITE (the stored/parked look)
  2. per-LED → BLUE for 3 s, then frames simply STOP (no disable, like a crash)
  3. you press Enter the moment the first 16 LEDs change (up to ${REVERT_WAIT_MS / 1000} s)`);
  await k.enter('Press Enter to start.');
  await k.repeatable(async () => {
    await warm();
    await k.sleep(2000);
    await perLedBlue(3);
    console.log('    frames stopped. Waiting for the strip to change…');
    const start = Date.now();
    try {
      await k.rl.question('    Press Enter the moment it changes: ', { signal: AbortSignal.timeout(io.dry ? 1 : REVERT_WAIT_MS) });
      const s = Math.round((Date.now() - start) / 1000);
      k.constants.revertAfterSeconds = s;
      console.log(`    changed after ${s} s (counting from the last frame)`);
    } catch {
      k.constants.revertAfterSeconds = null;
      console.log(`\n    no change reported within ${REVERT_WAIT_MS / 1000} s`);
    }
    await k.razer(false);
  });
  await k.ask('2-revert', 'When it changed, the first 16 LEDs showed:', {
    a: 'Warm white (the stored groups)',
    b: 'A Govee scene or other colors (note it)',
    c: 'Went dark / off',
    d: `Didn't change (stayed blue for the whole ${REVERT_WAIT_MS / 1000} s)`,
  });
  await k.ask('2-revert', 'When the probe then sent "disable" (end of the wait), did anything change?', {
    a: 'No', b: 'Yes (note what)',
  });

  await warm();
  k.close();
  k.heading('Done');
  console.log(`Answers: ${k.file}\nRestart govee-zones (or turn off "Release to Govee") when you're done.`);
}
