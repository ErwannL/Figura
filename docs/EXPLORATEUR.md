# Explorer mode (« Explorateur »)

A run kind (`kind: "explore"`) where 1 to 3 synthetic personas walk Orqea in a real Chromium as a
curious, slightly clumsy human would: they build a model of the interface, prefer what they have
not tried yet, take a screenshot of every new screen and record anomalies with their evidence. The
operator gets a visual report: a gallery (routes × devices side by side) and a deduplicated anomaly
list, each item with its screenshot and a "replay" button.

It is **not** load testing (that is Orqea's stress harness): human pace, at most 3 sessions.

## Architecture

```
 UI (new-run form, kind "explore")  ──POST /api/runs──▶  app: schema caps + one exploration per target (409)
                                                         │
 worker: executeRun ─▶ guard (+ STRIPE_LIVE) ─▶ exploreRun ─▶ N sessions in parallel (≤ 3)
                                                         │     each: BrowserDriver (device profile, run header,
                                                         │     rewrites) → account (catalogue signup / verify /
                                                         │     login) → optional seed data (catalogue use cases)
                                                         │     → explore loop (inventory → strategy → act →
                                                         │     detectors → screenshots) until budget, time or cancel
                                                         ▼
                                              report `explore` (reports table) + live progress (runs.progress)
                                                         ▼
                                              finish(): POST /cleanup {runId} — always (finally), residual ⇒ failed
```

Everything that already exists is reused: `guardTarget` and `waitReady`, `OrqeaClient` (target,
verification, cleanup, run header), `BrowserDriver` (routing, `X-Synthetic-Run` only to the API
origin, rewrites, catalogue use cases by role + accessible name), `newCredentials` /
`initialVars` (synthetic emails, usernames), `createPrng(seed).fork(label)`, `finish()` (cleanup in
`finally`), the `reports` table, the screenshots directory and its per-run purge.

| Module                           | Role                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `shared/explorer.ts`             | Device catalogue, explorer config schema, hard caps, anomaly types                    |
| `worker/explorer/forbidden.ts`   | Forbidden-action catalogue (structural: role, href, route, form action, origin)       |
| `worker/explorer/page-scan.ts`   | In-page inventory + DOM detectors (serialised like `measure.ts`, tested in happy-dom) |
| `worker/explorer/fingerprint.ts` | Route normalisation (`:id`) and state fingerprint                                     |
| `worker/explorer/strategy.ts`    | Novelty-weighted choice, stale detection, recovery                                    |
| `worker/explorer/values.ts`      | Field values: plausible and edge (empty, 2 000 chars, emoji, HTML-looking marker)     |
| `worker/explorer/missions.ts`    | Mission catalogue = ids of catalogue use cases (no second way to create a board)      |
| `worker/explorer/anomalies.ts`   | Anomaly record, severity, dedup key, network redaction                                |
| `worker/explorer/session.ts`     | One session's loop on a Playwright page                                               |
| `worker/explorer/shots.ts`       | PNG screenshots (dedup state × device, evidence per anomaly), retention purge         |
| `worker/explorer/run.ts`         | Sessions, parallelism, progress, report; called by `executeRun`                       |
| `worker/explorer/report.ts`      | Report assembly (states per device, route map, gallery, anomalies)                    |
| `ui/views/explore.ts`            | Live progress, anomalies (filters, replay), gallery, JSON export                      |

## Run parameters (`config.explorer`)

| Field        | Default       | Bounds                                                                                    |
| ------------ | ------------- | ----------------------------------------------------------------------------------------- |
| `devices`    | `["desktop"]` | ≥ 1 of the catalogue keys `desktop` (1440×900), `tablet` (iPad gen 7), `mobile` (Pixel 7) |
| `sessions`   | 1             | 1–3 **in total**, spread round-robin over the devices (server-side schema)                |
| `maxActions` | 150           | 1–500 per session                                                                         |
| `maxMinutes` | 10            | 1–30 per session; the first budget reached stops the session                              |
| `seedData`   | false         | creates a board, a list and a card (catalogue use cases) before exploring                 |
| `clumsiness` | 0.05          | 0–0.2: probability of a double/repeated click (at most 3 clicks in a row)                 |
| `replay`     | null          | `{device, slot, untilStep}`: one session replaying another session's choices              |
| `seed`       | random        | run-level; session PRNG = `createPrng(seed).fork("<device>#<slot>")`                      |

The start persona is always a **free** account (Figura cannot put a synthetic account on a plan
without Stripe; see requests to Orqea). Locale fixed to `en`. Target: the usual `target` /
`targetUrl` with the same `allowRemote` + retyped host.

## Guards

1. `GET /target` first (existing guard). Non-synthetic ⇒ `SYNTHETIC_DISABLED`, non-safe env ⇒
   `PRODUCTION_ENV`, **`stripeMode: "live"` ⇒ `STRIPE_LIVE`** (explore runs). No override flag.
2. Accounts: `synth+<runId>-explorer-<device>-<slot>@synthetic.invalid`, created for the run.
3. Pace: 400–2 500 ms between actions (seeded), ≤ 3 sessions, clumsy clicks bounded (≤ 3).
4. Forbidden catalogue (`worker/explorer/forbidden.ts`): logout, account deletion, data export,
   password/e-mail change (any control in a form with a password field), board encryption,
   payment/Stripe (checkout, portal, "choose plan"), OAuth providers, SSH servers, invitations to a
   non-synthetic address, links leaving the target's origin. **First rule: `data-danger`** on the
   control or an ancestor (Orqea marks every such control, `frontend/src/config/dangerControls.js`:
   `logout`, `delete-account`, `export`, `credentials`, `encryption`, `payment`, `oauth`, `ssh`) —
   language-proof. Then role, href, route, form action and origin; English accessible names only as
   a last signal (locale fixed to `en`).
5. Same origin: a navigation to another origin is aborted and recorded as `info`.
6. Cleanup: `finish()` in `finally`; `{before, after, residualRows}` in the report; residual > 0 ⇒
   run anomaly and `failed`.
7. Cancel: the existing cancel flag, polled; sessions stop at the next step, contexts close, cleanup runs.
8. No leak: request URLs lose their query; headers are never stored; tokens/`X-Synthetic-Run`
   look-alikes are masked in every stored excerpt (`redact()`).

One active exploration per target: partial unique index on `runs` (`kind = 'explore'` and a
non-final status) ⇒ `409 EXPLORATION_ACTIVE`.

## Exploration

- **Inventory**: visible, enabled, on-screen elements with role `button, link, tab, menuitem,
checkbox, radio, combobox, textbox, searchbox, switch, option`, deduplicated by role + name + href,
  forbidden ones removed (and counted).
- **Fingerprint**: normalised route (numbers, UUIDs, long hex → `:id`; query keys kept, values
  dropped except `tab`) + sorted `role:name` set + modal flag → FNV-1a hash.
- **Strategy**: weight = untried ? 10 / (1 + visits(state)) : 1 / (1 + tries)²; fill textboxes
  before clicking submit-like buttons of the same form; after `staleSteps` (8) steps without a new
  state: recover (close modal, then navigate to the home route).
- **Missions**: seeded pick among `create-board`, `create-list`, `create-card`, `edit-card`,
  `move-card`, `global-search`, `settings-theme` (about 1 step in 15).
- **Modals**: Escape, then a close button; `trapSteps` (12) steps on one state with a modal ⇒ `trap`.
- **Touch**: mobile/tablet contexts use `tap`, open the hamburger (button with `aria-expanded`).

## Anomalies

Accessibility checks are the built-in ones below (unnamed buttons/links, images without `alt`,
small touch targets). `@axe-core/playwright` is not integrated: it would be a new dependency
injected into every page; the in-page scan covers the same basic rules at no cost. It can be added
later as an extra detector on new states (serious/critical only).

| Type                  | Severity | Evidence                                     |
| --------------------- | -------- | -------------------------------------------- |
| `js-error`            | critical | `pageerror` message + stack head             |
| `console-error`       | minor    | console text                                 |
| `http-5xx`            | critical | method, path (no query), status              |
| `http-unexpected-4xx` | major    | 401 mid-session, 404 on an internal API call |
| `not-found`           | major    | link followed + landing route                |
| `horizontal-scroll`   | major    | document width vs viewport (mobile, tablet)  |
| `offscreen-control`   | minor    | control's box                                |
| `text-overflow`       | minor    | element, scrollWidth/clientWidth             |
| `small-target`        | minor    | control and its size (mobile, < 24×24)       |
| `unnamed-control`     | major    | role + outerHTML head                        |
| `img-no-alt`          | minor    | src path                                     |
| `raw-i18n-key`        | major    | the key                                      |
| `slow`                | major    | action and ms (> 5 000)                      |
| `trap`                | major    | route, steps stuck                           |
| `html-injected`       | critical | marker rendered as an element                |
| `cleanup-residual`    | critical | residual rows                                |

`info` (not anomalies): paywall 402, blocked external navigation, forbidden elements skipped.
Dedup key: type + normalised route + normalised message (digits → `#`); count and devices merged.

## Tests

- Pure units: device catalogue and caps, forbidden catalogue (each entry has structural cases and
  ordinary controls pass), fingerprints, strategy and replayability (same seed ⇒ same choices),
  values, missions, anomaly dedup and redaction, page scan (each DOM detector on a page that has the
  defect and on one that does not, in happy-dom), guard (`STRIPE_LIVE`).
- Integration (real Chromium): `worker/explorer/test-helpers/buggy-app.ts` plants a throwing button,
  a 500 route, a 404 link and a single-page-app NotFound screen, a page too wide for mobile, a raw
  i18n key, HTML rendered from user input, a slow call, a 401, a 402, a console error and a modal
  trap, plus a "Delete account" button and an external link: the explorer finds every defect,
  never clicks the button (server hit count 0), never leaves the origin, and finds nothing on the
  healthy twin.
- Worker: two devices in parallel against the fake Orqea (accounts, seed data, screenshots,
  progress, report without secrets), replay, refusals, cleanup after an exception, on cancel, with
  residual rows and when the cleanup call fails. API: caps (400) and the one-exploration lock (409).

## Report (`reports.kind = "explore"`, JSON export `/api/runs/:id/reports/explore.json`)

```json
{ "type": "explore", "runId", "seed", "params", "durationMs",
  "sessions": [{ "device", "slot", "steps", "states", "stoppedBy", "account": "synth+…" }],
  "statesByDevice": { "desktop": 12 }, "routes": [{ "route", "devices", "visits" }],
  "screenshots": [{ "file", "device", "session", "step", "route", "fingerprint", "action", "kind" }],
  "anomalies": [{ "key", "type", "severity", "count", "devices", "route", "step", "action",
                  "message", "excerpt", "screenshots", "replay": { "seed", "device", "slot", "untilStep" } }],
  "info": [{ "type", "count", "route", "message" }], "cleanup": { "before", "after", "residualRows" } }
```

Screenshots: PNG viewport per new state (dedup fingerprint × device), before/after per anomaly,
full page for layout anomalies, in `<FIGURA_SCREENSHOTS_DIR>/<runId>/x-*.png`. Retention:
`FIGURA_EXPLORER_RETENTION_DAYS` (default 14), purged by the worker loop; deleting the run purges too.

## Requests to Orqea (« Demandes à Orqea »)

1. **Put a synthetic account on a plan without Stripe.**
   `POST /api/admin/synthetic/plan {email, runId, planKey}` → `200 {planKey}`; `404` for a
   non-synthetic account or another run's; `400` unknown plan. Same auth and 404 rules as §3. Until
   then the explorer starts from a free account only (the UI does not offer a plan).
2. **Seed data through the admin API (optional).** `POST /api/admin/synthetic/seed {email, runId,
boards: n, listsPerBoard, cardsPerList}` → `201 {boards: [ids]}` would make seeding independent
   of UI changes; today Figura seeds through the catalogue's UI use cases.
3. ~~Structural hooks for forbidden actions.~~ **Done**: Orqea marks its dangerous controls with
   `data-danger="<kind>"` (catalogue `frontend/src/config/dangerControls.js`, a contract: a kind
   never changes); the page scan reads it (`Control.danger`) and `danger-marked` is the first
   forbidden rule.
