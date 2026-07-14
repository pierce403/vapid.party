# Cloudflare Architecture

vapid.party is deployed entirely on Cloudflare. The supported runtime is one
Worker, D1, a push Queue with a dead-letter Queue, and a singleton Container.
There is no Vercel/Next service and no PostgreSQL listener database.

## Request And Delivery Path

1. Converge creates one browser `PushSubscription` and publishes one logical
   registration for each loaded XMTP inbox/installation.
2. The Worker validates the app-scoped request and writes the subscription,
   identity, group/welcome topics, and HMAC epochs to D1.
3. A durable listener change advances the D1 control cursor. Registration
   mutations use a dirty marker so cron can repair an interrupted write.
4. The singleton `XmtpListenerContainer` loads a cursor-watermarked snapshot,
   then polls authenticated deltas into an atomic in-memory routing index.
5. Its Go process consumes XMTP production `SubscribeAll` envelopes. For each
   app route it validates `shouldPush`, HMAC epochs, and sender suppression.
6. A match produces a minimal authenticated event containing only the target
   installation, opaque app delivery token, topic, message type, and flags.
7. The Worker resolves that app route in D1 and enqueues one generic Web Push
   wake-up. The Queue consumer signs with the app's VAPID key and delivers it.
8. Converge's service worker records approximate inbox activity and displays
   copy derived only from local profile state. The app later syncs XMTP.

## Topic Contract

- Group/DM message topic: `/xmtp/mls/1/g-<32 lowercase hex>/proto`. XMTP v3
  group ids are 16 bytes.
- Installation welcome topic: `/xmtp/mls/1/w-<64 lowercase hex>/proto`. XMTP
  installation ids are 32 bytes.
- Group topics require at least one HMAC epoch. Welcome topics have none.
- DM stitching can produce more than one backing group topic; callers must
  register every topic/key set returned by the SDK.

Do not derive either identifier length from the other. The current XMTP docs
describe using each conversation's push topic plus the installation welcome
topic, and looking up HMAC keys by those topics.

## App Isolation

The listener's routing key is `(appId, installationId)`. Each route owns an
opaque delivery token and independent topic/HMAC set. Sharing an installation,
topic, or physical Web Push endpoint across apps must not merge routes.

Converge uses five restricted public compatibility routes:

- `GET /api/xmtp/vapid-public-key`
- `POST /api/xmtp/subscriptions`
- `DELETE /api/xmtp/subscriptions`
- `POST /api/xmtp/status`
- `POST /api/xmtp/status/test`

The public request must declare `app.id: "converge.cv"`; it cannot create or
select any other app. Pre-provisioned apps use `X-API-Key` with the generic
routes, including `/api/xmtp/registrations`. App provisioning and key rotation
are operator-only. The former unsigned wallet-admin endpoints are removed.

Public registration accepts only the canonical nested version-1 contract and
known HTTPS browser push-provider endpoint shapes. It enforces one active route
per app/inbox/installation, an immutable endpoint/key tuple, 400 topics, 800
combined topic/HMAC rows, 1024-character key fields, and uint32 epochs. The
maximum row contract assumes the paid D1 invocation query allowance.
Shared physical endpoint rows contain only push delivery material and a source
marker; inbox ids, installation ids, and optional legacy addresses remain out
of their user/channel/metadata fields.

A client can opt into a random 256-bit bearer management receipt. Only its hash
is stored. Exact endpoint/key refresh can bootstrap or recover it; endpoint
replacement and deletion require it after bootstrap. Replacement preserves the
valid receipt so a response-loss retry cannot strand the client. Status and a
minimal test push are available only with that bearer capability.

The first public claim is not signed by the XMTP installation and therefore is
not an ownership proof. Route squatting remains a denial-of-service boundary
requiring operator recovery. General apps must use the API-key contract.

Topic snapshot replacement uses a transactional D1 batch. Identity,
subscription, snapshot, listener outbox, and final logical-route updates are a
multi-statement mutation; versioned dirty markers reconcile interruptions.

## Privacy Boundary

Registration may contain:

- app, inbox, and installation identifiers;
- Web Push endpoint and subscription keys;
- XMTP group/welcome topics and HMAC epochs;
- an opaque browser-local inbox handle.

The Container-to-Worker event never contains the XMTP envelope, ciphertext,
sender identity, or decrypted content. The Web Push payload is limited to:

```json
{
  "type": "xmtp.new_message",
  "inboxHandle": "opaque_base64url_handle"
}
```

The relay must not receive, store, log, or forward message text, display names,
attachment URLs, previews, or decrypted conversation metadata.

## Readiness

`GET /api/health` is public. `data.status: "healthy"` only describes the Worker.
XMTP delivery is ready only when all of these are true:

- `data.xmtp.deliveryReady` is true;
- `listener.status` is `ready` with a fresh authenticated heartbeat;
- the XMTP stream and internal delivery probe are ready;
- `bridge.status` is `synced`;
- pending and failed registration counts are zero;
- the listener's cursor equals the latest D1 registration change.

The response deliberately excludes internal URLs, tokens, endpoints, and HMAC
material. The Container also exposes private `/livez` and `/readyz` probes.

Production reported the full ready state on 2026-07-14 after D1 migrations
0003/0004 and the Worker/Container rollout. The subsequent real-Chrome canary
verified XMTP welcome and group delivery, three HMAC epochs, own-message and
`shouldPush: false` suppression, and complete logical/browser cleanup.

## Deployment

Required Worker secrets:

- `CONVERGE_VAPID_PUBLIC_KEY`
- `CONVERGE_VAPID_PRIVATE_KEY`
- `INTERNAL_INGEST_TOKEN`
- `XMTP_LISTENER_SYNC_TOKEN`

`CONVERGE_API_KEY` is optional and only enables the reserved app's generic
API-key routes. It is not used by public Converge registration. Listener sync
and delivery tokens must be independent.

Release gates:

```bash
npm run lint
npm test
npm run build
npm audit --audit-level=low
cd infra/xmtp-listener
GOCACHE=/tmp/vapid-go-cache go test -race ./...
GOCACHE=/tmp/vapid-go-cache go vet ./...
```

Deploy with the configured Cloudflare account:

```bash
npm run db:migrate:remote
npx wrangler deploy
```

Follow `infra/xmtp-listener/CANARY.md` after changes to registration, matching,
delivery, Queue behavior, VAPID handling, or the service-worker payload.

## Known Reliability Limit

XMTP `SubscribeAll` is live-only and provides no durable listener replay cursor.
The Container reconnects, but a restart or upstream disconnect can still create
a push-only gap. XMTP conversation sync remains the source of truth, and push
must remain labeled experimental until restart/disconnect and installed-PWA or
mobile behavior have sufficient production evidence.
