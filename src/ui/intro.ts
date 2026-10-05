// The run's opening shot, on both seats (spec §3): the locomotive's running gear getting under way, the
// run's title stamped over it, and the engine's own sounds (the safety valve, the bell, the throttle,
// the first beats, the whistle). It plays inside the countdown, before the numbers, when a run leaves its
// origin: the host sends its length with the countdown, and each seat times it from there. The picture
// and the title's movement are src/render/intro.ts, a pure function of the time into the shot.

import { LOOKAHEAD, type Sfx } from '../audio/sfx';
import { INTRO_CUES, INTRO_CRUISE, introSpeed, introThrottle, introTitleLook, IntroRenderer } from '../render/intro';
import { INTRO_SECONDS } from '../sim/rules';
import type { EngineerRun } from '../sim/types';
import { h } from './dom';
import { ACT_NAMES, formatClock } from './text';

/** What the title says and what the shot looks like, for one run. */
export interface IntroInfo {
  kicker: string;
  name: string;
  route: string;
  clock: number;
  night: boolean;
  seed: number;
}

type IntroRun = Pick<EngineerRun, 'act' | 'index' | 'name' | 'origin' | 'contract' | 'stations' | 'startClock' | 'night'>;

export function introInfo(run: IntroRun): IntroInfo {
  const name = (id: string): string => run.stations.find((s) => s.id === id)?.name ?? id;
  return {
    kicker: `${ACT_NAMES[run.act] ?? `Act ${run.act}`} · Run ${run.index + 1}`,
    name: run.name,
    route: `${name(run.origin)} → ${name(run.contract.destination)} · departs ${formatClock(run.startClock)}`,
    clock: run.startClock,
    night: run.night,
    seed: run.index * 7919 + 17,
  };
}

/** One-shots whose moment has passed by more than this (s) are skipped, not played late. */
const LATE = 0.25;

/** The shot's sounds: continuous layers held each frame, one-shots fired as their moments pass. */
export class IntroSounds {
  private lastT = -Infinity;
  private started = false;
  private on = false;

  constructor(private readonly sfx: Sfx) {}

  frame(t: number): void {
    const sfx = this.sfx;
    if (!this.started) {
      // A fresh engine voice, so its beats are counted from the same standstill as the drivers turn from.
      this.started = true;
      sfx.engine(null);
    }
    this.on = true;
    const passed = (at: number): boolean => at > this.lastT && at <= t && t - at <= LATE;
    for (const at of INTRO_CUES.bells) if (passed(at)) sfx.bell();
    if (passed(INTRO_CUES.lever)) sfx.lever();
    sfx.safetyValve(t >= INTRO_CUES.valve[0] && t < INTRO_CUES.valve[1]);
    sfx.whistle(t >= INTRO_CUES.whistle[0] && t < INTRO_CUES.whistle[1], 'rider');
    // The engine queues its beats LOOKAHEAD ahead at the speed it's given, so give it the speed then: the
    // beats land as the drivers reach them.
    sfx.engine(t < INTRO_CUES.engineOff ? { speed: introSpeed(t + LOOKAHEAD), throttle: introThrottle(t), tunnel: false, listener: 'rider' } : null);
    sfx.wind(t < INTRO_CUES.engineOff ? 0.25 * (introSpeed(t) / INTRO_CRUISE) : 0);
    this.lastT = t;
  }

  stop(): void {
    this.lastT = -Infinity;
    this.started = false;
    if (!this.on) return;
    this.on = false;
    const sfx = this.sfx;
    sfx.engine(null);
    sfx.whistle(false, 'rider');
    sfx.safetyValve(false);
    sfx.wind(0);
  }
}

/** The shot over a play screen: shown while the countdown's opening seconds run, hidden otherwise. */
export class IntroOverlay {
  readonly el: HTMLElement;
  private readonly renderer: IntroRenderer;
  private readonly sounds: IntroSounds | null;
  private readonly veil = h('div', { class: 'intro-veil' });
  private readonly barTop = h('div', { class: 'intro-bar top' });
  private readonly barBottom = h('div', { class: 'intro-bar bottom' });
  private readonly kicker: HTMLElement;
  private readonly name: HTMLElement;
  private readonly rule = h('div', { class: 'intro-rule' });
  private readonly route: HTMLElement;
  private showing = false;

  constructor(
    private readonly info: IntroInfo,
    sfx: Sfx | null,
  ) {
    const canvas = h('canvas', { class: 'intro-canvas' });
    this.kicker = h('div', { class: 'intro-kicker', text: info.kicker });
    this.name = h('h1', { class: 'intro-name display', text: info.name });
    this.route = h('div', { class: 'intro-route', text: info.route });
    this.el = h(
      'div',
      { class: 'intro', attrs: { 'aria-live': 'polite' } },
      canvas,
      this.barTop,
      this.barBottom,
      h('div', { class: 'intro-title' }, this.kicker, this.name, this.rule, this.route),
      this.veil,
    );
    this.el.hidden = true;
    this.renderer = new IntroRenderer(canvas);
    this.sounds = sfx ? new IntroSounds(sfx) : null;
  }

  /**
   * Draws the shot if it's playing: `endMs` is when it ends (the countdown's numbers start), or null when
   * there's no countdown. Returns true while it plays, when the seat's own game sounds should wait.
   */
  frame(now: number, endMs: number | null, motion: boolean): boolean {
    const left = endMs === null ? 0 : (endMs - now) / 1000;
    const playing = left > 0 && left <= INTRO_SECONDS;
    if (playing !== this.showing) {
      this.showing = playing;
      this.el.hidden = !playing;
      if (!playing) this.sounds?.stop();
    }
    if (!playing) return false;
    const t = INTRO_SECONDS - left;
    this.renderer.draw(t, { clock: this.info.clock, night: this.info.night, motion, seed: this.info.seed });
    const look = introTitleLook(t, motion);
    this.el.style.opacity = String(look.opacity);
    this.veil.style.opacity = String(look.veil);
    this.barTop.style.transform = `scaleY(${look.bars})`;
    this.barBottom.style.transform = `scaleY(${look.bars})`;
    this.kicker.style.opacity = String(look.kicker.opacity);
    this.kicker.style.transform = `translateY(${look.kicker.dy}px)`;
    this.name.style.opacity = String(look.name.opacity);
    this.name.style.transform = `translateY(${look.name.dy}px) scale(${look.name.scale})`;
    this.rule.style.transform = `scaleX(${look.rule})`;
    this.route.style.opacity = String(look.route.opacity);
    this.route.style.transform = `translateY(${look.route.dy}px)`;
    this.sounds?.frame(t);
    return true;
  }

  destroy(): void {
    this.sounds?.stop();
  }
}
