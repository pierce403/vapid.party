# vapid.party

Cloudflare-hosted Web Push relay with public XMTP-aware registration endpoints for Converge.

The production target is a single Cloudflare Worker with D1, Queues, Durable Objects, and optional static assets. Historical Next/Vercel source remains only as an unbuilt reference: its scripts and dependencies are deliberately absent from the installable package graph. The supported runtime is `src/worker` on Node.js 22+ tooling.

## Status

Progress is tracked in [FEATURES.md](./FEATURES.md) using the `features.md` structure: Stability, Description, Properties, and Test Criteria.

Implemented in this repo:
- Cloudflare Worker API routes.
- D1 migration for apps, push subscriptions, XMTP identity/topic registrations, delivery attempts, rate logs, and relay cursors.
- Queue-backed push jobs with retry/dead-letter configuration.
- Durable Object shard lease and cursor coordination.
- Public Converge XMTP registration contract, including welcome topics and
  multiple HMAC epochs per conversation topic.
- Official XMTP notification-server HTTP delivery ingestion into Cloudflare
  Queues, with idempotent delivery attempts.
- Production D1 migration 0002 and the current Worker are deployed at
  `vapid.party`; public XMTP registration/delete and bearer-protected official
  delivery ingest are live.

Verified live:
- A real-Chrome production test used one physical FCM subscription for two
  logical Converge inboxes and passed D1 -> Queue -> FCM -> service-worker
  delivery for welcome and group topics, including suppression, privacy,
  logical deletion, and cleanup checks.
- A full production data-path test used XMTP's official v3 notification server
  with temporary PostgreSQL and passed genuine installation-welcome and inbound
  conversation delivery, three HMAC epochs, and own-message suppression.
- The former source-visible Converge generic API key is rejected in production.

Still required for continuous delivery:
- Deploy the official XMTP notification-server listener with durable PostgreSQL.
  No always-on listener is currently deployed, so the live tests prove the
  production relay path but automatic XMTP push is not continuously available.

Live API endpoints:
- `https://vapid.party`
- `https://vapid-party.bcrt43.workers.dev`

## Local Workflow

```bash
npm install
npm run db:migrate
npm run dev
```

`npm audit --audit-level=low` is a required release gate and must report zero findings.

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
npx wrangler secret put CONVERGE_API_KEY
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

Idempotently registers a Web Push subscription for an XMTP inbox/installation
and topic/HMAC set. Converge's nested version-1 request is the primary contract:

```json
{
  "version": 1,
  "app": {
    "id": "converge.cv",
    "origin": "https://converge.cv"
  },
  "identity": {
    "inboxId": "xmtp-inbox-id",
    "installationId": "xmtp-installation-id",
    "address": "0x..."
  },
  "subscription": {
    "endpoint": "https://push.example/subscription",
    "expirationTime": null,
    "keys": {
      "p256dh": "base64url...",
      "auth": "base64url..."
    }
  },
  "xmtp": {
    "env": "production",
    "topics": [
      {
        "topic": "/xmtp/mls/1/g-abc/proto",
        "hmacKeys": [
          { "epoch": "7", "key": "base64url..." },
          { "epoch": "8", "key": "base64url..." }
        ]
      },
      {
        "topic": "/xmtp/mls/1/w-installation/proto",
        "hmacKeys": []
      }
    ],
    "topicSource": "conversations.hmacKeys"
  },
  "notification": {
    "inboxHandle": "opaque_base64url_handle"
  },
  "preferences": {
    "minimalPayloadOnly": true,
    "plaintextPreview": false
  },
  "registeredAt": "2026-07-12T00:00:00.000Z"
}
```

The welcome topic intentionally has no HMAC key. Conversation topics can carry
multiple 30-day epoch keys. A flattened legacy request remains accepted for
older clients, but new clients should use the nested contract above.

`notification.inboxHandle` must be an opaque base64url-style identifier. It is
returned to the service worker so the browser can mark the right local inbox;
it must not contain a display name or raw inbox id.

### DELETE /api/xmtp/subscriptions

Best-effort logical unsubscribe/disable:

```json
{
  "endpoint": "https://push.example/subscription",
  "inboxId": "xmtp-inbox-id",
  "installationId": "xmtp-installation-id"
}
```

Deleting one inbox/installation registration does not disable the shared
physical Web Push endpoint while another logical inbox uses it. The deleted
identity's topics and HMAC keys are removed immediately. When the last logical
registration leaves, the physical endpoint and its `p256dh`/`auth` keys are
deleted too.

## XMTP Notification Server Delivery

An official
[`example-notification-server-go`](https://github.com/xmtp/example-notification-server-go)
listener can deliver its HTTP `SendRequest` JSON to:

```text
POST /api/internal/xmtp/deliveries
Authorization: Bearer <INTERNAL_INGEST_TOKEN>
```

The legacy `X-Internal-Token` header and `/api/internal/xmtp/envelopes` path are
accepted for deployment compatibility, but they use the same new delivery
schema. The Worker matches `installation.id` plus `subscription.topic`, honors
`message_context.should_push`, and deduplicates by the official
`idempotency_key`. The official encrypted `message.message` bytes are validated
for shape and immediately discarded; they are never written to D1 or Web Push.

This bearer-protected ingest is live in production. It has passed a genuine
XMTP v3 end-to-end test with the official notification server and temporary
PostgreSQL. The listener itself is not deployed persistently yet, so production
does not continuously consume XMTP traffic.

## XMTP Push Payload

The relay sends only generic metadata:

```json
{
  "type": "xmtp.new_message",
  "inboxHandle": "opaque_base64url_handle"
}
```

`inboxHandle` is an opaque local routing handle. Converge's service worker owns
all visible title/body copy and click navigation; the relay supplies neither.
The relay must never store, forward, or preview plaintext XMTP message text,
sender names, decrypted content, attachment URLs, previews, conversation ids,
or the encrypted envelope bytes received from the notification server.

## Generic Web Push API

Generic app operations retain the prior auth model:
- Owner/admin app routes use `Authorization: Bearer <wallet-token>`.
- Generic push subscription/send routes use `X-API-Key`.

The reserved Converge app's generic routes fail closed unless
`CONVERGE_API_KEY` is configured as a Worker secret. This prevents a
source-visible bootstrap key from authorizing generic sends. Independently
managed apps continue to use their own generated API keys.

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
