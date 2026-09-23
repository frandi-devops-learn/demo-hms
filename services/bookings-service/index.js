'use strict';
const express = require('express');
const crypto = require('crypto');
const {
  ApiError, asyncHandler, createLogger, createPool, healthResponse, requestLogger, httpRequest,
  verifyToken, requireRole, internalOnly, parseDateOnly, requireUuid, startOutboxPublisher, errorHandler,
} = require('shared');

const PORT = process.env.PORT || 3004;
const logger = createLogger('bookings-service');
const pool = createPool('bookings');
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(requestLogger(logger));

const roomsHeaders = () => ({ 'x-internal-key': process.env.INTERNAL_KEY });
const ROOMS = () => process.env.ROOM_SERVICE_URL;

function validateDates(checkIn, checkOut) {
  const inDate = parseDateOnly(checkIn, 'checkIn');
  const outDate = parseDateOnly(checkOut, 'checkOut');
  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  if (inDate < today) throw new ApiError(400, 'checkIn cannot be in the past');
  if (outDate <= inDate) throw new ApiError(400, 'checkOut must be after checkIn');
  return Math.round((outDate - inDate) / 86400000); // nights
}

app.get('/health', (_req, res) => res.json(healthResponse('bookings-service')));

app.get('/internal/bookings/:id', internalOnly, asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'bookingId');
  const { rows } = await pool.query(
    'SELECT * FROM bookings.bookings WHERE id = $1', [req.params.id]
  );
  if (!rows[0]) throw new ApiError(404, 'Booking not found');
  res.json(rows[0]);
}));

