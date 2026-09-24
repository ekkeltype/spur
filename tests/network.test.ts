import { describe, expect, it } from 'vitest';
import {
  fouls,
  framePath,
  framePoint,
  frameRange,
  frameX,
  frontHead,
  gradeAt,
  limitAt,
  mainPos,
  moveSpans,
  netIndex,
  nextEdge,
  pathCrosses,
  pointAt,
  rearHead,
  spansFromFront,
  spansLength,
  spansOverlap,
  validateRun,
  walk,
  xOnSpans,
} from '../src/sim/network';
import type { RunDef, Span, SwitchState } from '../src/sim/types';
import { loopRun, yRun } from './fixtures';

const sw = (run: RunDef, set: Record<string, SwitchState> = {}): Record<string, SwitchState> => {
  const out: Record<string, SwitchState> = {};
  for (const j of run.junctions) out[j.node] = j.initial;
  return { ...out, ...set };
};

const close = (a: number, b: number): void => expect(a).toBeCloseTo(b, 6);

describe('netIndex', () => {
  it('indexes nodes, edges, junctions and the edges meeting at each node', () => {
    const ix = netIndex(yRun());
    expect(ix.edge.get('e3')?.length).toBe(600);
    expect(ix.junction.get('J1')?.reverse).toBe('e3');
    expect(ix.incident.get('J1')?.map((i) => i.edge).sort()).toEqual(['e1', 'e2', 'e3']);
    expect(ix.incident.get('L1')).toEqual([
      { edge: 'e2', end: 'b' },
      { edge: 'e4', end: 'a' },
    ]);
  });

  it("indexes the Engineer's copy of a run, which has no obstacles, waves, plan or variants", () => {
    const { obstacles: _o, waves: _w, plan: _p, variants: _v, ...engineerRun } = yRun({
      tunnels: [{ id: 't1', edge: 'e1', from: 100, to: 200, name: 'T' }],
    });
    const ix = netIndex(engineerRun);
    expect(ix.features.get('e1')?.tunnels.map((t) => t.id)).toEqual(['t1']);
    expect(ix.features.get('e1')?.obstacles).toEqual([]);
  });

  it('caches per RunDef object', () => {
    const run = yRun();
    expect(netIndex(run)).toBe(netIndex(run));
  });
});

describe('nextEdge', () => {
  const run = yRun();
  const ix = netIndex(run);

  it('follows the switch on a facing move from the trunk', () => {
    expect(nextEdge(ix, sw(run), 'e1', 'J1')?.head).toEqual({ edge: 'e2', off: 0, dir: 1 });
    expect(nextEdge(ix, sw(run, { J1: 'reverse' }), 'e1', 'J1')?.head).toEqual({ edge: 'e3', off: 0, dir: 1 });
  });

  it('always goes to the trunk on a trailing move, and says when the switch was set against it', () => {
    const lined = nextEdge(ix, sw(run), 'e2', 'J1');
    expect(lined?.head).toEqual({ edge: 'e1', off: 1000, dir: -1 });
    expect(lined?.trailing).toBeNull();
    const against = nextEdge(ix, sw(run), 'e3', 'J1');
    expect(against?.head).toEqual({ edge: 'e1', off: 1000, dir: -1 });
    expect(against?.trailing).toBe('reverse');
  });

  it('passes straight through a link node and stops at an end node', () => {
    expect(nextEdge(ix, sw(run), 'e2', 'L1')?.head).toEqual({ edge: 'e4', off: 0, dir: 1 });
    expect(nextEdge(ix, sw(run), 'e4', 'L1')?.head).toEqual({ edge: 'e2', off: 500, dir: -1 });
    expect(nextEdge(ix, sw(run), 'e4', 'B')).toBeNull();
  });
});

