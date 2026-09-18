'use strict';
const db = require('../db');
const T = require('../lib/time');
const { HttpError } = require('../lib/router');
const { hashPassword, verifyPassword, token, rateLimit } = require('../lib/security');
const { createSession, destroySession, requireAuth, requireRole, ROLE_RANK } = require('../lib/auth');
const { isEmail, clampStr, int, num, bool, slugify, deepMerge, baseUrl } = require('../lib/util');
const { sendEmail, layout } = require('../lib/email');
const { BUSINESS_SETTINGS, DEFAULT_STEPS, LOCATION_TYPES } = require('../defaults');
const B = require('../services/business');
const L = require('../services/leads');
const Q = require('../services/quotes');
const BK = require('../services/bookings');
const calendars = require('../services/calendars');
const { pushToBoothBook, sendWebhook, buildBoothBookPayload } = require('../services/integrations');
const { createBusiness, uniqueSlug, ensureDefaultAvailability } = require('../services/setup');

const authLimit = rateLimit({ windowMs: 15 * 60000, max: 25 });
const SECRET_MASK = '••••••••';
const bid = (req) => req.membership.id;
const isAdmin = (req) => ROLE_RANK[req.membership?.role] >= ROLE_RANK.admin;

function meResponse(req) {
  return { user: req.user, business: req.membership ? { ...req.membership } : null, businesses: req.memberships || [],
    app: { base_url: baseUrl(), calendars: Object.fromEntries(Object.entries(calendars.PROVIDERS).map(([k, p]) => [k, { label: p.label, configured: calendars.isConfigured(k) }])), email_provider: process.env.RESEND_API_KEY ? 'resend' : 'log' } };
}

function sanitizeSteps(steps) {
  if (!Array.isArray(steps)) throw new HttpError(422, 'Steps must be a list');
  const Q_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'choice', 'multi'];
  const out = steps.slice(0, 12).map((s, i) => {
    const type = ['schedule', 'contact', 'questions'].includes(s.type) ? s.type : 'questions';
    const step = { key: slugify(s.key || s.title || `step-${i + 1}`) || `step-${i + 1}`, type, title: clampStr(s.title || '', 120), subtitle: clampStr(s.subtitle || '', 240) };
    if (type === 'contact') {
      const f = s.fields || {};
      const mode = (v, def) => (['required', 'optional', 'hidden'].includes(v) ? v : def);
      step.fields = { first_name: mode(f.first_name, 'required'), last_name: mode(f.last_name, 'required'), email: 'required', phone: mode(f.phone, 'required'), sms_consent: mode(f.sms_consent, 'optional') };
    }
    if (type === 'questions') {
      step.questions = (Array.isArray(s.questions) ? s.questions : []).slice(0, 15).map((q, j) => ({
        id: slugify(q.id || q.label || `q${j + 1}`).replace(/-/g, '_') || `q${j + 1}`, label: clampStr(q.label || 'Question', 160), type: Q_TYPES.includes(q.type) ? q.type : 'text',
        options: Array.isArray(q.options) ? q.options.map((o) => clampStr(String(o), 120)).filter(Boolean).slice(0, 30) : [],
        required: !!q.required, placeholder: clampStr(q.placeholder || '', 120), display: q.display === 'cards' ? 'cards' : 'list', use_services: !!q.use_services,
      }));
    }
    return step;
  });
  const keys = new Set();
  for (const s of out) { while (keys.has(s.key)) s.key += '-2'; keys.add(s.key); }
  if (out.filter((s) => s.type === 'schedule').length !== 1) throw new HttpError(422, 'A booking form needs exactly one "Pick a time" step');
  if (out.filter((s) => s.type === 'contact').length !== 1) throw new HttpError(422, 'A booking form needs exactly one "Contact info" step');
  return out;
}

function sanitizeService(body) {
  const id = (v, fallback) => slugify(v || fallback).replace(/-/g, '_').slice(0, 40) || token(4);
  return {
    category: clampStr(body.category, 80), name: clampStr(body.name || 'Untitled service', 120), description: clampStr(body.description, 1000), image_url: clampStr(body.image_url, 500),
    pricing_type: ['flat', 'hourly', 'per_unit'].includes(body.pricing_type) ? body.pricing_type : 'flat', base_price: Math.max(0, num(body.base_price)),
    unit_label: clampStr(body.unit_label, 30), min_qty: int(body.min_qty, 1, 1, 10000), max_qty: int(body.max_qty, 1, 1, 10000), default_qty: int(body.default_qty, 1, 1, 10000),
    badge: clampStr(body.badge, 40), active: body.active === undefined ? 1 : bool(body.active) ? 1 : 0,
    option_groups: JSON.stringify((Array.isArray(body.option_groups) ? body.option_groups : []).slice(0, 10).map((g, i) => ({
      id: id(g.id, g.name || `group${i}`), name: clampStr(g.name || 'Options', 80), mode: ['base', 'add', 'per_unit'].includes(g.mode) ? g.mode : 'add', required: !!g.required, multi: !!g.multi,
      choices: (Array.isArray(g.choices) ? g.choices : []).slice(0, 20).map((c, j) => ({ id: id(c.id, c.name || `c${j}`), name: clampStr(c.name || 'Choice', 80), price: num(c.price), description: clampStr(c.description, 300), default: !!c.default })),
    }))),
    addons: JSON.stringify((Array.isArray(body.addons) ? body.addons : []).slice(0, 30).map((a, i) => ({
      id: id(a.id, a.name || `addon${i}`), name: clampStr(a.name || 'Add-on', 80), price: num(a.price), per: a.per === 'unit' ? 'unit' : 'each', max: int(a.max, 1, 1, 999), description: clampStr(a.description, 300),
    }))),
  };
}

