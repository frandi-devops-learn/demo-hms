import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell, BedDouble, BookOpen, Building2, CalendarDays, Check, ChevronRight,
  CircleUserRound, ClipboardList, CreditCard, DoorOpen, FileText, History, Hotel,
  LayoutDashboard, LogIn, LogOut, Menu, Search, Settings, ShieldCheck, Sparkles,
  BarChart3, Users, X,
} from 'lucide-react';

const SESSION_KEY = 'luma.hotel.session';
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const navItems = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'discover', label: 'Find a room', icon: Search },
  { id: 'bookings', label: 'Bookings', icon: CalendarDays },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'profile', label: 'My profile', icon: CircleUserRound },
];

function readSession() {
  if (typeof window === 'undefined') return null;
  try { return JSON.parse(window.localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

function tomorrow(offset = 1) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function dateLabel(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(`${value.slice(0, 10)}T00:00:00`));
}

function timestampLabel(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value));
}

function initials(user) {
  const name = `${user?.first_name || user?.firstName || ''} ${user?.last_name || user?.lastName || ''}`.trim();
  return (name || user?.email || 'Guest').split(/\s|@/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function Status({ value }) {
  return <span className={`status status-${value}`}>{String(value).replaceAll('_', ' ')}</span>;
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.type || 'success'}`}>
      <span>{toast.type === 'success' ? <Check size={18} /> : <Bell size={18} />}</span>
      <p>{toast.message}</p><button onClick={onClose} aria-label="Close"><X size={17} /></button>
    </div>
  );
}

function AuthModal({ mode: initialMode, onClose, onAuthenticated, request, notify }) {
  const [mode, setMode] = useState(initialMode);
  const [busy, setBusy] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [email, setEmail] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      if (mode === 'reset') {
        const data = await request('/auth/password-reset/request', {
          method: 'POST', anonymous: true, body: { email: form.get('email') },
        });
        setEmail(form.get('email'));
        if (data.resetToken) setResetToken(data.resetToken);
        setMode('reset-confirm');
        notify('Reset instructions created. Check your email or use the development token shown below.');
      } else if (mode === 'reset-confirm') {
        await request('/auth/password-reset/confirm', {
          method: 'POST', anonymous: true,
          body: { resetToken: form.get('resetToken'), newPassword: form.get('newPassword') },
        });
        notify('Password changed. You can now sign in.');
        setMode('login');
      } else {
        const path = mode === 'register' ? '/auth/register' : '/auth/login';
        const body = mode === 'register'
          ? {
              email: form.get('email'), password: form.get('password'),
              firstName: form.get('firstName'), lastName: form.get('lastName'), phone: form.get('phone'),
            }
          : { email: form.get('email'), password: form.get('password') };
        const session = await request(path, { method: 'POST', anonymous: true, body });
        onAuthenticated(session);
      }
    } catch (error) { notify(error.message, 'error'); }
    finally { setBusy(false); }
  }

  const title = mode === 'register' ? 'Create your account'
    : mode === 'reset' ? 'Reset your password'
      : mode === 'reset-confirm' ? 'Choose a new password' : 'Welcome back';

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="auth-modal" aria-modal="true" role="dialog">
        <button className="modal-close" onClick={onClose} aria-label="Close"><X /></button>
        <div className="auth-mark"><Hotel size={27} /><span>LUMA</span></div>
        <p className="eyebrow">Guest portal</p><h2>{title}</h2>
        <p className="muted">
          {mode === 'register' ? 'Book faster, manage stays, and receive updates in one place.'
            : mode.startsWith('reset') ? 'Securely regain access to your hotel account.'
              : 'Sign in to continue to your stays and preferences.'}
        </p>
        <form onSubmit={submit} className="auth-form">
          {mode === 'register' && <div className="field-row"><label>First name<input name="firstName" required /></label><label>Last name<input name="lastName" required /></label></div>}
          {(mode === 'login' || mode === 'register' || mode === 'reset') &&
            <label>Email address<input name="email" type="email" defaultValue={email} required autoComplete="email" /></label>}
          {mode === 'register' && <label>Phone <span className="optional">optional</span><input name="phone" type="tel" autoComplete="tel" /></label>}
          {(mode === 'login' || mode === 'register') &&
            <label>Password<input name="password" type="password" minLength="8" required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>}
          {mode === 'reset-confirm' && <>
            <label>Reset token<textarea name="resetToken" defaultValue={resetToken} required rows="3" /></label>
            <label>New password<input name="newPassword" type="password" minLength="8" required autoComplete="new-password" /></label>
          </>}
          <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Please wait…' : mode === 'register' ? 'Create account' : mode === 'reset' ? 'Send reset instructions' : mode === 'reset-confirm' ? 'Change password' : 'Sign in'}</button>
        </form>
        {mode === 'login' && <button className="text-button" onClick={() => setMode('reset')}>Forgot your password?</button>}
        <div className="auth-switch">
          {mode === 'register' ? <>Already have an account? <button onClick={() => setMode('login')}>Sign in</button></>
            : mode === 'login' ? <>New to Luma? <button onClick={() => setMode('register')}>Create an account</button></>
              : <>Remembered it? <button onClick={() => setMode('login')}>Back to sign in</button></>}
        </div>
      </section>
    </div>
  );
}

function roomVisual(type) {
  return type.name.toLowerCase().includes('suite') ? 'suite' : type.name.toLowerCase().includes('deluxe') ? 'deluxe' : 'standard';
}

function RoomCard({ type, roomCount, onView }) {
  const visual = roomVisual(type);
  return (
    <article className="room-card">
      <div className={`room-visual room-${visual}`}>
        <img src={`/images/rooms/${visual}.jpg`} alt={`${type.name} hotel room`} loading="lazy" decoding="async" />
        <span>{type.name}</span><BedDouble size={30} aria-hidden="true" />
      </div>
      <div className="room-copy">
        <div className="room-title"><div><p className="eyebrow">Sleeps {type.capacity}</p><h3>{type.name}</h3></div><strong>{money.format(type.price_cents / 100)}<small>/night</small></strong></div>
        <p>{type.description || 'A thoughtfully appointed room designed for a restorative stay.'}</p>
        <div className="room-footer"><span>{roomCount} room{roomCount === 1 ? '' : 's'} in inventory</span><button className="button button-quiet" onClick={() => onView(type)}>View details <ChevronRight size={16} /></button></div>
      </div>
    </article>
  );
}

function RoomDetailsModal({ type, roomCount, onClose, onBook }) {
  if (!type) return null;
  const visual = roomVisual(type);
  const features = visual === 'suite'
    ? ['Separate living area', 'Two-room layout', `Sleeps ${type.capacity}`]
    : visual === 'deluxe'
      ? ['King bed', 'Private balcony', `Sleeps ${type.capacity}`]
      : ['Queen bed', 'City view', `Sleeps ${type.capacity}`];

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="room-detail-modal" role="dialog" aria-modal="true" aria-labelledby="room-detail-title">
        <div className="room-detail-photo">
          <img src={`/images/rooms/${visual}.jpg`} alt={`${type.name} hotel room`} />
          <button className="room-detail-close" onClick={onClose} aria-label="Close room details"><X /></button>
        </div>
        <div className="room-detail-copy">
          <p className="eyebrow">Room details</p>
          <div className="room-detail-title"><h2 id="room-detail-title">{type.name}</h2><strong>{money.format(type.price_cents / 100)}<small>per night</small></strong></div>
          <p className="room-detail-description">{type.description || 'A thoughtfully appointed room designed for a restorative stay.'}</p>
          <div className="room-features">{features.map((feature) => <span key={feature}><Check size={16} />{feature}</span>)}</div>
          <div className={`availability-note ${roomCount ? '' : 'availability-empty'}`}><BedDouble size={19} /><div><strong>{roomCount ? `${roomCount} rooms in inventory` : 'Currently unavailable'}</strong><small>{roomCount ? 'Choose your dates on the next step to confirm availability.' : 'Please check another room type.'}</small></div></div>
          <div className="room-detail-actions"><button className="button button-quiet" onClick={onClose}>Keep browsing</button><button className="button button-primary" onClick={() => onBook(type.id)} disabled={!roomCount}>Continue to booking <ChevronRight size={17} /></button></div>
          <small className="booking-assurance">No request is submitted until you choose dates. The hotel must approve it before it becomes confirmed.</small>
        </div>
      </section>
    </div>
  );
}

function FolioModal({ folio, onClose, onCharge, onPayment, canEdit }) {
  if (!folio) return null;
  const open = folio.status === 'open';
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="folio-modal" role="dialog" aria-modal="true">
      <button className="modal-close" onClick={onClose} aria-label="Close folio"><X /></button>
      <div className="panel-head"><div><p className="eyebrow">{open ? 'Open guest folio' : 'Final invoice'}</p><h2>{folio.invoice_number || `Folio ${folio.id.slice(0, 8).toUpperCase()}`}</h2></div><Status value={folio.status} /></div>
      <div className="metric-strip folio-summary"><div><strong>{money.format(folio.total_cents / 100)}</strong><span>Total</span></div><div><strong>{money.format((folio.paid_cents || 0) / 100)}</strong><span>Paid</span></div><div><strong>{money.format((folio.outstanding_cents || 0) / 100)}</strong><span>Outstanding</span></div></div>
      <div className="table-wrap"><table><thead><tr><th>Description</th><th>Qty</th><th>Amount</th></tr></thead><tbody><tr><td>Room charge</td><td>1</td><td>{money.format(folio.room_charge_cents / 100)}</td></tr>{folio.tax_cents > 0 && <tr><td>Tax</td><td>1</td><td>{money.format(folio.tax_cents / 100)}</td></tr>}{folio.service_charge_cents > 0 && <tr><td>Service charge</td><td>1</td><td>{money.format(folio.service_charge_cents / 100)}</td></tr>}{folio.items?.map((item) => <tr key={item.id}><td>{item.description}<br /><small>{item.type.replaceAll('_', ' ')}</small></td><td>{item.quantity}</td><td>{money.format(item.total_cents / 100)}</td></tr>)}</tbody></table></div>
      {folio.payments?.length > 0 && <div className="folio-payments"><h3>Payments</h3>{folio.payments.map((payment) => <div key={payment.id}><span>{payment.payment_method || payment.provider}</span><strong>{money.format(payment.amount_cents / 100)} <Status value={payment.status} /></strong></div>)}</div>}
      {canEdit && open && <div className="folio-forms"><form onSubmit={onCharge}><h3>Add charge</h3><label>Description<input name="description" required /></label><div className="field-row"><label>Type<select name="type"><option value="service">Service</option><option value="minibar">Minibar</option><option value="laundry">Laundry</option><option value="extra_bed">Extra bed</option><option value="other">Other</option></select></label><label>Quantity<input name="quantity" type="number" min="1" defaultValue="1" required /></label></div><label>Unit amount<input name="amount" type="number" min="0" step="0.01" required /></label><button className="button button-quiet">Add charge</button></form><form onSubmit={onPayment}><h3>Record payment</h3><label>Amount<input name="amount" type="number" min="0.01" step="0.01" max={(folio.outstanding_cents || 0) / 100} required /></label><label>Method<select name="method"><option value="cash">Cash</option><option value="card">Card</option><option value="bank_transfer">Bank transfer</option></select></label><label>Reference<input name="reference" /></label><label>Notes<input name="notes" /></label><button className="button button-primary" disabled={!folio.outstanding_cents}>Record payment</button></form></div>}
      <div className="folio-actions"><button className="button button-quiet" onClick={() => window.print()}><FileText size={17} /> Print invoice</button><button className="button button-primary" onClick={onClose}>Done</button></div>
    </section>
  </div>;
}

function App({ initialData = {} }) {
  const [session, setSessionState] = useState(null);
  const [profile, setProfile] = useState(null);
  const [roomTypes, setRoomTypes] = useState(initialData.roomTypes || []);
  const [rooms, setRooms] = useState(initialData.rooms || []);
  const [bookings, setBookings] = useState([]);
  const [payments, setPayments] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [users, setUsers] = useState([]);
  const [view, setView] = useState('discover');
  const [authMode, setAuthMode] = useState(null);
  const [bookingType, setBookingType] = useState('');
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [toast, setToast] = useState(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [loading, setLoading] = useState(!initialData.catalogLoaded);
  const [payingId, setPayingId] = useState(null);
  const [operationsDashboard, setOperationsDashboard] = useState(null);
  const [housekeeping, setHousekeeping] = useState([]);
  const [hotelSettings, setHotelSettings] = useState(null);
  const [reports, setReports] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);
  const [activeFolio, setActiveFolio] = useState(null);

  function storeSession(value) {
    setSessionState(value);
    if (value) window.localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(SESSION_KEY);
  }

  const notify = useCallback((message, type = 'success') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 4500);
  }, []);

  const request = useCallback(async (path, options = {}) => {
    const run = (accessToken) => fetch(`/api${path}`, {
      method: options.method || 'GET',
      headers: {
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let response = await run(options.anonymous ? null : session?.accessToken || session?.token);
    if (response.status === 401 && !options.anonymous && session?.refreshToken) {
      const refreshed = await fetch('/api/auth/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
      if (refreshed.ok) {
        const nextSession = await refreshed.json();
        storeSession(nextSession);
        response = await run(nextSession.accessToken);
      } else {
        storeSession(null); setProfile(null); setView('discover');
        throw new Error('Your session expired. Please sign in again.');
      }
    }
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Something went wrong');
    return data;
  }, [session]);

  const refreshPortal = useCallback(async () => {
    if (!session) return;
    const role = session.user?.role;
    const tasks = [request('/users/me'), request('/bookings'), request('/notifications/me'), request('/payments')];
    if (['admin', 'staff', 'manager', 'receptionist'].includes(role)) tasks.push(request('/users'), request('/rooms'));
    const results = await Promise.allSettled(tasks);
    if (results[0].status === 'fulfilled') setProfile(results[0].value);
    if (results[1].status === 'fulfilled') setBookings(results[1].value);
    if (results[2].status === 'fulfilled') setNotifications(results[2].value);
    if (results[3].status === 'fulfilled') setPayments(results[3].value);
    if (results[4]?.status === 'fulfilled') setUsers(results[4].value);
    if (results[5]?.status === 'fulfilled') setRooms(results[5].value);
  }, [request, session]);

  useEffect(() => {
    const savedSession = readSession();
    if (savedSession) {
      setSessionState(savedSession);
      setView('overview');
    }
  }, []);

  useEffect(() => {
    if (initialData.catalogLoaded) return;
    Promise.all([request('/rooms/room-types', { anonymous: true }), request('/rooms?status=active', { anonymous: true })])
      .then(([types, roomList]) => { setRoomTypes(types); setRooms(roomList); })
      .catch((error) => notify(error.message, 'error'))
      .finally(() => setLoading(false));
  }, []); // hydrate from SSR data or recover client-side if SSR catalogue loading failed

  useEffect(() => { refreshPortal(); }, [refreshPortal]);

  const role = session?.user?.role || 'guest';
  const isStaff = role !== 'guest';
  const canFrontDesk = ['admin', 'manager', 'receptionist'].includes(role);
  const canViewFinance = ['admin', 'manager', 'accountant'].includes(role);
  const canViewReports = ['admin', 'manager', 'accountant'].includes(role);
  const canManageHousekeeping = ['admin', 'manager', 'housekeeper'].includes(role);
  const unread = notifications.filter((item) => !item.read).length;
  const confirmed = bookings.filter((item) => item.status === 'confirmed');
  const pending = bookings.filter((item) => item.status === 'pending');
  const roomsById = useMemo(() => new Map(rooms.map((room) => [room.id, room])), [rooms]);
  const typesById = useMemo(() => new Map(roomTypes.map((type) => [type.id, type])), [roomTypes]);
  const paymentsByBookingId = useMemo(
    () => new Map(payments.map((payment) => [payment.booking_id, payment])),
    [payments],
  );
  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

  const refreshOperations = useCallback(async () => {
    if (!session || role === 'guest') return;
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const tasks = [request('/operations/dashboard'), request('/operations/settings')];
    const keys = ['dashboard', 'settings'];
    if (['admin', 'manager', 'receptionist', 'housekeeper'].includes(role)) {
      tasks.push(request('/operations/housekeeping')); keys.push('housekeeping');
    }
    if (canViewReports) {
      tasks.push(request(`/operations/reports/summary?from=${from}&to=${to}`)); keys.push('reports');
    }
    if (['admin', 'manager'].includes(role)) {
      tasks.push(request('/operations/audit-logs')); keys.push('audit');
    }
    const results = await Promise.allSettled(tasks);
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      if (keys[index] === 'dashboard') setOperationsDashboard(result.value);
      if (keys[index] === 'settings') setHotelSettings(result.value);
      if (keys[index] === 'housekeeping') setHousekeeping(result.value);
      if (keys[index] === 'reports') setReports(result.value);
      if (keys[index] === 'audit') setAuditLogs(result.value);
    });
  }, [session, role, request, canViewReports]);

  useEffect(() => { refreshOperations(); }, [refreshOperations]);
  useEffect(() => {
    if (!session || role === 'guest') return undefined;
    const timer = window.setInterval(() => { refreshPortal(); refreshOperations(); }, 30000);
    return () => window.clearInterval(timer);
  }, [session, role, refreshPortal, refreshOperations]);

  useEffect(() => {
    if (session && isStaff && view === 'discover') {
      setBookingType('');
      setSelectedRoom(null);
      setView('overview');
    }
  }, [session, isStaff, view]);

  function startBooking(typeId) {
    if (session && role !== 'guest') {
      notify('Only guest accounts can request rooms.', 'error');
      setSelectedRoom(null);
      return;
    }
    setSelectedRoom(null);
    setBookingType(typeId);
    if (session) setView('discover'); else setAuthMode('login');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function createBooking(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await request('/bookings', { method: 'POST', body: {
        roomTypeId: form.get('roomTypeId'), checkIn: form.get('checkIn'), checkOut: form.get('checkOut'),
        adults: Number(form.get('adults')), children: Number(form.get('children')),
        specialRequests: form.get('specialRequests'), bookingSource: 'website',
      } });
      notify('Your booking request was sent to the hotel for approval.'); setBookingType(''); await refreshPortal(); setView('bookings');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function confirmBooking(id) {
    try {
      await request(`/bookings/${id}/confirm`, { method: 'POST' });
      notify('Booking confirmed. The guest has been notified.');
      await refreshPortal();
    } catch (error) { notify(error.message, 'error'); }
  }

  async function cancelBooking(id, status, rejecting = false) {
    if (!window.confirm(status === 'pending' ? `${rejecting ? 'Reject' : 'Withdraw'} this pending booking request?` : 'Cancel this confirmed booking?')) return;
    try { await request(`/bookings/${id}/cancel`, { method: 'POST' }); notify('Booking cancelled. Any completed payment will be refunded automatically.'); await refreshPortal(); }
    catch (error) { notify(error.message, 'error'); }
  }

  async function payBooking(booking) {
    setPayingId(booking.id);
    try {
      const payment = await request('/payments/intents', {
        method: 'POST',
        body: { bookingId: booking.id, idempotencyKey: booking.id },
      });
      await request(`/payments/${payment.id}/confirm`, {
        method: 'POST',
        body: { paymentMethodToken: 'pm_demo_visa' },
      });
      notify('Payment completed. Your receipt notification is on its way.');
      await refreshPortal();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setPayingId(null);
    }
  }

  async function markRead(id) {
    try { await request(`/notifications/${id}/read`, { method: 'POST' }); setNotifications((items) => items.map((item) => item.id === id ? { ...item, read: true } : item)); }
    catch (error) { notify(error.message, 'error'); }
  }

  async function signOut() {
    try { if (session?.refreshToken) await request('/auth/logout', { method: 'POST', anonymous: true, body: { refreshToken: session.refreshToken } }); } catch { /* local logout still succeeds */ }
    storeSession(null); setProfile(null); setBookings([]); setPayments([]); setNotifications([]); setUsers([]); setView('discover');
  }

  async function saveProfile(event) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      const updated = await request(`/users/${profile.id}`, { method: 'PATCH', body: {
        firstName: form.get('firstName'), lastName: form.get('lastName'), phone: form.get('phone'),
        address: form.get('address'), nationality: form.get('nationality'),
        idType: 'passport', idNumber: form.get('idNumber'), dateOfBirth: form.get('dateOfBirth') || null,
        notes: form.get('notes'),
      } });
      setProfile({ ...updated, role }); notify('Profile updated.');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function setRoomStatus(roomId, operationalStatus) {
    try { await request(`/rooms/${roomId}`, { method: 'PATCH', body: { operationalStatus } }); setRooms((list) => list.map((room) => room.id === roomId ? { ...room, operational_status: operationalStatus } : room)); notify('Room status updated.'); await refreshOperations(); }
    catch (error) { notify(error.message, 'error'); }
  }

  async function setUserRole(userId, nextRole) {
    try { await request(`/users/${userId}/role`, { method: 'PATCH', body: { role: nextRole } }); setUsers((list) => list.map((user) => user.id === userId ? { ...user, role: nextRole } : user)); notify('User role updated.'); }
    catch (error) { notify(error.message, 'error'); }
  }

  async function setUserActive(userId, active) {
    try { await request(`/users/${userId}/status`, { method: 'PATCH', body: { active } }); setUsers((list) => list.map((user) => user.id === userId ? { ...user, active } : user)); notify(`User ${active ? 'activated' : 'deactivated'}.`); }
    catch (error) { notify(error.message, 'error'); }
  }

  async function checkInBooking(bookingId) {
    try { const folio = await request(`/operations/bookings/${bookingId}/check-in`, { method: 'POST' }); setActiveFolio(folio); notify('Guest checked in and folio opened.'); await Promise.all([refreshPortal(), refreshOperations()]); }
    catch (error) { notify(error.message, 'error'); }
  }

  async function checkOutBooking(bookingId) {
    if (!window.confirm('Complete checkout and mark the room Dirty?')) return;
    try { const result = await request(`/operations/bookings/${bookingId}/check-out`, { method: 'POST' }); setActiveFolio(result.invoice); notify('Checkout complete. The room was sent to housekeeping.'); await Promise.all([refreshPortal(), refreshOperations()]); }
    catch (error) { notify(error.message, 'error'); }
  }

  async function openFolio(bookingId) {
    try { setActiveFolio(await request(`/operations/folios/booking/${bookingId}`)); }
    catch (error) { notify(error.message, 'error'); }
  }

  async function addFolioCharge(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await request(`/operations/folios/${activeFolio.id}/items`, { method: 'POST', body: {
        type: form.get('type'), description: form.get('description'), quantity: Number(form.get('quantity')),
        unitCents: Math.round(Number(form.get('amount')) * 100),
      } });
      await openFolio(activeFolio.booking_id); event.currentTarget.reset(); notify('Charge added to folio.');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function addFolioPayment(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await request('/payments/manual', { method: 'POST', body: {
        folioId: activeFolio.id, amountCents: Math.round(Number(form.get('amount')) * 100),
        method: form.get('method'), referenceNumber: form.get('reference'), notes: form.get('notes'),
      } });
      await openFolio(activeFolio.booking_id); event.currentTarget.reset(); notify('Payment recorded.'); await refreshPortal();
    } catch (error) { notify(error.message, 'error'); }
  }

  async function updateHousekeeping(taskId, body) {
    try { await request(`/operations/housekeeping/${taskId}`, { method: 'PATCH', body }); notify('Housekeeping task updated.'); await refreshOperations(); }
    catch (error) { notify(error.message, 'error'); }
  }

  async function loadReports(event) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try { setReports(await request(`/operations/reports/summary?from=${form.get('from')}&to=${form.get('to')}`)); }
    catch (error) { notify(error.message, 'error'); }
  }

  async function saveSettings(event) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      const updated = await request('/operations/settings', { method: 'PATCH', body: Object.fromEntries(form) });
      setHotelSettings(updated); notify('Hotel settings saved.');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function changePassword(event) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      await request('/auth/change-password', { method: 'POST', body: { currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') } });
      notify('Password changed. Please sign in again.'); window.setTimeout(() => signOut(), 900);
    } catch (error) { notify(error.message, 'error'); }
  }

  const navigation = [
    navItems[0],
    ...(role === 'guest' ? [navItems[1], navItems[2]] : []),
    ...(['admin', 'staff', 'manager', 'receptionist'].includes(role) ? [navItems[2]] : []),
    ...(canFrontDesk ? [{ id: 'frontdesk', label: 'Front desk', icon: ClipboardList }] : []),
    ...(canViewFinance ? [{ id: 'payments', label: 'Hotel charges', icon: CreditCard }] : []),
    ...(canManageHousekeeping || role === 'receptionist' ? [{ id: 'housekeeping', label: 'Housekeeping', icon: Sparkles }] : []),
    ...(canViewReports ? [{ id: 'reports', label: 'Reports', icon: BarChart3 }] : []),
    ...(['admin', 'staff', 'manager', 'receptionist'].includes(role) ? [
      { id: 'inventory', label: 'Room inventory', icon: DoorOpen },
      { id: 'users', label: 'Guests & staff', icon: Users },
    ] : []),
    ...(role === 'admin' ? [{ id: 'settings', label: 'Hotel settings', icon: Settings }] : []),
    ...(['admin', 'manager'].includes(role) ? [{ id: 'audit', label: 'Audit log', icon: History }] : []),
    navItems[3], navItems[4],
  ];

  function renderContent() {
    if (view === 'overview' && isStaff) {
      const dashboard = operationsDashboard || {};
      return <><div className="page-heading"><div><p className="eyebrow">Hotel operations</p><h1>Good day, {profile?.first_name || 'team'}.</h1><p>A live view of arrivals, occupancy, revenue, and rooms requiring attention.</p></div></div>
        <div className="stat-grid stat-grid-four">
          <article className="stat-card"><span><BedDouble /></span><div><strong>{dashboard.occupancy_rate || 0}%</strong><p>Occupancy · {dashboard.occupied || 0}/{dashboard.total || 0} rooms</p></div></article>
          <article className="stat-card"><span><LogIn /></span><div><strong>{dashboard.arrivals || 0}</strong><p>Today's arrivals</p></div></article>
          <article className="stat-card"><span><LogOut /></span><div><strong>{dashboard.departures || 0}</strong><p>Today's departures</p></div></article>
          <article className="stat-card"><span><CreditCard /></span><div><strong>{money.format((dashboard.revenue_cents || 0) / 100)}</strong><p>Today's payments</p></div></article>
        </div>
        <section className="panel"><div className="panel-head"><div><p className="eyebrow">Room readiness</p><h2>Operational status</h2></div>{canFrontDesk && <button className="text-button" onClick={() => setView('frontdesk')}>Open front desk</button>}</div>
          <div className="metric-strip"><div><strong>{dashboard.available || 0}</strong><span>Available</span></div><div><strong>{dashboard.clean || 0}</strong><span>Clean / inspected</span></div><div><strong>{dashboard.dirty || 0}</strong><span>Dirty</span></div><div><strong>{dashboard.out_of_order || 0}</strong><span>Out of order</span></div><div><strong>{dashboard.current_guests || 0}</strong><span>In-house guests</span></div></div>
        </section>
      </>;
    }

    if (view === 'overview') return <>
      <div className="page-heading"><div><p className="eyebrow">{isStaff ? 'Hotel operations' : 'Your stay, your way'}</p><h1>Good day, {profile?.first_name || (isStaff ? 'team' : 'traveler')}.</h1><p>{isStaff ? 'Review reservations, guests, inventory, and hotel activity.' : 'Everything you need for a smooth hotel experience.'}</p></div>{!isStaff && <button className="button button-primary" onClick={() => setView('discover')}><BookOpen size={18} /> Book a stay</button>}</div>
      <div className="stat-grid">
        <article className="stat-card"><span><CalendarDays /></span><div><strong>{confirmed.length}</strong><p>Upcoming stays</p></div></article>
        <article className="stat-card"><span><Bell /></span><div><strong>{unread}</strong><p>Unread updates</p></div></article>
        <article className="stat-card"><span><Sparkles /></span><div><strong>{pending.length}</strong><p>Awaiting approval</p></div></article>
      </div>
      <section className="panel"><div className="panel-head"><div><p className="eyebrow">Next up</p><h2>{isStaff ? 'Confirmed reservations' : 'Your upcoming stays'}</h2></div><button className="text-button" onClick={() => setView('bookings')}>View all</button></div>
        {confirmed.length ? <div className="booking-list">{confirmed.slice(0, 3).map((booking) => <BookingRow key={booking.id} booking={booking} payment={paymentsByBookingId.get(booking.id)} roomsById={roomsById} typesById={typesById} onCancel={cancelBooking} onPay={role === 'guest' ? payBooking : null} paying={payingId === booking.id} />)}</div> : <Empty icon={CalendarDays} title="No confirmed stays" text={pending.length ? (isStaff ? 'Guest requests are waiting for review.' : 'Your booking request is waiting for hotel approval.') : (isStaff ? 'Confirmed guest reservations will appear here.' : 'Find the room that feels right for your next visit.')} action={isStaff ? undefined : () => setView('discover')} />}
      </section>
    </>;

    if (view === 'discover' && !isStaff) return <>
      <div className="page-heading"><div><p className="eyebrow">Rooms & suites</p><h1>Find your place to unwind.</h1><p>Considered comfort, warm service, and a room for every kind of stay.</p></div></div>
      {session && bookingType && <form className="booking-bar booking-bar-expanded" onSubmit={createBooking}>
        <input name="roomTypeId" type="hidden" value={bookingType} />
        <div className="booking-selection"><span>Selected room</span><strong>{typesById.get(bookingType)?.name || 'Room'}</strong><button type="button" onClick={() => setBookingType('')}>Change</button></div>
        <label>Check in<input name="checkIn" type="date" min={tomorrow()} defaultValue={tomorrow()} required /></label>
        <label>Check out<input name="checkOut" type="date" min={tomorrow(2)} defaultValue={tomorrow(2)} required /></label>
        <label>Adults<input name="adults" type="number" min="1" defaultValue="1" required /></label>
        <label>Children<input name="children" type="number" min="0" defaultValue="0" required /></label>
        <label className="wide-field">Special requests <span className="optional">optional</span><input name="specialRequests" placeholder="Accessibility, arrival, or room preferences" /></label>
        <button className="button button-primary"><Check size={18} /> Submit booking request</button>
      </form>}
      <div className="room-grid">{roomTypes.map((type) => <RoomCard key={type.id} type={type} roomCount={rooms.filter((room) => room.type_id === type.id).length} onView={setSelectedRoom} />)}</div>
    </>;

    if (view === 'bookings') return <><div className="page-heading"><div><p className="eyebrow">Reservations & payments</p><h1>{isStaff ? 'All bookings' : 'My bookings'}</h1><p>{role === 'admin' ? 'Review requests, confirm reservations, and monitor payment status.' : isStaff ? 'Review and manage guest reservations.' : 'Pay only after hotel approval, then manage your confirmed stay.'}</p></div></div><section className="panel">{bookings.length ? <div className="booking-list">{bookings.map((booking) => <BookingRow key={booking.id} booking={booking} payment={paymentsByBookingId.get(booking.id)} roomsById={roomsById} typesById={typesById} onCancel={cancelBooking} onConfirm={role === 'admin' ? confirmBooking : null} onPay={role === 'guest' ? payBooking : null} paying={payingId === booking.id} />)}</div> : <Empty icon={CalendarDays} title="No bookings yet" text={isStaff ? 'Guest booking requests will appear here.' : 'When you request a room, it will appear here.'} action={isStaff ? undefined : () => setView('discover')} />}</section></>;

    if (view === 'frontdesk' && canFrontDesk) return <><div className="page-heading"><div><p className="eyebrow">Stay operations</p><h1>Front desk</h1><p>Check guests in, manage folios, and complete checkout after payment.</p></div></div><section className="panel table-wrap"><table><thead><tr><th>Reservation</th><th>Guest</th><th>Stay</th><th>Status</th><th>Actions</th></tr></thead><tbody>{bookings.filter((booking) => ['confirmed', 'checked_in', 'checked_out'].includes(booking.status)).map((booking) => { const guest = usersById.get(booking.guest_id); return <tr key={booking.id}><td><strong>{booking.reservation_number || booking.id.slice(0, 8).toUpperCase()}</strong><br /><small>Room {roomsById.get(booking.room_id)?.room_number || 'assigned'}</small></td><td>{guest ? `${guest.first_name || ''} ${guest.last_name || ''}`.trim() : booking.guest_id.slice(0, 8)}<br /><small>{guest?.email || ''}</small></td><td>{dateLabel(booking.check_in)}<br /><small>to {dateLabel(booking.check_out)}</small></td><td><Status value={booking.status} /></td><td><div className="table-actions">{booking.status === 'confirmed' && <button className="button button-primary button-small" onClick={() => checkInBooking(booking.id)}>Check in</button>}{booking.status === 'checked_in' && <><button className="button button-quiet button-small" onClick={() => openFolio(booking.id)}>Folio</button><button className="button button-primary button-small" onClick={() => checkOutBooking(booking.id)}>Check out</button></>}{booking.status === 'checked_out' && <button className="button button-quiet button-small" onClick={() => openFolio(booking.id)}>Invoice</button>}</div></td></tr>; })}</tbody></table></section></>;

    if (view === 'notifications') return <><div className="page-heading"><div><p className="eyebrow">Inbox</p><h1>Notifications</h1><p>Booking and account updates, all in one place.</p></div></div><section className="panel notification-list">{notifications.length ? notifications.map((item) => <button key={item.id} className={`notification ${item.read ? '' : 'notification-unread'}`} onClick={() => !item.read && markRead(item.id)}><span><Bell size={19} /></span><div><strong>{item.type.replaceAll('_', ' ')}</strong><p>{item.message}</p><small>{new Date(item.created_at).toLocaleString()}</small></div>{!item.read && <i />}</button>) : <Empty icon={Bell} title="You're all caught up" text="New booking and account updates will appear here." />}</section></>;

    if (view === 'profile') return <><div className="page-heading"><div><p className="eyebrow">Account</p><h1>My profile</h1><p>Keep identity and contact information current.</p></div></div><div className="content-grid"><section className="panel"><div className="profile-intro profile-intro-horizontal"><div className="avatar avatar-large">{initials(profile)}</div><div><h2>{profile?.first_name} {profile?.last_name}</h2><p>{profile?.email}</p><Status value={role} /></div></div><form className="profile-form" onSubmit={saveProfile}><div className="field-row"><label>First name<input name="firstName" defaultValue={profile?.first_name || ''} required /></label><label>Last name<input name="lastName" defaultValue={profile?.last_name || ''} required /></label></div><div className="field-row"><label>Phone<input name="phone" type="tel" defaultValue={profile?.phone || ''} /></label><label>Date of birth<input name="dateOfBirth" type="date" defaultValue={profile?.date_of_birth?.slice(0, 10) || ''} /></label></div><div className="field-row"><label>Nationality<input name="nationality" defaultValue={profile?.nationality || ''} /></label><label>Passport / ID<input name="idNumber" defaultValue={profile?.id_number || ''} /></label></div><label>Address<textarea name="address" rows="2" defaultValue={profile?.address || ''} /></label><label>Notes<textarea name="notes" rows="2" defaultValue={profile?.notes || ''} /></label><button className="button button-primary">Save profile</button></form></section><section className="panel"><div className="panel-head"><div><p className="eyebrow">Security</p><h2>Change password</h2></div></div><form className="profile-form" onSubmit={changePassword}><label>Current password<input name="currentPassword" type="password" required /></label><label>New password<input name="newPassword" type="password" minLength="8" required /></label><button className="button button-quiet">Change password</button></form></section></div></>;

    if (view === 'payments' && canViewFinance) {
      const collected = payments.filter((payment) => payment.status === 'paid');
      const refunded = payments.filter((payment) => payment.status === 'refunded');
      const collectedCents = collected.reduce((sum, payment) => sum + payment.amount_cents, 0);
      return <><div className="page-heading"><div><p className="eyebrow">Finance</p><h1>Hotel charges</h1><p>See which guests paid, what booking was charged, and the current payment state.</p></div></div><div className="stat-grid"><article className="stat-card"><span><CreditCard /></span><div><strong>{collected.length}</strong><p>Paid charges</p></div></article><article className="stat-card"><span><Check /></span><div><strong>{money.format(collectedCents / 100)}</strong><p>Currently collected</p></div></article><article className="stat-card"><span><Bell /></span><div><strong>{refunded.length}</strong><p>Refunded charges</p></div></article></div><section className="panel table-wrap"><table><thead><tr><th>Guest</th><th>Booking</th><th>Amount</th><th>Status</th><th>Provider</th><th>Paid at</th></tr></thead><tbody>{payments.length ? payments.map((payment) => { const guest = usersById.get(payment.guest_id); return <tr key={payment.id}><td><div className="person-cell"><div className="avatar">{initials(guest || { email: payment.guest_id })}</div><div><strong>{guest ? `${guest.first_name || 'Guest'} ${guest.last_name || ''}`.trim() : 'Unknown guest'}</strong><small>{guest?.email || payment.guest_id}</small></div></div></td><td><strong>{payment.booking_id.slice(0, 8).toUpperCase()}</strong><br /><small>{payment.id.slice(0, 8).toUpperCase()}</small></td><td><strong>{money.format(payment.amount_cents / 100)}</strong><br /><small>{payment.currency}</small></td><td><Status value={payment.status} /></td><td>{payment.provider}<br /><small>{payment.provider_reference || 'No provider reference'}</small></td><td>{timestampLabel(payment.paid_at)}</td></tr>; }) : <tr><td colSpan="6">No hotel charges have been created yet.</td></tr>}</tbody></table></section></>;
    }

    if (view === 'housekeeping') return <><div className="page-heading"><div><p className="eyebrow">Room turnaround</p><h1>Housekeeping</h1><p>Assign rooms, track cleaning, and return inspected rooms to inventory.</p></div></div><section className="panel table-wrap"><table><thead><tr><th>Room</th><th>Status</th><th>Assigned to</th><th>Updated</th></tr></thead><tbody>{housekeeping.length ? housekeeping.map((task) => <tr key={task.id}><td><strong>{task.room_number}</strong><br /><small>{task.building || 'Main'} · Floor {task.floor}</small></td><td><select value={task.status} onChange={(e) => updateHousekeeping(task.id, { status: e.target.value })}><option value="dirty">Dirty</option><option value="cleaning">Cleaning</option><option value="clean">Clean</option>{role !== 'housekeeper' && <option value="inspected">Inspected</option>}</select></td><td>{['admin', 'manager'].includes(role) ? <select value={task.assigned_to || ''} onChange={(e) => updateHousekeeping(task.id, { assignedTo: e.target.value || null })}><option value="">Unassigned</option>{users.filter((user) => user.role === 'housekeeper' && user.active !== false).map((user) => <option key={user.id} value={user.id}>{user.first_name} {user.last_name}</option>)}</select> : (usersById.get(task.assigned_to)?.first_name || 'You')}</td><td>{timestampLabel(task.created_at)}</td></tr>) : <tr><td colSpan="4">No rooms are waiting for housekeeping.</td></tr>}</tbody></table></section></>;

    if (view === 'reports' && canViewReports) return <><div className="page-heading"><div><p className="eyebrow">Performance</p><h1>Reports</h1><p>Occupancy, reservations, revenue, guests, and housekeeping for a selected period.</p></div></div><form className="filter-bar" onSubmit={loadReports}><label>From<input name="from" type="date" defaultValue={reports?.from || tomorrow(-30)} required /></label><label>To<input name="to" type="date" defaultValue={reports?.to || tomorrow(0)} required /></label><button className="button button-primary">Run report</button></form>{reports && <><div className="stat-grid stat-grid-four"><article className="stat-card"><span><BedDouble /></span><div><strong>{reports.occupancy.occupancy_percentage}%</strong><p>Current occupancy</p></div></article><article className="stat-card"><span><CalendarDays /></span><div><strong>{reports.reservations.total_reservations}</strong><p>Reservations created</p></div></article><article className="stat-card"><span><CreditCard /></span><div><strong>{money.format(reports.revenue.payments_received_cents / 100)}</strong><p>Payments received</p></div></article><article className="stat-card"><span><Users /></span><div><strong>{reports.guests.new_guests}</strong><p>New guests</p></div></article></div><section className="panel metric-strip"><div><strong>{reports.reservations.checked_out}</strong><span>Checked out</span></div><div><strong>{reports.reservations.cancelled}</strong><span>Cancelled</span></div><div><strong>{reports.reservations.no_show}</strong><span>No shows</span></div><div><strong>{money.format(reports.revenue.refunded_cents / 100)}</strong><span>Refunded</span></div></section></>}</>;

    if (view === 'inventory') return <><div className="page-heading"><div><p className="eyebrow">Operations</p><h1>Room inventory</h1><p>Monitor lifecycle and operational readiness for every room.</p></div></div><section className="panel table-wrap"><table><thead><tr><th>Room</th><th>Type</th><th>Location</th><th>Lifecycle</th><th>Operational status</th></tr></thead><tbody>{rooms.map((room) => <tr key={room.id}><td><strong>{room.room_number}</strong></td><td>{room.type_name}</td><td>{room.building || 'Main'} · Floor {room.floor}</td><td><Status value={room.status} /></td><td><select value={room.operational_status || 'available'} onChange={(e) => setRoomStatus(room.id, e.target.value)}><option value="available">Available</option><option value="reserved">Reserved</option><option value="occupied">Occupied</option><option value="dirty">Dirty</option><option value="cleaning">Cleaning</option><option value="clean">Clean</option><option value="inspected">Inspected</option><option value="out_of_service">Out of service</option><option value="out_of_order">Out of order</option></select></td></tr>)}</tbody></table></section></>;

    if (view === 'users') return <><div className="page-heading"><div><p className="eyebrow">People</p><h1>Guests & staff</h1><p>Review guest profiles{role === 'admin' ? ' and manage staff access' : ''}.</p></div></div><section className="panel table-wrap"><table><thead><tr><th>Person</th><th>Contact</th><th>Role</th><th>Access</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><div className="person-cell"><div className="avatar">{initials(user)}</div><div><strong>{user.first_name || 'Guest'} {user.last_name || ''}</strong><small>{user.email}</small></div></div></td><td>{user.phone || '—'}<br /><small>{user.nationality || ''}</small></td><td>{role === 'admin' && user.id !== profile?.id ? <select value={user.role} onChange={(e) => setUserRole(user.id, e.target.value)}><option value="guest">Guest</option><option value="receptionist">Receptionist</option><option value="housekeeper">Housekeeper</option><option value="accountant">Accountant</option><option value="manager">Manager</option><option value="staff">Staff (legacy)</option><option value="admin">Admin</option></select> : <Status value={user.role} />}</td><td>{role === 'admin' && user.id !== profile?.id ? <button className={`button button-small ${user.active === false ? 'button-primary' : 'button-danger'}`} onClick={() => setUserActive(user.id, user.active === false)}>{user.active === false ? 'Activate' : 'Deactivate'}</button> : <Status value={user.active === false ? 'inactive' : 'active'} />}</td></tr>)}</tbody></table></section></>;

    if (view === 'settings' && role === 'admin' && hotelSettings) return <><div className="page-heading"><div><p className="eyebrow">Configuration</p><h1>Hotel settings</h1><p>Identity, tax, service charges, times, and invoice defaults.</p></div></div><section className="panel"><form className="settings-form" onSubmit={saveSettings}><div className="field-row"><label>Hotel name<input name="hotelName" defaultValue={hotelSettings.hotel_name} required /></label><label>Invoice prefix<input name="invoicePrefix" defaultValue={hotelSettings.invoice_prefix} required /></label></div><label>Address<textarea name="hotelAddress" defaultValue={hotelSettings.hotel_address || ''} rows="2" /></label><div className="field-row"><label>Phone<input name="phone" defaultValue={hotelSettings.phone || ''} /></label><label>Email<input name="email" type="email" defaultValue={hotelSettings.email || ''} /></label></div><div className="field-row"><label>Currency<input name="currency" maxLength="3" defaultValue={hotelSettings.currency} required /></label><label>Time zone<input name="timeZone" defaultValue={hotelSettings.time_zone} required /></label></div><div className="field-row"><label>Tax rate (%)<input name="taxRate" type="number" min="0" max="100" step="0.01" defaultValue={hotelSettings.tax_rate} /></label><label>Service charge (%)<input name="serviceChargeRate" type="number" min="0" max="100" step="0.01" defaultValue={hotelSettings.service_charge_rate} /></label></div><div className="field-row"><label>Check-in time<input name="checkInTime" type="time" defaultValue={hotelSettings.check_in_time?.slice(0, 5)} /></label><label>Check-out time<input name="checkOutTime" type="time" defaultValue={hotelSettings.check_out_time?.slice(0, 5)} /></label></div><button className="button button-primary">Save settings</button></form></section></>;

    if (view === 'audit' && ['admin', 'manager'].includes(role)) return <><div className="page-heading"><div><p className="eyebrow">Accountability</p><h1>Audit log</h1><p>Trace important booking, payment, access, and operational changes.</p></div></div><section className="panel table-wrap"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead><tbody>{auditLogs.map((entry) => { const actor = usersById.get(entry.actor_id); return <tr key={entry.id}><td>{timestampLabel(entry.created_at)}</td><td>{actor ? `${actor.first_name || ''} ${actor.last_name || ''}`.trim() : entry.actor_id?.slice(0, 8) || 'System'}</td><td><strong>{entry.action.replaceAll('.', ' ')}</strong></td><td>{entry.entity_type} · <small>{entry.entity_id?.slice(0, 12)}</small></td></tr>; })}</tbody></table></section></>;
    return null;
  }

  if (!session) return <div className="public-shell">
    <header className="public-header"><button className="brand" onClick={() => setView('discover')}><span><Hotel /></span><div>LUMA<small>HOTEL & RESIDENCE</small></div></button><nav><a href="#rooms">Rooms</a><a href="#experience">Experience</a><button className="button button-quiet" onClick={() => setAuthMode('login')}><LogIn size={17} /> Sign in</button><button className="button button-primary" onClick={() => setAuthMode('register')}>Create account</button></nav></header>
    <main>
      <section className="hero"><div className="hero-content"><p className="eyebrow light">A quieter kind of luxury</p><h1>Arrive curious.<br />Leave restored.</h1><p>A warm, modern stay in the heart of the city—designed around the way you actually travel.</p><div className="hero-actions"><button className="button button-gold" onClick={() => document.getElementById('rooms').scrollIntoView({ behavior: 'smooth' })}>Explore rooms <ChevronRight /></button><button className="button button-ghost" onClick={() => setAuthMode('login')}>Manage a booking</button></div></div><div className="hero-art"><div className="sun" /><div className="hotel-shape"><span /><span /><span /><span /><span /><span /></div></div></section>
      <section className="public-section intro" id="experience"><p className="eyebrow">The Luma experience</p><h2>Thoughtful stays, beautifully simple.</h2><div className="feature-grid"><article><Sparkles /><h3>Considered comfort</h3><p>Restful rooms, useful details, and nothing you don't need.</p></article><article><ShieldCheck /><h3>Book with confidence</h3><p>Clear pricing and complete control over every reservation.</p></article><article><Building2 /><h3>Here when you need us</h3><p>A connected team and timely updates throughout your stay.</p></article></div></section>
      <section className="public-section" id="rooms"><div className="section-title"><div><p className="eyebrow">Stay your way</p><h2>Rooms for every rhythm.</h2></div><p>From a quick city stop to a slow weekend away, settle into a space that fits.</p></div>{loading ? <div className="loading">Preparing rooms…</div> : <div className="room-grid">{roomTypes.map((type) => <RoomCard key={type.id} type={type} roomCount={rooms.filter((room) => room.type_id === type.id).length} onView={setSelectedRoom} />)}</div>}</section>
    </main>
    <footer><div className="brand brand-light"><span><Hotel /></span><div>LUMA<small>HOTEL & RESIDENCE</small></div></div><p>Modern hospitality, made personal.</p></footer>
    {!isStaff && selectedRoom && <RoomDetailsModal type={selectedRoom} roomCount={rooms.filter((room) => room.type_id === selectedRoom.id).length} onClose={() => setSelectedRoom(null)} onBook={startBooking} />}
    {authMode && <AuthModal mode={authMode} onClose={() => setAuthMode(null)} request={request} notify={notify} onAuthenticated={(value) => { const canBook = value.user?.role === 'guest'; storeSession(value); setAuthMode(null); if (!canBook) { setBookingType(''); setSelectedRoom(null); } setView(canBook && bookingType ? 'discover' : 'overview'); notify('Welcome to Luma.'); }} />}
    <Toast toast={toast} onClose={() => setToast(null)} />
  </div>;

  return <div className="app-shell">
    <aside className={mobileNav ? 'sidebar sidebar-open' : 'sidebar'}><div className="sidebar-top"><button className="brand brand-light"><span><Hotel /></span><div>LUMA<small>HOTEL PORTAL</small></div></button><button className="nav-close" onClick={() => setMobileNav(false)}><X /></button></div><nav>{navigation.map((item) => { const Icon = item.icon; return <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => { setView(item.id); setMobileNav(false); }}><Icon />{item.label}{item.id === 'notifications' && unread > 0 && <b>{unread}</b>}</button>; })}</nav><div className="sidebar-user"><div className="avatar">{initials(profile || session.user)}</div><div><strong>{profile?.first_name || session.user?.email}</strong><small>{role}</small></div><button onClick={signOut} title="Sign out"><LogOut /></button></div></aside>
    <main className="portal-main"><header className="portal-header"><button className="menu-button" onClick={() => setMobileNav(true)}><Menu /></button><div className="portal-crumb"><Hotel size={18} /><span>Luma Hotel</span><ChevronRight size={15} /><strong>{navigation.find((item) => item.id === view)?.label}</strong></div><button className="header-bell" onClick={() => setView('notifications')}><Bell />{unread > 0 && <b>{unread}</b>}</button></header><div className="portal-content">{renderContent()}</div></main>
    {!isStaff && selectedRoom && <RoomDetailsModal type={selectedRoom} roomCount={rooms.filter((room) => room.type_id === selectedRoom.id).length} onClose={() => setSelectedRoom(null)} onBook={startBooking} />}
    {activeFolio && <FolioModal folio={activeFolio} onClose={() => setActiveFolio(null)} onCharge={addFolioCharge} onPayment={addFolioPayment} canEdit={canFrontDesk} />}
    <Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
}

function BookingRow({ booking, payment, roomsById, typesById, onCancel, onConfirm, onPay, paying }) {
  const room = roomsById.get(booking.room_id);
  const type = typesById.get(booking.room_type_id);
  const cancellable = ['pending', 'confirmed'].includes(booking.status);
  const payable = booking.status === 'confirmed' && onPay && !['paid', 'refunded'].includes(payment?.status);
  return <article className="booking-row"><div className="booking-icon">{payment?.status === 'paid' ? <CreditCard /> : <BedDouble />}</div><div className="booking-main"><div><strong>{type?.name || room?.type_name || 'Hotel room'}</strong><Status value={booking.status} />{payment && <Status value={payment.status} />}</div><p>{dateLabel(booking.check_in)} → {dateLabel(booking.check_out)} · Room {room?.room_number || 'assigned'}</p><small>Request {booking.id.slice(0, 8).toUpperCase()}{payment ? ` · Payment ${payment.id.slice(0, 8).toUpperCase()}` : ''}</small></div><div className="booking-price"><strong>{money.format(booking.total_cents / 100)}</strong><div className="booking-actions">{booking.status === 'pending' && onConfirm && <button className="button button-primary button-small" onClick={() => onConfirm(booking.id)}>Confirm</button>}{payable && <button className="button button-primary button-small" disabled={paying} onClick={() => onPay(booking)}><CreditCard size={16} /> {paying ? 'Processing…' : payment?.status === 'failed' ? 'Retry payment' : 'Pay now'}</button>}{cancellable && <button className="button button-danger" onClick={() => onCancel(booking.id, booking.status, Boolean(onConfirm))}>{booking.status === 'pending' ? (onConfirm ? 'Reject' : 'Withdraw') : 'Cancel'}</button>}</div></div></article>;
}

function Empty({ icon: Icon, title, text, action }) {
  return <div className="empty"><span><Icon /></span><h3>{title}</h3><p>{text}</p>{action && <button className="button button-quiet" onClick={action}>Explore rooms <ChevronRight size={16} /></button>}</div>;
}

export default App;
