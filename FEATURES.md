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
- D1 migrations 0001 through 0005 are applied in production. Migration 0005
  supplies the deployed management-receipt and route-diagnostic contract.
- Migration 0006 and the matching public-app Worker contract are implemented
  locally and pending production rollout. Nothing in the public-app sections
  below should be read as already live until both are deployed.
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
  and rate-limit records. Migration 0006 adds hashed app and enrollment
  capabilities, public profiles, DNS state, and short-retained daily UTC usage
  counters.
- Listener routes are keyed by `(appId, installationId)`, not only by an inbox,
  installation, endpoint, or topic.

Properties:
- Each app/installation route owns a stable opaque delivery token.
- Two apps can register the same installation and topic without sharing HMAC
  keys, sender-suppression state, VAPID keys, or delivery authorization.
- One physical browser endpoint may back several logical inbox registrations.
- Exactly one inbox identity exists per app/installation.
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

## Frictionless Public Apps

Stability: implemented locally; pending production migration and Worker rollout

Description:
- Anyone can create an isolated app with `POST /api/apps`; there is no account,
  wallet signature, approval, or operator provisioning step.
- General-public apps support generic Web Push only. XMTP enrollment is held
  back until an installation-ownership proof contract exists.
- The no-store creation response returns the raw `appSecret` exactly once,
  alongside the app id, name, public VAPID key, and creation timestamp.
- Only the SHA-256 digest of that credential is stored. Each public app has one
  active app credential; rotation immediately revokes its predecessor.

Public Routes:
- `POST /api/apps`
- `GET /api/apps/{appId}/vapid-public-key`
- `GET /api/leaderboard`

Authenticated Management Routes (`X-API-Key: <appSecret>`):
- `POST /api/apps/{appId}/enrollment-ticket`
- `GET /api/apps/{appId}/stats`
- `PATCH /api/apps/{appId}/profile`
- `GET /api/apps/{appId}/domain`
- `POST /api/apps/{appId}/domain/verify`
- `POST /api/apps/{appId}/secret/rotate`
- `DELETE /api/apps/{appId}`

Security Properties:
- Path-scoped management rejects a valid credential belonging to another app.
- Anonymous creation is protected by high scoped/global per-minute abuse
  backstops. Raw client IP addresses are not stored; scoped values are
  secret-salted digests.
- Persistent anonymous state has hard service ceilings of 25,000 public apps
  and 250,000 public subscription rows. Capacity failures roll back atomically.
- Service backstops admit at most 5,000 anonymous creation attempts, 5,000
  subscription-verification attempts, and 5,000 authenticated public state
  mutations per minute; successful app creation remains capped at 600/minute.
- App responses that contain credentials or private usage state are no-store.
- An app secret is for trusted servers and must never be embedded in public
  browser code. Public enrollment uses narrower per-registration capabilities.

Test Criteria:
- [x] Creation returns one usable secret and D1 stores only its digest
- [x] Legacy raw app keys cannot authenticate an app with an active hashed secret
- [x] Rotation atomically revokes the prior secret and is capped at ten per UTC day
- [x] Deletion cascades app-owned state
- [x] App-id path mismatch is rejected
- [ ] Migration 0006 and the matching Worker are deployed to production

## Public Generic Enrollment And Planned XMTP Ownership Proof

Stability: generic enrollment implemented locally and pending production
rollout; general-public XMTP unavailable and planned

Generic Routes:
- `POST /api/apps/{appId}/enrollment-ticket` (app secret)
- `POST /api/apps/{appId}/subscriptions`
- `DELETE /api/apps/{appId}/subscriptions`

Unavailable XMTP Paths (HTTP `403`):
- `POST /api/apps/{appId}/xmtp/subscriptions`
- `DELETE /api/apps/{appId}/xmtp/subscriptions`
- `POST /api/xmtp/registrations` with a public-app credential
- `DELETE /api/xmtp/registrations` with a public-app credential
- `POST /api/apps/{appId}/xmtp/status` with a public-app credential
- `POST /api/apps/{appId}/xmtp/status/test` with a public-app credential

Properties:
- Browser enrollment does not receive or require the app secret.
- A trusted app server mints a five-minute stateless ticket bound to the exact
  app id, endpoint, keys, and expiration. The ticket is derived from the app's
  existing VAPID secret and is never stored.
- Public generic enrollment requires that ticket and cannot supply trusted
  `userId`, `channelId`, or metadata routing labels.
- Generic subscription upsert returns a fresh 256-bit management token in a
  no-store response. Only its hash is persisted; bearer possession is required
  to delete the endpoint.
