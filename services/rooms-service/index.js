'use strict';
const express = require('express');
const {
  ApiError, asyncHandler, createLogger, createPool, healthResponse, requestLogger,
  verifyToken, requireRole, internalOnly, parseDateOnly, requireUuid, errorHandler,
  createRedisClient, startEventConsumer,
} = require('shared');

const PORT = process.env.PORT || 3003;
const logger = createLogger('rooms-service');
const pool = createPool('rooms');
const redis = createRedisClient(logger);
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(requestLogger(logger));

app.get('/health', (_req, res) => res.json(healthResponse('rooms-service')));

/* ---------- room types ---------- */
app.get('/room-types', asyncHandler(async (_req, res) => {
  const cached = await redis.get('rooms:room-types:v1').catch(() => null);
  if (cached) return res.json(JSON.parse(cached));
  const { rows } = await pool.query('SELECT * FROM rooms.room_types WHERE active = true ORDER BY price_cents');
  await redis.setEx('rooms:room-types:v1', 60, JSON.stringify(rows)).catch(() => {});
  res.json(rows);
}));

app.post('/room-types', verifyToken, requireRole('admin'), asyncHandler(async (req, res) => {
  const { name, description, priceCents, capacity, numberOfBeds = 1, bedType = 'Queen', amenities = [], images = [] } = req.body;
  if (!name || priceCents == null || capacity == null) {
    throw new ApiError(400, 'name, priceCents and capacity are required');
  }
  const { rows } = await pool.query(
    `INSERT INTO rooms.room_types
       (name, description, price_cents, capacity, number_of_beds, bed_type, amenities, images)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb) RETURNING *`,
    [name, description || null, priceCents, capacity, numberOfBeds, bedType,
      JSON.stringify(amenities), JSON.stringify(images)]
  );
  await redis.del('rooms:room-types:v1').catch(() => {});
  res.status(201).json(rows[0]);
}));

app.put('/room-types/:id', verifyToken, requireRole('admin'), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'roomTypeId');
  const { name, description, priceCents, capacity, numberOfBeds, bedType, amenities, images, active } = req.body;
  const { rows } = await pool.query(
    `UPDATE rooms.room_types
     SET name = COALESCE($2, name), description = COALESCE($3, description),
         price_cents = COALESCE($4, price_cents), capacity = COALESCE($5, capacity),
         number_of_beds = COALESCE($6, number_of_beds), bed_type = COALESCE($7, bed_type),
         amenities = COALESCE($8::jsonb, amenities), images = COALESCE($9::jsonb, images),
         active = COALESCE($10, active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, name ?? null, description ?? null, priceCents ?? null, capacity ?? null,
      numberOfBeds ?? null, bedType ?? null, amenities == null ? null : JSON.stringify(amenities),
      images == null ? null : JSON.stringify(images), active ?? null]
  );
  if (!rows.length) throw new ApiError(404, 'Room type not found');
  await redis.del('rooms:room-types:v1').catch(() => {});
  res.json(rows[0]);
}));

app.delete('/room-types/:id', verifyToken, requireRole('admin'), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'roomTypeId');
  const { rowCount } = await pool.query('DELETE FROM rooms.room_types WHERE id = $1', [req.params.id]);
  if (!rowCount) throw new ApiError(404, 'Room type not found');
  await redis.del('rooms:room-types:v1').catch(() => {});
  res.status(204).end();
}));

/* ---------- rooms ---------- */
app.get('/rooms', asyncHandler(async (req, res) => {
  const { status } = req.query;
  const { rows } = await pool.query(
    `SELECT r.*, t.name AS type_name, t.price_cents, t.capacity
     FROM rooms.rooms r JOIN rooms.room_types t ON t.id = r.type_id
     WHERE ($1::text IS NULL OR r.status = $1)
     ORDER BY r.room_number`,
    [status || null]
  );
  res.json(rows);
}));

app.post('/rooms', verifyToken, requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const { roomNumber, typeId, floor, building = 'Main', baseRateCents, description, amenities = [] } = req.body;
  if (!roomNumber || !typeId) throw new ApiError(400, 'roomNumber and typeId are required');
  requireUuid(typeId, 'typeId');
  const { rows } = await pool.query(
    `INSERT INTO rooms.rooms
       (room_number, type_id, floor, building, base_rate_cents, description, amenities)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
    [roomNumber, typeId, floor || 1, building, baseRateCents ?? null, description || null, JSON.stringify(amenities)]
  );
  res.status(201).json(rows[0]);
}));

app.patch('/rooms/:id', verifyToken, requireRole('admin', 'staff', 'manager', 'receptionist', 'housekeeper'), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'roomId');
  const { status, operationalStatus, floor, typeId, building, baseRateCents, description, amenities } = req.body;
  if (typeId != null) requireUuid(typeId, 'typeId');
  if (status && !['active', 'maintenance', 'inactive'].includes(status)) {
    throw new ApiError(400, 'Invalid status');
  }
  if (operationalStatus && !['available', 'reserved', 'occupied', 'dirty', 'cleaning', 'clean', 'inspected', 'out_of_service', 'out_of_order'].includes(operationalStatus)) {
    throw new ApiError(400, 'Invalid operationalStatus');
  }
  if (req.user.role === 'housekeeper' && !['dirty', 'cleaning', 'clean'].includes(operationalStatus)) {
    throw new ApiError(403, 'Housekeepers can only update cleaning states');
  }
  const { rows } = await pool.query(
    `UPDATE rooms.rooms
     SET status = COALESCE($2, status), operational_status = COALESCE($3, operational_status),
         floor = COALESCE($4, floor), type_id = COALESCE($5, type_id), building = COALESCE($6, building),
         base_rate_cents = COALESCE($7, base_rate_cents), description = COALESCE($8, description),
         amenities = COALESCE($9::jsonb, amenities)
     WHERE id = $1 RETURNING *`,
    [req.params.id, status ?? null, operationalStatus ?? null, floor ?? null, typeId ?? null,
      building ?? null, baseRateCents ?? null, description ?? null,
      amenities == null ? null : JSON.stringify(amenities)]
  );
  if (!rows.length) throw new ApiError(404, 'Room not found');
  res.json(rows[0]);
}));

