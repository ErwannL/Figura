import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, devices, type Browser } from 'playwright';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrng } from '../../shared/prng.js';
import type { DeviceKey } from '../../shared/explorer.js';
import { AnomalyBook } from './anomalies.js';
import { ExplorerSession, domFindings, type SessionOptions } from './session.js';
import { ShotBook } from './shots.js';
import { buggyApp } from './test-helpers/buggy-app.js';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => browser.close());

async function explore(
  healthy: boolean,
  device: DeviceKey,
  o: Partial<SessionOptions> = {},
  onPage?: (p: import('playwright').Page) => void,
) {
  const app = await buggyApp({ healthy });
  const context = await browser.newContext(
    device === 'mobile' ? devices['Pixel 7'] : { viewport: { width: 1440, height: 900 } },
  );
  const page = await context.newPage();
  const leftOrigin: string[] = [];
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame() && !f.url().startsWith(app.origin) && f.url() !== 'about:blank')
      leftOrigin.push(f.url());
  });
  if (o.home === 'BOARDS') o = { ...o, home: `${app.origin}/boards?solo` };
  if (o.home === 'COVERED') o = { ...o, home: `${app.origin}/covered?solo` };
  if (o.home === 'EXTRAS') o = { ...o, home: `${app.origin}/extras?solo` };
  onPage?.(page);
  await page.goto(o.home ?? `${app.origin}/`);
  const dir = mkdtempSync(join(tmpdir(), 'explore-'));
  const book = new AnomalyBook();
  const shots = o.shots ?? new ShotBook(dir);
  const steps: number[] = [];
  const actions: string[] = [];
  const session = new ExplorerSession(page, {
    runId: 'r1',
    device,
    slot: 0,
    prng: createPrng(11).fork(`${device}#0`),
    origin: app.origin,
    apiOrigin: app.origin,
    home: `${app.origin}/`,
    touch: device !== 'desktop',
    maxActions: 45,
    deadline: Date.now() + 60_000,
    clumsiness: 0.1,
    book,
    shots,
    now: Date.now,
    sleep: async () => {},
    shouldStop: () => false,
    onStep: (p) => {
      steps.push(p.step);
      actions.push(p.action);
    },
    pause: { min: 0, max: 0 },
    actionTimeoutMs: 1500,
    ...o,
  });
  const result = await session.run();
  await context.close();
  await app.close();
  return { result, book, shots, app, dir, leftOrigin, steps, actions };
}

const types = (b: AnomalyBook) => new Set(b.anomalies().map((a) => a.type));

describe('ExplorerSession against a local app with planted defects', () => {
  it('desktop: finds the JS error, the 500, the NotFound link, the raw key', async () => {
    const r = await explore(false, 'desktop', { maxActions: 90 });
    expect(r.result).toMatchObject({
      device: 'desktop',
      steps: 90,
      stoppedBy: 'budget',
      error: null,
    });
    expect(r.steps.at(-1)).toBe(90);
    const found = types(r.book);
    for (const t of ['http-5xx', 'js-error', 'not-found', 'raw-i18n-key'] as const)
      expect(found, [...found].join()).toContain(t);
    const notFound = r.book.anomalies().filter((a) => a.type === 'not-found');
    // The server's 404 and the single-page app's own NotFound screen (200), each once.
    expect(notFound.map((a) => a.route).sort()).toEqual(['/board/:id', '/missing']);
    const js = r.book.anomalies().find((a) => a.type === 'js-error')!;
    expect(js).toMatchObject({ severity: 'critical', devices: ['desktop'] });
    expect(js.message).toContain('Boom handler exploded');
    expect(js.action).toContain('Boom');
    expect(js.screenshots.length).toBeGreaterThan(0);
    for (const f of js.screenshots) expect(existsSync(join(r.dir, f))).toBe(true);
    // Never clicked, never followed.
    expect(r.app.hits.deleteAccount).toBe(0);
    expect(r.leftOrigin).toEqual([]);
    const info = r.book.infoList();
    expect(
      info.some((i) => i.type === 'forbidden-skipped' && i.message.startsWith('account-delete')),
    ).toBe(true);
    expect(
      info.some((i) => i.type === 'forbidden-skipped' && i.message.startsWith('external-link')),
    ).toBe(true);
    expect(
      info.some((i) => i.type === 'external-navigation' && i.message.includes('elsewhere.invalid')),
    ).toBe(true);
    // One screenshot per new state and device, with its metadata.
    const states = r.shots.shots.filter((s) => s.kind === 'state');
    expect(new Set(states.map((s) => s.fingerprint)).size).toBe(states.length);
    expect(states[0]).toMatchObject({
      session: 'desktop#0',
      device: 'desktop',
      step: 1,
      route: '/',
      action: 'open',
    });
    expect(r.result.routes['/']).toBeGreaterThan(0);
  });

  it('mobile: horizontal scroll with a full-page screenshot, taps instead of clicks', async () => {
    const r = await explore(false, 'mobile');
    const scroll = r.book.anomalies().find((a) => a.type === 'horizontal-scroll');
    expect(scroll).toMatchObject({ route: '/wide', severity: 'major' });
    expect(scroll!.screenshots.some((f) => f.endsWith('-full.png'))).toBe(true);
    expect(r.book.anomalies().some((a) => a.action.startsWith('tap '))).toBe(true);
    expect(r.app.hits.deleteAccount).toBe(0);
  });

  it('user HTML typed into a field and rendered as markup', async () => {
    const r = await explore(false, 'desktop', {
      edgeRate: 1,
      home: 'BOARDS',
      maxActions: 80,
      prng: createPrng(1),
    });
    expect(types(r.book)).toContain('html-injected');
    const h = await explore(true, 'desktop', {
      edgeRate: 1,
      home: 'BOARDS',
      maxActions: 80,
      prng: createPrng(1),
    });
    expect(types(h.book)).not.toContain('html-injected');
  });

  it('the healthy twin: no anomaly at all on either device', async () => {
    for (const d of ['desktop', 'mobile'] as const) {
      const r = await explore(true, d);
      expect(r.book.anomalies().map((a) => `${a.type}: ${a.message}`)).toEqual([]);
      expect(r.app.hits.deleteAccount).toBe(0);
    }
  });

  it('same seed ⇒ same walk; stops on cancel, on time, and reports a crash as an error', async () => {
    const a = await explore(false, 'desktop', { maxActions: 25 });
    const b = await explore(false, 'desktop', { maxActions: 25 });
    const walk = (x: typeof a) => x.shots.shots.map((s) => `${s.step}:${s.route}:${s.action}`);
    expect(walk(a)).toEqual(walk(b));
    let n = 0;
    expect((await explore(false, 'desktop', { shouldStop: () => ++n > 3 })).result).toMatchObject({
      stoppedBy: 'cancel',
      steps: 3,
    });
    expect((await explore(false, 'desktop', { deadline: 0 })).result).toMatchObject({
      stoppedBy: 'time',
      steps: 0,
    });
    const crash = await explore(false, 'desktop', {
      sleep: async () => {
        throw new Error('sleep broke\nsecond line');
      },
    });
    expect(crash.result).toMatchObject({ stoppedBy: 'error', error: 'sleep broke', steps: 1 });
  });
});