- General-public XMTP enrollment is not shipped. A public app secret proves app
  control, but it does not prove ownership of a claimed XMTP installation.
  Public-app XMTP paths therefore fail closed with HTTP `403` until a future
  enrollment contract supplies that proof.
- Provider endpoint keys are immutable while active, and a physical endpoint
  cannot silently cross from another enrollment contract.
- Public enrollment applies per-app and secret-salted scoped abuse backstops and
  enforces 150 active physical subscriptions per public app. App-wide mutation
  serialization and D1 constraints close concurrent quota races.
- A non-null browser `expirationTime` must be in the future; expired persisted
  capabilities stop routing immediately and bounded cleanup removes them.
- Converge's existing fixed-app compatibility routes and receipt bootstrap
  behavior are unchanged. Pre-provisioned operator XMTP routes also remain
  separate from general-public app enrollment.

Test Criteria:
- [x] Browser code can discover VAPID and enroll with an endpoint-bound ticket,
  without receiving the app secret
- [x] Generic refresh rotates its management capability and deletion requires it
- [x] Public-app XMTP paths and public credentials on operator XMTP routes return 403
- [x] Cross-contract, endpoint-key, and provider-host conflicts fail
- [ ] Public app enrollment routes are deployed to production
- [ ] Cryptographic installation ownership proof and general-public XMTP enrollment

## Verified App Profiles And Public Leaderboard

Stability: implemented locally; pending production migration and Worker rollout

Description:
- Apps are absent by default. Listing requires an explicit profile opt-in and a
  DNS TXT binding last verified against the app id and public VAPID key.
- `GET /api/leaderboard` returns at most 50 qualifying apps, ordered by Web Push
  provider acceptances across today and the preceding six UTC dates.

DNS Contract:
- Record name: `_vapid-party.<app-domain>`
- Record value:
  `v=vapid-party1;app=<appId>;vapid=<current-public-vapid-key>`
- The management API returns the exact record to publish and verifies it through
  bounded DNS-over-HTTPS lookup.
- Domain changes clear verification. A listing requires the last successful DNS
  check to be no more than seven days old and the verified VAPID snapshot to
  equal the current key. `domainVerifiedAt` is a last-verified timestamp, not
  continuous or current proof of DNS ownership. Conflicting claims make the
  other profile mismatch when checked.
- A profile update may enable `leaderboardOptIn` only after verification. An app
  created with the opt-in flag set remains hidden until its DNS binding verifies.

Honesty Boundary:
- `providerAcceptedLast7Days` is a count of Web Push provider acceptances. It is
  not a count of notifications delivered to, displayed by, or read in browsers.
- Empty or unverified apps are not padded with pretend data or sample usage.

Test Criteria:
- [x] Unverified, stale, mismatched, and non-opted-in apps are excluded
- [x] Last-verified VAPID binding and deterministic ranking are enforced
- [x] Public output contains only profile/DNS identity and aggregate acceptance
- [ ] The production leaderboard route is live

## Private Usage Stats

Stability: implemented locally; pending production migration and Worker rollout

Description:
- `GET /api/apps/{appId}/stats` returns the app's profile, active subscription
  and XMTP topology counts, and aggregate daily UTC event counters.
- XMTP fields remain in the shared response schema for operator compatibility;
  they are empty for general-public apps because public XMTP enrollment is unavailable.
- `todayUtc` is the current UTC date. `last7DaysUtc` is today plus the six prior
  UTC dates, not a rolling 168-hour window.

Counter Semantics:
- `queued`: selected recipient jobs accepted into the Queue.
- `providerAccepted`: send attempts accepted by a Web Push provider.
- `failed`: failed provider attempts, including retries.
- `expired`: terminal invalid-endpoint outcomes.
- Diagnostic tests are excluded. Counters are retained for eight UTC dates and
  contain no notification payload, endpoint, user, topic, inbox, or message.

Test Criteria:
- [x] Stats are app-isolated and require the matching app credential
- [x] Today/seven-date windows and eight-date retention are explicit
- [x] Provider acceptance is never labeled delivered
- [ ] Private production stats are live

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
  characters per base64 key, 1..256 decoded bytes per HMAC key, and uint32 HMAC
  epochs.
- Listener state is capped at 5,000 combined topic/HMAC rows per app and 25,000
  rows globally.
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

Stability: base send and operator registration deployed; public-app access pending rollout

Description:
- Legacy pre-provisioned apps and publicly created apps use `X-API-Key` for
  generic Web Push. Public apps receive their secret through the pending
  `POST /api/apps` rollout.

