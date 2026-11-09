'use strict';
// Google Calendar + Microsoft 365 (Outlook) integration via OAuth2 and REST (no SDKs).
const db = require('../db');
const { encrypt, decrypt, token } = require('../lib/security');
const { baseUrl } = require('../lib/util');

const PROVIDERS = {
  google: {
    label: 'Google Calendar',
    clientId: () => process.env.GOOGLE_CLIENT_ID, clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy',
    extraAuth: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  microsoft: {
    label: 'Outlook / Microsoft 365',
    clientId: () => process.env.MICROSOFT_CLIENT_ID, clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET,
    authUrl: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/token`,
    // .Shared lets an admin's connection reach a teammate's calendar that was shared with them.
    // It asks for nothing more about the admin's own mailbox.
    scopes: 'offline_access openid email User.Read Calendars.ReadWrite Calendars.ReadWrite.Shared',
    extraAuth: { prompt: 'select_account', response_mode: 'query' },
  },
};

const isConfigured = (p) => !!(PROVIDERS[p] && PROVIDERS[p].clientId() && PROVIDERS[p].clientSecret());
const redirectUri = (p) => `${baseUrl()}/oauth/${p}/callback`;

/**
 * Begin connecting a calendar.
 *
 * targetUserId is who the connection will belong to, which is not always who is authorising it: a
 * market calendar is a resource with no login, so an admin signs in to their own Outlook or Google
 * account and attaches one of its calendars to Houston. The person who started it is still recorded
 * separately, because that is what the callback checks before trusting the code it is handed.
 */
function startAuth(provider, userId, targetUserId, returnOrigin) {
  const P = PROVIDERS[provider];
  const state = token(18);
  db.run('DELETE FROM oauth_states WHERE created_at < ?', Date.now() - 15 * 60000);
  db.run('INSERT INTO oauth_states (state, user_id, provider, target_user_id, return_origin, created_at) VALUES (?,?,?,?,?,?)', state, userId, provider, targetUserId || null, returnOrigin || null, Date.now());
  const params = new URLSearchParams({ client_id: P.clientId(), redirect_uri: redirectUri(provider), response_type: 'code', scope: P.scopes, state, ...P.extraAuth });
  return `${P.authUrl}?${params}`;
}

async function tokenRequest(provider, params) {
  const P = PROVIDERS[provider];
  const r = await fetch(P.tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: P.clientId(), client_secret: P.clientSecret(), ...params }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || data.error || `Token request failed (${r.status})`);
  return data;
}

const stateRow = (state, provider) => db.get('SELECT * FROM oauth_states WHERE state = ? AND provider = ?', String(state), String(provider));

async function finishAuth(provider, code, state, sessionUserId, { refuseEmail } = {}) {
  const row = db.get('SELECT * FROM oauth_states WHERE state = ? AND provider = ?', state, provider);
  if (!row || row.created_at < Date.now() - 15 * 60000) throw new Error('This connection link expired. Please try again.');
  if (!sessionUserId || row.user_id !== sessionUserId) throw new Error('Please log in as the person who started connecting this calendar, then try again.');
  db.run('DELETE FROM oauth_states WHERE state = ?', state);
  const t = await tokenRequest(provider, { code, grant_type: 'authorization_code', redirect_uri: redirectUri(provider) });
  let email = null;
  try {
    if (provider === 'google') {
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${t.access_token}` } });
      email = (await r.json()).email;
    } else {
      const r = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${t.access_token}` } });
      const me = await r.json(); email = me.mail || me.userPrincipalName;
    }
  } catch { /* email is cosmetic */ }
  // An admin logged in as a teammate who signs in to their own account by mistake would attach the
  // admin's calendar to the teammate's profile: both calendars would then block both people.
  if (refuseEmail && email && email.toLowerCase() === String(refuseEmail).toLowerCase()) {
    throw new Error(`That is your own account (${email}). While logged in as someone, sign in with their account, or use "Through my Outlook" on People instead.`);
  }
  // Everything from here attaches to whoever this was started for, which may be a market rather
  // than the person who just signed in.
  const owner = row.target_user_id || row.user_id;
  const existing = db.get('SELECT id FROM calendar_connections WHERE user_id = ? AND provider = ? AND account_email IS ?', owner, provider, email);
  const expires = Date.now() + (Number(t.expires_in) || 3600) * 1000;
  if (existing) {
    db.run('UPDATE calendar_connections SET access_token=?, refresh_token=COALESCE(?, refresh_token), expires_at=?, last_error=NULL, needs_reconnect=0, alerted_at=NULL WHERE id=?',
      encrypt(t.access_token), t.refresh_token ? encrypt(t.refresh_token) : null, expires, existing.id);
    // Teammates' calendars reached through this one were broken for the same reason; they are not.
    db.run('UPDATE calendar_connections SET last_error=NULL, needs_reconnect=0, alerted_at=NULL WHERE via_connection_id = ?', existing.id);
  } else {
    const hasWriter = db.get('SELECT 1 FROM calendar_connections WHERE user_id = ? AND write_events = 1', owner);
    db.run('INSERT INTO calendar_connections (user_id, provider, account_email, access_token, refresh_token, expires_at, write_events) VALUES (?,?,?,?,?,?,?)',
      owner, provider, email, encrypt(t.access_token), encrypt(t.refresh_token), expires, hasWriter ? 0 : 1);
  }
  return { userId: owner, email, forTarget: !!row.target_user_id };
}

async function accessToken(conn) {
  if (conn.expires_at && conn.expires_at > Date.now() + 60000) return decrypt(conn.access_token);
  const refresh = decrypt(conn.refresh_token);
  if (!refresh) throw new Error('Calendar needs to be reconnected');
  const t = await tokenRequest(conn.provider, { grant_type: 'refresh_token', refresh_token: refresh });
  const expires = Date.now() + (Number(t.expires_in) || 3600) * 1000;
  db.run('UPDATE calendar_connections SET access_token=?, refresh_token=COALESCE(?, refresh_token), expires_at=?, last_error=NULL, needs_reconnect=0, alerted_at=NULL WHERE id=?',
    encrypt(t.access_token), t.refresh_token ? encrypt(t.refresh_token) : null, expires, conn.id);
  conn.expires_at = expires;
  return t.access_token;
}

/**
 * A teammate's shared calendar has no sign-in of its own: it borrows the admin's Outlook connection
 * it was set up through. Everything that needs a token asks for it here, so the two kinds of row
 * look the same to the rest of the app.
 */
function sourceOf(conn) {
  if (!conn.via_connection_id) return conn;
  const src = db.get('SELECT * FROM calendar_connections WHERE id = ?', conn.via_connection_id);
  if (!src) throw new Error('This shared calendar needs to be reconnected: the Outlook account it went through was disconnected.');
  return src;
}
async function tokenFor(conn) {
  const at = await accessToken(sourceOf(conn));
  if (conn.via_connection_id && conn.needs_reconnect) {
    db.run('UPDATE calendar_connections SET needs_reconnect = 0, alerted_at = NULL WHERE id = ?', conn.id);
    conn.needs_reconnect = 0;
  }
  return at;
}

/** Graph address of a connection's calendar: the signed-in person's own, or the one shared with them. */
const graphCal = (conn) => (conn.mailbox
  ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(conn.mailbox)}/calendar`
  : 'https://graph.microsoft.com/v1.0/me');

