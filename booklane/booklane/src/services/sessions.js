'use strict';
// Sellable sessions: engagement, bridal, boudoir, anniversary, album design.
//
// Three ideas carry the whole feature:
//   1. A calendar profile is a market (Houston) or a person (the album designer). It owns a
//      login-less user row, so the existing scheduler gives it hours, blackouts and a real
//      Google/Outlook calendar for free.
//   2. A session product is an event type with kind='session' and a price in its settings.
//   3. An order is one attempt to buy. While it is 'pending' it also HOLDS the slot, so two
//      people cannot pay for the same Saturday morning. Abandoned holds expire on their own.
const db = require('../db');
const T = require('../lib/time');
const { token, hashPassword } = require('../lib/security');
const { HttpError } = require('../lib/router');
const { slugify, clampStr, int, baseUrl, deepMerge, money, isEmail } = require('../lib/util');
const { SESSION_SETTINGS, SESSION_STEPS } = require('../defaults');
const stripe = require('../lib/stripe');
const payments = require('../lib/payments');
const B = require('./business');
const L = require('./leads');
const S = require('./scheduling');
const BK = require('./bookings');

const HOLD_GRACE_MS = 60000; // keep a hold a minute past its checkout expiry, for webhook lag

// ---------- session products ----------

function sessionSettings(et) {
  const raw = db.json(et.settings, {});
  return deepMerge(SESSION_SETTINGS, raw.session || {});
}

// Idempotent on purpose: callers pass rows straight from the database (JSON strings) and rows that
// have already been through here (real objects). Re-parsing an object would throw away the settings
// and silently reset every price to zero.
function hydrate(et) {
  if (!et) return et;
  const parse = (v, fallback) => (typeof v === 'string' ? db.json(v, fallback) : (v ?? fallback));
  et.steps = parse(et.steps, []);
  et.settings = parse(et.settings, {});
  et.session = deepMerge(SESSION_SETTINGS, et.settings.session || {});
  return et;
}

function bySlug(business, slug) {
  const et = db.get("SELECT * FROM event_types WHERE business_id = ? AND slug = ? AND kind = 'session'", business.id, String(slug || ''));
  if (!et) throw new HttpError(404, 'Not found');
  if (!et.active) throw new HttpError(404, 'This session is not available right now.');
  return hydrate(et);
}

function listProducts(businessId, { includeInactive = false } = {}) {
  const rows = db.all(`SELECT * FROM event_types WHERE business_id = ? AND kind = 'session' ${includeInactive ? '' : 'AND active = 1'} ORDER BY sort, id`, businessId);
  return rows.map(hydrate);
}

// ---------- calendar profiles ----------

function listCalendars(businessId, { kind, includeInactive = false } = {}) {
  const where = ['c.business_id = ?'];
  const args = [businessId];
  if (kind) { where.push('c.kind = ?'); args.push(kind); }
  if (!includeInactive) where.push('c.active = 1');
  return db.all(`SELECT c.*, u.email user_email, u.timezone user_timezone
    FROM calendar_profiles c JOIN users u ON u.id = c.user_id
    WHERE ${where.join(' AND ')} ORDER BY c.sort, c.name`, ...args);
}

function calendarById(businessId, id) {
  return db.get('SELECT * FROM calendar_profiles WHERE business_id = ? AND id = ?', businessId, int(id, 0));
}

function calendarBySlug(businessId, slug) {
  return db.get('SELECT * FROM calendar_profiles WHERE business_id = ? AND slug = ?', businessId, String(slug || ''));
}

/** The calendars a session is offered on, in the order they should be shown. */
function calendarsForProduct(et) {
  return db.all(`SELECT c.* FROM calendar_profiles c
    JOIN event_type_hosts h ON h.user_id = c.user_id
    WHERE h.event_type_id = ? AND c.business_id = ? AND c.active = 1
    ORDER BY c.sort, c.name`, et.id, et.business_id);
}

