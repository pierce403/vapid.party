-- Expansion phase: this migration remains compatible with the previously
-- deployed Worker, including its ON CONFLICT(inbox_id, installation_id) SQL.
-- The staged 0004 contract migration removes that legacy global uniqueness
-- only after the app-aware Worker is live.
ALTER TABLE xmtp_identities
  ADD COLUMN app_id TEXT NOT NULL DEFAULT 'converge';

CREATE INDEX idx_xmtp_identities_app_inbox_installation
  ON xmtp_identities(app_id, inbox_id, installation_id);

-- Stable, provider-neutral routing tokens are internal listener identifiers.
-- They are never browser push endpoints or client credentials.
CREATE TABLE xmtp_listener_installations (
  app_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  delivery_token TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(app_id, installation_id)
);

CREATE TABLE xmtp_listener_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  latest_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO xmtp_listener_meta (id, latest_sequence) VALUES (1, 0);

-- This append-only change log is the D1 outbox. Each row means "reconcile this
-- installation from current canonical D1 state"; consumers may safely replay.
CREATE TABLE xmtp_listener_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('registration-upserted', 'registration-deleted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_xmtp_listener_changes_installation_sequence
  ON xmtp_listener_changes(app_id, installation_id, sequence);
CREATE INDEX idx_xmtp_listener_changes_created
  ON xmtp_listener_changes(created_at);

-- Mark a route before a multi-statement registration mutation. The outbox
-- write clears the matching version atomically; cron repairs markers left by
-- a Worker termination.
CREATE TABLE xmtp_listener_dirty_routes (
  app_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(app_id, installation_id)
);

CREATE INDEX idx_xmtp_listener_dirty_routes_updated
  ON xmtp_listener_dirty_routes(updated_at);

-- Container instances report only coarse readiness and their applied cursor.
CREATE TABLE xmtp_listener_consumers (
  instance_id TEXT PRIMARY KEY,
  ready INTEGER NOT NULL DEFAULT 0,
  cursor INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  stream_connected_at TEXT,
  last_envelope_at TEXT,
  last_control_sync_at TEXT,
  registration_count INTEGER,
  topic_count INTEGER,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_xmtp_listener_consumers_updated
  ON xmtp_listener_consumers(updated_at DESC);

-- Existing production registrations are automatically discoverable after the
-- migration without waiting for every browser to re-register.
INSERT OR IGNORE INTO xmtp_listener_installations (app_id, installation_id, delivery_token)
SELECT DISTINCT app_id, installation_id, lower(hex(randomblob(16)))
FROM xmtp_identities;

INSERT INTO xmtp_listener_changes (app_id, installation_id, reason)
SELECT DISTINCT app_id, installation_id, 'registration-upserted'
FROM xmtp_identities;

UPDATE xmtp_listener_meta
SET latest_sequence = COALESCE((SELECT MAX(sequence) FROM xmtp_listener_changes), 0),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1;
