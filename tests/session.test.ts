// Host and client sessions over the in-memory transport: the real protocol flow, headless (spec §3,
// §16). The sim's step() is wrapped so a test can add events to a tick (checkpoints, gunfire…)
// without depending on how the sim modules produce them.

import { describe, expect, it, vi } from 'vitest';
import { ClientSession, type ClientOptions } from '../src/net/client';
import { RUNS } from '../src/content/runs';
import { cleanCmd, GUNFIRE_MIN_TICKS, HostSession, runCard, type HostOptions } from '../src/net/host';
import { createLocalPair } from '../src/net/local';
import type { Msg, SwitchSave } from '../src/net/protocol';
import { defaultCampaign, defaultSave, recordResult, type SaveV1 } from '../src/save/save';
import { COUNTDOWN_SECONDS, INTRO_SECONDS, TICK_HZ, TIME_SCALE } from '../src/sim/rules';
import type { CampaignProgress, EngineerCmdBody, RunDef, SimEvent } from '../src/sim/types';
import { toEngineerRun, toEngineerView } from '../src/sim/views';
import { yRun } from './fixtures';

const inject = vi.hoisted(() => ({ next: [] as unknown[] }));

vi.mock('../src/sim/game', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sim/game')>();
  return {
    ...actual,
    step: (...args: Parameters<typeof actual.step>): SimEvent[] => [...actual.step(...args), ...(inject.next.splice(0) as SimEvent[])],
  };
});

/** Adds events to the next tick the host steps. */
const addEvents = (...events: SimEvent[]): void => {
  inject.next.push(...events);
};

const IDS = ['first-light', 'payroll', 'signal-country'];
const RUNS3: RunDef[] = IDS.map((id, index) =>
  yRun({ id, index, name: `Run ${index + 1}`, requiredCars: index === 1 ? ['express'] : [], maxCars: index === 0 ? 3 : 5 }),
);

const flush = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(opts: { campaign?: Partial<CampaignProgress>; host?: Partial<HostOptions>; client?: ClientOptions } = {}) {
  const pair = createLocalPair();
  let save: SaveV1 = { ...defaultSave(false), campaign: { ...defaultCampaign(), ...opts.campaign } };
  const writes = { campaign: 0, checkpoint: 0 };
  const host = new HostSession({
    campaign: save.campaign,
    checkpoint: null,
    recordResult: (r) => {
      const out = recordResult(save, r, RUNS3);
      save = out.save;
      return { campaign: save.campaign, payout: out.payout };
    },
    saveCampaign: (c) => {
      writes.campaign++;
      save = { ...save, campaign: c };
    },
    saveCheckpoint: (cp) => {
      writes.checkpoint++;
      save = { ...save, checkpoint: cp };
    },
    runs: RUNS3,
    ...opts.host,
  });
  host.attachTransport(pair.host);
  const received: Msg[] = [];
  pair.client.onMessage((m) => received.push(m));
  const sent: Msg[] = [];
  pair.host.onMessage((m) => sent.push(m));
  const client = new ClientSession(pair.client, opts.client);
  let now = 1000;
  const advance = (ms: number): void => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 1000 / 60);
      host.frame(now);
      client.frame(now);
    }
  };
  return { pair, host, client, received, sent, advance, time: () => now, save: () => save, writes };
}

type Ctx = ReturnType<typeof setup>;

async function toBriefing(ctx: Ctx, seed = 4242): Promise<void> {
  const { host, client } = ctx;
  await flush();
  client.setReady(true);
  host.setReady(true);
  await flush();
  host.start(seed);
  await flush();
}

async function toPlaying(ctx: Ctx): Promise<void> {
  const { host, client, advance } = ctx;
  await toBriefing(ctx);
  client.setReady(true);
  host.setReady(true);
  await flush();
  // The countdown is timed with performance.now(); fast-forward past it.
  host.countdownEndMs = 0;
  client.countdownEndMs = 0;
  advance(50);
  await flush();
}

/** Makes the running game end on the next tick. */
function endGame(ctx: Ctx, outcome: 'won' | 'lost'): void {
  const state = ctx.host.game!.state;
  state.phase = outcome;
  if (outcome === 'won') state.arrivedClock = state.clock0 + state.tick / TICK_HZ;
  else state.loss = { reason: 'derailed', detail: 'Took the curve at 52 mph; the limit was 30.' };
}

/** Every key anywhere in a JSON value. */
function keysIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysIn(v, out));
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysIn(v, out);
    }
  }
  return out;
}