describe('walk', () => {
  const run = yRun();
  const ix = netIndex(run);

  it('walks within an edge', () => {
    const w = walk(ix, sw(run), { edge: 'e1', off: 100, dir: 1 }, 250);
    expect(w.end).toEqual({ edge: 'e1', off: 350, dir: 1 });
    expect(w.walked).toBe(250);
    expect(w.spans).toEqual([{ edge: 'e1', from: 100, to: 350 }]);
    expect(w.blocked).toBe(false);
  });

  it('walks backward along an edge (b→a)', () => {
    const w = walk(ix, sw(run), { edge: 'e4', off: 500, dir: -1 }, 300);
    expect(w.end).toEqual({ edge: 'e4', off: 200, dir: -1 });
    expect(w.spans).toEqual([{ edge: 'e4', from: 500, to: 200 }]);
  });

  it('crosses junctions following the switches and records the nodes passed', () => {
    const w = walk(ix, sw(run, { J1: 'reverse' }), { edge: 'e1', off: 900, dir: 1 }, 300);
    expect(w.end).toEqual({ edge: 'e3', off: 200, dir: 1 });
    expect(w.spans).toEqual([
      { edge: 'e1', from: 900, to: 1000 },
      { edge: 'e3', from: 0, to: 200 },
    ]);
    expect(w.nodes).toEqual([{ node: 'J1', at: 100 }]);
  });

  it('stops at an end node and reports it', () => {
    const w = walk(ix, sw(run), { edge: 'e4', off: 700, dir: 1 }, 500);
    expect(w.blocked).toBe(true);
    expect(w.walked).toBe(100);
    expect(w.end).toEqual({ edge: 'e4', off: 800, dir: 1 });
  });

  it('stops exactly on a node without crossing it', () => {
    const w = walk(ix, sw(run), { edge: 'e1', off: 900, dir: 1 }, 100);
    expect(w.end).toEqual({ edge: 'e1', off: 1000, dir: 1 });
    expect(w.nodes).toEqual([]);
    expect(w.blocked).toBe(false);
  });

  it('records trailing moves through a switch set against them', () => {
    const w = walk(ix, sw(run), { edge: 'e3', off: 50, dir: -1 }, 100);
    expect(w.end).toEqual({ edge: 'e1', off: 950, dir: -1 });
    expect(w.trails).toEqual([{ junction: 'J1', state: 'reverse' }]);
  });

  it('a zero walk goes nowhere', () => {
    const w = walk(ix, sw(run), { edge: 'e1', off: 100, dir: 1 }, 0);
    expect(w.end).toEqual({ edge: 'e1', off: 100, dir: 1 });
    expect(w.spans).toEqual([]);
  });
});

