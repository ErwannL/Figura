import type { Plan } from '../../shared/plans.js';
import { isLoopbackHost } from '../../shared/synthetic.js';
import {
  ContractError,
  PATHS,
  type Endpoint,
  type OrqeaClient,
  type TargetInfo,
} from './client.js';

export type RefusalCode =
  | 'PRODUCTION_ENV'
  | 'REMOTE_HOST_UNCONFIRMED'
  | 'SYNTHETIC_DISABLED'
  | 'VOLUME_CAP'
  | 'TARGET_NOT_CONFIGURED'
  | 'STRIPE_LIVE'
  | `ORQEA_CONTRACT_MISSING:${string}`;

/** Sentences shown verbatim in the UI next to the code. */
export const REFUSAL_MESSAGES = {
  PRODUCTION_ENV:
    'The target reports a production environment. Synthetic users never run against production, and this cannot be overridden.',
  REMOTE_HOST_UNCONFIRMED:
    'The target is not on this machine. Tick "allow remote target" and retype the exact host name to confirm (several hosts: separate them with commas).',
  SYNTHETIC_DISABLED:
    'The target has synthetic mode turned off. Enable it on the target (non-production only) and try again.',
  VOLUME_CAP:
    'This run would exceed the configured volume caps (accounts, requests per second or rows). Lower the number of users.',
  TARGET_NOT_CONFIGURED:
    'The Orqea environment named by the run (or by the admin console) is not configured in FIGURA_TARGETS on this Figura. Add it, or pick a configured target.',
  STRIPE_LIVE:
    'The target reports live Stripe payments. Explorer runs only run against a target in Stripe test mode (or without Stripe), and this cannot be overridden.',
  ORQEA_CONTRACT_MISSING:
    'The target does not implement a required endpoint of the Orqea contract (see docs/ORQEA_CONTRACT.md).',
} as const;

/**
 * Environments that are explicitly safe. Anything else — including an unknown env — counts as
 * production. `recette` is Orqea's staging (it reports `APP_ENV=recette`).
 */
const SAFE_ENVS = /^(dev|development|local|test|testing|ci|staging|recette|preview|qa|synthetic)$/i;

/**
 * Endpoints that must be DESCRIBED by `GET /api`. Orqea's descriptor is documentation, not a
 * route dump: it lists the product API but not `GET /api/auth/verify-email`, `GET /api` itself nor
 * the synthetic admin API. Those are proved by calling them instead: `GET /api` and the target
 * call happen here, `GET /api/billing/plans` is parsed here, verification and cleanup are called
 * by the run and fail it with their endpoint named.
 */
export const REQUIRED_ENDPOINTS = ['POST /api/auth/register', 'POST /api/auth/login', PATHS.plans];

export interface GuardInput {
  /** The API base URL. */
  targetUrl: string;
  /** Every other URL the run will reach: the web app, the destinations of browser rewrites. */
  otherUrls: string[];
  allowRemote: boolean;
  /** Host name(s) retyped by the operator, comma or space separated. */
  confirmHost: string | null;
  /** Hosts declared local by the operator (e.g. the compose service name "fake-orqea"). */
  localHosts: string[];
  /** Hosts that are production, whatever the target says. */
  productionHosts: string[];
  requested: { accounts: number; requestsPerSecond: number; rows: number };
  caps: { accounts: number; requestsPerSecond: number; rows: number };
  /** Explorer runs: a target in live Stripe mode is refused (STRIPE_LIVE), with no override. */
  refuseLiveStripe?: boolean;
}

export type GuardResult =
  | { ok: true; info: TargetInfo; endpoints: Endpoint[]; plans: Plan[] }
  | { ok: false; code: RefusalCode; message: string };

const refuse = (
  code: RefusalCode,
  base: keyof typeof REFUSAL_MESSAGES = code as keyof typeof REFUSAL_MESSAGES,
): GuardResult => ({ ok: false, code, message: REFUSAL_MESSAGES[base] });

/** Runs before any work touches the target. PRODUCTION_ENV has no bypass. */
export async function guardTarget(
  input: GuardInput,
  client: Pick<OrqeaClient, 'targetInfo' | 'endpoints' | 'plans'>,
): Promise<GuardResult> {
  const lower = (list: string[]) => list.map((h) => h.trim().toLowerCase());
  const hosts = [input.targetUrl, ...input.otherUrls].map((u) => new URL(u).hostname.toLowerCase());
  const production = lower(input.productionHosts);
  if (hosts.some((h) => production.includes(h))) return refuse('PRODUCTION_ENV');
  const local = lower(input.localHosts);
  const confirmed = input.allowRemote ? lower((input.confirmHost ?? '').split(/[\s,]+/)) : [];
  const unconfirmed = hosts.some(
    (h) => !isLoopbackHost(h) && !local.includes(h) && !confirmed.includes(h),
  );
  if (unconfirmed) return refuse('REMOTE_HOST_UNCONFIRMED');
  let info: TargetInfo;
  let endpoints: Endpoint[];
  let plans: Plan[];
  try {
    info = await client.targetInfo();
    if (!SAFE_ENVS.test(info.env)) return refuse('PRODUCTION_ENV');
    if (!info.syntheticEnabled) return refuse('SYNTHETIC_DISABLED');
    if (input.refuseLiveStripe && info.stripeMode === 'live') return refuse('STRIPE_LIVE');
    endpoints = await client.endpoints();
    plans = await client.plans();
  } catch (e) {
    if (e instanceof ContractError)
      return refuse(`ORQEA_CONTRACT_MISSING:${e.endpoint}`, 'ORQEA_CONTRACT_MISSING');
    throw e;
  }
  const have = new Set(endpoints.map((e) => `${e.method.toUpperCase()} ${e.path}`));
  const missing = REQUIRED_ENDPOINTS.find((r) => !have.has(r));
  if (missing) return refuse(`ORQEA_CONTRACT_MISSING:${missing}`, 'ORQEA_CONTRACT_MISSING');
  const { requested: r, caps: c } = input;
  if (r.accounts > c.accounts || r.requestsPerSecond > c.requestsPerSecond || r.rows > c.rows)
    return refuse('VOLUME_CAP');
  return { ok: true, info, endpoints, plans };
}
