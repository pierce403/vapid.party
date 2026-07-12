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
- Production Worker is deployed at `https://vapid-party.bcrt43.workers.dev` and `https://vapid.party`.
- `vapid.party` is an active Cloudflare zone and the Worker custom domain is attached.

Test Criteria:
- [x] `npm run lint`
- [x] `npm test`
- [x] `npm run build`
- [x] Worker upload/deployment succeeds against the production Cloudflare account.
- [x] `wrangler deploy` succeeds with the `vapid.party` custom domain after the Cloudflare zone exists.

## D1 Persistence

Stability: in-progress

Description:
- Postgres persistence is being ported to D1.
- The schema keeps apps, VAPID key metadata, physical Web Push subscriptions,
  logical XMTP registrations, XMTP topics, per-epoch HMAC keys, idempotent
  delivery events, delivery attempts, rate logs, and relay cursors.

Properties:
- D1 migrations live in `migrations/d1`.
- Remote D1 database is `vapid-party` / `c78e2c36-5768-43e1-936e-79b5850871bb`.
- App VAPID keys remain per app.
- Converge registration rows are keyed by push endpoint, `inboxId`, and `installationId`.
- A welcome topic is represented without an HMAC row; a conversation topic can
  own multiple epoch-key rows.
- Deleting one logical inbox registration removes its identity/topic/HMAC rows.
  A shared physical Web Push endpoint remains only while another active logical
  inbox uses it; the last delete removes endpoint, `p256dh`, and `auth` data.
- XMTP topic/HMAC rows never store plaintext message content.

Test Criteria:
- [x] D1 migration applies locally with `npm run db:migrate`.
- [x] Migration 0002 is applied to the production D1 database.
- [x] Idempotent Converge registration test passes.
- [x] Unsubscribe test disables the expected registration rows.
- [x] Migration 0002 preserves seeded version-1 topics, HMAC keys, delivery
  references, and foreign-key integrity.

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
- The reserved Converge app's generic API-key routes fail closed unless the
  `CONVERGE_API_KEY` Worker secret is configured.

Test Criteria:
- [ ] API-key-protected routes reject missing keys.
- [x] Reserved Converge generic routes fail closed without the secret binding.
- [x] Production rejects the former source-visible Converge generic API key.
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
- The primary nested version-1 request accepts Web Push subscription data,
  identity metadata, XMTP topics and epoch keys, an opaque `inboxHandle`, and
  registration metadata emitted by Converge.
- The former flattened request remains accepted for older clients.
- `inboxHandle` is restricted to a base64url-style opaque token; display names
  and raw inbox ids are not valid handles.

Test Criteria:
- [x] Public Converge routes are not API-key gated.
- [x] Subscription payload validation rejects plaintext preview preferences.
- [x] Repeated registrations are idempotent for endpoint + inboxId + installationId.
- [x] Delete disables the matching Converge registration.
- [x] Nested Converge registration accepts multiple HMAC epochs and a welcome
  topic with no HMAC.
- [x] Delete keeps other logical registrations on the shared endpoint active.
- [x] Production VAPID, registration, and logical-delete routes are live at
  `https://vapid.party/api/xmtp/*`.

## Queue-Backed Push Delivery

Stability: in-progress

Description:
- Push sends are moved out of request handlers and into Cloudflare Queues.
- Queue retries and dead-letter handling are configured in Wrangler.

Properties:
- Queue producer binding is `PUSH_QUEUE`.
- Remote queues are `vapid-party-push-send` and `vapid-party-push-dlq`.
- Consumer uses bounded batches and retry delays.
- Dead-letter queue name is `vapid-party-push-dlq`.
- XMTP push payloads only contain generic metadata.

Test Criteria:
- [x] Queue payload shape test passes.
- [ ] Consumer records sent, failed, and expired subscription outcomes.
- [ ] Failed non-terminal sends retry through Queues.

## XMTP Notification Delivery Matching

Stability: in-progress

Description:
- An official XMTP notification-server listener performs network subscription,
  HMAC filtering, sender suppression, and `shouldPush` evaluation before HTTP
  delivery to the Worker.
- The relay does not receive, store, forward, or preview plaintext XMTP message content.

Properties:
- Worker matching uses the official delivery's `installation.id` plus
  `subscription.topic`; it never asks the delivery caller to resend an HMAC
  secret.
- Retries are deduplicated per installation, topic, physical subscription, and
  official `idempotency_key`.
- Push payload is minimal: `xmtp.new_message` plus the opaque `inboxHandle`.
- Converge's service worker owns all visible copy and click navigation.
- Official encrypted envelope bytes are shape-validated and immediately
  discarded; they are never stored or included in Web Push.
- Delivery honors `message_context.should_push=false` defensively even though
  the official listener already suppresses it.