function uniqueCalendarSlug(businessId, base) {
  let slug = slugify(base) || 'calendar';
  let s = slug;
  let i = 2;
  while (db.get('SELECT 1 FROM calendar_profiles WHERE business_id = ? AND slug = ?', businessId, s)) s = `${slug}-${i++}`;
  return s;
}

/**
 * Create a calendar. The user row behind it cannot log in: it gets a random unusable password and
 * is_resource = 1, which the login route refuses. It exists purely to own hours and a calendar link.
 */
function createCalendar(business, { name, kind = 'market', timezone, blurb, hours } = {}) {
  const label = clampStr(String(name || '').trim(), 80);
  if (!label) throw new HttpError(422, 'Give the calendar a name', { name: 'Required' });
  const tz = T.isValidTz(timezone) ? timezone : business.timezone;
  const slug = uniqueCalendarSlug(business.id, label);
  return db.tx(() => {
    // A reserved, non-routable address so it can never collide with a real person's email.
    const email = `calendar+${business.slug}-${slug}@booklane.invalid`;
    let user = db.get('SELECT * FROM users WHERE email = ?', email);
    if (!user) {
      const { lastId } = db.run('INSERT INTO users (email, name, password_hash, timezone, is_resource) VALUES (?,?,?,?,1)',
        email, label, `disabled:${token(16)}`, tz);
      user = db.get('SELECT * FROM users WHERE id = ?', lastId);
    }
    if (!db.get('SELECT 1 FROM memberships WHERE user_id = ? AND business_id = ?', user.id, business.id)) {
      db.run("INSERT INTO memberships (user_id, business_id, role, status) VALUES (?,?,'host','active')", user.id, business.id);
    }
    const sort = (db.get('SELECT MAX(sort) m FROM calendar_profiles WHERE business_id = ?', business.id) || {}).m || 0;
    const { lastId } = db.run('INSERT INTO calendar_profiles (business_id, user_id, kind, slug, name, blurb, timezone, sort) VALUES (?,?,?,?,?,?,?,?)',
      business.id, user.id, kind === 'person' ? 'person' : 'market', slug, label, clampStr(blurb, 300), tz, sort + 1);
    // Weekends matter for photography, so seed something sane rather than Mon-Fri 9-5.
    const week = hours || [[0, 12 * 60, 19 * 60], [5, 15 * 60, 20 * 60], [6, 8 * 60, 19 * 60]];
    for (const [wd, start, end] of week) db.run('INSERT INTO availability_rules (user_id, weekday, start_min, end_min) VALUES (?,?,?,?)', user.id, wd, start, end);
    return db.get('SELECT * FROM calendar_profiles WHERE id = ?', lastId);
  });
}

function updateCalendar(business, id, patch = {}) {
  const cal = calendarById(business.id, id);
  if (!cal) throw new HttpError(404, 'Not found');
  const name = patch.name !== undefined ? clampStr(String(patch.name).trim(), 80) : cal.name;
  if (!name) throw new HttpError(422, 'Give the calendar a name', { name: 'Required' });
  const tz = patch.timezone !== undefined && T.isValidTz(patch.timezone) ? patch.timezone : cal.timezone;
  db.run('UPDATE calendar_profiles SET name = ?, blurb = ?, timezone = ?, active = ?, sort = ? WHERE id = ?',
    name, patch.blurb !== undefined ? clampStr(patch.blurb, 300) : cal.blurb, tz,
    patch.active !== undefined ? (patch.active ? 1 : 0) : cal.active,
    patch.sort !== undefined ? int(patch.sort, cal.sort) : cal.sort, cal.id);
  // The scheduler reads the timezone off the user row, so keep the two in step.
  if (tz !== cal.timezone) db.run('UPDATE users SET timezone = ? WHERE id = ?', tz, cal.user_id);
  if (patch.name !== undefined) db.run('UPDATE users SET name = ? WHERE id = ?', name, cal.user_id);
  return calendarById(business.id, cal.id);
}

