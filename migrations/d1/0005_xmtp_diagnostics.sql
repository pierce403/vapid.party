-- Each logical XMTP registration receives a rotating bearer capability for
-- privacy-safe diagnostics. Only its SHA-256 digest is stored.
ALTER TABLE xmtp_subscriptions ADD COLUMN diagnostic_token_hash TEXT;
ALTER TABLE xmtp_subscriptions ADD COLUMN diagnostic_group_topic_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE xmtp_subscriptions ADD COLUMN diagnostic_welcome_topic_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE xmtp_subscriptions ADD COLUMN diagnostic_hmac_epoch_count INTEGER NOT NULL DEFAULT 0;

-- Existing registrations receive a one-time count snapshot. Future refreshes
-- update only their own logical registration's diagnostic snapshot.
UPDATE xmtp_subscriptions
SET diagnostic_group_topic_count = (
      SELECT COUNT(*) FROM xmtp_topics xt
      WHERE xt.identity_id = xmtp_subscriptions.identity_id
        AND xt.topic LIKE '/xmtp/mls/1/g-%/proto'
    ),
    diagnostic_welcome_topic_count = (
      SELECT COUNT(*) FROM xmtp_topics xt
      WHERE xt.identity_id = xmtp_subscriptions.identity_id
        AND xt.topic LIKE '/xmtp/mls/1/w-%/proto'
    ),
    diagnostic_hmac_epoch_count = (
      SELECT COUNT(*)
      FROM xmtp_topic_hmac_keys hk
      JOIN xmtp_topics xt ON xt.id = hk.topic_id
      WHERE xt.identity_id = xmtp_subscriptions.identity_id
    );

CREATE UNIQUE INDEX idx_xmtp_subscriptions_diagnostic_token
  ON xmtp_subscriptions(diagnostic_token_hash)
  WHERE diagnostic_token_hash IS NOT NULL;

-- One XMTP installation is one browser route. Resolve any legacy duplicates
-- deterministically before enforcing the active-route invariant.
WITH ranked_active_routes AS (
  SELECT
    xs.id,
    ROW_NUMBER() OVER (
      PARTITION BY xs.identity_id
      ORDER BY
        CASE WHEN s.disabled_at IS NULL THEN 1 ELSE 0 END DESC,
        xs.updated_at DESC,
        xs.id DESC
    ) AS route_rank
  FROM xmtp_subscriptions xs
  JOIN subscriptions s ON s.id = xs.subscription_id
  WHERE xs.active = 1
)
UPDATE xmtp_subscriptions
SET active = 0,
    diagnostic_token_hash = NULL
WHERE id IN (
  SELECT id FROM ranked_active_routes WHERE route_rank > 1
);

CREATE UNIQUE INDEX idx_xmtp_subscriptions_one_active_identity
  ON xmtp_subscriptions(identity_id)
  WHERE active = 1;

-- The public compatibility route uses this short-lived lock to make a losing
-- concurrent first claim fail before identity, endpoint, topic, or outbox data
-- can be mutated.
CREATE TABLE xmtp_registration_mutation_locks (
  app_id TEXT NOT NULL,
  inbox_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  lock_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(app_id, inbox_id, installation_id)
);

CREATE INDEX idx_xmtp_registration_mutation_locks_expiry
  ON xmtp_registration_mutation_locks(expires_at);

-- Tie delivery progress to the exact logical XMTP registration. A physical
-- Web Push endpoint can be shared by several inbox registrations.
ALTER TABLE delivery_attempts ADD COLUMN xmtp_subscription_id TEXT
  REFERENCES xmtp_subscriptions(id) ON DELETE SET NULL;

CREATE INDEX idx_delivery_attempts_xmtp_registration
  ON delivery_attempts(xmtp_subscription_id, event_type, created_at DESC);
