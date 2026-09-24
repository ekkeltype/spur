// The cab panel (spec §11): the dials and the water glass, the throttle and brake quadrants, the
// reverser, firebox and whistle, the warning lamps, the precision-stop readout and the HANDS UP
// banner. It owns its DOM, its canvases and the pointer on them; what a touch means (commands,
// refusals, the 50 ms lever gate) is the desk's business, reached through CabInput.

import { FIRE_MAX, LOW_WATER, REVERSER_MAX_SPEED } from '../../sim/rules';
import type { EngineerRun, EngineerView } from '../../sim/types';
import { HiDpiCanvas } from '../canvas';
import { btn, el, kbd, replay, setClass, setText } from './dom';
import { limitMph, toMph } from './format';
import { brakeCaption, brakeSlot, drawBrake, drawSpeedDial, drawSteamDial, drawThrottle, drawWaterGlass, RYE, SANS, throttleSlot } from './gauges';
import { brakeFromFraction, brakeZone, throttleFromFraction, throttleNotch } from './levers';
import { StopPanel } from './panels';

export type LeverKind = 'throttle' | 'brake';

export interface CabInput {
  /** A lever pressed ('down': return false to refuse it), dragged, or let go, at `value`. */
  lever(kind: LeverKind, value: number, phase: 'down' | 'move' | 'up', now: number): boolean;
  reverser(value: -1 | 0 | 1, now: number): void;
  fire(value: number, now: number): void;
  whistle(on: boolean): void;
}

/** What the cab shows: the view plus the desk's optimistic lever and switch positions. */
export interface CabLook {
  view: EngineerView | null;
  throttle: number;
  brake: number;
  reverser: -1 | 0 | 1;
  fire: number;
  whistle: boolean;
  /** The controls take input: not paused, not held up, the run under way. */
  live: boolean;
  enabled: boolean;
  dragging: Record<LeverKind, boolean>;
  font: number;
}

/** Needles ease toward each snapshot (15 Hz) with this time constant (s). */
const NEEDLE_TAU = 0.12;

interface Lever {
  hi: HiDpiCanvas;
  hover: boolean;
  pointer: number | null;
  flashUntil: number;
}

export class CabPanel {
  readonly el: HTMLElement;
  readonly stop: StopPanel;

  private readonly gauges: HiDpiCanvas;
  private readonly levers: Record<LeverKind, Lever>;
  private readonly throttleVal: HTMLElement;
  private readonly brakeVal: HTMLElement;
  private readonly reverser: HTMLButtonElement[];
  private readonly reverserRow: HTMLElement;
  private readonly fire: HTMLButtonElement[];
  private readonly fireRow: HTMLElement;
  private readonly fireAuto: HTMLElement;
  private readonly whistleBtn: HTMLButtonElement;
  private readonly lamps: { water: HTMLElement; speed: HTMLElement; valve: HTMLElement; dry: HTMLElement };
  private readonly handsup: HTMLElement;
  private readonly disp = { mph: 0, psi: 0, water: 0 };
  private gaugeKey = '';
  private leverKey = '';
  private whistlePointer = false;
  /** The desk's font size at the last draw: the quadrants' geometry depends on it. */
  private font = 14;

