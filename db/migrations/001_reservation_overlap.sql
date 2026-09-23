-- Apply this once to an existing hotel database created before the overlap guard.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE rooms.reservations
  ADD CONSTRAINT reservations_no_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    daterange(check_in, check_out, '[)') WITH &&
  ) WHERE (status = 'active');
