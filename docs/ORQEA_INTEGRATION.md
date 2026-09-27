# Running Figura inside Orqea's docker compose

How an embedding compose (Orqea's, which clones this repository into `.companions/Figura`) runs
Figura next to Orqea's `backend` and `frontend` services. The contract itself (endpoints, token
claims, refusal codes) is [ORQEA_CONTRACT.md](ORQEA_CONTRACT.md).

## Images

Build from the repository root, with no `.env` present — nothing is read at build time
(`.dockerignore` excludes `.env`, no secret is `COPY`-ed, the Playwright image brings Chromium):

| Service         | Dockerfile target    | Needed                                     |
| --------------- | -------------------- | ------------------------------------------ |
| `figura-db`     | `postgres:16-alpine` | yes (Figura's own database, never Orqea's) |
| `figura-app`    | `app`                | yes — API + UI on `:4000`                  |
| `figura-worker` | `worker`             | yes — runs the simulations (Chromium)      |
| `fake-orqea`    | `fake-orqea`         | no — only to test Figura itself            |

Both `app` and `worker` apply pending database migrations at start (advisory lock, idempotent),
so there is no migration job. All configuration is read at runtime from the environment.

## Environment

Secrets: at least 32 characters each; generate with `openssl rand -base64 36`.

| Variable                                 | Service     | Value in Orqea's local stack                                    | Notes                                                                                                                  |
| ---------------------------------------- | ----------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `FIGURA_DATABASE_URL`                    | app, worker | `postgres://figura:${FIGURA_DB_PASSWORD}@figura-db:5432/figura` | Figura's own Postgres.                                                                                                 |
| `FIGURA_SESSION_SECRET`                  | app         | secret                                                          | Must differ from `FIGURA_SSO_SECRET`.                                                                                  |
| `FIGURA_SSO_SECRET`                      | app         | **same value as Orqea's `FIGURA_SSO_SECRET`**                   | Orqea's handoff (`POST /api/admin/figura/handoff`) signs the SSO JWT with it.                                          |
| `FIGURA_APP_ID`                          | app         | `figura` (Orqea's `FIGURA_APP_ID`)                              | Expected `aud`.                                                                                                        |
| `FIGURA_CONSOLE_ORIGINS`                 | app         | `http://localhost:3002`                                         | Orqea's admin console origin: CSP `frame-ancestors`.                                                                   |
| `FIGURA_HOST` / `FIGURA_PORT`            | app         | `0.0.0.0` / `4000`                                              | Publish as `127.0.0.1:4000:4000` only.                                                                                 |
| `FIGURA_LOOPBACK_ONLY`                   | app         | `true`                                                          | The browser reaches it as `localhost:4000`.                                                                            |
| `FIGURA_TARGETS`                         | app, worker | see below                                                       | Named Orqea environments; the SSO `target` claim picks one.                                                            |
| `FIGURA_VIGIE_SECRET`                    | app         | secret (≥ 32, distinct)                                         | Bearer of Vigie's calls to `http://figura-app:4000/api/vigie/*` ([VIGIE.md](VIGIE.md)); absent ⇒ that API answers 401. |
| `FIGURA_READY_TIMEOUT_MS`                | worker      | `120000` (default)                                              | Browser runs wait this long for the web app and API to answer before the first step (`TARGET_NOT_READY` after).        |
| `FIGURA_EXPLORER_RETENTION_DAYS`         | worker      | `14` (default)                                                  | Explorer screenshots older than this are purged ([EXPLORATEUR.md](EXPLORATEUR.md)).                                    |
| `SYNTHETIC_SERVICE_SECRET`               | worker      | **same value as Orqea backend's `SYNTHETIC_SERVICE_SECRET`**    | Bearer of the synthetic admin API and HMAC key of `X-Synthetic-Run`.                                                   |
| `FIGURA_DATA_KEY`                        | worker      | secret                                                          | Encrypts synthetic credentials at rest.                                                                                |
| `FIGURA_LOCAL_TARGET_HOSTS`              | worker      | `backend,frontend`                                              | Compose service names the guard treats as local (no per-run confirmation).                                             |
| `FIGURA_PRODUCTION_HOSTS`                | worker      | Orqea's production host names                                   | Refused whatever they report; no override.                                                                             |
| `FIGURA_SCREENSHOTS_DIR`                 | app, worker | `/data/screenshots` (shared volume)                             | The images default to it; mount one volume on both so the UI shows the worker's screenshots.                           |
| `FIGURA_MAX_ACCOUNTS` / `_RPS` / `_ROWS` | worker      | `500` / `20` / `100000`                                         | Volume caps.                                                                                                           |

Orqea's backend must run with `SYNTHETIC_MODE=true` and a non-production `APP_ENV` (the local
stack reports `development`, recette reports `recette`).

### `FIGURA_TARGETS`

```json
{
  "local": {
    "api": "http://backend:5001",
    "web": "http://frontend:3001",
    "rewrite": {
      "http://localhost:5001": "http://backend:5001",
      "http://localhost:3001": "http://frontend:3001"
    }
  },
  "recette": { "api": "http://host.docker.internal:5102" }
}
```