  constructor(
    run: EngineerRun,
    private readonly opts: { keyboard: 'full' | 'local'; autoFire: boolean; governor: boolean },
    private readonly input: CabInput,
  ) {
    const local = opts.keyboard === 'local';
    this.el = el('section', 'desk-panel desk-cab');
    const head = el('div', 'desk-panel-head');
    head.append(el('h2', undefined, 'Cab'));
    const body = el('div', 'cab-body');

    const gaugeBox = el('div', 'cab-gauges');
    const gaugeCanvas = el('canvas');
    gaugeCanvas.setAttribute('role', 'img');
    gaugeCanvas.setAttribute('aria-label', 'Speed, steam and water');
    gaugeBox.append(gaugeCanvas);
    this.gauges = new HiDpiCanvas(gaugeCanvas);

    const mkLever = (): Lever => ({ hi: new HiDpiCanvas(el('canvas')), hover: false, pointer: null, flashUntil: 0 });
    this.levers = { throttle: mkLever(), brake: mkLever() };
    const controls = el('div', 'cab-controls');

    // The throttle: a tall quadrant on the left (↑/↓ move it a notch).
    const throttle = el('div', 'lever lever-throttle');
    const tCanvas = this.levers.throttle.hi.canvas;
    tCanvas.setAttribute('role', 'slider');
    tCanvas.setAttribute('aria-label', 'Throttle');
    tCanvas.setAttribute('aria-valuemin', '0');
    tCanvas.setAttribute('aria-valuemax', '8');
    // Canvases sit in sized boxes: a canvas's own backing store must never size the layout.
    const tBox = el('div', 'q');
    tBox.append(tCanvas);
    this.throttleVal = el('div', 'notch', 'Shut');
    const tKeys = el('div', 'lever-cap keys');
    tKeys.innerHTML = `${kbd('↑')}${kbd('↓')}`;
    throttle.append(el('div', 'lever-cap', 'Throttle'), tBox, this.throttleVal, tKeys);

    // The brake: release … service … emergency, left to right (←/→, Space throws it all the way).
    const brake = el('div', 'lever lever-brake');
    const bCap = el('div', 'lever-cap');
    bCap.innerHTML = `Brake ${kbd('←')}${kbd('→')}${local ? '' : ` ${kbd('Space')}`}`;
    this.brakeVal = el('span', 'val', 'Released');
    bCap.append(this.brakeVal);
    const bCanvas = this.levers.brake.hi.canvas;
    bCanvas.setAttribute('role', 'slider');
    bCanvas.setAttribute('aria-label', 'Brake');
    const bBox = el('div', 'q');
    bBox.append(bCanvas);
    brake.append(bCap, bBox);

    this.reverserRow = el('div', 'ctl-row ctl-reverser');
    const rLabel = el('span', 'ctl-label');
    rLabel.innerHTML = `Reverser${local ? '' : ` ${kbd('X')}`}`;
    const rSeg = el('div', 'desk-seg');
    this.reverser = (
      [
        [1, 'F', 'Forward'],
        [0, 'N', 'Neutral'],
        [-1, 'R', 'Reverse'],
      ] as const
    ).map(([v, t, title]) => btn('desk-btn', t, () => this.input.reverser(v, performance.now()), `${title} (only when stopped)`));
    rSeg.append(...this.reverser);
    this.reverserRow.append(rLabel, rSeg);

    this.fireRow = el('div', 'ctl-row ctl-fire');
    const fLabel = el('span', 'ctl-label');
    fLabel.innerHTML = `Firebox${local ? '' : ` ${kbd('F')}${kbd('V')}`}`;
    const fSeg = el('div', 'desk-seg');
    this.fire = Array.from({ length: FIRE_MAX + 1 }, (_, v) => btn('desk-btn', String(v), () => this.input.fire(v, performance.now()), `Firebox ${v}`));
    fSeg.append(...this.fire);
    this.fireAuto = el('span', 'auto', 'AUTO');
    this.fireAuto.title = opts.governor ? 'The governor keeps the steam up' : 'Engineer assist: the firebox runs itself';
    this.fireAuto.hidden = !opts.autoFire;
    setClass(this.fireRow, 'auto-on', opts.autoFire);
    this.fireRow.append(fLabel, fSeg, this.fireAuto);

    this.whistleBtn = btn('desk-btn whistle', `Whistle ${kbd('H')}`, () => undefined);
    this.bindWhistle();

    this.handsup = el('div', 'handsup');
    this.handsup.innerHTML = '<b>HANDS UP!</b><span>A bandit has a gun on you. Only the whistle works until the Rider clears the cab.</span>';
    this.handsup.hidden = true;
    controls.append(throttle, brake, this.reverserRow, this.fireRow, this.whistleBtn, this.handsup);

    // Warning lamps: always labelled, lit when they apply.
    const annun = el('div', 'cab-annun');
    const lamp = (text: string): HTMLElement => {
      const l = el('div', 'lamp', text);
      annun.append(l);
      return l;
    };
    this.lamps = { water: lamp('Low water'), speed: lamp('Overspeed'), valve: lamp('Safety valve'), dry: lamp('Dry boiler') };
    this.stop = new StopPanel(run);
    const status = el('div', 'cab-status');
    status.append(annun, this.stop.el);

    body.append(gaugeBox, controls, status);
    this.el.append(head, body);
    this.bindLever('throttle');
    this.bindLever('brake');
  }