/* ---------- availability (token OR internal key) ---------- */
const tokenOrInternal = (req, res, next) => {
  if (req.headers['x-internal-key'] === process.env.INTERNAL_KEY) return next();
  verifyToken(req, res, next);
};

app.get('/rooms/available', tokenOrInternal, asyncHandler(async (req, res) => {
  const { roomTypeId, checkIn, checkOut } = req.query;
  if (!roomTypeId || !checkIn || !checkOut) {
    throw new ApiError(400, 'roomTypeId, checkIn and checkOut are required');
  }
  requireUuid(roomTypeId, 'roomTypeId');
  const inDate = parseDateOnly(checkIn, 'checkIn');
  const outDate = parseDateOnly(checkOut, 'checkOut');
  if (outDate <= inDate) throw new ApiError(400, 'checkOut must be after checkIn');
  const { rows } = await pool.query(
    `SELECT r.id, r.room_number, r.floor, t.name AS type_name, t.price_cents, t.capacity
     FROM rooms.rooms r
     JOIN rooms.room_types t ON t.id = r.type_id
     WHERE r.type_id = $1 AND r.status = 'active'
       AND r.operational_status NOT IN ('out_of_service', 'out_of_order')
       AND NOT EXISTS (
         SELECT 1 FROM rooms.reservations v
         WHERE v.room_id = r.id AND v.status = 'active'
           AND v.check_in < $3::date AND v.check_out > $2::date
       )
     ORDER BY r.room_number
     LIMIT 1`,
    [roomTypeId, checkIn, checkOut]
  );
  if (!rows.length) throw new ApiError(409, 'No rooms available for the selected dates');
  res.json(rows[0]);
}));

/* ---------- reservations (internal only) ---------- */
app.post('/internal/reservations', internalOnly, asyncHandler(async (req, res) => {
  const { bookingId, roomTypeId, checkIn, checkOut } = req.body;
  if (!bookingId || !roomTypeId || !checkIn || !checkOut) {
    throw new ApiError(400, 'bookingId, roomTypeId, checkIn and checkOut are required');
  }
  requireUuid(bookingId, 'bookingId');
  requireUuid(roomTypeId, 'roomTypeId');
  const inDate = parseDateOnly(checkIn, 'checkIn');
  const outDate = parseDateOnly(checkOut, 'checkOut');
  if (outDate <= inDate) {
    throw new ApiError(400, 'checkOut must be after checkIn');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize allocation for a room type so concurrent requests choose different rooms.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [roomTypeId]);
    const { rows: rooms } = await client.query(
      `SELECT r.id, r.room_number, r.floor, t.id AS room_type_id,
              t.name AS type_name, t.price_cents, t.capacity
       FROM rooms.rooms r
       JOIN rooms.room_types t ON t.id = r.type_id
       WHERE r.type_id = $1 AND r.status = 'active'
         AND r.operational_status NOT IN ('out_of_service', 'out_of_order')
         AND NOT EXISTS (
           SELECT 1 FROM rooms.reservations v
           WHERE v.room_id = r.id AND v.status = 'active'
             AND v.check_in < $3::date AND v.check_out > $2::date
         )
       ORDER BY r.room_number
       LIMIT 1
       FOR UPDATE OF r`,
      [roomTypeId, checkIn, checkOut]
    );
    const room = rooms[0];
    if (!room) throw new ApiError(409, 'No rooms available for the selected dates');

    const { rows } = await client.query(
      `INSERT INTO rooms.reservations (booking_id, room_id, check_in, check_out)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [bookingId, room.id, checkIn, checkOut]
    );
    await client.query('COMMIT');
    res.status(201).json({ reservation: rows[0], room });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23P01') throw new ApiError(409, 'Room was just reserved; please retry');
    throw err;
  } finally {
    client.release();
  }
}));

app.delete('/internal/reservations/:bookingId', internalOnly, asyncHandler(async (req, res) => {
  requireUuid(req.params.bookingId, 'bookingId');
  const { rowCount } = await pool.query(
    `DELETE FROM rooms.reservations WHERE booking_id = $1`, [req.params.bookingId]
  );
  if (!rowCount) throw new ApiError(404, 'Reservation not found');
  res.status(204).end();
}));

app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
app.use(errorHandler(logger));

async function start() {
  await redis.connect();
  await startEventConsumer({
    queue: 'rooms.booking-events',
    bindings: ['booking.cancelled', 'booking.no_show'],
    logger,
    onEvent: async (event, routingKey) => {
      if (!['booking.cancelled', 'booking.no_show'].includes(routingKey)) return;
      requireUuid(event.bookingId, 'bookingId');
      await pool.query('DELETE FROM rooms.reservations WHERE booking_id = $1', [event.bookingId]);
      logger.info('reservation released from event', { bookingId: event.bookingId });
    },
  });
  app.listen(PORT, () => logger.info(`rooms-service listening on port ${PORT}`));
}

start().catch((err) => {
  logger.error('rooms-service startup failed', { error: err.message });
  process.exit(1);
});