function graphError(data, status, what) {
  const e = new Error((data && data.error && data.error.message) || `${what} ${status}`);
  e.status = status; e.code = data && data.error && data.error.code;
  return e;
}
// Graph's ways of saying "you may not look at this mailbox's calendar".
const noAccess = (e) => e.status === 403 || e.status === 404 || /ErrorAccessDenied|ErrorItemNotFound|ErrorInvalidUser|ErrorFolderNotFound/.test(String(e.code || ''));

/**
 * The scopes a Microsoft sign-in was granted, read from the access token, or null when the token is
 * not one that can be read (personal accounts). Only used to explain a refusal, never to decide one.
 */
function grantedScopes(accessTokenValue) {
  try {
    const part = String(accessTokenValue || '').split('.')[1];
    const scp = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')).scp;
    return typeof scp === 'string' ? scp.split(' ') : null;
  } catch { return null; }
}
const hasSharedScope = (at) => { const s = grantedScopes(at); return s === null ? null : s.some((x) => /^Calendars\.(Read|ReadWrite)\.Shared$/i.test(x)); };

/**
 * Free and busy times for a colleague in the same Microsoft 365 organisation. Works with nothing
 * shared at all (Outlook shows free/busy to colleagues by default), but gives no detail, so it is
 * the fallback when the calendar itself cannot be read.
 */