describe('spans', () => {
  const run = yRun();
  const ix = netIndex(run);
  const switches = sw(run);
  // A 100 m train whose front is at e1 950, heading toward J1.
  const train = (): Span[] => spansFromFront(ix, switches, { edge: 'e1', off: 950, dir: 1 }, 100);

  it('builds a train behind its front', () => {
    expect(train()).toEqual([{ edge: 'e1', from: 850, to: 950 }]);
    expect(spansLength(train())).toBe(100);
    expect(frontHead(train())).toEqual({ edge: 'e1', off: 950, dir: 1 });
    expect(rearHead(train())).toEqual({ edge: 'e1', off: 850, dir: -1 });
  });

  it('builds a train that straddles a node', () => {
    const spans = spansFromFront(ix, switches, { edge: 'e2', off: 30, dir: 1 }, 100);
    expect(spans).toEqual([
      { edge: 'e1', from: 930, to: 1000 },
      { edge: 'e2', from: 0, to: 30 },
    ]);
  });

  it('moves forward across a junction, keeping its length', () => {
    const m = moveSpans(ix, switches, train(), 120);
    expect(m.moved).toBe(120);
    expect(m.spans).toEqual([
      { edge: 'e1', from: 970, to: 1000 },
      { edge: 'e2', from: 0, to: 70 },
    ]);
    close(spansLength(m.spans), 100);
    const m2 = moveSpans(ix, switches, m.spans, 100);
    expect(m2.spans).toEqual([{ edge: 'e2', from: 70, to: 170 }]);
  });

  it('stops against the buffers at an end node', () => {
    const near = spansFromFront(ix, switches, { edge: 'e4', off: 790, dir: 1 }, 100);
    const m = moveSpans(ix, switches, near, 30);
    expect(m.blocked).toBe(true);
    expect(m.moved).toBe(10);
    expect(frontHead(m.spans)).toEqual({ edge: 'e4', off: 800, dir: 1 });
    close(spansLength(m.spans), 100);
  });

  it('moves backward with the rear leading, following the switches (a shunt into the spur)', () => {
    // A train on e3 facing J1, backing away from it... first put a train on the spur facing the junction.
    const onSpur = spansFromFront(ix, switches, { edge: 'e1', off: 500, dir: 1 }, 100);
    // Back up 50 m: the rear leads toward A.
    const back = moveSpans(ix, switches, onSpur, -50);
    expect(back.moved).toBe(-50);
    expect(back.spans).toEqual([{ edge: 'e1', from: 350, to: 450 }]);
    // A train past the junction on e2, backing through J1 (trailing from the trunk side? no: rear moves e2→J1→e1).
    const past = spansFromFront(ix, switches, { edge: 'e2', off: 150, dir: 1 }, 100);
    const b2 = moveSpans(ix, switches, past, -100);
    expect(b2.spans).toEqual([
      { edge: 'e1', from: 950, to: 1000 },
      { edge: 'e2', from: 0, to: 50 },
    ]);
  });

  it('backs into whichever leg the switch selects when the rear faces the junction from the trunk', () => {
    // Train on e1 heading toward A (dir −1): its rear is toward J1.
    const heading = spansFromFront(ix, sw(run, { J1: 'reverse' }), { edge: 'e1', off: 900, dir: -1 }, 60);
    expect(heading).toEqual([{ edge: 'e1', from: 960, to: 900 }]);
    const b = moveSpans(ix, sw(run, { J1: 'reverse' }), heading, -80);
    // The rear leads over J1 into e3 (the switch is reversed).
    expect(b.spans).toEqual([
      { edge: 'e3', from: 40, to: 0 },
      { edge: 'e1', from: 1000, to: 980 },
    ]);
    close(spansLength(b.spans), 60);
  });

  it('reports trailing moves so the sim can throw the switch', () => {
    const onSpur = spansFromFront(ix, sw(run, { J1: 'reverse' }), { edge: 'e3', off: 20, dir: -1 }, 50);
    const m = moveSpans(ix, switches, onSpur, 40); // switches say normal: the move trails through against it
    expect(m.trails).toEqual([{ junction: 'J1', state: 'reverse' }]);
    expect(frontHead(m.spans)).toEqual({ edge: 'e1', off: 980, dir: -1 });
  });

  it('finds points and train-frame positions along the spans', () => {
    const spans = spansFromFront(ix, switches, { edge: 'e2', off: 30, dir: 1 }, 100);
    expect(pointAt(spans, 0)).toEqual({ edge: 'e1', off: 930, dir: 1 });
    expect(pointAt(spans, 70)).toEqual({ edge: 'e1', off: 1000, dir: 1 });
    expect(pointAt(spans, 85)).toEqual({ edge: 'e2', off: 15, dir: 1 });
    expect(pointAt(spans, 100)).toEqual({ edge: 'e2', off: 30, dir: 1 });
    expect(xOnSpans(spans, { edge: 'e1', off: 950 })).toBe(20);
    expect(xOnSpans(spans, { edge: 'e2', off: 10 })).toBe(80);
    expect(xOnSpans(spans, { edge: 'e4', off: 10 })).toBeNull();
  });

  it('detects overlapping occupancy on the same edge only', () => {
    const a: Span[] = [{ edge: 'e1', from: 100, to: 200 }];
    expect(spansOverlap(a, [{ edge: 'e1', from: 250, to: 190 }])).toBe(true);
    expect(spansOverlap(a, [{ edge: 'e1', from: 201, to: 300 }])).toBe(false);
    expect(spansOverlap(a, [{ edge: 'e2', from: 100, to: 200 }])).toBe(false);
  });
});

describe('pathCrosses', () => {
  it('is true for points the path covered after its start, on the same edge', () => {
    const path: Span[] = [
      { edge: 'e1', from: 990, to: 1000 },
      { edge: 'e2', from: 0, to: 5 },
    ];
    expect(pathCrosses(path, { edge: 'e1', off: 995 })).toBe(true);
    expect(pathCrosses(path, { edge: 'e2', off: 5 })).toBe(true); // the end counts
    expect(pathCrosses(path, { edge: 'e1', off: 990 })).toBe(false); // the start doesn't (it was last tick's end)
    expect(pathCrosses(path, { edge: 'e2', off: 6 })).toBe(false);
    expect(pathCrosses(path, { edge: 'e3', off: 2 })).toBe(false);
    expect(pathCrosses([{ edge: 'e4', from: 300, to: 290 }], { edge: 'e4', off: 295 })).toBe(true); // b→a
    expect(pathCrosses([], { edge: 'e4', off: 295 })).toBe(false);
  });
});

