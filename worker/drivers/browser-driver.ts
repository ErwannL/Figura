import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Locator,
  Page,
  Response,
  Route,
} from 'playwright';
import { join } from 'node:path';
import { emptyFacts, mergeFacts, type Facts } from '../../shared/facts.js';
import type { UiStep, UiTarget, UseCase } from '../../shared/catalogue-schema.js';
import type { CommonUi } from '../../shared/common-ui.js';
import { VIEWPORTS, type Persona } from '../../shared/persona-schema.js';
import { CAPTCHA_HEADER, RUN_HEADER } from '../../shared/synthetic.js';
import { applyMistakes, skipsStep } from '../engine/mistakes.js';
import { fillTemplate } from '../engine/template.js';
import type { ApiCall, AttemptContext, Driver, Paywall, StepOutcome } from '../engine/types.js';
import { measureScript, type PageMeasure } from './measure.js';

export interface BrowserDriverOptions {
  /** What the persona opens (Orqea's public web origin). */
  baseUrl: string;
  /** Orqea's API origin as reached from here: only requests to it carry X-Synthetic-Run. */
  apiOrigin: string;
  /** Public origin → reachable origin (see shared/targets.ts). */
  rewrite: Record<string, string>;
  runHeader: () => string;
  screenshotDir: string | null;
  stepTimeoutMs: number;
  commonUi: CommonUi;
  /** Explorer devices: a Playwright device profile or viewport, over the persona's defaults. */
  context?: BrowserContextOptions;
}

/**
 * Where the browser's request really goes. The page keeps seeing the public origin (it is not a
 * redirect); the run header goes only to Orqea's API, never to a third party.
 */
export function routeRequest(
  url: string,
  o: { apiOrigin: string; rewrite: Record<string, string> },
): { url: string; rewritten: boolean; toApi: boolean } {
  const from = new URL(url).origin;
  const to = o.rewrite[from];
  const final = to === undefined ? url : to + url.slice(from.length);
  return { url: final, rewritten: to !== undefined, toApi: new URL(final).origin === o.apiOrigin };
}

/** Last steps after which nothing is left in flight. */
const SETTLED: Record<string, true> = {
  expect: true,
  expectText: true,
  goto: true,
  openVerifyUrl: true,
};

class StepFailure extends Error {
  constructor(
    message: string,
    readonly role: string | null,
    /** No HTTP response at all (timeout, refused, DNS): the target, not the persona's journey. */
    readonly unreachable = false,
  ) {
    super(message);
  }
}