describe('host and client sessions', () => {
  it('handshake, lobby readiness, start, briefing, countdown and play', async () => {
    const ctx = setup();
    const { host, client, advance } = ctx;
    await flush();
    expect(host.connected).toBe(true);
    expect(client.screen).toBe('lobby');
    expect(client.runs.map((r) => r.id)).toEqual(IDS);
    expect(client.runs.map((r) => r.unlocked)).toEqual([true, false, false]);
    expect(host.canStart()).toBe(false);
    client.setReady(true);
    host.setReady(true);
    await flush();
    expect(host.clientReady).toBe(true);
    expect(client.hostReady).toBe(true);
    expect(host.canStart()).toBe(true);

    host.start(4242);
    await flush();
    expect(host.screen).toBe('briefing');
    expect(client.screen).toBe('briefing');
    expect(client.game?.run).toEqual(toEngineerRun(RUNS3[0]));
    expect(client.game?.fromCheckpoint).toBeNull();
    expect(client.game?.consist).toEqual(host.game!.consist);

    client.setReady(true);
    host.setReady(true);
    await flush();
    expect(host.mode).toBe('countdown');
    expect(client.mode).toBe('countdown');
    expect(COUNTDOWN_SECONDS).toBeGreaterThan(0);
    host.countdownEndMs = 0;
    client.countdownEndMs = 0;
    advance(1000);
    await flush();
    expect(host.mode).toBe('running');
    expect(client.mode).toBe('running');
    expect(host.game!.state.tick).toBeGreaterThanOrEqual(TICK_HZ - 2);
    expect(client.view?.tick).toBeGreaterThan(0);
    expect(Object.keys(client.view!).sort()).toEqual(Object.keys(toEngineerView(host.game!.state, RUNS3[0])).sort());
  });

  it('runs the world TIME_SCALE times the wall clock, and the desk keeps pace with it', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { host, client, advance } = ctx;
    // The client stamps snapshots with performance.now(): make that the test's clock.
    const clock = vi.spyOn(performance, 'now');
    const t0 = host.game!.state.tick;
    // The desk's estimate of the host's tick, between snapshots, stays where the host is.
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      advance(1000 / 60);
      clock.mockReturnValue(ctx.time());
      await flush(1);
      if (i >= 10) worst = Math.max(worst, Math.abs(client.estTick(ctx.time()) - host.game!.state.tick));
    }
    const ran = host.game!.state.tick - t0;
    expect(ran).toBeGreaterThanOrEqual(Math.round(TICK_HZ * TIME_SCALE) - 2);
    expect(ran).toBeLessThanOrEqual(Math.round(TICK_HZ * TIME_SCALE) + 1);
    expect(worst).toBeLessThan(1.5);
    clock.mockRestore();
  });

  it('applies commands with acks, and refuses them while paused or malformed', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { host, client, advance } = ctx;
    client.sendCmd({ kind: 'throttle', value: 0.6 });
    expect(client.hasPending()).toBe(true);
    await flush();
    advance(40);
    await flush();
    expect(host.game!.state.train.throttle).toBeCloseTo(0.6);
    expect(client.hasPending()).toBe(false);
    expect(client.lastRefusal).toBeNull();

    const refusals: string[] = [];
    client.onRefusal((r) => refusals.push(r));
    // NaN arrives as null over the wire (the local transport warns about it in dev builds).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctx.pair.client.send({ type: 'cmd', cmd: { seq: 99, kind: 'throttle', value: Number.NaN } });
    warn.mockRestore();
    await flush();
    expect(refusals).toEqual(['The host could not read that command']);
    host.requestPause();
    await flush();
    client.sendCmd({ kind: 'brake', value: 1 });
    await flush();
    expect(client.lastRefusal?.text).toBe('The game is paused');
    expect(host.game!.state.train.brake).toBe(0);
  });

  it('pauses from either side and resumes when both are ready', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { host, client, advance } = ctx;
    client.requestPause();
    await flush();
    expect(host.mode).toBe('paused');
    expect(host.pausedBy).toBe('engineer');
    expect(client.mode).toBe('paused');
    expect(client.pausedBy).toBe('engineer');
    const tick = host.game!.state.tick;
    advance(500);
    expect(host.game!.state.tick).toBe(tick);
    host.setReady(true);
    client.setReady(true);
    await flush();
    expect(host.mode).toBe('countdown');
    host.countdownEndMs = 0;
    client.countdownEndMs = 0;
    advance(300);
    await flush();
    expect(host.mode).toBe('running');
    expect(host.game!.state.tick).toBeGreaterThan(tick);
    host.requestPause();
    await flush();
    expect(client.pausedBy).toBe('rider');
  });

  it('opens a run with its shot only when it leaves the origin', async () => {
    const ctx = setup();
    const { host, client, advance, received } = ctx;
    const countdowns = (): Msg[] => received.filter((m) => m.type === 'countdown');
    await toBriefing(ctx);
    client.setReady(true);
    host.setReady(true);
    await flush();
    // The shot, then the numbers: the countdown mode covers both, on both sides.
    expect(countdowns().at(-1)).toEqual({ type: 'countdown', seconds: COUNTDOWN_SECONDS, intro: INTRO_SECONDS });
    expect(host.countdownEndMs - host.introEndMs).toBeCloseTo(COUNTDOWN_SECONDS * 1000);
    expect(client.countdownEndMs - client.introEndMs).toBeCloseTo(COUNTDOWN_SECONDS * 1000);
    expect(client.introEndMs - performance.now()).toBeGreaterThan((INTRO_SECONDS - 1) * 1000);
    advance(500);
    expect(host.mode).toBe('countdown');
    expect(client.mode).toBe('countdown');
    host.countdownEndMs = 0;
    client.countdownEndMs = 0;
    advance(500);
    await flush();
    expect(host.mode).toBe('running');

    // Resuming from a pause: just the numbers.
    host.requestPause();
    await flush();
    host.setReady(true);
    client.setReady(true);
    await flush();
    expect(countdowns().at(-1)).toEqual({ type: 'countdown', seconds: COUNTDOWN_SECONDS, intro: 0 });
    expect(host.countdownEndMs - host.introEndMs).toBeCloseTo(COUNTDOWN_SECONDS * 1000);
    expect(client.introEndMs).toBeLessThanOrEqual(performance.now());
    host.countdownEndMs = 0;
    client.countdownEndMs = 0;
    advance(500);
    await flush();

    // Retrying from a checkpoint: just the numbers. Restarting the run: the shot again.
    addEvents({ type: 'checkpoint', stationId: 'orig' });
    advance(20);
    await flush();
    endGame(ctx, 'lost');
    advance(100);
    await flush();
    host.retryFromCheckpoint();
    await flush();
    host.setReady(true);
    client.setReady(true);
    await flush();
    expect(countdowns().at(-1)).toMatchObject({ intro: 0 });
    host.countdownEndMs = 0;
    client.countdownEndMs = 0;
    advance(100);
    await flush();
    endGame(ctx, 'lost');
    advance(100);
    await flush();
    host.restart();
    await flush();
    host.setReady(true);
    client.setReady(true);
    await flush();
    expect(countdowns().at(-1)).toMatchObject({ intro: INTRO_SECONDS });
  });

  it('pauses when the Engineer drops, and resyncs them when they come back', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { host, client, pair, received } = ctx;
    const gameId = client.game!.id;
    pair.drop();
    await flush();
    expect(host.connected).toBe(false);
    expect(host.mode).toBe('paused');
    expect(host.waitingForEngineer).toBe(true);
    received.length = 0;
    pair.restore();
    await flush(5);
    expect(host.connected).toBe(true);
    expect(host.waitingForEngineer).toBe(false);
    const types = received.map((m) => m.type);
    expect(types).toEqual(expect.arrayContaining(['welcome', 'start', 'snapshot', 'pause', 'ready']));
    const start = received.find((m) => m.type === 'start');
    expect(start?.type === 'start' && start.resume).toBe(true);
    expect(client.screen).toBe('playing');
    expect(client.mode).toBe('paused');
    expect(client.game!.id).toBe(gameId); // the same game: the desk stays
    host.setReady(true);
    client.setReady(true);
    await flush();
    expect(host.mode).toBe('countdown');
  });

  it('reports a loss to both sides, restarts, and returns to the lobby', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { host, client, advance } = ctx;
    endGame(ctx, 'lost');
    advance(100);
    await flush();
    expect(host.screen).toBe('results');
    expect(client.screen).toBe('results');
    expect(client.result?.outcome).toBe('lost');
    expect(client.result?.detail).toBe('Took the curve at 52 mph; the limit was 30.');
    expect(client.payout).toMatchObject({ won: false, total: 0 });
    expect(client.checkpointName).toBeNull();
    expect(host.hasNext()).toBe(false);
    expect(host.retryStation()).toBeNull();
    const firstGame = client.game!.id;
    host.restart();
    await flush();
    expect(client.screen).toBe('briefing');
    expect(client.game!.id).not.toBe(firstGame);
    host.toLobby();
    await flush();
    expect(client.screen).toBe('lobby');
    expect(host.selectedRun).toBe(0);
  });

  it('records a win: money, unlocks, the next run', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { host, client, advance } = ctx;
    endGame(ctx, 'won');
    advance(100);
    await flush();
    expect(client.result?.outcome).toBe('won');
    expect(host.campaign.unlocked).toBe(2);
    expect(host.campaign.completed.map((e) => e.runId)).toEqual(['first-light']);
    expect(host.campaign.money).toBe(Math.max(0, host.payout!.total));
    expect(client.campaign).toEqual(host.campaign);
    expect(ctx.save().campaign).toEqual(host.campaign);
    expect(host.hasNext()).toBe(true);
    host.next();
    await flush();
    expect(host.game!.run.id).toBe('payroll');
    expect(client.game!.run.id).toBe('payroll');
    expect(client.game!.replay).toBe(false);
    // Back in the lobby the suggestion follows the campaign: the run after the one won.
    host.toLobby();
    await flush();
    expect(host.selectedRun).toBe(1);
  });

  it('rejects a client with the wrong protocol version', async () => {
    const pair = createLocalPair();
    const host = new HostSession({ campaign: defaultCampaign(), recordResult: () => ({ campaign: defaultCampaign(), payout: null! }), runs: RUNS3 });
    host.attachTransport(pair.host);
    const got: Msg[] = [];
    pair.client.onMessage((m) => got.push(m));
    pair.client.send({ type: 'hello', protocol: 999 });
    await flush();
    expect(got).toEqual([{ type: 'reject', reason: 'Reload the page to get the latest version' }]);
    expect(host.connected).toBe(false);
  });

  it('never sends the Engineer anything but the documented messages, and never the seed or hidden run data', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { client, advance, received } = ctx;
    client.sendCmd({ kind: 'throttle', value: 1 });
    for (let k = 0; k < 10; k++) {
      advance(500);
      await flush();
    }
    endGame(ctx, 'lost');
    advance(100);
    await flush();
    const allowed = new Set(['welcome', 'reject', 'ready', 'lobby', 'depotRefused', 'start', 'snapshot', 'event', 'ack', 'pause', 'countdown', 'ping', 'pong', 'result', 'debug', 'switchBegin', 'switchSave']);
    for (const m of received) expect(allowed.has(m.type)).toBe(true);
    const keys = keysIn(received.filter((m) => m.type !== 'debug'));
    for (const hidden of ['seed', 'variant', 'variants', 'obstacles', 'waves', 'plan', 'bandits', 'horsemen', 'loot']) expect(keys.has(hidden)).toBe(false);
    expect(received.some((m) => m.type === 'snapshot')).toBe(true);
  });
});

