-- RabbitMQ outboxes, rotating refresh tokens, and password-reset state.
CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.credentials(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by UUID REFERENCES auth.refresh_tokens(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user ON auth.refresh_tokens (user_id, expires_at);

CREATE TABLE IF NOT EXISTS auth.password_reset_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.credentials(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_user ON auth.password_reset_tokens (user_id, expires_at);

CREATE TABLE IF NOT EXISTS auth.outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routing_key  TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_outbox_pending ON auth.outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS bookings.outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routing_key  TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bookings_outbox_pending ON bookings.outbox (created_at) WHERE published_at IS NULL;

ALTER TABLE notifications.notifications ADD COLUMN IF NOT EXISTS event_id UUID;
DROP INDEX IF EXISTS notifications.notifications_event_id;
CREATE UNIQUE INDEX notifications_event_id
  ON notifications.notifications (event_id);
