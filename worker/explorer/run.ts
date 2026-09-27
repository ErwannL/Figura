import { devices, type Browser, type BrowserContextOptions } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRow } from '../../app/db/runs.js';
import { heartbeat, isCancelRequested, setProgress, transition } from '../../app/db/runs.js';
import { saveReport } from '../../app/db/misc.js';
import {
  EXPLORER_DEFAULTS,
  EXPLORER_DEVICES,
  planSessions,
  type DeviceKey,
  type ExplorerConfig,
  type SessionPlan,
} from '../../shared/explorer.js';
import type { Catalogue } from '../../shared/catalogue-schema.js';
import type { Persona } from '../../shared/persona-schema.js';
import { createPrng } from '../../shared/prng.js';
import type { EffectiveTarget } from '../../shared/targets.js';
import { BrowserDriver } from '../drivers/browser-driver.js';
import { newCredentials } from '../modes.js';
import { Replayer } from '../replay.js';
import type { WorkerConfig, WorkerDeps } from '../runner.js';
import type { OrqeaClient, TargetInfo } from '../target/client.js';
import { AnomalyBook } from './anomalies.js';
import { SEED_USE_CASES, knownIn, useCase, type MissionId } from './missions.js';
import { buildExploreReport, type ExploreReport } from './report.js';
import { ExplorerSession, type SessionResult } from './session.js';
import { ShotBook } from './shots.js';

export interface ExplorePrepared {
  client: Pick<OrqeaClient, 'runHeader' | 'requestVerifyUrl'>;
  target: EffectiveTarget;
  info: TargetInfo;
}

/** Context options of an explorer device: its Playwright profile, or its viewport. */
export function deviceContext(key: DeviceKey): BrowserContextOptions {
  const d = EXPLORER_DEVICES[key];
  if (d.profile === null) return { viewport: d.viewport, isMobile: false, hasTouch: false };
  const { defaultBrowserType: _ignored, ...profile } = devices[
    d.profile
  ] as (typeof devices)[string];
  return profile;
}

/** The explorer persona: a catalogue persona's traits, English, on the session's device. */
export function explorerPersona(all: Persona[], plan: SessionPlan): Persona {
  const base = all.find((p) => p.locale === 'en') ?? (all[0] as Persona);
  const { assistive: _none, ...traits } = base;
  return {
    ...traits,
    id: `explorer-${plan.device}-${plan.slot}`,
    displayName: `Explorer ${plan.device} ${plan.slot + 1}`,
    locale: 'en',
    device: plan.device === 'desktop' ? 'desktop' : 'mobile',
    // Cookie banners are refused: an explorer never consents to more than it needs.
    privacyConcern: 1,
  };
}

/** The API origin as the page sees it (the public origin a rewrite serves it from). */
export function publicApiOrigin(target: EffectiveTarget): string {
  const api = new URL(target.api).origin;
  return Object.entries(target.rewrite).find(([, to]) => to === api)?.[0] ?? api;
}

/** A mission: its catalogue prerequisites, then the use case; any failure is just "not done". */
export function missionRunner(
  r: Pick<Replayer, 'prerequisites' | 'attempt'>,
  catalogue: Catalogue,
) {
  return async (id: MissionId): Promise<boolean> => {
    try {
      await r.prerequisites(id);
      return (await r.attempt(useCase(catalogue, id))).ok;
    } catch {
      return false;
    }
  };
}

interface Live {
  sessions: Record<string, { device: DeviceKey; slot: number; step: number; states: number }>;
  lastScreenshot: string | null;
  lastAction: string | null;
}

class ExploreRun {
  private stop = false;
  private readonly book = new AnomalyBook();
  private readonly shots: ShotBook;
  private readonly live: Live = { sessions: {}, lastScreenshot: null, lastAction: null };
  private readonly params: ExplorerConfig;

  constructor(
    private readonly run: RunRow,
    private readonly cfg: WorkerConfig,
    private readonly deps: WorkerDeps,
    private readonly p: ExplorePrepared,
  ) {
    this.params = run.config.explorer as ExplorerConfig;
    const dir = join(cfg.screenshotsDir, run.id);
    mkdirSync(dir, { recursive: true });
    this.shots = new ShotBook(dir);
  }

  progress(): Record<string, unknown> {
    const sessions = Object.values(this.live.sessions);
    return {
      sessions,
      states: sessions.reduce((n, s) => n + s.states, 0),
      anomalies: this.book.size,
      lastScreenshot: this.live.lastScreenshot,
      lastAction: this.live.lastAction,
    };
  }