describe('the lobby and depot', () => {
  it('either player can buy, couple cars and switch assists; the host saves and broadcasts', async () => {
    const ctx = setup({ campaign: { money: 500 } });
    const { host, client } = ctx;
    await flush();
    client.depot({ kind: 'buy', item: 'rifle' });
    await flush();
    expect(host.campaign.money).toBe(250);
    expect(host.campaign.owned).toEqual(['rifle']);
    expect(client.lobby?.campaign.owned).toEqual(['rifle']);
    expect(ctx.save().campaign.owned).toEqual(['rifle']);

    expect(host.depot({ kind: 'toggleCar', car: 'passenger' })).toEqual({ ok: true });
    await flush();
    expect(client.lobby?.consist).toEqual(['passenger']);
    client.depot({ kind: 'toggleCar', car: 'boxcar' });
    client.depot({ kind: 'assist', seat: 'engineer', on: true });
    await flush();
    expect(host.campaign.consist).toEqual(['passenger', 'boxcar']);
    expect(host.campaign.assists).toEqual({ rider: false, engineer: true });
    expect(client.lobby?.campaign.assists.engineer).toBe(true);
    expect(ctx.writes.campaign).toBe(4);

    // The game starts with what the depot set up.
    await toBriefing(ctx);
    expect(host.game!.consist).toEqual(['passenger', 'boxcar']);
    expect(host.game!.upgrades).toEqual(['rifle']);
    expect(client.game?.assists).toEqual({ rider: false, engineer: true });
  });

  it('refuses invalid actions from either side and says why', async () => {
    const ctx = setup({ campaign: { money: 100, unlocked: 2, consist: ['express', 'passenger', 'boxcar'] } });
    const { host, client } = ctx;
    await flush();
    const refused: string[] = [];
    client.onDepotRefusal((r) => refused.push(r));

    client.depot({ kind: 'buy', item: 'governor' });
    await flush();
    expect(refused).toEqual(['Not enough money: the Firebox governor costs $200.']);
    expect(host.campaign.money).toBe(100);

    // Run 1 takes at most three cars behind the tender, and the train is full.
    expect(host.depot({ kind: 'toggleCar', car: 'caboose' })).toEqual({ ok: false, reason: 'Buy the caboose at the depot first.' });
    client.depot({ kind: 'toggleCar', car: 'armored' });
    await flush();
    expect(refused[1]).toBe('Buy the armored car at the depot first.');
    const rich = setup({ campaign: { money: 1000, consist: ['express', 'passenger', 'boxcar'], owned: ['caboose'] } });
    await flush();
    expect(rich.host.depot({ kind: 'toggleCar', car: 'caboose' })).toEqual({ ok: false, reason: 'The train is full: at most 3 cars behind the tender.' });

    // Run 2 needs its express car.
    client.depot({ kind: 'selectRun', index: 1 });
    await flush();
    expect(host.selectedRun).toBe(1);
    expect(client.lobby?.consist[0]).toBe('express');
    client.depot({ kind: 'toggleCar', car: 'express' });
    await flush();
    expect(refused[2]).toBe('The contract needs the express car.');
    expect(host.lobbyState().consist).toContain('express');

    // Locked runs, nonsense and a closed depot.
    expect(host.depot({ kind: 'selectRun', index: 2 })).toEqual({ ok: false, reason: 'That run is locked: win the one before it first.' });
    expect(host.depot({ kind: 'selectRun', index: 7 })).toEqual({ ok: false, reason: "There's no such run." });
    ctx.pair.client.send({ type: 'depot', action: { kind: 'demolish' } as never });
    await flush();
    expect(refused[3]).toBe("The depot doesn't know that.");
    await toBriefing(ctx);
    client.depot({ kind: 'buy', item: 'headlamp' });
    await flush();
    expect(refused[4]).toBe('The run has started, so the depot is closed.');
    expect(host.campaign.owned).toEqual([]);
  });

  it('suggests the run after the furthest one won, or the checkpoint’s run', () => {
    const session = (campaign: Partial<CampaignProgress>) =>
      new HostSession({ campaign: { ...defaultCampaign(), ...campaign }, recordResult: () => ({ campaign: defaultCampaign(), payout: null! }), runs: RUNS3 });
    expect(session({}).selectedRun).toBe(0);
    expect(session({ unlocked: 2, completed: [{ runId: 'first-light', bestTimeSec: 1, medals: [], times: 1 }] }).selectedRun).toBe(1);
    expect(session({ unlocked: 3, completed: [{ runId: 'signal-country', bestTimeSec: 1, medals: [], times: 1 }] }).selectedRun).toBe(2);
    const forced = new HostSession({ campaign: defaultCampaign(), recordResult: () => ({ campaign: defaultCampaign(), payout: null! }), runs: RUNS3, forcedRun: 2 });
    expect(forced.selectedRun).toBe(2);
    expect(forced.canPlay(2)).toBe(true);
    expect(forced.canPlay(1)).toBe(false);
  });
});

