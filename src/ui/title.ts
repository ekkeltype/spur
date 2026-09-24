// Title screen (spec §3, §18): "Switch & Spur" in Rye over a dusk horizon, where a train silhouette
// rolls in along the line and stops short of the switch to the spur. That roll-in is the one
// orchestrated motion in the menus, and it's skipped under reduced motion.

import { button, h } from './dom';

const SVG = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

export interface TitleActions {
  host: () => void;
  join: () => void;
  local: () => void;
  settings: () => void;
  /** A message to show under the buttons, e.g. why the save couldn't be loaded. */
  notice?: string;
}

const SILHOUETTE = '#120d0a';
const BRASS = '#C8A15A';

/** Wheels: a dark disc with a brass hub. */
function wheel(cx: number, cy: number, r: number): SVGGElement {
  return svg('g', {}, svg('circle', { cx, cy, r, fill: SILHOUETTE }), svg('circle', { cx, cy, r: Math.max(1.5, r * 0.22), fill: BRASS, opacity: 0.7 }));
}

/** A train facing right, its front at x = 0 and its wheels on the rail at y = 0. */
function train(): SVGGElement {
  const body = { fill: SILHOUETTE };
  const g = svg('g', { class: 'title-train' });
  // Smoke drifting back from the stack.
  for (const [x, y, r, o] of [
    [-38, -86, 9, 0.22],
    [-58, -100, 13, 0.16],
    [-90, -110, 17, 0.1],
    [-130, -114, 20, 0.06],
  ]) {
    g.append(svg('circle', { cx: x, cy: y, r, fill: '#EFE6D2', opacity: o }));
  }
  g.append(
    // Locomotive: cowcatcher, buffer beam, boiler, stack, domes, headlamp, cab.
    svg('path', { ...body, d: 'M -18 -20 L -18 -3 L 3 -3 Z' }),
    svg('rect', { ...body, x: -24, y: -26, width: 8, height: 8 }),
    svg('rect', { ...body, x: -98, y: -48, width: 80, height: 28, rx: 6 }),
    svg('path', { ...body, d: 'M -38 -46 L -40 -60 L -48 -72 L -20 -72 L -28 -60 L -30 -46 Z' }),
    svg('path', { ...body, d: 'M -70 -47 Q -70 -58 -62 -58 Q -54 -58 -54 -47 Z' }),
    svg('path', { ...body, d: 'M -88 -47 Q -88 -54 -83 -54 Q -78 -54 -78 -47 Z' }),
    svg('rect', { ...body, x: -27, y: -60, width: 10, height: 10, rx: 1 }),
    svg('circle', { cx: -17, cy: -55, r: 3, fill: '#F2B632' }),
    svg('rect', { ...body, x: -130, y: -72, width: 34, height: 52 }),
    svg('rect', { ...body, x: -134, y: -77, width: 42, height: 6, rx: 2 }),
    svg('rect', { x: -124, y: -64, width: 18, height: 14, fill: BRASS, opacity: 0.85 }),
    svg('rect', { ...body, x: -134, y: -24, width: 118, height: 6 }),
    wheel(-50, -12, 12),
    wheel(-78, -12, 12),
    wheel(-26, -7, 7),
    wheel(-114, -8, 8),
    svg('line', { x1: -50, y1: -12, x2: -78, y2: -12, stroke: BRASS, 'stroke-width': 2, opacity: 0.8 }),
    // Tender, with coal heaped on top.
    svg('rect', { ...body, x: -190, y: -50, width: 52, height: 30, rx: 2 }),
    svg('path', { ...body, d: 'M -188 -50 Q -176 -62 -160 -58 Q -150 -64 -140 -50 Z' }),
    wheel(-178, -8, 8),
    wheel(-152, -8, 8),
    // An express car and a boxcar.
    svg('rect', { ...body, x: -296, y: -60, width: 100, height: 40, rx: 2 }),
    svg('rect', { ...body, x: -300, y: -65, width: 108, height: 6, rx: 3 }),
    svg('rect', { x: -284, y: -50, width: 76, height: 6, fill: BRASS, opacity: 0.45 }),
    wheel(-282, -8, 8),
    wheel(-212, -8, 8),
    svg('rect', { ...body, x: -398, y: -58, width: 96, height: 38, rx: 2 }),
    svg('rect', { ...body, x: -401, y: -62, width: 102, height: 5, rx: 2 }),
    wheel(-384, -8, 8),
    wheel(-316, -8, 8),
  );
  // Couplers between the vehicles.
  for (const x of [-138, -196, -302]) g.append(svg('rect', { ...body, x: x - 6, y: -18, width: 8, height: 3 }));
  return g;
}