describe('fouls', () => {
  const run = loopRun();
  const ix = netIndex(run);

  it('is true while a train occupies any edge of the junction near its node', () => {
    expect(fouls(ix, [{ edge: 'm1', from: 900, to: 990 }], 'P', 20)).toBe(true);
    expect(fouls(ix, [{ edge: 'm1', from: 800, to: 975 }], 'P', 20)).toBe(false);
    expect(fouls(ix, [{ edge: 's1', from: 5, to: 60 }], 'P', 20)).toBe(true);
    expect(fouls(ix, [{ edge: 's1', from: 395, to: 300 }], 'P', 20)).toBe(false); // near Q, not P
    expect(fouls(ix, [{ edge: 's1', from: 300, to: 395 }], 'Q', 20)).toBe(true);
  });
});

describe('positions', () => {
  it('projects onto the main line', () => {
    const ix = netIndex(loopRun());
    expect(mainPos(ix, { edge: 'm2', off: 100 })).toBe(1100);
    expect(mainPos(ix, { edge: 's1', off: 400 })).toBe(1400);
    const iy = netIndex(yRun());
    expect(mainPos(iy, { edge: 'e3', off: 10 })).toBeNull();
  });

  it('reads the grade and the speed limit at a point', () => {
    const run = yRun({
      grades: [{ edge: 'e1', from: 100, to: 400, grade: 0.015 }],
      curves: [{ id: 'c1', edge: 'e1', from: 500, to: 700, limit: 11 }],
    });
    const ix = netIndex(run);
    expect(gradeAt(ix, { edge: 'e1', off: 200 })).toBe(0.015);
    expect(gradeAt(ix, { edge: 'e1', off: 450 })).toBe(0);
    expect(limitAt(ix, { edge: 'e1', off: 600 })).toBe(11);
    expect(limitAt(ix, { edge: 'e1', off: 450 })).toBe(25);
  });
});

describe('framePath', () => {
  const run = yRun();
  const ix = netIndex(run);
  const switches = sw(run);

  it('lays the track behind, under and ahead of the train on one axis', () => {
    const spans = spansFromFront(ix, switches, { edge: 'e1', off: 950, dir: 1 }, 100); // rear at 850
    const fp = framePath(ix, switches, spans, 200, 300);
    expect(fp.x0).toBe(-200);
    expect(frameX(fp, { edge: 'e1', off: 850 })).toBe(0); // the rear
    expect(frameX(fp, { edge: 'e1', off: 950 })).toBe(100); // the front: x = L
    expect(frameX(fp, { edge: 'e1', off: 700 })).toBe(-150); // behind
    expect(frameX(fp, { edge: 'e2', off: 100 })).toBe(250); // ahead, past the junction
    expect(frameX(fp, { edge: 'e3', off: 100 })).toBeNull(); // not on the route
    expect(frameRange(fp, 'e1', 900, 1000)).toEqual([50, 150]);
    expect(frameRange(fp, 'e2', 0, 1000)).toEqual([150, 400]); // clipped to what the path covers
  });

  it('maps a train-frame x back to a track point', () => {
    const spans = spansFromFront(ix, switches, { edge: 'e1', off: 950, dir: 1 }, 100);
    const fp = framePath(ix, switches, spans, 200, 300);
    expect(framePoint(fp, 0)).toEqual({ edge: 'e1', off: 850 });
    expect(framePoint(fp, 250)).toEqual({ edge: 'e2', off: 100 });
    expect(framePoint(fp, -150)).toEqual({ edge: 'e1', off: 700 });
    expect(framePoint(fp, 401)).toBeNull(); // past the end of the path
    expect(framePoint(fp, -201)).toBeNull();
  });

  it('is shorter behind when the track ends', () => {
    const spans = spansFromFront(ix, switches, { edge: 'e1', off: 150, dir: 1 }, 100); // rear at 50
    const fp = framePath(ix, switches, spans, 200, 100);
    expect(fp.x0).toBe(-50);
  });
});

describe('validateRun', () => {
  it('accepts the fixtures', () => {
    expect(validateRun(yRun())).toEqual([]);
    expect(validateRun(loopRun())).toEqual([]);
  });

  it('reports structural mistakes', () => {
    const bad = yRun({
      junctions: [{ node: 'J1', trunk: 'e1', normal: 'e2', reverse: 'e4', initial: 'normal', name: 'x' }],
      tunnels: [{ id: 't', edge: 'e2', from: 400, to: 700, name: 'T' }],
      mainLine: ['e1', 'e4'],
    });
    const problems = validateRun(bad).join('\n');
    expect(problems).toMatch(/J1/);
    expect(problems).toMatch(/tunnel t/);
    expect(problems).toMatch(/mainLine/);
  });
});
