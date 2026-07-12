# Agent Guidelines for vapid.party

## Scope
These instructions apply to the entire repository.

## Self-improvement directive
- When you learn a durable workflow, command, pitfall, or convention, record it where future agents will look.
- Keep `AGENTS.md` concise and canonical; put longer reusable knowledge in `MEMORY.md`, `memory/`, `SKILLS.md`, or `skills/<name>/SKILL.md`.
- Prefer updates that make the next run faster or safer; avoid one-session trivia.

## Responsibilities
- Keep the Web Push relay honest about shipped behavior.
- Preserve wallet/API-key auth boundaries and per-app VAPID key isolation.
- Keep API handlers, Zod schemas, OpenAPI docs, LLM docs, README examples, and UI copy aligned.
- Verify changes with the relevant local workflow before landing.

## Git hygiene (required)
- Always `git commit` and `git push` whenever you finish a discrete piece of work (after `npm run lint` / `npm run build` if relevant).

## Core practices
- Avoid pretend data: don’t display “sample” counts, quotas, or marketing stats unless they are backed by real logic/data. If something isn’t implemented, hide it or label it explicitly as a placeholder.
- Prefer truth over polish: if a value is unknown, render “—” or omit the UI instead of inventing a default that looks like real usage.
- Keep product surface honest: UI/README/API docs should not claim limits/metrics/features that the backend doesn’t enforce or record.

## Implementation notes
- If a UI element implies user data (e.g., “subscribers”), it must be computed from persisted data (DB) and named clearly (e.g., “subscriber count” vs “subscription limit”).
- Keep “demo/dev shortcuts” (mock auth, fixtures) clearly gated (env flag) and never shipped as the default behavior.
- Public docs must distinguish enforced behavior from stored configuration or planned features.

## Style and structure (per recurse.bot guidance)
- Keep instructions concise and actionable; prefer bullet points over long prose.
- Update this file when workflows, conventions, or sharp edges change.
- Avoid redundant/conflicting directives; add scoped AGENTS files only when necessary.
- `AGENTS.md` is canonical. Use symlinks for harness-specific instruction files when needed.
- Use `MEMORY.md` as the compact map for durable notes, and `SKILLS.md` as the compact catalog for reusable procedures.
- Keep detailed procedures in `skills/<name>/SKILL.md`; use `curator` as the default skill for updating the skill library.

## Project overview
- Cloudflare Worker Web Push relay; the Next.js app remains as legacy dashboard code.
- Worker data lives in D1 with migrations under `migrations/d1`; legacy Next data uses Postgres.
- Auth is split between wallet bearer tokens for app management, `X-API-Key`
  for generic push, public Converge registration, and a secret bearer token for
  official XMTP notification-server delivery.
- VAPID keypairs are generated per app and stored with app records.

## Project shape
- `src/worker/`: primary deployed Worker API, D1 store, Queue producer/consumer,
  validation, and Web Push delivery.
- `migrations/d1/`: ordered production D1 migrations.
- `tests/worker/`: contract tests plus a Miniflare D1 integration test.
- `app/api/`: API route handlers; keep `runtime = 'nodejs'` for routes that use Node-only libraries.
- `lib/types.ts`: Zod schemas and TypeScript API types; update this before or with API behavior changes.
- `lib/db.ts`: table creation, mapping, CRUD, subscription counting, and rate-limit log operations.
- `lib/notifications.ts`: web-push delivery, targeting, expired subscription cleanup, and per-minute send limiting.
- `public/openapi.yaml` and `public/llms.txt`: machine-readable API docs that must stay in sync with shipped handlers.
- `components/` and `app/dashboard/`: product surface; do not display unsupported metrics or limits.

## Local workflows
- Dev: `npm run dev`
- Lint: `npm run lint`
- Tests: `npm test`
- Build: `npm run build`
- DB migrate: `npm run db:migrate`

## Known sharp edges
- `maxSubscriptions` is enforced on subscribe requests.
- `maxNotificationsPerMinute` is enforced on send requests.
- `maxNotificationsPerDay` exists in stored app config but is not currently enforced by a daily window.
- `npm run build` fetches Google Fonts through `next/font` in `app/layout.tsx`; sandboxed builds may need network approval or self-hosted fonts.
- `npm test` runs Vitest, and the D1 test uses Miniflare/workerd. Sandboxes that
  prohibit a localhost socket must run it with the required process permission.
- Explicit Converge unsubscribe deletes inbox topic/HMAC material immediately;
  it keeps a physical endpoint only while another active logical inbox shares it.
- The official XMTP HTTP delivery adapter retries every non-200 response and
  must receive a minimal `{type, inboxHandle}` Web Push payload.
- Production has the D1 0002 schema and the current Worker contract deployed.
  Public XMTP registration/delete and bearer-protected official delivery ingest
  are live. The D1 -> Queue -> FCM -> Converge service-worker path has passed a
  real-Chrome test, and the production XMTP path has passed with the official v3
  notification server running temporarily against PostgreSQL.
- No always-on XMTP listener or PostgreSQL is deployed. Do not describe push as
  continuously available until that runtime is deployed and observed; the live
  tests prove the relay data path, not persistent network monitoring.
- For GitHub auth, prefer `gh`/HTTPS over SSH. If SSH signing fails, run `gh auth setup-git` and use an HTTPS origin.