describe('switching seats (spec §3)', () => {
  /** Both tick "Switch seats". */
  async function bothTick(ctx: Ctx): Promise<void> {
    await flush();
    ctx.host.setSwitchSeats(true);
    ctx.client.setSwitchSeats(true);
    await flush();
  }

  it('begins when both have ticked it: the Engineer’s browser is asked for a room, and the depot waits', async () => {
    const ctx = setup({ campaign: { money: 500 } });
    const { host, client, received } = ctx;
    await flush();
    const begun: number[] = [];
    client.onSwitchBegin(() => begun.push(1));
    host.setSwitchSeats(true);
    await flush();
    expect(client.lobby?.switchSeats).toEqual({ rider: true, engineer: false, switching: false });
    expect(host.switching).toBe(false);
    client.setSwitchSeats(true);
    await flush();
    expect(host.switching).toBe(true);
    expect(begun).toEqual([1]);
    expect(client.lobby?.switchSeats).toEqual({ rider: true, engineer: true, switching: true });
    // The depot and the start wait while the seats switch, and nothing of the save has gone yet.
    expect(host.depot({ kind: 'buy', item: 'rifle' })).toEqual({ ok: false, reason: 'The seats are switching.' });
    host.setReady(true);
    client.setReady(true);
    await flush();
    expect(host.canStart()).toBe(false);
    expect(received.some((m) => m.type === 'switchSave')).toBe(false);
    expect(keysIn(received).has('seed')).toBe(false);
  });

  it('either can change their mind before the other ticks it', async () => {
    const ctx = setup();
    const { host, client } = ctx;
    await flush();
    client.setSwitchSeats(true);
    await flush();
    client.setSwitchSeats(false);
    await flush();
    host.setSwitchSeats(true);
    await flush();
    expect(host.switching).toBe(false);
    expect(client.lobby?.switchSeats).toEqual({ rider: true, engineer: false, switching: false });
  });

  it('hands the save over once the new room is open', async () => {
    const ctx = setup({ campaign: { money: 70, unlocked: 2 } });
    const { host, client } = ctx;
    await flush();
    host.depot({ kind: 'selectRun', index: 1 });
    const saves: SwitchSave[] = [];
    client.onSwitchSave((s) => saves.push(s));
    await bothTick(ctx);
    client.sendSwitchRoom('ab cde');
    await flush();
    expect(host.handoverCode).toBe('ABCDE');
    expect(saves).toEqual([{ campaign: host.campaign, checkpoint: null, runId: 'payroll' }]);
    // Once handed over, a second room changes nothing, and neither does the Engineer leaving.
    client.sendSwitchRoom('FGHJK');
    ctx.pair.drop();
    await flush();
    expect(host.handoverCode).toBe('ABCDE');
    expect(host.switching).toBe(true);
    expect(saves).toHaveLength(1);
  });

  it('takes the checkpoint along, so the new Rider can continue from it', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    addEvents({ type: 'checkpoint', stationId: 'orig' });
    ctx.advance(20);
    await flush();
    const cp = ctx.host.checkpoint!;
    ctx.host.toLobby();
    const saves: SwitchSave[] = [];
    ctx.client.onSwitchSave((s) => saves.push(s));
    await bothTick(ctx);
    ctx.client.sendSwitchRoom('ABCDE');
    await flush();
    expect(saves[0].checkpoint).toEqual(cp);
    expect(saves[0].runId).toBe('first-light');
  });

  it('ignores a room code that isn’t one', async () => {
    const ctx = setup();
    await bothTick(ctx);
    ctx.client.sendSwitchRoom('I0I0I');
    await flush();
    expect(ctx.host.handoverCode).toBeNull();
    expect(ctx.received.some((m) => m.type === 'switchSave')).toBe(false);
  });

  it('stays put when the room can’t open or the Engineer drops out, and the boxes clear', async () => {
    const ctx = setup();
    const { host, client, pair } = ctx;
    await bothTick(ctx);
    client.sendSwitchFailed("Can't reach the matchmaking server.");
    await flush();
    expect(host.switching).toBe(false);
    expect(host.switchProblem).toContain("Can't reach the matchmaking server.");
    expect(client.lobby?.switchSeats).toEqual({ rider: false, engineer: false, switching: false });

    await bothTick(ctx);
    expect(host.switching).toBe(true);
    pair.drop();
    await flush();
    expect(host.switching).toBe(false);
    expect(host.switchProblem).toContain('dropped out');
    pair.restore();
    await flush(5);
    // The Engineer comes back unticked; the Rider's tick stands.
    expect(client.lobby?.switchSeats).toEqual({ rider: true, engineer: false, switching: false });
  });

  it('clears the boxes when a run begins', async () => {
    const ctx = setup();
    const { host, client } = ctx;
    await flush();
    host.setSwitchSeats(true);
    await toBriefing(ctx);
    expect(host.switchRider).toBe(false);
    host.toLobby();
    await flush();
    expect(client.lobby?.switchSeats).toEqual({ rider: false, engineer: false, switching: false });
  });
});

