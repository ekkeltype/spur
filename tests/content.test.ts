import { describe, expect, it } from 'vitest';
import { clock, estimate, HATCH_BEHIND_FRONT, Line, longestTrain, makeRun, plannedPath, runawayRollTime, sliceSpans } from '../src/content/builder';
import { RUNS, runById } from '../src/content/runs';
import { edgeOf, netIndex, spansFromFront, spansLength, spansOverlap, validateRun, walk, xOnSpans, type NetIndex } from '../src/sim/network';
import { MILE, SPOUT_WINDOW, WHISTLE_SCARE_MAX, WHISTLE_SCARE_MIN } from '../src/sim/rules';
import { routeDistanceAt, routeSpans, timeAtRouteDistance } from '../src/sim/schedule';
import type { AiTrainDef, CarType, Cargo, RunDef, RunPlan, SwitchState, TrackPoint } from '../src/sim/types';

// ---- Helpers -------------------------------------------------------------------------------

const hm = (c: number): string => `${Math.floor(c / 3600)}:${String(Math.floor((c % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(c % 60)).padStart(2, '0')}`;

const variantsOf = (run: RunDef): [string, RunPlan][] => run.variants.map((v) => [v, run.plan[v]]);

const scheduled = (run: RunDef): AiTrainDef[] => run.aiTrains.filter((t) => t.kind !== 'runaway');

/** Every edge on some forward route from the start to the destination (any switch settings). */
function forwardEdges(run: RunDef): Set<string> {
  const ix = netIndex(run);
  const dest = run.stations.find((s) => s.id === run.contract.destination)!;
  const out = new Set<string>();
  const nodes = run.junctions.map((j) => j.node);
  for (let mask = 0; mask < 1 << nodes.length; mask++) {
    const sw: Record<string, SwitchState> = {};
    nodes.forEach((n, i) => (sw[n] = mask & (1 << i) ? 'reverse' : 'normal'));
    const w = walk(ix, sw, run.start, 1e6);
    const reached: string[] = [];
    let arrived = false;
    for (const s of w.spans) {
      reached.push(s.edge);
      if (s.edge === dest.edge) {
        arrived = true;
        break;
      }
    }
    if (arrived) for (const e of reached) out.add(e);
  }
  return out;
}

/** Route distance to where a scheduled train first crosses a node, or null. */
function routeDistanceToNode(ix: NetIndex, def: AiTrainDef, node: string): number | null {
  let acc = 0;
  for (const [i, leg] of def.route.entries()) {
    const e = edgeOf(ix, leg.edge);
    const entry = leg.dir === 1 ? e.a : e.b;
    if (i === 0 && entry === node) return 0;
    acc += e.length;
    if ((leg.dir === 1 ? e.b : e.a) === node) return acc;
  }
  return null;
}

/** Clashes between the plan's estimated drive and the scheduled trains (1 s steps). */
function conflicts(run: RunDef, variant: string): string[] {
  const est = estimate(run, variant);
  const ix = netIndex(run);
  const L = longestTrain(run);
  const behind = spansFromFront(ix, est.path.switches, run.start, L);
  const full = [...behind, ...est.path.spans];
  const bl = spansLength(behind);
  const out: string[] = [];
  for (let t = run.startClock; t <= est.arrive; t += 1) {
    const x = bl + est.frontAt(t);
    const ours = sliceSpans(full, x - L, x);
    for (const def of scheduled(run)) {
      if (spansOverlap(ours, routeSpans(ix, def, routeDistanceAt(def, t)))) out.push(`${def.id} at ${hm(t)}`);
    }
    if (out.length > 0) break;
  }
  return out;
}

const CARGO_CAR: Record<Cargo, CarType> = { mail: 'boxcar', freight: 'boxcar', payroll: 'express', silver: 'express', cash: 'express', gold: 'express', dynamite: 'powder' };

// ---- The builder ---------------------------------------------------------------------------

