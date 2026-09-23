-- Payment service-owned state. Safe to apply repeatedly.
CREATE SCHEMA IF NOT EXISTS payments;

CREATE TABLE IF NOT EXISTS payments.payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         UUID NOT NULL UNIQUE,
  guest_id           UUID NOT NULL,
  amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),
  currency           CHAR(3) NOT NULL DEFAULT 'USD',
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','paid','failed','refunded')),
  provider           TEXT NOT NULL,
  provider_reference TEXT,
  idempotency_key    TEXT NOT NULL UNIQUE,
  failure_code       TEXT,
  paid_at            TIMESTAMPTZ,
  refunded_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_guest
  ON payments.payments (guest_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payments.outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routing_key  TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS payments_outbox_pending
  ON payments.outbox (created_at) WHERE published_at IS NULL;
