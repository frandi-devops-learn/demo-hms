-- Guest reservations start pending and require explicit administrator approval.
ALTER TABLE bookings.bookings
  DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE bookings.bookings
  ALTER COLUMN status SET DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_by UUID;

ALTER TABLE bookings.bookings
  ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed'));
