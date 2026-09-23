-- One Postgres instance, one schema per service (database-per-service pattern,
-- without the operational overhead of multiple instances).

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('guest','staff','admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE auth.refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.credentials(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by UUID REFERENCES auth.refresh_tokens(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user ON auth.refresh_tokens (user_id, expires_at);
CREATE TABLE auth.password_reset_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.credentials(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_user ON auth.password_reset_tokens (user_id, expires_at);
CREATE TABLE auth.outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routing_key  TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX auth_outbox_pending ON auth.outbox (created_at) WHERE published_at IS NULL;

CREATE SCHEMA IF NOT EXISTS users;
CREATE TABLE users.profiles (
  id         UUID PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name  TEXT,
  phone      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SCHEMA IF NOT EXISTS rooms;
CREATE TABLE rooms.room_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  capacity    INTEGER NOT NULL CHECK (capacity > 0)
);
CREATE TABLE rooms.rooms (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_number TEXT NOT NULL UNIQUE,
  type_id     UUID NOT NULL REFERENCES rooms.room_types(id),
  floor       INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','inactive'))
);
-- Holds (room, date-range) taken by a booking. Room service owns availability.
CREATE TABLE rooms.reservations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL UNIQUE,
  room_id    UUID NOT NULL REFERENCES rooms.rooms(id),
  check_in   DATE NOT NULL,
  check_out  DATE NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (check_out > check_in)
);
CREATE INDEX reservations_room_dates ON rooms.reservations (room_id, check_in, check_out);
-- Final database-level guard against overlapping active reservations.
ALTER TABLE rooms.reservations ADD CONSTRAINT reservations_no_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    daterange(check_in, check_out, '[)') WITH &&
  ) WHERE (status = 'active');

CREATE SCHEMA IF NOT EXISTS bookings;
CREATE TABLE bookings.bookings (
  id           UUID PRIMARY KEY,
  guest_id     UUID NOT NULL,
  room_id      UUID NOT NULL,
  room_type_id UUID NOT NULL,
  check_in     DATE NOT NULL,
  check_out    DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','completed')),
  total_cents  INTEGER NOT NULL CHECK (total_cents >= 0),
  confirmed_at TIMESTAMPTZ,
  confirmed_by UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (check_out > check_in)
);
CREATE INDEX bookings_guest ON bookings.bookings (guest_id, status);
CREATE TABLE bookings.outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routing_key  TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX bookings_outbox_pending ON bookings.outbox (created_at) WHERE published_at IS NULL;

CREATE SCHEMA IF NOT EXISTS payments;
CREATE TABLE payments.payments (
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
CREATE INDEX payments_guest ON payments.payments (guest_id, created_at DESC);
CREATE TABLE payments.outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routing_key  TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX payments_outbox_pending ON payments.outbox (created_at) WHERE published_at IS NULL;

CREATE SCHEMA IF NOT EXISTS notifications;
CREATE TABLE notifications.notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID UNIQUE,
  user_id    UUID NOT NULL,
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  read       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed data: room types and rooms
INSERT INTO rooms.room_types (name, description, price_cents, capacity) VALUES
  ('Standard', 'Cozy room with queen bed and city view', 8900, 2),
  ('Deluxe',   'Spacious room with king bed and balcony', 14500, 2),
  ('Suite',    'Two-room suite with living area', 26000, 4);

INSERT INTO rooms.rooms (room_number, type_id, floor)
SELECT '1' || g.n::text, t.id, 1 FROM rooms.room_types t, generate_series(1, 5) g(n) WHERE t.name = 'Standard'
UNION ALL
SELECT '2' || g.n::text, t.id, 2 FROM rooms.room_types t, generate_series(1, 4) g(n) WHERE t.name = 'Deluxe'
UNION ALL
SELECT '3' || g.n::text, t.id, 3 FROM rooms.room_types t, generate_series(1, 2) g(n) WHERE t.name = 'Suite';

-- Extend the fresh database with the idempotent Phase 1 operations schema.
\ir migrations/005_phase1_operations.sql
