# Security

- **Never against production**: guard refuses `PRODUCTION_ENV` from the host list or the target's
  reported `env` (unknown ⇒ production), with no override (property test in `worker/target/target.test.ts`).
  Remote hosts need `allowRemote` + the host retyped. Refused runs never call the target.
  Every host a run reaches is checked (API, web app, browser rewrite destinations); rewrites and
  named targets come only from server configuration (`FIGURA_TARGETS`), never from the run request.
- **Explorer runs** ([EXPLORATEUR.md](EXPLORATEUR.md)): also refused on `stripeMode: live` (`STRIPE_LIVE`,
  no override); at most 3 sessions, 500 actions and 30 minutes per session (schema, server side); a
  catalogue of forbidden controls (logout, account deletion, export, credentials, encryption, payment,
  OAuth, SSH, non-synthetic invitations, other origins) never activated; navigations leaving the
  origin cancelled; stored excerpts redacted (run header, JWTs, bearer, secret query values) and
  URLs stored without query; one active exploration per target (409).
- **Run header scope**: the persona's browser sends `X-Synthetic-Run` only to Orqea's API origin
  (per request, fresh HMAC); the web app and third parties never see it. The SSO `target` claim is
  signed and validated (`BAD_TARGET`); an unknown name cannot widen what a run may reach.
- **Access**: no login screen; admin-console SSO (HS256, `iss`, `aud`, `exp ≤ 60 s`, single use by
  SHA-256) → short httpOnly session (`SameSite=Strict`, or `None; Secure` cross-site). Anti-CSRF
  header on state-changing calls. Loopback lock: 404 unless `Host` is local
  (`FIGURA_LOOPBACK_ONLY=false` only behind an authenticating reverse proxy).
- **Headers**: strict CSP (`default-src 'self'`, no inline script), `frame-ancestors` = configured
  console origins, no `X-Frame-Options`, no CORS, `nosniff`, `no-referrer`, `no-store` on API.
  HTML reports: `default-src 'none'`, sandboxed, no script.
- **Secrets** only from the environment (`.env`, never committed; `npm run check:secrets` in CI and
  pre-commit). Session, SSO, data-key and service secrets must be ≥ 32 chars; SSO ≠ session secret.
- **Data hygiene**: synthetic passwords random (`crypto`), credentials encrypted at rest (AES-256-GCM),
  session tokens and verify links never persisted, screenshots in a local volume purged with the run
  (`DELETE /api/runs/:id`), synthetic accounts cleaned up on the target at the end of every run.
- **Logs**: method, path (no query), status. No bodies, headers, cookies, tokens, passwords.
- **Containers**: non-root users, read-only root filesystems (app, fake), ports on 127.0.0.1 only,
  health checks. `npm audit --audit-level=high` in CI.
- **Target side** (documented in ORQEA_CONTRACT.md): admin API 404 outside synthetic mode or from
  non-allowed sources, Bearer secret, signed 5-minute run header, analytics exclusion.
