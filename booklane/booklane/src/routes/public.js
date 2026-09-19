'use strict';
const db = require('../db');
const T = require('../lib/time');
const { HttpError } = require('../lib/router');
const { rateLimit } = require('../lib/security');
const { baseUrl, bool } = require('../lib/util');
const { buildIcs, googleCalendarLink } = require('../lib/ics');
const { page, APP_NAME } = require('../views');
const B = require('../services/business');
const L = require('../services/leads');
const S = require('../services/scheduling');
const Q = require('../services/quotes');
const BK = require('../services/bookings');
const { LOCATION_TYPES } = require('../defaults');

const writeLimit = rateLimit({ windowMs: 60000, max: 90 });
const createLimit = rateLimit({ windowMs: 10 * 60000, max: 40 });
const bookLimit = rateLimit({ windowMs: 10 * 60000, max: 15 });

function getBusiness(slug) {
  const b = B.bySlug(slug);
  if (!b) throw new HttpError(404, 'Business not found');
  return b;
}
function getEventType(business, slug) {
  const et = BK.hydrateEt(db.get('SELECT * FROM event_types WHERE business_id = ? AND slug = ? AND active = 1', business.id, slug));
  if (!et) throw new HttpError(404, 'This booking page is not available');
  return et;
}
const publicBusiness = (b) => ({ id: b.id, slug: b.slug, name: b.name, logo_url: b.logo_url, brand_color: b.brand_color, timezone: b.timezone, phone: b.phone, email: b.email, website: b.website, settings: B.publicSettings(b) });
function publicEventType(et) {
  const hosts = S.hostsFor(et.id).map((h) => ({ name: h.name }));
  return { id: et.id, slug: et.slug, name: et.name, description: et.description, duration_min: et.duration_min, location_type: et.location_type,
    location_label: LOCATION_TYPES[et.location_type], location_value: et.location_type === 'in_person' ? et.location_value : null,
    max_days_ahead: et.max_days_ahead, color: et.color, steps: et.steps, hosts, settings: et.settings };
}
const activeEventTypes = (b) => db.all('SELECT * FROM event_types WHERE business_id = ? AND active = 1 ORDER BY sort, id', b.id).map(BK.hydrateEt);