describe('one campaign in both browsers (spec §17)', () => {
  const won = (runId: string, times = 1) => ({ runId, bestTimeSec: 400, medals: [], times });

  it('the Engineer brings their copy in the hello, and the host takes it when it’s further along', async () => {
    const theirs: CampaignProgress = { ...defaultCampaign(), unlocked: 3, money: 200, completed: [won('first-light'), won('payroll')] };
    const ctx = setup({ campaign: { unlocked: 2, completed: [won('first-light')] }, client: { campaign: () => theirs } });
    await flush();
    const hello = ctx.sent.find((m) => m.type === 'hello');
    expect(hello?.type === 'hello' && hello.campaign).toEqual(theirs);
    expect(ctx.host.campaign).toEqual(theirs);
    expect(ctx.save().campaign).toEqual(theirs);
    expect(ctx.host.tookEngineersCampaign).toBe(true);
    expect(ctx.host.selectedRun).toBe(2); // the run after the furthest won
    expect(ctx.client.lobby?.campaign).toEqual(theirs);
  });

  it('the host keeps its own when the Engineer’s copy is behind, the same, a different story or not there', async () => {
    const mine = { unlocked: 3, owned: ['shotgun' as const], completed: [won('first-light'), won('payroll')] };
    const behind = { ...defaultCampaign(), unlocked: 2, completed: [won('first-light')] };
    const other = { ...defaultCampaign(), unlocked: 2, owned: ['rifle' as const], completed: [won('first-light', 3)] };
    for (const theirs of [behind, { ...defaultCampaign(), ...mine }, other, null]) {
      const ctx = setup({ campaign: mine, client: { campaign: () => theirs } });
      await flush();
      expect(ctx.host.campaign).toEqual({ ...defaultCampaign(), ...mine });
      expect(ctx.host.tookEngineersCampaign).toBe(false);
      expect(ctx.writes.campaign).toBe(0);
      const hello = ctx.sent.find((m) => m.type === 'hello');
      expect(hello?.type === 'hello' && 'campaign' in hello).toBe(theirs !== null);
    }
  });

  it('a copy that isn’t a campaign is ignored', async () => {
    const ctx = setup({ client: { campaign: () => 'lots of money' as unknown as CampaignProgress } });
    await flush();
    expect(ctx.host.campaign).toEqual(defaultCampaign());
    expect(ctx.host.connected).toBe(true);
  });

  it('the Engineer’s browser hears every campaign the host sends, to keep its copy', async () => {
    const ctx = setup({ campaign: { money: 500 } });
    const seen: CampaignProgress[] = [];
    ctx.client.onCampaign((c) => seen.push(c));
    await flush();
    ctx.client.depot({ kind: 'buy', item: 'rifle' });
    await flush();
    expect(seen.at(-1)?.owned).toEqual(['rifle']);
    await toPlaying(ctx);
    endGame(ctx, 'won');
    ctx.advance(100);
    await flush();
    expect(seen.at(-1)?.completed.map((e) => e.runId)).toEqual(['first-light']);
  });
});

