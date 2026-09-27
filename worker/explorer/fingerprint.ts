import { hashString } from '../../shared/prng.js';
import type { Scan } from './page-scan.js';

/** Query keys whose value names a different screen (Orqea's settings tabs). */
const SCREEN_KEYS = new Set(['tab', 'view']);
const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[a-z]+\d[0-9a-z]*|[A-Za-z0-9_-]{20,})$/i;

/** `/board/42?tab=x&q=y` → `/board/:id?q&tab=x`: ids replaced, query keys sorted, values dropped. */
export function normalizeRoute(url: string): string {
  const u = new URL(url);
  const path =
    u.pathname
      .split('/')
      .map((s) => (s && ID_SEGMENT.test(s) ? ':id' : s))
      .join('/')
      .replace(/\/$/, '') || '/';
  const keys = [...new Set([...u.searchParams.keys()])].sort();
  const query = keys.map((k) => (SCREEN_KEYS.has(k) ? `${k}=${u.searchParams.get(k)}` : k));
  return query.length ? `${path}?${query.join('&')}` : path;
}

/** Signature of a screen: route + sorted `role:name` of its controls + modal flag. */
export function fingerprint(scan: Pick<Scan, 'url' | 'controls' | 'modal'>): string {
  const items = [...new Set(scan.controls.map((c) => `${c.role}:${c.name}`))].sort();
  const text = `${normalizeRoute(scan.url)}|${scan.modal ? 'modal' : ''}|${items.join('\n')}`;
  return hashString(text).toString(36).padStart(7, '0');
}

/** Key of an action on a screen: stable across visits (role, name, link target route). */
export function actionKey(c: { role: string; name: string; href: string | null }): string {
  return `${c.role}:${c.name}${c.href ? `→${normalizeRoute(c.href)}` : ''}`;
}
