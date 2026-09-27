import type { Api } from './api.js';
import type { Ctx } from './context.js';
import { h } from './dom.js';

/**
 * Branding shared by every screen, one source of truth (same set as SportSplitter and Archipel by
 * Orqea): logo, « by Orqea », credits, « Back to Orqea ». The Orqea link is the one of THIS
 * environment (`FIGURA_ORQEA_URL`, learnt from `/health`).
 */
export const DEFAULT_ORQEA_URL = 'https://orqea.dev';
export const AUTHOR = { name: 'Erwann Laplante', href: 'https://github.com/ErwannL' } as const;

type T = Ctx['t'];

/** The Orqea URL of this environment; the default when /health is down or silent. */
export async function fetchOrqeaUrl(api: Api): Promise<string> {
  try {
    return (await api.get<{ orqeaUrl?: string }>('/health')).orqeaUrl ?? DEFAULT_ORQEA_URL;
  } catch {
    return DEFAULT_ORQEA_URL;
  }
}

/** Static mark (`/logo.svg`) or the animated one (`/logo-animated.svg`, still under reduced motion). */
export function logo(doc: Document, size: number, animated = false, alt = ''): HTMLElement {
  const src = animated ? '/logo-animated.svg' : '/logo.svg';
  const w = String(size);
  return h(doc, 'img', { class: 'logo', src, alt, width: w, height: w });
}

/** « Powered by Orqea » (same tab, top frame) and « Developed by Erwann Laplante » (new tab). */
export function credits(doc: Document, t: T, orqeaUrl: string): HTMLElement {
  return h(
    doc,
    'span',
    { class: 'credits' },
    h(doc, 'a', { href: orqeaUrl, target: '_top', 'data-credit': 'owner' }, t('brand.poweredBy')),
    h(
      doc,
      'a',
      {
        href: AUTHOR.href,
        target: '_blank',
        rel: 'noreferrer noopener',
        'aria-label': t('brand.authorNewTab', { name: AUTHOR.name }),
        'data-credit': 'author',
      },
      t('brand.author', { name: AUTHOR.name }),
    ),
  );
}

/** « ← Back to Orqea »: the session comes from Orqea, so there is no logout, we go back. */
export function backToOrqea(doc: Document, t: T, orqeaUrl: string): HTMLElement {
  return h(doc, 'a', { class: 'back', href: orqeaUrl, target: '_top' }, t('brand.back'));
}

/** Full-page loader: the animated logo, never a spinner. */
export function loader(doc: Document, label: string): HTMLElement {
  return h(
    doc,
    'div',
    { class: 'loader', role: 'status' },
    logo(doc, 56, true),
    h(doc, 'span', {}, label),
  );
}

/** A branded full page (no session, unknown route): logo, name, message, way back, credits. */
export function brandedPage(
  doc: Document,
  t: T,
  orqeaUrl: string,
  title: string,
  hint: string,
): HTMLElement {
  return h(
    doc,
    'section',
    { class: 'gate' },
    logo(doc, 64, false, t('app.name')),
    h(
      doc,
      'p',
      { class: 'gate-name' },
      h(doc, 'strong', {}, t('app.name')),
      ' ',
      h(doc, 'span', { class: 'byline' }, t('app.byline')),
    ),
    h(doc, 'h1', {}, title),
    h(doc, 'p', {}, hint),
    h(doc, 'p', {}, backToOrqea(doc, t, orqeaUrl)),
    credits(doc, t, orqeaUrl),
  );
}
