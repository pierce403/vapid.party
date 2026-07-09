# Project Shape

## Current App

- Next.js 14 app-router project for a Web3-authenticated Web Push relay.
- App management uses wallet bearer auth; push subscription and send routes use `X-API-Key`.
- Each app has its own VAPID keypair stored in Postgres.
- `lib/types.ts` owns Zod request schemas and shared TypeScript API types.
- `lib/db.ts` owns table creation, row mapping, CRUD, subscription counts, and rate-limit logs.
- `lib/notifications.ts` owns web-push delivery, targeting, expired subscription cleanup, and per-minute send limiting.
- `public/openapi.yaml`, `public/llms.txt`, README examples, and dashboard snippets are public API contract surfaces.

## Local Commands

- Dev: `npm run dev`
- Lint: `npm run lint`
- Tests: `npm test`
- Build: `npm run build`
- DB migrate: `npm run db:migrate`

Verified during the 2026-07-08 structure pass:

- `npm run lint`
- `npm run build` (requires network access for `next/font` Google Fonts fetches)

## Product-Honesty Constraints

- `maxSubscriptions` is enforced on subscribe requests using the persisted subscription count.
- `maxNotificationsPerMinute` is enforced on send requests using `rate_limit_logs`.
- `maxNotificationsPerDay` is stored in app `rateLimit` config but no daily enforcement window currently uses it.
- Do not claim upgrade paths, analytics, global delivery infrastructure, or usage stats unless backed by shipped code or explicitly labeled future/planned.
- If a value is unknown or not persisted, render `--`, omit it, or label it as a placeholder.

## Change Discipline

- Keep API behavior, Zod schemas, OpenAPI docs, `llms.txt`, README examples, and dashboard snippets synchronized.
- Preserve Node runtime for route handlers that depend on Node-only libraries like `web-push`.
- Run the relevant checks before committing and pushing finished work.
- Prefer GitHub CLI/HTTPS auth for pushes; SSH signing can fail in this environment.
