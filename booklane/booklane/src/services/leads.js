'use strict';
const db = require('../db');
const { token } = require('../lib/security');
const { isEmail, clampStr, baseUrl, esc } = require('../lib/util');
const { sendEmail, layout, rows } = require('../lib/email');
const B = require('./business');
const { sendWebhook } = require('./integrations');

function sanitizeAnswers(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input).slice(0, 60)) {
    const key = String(k).slice(0, 60);
    if (Array.isArray(v)) out[key] = v.slice(0, 50).map((x) => String(x).slice(0, 300));
    else if (v === null || v === undefined) out[key] = null;
    else if (typeof v === 'object') continue;
    else out[key] = String(v).slice(0, 5000);
  }
  return out;
}

function createLead(business, { source = 'booking', eventTypeId = null, meta = {} }) {
  const t = token(18);
  const safeMeta = {
    utm: Object.fromEntries(Object.entries(meta.utm || {}).filter(([k]) => /^utm_|^gclid$|^fbclid$/.test(k)).map(([k, v]) => [k, String(v).slice(0, 200)])),
    referrer: clampStr(meta.referrer, 500), landing: clampStr(meta.landing, 500), user_agent: clampStr(meta.user_agent, 300),
    embedded: !!meta.embedded,
  };
  const { lastId } = db.run('INSERT INTO leads (business_id, token, source, event_type_id, meta) VALUES (?,?,?,?,?)',
    business.id, t, source, eventTypeId, JSON.stringify(safeMeta));
  return db.get('SELECT * FROM leads WHERE id = ?', lastId);
}

const byToken = (t) => db.get('SELECT * FROM leads WHERE token = ?', String(t || ''));

function updateLead(lead, body) {
  const answers = { ...db.json(lead.answers, {}), ...sanitizeAnswers(body.answers) };
  const c = body.contact || {};
  const email = c.email !== undefined ? (isEmail(c.email) ? c.email.trim().toLowerCase() : lead.email) : lead.email;
  const stepIndex = Number.isInteger(body.step_index) ? Math.max(0, Math.min(50, body.step_index)) : lead.step_index;
  db.run(`UPDATE leads SET answers = ?, first_name = ?, last_name = ?, email = ?, phone = ?, sms_consent = ?,
      step_index = ?, step_key = ?, step_total = ?, max_step_index = MAX(max_step_index, ?), last_activity_at = datetime('now'),
      abandoned_notified_at = CASE WHEN status = 'partial' THEN abandoned_notified_at ELSE abandoned_notified_at END
    WHERE id = ?`,
  JSON.stringify(answers),
  c.first_name !== undefined ? clampStr(String(c.first_name).trim(), 80) : lead.first_name,
  c.last_name !== undefined ? clampStr(String(c.last_name).trim(), 80) : lead.last_name,
  email,
  c.phone !== undefined ? clampStr(String(c.phone).trim(), 40) : lead.phone,
  c.sms_consent !== undefined ? (c.sms_consent ? 1 : 0) : lead.sms_consent,
  stepIndex, body.step_key !== undefined ? clampStr(body.step_key, 60) : lead.step_key,
  Number.isInteger(body.step_total) ? body.step_total : lead.step_total, stepIndex, lead.id);
  return db.get('SELECT * FROM leads WHERE id = ?', lead.id);
}

function setStatus(lead, status, { complete = false } = {}) {
  db.run(`UPDATE leads SET status = ?, completed_at = CASE WHEN ? THEN COALESCE(completed_at, datetime('now')) ELSE completed_at END, last_activity_at = datetime('now') WHERE id = ?`, status, complete ? 1 : 0, lead.id);
}

function leadName(l) { return [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || l.phone || 'Anonymous visitor'; }

function publicLead(l) {
  return { token: l.token, source: l.source, status: l.status, step_index: l.step_index, max_step_index: l.max_step_index, answers: db.json(l.answers, {}),
    contact: { first_name: l.first_name || '', last_name: l.last_name || '', email: l.email || '', phone: l.phone || '', sms_consent: !!l.sms_consent } };
}

function leadPayload(l) {
  return { id: l.id, token: l.token, source: l.source, status: l.status, first_name: l.first_name, last_name: l.last_name, email: l.email, phone: l.phone,
    sms_consent: !!l.sms_consent, step_key: l.step_key, step_index: l.step_index, step_total: l.step_total, answers: db.json(l.answers, {}), meta: db.json(l.meta, {}),
    created_at: l.created_at, last_activity_at: l.last_activity_at, admin_url: `${baseUrl()}/app#/leads/${l.id}` };
}

function resumeUrl(business, lead) {
  if (lead.source === 'quote') {
    const q = db.get('SELECT token FROM quotes WHERE lead_id = ? ORDER BY id DESC LIMIT 1', lead.id);
    return `${baseUrl()}/b/${business.slug}/quote?resume=${q ? q.token : ''}`;
  }
  const et = lead.event_type_id ? db.get('SELECT slug FROM event_types WHERE id = ?', lead.event_type_id) : null;
  return `${baseUrl()}/b/${business.slug}/${et ? et.slug : ''}?resume=${lead.token}`;
}

function answersToPairs(answers) {
  return Object.entries(answers || {}).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => [k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), Array.isArray(v) ? v.join(', ') : v]);
}

