// Group looks → segment (ptReal) datagrams, with diffing; and → preview pixels.
import { miredsToRgb, scale } from '../shared/color.js';
import { groupBounds } from '../shared/groups.js';
import type { Device, RGB } from '../shared/types.js';
import type { GroupLook } from './plan.js';
import * as proto from './protocol.js';

/** Frames per datagram: 6 verified on the H805A (probe round 1). */
export const MAX_FRAMES_PER_DATAGRAM = 6;

/** What we last sent to a group: its color identity, and brightness if lit. */
export interface SentGroup {
  color: string;
  pct?: number;
}

const colorKey = (l: GroupLook) => (l.kind === 'off' ? 'off' : l.kind === 'white' ? `white:${l.kelvin}` : `rgb:${l.rgb.join(',')}`);

/**
 * Frames that bring the strip from `sent` to `looks`. Only changed groups are
 * included; pass an empty `sent` for a full send. White is sent as kelvin with
 * RGB and tint 0 (ignored by the firmware). Off is RGB 0 + kelvin 0: brightness 0
 * isn't off (it clamps to 1 %). White-balance gains apply to RGB only.
 */
export function encodeGroups(looks: GroupLook[], sent: (SentGroup | undefined)[], gains?: RGB): { frames: Buffer[]; sent: SentGroup[] } {
  const colors = new Map<string, { look: GroupLook; groups: number[] }>();
  const pcts = new Map<number, number[]>();
  const next: SentGroup[] = [];
  looks.forEach((look, g) => {
    const key = colorKey(look);
    const pct = look.kind === 'off' ? undefined : look.pct;
    next[g] = { color: key, pct };
    const prev = sent[g];
    const colorChanged = prev?.color !== key;
    if (colorChanged) {
      const c = colors.get(key) ?? { look, groups: [] };
      c.groups.push(g);
      colors.set(key, c);
    }
    if (pct !== undefined && (colorChanged || prev?.pct !== pct)) pcts.set(pct, [...(pcts.get(pct) ?? []), g]);
  });
  const frames: Buffer[] = [];
  for (const { look, groups } of colors.values()) {
    const mask = proto.segmentMask(groups);
    if (look.kind === 'off') frames.push(proto.segmentColorFrame([0, 0, 0], 0, [0, 0, 0], mask));
    else if (look.kind === 'white') frames.push(proto.segmentColorFrame([0, 0, 0], look.kelvin, [0, 0, 0], mask));
    else {
      const rgb = gains ? look.rgb.map((v, i) => Math.round((v * gains[i]) / 100)) : look.rgb;
      frames.push(proto.segmentColorFrame(rgb, 0, [0, 0, 0], mask));
    }
  }
  for (const [pct, groups] of pcts) frames.push(proto.segmentBrightnessFrame(pct, proto.segmentMask(groups)));
  return { frames, sent: next };
}

/** Pack BLE frames into ptReal datagrams. */
export function packDatagrams(frames: Buffer[], max = MAX_FRAMES_PER_DATAGRAM): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < frames.length; i += max) out.push(proto.ptReal(frames.slice(i, i + max)));
  return out;
}

/** Group looks expanded to LEDs for the UI preview (uncorrected; white via the blackbody fit). */
export function groupPixels(device: Device, looks: GroupLook[]): Uint8Array {
  const out = new Uint8Array(device.ledCount * 3);
  groupBounds(device.ledCount, device.groupSize).forEach(([lo, hi], g) => {
    const l = looks[g];
    if (!l || l.kind === 'off') return;
    const c = scale(l.kind === 'white' ? miredsToRgb(1_000_000 / l.kelvin) : l.rgb, (l.pct / 100) * 255);
    for (let i = lo; i <= hi; i++) out.set(c, i * 3);
  });
  return out;
}