function setProductCalendars(business, et, calendarIds) {
  const wanted = (Array.isArray(calendarIds) ? calendarIds : []).map((x) => int(x, 0)).filter(Boolean);
  const valid = wanted.filter((id) => calendarById(business.id, id));
  db.tx(() => {
    // Only clear the hosts that are calendars, so a human host attached by hand survives.
    const calUsers = db.all('SELECT user_id FROM calendar_profiles WHERE business_id = ?', business.id).map((r) => r.user_id);
    for (const uid of calUsers) db.run('DELETE FROM event_type_hosts WHERE event_type_id = ? AND user_id = ?', et.id, uid);
    for (const id of valid) {
      const cal = calendarById(business.id, id);
      if (cal) db.run('INSERT OR IGNORE INTO event_type_hosts (event_type_id, user_id) VALUES (?,?)', et.id, cal.user_id);
    }
  });
  return calendarsForProduct(et);
}

// ---------- slot holds ----------

/**
 * Busy intervals from orders that are mid-payment. Returned in the same [startMs, endMs] shape
 * the scheduler already uses for external calendar busy time.
 */
function holdBusy(hostUserId, fromMs, toMs, { excludeOrderId } = {}) {
  const rows = db.all(`SELECT id, hold_start_utc, hold_end_utc FROM orders
    WHERE hold_host_user_id = ? AND status = 'pending' AND hold_expires_at > ?
      AND hold_end_utc > ? AND hold_start_utc < ?`,
  hostUserId, Date.now(), new Date(fromMs - 86400000).toISOString(), new Date(toMs + 86400000).toISOString());
  return rows.filter((r) => r.id !== excludeOrderId && r.hold_start_utc && r.hold_end_utc)
    .map((r) => [Date.parse(r.hold_start_utc), Date.parse(r.hold_end_utc)]);
}

function releaseExpiredHolds() {
  const { changes } = db.run("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND hold_expires_at IS NOT NULL AND hold_expires_at < ?", Date.now());
  return changes;
}

// ---------- orders ----------

function orderByToken(t) {
  return db.get('SELECT * FROM orders WHERE token = ?', String(t || ''));
}

function publicOrder(order) {
  const booking = order.booking_id ? db.get('SELECT token FROM bookings WHERE id = ?', order.booking_id) : null;
  return {
    token: order.token,
    status: order.status,
    product_name: order.product_name,
    amount: order.amount_cents / 100,
    amount_display: money(order.amount_cents / 100, order.currency),
    currency: order.currency,
    already_booked: !!order.already_booked,
    booking_number: order.booking_number || '',
    start: order.hold_start_utc,
    timezone: order.invitee_tz,
    booking_token: booking ? booking.token : null,
    redirect: booking ? `/booking/${booking.token}?new=1` : null,
    receipt_url: order.provider_receipt_url || null,
    error: order.last_error || null,
  };
}

function publicSession(et, business) {
  const cals = calendarsForProduct(et);
  const s = et.session;
  const contact = (et.steps || []).find((x) => x.type === 'contact');
  return {
    slug: et.slug,
    name: et.name,
    description: et.description || '',
    duration_min: et.duration_min,
    price: s.price_cents / 100,
    price_display: money(s.price_cents / 100, s.currency),
    price_cents: s.price_cents,
    currency: s.currency,
    payable: s.price_cents > 0 && payments.configured(business.id),
    payments_ready: payments.configured(business.id),
    calendars: cals.map((c) => ({ slug: c.slug, name: c.name, blurb: c.blurb || '' })),
    labels: {
      choose_label: s.choose_label, choose_hint: s.choose_hint,
      booked_question: s.booked_question, booked_yes_label: s.booked_yes_label, booked_no_label: s.booked_no_label,
      booking_number_label: s.booking_number_label, booking_number_hint: s.booking_number_hint,
      price_heading: s.price_heading || et.name, price_blurb: s.price_blurb, includes: s.includes,
      pay_cta: s.pay_cta, free_cta: s.free_cta, booked_note: s.booked_note, paid_note: s.paid_note,
    },
    ask_booking_number: !!s.ask_booking_number,
    booking_number_required: !!s.booking_number_required,
    contact_fields: contact?.fields || { first_name: 'required', email: 'required' },
    questions: (et.steps || []).filter((x) => x.type === 'questions'),
    timezone: business.timezone,
  };
}

