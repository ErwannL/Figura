import type { Page, Request, Response } from 'playwright';
import {
  EXPLORER_CAPS,
  EXPLORER_DEFAULTS,
  type AnomalyType,
  type DeviceKey,
} from '../../shared/explorer.js';
import type { Prng } from '../../shared/prng.js';
import { AnomalyBook, safeUrl } from './anomalies.js';
import { actionKey, fingerprint, normalizeRoute } from './fingerprint.js';
import { forbiddenRule, type Control } from './forbidden.js';
import { pickMission, type MissionId } from './missions.js';
import { scanScript, type Scan } from './page-scan.js';
import type { ShotBook } from './shots.js';
import { StateModel, TEXT_ROLES, decide } from './strategy.js';
import { fieldValue, valueKind } from './values.js';

export interface SessionOptions {
  runId: string;
  device: DeviceKey;
  slot: number;
  prng: Prng;
  /** Public origin of the web app: the only origin the explorer may navigate to. */
  origin: string;
  /** Orqea's API origin as the page sees it (401s there are anomalies). */
  apiOrigin: string;
  /** Where "recover" goes. */
  home: string;
  touch: boolean;
  maxActions: number;
  deadline: number;
  clumsiness: number;
  book: AnomalyBook;
  shots: ShotBook;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  shouldStop: () => boolean;
  /** Runs a mission (catalogue use case); absent: free exploration only. */
  mission?: (id: MissionId) => Promise<boolean>;
  onStep?: (p: { step: number; states: number; lastShot: string | null; action: string }) => void;
  staleSteps?: number;
  trapSteps?: number;
  slowMs?: number;
  pause?: { min: number; max: number };
  actionTimeoutMs?: number;
  /** Share of edge-case values typed into fields (default 0.2). */
  edgeRate?: number;
}

export type StopReason = 'budget' | 'time' | 'cancel' | 'error';

export interface SessionResult {
  device: DeviceKey;
  slot: number;
  steps: number;
  states: number;
  stoppedBy: StopReason;
  routes: Record<string, number>;
  error: string | null;
}

/** Request types an interface waits on (not long-lived streams). */
const WAITED_ON = new Set(['document', 'fetch', 'xhr']);

interface Pending {
  type: AnomalyType;
  message: string;
  excerpt: string;
}

/** One explorer on one page: scan → detect → decide → act, until a budget runs out. */
export class ExplorerSession {
  private model = new StateModel();
  private pending: Pending[] = [];
  private filled = new Set<number>();
  private form: number | undefined;
  private routes: Record<string, number> = {};
  private step = 0;
  private lastAction = 'open';
  private lastWasLink = false;
  private lastStateShot: string | null = null;
  private lastShot: string | null = null;
  private trapped = new Set<string>();
  /** Requests the interface is waiting on (a new document abandons the old one's). */
  private inflight = new Set<Request>();
  private readonly session: string;

  constructor(
    private readonly page: Page,
    private readonly o: SessionOptions,
  ) {
    this.session = `${o.device}#${o.slot}`;
  }

  private get timeout() {
    return this.o.actionTimeoutMs ?? 5000;
  }

  private get staleSteps() {
    return this.o.staleSteps ?? 8;
  }

  /** Browser events become pending sightings, attached to the step that caused them. */
  private listen(): void {
    const p = this.page;
    p.on('pageerror', (e) =>
      this.pending.push({
        type: 'js-error',
        message: e.message,
        excerpt: (e.stack ?? '').split('\n').slice(0, 4).join('\n'),
      }),
    );
    p.on('console', (m) => {
      // Failed loads are already reported from the response itself.
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource'))
        this.pending.push({ type: 'console-error', message: m.text(), excerpt: m.location().url });
    });
    p.on('response', (r) => this.onResponse(r));
    p.on('request', (r) => {
      if (WAITED_ON.has(r.resourceType())) this.inflight.add(r);
    });
    p.on('requestfinished', (r) => this.inflight.delete(r));
    p.on('requestfailed', (r) => this.inflight.delete(r));
    p.on('framenavigated', (f) => {
      if (f === p.mainFrame()) this.inflight.clear();
    });
    p.on('dialog', (d) => void d.dismiss().catch(() => undefined));
    // A link opening a tab: the explorer stays on its page.
    p.context().on('page', (other) => void other.close().catch(() => undefined));
  }

