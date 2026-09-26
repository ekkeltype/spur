// The Engineer's desk (spec §11): the Engineer's whole play screen. The app mounts `el` full-window,
// feeds it EngineerView snapshots (~15/s), filtered events and refusals, and calls frame() on every
// animation frame; the desk turns mouse and keyboard input into EngineerCmdBody commands (levers
// throttled to one per 50 ms, spec §16.1).
//
// Layout (desk.css): the header across the top; the cab down the left; the route map; the
// timetable chart and the Ahead list under it; the log, the telegraph, the Rider's whereabouts and
// the rulebook button across the bottom. The panels live in cab.ts, panels.ts, map.ts, chart.ts
// and rulebook.ts; the pure parts (ahead, marey, levers, format, events) are unit-tested. This
// file holds the desk's state: what the Engineer asked for and what the host confirmed, the
// keyboard, and what's derived from each snapshot (the Ahead list, the route the switches set,
// the chart's projection and conflicts).

import './desk.css';
import type { DebugInfo } from '../../net/protocol';
import { fouls, frontHead, netIndex, rearHead, spansLength, walk, xOnSpans, type NetIndex } from '../../sim/network';
import { CAR_SPECS, FIRE_MAX, REVERSER_MAX_SPEED, SWITCH_FOUL_DISTANCE } from '../../sim/rules';
import type { CarType, EngineerCmdBody, EngineerEvent, EngineerRun, EngineerView, Span, SwitchState, TrackHead } from '../../sim/types';
import { HiDpiCanvas } from '../canvas';
import { buildAhead, stopTarget, type AheadItem, type AheadKind, type StopTarget } from './ahead';
import { CabPanel, type CabLook, type LeverKind } from './cab';
import { MareyChart, type ChartTrain } from './chart';
import { btn, capitalise, el, isTyping, kbd, setClass, setHtml, setText } from './dom';
import { describeEvent, type LogTone } from './events';
import { formatClock, junctionNumbers, secondsTo } from './format';
import { brakeStep, CmdThrottle, stepThrottle } from './levers';
import { RouteMap, type MapFlash, type MapModel } from './map';
import { OutlawView } from './outlaw';
import { crossings, holdAdvice, mainLength, mainRate, projectAhead, scheduleLine, sidingBands, TraceRecorder, type Band, type Crossing, type Projection } from './marey';
import { AHEAD_ROWS, AheadPanel, HeaderPanel, LogPanel, RiderPanel, TelegraphPanel } from './panels';
import { Rulebook } from './rulebook';

export interface DeskOptions {
  /** Every command the Engineer issues (levers are throttled by the desk to ≤ 1 per 50 ms). */
  onCmd: (cmd: EngineerCmdBody) => void;
  /** Esc pressed on the desk (only with keyboard 'full': in local test mode the Rider's keys pause). */
  onPause: () => void;
  /** 'full' online; 'local' in local test mode, where the Rider has most of the keyboard (spec §11). */
  keyboard: 'full' | 'local';
  /** Letters on signal lamps in the rulebook (settings; setLampLetters changes it later). */
  lampLetters: boolean;
  /** Engineer assist: conflict advice on the chart; the firebox shows as automatic. */
  assist: boolean;
  /** The cars behind the tender, front to back (the `start` message's consist): names the Rider's car. */
  consist?: readonly CarType[];
  /** The firebox governor upgrade: the firebox runs itself, as with the assist (spec §5.5). */
  governor?: boolean;
}

// ---- The desk's own tunables (presentation only; game rules live in sim/rules.ts) ----------------

/** How far the lit route and the Ahead list look (m). */
const ROUTE_RANGE = 6000;
const AHEAD_RANGE = 12000;
/** An optimistic lever position is kept this long after the last local change (ms). */
const LEVER_HOLD_MS = 800;
/** An unconfirmed switch, reverser or firebox command is shown this long (ms). */
const PENDING_MS = 1500;
/** A refusal this soon after a command is taken to be about it (ms). */
const REFUSAL_MATCH_MS = 2000;
/** The chart's math is redone at most this often (ms). */
const CHART_MS = 250;
/** The desk is laid out for 1280×720 at this font size (px) and scales from there. */
const DESIGN_W = 1280;
const DESIGN_H = 720;
const DESIGN_FONT = 14;
/** The narrow layout (half a window in local test mode) is laid out for about this box. */
const NARROW_W = 900;
const NARROW_H = 900;

interface LeverState {
  gate: CmdThrottle;
  /** The position the Engineer set, shown until the host's view catches up. */
  local: { value: number; until: number } | null;
  dragging: boolean;
}

export class EngineerDesk {
  readonly el: HTMLElement;

  private readonly ix: NetIndex;
  private readonly numbers: Map<string, number>;
  private readonly byNumber = new Map<number, string>();
  private readonly header: HeaderPanel;
  private readonly cab: CabPanel;
  private readonly aheadPanel: AheadPanel;
  private readonly rider: RiderPanel;
  private readonly logPanel: LogPanel;
  private readonly telegraph: TelegraphPanel;
  private readonly map: RouteMap;
  private readonly chart = new MareyChart();
  private readonly rulebook: Rulebook;
  /** The outlaw who comes in with a hold-up (flavour). */
  private readonly outlaw = new OutlawView();
  private readonly trace = new TraceRecorder();
  private readonly observer: ResizeObserver | null;
  private readonly dom: {
    mapCanvas: HiDpiCanvas;
    fitBtn: HTMLButtonElement;
    followBtn: HTMLButtonElement;
    chartCanvas: HiDpiCanvas;
    chartBadge: HTMLElement;
    advice: HTMLElement;
    rulebookBtn: HTMLButtonElement;
  };

