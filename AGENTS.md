# Agent Guidelines for vapid.party

## Scope
These instructions apply to the entire repository.

## Self-improvement directive
- When you learn a durable workflow, command, pitfall, or convention, record it where future agents will look.
- Keep `AGENTS.md` concise and canonical; put longer reusable knowledge in `MEMORY.md`, `memory/`, `SKILLS.md`, or `skills/<name>/SKILL.md`.
- Prefer updates that make the next run faster or safer; avoid one-session trivia.

## Responsibilities
- Keep the Web Push relay honest about shipped behavior.
- Preserve operator/API-key auth boundaries and per-app VAPID key isolation.
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
- Cloudflare-only Worker Web Push relay; there is no supported Next.js or Vercel runtime.
- Worker and XMTP registration data live in D1 with migrations under
  `migrations/d1`. The always-on XMTP v3 listener is a singleton Cloudflare
  Container with an atomic in-memory routing index; do not add PostgreSQL or a
  separate public listener service.
- App provisioning is operator-only. Runtime auth is split between `X-API-Key`
  for generic app routes, restricted public Converge registration, and separate
  secret bearer tokens for listener control/status and delivery ingest.
- VAPID keypairs are generated per app and stored with app records.

## Project shape
- `src/worker/`: primary deployed Worker API, D1 store, Queue producer/consumer,
  validation, and Web Push delivery.
- `migrations/d1/`: ordered production D1 migrations.
- `tests/worker/`: contract tests plus a Miniflare D1 integration test.
- `infra/xmtp-listener/`: custom Go XMTP v3 `SubscribeAll` listener, container
  image, tests, and production canary runbook.
- `public/openapi.yaml` and `public/llms.txt`: machine-readable API docs that must stay in sync with shipped handlers.
- Do not add a Vercel/Next runtime or PostgreSQL listener state. The supported
  deployment is Worker + D1 + Queue + singleton Cloudflare Container.

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
- Node.js 22+ is required by Wrangler 4.110.0 and the matching Miniflare/Worker-types toolchain.
- `npm audit --audit-level=low` is a release gate and must remain at zero findings.
- `npm test` runs Vitest, and the D1 test uses Miniflare/workerd. Sandboxes that
  prohibit a localhost socket must run it with the required process permission.
- Explicit Converge unsubscribe deletes inbox topic/HMAC material immediately;
  it keeps a physical endpoint only while another active logical inbox shares it.
- Public Converge registration accepts only strict nested version 1. Keep the
  FCM/Mozilla/Apple/WNS endpoint allowlist, 400-topic/800-row cost ceiling,
  1024-character key bound, and uint32 epoch bound aligned across Zod, OpenAPI,
  README, FEATURES, and `public/llms.txt`.
- A diagnostic receipt is a 256-bit bearer management capability whose raw
  value is returned only in a no-store response and never persisted or logged.
  Valid receipts survive endpoint replacement for lost-response retry safety.
- Public first claim is not signed XMTP ownership proof and retains a bounded
  route-squatting denial-of-service risk. Never present this Converge-only
  compatibility route as a general multi-tenant enrollment API.
- Topic replacement is a transactional D1 batch, but the entire registration
  mutation is not atomic. Preserve dirty-route repair and do not document
  stronger guarantees.
- XMTP listener routes are keyed by `(appId, installationId)`. Never union HMAC
  keys or fan out registrations across apps, even for a shared installation or
  topic. Listener-to-Worker delivery is a minimal authenticated hint and must
  never include XMTP ciphertext, sender identity, or message content.
- Production has D1 migrations 0001 through 0004, the current Worker contract,
  Queue, and the singleton custom Go XMTP listener Container deployed. Public
  health reported `deliveryReady: true`, listener `ready`, and bridge `synced`
  on 2026-07-14. `SubscribeAll` has no listener replay cursor, so push can still
  have restart/disconnect gaps while normal XMTP client sync remains authoritative.
- XMTP stream traffic is background work and does not renew the Container
  helper's `sleepAfter` timer. Preserve the listener's `onActivityExpired()`
  renewal override; the minute `startAndWaitForPorts()` cron starts and checks
  the process but its already-running fast path does not renew activity.
- XMTP v3 group message topics contain a 16-byte group id (`g-` plus 32 hex
  characters). Welcome topics contain the 32-byte installation id (`w-` plus
  64 hex characters). Never apply one identifier length to both topic kinds.
- For GitHub auth, prefer `gh`/HTTPS over SSH. If SSH signing fails, run `gh auth setup-git` and use an HTTPS origin.
