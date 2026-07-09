# FEATURES

## Cloudflare Worker Runtime

Stability: in-progress

Description:
- `vapid.party` is moving from a Vercel/Next API deployment to a Cloudflare Worker entrypoint.
- The Worker owns public API routing, CORS, health checks, generic Web Push endpoints, Converge XMTP endpoints, and queue consumption.
- The existing Next app remains in the repository as legacy/dashboard code while the Cloudflare runtime becomes the deployable target.

Properties:
- Wrangler config lives in `wrangler.jsonc`.
- Worker source lives under `src/worker`.
- Static assets from `public/` are available through the Worker assets binding.
- `npm run dev` starts Wrangler for local Worker development.
- `npm run build` produces a Wrangler dry-run bundle instead of a Vercel build.

Test Criteria:
- [x] `npm run lint`
- [x] `npm test`
- [x] `npm run build`
- [ ] `wrangler deploy` succeeds against the production Cloudflare account.

## D1 Persistence

Stability: in-progress

Description:
- Postgres persistence is being ported to D1.
- The schema keeps apps, VAPID key metadata, subscriptions, rate logs, XMTP identities, XMTP topics/HMAC registrations, delivery attempts, and relay cursors.

Properties:
- D1 migrations live in `migrations/d1`.
- App VAPID keys remain per app.
- Converge registration rows are keyed by push endpoint, `inboxId`, and `installationId`.
- XMTP topic/HMAC rows never store plaintext message content.

Test Criteria:
- [x] D1 migration applies locally with `npm run db:migrate`.
- [x] Idempotent Converge registration test passes.
- [x] Unsubscribe test disables the expected registration rows.

## Generic Web Push API

Stability: in-progress

Description:
- Existing generic Web Push behavior is ported to Worker routes.
- Owner/admin app routes retain wallet bearer auth.
- Generic subscription and send routes retain `X-API-Key` auth.

Properties:
- `POST /api/subscribe` requires `X-API-Key`.
- `POST /api/send` requires `X-API-Key` and enqueues push jobs.
- `GET /api/vapid/public-key` requires `X-API-Key`.
- Invalid subscriptions returned by push services are disabled.

Test Criteria:
- [ ] API-key-protected routes reject missing keys.
- [ ] Generic send enqueues queue jobs for selected subscriptions.
- [ ] Queue consumer updates delivery attempts.

## Converge XMTP Public Registration

Stability: in-progress

Description:
- Converge is a static PWA and must be able to register push subscriptions without a client secret.
- Public XMTP-aware routes are exposed under Converge's existing `https://vapid.party/api` base URL.

Properties:
- `GET /api/xmtp/vapid-public-key` requires no client secret.
- `POST /api/xmtp/subscriptions` requires no client secret.
- `DELETE /api/xmtp/subscriptions` requires no client secret.
- Registrations require `minimalPayloadOnly=true` and `plaintextPreview=false`.
- Registrations accept Web Push subscription data, `inboxId`, `installationId`, optional address, and topic/HMAC registrations.

Test Criteria:
- [x] Public Converge routes are not API-key gated.
- [x] Subscription payload validation rejects plaintext preview preferences.
- [x] Repeated registrations are idempotent for endpoint + inboxId + installationId.
- [x] Delete disables the matching Converge registration.

## Queue-Backed Push Delivery

Stability: in-progress

Description:
- Push sends are moved out of request handlers and into Cloudflare Queues.
- Queue retries and dead-letter handling are configured in Wrangler.

Properties:
- Queue producer binding is `PUSH_QUEUE`.
- Consumer uses bounded batches and retry delays.
- Dead-letter queue name is `vapid-party-push-dlq`.
- XMTP push payloads only contain generic metadata.

Test Criteria:
- [x] Queue payload shape test passes.
- [ ] Consumer records sent, failed, and expired subscription outcomes.
- [ ] Failed non-terminal sends retry through Queues.

## XMTP Topic/HMAC Relay Matching

Stability: in-progress

Description:
- Relay matching is based on XMTP topic/HMAC metadata from Converge registrations.
- The relay does not receive, store, forward, or preview plaintext XMTP message content.

Properties:
- Matching compares topic plus HMAC key metadata.
- Push payload is always generic: `xmtp.new_message`, `Converge`, `New encrypted message`, `/`.
- `conversationId` is only included when supplied as safe non-content metadata.
- Envelope ingestion rejects plaintext-like fields such as message body, sender name, previews, and attachment URLs.

Test Criteria:
- [x] HMAC/topic matching test passes without plaintext inputs.
- [x] Unsafe plaintext-like envelope fields are rejected.
- [x] Push payload shape excludes message text, sender names, previews, and attachment URLs.

## Durable Object Relay Coordination

Stability: in-progress

Description:
- Durable Objects provide shard ownership, relay cursor state, and restart coordination for XMTP monitoring.

Properties:
- Durable Object class is `RelayCoordinator`.
- Shards are claimed with expiring leases.
- Cursor updates are stored durably per shard.
- Release only succeeds for the current owner.

Test Criteria:
- [x] Worker bundle includes `RelayCoordinator`.
- [ ] Shard claim and cursor RPCs are covered before production monitor rollout.

## XMTP Monitor Runtime

Stability: planned

Description:
- The preferred production path is Worker-only XMTP monitoring if the SDK streaming path proves reliable in Workers.
- If the SDK requires a long-running Node process or unsupported runtime APIs, the monitor should run as a Cloudflare Container daemon and call the Worker internal envelope ingestion path.

Properties:
- Worker-only monitoring is not yet proven.
- Container monitor is documented as the production fallback.
- Internal envelope ingestion must not accept plaintext content.
- Cursor and shard ownership state are durable.

Test Criteria:
- [ ] Worker-only XMTP SDK stream is tested for reconnect and catch-up behavior.
- [ ] If Worker-only is not reliable, Container daemon is implemented and deployed.
- [ ] Real Converge end-to-end push test passes before marking stable.

## Privacy And Security Model

Stability: in-progress

Description:
- `vapid.party` acts only as an encrypted-message wake-up relay for Converge.
- Message sync and decryption stay in Converge through XMTP local client behavior.

Properties:
- Converge public registration requires no baked client API key.
- Admin/dashboard/API-key auth remains scoped to owner and generic app operations.
- XMTP push payloads contain no plaintext body, sender display name, decrypted content, attachment URL, or preview.
- Unknown or unimplemented product metrics must not be shown as real values.

Test Criteria:
- [x] Public Converge endpoint tests pass without `X-API-Key`.
- [x] Payload privacy tests pass.
- [x] Docs separate implemented behavior from planned monitor/deployment work.

## Deployment And End-To-End Verification

Stability: planned

Description:
- Production is not complete until the Worker is deployed, D1/Queue/DO bindings are provisioned, `vapid.party` points at Cloudflare, and Converge receives a real push.

Properties:
- Cloudflare deployment requires account authentication and real D1/Queue resources.
- `vapid.party` route/custom domain must be configured in Cloudflare.
- A real browser push subscription and Converge XMTP registration must be used for final verification.
- Current blocker: `npx wrangler whoami` reports the Cloudflare auth token is expired in this non-interactive shell.

Test Criteria:
- [ ] D1 database and queues are created in Cloudflare.
- [ ] Secrets and vars are configured in Cloudflare.
- [ ] `wrangler deploy` completes.
- [ ] `https://vapid.party/api/xmtp/vapid-public-key` returns the production public VAPID key.
- [ ] Real Converge end-to-end push delivery succeeds.
