# Project Shape

## Current App

- Cloudflare-only Worker project for a Web Push and XMTP-aware relay, backed by
  D1, Queue, and one custom Go XMTP listener Container. There is no supported
  Vercel/Next or PostgreSQL runtime.
- App provisioning is operator-only; generic app routes use `X-API-Key`,
  Converge has a restricted public compatibility route, and listener control
  plus delivery use separate bearer secrets.
- Each app has its own VAPID keypair stored in D1.
- `src/worker/schemas.ts` owns Zod request schemas; `src/worker/types.ts` owns shared Worker types.
- `src/worker/db.ts` owns D1 row mapping, CRUD, subscription counts, and rate-limit logs.
- `src/worker/push.ts`, `src/worker/core.ts`, and `src/worker/queue.ts` own Web Push delivery, XMTP targeting, expired-subscription cleanup, and queued delivery.
- `infra/xmtp-listener/` owns the singleton production `SubscribeAll` listener;
  its routing snapshot/cursor is supplied by D1 through authenticated Worker APIs.
- `public/openapi.yaml`, `public/llms.txt`, and README examples are public API contract surfaces.

## Local Commands

- Dev: `npm run dev`
- Lint: `npm run lint`
- Tests: `npm test`
- Build: `npm run build`
- DB migrate: `npm run db:migrate`

Verified during the 2026-07-08 structure pass:

- `npm run lint`
- `npm run build` (Wrangler dry-run bundle; requires Node.js 22+)

## Product-Honesty Constraints

- `maxSubscriptions` is enforced on subscribe requests using the persisted subscription count.
- `maxNotificationsPerMinute` is enforced on send requests using `rate_limit_logs`.
- `maxNotificationsPerDay` is stored in app `rateLimit` config but no daily enforcement window currently uses it.
- Do not claim upgrade paths, analytics, global delivery infrastructure, or usage stats unless backed by shipped code or explicitly labeled future/planned.
- If a value is unknown or not persisted, render `--`, omit it, or label it as a placeholder.

## Change Discipline

- Keep Worker API behavior, Zod schemas, OpenAPI docs, `llms.txt`, and README examples synchronized.
- Preserve the Worker compatibility flags required by `web-push` and verify delivery code in Wrangler/Miniflare.
- Run the relevant checks before committing and pushing finished work.
- Prefer GitHub CLI/HTTPS auth for pushes; SSH signing can fail in this environment.
