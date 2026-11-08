'use strict';
// Scheduled emails and texts around a booking.
//
// How it fits together:
//   1. A booking is made, cancelled or moved. `scheduleFor` finds every automation whose
//      conditions match and writes one outbox row per channel, with the moment it is due.
//   2. `processDue` runs from the job loop, renders each one and sends it. The outbox has a unique
//      key on (automation, booking, channel), so a second run can never send the same thing twice.
//   3. Texts are held until 8am in the recipient's own timezone, and anyone who has replied STOP
//      is never texted again.
const db = require('../db');
const T = require('../lib/time');
const { esc, clampStr, int, baseUrl, isEmail } = require('../lib/util');
const { sendEmail, layout } = require('../lib/email');
const sms = require('../lib/sms');
const B = require('./business');

const QUIET_START = () => int(process.env.SMS_QUIET_START_HOUR, 8, 0, 23);   // do not text before
const QUIET_END = () => int(process.env.SMS_QUIET_END_HOUR, 21, 1, 24);      // or after
const MAX_ATTEMPTS = 4;
const TRIGGERS = {
  booked: 'When it is booked', before: 'Before the appointment', after: 'After the appointment', cancelled: 'When it is cancelled', rescheduled: 'When it is moved',
  // Set after the call, by the host's text reply or from Bookings. Timed from the moment it is marked.
  no_show: 'When marked a no-show', not_booked: 'When they showed up but have not booked yet', won: 'When they booked on the call',
};
// The outcome each of those triggers waits for, and the triggers tied to a call's outcome.
const OUTCOME_OF = { no_show: 'no_show', not_booked: 'not_booked', won: 'booked' };
const TRIGGER_OF = { no_show: 'no_show', not_booked: 'not_booked', booked: 'won' };
// 'invalid': not a real sales call (already a client, or meant for another department). No follow-ups.
const OUTCOMES = ['booked', 'not_booked', 'no_show', 'invalid'];

// ---------------------------------------------------------------- merge fields

// Shown in the editor so nobody has to guess the spelling.
const VARIABLES = [
  ['first_name', 'Their first name'],
  ['last_name', 'Their last name'],
  ['full_name', 'Their full name'],
  ['email', 'Their email'],
  ['phone', 'Their mobile number'],
  ['session', 'What they booked, e.g. Engagement Session'],
  ['duration', 'How long it runs, e.g. 90 minutes'],
  ['when', 'Full date and time in their timezone'],
  ['date', 'Just the date, e.g. Saturday, October 3'],
  ['time', 'Just the time, e.g. 3:00 PM'],
  ['weekday', 'e.g. Saturday'],
  ['timezone', 'Their timezone'],
  ['market', 'The calendar it is on, e.g. Houston'],
  ['location', 'Where it happens'],
  ['host', 'Who is running it'],
  ['services', 'Services they showed interest in'],
  ['booking_number', 'Their booking number, when they gave one'],
  ['manage_url', 'Link to reschedule or cancel'],
  ['rebook_url', 'Link to book a new time on the same booking page'],
  ['quote_url', 'Link to their quote, when they have one'],
  ['business_name', 'Your business name'],
  ['business_phone', 'Your phone number'],
  ['business_email', 'Your email'],
  ['website', 'Your website'],
];

/** Everything a template can refer to, for one booking. */
function contextFor(booking) {
  const business = B.byId(booking.business_id);
  const et = db.get('SELECT * FROM event_types WHERE id = ?', booking.event_type_id);
  const host = booking.host_user_id ? db.get('SELECT name, is_resource FROM users WHERE id = ?', booking.host_user_id) : null;
  const cal = host ? db.get('SELECT name FROM calendar_profiles WHERE user_id = ? AND business_id = ?', booking.host_user_id, booking.business_id) : null;
  const lead = booking.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', booking.lead_id) : null;
  const quote = booking.quote_id ? db.get('SELECT token FROM quotes WHERE id = ?', booking.quote_id) : null;
  const answers = db.json(booking.answers, {});
  const leadAnswers = lead ? db.json(lead.answers, {}) : {};
  const tz = booking.invitee_tz || business.timezone;
  const start = Date.parse(booking.start_utc);

  // "What services they were interested in" can come from the form's multi-select, from the
  // session they bought, or from the line items on a quote. Gather all three.
  const services = new Set();
  for (const src of [answers, leadAnswers]) {
    for (const v of Object.values(src || {})) {
      if (Array.isArray(v)) v.forEach((x) => x && services.add(String(x)));
    }
  }
  if (answers.session) services.add(String(answers.session));
  if (booking.quote_id) {
    for (const row of db.all(`SELECT s.name FROM services s WHERE s.business_id = ? AND s.id IN (
      SELECT CAST(json_extract(value, '$.service_id') AS INTEGER) FROM json_each((SELECT items FROM quotes WHERE id = ?)))`, booking.business_id, booking.quote_id)) {
      if (row.name) services.add(row.name);
    }
  }
  const serviceList = [...services].filter(Boolean);

  const first = String(booking.name || '').trim().split(/\s+/)[0] || '';
  return {
    _booking: booking, _business: business, _et: et, _lead: lead, _services: serviceList,
    _calendar_name: cal ? cal.name : null, _start: start, _tz: tz,
    first_name: first,
    last_name: String(booking.name || '').trim().split(/\s+/).slice(1).join(' '),
    full_name: booking.name || '',
    email: booking.email || '',
    phone: booking.phone || '',
    session: et ? et.name : 'your appointment',
    duration: et ? `${et.duration_min} minutes` : '',
    when: T.formatDateTime(start, tz),
    date: T.formatDateTime(start, tz, { hour: undefined, minute: undefined, timeZoneName: undefined, year: undefined }),
    time: T.formatTime(start, tz),
    weekday: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date(start)),
    timezone: tz,
    market: cal ? cal.name : '',
    location: booking.location || '',
    host: host && !host.is_resource ? host.name : (cal ? cal.name : ''),
    services: serviceList.join(', '),
    booking_number: answers.booking_number ? String(answers.booking_number) : '',
    manage_url: B.linkFor(business, `/booking/${booking.token}`),
    rebook_url: et ? B.pageUrl(business, et.kind === 'session' ? `s/${et.slug}` : et.slug) : B.pageUrl(business),
    quote_url: quote ? B.linkFor(business, `/q/${quote.token}`) : '',
    business_name: business.name,
    business_phone: business.phone || '',
    business_email: business.email || '',
    website: business.website || '',
  };
}

