// Small DOM helpers for the desk's panels. (The desk keeps its own rather than the app's ui/dom.ts
// so the render layer doesn't depend on the UI shell.)

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A button that never keeps focus: Space and the arrows belong to the levers, not to a focused button. */
export function btn(cls: string, html: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  b.innerHTML = html;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/** Writes text only when it changed (snapshots arrive 15 times a second). */
export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setHtml(node: Element, html: string): void {
  if (node.innerHTML !== html) node.innerHTML = html;
}

export function setClass(node: Element, cls: string, on: boolean): void {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
}

/** Restarts a one-shot CSS animation class (a refusal flash, a shake). */
export function replay(node: HTMLElement, cls: string): void {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t || !t.tagName) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

export function capitalise(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

export const kbd = (k: string): string => `<kbd>${k}</kbd>`;