function resolveCalendar(business, et, slug) {
  const cals = calendarsForProduct(et);
  if (!cals.length) throw new HttpError(409, 'This session has no calendar set up yet.');
  if (cals.length === 1 && !slug) return cals[0];
  const found = cals.find((c) => c.slug === String(slug || ''));
  if (!found) throw new HttpError(422, 'Pick a location first', { calendar: 'Required' });
  return found;
}

function normalizeBookingNumber(v) {
  return clampStr(String(v || '').trim().replace(/\s+/g, ' ').toUpperCase(), 60);
}

/**
 * Everything both branches need: a validated slot on a specific calendar, plus a lead.
 * Throws 409 if the slot went while they were filling the form.
 */
async function prepare(business, et, body) {
  const cal = resolveCalendar(business, et, body.calendar);
  const startMs = Date.parse(body.start);
  if (!Number.isFinite(startMs)) throw new HttpError(422, 'Pick a time first', { start: 'Required' });
  const tz = T.isValidTz(body.timezone) ? body.timezone : business.timezone;
  const contact = body.contact && typeof body.contact === 'object' ? body.contact : {};
  if (!isEmail(contact.email)) throw new HttpError(422, 'Please fix the highlighted fields', { email: 'Enter a valid email' });

  const hosts = await S.availableHostsAt(et, startMs, { restrictHostIds: [cal.user_id] });
  if (!hosts.includes(cal.user_id)) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another time.');

  let lead = body.lead_token ? L.byToken(body.lead_token) : null;
  if (lead && lead.business_id !== business.id) lead = null;
  if (!lead) lead = L.createLead(business, { source: 'booking', eventTypeId: et.id, meta: { session: et.slug, calendar: cal.slug } });
  return { cal, startMs, endMs: startMs + et.duration_min * 60000, tz, contact, lead };
}

/**
 * Booking without taking a card. Two cases reach here:
 *   - they already paid elsewhere, and give us a booking number;
 *   - the session costs nothing, so there is nothing to charge.
 *
 * The free case is only allowed when the session really has no price. Without that check a
 * customer could post already_booked=false at this endpoint and skip paying for a $495 shoot.
 */
async function claimBooked(business, et, body, { alreadyBooked = true } = {}) {
  const s = et.session;
  if (!alreadyBooked && s.price_cents > 0) throw new HttpError(402, 'This session has to be paid for first.');
  const { cal, startMs, tz, contact, lead } = await prepare(business, et, body);
  const number = alreadyBooked ? normalizeBookingNumber(body.booking_number) : null;
  if (alreadyBooked && s.ask_booking_number && s.booking_number_required && !number) {
    throw new HttpError(422, 'Please fix the highlighted fields', { booking_number: `${s.booking_number_label} is required` });
  }
  const answers = L.sanitizeAnswers(body.answers || {});
  answers.session = et.name;
  answers.location = cal.name;
  if (number) answers.booking_number = number;
  answers.payment = alreadyBooked ? 'Already booked — needs matching to their file' : 'No charge';

  const t = token(20);
  const orderId = db.run(`INSERT INTO orders (business_id, token, event_type_id, calendar_profile_id, lead_id, product_name,
      amount_cents, currency, status, provider, customer_name, customer_email, customer_phone, already_booked, booking_number,
      hold_host_user_id, hold_start_utc, hold_end_utc, invitee_tz, answers)
    VALUES (?,?,?,?,?,?,?,?,'not_required','none',?,?,?,?,?,?,?,?,?,?)`,
  business.id, t, et.id, cal.id, lead.id, et.name, 0, et.session.currency,
  clampStr([contact.first_name, contact.last_name].filter(Boolean).join(' '), 160), String(contact.email).trim().toLowerCase(), clampStr(contact.phone, 40),
  alreadyBooked ? 1 : 0, number, cal.user_id, new Date(startMs).toISOString(), new Date(startMs + et.duration_min * 60000).toISOString(), tz, JSON.stringify(answers)).lastId;

  const booking = await BK.createBooking({
    business, et, startIso: new Date(startMs).toISOString(), tz, contact, answers, lead,
    restrictHostIds: [cal.user_id], excludeOrderId: orderId,
  });
  db.run('UPDATE orders SET booking_id = ? WHERE id = ?', booking.id, orderId);
  B.logActivity(business.id, lead.id, 'booking', `${et.name} scheduled in ${cal.name}${number ? ` against booking ${number}` : ''}${alreadyBooked ? ' (already paid)' : ' (no charge)'}`, { booking_id: booking.id });
  return { order: db.get('SELECT * FROM orders WHERE id = ?', orderId), booking };
}