  // -------------------------------------------------------------------------------------------
  // Per snapshot: the buttons, the lamps and the banner

  update(look: CabLook): void {
    const v = look.view;
    const held = !!v?.train.heldUp;
    setClass(this.el, 'held', held);
    this.handsup.hidden = !held;
    const stopped = !!v && Math.abs(v.train.v) < REVERSER_MAX_SPEED;
    const revVals = [1, 0, -1];
    this.reverser.forEach((b, i) => {
      setClass(b, 'on', revVals[i] === look.reverser);
      b.disabled = !look.live || (!stopped && revVals[i] !== look.reverser);
    });
    this.reverserRow.title = stopped ? '' : 'Stop the train to move the reverser';
    this.fire.forEach((b, i) => {
      setClass(b, 'on', Math.round(look.fire) === i);
      b.disabled = !look.live || this.opts.autoFire;
    });
    this.whistleBtn.disabled = !look.enabled || !v || v.phase !== 'running';
    setClass(this.whistleBtn, 'on', look.whistle);
    if (v) this.updateLamps(v);
  }

  private updateLamps(view: EngineerView): void {
    const t = view.train;
    const L = this.lamps;
    const dry = t.water <= 0 && t.fire > 0;
    L.water.className = `lamp${!dry && t.water < LOW_WATER ? ' lit-yellow' : ''}`;
    L.dry.className = `lamp${dry ? ' lit-red' : ''}`;
    L.valve.className = `lamp${t.safetyValve ? ' lit-steam' : ''}`;
    setText(L.speed, t.overspeed === 2 ? 'Derail!' : 'Overspeed');
    L.speed.className = `lamp${t.overspeed === 2 ? ' lit-red' : t.overspeed === 1 ? ' lit-yellow' : ''}`;
  }

  // -------------------------------------------------------------------------------------------
  // Per frame: the dials and the levers

  draw(look: CabLook, now: number, dt: number): void {
    this.font = look.font;
    this.drawGauges(look, now, dt);
    this.drawLevers(look, now);
  }

  /** Forget what was drawn (a resize, fonts arriving). */
  invalidate(): void {
    this.gaugeKey = '';
    this.leverKey = '';
  }

