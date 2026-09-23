'use strict';
const express = require('express');
const crypto = require('crypto');
const {
  ApiError, asyncHandler, createLogger, createPool, healthResponse, requestLogger, httpRequest,
  verifyToken, requireRole, requireUuid, startOutboxPublisher,
  startEventConsumer, errorHandler,
} = require('shared');

const PORT = process.env.PORT || 3006;
const PROVIDER = process.env.PAYMENT_PROVIDER || 'mock';
const CURRENCY = (process.env.PAYMENT_CURRENCY || 'USD').toUpperCase();
const logger = createLogger('payment-service');
const pool = createPool('payments');
const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(requestLogger(logger));

const bookingHeaders = () => ({ 'x-internal-key': process.env.INTERNAL_KEY });
const BOOKINGS = () => process.env.BOOKING_SERVICE_URL;

function publicPayment(row) {
  if (!row) return row;
  const { failure_code: _failureCode, ...payment } = row;
  return payment;
}

async function ensureSchema() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS payments;
    CREATE TABLE IF NOT EXISTS payments.payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL UNIQUE,
      guest_id UUID NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      currency CHAR(3) NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','paid','failed','refunded')),
      provider TEXT NOT NULL,
      provider_reference TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      failure_code TEXT,
      paid_at TIMESTAMPTZ,
      refunded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS payments_guest
      ON payments.payments (guest_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS payments.outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      routing_key TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS payments_outbox_pending
      ON payments.outbox (created_at) WHERE published_at IS NULL;
    ALTER TABLE payments.payments DROP CONSTRAINT IF EXISTS payments_booking_id_key;
    ALTER TABLE payments.payments ADD COLUMN IF NOT EXISTS folio_id UUID;
    ALTER TABLE payments.payments ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'card';
    ALTER TABLE payments.payments ADD COLUMN IF NOT EXISTS received_by UUID;
    ALTER TABLE payments.payments ADD COLUMN IF NOT EXISTS notes TEXT;
    CREATE INDEX IF NOT EXISTS payments_booking ON payments.payments (booking_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS payments_folio ON payments.payments (folio_id, created_at DESC);
  `);
}

async function bookingById(bookingId) {
  return httpRequest(BOOKINGS(), {
    path: `/internal/bookings/${bookingId}`,
    headers: bookingHeaders(),
  });
}

async function addEvent(client, routingKey, payment, message) {
  await client.query(
    `INSERT INTO payments.outbox (routing_key, payload) VALUES ($1, $2::jsonb)`,
    [routingKey, JSON.stringify({
      userId: payment.guest_id,
      bookingId: payment.booking_id,
      paymentId: payment.id,
      amountCents: payment.amount_cents,
      currency: payment.currency.trim(),
      message,
    })]
  );
}

async function refundBooking(bookingId, actorId = null, paymentId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query(
      `SELECT * FROM payments.payments
       WHERE booking_id = $1 AND ($2::uuid IS NULL OR id = $2)
       ORDER BY created_at FOR UPDATE`,
      [bookingId, paymentId]
    );
    const refundable = existingRows.filter((item) => item.status !== 'refunded');
    if (!refundable.length) {
      await client.query('COMMIT');
      return existingRows[0];
    }
    const updated = [];
    for (const existing of refundable) {
      const { rows: [payment] } = await client.query(
        `UPDATE payments.payments
         SET status = 'refunded', refunded_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [existing.id]
      );
      updated.push(payment);
      if (existing.status === 'paid') {
        await addEvent(client, 'payment.refunded', payment, `Payment for booking ${bookingId} was refunded.`);
      } else {
        await addEvent(client, 'payment.cancelled', payment, `Payment for booking ${bookingId} was cancelled before it was charged.`);
      }
      logger.info('payment closed after booking cancellation', {
        paymentId: payment.id, bookingId, previousStatus: existing.status, actorId,
      });
    }
    await client.query('COMMIT');
    return updated[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

app.get('/health', (_req, res) => res.json(healthResponse('payment-service', { provider: PROVIDER })));

app.post('/payments/intents', verifyToken, asyncHandler(async (req, res) => {
  const { bookingId } = req.body;
  requireUuid(bookingId, 'bookingId');
  const idempotencyKey = req.body.idempotencyKey || req.headers['idempotency-key'] || bookingId;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ApiError(400, 'idempotencyKey must contain 8 to 128 characters');
  }

  const booking = await bookingById(bookingId);
  if (booking.guest_id !== req.user.sub) throw new ApiError(403, 'Only the booking guest can pay');
  if (booking.status !== 'confirmed') {
    throw new ApiError(409, 'Only hotel-confirmed bookings can be paid');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [bookingId]);
    const { rows: existingRows } = await client.query(
      'SELECT * FROM payments.payments WHERE idempotency_key = $1 LIMIT 1',
      [idempotencyKey]
    );
    if (existingRows[0]) {
      const existing = existingRows[0];
      if (existing.booking_id !== bookingId || existing.guest_id !== req.user.sub) {
        throw new ApiError(409, 'Idempotency key is already in use');
      }
      await client.query('COMMIT');
      return res.json(publicPayment(existing));
    }

    const { rows } = await client.query(
      `INSERT INTO payments.payments
         (booking_id, guest_id, amount_cents, currency, provider, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [bookingId, req.user.sub, booking.total_cents, CURRENCY, PROVIDER, idempotencyKey]
    );
    const payment = rows[0];
    await addEvent(
      client,
      'payment.created',
      payment,
      `Payment was prepared for booking ${bookingId}.`
    );
    await client.query('COMMIT');
    res.status(201).json(publicPayment(payment));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/payments/:id/confirm', verifyToken, asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'paymentId');
  const { paymentMethodToken } = req.body;
  if (typeof paymentMethodToken !== 'string' || !/^pm_[a-z0-9_-]{3,80}$/i.test(paymentMethodToken)) {
    throw new ApiError(400, 'A valid provider paymentMethodToken is required');
  }
  if (PROVIDER !== 'mock') throw new ApiError(503, 'Configured payment provider is not available');

  const client = await pool.connect();
  let payment;
  let declined = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT * FROM payments.payments WHERE id = $1 FOR UPDATE', [req.params.id]
    );
    payment = rows[0];
    if (!payment) throw new ApiError(404, 'Payment not found');
    if (payment.guest_id !== req.user.sub) throw new ApiError(403, 'Insufficient permissions');
    if (payment.status === 'paid') {
      await client.query('COMMIT');
      return res.json(publicPayment(payment));
    }
    if (payment.status === 'refunded') throw new ApiError(409, 'Refunded payments cannot be charged again');

    const booking = await bookingById(payment.booking_id);
    if (booking.status !== 'confirmed') {
      throw new ApiError(409, 'The booking is no longer eligible for payment');
    }

    declined = paymentMethodToken === 'pm_declined';
    if (declined) {
      ({ rows: [payment] } = await client.query(
        `UPDATE payments.payments
         SET status = 'failed', failure_code = 'card_declined', updated_at = now()
         WHERE id = $1 RETURNING *`,
        [req.params.id]
      ));
      await addEvent(client, 'payment.failed', payment, `Payment for booking ${payment.booking_id} was declined.`);
    } else {
      ({ rows: [payment] } = await client.query(
        `UPDATE payments.payments
         SET status = 'paid', provider_reference = $2, failure_code = NULL,
             paid_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [req.params.id, `mock_${crypto.randomUUID()}`]
      ));
      await addEvent(client, 'payment.succeeded', payment, `Payment for booking ${payment.booking_id} succeeded.`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (declined) throw new ApiError(402, 'Payment was declined');
  res.json(publicPayment(payment));
}));

