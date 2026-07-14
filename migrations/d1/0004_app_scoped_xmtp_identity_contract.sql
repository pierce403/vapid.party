PRAGMA defer_foreign_keys = ON;

-- Fail closed if the expansion-phase guard was bypassed or data was edited
-- manually. The contract migration must never guess which app owns a row.
DROP TABLE IF EXISTS xmtp_app_scope_guard_0004;

CREATE TABLE xmtp_app_scope_guard_0004 (
  mismatch_count INTEGER NOT NULL CHECK (mismatch_count = 0)
);

INSERT INTO xmtp_app_scope_guard_0004 (mismatch_count)
SELECT COUNT(*)
FROM xmtp_subscriptions xs
JOIN xmtp_identities xi ON xi.id = xs.identity_id
JOIN subscriptions s ON s.id = xs.subscription_id
WHERE s.app_id <> xi.app_id;

DROP TABLE xmtp_app_scope_guard_0004;

-- XMTP identities are app-scoped. The original schema predated generic XMTP
-- clients and allowed one app to replace another app's topic set when both
-- referenced the same inbox and installation.
CREATE TABLE xmtp_identities_new (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'converge' REFERENCES apps(id) ON DELETE CASCADE,
  inbox_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  address TEXT,
  inbox_handle TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(app_id, inbox_id, installation_id)
);

INSERT INTO xmtp_identities_new (
  id, app_id, inbox_id, installation_id, address, inbox_handle, created_at, updated_at
)
SELECT
  xi.id,
  xi.app_id,
  xi.inbox_id,
  xi.installation_id,
  xi.address,
  xi.inbox_handle,
  xi.created_at,
  xi.updated_at
FROM xmtp_identities xi;

CREATE TABLE xmtp_subscriptions_new (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES xmtp_identities_new(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  preferences TEXT NOT NULL DEFAULT '{"minimalPayloadOnly":true,"plaintextPreview":false}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(identity_id, subscription_id)
);

INSERT INTO xmtp_subscriptions_new
SELECT xs.*
FROM xmtp_subscriptions xs
JOIN xmtp_identities_new xi ON xi.id = xs.identity_id;

CREATE TABLE xmtp_topics_new (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES xmtp_identities_new(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'hmac-sha256',
  conversation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(identity_id, topic)
);

INSERT INTO xmtp_topics_new
SELECT xt.*
FROM xmtp_topics xt
JOIN xmtp_identities_new xi ON xi.id = xt.identity_id;

CREATE TABLE xmtp_topic_hmac_keys_new (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES xmtp_topics_new(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  hmac_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(topic_id, epoch, hmac_key)
);

INSERT INTO xmtp_topic_hmac_keys_new
SELECT hk.*
FROM xmtp_topic_hmac_keys hk
JOIN xmtp_topics_new xt ON xt.id = hk.topic_id;

CREATE TABLE delivery_attempts_new (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  xmtp_topic_id TEXT REFERENCES xmtp_topics_new(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  push_status INTEGER,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO delivery_attempts_new
SELECT
  da.id,
  da.app_id,
  da.subscription_id,
  CASE WHEN xt.id IS NULL THEN NULL ELSE da.xmtp_topic_id END,
  da.event_type,
  da.status,
  da.attempts,
  da.last_error,
  da.push_status,
  da.payload_json,
  da.created_at,
  da.updated_at
FROM delivery_attempts da
LEFT JOIN xmtp_topics_new xt ON xt.id = da.xmtp_topic_id;

DROP TABLE delivery_attempts;
DROP TABLE xmtp_topic_hmac_keys;
DROP TABLE xmtp_topics;
DROP TABLE xmtp_subscriptions;
DROP TABLE xmtp_identities;

ALTER TABLE xmtp_identities_new RENAME TO xmtp_identities;
ALTER TABLE xmtp_subscriptions_new RENAME TO xmtp_subscriptions;
ALTER TABLE xmtp_topics_new RENAME TO xmtp_topics;
ALTER TABLE xmtp_topic_hmac_keys_new RENAME TO xmtp_topic_hmac_keys;
ALTER TABLE delivery_attempts_new RENAME TO delivery_attempts;

CREATE INDEX idx_xmtp_identities_app_inbox
  ON xmtp_identities(app_id, inbox_id);
CREATE INDEX idx_xmtp_identities_installation
  ON xmtp_identities(installation_id);
CREATE INDEX idx_xmtp_subscriptions_identity
  ON xmtp_subscriptions(identity_id, active);
CREATE INDEX idx_xmtp_subscriptions_subscription
  ON xmtp_subscriptions(subscription_id, active);
CREATE INDEX idx_xmtp_topics_match ON xmtp_topics(topic);
CREATE INDEX idx_xmtp_topic_hmac_keys_topic_epoch
  ON xmtp_topic_hmac_keys(topic_id, epoch);
CREATE INDEX idx_delivery_attempts_subscription
  ON delivery_attempts(subscription_id, created_at);
CREATE INDEX idx_delivery_attempts_status
  ON delivery_attempts(status, updated_at);
