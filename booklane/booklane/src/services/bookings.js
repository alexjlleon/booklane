'use strict';
const db = require('../db');
const T = require('../lib/time');
const { token } = require('../lib/security');
const { HttpError } = require('../lib/router');
const { isEmail, baseUrl, esc, clampStr } = require('../lib/util');
const { sendEmail, layout, rows } = require('../lib/email');
const { buildIcs, googleCalendarLink } = require('../lib/ics');
const { LOCATION_TYPES } = require('../defaults');
const B = require('./business');
const L = require('./leads');
const S = require('./scheduling');
const calendars = require('./calendars');
const { sendWebhook } = require('./integrations');

function hydrateEt(et) {
  if (!et) return et;
  et.steps = db.json(et.steps, []);
  et.settings = db.json(et.settings, {});
  return et;
}

function contactStep(et) { return (et.steps || []).find((s) => s.type === 'contact'); }

function validateContact(et, contact, business) {
  const cfg = contactStep(et)?.fields || { first_name: 'required', email: 'required' };
  const errors = {};
  const need = (f) => cfg[f] === 'required';
  if (need('first_name') && !String(contact.first_name || '').trim()) errors.first_name = 'Required';
  if (need('last_name') && !String(contact.last_name || '').trim()) errors.last_name = 'Required';
  if (!isEmail(contact.email)) errors.email = 'Enter a valid email';
  if (need('phone') && String(contact.phone || '').replace(/\D/g, '').length < 7) errors.phone = 'Enter a valid phone number';
  if (Object.keys(errors).length) throw new HttpError(422, 'Please fix the highlighted fields', errors);
}

function locationText(et, contact, joinUrl) {
  switch (et.location_type) {
    case 'phone': return contact.phone ? `Phone call: we will call you at ${contact.phone}` : 'Phone call';
    case 'google_meet': case 'teams': return joinUrl || `${LOCATION_TYPES[et.location_type]} (link will be sent)`;
    default: return et.location_value || LOCATION_TYPES[et.location_type] || '';
  }
}

function bookingView(b) {
  const et = hydrateEt(db.get('SELECT * FROM event_types WHERE id = ?', b.event_type_id));
  const business = B.byId(b.business_id);
  const host = b.host_user_id ? db.get('SELECT id, name, email FROM users WHERE id = ?', b.host_user_id) : null;
  return { b, et, business, host };
}