function maskBusiness(b, req) {
  const s = JSON.parse(JSON.stringify(b.settings));
  if (req && !isAdmin(req)) {
    s.integrations = { boothbook: { enabled: s.integrations.boothbook.enabled }, webhook: { enabled: s.integrations.webhook.enabled } };
    return { ...b, settings: s };
  }
  if (s.integrations.boothbook.secret) s.integrations.boothbook.secret = SECRET_MASK;
  if (s.integrations.webhook.secret) s.integrations.webhook.secret = SECRET_MASK;
  return { ...b, settings: s };
}

module.exports = function adminRoutes(app) {
  // ---------- Auth ----------
  app.post('/api/admin/auth/signup', (req, res) => {
    authLimit(req);
    const { name, email, password, business_name, timezone } = req.body || {};
    if (process.env.ALLOW_SIGNUP === 'false' && db.get('SELECT 1 FROM users LIMIT 1')) throw new HttpError(403, 'Sign ups are closed. Ask an admin to invite you.');
    const errors = {};
    if (!String(name || '').trim()) errors.name = 'Required';
    if (!isEmail(email)) errors.email = 'Enter a valid email';
    if (String(password || '').length < 8) errors.password = 'Use at least 8 characters';
    if (!String(business_name || '').trim()) errors.business_name = 'Required';
    if (Object.keys(errors).length) throw new HttpError(422, 'Please fix the highlighted fields', errors);
    if (db.get('SELECT 1 FROM users WHERE email = ?', email.trim())) throw new HttpError(409, 'An account with that email already exists. Log in instead.');
    const tz = T.isValidTz(timezone) ? timezone : 'America/Chicago';
    const isFirst = !db.get('SELECT 1 FROM users LIMIT 1');
    const out = db.tx(() => {
      const u = db.run('INSERT INTO users (email, name, password_hash, timezone, is_super_admin) VALUES (?,?,?,?,?)', email.trim().toLowerCase(), clampStr(name.trim(), 120), hashPassword(password), tz, isFirst ? 1 : 0);
      const b = createBusiness({ name: clampStr(business_name.trim(), 120), timezone: tz, email: email.trim().toLowerCase(), ownerId: u.lastId });
      return { userId: u.lastId, businessId: b.id };
    });
    createSession(res, out.userId, out.businessId);
    return { ok: true };
  });

  app.post('/api/admin/auth/login', (req, res) => {
    authLimit(req);
    const { email, password } = req.body || {};
    const u = db.get('SELECT * FROM users WHERE email = ?', String(email || '').trim());
    if (!u || !verifyPassword(password || '', u.password_hash)) throw new HttpError(401, 'Wrong email or password');
    createSession(res, u.id);
    return { ok: true };
  });

  app.post('/api/admin/auth/logout', (req, res) => { destroySession(req, res); return { ok: true }; });
  app.get('/api/admin/auth/me', (req) => { requireAuth(req); return meResponse(req); });
  app.post('/api/admin/auth/switch', (req) => {
    requireAuth(req);
    const m = req.memberships.find((x) => x.id === Number(req.body?.business_id));
    if (!m) throw new HttpError(403, 'Not a member of that business');
    db.run('UPDATE sessions SET business_id = ? WHERE token = ?', m.id, req.session.token);
    return { ok: true };
  });

  app.patch('/api/admin/me', (req) => {
    requireAuth(req);
    const b = req.body || {};
    if (b.name !== undefined) db.run('UPDATE users SET name = ? WHERE id = ?', clampStr(String(b.name).trim() || req.user.name, 120), req.user.id);
    if (b.phone !== undefined) db.run('UPDATE users SET phone = ? WHERE id = ?', clampStr(b.phone, 40), req.user.id);
    if (b.timezone !== undefined) { if (!T.isValidTz(b.timezone)) throw new HttpError(422, 'Unknown timezone'); db.run('UPDATE users SET timezone = ? WHERE id = ?', b.timezone, req.user.id); }
    if (b.new_password) {
      const u = db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
      if (!verifyPassword(b.current_password || '', u.password_hash)) throw new HttpError(422, 'Current password is wrong', { current_password: 'Wrong password' });
      if (String(b.new_password).length < 8) throw new HttpError(422, 'Use at least 8 characters', { new_password: 'Too short' });
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(b.new_password), req.user.id);
    }
    return { ok: true };
  });

  app.post('/api/admin/businesses', (req) => {
    requireAuth(req);
    const name = String(req.body?.name || '').trim();
    if (!name) throw new HttpError(422, 'Business name is required', { name: 'Required' });
    const b = createBusiness({ name: clampStr(name, 120), timezone: req.user.timezone, email: req.user.email, ownerId: req.user.id });
    db.run('UPDATE sessions SET business_id = ? WHERE token = ?', b.id, req.session.token);
    return { ok: true, id: b.id };
  });

  // ---------- Business ----------
  app.get('/api/admin/business', (req) => { requireRole('host')(req); return maskBusiness(B.byId(bid(req)), req); });
  app.patch('/api/admin/business', (req) => {
    requireRole('admin')(req);
    const cur = B.byId(bid(req));
    const body = req.body || {};
    const fields = {};
    if (body.name !== undefined) fields.name = clampStr(String(body.name).trim() || cur.name, 120);
    if (body.slug !== undefined && body.slug !== cur.slug) {
      const s = slugify(body.slug);
      if (!s) throw new HttpError(422, 'Invalid link name', { slug: 'Use letters, numbers and dashes' });
      if (db.get('SELECT 1 FROM businesses WHERE slug = ? AND id != ?', s, cur.id) || uniqueSlug(s) !== s) throw new HttpError(409, 'That link is taken', { slug: 'Taken' });
      fields.slug = s;
    }
    if (body.timezone !== undefined) { if (!T.isValidTz(body.timezone)) throw new HttpError(422, 'Unknown timezone'); fields.timezone = body.timezone; }
    for (const k of ['email', 'phone', 'website', 'logo_url']) if (body[k] !== undefined) fields[k] = clampStr(body[k], 300);
    if (body.brand_color !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(body.brand_color)) throw new HttpError(422, 'Use a hex color like #6d4aff'); fields.brand_color = body.brand_color; }
    if (body.settings && typeof body.settings === 'object') {
      const stored = B.conform(BUSINESS_SETTINGS, db.json(db.get('SELECT settings FROM businesses WHERE id = ?', cur.id).settings, {})) || {};
      const incoming = B.conform(BUSINESS_SETTINGS, body.settings) || {};
      if (incoming.integrations?.boothbook?.secret === SECRET_MASK) delete incoming.integrations.boothbook.secret;
      if (incoming.integrations?.webhook?.secret === SECRET_MASK) delete incoming.integrations.webhook.secret;
      if (incoming.notifications?.team_emails) incoming.notifications.team_emails = [].concat(incoming.notifications.team_emails).map((e) => String(e).trim()).filter(isEmail);
      for (const [name, cfg] of [['BoothBook', incoming.integrations?.boothbook], ['Webhook', incoming.integrations?.webhook]]) {
        if (cfg?.url) { try { const u = new URL(cfg.url); if (!['https:', 'http:'].includes(u.protocol)) throw new Error(); } catch { throw new HttpError(422, `${name} URL must be a valid https:// address`); } }
      }
      const merged = deepMerge(stored, incoming);
      // arrays replace, not merge
      fields.settings = JSON.stringify(merged);
    }
    const keys = Object.keys(fields);
    if (keys.length) db.run(`UPDATE businesses SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), cur.id);
    return maskBusiness(B.byId(cur.id), req);
  });

  // ---------- Dashboard ----------
  app.get('/api/admin/dashboard', (req) => {
    requireRole('host')(req);
    const id = bid(req);
    const days = int(req.query.days, 30, 1, 365);
    const since = `-${days} days`;
    const one = (sql, ...p) => db.get(sql, ...p) || {};
    const leads = one(`SELECT COUNT(*) total, SUM(status = 'partial') partial, SUM(status != 'partial') completed, SUM(status = 'partial' AND (email IS NOT NULL OR phone IS NOT NULL)) recoverable FROM leads WHERE business_id = ? AND created_at >= datetime('now', ?)`, id, since);
    const bookings = one(`SELECT COUNT(*) created, SUM(status = 'cancelled') cancelled FROM bookings WHERE business_id = ? AND created_at >= datetime('now', ?)`, id, since);
    const upcoming = one(`SELECT COUNT(*) c FROM bookings WHERE business_id = ? AND status = 'confirmed' AND start_utc >= ?`, id, new Date().toISOString());
    const quotes = one(`SELECT COUNT(*) built, SUM(status != 'draft') submitted, SUM(status = 'contract_requested') contracts, SUM(next_step = 'callback') callbacks,
      SUM(CASE WHEN status != 'draft' THEN total ELSE 0 END) pipeline, SUM(CASE WHEN status = 'contract_requested' THEN total ELSE 0 END) contract_value
      FROM quotes WHERE business_id = ? AND created_at >= datetime('now', ?) AND total > 0`, id, since);
    const funnelRows = db.all(`SELECT source, event_type_id, max_step_index, status, COUNT(*) c FROM leads WHERE business_id = ? AND created_at >= datetime('now', ?) GROUP BY 1,2,3,4`, id, since);
    const eventTypes = db.all('SELECT id, name, steps FROM event_types WHERE business_id = ?', id).map((e) => ({ id: e.id, name: e.name, steps: db.json(e.steps, []).map((s) => s.title || s.key) }));
    const series = db.all(`SELECT date(created_at) d, COUNT(*) leads, SUM(status != 'partial') completed FROM leads WHERE business_id = ? AND created_at >= datetime('now', ?) GROUP BY 1 ORDER BY 1`, id, since);
    const upcomingList = db.all(`SELECT b.id, b.start_utc, b.name, b.email, b.phone, e.name event_name, u.name host FROM bookings b LEFT JOIN event_types e ON e.id = b.event_type_id LEFT JOIN users u ON u.id = b.host_user_id
      WHERE b.business_id = ? AND b.status = 'confirmed' AND b.start_utc >= ? ORDER BY b.start_utc LIMIT 6`, id, new Date().toISOString());
    const activity = db.all(`SELECT a.*, l.first_name, l.last_name, l.email FROM activity a LEFT JOIN leads l ON l.id = a.lead_id WHERE a.business_id = ? ORDER BY a.id DESC LIMIT 12`, id);
    return { days, leads, bookings: { ...bookings, upcoming: upcoming.c }, quotes, funnelRows, eventTypes, series, upcoming: upcomingList, activity };
  });

  // ---------- Leads ----------
  app.get('/api/admin/leads', (req) => {
    requireRole('host')(req);
    const where = ['l.business_id = ?']; const p = [bid(req)];
    if (req.query.status) { where.push('l.status = ?'); p.push(req.query.status); }
    if (req.query.source) { where.push('l.source = ?'); p.push(req.query.source); }
    if (req.query.hide_anonymous === '1') where.push("(l.email IS NOT NULL OR l.phone IS NOT NULL OR l.first_name IS NOT NULL)");
    if (req.query.q) { where.push('(l.first_name LIKE ? OR l.last_name LIKE ? OR l.email LIKE ? OR l.phone LIKE ?)'); const like = `%${req.query.q}%`; p.push(like, like, like, like); }
    const page = int(req.query.page, 1, 1, 10000); const per = 50;
    const total = db.get(`SELECT COUNT(*) c FROM leads l WHERE ${where.join(' AND ')}`, ...p).c;
    const rows = db.all(`SELECT l.id, l.token, l.source, l.status, l.first_name, l.last_name, l.email, l.phone, l.step_index, l.max_step_index, l.step_total, l.last_activity_at, l.created_at, l.answers,
        e.name event_name, (SELECT total FROM quotes q WHERE q.lead_id = l.id ORDER BY q.id DESC LIMIT 1) quote_total,
        (SELECT start_utc FROM bookings bk WHERE bk.lead_id = l.id AND bk.status = 'confirmed' ORDER BY bk.start_utc DESC LIMIT 1) booking_start
      FROM leads l LEFT JOIN event_types e ON e.id = l.event_type_id WHERE ${where.join(' AND ')} ORDER BY l.last_activity_at DESC LIMIT ? OFFSET ?`, ...p, per, (page - 1) * per)
      .map((r) => ({ ...r, answers: db.json(r.answers, {}) }));
    return { total, page, per, rows };
  });

  app.get('/api/admin/leads/export.csv', (req, res) => {
    requireRole('admin')(req);
    const rows = db.all(`SELECT l.*, e.name event_name FROM leads l LEFT JOIN event_types e ON e.id = l.event_type_id WHERE l.business_id = ? ORDER BY l.id DESC`, bid(req));
    const answerKeys = [...new Set(rows.flatMap((r) => Object.keys(db.json(r.answers, {}))))];
    const head = ['id', 'created_at', 'last_activity_at', 'source', 'status', 'form', 'step_reached', 'first_name', 'last_name', 'email', 'phone', 'sms_consent', ...answerKeys];
    const cell = (v) => { let s = Array.isArray(v) ? v.join('; ') : String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [head.join(',')].concat(rows.map((r) => { const a = db.json(r.answers, {}); return [r.id, r.created_at, r.last_activity_at, r.source, r.status, r.event_name || (r.source === 'quote' ? 'Quote builder' : ''), `${r.max_step_index + 1}/${r.step_total || ''}`, r.first_name, r.last_name, r.email, r.phone, r.sms_consent ? 'yes' : 'no', ...answerKeys.map((k) => a[k])].map(cell).join(','); }));
    res.set('Content-Disposition', 'attachment; filename="leads.csv"');
    res.text(lines.join('\n'), 'text/csv; charset=utf-8');
  });

  function getLead(req) {
    const l = db.get('SELECT * FROM leads WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!l) throw new HttpError(404, 'Lead not found');
    return l;
  }
  app.get('/api/admin/leads/:id', (req) => {
    requireRole('host')(req);
    const l = getLead(req);
    const et = l.event_type_id ? BK.hydrateEt(db.get('SELECT * FROM event_types WHERE id = ?', l.event_type_id)) : null;
    const quotes = db.all('SELECT * FROM quotes WHERE lead_id = ? ORDER BY id DESC', l.id).map((q) => ({ ...q, details: db.json(q.details, {}), line_items: db.json(q.line_items, []), contract_request: db.json(q.contract_request, null), callback_request: db.json(q.callback_request, null), sync_log: db.json(q.sync_log, []) }));
    const bookings = db.all('SELECT b.*, e.name event_name, u.name host FROM bookings b LEFT JOIN event_types e ON e.id = b.event_type_id LEFT JOIN users u ON u.id = b.host_user_id WHERE b.lead_id = ? ORDER BY b.start_utc DESC', l.id);
    const activity = db.all('SELECT * FROM activity WHERE lead_id = ? ORDER BY id DESC LIMIT 100', l.id);
    const steps = l.source === 'quote' ? ['Event details', 'Services', 'Contact', 'Review'] : (et?.steps || []).map((s) => s.title || s.key);
    return { lead: { ...l, answers: db.json(l.answers, {}), meta: db.json(l.meta, {}) }, event_type: et ? { id: et.id, name: et.name, slug: et.slug } : null, steps, quotes, bookings, activity, resume_url: L.resumeUrl(B.byId(bid(req)), l) };
  });
  app.patch('/api/admin/leads/:id', (req) => {
    requireRole('host')(req);
    const l = getLead(req);
    const b = req.body || {};
    const STATUSES = ['partial', 'booked', 'quoted', 'contract_requested', 'callback_requested', 'contacted', 'won', 'lost'];
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) throw new HttpError(422, 'Unknown status');
      db.run('UPDATE leads SET status = ? WHERE id = ?', b.status, l.id);
      B.logActivity(l.business_id, l.id, 'status', `${req.user.name} set status to ${b.status.replace(/_/g, ' ')}`);
    }
    if (b.notes !== undefined) db.run('UPDATE leads SET notes = ? WHERE id = ?', clampStr(b.notes, 10000), l.id);
    if (b.contact) L.updateLead(l, { contact: b.contact });
    return { ok: true };
  });
  app.delete('/api/admin/leads/:id', (req) => { requireRole('admin')(req); const l = getLead(req); db.run('DELETE FROM leads WHERE id = ?', l.id); return { ok: true }; });
  app.post('/api/admin/leads/:id/recovery', async (req) => {
    requireRole('host')(req);
    const l = getLead(req);
    if (!l.email) throw new HttpError(422, 'This lead has no email address');
    const r = await L.sendRecoveryEmail(B.byId(bid(req)), l);
    return { ok: r.status !== 'failed', status: r.status };
  });
  app.post('/api/admin/leads/:id/boothbook', async (req) => {
    requireRole('admin')(req);
    const l = getLead(req);
    const q = db.get('SELECT * FROM quotes WHERE lead_id = ? ORDER BY id DESC LIMIT 1', l.id);
    const r = await pushToBoothBook(B.byId(bid(req)), l, q, { test: false });
    if (r.skipped) throw new HttpError(422, 'Turn on the BoothBook integration in Settings first');
    return r;
  });

  // ---------- Bookings ----------
  app.get('/api/admin/bookings', (req) => {
    requireRole('host')(req);
    const now = new Date().toISOString();
    const scope = req.query.scope || 'upcoming';
    const cond = scope === 'past' ? "b.status = 'confirmed' AND b.start_utc < ?" : scope === 'cancelled' ? "b.status = 'cancelled' AND ? IS NOT NULL" : "b.status = 'confirmed' AND b.start_utc >= ?";
    const order = scope === 'upcoming' ? 'ASC' : 'DESC';
    const mine = req.query.mine === '1' ? ' AND b.host_user_id = ' + Number(req.user.id) : '';
    return db.all(`SELECT b.id, b.token, b.start_utc, b.end_utc, b.invitee_tz, b.name, b.email, b.phone, b.location, b.status, b.answers, b.cancel_reason, b.lead_id, b.external_events,
        e.name event_name, e.color, u.name host FROM bookings b LEFT JOIN event_types e ON e.id = b.event_type_id LEFT JOIN users u ON u.id = b.host_user_id
      WHERE b.business_id = ? AND ${cond}${mine} ORDER BY b.start_utc ${order} LIMIT 300`, bid(req), now)
      .map((r) => ({ ...r, answers: db.json(r.answers, {}), synced: db.json(r.external_events, []).length > 0, external_events: undefined }));
  });
  app.post('/api/admin/bookings/:id/cancel', async (req) => {
    requireRole('host')(req);
    const bk = db.get('SELECT * FROM bookings WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!bk) throw new HttpError(404, 'Booking not found');
    await BK.cancelBooking(bk, req.body?.reason, req.user.name);
    return { ok: true };
  });

  // ---------- Event types ----------
  const members = (businessId) => db.all("SELECT u.id, u.name, u.email, u.timezone, m.role FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ? AND m.status = 'active' ORDER BY u.name", businessId);
  function etOut(et) {
    return { ...BK.hydrateEt(et), active: !!et.active, hosts: db.all('SELECT user_id FROM event_type_hosts WHERE event_type_id = ?', et.id).map((r) => r.user_id),
      bookings_30d: db.get("SELECT COUNT(*) c FROM bookings WHERE event_type_id = ? AND created_at >= datetime('now','-30 days')", et.id).c };
  }
  app.get('/api/admin/event-types', (req) => {
    requireRole('host')(req);
    return { event_types: db.all('SELECT * FROM event_types WHERE business_id = ? ORDER BY sort, id', bid(req)).map(etOut), members: members(bid(req)), location_types: LOCATION_TYPES, default_steps: DEFAULT_STEPS() };
  });
  function saveEventType(req, existing) {
    const b = req.body || {};
    const businessId = bid(req);
    const slug = slugify(b.slug || b.name || existing?.slug);
    if (!slug) throw new HttpError(422, 'Give this event type a name', { name: 'Required' });
    if (db.get('SELECT 1 FROM event_types WHERE business_id = ? AND slug = ? AND id != ?', businessId, slug, existing?.id || 0)) throw new HttpError(409, 'Another event type already uses that link', { slug: 'Taken' });
    const f = {
      slug, name: clampStr(b.name ?? existing?.name ?? 'New event', 120), description: clampStr(b.description ?? existing?.description, 2000),
      duration_min: int(b.duration_min ?? existing?.duration_min, 30, 5, 720), location_type: LOCATION_TYPES[b.location_type] ? b.location_type : existing?.location_type || 'phone',
      location_value: clampStr(b.location_value ?? existing?.location_value, 500), buffer_before: int(b.buffer_before ?? existing?.buffer_before, 0, 0, 240), buffer_after: int(b.buffer_after ?? existing?.buffer_after, 0, 0, 240),
      min_notice_min: int(b.min_notice_min ?? existing?.min_notice_min, 240, 0, 60 * 24 * 60), max_days_ahead: int(b.max_days_ahead ?? existing?.max_days_ahead, 60, 1, 730),
      slot_interval_min: int(b.slot_interval_min ?? existing?.slot_interval_min, 30, 5, 720), daily_limit: int(b.daily_limit ?? existing?.daily_limit, 0, 0, 100),
      assignment: b.assignment === 'single' ? 'single' : 'round_robin', color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : existing?.color || '#6d4aff',
      steps: JSON.stringify(b.steps ? sanitizeSteps(b.steps) : existing ? BK.hydrateEt({ ...existing }).steps : DEFAULT_STEPS()),
      active: b.active === undefined ? (existing ? existing.active : 1) : bool(b.active) ? 1 : 0,
    };
    let id = existing?.id;
    db.tx(() => {
      if (existing) {
        const keys = Object.keys(f);
        db.run(`UPDATE event_types SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => f[k]), id);
      } else {
        const keys = Object.keys(f);
        const sort = (db.get('SELECT MAX(sort) m FROM event_types WHERE business_id = ?', businessId).m || 0) + 1;
        id = db.run(`INSERT INTO event_types (business_id, sort, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`, businessId, sort, ...keys.map((k) => f[k])).lastId;
      }
      if (Array.isArray(b.hosts) || !existing) {
        const valid = new Set(members(businessId).map((m) => m.id));
        let hosts = (Array.isArray(b.hosts) ? b.hosts : [req.user.id]).map(Number).filter((h) => valid.has(h));
        if (!hosts.length) hosts = [req.user.id];
        db.run('DELETE FROM event_type_hosts WHERE event_type_id = ?', id);
        for (const h of hosts) db.run('INSERT INTO event_type_hosts (event_type_id, user_id) VALUES (?,?)', id, h);
      }
    });
    return etOut(db.get('SELECT * FROM event_types WHERE id = ?', id));
  }
  app.post('/api/admin/event-types', (req) => { requireRole('admin')(req); return saveEventType(req, null); });
  app.patch('/api/admin/event-types/:id', (req) => {
    requireRole('admin')(req);
    const et = db.get('SELECT * FROM event_types WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!et) throw new HttpError(404, 'Not found');
    return saveEventType(req, et);
  });
  app.delete('/api/admin/event-types/:id', (req) => {
    requireRole('admin')(req);
    const r = db.run('DELETE FROM event_types WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!r.changes) throw new HttpError(404, 'Not found');
    return { ok: true };
  });

  // ---------- Availability ----------
  function targetUser(req) {
    const uid = req.query.user_id || req.body?.user_id ? int(req.query.user_id || req.body.user_id) : req.user.id;
    if (uid !== req.user.id) {
      if (!isAdmin(req)) throw new HttpError(403, 'You can only edit your own availability');
      if (!db.get("SELECT 1 FROM memberships WHERE user_id = ? AND business_id = ? AND status = 'active'", uid, bid(req))) throw new HttpError(404, 'Team member not found');
      const outside = db.get(`SELECT 1 FROM memberships t WHERE t.user_id = ? AND t.status = 'active' AND NOT EXISTS (
        SELECT 1 FROM memberships mine WHERE mine.user_id = ? AND mine.business_id = t.business_id AND mine.status = 'active' AND mine.role IN ('owner','admin'))`, uid, req.user.id);
      if (outside && req.method !== 'GET') throw new HttpError(403, 'This person also works with another business, so only they can change their hours');
    }
    return db.get('SELECT id, name, email, timezone FROM users WHERE id = ?', uid);
  }
  app.get('/api/admin/availability', (req) => {
    requireRole('host')(req);
    const u = targetUser(req);
    return { user: u, rules: db.all('SELECT weekday, start_min, end_min FROM availability_rules WHERE user_id = ? ORDER BY weekday, start_min', u.id),
      overrides: db.all("SELECT id, date, start_min, end_min, unavailable FROM date_overrides WHERE user_id = ? AND date >= date('now','-1 day') ORDER BY date, start_min", u.id), members: isAdmin(req) ? members(bid(req)) : [] };
  });
  app.put('/api/admin/availability', (req) => {
    requireRole('host')(req);
    const u = targetUser(req);
    const b = req.body || {};
    if (b.timezone && !T.isValidTz(b.timezone)) throw new HttpError(422, 'Unknown timezone');
    const rules = (Array.isArray(b.rules) ? b.rules : []).slice(0, 70).map((r) => ({ weekday: int(r.weekday, 0, 0, 6), start_min: int(r.start_min, 540, 0, 1440), end_min: int(r.end_min, 1020, 0, 1440) })).filter((r) => r.end_min > r.start_min);
    const overrides = (Array.isArray(b.overrides) ? b.overrides : []).slice(0, 400).filter((o) => T.isDateStr(o.date)).map((o) => ({ date: o.date, unavailable: bool(o.unavailable) ? 1 : 0, start_min: int(o.start_min, 540, 0, 1440), end_min: int(o.end_min, 1020, 0, 1440) }));
    db.tx(() => {
      if (b.timezone) db.run('UPDATE users SET timezone = ? WHERE id = ?', b.timezone, u.id);
      db.run('DELETE FROM availability_rules WHERE user_id = ?', u.id);
      for (const r of rules) db.run('INSERT INTO availability_rules (user_id, weekday, start_min, end_min) VALUES (?,?,?,?)', u.id, r.weekday, r.start_min, r.end_min);
      if (Array.isArray(b.overrides)) {
        db.run("DELETE FROM date_overrides WHERE user_id = ? AND date >= date('now','-1 day')", u.id);
        for (const o of overrides) db.run('INSERT INTO date_overrides (user_id, date, start_min, end_min, unavailable) VALUES (?,?,?,?,?)', u.id, o.date, o.start_min, o.end_min, o.unavailable);
      }
    });
    calendars.clearBusyCache(u.id);
    return { ok: true };
  });

  // ---------- Calendars ----------
  app.get('/api/admin/calendars', (req) => {
    requireAuth(req);
    return { providers: Object.fromEntries(Object.entries(calendars.PROVIDERS).map(([k, p]) => [k, { label: p.label, configured: calendars.isConfigured(k), redirect_uri: `${baseUrl()}/oauth/${k}/callback` }])),
      connections: db.all('SELECT id, provider, account_email, calendar_id, check_busy, write_events, last_error, created_at FROM calendar_connections WHERE user_id = ? ORDER BY id', req.user.id) };
  });
  app.patch('/api/admin/calendars/:id', (req) => {
    requireAuth(req);
    const c = db.get('SELECT * FROM calendar_connections WHERE id = ? AND user_id = ?', int(req.params.id), req.user.id);
    if (!c) throw new HttpError(404, 'Not found');
    const b = req.body || {};
    if (b.check_busy !== undefined) db.run('UPDATE calendar_connections SET check_busy = ? WHERE id = ?', bool(b.check_busy) ? 1 : 0, c.id);
    if (b.write_events !== undefined) {
      if (bool(b.write_events)) db.run('UPDATE calendar_connections SET write_events = 0 WHERE user_id = ?', req.user.id);
      db.run('UPDATE calendar_connections SET write_events = ? WHERE id = ?', bool(b.write_events) ? 1 : 0, c.id);
    }
    if (b.calendar_id) db.run('UPDATE calendar_connections SET calendar_id = ? WHERE id = ?', clampStr(b.calendar_id, 300), c.id);
    calendars.clearBusyCache(req.user.id);
    return { ok: true };
  });
  app.delete('/api/admin/calendars/:id', (req) => {
    requireAuth(req);
    db.run('DELETE FROM calendar_connections WHERE id = ? AND user_id = ?', int(req.params.id), req.user.id);
    calendars.clearBusyCache(req.user.id);
    return { ok: true };
  });

  // ---------- Services (quote catalog) ----------
  app.get('/api/admin/services', (req) => { requireRole('host')(req); return Q.catalog(bid(req), { all: true }); });
  app.post('/api/admin/services', (req) => {
    requireRole('admin')(req);
    const f = sanitizeService(req.body || {});
    const sort = (db.get('SELECT MAX(sort) m FROM services WHERE business_id = ?', bid(req)).m || 0) + 1;
    const keys = Object.keys(f);
    const id = db.run(`INSERT INTO services (business_id, sort, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`, bid(req), sort, ...keys.map((k) => f[k])).lastId;
    return Q.hydrateService(db.get('SELECT * FROM services WHERE id = ?', id));
  });
  app.patch('/api/admin/services/:id', (req) => {
    requireRole('admin')(req);
    const s = db.get('SELECT * FROM services WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!s) throw new HttpError(404, 'Not found');
    const merged = { ...Q.hydrateService({ ...s }), ...(req.body || {}) };
    const f = sanitizeService(merged);
    const keys = Object.keys(f);
    db.run(`UPDATE services SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => f[k]), s.id);
    return Q.hydrateService(db.get('SELECT * FROM services WHERE id = ?', s.id));
  });
  app.delete('/api/admin/services/:id', (req) => { requireRole('admin')(req); db.run('DELETE FROM services WHERE id = ? AND business_id = ?', int(req.params.id), bid(req)); return { ok: true }; });
  app.post('/api/admin/services/reorder', (req) => {
    requireRole('admin')(req);
    (req.body?.ids || []).forEach((id, i) => db.run('UPDATE services SET sort = ? WHERE id = ? AND business_id = ?', i, int(id), bid(req)));
    return { ok: true };
  });

  // ---------- Quotes ----------
  app.get('/api/admin/quotes', (req) => {
    requireRole('host')(req);
    const where = ['q.business_id = ?', 'q.total > 0']; const p = [bid(req)];
    if (req.query.status) { where.push('q.status = ?'); p.push(req.query.status); }
    return db.all(`SELECT q.id, q.token, q.status, q.total, q.deposit, q.next_step, q.sync_status, q.details, q.line_items, q.created_at, q.updated_at, l.id lead_id, l.first_name, l.last_name, l.email, l.phone
      FROM quotes q LEFT JOIN leads l ON l.id = q.lead_id WHERE ${where.join(' AND ')} ORDER BY q.updated_at DESC LIMIT 300`, ...p)
      .map((q) => ({ ...q, details: db.json(q.details, {}), services: db.json(q.line_items, []).map((l) => l.name), line_items: undefined }));
  });
  app.patch('/api/admin/quotes/:id', (req) => {
    requireRole('host')(req);
    const q = db.get('SELECT * FROM quotes WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!q) throw new HttpError(404, 'Not found');
    const st = req.body?.status;
    if (!['draft', 'submitted', 'contract_requested', 'contract_sent', 'signed', 'declined'].includes(st)) throw new HttpError(422, 'Unknown status');
    db.run("UPDATE quotes SET status = ?, updated_at = datetime('now') WHERE id = ?", st, q.id);
    if (q.lead_id) {
      B.logActivity(q.business_id, q.lead_id, 'quote', `${req.user.name} marked quote as ${st.replace(/_/g, ' ')}`);
      if (st === 'signed') db.run("UPDATE leads SET status = 'won' WHERE id = ?", q.lead_id);
      if (st === 'declined') db.run("UPDATE leads SET status = 'lost' WHERE id = ?", q.lead_id);
    }
    return { ok: true };
  });

  // ---------- Team ----------
  app.get('/api/admin/team', (req) => {
    requireRole('host')(req);
    return db.all('SELECT u.id, u.name, u.email, u.timezone, m.role, m.status FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ? ORDER BY m.status, u.name', bid(req)).map((m) => ({ ...m, has_hours: !!db.get('SELECT 1 FROM availability_rules WHERE user_id = ?', m.id), calendars: db.all('SELECT provider, account_email FROM calendar_connections WHERE user_id = ?', m.id) }));
  });
  app.post('/api/admin/team', async (req) => {
    requireRole('admin')(req);
    const { name, email, role } = req.body || {};
    if (!isEmail(email)) throw new HttpError(422, 'Enter a valid email', { email: 'Invalid' });
    const r = ['host', 'admin', 'owner'].includes(role) ? role : 'host';
    if (r === 'owner' && req.membership.role !== 'owner') throw new HttpError(403, 'Only owners can add owners');
    let u = db.get('SELECT * FROM users WHERE email = ?', email.trim());
    if (!u) {
      // Invited accounts have no password until the invitee sets one from their invite link
      const id = db.run("INSERT INTO users (email, name, password_hash, timezone) VALUES (?,?,'!',?)", email.trim().toLowerCase(), clampStr(name || email.split('@')[0], 120), req.user.timezone).lastId;
      u = db.get('SELECT * FROM users WHERE id = ?', id);
    }
    const existing = db.get('SELECT status FROM memberships WHERE user_id = ? AND business_id = ?', u.id, bid(req));
    if (existing && existing.status === 'active') throw new HttpError(409, 'Already on the team');
    const inviteToken = token(24);
    if (existing) db.run('UPDATE memberships SET role = ?, invite_token = ? WHERE user_id = ? AND business_id = ?', r, inviteToken, u.id, bid(req));
    else db.run("INSERT INTO memberships (user_id, business_id, role, status, invite_token) VALUES (?,?,?,'invited',?)", u.id, bid(req), r, inviteToken);
    const business = B.byId(bid(req));
    const url = `${baseUrl()}/app#/accept/${inviteToken}`;
    const sent = await sendEmail({ to: u.email, businessId: business.id, subject: `${req.user.name} invited you to ${business.name}`,
      html: layout(business, { heading: `Join ${business.name}`, body: `<p>${req.user.name.replace(/[<>&]/g, '')} invited you to take calls and manage leads for ${business.name.replace(/[<>&]/g, '')}.</p>`, cta: { label: 'Accept invite', url } }) });
    B.logActivity(business.id, null, 'team', `${req.user.name} invited ${u.email} as ${r}`);
    // Without an email provider the invite only gets logged, so hand the link to the admin to share
    return { ok: true, user_id: u.id, invited: true, invite_url: sent.status === 'sent' ? null : url };
  });
  app.get('/api/admin/auth/invite/:token', (req) => {
    authLimit(req);
    const m = db.get("SELECT m.role, b.name business, u.email, u.name, u.password_hash FROM memberships m JOIN businesses b ON b.id = m.business_id JOIN users u ON u.id = m.user_id WHERE m.invite_token = ? AND m.status = 'invited'", String(req.params.token));
    if (!m) throw new HttpError(404, 'This invite link is no longer valid');
    return { business: m.business, email: m.email, name: m.name, role: m.role, needs_password: m.password_hash === '!' };
  });
  app.post('/api/admin/auth/accept', (req, res) => {
    authLimit(req);
    const { token: t, password, name } = req.body || {};
    const m = db.get("SELECT * FROM memberships WHERE invite_token = ? AND status = 'invited'", String(t || ''));
    if (!m) throw new HttpError(404, 'This invite link is no longer valid');
    const u = db.get('SELECT * FROM users WHERE id = ?', m.user_id);
    if (u.password_hash === '!') {
      if (String(password || '').length < 8) throw new HttpError(422, 'Use at least 8 characters', { password: 'Too short' });
      db.run('UPDATE users SET password_hash = ?, name = COALESCE(NULLIF(?, \'\'), name) WHERE id = ?', hashPassword(password), clampStr(String(name || '').trim(), 120) || '', u.id);
    } else if (!verifyPassword(password || '', u.password_hash)) {
      throw new HttpError(401, 'Enter the password for your existing account', { password: 'Wrong password' });
    }
    db.run("UPDATE memberships SET status = 'active', invite_token = NULL WHERE user_id = ? AND business_id = ?", m.user_id, m.business_id);
    ensureDefaultAvailability(u.id);
    createSession(res, u.id, m.business_id);
    return { ok: true };
  });
  app.patch('/api/admin/team/:userId', (req) => {
    requireRole('admin')(req);
    const role = req.body?.role;
    if (!['host', 'admin', 'owner'].includes(role)) throw new HttpError(422, 'Unknown role');
    if (role === 'owner' && req.membership.role !== 'owner') throw new HttpError(403, 'Only owners can make owners');
    const target = db.get('SELECT role FROM memberships WHERE user_id = ? AND business_id = ?', int(req.params.userId), bid(req));
    if (!target) throw new HttpError(404, 'Not found');
    if (target.role === 'owner' && req.membership.role !== 'owner') throw new HttpError(403, 'Only owners can change an owner');
    if (target.role === 'owner' && role !== 'owner' && db.get("SELECT COUNT(*) c FROM memberships WHERE business_id = ? AND role = 'owner'", bid(req)).c <= 1) throw new HttpError(422, 'A business needs at least one owner');
    db.run('UPDATE memberships SET role = ? WHERE user_id = ? AND business_id = ?', role, int(req.params.userId), bid(req));
    return { ok: true };
  });
  app.delete('/api/admin/team/:userId', (req) => {
    requireRole('admin')(req);
    const uid = int(req.params.userId);
    const target = db.get('SELECT role FROM memberships WHERE user_id = ? AND business_id = ?', uid, bid(req));
    if (!target) throw new HttpError(404, 'Not found');
    if (target.role === 'owner' && req.membership.role !== 'owner') throw new HttpError(403, 'Only owners can remove an owner');
    if (target.role === 'owner' && db.get("SELECT COUNT(*) c FROM memberships WHERE business_id = ? AND role = 'owner'", bid(req)).c <= 1) throw new HttpError(422, 'A business needs at least one owner');
    db.run('DELETE FROM event_type_hosts WHERE user_id = ? AND event_type_id IN (SELECT id FROM event_types WHERE business_id = ?)', uid, bid(req));
    db.run('DELETE FROM memberships WHERE user_id = ? AND business_id = ?', uid, bid(req));
    return { ok: true };
  });

  // ---------- Integrations & emails ----------
  app.post('/api/admin/integrations/test', async (req) => {
    requireRole('admin')(req);
    const business = B.byId(bid(req));
    const sample = { id: 0, token: 'test', source: 'quote', status: 'contract_requested', first_name: 'Test', last_name: 'Lead', email: 'test@example.com', phone: '555-555-0100', answers: '{}', meta: '{}' };
    const sampleQuote = { id: 0, token: 'test', total: 1234, discount: 0, details: JSON.stringify({ event_date: T.addDays(T.utcToZoned(Date.now(), 'UTC').date, 120), event_type: 'Wedding', venue: 'Sample Venue' }), line_items: '[]', sync_log: '[]' };
    if (req.body?.type === 'boothbook') {
      const preview = { ...buildBoothBookPayload(business, sample, sampleQuote) };
      if (preview.secret) preview.secret = SECRET_MASK;
      if (req.body?.dry_run) return { preview };
      return { preview, result: await pushToBoothBook(business, null, sampleQuote, { test: true }) };
    }
    if (req.body?.type === 'webhook') {
      const cfg = business.settings.integrations.webhook;
      if (!cfg.url) throw new HttpError(422, 'Add a webhook URL first');
      business.settings.integrations.webhook = { ...cfg, enabled: true, events: ['test'] };
      return { result: await sendWebhook(business, 'test', { message: 'Hello from Booklane', lead: L.leadPayload(sample) }) };
    }
    if (req.body?.type === 'email') {
      return { result: await sendEmail({ to: req.user.email, businessId: business.id, subject: 'Test email from Booklane', html: layout(business, { heading: 'Email is working', body: '<p>This is a test message.</p>' }) }) };
    }
    throw new HttpError(422, 'Unknown test type');
  });
  app.get('/api/admin/emails', (req) => {
    requireRole('admin')(req);
    return db.all('SELECT id, to_addr, subject, status, provider, error, created_at FROM email_log WHERE business_id = ? ORDER BY id DESC LIMIT 100', bid(req));
  });
  app.get('/api/admin/emails/:id', (req) => {
    requireRole('admin')(req);
    const e = db.get('SELECT * FROM email_log WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!e) throw new HttpError(404, 'Not found');
    return e;
  });
};
