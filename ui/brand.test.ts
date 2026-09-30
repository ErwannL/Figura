import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { apiClient } from './api.js';
import { boot, route } from './app.js';
import { AUTHOR, DEFAULT_ORQEA_URL, fetchOrqeaUrl, loader } from './brand.js';
import { makeT, type Ctx } from './context.js';

const ORQEA = 'http://localhost:3001/apps/return';

function env(hash: string, health: { status: number; body: unknown }, me = 200) {
  const win = new Window({ url: `http://localhost:4000/${hash}` });
  Object.defineProperty(win.navigator, 'language', { value: 'fr-FR', configurable: true });
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = '<div id="app"></div>';
  const fetchImpl = vi.fn(async (url: string) => {
    if (url === '/health') return new Response(JSON.stringify(health.body), health);
    if (url === '/api/me')
      return new Response(JSON.stringify({ operator: 'Ops', targets: [] }), { status: me });
    return new Response(JSON.stringify({ runs: [] }), { status: 200 });
  });
  return { win, doc, fetchImpl, w: win as unknown as globalThis.Window };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('branding', () => {
  it('ships the static and animated marks, the SVG favicon and the title', () => {
    expect(readFileSync('ui/public/favicon.svg', 'utf8')).toBe(
      readFileSync('brand/logo.svg', 'utf8'),
    );
    const animated = readFileSync('ui/public/logo-animated.svg', 'utf8');
    expect(animated).toContain('@keyframes');
    expect(animated).toContain('prefers-reduced-motion: reduce');
    const html = readFileSync('ui/index.html', 'utf8');
    expect(html).toContain('<title>Figura by Orqea</title>');
    expect(html).toContain('href="/favicon.svg"');
  });

  it('reads the Orqea URL from /health, with a default when absent or down', async () => {
    const api = (status: number, body: unknown) =>
      apiClient(async () => new Response(JSON.stringify(body), { status }));
    expect(await fetchOrqeaUrl(api(200, { ok: true, orqeaUrl: ORQEA }))).toBe(ORQEA);
    expect(await fetchOrqeaUrl(api(200, { ok: true }))).toBe(DEFAULT_ORQEA_URL);
    expect(await fetchOrqeaUrl(api(503, {}))).toBe(DEFAULT_ORQEA_URL);
  });

  it('loader is the animated logo', () => {
    const doc = new Window().document as unknown as Document;
    const l = loader(doc, 'Chargement…');
    expect(l.getAttribute('role')).toBe('status');
    expect(l.querySelector('img')!.getAttribute('src')).toBe('/logo-animated.svg');
  });

  it('header: name, by Orqea, credits and the way back to the configured Orqea', async () => {
    const e = env('', { status: 200, body: { ok: true, orqeaUrl: ORQEA } });
    await boot(e.doc, e.w, e.fetchImpl);
    const header = e.doc.querySelector('header')!;
    expect(header.textContent).toContain('Figura');
    expect(header.textContent).toContain('par Orqea');
    const back = header.querySelector('a.back')!;
    expect(back.textContent).toBe('← Revenir sur Orqea');
    expect(back.getAttribute('href')).toBe(ORQEA);
    const owner = header.querySelector('a[data-credit=owner]')!;
    expect(owner.textContent).toBe('Propulsé par Orqea');
    expect(owner.getAttribute('href')).toBe(ORQEA);
    const author = header.querySelector('a[data-credit=author]')!;
    expect(author.textContent).toBe('Développé par Erwann Laplante');
    expect(author.getAttribute('href')).toBe(AUTHOR.href);
    expect(author.getAttribute('target')).toBe('_blank');
    expect(author.getAttribute('rel')).toBe('noreferrer noopener');
    expect(author.getAttribute('aria-label')).toBe('Développé par Erwann Laplante');
    expect(owner.getAttribute('target')).toBe('_top');
    expect(back.getAttribute('target')).toBe('_top');
    const marks = header.querySelectorAll('.logo-hover img');
    expect([...marks].map((m) => m.getAttribute('src'))).toEqual([
      '/logo.svg',
      '/logo-animated.svg',
    ]);
    const css = readFileSync('ui/public/styles.css', 'utf8');
    expect(css).toContain('.logo-hover:hover .logo-animated');
    expect(css).toContain('header:focus-within .logo-hover .logo-animated');
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.logo-hover/);
  });

  it('an unknown route is a branded 404, not the runs list', async () => {
    const e = env('#/nope', { status: 200, body: { ok: true, orqeaUrl: ORQEA } });
    await boot(e.doc, e.w, e.fetchImpl);
    await tick();
    const page = e.doc.querySelector('main .gate')!;
    expect(page.textContent).toContain('404 — page introuvable');
    expect(page.querySelector('img')!.getAttribute('alt')).toBe('Figura');
    expect(page.querySelector('a.back')!.getAttribute('href')).toBe(ORQEA);
    expect(page.textContent).toContain('Développé par Erwann Laplante');
    const ctx: Ctx = {
      doc: e.doc,
      win: e.w,
      api: apiClient(e.fetchImpl),
      locale: 'en',
      t: makeT('en'),
      go: () => undefined,
    };
    const en = await route(ctx, '/nope');
    expect(en.textContent).toContain('404 — page not found');
    expect(en.querySelector('a.back')!.getAttribute('href')).toBe(DEFAULT_ORQEA_URL);
  });

  it('without a session the gate is branded too, with the default Orqea when /health fails', async () => {
    const e = env('', { status: 503, body: {} }, 401);
    await boot(e.doc, e.w, e.fetchImpl);
    const gate = e.doc.querySelector('main > .gate')!;
    expect(gate.textContent).toContain('Ouvrez-moi depuis la console');
    expect(gate.querySelector('a.back')!.getAttribute('href')).toBe(DEFAULT_ORQEA_URL);
    expect(gate.querySelector('a[data-credit=author]')).not.toBeNull();
    expect(gate.querySelector('.logo-hover .logo-animated')).not.toBeNull();
  });

  it('the way back is hidden inside an iframe (the Orqea console)', async () => {
    const e = env('', { status: 200, body: { ok: true, orqeaUrl: ORQEA } });
    Object.defineProperty(e.win, 'top', { value: {}, configurable: true });
    await boot(e.doc, e.w, e.fetchImpl);
    expect(e.doc.querySelector('header a.back')!.hasAttribute('hidden')).toBe(true);
  });

  it('the way back is visible outside an iframe', async () => {
    const e = env('', { status: 200, body: { ok: true, orqeaUrl: ORQEA } });
    await boot(e.doc, e.w, e.fetchImpl);
    expect(e.doc.querySelector('header a.back')!.hasAttribute('hidden')).toBe(false);
  });
});
