'use strict';

const baseUrl = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:3000';

async function request(path, { method = 'GET', token, body, expected = 200 } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    throw new Error(`${method} ${path}: expected ${allowed.join('/')}, got ${response.status}: ${JSON.stringify(data)}`);
  }
  return { status: response.status, data };
}

function dateOnly(daysFromNow) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

async function main() {
  await request('/health');
  const { data: roomTypes } = await request('/api/rooms/room-types');
  const standard = roomTypes.find((type) => type.name === 'Standard') || roomTypes[0];
  if (!standard) throw new Error('No room types are configured');

  const { data: rooms } = await request('/api/rooms?status=active');
  const availableRoomCount = rooms.filter((room) => room.type_id === standard.id).length;
  if (!availableRoomCount) throw new Error(`No active rooms exist for ${standard.name}`);

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const register = async (name) => request('/api/auth/register', {
    method: 'POST',
    expected: 201,
    body: {
      email: `smoke-${name}-${runId}@example.com`,
      password: 'smoke-test-password',
      firstName: name,
      lastName: 'SmokeTest',
    },
  });
  const [{ data: owner }, { data: stranger }] = await Promise.all([register('owner'), register('stranger')]);

  await request('/api/users/me', { token: owner.token });

  // Refresh tokens rotate; replaying an old token revokes the replacement chain.
  const { data: rotated } = await request('/api/auth/refresh', {
    method: 'POST', body: { refreshToken: owner.refreshToken },
  });
  await request('/api/auth/refresh', {
    method: 'POST', body: { refreshToken: owner.refreshToken }, expected: 401,
  });
  await request('/api/auth/refresh', {
    method: 'POST', body: { refreshToken: rotated.refreshToken }, expected: 401,
  });

  // Password reset is single-use, changes the password, and revokes existing refresh tokens.
  const strangerEmail = stranger.user.email;
  const { data: reset } = await request('/api/auth/password-reset/request', {
    method: 'POST', expected: 202, body: { email: strangerEmail },
  });
  if (!reset.resetToken) throw new Error('Development password reset did not expose a test token');
  await request('/api/auth/password-reset/confirm', {
    method: 'POST', body: { resetToken: reset.resetToken, newPassword: 'new-smoke-test-password' },
  });
  await request('/api/auth/password-reset/confirm', {
    method: 'POST', expected: 400,
    body: { resetToken: reset.resetToken, newPassword: 'another-smoke-password' },
  });
  await request('/api/auth/login', {
    method: 'POST', expected: 401,
    body: { email: strangerEmail, password: 'smoke-test-password' },
  });
  const { data: strangerSession } = await request('/api/auth/login', {
    method: 'POST', body: { email: strangerEmail, password: 'new-smoke-test-password' },
  });
  await request('/api/auth/refresh', {
    method: 'POST', expected: 401, body: { refreshToken: stranger.refreshToken },
  });

  const { data: adminSession } = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@hotel.com', password: process.env.ADMIN_PASSWORD || 'admin123' },
  });
  await request('/api/users/me', { token: adminSession.token });

  const checkIn = dateOnly(60);
  const checkOut = dateOnly(62);
  await request('/api/bookings', {
    method: 'POST', token: adminSession.token, expected: 403,
    body: { roomTypeId: standard.id, checkIn, checkOut },
  });
  const createBooking = () => request('/api/bookings', {
    method: 'POST',
    token: owner.token,
    expected: [201, 409],
    body: { roomTypeId: standard.id, checkIn, checkOut },
  });

  const attempts = await Promise.all(
    Array.from({ length: availableRoomCount + 1 }, () => createBooking())
  );
  const pendingBookings = attempts.filter((attempt) => attempt.status === 201).map((attempt) => attempt.data);
  const rejected = attempts.filter((attempt) => attempt.status === 409);
  if (pendingBookings.length !== availableRoomCount || rejected.length !== 1 || pendingBookings.some((booking) => booking.status !== 'pending')) {
    throw new Error(`Concurrent allocation mismatch: ${pendingBookings.length} pending, ${rejected.length} rejected`);
  }

  const protectedBooking = pendingBookings[0];
  await request(`/api/bookings/${protectedBooking.id}/cancel`, {
    method: 'POST', token: strangerSession.token, expected: 403,
  });
  const { data: stillPending } = await request(`/api/bookings/${protectedBooking.id}`, {
    token: owner.token,
  });
  if (stillPending.status !== 'pending') {
    throw new Error('Unauthorized cancellation changed the booking');
  }

  await request(`/api/bookings/${protectedBooking.id}/confirm`, {
    method: 'POST', token: owner.token, expected: 403,
  });
  await request(`/api/bookings/${protectedBooking.id}/confirm`, {
    method: 'POST', token: strangerSession.token, expected: 403,
  });
  const { data: approved } = await request(`/api/bookings/${protectedBooking.id}/confirm`, {
    method: 'POST', token: adminSession.token,
  });
  if (approved.status !== 'confirmed' || approved.confirmed_by !== adminSession.user.id) {
    throw new Error('Administrator confirmation was not recorded');
  }

  // Payment is allowed only for the booking guest after hotel confirmation.
  await request('/api/payments/intents', {
    method: 'POST', token: strangerSession.token, expected: 403,
    body: { bookingId: approved.id, idempotencyKey: approved.id },
  });
  const { data: paymentIntent } = await request('/api/payments/intents', {
    method: 'POST', token: owner.token, expected: 201,
    body: { bookingId: approved.id, idempotencyKey: approved.id },
  });
  const { data: repeatedIntent } = await request('/api/payments/intents', {
    method: 'POST', token: owner.token,
    body: { bookingId: approved.id, idempotencyKey: approved.id },
  });
  if (repeatedIntent.id !== paymentIntent.id) throw new Error('Payment intent was not idempotent');
  await request(`/api/payments/${paymentIntent.id}/confirm`, {
    method: 'POST', token: strangerSession.token, expected: 403,
    body: { paymentMethodToken: 'pm_demo_visa' },
  });
  await request(`/api/payments/${paymentIntent.id}/confirm`, {
    method: 'POST', token: owner.token, expected: 402,
    body: { paymentMethodToken: 'pm_declined' },
  });
  const { data: paid } = await request(`/api/payments/${paymentIntent.id}/confirm`, {
    method: 'POST', token: owner.token,
    body: { paymentMethodToken: 'pm_demo_visa' },
  });
  if (paid.status !== 'paid' || paid.amount_cents !== approved.total_cents) {
    throw new Error('Successful payment did not match the confirmed booking');
  }
  const { data: adminPayments } = await request('/api/payments', { token: adminSession.token });
  const visibleCharge = adminPayments.find((payment) => payment.id === paid.id);
  if (!visibleCharge || visibleCharge.guest_id !== owner.user.id) {
    throw new Error('Administrator payment ledger did not identify the paying guest');
  }

  const cancelledBeforeChargeBooking = pendingBookings[1];
  await request(`/api/bookings/${cancelledBeforeChargeBooking.id}/confirm`, {
    method: 'POST', token: adminSession.token,
  });
  const { data: unchargedIntent } = await request('/api/payments/intents', {
    method: 'POST', token: owner.token, expected: 201,
    body: { bookingId: cancelledBeforeChargeBooking.id, idempotencyKey: cancelledBeforeChargeBooking.id },
  });
  await request(`/api/bookings/${cancelledBeforeChargeBooking.id}/cancel`, {
    method: 'POST', token: owner.token,
  });
  await request(`/api/payments/${unchargedIntent.id}/confirm`, {
    method: 'POST', token: owner.token, expected: 409,
    body: { paymentMethodToken: 'pm_demo_visa' },
  });

  // Full Phase 1 stay lifecycle: confirm -> pay -> check in -> folio -> checkout -> housekeeping.
  const operationalBooking = pendingBookings[2];
  if (!operationalBooking) throw new Error('At least three rooms are required for the operational workflow test');
  const { data: operationalConfirmed } = await request(`/api/bookings/${operationalBooking.id}/confirm`, {
    method: 'POST', token: adminSession.token,
  });
  const { data: operationalIntent } = await request('/api/payments/intents', {
    method: 'POST', token: owner.token, expected: 201,
    body: { bookingId: operationalConfirmed.id, idempotencyKey: `stay-${operationalConfirmed.id}` },
  });
  await request(`/api/payments/${operationalIntent.id}/confirm`, {
    method: 'POST', token: owner.token, body: { paymentMethodToken: 'pm_demo_visa' },
  });
  const { data: folio } = await request(`/api/operations/bookings/${operationalConfirmed.id}/check-in`, {
    method: 'POST', token: adminSession.token,
  });
  if (folio.status !== 'open' || folio.booking_id !== operationalConfirmed.id) {
    throw new Error('Check-in did not open the expected folio');
  }
  await request(`/api/operations/folios/${folio.id}/items`, {
    method: 'POST', token: adminSession.token, expected: 201,
    body: { type: 'minibar', description: 'Minibar refreshments', quantity: 1, unitCents: 1500 },
  });
  await request(`/api/operations/bookings/${operationalConfirmed.id}/check-out`, {
    method: 'POST', token: adminSession.token, expected: 409,
  });
  const { data: manualPayment } = await request('/api/payments/manual', {
    method: 'POST', token: adminSession.token, expected: 201,
    body: { folioId: folio.id, amountCents: 1500, method: 'cash', referenceNumber: `cash-${runId}` },
  });
  if (manualPayment.payment_method !== 'cash' || manualPayment.received_by !== adminSession.user.id) {
    throw new Error('Manual folio payment did not record its method and receiver');
  }
  const { data: checkedOut } = await request(`/api/operations/bookings/${operationalConfirmed.id}/check-out`, {
    method: 'POST', token: adminSession.token,
  });
  if (checkedOut.invoice.status !== 'closed' || checkedOut.invoice.outstanding_cents !== 0) {
    throw new Error('Checkout did not close a fully paid folio');
  }
  const { data: invoice } = await request(`/api/operations/folios/${folio.id}/invoice`, {
    token: adminSession.token,
  });
  if (!invoice.invoice_number || invoice.items.length !== 1 || invoice.payments.length !== 2) {
    throw new Error('Final invoice did not include room, charge, and payment data');
  }
  const { data: housekeepingTasks } = await request('/api/operations/housekeeping', { token: adminSession.token });
  const housekeepingTask = housekeepingTasks.find((task) => task.booking_id === operationalConfirmed.id);
  if (!housekeepingTask || housekeepingTask.operational_status !== 'dirty') {
    throw new Error('Checkout did not create a dirty housekeeping task');
  }
  for (const status of ['cleaning', 'clean', 'inspected']) {
    await request(`/api/operations/housekeeping/${housekeepingTask.id}`, {
      method: 'PATCH', token: adminSession.token, body: { status },
    });
  }
  const { data: cleanedRooms } = await request('/api/rooms?status=active');
  const cleanedRoom = cleanedRooms.find((room) => room.id === operationalConfirmed.room_id);
  if (cleanedRoom?.operational_status !== 'available') {
    throw new Error('Inspected room was not returned to available inventory');
  }
  const { data: dashboard } = await request('/api/operations/dashboard', { token: adminSession.token });
  const { data: report } = await request(`/api/operations/reports/summary?from=${dateOnly(-1)}&to=${dateOnly(1)}`, { token: adminSession.token });
  const { data: auditLogs } = await request('/api/operations/audit-logs', { token: adminSession.token });
  if (dashboard.total < 1 || report.reservations.checked_out < 1 || !auditLogs.some((entry) => entry.action === 'reservation.checked_out')) {
    throw new Error('Operational dashboard, reports, or audit log did not reflect checkout');
  }
  const { data: updatedSettings } = await request('/api/operations/settings', {
    method: 'PATCH', token: adminSession.token, body: { hotelName: 'Luma Hotel & Residence' },
  });
  if (updatedSettings.hotel_name !== 'Luma Hotel & Residence') throw new Error('Hotel settings were not saved');

  await Promise.all(pendingBookings
    .filter((booking) => ![cancelledBeforeChargeBooking.id, operationalBooking.id].includes(booking.id))
    .map((booking) => request(`/api/bookings/${booking.id}/cancel`, {
    method: 'POST', token: owner.token,
  })));

  let refundedPayment;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data: paymentList } = await request('/api/payments', { token: owner.token });
    refundedPayment = paymentList.find((payment) => payment.id === paymentIntent.id);
    if (refundedPayment?.status === 'refunded') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (refundedPayment?.status !== 'refunded') {
    throw new Error('Cancelling a paid booking did not trigger a refund');
  }

  let notifications = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    ({ data: notifications } = await request('/api/notifications/me', { token: owner.token }));
    if (notifications.some((item) => item.type === 'booking_requested') &&
        notifications.some((item) => item.type === 'booking_confirmed') &&
        notifications.some((item) => item.type === 'booking_cancelled') &&
        notifications.some((item) => item.type === 'payment_succeeded') &&
        notifications.some((item) => item.type === 'payment_refunded')) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!notifications.some((item) => item.type === 'booking_requested') ||
      !notifications.some((item) => item.type === 'booking_confirmed') ||
      !notifications.some((item) => item.type === 'booking_cancelled') ||
      !notifications.some((item) => item.type === 'payment_succeeded') ||
      !notifications.some((item) => item.type === 'payment_refunded')) {
    throw new Error('Expected booking and payment notifications were not stored');
  }

  let authNotifications = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    ({ data: authNotifications } = await request('/api/notifications/me', { token: strangerSession.token }));
    if (authNotifications.some((item) => item.type === 'auth_password_reset_completed')) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!authNotifications.some((item) => item.type === 'auth_password_reset_requested') ||
      !authNotifications.some((item) => item.type === 'auth_password_reset_completed')) {
    throw new Error('Expected password-reset notifications were not stored');
  }

  await request(`/api/users/${strangerSession.user.id}/role`, {
    method: 'PATCH', token: adminSession.token, body: { role: 'staff' },
  });
  const { data: staffSession } = await request('/api/auth/login', {
    method: 'POST', body: { email: strangerEmail, password: 'new-smoke-test-password' },
  });
  await request('/api/bookings', {
    method: 'POST', token: staffSession.token, expected: 403,
    body: { roomTypeId: standard.id, checkIn, checkOut },
  });
  await request('/api/payments', { token: staffSession.token, expected: 403 });
  await request('/api/auth/logout', {
    method: 'POST', expected: 204, body: { refreshToken: staffSession.refreshToken },
  });
  await request('/api/auth/logout', {
    method: 'POST', expected: 204, body: { refreshToken: strangerSession.refreshToken },
  });

  console.log(JSON.stringify({
    status: 'ok',
    roomType: standard.name,
    concurrentBookingRequestsHeld: pendingBookings.length,
    overCapacityRequestsRejected: rejected.length,
    unauthorizedCancellationProtected: true,
    adminConfirmationEnforced: true,
    refreshRotationAndReplayDetection: true,
    passwordResetAndSessionRevocation: true,
    rabbitMqNotifications: true,
    paymentAuthorizationAndIdempotency: true,
    paymentDeclineAndRetry: true,
    cancellationRefund: true,
    cancellationBeforeChargeProtected: true,
    adminPaymentLedgerIdentifiesGuest: true,
    checkInAndFolioFlow: true,
    checkoutBalanceGuard: true,
    manualPaymentAndInvoice: true,
    housekeepingTurnaround: true,
    dashboardReportsAuditAndSettings: true,
    adminAndStaffBookingBlocked: true,
    staffPaymentLedgerBlocked: true,
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
