import { z } from 'zod';

/**
 * Explorer devices (docs/EXPLORATEUR.md). Keys are immutable: they are stored in runs and reports.
 * `profile` names a Playwright device descriptor (resolved by the worker); `viewport` is used when
 * there is none. Shared with the UI, so no Playwright import here.
 */
export const EXPLORER_DEVICES = {
  desktop: {
    label: { en: 'Desktop (1440×900)', fr: 'Ordinateur (1440×900)' },
    profile: null,
    viewport: { width: 1440, height: 900 },
    touch: false,
  },
  tablet: {
    label: { en: 'Tablet (iPad)', fr: 'Tablette (iPad)' },
    profile: 'iPad (gen 7)',
    viewport: null,
    touch: true,
  },
  mobile: {
    label: { en: 'Mobile (Pixel 7)', fr: 'Mobile (Pixel 7)' },
    profile: 'Pixel 7',
    viewport: null,
    touch: true,
  },
} as const;
export type DeviceKey = keyof typeof EXPLORER_DEVICES;
export const DEVICE_KEYS = Object.keys(EXPLORER_DEVICES) as DeviceKey[];

/** Hard caps, enforced by the schema (so by the server), not only by the form. */
export const EXPLORER_CAPS = {
  sessions: 3,
  maxActions: 500,
  maxMinutes: 30,
  clumsiness: 0.2,
  /** Clicks in a row of a clumsy repeated click. */
  clumsyClicks: 3,
} as const;

export const EXPLORER_DEFAULTS = {
  sessions: 1,
  maxActions: 150,
  maxMinutes: 10,
  clumsiness: 0.05,
  /** Pause between two actions, drawn from the session's PRNG. */
  minPauseMs: 400,
  maxPauseMs: 2500,
  /** An action whose UI takes longer than this to settle is `slow`. */
  slowMs: 5000,
} as const;

const deviceKey = z.enum(DEVICE_KEYS as [DeviceKey, ...DeviceKey[]]);

export const explorerConfigSchema = z
  .object({
    devices: z
      .array(deviceKey)
      .min(1)
      .default(['desktop'])
      .transform((d) => [...new Set(d)]),
    sessions: z.number().int().min(1).max(EXPLORER_CAPS.sessions).default(1),
    maxActions: z.number().int().min(1).max(EXPLORER_CAPS.maxActions).default(150),
    maxMinutes: z.number().min(1).max(EXPLORER_CAPS.maxMinutes).default(10),
    seedData: z.boolean().default(false),
    clumsiness: z.number().min(0).max(EXPLORER_CAPS.clumsiness).default(0.05),
    /** Replays one session of an earlier run (same run seed) up to a step. */
    replay: z
      .object({
        device: deviceKey,
        slot: z
          .number()
          .int()
          .min(0)
          .max(EXPLORER_CAPS.sessions - 1),
        untilStep: z.number().int().min(1).max(EXPLORER_CAPS.maxActions),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type ExplorerConfig = z.infer<typeof explorerConfigSchema>;

/** One explorer session: which device, and its slot among that device's sessions. */
export interface SessionPlan {
  device: DeviceKey;
  slot: number;
  maxActions: number;
}

/** Sessions spread round-robin over the ticked devices; a replay is its one session. */
export function planSessions(c: ExplorerConfig): SessionPlan[] {
  if (c.replay)
    return [{ device: c.replay.device, slot: c.replay.slot, maxActions: c.replay.untilStep }];
  return Array.from({ length: c.sessions }, (_, i) => ({
    device: c.devices[i % c.devices.length] as DeviceKey,
    slot: Math.floor(i / c.devices.length),
    maxActions: c.maxActions,
  }));
}

export const SEVERITIES = ['critical', 'major', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Anomaly types and their severity (docs/EXPLORATEUR.md). */
export const ANOMALY_TYPES = {
  'js-error': 'critical',
  'console-error': 'minor',
  'http-5xx': 'critical',
  'http-unexpected-4xx': 'major',
  'not-found': 'major',
  'horizontal-scroll': 'major',
  'offscreen-control': 'minor',
  'text-overflow': 'minor',
  'small-target': 'minor',
  'unnamed-control': 'major',
  'img-no-alt': 'minor',
  'raw-i18n-key': 'major',
  slow: 'major',
  trap: 'major',
  'html-injected': 'critical',
  'cleanup-residual': 'critical',
} as const satisfies Record<string, Severity>;
export type AnomalyType = keyof typeof ANOMALY_TYPES;

/** Recorded, never anomalies: expected paywalls, blocked external navigations, skipped controls. */
export type InfoType = 'paywall' | 'external-navigation' | 'forbidden-skipped' | 'mission';
