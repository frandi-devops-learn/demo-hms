'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  ApiError, asyncHandler, createLogger, createPool, healthResponse, requestLogger, httpRequest,
  verifyToken, internalOnly, requireUuid, startOutboxPublisher, errorHandler,
} = require('shared');

const PORT = process.env.PORT || 3001;
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const ACCESS_TOKEN_EXPIRES_IN = Number(process.env.ACCESS_TOKEN_EXPIRES_IN || 900);
const REFRESH_TOKEN_DAYS = Number(process.env.REFRESH_TOKEN_DAYS || 30);
const RESET_TOKEN_MINUTES = Number(process.env.RESET_TOKEN_MINUTES || 30);
const logger = createLogger('auth-service');
const pool = createPool('auth');
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(requestLogger(logger));

app.get('/health', (_req, res) => res.json(healthResponse('auth-service')));

function signAccessToken(cred) {
  return jwt.sign(
    { sub: cred.id, email: cred.email, role: cred.role, tokenType: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

const opaqueToken = () => crypto.randomBytes(48).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new ApiError(400, 'password must be at least 8 characters');
  }
}

async function createRefreshToken(client, userId) {
  const refreshToken = opaqueToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86400000);
  const { rows } = await client.query(
    `INSERT INTO auth.refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3) RETURNING id`,
    [userId, hashToken(refreshToken), expiresAt]
  );
  return { id: rows[0].id, refreshToken, expiresAt };
}

function sessionResponse(cred, refresh) {
  const accessToken = signAccessToken(cred);
  return {
    token: accessToken,
    accessToken,
    accessTokenExpiresIn: ACCESS_TOKEN_EXPIRES_IN,
    refreshToken: refresh.refreshToken,
    refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
    user: { id: cred.id, email: cred.email, role: cred.role },
  };
}

app.post('/auth/register', asyncHandler(async (req, res) => {
  const { email, password, firstName, lastName, phone } = req.body;
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) throw new ApiError(400, 'email must be valid');
  validatePassword(password);

  const hash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  let cred;
  let profileCreated = false;
  let committed = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO auth.credentials (email, password_hash, role)
       VALUES ($1, $2, 'guest') RETURNING id, email, role`,
      [normalizedEmail, hash]
    );
    cred = rows[0];
    await httpRequest(process.env.USER_SERVICE_URL, {
      method: 'POST',
      path: '/internal/users',
      headers: { 'x-internal-key': process.env.INTERNAL_KEY },
      body: { id: cred.id, email: cred.email, firstName, lastName, phone, role: cred.role },
    });
    profileCreated = true;
    const refresh = await createRefreshToken(client, cred.id);
    await client.query('COMMIT');
    committed = true;
    res.status(201).json(sessionResponse(cred, refresh));
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    if (!committed && profileCreated && cred) {
      await httpRequest(process.env.USER_SERVICE_URL, {
        method: 'DELETE',
        path: `/internal/users/${cred.id}`,
        headers: { 'x-internal-key': process.env.INTERNAL_KEY },
      }).catch((cleanupErr) => logger.error('failed to compensate profile creation', {
        error: cleanupErr.message,
      }));
    }
    if (err.code === '23505') throw new ApiError(409, 'Email already registered');
    throw err;
  } finally {
    client.release();
  }
}));

app.post('/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query(
    'SELECT * FROM auth.credentials WHERE email = $1',
    [normalizeEmail(email)]
  );
  const cred = rows[0];
  if (!cred || !(await bcrypt.compare(String(password || ''), cred.password_hash))) {
    throw new ApiError(401, 'Invalid credentials');
  }
  if (!cred.active) throw new ApiError(403, 'Account is inactive');
  const refresh = await createRefreshToken(pool, cred.id);
  await pool.query(
    `INSERT INTO auth.outbox (routing_key, payload) VALUES ('auth.login.succeeded', $1::jsonb)`,
    [JSON.stringify({ userId: cred.id, actorId: cred.id, email: cred.email })]
  );
  res.json(sessionResponse(cred, refresh));
}));

app.post('/auth/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new ApiError(400, 'refreshToken is required');
  }
  const client = await pool.connect();
  let transactionDone = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT t.id AS token_id, t.user_id, t.expires_at, t.revoked_at,
              c.id, c.email, c.role, c.active
       FROM auth.refresh_tokens t
       JOIN auth.credentials c ON c.id = t.user_id
       WHERE t.token_hash = $1
       FOR UPDATE OF t`,
      [hashToken(refreshToken)]
    );
    const current = rows[0];
    if (!current) throw new ApiError(401, 'Invalid refresh token');
    if (!current.active) throw new ApiError(403, 'Account is inactive');
    if (current.revoked_at) {
      await client.query(
        'UPDATE auth.refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1',
        [current.user_id]
      );
      await client.query('COMMIT');
      transactionDone = true;
      throw new ApiError(401, 'Refresh token reuse detected; all sessions revoked');
    }
    if (new Date(current.expires_at) <= new Date()) {
      await client.query('UPDATE auth.refresh_tokens SET revoked_at = now() WHERE id = $1', [current.token_id]);
      await client.query('COMMIT');
      transactionDone = true;
      throw new ApiError(401, 'Refresh token expired');
    }
    const replacement = await createRefreshToken(client, current.user_id);
    await client.query(
      'UPDATE auth.refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1',
      [current.token_id, replacement.id]
    );
    await client.query('COMMIT');
    transactionDone = true;
    res.json(sessionResponse(current, replacement));
  } catch (err) {
    if (!transactionDone) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

app.post('/auth/logout', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new ApiError(400, 'refreshToken is required');
  }
  await pool.query(
    'UPDATE auth.refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE token_hash = $1',
    [hashToken(refreshToken)]
  );
  res.status(204).end();
}));