function scene(): SVGSVGElement {
  const s = svg('svg', { class: 'title-scene', viewBox: '0 0 1600 240', preserveAspectRatio: 'xMidYMax slice', 'aria-hidden': 'true' });
  const glow = svg(
    'linearGradient',
    { id: 'title-glow', x1: 0, y1: 0, x2: 0, y2: 1 },
    svg('stop', { offset: 0, 'stop-color': '#B5563A', 'stop-opacity': 0 }),
    svg('stop', { offset: 0.65, 'stop-color': '#B5563A', 'stop-opacity': 0.5 }),
    svg('stop', { offset: 1, 'stop-color': '#D9B77E', 'stop-opacity': 0.85 }),
  );
  s.append(svg('defs', {}, glow));
  s.append(
    svg('rect', { x: 0, y: 20, width: 1600, height: 172, fill: 'url(#title-glow)' }),
    svg('circle', { cx: 560, cy: 176, r: 46, fill: '#F2C46B', opacity: 0.9 }),
    // Buttes and mesas along the horizon.
    svg('path', {
      fill: '#2c1b14',
      d: 'M0 192 L0 158 L40 158 L52 140 L150 140 L170 160 L260 166 L300 150 L330 150 L338 120 L420 120 L430 150 L470 166 L620 174 L700 160 L760 160 L775 132 L900 132 L920 158 L1010 170 L1120 168 L1200 150 L1240 150 L1250 118 L1340 118 L1356 150 L1420 164 L1520 160 L1560 146 L1600 146 L1600 192 Z',
    }),
    svg('rect', { x: 0, y: 190, width: 1600, height: 50, fill: '#140f0b' }),
  );
  // The line: ties under one rail, and the spur leaving it at the switch.
  for (let x = 4; x < 1600; x += 22) s.append(svg('rect', { x, y: 191, width: 13, height: 4, fill: '#3b2a1d' }));
  s.append(
    svg('line', { x1: 0, y1: 190, x2: 1600, y2: 190, stroke: BRASS, 'stroke-width': 2.5 }),
    svg('path', { d: 'M1190 190 C 1270 190 1330 202 1420 222 L 1640 272', stroke: BRASS, 'stroke-width': 2.5, fill: 'none', opacity: 0.75 }),
    // The switch stand: a post with a red target.
    svg('line', { x1: 1172, y1: 190, x2: 1172, y2: 164, stroke: SILHOUETTE, 'stroke-width': 3 }),
    svg('circle', { cx: 1172, cy: 158, r: 7, fill: '#E0442E', stroke: SILHOUETTE, 'stroke-width': 2 }),
    svg('g', { transform: 'translate(1110 190)' }, train()),
  );
  return s;
}

export function titleScreen(actions: TitleActions): HTMLElement {
  return h(
    'div',
    { class: 'screen title-screen' },
    h(
      'div',
      { class: 'title-block' },
      h('h1', { class: 'title-word', ariaLabel: 'Switch & Spur' }, 'Switch ', h('span', { class: 'amp', text: '&' }), ' Spur'),
      h('p', { class: 'title-tag', text: 'A two-player frontier train. The Rider fights on the roof, the Engineer drives and dispatches. You win by talking.' }),
      h(
        'div',
        { class: 'title-buttons' },
        button('Host as Rider', actions.host, 'btn primary'),
        button('Join as Engineer', actions.join, 'btn primary'),
        button('Local test', actions.local, 'btn'),
        button('Settings', actions.settings, 'btn'),
      ),
      actions.notice ? h('p', { class: 'title-notice', text: actions.notice }) : null,
    ),
    scene(),
    h('div', { class: 'title-foot', text: 'Use your own voice chat. The Rider plays with keyboard and mouse, the Engineer with the mouse. Desktop browsers, 1280×720 and up.' }),
  );
}