  private drawGauges(look: CabLook, now: number, dt: number): void {
    const t = look.view?.train;
    const f = look.font;
    // Snapshots come at 15 Hz: ease the needles between them (DECISIONS.md).
    const a = dt > 0 ? 1 - Math.exp(-dt / NEEDLE_TAU) : 1;
    this.disp.mph += ((t ? Math.abs(toMph(t.v)) : 0) - this.disp.mph) * a;
    this.disp.psi += ((t?.pressure ?? 0) - this.disp.psi) * a;
    this.disp.water += ((t?.water ?? 0) - this.disp.water) * a;
    const animating = !!t && (t.overspeed === 2 || t.water < LOW_WATER || t.safetyValve || t.spout === 'down');
    const key = `${this.disp.mph.toFixed(2)}|${this.disp.psi.toFixed(1)}|${this.disp.water.toFixed(2)}|${t?.limit}|${t?.overspeed}|${t?.waterCap}|${f}`;
    if (key === this.gaugeKey && !animating) return;
    this.gaugeKey = key;
    const hi = this.gauges;
    const c = hi.begin();
    const W = hi.width;
    const H = hi.height;
    c.clearRect(0, 0, W, H);
    // The speed dial, the steam dial and the water glass side by side, as big as the box allows.
    const pad = Math.max(4, f * 0.3);
    const r1 = Math.max(10, Math.min((H - pad * 2) / 2, (W - pad * 2) / 4.42));
    const r2 = r1 * 0.8;
    const wg = r1 * 0.36;
    const gap = r1 * 0.2;
    const x0 = (W - (r1 * 2 + gap + r2 * 2 + gap + wg)) / 2;
    const cy = H / 2;
    const time = now / 1000;
    const limit = t && Number.isFinite(t.limit) && t.limit > 0 ? limitMph(t.limit) : null;
    drawSpeedDial(c, x0 + r1, cy, r1, { mph: this.disp.mph, limitMph: limit, overspeed: t?.overspeed ?? 0, time });
    if (limit !== null) limitPlate(c, x0 + r1, cy + r1 * 0.8, r1, limit, (t?.overspeed ?? 0) > 0);
    drawSteamDial(c, x0 + r1 * 2 + gap + r2, cy + (r1 - r2) * 0.35, r2, { psi: this.disp.psi, safetyValve: !!t?.safetyValve, time });
    // The glass, with room for its name above and its reading below.
    const gh = Math.min(H - pad * 2 - f * 2.2, r1 * 2);
    const gx = x0 + r1 * 2 + gap + r2 * 2 + gap;
    const gy = Math.max(pad + f * 0.9, cy - gh / 2 - f * 0.35);
    drawWaterGlass(c, gx, gy, wg, gh, { water: this.disp.water, cap: t?.waterCap ?? 100, idle: !t, dry: !!t && t.water <= 0 && t.fire > 0, filling: t?.spout === 'down', time });
    c.textAlign = 'center';
    c.fillStyle = t && t.water < LOW_WATER ? '#FF8A70' : 'rgba(239,230,210,0.75)';
    const reading = t ? String(Math.round(this.disp.water)) : '—';
    c.font = `${Math.round(f * 0.95)}px ${RYE}`;
    c.textBaseline = 'top';
    c.fillText(reading, gx + wg / 2, gy + gh + f * 0.2);
    c.fillStyle = 'rgba(239,230,210,0.4)';
    c.font = `700 ${Math.round(f * 0.62)}px ${SANS}`;
    c.textBaseline = 'bottom';
    c.fillText('WATER', gx + wg / 2, gy - f * 0.15);
  }

  private drawLevers(look: CabLook, now: number): void {
    const T = this.levers.throttle;
    const B = this.levers.brake;
    const key = [look.throttle, look.brake, look.live, T.hover, B.hover, look.dragging.throttle, look.dragging.brake, now < T.flashUntil, now < B.flashUntil, look.font].join('|');
    if (key === this.leverKey) return;
    this.leverKey = key;
    const tc = T.hi.begin();
    tc.clearRect(0, 0, T.hi.width, T.hi.height);
    drawThrottle(tc, T.hi.width, T.hi.height, look.throttle, { enabled: look.live, hover: T.hover, dragging: look.dragging.throttle, flash: now < T.flashUntil ? 1 : 0, font: look.font });
    const bc = B.hi.begin();
    bc.clearRect(0, 0, B.hi.width, B.hi.height);
    drawBrake(bc, B.hi.width, B.hi.height, look.brake, { enabled: look.live, hover: B.hover, dragging: look.dragging.brake, flash: now < B.flashUntil ? 1 : 0, font: look.font });
    const notch = throttleNotch(look.throttle);
    setText(this.throttleVal, notch === 0 ? 'Shut' : `Notch ${notch}`);
    setText(this.brakeVal, brakeCaption(look.brake));
    setClass(this.brakeVal, 'emerg', brakeZone(look.brake) === 'emergency');
    T.hi.canvas.setAttribute('aria-valuenow', String(notch));
    B.hi.canvas.setAttribute('aria-valuenow', String(Math.round(look.brake * 100)));
    B.hi.canvas.setAttribute('aria-valuetext', brakeCaption(look.brake));
  }