/**
 * The buy branch: hold the slot, then hand back a Stripe Checkout URL.
 * The hold and the conflict check happen in one transaction so two simultaneous buyers cannot
 * both walk away thinking they own the time.
 */
async function startCheckout(business, et, body) {
  const { cal, startMs, endMs, tz, contact, lead } = await prepare(business, et, body);
  const s = et.session;
  if (!(s.price_cents > 0)) throw new HttpError(409, 'This session has no price set yet.');
  if (!payments.configured(business.id)) throw new HttpError(503, 'Card payments are not switched on yet. Please call us and we will book it for you.');

  const holdMs = Math.max(10, Math.min(180, int(s.hold_minutes, 30))) * 60000;
  const expiresAt = Date.now() + holdMs;
  const answers = L.sanitizeAnswers(body.answers || {});
  answers.session = et.name;
  answers.location = cal.name;

  const t = token(20);
  const name = clampStr([contact.first_name, contact.last_name].filter(Boolean).join(' '), 160);
  const email = String(contact.email).trim().toLowerCase();

  const orderId = db.tx(() => {
    const conflict = holdBusy(cal.user_id, startMs, endMs).some(([hs, he]) => hs < endMs && he > startMs);
    if (conflict) throw new HttpError(409, 'Someone is paying for that time right now. Please pick another time.');
    const taken = db.get(`SELECT 1 FROM bookings WHERE host_user_id = ? AND status = 'confirmed' AND end_utc > ? AND start_utc < ?`,
      cal.user_id, new Date(startMs).toISOString(), new Date(endMs).toISOString());
    if (taken) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another time.');
    return db.run(`INSERT INTO orders (business_id, token, event_type_id, calendar_profile_id, lead_id, product_name,
        amount_cents, currency, status, provider, customer_name, customer_email, customer_phone,
        hold_host_user_id, hold_start_utc, hold_end_utc, hold_expires_at, invitee_tz, answers)
      VALUES (?,?,?,?,?,?,?,?,'pending','stripe',?,?,?,?,?,?,?,?,?)`,
    business.id, t, et.id, cal.id, lead.id, et.name, s.price_cents, s.currency,
    name, email, clampStr(contact.phone, 40),
    cal.user_id, new Date(startMs).toISOString(), new Date(endMs).toISOString(), expiresAt, tz, JSON.stringify(answers)).lastId;
  });

  L.updateLead(lead, { contact, answers });

  const when = T.formatDateTime(startMs, tz);
  try {
    const checkout = await payments.createCheckout(business, {
      amountCents: s.price_cents,
      items: [{ label: `${et.name} — ${cal.name}`, detail: `${when} (${tz})`, unit_cents: s.price_cents, qty: 1 }],
      currency: s.currency,
      productName: `${et.name} — ${cal.name}`,
      description: `${when} (${tz})`,
      customerEmail: email,
      referenceId: t,
      metadata: { business_id: String(business.id), event_type: et.slug, calendar: cal.slug },
      successUrl: `${baseUrl()}/session/${t}?paid=1`,
      cancelUrl: `${baseUrl()}/b/${business.slug}/s/${et.slug}?cancelled=${t}`,
      expiresAt,
      idempotencyKey: `order-${t}`,
    });
    db.run('UPDATE orders SET provider = ?, provider_session_id = ? WHERE id = ?', checkout.provider, checkout.orderId || checkout.id, orderId);
    B.logActivity(business.id, lead.id, 'booking', `Started checkout for ${et.name} in ${cal.name} at ${when}`);
    return { order_token: t, checkout_url: checkout.url };
  } catch (e) {
    // Never leave a hold behind for a checkout that was never created.
    db.run("UPDATE orders SET status = 'failed', last_error = ? WHERE id = ?", clampStr(e.message, 300), orderId);
    // Whichever provider refused, the customer gets the same plain sentence.
    const square = require('../lib/square');
    if (e instanceof stripe.StripeError || e instanceof square.SquareError) throw new HttpError(502, 'We could not start the payment. Please try again, or call us and we will book it for you.');
    throw e;
  }
}

