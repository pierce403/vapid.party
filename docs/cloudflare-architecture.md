# Cloudflare Architecture

This document separates the deployed and verified Cloudflare relay path from the
still-missing always-on XMTP listener runtime.

## Implemented

- Cloudflare Worker entrypoint in `src/worker/index.ts`.
- Public Converge routes:
  - `GET /api/xmtp/vapid-public-key`
  - `POST /api/xmtp/subscriptions`
  - `DELETE /api/xmtp/subscriptions`
- API-key-protected generic Web Push routes:
  - `GET /api/vapid/public-key`
  - `POST /api/subscribe`
  - `POST /api/send`
- Owner/admin app routes with wallet bearer auth.
- D1 migration for apps, subscriptions, XMTP identities, topic/HMAC registrations, delivery attempts, rate limits, usage logs, and relay cursors.
- Queue-backed push jobs with retry/dead-letter configuration in `wrangler.jsonc`.
- Durable Object `RelayCoordinator` for shard leases and cursor state.
- Internal official XMTP HTTP delivery route at `POST /api/internal/xmtp/deliveries`.
- Production D1 migration 0002, Worker routes, and bearer-protected internal
  ingest deployed at `https://vapid.party`.

## Live Verification

The production relay has passed two complementary end-to-end tests:

- A synthetic delivery test used real Chrome, one physical FCM subscription,
  and two logical Converge inboxes. Welcome and group events traveled through
  D1, Cloudflare Queue, FCM, and Converge's service worker. The test also proved
  idempotency, `should_push=false`, shared-endpoint logical deletion,
  post-delete suppression, local-only notification profile copy, privacy, and
  cleanup.
- A genuine XMTP test ran the official v3 `example-notification-server-go`
  locally with temporary PostgreSQL while using the production relay. It passed
  installation-welcome delivery, inbound conversation delivery with three HMAC
  epochs, and own-message suppression through the real browser service worker.

The former source-visible Converge generic API key is rejected in production.
These tests prove the deployed relay path; they do not provide continuous XMTP
monitoring.

## Privacy Model

`vapid.party` only wakes Converge clients. It must not receive or forward plaintext XMTP message content.

Allowed registration metadata:
- XMTP installation id and topic.
- Multiple 30-day HMAC epochs for a conversation topic.
- A welcome topic with no HMAC key.
- An opaque inbox handle used only for local browser routing.

The official XMTP notification server sends a `SendRequest` containing an
idempotency key, installation, subscription topic, message context, and opaque
encrypted envelope bytes. The Worker validates the official shape, matches only
installation id plus topic, and discards the encrypted bytes before persistence
or queueing. HMAC filtering and sender suppression happen in the official
listener; no HMAC secret is submitted as delivery authentication.

Rejected plaintext-like fields include:
- message body or message text.
- sender names or display names.
- plaintext previews.
- decrypted content.
- attachment URLs.

Push payloads sent for XMTP notifications are constrained to:

```json
{
  "type": "xmtp.new_message",
  "inboxHandle": "opaque_base64url_handle"
}
```

`inboxHandle` is an opaque browser routing token. The Converge service worker,
not the relay, owns visible copy and click navigation. No conversation id,
sender metadata, or message content crosses Web Push.

## XMTP Listener

The Worker API, D1 schema, and queue path do not replace an XMTP network
listener. The selected production design uses XMTP's maintained reference
notification server for that long-running role instead of attempting to keep a
stream alive inside a request-driven Worker.

Production listener path:
- Deploy XMTP's `example-notification-server-go` listener in a long-running
  service with its required Postgres database and XMTP network access.
- Configure its HTTP delivery address as
  `POST /api/internal/xmtp/deliveries` and its auth header as
  `Authorization: Bearer <INTERNAL_INGEST_TOKEN>`.
- The Worker also accepts `X-Internal-Token` and the old
  `/api/internal/xmtp/envelopes` path during migration, but the request body is
  always the official HTTP `SendRequest` shape.
- Never log or persist `message.message`; it contains the encrypted envelope and
  is not needed for Web Push wake-up delivery.

No always-on listener or durable listener PostgreSQL is deployed today. Until
both are deployed and observed, production registration succeeds but XMTP
messages are not monitored continuously for automatic push delivery.

## Operational Limits

- Cloudflare D1, queues, dead-letter queue, custom domain, migration 0002, and
  Worker deployment are provisioned in the production account.
- `CONVERGE_APP_ID` defaults to `converge`; either create that D1 app row or
  provide `CONVERGE_VAPID_PUBLIC_KEY`, `CONVERGE_VAPID_PRIVATE_KEY`, and
  `CONVERGE_API_KEY` secrets so the Worker can bootstrap it.
- Generic routes for the reserved Converge app fail closed when
  `CONVERGE_API_KEY` is absent, even if an old app row exists.
- `INTERNAL_INGEST_TOKEN` is required before using internal XMTP delivery.
- Real Converge browser/service-worker delivery is verified, but continuous
  service still requires the always-on listener and PostgreSQL described above.

## Runbook

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create Cloudflare resources:
   ```bash
   npx wrangler d1 create vapid-party
   npx wrangler queues create vapid-party-push-send
   npx wrangler queues create vapid-party-push-dlq
   ```
3. If Wrangler returns a D1 database id, add it to `wrangler.jsonc` under `d1_databases[0].database_id`.
4. Configure secrets:
   ```bash
   npx wrangler secret put CONVERGE_VAPID_PUBLIC_KEY
   npx wrangler secret put CONVERGE_VAPID_PRIVATE_KEY
   npx wrangler secret put CONVERGE_API_KEY
   npx wrangler secret put INTERNAL_INGEST_TOKEN
   ```
5. Apply D1 migrations:
   ```bash
   npm run db:migrate:remote
   ```
6. Verify locally:
   ```bash
   npm run lint
   npm test
   npm run build
   ```
7. Deploy:
   ```bash
   npx wrangler deploy
   ```
8. Verify production public key:
   ```bash
   curl https://vapid.party/api/xmtp/vapid-public-key
   ```
9. Re-run both the real-Chrome relay test and the genuine XMTP v3 listener test
   after changes to registration, delivery matching, queueing, or service-worker
   payload behavior.
10. Deploy the official listener with durable PostgreSQL and observe reconnect
    and catch-up behavior before marking automatic push stable.
