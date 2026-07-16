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
On 2026-07-15 a lifecycle canary then held one XMTP stream connection for 11
minutes 31 seconds across the former ten-minute Container idle cutoff.
Web Push remains experimental while restart/disconnect behavior and mobile/PWA
reliability are characterized.

On 2026-07-15 migration `0006` and the frictionless public-app Worker contract
were deployed. A disposable production canary passed anonymous creation,
one-time secret handling, VAPID discovery, ticketed browser enrollment,
private stats, DNS mismatch and leaderboard exclusion, management-token
unsubscribe, secret rotation, and complete app deletion. Post-cutover health
then remained `deliveryReady`, listener `ready`, and bridge `synced` across
multiple control polls without restarting the Container. The general-public
launch is for generic Web Push only. General-public XMTP enrollment remains
unavailable until the relay can verify installation ownership
cryptographically; the existing Converge compatibility and
operator-provisioned XMTP flows remain separate.

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
listener routes, control-plane deltas, and short-retained operational delivery
state. Migration `0006` adds hashed app and enrollment capabilities, public app
profiles, DNS verification state, and daily UTC usage counters. The container
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

The Container lifecycle treats the long-running `SubscribeAll` stream as
intentional background work: activity expiry renews the singleton instead of
stopping it. A minute cron starts a missing process and rechecks its liveness
port. That cron is a recovery backstop, not a readiness signal; use
`GET /api/health` and `/readyz` for stream and control-plane readiness.

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
npx wrangler deploy --containers-rollout=none
npx wrangler queues update vapid-party-push-send --message-retention-period-secs 3600
npx wrangler queues update vapid-party-push-dlq --message-retention-period-secs 3600
```

The one-hour settings bound transient generic notification copy to one hour in
the source queue and, after a failed source delivery is moved, one hour in the
dead-letter queue; those windows can occur sequentially. The deploy
is not launch-ready unless both updates succeed and the live queue settings
report 3,600 seconds; a Cloudflare plan that cannot select one-hour retention
must be upgraded before making that promise.

Then follow [the production canary](./infra/xmtp-listener/CANARY.md). Do not mark
continuous XMTP delivery ready based only on a successful container start.

## Public App Provisioning

Status: deployed in production with migration `0006`.

Anyone can create an isolated app without an account, wallet, or operator step:

```http
POST /api/apps
Content-Type: application/json