async function sendBookingEmails(kind, booking) {
  const { b, et, business, host } = bookingView(booking);
  const tz = b.invitee_tz || business.timezone;
  const start = Date.parse(b.start_utc), end = Date.parse(b.end_utc);
  const when = T.formatDateTime(start, tz);
  const manage = `${baseUrl()}/booking/${b.token}`;
  const summary = `${et?.name || 'Call'} with ${business.name}`;
  const answers = db.json(b.answers, {});
  const ics = buildIcs({ uid: `booking-${b.id}-${b.token.slice(0, 8)}@booklane`, start, end, summary, description: `Manage: ${manage}`, location: b.location,
    organizerName: business.name, organizerEmail: host?.email, attendeeName: b.name, attendeeEmail: b.email, cancelled: kind === 'cancelled', sequence: kind === 'rescheduled' ? 1 : kind === 'cancelled' ? 2 : 0 });
  const headings = { created: `You're booked, ${esc((b.name || '').split(' ')[0])}!`, rescheduled: 'Your call was rescheduled', cancelled: 'Your call was cancelled' };
  await sendEmail({
    to: b.email, businessId: business.id, fromName: business.name, replyTo: host?.email || business.email,
    subject: kind === 'cancelled' ? `Cancelled: ${summary}` : kind === 'rescheduled' ? `Rescheduled: ${summary} on ${when}` : `Confirmed: ${summary} on ${when}`,
    html: layout(business, {
      heading: headings[kind],
      body: rows([['What', summary], ['When', when], ['Where', b.location], ['With', host?.name]]) +
        (kind !== 'cancelled' ? `<p>Need to make a change? <a href="${manage}">Reschedule or cancel</a>. <a href="${googleCalendarLink({ start, end, summary, location: b.location, description: manage })}">Add to Google Calendar</a>.</p>` : ''),
      cta: kind === 'cancelled' ? { label: 'Book a new time', url: `${baseUrl()}/b/${business.slug}/${et?.slug || ''}` } : null,
    }),
    attachments: [{ filename: 'invite.ics', content: ics }],
  });
  const team = new Set(B.teamEmails(business));
  if (host?.email) team.add(host.email);
  if (business.settings.notifications.notify_on_booking || kind !== 'created') {
    await sendEmail({
      to: [...team], businessId: business.id,
      subject: `${kind === 'created' ? 'New booking' : kind === 'rescheduled' ? 'Rescheduled' : 'Cancelled'}: ${b.name} · ${T.formatDateTime(start, business.timezone, { weekday: 'short', month: 'short', year: undefined })}`,
      html: layout(business, {
        heading: kind === 'created' ? 'New call booked' : kind === 'rescheduled' ? 'A call was rescheduled' : 'A call was cancelled',
        body: rows([['Event', et?.name], ['When', T.formatDateTime(start, business.timezone)], ['Host', host?.name], ['Name', b.name], ['Email', b.email], ['Phone', b.phone], ['Location', b.location],
          ['Reason', b.cancel_reason], ...L.answersToPairs(answers)]),
        cta: { label: 'Open in dashboard', url: `${baseUrl()}/app#/bookings` },
      }),
      attachments: [{ filename: 'invite.ics', content: ics }],
    });
  }
}

// Must run inside db.tx: re-checks the host's calendar in the database right before writing
function assertFree(et, hostId, startMs, endMs, excludeId = 0) {
  const clash = db.get(`SELECT b.id FROM bookings b LEFT JOIN event_types e ON e.id = b.event_type_id WHERE b.host_user_id = ? AND b.status = 'confirmed' AND b.id != ?
    AND datetime(b.start_utc, '-' || MAX(COALESCE(e.buffer_before,0), ?) || ' minutes') < datetime(?) AND datetime(b.end_utc, '+' || MAX(COALESCE(e.buffer_after,0), ?) || ' minutes') > datetime(?)`,
  hostId, excludeId, et.buffer_after, new Date(endMs).toISOString(), et.buffer_before, new Date(startMs).toISOString());
  if (clash) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another time.');
  if (et.daily_limit > 0) {
    const host = db.get('SELECT timezone FROM users WHERE id = ?', hostId);
    const tz = T.isValidTz(host?.timezone) ? host.timezone : 'UTC';
    const day = T.utcToZoned(startMs, tz).date;
    const n = db.get("SELECT COUNT(*) c FROM bookings WHERE host_user_id = ? AND event_type_id = ? AND status = 'confirmed' AND id != ? AND start_utc >= ? AND start_utc < ?",
      hostId, et.id, excludeId, new Date(T.zonedToUtc(day, 0, tz)).toISOString(), new Date(T.zonedToUtc(T.addDays(day, 1), 0, tz)).toISOString()).c;
    if (n >= et.daily_limit) throw new HttpError(409, 'Sorry, that day just filled up. Please pick another day.');
  }
}

