// The train's shapes for drawing, taken from the sim's geometry (src/sim/geometry.ts: the surfaces,
// solids, ladders, hatches, doorways and interiors the Rider and the bandits actually walk, climb
// and shoot through), so what the player sees is exactly where they can stand and jump (spec §5.1):
// bodies 0.8 m in from each car end (half a bridge plate, then the end platform), roofs 1.6 m
// apart, ladders hanging over the platforms, the cab and its ladder, the tender's deck and bunker
// ladder, the hatches (express, boxcar, caboose) and the safe.

import { trainGeometry, type Doorway, type Hatch, type Interior, type Ladder, type TrainGeometry } from '../../sim/geometry';
import { CAR_SPECS, CUPOLA_Y } from '../../sim/rules';
import type { CarKind, CarState } from '../../sim/types';

export interface CarLook {
  kind: CarKind;
  x0: number;
  x1: number;
  /** The body (walls and roof); for the tender, the coal bunker; for the loco, all of it. */
  bx0: number;
  bx1: number;
  floorY: number;
  /** Walkable top: the roof, the loco's cab roof, the tender's coal top. */
  roofY: number;
  platforms: boolean;
  /** End platforms, against each end of the body. */
  decks: [number, number][];
  /** Half bridge plates, outside the platforms. */
  plates: [number, number][];
  /** Loco: the cab's extent. */
  cab: [number, number] | null;
  /** Tender: the front deck that joins the cab. */
  deck: [number, number] | null;
  /** Caboose: the cupola. */
  cupola: [number, number] | null;
  cupolaY: number;
  hatches: Hatch[];
  ladders: Ladder[];
  doorways: Doorway[];
  interior: Interior | null;
}

export interface TrainLook {
  key: string;
  cars: CarLook[];
  safe: TrainGeometry['safe'];
  tenderHatchX: number;
  geo: TrainGeometry;
}

const cache = new Map<string, TrainLook>();

/** The drawable layout of a consist, cached per layout (the same key the sim's geometry uses). */
export function trainLook(cars: readonly CarState[]): TrainLook {
  const geo = trainGeometry(cars);
  const hit = cache.get(geo.key);
  if (hit) return hit;
  const looks = cars.map((car, i) => carFromGeometry(geo, car, i));
  const out: TrainLook = { key: geo.key, cars: looks, safe: geo.safe, tenderHatchX: geo.tenderHatchX, geo };
  if (cache.size > 16) cache.delete(cache.keys().next().value as string);
  cache.set(geo.key, out);
  return out;
}

function carFromGeometry(geo: TrainGeometry, car: CarState, i: number): CarLook {
  const spec = CAR_SPECS[car.kind];
  const platforms = car.kind !== 'loco' && car.kind !== 'tender';
  let bx0 = car.x0;
  let bx1 = car.x1;
  let roofY = spec.roofY;
  if (platforms) {
    const roof = geo.solids.find((sd) => sd.car === i && sd.kind === 'roof');
    if (roof) {
      bx0 = roof.x0;
      bx1 = roof.x1;
      roofY = roof.y1;
    }
  } else if (car.kind === 'tender') {
    const bunker = geo.solids.find((sd) => sd.car === i && sd.kind === 'bunker');
    if (bunker) {
      bx0 = bunker.x0;
      bx1 = bunker.x1;
      roofY = bunker.y1;
    }
  }
  const decks: [number, number][] = [];
  const plates: [number, number][] = [];
  for (const sf of geo.surfaces) {
    if (sf.car !== i || sf.kind !== 'platform') continue;
    const against = Math.abs(sf.x1 - bx0) < 1e-6 || Math.abs(sf.x0 - bx1) < 1e-6;
    (against ? decks : plates).push([sf.x0, sf.x1]);
  }
  decks.sort((a, b) => a[0] - b[0]);
  plates.sort((a, b) => a[0] - b[0]);
  const cupola = geo.surfaces.find((sf) => sf.car === i && sf.kind === 'cupola');
  const deck = geo.surfaces.find((sf) => sf.car === i && sf.kind === 'tenderDeck');
  const interior = geo.interiors.find((it) => it.car === i) ?? null;
  return {
    kind: car.kind,
    x0: car.x0,
    x1: car.x1,
    bx0,
    bx1,
    floorY: spec.floorY,
    roofY,
    platforms,
    decks,
    plates,
    cab: car.kind === 'loco' ? [geo.cab.x0, geo.cab.x1] : null,
    deck: deck ? [deck.x0, deck.x1] : null,
    cupola: cupola ? [cupola.x0, cupola.x1] : null,
    cupolaY: cupola ? cupola.y : CUPOLA_Y,
    hatches: geo.hatches.filter((h) => h.car === i),
    ladders: geo.ladders.filter((l) => l.car === i),
    doorways: geo.doorways.filter((d) => d.car === i),
    interior,
  };
}

/** The look of car `i` of a consist. */
export function carLook(cars: readonly CarState[], i: number): CarLook {
  return trainLook(cars).cars[i];
}
