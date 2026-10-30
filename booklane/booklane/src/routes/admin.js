'use strict';
const db = require('../db');
const T = require('../lib/time');
const { HttpError } = require('../lib/router');
const { hashPassword, verifyPassword, token, rateLimit } = require('../lib/security');
const { createSession, destroySession, requireAuth, requireRole, ROLE_RANK } = require('../lib/auth');
const { isEmail, clampStr, int, num, bool, slugify, deepMerge, baseUrl } = require('../lib/util');
const { sendEmail, layout } = require('../lib/email');
const { BUSINESS_SETTINGS, DEFAULT_STEPS, QUICK_DATE_STEPS, SESSION_SETTINGS, SESSION_STEPS, LOCATION_TYPES } = require('../defaults');
const B = require('../services/business');
const L = require('../services/leads');
const Q = require('../services/quotes');
const BK = require('../services/bookings');
const S = require('../services/scheduling');
const TEAM = require('../services/team');
const calendars = require('../services/calendars');
const { pushToBoothBook, sendWebhook, buildBoothBookPayload } = require('../services/integrations');
const Importer = require('../services/catalog-import');
const ORG = require('../services/org');
const PLACES = require('../services/places');
const SESS = require('../services/sessions');
const FORMS = require('../services/forms');
const FSTYLE = require('../services/form-style');
const UP = require('../services/uploads');
const MSG = require('../services/messaging');
const sms = require('../lib/sms');
const appConfig = require('../lib/config');
const providers = require('../services/providers');
const { createBusiness, uniqueSlug, ensureDefaultAvailability, seedSessions } = require('../services/setup');

const authLimit = rateLimit({ windowMs: 15 * 60000, max: 25 });
const SECRET_MASK = '••••••••';
const bid = (req) => req.membership.id;
const isAdmin = (req) => ROLE_RANK[req.membership?.role] >= ROLE_RANK.admin;

function meResponse(req) {
  const cur = req.membership ? B.byId(req.membership.id) : null;
  return { user: req.user, business: req.membership ? { ...req.membership, custom_domain: cur.custom_domain || null, public_base: B.baseFor(cur), page_url: B.pageUrl(cur, '') } : null, businesses: req.memberships || [],
    calendar_alerts: require('../services/calendar-health').problemsFor(req.user.id, req.membership),
    app: { base_url: baseUrl(), calendars: Object.fromEntries(Object.entries(calendars.PROVIDERS).map(([k, p]) => [k, { label: p.label, configured: calendars.isConfigured(k) }])), email_provider: appConfig.get('RESEND_API_KEY') ? 'resend' : 'log' } };
}

/**
 * Per-option routing: picking this answer books them on another booking page's calendar.
 * Stored as { option label: event type id }. Only pick-one and pick-many questions route, and an
 * option that is no longer on the list loses its route rather than lingering invisibly.
 */
function cleanRoutes(q) {
  if (!['choice', 'multi', 'select'].includes(q.type) || !q.routes || typeof q.routes !== 'object') return {};
  const opts = new Set((Array.isArray(q.options) ? q.options : []).map((o) => clampStr(String(o), 120)));
  const out = {};
  for (const [label, id] of Object.entries(q.routes).slice(0, 30)) {
    const key = clampStr(String(label), 120);
    const n = int(id, 0);
    if (n > 0 && opts.has(key)) out[key] = n;
  }
  return out;
}

