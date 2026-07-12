PRAGMA defer_foreign_keys = ON;

ALTER TABLE xmtp_identities ADD COLUMN inbox_handle TEXT;

-- Rebuilding xmtp_topics temporarily fires delivery_attempts' ON DELETE SET
-- NULL action. Preserve those references and restore them after the new table
-- has taken the original name.
CREATE TABLE xmtp_delivery_topic_refs_0002 (
  delivery_attempt_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL
);

INSERT INTO xmtp_delivery_topic_refs_0002 (delivery_attempt_id, topic_id)
SELECT id, xmtp_topic_id
FROM delivery_attempts
WHERE xmtp_topic_id IS NOT NULL;

CREATE TABLE xmtp_topics_new (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES xmtp_identities(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'hmac-sha256',
  conversation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(identity_id, topic)
);

CREATE TABLE xmtp_topic_hmac_keys_new (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES xmtp_topics_new(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  hmac_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(topic_id, epoch, hmac_key)
);

INSERT INTO xmtp_topics_new (
  id, identity_id, topic, algorithm, conversation_id, created_at, updated_at
)
SELECT id, identity_id, topic, algorithm, conversation_id, created_at, updated_at
FROM xmtp_topics;

INSERT INTO xmtp_topic_hmac_keys_new (
  id, topic_id, epoch, hmac_key, created_at, updated_at
)
SELECT id || ':legacy', id, 'legacy', hmac_key, created_at, updated_at
FROM xmtp_topics;

DROP TABLE xmtp_topics;
ALTER TABLE xmtp_topics_new RENAME TO xmtp_topics;
ALTER TABLE xmtp_topic_hmac_keys_new RENAME TO xmtp_topic_hmac_keys;

UPDATE delivery_attempts
SET xmtp_topic_id = (
  SELECT topic_id
  FROM xmtp_delivery_topic_refs_0002 refs
  WHERE refs.delivery_attempt_id = delivery_attempts.id
)
WHERE id IN (SELECT delivery_attempt_id FROM xmtp_delivery_topic_refs_0002);

DROP TABLE xmtp_delivery_topic_refs_0002;

CREATE INDEX idx_xmtp_topics_match ON xmtp_topics(topic);
CREATE INDEX idx_xmtp_topic_hmac_keys_topic_epoch
  ON xmtp_topic_hmac_keys(topic_id, epoch);

CREATE TABLE xmtp_delivery_events (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(installation_id, topic, idempotency_key, subscription_id)
);

CREATE INDEX idx_xmtp_delivery_events_created
  ON xmtp_delivery_events(created_at);
