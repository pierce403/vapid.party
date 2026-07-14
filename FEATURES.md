# FEATURES

## Cloudflare-Only Runtime

Stability: deployed

Description:
- `vapid.party` runs on a Cloudflare Worker, D1, Cloudflare Queues, and one
  singleton Cloudflare Container.
- The Container runs the custom Go XMTP v3 `SubscribeAll` listener. D1 is its
  durable control plane; the Container holds only a replaceable in-memory index.
- This repository has no supported Next.js, Vercel, or PostgreSQL runtime.

Properties:
- Worker source lives in `src/worker` and listener source in
  `infra/xmtp-listener`.
- Wrangler configuration lives in `wrangler.jsonc`.
- Production is served at `https://vapid.party` and the Worker development URL.
- D1 migrations 0001 through 0004 are applied in production; migration 0005
  adds management receipts and route diagnostics for the next Worker rollout.
- Node.js 22 or newer is required by the pinned Wrangler toolchain.

Test Criteria:
- [x] `npm run lint`
- [x] `npm test`
- [x] `npm run build`
- [x] Go race tests and `go vet`
- [x] Worker and Container production deployment
- [x] Public health reported the listener ready and bridge synced on 2026-07-14

## App-Scoped D1 Registry

Stability: deployed

Description:
- D1 stores apps, per-app VAPID keys, physical Web Push subscriptions, logical
  XMTP registrations, topics, HMAC epochs, listener changes, delivery attempts,
  and rate-limit records.
- Listener routes are keyed by `(appId, installationId)`, not only by an inbox,
  installation, endpoint, or topic.

Properties:
- Each app/installation route owns a stable opaque delivery token.
- Two apps can register the same installation and topic without sharing HMAC
  keys, sender-suppression state, VAPID keys, or delivery authorization.
- One physical browser endpoint may back several logical inbox registrations.
- Exactly one logical registration is active per app/inbox/installation.
- An active physical endpoint's `p256dh`/`auth` tuple is immutable across every
  logical route that shares it.
- Removing one logical registration removes that inbox's topics and HMAC keys.
  The endpoint and Web Push keys are removed after the last logical user leaves.
- Versioned dirty markers repair interrupted multi-statement registration
  mutations. Tombstones remain until active listeners have consumed them.
- Topic/HMAC snapshot replacement is a transactional D1 batch. The complete
  registration mutation spans several statements and is repaired by dirty-route
  reconciliation; it is not claimed to be one atomic transaction.
- Group topics are `/xmtp/mls/1/g-<32 hex>/proto` for a 16-byte group id.
  Welcome topics are `/xmtp/mls/1/w-<64 hex>/proto` for a 32-byte installation id.

Test Criteria:
- [x] Local and production migrations preserve foreign-key integrity
- [x] App-scoped uniqueness and backfill preflights pass
- [x] Cross-app isolation is covered through snapshot, delivery, and deletion
- [x] Dirty-route recovery and tombstone retention are covered
- [x] Invalid legacy HMAC data is isolated without breaking valid routes

## Public Converge Registration

Stability: deployed

Description:
- Converge is a static PWA and registers through a deliberately restricted
  public compatibility contract without shipping an app secret.

Routes:
- `GET /api/xmtp/vapid-public-key`
- `POST /api/xmtp/subscriptions`
- `DELETE /api/xmtp/subscriptions`
- `POST /api/xmtp/status`
- `POST /api/xmtp/status/test`

Properties:
- Version 1 requires `app.id: "converge.cv"`; it cannot enroll another app.
- Registration includes one standard `PushSubscription`, inbox and installation
  ids, canonical XMTP topics, all current HMAC epochs, and an opaque
  `inboxHandle`.
- `minimalPayloadOnly` must be true and `plaintextPreview` must be false.
- Only strict nested version-1 registration/deletion bodies are accepted.
- Provider endpoints are limited to canonical HTTPS FCM, Mozilla, Apple, and
  WNS Web Push shapes.
- Registrations allow at most 400 topics, 800 combined topic/HMAC rows, 1024
  characters per base64 key, and uint32 HMAC epochs.
- `X-Vapid-Party-Diagnostics: 1` opts into a no-store management receipt. Only
  its hash is stored; a valid bearer receipt is required for endpoint replacement
  and post-bootstrap deletion.
- Endpoint replacement preserves the valid receipt so retries after a lost
  response are idempotent. Exact endpoint/key refresh can bootstrap or recover
  a receipt for compatibility with deployed clients.
- Status is receipt-scoped and secret-free. Diagnostic tests use a minimal
  short-lived payload; provider acceptance does not prove browser display.
- The unsigned first claim is not XMTP ownership proof and can be squatted for
  denial of service. This is a Converge-only compatibility path, not a general
  multi-tenant enrollment mechanism.