async function sendRecoveryEmail(business, lead) {
  if (!lead.email) return { status: 'skipped' };
  const url = resumeUrl(business, lead);
  const what = lead.source === 'quote' ? 'your quote' : 'booking your call';
  const res = await sendEmail({
    to: lead.email, businessId: business.id, fromName: business.name, replyTo: business.email,
    subject: lead.source === 'quote' ? `Your ${business.name} quote is saved` : `Finish booking your call with ${business.name}`,
    html: layout(business, {
      heading: `Hi ${lead.first_name || 'there'}, you were almost done!`,
      body: `<p>We saved everything you entered, so you can pick up right where you left off with ${esc(what)}.</p>`,
      cta: { label: lead.source === 'quote' ? 'Finish my quote' : 'Finish booking', url },
    }),
  });
  db.run("UPDATE leads SET recovery_sent_at = datetime('now') WHERE id = ?", lead.id);
  B.logActivity(business.id, lead.id, 'email', `Recovery email sent to ${lead.email}`);
  return res;
}

async function processAbandoned() {
  const candidates = db.all(`SELECT l.*, b.id bid FROM leads l JOIN businesses b ON b.id = l.business_id
    WHERE l.status = 'partial' AND (l.abandoned_notified_at IS NULL OR l.recovery_sent_at IS NULL) AND l.last_activity_at > datetime('now', '-7 days')`);
  for (const lead of candidates) {
    const business = B.byId(lead.bid);
    const s = business.settings.leads;
    const idleMin = (Date.now() - Date.parse(lead.last_activity_at.replace(' ', 'T') + 'Z')) / 60000;
    const hasContact = !!(lead.email || lead.phone);
    const hasAnything = hasContact || Object.keys(db.json(lead.answers, {})).length > 0;
    if (!lead.abandoned_notified_at && idleMin >= s.abandoned_after_min) {
      db.run("UPDATE leads SET abandoned_notified_at = datetime('now') WHERE id = ?", lead.id);
      if (!hasAnything || (s.partial_requires_contact && !hasContact)) continue;
      B.logActivity(business.id, lead.id, 'abandoned', `Left the ${lead.source === 'quote' ? 'quote builder' : 'booking form'} at step ${lead.max_step_index + 1} of ${lead.step_total || '?'}`);
      if (s.notify_team_on_partial) {
        const et = lead.event_type_id ? db.get('SELECT name FROM event_types WHERE id = ?', lead.event_type_id) : null;
        await sendEmail({
          to: B.teamEmails(business), businessId: business.id,
          subject: `Partial lead: ${leadName(lead)} (${lead.source === 'quote' ? 'quote builder' : et?.name || 'booking'})`,
          html: layout(business, {
            heading: 'Someone started but did not finish',
            body: `<p>They made it to step <b>${lead.max_step_index + 1}</b> of ${lead.step_total || '?'} before leaving. Here is everything they entered:</p>` +
              rows([['Name', leadName(lead)], ['Email', lead.email], ['Phone', lead.phone], ['Form', lead.source === 'quote' ? 'Quote builder' : et?.name], ...answersToPairs(db.json(lead.answers, {}))]),
            cta: { label: 'Open lead', url: `${baseUrl()}/app#/leads/${lead.id}` },
          }),
        });
      }
      await sendWebhook(business, 'lead.partial', leadPayload(lead), lead.id);
    }
    if (s.send_recovery_email && lead.email && !lead.recovery_sent_at && idleMin >= s.recovery_delay_min) {
      await sendRecoveryEmail(business, lead);
    }
  }
}

module.exports = { createLead, byToken, updateLead, setStatus, publicLead, leadPayload, leadName, processAbandoned, sendRecoveryEmail, resumeUrl, answersToPairs, sanitizeAnswers };