- `api`: Orqea's API as the worker reaches it. `web`: Orqea's web app as the worker reaches it
  (journey runs need it; `recette` has none by default, so only volume runs go there until one is
  added).
- `rewrite`: Orqea's SPA is built with `REACT_APP_API_URL=http://localhost:5001`, and its links and
  verification mails use `http://localhost:3001`; inside the worker container `localhost` is not
  Orqea. The persona's browser keeps the **public** origins (so `Origin`, CORS and cookies are what
  a real user produces — Orqea's CORS allow-list has `http://localhost:3001`) and Playwright only
  changes where the bytes come from. The browser opens the public origin that rewrites to `web`
  (`http://localhost:3001`). Only requests that end at `api` carry `X-Synthetic-Run`.
- Names are `[a-z0-9-]`, as in the SSO `target` claim. A claim naming an unconfigured target does not
  block sign-in: the UI shows `TARGET_NOT_CONFIGURED`, and a run on it is refused with that code.
- On Linux, give the worker `extra_hosts: ["host.docker.internal:host-gateway"]` to reach recette's
  tunnel. `host.docker.internal` is not in `FIGURA_LOCAL_TARGET_HOSTS`, so a recette run needs
  "allow remote" and the host retyped (or list it there if that tunnel only ever reaches recette).

## Service definitions (to adapt)

```yaml
services:
  figura-db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: figura
      POSTGRES_DB: figura
      POSTGRES_PASSWORD: ${FIGURA_DB_PASSWORD:?}
    volumes: [figura_db:/var/lib/postgresql/data]
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U figura -d figura']
      interval: 5s
      retries: 10

  figura-app:
    build: { context: ./.companions/Figura, target: app }
    environment:
      FIGURA_DATABASE_URL: postgres://figura:${FIGURA_DB_PASSWORD:?}@figura-db:5432/figura
      FIGURA_SESSION_SECRET: ${FIGURA_SESSION_SECRET:?}
      FIGURA_SSO_SECRET: ${FIGURA_SSO_SECRET:?}
      FIGURA_APP_ID: ${FIGURA_APP_ID:-figura}
      FIGURA_CONSOLE_ORIGINS: http://localhost:3002
      FIGURA_HOST: 0.0.0.0
      FIGURA_PORT: '4000'
      FIGURA_LOOPBACK_ONLY: 'true'
      FIGURA_TARGETS: ${FIGURA_TARGETS:?}
      FIGURA_VIGIE_SECRET: ${FIGURA_VIGIE_SECRET:-}
      FIGURA_SCREENSHOTS_DIR: /data/screenshots
    ports: ['127.0.0.1:4000:4000']
    volumes: [figura_screenshots:/data/screenshots]
    depends_on: { figura-db: { condition: service_healthy } }
    read_only: true
    tmpfs: [/tmp]

  figura-worker:
    build: { context: ./.companions/Figura, target: worker }
    environment:
      FIGURA_DATABASE_URL: postgres://figura:${FIGURA_DB_PASSWORD:?}@figura-db:5432/figura
      SYNTHETIC_SERVICE_SECRET: ${SYNTHETIC_SERVICE_SECRET:?}
      FIGURA_DATA_KEY: ${FIGURA_DATA_KEY:?}
      FIGURA_TARGETS: ${FIGURA_TARGETS:?}
      FIGURA_LOCAL_TARGET_HOSTS: backend,frontend
      FIGURA_PRODUCTION_HOSTS: ${FIGURA_PRODUCTION_HOSTS:-}
      FIGURA_SCREENSHOTS_DIR: /data/screenshots
    volumes: [figura_screenshots:/data/screenshots]
    extra_hosts: ['host.docker.internal:host-gateway']
    shm_size: 1gb
    depends_on:
      figura-db: { condition: service_healthy }
      backend: { condition: service_started }

volumes:
  figura_db: {}
  figura_screenshots: {}
```

The services must share a network with `backend` and `frontend` (the default compose network does).
No Figura port other than `127.0.0.1:4000` is published; the worker needs none.

## What Figura assumes of the Orqea it tests

- `GET /api` (nested descriptor), `POST /api/auth/register` / `login`, `GET /api/billing/plans` and
  the synthetic admin API under `/api/admin/synthetic/*` answering the worker's private address
  (Orqea's `localhostOnly` accepts compose peers).
- `@synthetic.invalid` passes the email allow-lists in synthetic mode **on the backend and in the web
  form**: the local stack builds the SPA with `REACT_APP_ALLOWED_EMAIL_DOMAINS=gmail.com`, whose
  in-form check blocks `synth+…@synthetic.invalid` before any request (see
  [ORQEA_UI_FACTS.md](ORQEA_UI_FACTS.md)).
- Socket.io: the browser's WebSocket to `ws://localhost:5001` is not rewritten (Playwright cannot
  redirect a WebSocket); Socket.io falls back to HTTP long-polling, which is.