  async execute(): Promise<{ report: ExploreReport; cancelled: boolean }> {
    const started = Date.now();
    const browser = await this.deps.launch();
    // A database hiccup must not crash the worker: the next tick tries again.
    const poll = setInterval(() => {
      void isCancelRequested(this.deps.db, this.run.id).then(
        (v) => (this.stop = this.stop || v),
        () => undefined,
      );
      void setProgress(this.deps.db, this.run.id, this.progress()).catch(() => undefined);
    }, this.cfg.cancelPollMs);
    let sessions: (SessionResult & { account: string })[];
    try {
      // At most 3 sessions (schema cap), all at once, each in its own browser context.
      sessions = await Promise.all(
        planSessions(this.params).map((plan) => this.session(browser, plan)),
      );
    } finally {
      clearInterval(poll);
      await browser.close();
    }
    await setProgress(this.deps.db, this.run.id, this.progress());
    await heartbeat(this.deps.db, this.run.id);
    const report = buildExploreReport({
      runId: this.run.id,
      seed: this.run.seed,
      params: this.params,
      durationMs: Date.now() - started,
      sessions,
      book: this.book,
      shots: this.shots.shots,
    });
    await saveReport(this.deps.db, this.run.id, 'explore', report);
    return { report, cancelled: this.stop };
  }

  private async session(
    browser: Browser,
    plan: SessionPlan,
  ): Promise<SessionResult & { account: string }> {
    const { target } = this.p;
    const persona = explorerPersona(this.deps.data.personas, plan);
    const creds = newCredentials(this.run.id)(persona);
    const key = `${plan.device}#${plan.slot}`;
    this.live.sessions[key] = { device: plan.device, slot: plan.slot, step: 0, states: 0 };
    const driver = await BrowserDriver.open(browser, persona, {
      baseUrl: target.browserBase,
      apiOrigin: new URL(target.api).origin,
      rewrite: target.rewrite,
      runHeader: () => this.p.client.runHeader(),
      screenshotDir: null,
      stepTimeoutMs: this.cfg.stepTimeoutMs,
      commonUi: this.deps.data.commonUi,
      context: deviceContext(plan.device),
    });
    const catalogue = this.deps.data.catalogue;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const r = new Replayer(
      this.run.id,
      persona,
      driver,
      {
        catalogue,
        requestVerifyUrl: (e) => this.p.client.requestVerifyUrl(e),
        sleep,
      },
      creds,
      knownIn(catalogue),
    );
    const base = { device: plan.device, slot: plan.slot, account: creds.email };
    try {
      try {
        await r.signedIn();
        if (this.params.seedData) for (const id of SEED_USE_CASES) await r.setup(id);
      } catch (e) {
        const error = `setup: ${(e as Error).message.split('\n')[0]}`;
        return { ...base, steps: 0, states: 0, stoppedBy: 'error', routes: {}, error };
      }
      const result = await this.explore(driver, plan, r, sleep);
      return { ...result, account: creds.email };
    } finally {
      await driver.close();
    }
  }

  private explore(
    driver: BrowserDriver,
    plan: SessionPlan,
    r: Replayer,
    sleep: (ms: number) => Promise<void>,
  ) {
    const page = driver.currentPage;
    const key = `${plan.device}#${plan.slot}`;
    const catalogue = this.deps.data.catalogue;
    const mission = missionRunner(r, catalogue);
    return new ExplorerSession(page, {
      runId: this.run.id,
      device: plan.device,
      slot: plan.slot,
      prng: createPrng(this.run.seed).fork(key),
      origin: new URL(this.p.target.browserBase).origin,
      apiOrigin: publicApiOrigin(this.p.target),
      home: page.url(),
      touch: EXPLORER_DEVICES[plan.device].touch,
      maxActions: plan.maxActions,
      deadline: Date.now() + this.params.maxMinutes * 60_000,
      clumsiness: this.params.clumsiness,
      book: this.book,
      shots: this.shots,
      now: Date.now,
      sleep,
      shouldStop: () => this.stop,
      mission,
      onStep: (s) => {
        this.live.sessions[key] = {
          device: plan.device,
          slot: plan.slot,
          step: s.step,
          states: s.states,
        };
        this.live.lastScreenshot = s.lastShot;
        this.live.lastAction = `${key}: ${s.action}`;
      },
      pause: this.cfg.explorerPause ?? {
        min: EXPLORER_DEFAULTS.minPauseMs,
        max: EXPLORER_DEFAULTS.maxPauseMs,
      },
      actionTimeoutMs: this.cfg.stepTimeoutMs,
    }).run();
  }
}

/** running → sessions in parallel → report. Cleanup is the caller's `finish()` (always). */
export async function exploreRun(
  run: RunRow,
  cfg: WorkerConfig,
  deps: WorkerDeps,
  p: ExplorePrepared,
): Promise<{ report: ExploreReport; cancelled: boolean }> {
  await transition(deps.db, run.id, 'running', cfg.workerId, null, {
    catalogue_version: deps.data.catalogue.version,
    weights_version: deps.data.weights.version,
    target_version: p.info.version,
  });
  return new ExploreRun(run, cfg, deps, p).execute();
}
