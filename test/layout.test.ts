import { describe, expect, it } from 'vitest';
import { ledPositions } from '../src/shared/layout.js';

const round = (p: { x: number; y: number } | null) => p && { x: Math.round(p.x), y: Math.round(p.y) };

describe('ledPositions', () => {
  it('needs at least two points', () => {
    expect(ledPositions({ height: 500, points: [{ x: 0, y: 0 }] }, 10)).toEqual([]);
    expect(ledPositions(undefined, 10)).toEqual([]);
  });

  it('spreads LEDs evenly along an unpinned path, corners included', () => {
    // L-shape: 100 right, then 100 down; 5 LEDs → every 50 units.
    const pos = ledPositions({ height: 500, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] }, 5);
    expect(pos.map(round)).toEqual([
      { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 100, y: 100 },
    ]);
  });

  it('honours pinned LEDs at corners', () => {
    // Corner pinned to LED 8 of 11: 9 LEDs on the first leg, 3 on the second.
    const pos = ledPositions(
      { height: 500, points: [{ x: 0, y: 0 }, { x: 80, y: 0, led: 8 }, { x: 80, y: 20 }] },
      11,
    );
    expect(round(pos[4])).toEqual({ x: 40, y: 0 });
    expect(round(pos[8])).toEqual({ x: 80, y: 0 });
    expect(round(pos[9])).toEqual({ x: 80, y: 10 });
    expect(round(pos[10])).toEqual({ x: 80, y: 20 });
  });

  it('leaves LEDs outside the pinned span unplaced', () => {
    // Traced path covers LEDs 10-20 only.
    const pos = ledPositions({ height: 500, points: [{ x: 0, y: 0, led: 10 }, { x: 100, y: 0, led: 20 }] }, 30);
    expect(pos[9]).toBeNull();
    expect(round(pos[15])).toEqual({ x: 50, y: 0 });
    expect(pos[21]).toBeNull();
  });

  it('ignores pins that go backwards', () => {
    const pos = ledPositions(
      { height: 500, points: [{ x: 0, y: 0 }, { x: 50, y: 0, led: 0 }, { x: 100, y: 0 }] },
      3,
    );
    expect(pos.map(round)).toEqual([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]);
  });
});
