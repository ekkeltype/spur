// The Engineer's desk (spec §11). STUB: the API is the contract between the Engineer's app
// (ui/client-app.ts) and the desk; the desk milestone replaces the body, keeping the API.

import type { DebugInfo } from '../../net/protocol';
import type { EngineerCmdBody, EngineerEvent, EngineerRun, EngineerView } from '../../sim/types';

export interface DeskOptions {
  /** Every command the Engineer issues (levers are throttled by the desk to ≤ 1 per 50 ms). */
  onCmd: (cmd: EngineerCmdBody) => void;
  /** Esc pressed on the desk. */
  onPause: () => void;
  /** 'full' online; 'local' in local test mode, where the Rider has most of the keyboard (spec §11). */
  keyboard: 'full' | 'local';
  /** Letters on signal lamps in the rulebook (settings). */
  lampLetters: boolean;
  /** Engineer assist: conflict advice on the chart; the firebox shows as automatic. */
  assist: boolean;
}

export class EngineerDesk {
  readonly el: HTMLElement;

  constructor(
    readonly run: EngineerRun,
    readonly opts: DeskOptions,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'desk';
    this.el.textContent = `Engineer's desk: ${run.name}`;
  }

  /** A new snapshot (about 15 per second). */
  setView(_view: EngineerView, _now: number): void {}

  /** A filtered event from the host, for the log and panel feedback (sounds are the app's job). */
  onEvent(_e: EngineerEvent, _now: number): void {}

  /** A command the host refused, with its reason. */
  refused(_reason: string, _now: number): void {}

  /** Once per animation frame (ms). */
  frame(_now: number): void {}

  /** Input on or off (off while paused or counting down). */
  setEnabled(_on: boolean): void {}

  /** Dev builds with ?debug=1: hidden information to overlay on the map. */
  setDebug(_info: DebugInfo | null): void {}

  destroy(): void {
    this.el.remove();
  }
}
