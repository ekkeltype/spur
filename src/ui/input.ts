// The Rider's keyboard and mouse (spec §6.2) → one RiderInput per tick.
//
// Held keys and buttons are always tracked, so a key held through the countdown works at once; but
// one-shot presses (jump, E, R, weapons, a click) made while paused or counting down are dropped,
// not fired on resume (as in Clew). When A and D are both held, the one pressed last wins.
// Aim is worked out at tick time from the last pointer position, so it follows the camera.
//
// The raw handlers (keyDown, mouseDown…) hold all the logic and don't touch the DOM: attach() wires
// them to the window and the canvas, and tests call them directly.

import { RIDER_SHOULDER, RIDER_SHOULDER_CROUCH } from '../sim/rules';
import type { RiderInput, Weapon } from '../sim/types';

export interface RiderControlsHandlers {
  onPause: () => void;
  /** Dev builds: ] [ G K N (spec §19). */
  onDebugKey?: (code: string) => void;
  /** Any key or click (unlocks audio). */
  onAnyInput?: () => void;
  /** One-shot presses count only while this is true: the game is running. */
  enabled?: () => boolean;
  /** Esc and the debug keys work while this is true: on the play screen, running, paused or counting down. */
  pausable?: () => boolean;
}

/** What aiming needs at tick time. */
export interface AimContext {
  /** The Rider's feet (train frame, metres) and stance. */
  rider: { x: number; y: number; crouch: boolean };
  /** Canvas CSS px → train-frame metres (RiderRenderer.toTrainFrame). */
  toTrainFrame(px: number, py: number): { x: number; y: number };
  /** The canvas's CSS width, for the spyglass distance. */
  width: number;
}

const WEAPON_KEYS: Record<string, Weapon> = { Digit1: 'revolver', Digit2: 'shotgun', Digit3: 'rifle' };
const MOVE_KEYS: Record<string, -1 | 1> = { KeyA: -1, KeyD: 1 };
const GAME_KEYS = new Set(['KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyE', 'KeyR', 'KeyQ', 'Space', 'ShiftLeft', 'ShiftRight', 'Digit1', 'Digit2', 'Digit3']);
export const DEBUG_KEYS = new Set(['BracketRight', 'BracketLeft', 'KeyG', 'KeyK', 'KeyN']);

/** Mouse buttons (MouseEvent.button). */
const LEFT = 0;
const RIGHT = 2;

function isTyping(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  if (!t || typeof t.tagName !== 'string') return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true;
}

export class RiderControls {
  /** Held key code → press order. */
  private held = new Map<string, number>();
  private order = 0;
  private left = false;
  private right = false;
  private pointer: { x: number; y: number } | null = null;
  private aim = 0;
  private jumpPressed = false;
  private downPressed = false;
  private interactPressed = false;
  private reloadPressed = false;
  private firePressed = false;
  private flagPressed = false;
  private weaponPressed: Weapon | 'next' | null = null;
  private canvas: HTMLElement | null = null;

  constructor(private handlers: RiderControlsHandlers) {}

  private get live(): boolean {
    return this.handlers.enabled ? this.handlers.enabled() : true;
  }

  private get pausable(): boolean {
    return this.handlers.pausable ? this.handlers.pausable() : true;
  }

  /** The spyglass is up: Shift or the right button held. */
  get scoped(): boolean {
    return this.right || this.held.has('ShiftLeft') || this.held.has('ShiftRight');
  }

  // ---------------------------------------------------------------------------
  // Raw input
  // ---------------------------------------------------------------------------

  /** A key went down. Returns true when the browser's default should be prevented (e.g. Space scrolling). */
  keyDown(code: string, repeat = false): boolean {
    this.handlers.onAnyInput?.();
    const pausable = this.pausable;
    if (code === 'Escape') {
      if (!pausable) return false;
      if (!repeat) this.handlers.onPause();
      return true;
    }
    if (import.meta.env.DEV && DEBUG_KEYS.has(code)) {
      if (pausable && !repeat) this.handlers.onDebugKey?.(code);
      return pausable;
    }
    if (!GAME_KEYS.has(code)) return false;
    if (repeat) return pausable;
    this.held.set(code, ++this.order);
    if (!this.live) return pausable;
    if (code === 'KeyW' || code === 'Space') this.jumpPressed = true;
    if (code === 'KeyS') this.downPressed = true;
    if (code === 'KeyE') this.interactPressed = true;
    if (code === 'KeyR') this.reloadPressed = true;
    if (code === 'KeyQ') this.weaponPressed = 'next';
    if (code in WEAPON_KEYS) this.weaponPressed = WEAPON_KEYS[code];
    return pausable;
  }

