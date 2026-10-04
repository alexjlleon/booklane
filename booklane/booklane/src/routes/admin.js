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
const calendars = require('../services/calendars');
const { pushToBoothBook, sendWebhook, buildBoothBookPayload } = require('../services/integrations');
const Importer = require('../services/catalog-import');
const ORG = require('../services/org');
const SESS = require('../services/sessions');
const PROD = require('../services/products');
const FORMS = require('../services/forms');
const MSG = require('../services/messaging');
const stripe = require('../lib/stripe');
const sms = require('../lib/sms');
const appConfig = require('../lib/config');
const providers = require('../services/providers');
const { createBusiness, uniqueSlug, ensureDefaultAvailability, seedSessions } = require('../services/setup');

const authLimit = rateLimit({ windowMs: 15 * 60000, max: 25 });
const SECRET_MASK = '••••••••';
const bid = (req) => req.membership.id;
const isAdmin = (req) => ROLE_RANK[req.membership?.role] >= ROLE_RANK.admin;

function meResponse(req) {
  return { user: req.user, business: req.membership ? { ...req.membership } : null, businesses: req.memberships || [],
    app: { base_url: baseUrl(), calendars: Object.fromEntries(Object.entries(calendars.PROVIDERS).map(([k, p]) => [k, { label: p.label, configured: calendars.isConfigured(k) }])), email_provider: appConfig.get('RESEND_API_KEY') ? 'resend' : 'log' } };
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
  // Real people only. Market and designer calendars are login-less rows and belong on the
  // Sessions screen, not in the team list or the host pickers.
  const members = (businessId) => db.all("SELECT u.id, u.name, u.email, u.timezone, m.role FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ? AND m.status = 'active' AND COALESCE(u.is_resource,0) = 0 ORDER BY u.name", businessId);
  function etOut(et) {
    return { ...BK.hydrateEt(et), active: !!et.active, hosts: db.all('SELECT user_id FROM event_type_hosts WHERE event_type_id = ?', et.id).map((r) => r.user_id),
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
    return { event_types: db.all('SELECT * FROM event_types WHERE business_id = ? ORDER BY sort, id', bid(req)).map(etOut), members: members(bid(req)), teams: ORG.listTeams(bid(req)), booking_types: ORG.listTypes(bid(req)), location_types: LOCATION_TYPES, default_steps: DEFAULT_STEPS(), quick_date_steps: QUICK_DATE_STEPS() };
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

  // ---------- Sessions you can sell (markets, products, orders) ----------
  function sessionOut(et) {
    const s = SESS.hydrate({ ...et });
    return {
      id: et.id, slug: et.slug, name: et.name, description: et.description || '', active: !!et.active, sort: et.sort,
      duration_min: et.duration_min, buffer_after: et.buffer_after, min_notice_min: et.min_notice_min,
      max_days_ahead: et.max_days_ahead, slot_interval_min: et.slot_interval_min, location_type: et.location_type, location_value: et.location_value,
      price: s.session.price_cents / 100, price_cents: s.session.price_cents, currency: s.session.currency,
      session: s.session, steps: s.steps,
      calendar_ids: SESS.calendarsForProduct(et).map((c) => c.id),
      public_url: `${baseUrl()}/b/${B.byId(et.business_id).slug}/s/${et.slug}`,
      sold: db.get("SELECT COUNT(*) c FROM orders WHERE event_type_id = ? AND status = 'paid'", et.id).c,
    };
  }

  app.get('/api/admin/payments', (req) => {
    requireRole('admin')(req);
    // Never send the keys back, only whether they are set and which mode they are in.
    return {
      configured: stripe.configured(),
      mode: stripe.configured() ? (stripe.liveMode() ? 'live' : 'test') : null,
      webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET,
      webhook_url: `${baseUrl()}/api/public/stripe/webhook`,
      needs: [stripe.configured() ? null : 'STRIPE_SECRET_KEY', process.env.STRIPE_WEBHOOK_SECRET ? null : 'STRIPE_WEBHOOK_SECRET'].filter(Boolean),
    };
  });

  app.get('/api/admin/session-calendars', (req) => {
    requireRole('host')(req);
    return SESS.listCalendars(bid(req), { includeInactive: true }).map((c) => ({
      id: c.id, user_id: c.user_id, kind: c.kind, slug: c.slug, name: c.name, blurb: c.blurb || '',
      timezone: c.timezone || c.user_timezone, active: !!c.active, sort: c.sort,
      has_hours: !!db.get('SELECT 1 FROM availability_rules WHERE user_id = ?', c.user_id),
      connections: db.all('SELECT provider, account_email, last_error FROM calendar_connections WHERE user_id = ?', c.user_id),
      upcoming: db.get("SELECT COUNT(*) c FROM bookings WHERE host_user_id = ? AND status = 'confirmed' AND start_utc > datetime('now')", c.user_id).c,
    }));
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
      summary: SESS.revenueSummary(bid(req)),
      location_types: LOCATION_TYPES,
      defaults: SESSION_SETTINGS,
    };
  });

  function saveSession(req, existing) {
    const b = B.byId(bid(req));
    const body = req.body || {};
    const name = clampStr(String(body.name || '').trim(), 120);
    if (!name) throw new HttpError(422, 'Give the session a name', { name: 'Required' });
    const priceCents = body.price_cents !== undefined ? int(body.price_cents, 0, 0, 100000000) : Math.round(num(body.price, 0) * 100);
    const session = deepMerge(existing ? SESS.hydrate({ ...existing }).session : SESSION_SETTINGS, {
      ...(body.session && typeof body.session === 'object' ? body.session : {}),
      price_cents: priceCents,
      currency: clampStr(String(body.currency || (existing ? SESS.hydrate({ ...existing }).session.currency : 'USD')).toUpperCase(), 3),
    });
    // Money and hold windows are the two places a typo hurts, so clamp them here.
    session.price_cents = int(session.price_cents, 0, 0, 100000000);
    session.hold_minutes = int(session.hold_minutes, 30, 10, 180);
    session.includes = (Array.isArray(session.includes) ? session.includes : []).slice(0, 12).map((x) => clampStr(String(x), 120)).filter(Boolean);

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
      settings: JSON.stringify(deepMerge(existing ? db.json(existing.settings, {}) : {}, { session })),
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
      steps: x.steps, settings: x.settings, copy: x.copy, shape: FORMS.shapeOf(x.steps),
      active: !!x.active, sort: x.sort, submissions: x.submissions,
      url: `${baseUrl()}/b/${B.byId(x.business_id).slug}/f/${x.slug}`,
      leads: db.get('SELECT COUNT(*) c FROM leads WHERE form_id = ?', x.id).c,
    };
  };

  app.get('/api/admin/forms', (req) => {
    requireRole('host')(req);
    const b = B.byId(bid(req));
    return {
      forms: FORMS.listAll(b).map(formOut),
      event_types: db.all('SELECT id, name, slug, kind FROM event_types WHERE business_id = ? AND active = 1 ORDER BY sort, id', b.id),
      products: db.all('SELECT id, name, slug FROM products WHERE business_id = ? AND active = 1 ORDER BY sort, id', b.id),
      step_types: FORMS.STEP_TYPES,
      question_types: FORMS.Q_TYPES,
      templates: FORMS.templateList(),
      defaults: FORMS.FORM_SETTINGS,
    };
  });

  function saveForm(req, existing) {
    const b = B.byId(bid(req));
    const body = req.body || {};
    const name = clampStr(String(body.name || '').trim(), 120);
    if (!name) throw new HttpError(422, 'Give the form a name', { name: 'Required' });
    const steps = body.steps !== undefined ? FORMS.sanitizeSteps(body.steps, b) : (existing ? db.json(existing.steps, []) : []);
    const settings = deepMerge(existing ? db.json(existing.settings, {}) : {}, (body.settings && typeof body.settings === 'object') ? body.settings : {});
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

  app.post('/api/admin/forms/reorder', (req) => {
    requireRole('admin')(req);
    (req.body?.ids || []).forEach((id, i) => db.run('UPDATE forms SET sort = ? WHERE id = ? AND business_id = ?', i, int(id), bid(req)));
    return { ok: true };
  });

  // ---------- Products sold outright (albums, prints) ----------
  // Options and add-ons are edited here so the priced list is Alex's to change without a release.
  // Ids are slugs of the labels, kept stable once written: an order's lines already recorded their
  // own labels and prices, so renaming a choice later never rewrites history.
  const idFor = (label, used, fallback) => {
    let base = slugify(String(label || '')) || fallback;
    let out = base; let i = 2;
    while (used.has(out)) out = `${base}-${i++}`;
    used.add(out);
    return out;
  };

  function cleanGroups(raw) {
    const used = new Set();
    return (Array.isArray(raw) ? raw : []).slice(0, 12).map((g, gi) => {
      const id = g && g.id ? clampStr(String(g.id), 60) : idFor(g && g.label, used, `group-${gi + 1}`);
      used.add(id);
      const cUsed = new Set();
      return {
        id,
        label: clampStr(g?.label || '', 120),
        hint: clampStr(g?.hint || '', 200),
        required: g?.required === undefined ? true : bool(g.required),
        layout: ['cards', 'swatches', 'list'].includes(g?.layout) ? g.layout : 'list',
        applies_to: (Array.isArray(g?.applies_to) ? g.applies_to : []).slice(0, 24).map((x) => clampStr(String(x), 60)).filter(Boolean),
        choices: (Array.isArray(g?.choices) ? g.choices : []).slice(0, 60).map((c, ci) => ({
          id: c && c.id ? clampStr(String(c.id), 60) : idFor(c && c.label, cUsed, `choice-${ci + 1}`),
          label: clampStr(c?.label || '', 200),
          hint: clampStr(c?.hint || '', 200),
          image_url: clampStr(c?.image_url || '', 500),
          price_cents: c?.price_cents !== undefined ? int(c.price_cents, 0, 0, 100000000) : Math.round(num(c?.price, 0) * 100),
        })).filter((c) => c.label),
      };
    }).filter((g) => g.choices.length);
  }

  // A rule is { when: { groupId: choiceId }, price_cents }. Unknown keys are kept as given: the
  // group may be renamed later, and a rule that stops matching shows up as "no price for that
  // combination" rather than quietly charging the wrong amount.
  function cleanRules(raw) {
    return (Array.isArray(raw) ? raw : []).slice(0, 2000).map((r) => {
      const when = {};
      const src = (r && r.when && typeof r.when === 'object') ? r.when : {};
      for (const k of Object.keys(src).slice(0, 8)) when[clampStr(String(k), 60)] = clampStr(String(src[k]), 60);
      return { when, price_cents: r?.price_cents !== undefined ? int(r.price_cents, 0, 0, 100000000) : Math.round(num(r?.price, 0) * 100) };
    }).filter((r) => Object.keys(r.when).length);
  }

  function cleanAddons(raw) {
    const used = new Set();
    return (Array.isArray(raw) ? raw : []).slice(0, 40).map((a, i) => ({
      id: a && a.id ? clampStr(String(a.id), 60) : idFor(a && a.label, used, `extra-${i + 1}`),
      label: clampStr(a?.label || '', 200),
      hint: clampStr(a?.hint || '', 200),
      price_cents: a?.price_cents !== undefined ? int(a.price_cents, 0, 0, 100000000) : Math.round(num(a?.price, 0) * 100),
      price_rules: cleanRules(a?.price_rules),
      unit_label: clampStr(a?.unit_label || '', 60),
      per_unit: bool(a?.per_unit),
      ui: a?.ui === 'stepper' ? 'stepper' : 'check',
      max_qty: int(a?.max_qty, 1, 1, 200),
    })).filter((a) => a.label);
  }

  const productOut = (p) => {
    const x = PROD.hydrate({ ...p });
    const sold = db.get("SELECT COUNT(*) c, COALESCE(SUM(amount_cents),0) cents FROM orders WHERE product_id = ? AND status = 'paid'", x.id);
    return {
      id: x.id, slug: x.slug, name: x.name, description: x.description || '', image_url: x.image_url || '',
      base_cents: x.base_cents, base_dollars: (x.base_cents / 100).toFixed(2), currency: x.currency,
      option_groups: x.option_groups, addons: x.addons, price_rules: x.price_rules,
      min_qty: x.min_qty, max_qty: x.max_qty, default_qty: x.default_qty,
      followup_event_type_id: x.followup_event_type_id, settings: x.settings, copy: x.copy,
      active: !!x.active, sort: x.sort,
      sold_count: sold.c, sold_cents: sold.cents,
      url: `${baseUrl()}/b/${B.byId(x.business_id).slug}/p/${x.slug}`,
    };
  };

  app.get('/api/admin/products', (req) => {
    requireRole('host')(req);
    const b = B.byId(bid(req));
    return {
      products: PROD.listAll(b).map(productOut),
      event_types: db.all("SELECT id, name, slug, kind FROM event_types WHERE business_id = ? AND active = 1 ORDER BY sort, id", b.id),
      defaults: PROD.PRODUCT_SETTINGS,
    };
  });

  function saveProduct(req, existing) {
    const b = B.byId(bid(req));
    const body = req.body || {};
    const name = clampStr(String(body.name || '').trim(), 120);
    if (!name) throw new HttpError(422, 'Give the product a name', { name: 'Required' });

    const groups = body.option_groups !== undefined ? cleanGroups(body.option_groups) : (existing ? db.json(existing.option_groups, []) : []);
    const addons = body.addons !== undefined ? cleanAddons(body.addons) : (existing ? db.json(existing.addons, []) : []);
    const baseCents = body.base_cents !== undefined ? int(body.base_cents, 0, 0, 100000000) : (body.base_price !== undefined ? Math.round(num(body.base_price, 0) * 100) : (existing ? existing.base_cents : 0));

    // Something has to carry a price, or the page would ask for money it cannot name.
    const rules = body.price_rules !== undefined ? cleanRules(body.price_rules) : (existing ? db.json(existing.price_rules, []) : []);
    const anyPrice = baseCents > 0
      || rules.some((r) => r.price_cents > 0)
      || groups.some((g) => g.choices.some((c) => c.price_cents > 0))
      || addons.some((a) => a.price_cents > 0 || a.price_rules.some((r) => r.price_cents > 0));
    if (!anyPrice) throw new HttpError(422, 'Give this a price, either on the product or on one of its choices', { base_price: 'Needs a price' });

    let followup = body.followup_event_type_id !== undefined
      ? (body.followup_event_type_id ? int(body.followup_event_type_id) : null)
      : (existing ? existing.followup_event_type_id : null);
    if (followup && !db.get('SELECT 1 FROM event_types WHERE id = ? AND business_id = ?', followup, b.id)) followup = null;

    const minQty = int(body.min_qty, existing?.min_qty ?? 1, 1, 100);
    const maxQty = Math.max(minQty, int(body.max_qty, existing?.max_qty ?? 10, 1, 100));
    const settings = deepMerge(existing ? db.json(existing.settings, {}) : {}, (body.settings && typeof body.settings === 'object') ? body.settings : {});

    const f = {
      name,
      description: clampStr(body.description || (existing ? existing.description : '') || '', 1000),
      image_url: clampStr(body.image_url || (existing ? existing.image_url : '') || '', 500),
      base_cents: baseCents,
      currency: clampStr(String(body.currency || existing?.currency || 'USD').toUpperCase(), 3),
      option_groups: JSON.stringify(groups),
      addons: JSON.stringify(addons),
      price_rules: JSON.stringify(rules),
      min_qty: minQty,
      max_qty: maxQty,
      default_qty: Math.min(maxQty, Math.max(minQty, int(body.default_qty, existing?.default_qty ?? 1, 1, 100))),
      followup_event_type_id: followup,
      settings: JSON.stringify(settings),
      active: body.active !== undefined ? (bool(body.active) ? 1 : 0) : (existing ? existing.active : 1),
    };

    if (existing) {
      db.run(`UPDATE products SET name=?, description=?, image_url=?, base_cents=?, currency=?, option_groups=?, addons=?, price_rules=?,
          min_qty=?, max_qty=?, default_qty=?, followup_event_type_id=?, settings=?, active=? WHERE id = ? AND business_id = ?`,
      f.name, f.description, f.image_url, f.base_cents, f.currency, f.option_groups, f.addons, f.price_rules,
      f.min_qty, f.max_qty, f.default_qty, f.followup_event_type_id, f.settings, f.active, existing.id, b.id);
      return productOut(db.get('SELECT * FROM products WHERE id = ?', existing.id));
    }
    let slug = slugify(body.slug || name) || 'product';
    let sl = slug; let i = 2;
    while (db.get('SELECT 1 FROM products WHERE business_id = ? AND slug = ?', b.id, sl)) sl = `${slug}-${i++}`;
    const sort = (db.get('SELECT MAX(sort) m FROM products WHERE business_id = ?', b.id) || {}).m || 0;
    const { lastId } = db.run(`INSERT INTO products (business_id, slug, name, description, image_url, base_cents, currency,
        option_groups, addons, price_rules, min_qty, max_qty, default_qty, followup_event_type_id, settings, active, sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.id, sl, f.name, f.description, f.image_url, f.base_cents, f.currency, f.option_groups, f.addons, f.price_rules,
    f.min_qty, f.max_qty, f.default_qty, f.followup_event_type_id, f.settings, f.active, sort + 1);
    return productOut(db.get('SELECT * FROM products WHERE id = ?', lastId));
  }

  app.post('/api/admin/products', (req) => { requireRole('admin')(req); return saveProduct(req, null); });
  app.patch('/api/admin/products/:id', (req) => {
    requireRole('admin')(req);
    const existing = db.get('SELECT * FROM products WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!existing) throw new HttpError(404, 'Not found');
    return saveProduct(req, existing);
  });
  app.delete('/api/admin/products/:id', (req) => {
    requireRole('admin')(req);
    const p = db.get('SELECT * FROM products WHERE id = ? AND business_id = ?', int(req.params.id), bid(req));
    if (!p) throw new HttpError(404, 'Not found');
    const sold = db.get("SELECT COUNT(*) c FROM orders WHERE product_id = ? AND status = 'paid'", p.id).c;
    // Something people have paid for is switched off, never deleted: the orders still point at it.
    if (sold) { db.run('UPDATE products SET active = 0 WHERE id = ?', p.id); return { ok: true, deactivated: true, sold }; }
    db.run('DELETE FROM products WHERE id = ?', p.id);
    return { ok: true };
  });
  /**
   * Paste a price matrix instead of typing it.
   *
   * Each line is the choices then the price: "8x8 Square, Velvet, 190". Columns map onto the first
   * option groups in order, and a label that is not a choice yet is added, so pasting a supplier's
   * whole sheet builds the options and prices them in one go. Tabs, commas and pipes all work, so a
   * copy straight out of a spreadsheet lands correctly.
   */
  app.post('/api/admin/products/:id/price-matrix', (req) => {
    requireRole('admin')(req);
    const b = B.byId(bid(req));
    const p = db.get('SELECT * FROM products WHERE id = ? AND business_id = ?', int(req.params.id), b.id);
    if (!p) throw new HttpError(404, 'Not found');
    const body = req.body || {};
    const target = clampStr(body.target || 'product', 60);

    const lines = String(body.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new HttpError(422, 'Paste some rows first', { text: 'Required' });

    // Strip the comma out of "1,298.00" before splitting, or a four-figure album would be read as
    // two cells and priced at $298.
    const split = (line) => line
      .replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1')
      .split(/\t|\s*\|\s*|,(?![^(]*\))/)
      .map((c) => c.trim()).filter((c) => c !== '');
    // Strict on purpose: a label like "8x8 Square" must not read as the number 88, or every row
    // would be mistaken for a header and silently dropped.
    const priceOf = (cell) => {
      const m = String(cell).trim().match(/^\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*$/);
      if (!m) return null;
      const n = Number(m[1].replace(/,/g, ''));
      return Number.isFinite(n) ? Math.round(n * 100) : null;
    };

    const rows = [];
    for (const line of lines) {
      const cells = split(line);
      if (cells.length < 2) continue;
      const cents = priceOf(cells[cells.length - 1]);
      if (cents === null) continue;             // header rows and notes fall out here
      const labels = cells.slice(0, -1);
      if (labels.every((l) => priceOf(l) !== null)) continue;   // a row of pure numbers is not a variation
      rows.push({ labels, cents });
    }
    if (!rows.length) throw new HttpError(422, 'Could not read any priced rows out of that. Each line needs its choices then a price, like "8x8 Square, Velvet, 190".', { text: 'Nothing readable' });

    const cols = Math.max(...rows.map((r) => r.labels.length));
    const groups = db.json(p.option_groups, []);
    if (groups.length < cols) throw new HttpError(422, `Those rows have ${cols} choice column${cols === 1 ? '' : 's'}, but this product only has ${groups.length} option group${groups.length === 1 ? '' : 's'}. Add the missing group first.`, { text: 'Too many columns' });

    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    let added = 0;
    const rules = [];
    for (const row of rows) {
      const when = {};
      let ok = true;
      row.labels.forEach((label, i) => {
        const g = groups[i];
        if (!g) { ok = false; return; }
        g.choices = g.choices || [];
        let choice = g.choices.find((c) => norm(c.label) === norm(label));
        if (!choice) {
          const used = new Set(g.choices.map((c) => c.id));
          choice = { id: idFor(label, used, `choice-${g.choices.length + 1}`), label: clampStr(label, 200), hint: '', image_url: '', price_cents: 0 };
          g.choices.push(choice);
          added++;
        }
        when[g.id] = choice.id;
      });
      if (ok && Object.keys(when).length) rules.push({ when, price_cents: row.cents });
    }

    const cleanedGroups = cleanGroups(groups);
    const cleanedRules = cleanRules(rules);
    if (target === 'product') {
      db.run('UPDATE products SET option_groups = ?, price_rules = ? WHERE id = ?', JSON.stringify(cleanedGroups), JSON.stringify(cleanedRules), p.id);
    } else {
      const addons = db.json(p.addons, []);
      const hit = addons.find((a) => a.id === target);
      if (!hit) throw new HttpError(404, 'No such extra on this product');
      hit.price_rules = cleanedRules;
      db.run('UPDATE products SET option_groups = ?, addons = ? WHERE id = ?', JSON.stringify(cleanedGroups), JSON.stringify(cleanAddons(addons)), p.id);
    }
    B.logActivity(b.id, null, 'import', `Priced ${cleanedRules.length} combination${cleanedRules.length === 1 ? '' : 's'} on ${p.name}`);
    return { ok: true, rules: cleanedRules.length, choices_added: added, product: productOut(db.get('SELECT * FROM products WHERE id = ?', p.id)) };
  });

  app.post('/api/admin/products/reorder', (req) => {
    requireRole('admin')(req);
    (req.body?.ids || []).forEach((id, i) => db.run('UPDATE products SET sort = ? WHERE id = ? AND business_id = ?', i, int(id), bid(req)));
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
    const sold = db.get("SELECT COUNT(*) c FROM orders WHERE event_type_id = ? AND status = 'paid'", et.id).c;
    // Keeping the row keeps the paid orders readable, so switch it off rather than deleting.
    if (sold) throw new HttpError(409, `${et.name} has ${sold} paid order${sold === 1 ? '' : 's'} attached. Switch it off instead of deleting it.`);
    db.run('DELETE FROM event_types WHERE id = ?', et.id);
    return { ok: true };
  });

  app.get('/api/admin/orders', (req) => {
    requireRole('host')(req);
    const { rows, total } = SESS.listOrders(bid(req), {
      status: ['pending', 'paid', 'expired', 'failed', 'refunded', 'not_required'].includes(req.query.status) ? req.query.status : null,
      eventTypeId: req.query.session ? int(req.query.session) : null,
      limit: int(req.query.limit, 100, 1, 500), offset: int(req.query.offset, 0, 0),
    });
    return { rows, total, summary: SESS.revenueSummary(bid(req)) };
  });

  app.get('/api/admin/orders/export.csv', (req, res) => {
    requireRole('admin')(req);
    const { rows } = SESS.listOrders(bid(req), { limit: 5000 });
    const cols = ['created_at', 'status', 'product_name', 'calendar', 'amount', 'already_booked', 'booking_number', 'customer_name', 'customer_email', 'customer_phone', 'start', 'timezone', 'booking_status', 'error'];
    const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    res.set('Content-Disposition', 'attachment; filename="session-orders.csv"');
    res.text([cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'), 'text/csv; charset=utf-8');
  });

  // Seed the markets and the starter session products. Idempotent: matched by slug.
  app.post('/api/admin/sessions/seed', (req) => {
    requireRole('admin')(req);
    return seedSessions(B.byId(bid(req)), req.body || {});
  });

  // ---------- Integrations: Stripe, Twilio, Resend ----------
  // Reading status needs admin. Writing a credential needs owner: a saved live Stripe key is the
  // difference between reading the dashboard and being able to take money as this business.
  app.get('/api/admin/integrations/providers', (req) => {
    requireRole('admin')(req);
    return providers.status(B.byId(bid(req)));
  });

  app.put('/api/admin/integrations/providers/:provider', (req) => {
    requireRole('owner')(req);
    const provider = String(req.params.provider);
    if (!['stripe', 'square', 'twilio', 'resend', 'payments'].includes(provider)) throw new HttpError(404, 'Unknown integration');
    const business = B.byId(bid(req));
    // Card credentials belong to this business. Twilio and Resend stay shared for now, which is why
    // only the payment providers are scoped.
    const scoped = ['stripe', 'square', 'payments'].includes(provider) ? business.id : undefined;
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
    return { ok: true, changed, status: providers.status(business)[provider] };
  });

  app.post('/api/admin/integrations/providers/:provider/check', async (req) => {
    requireRole('admin')(req);
    try {
      return await providers.check(String(req.params.provider), B.byId(bid(req)));
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

  // A real dollar through the whole path. Typed confirmation, because it is real money.
  app.post('/api/admin/integrations/stripe/test-charge', async (req) => {
    requireRole('owner')(req);
    const body = req.body || {};
    if (String(body.confirm || '').trim().toUpperCase() !== 'CHARGE') {
      throw new HttpError(422, 'Type CHARGE to confirm a real payment.', { confirm: 'Type CHARGE to confirm' });
    }
    try {
      const r = await providers.startDiagnosticCharge(B.byId(bid(req)), req.user, { amountCents: int(body.amount_cents, 100, 50, 5000) });
      B.logActivity(bid(req), null, 'integration', `${req.user.email} started a $${r.amount.toFixed(2)} Stripe connection test`);
      return r;
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
    return db.all('SELECT u.id, u.name, u.email, u.timezone, m.role, m.status FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ? AND COALESCE(u.is_resource,0) = 0 ORDER BY m.status, u.name', bid(req)).map((m) => ({ ...m, has_hours: !!db.get('SELECT 1 FROM availability_rules WHERE user_id = ?', m.id), calendars: db.all('SELECT provider, account_email FROM calendar_connections WHERE user_id = ?', m.id), teams: ORG.teamsOf(bid(req), m.id) }));
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