/**
 * Turn a paid order into a booking. Safe to call more than once and from two places at once:
 * the webhook and the return-from-Stripe page both call it, and whichever arrives first wins.
 */
async function finalizeOrder(order, { paymentIntent, receiptUrl, amountPaidCents } = {}) {
  const fresh = db.get('SELECT * FROM orders WHERE id = ?', order.id);
  if (!fresh) throw new HttpError(404, 'Not found');
  if (fresh.booking_id) return { order: fresh, booking: db.get('SELECT * FROM bookings WHERE id = ?', fresh.booking_id), already: true };
  if (fresh.status === 'cancelled') throw new HttpError(409, 'That order was cancelled.');

  // Claim the order first, so a second caller sees it is taken and bails out above.
  const claimed = db.run("UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, datetime('now')), provider_payment_intent = COALESCE(?, provider_payment_intent), provider_receipt_url = COALESCE(?, provider_receipt_url) WHERE id = ? AND booking_id IS NULL AND status IN ('pending','paid')", paymentIntent || null, receiptUrl || null, fresh.id);
  if (!claimed.changes) {
    const after = db.get('SELECT * FROM orders WHERE id = ?', fresh.id);
    return { order: after, booking: after.booking_id ? db.get('SELECT * FROM bookings WHERE id = ?', after.booking_id) : null, already: true };
  }

  const business = B.byId(fresh.business_id);
  const et = hydrate(db.get('SELECT * FROM event_types WHERE id = ?', fresh.event_type_id));
  const cal = fresh.calendar_profile_id ? db.get('SELECT * FROM calendar_profiles WHERE id = ?', fresh.calendar_profile_id) : null;
  const lead = fresh.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', fresh.lead_id) : null;
  if (!et || !cal) {
    db.run("UPDATE orders SET last_error = ? WHERE id = ?", 'The session or calendar was deleted after payment', fresh.id);
    throw new HttpError(409, 'We took your payment but the session setup changed. We will call you to book your time.');
  }

  const answers = db.json(fresh.answers, {});
  answers.session = et.name;
  answers.location = cal.name;
  answers.payment = `Paid ${money((amountPaidCents ?? fresh.amount_cents) / 100, fresh.currency)}`;
  if (receiptUrl) answers.receipt = receiptUrl;

  const [first, ...rest] = String(fresh.customer_name || '').split(' ');
  const contact = { first_name: first || '', last_name: rest.join(' '), email: fresh.customer_email, phone: fresh.customer_phone };

  try {
    const booking = await BK.createBooking({
      business, et, startIso: fresh.hold_start_utc, tz: fresh.invitee_tz, contact, answers,
      lead, restrictHostIds: [cal.user_id], excludeOrderId: fresh.id, force: true,
    });
    db.run('UPDATE orders SET booking_id = ?, last_error = NULL WHERE id = ?', booking.id, fresh.id);
    if (lead) B.logActivity(business.id, lead.id, 'booking', `Paid ${money(fresh.amount_cents / 100, fresh.currency)} for ${et.name} in ${cal.name}`, { booking_id: booking.id });
    return { order: db.get('SELECT * FROM orders WHERE id = ?', fresh.id), booking };
  } catch (e) {
    // They paid. Record why the booking failed rather than losing it; staff can place it by hand.
    db.run('UPDATE orders SET last_error = ? WHERE id = ?', clampStr(`Paid but not booked: ${e.message}`, 300), fresh.id);
    if (lead) B.logActivity(business.id, lead.id, 'booking', `Payment took but the slot could not be booked: ${e.message}`);
    throw e;
  }
}