/** Drives the real web app like the persona would: roles and accessible names only. */
export class BrowserDriver implements Driver {
  private facts: Facts = emptyFacts();
  private calls: ApiCall[] = [];
  private paywall: Paywall | null = null;
  private pending: Promise<void>[] = [];
  private measuredUrl = '';
  private navStatus: number | null = null;

  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly persona: Persona,
    private readonly opts: BrowserDriverOptions,
  ) {
    page.on('response', (r) => this.onResponse(r));
    page.on('requestfailed', () => {
      this.facts.networkErrors += 1;
    });
  }

  static async open(
    browser: Browser,
    persona: Persona,
    opts: BrowserDriverOptions,
  ): Promise<BrowserDriver> {
    const vp = VIEWPORTS[persona.device];
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.isMobile,
      hasTouch: vp.hasTouch,
      locale: persona.locale === 'fr' ? 'fr-FR' : 'en-GB',
      timezoneId: persona.timezone,
      reducedMotion: 'reduce',
      ...opts.context,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(opts.stepTimeoutMs);
    const driver = new BrowserDriver(context, page, persona, opts);
    await context.route('**/*', (route) => driver.onRoute(route));
    return driver;
  }

  private async onRoute(route: Route): Promise<void> {
    const req = route.request();
    const r = routeRequest(req.url(), this.opts);
    if (!r.rewritten && !r.toApi) return route.continue();
    // A fresh header per request: it is valid for 300 s and a session can outlast that.
    const headers = r.toApi ? { ...req.headers(), [RUN_HEADER]: this.opts.runHeader() } : undefined;
    return route.continue({ url: r.rewritten ? r.url : undefined, headers });
  }

  private onResponse(r: Response): void {
    const url = new URL(r.url());
    if (r.headers()[CAPTCHA_HEADER] === '1') this.facts.captcha = true;
    if (r.status() >= 500) this.facts.networkErrors += 1;
    if (url.pathname.startsWith('/api')) {
      // Ids out of the path: Orqea's are integers, the old fake's were "b12"-like.
      const path = url.pathname.replace(/\/(?:\d+|[a-z]+\d[0-9a-z]*)(?=\/|$)/g, '/:id');
      this.calls.push({
        method: r.request().method(),
        path,
        status: r.status(),
        ms: Math.round(r.request().timing().responseEnd),
      });
    }
    if (r.status() === 402) {
      this.pending.push(
        r.json().then(
          (b: Record<string, unknown>) => {
            this.paywall = {
              code: String(b.code ?? 'PAYWALL'),
              featureKey: String(b.feature ?? b.limitKey ?? 'unknown'),
            };
          },
          () => {
            this.paywall = { code: 'PAYWALL', featureKey: 'unknown' };
          },
        ),
      );
    }
  }

  async attempt(useCase: UseCase, ctx: AttemptContext): Promise<StepOutcome> {
    const started = Date.now();
    this.facts = emptyFacts();
    this.calls = [];
    this.paywall = null;
    this.pending = [];
    this.navStatus = null;
    const pages: string[] = [];
    let error: string | null = null;
    let unreachable = false;
    try {
      for (const [i, step] of useCase.ui.entries()) await this.run(step, i, ctx, pages);
      // A use case that ends on an action (e.g. "Choose Pro"): let the navigation it started land
      // before the next use case navigates, as a person would wait for the page.
      if (!(useCase.ui.at(-1)!.action in SETTLED)) await this.settleNetwork();
    } catch (e) {
      const failure = e as StepFailure;
      error = failure.message;
      unreachable = failure.unreachable === true;
      if (failure.role)
        this.facts.targetUnnamed = (await this.measure()).unnamedByRole[failure.role] !== undefined;
    }
    await Promise.all(this.pending);
    // Where a click left the persona (e.g. the new board's page) counts as a page seen too.
    const here = new URL(this.page.url()).pathname;
    if (pages.at(-1) !== here) pages.push(here);
    this.absorb(await this.measure());
    this.facts.paywall = this.paywall !== null;
    // The persona's time, not Figura's: measured before the evidence screenshot.
    const wallMs = Date.now() - started;
    const screenshot = await this.screenshot(ctx.label);
    return {
      ok: error === null,
      facts: this.facts,
      error,
      paywall: this.paywall,
      screenshot,
      apiCalls: this.calls,
      wallMs,
      navigationStatus: this.navStatus,
      unreachable,
      captured: {},
      pages,
    };
  }

  private async run(
    step: UiStep,
    index: number,
    ctx: AttemptContext,
    pages: string[],
  ): Promise<void> {
    if (step.action === 'goto' || step.action === 'openVerifyUrl') {
      const url =
        step.action === 'goto'
          ? this.opts.baseUrl + fillTemplate(step.path, ctx.vars)
          : (ctx.vars.verifyUrl as string);
      const t0 = Date.now();
      // DOMContentLoaded, not load: a dev server's hot-reload socket delays `load` indefinitely;
      // every later step waits for its own control anyway.
      const response = await this.page
        .goto(url, { waitUntil: 'domcontentloaded' })
        .catch((e: Error) => {
          throw new StepFailure(`step ${index + 1}: ${e.message.split('\n')[0]}`, null, true);
        });
      this.navStatus = response?.status() ?? null;
      this.facts.timeToInteractiveMs = Math.max(this.facts.timeToInteractiveMs, Date.now() - t0);
      pages.push(new URL(this.page.url()).pathname);
      this.measuredUrl = this.page.url();
      this.absorb(await this.measure());
      await this.dismissCookies();
      return;
    }
    if (step.action === 'press') {
      await this.page.keyboard.press(step.key);
      this.facts.clicksToGoal += 1;
      return;
    }
    if (step.action === 'check' && skipsStep(step.target.role, ctx.mistakes)) return;
    if (this.page.url() !== this.measuredUrl) {
      // A click navigated: measure the new page the persona is now looking at.
      this.measuredUrl = this.page.url();
      this.absorb(await this.measure());
    }
    if (step.action === 'expectText') {
      const text = (l: 'en' | 'fr') => fillTemplate(step.text[l], ctx.vars);
      const byText = (l: 'en' | 'fr') =>
        step.role
          ? this.page.getByRole(step.role as Parameters<Page['getByRole']>[0]).filter({
              hasText: text(l),
            })
          : this.page.getByText(text(l));
      await this.settle(byText, index, ctx, `"${text(ctx.persona.locale)}"`, null);
      return;
    }
    const target = await this.find(step.target, index, ctx);
    // find() only returns visible controls, so an "expect" step is complete here.
    if (step.action === 'expect') return;
    await this.act(step, target, ctx, index);
  }

  private async act(
    step: Exclude<UiStep, { action: 'goto' | 'openVerifyUrl' | 'press' | 'expect' | 'expectText' }>,
    target: Locator,
    ctx: AttemptContext,
    index: number,
  ): Promise<void> {
    const keyboard = this.persona.assistive?.keyboardOnly === true;
    if (step.action === 'fill') {
      await target.fill(
        applyMistakes(step.value, fillTemplate(step.value, ctx.vars), ctx.mistakes),
      );
    } else if (step.action === 'select') {
      await target.selectOption(fillTemplate(step.value, ctx.vars));
    } else if (step.action === 'drag') {
      if (keyboard)
        throw new StepFailure(`step ${index + 1}: drag and drop has no keyboard alternative`, null);
      await target.dragTo(await this.find(step.to, index, ctx));
    } else if (keyboard) {
      await target.focus();
      await this.page.keyboard.press(step.action === 'check' ? 'Space' : 'Enter');
    } else if (step.action === 'check') {
      await target.check();
    } else {
      await target.click();
    }
    this.facts.clicksToGoal += 1;
  }

  private locate(target: UiTarget, name: string): Locator {
    const exact = target.exact ?? false;
    if (target.role === 'password') {
      return this.page
        .getByLabel(name, { exact })
        .and(this.page.locator('input[type="password"]'))
        .first();
    }
    return this.page
      .getByRole(target.role as Parameters<Page['getByRole']>[0], { name, exact })
      .first();
  }

  /** Finds a control by role + accessible name in the persona's language, else in the other one. */
  private find(target: UiTarget, index: number, ctx: AttemptContext): Promise<Locator> {
    const name = (l: 'en' | 'fr') => fillTemplate(target.name[l], ctx.vars);
    return this.settle(
      (l) => this.locate(target, name(l)),
      index,
      ctx,
      `${target.role} named "${name(ctx.persona.locale)}"`,
      target.role,
    );
  }

  /** Waits for the persona's-language locator, the other language's, or a blocking alert. */
  private async settle(
    locator: (lang: 'en' | 'fr') => Locator,
    index: number,
    ctx: AttemptContext,
    what: string,
    role: string | null,
  ): Promise<Locator> {
    const own = ctx.persona.locale;
    const other = own === 'fr' ? 'en' : 'fr';
    const mine = locator(own).first();
    const theirs = locator(other).first();
    const blocker = this.page.getByRole('alert').or(this.page.getByRole('alertdialog')).first();
    try {
      await mine.or(theirs).or(blocker).first().waitFor({ state: 'visible' });
    } catch {
      throw new StepFailure(`step ${index + 1}: no ${what}`, role);
    }
    if (await mine.isVisible()) return mine;
    if (await theirs.isVisible()) {
      this.facts.foreignText = true;
      return theirs;
    }
    await Promise.all(this.pending);
    const blocked = this.paywall
      ? 'paywall shown'
      : `error shown: ${(await blocker.innerText()).trim()}`;
    throw new StepFailure(`step ${index + 1}: ${blocked}`, null);
  }

  private async settleNetwork(): Promise<void> {
    await this.page
      .waitForLoadState('networkidle', { timeout: this.opts.stepTimeoutMs })
      .catch(() => {
        // Never idle (polling, long requests): carry on, the step itself succeeded.
      });
  }

  private async dismissCookies(): Promise<void> {
    const ui = this.opts.commonUi;
    const own = this.persona.locale;
    const other = own === 'fr' ? 'en' : 'fr';
    const dialog = this.page.getByRole('dialog', { name: ui.cookieDialog[own] });
    if (!(await dialog.isVisible())) return;
    const choice = this.persona.privacyConcern >= 0.5 ? ui.cookieReject : ui.cookieAccept;
    // Same fallback as find(): an untranslated banner is still dismissed, but noticed.
    const mine = dialog.getByRole('button', { name: choice[own] });
    const button = (await mine.isVisible())
      ? mine
      : dialog.getByRole('button', { name: choice[other] });
    if (button !== mine) this.facts.foreignText = true;
    await button.click();
    this.facts.clicksToGoal += 1;
  }

  private async measure(): Promise<PageMeasure> {
    try {
      return (await this.page.evaluate(measureScript(this.persona.locale))) as PageMeasure;
    } catch {
      // The page was navigating (redirect, error page): measure once it has settled.
      await this.page.waitForLoadState('load');
      return (await this.page.evaluate(measureScript(this.persona.locale))) as PageMeasure;
    }
  }

  private absorb(m: PageMeasure): void {
    const f = emptyFacts({
      visibleFields: m.visibleFields,
      requiredFields: m.requiredFields,
      visibleWords: m.visibleWords,
      unnamedControls: m.unnamedControls,
      captcha: m.captcha,
      cookieBanner: m.cookieBanner,
      termsCheckbox: m.termsCheckbox,
      horizontalOverflow: m.horizontalOverflow,
      foreignText: m.foreignText,
      validationErrors: m.validationErrors,
      unclearErrors: m.unclearErrors,
    });
    // Alerts are a snapshot of the current page, not a running total.
    this.facts = mergeFacts({ ...this.facts, validationErrors: 0, unclearErrors: 0 }, f);
  }

  private async screenshot(label: string): Promise<string | null> {
    if (!this.opts.screenshotDir) return null;
    const file = `${label.replace(/[^a-z0-9-]/gi, '_')}.jpg`;
    await this.page.screenshot({
      path: join(this.opts.screenshotDir, file),
      type: 'jpeg',
      quality: 50,
    });
    return file;
  }

  /** The persona's page, for the explorer that continues where a use case left it. */
  get currentPage(): Page {
    return this.page;
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
