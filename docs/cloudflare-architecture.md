# Cloudflare Architecture

This document separates what is implemented in the repository from what still needs live Cloudflare provisioning and Converge end-to-end verification.

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
- Internal XMTP envelope ingestion route at `POST /api/internal/xmtp/envelopes`.

## Privacy Model

`vapid.party` only wakes Converge clients. It must not receive or forward plaintext XMTP message content.

Allowed XMTP relay inputs:
- XMTP topic.
- HMAC key metadata.
- Optional cursor.
- Optional conversation id only when treated as safe non-content metadata.

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
  "title": "Converge",
  "body": "New encrypted message",
  "url": "/"
}
```

`conversationId` may be added only when it is safe non-content metadata.

## Worker-Only Vs Container Monitor

The current repository proves the Worker API, D1 schema, queue payload path, and Durable Object coordination pieces. The long-running XMTP monitor is not yet proven Worker-only.

Preferred path:
- Run the XMTP SDK stream from a Worker if the SDK supports Workers reliably.
- Use `RelayCoordinator` leases for shard ownership.
- Save cursor progress after each processed envelope.
- Reconnect and catch up from durable cursor state after restarts.

Fallback path:
- Run the XMTP SDK stream in a Cloudflare Container daemon.
- Use `RelayCoordinator` for shard locks and cursor state.
- POST sanitized topic/HMAC envelope events to `POST /api/internal/xmtp/envelopes` with `X-Internal-Token`.
- Never post plaintext message content to the Worker.

## Operational Limits

- Cloudflare D1 database, queues, dead-letter queue, and custom domain must be created in the production account before deployment.
- `CONVERGE_APP_ID` defaults to `converge`; either create that D1 app row or provide `CONVERGE_VAPID_PUBLIC_KEY` and `CONVERGE_VAPID_PRIVATE_KEY` secrets so the Worker can bootstrap it.
- `INTERNAL_INGEST_TOKEN` is required before using the internal XMTP envelope ingestion route.
- A real Converge browser/service-worker subscription is required before claiming end-to-end delivery.

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
9. Run a real Converge end-to-end push delivery test before marking deployment stable in `FEATURES.md`.