  private onResponse(r: Response): void {
    const req = r.request();
    const status = r.status();
    const what = `${req.method()} ${safeUrl(r.url())} → ${status}`;
    const origin = new URL(r.url()).origin;
    if (status >= 500) this.pending.push({ type: 'http-5xx', message: what, excerpt: what });
    else if (status === 401 && origin === this.o.apiOrigin)
      this.pending.push({ type: 'http-unexpected-4xx', message: what, excerpt: what });
    else if (status === 402) this.o.book.info('paywall', this.route(), what);
    else if (status === 404 && req.isNavigationRequest() && req.frame() === this.page.mainFrame())
      this.pending.push({ type: 'not-found', message: what, excerpt: `after ${this.lastAction}` });
  }

  /** Navigations leaving the target are aborted and recorded (information, not an anomaly). */
  private async guardOrigin(): Promise<void> {
    await this.page.route('**/*', (route) => {
      const req: Request = route.request();
      const target = new URL(req.url());
      const leaving =
        req.isNavigationRequest() &&
        req.frame() === this.page.mainFrame() &&
        /^https?:$/.test(target.protocol) &&
        target.origin !== this.o.origin;
      if (!leaving) return route.fallback();
      this.o.book.info('external-navigation', this.route(), safeUrl(req.url()));
      // 204 to a navigation cancels it and leaves the page as it was (abort shows an error page).
      return route.fulfill({ status: 204, body: '' });
    });
  }

  private route(): string {
    return normalizeRoute(this.page.url());
  }

  async run(): Promise<SessionResult> {
    this.listen();
    await this.guardOrigin();
    let stoppedBy: StopReason = 'budget';
    let error: string | null = null;
    try {
      while (this.step < this.o.maxActions) {
        if (this.o.shouldStop()) {
          stoppedBy = 'cancel';
          break;
        }
        if (this.o.now() >= this.o.deadline) {
          stoppedBy = 'time';
          break;
        }
        this.step += 1;
        await this.oneStep();
        this.o.onStep?.({
          step: this.step,
          states: this.model.states,
          lastShot: this.lastShot,
          action: this.lastAction,
        });
        const pause = this.o.pause ?? {
          min: EXPLORER_DEFAULTS.minPauseMs,
          max: EXPLORER_DEFAULTS.maxPauseMs,
        };
        await this.o.sleep(this.o.prng.int(pause.min, pause.max));
      }
    } catch (e) {
      stoppedBy = 'error';
      error = (e as Error).message.split('\n')[0] as string;
    }
    return {
      device: this.o.device,
      slot: this.o.slot,
      steps: this.step,
      states: this.model.states,
      stoppedBy,
      routes: this.routes,
      error,
    };
  }

  private async scan(): Promise<Scan> {
    try {
      return (await this.page.evaluate(scanScript())) as Scan;
    } catch {
      // Navigating: scan once the page has settled.
      await this.page.waitForLoadState('domcontentloaded');
      return (await this.page.evaluate(scanScript())) as Scan;
    }
  }

