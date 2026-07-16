-- One installation can describe only one inbox inside an app. Fail closed
-- before adding the index so the migration never guesses which inbox owns an
-- already-ambiguous route. The app id remains part of the key so separate apps
-- may register the same XMTP installation independently.
DROP TABLE IF EXISTS xmtp_installation_identity_guard_0006;

CREATE TABLE xmtp_installation_identity_guard_0006 (
  duplicate_count INTEGER NOT NULL CHECK (duplicate_count = 0)
);

INSERT INTO xmtp_installation_identity_guard_0006 (duplicate_count)
SELECT COUNT(*)
FROM (
  SELECT app_id, installation_id
  FROM xmtp_identities
  GROUP BY app_id, installation_id
  HAVING COUNT(*) > 1
);

DROP TABLE xmtp_installation_identity_guard_0006;

CREATE UNIQUE INDEX idx_xmtp_identities_app_installation
  ON xmtp_identities(app_id, installation_id);

-- Migration 0005 retained losing duplicate routes as inactive rows. They are
-- not listener state and no capability can reactivate them, so remove their
-- routing material instead of letting it occupy the new hard capacity budget.
DELETE FROM xmtp_subscriptions WHERE active = 0;

DELETE FROM xmtp_identities
WHERE NOT EXISTS (
  SELECT 1 FROM xmtp_subscriptions registration
  WHERE registration.identity_id = xmtp_identities.id
);

DELETE FROM subscriptions
WHERE json_valid(metadata)
  AND json_extract(metadata, '$.source') = 'xmtp'
  AND NOT EXISTS (
    SELECT 1 FROM xmtp_subscriptions registration
    WHERE registration.subscription_id = subscriptions.id
  );

-- Keep the per-app physical and logical subscription ceilings atomic in D1.
-- API-side count checks provide friendly early responses, while these guards
-- close the race between concurrent requests. The stable abort marker is
-- translated to HTTP 429 by the Worker.
CREATE TRIGGER subscriptions_limit_before_insert
BEFORE INSERT ON subscriptions
WHEN NEW.disabled_at IS NULL
  -- An UPSERT executes BEFORE INSERT before resolving its endpoint conflict.
  -- Let an already-persisted endpoint refresh without consuming another slot.
  -- Expired rows still occupy storage until bounded cleanup removes them, so
  -- they count toward this hard ceiling even though delivery queries ignore
  -- them immediately.
  AND NOT EXISTS (
    SELECT 1
    FROM subscriptions existing
    WHERE existing.app_id = NEW.app_id
      AND existing.endpoint = NEW.endpoint
      AND existing.disabled_at IS NULL
  )
  AND (
    SELECT COUNT(*)
    FROM subscriptions persisted
    WHERE persisted.app_id = NEW.app_id AND persisted.disabled_at IS NULL
  ) >= COALESCE((
    SELECT CASE
      WHEN json_valid(app.rate_limit)
        THEN CAST(json_extract(app.rate_limit, '$.maxSubscriptions') AS INTEGER)
      ELSE NULL
    END
    FROM apps app
    WHERE app.id = NEW.app_id
  ), 10000)
BEGIN
  SELECT RAISE(ABORT, 'app_subscription_limit');
END;

CREATE TRIGGER subscriptions_limit_before_reactivate
BEFORE UPDATE OF disabled_at, expires_at ON subscriptions
WHEN OLD.disabled_at IS NOT NULL
  AND NEW.disabled_at IS NULL
  AND (
    SELECT COUNT(*)
    FROM subscriptions persisted
    WHERE persisted.app_id = NEW.app_id AND persisted.disabled_at IS NULL
  ) >= COALESCE((
    SELECT CASE
      WHEN json_valid(app.rate_limit)
        THEN CAST(json_extract(app.rate_limit, '$.maxSubscriptions') AS INTEGER)
      ELSE NULL
    END
    FROM apps app
    WHERE app.id = NEW.app_id
  ), 10000)
BEGIN
  SELECT RAISE(ABORT, 'app_subscription_limit');