  private view: EngineerView | null = null;
  private enabled = true;
  private debug: DebugInfo | null = null;
  private dead = false;
  private font = DESIGN_FONT;
  private follow = false;
  private lastNow = 0;
  private lastClock: number | null = null;
  private recovered = false;

  // What the Engineer asked for, until the host confirms or refuses it.
  private readonly levers: Record<LeverKind, LeverState>;
  private pollTimer = 0;
  private readonly pendingSwitch = new Map<string, { state: SwitchState; at: number }>();
  private pendingReverser: { value: -1 | 0 | 1; at: number } | null = null;
  private pendingFire: { value: number; at: number } | null = null;
  private lastCmd: { body: EngineerCmdBody; at: number } | null = null;
  private whistleKey = false;
  private whistlePointer = false;
  private whistleSent = false;
  private hoverSwitch: string | null = null;
  private flashes: MapFlash[] = [];

  // Derived from the latest view.
  private ahead: AheadItem[] = [];
  private reversing = false;
  private target: StopTarget | null = null;
  private route: Span[] = [];
  private routeEdges = new Set<string>();

  // The chart: static data, then what's recomputed at most every CHART_MS.
  private readonly bands: Band[];
  private readonly chartStations: { id: string; name: string; m: number; dest: boolean }[];
  private readonly mMax: number;
  private chartAt = -Infinity;
  private chartT1 = 0;
  private chartTrains: ChartTrain[] = [];
  private projection: Projection | null = null;
  private conflict: Crossing | null = null;
  private meets: Crossing[] = [];

  private mapDirty = true;
  private chartDataDirty = true;
  private chartDirty = true;

  constructor(
    readonly run: EngineerRun,
    readonly opts: DeskOptions,
  ) {
    this.ix = netIndex(run);
    this.numbers = junctionNumbers(run);
    for (const [id, n] of this.numbers) this.byNumber.set(n, id);
    this.bands = sidingBands(run);
    this.mMax = mainLength(run);
    this.chartStations = run.stations
      .map((s) => {
        const e = this.ix.edge.get(s.edge);
        const m = e?.mainAt ? e.mainAt[0] + ((e.mainAt[1] - e.mainAt[0]) * s.at) / e.length : null;
        return { id: s.id, name: s.name, m, dest: s.id === run.contract.destination };
      })
      .filter((s): s is { id: string; name: string; m: number; dest: boolean } => s.m !== null);
    this.chartTrains = this.scheduleLines(run.contract.deadline + 300);
    const mkLever = (): LeverState => ({ gate: new CmdThrottle(50), local: null, dragging: false });
    this.levers = { throttle: mkLever(), brake: mkLever() };

    this.el = el('div', 'desk');
    this.el.setAttribute('role', 'application');
    this.el.setAttribute('aria-label', `Engineer's desk: ${run.name}`);
    this.header = new HeaderPanel(run, () => opts.onPause());
    this.cab = new CabPanel(run, { keyboard: opts.keyboard, autoFire: this.autoFire, governor: !!opts.governor }, {
      lever: (kind, value, phase, now) => this.onLeverPointer(kind, value, phase, now),
      reverser: (value, now) => this.setReverser(value, now),
      fire: (value, now) => this.setFire(value, now),
      whistle: (on) => {
        this.whistlePointer = on;
        this.syncWhistle();
      },
    });
    this.aheadPanel = new AheadPanel(this.ix, this.numbers);
    this.rider = new RiderPanel(opts.consist);
    this.logPanel = new LogPanel();
    this.telegraph = new TelegraphPanel();
    this.map = new RouteMap(this.ix);
    this.rulebook = new Rulebook(run, opts.lampLetters, () => this.setRulebook(false));
    this.dom = this.build();
    this.bindInput();

    this.observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(this.onResize) : null;
    this.observer?.observe(this.el);
    const fonts = document.fonts as FontFaceSet | undefined;
    fonts?.ready.then(this.onFontsLoaded).catch(() => undefined);
    fonts?.addEventListener?.('loadingdone', this.onFontsLoaded);
    this.cab.update(this.cabLook(0));
    this.onResize();
  }

  // -------------------------------------------------------------------------------------------
  // The API (the desk.ts stub's contract)