{
  "name": "Example Alerts",
  "description": "Useful notifications from example.com",
  "domain": "example.com"
}
```

The no-store `201` response contains the app id, its public VAPID key, and one
`appSecret`. Save that secret immediately: only its SHA-256 digest is stored,
and the raw value cannot be recovered. Send it as `X-API-Key` for private send,
stats, profile, DNS, rotation, and deletion routes. Never put the app secret,
listener sync token, or ingest token in public browser code.

Public apps support generic Web Push. Public browser code never receives the
app secret. It discovers an app's VAPID key and manages its own generic
subscription through:

- `GET /api/apps/{appId}/vapid-public-key`
- `POST /api/apps/{appId}/subscriptions`
- `DELETE /api/apps/{appId}/subscriptions`

Before enrollment, the app's trusted backend validates its own user and sends
the exact standard `PushSubscription` to
`POST /api/apps/{appId}/enrollment-ticket` with `X-API-Key`. That returns a
five-minute stateless bearer ticket bound to the app, endpoint, keys, and
expiration. The browser presents that ticket to the public subscription POST.
No ticket or raw client address is stored. The public body cannot set trusted
`userId`, `channelId`, or metadata labels; the app maps the returned
subscription id in its own backend.

Generic enrollment accepts only canonical FCM, Mozilla, Apple, or WNS browser
Web Push endpoints. Each success returns a new per-subscription management
token; only its digest is retained. Keep that token in the browser and use it
as `Authorization: Bearer <token>` to delete that endpoint. Endpoint keys are
immutable while active. The public tier enforces at most 150 active physical
subscriptions per app, with app-wide serialization plus D1 constraint
backstops for concurrent enrollment. A non-null `expirationTime` must be in the
future. High service safety ceilings keep persistent anonymous state finite at
25,000 public apps and 250,000 public subscription rows; capacity exhaustion
fails closed instead of accepting partial state.

General-public XMTP enrollment is not shipped. Requests under
`/api/apps/{appId}/xmtp/*`, and public-app credentials presented to
`/api/xmtp/registrations`, receive HTTP `403`. Those routes stay unavailable
until a future contract can prove that the caller owns the claimed XMTP
installation. Creating a public app does not grant access to the existing
Converge or operator-provisioned XMTP compatibility flows.

Anonymous creation and public enrollment have high abuse-backstop rate limits,
with client scopes stored only as secret-salted digests rather than raw IP
addresses. The service accepts at most 5,000 anonymous app-creation attempts,
5,000 public subscription-verification attempts, and 5,000 authenticated public
state mutations per minute. Successful app creation remains capped at 600 per
minute, and DNS verification has a 600-check service backstop per minute.
These limits are not a signup gate or a claim of unlimited service.

## App Management, DNS, And Stats

The following routes require `X-API-Key: <appSecret>`, and the credential must
belong to the `{appId}` in the path:

- `GET /api/apps/{appId}/stats`
- `PATCH /api/apps/{appId}/profile`
- `GET /api/apps/{appId}/domain`
- `POST /api/apps/{appId}/domain/verify`
- `POST /api/apps/{appId}/secret/rotate`
- `DELETE /api/apps/{appId}`

Secret rotation is an atomic compare-and-swap, immediately revokes the previous
secret, returns a new raw secret once, and is limited to ten rotations per UTC
day. App deletion cascades through credentials, profiles, enrollment, and usage
state.

Stats report active generic subscriptions, shared-schema XMTP topology fields,
and daily UTC event counters for today and the last seven UTC dates. Public
apps cannot create XMTP routes, so those topology fields remain empty under the
general-public contract. `queued` means a job was enqueued;
`providerAccepted` means the Web Push provider accepted a send; `failed` counts
failed send attempts, including retries; and `expired` is a terminal invalid
endpoint. Provider acceptance does not prove a browser or OS displayed, read,
or even received a notification. Counters retain eight UTC dates, exclude
diagnostic tests, and contain no payload, endpoint, user, topic, or inbox data.

The public leaderboard is opt-in:

1. Set a domain with `PATCH /api/apps/{appId}/profile`.
2. Publish the exact TXT record returned by `GET /api/apps/{appId}/domain`:
   `_vapid-party.<domain>` with value
   `v=vapid-party1;app=<appId>;vapid=<current-public-vapid-key>`.
3. Call `POST /api/apps/{appId}/domain/verify`.
4. In a later profile patch, set `leaderboardOptIn: true`.

`GET /api/leaderboard` needs no credential. It lists at most 50 opted-in apps,
ranked by non-diagnostic provider acceptances across today and the six preceding
UTC dates. A listing requires a successful DNS check within the last seven days
and an exact binding to the app id and VAPID key at that check. The timestamp is
the domain's **last verified** time, not continuous proof of current ownership.
Changing the domain clears verification; a stale or mismatched recheck removes
the app from the listing.

## Converge XMTP Registration

Converge is a static PWA and uses these public routes without a client secret:

- `GET /api/xmtp/vapid-public-key`
- `POST /api/xmtp/subscriptions`
- `DELETE /api/xmtp/subscriptions`
- `POST /api/xmtp/status`
- `POST /api/xmtp/status/test`

The version-1 registration contains:

- `app.id: "converge.cv"` and optional origin metadata.
- XMTP inbox and installation ids.
- One standard browser `PushSubscription`.
- Canonical group topics with one or more HMAC epochs and a canonical welcome
  topic with no HMAC key.
- An opaque `inboxHandle` used only by the service worker for local routing.
- `minimalPayloadOnly: true` and `plaintextPreview: false`.

Only the strict nested version-1 request is accepted. Legacy flattened
registration and deletion bodies are rejected. The endpoint must be an HTTPS
browser Web Push endpoint from FCM, Mozilla autopush, Apple Web Push, or WNS;
arbitrary hosts and loopback/private endpoints are rejected. Each request may
contain at most 400 topics, at most 800 total topic plus HMAC rows, and base64
key fields of at most 1024 characters. Every HMAC key must decode to 1 through
256 bytes. HMAC epochs are canonical uint32 values. Listener state is capped at
5,000 combined topic/HMAC rows per app and 25,000 rows globally.
The 800-row ceiling assumes Cloudflare D1's paid 1,000-query-per-invocation
allowance; a free-plan deployment must lower this contract.

One inbox identity exists per `(appId, installationId)`. Multiple logical
routes for different installations may share one physical browser endpoint,
but that endpoint's `p256dh`/`auth` tuple is immutable while active. Topic
snapshot replacement is one transactional D1 batch. The whole registration
mutation is deliberately multi-statement; versioned dirty markers and listener reconciliation repair an
interruption rather than claiming whole-mutation atomicity.

Inbox and installation ids live only on the logical XMTP identity. Shared
physical subscription rows do not copy them into `user_id`, `channel_id`, or
metadata. An optional legacy `identity.address` field is accepted by the public
wire schema but discarded because routing does not need it.

### Registration management receipt

New clients send `X-Vapid-Party-Diagnostics: 1` on registration. A successful
no-store response includes a random 256-bit `diagnostics.receipt`; only its
SHA-256 hash is stored. Keep the receipt private and send it only as
`Authorization: Bearer <receipt>`:

- An exact endpoint-and-keys refresh may bootstrap or recover a receipt. This
  preserves compatibility with already deployed Converge clients.
- Replacing an endpoint requires the current receipt. A successful replacement
  preserves that receipt so retrying after a lost response is safe.
- Once a receipt exists, deletion requires it. Legacy registrations with no
  receipt may still delete their exact endpoint.
- A terminal provider `404`/`410` removes the endpoint keys, logical routes,
  topics, HMAC material, and diagnostic capability.

The Converge compatibility route does not cryptographically prove ownership of
the claimed XMTP inbox or installation on first registration. An attacker who
can guess those identifiers can first-claim a route and cause a denial of
service until the operator removes it. This bounded compatibility path is for
Converge only. General-public XMTP enrollment remains unavailable until an
installation-ownership proof contract exists.

### Private route diagnostics

`POST /api/xmtp/status` accepts an empty body plus the bearer receipt and returns
only coarse registration coverage, route synchronization, listener/bridge
readiness, and the latest XMTP/diagnostic delivery stage. It never returns the
receipt, inbox or installation ids, endpoint, topics, HMAC keys, or message
content. `POST /api/xmtp/status/test` queues a short-lived minimal payload
`{"type":"vapid.diagnostic","testId":"..."}`. A `sent` diagnostic means the
Web Push provider accepted it; it does not prove the browser or operating system
displayed a notification. Both routes and registration responses are
`Cache-Control: no-store` and rate limited.

The Converge route cannot enroll another app. Operator-provisioned adapters use
the separate authenticated compatibility contract; public apps cannot enroll
XMTP installations.

## Authenticated Send APIs

Publicly created apps and legacy pre-provisioned apps authenticate generic Web
Push operations with `X-API-Key`:

- `GET /api/vapid/public-key`
- `POST /api/subscribe`
- `POST /api/send`

Only pre-provisioned operator apps may also use:

- `POST /api/xmtp/registrations`
- `DELETE /api/xmtp/registrations`
- `POST /api/apps/{appId}/xmtp/status`
- `POST /api/apps/{appId}/xmtp/status/test`

Public-app credentials receive HTTP `403` on these XMTP routes until
installation ownership proof is available. For operator-provisioned apps, the
registration body matches Converge's nested version-1 body except that it omits
the fixed `app` field; the API key selects the app. Registration data, listener
routes, delivery tokens, VAPID keys, and queued delivery remain app-isolated.
An operator registration response returns a one-time diagnostic receipt plus
the app-scoped status and test paths. Calls to either path require both the
owning app's `X-API-Key` and `Authorization: Bearer <receipt>`; the receipt is
also checked against the app id in the path.

`POST /api/send` returns `202` after queueing. It does not claim that push has
already reached the provider or browser. Both the per-minute and daily limits
are enforced by selected recipient count, not merely by request count. Every
send is capped at 100 selected recipients, including filter-based sends. The
serialized notification payload is limited to 3,000 UTF-8 bytes. All recipient
jobs must also fit one estimated 240,000-byte JSON Queue batch; a single `sendBatch`
either publishes the request or its new attempt rows/counters are rolled back.
Public apps additionally share high service backstops of 2,000 selected
recipient deliveries per minute and 100,000 per UTC day.

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

D1 delivery-attempt rows store no generic or XMTP notification payload. The
opaque XMTP `inboxHandle` remains registration routing state, but is not copied
into an attempt payload. A generic notification body exists transiently in its
Queue/Web Push job because it is the content being sent; XMTP Queue/Web Push
jobs contain only the minimal wake-up type and opaque local handle. Operational
rows keep coarse status/timestamps (and a diagnostic `testId` only for the
diagnostic route) under short retention. Production Queue and dead-letter
retention are pinned to one hour.

See [FEATURES.md](./FEATURES.md) for the shipped contract and
[docs/cloudflare-architecture.md](./docs/cloudflare-architecture.md) for the
technical runbook.