END;

CREATE TRIGGER xmtp_subscriptions_limit_before_insert
BEFORE INSERT ON xmtp_subscriptions
WHEN NEW.active = 1
  AND (
    SELECT COUNT(*)
    FROM xmtp_subscriptions persisted
    JOIN xmtp_identities identity ON identity.id = persisted.identity_id
    WHERE identity.app_id = (
      SELECT candidate.app_id
      FROM xmtp_identities candidate
      WHERE candidate.id = NEW.identity_id
    )
      AND persisted.active = 1
  ) >= COALESCE((
    SELECT CASE
      WHEN json_valid(app.rate_limit)
        THEN CAST(json_extract(app.rate_limit, '$.maxSubscriptions') AS INTEGER)
      ELSE NULL
    END
    FROM apps app
    JOIN xmtp_identities identity ON identity.app_id = app.id
    WHERE identity.id = NEW.identity_id
  ), 10000)
BEGIN
  SELECT RAISE(ABORT, 'app_subscription_limit');
END;

CREATE TRIGGER xmtp_subscriptions_limit_before_reactivate
BEFORE UPDATE OF active ON xmtp_subscriptions
WHEN OLD.active <> 1
  AND NEW.active = 1
  AND (
    SELECT COUNT(*)
    FROM xmtp_subscriptions persisted
    JOIN xmtp_identities identity ON identity.id = persisted.identity_id
    WHERE identity.app_id = (
      SELECT candidate.app_id
      FROM xmtp_identities candidate
      WHERE candidate.id = NEW.identity_id
    )
      AND persisted.active = 1
  ) >= COALESCE((
    SELECT CASE
      WHEN json_valid(app.rate_limit)
        THEN CAST(json_extract(app.rate_limit, '$.maxSubscriptions') AS INTEGER)
      ELSE NULL
    END
    FROM apps app
    JOIN xmtp_identities identity ON identity.app_id = app.id
    WHERE identity.id = NEW.identity_id
  ), 10000)
BEGIN
  SELECT RAISE(ABORT, 'app_subscription_limit');
END;

-- Public apps use one-time bearer capabilities. Only SHA-256 digests are
-- retained; the app secret itself is returned once and never stored.
CREATE TABLE app_credentials (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  secret_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT
);

CREATE INDEX idx_app_credentials_app_active
  ON app_credentials(app_id, revoked_at);

CREATE UNIQUE INDEX idx_app_credentials_one_active
  ON app_credentials(app_id)
  WHERE revoked_at IS NULL;