async function scheduleEntries(conn, at, fromMs, toMs) {
  const out = [];
  const DAY = 86400000;
  for (let s = fromMs; s < toMs; s += 60 * DAY) {
    const e = Math.min(toMs, s + 60 * DAY);
    const r = await fetch('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
      method: 'POST', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json', Prefer: 'outlook.timezone="UTC"' },
      body: JSON.stringify({ schedules: [conn.mailbox], startTime: { dateTime: new Date(s).toISOString().slice(0, 19), timeZone: 'UTC' }, endTime: { dateTime: new Date(e).toISOString().slice(0, 19), timeZone: 'UTC' }, availabilityViewInterval: 30 }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw graphError(data, r.status, 'Graph getSchedule');
    const sched = (data.value || [])[0] || {};
    if (sched.error) throw Object.assign(new Error(sched.error.message || `Could not read ${conn.mailbox}'s free/busy times`), { code: sched.error.responseCode, status: 403 });
    for (const it of sched.scheduleItems || []) {
      const start = Date.parse(String(it.start.dateTime).replace(/Z?$/, 'Z')), end = Date.parse(String(it.end.dateTime).replace(/Z?$/, 'Z'));
      out.push({ start, end, all_day: end - start >= 23.5 * 3600000, show_as: String(it.status || ''), subject: String(it.subject || ''), inferred: true });
    }
  }
  return out;
}

/**
 * Errors that only the person can fix by signing in again: access revoked, the sign-in expired, or
 * the stored token can no longer be read. Anything else (a timeout, Google having a bad minute) is
 * recorded but is not a reason to tell anyone to reconnect.
 */
const RECONNECT_RE = /invalid_grant|expired or revoked|been revoked|needs to be reconnected|AADSTS(700082|50173|65001|50076|70043)|interaction_required|consent_required/i;
const needsReconnect = (msg) => RECONNECT_RE.test(String(msg || ''));

function markError(conn, e) {
  const msg = String(e.message || e).slice(0, 300);
  db.run('UPDATE calendar_connections SET last_error = ?, needs_reconnect = CASE WHEN ? THEN 1 ELSE needs_reconnect END WHERE id = ?', msg, needsReconnect(msg) ? 1 : 0, conn.id);
}

/**
 * Refresh a connection's sign-in now, whether or not its access has run out. Used by the health
 * check: it finds a revoked or expired calendar before a customer meets it, and using the sign-in
 * regularly stops Google retiring it for being idle.
 */
async function checkConnection(conn) {
  if (conn.via_connection_id) return checkShared(conn);
  try {
    conn.expires_at = 0;
    await accessToken(conn);
    db.run('UPDATE calendar_connections SET checked_at = ? WHERE id = ?', Date.now(), conn.id);
    return { ok: true };
  } catch (e) {
    markError(conn, e);
    db.run('UPDATE calendar_connections SET checked_at = ? WHERE id = ?', Date.now(), conn.id);
    return { ok: false, reconnect: needsReconnect(e.message), error: e.message };
  }
}

/**
 * How far an admin's connection can reach into a teammate's calendar:
 *   edit       read busy times and add bookings to it
 *   read       read busy times only (shared without edit rights)
 *   free_busy  nothing shared, but free/busy works inside the same Microsoft 365 organisation
 *   none       nothing at all (wrong address, or a different organisation)
 */
async function checkShared(conn) {
  const now = Date.now();
  let at;
  try {
    at = await tokenFor(conn);
  } catch (e) {
    markError(conn, e);
    db.run('UPDATE calendar_connections SET checked_at = ? WHERE id = ?', now, conn.id);
    return { ok: false, reconnect: needsReconnect(e.message), error: e.message };
  }
  let level = 'none', note = null;
  try {
    const r = await fetch(`${graphCal(conn)}?$select=canEdit,name`, { headers: { Authorization: `Bearer ${at}` }, signal: AbortSignal.timeout(10000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw graphError(data, r.status, 'Graph calendar');
    level = data.canEdit ? 'edit' : 'read';
    if (!data.canEdit) note = `${conn.mailbox} shared their calendar without edit rights, so busy times are checked but bookings cannot be added to it.`;
  } catch (e) {
    if (!noAccess(e)) {
      markError(conn, e);
      db.run('UPDATE calendar_connections SET checked_at = ? WHERE id = ?', now, conn.id);
      return { ok: false, reconnect: false, error: e.message };
    }
    try {
      await scheduleEntries(conn, at, now, now + 86400000);
      level = 'free_busy';
    } catch { level = 'none'; }
    const scoped = hasSharedScope(at);
    note = scoped === false
      ? 'Your Outlook sign-in is from before shared calendars were supported. Reconnect your own Outlook once on Calendars, then check again.'
      : level === 'free_busy'
        ? `${conn.mailbox} has not shared their calendar with you, so only free/busy times are checked and bookings cannot be added to it. In Outlook they share it with you as "Can edit".`
        : `Could not reach ${conn.mailbox}'s calendar. Check the address, and that they are in your Microsoft 365 organisation.`;
  }
  db.run('UPDATE calendar_connections SET access_level = ?, last_error = ?, checked_at = ? WHERE id = ?', level, note, now, conn.id);
  return { ok: true, access: level, note, needs_scope: hasSharedScope(at) === false };
}

/** Tell Google to forget a connection when it is removed here, so no access is left behind. */
async function revoke(conn) {
  // A shared calendar borrows someone else's sign-in, which must stay exactly as it was.
  if (!conn || conn.provider !== 'google' || conn.via_connection_id) return;
  const t = decrypt(conn.refresh_token) || decrypt(conn.access_token);
  if (!t) return;
  try {
    await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t }).toString(), signal: AbortSignal.timeout(8000) });
  } catch { /* best effort: the connection is gone from here either way */ }
}

const busyCache = new Map();
/**
 * Everything one connected calendar says is taken, with enough about each entry to decide whether
 * it should really stop someone booking.
 *
 * Kept separate from the filtering below so the admin can be shown exactly what the app sees. An
 * empty booking calendar is impossible to explain otherwise: the page just offers nothing, and the
 * reason is sitting in an API response nobody can look at.
 */
async function fetchBusyEntries(conn, fromMs, toMs) {
  const at = await tokenFor(conn);
  const out = [];
  if (conn.provider === 'google') {
    const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), items: [{ id: conn.calendar_id || 'primary' }] }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || `Google freeBusy ${r.status}`);
    for (const cal of Object.values(data.calendars || {})) {
      for (const b of cal.busy || []) {
        const start = Date.parse(b.start), end = Date.parse(b.end);
        // Google's free/busy hands back anonymous blocks, so whether this was an all-day entry has
        // to be guessed from its length. Marked as a guess, because it is one.
        out.push({ start, end, all_day: end - start >= 23.5 * 3600000, show_as: '', subject: '', inferred: true });
      }
    }
    return out;
  }
  try { return await calendarViewEntries(conn, at, fromMs, toMs); } catch (e) {
    // A teammate who has not shared their calendar still has free/busy times we can see.
    if (!conn.mailbox || !noAccess(e)) throw e;
    const entries = await scheduleEntries(conn, at, fromMs, toMs);
    if (conn.access_level !== 'free_busy') db.run("UPDATE calendar_connections SET access_level = 'free_busy' WHERE id = ?", conn.id);
    return entries;
  }
}