Test Criteria:
- [x] Public routes do not require `X-API-Key`
- [x] Another app id and plaintext preview preferences are rejected
- [x] Multiple HMAC epochs and no-HMAC welcome topics are accepted
- [x] Shared endpoints survive one logical inbox deletion
- [x] Legacy/oversized payloads mutate no protected registration state
- [x] Receipt bootstrap, replacement retry, deletion, and terminal cleanup
- [x] Concurrent first claims cannot rewrite a shared endpoint key tuple

## Authenticated App APIs

Stability: deployed

Description:
- Pre-provisioned apps use `X-API-Key` for generic Web Push and app-scoped XMTP
  registration.
- App provisioning and key rotation are operator-only until a verifiable admin
  authentication design is implemented.

Routes:
- `GET /api/vapid/public-key`
- `POST /api/subscribe`
- `POST /api/send`
- `POST /api/xmtp/registrations`
- `DELETE /api/xmtp/registrations`

Security Properties:
- The former unsigned wallet bearer/admin routes are removed and return 404.
- The reserved Converge generic API routes fail closed without a configured
  `CONVERGE_API_KEY`; its public compatibility routes remain independent.
- API keys, listener sync tokens, ingest tokens, Web Push secrets, and delivery
  tokens must never be sent to untrusted browser code or logs.

Test Criteria:
- [x] Missing or invalid app credentials are rejected
- [x] A forged legacy wallet token cannot reach app administration
- [x] The API key selects the app and the request cannot override app scope

## XMTP Listener And Matching

Stability: experimental

Description:
- The singleton Container listens to XMTP production `SubscribeAll`, applies the
  D1 snapshot and deltas, evaluates `shouldPush`, and suppresses messages sent by
  the registered installation before posting a minimal delivery hint.

Properties:
- Snapshot, delta, status, and delivery-readiness endpoints require the listener
  sync token or ingest token as appropriate.
- HMAC matching is performed independently for each app route and epoch.
- Installation welcome topics need no HMAC key.
- The listener sends no envelope ciphertext, sender identity, or message content
  to the Worker.
- Delivery uses bounded HTTP retries. Queue delivery and provider retries happen
  after the Worker accepts the minimal event.
- The Worker temporarily accepts the previous official HTTP `SendRequest` shape
  for migration compatibility; the production Container uses the minimal event.

Test Criteria:
- [x] Real XMTP installation welcome reached Converge through the deployed Container
- [x] Real XMTP group delivery matched three HMAC epochs through the deployed Container
- [x] The production canary verified own-message and `shouldPush: false` suppression
- [ ] Restart/disconnect behavior is observed over time

## Queue-Backed Web Push

Stability: deployed

Description:
- Request handlers enqueue bounded push jobs. A Cloudflare Queue consumer owns
  provider delivery, retries, dead-letter handling, and expired-endpoint cleanup.

Properties:
- Producer queue: `vapid-party-push-send`.
- Dead-letter queue: `vapid-party-push-dlq`.
- XMTP payloads contain only `type: "xmtp.new_message"` and the opaque local
  `inboxHandle`.
- `POST /api/send` returns 202 after queueing, not after browser delivery.

Test Criteria:
- [x] Queue payloads exclude XMTP plaintext and ciphertext
- [x] Real Chrome received D1 -> Queue -> FCM -> Converge service-worker pushes
- [x] Duplicate delivery ids and `shouldPush: false` do not enqueue twice

## Health And Readiness

Stability: deployed

Description:
- `GET /api/health` exposes a secret-free, coarse readiness result for clients
  and operators.

Properties:
- Top-level Worker `status: healthy` does not imply XMTP delivery readiness.
- `data.xmtp.deliveryReady` is true only when the listener heartbeat, XMTP
  stream, internal delivery probe, and D1 cursor are fresh and synchronized.
- `listener.status` is `ready`, `not_ready`, `not_configured`, or `unknown`.
- `bridge.status` is `synced`, `pending`, `failed`, or `not_configured`, with
  pending and failed registration counts.
- The public response never exposes Container URLs, delivery tokens, HMAC keys,
  Web Push endpoints, or bearer secrets.

Test Criteria:
- [x] Stale listener, stale cursor, failed routes, and dirty routes report non-ready
- [x] Authenticated bodyless delivery probe is required for ready state
- [x] Production reported `deliveryReady: true` after deployment

## Privacy And Reliability Boundaries

Stability: experimental

Security Properties:
- vapid.party never stores or pushes plaintext XMTP message text, sender names,
  decrypted content, attachment URLs, conversation previews, or envelope bytes.
- The app owns notification copy, navigation, XMTP sync, and decryption.
- Push is an approximate wake-up hint, never message transport or history.
- XMTP `SubscribeAll` has no durable listener replay cursor. A Container restart
  or stream disconnect can therefore miss push hints; normal XMTP client sync
  remains authoritative.
- Installed-PWA and mobile-provider reliability still requires longer production
  observation before notification delivery is called stable.

Test Criteria:
- [x] Minimal payload privacy tests pass
- [x] Welcome delivery works through a real production browser subscription
- [ ] Long-running restart, disconnect, installed-PWA, and mobile tests complete
