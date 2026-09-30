import type { I18nKey, Locale } from '../shared/i18n.js';
import { apiClient, type Fetch } from './api.js';
import { makeT, type Ctx } from './context.js';
import { h } from './dom.js';
import {
  backToOrqea,
  brandedPage,
  credits,
  DEFAULT_ORQEA_URL,
  fetchOrqeaUrl,
  loader,
  hoverLogo,
} from './brand.js';
import { bootstrapSession } from './sso.js';
import { compareView } from './views/compare.js';
import { newRunView } from './views/new-run.js';
import { personasView } from './views/personas.js';
import { runView } from './views/run.js';
import { runsView } from './views/runs.js';

const LOCALE_KEY = 'figura.locale';

export function initialLocale(win: Window): Locale {
  let stored: string | null = null;
  try {
    stored = win.localStorage.getItem(LOCALE_KEY);
  } catch {
    stored = null;
  }
  const wanted = stored ?? win.navigator.language.slice(0, 2);
  return wanted === 'fr' ? 'fr' : 'en';
}

/** Unknown route ⇒ the branded 404 (never a silent fallback to another page). */
export async function route(
  ctx: Ctx,
  path: string,
  orqeaUrl: string = DEFAULT_ORQEA_URL,
): Promise<HTMLElement> {
  const run = /^\/runs\/([0-9a-z]+)$/.exec(path);
  if (run) return runView(ctx, run[1] as string);
  if (path === '/new') return newRunView(ctx);
  if (path === '/compare') return compareView(ctx);
  if (path === '/personas') return personasView(ctx);
  if (path === '/runs') return runsView(ctx);
  return brandedPage(ctx.doc, ctx.t, orqeaUrl, ctx.t('notFound.title'), ctx.t('notFound.hint'));
}

/** Top bar: logo, name, navigation, operator, language switch, credits, way back to Orqea. */
export function buildHeader(
  ctx: Ctx,
  operator: string,
  langSelect: HTMLElement,
  orqeaUrl: string,
): HTMLElement {
  const { doc, t } = ctx;
  const routes: [string, I18nKey][] = [
    ['/runs', 'nav.runs'],
    ['/new', 'nav.newRun'],
    ['/compare', 'nav.compare'],
    ['/personas', 'nav.personas'],
  ];
  const nav = h(
    doc,
    'nav',
    { 'aria-label': t('app.name') },
    ...routes.map(([r, k]) => h(doc, 'a', { href: `#${r}` }, t(k))),
  );
  return h(
    doc,
    'header',
    {},
    hoverLogo(doc, 28),
    h(
      doc,
      'div',
      { class: 'brand-text' },
      h(
        doc,
        'span',
        { class: 'brand-name' },
        h(doc, 'strong', {}, t('app.name')),
        ' ',
        h(doc, 'span', { class: 'byline' }, t('app.byline')),
      ),
      credits(doc, t, orqeaUrl),
    ),
    nav,
    h(doc, 'span', { class: 'who' }, t('app.signedInAs', { operator })),
    langSelect,
    backToOrqea(doc, t, orqeaUrl),
  );
}

/** Boots the SPA: SSO first; without a session only the "open me from the console" notice. */
export async function boot(doc: Document, win: Window, fetchImpl: Fetch): Promise<void> {
  const root = doc.getElementById('app') as HTMLElement;
  let locale = initialLocale(win);
  const api = apiClient(fetchImpl);
  doc.documentElement.lang = locale;
  root.replaceChildren(loader(doc, makeT(locale)('app.signingIn')));
  const [operator, orqeaUrl] = await Promise.all([bootstrapSession(win, api), fetchOrqeaUrl(api)]);
  if (!operator) {
    const t = makeT(locale);
    root.replaceChildren(
      h(
        doc,
        'main',
        {},
        brandedPage(doc, t, orqeaUrl, t('app.openFromConsole'), t('app.openFromConsoleHint')),
      ),
    );
    return;
  }
  const main = h(doc, 'main', { id: 'main' });
  const render = async () => {
    const t = makeT(locale);
    const ctx: Ctx = {
      doc,
      win,
      api,
      locale,
      t,
      go: (r) => {
        win.location.hash = `#${r}`;
      },
    };
    const langSelect = h(
      doc,
      'select',
      { 'aria-label': t('nav.language') },
      h(doc, 'option', { value: 'en', selected: locale === 'en' }, 'English'),
      h(doc, 'option', { value: 'fr', selected: locale === 'fr' }, 'Français'),
    ) as HTMLSelectElement;
    langSelect.addEventListener('change', () => {
      locale = langSelect.value === 'fr' ? 'fr' : 'en';
      try {
        win.localStorage.setItem(LOCALE_KEY, locale);
      } catch {
        // storage blocked: the choice lasts for this page only
      }
      doc.documentElement.lang = locale;
      void render();
    });
    const header = buildHeader(ctx, operator as string, langSelect, orqeaUrl);
    root.replaceChildren(header, main);
    main.replaceChildren(loader(doc, t('app.loading')));
    try {
      main.replaceChildren(
        await route(ctx, win.location.hash.replace(/^#/, '') || '/runs', orqeaUrl),
      );
    } catch (e) {
      main.replaceChildren(
        h(doc, 'p', { role: 'alert' }, t('app.error', { detail: (e as Error).message })),
      );
    }
  };
  win.addEventListener('hashchange', () => void render());
  await render();
}
