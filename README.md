# vapid.party

Cloudflare-only Web Push relay with app-scoped XMTP alert routing.

The supported runtime is a Cloudflare Worker, D1, Cloudflare Queues, and one
singleton Cloudflare Container. There is no Next.js or Vercel runtime in this
repository, and deploying vapid.party does not require provisioning anything in
Vercel.

## Status

The Cloudflare-only Worker, D1 schema, Queue, and singleton XMTP listener
Container are deployed in production. On 2026-07-14 the public health signal
reported `deliveryReady: true`, listener `ready`, bridge `synced`, and zero
pending or failed registrations. A post-deployment production canary then
verified a real XMTP welcome, group delivery, own-message suppression,
`shouldPush: false`, and complete cleanup through a real Chrome subscription.
Web Push remains experimental while restart/disconnect behavior and mobile/PWA
reliability are characterized.

Verified production behavior includes:

- A real Chrome subscription received D1 -> Queue -> push-provider -> Converge
  service-worker delivery for welcome and group topics.
- Logical deletion, shared physical endpoints, multiple HMAC epochs,
  `shouldPush=false`, own-message suppression, and minimal payload privacy were
  exercised with real XMTP traffic.

Registration success does not prove continuous XMTP monitoring. Use
`GET /api/health` and inspect `data.xmtp.deliveryReady` for the current coarse
end-to-end readiness signal.

## Architecture

- `src/worker/`: API, D1 access, listener control plane, Queue producer and
  consumer, and Web Push delivery.
- `migrations/d1/`: canonical D1 schema and ordered production migrations.
- `infra/xmtp-listener/`: custom Go XMTP v3 `SubscribeAll` listener packaged as
  a Cloudflare Container.
- `tests/worker/`: API, persistence, migration, isolation, and delivery tests.
- `public/openapi.yaml` and `public/llms.txt`: public API contracts.

D1 is the durable source of truth for apps, VAPID keys, physical Web Push
subscriptions, logical XMTP registrations, topics, HMAC epochs, app-scoped
listener routes, control-plane deltas, and delivery attempts. The container
keeps only a validated in-memory routing index.

An XMTP listener route is keyed by `(appId, installationId)`. Each app route has
its own opaque delivery token and HMAC set, so two apps can register the same
installation and topic without sharing sender-suppression state or delivery.

The container:

1. Loads a cursor-watermarked D1 snapshot through authenticated Worker control
   endpoints.
2. Applies D1 registration deltas and atomically swaps its in-memory index.
3. Consumes XMTP production `SubscribeAll` traffic.
4. Evaluates `shouldPush`, topic HMACs, and sender suppression separately for
   each app route.
5. Sends the Worker a minimal authenticated delivery hint; the Worker resolves
   the app-scoped token and enqueues Web Push.

The listener never stores PostgreSQL state and never sends XMTP ciphertext,
sender identity, or message content to the Worker.

## Readiness

`GET /api/health` is public and returns Worker health plus a coarse XMTP path
status:

```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "runtime": "cloudflare-worker",
    "xmtp": {
      "deliveryReady": true,
      "listener": {
        "configured": true,
        "status": "ready"
      },
      "bridge": {
        "status": "synced",
        "pendingRegistrationCount": 0,
        "failedRegistrationCount": 0
      }
    }
  }
}
```

`deliveryReady` is true only when the listener heartbeat is fresh, its XMTP
stream and internal delivery probe are ready, and its applied registration
cursor is synchronized with D1. The Worker's top-level `status: healthy` alone
does not mean XMTP delivery is ready.

The container exposes private process probes:

- `/livez`: the process and health server are alive.
- `/readyz`: the D1 control index is fresh, XMTP is connected and recently
  active, and authenticated delivery ingest is reachable.

XMTP `SubscribeAll` is a live stream without a durable listener replay cursor.
A restart or upstream disconnect can therefore create a push-only gap. XMTP
clients still retrieve messages through normal conversation sync; push is only
a wake-up hint, never the message transport or source of truth.

## Local Workflow

Node.js 22 or newer is required.

```bash
npm install
npm run db:migrate
npm run dev
```

Release checks:

```bash
npm run lint
npm test
npm run build
npm audit --audit-level=low
```

Listener checks:

```bash
cd infra/xmtp-listener
GOCACHE=/tmp/vapid-go-cache go test ./...
docker build -t vapid-party-xmtp-listener .
```