/**
 * Replace {{name}} and {{name|fallback}}. Values are escaped for email and left raw for texts.
 * An unknown name renders empty and is reported, so the preview can warn about a typo rather than
 * shipping "Hi {{frist_name}}" to a customer.
 */
function render(template, ctx, { html = false } = {}) {
  const unknown = new Set();
  const out = String(template || '').replace(/\{\{\s*([a-z0-9_]+)\s*(?:\|([^}]*))?\}\}/gi, (_, rawName, fallback) => {
    const name = rawName.toLowerCase();
    if (!(name in ctx) || String(name).startsWith('_')) {
      if (!(name in ctx)) unknown.add(name);
      return fallback !== undefined ? String(fallback).trim() : '';
    }
    const v = ctx[name];
    const s = v === null || v === undefined || v === '' ? (fallback !== undefined ? String(fallback).trim() : '') : String(v);
    return html ? esc(s) : s;
  });
  return { text: out, unknown: [...unknown] };
}

// ---------------------------------------------------------------- conditions

const norm = (s) => String(s || '').trim().toLowerCase();

function hydrateAutomation(a) {
  if (!a) return a;
  const parse = (v, f) => (typeof v === 'string' ? db.json(v, f) : (v ?? f));
  a.event_type_ids = parse(a.event_type_ids, []);
  a.calendar_ids = parse(a.calendar_ids, []);
  a.service_match = parse(a.service_match, []);
  return a;
}

