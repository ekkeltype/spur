// What each seat hears (spec §18.3): the mapping from game state to the audio engine's layers.

import { describe, expect, it } from 'vitest';
import { brakeLevel, panOf, windLevel } from '../src/ui/sounds';

const rider = (patch: Partial<Parameters<typeof windLevel>[0]> = {}) => ({ mode: 'active' as const, inside: null, surface: 'roof' as const, ladder: null, ...patch });

describe('the Rider’s soundscape', () => {
  it('wind: full on top, about half on platforms and ladders, none inside or off the train', () => {
    expect(windLevel(rider(), 25)).toBeCloseTo(1 / 1.4);
    expect(windLevel(rider(), 40)).toBe(1);
    expect(windLevel(rider({ surface: 'tenderTop' }), 25)).toBeCloseTo(1 / 1.4);
    expect(windLevel(rider({ surface: 'platform' }), 40)).toBe(0.5);
    expect(windLevel(rider({ surface: null, ladder: 2 }), 40)).toBe(0.5);
    expect(windLevel(rider({ surface: null }), 40)).toBe(1); // in the air between roofs
    expect(windLevel(rider({ surface: 'floor', inside: 3 }), 40)).toBe(0);
    expect(windLevel(rider({ surface: 'cabFloor' }), 40)).toBe(0);
    expect(windLevel(rider({ mode: 'off' }), 40)).toBe(0);
    expect(windLevel(rider(), 0)).toBe(0);
  });

  it('brakes squeal only while the wheels turn', () => {
    expect(brakeLevel(1, 20)).toBe(1);
    expect(brakeLevel(0.5, -20)).toBe(0.5);
    expect(brakeLevel(1, 0.75)).toBe(0.5);
    expect(brakeLevel(1, 0)).toBe(0);
  });

  it('pans by the place across the view, or by the offset from the Rider without one', () => {
    const view = { left: 10, right: 50 };
    expect(panOf(10, view, 30)).toBe(-1);
    expect(panOf(30, view, 0)).toBe(0);
    expect(panOf(80, view, 30)).toBe(1);
    expect(panOf(45, null, 30)).toBeCloseTo(0.5);
  });
});
