import { z } from 'zod';

/**
 * Named Orqea targets (`FIGURA_TARGETS`, JSON). The admin console signs the name of the Orqea
 * environment it inspects into the SSO token (`target` claim); Figura resolves it here.
 *
 * - `api`: base URL of Orqea's API as seen from the Figura worker (e.g. `http://backend:5001`).
 * - `web`: base URL of Orqea's web app as seen from the worker (journey mode needs it).
 * - `rewrite`: origin → origin, applied by the persona's browser. Orqea's SPA is built with a public
 *   API origin (`REACT_APP_API_URL=http://localhost:5001`) that is not Orqea inside the worker
 *   container; the browser keeps the public origins (so CORS, cookies and links behave as for a
 *   real user) and only the bytes come from the rewritten origin.
 */
const origin = z
  .string()
  .url()
  .refine((u) => new URL(u).origin === u.replace(/\/$/, ''), 'must be an origin (no path)')
  .transform((u) => new URL(u).origin);

export const targetSpecSchema = z
  .object({
    api: z.string().url(),
    web: z.string().url().optional(),
    rewrite: z.record(origin, origin).default({}),
  })
  .strict();
export type TargetSpec = z.infer<typeof targetSpecSchema>;
export type Targets = Record<string, TargetSpec>;

export const TARGET_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const TARGET_NOT_CONFIGURED = 'TARGET_NOT_CONFIGURED';

const targetsSchema = z.record(z.string().regex(TARGET_NAME), targetSpecSchema);

/** Parses FIGURA_TARGETS; unset or empty = no named target. Throws with the offending path. */
export function parseTargets(json: string | undefined): Targets {
  if (!json || !json.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('FIGURA_TARGETS must be valid JSON');
  }
  const parsed = targetsSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0] as { path: PropertyKey[]; message: string };
    throw new Error(`FIGURA_TARGETS: ${i.path.map(String).join('.')}: ${i.message}`);
  }
  return parsed.data;
}

/** The URL the persona's browser opens: the public origin rewritten to `web`, else `web` itself. */
export function browserBaseUrl(spec: { web: string; rewrite: Record<string, string> }): string {
  const web = new URL(spec.web);
  const pub = Object.entries(spec.rewrite).find(([, to]) => to === web.origin)?.[0];
  return pub ? `${pub}${web.pathname}`.replace(/\/$/, '') : spec.web.replace(/\/$/, '');
}

/** What the operator UI may show of the configured targets (no secrets live here). */
export function publicTargets(targets: Targets) {
  return Object.entries(targets).map(([name, t]) => ({
    name,
    api: t.api,
    web: t.web ?? null,
  }));
}

type RefusalBody = { error: typeof TARGET_NOT_CONFIGURED; issues: string[] };

/**
 * Server side of run creation: a run naming a target gets that target's URLs, whatever the client
 * sent. An unknown name, or a journey run on a target without a web URL, is refused.
 */
export function applyTarget(raw: unknown, targets: Targets): { config: unknown } | RefusalBody {
  if (raw === null || typeof raw !== 'object') return { config: raw };
  const c = raw as Record<string, unknown>;
  if (typeof c.target !== 'string') return { config: raw };
  const spec = targets[c.target];
  const refuse = (why: string): RefusalBody => ({
    error: TARGET_NOT_CONFIGURED,
    issues: [`target: "${c.target as string}" ${why}`],
  });
  if (!spec) return refuse('is not configured in FIGURA_TARGETS');
  if (['journey', 'replay', 'explore'].includes(c.kind as string) && !spec.web)
    return refuse('has no web URL in FIGURA_TARGETS; journey runs drive the web app');
  return { config: { ...c, targetUrl: spec.api, webUrl: spec.web ?? null } };
}

/** Where a run really goes, as the worker sees it. Null when the named target is unknown here. */
export interface EffectiveTarget {
  api: string;
  web: string;
  /** What the persona's browser opens (public origin when a rewrite serves `web`). */
  browserBase: string;
  rewrite: Record<string, string>;
}

export function effectiveTarget(
  c: { target: string | null; targetUrl: string; webUrl: string | null },
  targets: Targets,
): EffectiveTarget | null {
  if (c.target === null) {
    const web = c.webUrl ?? c.targetUrl;
    return { api: c.targetUrl, web, browserBase: web.replace(/\/$/, ''), rewrite: {} };
  }
  const spec = targets[c.target];
  if (!spec) return null;
  const web = spec.web ?? spec.api;
  return {
    api: spec.api,
    web,
    browserBase: browserBaseUrl({ web, rewrite: spec.rewrite }),
    rewrite: spec.rewrite,
  };
}
