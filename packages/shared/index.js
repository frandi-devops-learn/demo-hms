'use strict';
const crypto = require('crypto');
const { Pool } = require('pg');

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function createLogger(name) {
  const priorities = { debug: 10, info: 20, warn: 30, error: 40 };
  const configuredLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  const threshold = priorities[configuredLevel] || priorities.info;
  const sensitiveKeys = /password|secret|token|authorization|cookie|card|cvv/i;
  const redact = (value, depth = 0) => {
    if (depth > 5 || value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, sensitiveKeys.test(key) ? '[REDACTED]' : redact(item, depth + 1),
    ]));
  };
  const fmt = (level, msg, meta) => {
    if (priorities[level] < threshold) return;
    const output = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: name,
      msg,
      ...redact(meta || {}),
    });
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(output);
  };
  return {
    debug: (msg, meta) => fmt('debug', msg, meta),
    info: (msg, meta) => fmt('info', msg, meta),
    warn: (msg, meta) => fmt('warn', msg, meta),
    error: (msg, meta) => fmt('error', msg, meta),
  };
}

function healthResponse(service, extra = {}) {
  return {
    status: 'ok',
    service,
    version: process.env.SERVICE_VERSION || 'development',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function requestLogger(logger) {
  const slowRequestMs = Math.max(1, Number(process.env.SLOW_REQUEST_MS) || 1000);
  const logHealth = process.env.LOG_HEALTH_REQUESTS === 'true';
  const logClientIp = process.env.LOG_CLIENT_IP === 'true';
  return (req, res, next) => {
    const suppliedId = String(req.headers['x-request-id'] || '');
    const requestId = /^[a-zA-Z0-9._:-]{1,128}$/.test(suppliedId) ? suppliedId : crypto.randomUUID();
    const started = process.hrtime.bigint();
    req.requestId = requestId;
    req.headers['x-request-id'] = requestId;
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => {
      const path = String(req.originalUrl || req.url || '/').split('?')[0];
      if (!logHealth && path === '/health' && res.statusCode < 400) return;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const meta = {
        logType: 'access', requestId, method: req.method, path,
        statusCode: res.statusCode, durationMs: Number(durationMs.toFixed(2)),
        userId: req.user?.sub, role: req.user?.role,
        ...(logClientIp ? { clientIp: req.ip } : {}),
      };
      if (res.statusCode >= 500) logger.error('http request completed', meta);
      else if (res.statusCode >= 400 || durationMs >= slowRequestMs) logger.warn('http request completed', meta);
      else logger.info('http request completed', meta);
    });
    next();
  };
}

function createPool(schema) {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema},public`,
  });
}

function createRedisClient(logger) {
  const { createClient } = require('redis');
  const client = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
  client.on('error', (err) => logger.warn('redis error', { error: err.message }));
  return client;
}

function startOutboxPublisher({ pool, table, logger, intervalMs = 500 }) {
  const amqp = require('amqplib');
  const exchange = process.env.RABBITMQ_EXCHANGE || 'hotel.events';
  const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://hotel:hotel@rabbitmq:5672';
  let connection;
  let channel;
  let busy = false;

  async function getChannel() {
    if (channel) return channel;
    connection = await amqp.connect(rabbitUrl);
    connection.on('error', (err) => logger.warn('rabbitmq connection error', { error: err.message }));
    connection.on('close', () => {
      connection = undefined;
      channel = undefined;
      logger.warn('rabbitmq connection closed');
    });
    channel = await connection.createConfirmChannel();
    await channel.assertExchange(exchange, 'topic', { durable: true });
    return channel;
  }

  async function publishBatch() {
    if (busy) return;
    busy = true;
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, routing_key, payload, created_at
         FROM ${table}
         WHERE published_at IS NULL
         ORDER BY created_at
         LIMIT 25
         FOR UPDATE SKIP LOCKED`
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return;
      }
      const activeChannel = await getChannel();
      for (const event of rows) {
        const envelope = {
          id: event.id,
          type: event.routing_key,
          occurredAt: event.created_at,
          ...event.payload,
        };
        activeChannel.publish(exchange, event.routing_key, Buffer.from(JSON.stringify(envelope)), {
          contentType: 'application/json',
          deliveryMode: 2,
          messageId: event.id,
          timestamp: Date.now(),
        });
      }
      await activeChannel.waitForConfirms();
      await client.query(
        `UPDATE ${table} SET published_at = now() WHERE id = ANY($1::uuid[])`,
        [rows.map((event) => event.id)]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      logger.warn('outbox publish failed', { table, error: err.message });
    } finally {
      client?.release();
      busy = false;
    }
  }

  const timer = setInterval(publishBatch, intervalMs);
  publishBatch();
  return async () => {
    clearInterval(timer);
    await channel?.close().catch(() => {});
    await connection?.close().catch(() => {});
  };
}

