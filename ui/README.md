# ui/

The operator web UI (TypeScript, no framework, built by Vite into `dist/ui`).

## How it works

`main.ts` calls `boot()` (`app.ts`): SSO bootstrap from `#sso=` (`sso.ts`) — without a session only the "open me from the Orqea admin console" notice — then hash routing to the views (unknown route ⇒ branded 404). `brand.ts` holds the shared branding: animated-logo loader, « by Orqea », credits (Orqea + Erwann Laplante) and « Back to Orqea », whose URL comes from `/health` (`FIGURA_ORQEA_URL`). Every visible string is a key of `shared/i18n.ts` (EN/FR). `dom.ts` never uses innerHTML.

## Sub-folders

- `views/` — Runs, new run, run detail + persona inspector, compare, personas.
- `public/` — Static files copied as-is (stylesheet, logo, favicon).