-- Public profile data is deliberately separate from private app metadata.
-- Apps are absent from the leaderboard unless they explicitly opt in.
CREATE TABLE app_public_profiles (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  domain TEXT,
  domain_verified_at TEXT,
  domain_last_checked_at TEXT,
  domain_verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (domain_verification_status IN ('unverified', 'verified', 'mismatch')),
  domain_verified_vapid_key TEXT,
  leaderboard_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (leaderboard_opt_in IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_app_public_profiles_leaderboard
  ON app_public_profiles(leaderboard_opt_in, domain_verified_at);

-- Keep anonymous persistent state finite even when app creation is deliberately
-- frictionless. These are high emergency ceilings, not advertised quotas.
-- Public apps remain deletable and immediately release their reserved rows.
CREATE TABLE public_platform_capacity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_count INTEGER NOT NULL DEFAULT 0 CHECK (app_count >= 0),
  subscription_count INTEGER NOT NULL DEFAULT 0 CHECK (subscription_count >= 0)
);

INSERT INTO public_platform_capacity (id, app_count, subscription_count)
SELECT
  1,
  (SELECT COUNT(*) FROM app_public_profiles),
  (
    SELECT COUNT(*)
    FROM subscriptions subscription
    JOIN app_public_profiles profile ON profile.app_id = subscription.app_id
  );

CREATE TRIGGER public_app_capacity_before_insert
BEFORE INSERT ON app_public_profiles
WHEN (SELECT app_count FROM public_platform_capacity WHERE id = 1) >= 25000
BEGIN
  SELECT RAISE(ABORT, 'public_app_capacity_limit');
END;

CREATE TRIGGER public_app_capacity_after_insert
AFTER INSERT ON app_public_profiles
BEGIN
  UPDATE public_platform_capacity SET app_count = app_count + 1 WHERE id = 1;
END;

CREATE TRIGGER public_app_capacity_before_delete
BEFORE DELETE ON app_public_profiles
BEGIN
  UPDATE public_platform_capacity SET app_count = MAX(0, app_count - 1) WHERE id = 1;
END;

CREATE TRIGGER public_app_subscriptions_capacity_before_insert
BEFORE INSERT ON subscriptions
WHEN EXISTS (
    SELECT 1 FROM app_public_profiles profile WHERE profile.app_id = NEW.app_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM subscriptions existing
    WHERE existing.app_id = NEW.app_id AND existing.endpoint = NEW.endpoint
  )
  AND (
    SELECT subscription_count FROM public_platform_capacity WHERE id = 1
  ) >= 250000
BEGIN
  SELECT RAISE(ABORT, 'public_subscription_capacity_limit');
END;

CREATE TRIGGER public_app_subscriptions_capacity_after_insert
AFTER INSERT ON subscriptions
WHEN EXISTS (
  SELECT 1 FROM app_public_profiles profile WHERE profile.app_id = NEW.app_id
)
BEGIN
  UPDATE public_platform_capacity
  SET subscription_count = subscription_count + 1
  WHERE id = 1;
END;

CREATE TRIGGER public_app_subscriptions_capacity_before_delete
BEFORE DELETE ON subscriptions
WHEN EXISTS (
  SELECT 1 FROM app_public_profiles profile WHERE profile.app_id = OLD.app_id
)
BEGIN
  UPDATE public_platform_capacity
  SET subscription_count = MAX(0, subscription_count - 1)
  WHERE id = 1;
END;

-- During an app cascade the parent profile is no longer visible to the child
-- subscription trigger, so subtract the complete public-app footprint while
-- OLD.id is still queryable. Direct subscription deletes continue to use the
-- child trigger above.
CREATE TRIGGER public_app_subscriptions_before_app_delete
BEFORE DELETE ON apps
WHEN EXISTS (
  SELECT 1 FROM app_public_profiles profile WHERE profile.app_id = OLD.id
)
BEGIN
  UPDATE public_platform_capacity
  SET subscription_count = MAX(
    0,
    subscription_count - (
      SELECT COUNT(*) FROM subscriptions WHERE app_id = OLD.id
    )
  )
  WHERE id = 1;
END;

-- The listener decodes HMAC material into memory and accepts at most 256
-- decoded bytes per key. Stored keys are normalized unpadded base64url, where
-- 342 characters is the largest encoding of 256 bytes. Fail closed instead of
-- allowing one legacy row to poison every listener snapshot.
DROP TABLE IF EXISTS xmtp_hmac_size_guard_0006;

CREATE TABLE xmtp_hmac_size_guard_0006 (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);

INSERT INTO xmtp_hmac_size_guard_0006 (invalid_count)
SELECT COUNT(*)
FROM xmtp_topic_hmac_keys
WHERE length(hmac_key) < 2 OR length(hmac_key) > 342;

DROP TABLE xmtp_hmac_size_guard_0006;

CREATE TRIGGER xmtp_hmac_size_before_insert
BEFORE INSERT ON xmtp_topic_hmac_keys
WHEN length(NEW.hmac_key) < 2 OR length(NEW.hmac_key) > 342
BEGIN
  SELECT RAISE(ABORT, 'xmtp_hmac_key_size');
END;

CREATE TRIGGER xmtp_hmac_size_before_update
BEFORE UPDATE OF hmac_key ON xmtp_topic_hmac_keys
WHEN length(NEW.hmac_key) < 2 OR length(NEW.hmac_key) > 342
BEGIN
  SELECT RAISE(ABORT, 'xmtp_hmac_key_size');
END;

-- Bound the singleton listener's complete in-memory index, not just each page
-- or registration. These counters contain no routing material; triggers keep
-- them transactionally aligned with topic and HMAC rows, including cascades.
DROP TABLE IF EXISTS xmtp_capacity_guard_0006;

CREATE TABLE xmtp_capacity_guard_0006 (
  violation_count INTEGER NOT NULL CHECK (violation_count = 0)
);

WITH per_app AS (
  SELECT app_id, SUM(row_count) AS row_count
  FROM (
    SELECT xi.app_id, COUNT(*) AS row_count
    FROM xmtp_topics xt
    JOIN xmtp_identities xi ON xi.id = xt.identity_id
    GROUP BY xi.app_id
    UNION ALL
    SELECT xi.app_id, COUNT(*) AS row_count
    FROM xmtp_topic_hmac_keys hk
    JOIN xmtp_topics xt ON xt.id = hk.topic_id
    JOIN xmtp_identities xi ON xi.id = xt.identity_id
    GROUP BY xi.app_id
  )
  GROUP BY app_id
)
INSERT INTO xmtp_capacity_guard_0006 (violation_count)
SELECT
  COALESCE(SUM(CASE WHEN row_count > 5000 THEN 1 ELSE 0 END), 0)
  + CASE WHEN COALESCE(SUM(row_count), 0) > 25000 THEN 1 ELSE 0 END
FROM per_app;

DROP TABLE xmtp_capacity_guard_0006;

CREATE TABLE xmtp_app_capacity (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0)
);

