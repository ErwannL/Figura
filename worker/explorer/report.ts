import type { DeviceKey, ExplorerConfig } from '../../shared/explorer.js';
import type { CleanupResult } from '../target/client.js';
import type { Anomaly, AnomalyBook, Info } from './anomalies.js';
import type { SessionResult } from './session.js';
import type { Shot } from './shots.js';

export interface ExploreReport {
  type: 'explore';
  runId: string;
  seed: number;
  params: ExplorerConfig;
  durationMs: number;
  sessions: (SessionResult & { account: string })[];
  statesByDevice: Partial<Record<DeviceKey, number>>;
  routes: { route: string; devices: DeviceKey[]; visits: number }[];
  screenshots: Shot[];
  /** Gallery: per route, each device's first screenshot of it (side by side in the UI). */
  gallery: { route: string; shots: Partial<Record<DeviceKey, string>> }[];
  anomalies: (Anomaly & {
    replay: { seed: number; device: DeviceKey; slot: number; untilStep: number };
  })[];
  info: Info[];
  /** Null until cleanup has run (the report is saved again with it). */
  cleanup: CleanupResult | null;
}

export function buildExploreReport(o: {
  runId: string;
  seed: number;
  params: ExplorerConfig;
  durationMs: number;
  sessions: (SessionResult & { account: string })[];
  book: AnomalyBook;
  shots: Shot[];
}): ExploreReport {
  const statesByDevice: Partial<Record<DeviceKey, number>> = {};
  const routes = new Map<string, { devices: Set<DeviceKey>; visits: number }>();
  for (const s of o.sessions) {
    statesByDevice[s.device] = (statesByDevice[s.device] ?? 0) + s.states;
    for (const [route, n] of Object.entries(s.routes)) {
      const r = routes.get(route) ?? { devices: new Set<DeviceKey>(), visits: 0 };
      r.devices.add(s.device);
      r.visits += n;
      routes.set(route, r);
    }
  }
  const gallery = new Map<string, Partial<Record<DeviceKey, string>>>();
  for (const shot of o.shots.filter((s) => s.kind === 'state')) {
    const g = gallery.get(shot.route) ?? {};
    g[shot.device] ??= shot.file;
    gallery.set(shot.route, g);
  }
  return {
    type: 'explore',
    runId: o.runId,
    seed: o.seed,
    params: o.params,
    durationMs: o.durationMs,
    sessions: o.sessions,
    statesByDevice,
    routes: [...routes.entries()]
      .map(([route, r]) => ({ route, devices: [...r.devices], visits: r.visits }))
      .sort((a, b) => b.visits - a.visits),
    screenshots: o.shots,
    gallery: [...gallery.entries()]
      .map(([route, shots]) => ({ route, shots }))
      .sort(
        (a, b) =>
          Object.keys(b.shots).length - Object.keys(a.shots).length ||
          a.route.localeCompare(b.route),
      ),
    anomalies: o.book.anomalies().map((a) => ({
      ...a,
      replay: { seed: o.seed, device: a.device, slot: a.slot, untilStep: a.step },
    })),
    info: o.book.infoList(),
    cleanup: null,
  };
}

/** Adds the cleanup outcome; residual rows are an anomaly of the run itself. */
export function withCleanup(
  report: ExploreReport,
  cleanup: CleanupResult | null,
  error: string | null,
): ExploreReport {
  const out: ExploreReport = { ...report, cleanup };
  const residual = cleanup?.residualRows ?? 0;
  if (residual > 0 || (cleanup === null && error?.startsWith('CLEANUP_FAILED'))) {
    const message =
      residual > 0 ? `${residual} synthetic rows left after cleanup` : (error as string);
    const first = { device: report.params.devices[0] as DeviceKey, slot: 0 };
    out.anomalies = [
      {
        key: `cleanup-residual||${message}`,
        type: 'cleanup-residual',
        severity: 'critical',
        count: 1,
        devices: [],
        route: '',
        step: 0,
        device: first.device,
        slot: first.slot,
        action: 'cleanup',
        message,
        excerpt: JSON.stringify(cleanup),
        screenshots: [],
        replay: { seed: report.seed, device: first.device, slot: first.slot, untilStep: 1 },
      },
      ...report.anomalies,
    ];
  }
  return out;
}
