// Dev-only page for the run's opening shot (src/ui/intro.ts), served by Vite at /intro.html (never part
// of the game build). It plays the shot on a loop over a black play screen. Click (or press Space) to
// replay it with sound. Query parameters: ?run=1..6 picks the run, ?t=2.5 freezes the shot at that
// second, ?motion=0 plays it as with screen shake off.

import '../ui/styles.css';
import { Sfx } from '../audio/sfx';
import { RUNS } from '../content/runs';
import { INTRO_SECONDS } from '../sim/rules';
import { introInfo, IntroOverlay } from '../ui/intro';

const params = new URLSearchParams(location.search);
const runNo = Math.min(RUNS.length, Math.max(1, Number(params.get('run')) || 1));
const frozen = params.has('t') ? Number(params.get('t')) : null;
const motion = params.get('motion') !== '0';
/** The countdown's numbers would follow; the harness pauses this long before playing it again. */
const GAP_MS = 1500;

const sfx = new Sfx();
const overlay = new IntroOverlay(introInfo(RUNS[runNo - 1]), sfx);
const play = document.createElement('div');
play.className = 'play';
const label = document.createElement('div');
label.className = 'debug-badge';
label.style.zIndex = '20';
label.textContent = `Run ${runNo}: ${RUNS[runNo - 1].name} · click or Space to replay with sound · ?run=1..6 ?t=2.5 ?motion=0`;
play.append(overlay.el, label);
document.body.append(play);

let endMs = performance.now() + INTRO_SECONDS * 1000;
const replay = (): void => {
  sfx.unlock();
  endMs = performance.now() + INTRO_SECONDS * 1000;
};
window.addEventListener('pointerdown', replay);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') replay();
});

const frame = (now: number): void => {
  if (frozen !== null) {
    overlay.frame(now, now + (INTRO_SECONDS - frozen) * 1000, motion);
  } else {
    if (now > endMs + GAP_MS) endMs = now + INTRO_SECONDS * 1000;
    overlay.frame(now, endMs, motion);
  }
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