describe('the real campaign', () => {
  it('lists every run and plays the first one', async () => {
    const pair = createLocalPair();
    let save = defaultSave(false);
    const host = new HostSession({
      campaign: save.campaign,
      recordResult: (r) => {
        const out = recordResult(save, r);
        save = out.save;
        return { campaign: save.campaign, payout: out.payout };
      },
    });
    host.attachTransport(pair.host);
    const client = new ClientSession(pair.client);
    await flush();
    expect(client.runs.map((r) => r.id)).toEqual(RUNS.map((r) => r.id));
    expect(client.runs[0].unlocked).toBe(true);
    host.start(7);
    await flush();
    expect(client.game?.run.name).toBe(RUNS[0].name);
    client.setReady(true);
    host.setReady(true);
    await flush();
    host.countdownEndMs = 0;
    for (let t = 1000; t < 3000; t += 1000 / 60) host.frame(t);
    await flush();
    expect(host.game!.state.tick).toBeGreaterThan(60);
    expect(client.view?.tick).toBeGreaterThan(0);
  });
});

describe('runCard', () => {
  it('tells the lobby what a run is, in names rather than ids', () => {
    const run = yRun({ id: 'loop', index: 3, sideJobs: [{ id: 'j1', title: '4 passengers', pay: 80, from: 'orig', to: 'dest', needs: 'passenger' }] });
    const card = runCard(run, 3, { ...defaultCampaign(), completed: [{ runId: 'loop', bestTimeSec: 500, medals: ['clean'], times: 2 }] }, true);
    expect(card).toMatchObject({
      id: 'loop',
      index: 3,
      originName: 'Origin',
      destinationName: 'Destination',
      sideJobs: [{ title: '4 passengers', pay: 80, needs: 'passenger' }],
      unlocked: true,
      times: 2,
      best: 500,
      medals: ['clean'],
    });
    expect(Object.keys(card)).not.toContain('obstacles');
  });
});