  private async oneStep(): Promise<void> {
    const scan = await this.scan();
    const state = fingerprint(scan);
    const route = normalizeRoute(scan.url);
    this.routes[route] = (this.routes[route] ?? 0) + 1;
    const isNew = this.model.arrive(state);
    // Another screen: its fields are empty again (indexes are per scan).
    if (this.model.sameState === 0) {
      this.filled.clear();
      this.form = undefined;
    }
    if (isNew && this.o.shots.firstSight(this.o.device, state)) {
      this.lastStateShot = await this.shoot('state', route, state);
    }
    await this.detect(scan, route, state, isNew);
    if (this.model.sameState >= (this.o.trapSteps ?? 12) && scan.modal) {
      if (!this.trapped.has(state)) {
        this.trapped.add(state);
        const message = `stuck ${this.model.sameState} steps on a modal`;
        await this.report({ type: 'trap', message, excerpt: scan.title }, route, state);
      }
      return this.recover();
    }
    const mission = this.o.mission ? pickMission(this.o.prng) : null;
    if (mission && this.o.mission) {
      this.lastAction = `mission ${mission}`;
      const ok = await this.o.mission(mission);
      this.o.book.info('mission', route, `${mission}: ${ok ? 'done' : 'failed'}`);
      return;
    }
    const allowed = scan.controls.filter((c) => {
      const rule = forbiddenRule(c, this.o.origin);
      if (rule) this.o.book.info('forbidden-skipped', route, `${rule.key}: ${c.role} "${c.name}"`);
      return rule === null;
    });
    const d = decide(this.o.prng, this.model, state, allowed, {
      modal: scan.modal,
      staleSteps: this.staleSteps,
      filled: this.filled,
      touch: this.o.touch,
      form: this.form,
    });
    if (d.kind === 'act') {
      this.model.tried(state, actionKey(d.control));
      await this.timed(() => this.act(d.control), route, state);
    } else if (d.kind === 'close-modal') {
      this.lastAction = 'close modal';
      await this.closeModal();
      this.model.sinceNew = Math.max(0, this.staleSteps - 2);
    } else await this.recover();
  }

