'use strict';
const express = require('express');
const {
  ApiError, asyncHandler, createLogger, createRedisClient, healthResponse, requestLogger,
  httpResponse, verifyToken, errorHandler,
} = require('shared');

const PORT = process.env.PORT || 3000;
const logger = createLogger('api-gateway');
const redis = createRedisClient(logger);
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(requestLogger(logger));

const targets = {
  auth: process.env.AUTH_SERVICE_URL,
  users: process.env.USER_SERVICE_URL,
  rooms: process.env.ROOM_SERVICE_URL,
  bookings: process.env.BOOKING_SERVICE_URL,
  payments: process.env.PAYMENT_SERVICE_URL,
  operations: process.env.OPERATIONS_SERVICE_URL,
  notifications: process.env.NOTIFICATION_SERVICE_URL,
};

// Reverse-proxy a mounted route while restoring the path expected by the service.
function route(mount, target, upstreamPrefix) {
  app.use(mount, asyncHandler(async (req, res) => {
    const { status, data } = await httpResponse(target, {
      method: req.method,
      path: upstreamPrefix + req.url,
      headers: { authorization: req.headers.authorization, 'x-request-id': req.requestId },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
    });
    if (status === 204) return res.status(204).end();
    res.status(status).json(data);
  }));
}

function publicGet(path, target, upstreamPath) {
  app.get(path, asyncHandler(async (req, res) => {
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const { status, data } = await httpResponse(target, {
      path: upstreamPath + query,
      headers: { 'x-request-id': req.requestId },
    });
    res.status(status).json(data);
  }));
}

function rateLimit(prefix, limit) {
  return asyncHandler(async (req, res, next) => {
    try {
      const windowId = Math.floor(Date.now() / 60000);
      const key = `rate:${prefix}:${req.ip}:${windowId}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 60);
      res.set('x-ratelimit-limit', String(limit));
      res.set('x-ratelimit-remaining', String(Math.max(0, limit - count)));
      if (count > limit) throw new ApiError(429, 'Too many requests; please try again shortly');
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.warn('rate limiting unavailable', { error: err.message });
    }
    next();
  });
}

app.get('/health', (_req, res) => res.json(healthResponse('api-gateway', { services: Object.keys(targets) })));

// Public: registration & login
app.use('/api/auth', rateLimit('auth', 30));
route('/api/auth', targets.auth, '/auth');

// Public catalogue endpoints. Mutating room endpoints remain protected below.
app.use('/api/rooms', rateLimit('catalog', 120));
publicGet('/api/rooms', targets.rooms, '/rooms');
publicGet('/api/rooms/room-types', targets.rooms, '/room-types');

// Everything below requires a valid JWT (verified here, re-verified by each service)
app.use('/api', verifyToken);
app.use('/api', rateLimit('api', 180));
route('/api/users', targets.users, '/users');
route('/api/rooms/room-types', targets.rooms, '/room-types');
route('/api/rooms', targets.rooms, '/rooms');
route('/api/bookings', targets.bookings, '/bookings');
route('/api/payments', targets.payments, '/payments');
route('/api/operations', targets.operations, '/operations');
route('/api/notifications', targets.notifications, '/notifications');

app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
app.use(errorHandler(logger));

redis.connect()
  .then(() => app.listen(PORT, () => logger.info(`api-gateway listening on port ${PORT}`)))
  .catch((err) => {
    logger.error('api-gateway startup failed', { error: err.message });
    process.exit(1);
  });