  /** A new snapshot (about 15 per second). */
  setView(view: EngineerView, now: number): void {
    if (this.dead) return;
    const prev = this.view;
    this.view = view;
    // The clock went back: a restart or a checkpoint. The old trace and pending commands are void.
    if (this.lastClock !== null && view.clock < this.lastClock - 1) this.onRestart();
    this.lastClock = view.clock;
    this.trace.add(view.clock, view.train.mainPos);

    // Confirm or expire what the Engineer asked for.
    for (const [id, p] of this.pendingSwitch) {
      if ((view.switches[id] ?? this.ix.junction.get(id)?.initial) === p.state || now - p.at > PENDING_MS) this.pendingSwitch.delete(id);
    }
    if (this.pendingReverser && (view.train.reverser === this.pendingReverser.value || now - this.pendingReverser.at > PENDING_MS)) this.pendingReverser = null;
    if (this.pendingFire && (view.train.fire === this.pendingFire.value || now - this.pendingFire.at > PENDING_MS)) this.pendingFire = null;
    for (const kind of ['throttle', 'brake'] as const) {
      const lv = this.levers[kind];
      if (lv.local && !lv.dragging && Math.abs(view.train[kind] - lv.local.value) < 1e-3) lv.local = null;
    }
    // A gun in the cab: the Engineer's hands come off the levers, and there's the outlaw.
    if (view.train.heldUp && !prev?.train.heldUp) this.releaseLevers(now);
    this.outlaw.set(view.train.heldUp && view.phase === 'running');

    this.derive(view, now);
    this.header.update(view, this.recovered);
    this.cab.update(this.cabLook(now));
    this.cab.stop.update(view, this.target, this.target ? null : this.nextStop(view));
    this.aheadPanel.update(view, this.ahead, this.reversing);
    this.rider.update(view);
    this.mapDirty = true;
  }

  /** A filtered event from the host, for the log and panel feedback (sounds are the app's job). */
  onEvent(e: EngineerEvent, now: number): void {
    if (this.dead) return;
    const line = describeEvent(e, {
      stationName: (id) => this.run.stations.find((s) => s.id === id)?.name ?? id,
      switchLabel: (id) => this.switchLabel(id),
      tunnelName: (id) => this.run.tunnels.find((t) => t.id === id)?.name ?? 'the tunnel',
      fordName: (id) => this.run.fords.find((f) => f.id === id)?.name ?? 'the ford',
      signalName: (id) => {
        const s = this.run.signals.find((g) => g.id === id);
        return s?.name ?? (s?.kind === 'junction' ? 'a junction signal' : 'a block signal');
      },
      cargo: capitalise(this.run.contract.cargo),
      flagDist: e.type === 'flagPlaced' ? this.distAhead(e.flag.point) : null,
    });
    if (line) this.log(line.text, line.tone, line.key);
    switch (e.type) {
      case 'switchThrown':
        this.pendingSwitch.delete(e.junction);
        this.flashes.push({ junction: e.junction, kind: 'thrown', at: now });
        this.mapDirty = true;
        break;
      case 'telegram':
        this.telegraph.show(e.text);
        break;
      case 'lootStolen':
      case 'lootRecovered':
        this.recovered = e.type === 'lootRecovered';
        if (this.view) this.header.update(this.view, this.recovered);
        break;
      case 'flagPlaced':
        this.mapDirty = true;
        break;
      default:
        break;
    }
  }

  /**
   * A command the host refused, with its reason. `cmd` (optional) is the refused command, when the
   * app tracks sequence numbers; without it the desk blames its latest switch, reverser or firebox
   * command of the last two seconds.
   */
  refused(reason: string, now: number, cmd?: EngineerCmdBody): void {
    if (this.dead) return;
    const recent = this.lastCmd && now - this.lastCmd.at < REFUSAL_MATCH_MS ? this.lastCmd.body : null;
    const what = cmd ?? recent;
    this.log(`Refused: ${reason}`, 'danger');
    switch (what?.kind) {
      case undefined:
        this.cab.flash('cab');
        break;
      case 'switch':
        this.pendingSwitch.delete(what.junction);
        this.flashes.push({ junction: what.junction, kind: 'refused', at: now });
        this.mapDirty = true;
        break;
      case 'reverser':
        this.pendingReverser = null;
        this.cab.flash('reverser');
        break;
      case 'fire':
        this.pendingFire = null;
        this.cab.flash('fire');
        break;
      case 'throttle':
      case 'brake': {
        const lv = this.levers[what.kind];
        lv.local = null;
        lv.gate.reset();
        this.cab.flashLever(what.kind, now);
        break;
      }
      case 'whistle':
        this.cab.flash('whistle');
        break;
    }
    this.cab.update(this.cabLook(now));
  }