Test Criteria:
- [x] Installation/topic matching test passes without delivery HMAC secrets.
- [x] Official request extensions and conflicting topics are rejected.
- [x] Duplicate idempotency keys do not enqueue twice.
- [x] `should_push=false` does not enqueue.
- [x] Push payload shape excludes message text, sender names, previews, and attachment URLs.
- [x] Shared-endpoint D1 test keeps the physical endpoint until the last logical
  delete, then removes endpoint keys and inbox HMAC material.
- [x] A production synthetic test used real Chrome and one physical FCM endpoint
  for two logical inboxes, delivered welcome and group events through D1 ->
  Queue -> FCM -> Converge's service worker, and verified idempotency,
  `should_push=false`, logical deletion, post-delete suppression, local-only
  profile copy, and cleanup.

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

## XMTP Listener Runtime

Stability: planned

Description:
- The production design uses XMTP's `example-notification-server-go` as the
  long-running network listener and the Worker as the Web Push delivery adapter.

Properties:
- `POST /api/internal/xmtp/deliveries` accepts the official HTTP `SendRequest`
  JSON and requires `Authorization: Bearer <INTERNAL_INGEST_TOKEN>`.
- `X-Internal-Token` and `/api/internal/xmtp/envelopes` remain compatibility
  aliases for the same request schema.
- The official adapter requires HTTP 200, which the Worker returns after queueing
  or idempotently recognizing the delivery.
- The official listener still must be deployed with Postgres and XMTP network
  access before real messages can trigger delivery continuously.
- The bearer-protected production ingest has been exercised with XMTP's official
  v3 notification server running temporarily against PostgreSQL. That test used
  genuine installation-welcome and conversation envelopes, three HMAC epochs,
  and verified own-message suppression through the Converge service worker.

Test Criteria:
- [x] Official HTTP delivery request shape is covered by contract tests.
- [x] Production internal delivery ingest is live and rejects unauthenticated
  requests.
- [x] A full production data-path test passes with the official v3 listener and
  temporary PostgreSQL: genuine welcome, inbound conversation push, three HMAC
  epochs, and own-message suppression.
- [ ] Official notification-server listener is deployed and its reconnect and
  catch-up behavior is observed in production.

## Privacy And Security Model

Stability: in-progress

Description:
- `vapid.party` acts only as an encrypted-message wake-up relay for Converge.
- Message sync and decryption stay in Converge through XMTP local client behavior.

Properties:
- Converge public registration requires no baked client API key.
- Admin/dashboard/API-key auth remains scoped to owner and generic app operations.
- XMTP push payloads contain no plaintext body, sender display name, decrypted content, attachment URL, or preview.
- The Worker does not store or forward the encrypted envelope bytes delivered by
  the official listener.
- `inboxHandle` is opaque and is the only inbox-routing value in Web Push.
- Unknown or unimplemented product metrics must not be shown as real values.

Test Criteria:
- [x] Public Converge endpoint tests pass without `X-API-Key`.
- [x] Payload privacy tests pass.
- [x] Source-visible Converge bootstrap API key is removed.
- [x] Docs separate implemented behavior from planned monitor/deployment work.

## Deployment And End-To-End Verification

Stability: in-progress

Description:
- The Worker, D1/Queue/DO bindings, custom domain, and relay data path are
  deployed and verified. Continuous automatic XMTP delivery remains incomplete
  until the official listener and its PostgreSQL database run persistently.

Properties:
- Cloudflare deployment requires account authentication and real D1/Queue resources.
- `vapid.party` route/custom domain must be configured in Cloudflare.
- A real browser push subscription and Converge XMTP registration must be used for final verification.
- Current Worker URLs: `https://vapid-party.bcrt43.workers.dev` and `https://vapid.party`.
- The production relay passed both a synthetic real-Chrome delivery test and a
  genuine XMTP v3 end-to-end test driven by a temporary official listener.
- Current remaining blocker: no always-on official XMTP listener/PostgreSQL is
  deployed, so production does not continuously monitor XMTP for notifications.
- DNS note: Cloudflare authoritative DNS returns Worker-managed records for `vapid.party`; some recursive resolvers may briefly lag after the cutover.
- Wrangler auth is available by passing the valid `cf` OAuth token from `~/.cf/config.toml` as `CLOUDFLARE_API_TOKEN`.

Test Criteria:
- [x] D1 database and queues are created in Cloudflare.
- [x] Secrets and vars are configured in Cloudflare.
- [x] Worker deployment exists in Cloudflare.
- [x] `https://vapid-party.bcrt43.workers.dev/api/xmtp/vapid-public-key` returns the production public VAPID key.
- [x] `vapid.party` Cloudflare zone is created/activated.
- [x] `wrangler deploy` completes with `https://vapid.party` custom domain attached.
- [x] `https://vapid.party/api/xmtp/vapid-public-key` returns the production public VAPID key.
- [x] Two logical inboxes sharing one real browser endpoint pass production
  welcome/group delivery, suppression, privacy, deletion, and cleanup checks.
- [x] Genuine XMTP v3 welcome and group-message delivery reaches Converge through
  the production relay when the official listener is run temporarily.
- [ ] Deploy and observe an always-on official listener with durable PostgreSQL.