async function calendarViewEntries(conn, at, fromMs, toMs) {
  const out = [];
  let url = `${graphCal(conn)}/calendarView?startDateTime=${new Date(fromMs).toISOString()}&endDateTime=${new Date(toMs).toISOString()}&$select=subject,start,end,showAs,isCancelled,isAllDay&$top=500`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${at}`, Prefer: 'outlook.timezone="UTC"' }, signal: AbortSignal.timeout(10000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw graphError(data, r.status, 'Graph calendarView');
    for (const ev of data.value || []) {
      if (ev.isCancelled) continue;
      out.push({
        start: Date.parse(ev.start.dateTime + 'Z'), end: Date.parse(ev.end.dateTime + 'Z'),
        // Outlook says so outright, so there is nothing to guess at here.
        all_day: !!ev.isAllDay, show_as: String(ev.showAs || ''), subject: String(ev.subject || ''), inferred: false,
      });
    }
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

// An entry that does not really mean "cannot take a call". Marked free, working elsewhere, or - by
// default - an all-day entry, which is usually a label on the day rather than a solid commitment.
function ignoredReason(entry, conn) {
  if (entry.show_as === 'free' || entry.show_as === 'workingElsewhere') return entry.show_as === 'free' ? 'Marked free' : 'Working elsewhere';
  if (entry.all_day && !conn.busy_all_day) return 'All-day entry';
  return null;
}

async function getBusy(userId, fromMs, toMs) {
  const conns = db.all('SELECT * FROM calendar_connections WHERE user_id = ? AND check_busy = 1', userId);
  if (!conns.length) return [];
  const key = `${userId}:${Math.floor(fromMs / 3600000)}:${Math.ceil(toMs / 3600000)}`;
  const hit = busyCache.get(key);
  if (hit && hit.at > Date.now() - 90000) return hit.busy;
  const busy = [];
  await Promise.all(conns.map(async (c) => {
    if (!isConfigured(c.provider)) return;
    try {
      for (const e of await fetchBusyEntries(c, fromMs, toMs)) {
        if (!ignoredReason(e, c)) busy.push([e.start, e.end]);
      }
    } catch (e) { markError(c, e); console.warn(`[calendar] busy lookup failed for connection ${c.id}:`, e.message); }
  }));
  busyCache.set(key, { at: Date.now(), busy });
  return busy;
}

/** What one connection is contributing, and what is being ignored, for the admin to look at. */
async function explainBusy(conn, fromMs, toMs) {
  const entries = await fetchBusyEntries(conn, fromMs, toMs);
  return entries
    .map((e) => ({ ...e, ignored: ignoredReason(e, conn) }))
    .sort((a, b) => a.start - b.start);
}

const clearBusyCache = (userId) => { for (const k of busyCache.keys()) if (k.startsWith(userId + ':')) busyCache.delete(k); };

// The customer plus anyone they invited, in each provider's own shape. Guests are optional attendees.
const googleAttendees = (email, name, guests = []) => [...(email ? [{ email, displayName: name }] : []), ...guests.map((g) => ({ email: g, optional: true }))];
const graphAttendees = (email, name, guests = []) => [...(email ? [{ emailAddress: { address: email, name }, type: 'required' }] : []), ...guests.map((g) => ({ emailAddress: { address: g }, type: 'optional' }))];

async function createEvent(hostUserId, { summary, description, start, end, attendeeEmail, attendeeName, guests, location, locationType, timezone }) {
  const conn = db.get('SELECT * FROM calendar_connections WHERE user_id = ? AND write_events = 1 ORDER BY id LIMIT 1', hostUserId);
  if (!conn || !isConfigured(conn.provider)) return null;
  try {
    const at = await tokenFor(conn);
    if (conn.provider === 'google') {
      const body = {
        summary, description, location: locationType === 'google_meet' ? undefined : location,
        start: { dateTime: new Date(start).toISOString(), timeZone: timezone }, end: { dateTime: new Date(end).toISOString(), timeZone: timezone },
        attendees: googleAttendees(attendeeEmail, attendeeName, guests),
        reminders: { useDefault: true },
      };
      if (locationType === 'google_meet') body.conferenceData = { createRequest: { requestId: token(8), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.calendar_id || 'primary')}/events?conferenceDataVersion=1&sendUpdates=none`, {
        method: 'POST', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || `Google events.insert ${r.status}`);
      return { provider: 'google', connection_id: conn.id, event_id: data.id, join_url: data.hangoutLink || null };
    }
    const body = {
      subject: summary, body: { contentType: 'text', content: description },
      start: { dateTime: new Date(start).toISOString().slice(0, 19), timeZone: 'UTC' }, end: { dateTime: new Date(end).toISOString().slice(0, 19), timeZone: 'UTC' },
      location: location && locationType !== 'teams' ? { displayName: location } : undefined,
      attendees: graphAttendees(attendeeEmail, attendeeName, guests),
    };
    if (locationType === 'teams') { body.isOnlineMeeting = true; body.onlineMeetingProvider = 'teamsForBusiness'; }
    // On a teammate's shared calendar the event is theirs alone: no attendees, because Outlook would
    // send the customer a second invite from the admin's name. Availvo's own email already invites them.
    if (conn.mailbox) delete body.attendees;
    const post = (b) => fetch(`${graphCal(conn)}/events`, {
      method: 'POST', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(15000),
    });
    let r = await post(body);
    let data = await r.json().catch(() => ({}));
    // Someone else's calendar may refuse to make a Teams meeting; the booking still goes on it.
    if (!r.ok && conn.mailbox && body.isOnlineMeeting && r.status !== 403) {
      delete body.isOnlineMeeting; delete body.onlineMeetingProvider;
      r = await post(body); data = await r.json().catch(() => ({}));
    }
    if (!r.ok && conn.mailbox && noAccess(graphError(data, r.status, ''))) {
      db.run("UPDATE calendar_connections SET access_level = CASE WHEN access_level = 'edit' THEN 'read' ELSE access_level END WHERE id = ?", conn.id);
      throw new Error(`Could not add the booking to ${conn.mailbox}'s calendar: it is not shared with edit rights.`);
    }
    if (!r.ok) throw graphError(data, r.status, 'Graph create event');
    return { provider: 'microsoft', connection_id: conn.id, event_id: data.id, join_url: data.onlineMeeting?.joinUrl || null };
  } catch (e) { markError(conn, e); console.warn('[calendar] create event failed:', e.message); return null; } finally { clearBusyCache(hostUserId); }
}