INSERT INTO xmtp_app_capacity (app_id, row_count)
SELECT app_id, SUM(row_count)
FROM (
  SELECT xi.app_id, COUNT(*) AS row_count
  FROM xmtp_topics xt
  JOIN xmtp_identities xi ON xi.id = xt.identity_id
  GROUP BY xi.app_id
  UNION ALL
  SELECT xi.app_id, COUNT(*) AS row_count
  FROM xmtp_topic_hmac_keys hk
  JOIN xmtp_topics xt ON xt.id = hk.topic_id
  JOIN xmtp_identities xi ON xi.id = xt.identity_id
  GROUP BY xi.app_id
)
GROUP BY app_id;

CREATE TABLE xmtp_global_capacity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0)
);

INSERT INTO xmtp_global_capacity (id, row_count)
SELECT 1, COALESCE(SUM(row_count), 0) FROM xmtp_app_capacity;

CREATE TRIGGER xmtp_app_capacity_limit_before_insert
BEFORE INSERT ON xmtp_app_capacity
WHEN NEW.row_count > 5000
BEGIN
  SELECT RAISE(ABORT, 'xmtp_app_capacity_limit');
END;

CREATE TRIGGER xmtp_app_capacity_limit_before_update
BEFORE UPDATE OF row_count ON xmtp_app_capacity
WHEN NEW.row_count > 5000
BEGIN
  SELECT RAISE(ABORT, 'xmtp_app_capacity_limit');
END;

CREATE TRIGGER xmtp_global_capacity_limit_before_update
BEFORE UPDATE OF row_count ON xmtp_global_capacity
WHEN NEW.row_count > 25000
BEGIN
  SELECT RAISE(ABORT, 'xmtp_global_capacity_limit');
END;

CREATE TRIGGER xmtp_topic_capacity_after_insert
AFTER INSERT ON xmtp_topics
BEGIN
  INSERT INTO xmtp_app_capacity (app_id, row_count)
  SELECT xi.app_id, 1
  FROM xmtp_identities xi
  WHERE xi.id = NEW.identity_id
  ON CONFLICT(app_id) DO UPDATE SET row_count = row_count + 1;
  UPDATE xmtp_global_capacity SET row_count = row_count + 1 WHERE id = 1;
END;