describe('checkpoints', () => {
  it('are saved on departure, offered after a loss, restored as they were, and reach the Engineer', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { host, client, advance, received } = ctx;
    client.sendCmd({ kind: 'throttle', value: 0.8 });
    advance(500);
    await flush();
    addEvents({ type: 'checkpoint', stationId: 'orig' });
    advance(20);
    await flush();
    const cp = host.checkpoint!;
    expect(cp).toMatchObject({ runId: 'first-light', seed: 4242, stationId: 'orig', stationName: 'Origin', consist: host.game!.consist });
    expect(ctx.save().checkpoint).toBe(cp);
    const savedTick = cp.state.tick;
    expect(savedTick).toBeGreaterThan(0);
    advance(500);
    expect(host.game!.state.tick).toBeGreaterThan(savedTick);
    expect(cp.state.tick).toBe(savedTick); // a copy, not the live state
    expect(received.some((m) => m.type === 'event' && m.event.type === 'checkpoint')).toBe(true);

    endGame(ctx, 'lost');
    advance(100);
    await flush();
    expect(host.retryStation()).toBe('Origin');
    expect(client.checkpointName).toBe('Origin');
    received.length = 0;
    host.retryFromCheckpoint();
    await flush();
    const start = received.find((m) => m.type === 'start');
    expect(start?.type === 'start' && start.fromCheckpoint).toBe('Origin');
    expect(client.screen).toBe('briefing');
    expect(client.game?.fromCheckpoint).toBe('Origin');
    expect(host.game!.state.tick).toBe(savedTick);
    expect(host.game!.state).toEqual(cp.state);
    expect(host.game!.state).not.toBe(cp.state);
    expect(host.checkpoint).toBe(cp); // still there for another try

    // The lobby offers it too; a fresh start discards it.
    host.toLobby();
    await flush();
    expect(client.lobby?.checkpoint).toEqual({ runId: 'first-light', runName: 'Run 1', stationName: 'Origin' });
    expect(host.continueStation()).toBe('Origin');
    host.continueFromCheckpoint();
    await flush();
    expect(client.game?.fromCheckpoint).toBe('Origin');
    host.toLobby();
    host.start(5);
    await flush();
    expect(host.checkpoint).toBeNull();
    expect(ctx.save().checkpoint).toBeNull();
    expect(client.game?.fromCheckpoint).toBeNull();
  });

  it('is cleared when its run is won', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { host, advance } = ctx;
    addEvents({ type: 'checkpoint', stationId: 'orig' });
    advance(20);
    expect(host.checkpoint).not.toBeNull();
    endGame(ctx, 'won');
    advance(100);
    await flush();
    expect(host.screen).toBe('results');
    expect(host.checkpoint).toBeNull();
    expect(ctx.save().checkpoint).toBeNull();
  });
});

describe('what the Engineer hears', () => {
  it('filtered events only, and gunfire at most four times a second', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { host, advance, received } = ctx;
    received.length = 0;
    const shot: SimEvent = { type: 'shot', by: 'horseman', weapon: 'revolver', layer: 'trackside', x0: 3, y0: 2, x1: 10, y1: 3, hit: 'none' };
    const startTick = host.game!.state.tick;
    for (let k = 0; k < 2 * TICK_HZ; k++) {
      addEvents(shot, { ...shot, by: 'rider' });
      advance(1000 / TICK_HZ);
    }
    addEvents({ type: 'telegram', id: 't1', text: 'Runaway loose at Mesa.' }, { type: 'banditBoarded', id: 1, x: 30, y: 4, into: 'platform' });
    advance(40);
    await flush();
    const ticks = host.game!.state.tick - startTick;
    const gunfire = received.filter((m) => m.type === 'event' && m.event.type === 'gunfire');
    expect(gunfire.length).toBeLessThanOrEqual(Math.ceil(ticks / GUNFIRE_MIN_TICKS));
    expect(gunfire.length).toBeGreaterThanOrEqual(Math.floor((2 * TICK_HZ) / GUNFIRE_MIN_TICKS));
    expect(gunfire.every((m) => m.type === 'event' && m.event.type === 'gunfire' && m.event.intensity === 0.6)).toBe(true);
    const types = received.filter((m) => m.type === 'event').map((m) => (m.type === 'event' ? m.event.type : ''));
    expect(types).toContain('telegram');
    expect(types).not.toContain('shot');
    expect(types).not.toContain('banditBoarded');
  });
});

