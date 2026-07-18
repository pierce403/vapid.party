-- Delivery routes remain app scoped in the existing subscriptions table.
-- Callback URLs occupy the endpoint column, while Web Push key columns stay
-- empty and are never interpreted for callback rows.
ALTER TABLE subscriptions ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'web_push'
  CHECK (delivery_kind IN ('web_push', 'https_callback'));

CREATE INDEX idx_subscriptions_delivery_kind
  ON subscriptions(app_id, delivery_kind, disabled_at);
