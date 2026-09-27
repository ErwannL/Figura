import { describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { apiClient } from './api.js';
import { route } from './app.js';
import { makeT, type Ctx } from './context.js';
import { REFRESH_MS, anomaliesView, galleryView, refreshProgress } from './views/explore.js';
import type { ExploreReport, PublicRun } from './types.js';

type Reply = { status?: number; body?: unknown };

function setup(
  handler: (url: string, init: RequestInit) => Reply | undefined,
  locale: 'en' | 'fr' = 'en',
) {
  const win = new Window({ url: 'http://localhost:4000/' });
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = '<main id="main"></main>';
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = handler(url, init) ?? { status: 404, body: { error: 'NOT_FOUND' } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  });
  const timers: (() => void)[] = [];
  const w = win as unknown as globalThis.Window;
  (w as unknown as { setTimeout: (f: () => void) => number }).setTimeout = (f) => timers.push(f);
  const ctx: Ctx = {
    doc,
    win: w,
    api: apiClient(fetchImpl),
    locale,
    t: makeT(locale),
    go: (r) => (win.location.hash = `#${r}`),
  };
  return { win, doc, ctx, calls, timers };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

const run: PublicRun = {
  id: 'ex1',
  kind: 'explore',
  status: 'done',
  label: '',
  seed: 5,
  targetUrl: 'http://fake',
  config: {
    target: 'local',
    targetUrl: 'http://backend:5001',
    allowRemote: false,
    confirmHost: null,
    explorer: { devices: ['desktop', 'mobile'], sessions: 2 },
  },
  progress: null,
  refusalCode: null,
  refusalMessage: null,
  error: null,
  createdAt: '2030-01-01T00:00:00Z',
  catalogueVersion: null,
  weightsVersion: null,
  targetVersion: null,
};
const anomaly = (o: object = {}) => ({
  key: 'k',
  type: 'js-error',
  severity: 'critical',
  count: 2,
  devices: ['desktop', 'mobile'],
  route: '/board/:id',
  step: 12,
  device: 'mobile',
  slot: 0,
  action: 'tap button "Boom"',
  message: 'Boom',
  excerpt: 'at x.js:1',
  screenshots: ['x-mobile-0-0012-after.png'],
  replay: { seed: 5, device: 'mobile', slot: 0, untilStep: 12 },
  ...o,
});
const report: ExploreReport = {
  type: 'explore',
  seed: 5,
  params: {
    devices: ['desktop', 'mobile'],
    sessions: 2,
    maxActions: 150,
    maxMinutes: 10,
    seedData: false,
  },
  durationMs: 61_000,
  sessions: [
    {
      device: 'desktop',
      slot: 0,
      account: 'synth+ex1-explorer-desktop-0@synthetic.invalid',
      steps: 150,
      states: 9,
      stoppedBy: 'budget',
      error: null,
    },
    {
      device: 'mobile',
      slot: 0,
      account: 'synth+ex1-explorer-mobile-0@synthetic.invalid',
      steps: 0,
      states: 0,
      stoppedBy: 'error',
      error: 'setup: x',
    },
  ],
  statesByDevice: { desktop: 9, mobile: 0 },
  routes: [{ route: '/dashboard', devices: ['desktop'], visits: 40 }],
  gallery: [
    { route: '/dashboard', shots: { desktop: 'x-desktop-0-0001-state.png' } },
    {
      route: '/boards',
      shots: { desktop: 'x-desktop-0-0002-state.png', mobile: 'x-mobile-0-0002-state.png' },
    },
  ],
  anomalies: [
    anomaly(),
    anomaly({
      key: 'k2',
      type: 'small-target',
      severity: 'minor',
      devices: ['mobile'],
      excerpt: 'Boom',
      message: 'Boom',
    }),
  ],
  info: [{ type: 'paywall', route: '/stats', message: 'GET /api/stats → 402', count: 1 }],
  cleanup: { before: { users: 2 }, after: { users: 0 }, residualRows: 0 },
};

describe('explorer run page', () => {
  it('shows the summary, anomalies (filters, evidence), the side-by-side gallery and the export', async () => {
    const e = setup((url) => {
      if (url === '/api/runs/ex1') return { body: { run, transitions: [] } };
      if (url === '/api/runs/ex1/events') return { body: { events: [] } };
      if (url === '/api/runs/ex1/reports/explore.json') return { body: report };
      return undefined;
    });
    const view = await route(e.ctx, '/runs/ex1');
    const text = view.textContent as string;
    expect(text).toContain('Explorer report');
    expect(text).toContain('Seed 5 · duration 61 s');
    expect(text).toContain(
      'mobile #1 · synth+ex1-explorer-mobile-0@synthetic.invalid · 0 steps · 0 states · stopped by error (setup: x)',
    );
    expect(text).toContain('before {"users":2} · after {"users":0} · residual rows 0');
    expect(view.querySelector('a[href="/api/runs/ex1/reports/explore.json"]')).not.toBeNull();
    // The excerpt shows when it adds to the message.
    expect(Array.from(view.querySelectorAll('pre')).map((p) => p.textContent)).toEqual([
      'at x.js:1',
    ]);
    const rows = () => view.querySelectorAll('tbody tr').length;
    const before = rows();
    const pick = (label: string) =>
      view.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
    const device = pick('Device');
    const type = pick('Type');
    type!.value = 'small-target';
    type!.dispatchEvent(new e.win.Event('change') as unknown as Event);
    expect(rows()).toBe(before - 1);
    device!.value = 'desktop';
    device!.dispatchEvent(new e.win.Event('change') as unknown as Event);
    expect(rows()).toBe(before - 2);
    const gallery = view.querySelector('.gallery') as HTMLElement;
    expect(gallery.querySelector('img')!.getAttribute('src')).toBe(
      '/api/runs/ex1/screenshots/x-desktop-0-0001-state.png',
    );
    expect(gallery.textContent).toContain('mobile: —');
    expect(
      gallery.querySelector('img[src$="x-mobile-0-0002-state.png"]')!.getAttribute('width'),
    ).toBe('180');
  });

  it('while running: live progress refreshed until the run ends; no report yet', async () => {
    let status = 'running';
    const progress = {
      sessions: [{ device: 'desktop', slot: 0, step: 4, states: 3 }],
      states: 3,
      anomalies: 1,
      lastScreenshot: 'x-desktop-0-0004-state.png',
      lastAction: 'desktop#0: click link "Boards"',
    };
    const e = setup((url) => {
      if (url === '/api/runs/ex1')
        return { body: { run: { ...run, status, progress }, transitions: [] } };
      if (url === '/api/runs/ex1/events') return { body: { events: [] } };
      return undefined;
    }, 'fr');
    const view = await route(e.ctx, '/runs/ex1');
    e.doc.getElementById('main')!.append(view);
    expect(view.textContent).toContain('3 états découverts · 1 anomalies');
    expect(view.textContent).toContain('Le rapport apparaît');
    expect(view.querySelector('img[src$="x-desktop-0-0004-state.png"]')).not.toBeNull();
    expect(e.timers).toHaveLength(1);
    e.timers.shift()!();
    await tick();
    expect(e.timers).toHaveLength(1);
    status = 'done';
    e.timers.shift()!();
    await tick();
    expect(e.win.location.hash).toBe('#/runs/ex1');
    // The run is over: flushing whatever is scheduled fetches nothing more.
    const calls = e.calls.length;
    for (const f of e.timers.splice(0)) f();
    await tick();
    expect(e.calls).toHaveLength(calls);
  });

  it('refresh stops once the view is left, and survives a failed call', async () => {
    const e = setup(() => ({ status: 500, body: {} }));
    const box = e.doc.createElement('div');
    await refreshProgress(e.ctx, 'ex1', box);
    expect(e.calls).toHaveLength(0);
    e.doc.body.append(box);
    await refreshProgress(e.ctx, 'ex1', box);
    expect(e.timers).toHaveLength(1);
    const sparse = setup((url) =>
      url === '/api/runs/ex1'
        ? {
            body: {
              run: {
                ...run,
                status: 'running',
                progress: {
                  sessions: [],
                  states: 0,
                  anomalies: 0,
                  lastScreenshot: null,
                  lastAction: null,
                },
              },
            },
          }
        : undefined,
    );
    const b2 = sparse.doc.createElement('div');
    sparse.doc.body.append(b2);
    await refreshProgress(sparse.ctx, 'ex1', b2);
    expect(b2.querySelector('img')).toBeNull();
    const none = setup((url) =>
      url === '/api/runs/ex1'
        ? { body: { run: { ...run, status: 'queued', progress: null } } }
        : undefined,
    );
    const b3 = none.doc.createElement('div');
    none.doc.body.append(b3);
    await refreshProgress(none.ctx, 'ex1', b3);
    expect(b3.childNodes).toHaveLength(0);
    expect(REFRESH_MS).toBe(3000);
  });

  it('replay queues the same seed and device up to the step; a 409 is explained', async () => {
    let status = 201;
    const e = setup((url, init) =>
      url === '/api/runs' && init.method === 'POST'
        ? status === 201
          ? { status, body: { run: { id: 'rp1' } } }
          : { status, body: { error: 'EXPLORATION_ACTIVE' } }
        : undefined,
    );
    const view = anomaliesView(e.ctx, run, report);
    const button = view.querySelector('tbody button') as HTMLButtonElement;
    expect(button.textContent).toBe('Replay (seed 5, mobile, to step 12)');
    button.click();
    await tick();
    const body = JSON.parse(String(e.calls[0]!.init.body)) as { config: Record<string, unknown> };
    expect(body.config).toMatchObject({
      kind: 'explore',
      target: 'local',
      seed: 5,
      explorer: {
        devices: ['desktop', 'mobile'],
        sessions: 2,
        replay: { device: 'mobile', slot: 0, untilStep: 12 },
      },
    });
    expect(e.win.location.hash).toBe('#/runs/rp1');
    status = 409;
    button.click();
    await tick();
    expect(view.querySelector('[role="alert"]')!.textContent).toContain('EXPLORATION_ACTIVE');
    // A run without stored config (older rows): its target URL is used.
    const bare = setup((url) => (url === '/api/runs' ? { status: 500, body: {} } : undefined));
    const v2 = anomaliesView(bare.ctx, { ...run, config: undefined }, report);
    (v2.querySelector('tbody button') as HTMLButtonElement).click();
    await tick();
    expect(JSON.parse(String(bare.calls[0]!.init.body)).config).toMatchObject({
      targetUrl: 'http://fake',
      allowRemote: false,
      confirmHost: null,
      explorer: { replay: { untilStep: 12 } },
    });
    bare.ctx.api.post = async () => {
      throw new Error('offline');
    };
    (v2.querySelector('tbody button') as HTMLButtonElement).click();
    await tick();
    expect(v2.querySelector('[role="alert"]')!.textContent).toContain('offline');
  });

  it('no anomaly, residual rows, pending cleanup, empty gallery cells', async () => {
    const e = setup(() => undefined);
    for (const [cleanup, text, alert] of [
      [{ before: 3, after: 1, residualRows: 1 }, 'residual rows 1', true],
      [null, 'Cleanup not reported yet.', false],
    ] as const) {
      const e2 = setup((url) => {
        if (url === '/api/runs/ex1') return { body: { run, transitions: [] } };
        if (url === '/api/runs/ex1/events') return { body: { events: [] } };
        if (url === '/api/runs/ex1/reports/explore.json') return { body: { ...report, cleanup } };
        return undefined;
      });
      const view = await route(e2.ctx, '/runs/ex1');
      const p = Array.from(view.querySelectorAll('p')).find((x) => x.textContent!.includes(text))!;
      expect(p.getAttribute('role') === 'alert').toBe(alert);
    }
    expect(anomaliesView(e.ctx, run, { ...report, anomalies: [] }).textContent).toBe(
      'No anomaly found.',
    );
    expect(galleryView(e.ctx, 'ex1', { ...report, gallery: [] }).childNodes).toHaveLength(0);
  });
});
