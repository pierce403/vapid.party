# XMTP Listener

This directory contains vapid.party's always-on XMTP v3 listener. It runs as a
singleton Cloudflare Container behind the existing Worker. The Worker and D1
remain the control plane and durable source of registration state; the container
holds only a validated in-memory routing index.

The listener does not expose a public registration API, store PostgreSQL state,
decrypt messages, or send encrypted XMTP payloads to the Worker. It consumes the
production XMTP v3 `SubscribeAll` stream and emits only minimal, authenticated
delivery hints to the Worker's internal ingest endpoint.

## Data Flow

1. The container authenticates to the Worker and reads a cursor-watermarked,
   paginated full snapshot from D1.
2. It reads all deltas after that cursor, validates the entire result, and
   atomically replaces its in-memory index.
3. It polls idempotent D1 deltas. A `409` or `410` reloads the full snapshot.
4. Each matching XMTP envelope is evaluated independently for every app route.
   HMAC keys are never combined across apps, even when two apps register the
   same installation and topic.
5. The listener sends the Worker only the delivery token, installation, topic,
   message class, push flags, and an idempotency key. The Worker resolves the
   opaque token to an app and performs the queued push delivery.

The route identity is `(appId, installationId)`. Deleting one app's route does
not delete or alter another app's route for the same XMTP installation.

## Configuration

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `VAPID_PARTY_CONTROL_URL` | Origin for the Worker's internal snapshot, delta, and status APIs. |
| `VAPID_PARTY_DELIVERY_URL` | Full URL for the Worker's authenticated internal delivery ingest. |
| `XMTP_LISTENER_SYNC_TOKEN` | Bearer token for control-plane reads and status writes. |
| `INTERNAL_INGEST_TOKEN` | Bearer token for minimal delivery events. |

Defaults are production-safe for the first deployment:

- `XMTP_GRPC_ADDRESS=grpc.production.xmtp.network:443`
- `LISTEN_ADDRESS=:8080`
- `CONTROL_POLL_INTERVAL=15s`
- `CONTROL_MAX_STALENESS=2m`
- `STREAM_STARTUP_GRACE=2m`
- `STREAM_MAX_IDLE=3m`
- `STATUS_REPORT_INTERVAL=30s`
- `MESSAGE_WORKERS=4`

The Worker injects the two URLs, both secrets, the release version, and a stable
instance ID. Do not put either bearer token in `wrangler.jsonc` or the image.

## Health Semantics

- `GET /livez` means the process and HTTP server are alive. Container liveness
  uses this endpoint so a temporary upstream outage does not cause a restart
  loop.
- `GET /readyz` means the D1-derived control index is loaded and fresh, the XMTP
  stream is connected, and the global stream has produced an envelope within
  the configured startup/idle window.

Readiness fails closed with one of `control_unavailable`, `control_stale`,
`stream_disconnected`, or `stream_stale`. A reconnect resets envelope freshness;
an old pre-reconnect event cannot make a new stream appear healthy. The listener
also posts these timestamps and coarse counts to the Worker's authenticated
status endpoint.

## Delivery Guarantees

`SubscribeAll` is a live stream and does not supply this listener with a durable
replay cursor. Restarts and upstream disconnects can therefore leave a push-only
gap. This does not lose XMTP messages: clients still obtain messages through
normal XMTP conversation sync when opened. Push remains a wake-up hint, not a
message transport or source of truth.

The Worker must deduplicate the listener's stable `idempotencyKey`. The listener
retries transport errors, HTTP 408/429, and 5xx responses with bounded backoff.

## Local Validation

```bash
GOCACHE=/tmp/vapid-go-cache go test ./...
docker build -t vapid-party-xmtp-listener .
```

Run the image only with real internal endpoints and secrets. The image contains
no development credentials or fallback registration data.

See [CANARY.md](CANARY.md) for production proof and [UPSTREAM.md](UPSTREAM.md)
for the pinned XMTP reference implementation and upgrade procedure.