app.post('/auth/change-password', verifyToken, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  validatePassword(newPassword);
  const { rows } = await pool.query('SELECT password_hash FROM auth.credentials WHERE id = $1', [req.user.sub]);
  if (!rows[0] || !(await bcrypt.compare(String(currentPassword || ''), rows[0].password_hash))) {
    throw new ApiError(401, 'Current password is incorrect');
  }
  const passwordHash = await bcrypt.hash(newPassword, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE auth.credentials SET password_hash = $2 WHERE id = $1', [req.user.sub, passwordHash]);
    await client.query(
      'UPDATE auth.refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1',
      [req.user.sub]
    );
    await client.query(
      `INSERT INTO auth.outbox (routing_key, payload) VALUES ('auth.password_changed', $1::jsonb)`,
      [JSON.stringify({ userId: req.user.sub, actorId: req.user.sub, message: 'Your password was changed.' })]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  res.json({ message: 'Password changed. Sign in again on other devices.' });
}));

app.post('/auth/password-reset/request', asyncHandler(async (req, res) => {
  const response = { message: 'If that account exists, password reset instructions have been sent.' };
  const email = normalizeEmail(req.body.email);
  if (!validEmail(email)) return res.status(202).json(response);
  const { rows } = await pool.query('SELECT id, email FROM auth.credentials WHERE email = $1', [email]);
  const cred = rows[0];
  if (!cred) return res.status(202).json(response);

  const resetToken = opaqueToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_MINUTES * 60000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE auth.password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
      [cred.id]
    );
    await client.query(
      `INSERT INTO auth.password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [cred.id, hashToken(resetToken), expiresAt]
    );
    await client.query(
      `INSERT INTO auth.outbox (routing_key, payload)
       VALUES ('auth.password_reset.requested', $1::jsonb)`,
      [JSON.stringify({
        userId: cred.id,
        email: cred.email,
        resetToken,
        expiresAt: expiresAt.toISOString(),
        message: 'Password reset instructions were requested for your account.',
      })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (process.env.PASSWORD_RESET_EXPOSE_TOKEN === 'true') response.resetToken = resetToken;
  res.status(202).json(response);
}));

app.post('/auth/password-reset/confirm', asyncHandler(async (req, res) => {
  const { resetToken, newPassword } = req.body;
  if (typeof resetToken !== 'string' || !resetToken) throw new ApiError(400, 'resetToken is required');
  validatePassword(newPassword);
  const passwordHash = await bcrypt.hash(newPassword, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT t.id AS token_id, t.user_id, t.expires_at, t.used_at, c.email
       FROM auth.password_reset_tokens t
       JOIN auth.credentials c ON c.id = t.user_id
       WHERE t.token_hash = $1
       FOR UPDATE OF t`,
      [hashToken(resetToken)]
    );
    const reset = rows[0];
    if (!reset || reset.used_at || new Date(reset.expires_at) <= new Date()) {
      throw new ApiError(400, 'Invalid or expired password reset token');
    }
    await client.query('UPDATE auth.credentials SET password_hash = $2 WHERE id = $1', [reset.user_id, passwordHash]);
    await client.query('UPDATE auth.password_reset_tokens SET used_at = now() WHERE id = $1', [reset.token_id]);
    await client.query(
      'UPDATE auth.refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1',
      [reset.user_id]
    );
    await client.query(
      `INSERT INTO auth.outbox (routing_key, payload)
       VALUES ('auth.password_reset.completed', $1::jsonb)`,
      [JSON.stringify({
        userId: reset.user_id,
        email: reset.email,
        message: 'Your account password was changed.',
      })]
    );
    await client.query('COMMIT');
    res.json({ message: 'Password reset successful. Sign in with your new password.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// Called by user-service when an admin changes a role
app.post('/internal/role', internalOnly, asyncHandler(async (req, res) => {
  const { userId, role } = req.body;
  requireUuid(userId, 'userId');
  if (!['guest', 'staff', 'admin', 'manager', 'receptionist', 'housekeeper', 'accountant'].includes(role)) {
    throw new ApiError(400, 'Invalid role');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE auth.credentials SET role = $2 WHERE id = $1 RETURNING id, email, role`,
      [userId, role]
    );
    if (!rows.length) throw new ApiError(404, 'User not found');
    await client.query(
      'UPDATE auth.refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1',
      [userId]
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

app.post('/internal/status', internalOnly, asyncHandler(async (req, res) => {
  const { userId, active } = req.body;
  requireUuid(userId, 'userId');
  if (typeof active !== 'boolean') throw new ApiError(400, 'active must be boolean');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE auth.credentials SET active = $2 WHERE id = $1 RETURNING id, email, role, active',
      [userId, active]
    );
    if (!rows[0]) throw new ApiError(404, 'User not found');
    if (!active) {
      await client.query(
        'UPDATE auth.refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1', [userId]
      );
    }
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

// Batch role lookup used by user-service when rendering staff/admin directories.
app.post('/internal/roles', internalOnly, asyncHandler(async (req, res) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length > 100) {
    throw new ApiError(400, 'userIds must be an array with at most 100 items');
  }
  userIds.forEach((id) => requireUuid(id, 'userId'));
  const { rows } = await pool.query(
    'SELECT id, role, active FROM auth.credentials WHERE id = ANY($1::uuid[])',
    [userIds]
  );
  res.json(rows);
}));

async function ensureAdmin() {
  let { rows } = await pool.query(
    `SELECT id, email, role FROM auth.credentials WHERE email = 'admin@hotel.com'`
  );
  if (!rows.length) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
    ({ rows } = await pool.query(
      `INSERT INTO auth.credentials (email, password_hash, role)
       VALUES ('admin@hotel.com', $1, 'admin') RETURNING id, email, role`,
      [hash]
    ));
    logger.info('Admin account created: admin@hotel.com');
  }
  const admin = rows[0];
  await httpRequest(process.env.USER_SERVICE_URL, {
    method: 'POST',
    path: '/internal/users',
    headers: { 'x-internal-key': process.env.INTERNAL_KEY },
    body: { id: admin.id, email: admin.email, firstName: 'Hotel', lastName: 'Administrator', role: 'admin' },
  });
}

app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
app.use(errorHandler(logger));

app.listen(PORT, async () => {
  try {
    await ensureAdmin();
    startOutboxPublisher({ pool, table: 'auth.outbox', logger });
    logger.info(`auth-service listening on port ${PORT}`);
  } catch (err) {
    logger.error('auth-service startup failed', { error: err.message });
    process.exit(1);
  }
});