/**
 * Handle one already-verified event from either provider.
 *
 * The signature was checked before we got here. Everything below reads the event through the
 * payments layer, so Stripe and Square arrive in the same shape and only the matching differs.
 */
async function handleStripeEvent(event, { provider = 'stripe', business } = {}) {
  const payments = require('../lib/payments');
  const eventId = String(event.id || event.event_id || '');
  const seen = db.run('INSERT OR IGNORE INTO provider_events (provider, event_id, kind) VALUES (?,?,?)', provider, eventId, String(event.type || ''));
  if (!seen.changes) return 'duplicate';

  const obj = event.data?.object || {};
  // The Integrations screen's connection test pays a real dollar with no booking behind it.
  // Record the result and stop, rather than hunting for an order that was never created.
  if (obj.metadata && obj.metadata.diagnostic === '1') {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      return require('./providers').recordDiagnostic(event, obj);
    }
    return 'connection test event ignored';
  }
  // From here on the event is read through the payments layer, so Stripe and Square look the same.
  const read = await payments.readEvent(provider, event, business);
  const findOrder = () => {
    if (read.referenceId) { const o = orderByToken(read.referenceId); if (o) return o; }
    if (read.sessionId) { const o = db.get('SELECT * FROM orders WHERE provider_session_id = ?', read.sessionId); if (o) return o; }
    if (read.paymentId) return db.get('SELECT * FROM orders WHERE provider_payment_intent = ?', read.paymentId);
    return null;
  };

  if (read.kind === 'paid') {
    const order = findOrder();
    if (!order) return 'no matching order';
    // A product order has no slot waiting to be confirmed: record the payment and hand back a
    // scheduling link instead of trying to create a booking nobody has picked a time for.
    if (order.order_kind === 'product') {
      await require('./products').markPaid(order, { paymentIntent: read.paymentId, receiptUrl: read.receiptUrl, amountPaidCents: read.amountCents });
      return 'paid';
    }
    await finalizeOrder(order, { paymentIntent: read.paymentId, receiptUrl: read.receiptUrl, amountPaidCents: read.amountCents });
    return 'booked';
  }
  if (read.kind === 'expired' || read.kind === 'failed') {
    const order = findOrder();
    if (!order || order.booking_id) return 'nothing to release';
    db.run("UPDATE orders SET status = ?, hold_expires_at = 0 WHERE id = ? AND status = 'pending'", read.kind, order.id);
    return order.order_kind === 'product' ? 'order abandoned' : 'hold released';
  }
  if (read.kind === 'refunded') {
    if (read.paymentId) db.run("UPDATE orders SET status = 'refunded' WHERE provider_payment_intent = ?", read.paymentId);
    return 'refund recorded';
  }
  return read.kind === 'pending' ? `not paid yet (${read.status || 'pending'})` : 'ignored';
}

/**
 * Called when the customer lands back on our success URL. The webhook is the source of truth, but
 * it can be a second or two behind, so ask Stripe directly rather than making them stare at a spinner.
 */
