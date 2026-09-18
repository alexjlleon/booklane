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
    scopes: 'offline_access openid email User.Read Calendars.ReadWrite',
    extraAuth: { prompt: 'select_account', response_mode: 'query' },
  },
};

const isConfigured = (p) => !!(PROVIDERS[p] && PROVIDERS[p].clientId() && PROVIDERS[p].clientSecret());
const redirectUri = (p) => `${baseUrl()}/oauth/${p}/callback`;

function startAuth(provider, userId) {
  const P = PROVIDERS[provider];
  const state = token(18);
  db.run('DELETE FROM oauth_states WHERE created_at < ?', Date.now() - 15 * 60000);
  db.run('INSERT INTO oauth_states (state, user_id, provider, created_at) VALUES (?,?,?,?)', state, userId, provider, Date.now());
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

async function finishAuth(provider, code, state, sessionUserId) {
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
  const existing = db.get('SELECT id FROM calendar_connections WHERE user_id = ? AND provider = ? AND account_email IS ?', row.user_id, provider, email);
  const expires = Date.now() + (Number(t.expires_in) || 3600) * 1000;
  if (existing) {
    db.run('UPDATE calendar_connections SET access_token=?, refresh_token=COALESCE(?, refresh_token), expires_at=?, last_error=NULL WHERE id=?',
      encrypt(t.access_token), t.refresh_token ? encrypt(t.refresh_token) : null, expires, existing.id);
  } else {
    const hasWriter = db.get('SELECT 1 FROM calendar_connections WHERE user_id = ? AND write_events = 1', row.user_id);
    db.run('INSERT INTO calendar_connections (user_id, provider, account_email, access_token, refresh_token, expires_at, write_events) VALUES (?,?,?,?,?,?,?)',
      row.user_id, provider, email, encrypt(t.access_token), encrypt(t.refresh_token), expires, hasWriter ? 0 : 1);
  }
  return { userId: row.user_id, email };
}

async function accessToken(conn) {
  if (conn.expires_at && conn.expires_at > Date.now() + 60000) return decrypt(conn.access_token);
  const refresh = decrypt(conn.refresh_token);
  if (!refresh) throw new Error('Calendar needs to be reconnected');
  const t = await tokenRequest(conn.provider, { grant_type: 'refresh_token', refresh_token: refresh });
  const expires = Date.now() + (Number(t.expires_in) || 3600) * 1000;
  db.run('UPDATE calendar_connections SET access_token=?, refresh_token=COALESCE(?, refresh_token), expires_at=?, last_error=NULL WHERE id=?',
    encrypt(t.access_token), t.refresh_token ? encrypt(t.refresh_token) : null, expires, conn.id);
  conn.expires_at = expires;
  return t.access_token;
}

function markError(conn, e) { db.run('UPDATE calendar_connections SET last_error = ? WHERE id = ?', String(e.message || e).slice(0, 300), conn.id); }

const busyCache = new Map();
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
      const at = await accessToken(c);
      if (c.provider === 'google') {
        const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
          method: 'POST', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), items: [{ id: c.calendar_id || 'primary' }] }),
          signal: AbortSignal.timeout(10000),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error?.message || `Google freeBusy ${r.status}`);
        for (const cal of Object.values(data.calendars || {})) for (const b of cal.busy || []) busy.push([Date.parse(b.start), Date.parse(b.end)]);
      } else {
        let url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${new Date(fromMs).toISOString()}&endDateTime=${new Date(toMs).toISOString()}&$select=start,end,showAs,isCancelled&$top=500`;
        while (url) {
          const r = await fetch(url, { headers: { Authorization: `Bearer ${at}`, Prefer: 'outlook.timezone="UTC"' }, signal: AbortSignal.timeout(10000) });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error?.message || `Graph calendarView ${r.status}`);
          for (const ev of data.value || []) {
            if (ev.isCancelled || ev.showAs === 'free' || ev.showAs === 'workingElsewhere') continue;
            busy.push([Date.parse(ev.start.dateTime + 'Z'), Date.parse(ev.end.dateTime + 'Z')]);
          }
          url = data['@odata.nextLink'] || null;
        }
      }
    } catch (e) { markError(c, e); console.warn(`[calendar] busy lookup failed for connection ${c.id}:`, e.message); }
  }));
  busyCache.set(key, { at: Date.now(), busy });
  return busy;
}
const clearBusyCache = (userId) => { for (const k of busyCache.keys()) if (k.startsWith(userId + ':')) busyCache.delete(k); };

async function createEvent(hostUserId, { summary, description, start, end, attendeeEmail, attendeeName, location, locationType, timezone }) {
  const conn = db.get('SELECT * FROM calendar_connections WHERE user_id = ? AND write_events = 1 ORDER BY id LIMIT 1', hostUserId);
  if (!conn || !isConfigured(conn.provider)) return null;
  try {
    const at = await accessToken(conn);
    if (conn.provider === 'google') {
      const body = {
        summary, description, location: locationType === 'google_meet' ? undefined : location,
        start: { dateTime: new Date(start).toISOString(), timeZone: timezone }, end: { dateTime: new Date(end).toISOString(), timeZone: timezone },
        attendees: attendeeEmail ? [{ email: attendeeEmail, displayName: attendeeName }] : [],
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
      attendees: attendeeEmail ? [{ emailAddress: { address: attendeeEmail, name: attendeeName }, type: 'required' }] : [],
    };
    if (locationType === 'teams') { body.isOnlineMeeting = true; body.onlineMeetingProvider = 'teamsForBusiness'; }
    const r = await fetch('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || `Graph create event ${r.status}`);
    return { provider: 'microsoft', connection_id: conn.id, event_id: data.id, join_url: data.onlineMeeting?.joinUrl || null };
  } catch (e) { markError(conn, e); console.warn('[calendar] create event failed:', e.message); return null; } finally { clearBusyCache(hostUserId); }
}

async function deleteEvent(ext) {
  const conn = db.get('SELECT * FROM calendar_connections WHERE id = ?', ext.connection_id);
  if (!conn || !isConfigured(conn.provider)) return;
  try {
    const at = await accessToken(conn);
    const url = conn.provider === 'google'
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.calendar_id || 'primary')}/events/${encodeURIComponent(ext.event_id)}?sendUpdates=none`
      : `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(ext.event_id)}`;
    await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${at}` }, signal: AbortSignal.timeout(10000) });
    clearBusyCache(conn.user_id);
  } catch (e) { markError(conn, e); }
}

module.exports = { PROVIDERS, isConfigured, startAuth, finishAuth, getBusy, createEvent, deleteEvent, clearBusyCache };