  /** Back to a known state: the home route. */
  private async recover(): Promise<void> {
    this.lastAction = 'recover: home';
    this.lastWasLink = false;
    await this.page.goto(this.o.home, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    this.model.sinceNew = 0;
  }

  /** An action whose UI does not settle within `slowMs` is `slow`. */
  private async timed(fn: () => Promise<void>, route: string, state: string): Promise<void> {
    await fn();
    // The explorer's own waiting (a covered control) is not the interface's slowness.
    const t0 = this.o.now();
    const slowMs = this.o.slowMs ?? EXPLORER_DEFAULTS.slowMs;
    await this.settle(t0 + slowMs + 1000);
    const ms = this.o.now() - t0;
    if (ms > slowMs)
      await this.report(
        { type: 'slow', message: `${this.lastAction} took ${ms} ms`, excerpt: `${ms} ms` },
        route,
        state,
      );
  }

  /** Settled: the document loaded and no request in flight (polled, bounded by `until`). */
  private async settle(until: number): Promise<void> {
    await this.page
      .waitForLoadState('load', { timeout: Math.max(until - this.o.now(), 1) })
      .catch(() => undefined);
    while (this.inflight.size > 0 && this.o.now() < until)
      await new Promise((r) => setTimeout(r, 25));
  }

  private async act(c: Control): Promise<void> {
    const el = this.page.locator(`[data-figura-x="${c.idx}"]`);
    const timeout = this.timeout;
    const p = this.o.prng;
    this.lastWasLink = c.role === 'link';
    try {
      if (TEXT_ROLES.has(c.role)) {
        const kind = valueKind(p, this.o.edgeRate);
        const type = c.tag === 'textarea' ? 'textarea' : c.type;
        this.lastAction = `fill ${c.role} "${c.name}" (${kind})`;
        await el.fill(fieldValue(p, type, kind, this.o.runId), { timeout });
        this.filled.add(c.idx);
        this.form = c.formId >= 0 ? c.formId : undefined;
        return;
      }
      if (c.role === 'combobox' && c.tag === 'select') {
        const n = await el.evaluate((s) => (s as HTMLSelectElement).options.length);
        this.lastAction = `select "${c.name}"`;
        if (n > 0) await el.selectOption({ index: p.int(0, n - 1) }, { timeout });
        return;
      }
      if (c.draggable && p.chance(0.5)) return await this.drag(el, c);
      const clicks = p.chance(this.o.clumsiness) ? p.int(2, EXPLORER_CAPS.clumsyClicks) : 1;
      this.lastAction = `${this.o.touch ? 'tap' : 'click'} ${c.role} "${c.name}"${clicks > 1 ? ` ×${clicks}` : ''}`;
      if (this.o.touch) await el.tap({ timeout });
      else await el.click({ timeout });
      // A clumsy repeat lands where the control was, on whatever is there now.
      const x = c.box.x + c.box.width / 2;
      const y = c.box.y + c.box.height / 2;
      for (let i = 1; i < clicks; i++) {
        if (this.o.touch) await this.page.touchscreen.tap(x, y);
        else await this.page.mouse.click(x, y);
      }
    } catch {
      // Detached, covered or gone: a person would simply try something else.
    }
  }

  /** Drag and drop with the mouse moving in small steps, as a hand would. */
  private async drag(el: ReturnType<Page['locator']>, c: Control): Promise<void> {
    this.lastAction = `drag "${c.name}"`;
    const box = c.box;
    const vp = this.page.viewportSize() as { width: number; height: number };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await el.hover({ timeout: this.timeout });
    await this.page.mouse.down();
    const dx = this.o.prng.int(-200, 300);
    await this.page.mouse.move(
      Math.min(Math.max(x + dx, 1), vp.width - 1),
      y + this.o.prng.int(-20, 60),
      { steps: 12 },
    );
    await this.page.mouse.up();
  }

  private async closeModal(): Promise<void> {
    await this.page.keyboard.press('Escape');
    const close = this.page
      .locator('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]')
      .getByRole('button', { name: /close|cancel|dismiss|^×$|^✕$|^x$/i })
      .first();
    if (await close.isVisible().catch(() => false))
      await close.click({ timeout: 2000 }).catch(() => undefined);
    else await this.page.mouse.click(2, 2).catch(() => undefined);
  }

  private async shoot(
    kind: 'state' | 'after' | 'full',
    route: string,
    state: string,
  ): Promise<string | null> {
    const file = await this.o.shots.take(this.page, {
      session: this.session,
      device: this.o.device,
      step: this.step,
      route,
      fingerprint: state,
      action: this.lastAction,
      kind,
    });
    if (file) this.lastShot = file;
    return file;
  }

  /** Records a sighting; the first of its kind gets its evidence screenshots. */
  private async report(p: Pending, route: string, state: string, full = false): Promise<void> {
    const { anomaly, first } = this.o.book.add({
      ...p,
      route,
      device: this.o.device,
      slot: this.o.slot,
      step: this.step,
      action: this.lastAction,
    });
    if (!first) return;
    const before = this.lastStateShot;
    const after = await this.shoot(full ? 'full' : 'after', route, state);
    anomaly.screenshots = [before, after].filter((f): f is string => f !== null);
  }

  /** DOM detectors on new states, and whatever the browser reported since the last step. */
  private async detect(scan: Scan, route: string, state: string, isNew: boolean): Promise<void> {
    const found: (Pending & { full?: boolean })[] = this.pending.splice(0);
    if (this.lastWasLink && scan.notFound && !found.some((f) => f.type === 'not-found'))
      found.push({
        type: 'not-found',
        message: `NotFound page at ${route}`,
        excerpt: `after ${this.lastAction}`,
      });
    this.lastWasLink = false;
    // Typed markup appears without changing the screen's controls: checked on every step.
    const dom = domFindings(scan, this.o.touch);
    found.push(...(isNew ? dom : dom.filter((f) => f.type === 'html-injected')));
    for (const f of found) await this.report(f, route, state, f.full === true);
  }
}

/** Layout, accessibility, i18n and injection findings of one scan. */
export function domFindings(scan: Scan, touch: boolean): (Pending & { full?: boolean })[] {
  const out: (Pending & { full?: boolean })[] = [];
  const add = (type: AnomalyType, items: string[], full = false) => {
    for (const i of items) out.push({ type, message: i, excerpt: i, full });
  };
  if (touch && scan.docWidth > scan.viewport.width + 1)
    add(
      'horizontal-scroll',
      [`document ${scan.docWidth}px wide in a ${scan.viewport.width}px viewport`],
      true,
    );
  add('offscreen-control', scan.offscreen, true);
  add('text-overflow', scan.textOverflow, true);
  if (touch) add('small-target', scan.smallTargets);
  add('unnamed-control', scan.unnamed);
  add('img-no-alt', scan.imgNoAlt);
  add('raw-i18n-key', scan.rawKeys);
  add(
    'html-injected',
    scan.htmlInjected.map((m) => `<b>${m}</b> rendered as markup`),
  );
  return out;
}
