// A canvas whose backing store tracks its CSS size × devicePixelRatio, so drawing stays sharp.

export class HiDpiCanvas {
  readonly ctx: CanvasRenderingContext2D;
  width = 0; // CSS px
  height = 0; // CSS px
  dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.fit();
  }

  /** Matches the backing store to the element's CSS size. Returns true if anything changed. */
  fit(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.width && h === this.height && dpr === this.dpr) return false;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    return true;
  }

  /** Fits, then resets the transform so drawing is in CSS pixels. */
  begin(): CanvasRenderingContext2D {
    this.fit();
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    return ctx;
  }
}
