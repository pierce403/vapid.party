-- Public service health retains only the latest coarse operational timestamps.
-- It never stores app, endpoint, subscription, topic, inbox, payload, or message
-- identifiers. Listener and delivery history keep their existing short windows.
ALTER TABLE xmtp_listener_consumers ADD COLUMN last_delivery_probe_at TEXT;

CREATE TABLE service_activity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_xmtp_envelope_at TEXT,
  last_web_push_accepted_at TEXT,
  last_callback_accepted_at TEXT,
  last_delivery_failure_at TEXT,
  last_delivery_failure_category TEXT
    CHECK (
      last_delivery_failure_category IS NULL
      OR last_delivery_failure_category IN (
        'subscription_expired',
        'provider_rate_limited',
        'provider_unavailable',
        'provider_rejected',
        'relay_failure'
      )
    ),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO service_activity (
  id,
  last_xmtp_envelope_at,
  last_web_push_accepted_at,
  last_callback_accepted_at,
  last_delivery_failure_at,
  last_delivery_failure_category
)
SELECT
  1,
  (
    SELECT MAX(last_envelope_at)
    FROM xmtp_listener_consumers
  ),
  (
    SELECT MAX(attempt.updated_at)
    FROM delivery_attempts attempt
    JOIN subscriptions subscription ON subscription.id = attempt.subscription_id
    WHERE attempt.status = 'sent' AND subscription.delivery_kind = 'web_push'
  ),
  (
    SELECT MAX(attempt.updated_at)
    FROM delivery_attempts attempt
    JOIN subscriptions subscription ON subscription.id = attempt.subscription_id
    WHERE attempt.status = 'sent' AND subscription.delivery_kind = 'https_callback'
  ),
  (
    SELECT attempt.updated_at
    FROM delivery_attempts attempt
    WHERE attempt.last_error IN (
      'subscription_expired',
      'provider_rate_limited',
      'provider_unavailable',
      'provider_rejected',
      'relay_failure'
    )
    ORDER BY attempt.updated_at DESC
    LIMIT 1
  ),
  (
    SELECT attempt.last_error
    FROM delivery_attempts attempt
    WHERE attempt.last_error IN (
      'subscription_expired',
      'provider_rate_limited',
      'provider_unavailable',
      'provider_rejected',
      'relay_failure'
    )
    ORDER BY attempt.updated_at DESC
    LIMIT 1
  );