  // -------------------------------------------------------------------------------------------
  // Feedback

  /** A lever the host refused, or one touched while it's dead: its handle flashes red. */
  flashLever(kind: LeverKind, now: number): void {
    this.levers[kind].flashUntil = now + 450;
    this.leverKey = '';
  }

  flash(what: 'reverser' | 'fire' | 'whistle' | 'auto' | 'cab'): void {
    const node = what === 'reverser' ? this.reverserRow : what === 'fire' ? this.fireRow : what === 'whistle' ? this.whistleBtn : what === 'auto' ? this.fireAuto : this.el;
    replay(node, 'flash-refused');
  }

  /** A dead control was tried with a gun in the cab: the banner says why. */
  shakeHandsUp(): void {
    if (!this.handsup.hidden) replay(this.handsup, 'shake');
  }

  /** Lets go of any lever being dragged (paused, or a gun came out). */
  release(): void {
    for (const kind of ['throttle', 'brake'] as const) {
      const lv = this.levers[kind];
      if (lv.pointer !== null && lv.hi.canvas.hasPointerCapture(lv.pointer)) lv.hi.canvas.releasePointerCapture(lv.pointer);
      lv.pointer = null;
    }
    if (this.whistlePointer) {
      this.whistlePointer = false;
      this.input.whistle(false);
    }
    this.leverKey = '';
  }

  // -------------------------------------------------------------------------------------------
  // Pointer input

  private bindLever(kind: LeverKind): void {
    const lv = this.levers[kind];
    const canvas = lv.hi.canvas;
    const valueAt = (e: PointerEvent): number => {
      const r = canvas.getBoundingClientRect();
      const font = this.font;
      if (kind === 'throttle') {
        const s = throttleSlot(r.width, r.height, font);
        return throttleFromFraction((s.y0 - (e.clientY - r.top)) / Math.max(1, s.y0 - s.y1));
      }
      const s = brakeSlot(r.width, r.height, font);
      return brakeFromFraction((e.clientX - r.left - s.x0) / Math.max(1, s.x1 - s.x0));
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (!this.input.lever(kind, valueAt(e), 'down', performance.now())) return;
      canvas.setPointerCapture(e.pointerId);
      lv.pointer = e.pointerId;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!lv.hover) {
        lv.hover = true;
        this.leverKey = '';
      }
      if (lv.pointer === e.pointerId) this.input.lever(kind, valueAt(e), 'move', performance.now());
    });
    const end = (e: PointerEvent): void => {
      if (lv.pointer !== e.pointerId) return;
      lv.pointer = null;
      this.input.lever(kind, NaN, 'up', performance.now());
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('lostpointercapture', end);
    canvas.addEventListener('pointerleave', () => {
      lv.hover = false;
      this.leverKey = '';
    });
  }

  private bindWhistle(): void {
    const w = this.whistleBtn;
    w.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || w.disabled) return;
      w.setPointerCapture(e.pointerId);
      this.whistlePointer = true;
      this.input.whistle(true);
    });
    const up = (): void => {
      if (!this.whistlePointer) return;
      this.whistlePointer = false;
      this.input.whistle(false);
    };
    w.addEventListener('pointerup', up);
    w.addEventListener('pointercancel', up);
    w.addEventListener('lostpointercapture', up);
  }
}

/** The limit at the loco, on a plate in the speed dial's bottom gap (red when over it). */
function limitPlate(c: CanvasRenderingContext2D, x: number, y: number, r: number, mph: number, warn: boolean): void {
  const text = `LIMIT ${mph}`;
  c.font = `700 ${Math.max(8, Math.round(r * 0.1))}px ${SANS}`;
  const w = c.measureText(text).width + r * 0.12;
  const h = r * 0.15;
  c.beginPath();
  c.roundRect(x - w / 2, y - h / 2, w, h, h * 0.25);
  c.fillStyle = warn ? '#E0442E' : '#2A2118';
  c.fill();
  c.fillStyle = warn ? '#FFF3EE' : '#F2D493';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, x, y + 0.5);
}