function sanitizeSteps(steps) {
  if (!Array.isArray(steps)) throw new HttpError(422, 'Steps must be a list');
  const Q_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'choice', 'multi'];
  const out = steps.slice(0, 12).map((s, i) => {
    const type = ['schedule', 'contact', 'questions', 'availability'].includes(s.type) ? s.type : 'questions';
    const step = { key: slugify(s.key || s.title || `step-${i + 1}`) || `step-${i + 1}`, type, title: clampStr(s.title || '', 120), subtitle: clampStr(s.subtitle || '', 240) };
    if (type === 'contact') {
      const f = s.fields || {};
      const mode = (v, def) => (['required', 'optional', 'hidden'].includes(v) ? v : def);
      step.fields = { first_name: mode(f.first_name, 'required'), last_name: mode(f.last_name, 'required'), email: mode(f.email, 'required'), phone: mode(f.phone, 'required'), sms_consent: mode(f.sms_consent, 'optional') };
      // Short forms may skip email, but the form has to leave us some way to reach the person.
      if (step.fields.email === 'hidden' && step.fields.phone === 'hidden') step.fields.phone = 'required';
    }
    if (type === 'availability') {
      step.date_question_id = slugify(s.date_question_id || 'event_date').replace(/-/g, '_') || 'event_date';
      step.available_text = clampStr(s.available_text || '', 300);
      step.unavailable_text = clampStr(s.unavailable_text || '', 300);
      step.cta = clampStr(s.cta || '', 40);
    }
    if (type === 'questions') {
      step.questions = (Array.isArray(s.questions) ? s.questions : []).slice(0, 15).map((q, j) => ({
        id: slugify(q.id || q.label || `q${j + 1}`).replace(/-/g, '_') || `q${j + 1}`, label: clampStr(q.label || 'Question', 160), type: Q_TYPES.includes(q.type) ? q.type : 'text',
        options: Array.isArray(q.options) ? q.options.map((o) => clampStr(String(o), 120)).filter(Boolean).slice(0, 30) : [],
        required: !!q.required, placeholder: clampStr(q.placeholder || '', 120), display: q.display === 'cards' ? 'cards' : 'list', use_services: !!q.use_services,
        routes: cleanRoutes(q),
      }));
    }
    return step;
  });
  const keys = new Set();
  for (const s of out) { while (keys.has(s.key)) s.key += '-2'; keys.add(s.key); }
  if (out.filter((s) => s.type === 'availability').length > 1) throw new HttpError(422, 'Only one date-check step per form');
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
    // A company's own domain is that company's front door, not a place to open a new account.
    if (req.hostBusiness) throw new HttpError(403, 'Sign up on the Availvo site, not on a company\'s own address.');
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
      for (const k of ['contract_emails', 'partial_emails']) if (incoming.notifications?.[k]) incoming.notifications[k] = [].concat(incoming.notifications[k]).map((e) => String(e).trim()).filter(isEmail);
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
    // Where the forms were embedded: leads and completions per source page.
    const pages = db.all(`SELECT json_extract(meta, '$.page_url') page, json_extract(meta, '$.page_title') title,
        COUNT(*) leads, SUM(CASE WHEN status != 'partial' THEN 1 ELSE 0 END) done
      FROM leads WHERE business_id = ? AND created_at >= datetime('now', ?) AND json_extract(meta, '$.page_url') IS NOT NULL
      GROUP BY 1 ORDER BY leads DESC LIMIT 12`, id, since);
    return { days, leads, bookings: { ...bookings, upcoming: upcoming.c }, quotes, funnelRows, eventTypes, series, upcoming: upcomingList, activity, pages };
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
    const head = ['id', 'created_at', 'last_activity_at', 'source', 'status', 'form', 'step_reached', 'first_name', 'last_name', 'email', 'phone', 'sms_consent', 'page_url', 'page_title', ...answerKeys];
    const cell = (v) => { let s = Array.isArray(v) ? v.join('; ') : String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [head.join(',')].concat(rows.map((r) => { const a = db.json(r.answers, {}); const m = db.json(r.meta, {}); return [r.id, r.created_at, r.last_activity_at, r.source, r.status, r.event_name || (r.source === 'quote' ? 'Quote builder' : ''), `${r.max_step_index + 1}/${r.step_total || ''}`, r.first_name, r.last_name, r.email, r.phone, r.sms_consent ? 'yes' : 'no', m.page_url || '', m.page_title || '', ...answerKeys.map((k) => a[k])].map(cell).join(','); }));
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
  // A quote belongs to the person who built it, so it goes with them. Left behind, it becomes a
  // link the customer can still open but can never finish: the schema detaches it rather than
  // removing it, and every later step is refused for having nobody on it.
  app.delete('/api/admin/leads/:id', (req) => {
    requireRole('admin')(req);
    const l = getLead(req);
    const quotes = db.tx(() => {
      const n = db.run('DELETE FROM quotes WHERE lead_id = ?', l.id).changes;
      db.run('DELETE FROM leads WHERE id = ?', l.id);
      return n;
    });
    return { ok: true, quotes_deleted: quotes };
  });
  // Several at once, for clearing out test runs. Same as deleting each: the lead and its quotes go,
  // any bookings stay (they have their own delete).
  app.post('/api/admin/leads/delete', (req) => {
    requireRole('admin')(req);
    const ids = [...new Set([].concat(req.body?.ids || []).map(Number).filter(Number.isInteger))].slice(0, 1000);
    if (!ids.length) throw new HttpError(422, 'Pick at least one lead');
    return db.tx(() => {
      let deleted = 0, quotes = 0;
      for (const id of ids) {
        const l = db.get('SELECT id FROM leads WHERE id = ? AND business_id = ?', id, bid(req));
        if (!l) continue;
        quotes += db.run('DELETE FROM quotes WHERE lead_id = ?', l.id).changes;
        deleted += db.run('DELETE FROM leads WHERE id = ?', l.id).changes;
      }
      return { ok: true, deleted, quotes_deleted: quotes };
    });
  });
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
    // Past includes no-shows: they happened (or were due to), and hiding them would make a
    // person's history look cleaner than it was.
    const cond = scope === 'past' ? "b.status IN ('confirmed','no_show') AND b.start_utc < ?" : scope === 'cancelled' ? "b.status = 'cancelled' AND ? IS NOT NULL" : "b.status = 'confirmed' AND b.start_utc >= ?";
    const order = scope === 'upcoming' ? 'ASC' : 'DESC';
    // One person's calls: your own with mine=1, or anyone's by id. Both are parameters, never
    // pasted into the SQL, and an id from another business simply matches nothing.
    const hostId = req.query.mine === '1' ? Number(req.user.id) : (req.query.host ? int(req.query.host, 0) : 0);
    const mine = hostId ? ' AND b.host_user_id = ' + Number(hostId) : '';
    return db.all(`SELECT b.id, b.token, b.start_utc, b.end_utc, b.invitee_tz, b.name, b.email, b.phone, b.location, b.status, b.answers, b.cancel_reason, b.lead_id, b.external_events,
        b.host_user_id, b.start_utc < ? is_past, e.name event_name, e.color, u.name host FROM bookings b LEFT JOIN event_types e ON e.id = b.event_type_id LEFT JOIN users u ON u.id = b.host_user_id
      WHERE b.business_id = ? AND ${cond}${mine} ORDER BY b.start_utc ${order} LIMIT 300`, now, bid(req), now)
      .map((r) => ({ ...r, answers: db.json(r.answers, {}), synced: db.json(r.external_events, []).length > 0, external_events: undefined }));
  });
  // Admins manage everyone's calendar. A host can still manage their own calls.
  const ownBooking = (req) => {
    const bk = db.get('SELECT * FROM bookings WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!bk) throw new HttpError(404, 'Booking not found');
    if ((ROLE_RANK[req.membership.role] || 0) < ROLE_RANK.admin && bk.host_user_id !== req.user.id) throw new HttpError(403, 'Only an admin can change someone else\'s booking');
    return bk;
  };

  // Mark whether the customer showed up. Only for calls that have already started, and reversible,
  // because the button is one click from the meeting list and mistakes happen.
  app.post('/api/admin/bookings/:id/no-show', (req) => {
    requireRole('host')(req);
    const bk = ownBooking(req);
    if (Date.parse(bk.start_utc) > Date.now()) throw new HttpError(422, 'That call has not happened yet.');
    if (!['confirmed', 'no_show'].includes(bk.status)) throw new HttpError(422, 'A cancelled call cannot be a no-show.');
    const noShow = req.body?.no_show !== false;
    db.run('UPDATE bookings SET status = ? WHERE id = ?', noShow ? 'no_show' : 'confirmed', bk.id);
    // A follow-up thanking them for the call would be wrong for someone who never turned up.
    if (noShow) { try { MSG.cancelQueued(bk.id, 'they did not show up for the call'); } catch (e) { console.error('[no-show]', e.message); } }
    if (bk.lead_id) B.logActivity(bid(req), bk.lead_id, 'booking', noShow ? `Marked as a no-show by ${req.user.name}` : `No-show cleared by ${req.user.name}`, { booking_id: bk.id });
    return { ok: true, status: noShow ? 'no_show' : 'confirmed' };
  });

  // Open times to move a call to: the same booking page's slots, with this booking's own time freed.
  app.get('/api/admin/bookings/:id/slots', async (req) => {
    requireRole('host')(req);
    const bk = ownBooking(req);
    const et = BK.hydrateEt(db.get('SELECT * FROM event_types WHERE id = ?', bk.event_type_id));
    if (!et) throw new HttpError(409, 'The booking page for this call no longer exists.');
    const b = B.byId(bid(req));
    const tz = T.isValidTz(req.query.tz) ? req.query.tz : b.timezone;
    const from = T.isDateStr(req.query.from) ? req.query.from : T.utcToZoned(Date.now(), tz).date;
    let to = T.isDateStr(req.query.to) ? req.query.to : T.addDays(from, 13);
    if (to < from) to = from;
    if (Date.parse(to) - Date.parse(from) > 62 * 86400000) to = T.addDays(from, 62);
    const slots = await S.computeSlots(et, from, to, tz, { excludeBookingId: bk.id });
    const hostIds = new Set();
    const days = {};
    for (const [d, list] of Object.entries(slots)) days[d] = list.map((x) => { x.hosts.forEach((h) => hostIds.add(h)); return { start: x.start, same_host: x.hosts.includes(bk.host_user_id) }; });
    return { timezone: tz, from, to, days, host_user_id: bk.host_user_id, event: { name: et.name, duration_min: et.duration_min } };
  });

  // Move a call for someone. The customer gets the same rescheduled email and invite as if they
  // had moved it themselves, and queued reminders move with it.
  app.post('/api/admin/bookings/:id/reschedule', async (req) => {
    requireRole('host')(req);
    const bk = ownBooking(req);
    const updated = await BK.rescheduleBooking(bk, req.body?.start, req.body?.timezone || bk.invitee_tz);
    if (bk.lead_id) B.logActivity(bid(req), bk.lead_id, 'booking', `Rescheduled by ${req.user.name}`, { booking_id: bk.id });
    return { ok: true, start_utc: updated.start_utc, host_user_id: updated.host_user_id };
  });

  // ---------- This company's domain and email ----------
  // The domain decides where its pages live and where every link it sends points. The send-from
  // address is stored against this company only, so each company emails as itself.
  const domainOut = async (b) => {
    const own = appConfig.get('EMAIL_FROM', b.id);
    const shared = appConfig.get('EMAIL_FROM');
    const stored = db.get("SELECT 1 x FROM business_credentials WHERE business_id = ? AND key = 'EMAIL_FROM'", b.id);
    const effective = own || shared || '';
    const sendDomain = (effective.match(/@([^>\s]+)/) || [])[1] || null;
    return {
      custom_domain: b.custom_domain || null,
      platform_host: B.platformHost(),
      page_url: B.pageUrl(b, ''),
      email_from: stored ? own : '',
      email_from_effective: effective,
      email_from_is_own: !!stored,
      email_domain: sendDomain ? await providers.resendDomainStatus(sendDomain) : null,
    };
  };
  app.get('/api/admin/business/domain', async (req) => {
    requireRole('admin')(req);
    return domainOut(B.byId(bid(req)));
  });
  app.put('/api/admin/business/domain', async (req) => {
    requireRole('owner')(req);
    const b = B.byId(bid(req));
    const body = req.body || {};
    // Check everything before writing anything, so a bad email never leaves a half-saved domain.
    let domain; let from;
    if (body.custom_domain !== undefined) {
      domain = B.normalizeDomain(body.custom_domain);
      if (domain) {
        if (!B.isDomain(domain)) throw new HttpError(422, 'That does not look like a domain. Use something like book.yourcompany.com', { custom_domain: 'Not a domain' });
        const taken = db.get('SELECT id FROM businesses WHERE custom_domain = ? AND id != ?', domain, b.id);
        if (taken) throw new HttpError(409, 'Another company on Availvo already uses that domain', { custom_domain: 'Already in use' });
      }
    }
    if (body.email_from !== undefined) {
      from = clampStr(String(body.email_from || '').trim(), 200);
      if (from) {
        const addr = (from.match(/<([^>]+)>/) || [null, from])[1].trim();
        if (!isEmail(addr) || (from.match(/</g) || []).length > 1) throw new HttpError(422, 'Use an address like Your Company <hello@yourcompany.com>', { email_from: 'Not an email address' });
      }
    }
    if (domain !== undefined && (domain || null) !== (b.custom_domain || null)) {
      db.run('UPDATE businesses SET custom_domain = ? WHERE id = ?', domain || null, b.id);
      B.logActivity(b.id, null, 'settings', domain ? `Domain set to ${domain} by ${req.user.email}` : `Domain removed by ${req.user.email}`);
    }
    if (from !== undefined) {
      if (from) appConfig.set('EMAIL_FROM', from, req.user.id, b.id); else appConfig.clear('EMAIL_FROM', b.id);
      B.logActivity(b.id, null, 'settings', from ? `Send-from address set to ${from} by ${req.user.email}` : `Send-from address cleared by ${req.user.email}`);
    }
    return domainOut(B.byId(b.id));
  });

  // ---------- Team performance ----------
  app.get('/api/admin/team-stats', (req) => {
    requireRole('admin')(req);
    return TEAM.teamStats(B.byId(bid(req)), req.query || {});
  });
  app.get('/api/admin/team-stats/:userId', (req) => {
    requireRole('admin')(req);
    const out = TEAM.personDetail(B.byId(bid(req)), int(req.params.userId, 0), req.query || {});
    if (!out) throw new HttpError(404, 'That person is not on this team');
    return out;
  });

  // Delete for good, without telling the customer. For test bookings; real ones should be cancelled.
  app.post('/api/admin/bookings/delete', async (req) => {
    requireRole('admin')(req);
    const ids = [].concat(req.body?.ids || []).slice(0, 1000);
    if (!ids.length) throw new HttpError(422, 'Pick at least one booking');
    return { ok: true, deleted: await BK.deleteBookings(bid(req), ids) };
  });

  app.post('/api/admin/bookings/:id/cancel', async (req) => {
    requireRole('host')(req);
    const bk = db.get('SELECT * FROM bookings WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!bk) throw new HttpError(404, 'Booking not found');
    await BK.cancelBooking(bk, req.body?.reason, req.user.name);
    return { ok: true };
  });

  // ---------- Event types ----------
  // Real people only. Market and designer calendars are login-less rows and belong on the
  // Sessions screen, not in the team list or the host pickers.
  const members = (businessId) => db.all("SELECT u.id, u.name, u.email, u.timezone, m.role, COALESCE(m.level, 'staff') level FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ? AND m.status = 'active' AND COALESCE(u.is_resource,0) = 0 ORDER BY u.name", businessId);
  const PRIORITY_VALUE = { high: 3, medium: 2, low: 1 };
  const PRIORITY_NAME = { 3: 'high', 2: 'medium', 1: 'low' };
  function etOut(et) {
    const hostRows = db.all('SELECT user_id, priority FROM event_type_hosts WHERE event_type_id = ?', et.id);
    return { ...BK.hydrateEt(et), active: !!et.active, hosts: hostRows.map((r) => r.user_id),
      host_priorities: Object.fromEntries(hostRows.map((r) => [r.user_id, PRIORITY_NAME[r.priority] || 'medium'])),
      bookings_30d: db.get("SELECT COUNT(*) c FROM bookings WHERE event_type_id = ? AND created_at >= datetime('now','-30 days')", et.id).c };
  }
  // ---------- Teams and booking types ----------
  // Who does the work, and what kind of work it is. Anyone who can see the booking pages can read
  // these, because the page editor needs them to fill its two dropdowns; only an admin edits them.
  app.get('/api/admin/org', (req) => {
    requireRole('host')(req);
    return { teams: ORG.listTeams(bid(req), { all: true }), booking_types: ORG.listTypes(bid(req), { all: true }), members: members(bid(req)) };
  });
  const teamOr404 = (req) => {
    const t = db.get('SELECT * FROM teams WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!t) throw new HttpError(404, 'Not found');
    return t;
  };
  const typeOr404 = (req) => {
    const t = db.get('SELECT * FROM booking_types WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!t) throw new HttpError(404, 'Not found');
    return t;
  };
  const validMembers = (req) => members(bid(req)).map((m) => m.id);
  app.post('/api/admin/teams', (req) => { requireRole('admin')(req); return ORG.saveTeam(bid(req), req.body || {}, null, validMembers(req)); });
  app.patch('/api/admin/teams/:id', (req) => { requireRole('admin')(req); return ORG.saveTeam(bid(req), req.body || {}, teamOr404(req), validMembers(req)); });
  app.delete('/api/admin/teams/:id', (req) => { requireRole('admin')(req); return ORG.removeTeam(bid(req), teamOr404(req).id); });
  app.post('/api/admin/booking-types', (req) => { requireRole('admin')(req); return ORG.saveType(bid(req), req.body || {}, null); });
  app.patch('/api/admin/booking-types/:id', (req) => { requireRole('admin')(req); return ORG.saveType(bid(req), req.body || {}, typeOr404(req)); });
  app.delete('/api/admin/booking-types/:id', (req) => { requireRole('admin')(req); return ORG.removeType(bid(req), typeOr404(req).id); });

  app.get('/api/admin/event-types', (req) => {
    requireRole('host')(req);
    // Everything, sessions included: automations and messaging scope themselves to any event type
    // and need the whole list. Which of them the Booking pages screen will edit is its own call,
    // and each row carries its kind so it can make it.
    return { event_types: db.all('SELECT * FROM event_types WHERE business_id = ? ORDER BY sort, id', bid(req)).map(etOut),
      members: members(bid(req)), teams: ORG.listTeams(bid(req)), booking_types: ORG.listTypes(bid(req)), location_types: LOCATION_TYPES, default_steps: DEFAULT_STEPS(), quick_date_steps: QUICK_DATE_STEPS() };
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
      // The ways a customer may choose to meet. An empty list is not a gap: it means this page
      // offers the single location_type above, which is how every page worked before.
      location_options: JSON.stringify(b.location_options ? PLACES.sanitize(b.location_options) : existing ? BK.hydrateEt({ ...existing }).location_options : []),
      active: b.active === undefined ? (existing ? existing.active : 1) : bool(b.active) ? 1 : 0,
      // Only this business's own labels, so a stale id in a form can never file a page under
      // another company's team. Anything unrecognised clears the field rather than being stored.
      team_id: b.team_id === undefined ? (existing ? existing.team_id : null) : ORG.teamIdFor(businessId, b.team_id),
      booking_type_id: b.booking_type_id === undefined ? (existing ? existing.booking_type_id : null) : ORG.typeIdFor(businessId, b.booking_type_id),
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
        // Keep each person's priority unless this save says otherwise, so un-ticking and re-ticking
        // someone, or an older screen that does not send priorities, never quietly resets them.
        const before = new Map(db.all('SELECT user_id, priority FROM event_type_hosts WHERE event_type_id = ?', id).map((r) => [r.user_id, r.priority]));
        const sent = b.host_priorities && typeof b.host_priorities === 'object' ? b.host_priorities : {};
        db.run('DELETE FROM event_type_hosts WHERE event_type_id = ?', id);
        for (const h of hosts) {
          const p = PRIORITY_VALUE[String(sent[h] || '').toLowerCase()] || before.get(h) || 2;
          db.run('INSERT INTO event_type_hosts (event_type_id, user_id, priority) VALUES (?,?,?)', id, h, p);
        }
      } else if (b.host_priorities && typeof b.host_priorities === 'object') {
        for (const [h, name] of Object.entries(b.host_priorities)) {
          const p = PRIORITY_VALUE[String(name || '').toLowerCase()];
          if (p) db.run('UPDATE event_type_hosts SET priority = ? WHERE event_type_id = ? AND user_id = ?', p, id, Number(h));
        }
      }
    });
    return etOut(db.get('SELECT * FROM event_types WHERE id = ?', id));
  }
  app.post('/api/admin/event-types', (req) => { requireRole('admin')(req); return saveEventType(req, null); });
  app.patch('/api/admin/event-types/:id', (req) => {
    requireRole('admin')(req);
    const et = db.get('SELECT * FROM event_types WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!et) throw new HttpError(404, 'Not found');
    // Saying so beats letting the save fail on a rule that was never meant to apply to it.
    if (et.kind === 'session') throw new HttpError(409, `"${et.name}" is a session, so it is edited under Sessions & markets rather than here.`);
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
      connections: db.all('SELECT id, provider, account_email, calendar_id, check_busy, write_events, busy_all_day, last_error, created_at FROM calendar_connections WHERE user_id = ? ORDER BY id', req.user.id) };
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
    if (b.busy_all_day !== undefined) db.run('UPDATE calendar_connections SET busy_all_day = ? WHERE id = ?', bool(b.busy_all_day) ? 1 : 0, c.id);
    if (b.calendar_id) db.run('UPDATE calendar_connections SET calendar_id = ? WHERE id = ?', clampStr(b.calendar_id, 300), c.id);
    calendars.clearBusyCache(req.user.id);
    return { ok: true };
  });
  /**
   * What this calendar is actually blocking, and what is being let through.
   *
   * Someone whose booking page offers no times has no way to find out why: the answer lives in an
   * API response they cannot see. This is their own calendar, read with their own connection, and
   * shown only back to them.
   */
  app.get('/api/admin/calendars/:id/busy', async (req) => {
    requireAuth(req);
    const c = db.get('SELECT * FROM calendar_connections WHERE id = ? AND user_id = ?', int(req.params.id), req.user.id);
    if (!c) throw new HttpError(404, 'Not found');
    if (!calendars.isConfigured(c.provider)) throw new HttpError(422, 'That calendar provider is not set up on this server');
    const days = Math.max(1, Math.min(60, int(req.query.days, 14)));
    const from = Date.now(), to = from + days * 86400000;
    try {
      const entries = await calendars.explainBusy(c, from, to);
      return {
        days, timezone: req.user.timezone || 'UTC', checking: !!c.check_busy, busy_all_day: !!c.busy_all_day,
        blocking: entries.filter((e) => !e.ignored).length, ignored: entries.filter((e) => e.ignored).length,
        entries: entries.slice(0, 200),
      };
    } catch (e) { throw new HttpError(502, `Could not read that calendar: ${e.message}`); }
  });
  app.delete('/api/admin/calendars/:id', (req) => {
    requireAuth(req);
    const conn = db.get('SELECT * FROM calendar_connections WHERE id = ? AND user_id = ?', int(req.params.id), req.user.id);
    db.run('DELETE FROM calendar_connections WHERE id = ? AND user_id = ?', int(req.params.id), req.user.id);
    calendars.clearBusyCache(req.user.id);
    // Removing it here also removes Availvo's access on Google's side, so nothing is left behind.
    if (conn) calendars.revoke(conn);
    return { ok: true };
  });

  // ---------- Booked event dates (drives the "we're available" step) ----------
  app.get('/api/admin/blocked-dates', (req) => {
    requireRole('host')(req);
    return db.all('SELECT id, date, note FROM blocked_dates WHERE business_id = ? ORDER BY date', bid(req));
  });
  app.post('/api/admin/blocked-dates', (req) => {
    requireRole('admin')(req);
    const raw = String((req.body || {}).dates || '');
    const note = clampStr((req.body || {}).note || '', 200);
    const dates = [...new Set(raw.split(/[\s,;]+/).map((d) => d.trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].slice(0, 500);
    if (!dates.length) throw new HttpError(422, 'Enter one or more dates as YYYY-MM-DD.');
    let added = 0;
    db.tx(() => {
      for (const d of dates) {
        const r = db.run('INSERT OR IGNORE INTO blocked_dates (business_id, date, note) VALUES (?,?,?)', bid(req), d, note);
        if (r.changes) added++;
      }
    });
    return { added, skipped: dates.length - added };
  });
  app.delete('/api/admin/blocked-dates/:id', (req) => {
    requireRole('admin')(req);
    db.run('DELETE FROM blocked_dates WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    return { ok: true };
  });

  // ---------- Sessions (markets and the sessions booked on them) ----------
  function sessionOut(et) {
    const s = SESS.hydrate({ ...et });
    return {
      id: et.id, slug: et.slug, name: et.name, description: et.description || '', active: !!et.active, sort: et.sort,
      duration_min: et.duration_min, buffer_after: et.buffer_after, min_notice_min: et.min_notice_min,
      max_days_ahead: et.max_days_ahead, slot_interval_min: et.slot_interval_min, location_type: et.location_type, location_value: et.location_value,
      session: s.session, steps: s.steps,
      calendar_ids: SESS.calendarsForProduct(et).map((c) => c.id),
      public_url: B.pageUrl(B.byId(et.business_id), `s/${et.slug}`),
      booked: db.get("SELECT COUNT(*) c FROM bookings WHERE event_type_id = ? AND status = 'confirmed'", et.id).c,
    };
  }

  app.get('/api/admin/session-calendars', (req) => {
    requireRole('host')(req);
    return SESS.listCalendars(bid(req), { includeInactive: true }).map((c) => ({
      id: c.id, user_id: c.user_id, kind: c.kind, slug: c.slug, name: c.name, blurb: c.blurb || '',
      timezone: c.timezone || c.user_timezone, active: !!c.active, sort: c.sort,
      has_hours: !!db.get('SELECT 1 FROM availability_rules WHERE user_id = ?', c.user_id),
      connections: db.all('SELECT id, provider, account_email, check_busy, busy_all_day, last_error FROM calendar_connections WHERE user_id = ?', c.user_id),
      upcoming: db.get("SELECT COUNT(*) c FROM bookings WHERE host_user_id = ? AND status = 'confirmed' AND start_utc > datetime('now')", c.user_id).c,
    }));
  });
  /**
   * A connection belonging to a market, rather than to the person signed in.
   *
   * The ordinary calendar routes are scoped to the caller's own user, which is right for a person
   * and useless for a resource: a market has no login, so nobody could ever manage its connection.
   * These are scoped to the business instead, and only an admin of it may touch them.
   */
  app.patch('/api/admin/session-calendars/:id/connection/:connId', (req) => {
    requireRole('admin')(req);
    const cal = SESS.calendarById(bid(req), int(req.params.id));
    if (!cal) throw new HttpError(404, 'Not found');
    const conn = db.get('SELECT * FROM calendar_connections WHERE id = ? AND user_id = ?', int(req.params.connId), cal.user_id);
    if (!conn) throw new HttpError(404, 'Not found');
    const b = req.body || {};
    if (b.check_busy !== undefined) db.run('UPDATE calendar_connections SET check_busy = ? WHERE id = ?', bool(b.check_busy) ? 1 : 0, conn.id);
    if (b.busy_all_day !== undefined) db.run('UPDATE calendar_connections SET busy_all_day = ? WHERE id = ?', bool(b.busy_all_day) ? 1 : 0, conn.id);
    if (b.calendar_id) db.run('UPDATE calendar_connections SET calendar_id = ? WHERE id = ?', clampStr(b.calendar_id, 300), conn.id);
    calendars.clearBusyCache(cal.user_id);
    return { ok: true };
  });
  app.delete('/api/admin/session-calendars/:id/connection/:connId', (req) => {
    requireRole('admin')(req);
    const cal = SESS.calendarById(bid(req), int(req.params.id));
    if (!cal) throw new HttpError(404, 'Not found');
    const r = db.run('DELETE FROM calendar_connections WHERE id = ? AND user_id = ?', int(req.params.connId), cal.user_id);
    if (!r.changes) throw new HttpError(404, 'Not found');
    calendars.clearBusyCache(cal.user_id);
    return { ok: true };
  });

  app.post('/api/admin/session-calendars', (req) => {
    requireRole('admin')(req);
    const b = B.byId(bid(req));
    return SESS.createCalendar(b, req.body || {});
  });
  app.patch('/api/admin/session-calendars/:id', (req) => {
    requireRole('admin')(req);
    return SESS.updateCalendar(B.byId(bid(req)), req.params.id, req.body || {});
  });
  app.delete('/api/admin/session-calendars/:id', (req) => {
    requireRole('admin')(req);
    const cal = SESS.calendarById(bid(req), req.params.id);
    if (!cal) throw new HttpError(404, 'Not found');
    const future = db.get("SELECT COUNT(*) c FROM bookings WHERE host_user_id = ? AND status = 'confirmed' AND start_utc > datetime('now')", cal.user_id).c;
    // Deleting would orphan real sessions, so refuse and let them switch it off instead.
    if (future) throw new HttpError(409, `${cal.name} still has ${future} upcoming session${future === 1 ? '' : 's'}. Switch it off instead of deleting it.`);
    db.run('DELETE FROM calendar_profiles WHERE id = ?', cal.id);
    return { ok: true };
  });

  app.get('/api/admin/sessions', (req) => {
    requireRole('host')(req);
    return {
      sessions: SESS.listProducts(bid(req), { includeInactive: true }).map(sessionOut),
      calendars: SESS.listCalendars(bid(req), { includeInactive: true }).map((c) => ({ id: c.id, name: c.name, kind: c.kind, active: !!c.active })),
      location_types: LOCATION_TYPES,
      defaults: SESSION_SETTINGS,
    };
  });

  function saveSession(req, existing) {
    const b = B.byId(bid(req));
    const body = req.body || {};
    const name = clampStr(String(body.name || '').trim(), 120);
    if (!name) throw new HttpError(422, 'Give the session a name', { name: 'Required' });
    const merged = deepMerge(existing ? SESS.hydrate({ ...existing }).session : SESSION_SETTINGS,
      body.session && typeof body.session === 'object' ? body.session : {});
    // Keep only the settings a session still has. Prices, holds and checkout copy from before
    // payments were removed are dropped here rather than carried along forever.
    const session = {};
    for (const k of Object.keys(SESSION_SETTINGS)) {
      const v = merged[k];
      session[k] = typeof SESSION_SETTINGS[k] === 'boolean' ? bool(v) : clampStr(String(v ?? ''), 300);
    }

    const fields = {
      name,
      description: clampStr(body.description || '', 1000),
      duration_min: int(body.duration_min, existing?.duration_min || 90, 5, 1440),
      buffer_after: int(body.buffer_after, existing?.buffer_after ?? 30, 0, 480),
      min_notice_min: int(body.min_notice_min, existing?.min_notice_min ?? 1440, 0, 100000),
      max_days_ahead: int(body.max_days_ahead, existing?.max_days_ahead ?? 180, 1, 730),
      slot_interval_min: int(body.slot_interval_min, existing?.slot_interval_min ?? 30, 5, 240),
      location_type: LOCATION_TYPES[body.location_type] ? body.location_type : (existing?.location_type || 'in_person'),
      location_value: clampStr(body.location_value || '', 300),
      active: body.active !== undefined ? (bool(body.active) ? 1 : 0) : (existing ? existing.active : 1),
      steps: JSON.stringify(body.steps ? sanitizeSteps(body.steps) : (existing ? db.json(existing.steps, SESSION_STEPS()) : SESSION_STEPS())),
      settings: JSON.stringify(Object.assign(existing ? db.json(existing.settings, {}) : {}, { session })),
    };

    let et;
    if (existing) {
      db.run(`UPDATE event_types SET name=?, description=?, duration_min=?, buffer_after=?, min_notice_min=?, max_days_ahead=?,
          slot_interval_min=?, location_type=?, location_value=?, active=?, steps=?, settings=? WHERE id = ? AND business_id = ?`,
      fields.name, fields.description, fields.duration_min, fields.buffer_after, fields.min_notice_min, fields.max_days_ahead,
      fields.slot_interval_min, fields.location_type, fields.location_value, fields.active, fields.steps, fields.settings, existing.id, b.id);
      et = db.get('SELECT * FROM event_types WHERE id = ?', existing.id);
    } else {
      let slug = slugify(body.slug || name) || 'session';
      let s = slug; let i = 2;
      while (db.get('SELECT 1 FROM event_types WHERE business_id = ? AND slug = ?', b.id, s)) s = `${slug}-${i++}`;
      const sort = (db.get('SELECT MAX(sort) m FROM event_types WHERE business_id = ?', b.id) || {}).m || 0;
      const { lastId } = db.run(`INSERT INTO event_types (business_id, slug, name, description, duration_min, buffer_after, min_notice_min,
          max_days_ahead, slot_interval_min, location_type, location_value, active, kind, steps, settings, sort)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'session',?,?,?)`,
      b.id, s, fields.name, fields.description, fields.duration_min, fields.buffer_after, fields.min_notice_min,
      fields.max_days_ahead, fields.slot_interval_min, fields.location_type, fields.location_value, fields.active, fields.steps, fields.settings, sort + 1);
      et = db.get('SELECT * FROM event_types WHERE id = ?', lastId);
    }
    if (Array.isArray(body.calendar_ids)) SESS.setProductCalendars(b, et, body.calendar_ids);
    return sessionOut(db.get('SELECT * FROM event_types WHERE id = ?', et.id));
  }

  // ---------- Custom forms ----------
  const formOut = (f) => {
    const x = FORMS.hydrate({ ...f });
    return {
      id: x.id, slug: x.slug, name: x.name, description: x.description || '',
      steps: x.steps, settings: x.settings, copy: x.copy, style: x.style, shape: FORMS.shapeOf(x.steps),
      active: !!x.active, sort: x.sort, submissions: x.submissions,
      url: B.pageUrl(B.byId(x.business_id), `f/${x.slug}`),
      leads: db.get('SELECT COUNT(*) c FROM leads WHERE form_id = ?', x.id).c,
    };
  };

  app.get('/api/admin/forms', (req) => {
    requireRole('host')(req);
    const b = B.byId(bid(req));
    return {
      forms: FORMS.listAll(b).map(formOut),
      event_types: db.all('SELECT id, name, slug, kind FROM event_types WHERE business_id = ? AND active = 1 ORDER BY sort, id', b.id),
      step_types: FORMS.STEP_TYPES,
      question_types: FORMS.Q_TYPES,
      templates: FORMS.templateList(),
      defaults: FORMS.FORM_SETTINGS,
      // Everything the style editor needs to offer, so the browser never guesses at a list.
      styles: {
        layouts: FSTYLE.LAYOUTS.map((id) => Object.assign({ id }, FSTYLE.LAYOUT_INFO[id], { defaults: FSTYLE.defaultsFor(id) })),
        fonts: Object.keys(FSTYLE.FONTS),
        progress: FSTYLE.PROGRESS,
        date_displays: FSTYLE.DATE_DISPLAYS,
      },
      brand_color: b.brand_color || '',
      logo_url: b.logo_url || '',
    };
  });

  function saveForm(req, existing) {
    const b = B.byId(bid(req));
    const body = req.body || {};
    const name = clampStr(String(body.name || '').trim(), 120);
    if (!name) throw new HttpError(422, 'Give the form a name', { name: 'Required' });
    const steps = body.steps !== undefined ? FORMS.sanitizeSteps(body.steps, b) : (existing ? db.json(existing.steps, []) : []);
    const incoming = (body.settings && typeof body.settings === 'object') ? body.settings : {};
    const settings = deepMerge(existing ? db.json(existing.settings, {}) : {}, incoming);
    // A style is saved whole, not merged, so switching layout cannot leave the old one's leftovers.
    if (incoming.style !== undefined) settings.style = FSTYLE.sanitizeStyle(incoming.style);
    else if (settings.style) settings.style = FSTYLE.sanitizeStyle(settings.style);
    const active = body.active !== undefined ? (bool(body.active) ? 1 : 0) : (existing ? existing.active : 1);
    const description = clampStr(body.description !== undefined ? body.description : (existing ? existing.description : '') || '', 1000);

    if (existing) {
      db.run('UPDATE forms SET name=?, description=?, steps=?, settings=?, active=? WHERE id = ? AND business_id = ?',
        name, description, JSON.stringify(steps), JSON.stringify(settings), active, existing.id, b.id);
      return formOut(db.get('SELECT * FROM forms WHERE id = ?', existing.id));
    }
    let base = slugify(body.slug || name) || 'form';
    let sl = base; let i = 2;
    while (db.get('SELECT 1 FROM forms WHERE business_id = ? AND slug = ?', b.id, sl)) sl = `${base}-${i++}`;
    const sort = (db.get('SELECT MAX(sort) m FROM forms WHERE business_id = ?', b.id) || {}).m || 0;
    const { lastId } = db.run('INSERT INTO forms (business_id, slug, name, description, steps, settings, active, sort) VALUES (?,?,?,?,?,?,?,?)',
      b.id, sl, name, description, JSON.stringify(steps), JSON.stringify(settings), active, sort + 1);
    return formOut(db.get('SELECT * FROM forms WHERE id = ?', lastId));
  }

  app.post('/api/admin/forms', (req) => { requireRole('admin')(req); return saveForm(req, null); });
  app.patch('/api/admin/forms/:id', (req) => {
    requireRole('admin')(req);
    const existing = db.get('SELECT * FROM forms WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!existing) throw new HttpError(404, 'Not found');
    return saveForm(req, existing);
  });
  app.delete('/api/admin/forms/:id', (req) => {
    requireRole('admin')(req);
    const f = db.get('SELECT * FROM forms WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!f) throw new HttpError(404, 'Not found');
    // A form people have already filled in is switched off, not deleted: its leads point back here.
    const used = db.get('SELECT COUNT(*) c FROM leads WHERE form_id = ?', f.id).c;
    if (used) { db.run('UPDATE forms SET active = 0 WHERE id = ?', f.id); return { ok: true, deactivated: true, leads: used }; }
    db.run('DELETE FROM forms WHERE id = ?', f.id);
    return { ok: true };
  });

  /** Start a form from one of the ready-made shapes, wired to this business's own pages. */
  app.post('/api/admin/forms/from-template', (req) => {
    requireRole('admin')(req);
    const b = B.byId(bid(req));
    const built = FORMS.buildTemplate(b, String((req.body || {}).template || ''));
    const steps = FORMS.sanitizeSteps(built.steps, b);
    let base = slugify(built.slug || built.name) || 'form';
    let sl = base; let i = 2;
    while (db.get('SELECT 1 FROM forms WHERE business_id = ? AND slug = ?', b.id, sl)) sl = `${base}-${i++}`;
    const sort = (db.get('SELECT MAX(sort) m FROM forms WHERE business_id = ?', b.id) || {}).m || 0;
    const { lastId } = db.run('INSERT INTO forms (business_id, slug, name, description, steps, settings, active, sort) VALUES (?,?,?,?,?,?,1,?)',
      b.id, sl, built.name, built.description || '', JSON.stringify(steps), JSON.stringify(built.settings || {}), sort + 1);
    return Object.assign({ warnings: built.warnings || [] }, { form: formOut(db.get('SELECT * FROM forms WHERE id = ?', lastId)) });
  });

  /** An image for a form: a logo, banner, background or a photo on a choice. Returns its address. */
  app.post('/api/admin/uploads', (req) => {
    requireRole('admin')(req);
    return UP.save(bid(req), (req.body || {}).data);
  });

  /** Copy a form, switched off, so a variation can be tried without touching the live one. */
  app.post('/api/admin/forms/:id/clone', (req) => {
    requireRole('admin')(req);
    const b = B.byId(bid(req));
    const f = db.get('SELECT * FROM forms WHERE id = ? AND business_id = ?', int(req.params.id), b.id);
    if (!f) throw new HttpError(404, 'Not found');
    const base = slugify(`${f.slug}-copy`) || 'form-copy';
    let sl = base; let i = 2;
    while (db.get('SELECT 1 FROM forms WHERE business_id = ? AND slug = ?', b.id, sl)) sl = `${base}-${i++}`;
    const sort = (db.get('SELECT MAX(sort) m FROM forms WHERE business_id = ?', b.id) || {}).m || 0;
    const { lastId } = db.run('INSERT INTO forms (business_id, slug, name, description, steps, settings, active, sort) VALUES (?,?,?,?,?,?,0,?)',
      b.id, sl, clampStr(`${f.name} (copy)`, 120), f.description || '', f.steps, f.settings, sort + 1);
    return formOut(db.get('SELECT * FROM forms WHERE id = ?', lastId));
  });

  app.post('/api/admin/forms/reorder', (req) => {
    requireRole('admin')(req);
    (req.body?.ids || []).forEach((id, i) => db.run('UPDATE forms SET sort = ? WHERE id = ? AND business_id = ?', i, int(id), bid(req)));
    return { ok: true };
  });

  app.post('/api/admin/sessions', (req) => { requireRole('admin')(req); return saveSession(req, null); });
  app.patch('/api/admin/sessions/:id', (req) => {
    requireRole('admin')(req);
    const existing = db.get("SELECT * FROM event_types WHERE id = ? AND business_id = ? AND kind = 'session'", int(req.params.id), bid(req));
    if (!existing) throw new HttpError(404, 'Not found');
    return saveSession(req, existing);
  });
  app.delete('/api/admin/sessions/:id', (req) => {
    requireRole('admin')(req);
    const et = db.get("SELECT * FROM event_types WHERE id = ? AND business_id = ? AND kind = 'session'", int(req.params.id), bid(req));
    if (!et) throw new HttpError(404, 'Not found');
    const upcoming = db.get("SELECT COUNT(*) c FROM bookings WHERE event_type_id = ? AND status = 'confirmed' AND start_utc > datetime('now')", et.id).c;
    // Deleting would orphan real bookings, so refuse and let them switch it off instead.
    if (upcoming) throw new HttpError(409, `${et.name} has ${upcoming} upcoming booking${upcoming === 1 ? '' : 's'}. Switch it off instead of deleting it.`);
    db.run('DELETE FROM event_types WHERE id = ?', et.id);
    return { ok: true };
  });

  // Seed the markets and the starter session products. Idempotent: matched by slug.
  app.post('/api/admin/sessions/seed', (req) => {
    requireRole('admin')(req);
    return seedSessions(B.byId(bid(req)), req.body || {});
  });

  // ---------- Integrations: Twilio, Resend ----------
  // Reading status needs admin. Writing a credential needs owner: a saved key lets someone send
  // texts and email as this business.
  app.get('/api/admin/integrations/providers', (req) => {
    requireRole('admin')(req);
    return providers.status();
  });

  app.put('/api/admin/integrations/providers/:provider', (req) => {
    requireRole('owner')(req);
    const provider = String(req.params.provider);
    if (!['twilio', 'resend'].includes(provider)) throw new HttpError(404, 'Unknown integration');
    // Twilio and Resend are one shared set of keys for the platform.
    const scoped = undefined;
    const body = req.body || {};
    const allowed = new Set(appConfig.keysFor(provider));
    for (const key of Object.keys(body)) {
      if (key !== 'clear' && !allowed.has(key)) throw new HttpError(422, `${key} does not belong to ${provider}`);
    }
    // A field left as the mask means "leave it alone"; an empty string clears it back to Railway.
    const changed = appConfig.applyPatch(body, { provider, userId: req.user.id, businessId: scoped });
    for (const key of (Array.isArray(body.clear) ? body.clear : [])) {
      if (allowed.has(key)) { appConfig.clear(key, scoped); changed.push(`${key} (cleared)`); }
    }
    if (changed.length) B.logActivity(bid(req), null, 'integration', `${provider} credentials updated by ${req.user.email}: ${changed.join(', ')}`);
    return { ok: true, changed, status: providers.status()[provider] };
  });

  app.post('/api/admin/integrations/providers/:provider/check', async (req) => {
    requireRole('admin')(req);
    try {
      return await providers.check(String(req.params.provider));
    } catch (e) {
      throw new HttpError(422, e.message);
    }
  });

  app.post('/api/admin/integrations/providers/:provider/send-test', async (req) => {
    requireRole('admin')(req);
    const provider = String(req.params.provider);
    const business = B.byId(bid(req));
    const to = clampStr(String((req.body || {}).to || '').trim(), 160);
    try {
      if (provider === 'resend') return await providers.sendTestEmail(business, to || req.user.email);
      if (provider === 'twilio') return await providers.sendTestSms(business, to || req.user.phone);
      throw new Error('That integration has nothing to send.');
    } catch (e) {
      throw new HttpError(422, e.message);
    }
  });

  // ---------- Scheduled emails and texts ----------
  const CHANNELS = ['email', 'sms', 'both'];
  const KINDS = ['transactional', 'marketing'];

  function automationIn(req, existing) {
    const body = req.body || {};
    const name = clampStr(String(body.name || '').trim(), 120);
    if (!name) throw new HttpError(422, 'Give the automation a name', { name: 'Required' });
    const trigger = Object.keys(MSG.TRIGGERS).includes(body.trigger) ? body.trigger : (existing?.trigger || 'before');
    const channel = CHANNELS.includes(body.channel) ? body.channel : (existing?.channel || 'email');
    const ids = (v, fallback) => JSON.stringify((Array.isArray(v) ? v : fallback).map((x) => int(x, 0)).filter(Boolean).slice(0, 60));
    const strings = (v, fallback) => JSON.stringify((Array.isArray(v) ? v : fallback).map((x) => clampStr(String(x).trim(), 120)).filter(Boolean).slice(0, 40));
    const out = {
      name, trigger, channel,
      kind: KINDS.includes(body.kind) ? body.kind : (existing?.kind || 'transactional'),
      // Cap at a year so a stray keystroke cannot park a message in the queue forever.
      offset_min: int(body.offset_min, existing?.offset_min ?? 1440, 0, 525600),
      event_type_ids: ids(body.event_type_ids, existing ? db.json(existing.event_type_ids, []) : []),
      calendar_ids: ids(body.calendar_ids, existing ? db.json(existing.calendar_ids, []) : []),
      service_match: strings(body.service_match, existing ? db.json(existing.service_match, []) : []),
      match_mode: body.match_mode === 'all' ? 'all' : 'any',
      skip_if_rebooked: body.skip_if_rebooked !== undefined ? (bool(body.skip_if_rebooked) ? 1 : 0) : (existing?.skip_if_rebooked ?? 0),
      subject: clampStr(body.subject || '', 200),
      body_html: clampStr(body.body_html || '', 20000),
      sms_body: clampStr(body.sms_body || '', 1600),
      active: body.active !== undefined ? (bool(body.active) ? 1 : 0) : (existing?.active ?? 0),
    };
    if (out.active) {
      // Refuse to switch on something that would send nothing, or nothing sendable.
      if ((channel === 'email' || channel === 'both') && !out.body_html.trim()) throw new HttpError(422, 'Write the email before switching this on', { body_html: 'Required' });
      if ((channel === 'sms' || channel === 'both') && !out.sms_body.trim()) throw new HttpError(422, 'Write the text before switching this on', { sms_body: 'Required' });
      if ((channel === 'sms' || channel === 'both') && !sms.configured()) throw new HttpError(422, 'Text messaging is not connected yet, so this cannot send texts.', { channel: 'Texts are not set up' });
    }
    return out;
  }

  app.get('/api/admin/automations', (req) => {
    requireRole('host')(req);
    const businessId = bid(req);
    return {
      automations: MSG.listAutomations(businessId),
      summary: MSG.summary(businessId),
      triggers: MSG.TRIGGERS,
      variables: MSG.VARIABLES,
      event_types: db.all('SELECT id, name, kind FROM event_types WHERE business_id = ? ORDER BY sort, id', businessId),
      calendars: SESS.listCalendars(businessId, { includeInactive: true }).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
      services: db.all('SELECT name FROM services WHERE business_id = ? AND active = 1 ORDER BY sort, id', businessId).map((r) => r.name),
      sms: {
        ready: sms.configured(),
        inbound_url: `${baseUrl()}/api/public/sms/inbound`,
        needs: sms.configured() ? [] : ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID'],
      },
    };
  });

  app.post('/api/admin/automations', (req) => {
    requireRole('admin')(req);
    const f = automationIn(req, null);
    const sort = (db.get('SELECT MAX(sort) m FROM message_automations WHERE business_id = ?', bid(req)) || {}).m || 0;
    const { lastId } = db.run(`INSERT INTO message_automations (business_id, name, channel, kind, trigger, offset_min,
        event_type_ids, calendar_ids, service_match, match_mode, skip_if_rebooked, subject, body_html, sms_body, active, sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    bid(req), f.name, f.channel, f.kind, f.trigger, f.offset_min, f.event_type_ids, f.calendar_ids, f.service_match,
    f.match_mode, f.skip_if_rebooked, f.subject, f.body_html, f.sms_body, f.active, sort + 1);
    return MSG.listAutomations(bid(req)).find((a) => a.id === lastId);
  });

  function getAutomation(req) {
    const a = db.get('SELECT * FROM message_automations WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!a) throw new HttpError(404, 'Not found');
    return a;
  }

  app.patch('/api/admin/automations/:id', (req) => {
    requireRole('admin')(req);
    const existing = getAutomation(req);
    const f = automationIn(req, existing);
    db.run(`UPDATE message_automations SET name=?, channel=?, kind=?, trigger=?, offset_min=?, event_type_ids=?, calendar_ids=?,
        service_match=?, match_mode=?, skip_if_rebooked=?, subject=?, body_html=?, sms_body=?, active=?, updated_at=datetime('now')
      WHERE id = ? AND business_id = ?`,
    f.name, f.channel, f.kind, f.trigger, f.offset_min, f.event_type_ids, f.calendar_ids, f.service_match,
    f.match_mode, f.skip_if_rebooked, f.subject, f.body_html, f.sms_body, f.active, existing.id, bid(req));
    // Timing or conditions may have changed, so anything not yet sent is stale.
    const dropped = db.run("UPDATE scheduled_messages SET status = 'cancelled', skip_reason = 'the automation was edited' WHERE automation_id = ? AND status = 'queued'", existing.id).changes;
    const out = MSG.listAutomations(bid(req)).find((a) => a.id === existing.id);
    return { ...out, requeued_note: dropped ? `${dropped} queued message${dropped === 1 ? '' : 's'} dropped; new bookings use the updated version` : null };
  });

  // A copy to start a similar message from. It starts switched off, so nothing goes out twice
  // until the copy has been changed and turned on.
  app.post('/api/admin/automations/:id/clone', (req) => {
    requireRole('admin')(req);
    const a = getAutomation(req);
    const sort = (db.get('SELECT MAX(sort) m FROM message_automations WHERE business_id = ?', bid(req)) || {}).m || 0;
    const { lastId } = db.run(`INSERT INTO message_automations (business_id, name, channel, kind, trigger, offset_min,
        event_type_ids, calendar_ids, service_match, match_mode, skip_if_rebooked, subject, body_html, sms_body, active, sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    a.business_id, `${a.name} (copy)`.slice(0, 200), a.channel, a.kind, a.trigger, a.offset_min, a.event_type_ids, a.calendar_ids,
    a.service_match, a.match_mode, a.skip_if_rebooked, a.subject, a.body_html, a.sms_body, sort + 1);
    return MSG.listAutomations(bid(req)).find((x) => x.id === lastId);
  });

  app.delete('/api/admin/automations/:id', (req) => {
    requireRole('admin')(req);
    const a = getAutomation(req);
    db.run('DELETE FROM message_automations WHERE id = ?', a.id);
    return { ok: true };
  });

  app.post('/api/admin/automations/preview', (req) => {
    requireRole('host')(req);
    const body = req.body || {};
    const base = body.id ? db.get('SELECT * FROM message_automations WHERE id = ? AND business_id = ?', int(body.id), bid(req)) : {};
    return MSG.preview(B.byId(bid(req)), { ...(base || {}), ...body }, { bookingId: body.booking_id });
  });

  const getAutomationById = (businessId, id) => db.get('SELECT * FROM message_automations WHERE id = ? AND business_id = ?', int(id), businessId);
  app.post('/api/admin/automations/test', async (req) => {
    requireRole('admin')(req);
    const body = req.body || {};
    const base = body.id ? getAutomationById(bid(req), body.id) : {};
    const channel = body.channel === 'sms' ? 'sms' : 'email';
    const to = clampStr(String(body.to || '').trim(), 160) || (channel === 'sms' ? req.user.phone : req.user.email);
    try {
      return await MSG.sendTest(B.byId(bid(req)), { ...(base || {}), ...body }, { to, channel });
    } catch (e) {
      throw new HttpError(422, e.message);
    }
  });

  app.get('/api/admin/messages', (req) => {
    requireRole('host')(req);
    return {
      rows: MSG.listQueue(bid(req), {
        status: ['queued', 'sent', 'failed', 'skipped', 'cancelled'].includes(req.query.status) ? req.query.status : null,
        limit: int(req.query.limit, 100, 1, 500),
      }),
      summary: MSG.summary(bid(req)),
    };
  });

  // Nudge the queue by hand, for when someone does not want to wait for the next minute tick.
  app.post('/api/admin/messages/run', async (req) => {
    requireRole('admin')(req);
    return MSG.processDue({ limit: 40 });
  });

  app.post('/api/admin/messages/:id/cancel', (req) => {
    requireRole('admin')(req);
    const r = db.run("UPDATE scheduled_messages SET status = 'cancelled', skip_reason = 'cancelled by hand' WHERE id = ? AND business_id = ? AND status = 'queued'", int(req.params.id), bid(req));
    if (!r.changes) throw new HttpError(409, 'That message has already gone out or was cancelled.');
    return { ok: true };
  });

  app.get('/api/admin/sms-optouts', (req) => {
    requireRole('host')(req);
    return db.all('SELECT phone, reason, created_at FROM sms_optouts WHERE business_id = ? ORDER BY created_at DESC LIMIT 500', bid(req));
  });

  // Only ever removed because the person asked us to start again.
  app.delete('/api/admin/sms-optouts/:phone', (req) => {
    requireRole('admin')(req);
    const number = sms.normalizeNumber(req.params.phone);
    if (!number) throw new HttpError(422, 'That is not a number we recognise.');
    db.run('DELETE FROM sms_optouts WHERE business_id = ? AND phone = ?', bid(req), number);
    return { ok: true };
  });

  // ---------- Services (quote catalog) ----------
  // Spreadsheet import. Always dry run first so the admin sees exactly what will change.
  app.post('/api/admin/services/import', (req) => {
    requireRole('admin')(req);
    const { filename = '', data = '', mode = 'merge', confirm = false } = req.body || {};
    if (!data) throw new HttpError(400, 'No file was uploaded.');
    let buf;
    try { buf = Buffer.from(String(data), 'base64'); } catch { throw new HttpError(400, 'That file could not be read.'); }
    if (!buf.length) throw new HttpError(400, 'That file is empty.');
    if (buf.length > 6_000_000) throw new HttpError(413, 'That file is too large. Keep it under 6MB.');
    let parsed;
    try { parsed = Importer.analyze(buf, String(filename)); }
    catch (e) { throw new HttpError(400, e.message || 'That file could not be read.'); }
    if (!confirm) return { preview: true, ...parsed };
    const result = Importer.apply(bid(req), parsed, { mode: mode === 'replace' ? 'replace' : 'merge' });
    B.logActivity(bid(req), null, 'import', `Imported ${result.added + result.updated} services from ${String(filename).slice(0, 80)}`);
    return { preview: false, ...result, warnings: parsed.warnings };
  });

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
    return db.all("SELECT u.id, u.name, u.email, u.timezone, m.role, m.status, COALESCE(m.level, 'staff') level FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ? AND COALESCE(u.is_resource,0) = 0 ORDER BY m.status, u.name", bid(req)).map((m) => ({ ...m, has_hours: !!db.get('SELECT 1 FROM availability_rules WHERE user_id = ?', m.id), calendars: db.all('SELECT provider, account_email FROM calendar_connections WHERE user_id = ?', m.id), teams: ORG.teamsOf(bid(req), m.id) }));
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
    const url = B.linkFor(business, `/app#/accept/${inviteToken}`);
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
    // A level change on its own, from the People screen. It decides who gets which sales calls,
    // nothing about what they can see or do, so any admin can set it for anyone, owners included.
    if (req.body && req.body.level !== undefined && req.body.role === undefined) {
      if (!S.LEVELS.includes(req.body.level)) throw new HttpError(422, 'Unknown level');
      const n = db.run('UPDATE memberships SET level = ? WHERE user_id = ? AND business_id = ?', req.body.level, int(req.params.userId), bid(req)).changes;
      if (!n) throw new HttpError(404, 'Not found');
      return { ok: true };
    }
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
      return { result: await sendWebhook(business, 'test', { message: 'Hello from Availvo', lead: L.leadPayload(sample) }) };
    }
    if (req.body?.type === 'email') {
      return { result: await sendEmail({ to: req.user.email, businessId: business.id, subject: 'Test email from Availvo', html: layout(business, { heading: 'Email is working', body: '<p>This is a test message.</p>' }) }) };
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
