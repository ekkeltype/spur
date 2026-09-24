// Settings: volumes, screen shake, hints, and letters on signal lamps.

import type { Settings } from '../sim/types';
import { button, h } from './dom';

/** `onPatch` receives only what changed, so stores for other roles keep their other choices. */
export function settingsScreen(get: () => Settings, onPatch: (patch: Partial<Settings>) => void, onBack: () => void, onTest?: () => void): HTMLElement {
  const s = get();
  const range = (label: string, value: number, on: (v: number) => void): HTMLInputElement => {
    const el = h('input', { type: 'range', ariaLabel: label, attrs: { min: '0', max: '100', step: '1' } });
    el.value = String(Math.round(value * 100));
    el.addEventListener('input', () => on(Number(el.value) / 100));
    el.addEventListener('change', () => onTest?.());
    return el;
  };
  const check = (label: string, value: boolean, on: (v: boolean) => void): HTMLInputElement => {
    const el = h('input', { type: 'checkbox', ariaLabel: label });
    el.checked = value;
    el.addEventListener('change', () => on(el.checked));
    return el;
  };
  const hints = h(
    'select',
    { ariaLabel: 'Hints' },
    h('option', { value: 'first', text: 'First run only' }),
    h('option', { value: 'always', text: 'Always' }),
    h('option', { value: 'never', text: 'Never' }),
  );
  hints.value = s.hints;
  hints.addEventListener('change', () => onPatch({ hints: hints.value as Settings['hints'] }));
  return h(
    'div',
    { class: 'screen' },
    h(
      'div',
      { class: 'sheet narrow settings' },
      h('h2', { class: 'display', text: 'Settings' }),
      h(
        'div',
        { class: 'settings-grid' },
        h('label', { text: 'Master volume' }),
        range('Master volume', s.masterVolume, (v) => onPatch({ masterVolume: v })),
        h('label', { text: 'Effects volume' }),
        range('Effects volume', s.effectsVolume, (v) => onPatch({ effectsVolume: v })),
        h('label', { text: 'Screen shake' }),
        check('Screen shake', s.screenShake, (v) => onPatch({ screenShake: v })),
        h('label', { text: 'Hints' }),
        hints,
        h('label', { text: 'Letters on signal lamps (R, Y, G)' }),
        check('Letters on signal lamps', s.lampLetters, (v) => onPatch({ lampLetters: v })),
      ),
      h('p', { class: 'small muted', text: 'Screen shake starts off if your system asks for reduced motion. Lamp letters help tell red, yellow and green apart.' }),
      h('div', { class: 'row end' }, button('Done', onBack, 'btn primary')),
    ),
  );
}
