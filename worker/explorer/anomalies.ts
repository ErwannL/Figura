import {
  ANOMALY_TYPES,
  SEVERITIES,
  type AnomalyType,
  type DeviceKey,
  type InfoType,
  type Severity,
} from '../../shared/explorer.js';

export interface Anomaly {
  /** Dedup key: type + normalised route + normalised message. */
  key: string;
  type: AnomalyType;
  severity: Severity;
  count: number;
  devices: DeviceKey[];
  route: string;
  /** First occurrence: where to replay up to. */
  step: number;
  device: DeviceKey;
  slot: number;
  action: string;
  message: string;
  excerpt: string;
  screenshots: string[];
}

export interface Info {
  type: InfoType;
  route: string;
  message: string;
  count: number;
}

export interface Sighting {
  type: AnomalyType;
  route: string;
  message: string;
  excerpt?: string;
  device: DeviceKey;
  slot: number;
  step: number;
  action: string;
  screenshots?: string[];
}

const SECRET_PATTERNS: [RegExp, string][] = [
  // X-Synthetic-Run value: <runId>.<ts>.<64 hex>
  [/\b[0-9a-z]+\.\d{9,}\.[0-9a-f]{64}\b/g, '[run-header]'],
  // JWTs (session tokens, SSO)
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]'],
  [/\b(bearer)\s+[^\s"']+/gi, '$1 [redacted]'],
  [/([?&](token|access_token|code|key|secret|password|sig|signature)=)[^&\s"']+/gi, '$1[redacted]'],
  [
    /("?(token|password|secret|authorization|cookie|x-synthetic-run)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
    '$1[redacted]',
  ],
  // Any 40+ hex run (HMACs, API keys)
  [/\b[0-9a-f]{40,}\b/gi, '[hex]'],
];

/** Masks secrets in anything stored: excerpts, messages, URLs. Also bounds the length. */
export function redact(text: string, max = 500): string {
  let out = text;
  for (const [re, by] of SECRET_PATTERNS) out = out.replace(re, by);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** A network URL as stored: path only (no query, no fragment), secrets masked. */
export function safeUrl(url: string): string {
  const u = new URL(url);
  return redact(`${u.origin}${u.pathname}`);
}

export function normalizeMessage(m: string): string {
  return m
    .toLowerCase()
    .replace(/https?:\/\/[^\s)]+/g, (u) => u.replace(/[?#].*$/, ''))
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Collects sightings into deduplicated anomalies (count + devices), and info records. */
export class AnomalyBook {
  private byKey = new Map<string, Anomaly>();
  private infos = new Map<string, Info>();

  add(s: Sighting): { anomaly: Anomaly; first: boolean } {
    const key = `${s.type}|${s.route}|${normalizeMessage(s.message)}`;
    const known = this.byKey.get(key);
    if (known) {
      known.count += 1;
      if (!known.devices.includes(s.device)) known.devices.push(s.device);
      return { anomaly: known, first: false };
    }
    const anomaly: Anomaly = {
      key,
      type: s.type,
      severity: ANOMALY_TYPES[s.type],
      count: 1,
      devices: [s.device],
      route: s.route,
      step: s.step,
      device: s.device,
      slot: s.slot,
      action: redact(s.action, 200),
      message: redact(s.message),
      excerpt: redact(s.excerpt ?? ''),
      screenshots: [...(s.screenshots ?? [])],
    };
    this.byKey.set(key, anomaly);
    return { anomaly, first: true };
  }

  info(type: InfoType, route: string, message: string): void {
    const key = `${type}|${route}|${normalizeMessage(message)}`;
    const known = this.infos.get(key);
    if (known) known.count += 1;
    else this.infos.set(key, { type, route, message: redact(message, 200), count: 1 });
  }

  get size(): number {
    return this.byKey.size;
  }

  /** Sorted by severity, then by count. */
  anomalies(): Anomaly[] {
    const rank = (s: Severity) => SEVERITIES.indexOf(s);
    return [...this.byKey.values()].sort(
      (a, b) => rank(a.severity) - rank(b.severity) || b.count - a.count,
    );
  }

  infoList(): Info[] {
    return [...this.infos.values()];
  }
}