describe('the autopilot hook', () => {
  it('drives the Engineer’s levers without acking the client', async () => {
    const ctx = setup();
    const begun: string[] = [];
    ctx.host.autopilot = {
      begin: (run) => begun.push(run.id),
      step: (): EngineerCmdBody[] => [{ kind: 'throttle', value: 1 }],
    };
    await toPlaying(ctx);
    expect(begun).toEqual(['first-light']);
    expect(ctx.host.game!.state.train.throttle).toBe(1);
    expect(ctx.received.some((m) => m.type === 'ack')).toBe(false);
  });
});

describe('review regressions (sessions)', () => {
  it('a version reject is final: later lobby updates do not pull the client into a fake lobby', async () => {
    const pair = createLocalPair();
    const host = new HostSession({ campaign: defaultCampaign(), recordResult: () => ({ campaign: defaultCampaign(), payout: null! }), runs: RUNS3 });
    host.attachTransport(pair.host);
    const got: Msg[] = [];
    pair.client.onMessage((m) => got.push(m));
    pair.client.send({ type: 'hello', protocol: 999 });
    await flush();
    host.depot({ kind: 'selectRun', index: 0 });
    host.setReady(true);
    pair.client.send({ type: 'ready', ready: true });
    pair.client.send({ type: 'depot', action: { kind: 'buy', item: 'rifle' } });
    await flush();
    expect(got.map((m) => m.type)).toEqual(['reject']);
    expect(host.clientReady).toBe(false);
    // And a ClientSession that was rejected stays on the rejected screen.
    const pair2 = createLocalPair();
    const client = new ClientSession(pair2.client);
    pair2.host.send({ type: 'reject', reason: 'Reload the page to get the latest version' });
    await flush();
    pair2.host.send({ type: 'lobby', lobby: host.lobbyState(), runs: host.runCards() });
    await flush();
    expect(client.screen).toBe('rejected');
  });

  it('when both pause at once, the first pause counts', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { host, client } = ctx;
    host.requestPause();
    client.requestPause(); // sent before the host's pause arrived
    await flush();
    expect(host.pausedBy).toBe('rider');
    expect(client.pausedBy).toBe('rider');
  });

  it('a pause after a dropped connection says so, and keeps who paused', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { host, client, pair } = ctx;
    host.requestPause();
    await flush();
    expect(client.pausedBy).toBe('rider');
    pair.drop();
    await flush();
    pair.restore();
    await flush(5);
    expect(host.pausedBy).toBe('rider');
    expect(host.connectionDropped).toBe(true);
    expect(client.pauseReason).toBe('disconnect');
    host.setReady(true);
    client.setReady(true);
    await flush();
    expect(host.connectionDropped).toBe(false);
    expect(client.pauseReason).toBe(null);
  });

  it('the Rider can abandon a paused game or a briefing and take the Engineer back to the lobby', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { host, client, pair } = ctx;
    pair.drop();
    await flush();
    expect(host.waitingForEngineer).toBe(true);
    host.toLobby();
    expect(host.screen).toBe('lobby');
    expect(host.waitingForEngineer).toBe(false);
    pair.restore();
    await flush(5);
    expect(client.screen).toBe('lobby');
    await toBriefing(ctx);
    host.toLobby();
    await flush();
    expect(client.screen).toBe('lobby');
  });

  it('a reconnect during the results shows the Engineer the results again', async () => {
    const ctx = setup();
    await toPlaying(ctx);
    const { client, pair, advance } = ctx;
    endGame(ctx, 'lost');
    advance(100);
    await flush();
    pair.drop();
    await flush();
    pair.restore();
    await flush(5);
    expect(client.screen).toBe('results');
    expect(client.result?.outcome).toBe('lost');
  });
});

describe('cleanCmd', () => {
  it('passes well-formed commands and drops anything else', () => {
    expect(cleanCmd({ seq: 1, kind: 'throttle', value: 0.5 })).toEqual({ seq: 1, kind: 'throttle', value: 0.5 });
    expect(cleanCmd({ seq: 2, kind: 'reverser', value: -1 })).toEqual({ seq: 2, kind: 'reverser', value: -1 });
    expect(cleanCmd({ seq: 3, kind: 'switch', junction: 'J1', state: 'reverse', extra: 1 })).toEqual({ seq: 3, kind: 'switch', junction: 'J1', state: 'reverse' });
    expect(cleanCmd({ seq: 4, kind: 'whistle', on: true })).toEqual({ seq: 4, kind: 'whistle', on: true });
    for (const bad of [
      null,
      'throttle',
      { seq: 1, kind: 'throttle', value: Number.NaN },
      { seq: 1, kind: 'throttle', value: '1' },
      { seq: 0, kind: 'brake', value: 1 },
      { seq: 1.5, kind: 'brake', value: 1 },
      { seq: 1, kind: 'reverser', value: 2 },
      { seq: 1, kind: 'switch', junction: 'J1', state: 'sideways' },
      { seq: 1, kind: 'whistle', on: 1 },
      { seq: 1, kind: 'teleport' },
    ]) {
      expect(cleanCmd(bad)).toBeNull();
    }
  });
});
