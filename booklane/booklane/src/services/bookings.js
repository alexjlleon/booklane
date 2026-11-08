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
const PLACES = require('./places');
const S = require('./scheduling');
const calendars = require('./calendars');
const { sendWebhook } = require('./integrations');
const MSG = require('./messaging');
const PUSH = require('./push');

function hydrateEt(et) {
  if (!et) return et;
  et.steps = db.json(et.steps, []);
  et.settings = db.json(et.settings, {});
  et.location_options = db.json(et.location_options, []);
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

// Kept as a thin wrapper so anything still handing over a whole page keeps working; the page is
// just the list of one it always was.
function locationText(et, contact, joinUrl) {
  return PLACES.placeText(PLACES.placesFor(et)[0], contact, joinUrl);
}

// ---------- Guests: people the customer invites to their call ----------
const MAX_GUESTS = 5;
const guestsOf = (b) => db.json(b.guests, []);
// On unless a booking page has switched it off.
const guestsAllowed = (et) => et?.settings?.allow_guests !== false;

// The list after adding `list` to `existing`: lower-cased, no repeats, and never the customer.
function mergeGuests(list, customerEmail, existing = []) {
  const own = String(customerEmail || '').trim().toLowerCase();
  const out = [...existing];
  for (const raw of [].concat(list || [])) {
    const email = String(raw || '').trim().toLowerCase();
    if (!email) continue;
    if (!isEmail(email)) throw new HttpError(422, `"${email.slice(0, 80)}" is not a valid email address`);
    if (email !== own && !out.includes(email)) out.push(email);
  }
  if (out.length > MAX_GUESTS) throw new HttpError(422, `You can invite up to ${MAX_GUESTS} guests.`);
  return out;
}

function bookingView(b) {
  const et = hydrateEt(db.get('SELECT * FROM event_types WHERE id = ?', b.event_type_id));
  const business = B.byId(b.business_id);
  const host = b.host_user_id ? db.get('SELECT id, name, email, is_resource FROM users WHERE id = ?', b.host_user_id) : null;
  // A market or designer calendar is not a person: its address is a placeholder, so never mail it.
  if (host?.is_resource) host.email = null;
  return { b, et, business, host };
}

// What a guest receives. Deliberately has no manage link and no manage link in its invite: that
// link can move or cancel the call, and only the customer who booked it should hold it.
async function sendGuestEmails(kind, booking, recipients) {
  if (!recipients.length) return;
  const { b, et, business, host } = bookingView(booking);
  const tz = b.invitee_tz || business.timezone;
  const start = Date.parse(b.start_utc), end = Date.parse(b.end_utc);
  const when = T.formatDateTime(start, tz);
  const summary = `${et?.name || 'Call'} with ${business.name}`;
  const inviter = b.name || b.email;
  const off = kind === 'cancelled' || kind === 'removed';
  const copy = {
    created: { subject: `You're invited: ${summary} on ${when}`, heading: `${inviter} invited you to a call` },
    rescheduled: { subject: `Rescheduled: ${summary} on ${when}`, heading: 'This call was rescheduled' },
    reassigned: { subject: `Update: ${summary} on ${when} is now with ${host?.name || 'a teammate'}`, heading: `This call is now with ${host?.name || 'a teammate'}` },
    cancelled: { subject: `Cancelled: ${summary}`, heading: 'This call was cancelled' },
    removed: { subject: `You're no longer on: ${summary}`, heading: `${inviter} removed you from this call` },
    reminder: { subject: `Reminder: ${summary}`, heading: 'See you soon!' },
  }[kind];
  // One message each, so a calendar app treats it as that person's own invite.
  for (const email of recipients) {
    const ics = kind === 'reminder' ? null : buildIcs({ uid: bookingUid(b), start, end, summary, description: `Invited by ${inviter}`, location: b.location,
      organizerName: business.name, organizerEmail: host?.email, attendeeName: b.name, attendeeEmail: b.email, guests: kind === 'removed' ? [email] : guestsOf(b), cancelled: off,
      sequence: off ? 2 : kind === 'rescheduled' || kind === 'reassigned' ? 1 : 0 });
    await sendEmail({
      to: email, businessId: business.id, fromName: business.name, replyTo: host?.email || business.email, subject: copy.subject,
      html: layout(business, {
        heading: copy.heading,
        body: rows([['What', summary], ['When', when], ['Where', b.location], ['With', host?.name], ['Invited by', inviter]]) +
          (off ? '' : `<p><a href="${googleCalendarLink({ start, end, summary, location: b.location, description: `Invited by ${inviter}` })}">Add to Google Calendar</a>. To change the time, please ask ${esc(inviter)}.</p>`),
      }),
      attachments: ics ? [{ filename: 'invite.ics', content: ics }] : undefined,
    });
  }
}

const bookingUid = (b) => `booking-${b.id}-${b.token.slice(0, 8)}@booklane`;

async function sendBookingEmails(kind, booking, { oldHost, notifyCustomer = true } = {}) {
  const { b, et, business, host } = bookingView(booking);
  const tz = b.invitee_tz || business.timezone;
  const start = Date.parse(b.start_utc), end = Date.parse(b.end_utc);
  const when = T.formatDateTime(start, tz);
  const manage = B.linkFor(business, `/booking/${b.token}`);
  const summary = `${et?.name || 'Call'} with ${business.name}`;
  const answers = db.json(b.answers, {});
  const guests = guestsOf(b);
  const ics = buildIcs({ uid: bookingUid(b), start, end, summary, description: `Manage: ${manage}`, location: b.location,
    organizerName: business.name, organizerEmail: host?.email, attendeeName: b.name, attendeeEmail: b.email, guests, cancelled: kind === 'cancelled', sequence: kind === 'rescheduled' || kind === 'reassigned' ? 1 : kind === 'cancelled' ? 2 : 0 });
  // The host's phone, if they have the app. Only the person whose call it is: the team inbox is email.
  if (host && !host.is_resource) {
    const short = T.formatDateTime(start, business.timezone, { weekday: 'short', month: 'short', year: undefined, timeZoneName: 'short' });
    const titles = { created: 'New call booked', rescheduled: 'Call moved', cancelled: 'Call cancelled', reassigned: `${oldHost?.name || 'A teammate'} passed you a call` };
    PUSH.notify([host.id], 'bookings', { title: titles[kind], body: `${b.name || 'Someone'} · ${et?.name || 'Call'} · ${short}`, url: kind === 'cancelled' ? '/app#/bookings' : `/app#/bookings?focus=${b.id}` });
  }
  const headings = { created: `You're booked, ${esc((b.name || '').split(' ')[0])}!`, rescheduled: 'Your call was rescheduled', cancelled: 'Your call was cancelled',
    reassigned: `Your call is now with ${esc(host?.name || 'a teammate')}` };
  if (kind !== 'reassigned' || notifyCustomer) await sendEmail({
    to: b.email, businessId: business.id, fromName: business.name, replyTo: host?.email || business.email,
    subject: kind === 'cancelled' ? `Cancelled: ${summary}` : kind === 'reassigned' ? `Update: ${summary} on ${when} is now with ${host?.name || 'a teammate'}` : kind === 'rescheduled' ? `Rescheduled: ${summary} on ${when}` : `Confirmed: ${summary} on ${when}`,
    html: layout(business, {
      heading: headings[kind],
      body: rows([['What', summary], ['When', when], ['Where', b.location], ['With', host?.name], ['Guests', guests.join(', ')]]) +
        (kind !== 'cancelled' ? `<p>Need to make a change? <a href="${manage}">Reschedule or cancel</a>. <a href="${googleCalendarLink({ start, end, summary, location: b.location, description: manage })}">Add to Google Calendar</a>.</p>` : ''),
      cta: kind === 'cancelled' ? { label: 'Book a new time', url: B.pageUrl(business, et?.slug || '') } : null,
    }),
    attachments: [{ filename: 'invite.ics', content: ics }],
  });
  if (kind !== 'reassigned' || notifyCustomer) await sendGuestEmails(kind, b, guests);
  // A handoff only concerns the two people involved, not the whole team inbox.
  const team = new Set(kind === 'reassigned' ? [] : B.teamEmails(business));
  if (host?.email) team.add(host.email);
  if (oldHost?.email) team.add(oldHost.email);
  if (business.settings.notifications.notify_on_booking || kind !== 'created') {
    await sendEmail({
      to: [...team], businessId: business.id,
      subject: `${kind === 'created' ? 'New booking' : kind === 'rescheduled' ? 'Rescheduled' : kind === 'reassigned' ? `Passed to ${host?.name}` : 'Cancelled'}: ${b.name} · ${T.formatDateTime(start, business.timezone, { weekday: 'short', month: 'short', year: undefined })}`,
      html: layout(business, {
        heading: kind === 'created' ? 'New call booked' : kind === 'rescheduled' ? 'A call was rescheduled' : kind === 'reassigned' ? `${esc(oldHost?.name || 'Someone')} passed this call to ${esc(host?.name || 'a teammate')}` : 'A call was cancelled',
        body: rows([['Event', et?.name], ['When', T.formatDateTime(start, business.timezone)], ['Host', host?.name], ...(kind === 'reassigned' ? [['Was with', oldHost?.name], ['Note', b.handoff_note]] : []), ['Name', b.name], ['Email', b.email], ['Phone', b.phone], ['Guests', guests.join(', ')], ['Location', b.location],
          ['Reason', b.cancel_reason], ...L.answersToPairs(answers)]),
        cta: { label: 'Open in dashboard', url: B.linkFor(business, '/app#/bookings') },
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

async function createBooking({ business, et, startIso, tz, contact = {}, answers = {}, guests, lead, quote, restrictHostIds, placeId, contactEt, countSteps }) {
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) throw new HttpError(400, 'Pick a valid time');
  if (!T.isValidTz(tz)) tz = business.timezone;
  // A routed booking is made on another page's calendar, but the person filled in this page's
  // contact step, so that is the one their details are checked against.
  validateContact(contactEt || et, contact, business);
  const guestList = mergeGuests(guests, contact.email);
  const hosts = await S.availableHostsAt(et, startMs, { restrictHostIds });
  if (!hosts.length) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another time.');
  // Counted from the questions the person actually answered: this page's, the page that routed
  // them here, or the custom form they came through.
  const servicesCount = S.servicesCount(countSteps || (contactEt || et).steps, answers);
  const hostId = S.pickHost(et, hosts, { servicesCount });
  const endMs = startMs + et.duration_min * 60000;
  const name = [contact.first_name, contact.last_name].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  const cleanAnswers = L.sanitizeAnswers(answers);
  // An unrecognised choice falls back to the first way of meeting rather than refusing. Somebody
  // who picked Zoom on a page that has since dropped it should still end up with a booking.
  const place = PLACES.placeFor(et, placeId);
  const t = token(18);

  const bookingId = db.tx(() => {
    assertFree(et, hostId, startMs, endMs);
    return db.run(`INSERT INTO bookings (business_id, event_type_id, host_user_id, lead_id, quote_id, token, start_utc, end_utc, invitee_tz, name, email, phone, location, place_id, answers, services_count, guests)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, business.id, et.id, hostId, lead?.id, quote?.id, t, new Date(startMs).toISOString(), new Date(endMs).toISOString(), tz,
    clampStr(name, 160), String(contact.email).trim().toLowerCase(), clampStr(contact.phone, 40), PLACES.placeText(place, contact), place.id, JSON.stringify(cleanAnswers), servicesCount, JSON.stringify(guestList)).lastId;
  });

  const host = db.get('SELECT name FROM users WHERE id = ?', hostId);
  const ext = await calendars.createEvent(hostId, {
    summary: `${et.name}: ${name || contact.email}`, start: startMs, end: endMs, attendeeEmail: contact.email, attendeeName: name, guests: guestList, timezone: tz,
    location: PLACES.placeText(place, contact), locationType: place.type,
    description: [`Booked via ${business.name}`, contact.phone ? `Phone: ${contact.phone}` : '', ...L.answersToPairs(cleanAnswers).map(([k, v]) => `${k}: ${v}`),
      quote ? `Quote: ${B.linkFor(business, `/q/${quote.token}`)}` : '', `Manage: ${B.linkFor(business, '/app#/bookings')}`].filter(Boolean).join('\n'),
  });
  if (ext) db.run('UPDATE bookings SET external_events = ?, location = ? WHERE id = ?', JSON.stringify([ext]), PLACES.placeText(place, contact, ext.join_url), bookingId);

  if (lead) {
    L.updateLead(lead, { contact, answers: cleanAnswers });
    L.setStatus(lead, 'booked', { complete: true });
    B.logActivity(business.id, lead.id, 'booking', `Booked ${et.name} for ${T.formatDateTime(startMs, business.timezone)} with ${host?.name}`, { booking_id: bookingId });
  }
  const booking = db.get('SELECT * FROM bookings WHERE id = ?', bookingId);
  // Queue the scheduled emails and texts for this booking. Never let a template mistake stop a
  // booking that has already been written to the calendar.
  for (const trigger of ['booked', 'before', 'after']) {
    try { MSG.scheduleFor(booking, trigger); } catch (e) { console.error('[messaging schedule]', trigger, e.message); }
  }
  sendBookingEmails('created', booking).catch((e) => console.error('[booking email]', e));
  const payload = { booking: bookingPayload(booking), lead: lead ? L.leadPayload(db.get('SELECT * FROM leads WHERE id = ?', lead.id)) : null };
  sendWebhook(business, 'booking.created', payload, lead?.id).then(() => lead && sendWebhook(business, 'lead.completed', payload.lead, lead.id)).catch((e) => console.error('[webhook]', e));
  return booking;
}

function bookingPayload(b) {
  return { id: b.id, token: b.token, status: b.status, start: b.start_utc, end: b.end_utc, timezone: b.invitee_tz, name: b.name, email: b.email, phone: b.phone,
    location: b.location, answers: db.json(b.answers, {}), event_type_id: b.event_type_id, host_user_id: b.host_user_id, guests: guestsOf(b), manage_url: B.linkFor(B.byId(b.business_id), `/booking/${b.token}`) };
}

async function cancelBooking(booking, reason, by = 'invitee') {
  if (booking.status !== 'confirmed') throw new HttpError(400, 'This booking is already cancelled');
  if (by === 'invitee' && Date.parse(booking.start_utc) < Date.now()) throw new HttpError(400, 'This call already happened.');
  db.run("UPDATE bookings SET status = 'cancelled', cancel_reason = ? WHERE id = ?", clampStr(reason, 500), booking.id);
  for (const ext of db.json(booking.external_events, [])) await calendars.deleteEvent(ext);
  const b = db.get('SELECT * FROM bookings WHERE id = ?', booking.id);
  const business = B.byId(b.business_id);
  if (b.lead_id) B.logActivity(business.id, b.lead_id, 'booking', `Call cancelled by ${by}${reason ? `: ${reason}` : ''}`);
  // Nothing scheduled should still go out for an appointment that is not happening.
  try { MSG.cancelQueued(b.id); MSG.scheduleFor(b, 'cancelled'); } catch (e) { console.error('[messaging cancel]', e.message); }
  sendBookingEmails('cancelled', b).catch((e) => console.error('[booking email]', e));
  sendWebhook(business, 'booking.cancelled', bookingPayload(b), b.lead_id).catch((e) => console.error('[webhook]', e));
  return b;
}

/**
 * Remove bookings for good (test runs, junk). No email or text goes to the customer: a
 * booking that is still on is taken off the host's calendar, and anything queued for it is
 * dropped with it.
 */
async function deleteBookings(businessId, ids) {
  const rows = [...new Set((ids || []).map(Number).filter(Number.isInteger))]
    .map((id) => db.get('SELECT * FROM bookings WHERE id = ? AND business_id = ?', id, businessId)).filter(Boolean);
  for (const b of rows) {
    if (b.status === 'confirmed') {
      for (const ext of db.json(b.external_events, [])) {
        try { await calendars.deleteEvent(ext); } catch (e) { console.error('[delete booking calendar]', e.message); }
      }
    }
    db.run('DELETE FROM bookings WHERE id = ?', b.id);
  }
  return rows.length;
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
  const hostId = hosts.includes(booking.host_user_id) ? booking.host_user_id : S.pickHost(et, hosts, { servicesCount: booking.services_count });
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
  const ext = await calendars.createEvent(hostId, { summary: `${et.name}: ${b.name || b.email}`, start: startMs, end: endMs, attendeeEmail: b.email, attendeeName: b.name, guests: guestsOf(b),
    timezone: b.invitee_tz, location: b.location, locationType: PLACES.placeFor(et, b.place_id).type, description: `Rescheduled booking. Manage: ${B.linkFor(B.byId(b.business_id), '/app#/bookings')}` });
  if (ext) db.run('UPDATE bookings SET external_events = ?, location = CASE WHEN ? IS NOT NULL THEN ? ELSE location END WHERE id = ?', JSON.stringify([ext]), ext.join_url, ext.join_url, b.id);
  const business = B.byId(b.business_id);
  if (b.lead_id) B.logActivity(business.id, b.lead_id, 'booking', `Call rescheduled to ${T.formatDateTime(startMs, business.timezone)}`);
  // The old "2 hours before" is now pointing at the wrong moment, so recompute the whole queue.
  try { MSG.rescheduleQueued(b); MSG.scheduleFor(b, 'rescheduled'); } catch (e) { console.error('[messaging reschedule]', e.message); }
  sendBookingEmails('rescheduled', b).catch((e) => console.error('[booking email]', e));
  return b;
}

// Pass a call to a teammate at the same time. The new person must be on the call's booking page
// and genuinely free then. Their calendar gets the event, the old one loses it, both are emailed,
// and the customer is told who they will now be talking to (unless the person passing says not to).
async function reassignBooking(booking, newHostId, { note, notifyCustomer = true, by } = {}) {
  if (booking.status !== 'confirmed') throw new HttpError(400, 'Only an upcoming call can be passed on.');
  if (Date.parse(booking.start_utc) < Date.now()) throw new HttpError(400, 'This call already happened.');
  newHostId = Number(newHostId);
  if (newHostId === booking.host_user_id) throw new HttpError(400, 'That person already has this call.');
  const et = hydrateEt(db.get('SELECT * FROM event_types WHERE id = ?', booking.event_type_id));
  if (!et) throw new HttpError(409, 'The booking page for this call no longer exists.');
  if (!S.hostsFor(et.id).some((h) => h.id === newHostId)) throw new HttpError(422, 'That person is not a host on this booking page.');
  const startMs = Date.parse(booking.start_utc), endMs = Date.parse(booking.end_utc);
  const check = await S.hostFreeAt(et, newHostId, startMs, { excludeBookingId: booking.id });
  if (!check.free) throw new HttpError(409, `They are not free then (${check.reason}).`);
  const oldHost = db.get('SELECT id, name, email FROM users WHERE id = ?', booking.host_user_id);
  const oldExternal = db.json(booking.external_events, []);
  const cleanNote = String(note || '').trim().slice(0, 1000) || null;
  db.tx(() => {
    const fresh = db.get('SELECT status, host_user_id FROM bookings WHERE id = ?', booking.id);
    if (!fresh || fresh.status !== 'confirmed') throw new HttpError(400, 'This booking was cancelled.');
    if (fresh.host_user_id !== booking.host_user_id) throw new HttpError(409, 'Someone else just changed who has this call. Refresh and try again.');
    assertFree(et, newHostId, startMs, endMs, booking.id);
    db.run("UPDATE bookings SET host_user_id = ?, handoff_note = ?, external_events = '[]' WHERE id = ?", newHostId, cleanNote, booking.id);
  });
  for (const ext of oldExternal) await calendars.deleteEvent(ext);
  const b = db.get('SELECT * FROM bookings WHERE id = ?', booking.id);
  const ext = await calendars.createEvent(newHostId, { summary: `${et.name}: ${b.name || b.email}`, start: startMs, end: endMs, attendeeEmail: b.email, attendeeName: b.name, guests: guestsOf(b),
    timezone: b.invitee_tz, location: b.location, locationType: PLACES.placeFor(et, b.place_id).type, description: `Passed on by ${oldHost?.name || 'a teammate'}.${cleanNote ? ` Note: ${cleanNote}` : ''} Manage: ${B.linkFor(B.byId(b.business_id), '/app#/bookings')}` });
  if (ext) db.run('UPDATE bookings SET external_events = ?, location = CASE WHEN ? IS NOT NULL THEN ? ELSE location END WHERE id = ?', JSON.stringify([ext]), ext.join_url, ext.join_url, b.id);
  const after = db.get('SELECT * FROM bookings WHERE id = ?', booking.id);
  const newHost = db.get('SELECT name FROM users WHERE id = ?', newHostId);
  if (after.lead_id) B.logActivity(after.business_id, after.lead_id, 'booking', `Call passed from ${oldHost?.name || 'someone'} to ${newHost?.name || 'someone'}${by ? ` by ${by}` : ''}`, { booking_id: after.id });
  sendBookingEmails('reassigned', after, { oldHost, notifyCustomer }).catch((e) => console.error('[booking email]', e));
  return after;
}

// Only a call that is still to come can have its guests changed.
function assertGuestsEditable(booking) {
  if (booking.status !== 'confirmed') throw new HttpError(400, 'This booking was cancelled.');
  if (Date.parse(booking.start_utc) < Date.now()) throw new HttpError(400, 'This call already happened.');
}

async function syncGuestsToCalendar(b) {
  for (const ext of db.json(b.external_events, [])) await calendars.updateAttendees(ext, { attendeeEmail: b.email, attendeeName: b.name, guests: guestsOf(b) });
}

// The host hears about it because the people on their call changed. The rest of the team does not.
async function tellHostGuestsChanged(b, change, email) {
  const { et, business, host } = bookingView(b);
  if (b.lead_id) B.logActivity(business.id, b.lead_id, 'booking', `${b.name || b.email} ${change} ${email}`, { booking_id: b.id });
  if (!host?.email) return;
  await sendEmail({
    to: host.email, businessId: business.id, subject: `Guests changed: ${b.name || b.email} · ${T.formatDateTime(Date.parse(b.start_utc), business.timezone, { weekday: 'short', month: 'short', year: undefined })}`,
    html: layout(business, { heading: `${b.name || b.email} ${change} ${email}`, body: rows([['Event', et?.name], ['When', T.formatDateTime(Date.parse(b.start_utc), business.timezone)], ['Guests', guestsOf(b).join(', ') || 'None']]), cta: { label: 'Open in dashboard', url: B.linkFor(business, '/app#/bookings') } }),
  });
}

async function addGuests(booking, emails) {
  assertGuestsEditable(booking);
  const { et } = bookingView(booking);
  if (!guestsAllowed(et)) throw new HttpError(403, 'This booking page does not allow guests.');
  let added = [];
  db.tx(() => {
    const fresh = db.get('SELECT * FROM bookings WHERE id = ?', booking.id);
    assertGuestsEditable(fresh);
    const before = guestsOf(fresh);
    const after = mergeGuests(emails, fresh.email, before);
    added = after.filter((g) => !before.includes(g));
    db.run('UPDATE bookings SET guests = ? WHERE id = ?', JSON.stringify(after), booking.id);
  });
  const b = db.get('SELECT * FROM bookings WHERE id = ?', booking.id);
  if (!added.length) return b;
  await syncGuestsToCalendar(b);
  sendGuestEmails('created', b, added).then(() => tellHostGuestsChanged(b, 'invited', added.join(', '))).catch((e) => console.error('[guest email]', e));
  return b;
}

async function removeGuest(booking, email) {
  assertGuestsEditable(booking);
  const target = String(email || '').trim().toLowerCase();
  let removed = false;
  db.tx(() => {
    const before = guestsOf(db.get('SELECT guests FROM bookings WHERE id = ?', booking.id));
    removed = before.includes(target);
    if (removed) db.run('UPDATE bookings SET guests = ? WHERE id = ?', JSON.stringify(before.filter((g) => g !== target)), booking.id);
  });
  const b = db.get('SELECT * FROM bookings WHERE id = ?', booking.id);
  if (!removed) return b;
  await syncGuestsToCalendar(b);
  sendGuestEmails('removed', b, [target]).then(() => tellHostGuestsChanged(b, 'removed', target)).catch((e) => console.error('[guest email]', e));
  return b;
}

async function sendReminders() {
  const due = db.all(`SELECT * FROM bookings WHERE status = 'confirmed' AND reminder_sent_at IS NULL AND start_utc > ? AND start_utc <= ?`,
    new Date().toISOString(), new Date(Date.now() + 24 * 3600000).toISOString());
  // Businesses that have written their own "before the appointment" automation own their reminders;
  // sending this built-in one too would be a duplicate in the customer's inbox.
  const handled = new Set(db.all("SELECT DISTINCT business_id FROM message_automations WHERE active = 1 AND trigger = 'before'").map((r) => r.business_id));
  for (const b of due) {
    if (Date.parse(b.created_at.replace(' ', 'T') + 'Z') > Date.now() - 2 * 3600000) { db.run("UPDATE bookings SET reminder_sent_at = datetime('now') WHERE id = ?", b.id); continue; }
    const { et, business } = bookingView(b);
    db.run("UPDATE bookings SET reminder_sent_at = datetime('now') WHERE id = ?", b.id);
    // Automations are written to the customer and carry their manage link, so guests never get
    // those. This plain reminder is theirs, whichever way the customer is reminded.
    await sendGuestEmails('reminder', b, guestsOf(b));
    if (handled.has(b.business_id)) continue;
    await sendEmail({
      to: b.email, businessId: business.id, fromName: business.name, replyTo: business.email,
      subject: `Reminder: ${et?.name || 'your call'} with ${business.name}`,
      html: layout(business, { heading: 'See you soon!', body: rows([['When', T.formatDateTime(Date.parse(b.start_utc), b.invitee_tz || business.timezone)], ['Where', b.location]]), cta: { label: 'Reschedule or cancel', url: B.linkFor(business, `/booking/${b.token}`) } }),
    });
  }
}

module.exports = { createBooking, cancelBooking, deleteBookings, rescheduleBooking, reassignBooking, addGuests, removeGuest, guestsAllowed, guestsOf, MAX_GUESTS, sendReminders, hydrateEt, bookingPayload, bookingView, validateContact };