describe('domFindings', () => {
  const empty = {
    url: 'http://x/',
    title: '',
    controls: [],
    modal: false,
    viewport: { width: 400, height: 800 },
    docWidth: 400,
    offscreen: [],
    textOverflow: [],
    smallTargets: [],
    unnamed: [],
    imgNoAlt: [],
    rawKeys: [],
    htmlInjected: [],
    notFound: false,
  };
  it('reports small targets and horizontal scroll on touch devices only', () => {
    const scan = { ...empty, docWidth: 900, smallTargets: ['button "x" 10×10'] };
    expect(domFindings(scan, true).map((f) => f.type)).toEqual([
      'horizontal-scroll',
      'small-target',
    ]);
    expect(domFindings(scan, false)).toEqual([]);
    expect(domFindings(empty, true)).toEqual([]);
  });
});

describe('ExplorerSession: the other detectors, missions, modals', () => {
  const extras = { home: 'EXTRAS', slowMs: 800, trapSteps: 6, staleSteps: 4, maxActions: 60 };
  it('slow action, 401 mid-session, console error, trap; 402 is information', async () => {
    const r = await explore(false, 'desktop', { ...extras, prng: createPrng(3) });
    const found = types(r.book);
    for (const t of ['slow', 'http-unexpected-4xx', 'console-error', 'trap'] as const)
      expect(found, [...found].join()).toContain(t);
    expect(r.book.infoList().some((i) => i.type === 'paywall' && i.message.includes('402'))).toBe(
      true,
    );
    expect(r.actions.some((a) => a.startsWith('select "Sort"'))).toBe(true);
    expect(r.actions.some((a) => a.startsWith('drag "Card one"'))).toBe(true);
    const h = await explore(true, 'desktop', { ...extras, prng: createPrng(3) });
    expect(h.book.anomalies().map((a) => a.message)).toEqual([]);
    expect(h.actions).toContain('close modal');
  });

  it('a control that cannot be clicked is given up, not fatal', async () => {
    const r = await explore(false, 'desktop', {
      home: 'COVERED',
      maxActions: 2,
      actionTimeoutMs: 200,
    });
    expect(r.result).toMatchObject({ steps: 2, stoppedBy: 'budget', error: null });
    expect(r.actions[0]).toBe('click button "Covered"');
  });

  it('chains missions; screenshots are bounded', async () => {
    const seen: string[] = [];
    let livePage: import('playwright').Page | undefined;
    const r = await explore(
      true,
      'desktop',
      {
        mission: async (id) => {
          seen.push(id);
          // A page error without a stack (a thrown string): still an anomaly, empty excerpt.
          // (Playwright's Page is an EventEmitter; its typings do not expose emit.)
          const emitter = livePage as unknown as { emit(e: string, v: unknown): void };
          if (seen.length === 1) emitter.emit('pageerror', { message: 'no stack here' });
          return seen.length % 2 === 0;
        },
        shots: new ShotBook(mkdtempSync(join(tmpdir(), 'explore-')), 1),
        // Defaults: the pause and action timeout the worker uses.
        pause: undefined,
        actionTimeoutMs: undefined,
      },
      (page) => (livePage = page),
    );
    expect(seen.length).toBeGreaterThan(0);
    const missions = r.book.infoList().filter((i) => i.type === 'mission');
    expect(missions.some((m) => m.message.endsWith('done'))).toBe(true);
    expect(r.shots.shots).toHaveLength(1);
    expect(r.book.anomalies().find((a) => a.message === 'no stack here')).toMatchObject({
      excerpt: '',
    });
  });
});
