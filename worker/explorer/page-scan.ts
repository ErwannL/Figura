import { accessibleName, isHidden, roleOf, textOf } from '../drivers/measure.js';
import type { Control } from './forbidden.js';

/** One scan of the current screen: what can be done, and what looks broken (DOM only). */
export interface Scan {
  url: string;
  title: string;
  controls: Control[];
  modal: boolean;
  viewport: { width: number; height: number };
  docWidth: number;
  offscreen: string[];
  textOverflow: string[];
  smallTargets: string[];
  unnamed: string[];
  imgNoAlt: string[];
  rawKeys: string[];
  htmlInjected: string[];
  notFound: boolean;
}

/** Marker typed into fields: rendered as an element means the app interpreted user HTML. */
export const HTML_MARKER_PREFIX = 'fxh';

/** measure.ts's helpers, passed in: an imported name would not survive serialisation. */
export const HELPERS = { isHidden, textOf, accessibleName, roleOf };
export type Helpers = typeof HELPERS;

// Serialised with scanPage (see scanScript): no imports, no closures beyond the listed helpers.
export function roleOfControl(el: Element, roleOf: Helpers['roleOf']): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (
    el.tagName === 'INPUT' &&
    ['email', 'password', 'number', 'date', 'tel', 'url'].includes(type)
  )
    return 'textbox';
  if (el.tagName === 'TEXTAREA') return 'textbox';
  return roleOf(el);
}

export function formInfo(el: Element, forms: Element[]) {
  const form = el.closest('form');
  if (!form) return { form: '', formId: -1, formHasPassword: false, formEmails: [] as string[] };
  const method = (form.getAttribute('method') ?? '').toUpperCase();
  const target = form.getAttribute('data-api') ?? form.getAttribute('action') ?? '';
  return {
    form: `${method} ${target}`.trim(),
    formId: forms.indexOf(form),
    formHasPassword: form.querySelector('input[type="password"]') !== null,
    formEmails: Array.from(form.querySelectorAll('input[type="email"]')).map(
      (i) => (i as HTMLInputElement).value,
    ),
  };
}

export function isRawKey(text: string): boolean {
  if (!/^[a-z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/.test(text)) return false;
  if (/\.(com|net|org|io|app|fr|dev|json|js|ts|png|jpg|svg|txt|csv|md|html)$/i.test(text))
    return false;
  return text.split('.').length >= 3 || text.includes('_');
}

/** Visible text: raw i18n keys, and text spilling out of a box whose overflow is not planned. */
export function scanText(
  doc: Document,
  win: Window,
  hidden: (el: Element) => boolean,
  isRawKey: (t: string) => boolean,
): { textOverflow: string[]; rawKeys: string[] } {
  const textOverflow: string[] = [];
  const rawKeys: string[] = [];
  const walker = doc.createTreeWalker(doc.body, 4);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement as Element;
    const text = (n.textContent as string).trim();
    if (!text || ['SCRIPT', 'STYLE'].includes(parent.tagName) || hidden(parent)) continue;
    if (isRawKey(text)) rawKeys.push(text);
    const style = win.getComputedStyle(parent);
    const clipped = ['hidden', 'auto', 'scroll', 'clip'].includes(
      style.overflowX || style.overflow,
    );
    const pe = parent as HTMLElement;
    if (!clipped && pe.clientWidth > 0 && pe.scrollWidth > pe.clientWidth + 1)
      textOverflow.push(`${parent.tagName.toLowerCase()}: ${text.slice(0, 60)}`);
  }
  return { textOverflow, rawKeys };
}

const INTERACTIVE =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="option"], [role="combobox"]';

/**
 * Unit-tested in happy-dom and injected into real pages as source text (see scanScript). Widths
 * use the layout viewport: on mobile, innerWidth grows when the page zooms out to fit wide content.
 */
