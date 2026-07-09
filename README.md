# vapid.party

Cloudflare-hosted Web Push relay with public XMTP-aware registration endpoints for Converge.

The production target is a single Cloudflare Worker with D1, Queues, Durable Objects, and optional static assets. The legacy Next/Vercel code remains in the repository for reference/dashboard continuity, but the deployable runtime is now `src/worker`.

## Status

Progress is tracked in [FEATURES.md](./FEATURES.md) using the `features.md` structure: Stability, Description, Properties, and Test Criteria.

Implemented in this repo:
- Cloudflare Worker API routes.
- D1 migration for apps, push subscriptions, XMTP identity/topic registrations, delivery attempts, rate logs, and relay cursors.
- Queue-backed push jobs with retry/dead-letter configuration.
- Durable Object shard lease and cursor coordination.
- Public Converge XMTP registration contract.

Not complete until verified live:
- Cloudflare resources provisioned in the production account.
- `vapid.party` custom domain routed to the Worker.
- Worker-only XMTP stream or Container daemon proven in production.
- Real Converge end-to-end push delivery test.

## Local Workflow

```bash
npm install
npm run db:migrate
npm run dev
```

Useful checks:

```bash
npm run lint
npm test
npm run build
```

## Cloudflare Runtime

Wrangler config lives in `wrangler.jsonc`.

Bindings:
- `DB`: D1 database `vapid-party`.
- `PUSH_QUEUE`: Cloudflare Queue `vapid-party-push-send`.
- `RELAY_COORDINATOR`: Durable Object class `RelayCoordinator`.
- `ASSETS`: optional static asset binding for files in `public/`.

Provisioning outline:

```bash
npx wrangler d1 create vapid-party
npx wrangler queues create vapid-party-push-send
npx wrangler queues create vapid-party-push-dlq
npm run db:migrate:remote
npx wrangler deploy
```

If `wrangler d1 create` returns a database id, add it to `wrangler.jsonc`.

Secrets:

```bash
npx wrangler secret put CONVERGE_VAPID_PUBLIC_KEY
npx wrangler secret put CONVERGE_VAPID_PRIVATE_KEY
npx wrangler secret put INTERNAL_INGEST_TOKEN
```

See [docs/cloudflare-architecture.md](./docs/cloudflare-architecture.md) for the architecture, monitor decision, privacy model, and deployment runbook.

## Converge XMTP API

Converge remains a static PWA and defaults to `https://vapid.party/api`.

Public routes:
- `GET /api/xmtp/vapid-public-key`
- `POST /api/xmtp/subscriptions`
- `DELETE /api/xmtp/subscriptions`

These routes do not require a client secret or baked client API key.

### GET /api/xmtp/vapid-public-key

Returns the public VAPID key used by Converge:

```json
{
  "success": true,
  "data": {
    "publicKey": "BN..."
  }
}
```

### POST /api/xmtp/subscriptions

Idempotently registers a Web Push subscription for an XMTP inbox/installation and topic/HMAC set.

```json
{
  "endpoint": "https://push.example/subscription",
  "keys": {
    "p256dh": "base64url...",
    "auth": "base64url..."
  },
  "expirationTime": null,
  "inboxId": "xmtp-inbox-id",
  "installationId": "xmtp-installation-id",
  "address": "0x...",
  "hmacKeys": {
    "/xmtp/topic": "base64url-hmac-key"
  },
  "preferences": {
    "minimalPayloadOnly": true,
    "plaintextPreview": false
  }
}
```

The route also accepts a browser-style nested `subscription` object and `topics` as an array of `{ topic, hmacKey, algorithm?, conversationId? }`.

### DELETE /api/xmtp/subscriptions

Best-effort unsubscribe/disable:

```json
{
  "endpoint": "https://push.example/subscription",
  "inboxId": "xmtp-inbox-id",
  "installationId": "xmtp-installation-id"
}
```

## XMTP Push Payload

The relay sends only generic metadata:

```json
{
  "type": "xmtp.new_message",
  "title": "Converge",
  "body": "New encrypted message",
  "url": "/"
}
```

`conversationId` may be included only if it is safe non-content metadata. The relay must never receive, store, forward, or preview plaintext XMTP message text, sender names, decrypted content, attachment URLs, or previews.

## Generic Web Push API

Generic app operations retain the prior auth model:
- Owner/admin app routes use `Authorization: Bearer <wallet-token>`.
- Generic push subscription/send routes use `X-API-Key`.

Routes:
- `POST /api/register-app`
- `GET /api/apps`
- `GET /api/apps/:id`
- `PUT /api/apps/:id`
- `DELETE /api/apps/:id`
- `POST /api/apps/:id/regenerate-key`
- `GET /api/vapid/public-key`
- `POST /api/subscribe`
- `POST /api/send`

`POST /api/send` queues push jobs and returns `202` with queued delivery attempt ids. Actual Web Push delivery happens in the queue consumer.

Machine-readable docs:
- OpenAPI schema: `/openapi.yaml`
- LLM guide: `/llms.txt`
