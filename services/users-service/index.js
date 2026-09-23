'use strict';
const express = require('express');
const {
  ApiError, asyncHandler, createLogger, createPool, healthResponse, requestLogger, httpRequest,
  verifyToken, requireRole, internalOnly, requireUuid, errorHandler,
} = require('shared');

const PORT = process.env.PORT || 3002;
const logger = createLogger('users-service');
const pool = createPool('users');
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(requestLogger(logger));

app.get('/health', (_req, res) => res.json(healthResponse('users-service')));

// Internal: profile creation, called by auth-service during registration
app.post('/internal/users', internalOnly, asyncHandler(async (req, res) => {
  const { id, email, firstName, lastName, phone, role } = req.body;
  if (!email) throw new ApiError(400, 'email is required');
  requireUuid(id, 'id');
  const { rows } = await pool.query(
    `INSERT INTO users.profiles (id, email, first_name, last_name, phone)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       first_name = COALESCE(EXCLUDED.first_name, users.profiles.first_name),
       last_name = COALESCE(EXCLUDED.last_name, users.profiles.last_name),
       phone = COALESCE(EXCLUDED.phone, users.profiles.phone)
     RETURNING id, email, first_name, last_name, phone`,
    [id, email, firstName || null, lastName || null, phone || null]
  );
  res.status(201).json({ ...rows[0], role: role || 'guest' });
}));

// Compensation endpoint used if registration cannot commit in auth-service.
app.delete('/internal/users/:id', internalOnly, asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'id');
  await pool.query('DELETE FROM users.profiles WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

app.get('/users/me', verifyToken, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, first_name, last_name, phone, date_of_birth, gender, nationality,
            address, id_type, id_number, notes, preferences
     FROM users.profiles WHERE id = $1`,
    [req.user.sub]
  );
  if (!rows.length) throw new ApiError(404, 'Profile not found');
  res.json({ ...rows[0], role: req.user.role });
}));

app.get('/users', verifyToken, requireRole('admin', 'staff', 'manager', 'receptionist'), asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim();
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const { rows } = await pool.query(
    `SELECT id, email, first_name, last_name, phone, date_of_birth, gender, nationality,
            address, id_type, id_number, notes, preferences, created_at
     FROM users.profiles
     WHERE ($1 = '' OR concat_ws(' ', first_name, last_name, email, phone, id::text) ILIKE '%' || $1 || '%')
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [query, limit, offset]
  );
  const roles = await httpRequest(process.env.AUTH_SERVICE_URL, {
    method: 'POST',
    path: '/internal/roles',
    headers: { 'x-internal-key': process.env.INTERNAL_KEY },
    body: { userIds: rows.map((user) => user.id) },
  });
  const rolesById = new Map(roles.map((item) => [item.id, item]));
  res.json(rows.map((user) => ({
    ...user,
    role: rolesById.get(user.id)?.role || 'guest',
    active: rolesById.get(user.id)?.active ?? true,
  })));
}));

app.get('/users/:id', verifyToken, requireRole('admin', 'staff', 'manager', 'receptionist'), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'id');
  const { rows } = await pool.query(
    `SELECT id, email, first_name, last_name, phone, date_of_birth, gender, nationality,
            address, id_type, id_number, notes, preferences FROM users.profiles WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length) throw new ApiError(404, 'User not found');
  res.json(rows[0]);
}));

// Admin can edit anyone; guests/staff can edit their own profile
app.patch('/users/:id', verifyToken, asyncHandler(async (req, res) => {
  const target = req.params.id;
  requireUuid(target, 'id');
  const isSelf = target === req.user.sub;
  if (!isSelf && !['admin', 'staff', 'manager', 'receptionist'].includes(req.user.role)) {
    throw new ApiError(403, 'Insufficient permissions');
  }
  const { firstName, lastName, phone, dateOfBirth, gender, nationality, address, idType, idNumber, notes, preferences } = req.body;
  const { rows } = await pool.query(
    `UPDATE users.profiles
     SET first_name = COALESCE($2, first_name),
         last_name  = COALESCE($3, last_name),
         phone      = COALESCE($4, phone),
         date_of_birth = COALESCE($5, date_of_birth), gender = COALESCE($6, gender),
         nationality = COALESCE($7, nationality), address = COALESCE($8, address),
         id_type = COALESCE($9, id_type), id_number = COALESCE($10, id_number),
         notes = COALESCE($11, notes), preferences = COALESCE($12::jsonb, preferences)
     WHERE id = $1
     RETURNING id, email, first_name, last_name, phone, date_of_birth, gender, nationality,
               address, id_type, id_number, notes, preferences`,
    [target, firstName ?? null, lastName ?? null, phone ?? null, dateOfBirth ?? null, gender ?? null,
      nationality ?? null, address ?? null, idType ?? null, idNumber ?? null, notes ?? null,
      preferences == null ? null : JSON.stringify(preferences)]
  );
  if (!rows.length) throw new ApiError(404, 'User not found');
  res.json(rows[0]);
}));

// Admin-only role change: update auth-service credentials (source of truth for roles)
app.patch('/users/:id/role', verifyToken, requireRole('admin'), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'id');
  const { role } = req.body;
  if (!['guest', 'staff', 'admin', 'manager', 'receptionist', 'housekeeper', 'accountant'].includes(role)) {
    throw new ApiError(400, 'Invalid role');
  }
  const result = await httpRequest(process.env.AUTH_SERVICE_URL, {
    method: 'POST',
    path: '/internal/role',
    headers: { 'x-internal-key': process.env.INTERNAL_KEY },
    body: { userId: req.params.id, role },
  });
  res.json(result);
}));

app.patch('/users/:id/status', verifyToken, requireRole('admin'), asyncHandler(async (req, res) => {
  requireUuid(req.params.id, 'id');
  if (req.params.id === req.user.sub && req.body.active === false) {
    throw new ApiError(400, 'Administrators cannot deactivate their own account');
  }
  const result = await httpRequest(process.env.AUTH_SERVICE_URL, {
    method: 'POST', path: '/internal/status',
    headers: { 'x-internal-key': process.env.INTERNAL_KEY },
    body: { userId: req.params.id, active: req.body.active },
  });
  res.json(result);
}));

app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
app.use(errorHandler(logger));

app.listen(PORT, () => logger.info(`users-service listening on port ${PORT}`));