CREATE TRIGGER xmtp_topic_capacity_before_delete
BEFORE DELETE ON xmtp_topics
BEGIN
  UPDATE xmtp_app_capacity
  SET row_count = MAX(
    0,
    row_count - 1 - (
      SELECT COUNT(*)
      FROM xmtp_topic_hmac_keys hk
      WHERE hk.topic_id = OLD.id
    )
  )
  WHERE app_id = (
    SELECT xi.app_id FROM xmtp_identities xi WHERE xi.id = OLD.identity_id
  );
  UPDATE xmtp_global_capacity SET row_count = MAX(0, row_count - 1) WHERE id = 1;
END;

-- Parent rows are no longer visible to child triggers once a foreign-key
-- cascade begins. Account for the complete identity while OLD.app_id is still
-- available; topic/HMAC child triggers remain responsible for the global
-- counter and become no-ops for the per-app counter during this cascade.
CREATE TRIGGER xmtp_identity_capacity_before_delete
BEFORE DELETE ON xmtp_identities
BEGIN
  UPDATE xmtp_app_capacity
  SET row_count = MAX(
    0,
    row_count - (
      SELECT COUNT(*)
      FROM xmtp_topics xt
      WHERE xt.identity_id = OLD.id
    ) - (
      SELECT COUNT(*)
      FROM xmtp_topic_hmac_keys hk
      JOIN xmtp_topics xt ON xt.id = hk.topic_id
      WHERE xt.identity_id = OLD.id
    )
  )
  WHERE app_id = OLD.app_id;
END;

CREATE TRIGGER xmtp_hmac_capacity_after_insert
AFTER INSERT ON xmtp_topic_hmac_keys
BEGIN
  INSERT INTO xmtp_app_capacity (app_id, row_count)
  SELECT xi.app_id, 1
  FROM xmtp_topics xt
  JOIN xmtp_identities xi ON xi.id = xt.identity_id
  WHERE xt.id = NEW.topic_id
  ON CONFLICT(app_id) DO UPDATE SET row_count = row_count + 1;
  UPDATE xmtp_global_capacity SET row_count = row_count + 1 WHERE id = 1;
END;

CREATE TRIGGER xmtp_hmac_capacity_before_delete
BEFORE DELETE ON xmtp_topic_hmac_keys
BEGIN
  UPDATE xmtp_app_capacity
  SET row_count = MAX(0, row_count - 1)
  WHERE app_id = (
    SELECT xi.app_id
    FROM xmtp_topics xt
    JOIN xmtp_identities xi ON xi.id = xt.identity_id
    WHERE xt.id = OLD.topic_id
  );
  UPDATE xmtp_global_capacity SET row_count = MAX(0, row_count - 1) WHERE id = 1;
END;

-- High anonymous mutation ceilings are abuse backstops, not account or signup
-- gates. Scope values are secret-salted digests; raw client IPs are not stored.
CREATE TABLE public_rate_limits (
  scope_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(scope_hash, action, window_start)
);

CREATE INDEX idx_public_rate_limits_created
  ON public_rate_limits(created_at);

CREATE INDEX idx_rate_limit_logs_retention
  ON rate_limit_logs(window_start);

CREATE INDEX idx_delivery_attempts_retention
  ON delivery_attempts(event_type, created_at);

-- Browser enrollment is public, but endpoint deletion uses a separate
-- per-subscription capability. Only its digest is stored.
ALTER TABLE subscriptions ADD COLUMN management_token_hash TEXT;

CREATE UNIQUE INDEX idx_subscriptions_management_token
  ON subscriptions(management_token_hash)
  WHERE management_token_hash IS NOT NULL;

CREATE INDEX idx_subscriptions_expiration
  ON subscriptions(expires_at)
  WHERE disabled_at IS NULL AND expires_at IS NOT NULL;

-- Usage is kept as short-lived daily counters. It contains no notification
-- payload, endpoint, user, topic, inbox, or message data.
CREATE TABLE app_usage_daily (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  event_type TEXT NOT NULL,
  queued_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  expired_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(app_id, day, event_type)
);

CREATE INDEX idx_app_usage_daily_day
  ON app_usage_daily(day, sent_count DESC);

