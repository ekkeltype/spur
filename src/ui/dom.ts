// Tiny DOM helpers: menus are plain DOM and CSS (spec §13).

type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  title?: string;
  id?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  role?: string;
  ariaLabel?: string;
  tabIndex?: number;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  if (props.id) el.id = props.id;
  if (props.role) el.setAttribute('role', props.role);
  if (props.ariaLabel) el.setAttribute('aria-label', props.ariaLabel);
  if (props.tabIndex !== undefined) el.tabIndex = props.tabIndex;
  if (props.type !== undefined) el.setAttribute('type', props.type);
  if (props.value !== undefined) (el as HTMLInputElement).value = props.value;
  if (props.placeholder !== undefined) (el as HTMLInputElement).placeholder = props.placeholder;
  if (props.disabled !== undefined) (el as HTMLButtonElement).disabled = props.disabled;
  if (props.checked !== undefined) (el as HTMLInputElement).checked = props.checked;
  if (props.style) Object.assign(el.style, props.style);
  if (props.dataset) Object.assign(el.dataset, props.dataset);
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
  if (props.on) {
    for (const [k, fn] of Object.entries(props.on)) {
      if (fn) el.addEventListener(k, fn as EventListener);
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function button(label: string, onClick: () => void, cls = 'btn', props: Props = {}): HTMLButtonElement {
  return h('button', { ...props, class: cls, type: 'button', text: label, on: { click: () => onClick() } });
}

/** Copies text to the clipboard, falling back to a hidden textarea. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    let ok: boolean;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

