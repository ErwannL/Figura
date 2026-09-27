# Figura by Orqea

**Synthetic users, real friction.** Figura answers _"how would real people experience Orqea?"_
without real people: ten deterministic personas (extensible) each live a full user life in the web
app — landing, signup, email verification, login, onboarding, then the features their goals and
personality lead them to — while every step is scored for friction. A persona whose frustration
exceeds its tolerance abandons, as a real user would.

No AI: rules, weights and a seeded random generator. Same seed + same target + same catalogue ⇒
same decisions. Every report says it: _Simulation of N modelled personas, not a measurement of real users._

## What you get

- **Use-case funnel** per persona with abandon reasons and screenshots, headline funnel, coverage matrix.
- **Change reaction (A/B)**: same seed against two targets or two scenarios — who got hurt.
- **Load / usage forecast** for 100 / 1 000 / 10 000 users; **volume mode** measures p50/p95/p99.
- **Pricing / conversion** under the target's prices and your alternatives.
- **Calibration** against real aggregates (suggestions only).
- **Persona inspector**: timeline, facts, friction, the exact rule behind each decision, screenshots.
- **Explorer** ([docs/EXPLORATEUR.md](docs/EXPLORATEUR.md)): 1–3 synthetic personas explore the web app on
  desktop, tablet and mobile at a human pace, screenshot every new screen and report anomalies (JS errors,
  5xx, NotFound, layout, accessibility, raw i18n keys, slowness, traps) with evidence and a seeded replay.

## Quick start

See [docs/RUNBOOK.md](docs/RUNBOOK.md): `cp .env.example .env`, fill secrets, `docker compose up --build`,
open `http://localhost:4100/console`.

## Layout

| Folder        | Purpose                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `app/`        | API, SSO, sessions, security, Postgres access                           |
| `worker/`     | Run lifecycle, journey engine, friction model, drivers, guard, reports  |
| `ui/`         | Operator UI (EN/FR)                                                     |
| `shared/`     | Schemas, loaders, PRNG, crypto, JWT, i18n                               |
| `personas/`   | Persona data files + tests                                              |
| `catalogue/`  | Versioned use-case catalogue                                            |
| `config/`     | Friction weights, time multipliers, common UI names                     |
| `fake-orqea/` | Test double of Orqea (real paths, payloads, names) + friction scenarios |
| `e2e/`        | End-to-end tests                                                        |
| `brand/`      | Logo, icons, brand guide                                                |
| `scripts/`    | Repository gates and tooling                                            |
| `docs/`       | Architecture, decisions, contract, security, coverage, runbook          |

## Quality gates (CI and pre-commit)

Prettier, ESLint with 0 warnings, `tsc`, files ≤ 1000 lines / functions ≤ 80 lines, LF only, a
README in every folder, no skipped tests, secret scan, **100 % coverage per file**, build, e2e,
`npm audit`, `docker compose build`, smoke `up` + health checks, catalogue drift.

## Contract with Orqea

[docs/ORQEA_CONTRACT.md](docs/ORQEA_CONTRACT.md) (Orqea's real API shapes, the SSO `target` claim,
refusal codes), [docs/ORQEA_INTEGRATION.md](docs/ORQEA_INTEGRATION.md) (running inside Orqea's docker
compose: services, env vars, `FIGURA_TARGETS`) and [docs/ORQEA_UI_FACTS.md](docs/ORQEA_UI_FACTS.md)
(what Orqea's UI does not name, as friction facts).

Figura targets the Orqea environment the admin console is inspecting (`local` or `recette`, never
production): the console signs it into the SSO token and the new-run form preselects it.