Routes:
- `GET /api/vapid/public-key`
- `POST /api/subscribe`
- `POST /api/send`

Pre-Provisioned Operator XMTP Routes:
- `POST /api/xmtp/registrations`
- `DELETE /api/xmtp/registrations`
- `POST /api/apps/{appId}/xmtp/status`
- `POST /api/apps/{appId}/xmtp/status/test`

Security Properties:
- The former unsigned wallet bearer/admin routes are removed and return 404.
- The reserved Converge generic API routes fail closed without a configured
  `CONVERGE_API_KEY`; its public compatibility routes remain independent.
- Public-app credentials receive HTTP `403` on operator XMTP routes. General
  XMTP onboarding remains planned until installation ownership can be proven.
- Operator registration returns an app-scoped diagnostic receipt. Status and
  test calls require both the owning `X-API-Key` and that bearer receipt, and
  the receipt is checked against the app id in the path.
- API keys, listener sync tokens, ingest tokens, Web Push secrets, and delivery
  tokens must never be sent to untrusted browser code or logs.
- Both per-minute and daily send limits are enforced by selected recipient
  count. Every send is capped at 100 selected recipients.
- Public apps share service backstops of 2,000 selected recipient deliveries per
  minute and 100,000 per UTC day.
- The serialized Web Push payload is capped at 3,000 UTF-8 bytes, and all jobs
  must fit one estimated 240,000-byte JSON Queue batch. One `sendBatch` avoids
  partial publication; a publish failure removes its queued attempt rows and
  reverses aggregate queued counters before returning 503.

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
- Each HMAC key decodes to 1..256 bytes. Listener registration state is capped
  at 5,000 combined topic/HMAC rows per app and 25,000 globally.
- The listener sends no envelope ciphertext, sender identity, or message content
  to the Worker.
- Delivery uses bounded HTTP retries. Queue delivery and provider retries happen
  after the Worker accepts the minimal event.
- The Worker temporarily accepts the previous official HTTP `SendRequest` shape
  for migration compatibility; the production Container uses the minimal event.
- Container activity expiry renews the long-running listener instead of taking
  the default stop path. A minute cron reasserts startup for the singleton after
  a real process or host exit.

Test Criteria:
- [x] Real XMTP installation welcome reached Converge through the deployed Container
- [x] Real XMTP group delivery matched three HMAC epochs through the deployed Container
- [x] The production canary verified own-message and `shouldPush: false` suppression
- [x] A lifecycle regression test prevents activity expiry from stopping the listener
- [x] Production held one stream connection for 11 minutes 31 seconds across
  the former ten-minute idle cutoff on 2026-07-15
- [ ] Restart/disconnect behavior is observed over time

## Queue-Backed Web Push

Stability: deployed

Description:
- Request handlers enqueue bounded push jobs. A Cloudflare Queue consumer owns
  provider delivery, retries, dead-letter handling, and expired-endpoint cleanup.

Properties:
- Producer queue: `vapid-party-push-send`.
- Dead-letter queue: `vapid-party-push-dlq`.
- Production retention for both queues is pinned to 3,600 seconds. Source and
  dead-letter windows can occur sequentially, so this is one hour in each
  queue rather than a one-hour end-to-end bound.
- Launch verification must confirm both live queues report 3,600 seconds; a
  Cloudflare plan that cannot configure this value must be upgraded first.
- XMTP payloads contain only `type: "xmtp.new_message"` and the opaque local
  `inboxHandle`.
- `POST /api/send` returns 202 after queueing, not after browser delivery.
- D1 delivery-attempt payloads store `{}` rather than generic or XMTP
  notification payloads. The opaque XMTP handle remains registration routing
  state but is not copied into an attempt. Generic notification content exists
  transiently only in the Queue/Web Push path; XMTP stays a minimal wake-up hint.
- Daily UTC counters retain eight dates. Non-diagnostic operational attempts
  retain seven days and diagnostic attempts retain 24 hours.

Test Criteria:
- [x] Queue payloads exclude XMTP plaintext and ciphertext
- [x] Real Chrome received D1 -> Queue -> FCM -> Converge service-worker pushes
- [x] Duplicate delivery ids and `shouldPush: false` do not enqueue twice
- [x] Generic sends publish one bounded batch and roll back cleanly on failure
- [x] Provider-accepted and expired counters are idempotent per delivery id

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
- D1 delivery-attempt rows store no generic or XMTP notification payload. The
  opaque handle remains in registration routing state but not attempt payloads.
  D1 retains coarse operational status and timestamps, and only diagnostic
  attempts may retain their short-lived `testId`.
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
