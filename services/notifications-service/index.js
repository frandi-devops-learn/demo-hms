'use strict';
const express = require('express');
const {
  ApiError, asyncHandler, createLogger, createPool, healthResponse, requestLogger,
  verifyToken, requireRole, internalOnly, requireUuid, errorHandler,
  startEventConsumer,
} = require('shared');

const PORT = process.env.PORT || 3005;
const logger = createLogger('notifications-service');
const pool = createPool('notifications');
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(requestLogger(logger));

app.get('/health', (_req, res) => res.json(healthResponse('notifications-service')));

// Internal: other services push notifications here
app.post('/internal/notifications', internalOnly, asyncHandler(async (req, res) => {
  const { userId, type, message } = req.body;
  if (!userId || !message) throw new ApiError(400, 'userId and message are required');
  requireUuid(userId, 'userId');
  const { rows } = await pool.query(
    `INSERT INTO notifications.notifications (user_id, type, message)
     VALUES ($1, $2, $3) RETURNING *`,
    [userId, type || 'info', message]
  );
  logger.info('notification stored', { userId, type: rows[0].type });
  // Integration point: plug in email/SMS/push providers here
  res.status(201).json(rows[0]);
}));

app.get('/notifications/me', verifyToken, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM notifications.notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.user.sub]
  );
  res.json(rows);
}));

app.post('/notifications/:id/read', verifyToken, asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'notificationId');
  const { rows } = await pool.query(
    `UPDATE notifications.notifications SET read = true
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [req.params.id, req.user.sub]
  );
  if (!rows.length) throw new ApiError(404, 'Notification not found');
  res.json(rows[0]);
}));

app.get('/notifications', verifyToken, requireRole('admin'), asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM notifications.notifications ORDER BY created_at DESC LIMIT 100'
  );
  res.json(rows);
}));

app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
app.use(errorHandler(logger));

async function start() {
  await startEventConsumer({
    queue: 'notifications.domain-events',
    bindings: ['booking.*', 'payment.*', 'operation.*', 'auth.password_reset.*', 'auth.password_changed'],
    logger,
    onEvent: async (event, routingKey) => {
      requireUuid(event.id, 'eventId');
      requireUuid(event.userId, 'userId');
      const notificationType = routingKey.replaceAll('.', '_');
      const safeMessages = {
        'auth.password_reset.requested': 'Password reset instructions were requested for your account.',
        'auth.password_reset.completed': 'Your account password was changed.',
      };
      const message = safeMessages[routingKey] || event.message;
      if (!message) throw new Error(`Event ${routingKey} does not contain a message`);
      const { rows } = await pool.query(
        `INSERT INTO notifications.notifications (event_id, user_id, type, message)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id`,
        [event.id, event.userId, notificationType, message]
      );
      if (rows.length) logger.info('notification stored from event', { eventId: event.id, routingKey });
      // Email/SMS providers can use the full event payload here without persisting secrets.
    },
  });
  app.listen(PORT, () => logger.info(`notifications-service listening on port ${PORT}`));
}

start().catch((err) => {
  logger.error('notifications-service startup failed', { error: err.message });
  process.exit(1);
});