app.post('/payments/manual', verifyToken, requireRole('admin', 'manager', 'receptionist', 'accountant'), asyncHandler(async (req, res) => {
  const { folioId, amountCents, method = 'cash', referenceNumber, notes } = req.body;
  requireUuid(folioId, 'folioId');
  const amount = Number(amountCents);
  if (!Number.isInteger(amount) || amount <= 0) throw new ApiError(400, 'amountCents must be a positive integer');
  if (!['cash', 'card', 'bank_transfer', 'other'].includes(method)) throw new ApiError(400, 'Invalid payment method');

  const client = await pool.connect();
  let payment;
  try {
    await client.query('BEGIN');
    const { rows: [folio] } = await client.query(
      'SELECT * FROM operations.folios WHERE id = $1 FOR UPDATE', [folioId]
    );
    if (!folio) throw new ApiError(404, 'Folio not found');
    if (folio.status !== 'open') throw new ApiError(409, 'Closed folios cannot receive payments');
    const { rows: [totals] } = await client.query(
      `SELECT COALESCE(sum(amount_cents) FILTER (WHERE status = 'paid'), 0)::integer AS paid
       FROM payments.payments WHERE folio_id = $1 OR booking_id = $2`,
      [folio.id, folio.booking_id]
    );
    const outstanding = folio.total_cents - totals.paid;
    if (amount > outstanding) throw new ApiError(409, `Payment exceeds outstanding balance (${outstanding} cents)`);
    ({ rows: [payment] } = await client.query(
      `INSERT INTO payments.payments
         (booking_id, folio_id, guest_id, amount_cents, currency, status, provider,
          provider_reference, idempotency_key, payment_method, received_by, notes, paid_at)
       VALUES ($1, $2, $3, $4, $5, 'paid', 'manual', $6, $7, $8, $9, $10, now())
       RETURNING *`,
      [folio.booking_id, folio.id, folio.guest_id, amount, CURRENCY,
        referenceNumber || null, `manual_${crypto.randomUUID()}`, method, req.user.sub, notes || null]
    ));
    await addEvent(client, 'payment.succeeded', payment, `A ${method.replace('_', ' ')} payment was added to your hotel folio.`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  res.status(201).json(publicPayment(payment));
}));

app.get('/payments', verifyToken, asyncHandler(async (req, res) => {
  if (['staff', 'receptionist', 'housekeeper'].includes(req.user.role)) {
    throw new ApiError(403, 'Payment ledger is restricted to financial roles');
  }
  const { rows } = ['admin', 'manager', 'accountant'].includes(req.user.role)
    ? await pool.query('SELECT * FROM payments.payments ORDER BY created_at DESC LIMIT 200')
    : await pool.query(
        'SELECT * FROM payments.payments WHERE guest_id = $1 ORDER BY created_at DESC',
        [req.user.sub]
      );
  res.json(rows.map(publicPayment));
}));

app.get('/payments/:id', verifyToken, asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'paymentId');
  const { rows } = await pool.query('SELECT * FROM payments.payments WHERE id = $1', [req.params.id]);
  const payment = rows[0];
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.guest_id !== req.user.sub && !['admin', 'manager', 'accountant'].includes(req.user.role)) {
    throw new ApiError(403, 'Insufficient permissions');
  }
  res.json(publicPayment(payment));
}));