describe('builder', () => {
  const line = new Line({
    length: 6000,
    speed: 25,
    terrain: [
      [0, 'town'],
      [800, 'desert'],
      [4200, 'canyon'],
    ],
    ends: ['To Juniper', 'To Mesa'],
    loops: [{ id: 'lp', name: 'Pine siding', from: 2000, to: 2400 }],
    cutoffs: [{ id: 'cut', name: 'Gulch cutoff', from: 3000, to: 5000, speed: 15, parts: [[900, 'canyon'], [700, 'mesa']], junctions: ['Gulch Jct.', 'Gulch East Jct.'], side: -1 }],
    spurs: [
      { id: 'sp', name: 'Quarry spur', at: 5500, length: 300, toward: -1 },
      { id: 'br', name: 'Red Rock branch', at: 1500, length: 800, toward: 1, kind: 'branch', label: 'To Red Rock' },
    ],
  });
  const run = makeRun(line, {
    id: 'b',
    index: 0,
    act: 1,
    name: 'B',
    flavor: '',
    briefing: { rider: [], engineer: [] },
    startClock: clock(9, 0),
    night: false,
    stations: [line.station('o', 'Origin', 400), line.station('d', 'Dest', 5800)],
    contract: { cargo: 'mail', title: 'T', pay: 1, destination: 'd', deadline: clock(9, 10), latePenaltyPerMin: 1, critical: false },
    origin: 'o',
    initialWater: 100,
    variants: ['main'],
    requiredCars: ['boxcar'],
    par: 300,
    plan: { main: { cruise: 20, switches: [], stops: ['d'], holds: [], whistles: [], minSpeeds: [] } },
  });
  const ix = netIndex(run);

  it('builds a valid network with nodes at every switch and terrain change', () => {
    expect(validateRun(run)).toEqual([]);
    expect(run.nodes.find((n) => n.id === 'W')).toMatchObject({ kind: 'end', label: 'To Juniper', x: 0, y: 0 });
    expect(run.nodes.filter((n) => n.kind === 'junction').map((n) => n.id).sort()).toEqual(['br-j', 'cut-e', 'cut-w', 'lp-e', 'lp-w', 'sp-j']);
    expect(run.mainLine.map((id) => edgeOf(ix, id).terrain)).toEqual(['town', 'desert', 'desert', 'desert', 'desert', 'desert', 'canyon', 'canyon', 'canyon']);
    const total = run.mainLine.reduce((n, id) => n + edgeOf(ix, id).length, 0);
    expect(total).toBe(6000);
  });

  it('maps every edge onto the main line: main edges by distance, sidings beside it, cutoffs linearly', () => {
    let d = 0;
    for (const id of run.mainLine) {
      const e = edgeOf(ix, id);
      expect(e.mainAt).toEqual([d, d + e.length]);
      d += e.length;
    }
    expect(edgeOf(ix, 'lp').mainAt).toEqual([2000, 2400]);
    expect(edgeOf(ix, 'cut-1').mainAt).toEqual([3000, 3000 + (2000 * 900) / 1600]);
    expect(edgeOf(ix, 'cut-2').mainAt).toEqual([3000 + (2000 * 900) / 1600, 5000]);
    expect(edgeOf(ix, 'sp').mainAt).toEqual([5500, 5200]);
    expect(edgeOf(ix, 'br').mainAt).toBeUndefined(); // a branch off the map isn't on our timetable
    expect(edgeOf(ix, 'cut-1').via).toBeDefined();
    expect(edgeOf(ix, 'lp').via?.every(([, y]) => y !== 0)).toBe(true);
  });

  it('infers trunk and legs from how each branch is declared', () => {
    const j = (id: string) => run.junctions.find((x) => x.node === id)!;
    const main = (from: number) => line.at(from).edge;
    expect(j('lp-w')).toMatchObject({ trunk: main(1999), normal: main(2000), reverse: 'lp' });
    expect(j('lp-e')).toMatchObject({ trunk: main(2400), normal: main(2399), reverse: 'lp' });
    expect(j('cut-w')).toMatchObject({ trunk: main(2999), normal: main(3000), reverse: 'cut-1', name: 'Gulch Jct.' });
    expect(j('cut-e')).toMatchObject({ trunk: main(5000), normal: main(4999), reverse: 'cut-2', name: 'Gulch East Jct.' });
    // A west-facing spur is taken by westbound trains: its trunk is on the east side.
    expect(j('sp-j')).toMatchObject({ trunk: main(5500), normal: main(5499), reverse: 'sp' });
    expect(j('br-j')).toMatchObject({ trunk: main(1499), normal: main(1500), reverse: 'br' });
    expect(edgeOf(ix, 'br').kind).toBe('branch');
  });

  it('resolves places on the main line and along branches, and refuses stretches across nodes', () => {
    expect(line.at(1000)).toEqual({ edge: main(1000), off: 200 });
    expect(line.at(['cut', 1000])).toEqual({ edge: 'cut-2', off: 100 });
    expect(line.at(['lp', 150])).toEqual({ edge: 'lp', off: 150 });
    expect(line.span([900, 1100])).toEqual({ edge: main(1000), from: 100, to: 300 });
    expect(() => line.span([700, 900])).toThrow(/crosses a node/);
    expect(() => line.at(7000)).toThrow();
    function main(d: number): string {
      return line.at(d).edge;
    }
  });

  it('puts a milepost every quarter mile along the main line', () => {
    expect(run.mileposts.length).toBe(Math.floor(6000 / (MILE / 4)));
    expect(run.mileposts[3].mile).toBe(1);
    const mp = run.mileposts[3];
    const e = edgeOf(ix, mp.edge);
    expect(e.mainAt![0] + mp.at).toBeCloseTo(MILE, 6);
  });

  it('builds scheduled trains’ routes along the main line, through cutoffs and off onto branches', () => {
    const west = line.route('west');
    expect(west.map((l) => l.edge)).toEqual(run.mainLine);
    const east = line.route('east', { via: ['cut'] });
    expect(east[0]).toEqual({ edge: run.mainLine[run.mainLine.length - 1], dir: -1 });
    expect(east.map((l) => l.edge)).toContain('cut-2');
    expect(east.map((l) => l.edge)).not.toContain(line.at(4000).edge);
    const toBranch = line.route('west', { leave: 'br' });
    expect(toBranch.map((l) => l.edge)).toEqual([run.mainLine[0], run.mainLine[1], 'br']);
    expect(() => line.route('east', { leave: 'br' })).toThrow(/doesn't face/);
    expect(validateRun({ ...run, aiTrains: [{ id: 'f', name: 'F', kind: 'freight', cars: 5, length: 80, route: east, depart: clock(9, 1), speed: 10, stops: [], charted: true }] })).toEqual([]);
  });

  it('answers timetable questions: when a train reaches and clears a place or a loop', () => {
    const f: AiTrainDef = { id: 'f', name: 'F', kind: 'freight', cars: 5, length: 100, route: line.route('east'), depart: clock(9, 0), speed: 10, stops: [], charted: true };
    expect(line.arrives(f, 5000)).toBe(clock(9, 0) + 100);
    expect(line.clears(f, 5000)).toBe(clock(9, 0) + 110);
    expect(line.reachesSection(f, 'lp')).toBe(clock(9, 0) + 360);
    expect(line.clearsSection(f, 'lp')).toBe(clock(9, 0) + 410);
  });

  it('walks a plan to the destination and estimates it', () => {
    const path = plannedPath(run, 'main')!;
    expect(path.length).toBe(5400);
    const est = estimate(run, 'main');
    // 5.4 km at 20 m/s is 270 s; starting, stopping and the dwell add about a minute.
    expect(est.arrive - run.startClock).toBeGreaterThan(290);
    expect(est.arrive - run.startClock).toBeLessThan(400);
    expect(est.frontAt(est.arrive)).toBe(5400);
    expect(est.timeAt(0)).toBe(run.startClock);
    const reversed = { ...run, plan: { main: { ...run.plan.main, switches: [{ junction: 'cut-w', state: 'reverse' as const }] } } };
    expect(plannedPath(reversed, 'main')!.length).toBe(5400 - 2000 + 1600);
  });

  it('knows the hatch, the longest train and the runaway’s roll', () => {
    expect(HATCH_BEHIND_FRONT).toBe(23);
    expect(longestTrain(run)).toBe(16 + 9 + 5 * 17);
    expect(runawayRollTime(245)).toBeCloseTo(35, 6);
    expect(runawayRollTime(245 + 140)).toBeCloseTo(45, 6);
  });
});

// ---- The campaign --------------------------------------------------------------------------

describe('the campaign', () => {
  it('has the six runs of spec §13 in order, in two acts', () => {
    expect(RUNS.map((r) => r.name)).toEqual(['First Light', 'Payroll to Pale Rock', 'Signal Country', 'Single Track', 'Night Freight', 'The Blackwater Line']);
    expect(RUNS.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(RUNS.map((r) => r.act)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(new Set(RUNS.map((r) => r.id)).size).toBe(RUNS.length);
    for (const r of RUNS) expect(runById(r.id)).toBe(r);
    expect(runById('nowhere')).toBeUndefined();
  });

  it('carries the contracts of spec §13', () => {
    expect(RUNS.map((r) => [r.contract.cargo, r.contract.pay, r.contract.critical])).toEqual([
      ['mail', 120, false],
      ['payroll', 220, true],
      ['silver', 260, true],
      ['cash', 240, true],
      ['dynamite', 300, true],
      ['gold', 400, true],
    ]);
  });

  it('is night only in run 5', () => {
    expect(RUNS.map((r) => r.night)).toEqual([false, false, false, false, true, false]);
  });

  it('ramps the bandits from three tier-1 riders to the boss and his gang', () => {
    const maxTier = RUNS.map((r) => Math.max(...r.waves.map((w) => w.tier)));
    expect(maxTier[0]).toBe(1);
    expect(maxTier[5]).toBe(3);
    for (let i = 1; i < RUNS.length; i++) expect(maxTier[i]).toBeGreaterThanOrEqual(maxTier[i - 1]);
    expect(Math.max(...RUNS[0].waves.map((w) => w.count))).toBe(3);
    RUNS.forEach((r, i) => expect(r.waves.some((w) => w.boss)).toBe(i === 5));
    const boss = RUNS[5].waves.find((w) => w.boss)!;
    expect(boss.goal).toBe('safe');
    // The boss rides in with a mixed-tier gang: waves sprung at the same place.
    const gang = RUNS[5].waves.filter((w) => w.trigger.edge === boss.trigger.edge && Math.abs(w.trigger.off - boss.trigger.off) < 300);
    expect(gang.reduce((n, w) => n + w.count, 0)).toBeGreaterThanOrEqual(6);
    expect(new Set(gang.map((w) => w.tier)).size).toBeGreaterThanOrEqual(2);
  });

  it('gets busier: more track, more riders, more traffic', () => {
    const junctions = RUNS.map((r) => r.junctions.length);
    const riders = RUNS.map((r) => r.waves.reduce((n, w) => n + w.count, 0));
    expect(junctions[0]).toBe(0);
    expect(junctions[5]).toBeGreaterThan(junctions[1]);
    expect(riders[5]).toBeGreaterThan(riders[0] * 2);
    expect(RUNS.map((r) => scheduled(r).length)).toEqual([0, 0, 0, 1, 2, 1]);
  });
});

// ---- Every run -----------------------------------------------------------------------------

for (const run of RUNS) {
  describe(`${run.index + 1}. ${run.name}`, () => {
    const ix = netIndex(run);
    const fwd = forwardEdges(run);
    const initial: Record<string, SwitchState> = Object.fromEntries(run.junctions.map((j) => [j.node, j.initial]));
    const kindOf = (edge: string) => edgeOf(ix, edge).kind;

    it('is a sound network', () => {
      expect(validateRun(run)).toEqual([]);
      const ids = [...run.stations, ...run.waterTowers, ...run.tunnels, ...run.lowBridges, ...run.trestles, ...run.curves, ...run.signals, ...run.obstacles].map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(run.waves.map((w) => w.id)).size).toBe(run.waves.length);
      expect(new Set(run.telegrams.map((t) => t.id)).size).toBe(run.telegrams.length);
    });

    it('starts stopped on the origin’s stop mark with room behind for the longest train', () => {
      const origin = run.stations.find((s) => s.id === run.origin)!;
      expect(run.start).toEqual({ edge: origin.edge, off: origin.at, dir: 1 });
      expect(kindOf(origin.edge)).toBe('main');
      expect(spansLength(spansFromFront(ix, initial, run.start, longestTrain(run) + 50))).toBeCloseTo(longestTrain(run) + 50, 6);
      expect(run.mainLine).toContain(run.stations.find((s) => s.id === run.contract.destination)!.edge);
      expect(run.initialWater).toBe(run.index === 1 ? 55 : 100);
      expect(run.maxCars).toBe(5);
    });

    it('dresses the scenery: towns at stations, trestles over water or gorges, tunnels through high ground', () => {
      for (const s of run.stations) expect(edgeOf(ix, s.edge).terrain, s.id).toBe('town');
      for (const t of run.trestles) expect(['river', 'canyon'], t.id).toContain(edgeOf(ix, t.edge).terrain);
      for (const t of run.tunnels) expect(['hills', 'mesa', 'canyon'], t.id).toContain(edgeOf(ix, t.edge).terrain);
      expect(new Set(run.edges.map((e) => e.terrain)).size).toBeGreaterThanOrEqual(4);
    });

    it('keeps every feature on a forward route to the destination', () => {
      const on = (id: string, edge: string) => expect(fwd.has(edge), `${id} on ${edge}`).toBe(true);
      for (const f of [...run.stations, ...run.waterTowers, ...run.tunnels, ...run.lowBridges, ...run.trestles, ...run.curves, ...run.signals, ...run.obstacles]) on(f.id, f.edge);
      for (const w of run.waves) on(w.id, w.trigger.edge);
      for (const t of run.telegrams) {
        if (t.at) on(t.id, t.at.edge);
        if (t.clock !== undefined) expect(t.clock).toBeGreaterThanOrEqual(run.startClock);
      }
    });

    it('fits its cargo: required cars, and bandits that go for what is aboard', () => {
      expect(run.requiredCars).toContain(CARGO_CAR[run.contract.cargo]);
      for (const w of run.waves) {
        if (w.goal === 'safe' || w.goal === 'mixed') expect(run.requiredCars, w.id).toContain('express');
        if (w.goal === 'powder') expect(run.requiredCars, w.id).toContain('powder');
      }
      expect(run.waves.some((w) => w.goal === 'powder')).toBe(run.requiredCars.includes('powder'));
      expect(run.flavor.length).toBeGreaterThan(20);
      for (const lines of [run.briefing.rider, run.briefing.engineer]) {
        expect(lines.length).toBeGreaterThanOrEqual(2);
        expect(lines.length).toBeLessThanOrEqual(4);
      }
    });

    it('places each junction signal 300–500 m before its junction, approaching from the trunk', () => {
      for (const s of run.signals.filter((x) => x.kind === 'junction')) {
        const w = walk(ix, initial, { edge: s.edge, off: s.at, dir: s.facing }, 600);
        const first = w.nodes.find((n) => ix.junction.has(n.node));
        expect(first?.node, s.id).toBe(s.junction);
        expect(first!.at).toBeGreaterThanOrEqual(300);
        expect(first!.at).toBeLessThanOrEqual(500);
        let acc = 0;
        let arrivedOn = '';
        for (const sp of w.spans) {
          acc += Math.abs(sp.to - sp.from);
          if (Math.abs(acc - first!.at) < 1e-6) {
            arrivedOn = sp.edge;
            break;
          }
        }
        expect(arrivedOn, s.id).toBe(ix.junction.get(s.junction!)!.trunk);
      }
    });

    it('runs its scheduled trains from map edge to map edge, on main lines, clear of each other', () => {
      const trains = scheduled(run);
      const node = (id: string) => run.nodes.find((n) => n.id === id)!;
      for (const t of trains) {
        expect(t.charted).toBe(true);
        const first = edgeOf(ix, t.route[0].edge);
        const lastLeg = t.route[t.route.length - 1];
        const last = edgeOf(ix, lastLeg.edge);
        expect(node(t.route[0].dir === 1 ? first.a : first.b).kind).toBe('end');
        expect(node(lastLeg.dir === 1 ? last.b : last.a).kind).toBe('end');
        for (const l of t.route) expect(['main', 'branch']).toContain(kindOf(l.edge));
      }
      for (let i = 0; i < trains.length; i++)
        for (let j = i + 1; j < trains.length; j++)
          for (let c = run.startClock; c < run.contract.deadline + 600; c += 2) {
            const a = routeSpans(ix, trains[i], routeDistanceAt(trains[i], c));
            const b = routeSpans(ix, trains[j], routeDistanceAt(trains[j], c));
            expect(spansOverlap(a, b), `${trains[i].id} meets ${trains[j].id} at ${hm(c)}`).toBe(false);
          }
    });

    for (const [variant, plan] of variantsOf(run)) {
      describe(`plan ${variant}`, () => {
        const path = plannedPath(run, variant);
        const est = path ? estimate(run, variant) : null;
        const inVariant = (f: { variants?: string[] }): boolean => !f.variants || f.variants.includes(variant);

        it('reaches the destination, setting its switches in the order it meets them', () => {
          expect(path).not.toBeNull();
          const crossed: string[] = [];
          path!.spans.forEach((s, i) => {
            const next = path!.spans[i + 1];
            if (!next || next.edge === s.edge) return;
            const e = edgeOf(ix, s.edge);
            crossed.push(s.to > s.from ? e.b : e.a);
          });
          const order = plan.switches.map((s) => crossed.indexOf(s.junction));
          expect(order.every((i) => i >= 0), JSON.stringify(plan.switches)).toBe(true);
          expect([...order].sort((a, b) => a - b)).toEqual(order);
          expect(new Set(plan.switches.map((s) => s.junction)).size).toBe(plan.switches.length);
          for (const s of plan.switches) expect(ix.junction.get(s.junction)!.initial, s.junction).not.toBe(s.state);
          expect(plan.cruise).toBeGreaterThanOrEqual(18);
          expect(plan.cruise).toBeLessThanOrEqual(22);
        });

        it('stops in order along its route, ending at the destination', () => {
          const xs = plan.stops.map((id) => {
            const st = run.stations.find((s) => s.id === id);
            const tw = run.waterTowers.find((w) => w.id === id);
            expect(st ?? tw, id).toBeDefined();
            const x = st ? path!.x({ edge: st.edge, off: st.at }) : path!.x({ edge: tw!.edge, off: tw!.at });
            expect(x, id).not.toBeNull();
            // At a tower the loco's front stops with the hatch under the spout: still on the route.
            if (tw) expect(x! + HATCH_BEHIND_FRONT + SPOUT_WINDOW).toBeLessThanOrEqual(path!.length);
            return st ? x! : x! + HATCH_BEHIND_FRONT;
          });
          for (let i = 1; i < xs.length; i++) expect(xs[i], plan.stops[i]).toBeGreaterThan(xs[i - 1] + 50);
          expect(plan.stops[plan.stops.length - 1]).toBe(run.contract.destination);
          for (const p of [...plan.whistles, ...plan.minSpeeds.map((m) => m.from)]) expect(path!.x(p)).not.toBeNull();
        });

        it('holds only inside sidings, clear of the other trains, until they have cleared', () => {
          const L = longestTrain(run);
          for (const [i, h] of plan.holds.entries()) {
            const x = path!.x(h.at);
            expect(x, `hold ${i + 1}`).not.toBeNull();
            const e = edgeOf(ix, h.at.edge);
            expect(e.kind).toBe('siding');
            // The whole train stands on the siding, clear of both switches.
            expect(h.at.off - L).toBeGreaterThanOrEqual(20);
            expect(h.at.off).toBeLessThanOrEqual(e.length - 20);
            for (const t of scheduled(run)) expect(t.route.some((l) => l.edge === e.id), t.id).toBe(false);
            const arrive = est!.halts.find((hh) => hh.id === `hold ${i + 1}`)!.arrive;
            expect(h.until - arrive, `hold ${i + 1} is a real wait`).toBeGreaterThan(30);
            // Sheltered from the first stop (a siding platform or tank, or the hold) with the whole train inside.
            const start = x! - h.at.off;
            const sheltered = Math.min(...est!.halts.filter((hh) => hh.x >= start + L + 20 && hh.x <= start + e.length - 20).map((hh) => hh.arrive));
            const met = scheduled(run).filter((t) => {
              const dA = routeDistanceToNode(ix, t, e.a);
              const dB = routeDistanceToNode(ix, t, e.b);
              if (dA === null || dB === null) return false;
              const tIn = timeAtRouteDistance(t, Math.min(dA, dB));
              const tOut = timeAtRouteDistance(t, Math.max(dA, dB) + t.length);
              if (!(tIn <= h.until && tOut >= sheltered - 60)) return false;
              expect(tIn - sheltered, `${t.id} arrives well after we're in the siding`).toBeGreaterThanOrEqual(45);
              expect(h.until - tOut, `${t.id}: hold margin`).toBeGreaterThanOrEqual(15);
              expect(h.until - tOut, `${t.id}: hold margin`).toBeLessThanOrEqual(75);
              return true;
            });
            expect(met.length, `hold ${i + 1} meets a train`).toBeGreaterThan(0);
          }
        });

        it('runs clear of every scheduled train, and would not without its holds', () => {
          expect(conflicts(run, variant)).toEqual([]);
          if (plan.holds.length === 0) return;
          const sidings = new Set(run.edges.filter((e) => e.kind === 'siding').map((e) => e.id));
          const onSiding = (id: string) => sidings.has([...run.stations, ...run.waterTowers].find((f) => f.id === id)!.edge);
          const reckless: RunPlan = {
            ...plan,
            holds: [],
            stops: plan.stops.filter((id) => !onSiding(id)),
            switches: plan.switches.filter((s) => !(s.state === 'reverse' && sidings.has(ix.junction.get(s.junction)!.reverse))),
          };
          expect(conflicts({ ...run, plan: { ...run.plan, [variant]: reckless } }, variant).length).toBeGreaterThan(0);
        });

        it('whistles the cattle off, avoids the rocks and meets barricades slowly', () => {
          for (const o of run.obstacles.filter(inVariant)) {
            const x = path!.x({ edge: o.edge, off: o.at });
            if (o.kind === 'rocks') {
              expect(x, `${o.id} blocks the plan`).toBeNull();
              continue;
            }
            if (x === null) continue;
            if (o.kind === 'cattle') {
              const w = plan.whistles.map((p) => x - path!.x(p)!).filter((d) => d >= 200 && d <= WHISTLE_SCARE_MAX - 10);
              expect(w.length, `${o.id} whistled`).toBeGreaterThan(0);
              expect(WHISTLE_SCARE_MIN).toBeLessThan(200);
            }
            if (o.kind === 'barricade') {
              const halt = est!.halts.find((h) => x - h.x >= 15 && x - h.x <= 40);
              expect(halt, `${o.id} just past a stop`).toBeDefined();
            }
            // Cattle and barricades lie outside every signal's block, or its signal would hold us short.
            const sigs = run.signals.map((s) => path!.x({ edge: s.edge, off: s.at })).filter((sx): sx is number => sx !== null && sx < x);
            if (sigs.length > 0) expect(x - Math.max(...sigs), `${o.id} is in a block`).toBeGreaterThan(2600);
          }
        });

        it('crosses burning trestles fast enough, out of the curve before them', () => {
          for (const tr of run.trestles.filter((t) => t.burning)) {
            const x0 = Math.min(path!.x({ edge: tr.edge, off: tr.from }) ?? Infinity, path!.x({ edge: tr.edge, off: tr.to }) ?? Infinity);
            if (x0 === Infinity) continue;
            const min = tr.burning!.minSpeed;
            const runUp = plan.minSpeeds.map((m) => ({ x: path!.x(m.from)!, speed: m.speed })).find((m) => m.x < x0 && x0 - m.x <= 700);
            expect(runUp, tr.id).toBeDefined();
            expect(runUp!.speed).toBeGreaterThanOrEqual(min + 1);
            const curve = run.curves
              .map((c) => ({ c, end: Math.max(path!.x({ edge: c.edge, off: c.from }) ?? -1, path!.x({ edge: c.edge, off: c.to }) ?? -1) }))
              .filter((c) => c.end >= 0 && c.end < x0)
              .sort((a, b) => b.end - a.end)[0];
            expect(curve.c.limit).toBeLessThanOrEqual(min + 0.5);
            expect(x0 - curve.end).toBeGreaterThanOrEqual(300);
            expect(x0 - curve.end).toBeLessThanOrEqual(600);
            expect(runUp!.x).toBeGreaterThanOrEqual(curve.end - 1);
          }
        });

        it('fits the deadline with 15–30% to spare, takes 8–15 minutes and never runs dry', () => {
          const dur = est!.arrive - run.startClock;
          const allowed = run.contract.deadline - run.startClock;
          const note = `plan ${Math.round(dur)} s, allowed ${allowed} s`;
          expect(dur, note).toBeGreaterThanOrEqual(8 * 60);
          expect(dur, note).toBeLessThanOrEqual(15 * 60);
          expect(allowed / dur, note).toBeGreaterThanOrEqual(1.15);
          expect(allowed / dur, note).toBeLessThanOrEqual(1.3);
          expect(Math.abs(run.par - dur) / dur, `par ${run.par}, ${note}`).toBeLessThanOrEqual(0.15);
          expect(est!.minWater, 'water').toBeGreaterThanOrEqual(5);
        });

        it('spaces tunnels and low bridges so there is time to call them', () => {
          const hazards = [
            ...run.tunnels.map((t) => [path!.x({ edge: t.edge, off: t.from }), path!.x({ edge: t.edge, off: t.to })]),
            ...run.lowBridges.map((b) => [path!.x({ edge: b.edge, off: b.at }), path!.x({ edge: b.edge, off: b.at })]),
          ]
            .filter((r): r is [number, number] => r[0] !== null && r[1] !== null)
            .map(([a, b]) => [Math.min(a, b), Math.max(a, b)])
            .sort((a, b) => a[0] - b[0]);
          if (hazards.length > 0) expect(hazards[0][0]).toBeGreaterThanOrEqual(700);
          for (let i = 1; i < hazards.length; i++) expect(hazards[i][0] - hazards[i - 1][1]).toBeGreaterThanOrEqual(400);
        });

        it('meets bandits on the way', () => {
          const passed = run.waves.filter(inVariant).filter((w) => path!.x(w.trigger) !== null);
          expect(passed.length).toBeGreaterThanOrEqual(2);
          for (const w of passed) expect(path!.x(w.trigger)!).toBeLessThan(path!.length - 300);
        });
      });
    }
  });
}

// ---- What each run introduces (spec §13) ---------------------------------------------------

describe('what each run introduces', () => {
  const first = (run: RunDef) => run.variants[0];
  const pathOf = (run: RunDef, v = first(run)) => plannedPath(run, v)!;
  const passes = (run: RunDef, p: TrackPoint, v = first(run)) => pathOf(run, v).x(p) !== null;
  const stationName = (run: RunDef, id: string) => run.stations.find((s) => s.id === id)!.name;
  const entersAt = (run: RunDef, t: AiTrainDef) => {
    const e = edgeOf(netIndex(run), t.route[0].edge);
    return t.route[0].dir === 1 ? e.a : e.b;
  };

  it('1. First Light: a station stop, tunnel and low-bridge calls, a curve limit, horsemen', () => {
    const run = RUNS[0];
    expect(stationName(run, run.origin)).toBe('Juniper');
    expect(stationName(run, run.contract.destination)).toBe('Coyote Bend');
    expect(run.startClock).toBeGreaterThanOrEqual(clock(5, 0));
    expect(run.startClock).toBeLessThan(clock(7, 0));
    expect(run.tunnels.some((t) => passes(run, { edge: t.edge, off: t.from }))).toBe(true);
    expect(run.lowBridges.some((b) => passes(run, { edge: b.edge, off: b.at }))).toBe(true);
    expect(run.curves.some((c) => c.limit <= 14 && passes(run, { edge: c.edge, off: c.from }))).toBe(true);
    expect(run.plan[first(run)].stops.length).toBeGreaterThanOrEqual(2);
    expect(run.signals).toEqual([]);
    expect(run.aiTrains).toEqual([]);
    expect(run.variants.length).toBe(1);
    expect(run.waves.every((w) => w.tier === 1 && w.count <= 3 && w.goal === 'hunt')).toBe(true);
  });

  it('2. Payroll to Pale Rock: the long way or the steep cutoff, the safe, water towers, 55 water', () => {
    const run = RUNS[1];
    expect(stationName(run, run.contract.destination)).toBe('Pale Rock');
    expect(run.requiredCars).toContain('express');
    expect(run.waves.some((w) => w.goal === 'safe')).toBe(true);
    expect(run.waterTowers.length).toBeGreaterThanOrEqual(2);
    expect(run.waterTowers.map((w) => w.id)).toContain(run.plan[first(run)].stops[0]);
    const cut = run.edges.filter((e) => e.kind === 'branch');
    expect(cut.length).toBeGreaterThan(0);
    const m0 = Math.min(...cut.map((e) => e.mainAt![0]));
    const m1 = Math.max(...cut.map((e) => e.mainAt![1]));
    expect(cut.reduce((n, e) => n + e.length, 0)).toBeLessThan(m1 - m0);
    expect(run.grades.some((g) => cut.some((e) => e.id === g.edge) && Math.abs(g.grade) >= 0.015)).toBe(true);
    expect(run.waves.some((w) => w.from === 'ahead' && cut.some((e) => e.id === w.trigger.edge))).toBe(true);
    const longWay = run.edges.filter((e) => e.kind === 'main' && e.mainAt![0] >= m0 && e.mainAt![1] <= m1).map((e) => e.id);
    expect(run.tunnels.some((t) => longWay.includes(t.edge))).toBe(true);
    expect(run.signals).toEqual([]);
    expect(run.aiTrains).toEqual([]);
  });

  it('3. Signal Country: signals, a rockslide one of two ways, cattle, the burning Devil’s Trestle', () => {
    const run = RUNS[2];
    const ix = netIndex(run);
    expect(new Set(run.signals.map((s) => s.kind))).toEqual(new Set(['block', 'junction']));
    expect(run.variants.length).toBe(2);
    const rocks = run.obstacles.filter((o) => o.kind === 'rocks');
    for (const v of run.variants) expect(rocks.filter((r) => r.variants?.includes(v)).length).toBe(1);
    const [a, b] = run.variants.map((v) => JSON.stringify(run.plan[v].switches));
    expect(a).not.toBe(b);
    // The junction signal gives the rockslide away: it lies in that signal's block one way or the other.
    const initial: Record<string, SwitchState> = Object.fromEntries(run.junctions.map((j) => [j.node, j.initial]));
    for (const r of rocks) {
      const seen = run.signals
        .filter((s) => s.kind === 'junction')
        .some((s) =>
          (['normal', 'reverse'] as const).some((state) => {
            const w = walk(ix, { ...initial, [s.junction!]: state }, { edge: s.edge, off: s.at, dir: s.facing }, 2500);
            const xr = xOnSpans(w.spans, { edge: r.edge, off: r.at });
            if (xr === null) return false;
            return !run.signals.some((o) => o.id !== s.id && ((x) => x !== null && x > 0 && x < xr)(xOnSpans(w.spans, { edge: o.edge, off: o.at })));
          }),
        );
      expect(seen, r.id).toBe(true);
    }
    expect(run.obstacles.some((o) => o.kind === 'cattle' && !o.variants)).toBe(true);
    const devil = run.trestles.find((t) => t.burning)!;
    expect(devil.name).toMatch(/Devil/);
    expect(devil.burning!.minSpeed).toBeCloseTo(13.4, 1);
    expect(run.curves.some((c) => Math.abs(c.limit - 13.4) < 0.05)).toBe(true);
    expect(run.aiTrains).toEqual([]);
  });

  it('4. Single Track: passing loops, an opposing freight to meet, block signals, passengers', () => {
    const run = RUNS[3];
    expect(run.edges.filter((e) => e.kind === 'siding').length).toBeGreaterThanOrEqual(2);
    const [freight] = scheduled(run);
    expect(freight.kind).toBe('freight');
    expect(entersAt(run, freight)).toBe('E');
    expect(run.plan[first(run)].holds.length).toBe(1);
    expect(run.signals.filter((s) => s.kind === 'block').length).toBeGreaterThanOrEqual(3);
    expect(run.sideJobs.length).toBe(1);
    const job = run.sideJobs[0];
    expect(job.needs).toBe('passenger');
    const stops = run.plan[first(run)].stops;
    expect(stops.indexOf(job.from)).toBeGreaterThanOrEqual(0);
    expect(stops.indexOf(job.to)).toBeGreaterThan(stops.indexOf(job.from));
    expect(job.from).not.toBe(run.origin);
  });

  it('5. Night Freight: night, the powder car, an opposing freight and an overtaking express', () => {
    const run = RUNS[4];
    expect(run.night).toBe(true);
    expect(run.startClock >= clock(20, 0) || run.startClock < clock(4, 0)).toBe(true);
    expect(run.requiredCars).toContain('powder');
    const trains = scheduled(run);
    const freight = trains.find((t) => t.kind === 'freight')!;
    const express = trains.find((t) => t.kind === 'express')!;
    expect(entersAt(run, freight)).toBe('E');
    expect(entersAt(run, express)).toBe('W');
    expect(express.speed).toBeGreaterThan(run.plan[first(run)].cruise + 3);
    expect(run.plan[first(run)].holds.length).toBe(2);
    expect(run.waves.filter((w) => w.goal === 'powder').length).toBeGreaterThanOrEqual(2);
  });

  it('6. The Blackwater Line: the runaway, the boss, a barricade ambush', () => {
    const run = RUNS[5];
    const ix = netIndex(run);
    const runaway = run.aiTrains.find((t) => t.kind === 'runaway')!;
    expect(runaway.charted).toBe(false);
    expect(runaway.route).toEqual([]);
    const rw = runaway.runaway!;
    expect(rw.telegram.length).toBeGreaterThan(20);
    for (const v of run.variants) {
      const path = plannedPath(run, v)!;
      // With the plan's switches it rolls into a spur's buffers…
      const roll = walk(ix, path.switches, { ...rw.start, dir: rw.dir }, 1e5);
      expect(roll.blocked).toBe(true);
      const spur = edgeOf(ix, roll.spans[roll.spans.length - 1].edge);
      expect(spur.kind).toBe('spur');
      const sw = run.junctions.find((j) => j.reverse === spur.id)!;
      expect(run.plan[v].switches).toContainEqual({ junction: sw.node, state: 'reverse' });
      // …and without them it would come down the main at us.
      const xTrig = path.x(rw.trigger)!;
      expect(xTrig).not.toBeNull();
      const loose = walk(ix, { ...path.switches, [sw.node]: 'normal' }, { ...rw.start, dir: rw.dir }, 1e5);
      expect(loose.spans.some((s) => ((x) => x !== null && x < xTrig)(path.x({ edge: s.edge, off: s.to })))).toBe(true);
      // The telegram comes as it breaks loose, with time to set the switch before it gets there.
      const est = estimate(run, v);
      const toSwitch = roll.spans.slice(0, roll.spans.findIndex((s) => s.edge === spur.id)).reduce((n, s) => n + Math.abs(s.to - s.from), 0);
      const last = roll.spans[roll.spans.findIndex((s) => s.edge === spur.id) - 1];
      const xSwitch = path.x({ edge: last.edge, off: last.to })!;
      const tTrig = est.timeAt(xTrig);
      const tSwitch = tTrig + runawayRollTime(toSwitch);
      expect(tSwitch - tTrig).toBeGreaterThanOrEqual(60);
      expect(tSwitch - est.timeAt(xSwitch - 500)).toBeGreaterThanOrEqual(30);
      expect(xTrig).toBeLessThan(xSwitch);
    }
    const bar = run.obstacles.find((o) => o.kind === 'barricade')!;
    const p0 = pathOf(run);
    const xBar = p0.x({ edge: bar.edge, off: bar.at })!;
    expect(xBar).not.toBeNull();
    expect(run.waves.some((w) => w.from === 'ahead' && Math.abs(xBar - p0.x(w.trigger)! - 450) <= 60)).toBe(true);
    expect(run.variants.length).toBe(2);
    expect(scheduled(run).length).toBe(1);
    expect(run.plan[first(run)].holds.length).toBe(1);
  });
});
