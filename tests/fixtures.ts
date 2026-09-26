// Hand-built networks for tests. Every sim module's tests may use these.
//
// Y network ("yRun"):
//
//   A(end) ──e1 1000m── J1 ──e2 500m (normal)── L1(link) ──e4 800m── B(end)
//                        └──e3 600m (reverse, spur)── S(end)
//
// Loop network ("loopRun"): a single line with a passing loop in the middle.
//
//   W(end) ──m1 1000m── P ──m2 400m (normal)── Q ──m3 1000m── E(end)
//                        └──s1 400m (reverse, siding)──┘
//   P: trunk m1, normal m2, reverse s1.   Q: trunk m3, normal m2, reverse s1.

import type { NetEdge, NetNode, RunDef, RunPlan } from '../src/sim/types';

export const EMPTY_PLAN: RunPlan = { cruise: 15, switches: [], stops: [], holds: [], whistles: [], minSpeeds: [] };

function edge(id: string, a: string, b: string, length: number, extra: Partial<NetEdge> = {}): NetEdge {
  return { id, a, b, length, kind: 'main', speedLimit: 25, terrain: 'desert', ...extra };
}

function node(id: string, kind: NetNode['kind'], x: number, y: number): NetNode {
  return { id, kind, x, y };
}

/** A valid RunDef with everything empty except what's given. */
export function baseRun(parts: Partial<RunDef> & Pick<RunDef, 'nodes' | 'edges' | 'start' | 'mainLine'>): RunDef {
  return {
    id: 'test',
    index: 0,
    act: 1,
    name: 'Test',
    flavor: '',
    briefing: { rider: [], engineer: [] },
    startClock: 12 * 3600,
    night: false,
    junctions: [],
    tunnels: [],
    fords: [],
    lowBridges: [],
    trestles: [],
    stations: [],
    waterTowers: [],
    curves: [],
    grades: [],
    mileposts: [],
    signals: [],
    obstacles: [],
    waves: [],
    aiTrains: [],
    telegrams: [],
    contract: { cargo: 'mail', title: 'Test mail', pay: 100, destination: 'dest', deadline: 13 * 3600, latePenaltyPerMin: 5, critical: false },
    sideJobs: [],
    origin: 'orig',
    initialWater: 100,
    variants: ['main'],
    requiredCars: [],
    maxCars: 5,
    par: 600,
    plan: { main: EMPTY_PLAN },
    ...parts,
  };
}

export function yRun(extra: Partial<RunDef> = {}): RunDef {
  return baseRun({
    nodes: [node('A', 'end', 0, 0), node('J1', 'junction', 10, 0), node('L1', 'link', 15, 0), node('B', 'end', 23, 0), node('S', 'end', 16, 3)],
    edges: [
      edge('e1', 'A', 'J1', 1000, { mainAt: [0, 1000] }),
      edge('e2', 'J1', 'L1', 500, { mainAt: [1000, 1500] }),
      edge('e3', 'J1', 'S', 600, { kind: 'spur' }),
      edge('e4', 'L1', 'B', 800, { mainAt: [1500, 2300] }),
    ],
    junctions: [{ node: 'J1', trunk: 'e1', normal: 'e2', reverse: 'e3', initial: 'normal', name: 'Junction 1' }],
    mainLine: ['e1', 'e2', 'e4'],
    stations: [
      { id: 'orig', name: 'Origin', edge: 'e1', at: 200, platform: 60, checkpoint: false },
      { id: 'dest', name: 'Destination', edge: 'e4', at: 700, platform: 60, checkpoint: false },
    ],
    start: { edge: 'e1', off: 200, dir: 1 },
    ...extra,
  });
}

export function loopRun(extra: Partial<RunDef> = {}): RunDef {
  return baseRun({
    nodes: [node('W', 'end', 0, 0), node('P', 'junction', 10, 0), node('Q', 'junction', 14, 0), node('E', 'end', 24, 0)],
    edges: [
      edge('m1', 'W', 'P', 1000, { mainAt: [0, 1000] }),
      edge('m2', 'P', 'Q', 400, { mainAt: [1000, 1400] }),
      edge('s1', 'P', 'Q', 400, { kind: 'siding', mainAt: [1000, 1400] }),
      edge('m3', 'Q', 'E', 1000, { mainAt: [1400, 2400] }),
    ],
    junctions: [
      { node: 'P', trunk: 'm1', normal: 'm2', reverse: 's1', initial: 'normal', name: 'West loop switch' },
      { node: 'Q', trunk: 'm3', normal: 'm2', reverse: 's1', initial: 'normal', name: 'East loop switch' },
    ],
    mainLine: ['m1', 'm2', 'm3'],
    stations: [
      { id: 'orig', name: 'Origin', edge: 'm1', at: 300, platform: 60, checkpoint: false },
      { id: 'dest', name: 'Destination', edge: 'm3', at: 900, platform: 60, checkpoint: false },
    ],
    start: { edge: 'm1', off: 300, dir: 1 },
    ...extra,
  });
}