app.post('/payments/:id/refund', verifyToken, requireRole('admin', 'manager', 'accountant'), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'paymentId');
  const { rows } = await pool.query('SELECT booking_id, status FROM payments.payments WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw new ApiError(404, 'Payment not found');
  if (rows[0].status !== 'paid') throw new ApiError(409, 'Only paid payments can be refunded');
  const payment = await refundBooking(rows[0].booking_id, req.user.sub, req.params.id);
  res.json(publicPayment(payment));
}));

app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
app.use(errorHandler(logger));

async function start() {
  if (!/^[A-Z]{3}$/.test(CURRENCY)) throw new Error('PAYMENT_CURRENCY must be a three-letter code');
  await ensureSchema();
  await startEventConsumer({
    queue: 'payments.booking-events',
    bindings: ['booking.cancelled'],
    logger,
    onEvent: async (event) => {
      requireUuid(event.id, 'eventId');
      requireUuid(event.bookingId, 'bookingId');
      await refundBooking(event.bookingId, 'booking.cancelled');
    },
  });
  startOutboxPublisher({ pool, table: 'payments.outbox', logger });
  app.listen(PORT, () => logger.info(`payment-service listening on port ${PORT}`, { provider: PROVIDER }));
}

start().catch((error) => {
  logger.error('payment-service startup failed', { error: error.message });
  process.exit(1);
});
