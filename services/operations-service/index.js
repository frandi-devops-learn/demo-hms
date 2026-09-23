'use strict';
const express = require('express');
const fs = require('fs/promises');
const {
  ApiError, asyncHandler, createLogger, createPool, healthResponse, requestLogger, verifyToken, requireRole,
  requireUuid, parseDateOnly, startOutboxPublisher, startEventConsumer, errorHandler,
} = require('shared');

const PORT = process.env.PORT || 3007;
const logger = createLogger('operations-service');
const pool = createPool('operations');
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(requestLogger(logger));

const FRONT_DESK_ROLES = ['admin', 'manager', 'receptionist'];
const REPORT_ROLES = ['admin', 'manager', 'accountant'];
const HOTEL_ROLES = ['admin', 'manager', 'receptionist', 'housekeeper', 'accountant', 'staff'];

const cents = (value, field) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ApiError(400, `${field} must be a non-negative integer`);
  return parsed;
};

async function audit(client, actorId, action, entityType, entityId, previousValue, newValue) {
  await client.query(
    `INSERT INTO operations.audit_logs
       (actor_id, action, entity_type, entity_id, previous_value, new_value)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [actorId || null, action, entityType, String(entityId || ''),
      previousValue ? JSON.stringify(previousValue) : null,
      newValue ? JSON.stringify(newValue) : null]
  );
}

async function event(client, routingKey, payload) {
  await client.query(
    'INSERT INTO operations.outbox (routing_key, payload) VALUES ($1, $2::jsonb)',
    [routingKey, JSON.stringify(payload)]
  );
}

async function recalculateFolio(client, folioId) {
  const { rows } = await client.query(
    `WITH item_total AS (
       SELECT COALESCE(sum(total_cents), 0)::integer AS cents
       FROM operations.folio_items WHERE folio_id = $1
     )
     UPDATE operations.folios f
     SET total_cents = f.room_charge_cents + f.tax_cents + f.service_charge_cents
                       - f.discount_cents + item_total.cents
     FROM item_total WHERE f.id = $1 RETURNING f.*`,
    [folioId]
  );
  return rows[0];
}

async function folioView(folioId) {
  const { rows } = await pool.query('SELECT * FROM operations.folios WHERE id = $1', [folioId]);
  const folio = rows[0];
  if (!folio) throw new ApiError(404, 'Folio not found');
  const [{ rows: items }, { rows: payments }] = await Promise.all([
    pool.query('SELECT * FROM operations.folio_items WHERE folio_id = $1 ORDER BY created_at', [folioId]),
    pool.query(
      `SELECT id, booking_id, folio_id, amount_cents, currency, status, provider,
              provider_reference, payment_method, received_by, notes, paid_at, refunded_at, created_at
       FROM payments.payments WHERE folio_id = $1 OR booking_id = $2 ORDER BY created_at`,
      [folioId, folio.booking_id]
    ),
  ]);
  const paidCents = payments
    .filter((payment) => payment.status === 'paid')
    .reduce((sum, payment) => sum + payment.amount_cents, 0);
  return { ...folio, items, payments, paid_cents: paidCents, outstanding_cents: Math.max(0, folio.total_cents - paidCents) };
}

app.get('/health', (_req, res) => res.json(healthResponse('operations-service')));

app.get('/operations/dashboard', verifyToken, requireRole(...HOTEL_ROLES), asyncHandler(async (_req, res) => {
  const [rooms, bookings, revenue, housekeeping] = await Promise.all([
    pool.query(`SELECT count(*)::integer AS total,
      count(*) FILTER (WHERE operational_status = 'available')::integer AS available,
      count(*) FILTER (WHERE operational_status = 'occupied')::integer AS occupied,
      count(*) FILTER (WHERE operational_status = 'dirty')::integer AS dirty,
      count(*) FILTER (WHERE operational_status IN ('clean','inspected'))::integer AS clean,
      count(*) FILTER (WHERE operational_status IN ('out_of_service','out_of_order'))::integer AS out_of_order
      FROM rooms.rooms WHERE status = 'active'`),
    pool.query(`SELECT
      count(*) FILTER (WHERE check_in = CURRENT_DATE AND status = 'confirmed')::integer AS arrivals,
      count(*) FILTER (WHERE check_out = CURRENT_DATE AND status = 'checked_in')::integer AS departures,
      count(*) FILTER (WHERE status = 'checked_in')::integer AS current_guests,
      count(*) FILTER (WHERE created_at::date = CURRENT_DATE)::integer AS reservations_today,
      count(*) FILTER (WHERE status = 'cancelled' AND created_at::date = CURRENT_DATE)::integer AS cancellations_today,
      count(*) FILTER (WHERE status = 'no_show' AND check_in = CURRENT_DATE)::integer AS no_shows_today
      FROM bookings.bookings`),
    pool.query(`SELECT COALESCE(sum(amount_cents), 0)::integer AS revenue_cents
      FROM payments.payments WHERE status = 'paid' AND paid_at::date = CURRENT_DATE`),
    pool.query(`SELECT status, count(*)::integer AS count FROM operations.housekeeping_tasks
      WHERE status <> 'inspected' GROUP BY status ORDER BY status`),
  ]);
  const room = rooms.rows[0];
  const occupancyRate = room.total ? Number(((room.occupied / room.total) * 100).toFixed(1)) : 0;
  res.json({ ...room, ...bookings.rows[0], ...revenue.rows[0], occupancy_rate: occupancyRate, housekeeping: housekeeping.rows });
}));

app.post('/operations/bookings/:id/check-in', verifyToken, requireRole(...FRONT_DESK_ROLES), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'bookingId');
  const client = await pool.connect();
  let folio;
  try {
    await client.query('BEGIN');
    const { rows: bookingRows } = await client.query(
      'SELECT * FROM bookings.bookings WHERE id = $1 FOR UPDATE', [req.params.id]
    );
    const booking = bookingRows[0];
    if (!booking) throw new ApiError(404, 'Booking not found');
    if (booking.status !== 'confirmed') throw new ApiError(409, 'Only confirmed bookings can be checked in');
    if (new Date(`${booking.check_out.toISOString?.().slice(0, 10) || booking.check_out}T00:00:00Z`) <= new Date()) {
      throw new ApiError(409, 'This reservation has already passed its checkout date');
    }
    const { rows: guestRows } = await client.query(
      'SELECT id, email, first_name, last_name FROM users.profiles WHERE id = $1', [booking.guest_id]
    );
    const guest = guestRows[0];
    if (!guest?.email || !guest?.first_name || !guest?.last_name) {
      throw new ApiError(409, 'Guest first name, last name, and email are required before check-in');
    }
    const { rows: roomRows } = await client.query('SELECT * FROM rooms.rooms WHERE id = $1 FOR UPDATE', [booking.room_id]);
    const room = roomRows[0];
    if (!room || room.status !== 'active' || !['available', 'clean', 'inspected', 'reserved'].includes(room.operational_status)) {
      throw new ApiError(409, 'Assigned room is not ready for check-in');
    }
    const { rows: settingRows } = await client.query('SELECT * FROM operations.settings WHERE id = 1');
    const settings = settingRows[0];
    const taxCents = Math.round(booking.total_cents * Number(settings.tax_rate) / 100);
    const serviceCents = Math.round(booking.total_cents * Number(settings.service_charge_rate) / 100);
    const { rows: folioRows } = await client.query(
      `INSERT INTO operations.folios
         (booking_id, guest_id, room_id, room_charge_cents, tax_cents, service_charge_cents, total_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $4::integer + $5::integer + $6::integer)
       ON CONFLICT (booking_id) DO UPDATE SET booking_id = EXCLUDED.booking_id
       RETURNING *`,
      [booking.id, booking.guest_id, booking.room_id, booking.total_cents, taxCents, serviceCents]
    );
    folio = folioRows[0];
    await client.query('UPDATE payments.payments SET folio_id = $2 WHERE booking_id = $1', [booking.id, folio.id]);
    await client.query(
      `UPDATE bookings.bookings SET status = 'checked_in', checked_in_at = now(), checked_in_by = $2
       WHERE id = $1`, [booking.id, req.user.sub]
    );
    await client.query("UPDATE rooms.rooms SET operational_status = 'occupied' WHERE id = $1", [booking.room_id]);
    await audit(client, req.user.sub, 'reservation.checked_in', 'booking', booking.id, { status: booking.status }, { status: 'checked_in', folioId: folio.id });
    await event(client, 'operation.checked_in', {
      userId: booking.guest_id, bookingId: booking.id, roomId: booking.room_id,
      message: `Reservation ${booking.reservation_number} was checked in.`,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  res.json(await folioView(folio.id));
}));

app.post('/operations/bookings/:id/check-out', verifyToken, requireRole(...FRONT_DESK_ROLES), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'bookingId');
  const client = await pool.connect();
  let folioId;
  try {
    await client.query('BEGIN');
    const { rows: bookingRows } = await client.query('SELECT * FROM bookings.bookings WHERE id = $1 FOR UPDATE', [req.params.id]);
    const booking = bookingRows[0];
    if (!booking) throw new ApiError(404, 'Booking not found');
    if (booking.status !== 'checked_in') throw new ApiError(409, 'Only checked-in reservations can be checked out');
    const { rows: folioRows } = await client.query('SELECT * FROM operations.folios WHERE booking_id = $1 FOR UPDATE', [booking.id]);
    let folio = folioRows[0];
    if (!folio) throw new ApiError(409, 'The reservation does not have a folio');
    folio = await recalculateFolio(client, folio.id);
    const { rows: paymentRows } = await client.query(
      `SELECT COALESCE(sum(amount_cents) FILTER (WHERE status = 'paid'), 0)::integer AS paid
       FROM payments.payments WHERE booking_id = $1`, [booking.id]
    );
    const outstanding = folio.total_cents - paymentRows[0].paid;
    if (outstanding > 0) throw new ApiError(409, `Outstanding balance must be paid before checkout (${outstanding} cents)`);
    await client.query(
      `UPDATE bookings.bookings SET status = 'checked_out', checked_out_at = now(), checked_out_by = $2
       WHERE id = $1`, [booking.id, req.user.sub]
    );
    await client.query("UPDATE rooms.rooms SET operational_status = 'dirty' WHERE id = $1", [booking.room_id]);
    await client.query("UPDATE operations.folios SET status = 'closed', closed_at = now() WHERE id = $1", [folio.id]);
    await client.query(
      `INSERT INTO operations.housekeeping_tasks (room_id, booking_id, status)
       VALUES ($1, $2, 'dirty')`, [booking.room_id, booking.id]
    );
    await audit(client, req.user.sub, 'reservation.checked_out', 'booking', booking.id, { status: booking.status }, { status: 'checked_out', folioId: folio.id });
    await event(client, 'operation.checked_out', {
      userId: booking.guest_id, bookingId: booking.id, roomId: booking.room_id,
      message: `Reservation ${booking.reservation_number} was checked out. The room now requires cleaning.`,
    });
    await client.query('COMMIT');
    folioId = folio.id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  res.json({ invoice: await folioView(folioId) });
}));

app.get('/operations/folios', verifyToken, requireRole('admin', 'manager', 'receptionist', 'accountant'), asyncHandler(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM operations.folios ORDER BY opened_at DESC LIMIT 200');
  res.json(rows);
}));

app.get('/operations/folios/booking/:bookingId', verifyToken, requireRole('admin', 'manager', 'receptionist', 'accountant'), asyncHandler(async (req, res) => {
  requireUuid(req.params.bookingId, 'bookingId');
  const { rows } = await pool.query('SELECT id FROM operations.folios WHERE booking_id = $1', [req.params.bookingId]);
  if (!rows[0]) throw new ApiError(404, 'Folio not found');
  res.json(await folioView(rows[0].id));
}));

app.get('/operations/folios/:id/invoice', verifyToken, requireRole('admin', 'manager', 'receptionist', 'accountant'), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'folioId');
  const folio = await folioView(req.params.id);
  const { rows: [settings] } = await pool.query('SELECT * FROM operations.settings WHERE id = 1');
  const { rows: [guest] } = await pool.query('SELECT * FROM users.profiles WHERE id = $1', [folio.guest_id]);
  const { rows: [booking] } = await pool.query('SELECT * FROM bookings.bookings WHERE id = $1', [folio.booking_id]);
  res.json({
    invoice_number: `${settings.invoice_prefix}-${booking.reservation_number}`,
    issued_at: new Date().toISOString(), settings, guest, booking, ...folio,
  });
}));

app.post('/operations/folios/:id/items', verifyToken, requireRole(...FRONT_DESK_ROLES), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'folioId');
  const { type = 'other', description, quantity = 1, unitCents } = req.body;
  if (!['extra_bed', 'service', 'minibar', 'laundry', 'other'].includes(type)) throw new ApiError(400, 'Invalid charge type');
  if (typeof description !== 'string' || !description.trim()) throw new ApiError(400, 'description is required');
  const qty = cents(quantity, 'quantity');
  if (qty < 1) throw new ApiError(400, 'quantity must be at least 1');
  const unit = cents(unitCents, 'unitCents');
  const client = await pool.connect();
  let item;
  try {
    await client.query('BEGIN');
    const { rows: [folio] } = await client.query('SELECT * FROM operations.folios WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!folio) throw new ApiError(404, 'Folio not found');
    if (folio.status !== 'open') throw new ApiError(409, 'Closed folios cannot be modified');
    ({ rows: [item] } = await client.query(
      `INSERT INTO operations.folio_items
         (folio_id, type, description, quantity, unit_cents, total_cents, added_by)
       VALUES ($1, $2, $3, $4, $5, $4::integer * $5::integer, $6) RETURNING *`,
      [folio.id, type, description.trim(), qty, unit, req.user.sub]
    ));
    const updated = await recalculateFolio(client, folio.id);
    await audit(client, req.user.sub, 'folio.charge_added', 'folio', folio.id, null, item);
    await event(client, 'operation.charge_added', {
      userId: folio.guest_id, bookingId: folio.booking_id, folioId: folio.id,
      message: `${description.trim()} was added to your hotel folio.`,
    });
    await client.query('COMMIT');
    res.status(201).json({ item, folio: updated });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/operations/housekeeping', verifyToken, requireRole('admin', 'manager', 'receptionist', 'housekeeper'), asyncHandler(async (req, res) => {
  const ownOnly = req.user.role === 'housekeeper';
  const { rows } = await pool.query(
    `SELECT h.*, r.room_number, r.floor, r.building, r.operational_status
     FROM operations.housekeeping_tasks h JOIN rooms.rooms r ON r.id = h.room_id
     WHERE (NOT $1::boolean OR h.assigned_to = $2) AND h.status <> 'inspected'
     ORDER BY h.created_at DESC`,
    [ownOnly, req.user.sub]
  );
  res.json(rows);
}));

app.patch('/operations/housekeeping/:id', verifyToken, requireRole('admin', 'manager', 'housekeeper'), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'taskId');
  const { status, assignedTo, notes } = req.body;
  if (status && !['dirty', 'cleaning', 'clean', 'inspected'].includes(status)) throw new ApiError(400, 'Invalid housekeeping status');
  if (assignedTo != null) requireUuid(assignedTo, 'assignedTo');
  const client = await pool.connect();
  let task;
  try {
    await client.query('BEGIN');
    const { rows: [previous] } = await client.query('SELECT * FROM operations.housekeeping_tasks WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!previous) throw new ApiError(404, 'Housekeeping task not found');
    if (req.user.role === 'housekeeper' && previous.assigned_to !== req.user.sub) throw new ApiError(403, 'This room is not assigned to you');
    if (req.user.role === 'housekeeper' && status === 'inspected') throw new ApiError(403, 'A manager must inspect cleaned rooms');
    ({ rows: [task] } = await client.query(
      `UPDATE operations.housekeeping_tasks SET
         assigned_to = COALESCE($2, assigned_to), status = COALESCE($3, status), notes = COALESCE($4, notes),
         started_at = CASE WHEN $3 = 'cleaning' THEN COALESCE(started_at, now()) ELSE started_at END,
         completed_at = CASE WHEN $3 = 'clean' THEN COALESCE(completed_at, now()) ELSE completed_at END,
         inspected_at = CASE WHEN $3 = 'inspected' THEN COALESCE(inspected_at, now()) ELSE inspected_at END
       WHERE id = $1 RETURNING *`,
      [req.params.id, assignedTo ?? null, status ?? null, notes ?? null]
    ));
    if (status) {
      const roomStatus = status === 'inspected' ? 'available' : status;
      await client.query('UPDATE rooms.rooms SET operational_status = $2 WHERE id = $1', [task.room_id, roomStatus]);
    }
    await audit(client, req.user.sub, 'housekeeping.updated', 'housekeeping_task', task.id, previous, task);
    if (status) await event(client, `operation.housekeeping.${status}`, {
      userId: task.assigned_to || req.user.sub, roomId: task.room_id, taskId: task.id,
      message: `Housekeeping status changed to ${status}.`,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  res.json(task);
}));

app.get('/operations/reports/summary', verifyToken, requireRole(...REPORT_ROLES), asyncHandler(async (req, res) => {
  const from = parseDateOnly(req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), 'from');
  const to = parseDateOnly(req.query.to || new Date().toISOString().slice(0, 10), 'to');
  if (to < from) throw new ApiError(400, 'to must be on or after from');
  const params = [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
  const [roomRows, reservationRows, revenueRows, guestRows, housekeepingRows] = await Promise.all([
    pool.query(`SELECT count(*)::integer AS total_rooms,
      count(*) FILTER (WHERE operational_status = 'occupied')::integer AS occupied_rooms,
      count(*) FILTER (WHERE operational_status = 'available')::integer AS available_rooms,
      count(*) FILTER (WHERE operational_status IN ('out_of_order','out_of_service'))::integer AS out_of_order_rooms
      FROM rooms.rooms WHERE status = 'active'`),
    pool.query(`SELECT count(*)::integer AS total_reservations,
      count(*) FILTER (WHERE status = 'confirmed')::integer AS confirmed,
      count(*) FILTER (WHERE status = 'checked_in')::integer AS checked_in,
      count(*) FILTER (WHERE status = 'checked_out')::integer AS checked_out,
      count(*) FILTER (WHERE status = 'cancelled')::integer AS cancelled,
      count(*) FILTER (WHERE status = 'no_show')::integer AS no_show
      FROM bookings.bookings WHERE created_at::date BETWEEN $1 AND $2`, params),
    pool.query(`SELECT COALESCE(sum(amount_cents) FILTER (WHERE status = 'paid'), 0)::integer AS payments_received_cents,
      COALESCE(sum(amount_cents) FILTER (WHERE status = 'refunded'), 0)::integer AS refunded_cents
      FROM payments.payments WHERE created_at::date BETWEEN $1 AND $2`, params),
    pool.query(`SELECT count(*)::integer AS total_guests,
      count(*) FILTER (WHERE created_at::date BETWEEN $1 AND $2)::integer AS new_guests
      FROM users.profiles`, params),
    pool.query(`SELECT status, count(*)::integer AS count FROM operations.housekeeping_tasks
      WHERE created_at::date BETWEEN $1 AND $2 GROUP BY status`, params),
  ]);
  const rooms = roomRows.rows[0];
  res.json({
    from: params[0], to: params[1], occupancy: { ...rooms, occupancy_percentage: rooms.total_rooms ? Number((rooms.occupied_rooms / rooms.total_rooms * 100).toFixed(1)) : 0 },
    reservations: reservationRows.rows[0], revenue: revenueRows.rows[0], guests: guestRows.rows[0], housekeeping: housekeepingRows.rows,
  });
}));

app.get('/operations/settings', verifyToken, requireRole(...HOTEL_ROLES), asyncHandler(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM operations.settings WHERE id = 1');
  res.json(rows[0]);
}));

app.patch('/operations/settings', verifyToken, requireRole('admin'), asyncHandler(async (req, res) => {
  const fields = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [previous] } = await client.query('SELECT * FROM operations.settings WHERE id = 1 FOR UPDATE');
    const taxRate = fields.taxRate == null ? null : Number(fields.taxRate);
    const serviceRate = fields.serviceChargeRate == null ? null : Number(fields.serviceChargeRate);
    if (taxRate != null && (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100)) throw new ApiError(400, 'Invalid taxRate');
    if (serviceRate != null && (!Number.isFinite(serviceRate) || serviceRate < 0 || serviceRate > 100)) throw new ApiError(400, 'Invalid serviceChargeRate');
    const { rows: [settings] } = await client.query(
      `UPDATE operations.settings SET
        hotel_name = COALESCE($1, hotel_name), hotel_address = COALESCE($2, hotel_address),
        phone = COALESCE($3, phone), email = COALESCE($4, email), currency = COALESCE($5, currency),
        time_zone = COALESCE($6, time_zone), tax_rate = COALESCE($7, tax_rate),
        service_charge_rate = COALESCE($8, service_charge_rate),
        check_in_time = COALESCE($9, check_in_time), check_out_time = COALESCE($10, check_out_time),
        invoice_prefix = COALESCE($11, invoice_prefix), updated_at = now()
       WHERE id = 1 RETURNING *`,
      [fields.hotelName ?? null, fields.hotelAddress ?? null, fields.phone ?? null, fields.email ?? null,
        fields.currency?.toUpperCase() ?? null, fields.timeZone ?? null, taxRate, serviceRate,
        fields.checkInTime ?? null, fields.checkOutTime ?? null, fields.invoicePrefix ?? null]
    );
    await audit(client, req.user.sub, 'settings.updated', 'settings', 1, previous, settings);
    await client.query('COMMIT');
    res.json(settings);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/operations/audit-logs', verifyToken, requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const { rows } = await pool.query('SELECT * FROM operations.audit_logs ORDER BY created_at DESC LIMIT $1', [limit]);
  res.json(rows);
}));

app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
app.use(errorHandler(logger));

async function start() {
  const migration = await fs.readFile('/app/db/migrations/005_phase1_operations.sql', 'utf8');
  await pool.query(migration);
  await startEventConsumer({
    queue: 'operations.audit-events',
    bindings: ['booking.*', 'payment.*', 'auth.login.succeeded'],
    logger,
    onEvent: async (incoming, routingKey) => {
      requireUuid(incoming.id, 'eventId');
      await pool.query(
        `INSERT INTO operations.audit_logs (event_id, actor_id, action, entity_type, entity_id, new_value)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (event_id) DO NOTHING`,
        [incoming.id, incoming.actorId || incoming.userId || null, routingKey,
          routingKey.split('.')[0], incoming.bookingId || incoming.paymentId || incoming.userId || null,
          JSON.stringify(incoming)]
      );
    },
  });
  startOutboxPublisher({ pool, table: 'operations.outbox', logger });
  app.listen(PORT, () => logger.info(`operations-service listening on port ${PORT}`));
}

start().catch((error) => {
  logger.error('operations-service startup failed', { error: error.message });
  process.exit(1);
});
