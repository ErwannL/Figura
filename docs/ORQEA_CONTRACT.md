# Orqea ⇄ Figura contract

What Orqea must provide so Figura (the synthetic-user simulator) can run against it, and what the
admin console must do to embed Figura. **The product API is Orqea's own** (§2 describes its real
shapes; Figura adapts to them, Orqea does not change for Figura). The fake Orqea (`fake-orqea/`) is
the test double of the real Orqea: same paths, payloads, errors and accessible names;
`worker/target/client.ts` is the client. Running Figura inside Orqea's compose:
[ORQEA_INTEGRATION.md](ORQEA_INTEGRATION.md). Known UI gaps: [ORQEA_UI_FACTS.md](ORQEA_UI_FACTS.md).

Conventions: JSON bodies (`content-type: application/json`), UTF-8, times in seconds since epoch.
Figura sends `accept-language: en|fr` (the persona's language) on product calls.

## 1. Environment variables (Orqea side)

| Variable                                                      | Where         | Meaning                                                                                                                                                            |
| ------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SYNTHETIC_MODE` (`true`/`false`)                             | API           | Enables the synthetic admin API and the run header. Default `false`. **Must be `false` in production.**                                                            |
| `SYNTHETIC_SERVICE_SECRET` (≥ 32 chars)                       | API           | Shared with Figura: Bearer secret of the admin API and HMAC key of `X-Synthetic-Run`.                                                                              |
| `SYNTHETIC_ADMIN_SOURCES`                                     | API           | Source addresses allowed on the admin API besides loopback (e.g. the Figura worker's network). Default: loopback only.                                             |
| `APP_ENV`                                                     | API           | Reported as `env` (§3.1), falling back to `NODE_ENV`. Recette reports `recette`. Anything but an explicit non-production value is treated as production by Figura. |
| `FIGURA_SSO_SECRET` (≥ 32 chars, ≠ Figura's session secret)   | Admin console | Signs SSO tokens (§5).                                                                                                                                             |
| `FIGURA_APP_ID` (default `figura`)                            | Admin console | JWT audience.                                                                                                                                                      |
| `FIGURA_URL_LOCAL` / `FIGURA_URL_STAGING` / `FIGURA_URL_PROD` | Admin console | Figura's URL per environment (the prod console may point at a Figura that only targets staging — Figura never targets production).                                 |

## 2. Public product API (Orqea's real shapes)

| Endpoint                                                               | Success                                                                                                                                                                                                                                                                                                                              | Errors                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/register {email, password, username?, acceptedTerms?}` | `201 {id, email, username, emailDelivery, verifyUrl?}` (`verifyUrl` only with Orqea's dev outbox)                                                                                                                                                                                                                                    | `400 {message: 'Missing email or password' \| 'Invalid username' \| 'Invalid email' \| 'Weak password', issues?}`; `409 {message: 'User already exists'}`. Figura always sends `username` (Orqea refuses the `+` of a derived one). |
| `GET /api/auth/verify-email?token=…`                                   | `200 {message: 'Email verified'}` (JSON; the link a mail carries is the web page `/verify-email?token=`)                                                                                                                                                                                                                             | `400 {message}`: missing, invalid, used or expired token                                                                                                                                                                            |
| `POST /api/auth/login {email, password}`                               | `200 {token}` (Bearer for later calls)                                                                                                                                                                                                                                                                                               | `400` missing fields or invalid email; `401 {message: 'Invalid credentials'}`; `403 {message: 'Email not verified'}`; `429` brake                                                                                                   |
| `GET /api`                                                             | `200 {message: 'Orqea API', endpoints}`: `endpoints` is a **nested object** grouped by resource whose leaves carry `method` and `path` (`:name` params, sometimes `?query`). Figura walks every `{method, path}` leaf (a flat array is accepted too).                                                                                | —                                                                                                                                                                                                                                   |
| `GET /api/billing/plans` (public)                                      | `200 {plans: [{key, name, displayAmount: {month}, entitlements: {features}, …, priceMonthly, currency, perSeat, features}]}`. Figura reads the readable fields (`priceMonthly` in currency units, `null` = quote-based "contact sales": shown, never bought by a persona) and falls back to Orqea's own fields when they are absent. | —                                                                                                                                                                                                                                   |

Plus the product endpoints used by the catalogue's `api` steps (`catalogue/use-cases/*.json`; the
drift check lists them). Authenticated calls use `Authorization: Bearer <token>`. Errors are
`{message, issues?}` or `{code, field}`; Figura reports the first of `error`, `code`, `message` and
judges clarity on the message plus its `issues`.

**Paywall.** A locked feature answers **402** `{code:"FEATURE_LOCKED"|"PLAN_LIMIT", feature?, limitKey?, planKey, upgrade:true}`
(`planKey` = the user's current plan). Figura treats it as a paywall encounter (money decision), not
as a bug. In the web UI the same 402 must be what the page's own call receives: a page gated only in
the browser (Orqea's `/stats`) is seen as a failure, not a paywall.

**UI.** Controls must expose roles and accessible names; the catalogue's `ui` steps use Orqea's
(e.g. link "Try the beta" / "Essayer la bêta", button "Sign up" / "S'inscrire"). A changed name is a
catalogue change. A missing one is a friction fact ([ORQEA_UI_FACTS.md](ORQEA_UI_FACTS.md)).

## 3. Synthetic-users admin API

Enabled only when `SYNTHETIC_MODE=true` **and** the environment is not production. Otherwise, and
for any source not on loopback / `SYNTHETIC_ADMIN_SOURCES`, every admin route answers **404**.
Authentication: `Authorization: Bearer <SYNTHETIC_SERVICE_SECRET>` (constant-time compare) → `401` otherwise.

### 3.1 `GET /api/admin/synthetic/target`

`200 {env, stripeMode:"test"|"live"|"off", syntheticEnabled, version}`.
Figura accepts only `env` ∈ `dev, development, local, test, testing, ci, staging, recette, preview, qa, synthetic`
(case-insensitive); anything else ⇒ `PRODUCTION_ENV`.

### 3.2 `POST /api/admin/synthetic/verification {email, runId}`

For an **unverified** account of that run: `200 {verifyUrl}` (the same link an email would contain,
i.e. the web page `<FRONTEND_URL>/verify-email?token=…`; Figura opens it in the persona's browser, so
the verify page is exercised, and reads `token` from it for API runs). `404` otherwise.

### 3.3 Synthetic accounts

Emails: `synth+<runId>-<personaId>[-<n>]@synthetic.invalid`; `runId` is base-36 (`[0-9a-z]+`).
They must be **excluded from product analytics** (events, funnels, MRR, emails): filter on the
`@synthetic.invalid` domain at ingestion. `.invalid` never receives mail (RFC 2606).

### 3.4 `X-Synthetic-Run: <runId>.<ts>.<hex HMAC-SHA256(SYNTHETIC_SERVICE_SECRET, "<runId>|<ts>")>`

Valid when `|now − ts| ≤ 300 s` and the HMAC matches — and, in Orqea, only when the request's email
(body or query), if any, is `@synthetic.invalid`. Figura's API calls always carry it; in the browser
it is added only to requests that end at Orqea's API origin (never to the web app or third parties). Such requests are exempt from rate limits,
login brakes and captcha. When a real user **would** have seen a captcha, answer with
`X-Captcha-Would-Show: 1` (Figura counts it as friction). Figura refreshes the header on every step.

### 3.5 `POST /api/admin/synthetic/cleanup {runId} | {olderThanHours}`

Deletes every synthetic account of the run (or older than N hours) and everything they own.
`200 {before, after, residualRows}` — row counts before/after (a number, or per-table counts
`{users: 3, boards: 2, …}` as Orqea reports them) and synthetic rows still matching.
Figura fails the run when `residualRows > 0`. `400` without a valid selector.

## 4. Guard (Figura side, before any work) — refusal codes shown verbatim in the UI

| Code                                   | When                                                                                                                              | Override             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `PRODUCTION_ENV`                       | host listed in `FIGURA_PRODUCTION_HOSTS`, or `env` not explicitly non-production                                                  | **none**             |
| `REMOTE_HOST_UNCONFIRMED`              | host not loopback/declared-local, unless the run has `allowRemote` **and** the host retyped (`confirmHost`, compared server-side) | per run              |
| `SYNTHETIC_DISABLED`                   | `syntheticEnabled:false`                                                                                                          | enable on the target |
| `VOLUME_CAP`                           | accounts / requests per second / estimated rows above `FIGURA_MAX_*`                                                              | lower the run        |
| `ORQEA_CONTRACT_MISSING:<METHOD path>` | `GET /api` does not describe register, login or plans; or the target, `GET /api` or plans call fails or is malformed              | implement it         |
| `TARGET_NOT_CONFIGURED`                | the run (or the console's `target` claim) names an Orqea environment absent from `FIGURA_TARGETS`                                 | configure it         |
| `STRIPE_LIVE`                          | explorer runs only ([EXPLORATEUR.md](EXPLORATEUR.md)): `stripeMode` is `live`                                                     | **none**             |

`REMOTE_HOST_UNCONFIRMED` and `PRODUCTION_ENV` apply to **every** host the run reaches: the API, the
web app and the destinations of browser rewrites (`confirmHost` may list several, comma separated).
A refused run never touches the target (no cleanup call either). Catalogue steps that `GET /api`
does not describe are recorded as `summary.drift` and do not stop the run: Orqea's descriptor is
documentation, not a route dump. Verification and cleanup are proved by being called.

## 5. Admin console embedding and single sign-on

**Token endpoint (console backend):** admin-only, reachable from localhost/the console only.
Orqea's is `POST /api/admin/figura/handoff` → `{token, expiresIn: 60}` (404 in production). `token`
is a JWT HS256 signed with `FIGURA_SSO_SECRET`: header `{alg:"HS256",typ:"JWT"}`, claims
`{iss:"orqea-admin-console", aud:"<FIGURA_APP_ID>", operator:"<display name>", target:"<env>", jti:"<random>", iat, exp: iat+60}`.
`jti` should be random: without it, two tokens minted in the same second for the same operator are
byte-identical and single use refuses the second one as `REUSED` (Figura does not require it).
`operator` is for Figura's audit log only (no account is provisioned). `target` (optional, signed)
is the Orqea environment the console inspects: Orqea sends `local` for its local stack and `recette`
for recette. It must match `[a-z0-9][a-z0-9-]{0,39}` or the token is refused with `BAD_TARGET`.
Figura keeps it in the session, preselects the matching `FIGURA_TARGETS` entry for new runs and
shows which Orqea is being tested; an unconfigured name shows `TARGET_NOT_CONFIGURED`.

**Iframe:** `<iframe title="Synthetic users simulator" src="<FIGURA_URL>/#sso=<token>">`. The
fragment never reaches servers or logs. If no `load` event within 8 s, show a fallback link.
Offer "Open in new tab" that fetches a **fresh** token (tokens are single use).

**Figura side:** reads `#sso=` once, `POST /auth/sso {token}`, then `history.replaceState` removes
the fragment. It verifies signature, `iss`, `aud`, `exp` (lifetime ≤ 60 s) and single use (SHA-256
kept until expiry), then sets its own session cookie (httpOnly, `SameSite=Strict`; with
`FIGURA_COOKIE_CROSS_SITE=true` → `SameSite=None; Secure` for a console on another site — HTTPS required).
Errors: `400 TOKEN_REQUIRED`, `401 {error: MALFORMED|BAD_ALG|BAD_SIGNATURE|BAD_ISSUER|BAD_AUDIENCE|EXPIRED|BAD_LIFETIME|NO_OPERATOR|BAD_TARGET|REUSED}`.
`POST /auth/sso` answers `{operator, target}`; `GET /api/me` answers
`{operator, target, targetConfigured, targets: [{name, api, web}]}`.
Only `/auth/sso`, `/health` and the static UI shell are reachable without a session; the shell only
says "open me from the Orqea admin console".

**Framing:** Figura sends `Content-Security-Policy: frame-ancestors <FIGURA_CONSOLE_ORIGINS>` and no
`X-Frame-Options`. Put the console origin(s) of each environment in `FIGURA_CONSOLE_ORIGINS`.

**Loopback lock:** Figura answers **404** to any request whose `Host` is not local. Set
`FIGURA_LOOPBACK_ONLY=false` only behind a reverse proxy that authenticates admins itself.

## 6. Explorer runs

Explorer runs use only what is above (target, verification, cleanup, run header). What they would
need from Orqea but Figura does not work around is listed in
[EXPLORATEUR.md](EXPLORATEUR.md#requests-to-orqea--demandes-à-orqea-) (plan without Stripe, seeding API,
structural hooks on dangerous controls).

## 7. Fake-only extension

`PUT /__control/scenario/:runId {preset?, …overrides}` (same auth as §3) selects a friction
scenario for one run. Orqea does not need it; Figura calls it only when a run sets `fakeScenario`.