async function startEventConsumer({ queue, bindings, logger, onEvent }) {
  const amqp = require('amqplib');
  const exchange = process.env.RABBITMQ_EXCHANGE || 'hotel.events';
  const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://hotel:hotel@rabbitmq:5672';
  const connection = await amqp.connect(rabbitUrl);
  connection.on('error', (err) => logger.warn('rabbitmq connection error', { error: err.message }));
  const channel = await connection.createChannel();
  const retryExchange = `${exchange}.retry`;
  const deadExchange = `${exchange}.dead`;
  const retryQueue = `${queue}.retry`;
  const deadQueue = `${queue}.dead`;
  await channel.assertExchange(exchange, 'topic', { durable: true });
  await channel.assertExchange(retryExchange, 'topic', { durable: true });
  await channel.assertExchange(deadExchange, 'topic', { durable: true });
  await channel.assertQueue(queue, { durable: true });
  await channel.assertQueue(retryQueue, {
    durable: true,
    arguments: {
      'x-message-ttl': 2000,
      'x-dead-letter-exchange': exchange,
    },
  });
  await channel.assertQueue(deadQueue, { durable: true });
  await channel.bindQueue(retryQueue, retryExchange, '#');
  await channel.bindQueue(deadQueue, deadExchange, '#');
  for (const binding of bindings) await channel.bindQueue(queue, exchange, binding);
  await channel.prefetch(10);
  await channel.consume(queue, async (message) => {
    if (!message) return;
    let event;
    try {
      event = JSON.parse(message.content.toString('utf8'));
    } catch (err) {
      logger.error('discarding malformed event', { error: err.message });
      channel.nack(message, false, false);
      return;
    }
    try {
      await onEvent(event, message.fields.routingKey);
      channel.ack(message);
    } catch (err) {
      logger.error('event processing failed', { eventId: event.id, error: err.message });
      const retryCount = Number(message.properties.headers?.['x-retry-count'] || 0);
      const targetExchange = retryCount < 5 ? retryExchange : deadExchange;
      channel.publish(targetExchange, message.fields.routingKey, message.content, {
        contentType: 'application/json',
        deliveryMode: 2,
        messageId: message.properties.messageId || event.id,
        headers: { ...message.properties.headers, 'x-retry-count': retryCount + 1 },
      });
      channel.ack(message);
      if (retryCount >= 5) {
        logger.error('event moved to dead-letter queue', { eventId: event.id, queue: deadQueue });
      }
    }
  });
  logger.info('event consumer ready', { queue, bindings });
  return async () => connection.close();
}

function verifyToken(req, _res, next) {
  const jwt = require('jsonwebtoken');
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new ApiError(401, 'Missing Authorization token'));
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new ApiError(401, 'Invalid or expired token'));
  }
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new ApiError(403, 'Insufficient permissions'));
    }
    next();
  };
}

function internalOnly(req, _res, next) {
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_KEY) {
    return next(new ApiError(403, 'Forbidden'));
  }
  next();
}

function parseDateOnly(value, field = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, `${field} must use YYYY-MM-DD format`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (isNaN(date) || date.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, `${field} must be a valid calendar date`);
  }
  return date;
}

function requireUuid(value, field = 'id') {
  if (typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, `${field} must be a valid UUID`);
  }
  return value;
}

async function httpResponse(baseUrl, {
  method = 'GET', path = '/', headers = {}, body, timeoutMs = 5000,
} = {}) {
  let res;
  try {
    const cleanHeaders = Object.fromEntries(
      Object.entries({ 'content-type': 'application/json', ...headers })
        .filter(([, value]) => value != null)
    );
    res = await fetch(baseUrl + path, {
      method,
      headers: cleanHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (['TimeoutError', 'AbortError'].includes(err.name)) {
      throw new ApiError(504, 'Upstream service timed out');
    }
    throw new ApiError(502, 'Upstream service unavailable');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data?.message || `Upstream error (${res.status})`);
  }
  return { status: res.status, data };
}

async function httpRequest(baseUrl, options = {}) {
  const { data } = await httpResponse(baseUrl, options);
  return data;
}

function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) logger.error(err.message, {
      logType: 'error', requestId: req.requestId, method: req.method,
      path: String(req.originalUrl || req.url || '/').split('?')[0], stack: err.stack,
    });
    const message = status >= 500 ? 'Internal server error' : (err.message || 'Request failed');
    res.status(status).json({ message });
  };
}

module.exports = {
  ApiError,
  asyncHandler,
  createLogger,
  healthResponse,
  requestLogger,
  createPool,
  createRedisClient,
  startOutboxPublisher,
  startEventConsumer,
  verifyToken,
  requireRole,
  internalOnly,
  parseDateOnly,
  requireUuid,
  httpRequest,
  httpResponse,
  errorHandler,
};
