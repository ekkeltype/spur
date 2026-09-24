// The Rider's controls (spec §6.2): keys and buttons → RiderInput, one tick at a time.

import { describe, expect, it } from 'vitest';
import { RIDER_SHOULDER, RIDER_SHOULDER_CROUCH } from '../src/sim/rules';
import { NO_INPUT } from '../src/sim/types';
import { RiderControls, type AimContext } from '../src/ui/input';

function controls(running = true) {
  const state = { running, pauses: 0, debug: [] as string[], any: 0 };
  const c = new RiderControls({
    onPause: () => state.pauses++,
    onDebugKey: (code) => state.debug.push(code),
    onAnyInput: () => state.any++,
    enabled: () => state.running,
    pausable: () => true,
  });
  return { c, state };
}

/** 1 px = 0.1 m, the Rider's feet at the origin, y up; the canvas is 800 px wide. */
const ctx = (crouch = false): AimContext => ({
  rider: { x: 0, y: 0, crouch },
  toTrainFrame: (px, py) => ({ x: px / 10, y: -py / 10 }),
  width: 800,
});

describe('RiderControls', () => {
  it('gives no input when nothing is pressed', () => {
    const { c } = controls();
    expect(c.next(ctx())).toEqual({ ...NO_INPUT, aim: 0, scopeT: 0.5 });
  });

  it('walks with A and D; the key pressed last wins while both are held', () => {
    const { c } = controls();
    c.keyDown('KeyA');
    expect(c.next(null).moveX).toBe(-1);
    c.keyDown('KeyD');
    expect(c.next(null).moveX).toBe(1);
    c.keyUp('KeyD');
    expect(c.next(null).moveX).toBe(-1);
    c.keyUp('KeyA');
    expect(c.next(null).moveX).toBe(0);
  });

  it('W and Space jump (W also climbs); S crouches and climbs down; presses count once', () => {
    const { c } = controls();
    c.keyDown('KeyW');
    let i = c.next(null);
    expect([i.up, i.jump, i.jumpPressed]).toEqual([true, true, true]);
    i = c.next(null);
    expect([i.up, i.jump, i.jumpPressed]).toEqual([true, true, false]);
    c.keyUp('KeyW');
    c.keyDown('Space');
    i = c.next(null);
    expect([i.up, i.jump, i.jumpPressed]).toEqual([false, true, true]);
    c.keyDown('KeyS');
    i = c.next(null);
    expect([i.down, i.downPressed]).toEqual([true, true]);
    expect(c.next(null).downPressed).toBe(false);
  });

  it('E interacts, R reloads, Q cycles weapons and 1–3 pick one', () => {
    const { c } = controls();
    c.keyDown('KeyE');
    c.keyDown('KeyR');
    let i = c.next(null);
    expect([i.interactPressed, i.reloadPressed]).toEqual([true, true]);
    c.keyDown('KeyQ');
    expect(c.next(null).weaponPressed).toBe('next');
    c.keyDown('Digit3');
    expect(c.next(null).weaponPressed).toBe('rifle');
    c.keyDown('Digit2');
    i = c.next(null);
    expect(i.weaponPressed).toBe('shotgun');
    expect(c.next(null).weaponPressed).toBeNull();
  });

  it('aims from the shoulder at the pointer, crouched or standing', () => {
    const { c } = controls();
    // 10 m toward the loco, level with the standing shoulder.
    c.pointerMove(100, -RIDER_SHOULDER * 10);
    expect(c.next(ctx()).aim).toBeCloseTo(0, 6);
    // Straight up.
    c.pointerMove(0, -50);
    expect(c.next(ctx()).aim).toBeCloseTo(Math.PI / 2, 6);
    // Toward the rear and level with the crouched shoulder.
    c.pointerMove(-100, -RIDER_SHOULDER_CROUCH * 10);
    expect(Math.abs(c.next(ctx(true)).aim)).toBeCloseTo(Math.PI, 6);
    // Without a view the last aim is kept.
    expect(Math.abs(c.next(null).aim)).toBeCloseTo(Math.PI, 6);
  });

  it('left click fires; holding keeps firing', () => {
    const { c } = controls();
    c.mouseDown(0, 400, 100);
    let i = c.next(ctx());
    expect([i.firePressed, i.firing, i.flagPressed]).toEqual([true, true, false]);
    i = c.next(ctx());
    expect([i.firePressed, i.firing]).toEqual([false, true]);
    c.mouseUp(0);
    expect(c.next(ctx()).firing).toBe(false);
  });

  it('Shift or the right button raise the spyglass; its reach follows the pointer; a click plants a flag', () => {
    const { c } = controls();
    c.keyDown('ShiftLeft');
    c.pointerMove(200, 300);
    let i = c.next(ctx());
    expect(i.scope).toBe(true);
    expect(i.scopeT).toBeCloseTo(0.25);
    c.mouseDown(0, 800, 300);
    i = c.next(ctx());
    expect([i.flagPressed, i.firePressed, i.firing]).toEqual([true, false, false]);
    expect(i.scopeT).toBe(1);
    c.mouseUp(0);
    c.keyUp('ShiftLeft');
    expect(c.next(ctx()).scope).toBe(false);
    c.mouseDown(2, 100, 300);
    expect(c.next(ctx()).scope).toBe(true);
    c.mouseUp(2);
    expect(c.next(ctx()).scope).toBe(false);
  });

  it('drops one-shot presses made while paused or counting down, but keeps held keys', () => {
    const { c, state } = controls(false);
    c.keyDown('KeyD');
    c.keyDown('Space');
    c.keyDown('KeyE');
    c.keyDown('Digit2');
    c.mouseDown(0, 10, 10);
    state.running = true;
    const i = c.next(ctx());
    expect(i.moveX).toBe(1);
    expect(i.jump).toBe(true);
    expect(i.firing).toBe(true);
    expect([i.jumpPressed, i.interactPressed, i.firePressed, i.weaponPressed]).toEqual([false, false, false, null]);
  });

  it('ignores key repeats, releases everything on blur, and reports Esc and the debug keys', () => {
    const { c, state } = controls();
    c.keyDown('KeyW');
    c.next(null);
    c.keyDown('KeyW', true);
    expect(c.next(null).jumpPressed).toBe(false);
    c.keyDown('KeyA');
    c.mouseDown(2, 0, 0);
    c.blur();
    const i = c.next(null);
    expect([i.moveX, i.jump, i.scope]).toEqual([0, false, false]);
    expect(c.keyDown('Escape')).toBe(true);
    c.keyDown('Escape', true);
    expect(state.pauses).toBe(1);
    c.keyDown('BracketRight');
    c.keyDown('KeyG');
    expect(state.debug).toEqual(['BracketRight', 'KeyG']);
    expect(c.keyDown('Space')).toBe(true); // don't scroll the page
    expect(c.keyDown('KeyZ')).toBe(false);
    expect(state.any).toBeGreaterThan(0);
  });
});