CREATE INDEX idx_app_usage_daily_window
  ON app_usage_daily(day, event_type, app_id);

-- Seed the rolling window from the operational attempts that still exist at
-- migration time. Earlier retry transitions cannot be reconstructed, so this
-- backfill records each row's current terminal state exactly once.
INSERT INTO app_usage_daily (
  app_id, day, event_type, queued_count, sent_count, failed_count, expired_count
)
SELECT
  app_id,
  substr(created_at, 1, 10),
  event_type,
  COUNT(*),
  SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END)
FROM delivery_attempts
WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days')
GROUP BY app_id, substr(created_at, 1, 10), event_type;

-- Operational rows retain only the diagnostic test id needed by the scoped
-- status endpoint. Generic notification copy and opaque XMTP routing hints are
-- removed immediately rather than waiting for compaction.
UPDATE delivery_attempts
SET payload_json = CASE
  WHEN event_type = 'vapid.diagnostic'
    AND json_type(
      CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,
      '$.testId'
    ) = 'text'
    THEN json_object('testId', json_extract(payload_json, '$.testId'))
  ELSE '{}'
END,
last_error = CASE
  WHEN last_error IN (
    'subscription_expired',
    'provider_rate_limited',
    'provider_unavailable',
    'provider_rejected',
    'relay_failure'
  ) THEN last_error
  ELSE NULL
END;

-- Enforce the same boundary in D1 itself. This closes the migration-to-Worker
-- cutover window and prevents an older Worker from reintroducing notification
-- copy or raw provider errors after the one-time scrub above.
CREATE TRIGGER delivery_attempts_redact_after_insert
AFTER INSERT ON delivery_attempts
BEGIN
  UPDATE delivery_attempts
  SET payload_json = CASE
    WHEN NEW.event_type = 'vapid.diagnostic'
      AND json_type(
        CASE WHEN json_valid(NEW.payload_json) THEN NEW.payload_json ELSE '{}' END,
        '$.testId'
      ) = 'text'
      THEN json_object('testId', json_extract(NEW.payload_json, '$.testId'))
    ELSE '{}'
  END,
  last_error = CASE
    WHEN NEW.last_error IN (
      'subscription_expired',
      'provider_rate_limited',
      'provider_unavailable',
      'provider_rejected',
      'relay_failure'
    ) THEN NEW.last_error
    ELSE NULL
  END
  WHERE id = NEW.id;
END;

CREATE TRIGGER delivery_attempts_redact_after_update
AFTER UPDATE OF payload_json, last_error ON delivery_attempts
WHEN NEW.payload_json <> CASE
    WHEN NEW.event_type = 'vapid.diagnostic'
      AND json_type(
        CASE WHEN json_valid(NEW.payload_json) THEN NEW.payload_json ELSE '{}' END,
        '$.testId'
      ) = 'text'
      THEN json_object('testId', json_extract(NEW.payload_json, '$.testId'))
    ELSE '{}'
  END
  OR COALESCE(NEW.last_error, '') NOT IN (
    '',
    'subscription_expired',
    'provider_rate_limited',
    'provider_unavailable',
    'provider_rejected',
    'relay_failure'
  )
BEGIN
  UPDATE delivery_attempts
  SET payload_json = CASE
    WHEN NEW.event_type = 'vapid.diagnostic'
      AND json_type(
        CASE WHEN json_valid(NEW.payload_json) THEN NEW.payload_json ELSE '{}' END,
        '$.testId'
      ) = 'text'
      THEN json_object('testId', json_extract(NEW.payload_json, '$.testId'))
    ELSE '{}'
  END,
  last_error = CASE
    WHEN NEW.last_error IN (
      'subscription_expired',
      'provider_rate_limited',
      'provider_unavailable',
      'provider_rejected',
      'relay_failure'
    ) THEN NEW.last_error
    ELSE NULL
  END
  WHERE id = NEW.id;
END;

-- This unused early prototype table was never written by the Worker. Removing
-- it prevents accidental long-term event logging from becoming product state.
DROP TABLE usage_logs;
