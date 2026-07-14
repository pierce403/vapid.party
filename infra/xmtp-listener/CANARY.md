# Production Canary

Push is not complete merely because the container is running. Use this canary
after the first deployment and after listener, schema, queue, or service-worker
changes.

## Preconditions

- Production D1 migrations are applied.
- `XMTP_LISTENER_SYNC_TOKEN` and `INTERNAL_INGEST_TOKEN` are configured as Worker
  secrets and injected into the container without logging their values.
- The singleton container is running through the Worker's container binding.
- A real installed Converge client has enabled notifications on production XMTP.
- A second XMTP installation can send into the test conversation.

## Control And Stream

1. Confirm `/livez` is `200` through the container control path.
2. Confirm `/readyz` becomes `200` after snapshot/delta load and XMTP stream
   activity. Verify the reported cursor, registration count, topic count,
   `lastControlSyncAt`, `streamConnectedAt`, and `lastEnvelopeAt` advance.
3. Enable or refresh a real Converge registration. Confirm D1 changes first,
   then the listener cursor/count changes without a container restart.
4. Interrupt XMTP connectivity. `/readyz` must report `stream_disconnected` or
   `stream_stale`, then recover after a new stream and fresh envelope.
5. Stop and restart the container. It must full-snapshot at one cursor, apply
   all subsequent deltas, and return ready without losing current routes.

## End-To-End Delivery

1. From a different installation, send one ordinary message into the registered
   conversation. Expect exactly one browser notification and one queued delivery
   for the route.
2. Send from the registered installation. The route whose HMAC identifies the
   sender must be suppressed.
3. Send an envelope with `shouldPush=false`. Expect no delivery.
4. Exercise a welcome topic by adding a new installation. Expect one minimal
   welcome delivery without message bytes.
5. Register a second app for the same installation/topic with a different HMAC
   set. Send as app A. App A must suppress itself while app B still receives its
   independent delivery. Confirm neither app's key set was unioned into the
   other app route.
6. Delete only app A's logical registration. Confirm the deletion delta removes
   app A while app B continues to receive alerts.
7. Repeat an identical delivery event. Confirm the Worker idempotency boundary
   prevents a second push.

## Privacy Checks

- Inspect listener-to-Worker requests: they must contain only the documented v1
  minimal delivery fields, never XMTP ciphertext, sender identity, conversation
  title, profile name, or message content.
- Inspect logs and traces for both bearer tokens, Web Push endpoints, auth keys,
  and HMAC key material. None may be emitted.
- Confirm a delivery token cannot route across apps when paired with a different
  installation or topic.

Record canary time, listener image/version, D1 migration version, installation
IDs, app IDs, observed status cursor, and pass/fail results in the deployment
log. Keep the user-facing feature marked experimental until this canary passes
and restart/mobile/PWA reliability has been observed over time.

## Latest Production Result

The post-deployment canary passed on 2026-07-14 at 22:34 UTC:

- Worker version: `47c87aef-d76a-45d7-adf7-1cd1fc273b63`.
- Container image digest: `sha256:e01742ea3353a4feaeb3a2aaeab1298b5f76613f2fb57b65a26a3b6d9afe945f`.
- D1 contract migration: `0004_app_scoped_xmtp_identity_contract.sql`.
- Canary run: `20260714223233-05a92fe9`.
- Passed: installation welcome, 16-byte group-topic delivery, three HMAC
  epochs, registered-installation sender suppression, `shouldPush: false`, one
  normal external inbound push, registration deletion, browser unsubscribe,
  and local cleanup.

The feature remains experimental because this one-shot proof does not provide a
durable `SubscribeAll` replay cursor or characterize long-running restart,
disconnect, installed-PWA, and mobile behavior.