## Cloudflare Deployment

Wrangler configuration lives in `wrangler.jsonc`.

Bindings:

- `DB`: D1 database `vapid-party`.
- `PUSH_QUEUE`: Cloudflare Queue `vapid-party-push-send`.
- `RELAY_COORDINATOR`: existing Durable Object coordination class.
- `XMTP_LISTENER`: singleton `XmtpListenerContainer` binding.
- `ASSETS`: static files from `public/`.

Secrets:

```bash
npx wrangler secret put CONVERGE_VAPID_PUBLIC_KEY
npx wrangler secret put CONVERGE_VAPID_PRIVATE_KEY
npx wrangler secret put INTERNAL_INGEST_TOKEN
npx wrangler secret put XMTP_LISTENER_SYNC_TOKEN
```

`CONVERGE_API_KEY` is optional and only enables the reserved app's generic
API-key routes. Converge's public compatibility registration does not use it.

Apply migrations before deploying the Worker/container contract:

```bash
npm run db:migrate:remote
npx wrangler deploy
```

Then follow [the production canary](./infra/xmtp-listener/CANARY.md). Do not mark
continuous XMTP delivery ready based only on a successful container start.

## App Provisioning

Public wallet-based app management has been removed. There are no supported
`/api/register-app` or `/api/apps/*` routes. Until a verified administrator
authentication flow is implemented, app records, per-app VAPID keys, limits,
and API keys are provisioned by the operator in Cloudflare secrets and D1.

Do not expose an app API key, listener sync token, or ingest token to a browser.
Converge is the deliberate exception for registration: it uses a restricted
public compatibility route that can only enroll the reserved Converge app.

## Converge XMTP Registration

Converge is a static PWA and uses these public routes without a client secret:

- `GET /api/xmtp/vapid-public-key`
- `POST /api/xmtp/subscriptions`
- `DELETE /api/xmtp/subscriptions`

The version-1 registration contains:

- `app.id: "converge.cv"` and optional origin metadata.
- XMTP inbox and installation ids.
- One standard browser `PushSubscription`.
- Canonical group topics with one or more HMAC epochs and a canonical welcome
  topic with no HMAC key.
- An opaque `inboxHandle` used only by the service worker for local routing.
- `minimalPayloadOnly: true` and `plaintextPreview: false`.

The public route cannot enroll another app. A future Farcaster Mini App or other
delivery adapter must use a separately provisioned app and authenticated
app-scoped registration.

## Authenticated App APIs

Pre-provisioned apps authenticate with `X-API-Key`:

- `GET /api/vapid/public-key`
- `POST /api/subscribe`
- `POST /api/send`
- `POST /api/xmtp/registrations`
- `DELETE /api/xmtp/registrations`

The XMTP registration body matches Converge's nested version-1 body except that
it omits the fixed `app` field; the API key selects the app. Registration data,
listener routes, delivery tokens, VAPID keys, and queued delivery all remain
isolated by that app.

`POST /api/send` returns `202` after queueing. It does not claim that push has
already reached the provider or browser.

## Listener Delivery Contract

The singleton listener posts a minimal event to the internal ingest route:

```text
POST /api/internal/xmtp/deliveries
Authorization: Bearer <INTERNAL_INGEST_TOKEN>
```

```json
{
  "version": 1,
  "idempotencyKey": "opaque-stable-id",
  "installationId": "xmtp-installation-id",
  "deliveryToken": "opaque-app-route-token",
  "topic": "/xmtp/mls/1/g-.../proto",
  "messageType": "v3-conversation",
  "shouldPush": true,
  "isSilent": false
}
```

The delivery token is scoped to one app and installation. The Worker also
accepts the previous official HTTP `SendRequest` shape and legacy internal path
as a transitional compatibility contract, but the Cloudflare Container uses
the minimal event above.

## Privacy

XMTP Web Push contains only generic wake-up metadata:

```json
{
  "type": "xmtp.new_message",
  "inboxHandle": "opaque_base64url_handle"
}
```

The relay must never place message text, sender names, decrypted content,
attachment URLs, conversation ids, or XMTP ciphertext in D1, Queue payloads, or
Web Push. The receiving app owns visible notification copy, navigation, sync,
and decryption.

See [FEATURES.md](./FEATURES.md) for the shipped contract and
[docs/cloudflare-architecture.md](./docs/cloudflare-architecture.md) for the
technical runbook.