app.post('/bookings', verifyToken, requireRole('guest'), asyncHandler(async (req, res) => {
  const {
    roomTypeId, checkIn, checkOut, adults = 1, children = 0,
    specialRequests, bookingSource = 'guest_portal', notes,
  } = req.body;
  if (!roomTypeId || !checkIn || !checkOut) {
    throw new ApiError(400, 'roomTypeId, checkIn and checkOut are required');
  }
  requireUuid(roomTypeId, 'roomTypeId');
  const nights = validateDates(checkIn, checkOut);
  if (!Number.isInteger(Number(adults)) || Number(adults) < 1) throw new ApiError(400, 'adults must be at least 1');
  if (!Number.isInteger(Number(children)) || Number(children) < 0) throw new ApiError(400, 'children cannot be negative');

  // Atomically allocate and hold a room, then persist the booking.
  const bookingId = crypto.randomUUID();
  const hold = await httpRequest(ROOMS(), {
    method: 'POST', path: '/internal/reservations', headers: roomsHeaders(),
    body: { bookingId, roomTypeId, checkIn, checkOut },
  });
  const room = hold.room;
  if (Number(adults) + Number(children) > room.capacity) {
    await httpRequest(ROOMS(), {
      method: 'DELETE', path: `/internal/reservations/${bookingId}`, headers: roomsHeaders(),
    }).catch(() => {});
    throw new ApiError(400, `Guest count exceeds room capacity (${room.capacity})`);
  }
  const totalCents = room.price_cents * nights;
  const reservationNumber = `RES-${bookingId.replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO bookings.bookings
         (id, guest_id, room_id, room_type_id, check_in, check_out, status, total_cents,
          reservation_number, adults, children, special_requests, booking_source, notes)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7,
               $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [bookingId, req.user.sub, room.id, roomTypeId, checkIn, checkOut, totalCents,
        reservationNumber, Number(adults), Number(children), specialRequests || null, bookingSource, notes || null]
    );
    await client.query(
      `INSERT INTO bookings.outbox (routing_key, payload) VALUES ('booking.requested', $1::jsonb)`,
      [JSON.stringify({
        userId: req.user.sub,
        bookingId,
        roomId: room.id,
        roomType: room.type_name,
        roomNumber: room.room_number,
        checkIn,
        checkOut,
        message: `Booking request ${bookingId} was submitted for ${room.type_name}, ${checkIn} to ${checkOut}. It is awaiting hotel approval.`,
      })]
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Compensation: release the room hold so the saga does not leak inventory
    await httpRequest(ROOMS(), {
      method: 'DELETE', path: `/internal/reservations/${bookingId}`, headers: roomsHeaders(),
    }).catch((e) => logger.error('failed to release room hold', { error: e.message }));
    throw err;
  } finally {
    client.release();
  }
}));

app.post('/bookings/:id/confirm', verifyToken, requireRole('admin'), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'bookingId');
  const client = await pool.connect();
  let booking;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE bookings.bookings
       SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [req.params.id, req.user.sub]
    );
    booking = rows[0];
    if (!booking) {
      const { rows: existing } = await client.query(
        'SELECT status FROM bookings.bookings WHERE id = $1', [req.params.id]
      );
      if (!existing[0]) throw new ApiError(404, 'Booking not found');
      throw new ApiError(409, `Only pending bookings can be confirmed (current status: ${existing[0].status})`);
    }
    await client.query(
      `INSERT INTO bookings.outbox (routing_key, payload) VALUES ('booking.confirmed', $1::jsonb)`,
      [JSON.stringify({
        userId: booking.guest_id,
        bookingId: booking.id,
        actorId: req.user.sub,
        roomId: booking.room_id,
        checkIn: booking.check_in,
        checkOut: booking.check_out,
        message: `Booking ${booking.id} has been confirmed by the hotel.`,
      })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json(booking);
}));

app.get('/bookings', verifyToken, asyncHandler(async (req, res) => {
  const isStaff = ['admin', 'staff', 'manager', 'receptionist'].includes(req.user.role);
  const { status } = req.query;
  const { rows } = isStaff
    ? await pool.query(
        `SELECT * FROM bookings.bookings
         WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC`,
        [status || null])
    : await pool.query(
        `SELECT * FROM bookings.bookings
         WHERE guest_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC`,
        [req.user.sub, status || null]);
  res.json(rows);
}));

app.get('/bookings/:id', verifyToken, asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'bookingId');
  const { rows } = await pool.query('SELECT * FROM bookings.bookings WHERE id = $1', [req.params.id]);
  const booking = rows[0];
  if (!booking) throw new ApiError(404, 'Booking not found');
  const isOwner = booking.guest_id === req.user.sub;
  if (!isOwner && !['admin', 'staff', 'manager', 'receptionist'].includes(req.user.role)) {
    throw new ApiError(403, 'Insufficient permissions');
  }
  res.json(booking);
}));

app.post('/bookings/:id/cancel', verifyToken, asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'bookingId');
  const canManageAll = ['admin', 'staff', 'manager', 'receptionist'].includes(req.user.role);
  const client = await pool.connect();
  let booking;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE bookings.bookings SET status = 'cancelled'
       WHERE id = $1 AND status IN ('pending', 'confirmed')
         AND (guest_id = $2 OR $3::boolean)
       RETURNING *`,
      [req.params.id, req.user.sub, canManageAll]
    );
    booking = rows[0];
    if (!booking) {
      const { rows: existing } = await client.query(
        'SELECT guest_id, status FROM bookings.bookings WHERE id = $1', [req.params.id]
      );
      if (existing[0] && existing[0].guest_id !== req.user.sub && !canManageAll) {
        throw new ApiError(403, 'Insufficient permissions');
      }
      throw new ApiError(404, 'Booking not found or cannot be cancelled');
    }
    await client.query(
      `INSERT INTO bookings.outbox (routing_key, payload) VALUES ('booking.cancelled', $1::jsonb)`,
      [JSON.stringify({
        userId: booking.guest_id,
        bookingId: booking.id,
        roomId: booking.room_id,
        message: `Booking ${booking.id} has been cancelled.`,
      })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json(booking);
}));

app.post('/bookings/:id/no-show', verifyToken, requireRole('admin', 'manager', 'receptionist'), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'bookingId');
  const client = await pool.connect();
  let booking;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE bookings.bookings SET status = 'no_show'
       WHERE id = $1 AND status = 'confirmed' AND check_in <= CURRENT_DATE
       RETURNING *`, [req.params.id]
    );
    booking = rows[0];
    if (!booking) throw new ApiError(409, 'Only due confirmed reservations can be marked no-show');
    await client.query(
      `INSERT INTO bookings.outbox (routing_key, payload) VALUES ('booking.no_show', $1::jsonb)`,
      [JSON.stringify({
        userId: booking.guest_id, actorId: req.user.sub, bookingId: booking.id, roomId: booking.room_id,
        message: `Reservation ${booking.reservation_number} was marked as no-show.`,
      })]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  res.json(booking);
}));

app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
app.use(errorHandler(logger));

app.listen(PORT, () => {
  startOutboxPublisher({ pool, table: 'bookings.outbox', logger });
  logger.info(`bookings-service listening on port ${PORT}`);
});