/** Does this automation apply to this booking? */
function matches(a, ctx) {
  const bk = ctx._booking;
  if (a.calls_only && ctx._et && ctx._et.kind === 'session') return false;
  if (a.event_type_ids.length && !a.event_type_ids.map(Number).includes(Number(bk.event_type_id))) return false;
  if (a.calendar_ids.length) {
    const cal = db.get('SELECT id FROM calendar_profiles WHERE user_id = ? AND business_id = ?', bk.host_user_id, bk.business_id);
    if (!cal || !a.calendar_ids.map(Number).includes(Number(cal.id))) return false;
  }
  if (a.service_match.length) {
    const have = ctx._services.map(norm);
    const want = a.service_match.map(norm).filter(Boolean);
    // Substring both ways, so "photo booth" matches "Photo Booth (3 hours)".
    const hit = (w) => have.some((h) => h === w || h.includes(w) || w.includes(h));
    if (a.match_mode === 'all' ? !want.every(hit) : !want.some(hit)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- scheduling

/** When is this automation due for this booking, in epoch ms? */
function dueAt(a, ctx, now = Date.now()) {
  const start = ctx._start;
  switch (a.trigger) {
    case 'booked': case 'cancelled': case 'rescheduled': case 'no_show': case 'not_booked': case 'won': return now + Math.max(0, a.offset_min) * 60000;
    case 'before': return start - Math.max(0, a.offset_min) * 60000;
    case 'after': return start + Math.max(0, a.offset_min) * 60000;
    default: return now;
  }
}

/**
 * Push a texting time into the allowed window, in the recipient's own timezone.
 * A message due at 5:30am waits for 8am; one due at 10pm waits for 8am tomorrow.
 */
function holdForQuietHours(ms, tz) {
  if (!T.isValidTz(tz)) return ms;
  const startH = QUIET_START();
  const endH = QUIET_END();
  if (startH >= endH) return ms;
  const z = T.utcToZoned(ms, tz);
  if (z.minutes < startH * 60) return T.zonedToUtc(z.date, startH * 60, tz);
  if (z.minutes >= endH * 60) return T.zonedToUtc(T.addDays(z.date, 1), startH * 60, tz);
  return ms;
}

function channelsOf(a) {
  return a.channel === 'both' ? ['email', 'sms'] : [a.channel];
}

/**
 * Queue every automation that matches this booking for the given trigger.
 * Returns what was queued and what was skipped, which the tests and the admin both use.
 */
function scheduleFor(booking, trigger, { now = Date.now() } = {}) {
  // A call marked not valid (already a client, or the wrong department) never gets anything.
  const current = booking.id ? db.get('SELECT outcome FROM bookings WHERE id = ?', booking.id) : null;
  if ((current ? current.outcome : booking.outcome) === 'invalid') return { queued: 0, skipped: [{ reason: 'marked not a valid call' }] };
  const rows = db.all("SELECT * FROM message_automations WHERE business_id = ? AND active = 1 AND trigger = ? ORDER BY sort, id", booking.business_id, trigger).map(hydrateAutomation);
  if (!rows.length) return { queued: 0, skipped: [] };
  const ctx = contextFor(booking);
  const result = { queued: 0, skipped: [] };

  for (const a of rows) {
    if (!matches(a, ctx)) { result.skipped.push({ automation: a.id, reason: 'conditions did not match' }); continue; }
    for (const channel of channelsOf(a)) {
      const to = channel === 'sms' ? sms.normalizeNumber(booking.phone) : (isEmail(booking.email) ? booking.email : null);
      if (!to) { result.skipped.push({ automation: a.id, channel, reason: channel === 'sms' ? 'no usable mobile number' : 'no email address' }); continue; }
      // An email-and-text automation keeps sending its emails while texting is not connected yet.
      if (channel === 'sms' && !sms.configured()) { result.skipped.push({ automation: a.id, channel, reason: 'texting is not connected yet' }); continue; }
      if (channel === 'sms' && !B.canText(B.byId(booking.business_id))) { result.skipped.push({ automation: a.id, channel, reason: 'texting is not turned on for this company' }); continue; }
      if (channel === 'sms' && isOptedOut(booking.business_id, to)) { result.skipped.push({ automation: a.id, channel, reason: 'they replied STOP' }); continue; }
      if (channel === 'sms' && !(a.sms_body || '').trim()) { result.skipped.push({ automation: a.id, channel, reason: 'no text written' }); continue; }
      if (channel === 'email' && !(a.body_html || '').trim()) { result.skipped.push({ automation: a.id, channel, reason: 'no email written' }); continue; }

      let due = dueAt(a, ctx, now);
      // A "3 days before" rule on a booking made tomorrow has already passed. Normally it goes out
      // now rather than being dropped; with skip_if_late it is skipped, so a call booked an hour out
      // does not get the 3-day, 1-day and 2-hour reminders all at once. Never after it has started.
      if (a.trigger === 'before' && due < now && a.skip_if_late) { result.skipped.push({ automation: a.id, channel, reason: 'booked too close to the appointment for this one' }); continue; }
      if (a.trigger === 'before' && due < now) due = ctx._start > now ? now : 0;
      if (!due) { result.skipped.push({ automation: a.id, channel, reason: 'the appointment already started' }); continue; }
      if (channel === 'sms') {
        due = holdForQuietHours(due, ctx._tz);
        // A reminder text for a 7am call would otherwise be held until 8am, after the call.
        if (a.trigger === 'before' && due > ctx._start) { result.skipped.push({ automation: a.id, channel, reason: 'quiet hours would hold this text until after the appointment' }); continue; }
      }

      const r = db.run(`INSERT OR IGNORE INTO scheduled_messages (business_id, automation_id, booking_id, lead_id, channel, to_addr, send_after, due_at)
        VALUES (?,?,?,?,?,?,?,?)`, booking.business_id, a.id, booking.id, booking.lead_id, channel, to, due, new Date(due).toISOString());
      if (r.changes) result.queued++;
    }
  }
  return result;
}

/** Drop anything still waiting for a booking that is no longer happening. */
function cancelQueued(bookingId, reason = 'the booking was cancelled') {
  return db.run("UPDATE scheduled_messages SET status = 'cancelled', skip_reason = ? WHERE booking_id = ? AND status = 'queued'", clampStr(reason, 200), bookingId).changes;
}

/** A moved booking needs its before/after messages recomputed against the new time. */
function rescheduleQueued(booking) {
  cancelQueued(booking.id, 'the booking moved, so this was rescheduled');
  db.run("DELETE FROM scheduled_messages WHERE booking_id = ? AND status = 'cancelled' AND skip_reason LIKE 'the booking moved%'", booking.id);
  const out = { before: 0, after: 0 };
  out.before = scheduleFor(booking, 'before').queued;
  out.after = scheduleFor(booking, 'after').queued;
  return out;
}

const isOptedOut = (businessId, phone) => !!db.get('SELECT 1 FROM sms_optouts WHERE business_id = ? AND phone = ?', businessId, phone);

// ---------------------------------------------------------------- sending

function emailHtml(business, a, ctx) {
  const body = render(a.body_html, ctx, { html: true }).text;
  // Written as plain paragraphs in the editor, wrapped in the branded shell on the way out.
  const looksLikeHtml = /<(p|div|table|ul|ol|h[1-6]|br)\b/i.test(body);
  const inner = looksLikeHtml ? body : body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  return layout(business, { heading: render(a.subject || '', ctx, { html: true }).text, body: inner, cta: { label: 'View or change your booking', url: ctx.manage_url } });
}

async function sendOne(msg) {
  const a = hydrateAutomation(db.get('SELECT * FROM message_automations WHERE id = ?', msg.automation_id));
  const booking = db.get('SELECT * FROM bookings WHERE id = ?', msg.booking_id);
  if (!a || !booking) {
    db.run("UPDATE scheduled_messages SET status = 'skipped', skip_reason = ? WHERE id = ?", 'the automation or booking was deleted', msg.id);
    return 'skipped';
  }
  if (booking.outcome === 'invalid') {
    db.run("UPDATE scheduled_messages SET status = 'skipped', skip_reason = ? WHERE id = ?", 'marked not a valid call', msg.id);
    return 'skipped';
  }
  // Outcome messages only go while the call's outcome is still the one they were written for: a
  // no-show later marked "they booked" must not get "sorry we missed you".
  if (OUTCOME_OF[a.trigger] && booking.outcome !== OUTCOME_OF[a.trigger]) {
    db.run("UPDATE scheduled_messages SET status = 'skipped', skip_reason = ? WHERE id = ?", 'the call outcome changed', msg.id);
    return 'skipped';
  }
  if (booking.status !== 'confirmed' && a.trigger !== 'cancelled' && !(a.trigger === 'no_show' && booking.status === 'no_show')) {
    db.run("UPDATE scheduled_messages SET status = 'skipped', skip_reason = ? WHERE id = ?", 'the booking is no longer confirmed', msg.id);
    return 'skipped';
  }
  if (a.skip_if_rebooked && db.get("SELECT 1 FROM bookings WHERE lead_id = ? AND id != ? AND status = 'confirmed' AND created_at > ?", booking.lead_id, booking.id, booking.created_at)) {
    db.run("UPDATE scheduled_messages SET status = 'skipped', skip_reason = ? WHERE id = ?", 'they already booked again', msg.id);
    return 'skipped';
  }

  const ctx = contextFor(booking);
  const business = ctx._business;
  db.run('UPDATE scheduled_messages SET attempts = attempts + 1 WHERE id = ?', msg.id);

  try {
    if (msg.channel === 'sms') {
      if (!B.canText(business)) {
        db.run("UPDATE scheduled_messages SET status = 'skipped', skip_reason = ? WHERE id = ?", 'texting is not turned on for this company', msg.id);
        return 'skipped';
      }
      // Re-check the opt-out list at send time, not just when it was queued.
      if (isOptedOut(business.id, msg.to_addr)) {
        db.run("UPDATE scheduled_messages SET status = 'skipped', skip_reason = ? WHERE id = ?", 'they replied STOP', msg.id);
        return 'skipped';
      }
      const body = render(a.sms_body, ctx).text.trim();
      if (!body) throw new Error('The text came out empty');
      const r = await sms.sendSms({ to: msg.to_addr, body });
      db.run('INSERT INTO sms_log (business_id, direction, to_addr, from_addr, body, status, provider_sid, segments) VALUES (?,?,?,?,?,?,?,?)',
        business.id, 'out', msg.to_addr, sms.fromNumber() || sms.messagingService(), body, r.status || 'sent', r.sid, r.segments);
      db.run("UPDATE scheduled_messages SET status = 'sent', sent_at = datetime('now'), body = ?, last_error = NULL WHERE id = ?", body, msg.id);
      return 'sent';
    }
    const subject = render(a.subject || `${ctx.session} with ${business.name}`, ctx).text;
    const html = emailHtml(business, a, ctx);
    const r = await sendEmail({ to: msg.to_addr, businessId: business.id, fromName: business.name, replyTo: business.email, subject, html });
    if (r.status === 'failed') throw new Error(r.error || 'the email provider rejected it');
    db.run("UPDATE scheduled_messages SET status = 'sent', sent_at = datetime('now'), subject = ?, body = ?, last_error = NULL WHERE id = ?", subject, html, msg.id);
    return 'sent';
  } catch (e) {
    const attempts = (msg.attempts || 0) + 1;
    const fatal = attempts >= MAX_ATTEMPTS || /not set up|bad_number|does not look like/i.test(e.message);
    db.run(`UPDATE scheduled_messages SET status = ?, last_error = ?, send_after = ? WHERE id = ?`,
      fatal ? 'failed' : 'queued', clampStr(e.message, 300),
      // Back off, so a provider having a bad minute is not hammered.
      fatal ? msg.send_after : Date.now() + attempts * 5 * 60000, msg.id);
    if (msg.channel === 'sms') {
      db.run('INSERT INTO sms_log (business_id, direction, to_addr, body, status, error) VALUES (?,?,?,?,?,?)',
        business.id, 'out', msg.to_addr, render(a.sms_body, ctx).text, 'failed', clampStr(e.message, 300));
    }
    return fatal ? 'failed' : 'retry';
  }
}

/** Called from the job loop. Sends what is due, oldest first. */
async function processDue({ limit = 40, now = Date.now() } = {}) {
  const due = db.all("SELECT * FROM scheduled_messages WHERE status = 'queued' AND send_after <= ? ORDER BY send_after LIMIT ?", now, int(limit, 40, 1, 200));
  const tally = { sent: 0, skipped: 0, failed: 0, retry: 0 };
  for (const msg of due) {
    try { tally[await sendOne(msg)] += 1; } catch (e) { console.error('[messaging]', e); tally.failed += 1; }
  }
  return tally;
}

// ---------------------------------------------------------------- preview and test

/** A stand-in booking so an automation can be previewed before anyone has booked anything. */
function sampleContext(business) {
  const tz = business.timezone;
  // Round to a believable 10am three days out, rather than whatever minute it happens to be now.
  const day = T.addDays(T.utcToZoned(Date.now(), tz).date, 3);
  const start = T.zonedToUtc(day, 10 * 60, tz);
  return {
    _booking: { id: 0, business_id: business.id, token: 'sample' }, _business: business, _services: ['Photography', 'Photo Booth'],
    _start: start, _tz: tz, _calendar_name: 'Houston',
    first_name: 'Dana', last_name: 'Ruiz', full_name: 'Dana Ruiz', email: 'dana@example.com', phone: '(832) 555-1234',
    session: 'Engagement Session', duration: '90 minutes',
    when: T.formatDateTime(start, tz), date: T.formatDateTime(start, tz, { hour: undefined, minute: undefined, timeZoneName: undefined, year: undefined }),
    time: T.formatTime(start, tz), weekday: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date(start)), timezone: tz,
    market: 'Houston', location: 'Hermann Park, Houston', host: 'Houston', services: 'Photography, Photo Booth',
    booking_number: 'WU-10432',
    manage_url: B.linkFor(business, '/booking/sample'), rebook_url: B.pageUrl(business, 'discovery-call'), quote_url: '',
    business_name: business.name, business_phone: business.phone || '', business_email: business.email || '', website: business.website || '',
  };
}

/** Render an automation against a real booking when there is one, otherwise the sample. */
function preview(business, a, { bookingId } = {}) {
  const auto = hydrateAutomation({ ...a });
  const booking = bookingId
    ? db.get('SELECT * FROM bookings WHERE id = ? AND business_id = ?', int(bookingId, 0), business.id)
    : db.get("SELECT * FROM bookings WHERE business_id = ? AND status = 'confirmed' ORDER BY start_utc DESC LIMIT 1", business.id);
  const ctx = booking ? contextFor(booking) : sampleContext(business);
  const subject = render(auto.subject || '', ctx);
  const emailBody = auto.body_html ? render(auto.body_html, ctx, { html: true }) : { text: '', unknown: [] };
  const smsBody = auto.sms_body ? render(auto.sms_body, ctx) : { text: '', unknown: [] };
  const unknown = [...new Set([...subject.unknown, ...emailBody.unknown, ...smsBody.unknown])];
  const seg = sms.segmentInfo(smsBody.text);
  return {
    using: booking ? 'a real booking' : 'sample details',
    booking_id: booking ? booking.id : null,
    subject: subject.text,
    email_html: auto.body_html ? emailHtml(business, auto, ctx) : '',
    sms_text: smsBody.text,
    sms: { encoding: seg.encoding, characters: seg.units, segments: seg.segments },
    due_example: describeTiming(auto),
    unknown_variables: unknown,
  };
}

function describeTiming(a) {
  const mins = Math.max(0, a.offset_min || 0);
  const human = mins === 0 ? 'straight away'
    : mins % 1440 === 0 ? `${mins / 1440} day${mins / 1440 === 1 ? '' : 's'}`
      : mins % 60 === 0 ? `${mins / 60} hour${mins / 60 === 1 ? '' : 's'}` : `${mins} minutes`;
  switch (a.trigger) {
    case 'booked': return mins ? `${human} after they book` : 'the moment they book';
    case 'before': return mins ? `${human} before the appointment` : 'right as the appointment starts';
    case 'after': return `${human} after the appointment`;
    case 'cancelled': return mins ? `${human} after it is cancelled` : 'when it is cancelled';
    case 'rescheduled': return mins ? `${human} after it moves` : 'when it moves';
    case 'no_show': return mins ? `${human} after it is marked a no-show` : 'when it is marked a no-show';
    case 'not_booked': return mins ? `${human} after they are marked "not booked yet"` : 'when they are marked "not booked yet"';
    case 'won': return mins ? `${human} after they are marked "booked on the call"` : 'when they are marked "booked on the call"';
    default: return human;
  }
}

/** Send one message to yourself, right now, without touching the queue or any customer. */
async function sendTest(business, a, { to, channel }) {
  const auto = hydrateAutomation({ ...a });
  const ctx = sampleContext(business);
  if (channel === 'sms') {
    if (!B.canText(business)) throw new Error('Texting is not turned on for this company yet.');
    const number = sms.normalizeNumber(to);
    if (!number) throw new Error('Enter a mobile number to test with.');
    const body = render(auto.sms_body, ctx).text.trim();
    if (!body) throw new Error('Write the text first.');
    const r = await sms.sendSms({ to: number, body });
    db.run('INSERT INTO sms_log (business_id, direction, to_addr, body, status, provider_sid, segments) VALUES (?,?,?,?,?,?,?)',
      business.id, 'out', number, `[test] ${body}`, r.status || 'sent', r.sid, r.segments);
    return { channel: 'sms', to: number, segments: r.segments };
  }
  if (!isEmail(to)) throw new Error('Enter an email address to test with.');
  const subject = `[Test] ${render(auto.subject || 'Your booking', ctx).text}`;
  const r = await sendEmail({ to, businessId: business.id, fromName: business.name, replyTo: business.email, subject, html: emailHtml(business, auto, ctx) });
  if (r.status === 'failed') throw new Error(r.error || 'the email provider rejected it');
  return { channel: 'email', to, status: r.status };
}

// ---------------------------------------------------------------- inbound texts

/**
 * Handle a reply. STOP adds a permanent opt-out; START removes it. Everything else is logged so
 * staff can see it. The caller verifies the signature before this runs.
 */
function handleInboundSms({ from, to, body, businessId, sid: providerSid }) {
  const number = sms.normalizeNumber(from);
  const word = sms.keywordOf(body);
  let bizId = businessId || null;
  if (!bizId && number) {
    // Work out who they were talking to, so the opt-out lands on the right business rather than
    // all of them. Last text we sent, then anything queued for them, then their last booking.
    const hit = db.get("SELECT business_id FROM sms_log WHERE to_addr = ? AND direction = 'out' AND business_id IS NOT NULL ORDER BY id DESC LIMIT 1", number)
      || db.get('SELECT business_id FROM scheduled_messages WHERE to_addr = ? ORDER BY id DESC LIMIT 1', number)
      || db.all("SELECT business_id, phone FROM bookings WHERE phone IS NOT NULL AND phone != '' ORDER BY id DESC LIMIT 500")
        .find((r) => sms.normalizeNumber(r.phone) === number);
    bizId = hit ? hit.business_id : null;
  }
  db.run('INSERT INTO sms_log (business_id, direction, to_addr, from_addr, body, status, provider_sid) VALUES (?,?,?,?,?,?,?)',
    bizId, 'in', to || null, number, clampStr(body, 1000), word || 'received', providerSid || null);

  if (!number) return { action: 'ignored', reason: 'unreadable number' };
  // A host answering the after-call question. Checked before START, because "yes" is both.
  if (word !== 'stop') {
    const hostReply = handleHostReply(number, body);
    if (hostReply) return hostReply;
  }
  if (word === 'stop') {
    const targets = bizId ? [bizId] : db.all('SELECT id FROM businesses').map((r) => r.id);
    for (const id of targets) db.run('INSERT OR IGNORE INTO sms_optouts (business_id, phone, reason) VALUES (?,?,?)', id, number, 'replied STOP');
    const dropped = db.run("UPDATE scheduled_messages SET status = 'cancelled', skip_reason = 'they replied STOP' WHERE channel = 'sms' AND status = 'queued' AND to_addr = ?", number).changes;
    return { action: 'opted_out', number, cancelled: dropped };
  }
  if (word === 'start') {
    db.run('DELETE FROM sms_optouts WHERE phone = ?', number);
    return { action: 'opted_in', number };
  }
  if (bizId && !word) {
    try { const alerted = alertTeamOfReply(bizId, number, body); if (alerted) return alerted; } catch (e) { console.error('[reply alert]', e.message); }
  }
  return { action: 'logged', number, keyword: word };
}

// ---------------------------------------------------------------- after-call check to the host
//
// A few minutes after each call ends, the host gets a text asking whether the customer picked up.
// Replying 1 records the call as held; 2 marks the booking a no-show, which also cancels any
// follow-ups queued for it. Switched on per company (settings.host_check). Only people get it,
// never market calendars, and only when they have a mobile number on their profile.

const HOST_CHECK_WINDOW_MS = 16 * 3600000;   // never ask about a call that ended longer ago than this
const HOST_REPLY_WINDOW = 48 * 3600000;      // a reply only counts against a question this recent

function hostCheckText(booking, business, host) {
  const et = db.get('SELECT name FROM event_types WHERE id = ?', booking.event_type_id);
  const tz = host.timezone || business.timezone;
  const who = String(booking.name || booking.email || 'the customer').trim().slice(0, 40);
  return `${business.name}: did your ${T.formatTime(Date.parse(booking.start_utc), tz)} call with ${who}${et ? ` (${et.name})` : ''} happen? `
    + 'Reply 1 if they booked on the call, 2 if they showed up but have not booked yet, 3 if it was a no-show, '
    + 'or 4 if it was not a valid call (already booked or called the wrong department).';
}

/** Called from the job loop. Sends the after-call question for calls that have just ended. */
async function sendHostChecks({ now = Date.now() } = {}) {
  if (!sms.configured()) return { sent: 0 };
  let sent = 0;
  for (const { id } of db.all('SELECT id FROM businesses WHERE suspended_at IS NULL')) {
    const business = B.byId(id);
    const cfg = (business.settings || {}).host_check || {};
    if (!cfg.enabled || !B.canText(business)) continue;
    const after = int(cfg.after_min, 10, 0, 720) * 60000;
    const rows = db.all(`SELECT b.*, u.phone host_phone, u.timezone host_tz, u.name host_name, u.is_resource FROM bookings b
      JOIN users u ON u.id = b.host_user_id
      WHERE b.business_id = ? AND b.status = 'confirmed' AND b.outcome IS NULL AND b.host_check_sent_at IS NULL AND b.end_utc <= ? AND b.end_utc >= ?`,
    id, new Date(now - after).toISOString(), new Date(now - HOST_CHECK_WINDOW_MS).toISOString());
    for (const b of rows) {
      const to = sms.normalizeNumber(b.host_phone);
      if (b.is_resource || !to || isOptedOut(id, to)) continue;
      // Respect quiet hours in the host's own timezone; the next run picks it up in the morning.
      const due = holdForQuietHours(Date.parse(b.end_utc) + after, b.host_tz || business.timezone);
      if (due > now) continue;
      const body = hostCheckText(b, business, { timezone: b.host_tz });
      // Claim it first, so an overlapping run can never text the same question twice.
      if (!db.run('UPDATE bookings SET host_check_sent_at = ?, host_check_to = ? WHERE id = ? AND host_check_sent_at IS NULL', new Date(now).toISOString(), to, b.id).changes) continue;
      try {
        const r = await sms.sendSms({ to, body });
        db.run('INSERT INTO sms_log (business_id, direction, to_addr, from_addr, body, status, provider_sid, segments) VALUES (?,?,?,?,?,?,?,?)',
          id, 'out', to, sms.fromNumber() || sms.messagingService(), body, r.status || 'sent', r.sid, r.segments);
        sent++;
      } catch (e) {
        db.run('INSERT INTO sms_log (business_id, direction, to_addr, body, status, error) VALUES (?,?,?,?,?,?)', id, 'out', to, body, 'failed', clampStr(e.message, 300));
      }
    }
  }
  return { sent };
}

/** 'booked', 'not_booked', 'no_show', 'invalid' or null, from a host's reply. */
function hostAnswerOf(body) {
  const t = String(body || '').trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  if (/^(1|booked|they booked|booked on the call|won|signed)$/.test(t)) return 'booked';
  if (/^(2|not booked|not yet|not booked yet|showed|showed up|held|thinking)$/.test(t)) return 'not_booked';
  if (/^(4|invalid|not valid|not a valid call|wrong department|wrong dept|already booked|already a client)$/.test(t)) return 'invalid';
  if (/^(3|no ?-?show|no show up|didn'?t show|did not show|no answer|didn'?t pick up|did not pick up)$/.test(t)) return 'no_show';
  return null;
}

const OUTCOME_LABEL = { booked: 'booked on the call', not_booked: 'showed up, not booked yet', no_show: 'a no-show', invalid: 'not a valid call' };

/**
 * Record how a call went and start the matching follow-ups. The one place an outcome changes, from
 * the host's text reply and from Bookings alike.
 *   - Messages waiting for a different outcome are cancelled (and "after the call" thank-yous too
 *     for a no-show, since they never had the call).
 *   - The new outcome's automations are queued, timed from now.
 *   - A no-show also sets the booking's status, which the team numbers count.
 * Passing null clears the outcome. Returns the updated booking.
 */
function setOutcome(bookingOrId, outcome, { by } = {}) {
  const b = typeof bookingOrId === 'object' ? bookingOrId : db.get('SELECT * FROM bookings WHERE id = ?', bookingOrId);
  if (!b) throw new Error('Booking not found');
  const next = OUTCOMES.includes(outcome) ? outcome : null;
  if ((b.outcome || null) === next && (next !== 'no_show' || b.status === 'no_show')) return b;
  if (b.status === 'cancelled') throw new Error('A cancelled call has no outcome.');

  // Messages for the old outcome are stale now.
  const stale = Object.entries(TRIGGER_OF).filter(([o]) => o !== next).map(([, t]) => t);
  db.run(`UPDATE scheduled_messages SET status = 'cancelled', skip_reason = 'the call outcome changed'
    WHERE booking_id = ? AND status = 'queued' AND automation_id IN (SELECT id FROM message_automations WHERE trigger IN (${stale.map(() => '?').join(',')}))`, b.id, ...stale);
  if (next === 'no_show') cancelQueued(b.id, 'they did not show up for the call');
  // Already a client, or the wrong department: nothing after the call applies to them.
  if (next === 'invalid') cancelQueued(b.id, 'marked not a valid call');
  // Let a re-marked outcome queue its messages again (the outbox key is automation + booking + channel).
  db.run(`DELETE FROM scheduled_messages WHERE booking_id = ? AND status = 'cancelled' AND skip_reason = 'the call outcome changed'`, b.id);

  const status = next === 'no_show' ? 'no_show' : (b.status === 'no_show' ? 'confirmed' : b.status);
  db.run("UPDATE bookings SET outcome = ?, outcome_at = datetime('now'), status = ? WHERE id = ?", next, status, b.id);
  const fresh = db.get('SELECT * FROM bookings WHERE id = ?', b.id);
  let queued = 0;
  if (next) queued = scheduleFor(fresh, TRIGGER_OF[next]).queued;
  if (b.lead_id) {
    try {
      B.logActivity(b.business_id, b.lead_id, 'booking', next ? `Call marked ${OUTCOME_LABEL[next]}${by ? ` by ${by}` : ''}` : `Call outcome cleared${by ? ` by ${by}` : ''}`, { booking_id: b.id, outcome: next, queued });
    } catch (e) { /* log only */ }
  }
  return { ...fresh, follow_ups_queued: queued };
}

/**
 * A reply from a host to the after-call question. Answers the most recent open question sent to
 * that number, then asks about the next one if more are waiting. Returns null when nobody asked
 * this number anything, so normal inbound handling carries on.
 */
function handleHostReply(number, body, now = Date.now()) {
  const open = () => db.all(`SELECT * FROM bookings WHERE host_check_to = ? AND host_check_answer IS NULL AND host_check_sent_at >= ?
    ORDER BY host_check_sent_at DESC, id DESC`, number, new Date(now - HOST_REPLY_WINDOW).toISOString());
  const pending = open();
  if (!pending.length) return null;
  const answer = hostAnswerOf(body);
  if (!answer) {
    // A short reply that is not 1, 2 or 3 is almost certainly a fumbled answer: say how to answer.
    if (String(body || '').trim().length <= 20 && !sms.keywordOf(body)) return { action: 'host_check_help', reply: 'Please reply 1 if they booked on the call, 2 if they showed up but have not booked yet, 3 if it was a no-show, or 4 if it was not a valid call.' };
    return null;
  }
  const b = pending[0];
  const host = db.get('SELECT name FROM users WHERE id = ?', b.host_user_id);
  db.run('UPDATE bookings SET host_check_answer = ? WHERE id = ?', answer, b.id);
  if (b.status !== 'cancelled') setOutcome(b, answer, { by: host ? `${host.name} (by text)` : 'text' });
  const who = String(b.name || 'them').trim().split(/\s+/)[0];
  let reply = `Got it, ${who} is marked ${OUTCOME_LABEL[answer]}.`;
  const next = open()[0];
  if (next) reply += ` Next: ${hostCheckText(next, B.byId(next.business_id), { timezone: (db.get('SELECT timezone FROM users WHERE id = ?', next.host_user_id) || {}).timezone }).replace(/^[^:]*: /, '')}`;
  return { action: 'host_check', booking_id: b.id, answer, reply };
}

// ---------------------------------------------------------------- customers texting back

const wantsProposal = (body) => /\bproposal\b/i.test(String(body || ''));

/**
 * A customer replied to one of our texts (not STOP or START). Emails the team so the conversation
 * can pick back up, notes it on their lead, and, when they asked for a proposal, tells them it is
 * on the way. Fire and forget: a slow email never holds up Twilio's webhook.
 */
function alertTeamOfReply(businessId, number, body) {
  const business = B.byId(businessId);
  if (!business) return null;
  const booking = db.all("SELECT * FROM bookings WHERE business_id = ? AND phone IS NOT NULL AND phone != '' ORDER BY id DESC LIMIT 500", businessId)
    .find((r) => sms.normalizeNumber(r.phone) === number) || null;
  const lead = booking && booking.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', booking.lead_id)
    : db.all("SELECT * FROM leads WHERE business_id = ? AND phone IS NOT NULL ORDER BY id DESC LIMIT 500", businessId).find((l) => sms.normalizeNumber(l.phone) === number) || null;
  const name = (booking && booking.name) || (lead && [lead.first_name, lead.last_name].filter(Boolean).join(' ')) || number;
  const proposal = wantsProposal(body);
  if (lead) { try { B.logActivity(businessId, lead.id, 'sms', `${proposal ? 'Asked for a proposal by text' : 'Texted back'}: ${clampStr(body, 300)}`, { from: number }); } catch (e) { /* log only */ } }
  const { rows: kv } = require('../lib/email');
  const to = B.replyEmails(business);
  const outcome = booking && booking.outcome ? OUTCOME_LABEL[booking.outcome] : null;
  if (to.length) {
    sendEmail({
      to, businessId, fromName: business.name,
      subject: proposal ? `${name} asked for a proposal by text` : `Text reply from ${name}`,
      html: layout(business, {
        heading: proposal ? `${esc(name)} wants a proposal by text` : `${esc(name)} texted back`,
        body: `<p style="margin:0 0 14px;white-space:pre-wrap">${esc(clampStr(body, 1000))}</p>` + kv([['From', number], ['Their call', booking ? T.formatDateTime(Date.parse(booking.start_utc), business.timezone) : null], ['How it went', outcome]]),
        cta: lead ? { label: 'Open their lead', url: B.linkFor(business, `/app#/leads/${lead.id}`) } : undefined,
      }),
    }).catch((e) => console.error('[reply alert]', e.message));
  }
  return { action: proposal ? 'proposal_requested' : 'reply_alerted', number, lead_id: lead ? lead.id : null,
    reply: proposal ? `Thanks! ${business.name} will text you a proposal shortly.` : null };
}

// ---------------------------------------------------------------- admin listing

function listAutomations(businessId) {
  return db.all('SELECT * FROM message_automations WHERE business_id = ? ORDER BY sort, id', businessId).map((a) => {
    hydrateAutomation(a);
    const counts = db.get(`SELECT
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) queued,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) sent,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) failed
      FROM scheduled_messages WHERE automation_id = ?`, a.id) || {};
    return { ...a, active: !!a.active, skip_if_rebooked: !!a.skip_if_rebooked, skip_if_late: !!a.skip_if_late, calls_only: !!a.calls_only, timing: describeTiming(a),
      queued: counts.queued || 0, sent: counts.sent || 0, failed: counts.failed || 0 };
  });
}

function listQueue(businessId, { status, limit = 100 } = {}) {
  const where = ['m.business_id = ?'];
  const args = [businessId];
  if (status) { where.push('m.status = ?'); args.push(status); }
  const rows = db.all(`SELECT m.*, a.name automation_name, b.name customer, b.token booking_token, b.start_utc
    FROM scheduled_messages m
    LEFT JOIN message_automations a ON a.id = m.automation_id
    LEFT JOIN bookings b ON b.id = m.booking_id
    WHERE ${where.join(' AND ')} ORDER BY m.send_after DESC LIMIT ?`, ...args, int(limit, 100, 1, 500));
  return rows.map((r) => ({
    id: r.id, automation: r.automation_name, channel: r.channel, to: r.to_addr, status: r.status,
    due: r.due_at, sent_at: r.sent_at, attempts: r.attempts, error: r.last_error, skip_reason: r.skip_reason,
    customer: r.customer, booking_token: r.booking_token, appointment: r.start_utc, subject: r.subject,
  }));
}

function summary(businessId) {
  const q = db.get("SELECT COUNT(*) c FROM scheduled_messages WHERE business_id = ? AND status = 'queued'", businessId).c;
  const sent7 = db.get("SELECT COUNT(*) c FROM scheduled_messages WHERE business_id = ? AND status = 'sent' AND sent_at >= datetime('now','-7 day')", businessId).c;
  const failed = db.get("SELECT COUNT(*) c FROM scheduled_messages WHERE business_id = ? AND status = 'failed'", businessId).c;
  const optouts = db.get('SELECT COUNT(*) c FROM sms_optouts WHERE business_id = ?', businessId).c;
  const texts7 = db.get("SELECT COALESCE(SUM(segments),0) s FROM sms_log WHERE business_id = ? AND direction = 'out' AND status != 'failed' AND created_at >= datetime('now','-7 day')", businessId).s;
  return { queued: q, sent_7d: sent7, failed, optouts, sms_segments_7d: texts7, sms_ready: sms.configured() && B.canText(B.byId(businessId)), quiet_hours: { from: QUIET_END(), to: QUIET_START() } };
}

module.exports = {
  VARIABLES, TRIGGERS, contextFor, render, matches, hydrateAutomation, dueAt, holdForQuietHours,
  scheduleFor, cancelQueued, rescheduleQueued, processDue, sendOne, isOptedOut,
  sendHostChecks, handleHostReply, hostAnswerOf, hostCheckText, setOutcome, OUTCOMES, alertTeamOfReply,
  preview, sampleContext, sendTest, describeTiming, handleInboundSms,
  listAutomations, listQueue, summary,
};
