'use strict';
const db = require('../db');
const { BUSINESS_SETTINGS } = require('../defaults');
const { deepMerge } = require('../lib/util');

const FREE_MAPS = new Set(['integrations.boothbook.field_map', 'integrations.boothbook.static_fields']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Keep only keys that exist in the defaults, coerced to the default's type. Protects against bad or hostile settings payloads.
function conform(def, val, path = '') {
  if (FREE_MAPS.has(path)) {
    if (!isObj(val)) return undefined;
    return Object.fromEntries(Object.entries(val).slice(0, 50).filter(([, v]) => ['string', 'number'].includes(typeof v)).map(([k, v]) => [String(k).slice(0, 80), String(v).slice(0, 500)]));
  }
  if (isObj(def)) {
    if (!isObj(val)) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (!(k in def)) continue;
      const c = conform(def[k], v, path ? `${path}.${k}` : k);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  if (Array.isArray(def)) {
    if (!Array.isArray(val)) return undefined;
    if (path === 'quote.bundle_discounts') return val.filter(isObj).slice(0, 10).map((t) => ({ min_services: Math.max(1, Math.min(50, parseInt(t.min_services, 10) || 2)), percent: Math.max(0, Math.min(100, Number(t.percent) || 0)), label: String(t.label || '').slice(0, 80) }));
    return val.filter((x) => ['string', 'number'].includes(typeof x)).slice(0, 100).map((x) => String(x).slice(0, 300));
  }
  if (typeof def === 'number') { const n = Number(val); return val !== '' && val !== null && Number.isFinite(n) ? n : undefined; }
  if (typeof def === 'boolean') return val === true || val === 'true' || val === 1 || val === '1';
  if (typeof def === 'string') return val == null ? undefined : String(val).slice(0, 5000);
  if (def === null) { if (val === null || val === '') return null; const n = Number(val); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

function hydrate(b) {
  if (!b) return b;
  b.settings = deepMerge(BUSINESS_SETTINGS, conform(BUSINESS_SETTINGS, db.json(b.settings, {})) || {});
  return b;
}
const bySlug = (slug) => hydrate(db.get('SELECT * FROM businesses WHERE slug = ?', slug));
const byId = (id) => hydrate(db.get('SELECT * FROM businesses WHERE id = ?', id));

function teamEmails(b) {
  const list = (b.settings.notifications.team_emails || []).filter(Boolean);
  if (list.length) return list;
  if (b.email) return [b.email];
  return db.all("SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ? AND m.status = 'active' AND m.role IN ('owner','admin')", b.id).map((r) => r.email);
}

function logActivity(businessId, leadId, type, message, meta = {}) {
  db.run('INSERT INTO activity (business_id, lead_id, type, message, meta) VALUES (?,?,?,?,?)', businessId, leadId || null, type, message, JSON.stringify(meta));
}

// Settings safe to expose publicly (no integration secrets)
function publicSettings(b) {
  const s = b.settings;
  return {
    tagline: s.tagline, about: s.about, urgency_text: s.urgency_text, trust_points: s.trust_points,
    sms_consent_text: s.sms_consent_text, privacy_note: s.privacy_note,
    quote: {
      enabled: s.quote.enabled, title: s.quote.title, intro: s.quote.intro, currency: s.quote.currency, tax_rate: s.quote.tax_rate,
      deposit_type: s.quote.deposit_type, deposit_value: s.quote.deposit_value, bundle_discounts: s.quote.bundle_discounts,
      contact_step_position: s.quote.contact_step_position, event_types: s.quote.event_types, guest_ranges: s.quote.guest_ranges, cities: s.quote.cities,
      require_event_date: s.quote.require_event_date, next_steps: s.quote.next_steps, terms: s.quote.terms, contract_fields: s.quote.contract_fields,
      call_event_type_id: s.quote.call_event_type_id,
    },
  };
}

module.exports = { conform, hydrate, bySlug, byId, teamEmails, logActivity, publicSettings };