async function createBooking({ business, et, startIso, tz, contact = {}, answers = {}, lead, quote }) {
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) throw new HttpError(400, 'Pick a valid time');
  if (!T.isValidTz(tz)) tz = business.timezone;
  validateContact(et, contact, business);
  const hosts = await S.availableHostsAt(et, startMs);
  if (!hosts.length) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another time.');
  const hostId = S.pickHost(et, hosts);
  const endMs = startMs + et.duration_min * 60000;
  const name = [contact.first_name, contact.last_name].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  const cleanAnswers = L.sanitizeAnswers(answers);
  const t = token(18);

  const bookingId = db.tx(() => {
    assertFree(et, hostId, startMs, endMs);
    return db.run(`INSERT INTO bookings (business_id, event_type_id, host_user_id, lead_id, quote_id, token, start_utc, end_utc, invitee_tz, name, email, phone, location, answers)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, business.id, et.id, hostId, lead?.id, quote?.id, t, new Date(startMs).toISOString(), new Date(endMs).toISOString(), tz,
    clampStr(name, 160), String(contact.email).trim().toLowerCase(), clampStr(contact.phone, 40), locationText(et, contact), JSON.stringify(cleanAnswers)).lastId;
  });

  const host = db.get('SELECT name FROM users WHERE id = ?', hostId);
  const ext = await calendars.createEvent(hostId, {
    summary: `${et.name}: ${name || contact.email}`, start: startMs, end: endMs, attendeeEmail: contact.email, attendeeName: name, timezone: tz,
    location: locationText(et, contact), locationType: et.location_type,
    description: [`Booked via ${business.name}`, contact.phone ? `Phone: ${contact.phone}` : '', ...L.answersToPairs(cleanAnswers).map(([k, v]) => `${k}: ${v}`),
      quote ? `Quote: ${baseUrl()}/q/${quote.token}` : '', `Manage: ${baseUrl()}/app#/bookings`].filter(Boolean).join('\n'),
  });
  if (ext) db.run('UPDATE bookings SET external_events = ?, location = ? WHERE id = ?', JSON.stringify([ext]), locationText(et, contact, ext.join_url), bookingId);

  if (lead) {
    L.updateLead(lead, { contact, answers: cleanAnswers });
    L.setStatus(lead, 'booked', { complete: true });
    B.logActivity(business.id, lead.id, 'booking', `Booked ${et.name} for ${T.formatDateTime(startMs, business.timezone)} with ${host?.name}`, { booking_id: bookingId });
  }
  const booking = db.get('SELECT * FROM bookings WHERE id = ?', bookingId);
  sendBookingEmails('created', booking).catch((e) => console.error('[booking email]', e));
  const payload = { booking: bookingPayload(booking), lead: lead ? L.leadPayload(db.get('SELECT * FROM leads WHERE id = ?', lead.id)) : null };
  sendWebhook(business, 'booking.created', payload, lead?.id).then(() => lead && sendWebhook(business, 'lead.completed', payload.lead, lead.id)).catch((e) => console.error('[webhook]', e));
  return booking;
}

function bookingPayload(b) {
  return { id: b.id, token: b.token, status: b.status, start: b.start_utc, end: b.end_utc, timezone: b.invitee_tz, name: b.name, email: b.email, phone: b.phone,
    location: b.location, answers: db.json(b.answers, {}), event_type_id: b.event_type_id, host_user_id: b.host_user_id, manage_url: `${baseUrl()}/booking/${b.token}` };
}

async function cancelBooking(booking, reason, by = 'invitee') {
  if (booking.status !== 'confirmed') throw new HttpError(400, 'This booking is already cancelled');
  if (by === 'invitee' && Date.parse(booking.start_utc) < Date.now()) throw new HttpError(400, 'This call already happened.');
  db.run("UPDATE bookings SET status = 'cancelled', cancel_reason = ? WHERE id = ?", clampStr(reason, 500), booking.id);
  for (const ext of db.json(booking.external_events, [])) await calendars.deleteEvent(ext);
  const b = db.get('SELECT * FROM bookings WHERE id = ?', booking.id);
  const business = B.byId(b.business_id);
  if (b.lead_id) B.logActivity(business.id, b.lead_id, 'booking', `Call cancelled by ${by}${reason ? `: ${reason}` : ''}`);
  sendBookingEmails('cancelled', b).catch((e) => console.error('[booking email]', e));
  sendWebhook(business, 'booking.cancelled', bookingPayload(b), b.lead_id).catch((e) => console.error('[webhook]', e));
  return b;
}