module.exports = function publicRoutes(app) {
  // ---------- Pages ----------
  app.get('/b/:slug', (req, res) => {
    const b = getBusiness(req.params.slug);
    const embed = bool(req.query.embed);
    res.html(page({ title: `${b.name} · Book a call`, description: b.settings.tagline, business: b, embed, scripts: ['common.js', 'profile.js'],
      data: { business: publicBusiness(b), eventTypes: activeEventTypes(b).map(publicEventType) } }));
  });

  app.get('/b/:slug/quote', (req, res) => {
    const b = getBusiness(req.params.slug);
    if (!b.settings.quote.enabled) throw new HttpError(404, 'Quotes are not enabled');
    const callEt = b.settings.quote.call_event_type_id ? db.get('SELECT slug FROM event_types WHERE id = ? AND business_id = ? AND active = 1', b.settings.quote.call_event_type_id, b.id) : null;
    const fallbackEt = callEt || db.get('SELECT slug FROM event_types WHERE business_id = ? AND active = 1 ORDER BY sort, id LIMIT 1', b.id);
    res.html(page({ title: `${b.settings.quote.title} · ${b.name}`, description: b.settings.quote.intro, business: b, embed: bool(req.query.embed), scripts: ['pricing.js', 'common.js', 'quote.js'],
      data: { business: publicBusiness(b), catalog: Q.catalog(b.id), callEventSlug: fallbackEt?.slug || null } }));
  });

  app.get('/b/:slug/:event', (req, res) => {
    const b = getBusiness(req.params.slug);
    const et = getEventType(b, req.params.event);
    let services = [];
    try { services = Q.catalog(b.id).map((s) => s.name); } catch { /* ignore */ }
    res.html(page({ title: `${et.name} · ${b.name}`, description: et.description || b.settings.tagline, business: b, embed: bool(req.query.embed), scripts: ['common.js', 'scheduler.js', 'booking.js'],
      data: { business: publicBusiness(b), eventType: publicEventType(et), serviceNames: services } }));
  });

  app.get('/q/:token', (req, res) => {
    const q = Q.byToken(req.params.token);
    if (!q) throw new HttpError(404, 'Quote not found');
    const b = B.byId(q.business_id);
    const callEt = b.settings.quote.call_event_type_id ? db.get('SELECT slug FROM event_types WHERE id = ? AND business_id = ? AND active = 1', b.settings.quote.call_event_type_id, b.id) : db.get('SELECT slug FROM event_types WHERE business_id = ? AND active = 1 ORDER BY sort, id LIMIT 1', b.id);
    res.set('X-Robots-Tag', 'noindex');
    res.html(page({ title: `Your quote · ${b.name}`, business: b, scripts: ['pricing.js', 'common.js', 'quote-view.js'],
      data: { business: publicBusiness(b), quote: Q.publicQuote(q, b), catalog: Q.catalog(b.id), callEventSlug: callEt?.slug || null } }));
  });

  app.get('/booking/:token', (req, res) => {
    const bk = db.get('SELECT * FROM bookings WHERE token = ?', req.params.token);
    if (!bk) throw new HttpError(404, 'Booking not found');
    const { et, business, host } = BK.bookingView(bk);
    res.set('X-Robots-Tag', 'noindex');
    res.html(page({ title: `Your booking · ${business.name}`, business, scripts: ['common.js', 'scheduler.js', 'manage.js'],
      data: { business: publicBusiness(business), eventType: et ? publicEventType(et) : null, booking: bookingPublic(bk, et, business, host), reschedule: bool(req.query.reschedule) } }));
  });

  function bookingPublic(bk, et, business, host) {
    const start = Date.parse(bk.start_utc), end = Date.parse(bk.end_utc);
    const summary = `${et?.name || 'Call'} with ${business.name}`;
    return { token: bk.token, status: bk.status, start: bk.start_utc, end: bk.end_utc, timezone: bk.invitee_tz, name: bk.name, email: bk.email, location: bk.location,
      host: host?.name, event_name: et?.name, duration_min: et?.duration_min, cancel_reason: bk.cancel_reason,
      google_link: googleCalendarLink({ start, end, summary, location: bk.location, description: `${baseUrl()}/booking/${bk.token}` }), ics_url: `/api/public/bookings/${bk.token}/ics` };
  }

  // ---------- Booking API ----------
  app.get('/api/public/b/:slug/e/:event/slots', async (req) => {
    const b = getBusiness(req.params.slug);
    const et = getEventType(b, req.params.event);
    const tz = T.isValidTz(req.query.tz) ? req.query.tz : b.timezone;
    const from = T.isDateStr(req.query.from) ? req.query.from : T.utcToZoned(Date.now(), tz).date;
    let to = T.isDateStr(req.query.to) ? req.query.to : T.addDays(from, 30);
    if (to < from) to = from;
    if (Date.parse(to) - Date.parse(from) > 62 * 86400000) to = T.addDays(from, 62);
    const exclude = req.query.reschedule ? db.get('SELECT id FROM bookings WHERE token = ?', req.query.reschedule)?.id : undefined;
    const slots = await S.computeSlots(et, from, to, tz, { excludeBookingId: exclude });
    const days = {};
    for (const [d, list] of Object.entries(slots)) days[d] = list.map((s) => s.start);
    return { timezone: tz, from, to, days };
  });

  app.post('/api/public/b/:slug/leads', (req) => {
    createLimit(req);
    const b = getBusiness(req.params.slug);
    const body = req.body || {};
    let et = null;
    if (body.event_type_slug) et = db.get('SELECT id FROM event_types WHERE business_id = ? AND slug = ?', b.id, body.event_type_slug);
    const lead = L.createLead(b, { source: body.source === 'quote' ? 'quote' : 'booking', eventTypeId: et?.id, meta: { ...(body.meta || {}), user_agent: req.headers['user-agent'] } });
    B.logActivity(b.id, lead.id, 'started', `Started the ${lead.source === 'quote' ? 'quote builder' : 'booking form'}`);
    return { token: lead.token };
  });

  app.get('/api/public/leads/:token', (req) => {
    const lead = L.byToken(req.params.token);
    if (!lead) throw new HttpError(404, 'Not found');
    return L.publicLead(lead);
  });

  const patchLead = (req) => {
    writeLimit(req);
    const lead = L.byToken(req.params.token);
    if (!lead) throw new HttpError(404, 'Not found');
    const updated = L.updateLead(lead, req.body || {});
    return { ok: true, status: updated.status };
  };
  app.patch('/api/public/leads/:token', patchLead);
  app.post('/api/public/leads/:token/beacon', (req, res) => { try { patchLead(req); } catch { /* beacons are fire-and-forget */ } res.statusCode = 204; res.end(); });

  app.post('/api/public/b/:slug/e/:event/book', async (req) => {
    bookLimit(req);
    const b = getBusiness(req.params.slug);
    const et = getEventType(b, req.params.event);
    const body = req.body || {};
    let lead = body.lead_token ? L.byToken(body.lead_token) : null;
    if (lead && lead.business_id !== b.id) lead = null;
    if (!lead) lead = L.createLead(b, { source: 'booking', eventTypeId: et.id });
    let quote = body.quote_token ? Q.byToken(body.quote_token) : null;
    if (quote && quote.business_id !== b.id) quote = null;
    if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) body.answers = {};
    if (quote) body.answers.quote_total = String(quote.total);
    const contact = body.contact && typeof body.contact === 'object' ? body.contact : {};
    const booking = await BK.createBooking({ business: b, et, startIso: body.start, tz: body.timezone, contact, answers: body.answers || {}, lead, quote });
    if (quote) db.run("UPDATE quotes SET next_step = 'call', status = CASE WHEN status = 'draft' THEN 'submitted' ELSE status END, updated_at = datetime('now') WHERE id = ?", quote.id);
    return { token: booking.token, redirect: `/booking/${booking.token}?new=1` };
  });

  app.get('/api/public/bookings/:token/ics', (req, res) => {
    const bk = db.get('SELECT * FROM bookings WHERE token = ?', req.params.token);
    if (!bk) throw new HttpError(404, 'Not found');
    const { et, business, host } = BK.bookingView(bk);
    res.set('Content-Disposition', 'attachment; filename="booking.ics"');
    res.text(buildIcs({ uid: `booking-${bk.id}-${bk.token.slice(0, 8)}@booklane`, start: Date.parse(bk.start_utc), end: Date.parse(bk.end_utc), summary: `${et?.name || 'Call'} with ${business.name}`,
      description: `${baseUrl()}/booking/${bk.token}`, location: bk.location, organizerName: business.name, organizerEmail: host?.email, attendeeName: bk.name, attendeeEmail: bk.email, method: 'PUBLISH', cancelled: bk.status === 'cancelled' }), 'text/calendar; charset=utf-8');
  });

  app.post('/api/public/bookings/:token/cancel', async (req) => {
    writeLimit(req);
    const bk = db.get('SELECT * FROM bookings WHERE token = ?', req.params.token);
    if (!bk) throw new HttpError(404, 'Not found');
    await BK.cancelBooking(bk, req.body?.reason, 'invitee');
    return { ok: true };
  });

  app.post('/api/public/bookings/:token/reschedule', async (req) => {
    bookLimit(req);
    const bk = db.get('SELECT * FROM bookings WHERE token = ?', req.params.token);
    if (!bk) throw new HttpError(404, 'Not found');
    const updated = await BK.rescheduleBooking(bk, req.body?.start, req.body?.timezone);
    return { ok: true, start: updated.start_utc };
  });

  // ---------- Quote API ----------
  app.post('/api/public/b/:slug/quotes', (req) => {
    createLimit(req);
    const b = getBusiness(req.params.slug);
    const body = req.body || {};
    let lead = body.lead_token ? L.byToken(body.lead_token) : null;
    if (lead && lead.business_id !== b.id) lead = null;
    if (!lead) {
      lead = L.createLead(b, { source: 'quote', meta: { ...(body.meta || {}), user_agent: req.headers['user-agent'] } });
      B.logActivity(b.id, lead.id, 'started', 'Started the quote builder');
    }
    const q = Q.createQuote(b, lead);
    return { token: q.token, lead_token: lead.token };
  });

  app.get('/api/public/quotes/:token', (req) => {
    const q = Q.byToken(req.params.token);
    if (!q) throw new HttpError(404, 'Not found');
    return Q.publicQuote(q, B.byId(q.business_id));
  });

  app.patch('/api/public/quotes/:token', (req) => {
    writeLimit(req);
    const q = Q.byToken(req.params.token);
    if (!q) throw new HttpError(404, 'Not found');
    const b = B.byId(q.business_id);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const locked = !['draft', 'submitted'].includes(q.status);
    if (locked && (body.details || body.selections)) throw new HttpError(409, 'This quote is locked because a contract was requested. Contact us to make changes.');
    if (body.details) db.run("UPDATE quotes SET details = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify({ ...db.json(q.details, {}), ...Q.sanitizeDetails({ ...db.json(q.details, {}), ...body.details }, b) }), q.id);
    if (body.selections) Q.recalc(b, q, Q.sanitizeSelections(body.selections));
    const lead = q.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', q.lead_id) : null;
    if (lead) {
      const details = db.json(Q.byToken(q.token).details, {});
      const quoteAnswers = { event_type: details.event_type, event_date: details.event_date, venue: details.venue, city: details.city, guests: details.guests };
      const fresh = Q.byToken(q.token);
      const services = db.json(fresh.line_items, []).map((l) => l.name);
      const extra = services.length ? { services, quote_total: String(fresh.total) } : {};
      L.updateLead(lead, { ...body, answers: { ...Object.fromEntries(Object.entries(quoteAnswers).filter(([, v]) => v)), ...extra } });
    }
    return Q.publicQuote(Q.byToken(q.token), b);
  });

  async function quoteAction(req, fn) {
    bookLimit(req);
    const q = Q.byToken(req.params.token);
    if (!q) throw new HttpError(404, 'Not found');
    const b = B.byId(q.business_id);
    const lead = db.get('SELECT * FROM leads WHERE id = ?', q.lead_id);
    if (!lead) throw new HttpError(400, 'Missing contact info');
    return fn(b, q, lead);
  }
  app.post('/api/public/quotes/:token/submit', (req) => quoteAction(req, async (b, q, lead) => ({ quote: Q.publicQuote(await Q.submitQuote(b, q, lead), b) })));
  app.post('/api/public/quotes/:token/contract', (req) => quoteAction(req, async (b, q, lead) => {
    const r = await Q.requestContract(b, q, lead, req.body || {});
    return { quote: Q.publicQuote(r.quote, b) };
  }));
  app.post('/api/public/quotes/:token/callback', (req) => quoteAction(req, async (b, q, lead) => ({ quote: Q.publicQuote(await Q.requestCallback(b, q, lead, req.body || {}), b) })));

  // Is the business free on a given event date? Used by the "we're available" step.
  app.get('/api/public/b/:slug/date-check', (req) => {
    const b = getBusiness(req.params.slug);
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Pick a date first.');
    const hit = db.get('SELECT note FROM blocked_dates WHERE business_id = ? AND date = ?', b.id, date);
    return { date, available: !hit, note: hit ? String(hit.note || '').slice(0, 200) : '' };
  });

  // ---------- Embed script ----------
  app.get('/embed.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.text(`(function(){var base=${JSON.stringify(baseUrl())};
function src(){try{return encodeURIComponent(location.href.slice(0,500))}catch(e){return ''}}
function stitle(){try{return encodeURIComponent((document.title||'').slice(0,120))}catch(e){return ''}}
function frame(url,el){var f=document.createElement('iframe');f.src=url+(url.indexOf('?')>-1?'&':'?')+'embed=1&src='+src()+'&stitle='+stitle();f.style.cssText='width:100%;border:0;min-height:640px;display:block;color-scheme:normal';f.setAttribute('title','${APP_NAME} booking');f.setAttribute('loading','lazy');el.appendChild(f);return f}
window.addEventListener('message',function(e){if(e.origin!==base||!e.data||e.data.type!=='booklane:height')return;var fs=document.querySelectorAll('iframe');for(var i=0;i<fs.length;i++){if(fs[i].contentWindow===e.source){fs[i].style.height=e.data.height+'px'}}});
function inline(){var els=document.querySelectorAll('[data-booklane]');for(var i=0;i<els.length;i++){var el=els[i];if(el.__bl)continue;el.__bl=1;frame(base+'/'+el.getAttribute('data-booklane').replace(/^\\//,''),el)}}
function popup(path){var o=document.createElement('div');o.style.cssText='position:fixed;inset:0;background:rgba(15,12,30,.6);z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:16px';var box=document.createElement('div');box.style.cssText='background:#fff;border-radius:16px;width:100%;max-width:980px;max-height:92vh;overflow:auto;position:relative';var x=document.createElement('button');x.innerHTML='&times;';x.setAttribute('aria-label','Close');x.style.cssText='position:absolute;top:8px;right:12px;font-size:28px;background:none;border:0;cursor:pointer;z-index:2';x.onclick=function(){o.remove()};o.onclick=function(e){if(e.target===o)o.remove()};box.appendChild(x);o.appendChild(box);document.body.appendChild(o);frame(base+'/'+path.replace(/^\\//,''),box)}
function cta(el){if(el.__bl)return;el.__bl=1;
var path=el.getAttribute('data-booklane-cta').replace(/^\\//,'');
var fieldName=el.getAttribute('data-field')||'event_date';
var label=el.getAttribute('data-label')||'';
var btn=el.getAttribute('data-button')||'Check availability';
var ph=el.getAttribute('data-placeholder')||'';
var color=el.getAttribute('data-color')||'';
var itype=/date/.test(fieldName)?'date':/phone|tel/.test(fieldName)?'tel':/email/.test(fieldName)?'email':'text';
var f=document.createElement('form');
f.style.cssText='display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;font:inherit';
var wrap=document.createElement('label');
wrap.style.cssText='display:flex;flex-direction:column;gap:4px;flex:1;min-width:180px;font:inherit';
if(label){var sp=document.createElement('span');sp.textContent=label;sp.style.cssText='font-size:14px;font-weight:600';wrap.appendChild(sp)}
var input=document.createElement('input');
input.type=itype;input.name=fieldName;input.placeholder=ph;input.required=true;
input.style.cssText='font:inherit;padding:12px 14px;border:1px solid rgba(0,0,0,.18);border-radius:10px;width:100%;box-sizing:border-box;background:#fff';
if(itype==='date'){try{input.min=new Date().toISOString().slice(0,10)}catch(e){}}
wrap.appendChild(input);
var go=document.createElement('button');
go.type='submit';go.textContent=btn;
go.style.cssText='font:inherit;font-weight:700;padding:12px 20px;border:0;border-radius:10px;cursor:pointer;color:#fff;background:'+(color||'#5b3df5');
f.appendChild(wrap);f.appendChild(go);
f.addEventListener('submit',function(e){e.preventDefault();
  var v=(input.value||'').trim();if(!v){input.focus();return}
  popup(path+(path.indexOf('?')>-1?'&':'?')+encodeURIComponent(fieldName)+'='+encodeURIComponent(v));
});
el.appendChild(f)}
function ctas(){var els=document.querySelectorAll('[data-booklane-cta]');for(var i=0;i<els.length;i++)cta(els[i])}
window.Booklane={popup:popup,inline:inline,ctas:ctas};
document.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('[data-booklane-popup]');if(t){e.preventDefault();popup(t.getAttribute('data-booklane-popup'))}});
function init(){inline();ctas()}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();})();`, 'application/javascript; charset=utf-8');
  });
};