async function reconcileOrder(order) {
  if (order.booking_id) return publicOrder(db.get('SELECT * FROM orders WHERE id = ?', order.id));
  if (order.provider_session_id) {
    try {
      const business = B.byId(order.business_id);
      const look = await payments.lookupCheckout(business, order);
      if (look.paid) {
        const receipt = look.receiptUrl || look.raw?.payment_intent?.charges?.data?.[0]?.receipt_url || null;
        await finalizeOrder(order, { paymentIntent: look.paymentId, receiptUrl: receipt, amountPaidCents: look.amountCents });
      } else if (look.raw && look.raw.status === 'expired') {
        db.run("UPDATE orders SET status = 'expired', hold_expires_at = 0 WHERE id = ? AND status = 'pending'", order.id);
      }
    } catch (e) {
      if (!(e instanceof HttpError)) db.run('UPDATE orders SET last_error = ? WHERE id = ?', clampStr(e.message, 300), order.id);
    }
  }
  return publicOrder(db.get('SELECT * FROM orders WHERE id = ?', order.id));
}

// ---------- admin listing ----------

function listOrders(businessId, { status, limit = 100, offset = 0, eventTypeId } = {}) {
  const where = ['o.business_id = ?'];
  const args = [businessId];
  if (status) { where.push('o.status = ?'); args.push(status); }
  if (eventTypeId) { where.push('o.event_type_id = ?'); args.push(int(eventTypeId, 0)); }
  const rows = db.all(`SELECT o.*, c.name calendar_name, bk.token booking_token, bk.start_utc booking_start, bk.status booking_status, l.token lead_token
    FROM orders o
    LEFT JOIN calendar_profiles c ON c.id = o.calendar_profile_id
    LEFT JOIN bookings bk ON bk.id = o.booking_id
    LEFT JOIN leads l ON l.id = o.lead_id
    WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, ...args, int(limit, 100, 1, 500), int(offset, 0, 0));
  const total = db.get(`SELECT COUNT(*) c FROM orders o WHERE ${where.join(' AND ')}`, ...args).c;
  return {
    total,
    rows: rows.map((o) => ({
      token: o.token, status: o.status, product_name: o.product_name, calendar: o.calendar_name,
      amount: o.amount_cents / 100, amount_display: money(o.amount_cents / 100, o.currency),
      already_booked: !!o.already_booked, booking_number: o.booking_number || '',
      customer_name: o.customer_name, customer_email: o.customer_email, customer_phone: o.customer_phone,
      start: o.booking_start || o.hold_start_utc, timezone: o.invitee_tz,
      booking_token: o.booking_token, booking_status: o.booking_status, lead_token: o.lead_token,
      receipt_url: o.provider_receipt_url, error: o.last_error, paid_at: o.paid_at, created_at: o.created_at,
    })),
  };
}

function revenueSummary(businessId, sinceDays = 30) {
  const since = new Date(Date.now() - Math.max(1, sinceDays) * 86400000).toISOString();
  const r = db.get(`SELECT COUNT(*) c, COALESCE(SUM(amount_cents),0) cents FROM orders
    WHERE business_id = ? AND status = 'paid' AND created_at >= ?`, businessId, since) || { c: 0, cents: 0 };
  const pending = db.get("SELECT COUNT(*) c FROM orders WHERE business_id = ? AND status = 'pending' AND hold_expires_at > ?", businessId, Date.now()).c;
  const claimed = db.get(`SELECT COUNT(*) c FROM orders WHERE business_id = ? AND already_booked = 1 AND created_at >= ?`, businessId, since).c;
  const stuck = db.get("SELECT COUNT(*) c FROM orders WHERE business_id = ? AND status = 'paid' AND booking_id IS NULL", businessId).c;
  return { paid_count: r.c, paid_total: r.cents / 100, pending, already_booked: claimed, paid_but_unbooked: stuck };
}

module.exports = {
  sessionSettings, hydrate, bySlug, listProducts, publicSession,
  listCalendars, calendarById, calendarBySlug, calendarsForProduct, createCalendar, updateCalendar, setProductCalendars, uniqueCalendarSlug, resolveCalendar,
  holdBusy, releaseExpiredHolds,
  orderByToken, publicOrder, prepare, claimBooked, startCheckout, finalizeOrder, handleStripeEvent, reconcileOrder,
  listOrders, revenueSummary, SESSION_STEPS,
};
