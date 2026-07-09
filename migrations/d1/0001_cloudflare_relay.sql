CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_wallet TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  vapid_public_key TEXT NOT NULL,
  vapid_private_key TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  rate_limit TEXT NOT NULL DEFAULT '{"maxNotificationsPerMinute":60,"maxNotificationsPerDay":10000,"maxSubscriptions":10000}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_apps_owner_wallet ON apps(owner_wallet);
CREATE INDEX IF NOT EXISTS idx_apps_api_key ON apps(api_key);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_id TEXT,
  channel_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  disabled_at TEXT,
  UNIQUE(app_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_app_id ON subscriptions(app_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(app_id, user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_channel_id ON subscriptions(app_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_disabled ON subscriptions(app_id, disabled_at);

CREATE TABLE IF NOT EXISTS rate_limit_logs (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  window_start TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(app_id, action, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_app_window ON rate_limit_logs(app_id, window_start);

CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_app_created ON usage_logs(app_id, created_at);

CREATE TABLE IF NOT EXISTS xmtp_identities (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  address TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(inbox_id, installation_id)
);

CREATE INDEX IF NOT EXISTS idx_xmtp_identities_inbox ON xmtp_identities(inbox_id);

CREATE TABLE IF NOT EXISTS xmtp_subscriptions (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES xmtp_identities(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  preferences TEXT NOT NULL DEFAULT '{"minimalPayloadOnly":true,"plaintextPreview":false}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(identity_id, subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_xmtp_subscriptions_identity ON xmtp_subscriptions(identity_id, active);
CREATE INDEX IF NOT EXISTS idx_xmtp_subscriptions_subscription ON xmtp_subscriptions(subscription_id, active);

CREATE TABLE IF NOT EXISTS xmtp_topics (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES xmtp_identities(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  hmac_key TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'hmac-sha256',
  conversation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(identity_id, topic)
);

CREATE INDEX IF NOT EXISTS idx_xmtp_topics_match ON xmtp_topics(topic, hmac_key);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  xmtp_topic_id TEXT REFERENCES xmtp_topics(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  push_status INTEGER,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_subscription ON delivery_attempts(subscription_id, created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_status ON delivery_attempts(status, updated_at);

CREATE TABLE IF NOT EXISTS relay_cursors (
  shard TEXT PRIMARY KEY,
  cursor TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
