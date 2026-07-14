# XMTP Listener Rollout

The production expand/deploy/contract rollout completed on 2026-07-14.

- D1 migration `0003_xmtp_listener_registry_expand.sql` added app-scoped
  listener routes, changes, dirty markers, and consumer status while preserving
  the prior identity uniqueness contract.
- The app-aware Worker and singleton Cloudflare Container were deployed with
  independent sync and delivery secrets.
- D1 migration `0004_app_scoped_xmtp_identity_contract.sql` changed identity
  uniqueness to `(app_id, inbox_id, installation_id)`.
- Production preflights reported zero missing apps, zero cross-app subscription
  mismatches, and no foreign-key errors.
- Public health subsequently reported `deliveryReady: true`, listener `ready`,
  bridge `synced`, and zero pending or failed registrations.

Do not move either migration back to a staged directory. New environments apply
all files in `migrations/d1` in order.

## New Environment

```bash
npm install
npm run lint
npm test
(
  cd infra/xmtp-listener
  GOCACHE=/tmp/vapid-go-cache go test -race ./...
)
npm run db:migrate:remote
npx wrangler deploy
```

Configure independent `XMTP_LISTENER_SYNC_TOKEN` and
`INTERNAL_INGEST_TOKEN` secrets before starting the Container. Never place them
in `wrangler.jsonc`, browser code, logs, or the image.

Verify the schema after migration:

```sql
SELECT COUNT(*) AS missing_apps
FROM xmtp_identities xi
LEFT JOIN apps a ON a.id = xi.app_id
WHERE a.id IS NULL;

SELECT COUNT(*) AS app_scope_mismatches
FROM xmtp_subscriptions xs
JOIN xmtp_identities xi ON xi.id = xs.identity_id
JOIN subscriptions s ON s.id = xs.subscription_id
WHERE s.app_id <> xi.app_id;

PRAGMA foreign_key_check;
```

Both counts must be zero and `foreign_key_check` must return no rows. Never
infer app ownership from an inbox, installation, endpoint, or topic.

## Readiness

`GET /api/health` is ready for XMTP delivery only when:

- `data.xmtp.deliveryReady` is true;
- `data.xmtp.listener.status` is `ready`;
- `data.xmtp.bridge.status` is `synced`;
- pending and failed registration counts are zero.

Follow `infra/xmtp-listener/CANARY.md` after changes to registration, matching,
delivery, Queue behavior, or the Container. `SubscribeAll` has no durable replay
cursor, so push remains a wake-up hint and can have restart/disconnect gaps even
after a canary passes.