  /** Once per animation frame (ms). */
  frame(now: number): void {
    if (this.dead) return;
    const dt = this.lastNow > 0 ? Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000)) : 0;
    this.lastNow = now;
    this.pollLevers(now);
    this.flashes = this.flashes.filter((f) => now - f.at < 1000);
    if (this.view && this.chartDataDirty && now - this.chartAt >= CHART_MS) this.deriveChart(this.view, now);

    this.cab.draw(this.cabLook(now), now, dt);
    const model = this.mapModel(now);
    if (this.mapDirty || this.map.animating(model)) {
      const hi = this.dom.mapCanvas;
      this.map.render(hi.begin(), hi.width, hi.height, model);
      this.mapDirty = false;
    }
    if (this.chartDirty) this.drawChart();
    if (this.rulebook.open) this.rulebook.draw();
  }

  /** Input on or off (off while paused or counting down). Off, the desk ignores every key and click. */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    setClass(this.el, 'dk-disabled', !on);
    if (!on) {
      this.releaseLevers(performance.now());
      this.whistleKey = false;
      this.whistlePointer = false;
      this.syncWhistle();
      this.hoverSwitch = null;
    }
    this.mapDirty = true;
    this.cab.update(this.cabLook(performance.now()));
  }

  /** Dev builds with ?debug=1: hidden information to overlay on the map. */
  setDebug(info: DebugInfo | null): void {
    this.debug = info;
    this.mapDirty = true;
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    (document.fonts as FontFaceSet | undefined)?.removeEventListener?.('loadingdone', this.onFontsLoaded);
    this.observer?.disconnect();
    window.clearTimeout(this.pollTimer);
    this.outlaw.destroy();
    this.el.remove();
  }

  // ---- Additions -----------------------------------------------------------------------------

  /** Whether the rulebook overlay is open. */
  get rulebookOpen(): boolean {
    return this.rulebook.open;
  }

  /** Opens or closes the rulebook overlay (Tab, or its button). */
  setRulebook(open: boolean): void {
    this.rulebook.setOpen(open);
    this.dom.rulebookBtn.setAttribute('aria-pressed', String(open));
  }

  /** Letters on the rulebook's signal lamps (a settings change applies at once). */
  setLampLetters(on: boolean): void {
    this.rulebook.setLetters(on);
  }

  /** The route map's zoom: fit the whole run, or follow the train. */
  setFollow(follow: boolean): void {
    this.follow = follow;
    this.dom.followBtn.setAttribute('aria-pressed', String(follow));
    this.dom.fitBtn.setAttribute('aria-pressed', String(!follow));
    this.mapDirty = true;
  }

  /**
   * The nearest item of a kind on the Ahead list now, and the real seconds to it at the current speed
   * (Infinity standing), or null: for the app's hints ("near the first signal").
   */
  nearest(kind: AheadKind): { item: AheadItem; secs: number } | null {
    const item = this.ahead.find((i) => i.kind === kind);
    const v = this.view?.train.v ?? 0;
    const speed = this.reversing ? -v : v;
    return item ? { item, secs: secondsTo(item.dist, speed) } : null;
  }

  // -------------------------------------------------------------------------------------------
  // Assembly

  private build(): EngineerDesk['dom'] {
    // The route map.
    const mapPanel = el('section', 'desk-panel desk-map');
    const mapHead = el('div', 'desk-panel-head');
    const n = this.numbers.size;
    const hint = n === 0 ? '' : `Click a switch or press its number${n > 1 ? ` (1–${Math.min(9, n)})` : ' (1)'} to throw it`;
    const tools = el('div', 'desk-seg dk-map-tools');
    const fitBtn = btn('desk-btn', 'Whole line', () => this.setFollow(false));
    fitBtn.setAttribute('aria-pressed', 'true');
    const followBtn = btn('desk-btn', 'Follow train', () => this.setFollow(true));
    followBtn.setAttribute('aria-pressed', 'false');
    tools.append(fitBtn, followBtn);
    mapHead.append(el('h2', undefined, 'Route map'), el('span', 'dk-hint', hint), el('span', 'dk-spacer'), tools);
    const mapWrap = el('div', 'desk-canvas-wrap');
    const mapCanvas = el('canvas');
    mapCanvas.setAttribute('role', 'img');
    mapCanvas.setAttribute('aria-label', 'Route map');
    mapWrap.append(mapCanvas);
    mapPanel.append(mapHead, mapWrap);

    // The timetable chart, with its conflict badge and the assist's advice.
    const chartPanel = el('section', 'desk-panel desk-chart');
    const chartHead = el('div', 'desk-panel-head');
    const chartBadge = el('span', 'chart-badge');
    chartBadge.hidden = true;
    chartHead.append(el('h2', undefined, 'Timetable'), el('span', 'dk-spacer'), chartBadge);
    const chartWrap = el('div', 'desk-canvas-wrap');
    const chartCanvas = el('canvas');
    chartCanvas.setAttribute('role', 'img');
    chartCanvas.setAttribute('aria-label', 'Timetable chart');
    chartWrap.append(chartCanvas);
    const advice = el('div', 'chart-advice');
    advice.hidden = true;
    chartPanel.append(chartHead, chartWrap, advice);

    // The footer.
    const foot = el('footer', 'desk-foot');
    const book =
      '<svg class="dk-book" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 5.5c3-1.5 6-1.5 9 .5 3-2 6-2 9-.5V19c-3-1.5-6-1.5-9 .5-3-2-6-2-9-.5z"/><path d="M12 6v13.5"/></svg>';
    const rulebookBtn = btn('desk-btn desk-rulebook-btn', `${book}Rulebook ${kbd('Tab')}`, () => this.setRulebook(!this.rulebook.open));
    rulebookBtn.setAttribute('aria-pressed', 'false');
    foot.append(this.logPanel.el, this.telegraph.el, this.rider.el, rulebookBtn);

    this.el.append(this.header.el, this.cab.el, mapPanel, chartPanel, this.aheadPanel.el, foot, this.rulebook.el);
    this.outlaw.mount(this.el);
    return { mapCanvas: new HiDpiCanvas(mapCanvas), fitBtn, followBtn, chartCanvas: new HiDpiCanvas(chartCanvas), chartBadge, advice, rulebookBtn };
  }

  private get autoFire(): boolean {
    return this.opts.assist || !!this.opts.governor;
  }

  private readonly onResize = (): void => {
    if (this.dead) return;
    const w = this.el.clientWidth || DESIGN_W;
    const h = this.el.clientHeight || DESIGN_H;
    // Tall or narrow boxes (half the window in local test mode) stack the chart under the map.
    const narrow = w / h < 1.3 && w < 1100;
    setClass(this.el, 'dk-narrow', narrow);
    // Scale the whole desk from its box: 1280×720 → 14px, growing a little slower than the box so
    // bigger screens also show more map and chart, and shrinking with it below the design size.
    const s = narrow ? Math.min(w / NARROW_W, h / NARROW_H) : Math.min(w / DESIGN_W, h / DESIGN_H);
    this.font = Math.round(DESIGN_FONT * (s >= 1 ? Math.pow(s, 0.8) : Math.max(0.7, s)) * 4) / 4;
    this.el.style.fontSize = `${this.font}px`;
    this.invalidate();
  };

  private readonly onFontsLoaded = (): void => {
    if (!this.dead) this.invalidate();
  };

  /** Everything drawn is stale (a resize, fonts arriving): redraw it all. */
  private invalidate(): void {
    this.mapDirty = true;
    this.chartDirty = true;
    this.cab.invalidate();
    this.rulebook.invalidate();
  }

  private onRestart(): void {
    this.trace.clear();
    this.pendingSwitch.clear();
    this.pendingReverser = null;
    this.pendingFire = null;
    this.chartDataDirty = true;
    this.chartDirty = true;
  }

  // -------------------------------------------------------------------------------------------
  // Derived state

  private derive(view: EngineerView, now: number): void {
    const t = view.train;
    if (t.spans.length === 0) {
      this.ahead = [];
      this.target = null;
      this.route = [];
      this.routeEdges = new Set();
      return;
    }
    const switches = this.displaySwitches();
    // Backing up (or about to, with the reverser in R), the list and the lit route run from the rear.
    this.reversing = t.v < -0.2 || (Math.abs(t.v) <= 0.2 && t.reverser === -1);
    const head: TrackHead = this.reversing ? rearHead(t.spans) : frontHead(t.spans);
    const L = spansLength(t.spans);
    const hatchX = xOnSpans(t.spans, t.hatch) ?? Math.max(0, L - (CAR_SPECS.loco.length + CAR_SPECS.tender.length - 2));
    this.ahead = buildAhead(this.ix, switches, head, {
      max: AHEAD_ROWS,
      range: AHEAD_RANGE,
      hatchBack: this.reversing ? hatchX : L - hatchX,
      flags: view.flags,
      destination: this.run.contract.destination,
      // Tunnels, fords and low bridges stay listed until the last car is past them.
      trainLength: L,
    });
    this.target = stopTarget(this.ix, switches, t.spans, t.hatch, { done: t.lastStation });
    this.route = walk(this.ix, switches, head, ROUTE_RANGE).spans;
    this.routeEdges = new Set([...this.route.map((s) => s.edge), ...t.spans.map((s) => s.edge)]);
    this.chartDataDirty = true;
    this.chartDirty = true;
    if (now - this.chartAt >= CHART_MS) this.deriveChart(view, now);
  }

  private scheduleLines(t1: number): ChartTrain[] {
    return this.run.aiTrains
      .filter((d) => d.charted && d.route.length > 0)
      .map((d) => ({ id: d.id, name: d.name, kind: d.kind, pts: scheduleLine(this.ix, d, this.run.startClock, t1) }));
  }

  /** The chart's projection at the current speed, and where it meets the timetabled trains (spec §11). */
  private deriveChart(view: EngineerView, now: number): void {
    this.chartAt = now;
    this.chartDataDirty = false;
    // The chart runs to the deadline plus 5 minutes, or on past it when the train is late.
    const t1 = Math.max(this.run.contract.deadline + 300, view.clock + 120);
    if (t1 !== this.chartT1) {
      this.chartT1 = t1;
      this.chartTrains = this.scheduleLines(t1);
    }
    const t = view.train;
    this.projection = null;
    this.conflict = null;
    this.meets = [];
    if (t.mainPos !== null && t.spans.length > 0) {
      const rate = mainRate(this.ix, frontHead(t.spans), t.v) ?? 0;
      this.projection = projectAhead(view.clock, t.mainPos, rate, t1, this.mMax);
      // A meet inside a siding is safe only if the train is in it or its route takes it.
      const all = crossings(this.projection, this.chartTrains, this.bands, (b) => this.routeEdges.has(b.edge));
      this.conflict = all.find((c) => !c.safe) ?? null;
      this.meets = all.filter((c) => c.safe && (!this.conflict || c.t < this.conflict.t)).slice(0, 3);
    }
    this.updateChartDom(view);
    this.chartDirty = true;
  }

  private updateChartDom(view: EngineerView): void {
    const d = this.dom;
    const cf = this.conflict;
    const trainName = (id: string): string => this.chartTrains.find((c) => c.id === id)?.name ?? 'A train';
    if (cf) {
      d.chartBadge.hidden = false;
      d.chartBadge.className = 'chart-badge dk-conflict';
      setText(d.chartBadge, `Conflict: ${trainName(cf.train)} at ${formatClock(cf.t)}`);
    } else if (this.meets.length > 0) {
      const m = this.meets[0];
      d.chartBadge.hidden = false;
      d.chartBadge.className = 'chart-badge dk-meet';
      setText(d.chartBadge, `Meet ${trainName(m.train)} in ${m.band?.name ?? 'the siding'}`);
    } else d.chartBadge.hidden = true;

    // The Engineer assist: where to let the other train by (spec §12).
    const advise = this.opts.assist && !!cf && !!this.projection;
    if (advise && cf && this.projection) {
      const occupied = view.train.spans.length > 0 ? view.train.spans[view.train.spans.length - 1].edge : null;
      const a = holdAdvice(cf, this.projection, this.bands, this.chartTrains, this.run.aiTrains, occupied);
      let text: string;
      if (a) {
        const until = formatClock(Math.ceil(a.until / 60) * 60);
        const sw = this.sidingSwitch(a.band, view);
        if (a.where === 'here') text = `Hold here in ${a.band.name} until ${until}.`;
        else if (a.where === 'ahead') text = `Take ${a.band.name}${sw} and hold until ${until}.`;
        else if (a.where === 'behind') text = `Back into ${a.band.name}${sw} and hold until ${until}.`;
        else text = `Get into ${a.band.name}${sw} and hold until ${until}.`;
      } else text = `${trainName(cf.train)} meets you at ${formatClock(cf.t)} and there's no siding in reach: stop short of it.`;
      setHtml(d.advice, `<b>ASSIST</b><span>${text}</span>`);
    }
    if (d.advice.hidden === advise) {
      d.advice.hidden = !advise;
      this.chartDirty = true; // the plot's height changed
    }
  }

  /** " (switch 2 to reverse)": the switch that turns the train into a siding, unless the route already does. */
  private sidingSwitch(b: Band, view: EngineerView): string {
    if (this.routeEdges.has(b.edge)) return '';
    const pos = view.train.mainPos ?? 0;
    let best: { n: number; state: SwitchState; d: number } | null = null;
    for (const j of this.run.junctions) {
      const state: SwitchState | null = j.reverse === b.edge ? 'reverse' : j.normal === b.edge ? 'normal' : null;
      const e = this.ix.edge.get(j.trunk);
      const m = e?.mainAt ? (e.a === j.node ? e.mainAt[0] : e.mainAt[1]) : null;
      const n = this.numbers.get(j.node);
      if (!state || m === null || !n) continue;
      if (!best || Math.abs(m - pos) < best.d) best = { n, state, d: Math.abs(m - pos) };
    }
    return best ? ` (switch ${best.n} to ${best.state})` : '';
  }

  /** The switches as drawn: the view's, with the Engineer's unconfirmed throws applied. */
  private displaySwitches(): Record<string, SwitchState> {
    const out: Record<string, SwitchState> = {};
    for (const j of this.run.junctions) out[j.node] = this.view?.switches[j.node] ?? j.initial;
    for (const [id, p] of this.pendingSwitch) out[id] = p.state;
    return out;
  }

  /** The next station or water tower along the route, for the stop readout's idle line. */
  private nextStop(view: EngineerView): { name: string; dist: number } | null {
    if (view.train.spans.length === 0) return null;
    const head = this.reversing ? rearHead(view.train.spans) : frontHead(view.train.spans);
    const s = buildAhead(this.ix, this.displaySwitches(), head, { max: 40, range: 40000 }).find((i) => i.kind === 'station' || i.kind === 'water');
    return s ? { name: s.name, dist: s.dist } : null;
  }

  /** Metres from the loco's front to a point ahead on the route, or null. */
  private distAhead(p: { edge: string; off: number }): number | null {
    const v = this.view;
    if (!v || v.train.spans.length === 0) return null;
    return xOnSpans(walk(this.ix, this.displaySwitches(), frontHead(v.train.spans), 2500).spans, p);
  }

  private switchLabel(id: string): string {
    const n = this.numbers.get(id);
    const name = this.ix.junction.get(id)?.name ?? id;
    return n ? `Switch ${n} (${name})` : name;
  }

  /** The controls take input: not paused, no gun in the cab, the run under way. */
  private controlsLive(): boolean {
    const v = this.view;
    return this.enabled && !!v && !v.train.heldUp && v.phase === 'running';
  }

  private log(text: string, tone: LogTone, key?: string): void {
    this.logPanel.add(text, tone, this.view?.clock ?? this.run.startClock, key);
  }

  // -------------------------------------------------------------------------------------------
  // Drawing

  private leverValue(kind: LeverKind, now: number): number {
    const lv = this.levers[kind];
    if (lv.local && (lv.dragging || now < lv.local.until)) return lv.local.value;
    return this.view?.train[kind] ?? 0;
  }

  private cabLook(now: number): CabLook {
    const v = this.view;
    return {
      view: v,
      throttle: this.leverValue('throttle', now),
      brake: this.leverValue('brake', now),
      reverser: this.pendingReverser?.value ?? v?.train.reverser ?? 0,
      fire: this.pendingFire?.value ?? v?.train.fire ?? 0,
      whistle: this.whistleSent || !!v?.train.whistle,
      live: this.controlsLive(),
      enabled: this.enabled,
      dragging: { throttle: this.levers.throttle.dragging, brake: this.levers.brake.dragging },
      font: this.font,
    };
  }

  private mapModel(now: number): MapModel {
    return {
      view: this.view,
      switches: this.displaySwitches(),
      pending: new Set(this.pendingSwitch.keys()),
      numbers: this.numbers,
      route: this.route,
      hover: this.hoverSwitch,
      flashes: this.flashes,
      follow: this.follow,
      destination: this.run.contract.destination,
      debug: this.debug,
      enabled: this.controlsLive(),
      font: this.font,
      now,
    };
  }

  private drawChart(): void {
    const hi = this.dom.chartCanvas;
    const v = this.view;
    this.chart.render(hi.begin(), hi.width, hi.height, {
      t0: this.run.startClock,
      t1: this.chartT1 || this.run.contract.deadline + 300,
      mMax: this.mMax,
      clock: v?.clock ?? null,
      pos: v?.train.mainPos ?? null,
      trace: this.trace.pts,
      trains: this.chartTrains,
      bands: this.bands,
      stations: this.chartStations,
      deadline: this.run.contract.deadline,
      projection: this.projection,
      conflict: this.conflict,
      meets: this.meets,
      font: this.font,
    });
    this.chartDirty = false;
  }

  // -------------------------------------------------------------------------------------------
  // Commands

  /** The cab's lever canvases: a press, a drag, a release. Returns false to refuse the press. */
  private onLeverPointer(kind: LeverKind, value: number, phase: 'down' | 'move' | 'up', now: number): boolean {
    const lv = this.levers[kind];
    if (phase === 'down') {
      if (!this.controlsLive()) {
        this.refuseLocally(kind, now);
        return false;
      }
      lv.dragging = true;
      lv.gate.reset();
      // Grabbing the handle where it already is sends nothing.
      if (value !== this.leverValue(kind, now)) this.setLever(kind, value, now);
      else lv.local = { value, until: Infinity };
      return true;
    }
    if (phase === 'move') {
      if (lv.dragging) this.setLever(kind, value, now);
      return true;
    }
    lv.dragging = false;
    if (lv.local) lv.local.until = now + LEVER_HOLD_MS;
    return true;
  }

  private setLever(kind: LeverKind, value: number, now: number): void {
    const lv = this.levers[kind];
    lv.local = { value, until: lv.dragging ? Infinity : now + LEVER_HOLD_MS };
    const send = lv.gate.offer(value, now);
    if (send !== null) this.opts.onCmd({ kind, value: send });
    this.schedulePoll(now);
  }

  /** Sends lever values the 50 ms gate held back, once they're due. */
  private pollLevers(now: number): void {
    for (const kind of ['throttle', 'brake'] as const) {
      const v = this.levers[kind].gate.poll(now);
      if (v !== null) this.opts.onCmd({ kind, value: v });
    }
  }

  /** The final value of a drag must go out even if animation frames stop (a hidden tab). */
  private schedulePoll(now: number): void {
    const due = Math.min(this.levers.throttle.gate.dueAt() ?? Infinity, this.levers.brake.gate.dueAt() ?? Infinity);
    if (!Number.isFinite(due)) return;
    window.clearTimeout(this.pollTimer);
    this.pollTimer = window.setTimeout(
      () => {
        const t = performance.now();
        this.pollLevers(t);
        this.schedulePoll(t);
      },
      Math.max(0, due - now) + 1,
    );
  }

  private releaseLevers(now: number): void {
    this.cab.release();
    for (const kind of ['throttle', 'brake'] as const) {
      const lv = this.levers[kind];
      lv.dragging = false;
      if (lv.local) lv.local.until = now;
    }
  }

  private stepLever(kind: LeverKind, dir: 1 | -1, now: number): void {
    if (!this.controlsLive()) return this.refuseLocally(kind, now);
    const cur = this.leverValue(kind, now);
    const next = kind === 'throttle' ? stepThrottle(cur, dir) : brakeStep(cur, dir);
    if (next === cur) return;
    this.levers[kind].gate.reset();
    this.setLever(kind, next, now);
  }

  /** A control tried with a gun in the cab: the banner shakes and the outlaw jabs his gun. */
  private refuseHeldUp(): void {
    this.cab.shakeHandsUp();
    this.outlaw.jab();
  }

  /** A dead control tried with a gun in the cab: the lever flashes and the banner shakes. */
  private refuseLocally(kind: LeverKind, now: number): void {
    if (!this.enabled || !this.view?.train.heldUp) return;
    this.cab.flashLever(kind, now);
    this.refuseHeldUp();
  }

  private sendDiscrete(body: EngineerCmdBody, now: number): void {
    this.lastCmd = { body, at: now };
    this.opts.onCmd(body);
  }

  private throwSwitch(id: string, now: number): void {
    if (!this.enabled) return;
    const v = this.view;
    if (!v || !this.controlsLive()) {
      if (v?.train.heldUp) {
        this.flashes.push({ junction: id, kind: 'refused', at: now });
        this.refuseHeldUp();
        this.mapDirty = true;
      }
      return;
    }
    // The desk can see a train on the points (spec §5.2): refuse at once rather than round-trip.
    const fouled = fouls(this.ix, v.train.spans, id, SWITCH_FOUL_DISTANCE) || v.trains.some((t) => fouls(this.ix, t.spans, id, SWITCH_FOUL_DISTANCE));
    if (fouled) {
      this.flashes.push({ junction: id, kind: 'refused', at: now });
      this.log(`${this.switchLabel(id)} won't move: a train is on the points`, 'warn', `fouled:${id}`);
      this.mapDirty = true;
      return;
    }
    const next: SwitchState = this.displaySwitches()[id] === 'reverse' ? 'normal' : 'reverse';
    this.pendingSwitch.set(id, { state: next, at: now });
    this.sendDiscrete({ kind: 'switch', junction: id, state: next }, now);
    // The lit route and the Ahead list follow the throw at once.
    this.derive(v, now);
    this.aheadPanel.update(v, this.ahead, this.reversing);
    this.mapDirty = true;
  }

  private setReverser(value: -1 | 0 | 1, now: number): void {
    const v = this.view;
    if (!v || !this.controlsLive()) {
      if (v?.train.heldUp) this.refuseHeldUp();
      return;
    }
    const cur = this.pendingReverser?.value ?? v.train.reverser;
    if (value === cur) return;
    if (Math.abs(v.train.v) >= REVERSER_MAX_SPEED) {
      this.cab.flash('reverser');
      this.log('Stop the train before moving the reverser', 'warn', 'reverser');
      return;
    }
    this.pendingReverser = { value, at: now };
    this.sendDiscrete({ kind: 'reverser', value }, now);
    this.cab.update(this.cabLook(now));
  }

  private setFire(value: number, now: number): void {
    const v = this.view;
    if (!v || !this.controlsLive()) {
      if (v?.train.heldUp) this.refuseHeldUp();
      return;
    }
    if (this.autoFire) {
      this.cab.flash('auto');
      return;
    }
    const next = Math.max(0, Math.min(FIRE_MAX, value));
    if (next === (this.pendingFire?.value ?? v.train.fire)) return;
    this.pendingFire = { value: next, at: now };
    this.sendDiscrete({ kind: 'fire', value: next }, now);
    this.cab.update(this.cabLook(now));
  }

  /** The whistle sounds while the H key or the button is held (and works with a gun on you). */
  private syncWhistle(): void {
    const v = this.view;
    const on = (this.whistleKey || this.whistlePointer) && this.enabled && !!v && v.phase === 'running';
    if (on === this.whistleSent) return;
    this.whistleSent = on;
    this.opts.onCmd({ kind: 'whistle', on });
    this.cab.update(this.cabLook(performance.now()));
  }

  // -------------------------------------------------------------------------------------------
  // Input

  private bindInput(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    // Buttons never take focus: Space and the arrows belong to the levers, not to a focused button.
    this.el.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) e.preventDefault();
    });

    const mc = this.dom.mapCanvas.canvas;
    const switchAt = (e: PointerEvent | MouseEvent): string | null => {
      const r = mc.getBoundingClientRect();
      return this.map.switchAt(e.clientX - r.left, e.clientY - r.top);
    };
    mc.addEventListener('pointermove', (e) => {
      const id = switchAt(e);
      if (id === this.hoverSwitch) return;
      this.hoverSwitch = id;
      setClass(mc, 'dk-over-switch', id !== null && this.enabled);
      this.mapDirty = true;
    });
    mc.addEventListener('pointerleave', () => {
      if (this.hoverSwitch === null) return;
      this.hoverSwitch = null;
      setClass(mc, 'dk-over-switch', false);
      this.mapDirty = true;
    });
    mc.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const id = switchAt(e);
      if (id) this.throwSwitch(id, performance.now());
    });
    mc.addEventListener('dblclick', (e) => {
      if (!switchAt(e)) this.setFollow(!this.follow);
    });
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.dead || !this.enabled || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.code;
    const now = performance.now();
    const full = this.opts.keyboard === 'full';
    // The desk's keys (spec §11). In local test mode the Rider has the rest of the keyboard,
    // Esc included: the Rider's keys pause the game there.
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code);
    if (digit) {
      e.preventDefault();
      const id = this.byNumber.get(Number(digit[1]));
      if (id && !e.repeat) this.throwSwitch(id, now);
      return;
    }
    switch (code) {
      case 'ArrowUp':
      case 'ArrowDown':
        e.preventDefault();
        this.stepLever('throttle', code === 'ArrowUp' ? 1 : -1, now);
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        e.preventDefault();
        this.stepLever('brake', code === 'ArrowRight' ? 1 : -1, now);
        return;
      case 'KeyH':
        e.preventDefault();
        if (!e.repeat) {
          this.whistleKey = true;
          this.syncWhistle();
        }
        return;
      case 'Tab':
        e.preventDefault();
        if (!e.repeat) this.setRulebook(!this.rulebook.open);
        return;
    }
    if (!full) return;
    switch (code) {
      case 'Escape':
        e.preventDefault();
        if (!e.repeat) this.opts.onPause();
        return;
      case 'Space':
        e.preventDefault();
        if (!this.controlsLive()) return this.refuseLocally('brake', now);
        this.levers.brake.gate.reset();
        this.setLever('brake', 1, now);
        return;
      case 'KeyF':
      case 'KeyV':
        e.preventDefault();
        if (!e.repeat) this.setFire((this.pendingFire?.value ?? this.view?.train.fire ?? 0) + (code === 'KeyF' ? 1 : -1), now);
        return;
      case 'KeyX': {
        e.preventDefault();
        const cur = this.pendingReverser?.value ?? this.view?.train.reverser ?? 0;
        if (!e.repeat) this.setReverser(cur === 1 ? 0 : cur === 0 ? -1 : 1, now);
        return;
      }
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (this.dead) return;
    if (e.code === 'KeyH' && this.whistleKey) {
      this.whistleKey = false;
      this.syncWhistle();
    }
    // Space released over a focused button would click it.
    if (e.code === 'Space' && this.opts.keyboard === 'full' && this.enabled && !isTyping(e)) e.preventDefault();
  };

  private readonly onBlur = (): void => {
    // Keys released while the window was away never arrive: let go of the whistle.
    if (!this.whistleKey) return;
    this.whistleKey = false;
    this.syncWhistle();
  };
}
