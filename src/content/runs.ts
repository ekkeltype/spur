// The campaign (spec §13). PLACEHOLDER: one hand-built practice run so the shell has something to
// list and drive. The content milestone replaces this file with the six real runs (built with
// builder.ts); the exports RUNS and runById stay.

import type { RunDef } from '../sim/types';

const practice: RunDef = {
  id: 'practice',
  index: 0,
  act: 1,
  name: 'Practice Line',
  flavor: 'A short stretch of track to try the controls.',
  briefing: { rider: ['Run the roofs and keep your footing.'], engineer: ['Get her moving and stop at the far platform.'] },
  startClock: 9 * 3600,
  night: false,
  nodes: [
    { id: 'W', kind: 'end', x: 0, y: 0, label: 'West end' },
    { id: 'P', kind: 'junction', x: 30, y: 0 },
    { id: 'Q', kind: 'junction', x: 42, y: 0 },
    { id: 'E', kind: 'end', x: 72, y: 0, label: 'East end' },
  ],
  edges: [
    { id: 'm1', a: 'W', b: 'P', length: 3000, kind: 'main', speedLimit: 24, terrain: 'desert', mainAt: [0, 3000] },
    { id: 'm2', a: 'P', b: 'Q', length: 1200, kind: 'main', speedLimit: 24, terrain: 'mesa', mainAt: [3000, 4200] },
    { id: 's1', a: 'P', b: 'Q', length: 1200, kind: 'siding', speedLimit: 11, terrain: 'mesa', mainAt: [3000, 4200], via: [[32, 2], [40, 2]] },
    { id: 'm3', a: 'Q', b: 'E', length: 3000, kind: 'main', speedLimit: 24, terrain: 'canyon', mainAt: [4200, 7200] },
  ],
  junctions: [
    { node: 'P', trunk: 'm1', normal: 'm2', reverse: 's1', initial: 'normal', name: 'West loop switch' },
    { node: 'Q', trunk: 'm3', normal: 'm2', reverse: 's1', initial: 'normal', name: 'East loop switch' },
  ],
  mainLine: ['m1', 'm2', 'm3'],
  tunnels: [{ id: 't1', edge: 'm1', from: 1200, to: 1450, name: 'Juniper Tunnel' }],
  lowBridges: [{ id: 'b1', edge: 'm1', at: 2100 }],
  trestles: [{ id: 'r1', edge: 'm3', from: 800, to: 1000, name: 'Sage Creek Trestle' }],
  stations: [
    { id: 'west', name: 'Juniper', edge: 'm1', at: 200, platform: 60, checkpoint: false },
    { id: 'east', name: 'Coyote Bend', edge: 'm3', at: 2700, platform: 60, checkpoint: false },
  ],
  waterTowers: [{ id: 'w1', edge: 'm2', at: 600 }],
  curves: [{ id: 'c1', edge: 'm3', from: 1500, to: 1900, limit: 13 }],
  grades: [],
  mileposts: [],
  signals: [],
  obstacles: [],
  waves: [],
  aiTrains: [],
  telegrams: [],
  contract: { cargo: 'mail', title: 'Practice mail', pay: 50, destination: 'east', deadline: 9 * 3600 + 900, latePenaltyPerMin: 5, critical: false },
  sideJobs: [],
  start: { edge: 'm1', off: 200, dir: 1 },
  origin: 'west',
  initialWater: 100,
  variants: ['main'],
  requiredCars: ['express'],
  maxCars: 5,
  par: 600,
  plan: { main: { cruise: 18, switches: [], stops: ['east'], holds: [], whistles: [], minSpeeds: [] } },
};

export const RUNS: readonly RunDef[] = [practice];

export function runById(id: string): RunDef | undefined {
  return RUNS.find((r) => r.id === id);
}
