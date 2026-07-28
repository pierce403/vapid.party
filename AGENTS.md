# Agent Guidelines for vapid.party

## Scope
These instructions apply to the entire repository.

## Self-improvement directive
- When you learn a durable workflow, command, pitfall, or convention, record it where future agents will look.
- Keep `AGENTS.md` concise and canonical; put longer reusable knowledge in `MEMORY.md`, `memory/`, `SKILLS.md`, or `skills/<name>/SKILL.md`.
- Prefer updates that make the next run faster or safer; avoid one-session trivia.

## Responsibilities
- Keep the Web Push relay honest about shipped behavior.
- Preserve public app-secret, enrollment-ticket, management-token, operator
  API-key, and internal bearer boundaries plus per-app VAPID key isolation.
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
- Anonymous app creation returns one raw `vp_` app secret once and stores only
  its SHA-256 digest. Pre-provisioned operator apps retain their API-key flow.
- Runtime auth is split between app credentials, endpoint-bound enrollment
  tickets, per-subscription management tokens, restricted public Converge
  registration, and separate listener-control and delivery-ingest bearers.
- VAPID keypairs are generated per app and remain server-managed; only the
  public VAPID key is published to browser clients.

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
- `maxNotificationsPerDay` is enforced with a UTC-day window.
- Public XMTP enrollment requires an exact-body app ticket plus Ed25519
  installation-key possession proof. Never re-open the legacy app-secret-only
  XMTP route or let an exact proof replay rotate its management receipt.
- HTTPS callback targets must remain on the exact fresh verified app domain at
  ticket mint. Stale prior verification may be re-resolved under bounded DNS
  limits, but existing routes must not silently expire when freshness ages out.
- Callback signatures use the app VAPID P-256 key and raw 64-byte IEEE-P1363
  ECDSA, not DER. A terminal 404/410 must remove the full logical route and its
  topic/HMAC state, not only stop one attempt; it must retain a physical callback
  URL while another logical route uses it.
- For HTTPS callbacks, `(appId, inboxHandle)` is one recipient. Activate a newly
  proved installation before retiring older installations with that handle, and
  keep trusted receipt-free handle revocation app-secret-only and private.
- Public generic sends are bounded to 100 recipients, a 3,000-byte JSON
  payload, and an estimated 240,000-byte single Queue batch. Shared public
  relay ceilings are 2,000 selected deliveries/minute and 100,000/day.
- Hard anonymous-state ceilings are 25,000 public apps, 250,000 public
  subscription rows, and 150 subscriptions per public app. D1 triggers are the
  concurrency-safe enforcement layer; API checks provide earlier responses.
- Node.js 22+ is required by the pinned Wrangler 4.114.0 and Miniflare
  4.20260722.0 toolchain.
- `npm audit --audit-level=low` is a release gate and must remain at zero findings.
- `npm audit` does not cover `infra/xmtp-listener/go.mod`; reconcile open Go
  Dependabot alerts separately, then rerun the listener race tests and `go vet`.
- `npm test` runs Vitest, and the D1 test uses Miniflare/workerd. Sandboxes that
  prohibit a localhost socket must run it with the required process permission.
- Explicit Converge unsubscribe deletes inbox topic/HMAC material immediately;
  it keeps a physical endpoint only while another active logical inbox shares it.
- Public Converge registration accepts only strict nested version 1. Keep the
  FCM/Mozilla/Apple/WNS endpoint allowlist, 400-topic/800-row cost ceiling,
  decoded 1..256-byte HMAC key bound, and uint32 epoch bound aligned across
  Zod, OpenAPI, README, FEATURES, and `public/llms.txt`.
- A diagnostic receipt is a 256-bit bearer management capability whose raw
  value is returned only in a no-store response and never persisted or logged.
  Valid receipts survive endpoint replacement for lost-response retry safety.
- Public first claim is not signed XMTP ownership proof and retains a bounded
  route-squatting denial-of-service risk. Never present this Converge-only
  compatibility route as a general multi-tenant enrollment API.
- Topic replacement is a transactional D1 batch, but the entire registration
  mutation is not atomic. Preserve dirty-route repair and do not document
  stronger guarantees.
- Listener topic plus HMAC state is capped at 5,000 rows per app and 25,000
  rows globally. Snapshot and delta pages are capped at 10 routes.
- The deployed v2 listener still requests control pages with `limit=100`.
  Worker parsing must clamp positive legacy limits to 10 instead of rejecting
  them, unless the Container rollout is coordinated first.
- After every Worker deploy, wait through at least two listener control polls
  and require public health to return `deliveryReady: true`, listener `ready`,
  and bridge `synced` before declaring success.
- Public health must diagnose listener heartbeat, XMTP stream/ingest, route
  bridge, source Queue, and dead-letter Queue independently, while reporting
  latest allowlisted target outcomes without making one recipient's failure a
  global outage. The singleton `service_activity` row is an overwrite-only
  timestamp aggregate, never event or message history.
- XMTP listener routes are keyed by `(appId, installationId)`. Never union HMAC
  keys or fan out registrations across apps, even for a shared installation or
  topic. Listener-to-Worker delivery is a minimal authenticated hint and must
  never include XMTP ciphertext, sender identity, or message content.
- Listener logs must not include installation ids, exact topics, HMAC material,
  delivery tokens, or raw index-validation errors that can embed those values.
  Keep route failures categorical and diagnose route specifics in local tests.
- Internal listener control and delivery clients carry bearer capabilities and
  must never follow HTTP redirects; only the exact configured Worker URLs are
  valid trust targets.
- Production has D1 migrations 0001 through 0008, the version-6 public-health
  Worker contract, Queue, and the singleton custom Go XMTP listener Container
  deployed. The disposable public-app canary passed on 2026-07-15. Public
  health reported `deliveryReady: true`, listener `ready`, and bridge `synced`
  on 2026-07-14. On 2026-07-15 the same `streamConnectedAt` survived for 11
  minutes 31 seconds across the former ten-minute idle cutoff. `SubscribeAll`
  has no listener replay cursor, so push can still have restart/disconnect gaps
  while normal XMTP client sync remains authoritative.
- On 2026-07-28 Worker version
  `7b09d687-5163-4e40-bef0-0c69fc4d0393` passed multiple post-deploy health
  polls and live-browser verification. The Worker-only rollout preserved the
  Container's `2026-07-28T05:15:16.356672269Z` stream connection.
- Migration 0007 adds delivery-kind labeling for public XMTP callbacks and must
  be applied before deploying the matching version-5 Worker.
- XMTP stream traffic is background work and does not renew the Container
  helper's `sleepAfter` timer. Preserve the listener's `onActivityExpired()`
  renewal override; the minute `startAndWaitForPorts()` cron starts and checks
  the process but its already-running fast path does not renew activity.
- XMTP v3 group message topics contain a 16-byte group id (`g-` plus 32 hex
  characters). Welcome topics contain the 32-byte installation id (`w-` plus
  64 hex characters). Never apply one identifier length to both topic kinds.
- Generic notification payloads and provider error bodies are never retained
  in D1. Source Queue and dead-letter Queue retention must each be verified at
  3,600 seconds; the two windows can occur sequentially. Queue delivery is
  at-least-once, so preserve tuple-bound processing leases, generation-safe
  completion, retry classification, and two-hour stale-attempt reconciliation.
- For GitHub auth, prefer `gh`/HTTPS over SSH. If SSH signing fails, run `gh auth setup-git` and use an HTTPS origin.
