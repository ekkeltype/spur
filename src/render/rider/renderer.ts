// The Rider's side view (spec §18.2). STUB: the API is the contract between the Rider's app
// (ui/host-app.ts) and the renderer; the renderer milestone replaces the body, keeping the API.

import type { GameState, RunDef, SimEvent } from '../../sim/types';

export interface RiderFrame {
  state: GameState;
  run: RunDef;
  /** Fraction of a tick since the last sim step, for interpolation (0..1). */
  alpha: number;
  /** ms, performance.now(). */
  now: number;
  /** Events the sim produced since the last frame (effects: tracers, flashes, dust…). */
  events: SimEvent[];
  settings: { screenShake: boolean; lampLetters: boolean };
  /** A prompt to show near the Rider ("E: lower the spout"), or null. */
  prompt: string | null;
  /** The game is paused or counting down: freeze animation clocks that follow the sim. */
  frozen: boolean;
}

export class RiderRenderer {
  constructor(readonly canvas: HTMLCanvasElement) {}

  draw(f: RiderFrame): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const w = (this.canvas.width = this.canvas.clientWidth);
    const h = (this.canvas.height = this.canvas.clientHeight);
    ctx.fillStyle = '#9CC7E8';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#2A2118';
    ctx.font = '16px sans-serif';
    ctx.fillText(`${f.run.name} · ${(f.state.train.v * 2.23694).toFixed(0)} mph`, 12, 24);
  }

  /** A pointer position (CSS px relative to the canvas) in train-frame metres, for aiming. */
  toTrainFrame(px: number, py: number): { x: number; y: number } {
    return { x: px / 40, y: -py / 40 };
  }

  destroy(): void {}
}