async function deleteEvent(ext) {
  const conn = db.get('SELECT * FROM calendar_connections WHERE id = ?', ext.connection_id);
  if (!conn || !isConfigured(conn.provider)) return;
  try {
    const at = await tokenFor(conn);
    const url = conn.provider === 'google'
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.calendar_id || 'primary')}/events/${encodeURIComponent(ext.event_id)}?sendUpdates=none`
      : `${graphCal(conn)}/events/${encodeURIComponent(ext.event_id)}`;
    await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${at}` }, signal: AbortSignal.timeout(10000) });
    clearBusyCache(conn.user_id);
  } catch (e) { markError(conn, e); }
}

// Change who is on an event that already exists. A calendar that will not take the change is
// logged, not raised: the guest still has their emailed invite.
async function updateAttendees(ext, { attendeeEmail, attendeeName, guests }) {
  const conn = db.get('SELECT * FROM calendar_connections WHERE id = ?', ext.connection_id);
  if (!conn || !isConfigured(conn.provider)) return;
  // Events on a shared calendar carry no attendees (see createEvent), so there is nothing to change.
  if (conn.mailbox) return;
  try {
    const at = await tokenFor(conn);
    const google = conn.provider === 'google';
    const url = google
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.calendar_id || 'primary')}/events/${encodeURIComponent(ext.event_id)}?sendUpdates=none`
      : `${graphCal(conn)}/events/${encodeURIComponent(ext.event_id)}`;
    const attendees = google ? googleAttendees(attendeeEmail, attendeeName, guests) : graphAttendees(attendeeEmail, attendeeName, guests);
    const r = await fetch(url, { method: 'PATCH', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ attendees }), signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`${conn.provider} update event ${r.status}`);
  } catch (e) { markError(conn, e); console.warn('[calendar] update attendees failed:', e.message); }
}

/**
 * Point a teammate's profile at their Outlook calendar, reached through an admin's own Outlook
 * connection. Saves first and then checks, so the admin is told straight away what it can do.
 */
async function addShared({ targetUserId, sourceConn, mailbox }) {
  const box = String(mailbox || '').trim().toLowerCase();
  let row = db.get('SELECT * FROM calendar_connections WHERE user_id = ? AND mailbox = ?', targetUserId, box);
  if (row) {
    db.run('UPDATE calendar_connections SET via_connection_id = ?, needs_reconnect = 0, alerted_at = NULL, last_error = NULL WHERE id = ?', sourceConn.id, row.id);
  } else {
    const hasWriter = db.get('SELECT 1 FROM calendar_connections WHERE user_id = ? AND write_events = 1', targetUserId);
    const id = db.run('INSERT INTO calendar_connections (user_id, provider, account_email, mailbox, via_connection_id, write_events) VALUES (?,?,?,?,?,?)',
      targetUserId, 'microsoft', box, box, sourceConn.id, hasWriter ? 0 : 1).lastId;
    row = { id };
  }
  clearBusyCache(targetUserId);
  const fresh = db.get('SELECT * FROM calendar_connections WHERE id = ?', row.id);
  const check = await checkShared(fresh);
  return { id: row.id, ...check };
}

module.exports = { addShared, checkShared, grantedScopes, needsReconnect, checkConnection, revoke, explainBusy, ignoredReason, PROVIDERS, isConfigured, startAuth, finishAuth, stateRow, getBusy, createEvent, updateAttendees, deleteEvent, clearBusyCache };
