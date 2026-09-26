// Toasts and one-time contextual hints (spec §18).

import type { Settings } from '../sim/types';
import { h } from './dom';

export type Tone = 'info' | 'danger' | 'good';

export class Toaster {
  readonly el: HTMLElement;

  constructor() {
    this.el = h('div', { class: 'toasts' });
  }

  show(text: string, tone: Tone = 'info', ms = 2600): void {
    const t = h('div', { class: `toast ${tone === 'info' ? '' : tone}`, text });
    this.el.append(t);
    while (this.el.children.length > 4) this.el.firstElementChild?.remove();
    window.setTimeout(() => t.classList.add('fade'), ms);
    window.setTimeout(() => t.remove(), ms + 600);
  }
}

/** Contextual hints, each shown once per session while hints are on. */
export class Hints {
  readonly el: HTMLElement;
  private shown = new Set<string>();
  private hideTimer = 0;

  constructor(private enabled: () => boolean) {
    this.el = h('div', { class: 'hint' });
    this.el.hidden = true;
  }

  show(id: string, text: string, ms = 7000): void {
    if (!this.enabled() || this.shown.has(id)) return;
    this.shown.add(id);
    this.el.textContent = text;
    this.el.hidden = false;
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => (this.el.hidden = true), ms);
  }
}

/**
 * Whether hints apply to a run under the current settings. 'first' (the default) means while the
 * run is new to the players, until they've won it: each run brings something new (spec §13), and
 * its hints come with it.
 */
export function hintsOn(settings: Settings, newRun: boolean): boolean {
  if (settings.hints === 'never') return false;
  if (settings.hints === 'always') return true;
  return newRun;
}
