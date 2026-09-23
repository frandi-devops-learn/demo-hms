-- Phase 1 operational HMS schema. Safe to apply repeatedly.
ALTER TABLE auth.credentials ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE auth.credentials DROP CONSTRAINT IF EXISTS credentials_role_check;
ALTER TABLE auth.credentials ADD CONSTRAINT credentials_role_check
  CHECK (role IN ('guest','staff','admin','manager','receptionist','housekeeper','accountant'));

ALTER TABLE users.profiles ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE users.profiles ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE users.profiles ADD COLUMN IF NOT EXISTS nationality TEXT;
ALTER TABLE users.profiles ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE users.profiles ADD COLUMN IF NOT EXISTS id_type TEXT;
ALTER TABLE users.profiles ADD COLUMN IF NOT EXISTS id_number TEXT;
ALTER TABLE users.profiles ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE users.profiles ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE rooms.room_types ADD COLUMN IF NOT EXISTS number_of_beds INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rooms.room_types ADD COLUMN IF NOT EXISTS bed_type TEXT NOT NULL DEFAULT 'Queen';
ALTER TABLE rooms.room_types ADD COLUMN IF NOT EXISTS amenities JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE rooms.room_types ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE rooms.room_types ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE rooms.rooms ADD COLUMN IF NOT EXISTS building TEXT NOT NULL DEFAULT 'Main';
ALTER TABLE rooms.rooms ADD COLUMN IF NOT EXISTS base_rate_cents INTEGER;
ALTER TABLE rooms.rooms ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE rooms.rooms ADD COLUMN IF NOT EXISTS amenities JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE rooms.rooms ADD COLUMN IF NOT EXISTS operational_status TEXT NOT NULL DEFAULT 'available';
ALTER TABLE rooms.rooms DROP CONSTRAINT IF EXISTS rooms_operational_status_check;
ALTER TABLE rooms.rooms ADD CONSTRAINT rooms_operational_status_check CHECK (
  operational_status IN ('available','reserved','occupied','dirty','cleaning','clean','inspected','out_of_service','out_of_order')
);

ALTER TABLE bookings.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings.bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending','confirmed','checked_in','checked_out','cancelled','completed','no_show'));
ALTER TABLE bookings.bookings ADD COLUMN IF NOT EXISTS reservation_number TEXT;
UPDATE bookings.bookings SET reservation_number = 'RES-' || upper(substr(replace(id::text, '-', ''), 1, 10))
  WHERE reservation_number IS NULL;
ALTER TABLE bookings.bookings ALTER COLUMN reservation_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bookings_reservation_number ON bookings.bookings (reservation_number);
ALTER TABLE bookings.bookings ADD COLUMN IF NOT EXISTS adults INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bookings.bookings ADD COLUMN IF NOT EXISTS children INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings.bookings ADD COLUMN IF NOT EXISTS special_requests TEXT;
ALTER TABLE bookings.bookings ADD COLUMN IF NOT EXISTS booking_source TEXT NOT NULL DEFAULT 'guest_portal';
ALTER TABLE bookings.bookings ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE bookings.bookings ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ;
ALTER TABLE bookings.bookings ADD COLUMN IF NOT EXISTS checked_in_by UUID;
ALTER TABLE bookings.bookings ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMPTZ;
ALTER TABLE bookings.bookings ADD COLUMN IF NOT EXISTS checked_out_by UUID;

ALTER TABLE payments.payments DROP CONSTRAINT IF EXISTS payments_booking_id_key;
ALTER TABLE payments.payments ADD COLUMN IF NOT EXISTS folio_id UUID;
ALTER TABLE payments.payments ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'card';
ALTER TABLE payments.payments ADD COLUMN IF NOT EXISTS received_by UUID;
ALTER TABLE payments.payments ADD COLUMN IF NOT EXISTS notes TEXT;
CREATE INDEX IF NOT EXISTS payments_booking ON payments.payments (booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_folio ON payments.payments (folio_id, created_at DESC);

CREATE SCHEMA IF NOT EXISTS operations;
CREATE TABLE IF NOT EXISTS operations.settings (
  id                 SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hotel_name         TEXT NOT NULL DEFAULT 'Luma Hotel & Residence',
  hotel_address      TEXT,
  phone              TEXT,
  email              TEXT,
  currency           CHAR(3) NOT NULL DEFAULT 'USD',
  time_zone          TEXT NOT NULL DEFAULT 'Asia/Bangkok',
  tax_rate           NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
  service_charge_rate NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (service_charge_rate >= 0),
  check_in_time      TIME NOT NULL DEFAULT '14:00',
  check_out_time     TIME NOT NULL DEFAULT '12:00',
  invoice_prefix     TEXT NOT NULL DEFAULT 'INV',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO operations.settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS operations.folios (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         UUID NOT NULL UNIQUE,
  guest_id           UUID NOT NULL,
  room_id            UUID NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  room_charge_cents  INTEGER NOT NULL CHECK (room_charge_cents >= 0),
  discount_cents     INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_cents          INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  service_charge_cents INTEGER NOT NULL DEFAULT 0 CHECK (service_charge_cents >= 0),
  total_cents        INTEGER NOT NULL CHECK (total_cents >= 0),
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS folios_guest ON operations.folios (guest_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS operations.folio_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folio_id    UUID NOT NULL REFERENCES operations.folios(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('room','extra_bed','service','minibar','laundry','other')),
  description TEXT NOT NULL,
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_cents  INTEGER NOT NULL CHECK (unit_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  added_by    UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS folio_items_folio ON operations.folio_items (folio_id, created_at);

CREATE TABLE IF NOT EXISTS operations.housekeeping_tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     UUID NOT NULL,
  booking_id  UUID,
  assigned_to UUID,
  status      TEXT NOT NULL DEFAULT 'dirty' CHECK (status IN ('dirty','cleaning','clean','inspected')),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  inspected_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS housekeeping_open ON operations.housekeeping_tasks (status, created_at DESC);

CREATE TABLE IF NOT EXISTS operations.audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID UNIQUE,
  actor_id    UUID,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  previous_value JSONB,
  new_value  JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_created ON operations.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_entity ON operations.audit_logs (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS operations.outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routing_key  TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS operations_outbox_pending
  ON operations.outbox (created_at) WHERE published_at IS NULL;