async function rescheduleBooking(booking, startIso, tz) {
  if (booking.status !== 'confirmed') throw new HttpError(400, 'This booking was cancelled. Please book a new time.');
  const et = hydrateEt(db.get('SELECT * FROM event_types WHERE id = ?', booking.event_type_id));
  if (!et) throw new HttpError(400, 'This call type is no longer available. Please book a new time.');
  if (Date.parse(booking.start_utc) < Date.now()) throw new HttpError(400, 'This call already happened.');
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) throw new HttpError(400, 'Pick a valid time');
  const hosts = await S.availableHostsAt(et, startMs, { excludeBookingId: booking.id });
  if (!hosts.length) throw new HttpError(409, 'Sorry, that time is not available.');
  const hostId = hosts.includes(booking.host_user_id) ? booking.host_user_id : S.pickHost(et, hosts);
  const endMs = startMs + et.duration_min * 60000;
  const oldExternal = db.json(booking.external_events, []);
  db.tx(() => {
    const fresh = db.get('SELECT status FROM bookings WHERE id = ?', booking.id);
    if (!fresh || fresh.status !== 'confirmed') throw new HttpError(400, 'This booking was cancelled. Please book a new time.');
    assertFree(et, hostId, startMs, endMs, booking.id);
    db.run("UPDATE bookings SET start_utc = ?, end_utc = ?, host_user_id = ?, invitee_tz = ?, external_events = '[]', reminder_sent_at = NULL WHERE id = ?",
      new Date(startMs).toISOString(), new Date(endMs).toISOString(), hostId, T.isValidTz(tz) ? tz : booking.invitee_tz, booking.id);
  });
  for (const ext of oldExternal) await calendars.deleteEvent(ext);
  const b = db.get('SELECT * FROM bookings WHERE id = ?', booking.id);
  const ext = await calendars.createEvent(hostId, { summary: `${et.name}: ${b.name || b.email}`, start: startMs, end: endMs, attendeeEmail: b.email, attendeeName: b.name,
    timezone: b.invitee_tz, location: b.location, locationType: et.location_type, description: `Rescheduled booking. Manage: ${baseUrl()}/app#/bookings` });
  if (ext) db.run('UPDATE bookings SET external_events = ?, location = CASE WHEN ? IS NOT NULL THEN ? ELSE location END WHERE id = ?', JSON.stringify([ext]), ext.join_url, ext.join_url, b.id);
  const business = B.byId(b.business_id);
  if (b.lead_id) B.logActivity(business.id, b.lead_id, 'booking', `Call rescheduled to ${T.formatDateTime(startMs, business.timezone)}`);
  sendBookingEmails('rescheduled', b).catch((e) => console.error('[booking email]', e));
  return b;
}

async function sendReminders() {
  const due = db.all(`SELECT * FROM bookings WHERE status = 'confirmed' AND reminder_sent_at IS NULL AND start_utc > ? AND start_utc <= ?`,
    new Date().toISOString(), new Date(Date.now() + 24 * 3600000).toISOString());
  for (const b of due) {
    if (Date.parse(b.created_at.replace(' ', 'T') + 'Z') > Date.now() - 2 * 3600000) { db.run("UPDATE bookings SET reminder_sent_at = datetime('now') WHERE id = ?", b.id); continue; }
    const { et, business } = bookingView(b);
    db.run("UPDATE bookings SET reminder_sent_at = datetime('now') WHERE id = ?", b.id);
    await sendEmail({
      to: b.email, businessId: business.id, fromName: business.name, replyTo: business.email,
      subject: `Reminder: ${et?.name || 'your call'} with ${business.name}`,
      html: layout(business, { heading: 'See you soon!', body: rows([['When', T.formatDateTime(Date.parse(b.start_utc), b.invitee_tz || business.timezone)], ['Where', b.location]]), cta: { label: 'Reschedule or cancel', url: `${baseUrl()}/booking/${b.token}` } }),
    });
  }
}

module.exports = { createBooking, cancelBooking, rescheduleBooking, sendReminders, hydrateEt, bookingPayload, bookingView, validateContact };