  keyUp(code: string): void {
    this.held.delete(code);
  }

  /** The pointer moved to (x, y), CSS px relative to the canvas. */
  pointerMove(x: number, y: number): void {
    this.pointer = { x, y };
  }

  mouseDown(button: number, x: number, y: number): void {
    this.handlers.onAnyInput?.();
    this.pointer = { x, y };
    if (button === RIGHT) this.right = true;
    if (button !== LEFT) return;
    this.left = true;
    if (!this.live) return;
    // While scoped a click plants a flag instead of firing (spec §6.5).
    if (this.scoped) this.flagPressed = true;
    else this.firePressed = true;
  }

  mouseUp(button: number): void {
    if (button === LEFT) this.left = false;
    if (button === RIGHT) this.right = false;
  }

  /** The window lost focus: nothing is held any more. */
  blur(): void {
    this.held.clear();
    this.left = false;
    this.right = false;
  }

  // ---------------------------------------------------------------------------
  // Per tick
  // ---------------------------------------------------------------------------

  /** Resolves one tick's input and consumes the one-shot presses. */
  next(ctx: AimContext | null): RiderInput {
    let moveX: -1 | 0 | 1 = 0;
    let moveOrder = -1;
    for (const [code, order] of this.held) {
      const dir = MOVE_KEYS[code];
      if (dir !== undefined && order > moveOrder) {
        moveX = dir;
        moveOrder = order;
      }
    }
    const scoped = this.scoped;
    let scopeT = 0.5;
    if (ctx && this.pointer) {
      const r = ctx.rider;
      const p = ctx.toTrainFrame(this.pointer.x, this.pointer.y);
      const shoulder = r.y + (r.crouch ? RIDER_SHOULDER_CROUCH : RIDER_SHOULDER);
      const dx = p.x - r.x;
      const dy = p.y - shoulder;
      if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) this.aim = Math.atan2(dy, dx);
      if (ctx.width > 0) scopeT = Math.max(0, Math.min(1, this.pointer.x / ctx.width));
    }
    const input: RiderInput = {
      moveX,
      up: this.held.has('KeyW'),
      down: this.held.has('KeyS'),
      downPressed: this.downPressed,
      jump: this.held.has('KeyW') || this.held.has('Space'),
      jumpPressed: this.jumpPressed,
      interactPressed: this.interactPressed,
      firing: this.left && !scoped,
      firePressed: this.firePressed,
      reloadPressed: this.reloadPressed,
      weaponPressed: this.weaponPressed,
      aim: this.aim,
      scope: scoped,
      scopeT,
      flagPressed: this.flagPressed,
    };
    this.jumpPressed = false;
    this.downPressed = false;
    this.interactPressed = false;
    this.reloadPressed = false;
    this.firePressed = false;
    this.flagPressed = false;
    this.weaponPressed = null;
    return input;
  }

  // ---------------------------------------------------------------------------
  // DOM wiring
  // ---------------------------------------------------------------------------

  /** Keys from the whole window; the mouse from the Rider's canvas (in local test mode the other pane is the Engineer's). */
  attach(canvas: HTMLElement): void {
    this.detach();
    this.canvas = canvas;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mouseup', this.onMouseUp);
    if (this.canvas) {
      this.canvas.removeEventListener('mousemove', this.onMouseMove);
      this.canvas.removeEventListener('mousedown', this.onMouseDown);
      this.canvas.removeEventListener('contextmenu', this.onContextMenu);
      this.canvas = null;
    }
    this.blur();
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: e.clientX, y: e.clientY };
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping(e.target)) return;
    if (this.keyDown(e.code, e.repeat)) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keyUp(e.code);
  };

  private onBlur = (): void => {
    this.blur();
  };

  private onMouseMove = (e: MouseEvent): void => {
    const p = this.local(e);
    this.pointerMove(p.x, p.y);
  };

  private onMouseDown = (e: MouseEvent): void => {
    const p = this.local(e);
    e.preventDefault(); // no text selection or focus change while shooting
    this.mouseDown(e.button, p.x, p.y);
  };

  private onMouseUp = (e: MouseEvent): void => {
    this.mouseUp(e.button);
  };

  private onContextMenu = (e: Event): void => {
    e.preventDefault(); // the right button is the spyglass
  };
}