export function scanPage(doc: Document, win: Window, h: Helpers): Scan {
  const vw = doc.documentElement.clientWidth || win.innerWidth;
  const vh = win.innerHeight;
  const hidden = (el: Element) => h.isHidden(el, win);
  const forms = Array.from(doc.querySelectorAll('form'));
  const modals = Array.from(
    doc.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]',
    ),
  ).filter((m) => !hidden(m));
  const seen = new Set<string>();
  const controls: Control[] = [];
  const offscreen: string[] = [];
  const smallTargets: string[] = [];
  const unnamed: string[] = [];
  const all = Array.from(doc.querySelectorAll(INTERACTIVE)).filter(
    (el) => el.getAttribute('type') !== 'hidden' && !hidden(el),
  );
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const role = roleOfControl(el, h.roleOf);
    // accname: these roles take their name from their content, whatever the tag.
    const fromContent = /^(button|link|tab|menuitem|option|checkbox|switch)$/.test(role);
    const name = h.accessibleName(el, doc) || (fromContent ? h.textOf(el) : '');
    const label = `${role} "${name}"`;
    if (r.width <= 0 || r.height <= 0) continue;
    if (!name && (role === 'button' || role === 'link'))
      unnamed.push(`${role}: ${el.outerHTML.slice(0, 120)}`);
    if (r.x + r.width > vw + 1 || r.x < -1) offscreen.push(label);
    if (r.width < 24 || r.height < 24)
      smallTargets.push(`${label} ${Math.round(r.width)}×${Math.round(r.height)}`);
    const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
    if (disabled || r.x + r.width <= 0 || r.x >= vw) continue;
    const a = el.getAttribute('href');
    const href = a === null ? null : new URL(a, doc.baseURI).href;
    const key = `${role}|${name}|${href ?? ''}|${el.getAttribute('type') ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const idx = controls.length;
    el.setAttribute('data-figura-x', String(idx));
    const expanded = el.getAttribute('aria-expanded');
    controls.push({
      idx,
      role,
      name,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') ?? '').toLowerCase(),
      href,
      ...formInfo(el, forms),
      expanded: expanded === null ? null : expanded === 'true',
      inModal: modals.some((m) => m.contains(el)),
      draggable: el.getAttribute('draggable') === 'true',
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
    });
  }
  const { textOverflow, rawKeys } = scanText(doc, win, hidden, isRawKey);
  const imgNoAlt = Array.from(doc.querySelectorAll('img:not([alt])'))
    .filter((i) => !hidden(i) && i.getAttribute('role') !== 'presentation')
    .map((i) => (i.getAttribute('src') ?? '').split('?')[0] as string);
  const htmlInjected = Array.from(doc.querySelectorAll('b, i, strong, em, u'))
    .map(h.textOf)
    .filter((t) => /^fxh[0-9a-z]+$/.test(t));
  const heading = h.textOf(doc.querySelector('h1'));
  return {
    url: win.location.href,
    title: doc.title,
    controls,
    modal: modals.length > 0,
    viewport: { width: vw, height: vh },
    docWidth: doc.documentElement.scrollWidth,
    offscreen,
    textOverflow,
    smallTargets,
    unnamed,
    imgNoAlt,
    rawKeys: [...new Set(rawKeys)],
    htmlInjected,
    notFound: /\b404\b|not found|page introuvable/i.test(`${doc.title} ${heading}`),
  };
}

export function scanScript(): string {
  const parts = [
    isHidden,
    textOf,
    accessibleName,
    roleOf,
    roleOfControl,
    formInfo,
    isRawKey,
    scanText,
  ]
    .map(String)
    .join('\n');
  const helpers = '{ isHidden, textOf, accessibleName, roleOf }';
  return `(() => {\nconst INTERACTIVE = ${JSON.stringify(INTERACTIVE)};\n${parts}\nreturn (${scanPage.toString()})(document, window, ${helpers});\n})()`;
}
