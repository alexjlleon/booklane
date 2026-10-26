'use strict';
const http = require('node:http');
const path = require('node:path');
const { createRouter, serveStatic, HttpError } = require('./lib/router');
const { loadSession, requireAuth } = require('./lib/auth');
const { page, APP_NAME } = require('./views');
const { baseUrl } = require('./lib/util');
const B = require('./services/business');
const calendars = require('./services/calendars');
const L = require('./services/leads');
const BK = require('./services/bookings');
const MSG = require('./services/messaging');
const CATALOG_REPAIR = require('./services/catalog-repair');
const db = require('./db');

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const app = createRouter();

// ---------- company domains ----------
// A request for book.weddingsunlimited.com is that company's site: its home page at /, its booking
// pages at /<page>, and its admin at /app. Paths that belong to the platform itself keep working
// there, so a booking's manage link or a quote link opens on the company's own domain.
const PLATFORM_PATHS = new Set(['api', 'app', 'static', 'b', 'q', 'booking', 'oauth', 'healthz', 'embed.js', 'favicon.ico', 'robots.txt', 'session']);
const requestHost = (req) => String(req.headers.host || '').split(',')[0].trim();
app.pre((req, res) => {
  const host = B.normalizeDomain(requestHost(req));
  // A company's domain wins even when it is also the platform's address, which it is for Weddings
  // Unlimited until Booklane has a domain of its own.
  req.hostBusiness = host ? B.byDomain(host) : null;
  if (!req.hostBusiness) {
    // A company with its own domain has one address for each page. Its /b/ pages on the platform
    // forward there, so old links and bookmarks keep working and search engines see one copy.
    const m = /^\/b\/([^/]+)(\/.*)?$/.exec(req.path);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      const owner = B.bySlug(decodeURIComponent(m[1]));
      if (owner && owner.custom_domain) {
        const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        res.statusCode = 301;
        res.setHeader('Location', `https://${owner.custom_domain}${m[2] || '/'}${qs}`);
        return res.end();
      }
    }
    return;
  }
  const slug = req.hostBusiness.slug;
  const [, first = '', second = ''] = req.path.split('/');
  if (!first) { req.path = `/b/${slug}`; return; }
  if (first === 'b') {
    // Another company's pages are not served under this one's name.
    if (second && second.toLowerCase() !== slug.toLowerCase()) throw new HttpError(404, 'Not found');
    return;
  }
  if (PLATFORM_PATHS.has(first)) return;
  req.path = `/b/${slug}${req.path}`;
});

// Security headers. Public booking pages may be framed (embeds); the admin may not.
app.use((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  const framable = req.path.startsWith('/b/') || req.path.startsWith('/booking/') || req.path.startsWith('/q/') || req.path.startsWith('/static/');
  if (!framable) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if ((process.env.BASE_URL || '').startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
});
app.use(serveStatic(path.join(__dirname, '..', 'public'), '/static'));
app.use((req) => {
  if (req.path.startsWith('/api/admin') || req.path.startsWith('/app') || req.path.startsWith('/oauth')) loadSession(req);
  // CSRF defense: state-changing admin API calls must be JSON from our own origin
  if (req.path.startsWith('/api/admin') && req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && origin !== baseUrl() && !(req.headers.host && origin.endsWith('//' + req.headers.host))) throw new HttpError(403, 'Cross-site request blocked');
    if (!(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Use JSON');
  }
});

app.get('/healthz', () => ({ ok: true, db: !!db.get('SELECT 1 x') }));

// The platform's own home page. Neutral on purpose: it is the front door for every company on
// Booklane, so it names none of them. A company's domain never reaches here; it is rewritten above.
app.get('/', (req, res) => {
  const first = db.get('SELECT slug FROM businesses ORDER BY id LIMIT 1');
  if (process.env.HOME_REDIRECT === 'business' && first) return res.redirect(`/b/${first.slug}`);
  const signup = process.env.ALLOW_SIGNUP !== 'false';
  res.html(page({ title: `${APP_NAME} · Booking pages and quotes for service businesses`, description: 'Booking pages that capture every lead, round robin for your team, and a quote builder customers finish.', scripts: [], styles: ['app.css'],
    body: `<main class="home"><div class="home-card"><div class="logo-mark"></div><h1>${APP_NAME}</h1>
    <p>Booking pages that capture every lead, round robin across your team, and a quote builder customers actually finish.</p>
    <ul class="home-points"><li>Your own domain and branding</li><li>Google and Outlook calendars, with busy times respected</li><li>Email and text reminders, and team performance at a glance</li></ul>
    <div class="home-actions">${signup ? '<a class="btn btn-primary btn-lg" href="/app#/signup">Create your booking page</a>' : ''}<a class="btn ${signup ? 'btn-ghost' : 'btn-primary'} btn-lg" href="/app#/login">Log in</a></div></div></main>` }));
});

app.get('/app', (req, res) => res.html(page({ title: `${req.hostBusiness ? `${req.hostBusiness.name} · ` : ''}${APP_NAME} dashboard`,
  // On a company's own domain the login screen is that company's, so it does not offer sign-up.
  data: { companyDomain: req.hostBusiness ? { name: req.hostBusiness.name } : null, allowSignup: process.env.ALLOW_SIGNUP !== 'false' && !req.hostBusiness },
  scripts: ['pricing.js', 'admin-core.js', 'admin-main.js', 'admin-setup.js', 'admin-business.js', 'admin-org.js', 'admin-sessions.js', 'admin-forms.js', 'admin-messaging.js', 'admin-integrations.js', 'admin-team.js'], styles: ['app.css', 'admin.css'], bodyClass: 'admin' })));

app.get('/oauth/:provider/start', (req, res) => {
  requireAuth(req);
  const p = req.params.provider;
  if (!calendars.PROVIDERS[p]) throw new HttpError(404, 'Unknown provider');
  const back = req.query.calendar ? '/app#/sessions' : '/app#/calendars';
  if (!calendars.isConfigured(p)) return res.redirect(`${back}?error=${encodeURIComponent(`${calendars.PROVIDERS[p].label} is not configured on the server yet`)}`);
  // Connecting on behalf of a market calendar. It has no login, so an admin of that business
  // authorises with their own account; anyone else must not be able to point it at a resource.
  let target = null;
  if (req.query.calendar) {
    if (!['owner', 'admin'].includes(req.membership?.role)) return res.redirect(`${back}?error=${encodeURIComponent('Only an admin can connect a calendar to a market')}`);
    const prof = db.get('SELECT user_id FROM calendar_profiles WHERE id = ? AND business_id = ?', Number(req.query.calendar) || 0, req.membership.id);
    if (!prof) return res.redirect(`${back}?error=${encodeURIComponent('That calendar is not one of yours')}`);
    target = prof.user_id;
  }
  // The sign-in always returns to the platform's callback (the one address registered with Google
  // and Microsoft). Remember which domain it started on so the callback can hand it back there,
  // where this person's session actually is.
  res.redirect(calendars.startAuth(p, req.user.id, target, req.hostBusiness ? B.baseFor(req.hostBusiness) : null));
});
async function finishCalendarSignIn(req, res) {
  const p = req.params.provider;
  if (req.query.error) return res.redirect(`/app#/calendars?error=${encodeURIComponent(req.query.error_description || req.query.error)}`);
  try {
    if (!calendars.PROVIDERS[p]) throw new HttpError(404, 'Unknown provider');
    const r = await calendars.finishAuth(p, req.query.code, req.query.state, req.user?.id);
    // Land back where they started, so connecting a market does not dump them on their own page.
    res.redirect(`/app#/${r.forTarget ? 'sessions' : 'calendars'}?connected=${encodeURIComponent(r.email || p)}`);
  } catch (e) {
    res.redirect(`/app#/calendars?error=${encodeURIComponent(e.message)}`);
  }
}
app.get('/oauth/:provider/callback', (req, res) => {
  // Started on a company's domain: send the code and state back there to finish, because that is
  // where the person is logged in. The code is single-use and only redeemable with our secret, and
  // finishing still requires the session of the person who started it.
  const row = req.query.state ? calendars.stateRow(req.query.state, req.params.provider) : null;
  const here = `https://${B.normalizeDomain(requestHost(req))}`;
  if (row && row.return_origin && row.return_origin !== here && row.return_origin !== baseUrl()) {
    const qs = new URLSearchParams(Object.fromEntries(['code', 'state', 'error', 'error_description'].filter((k) => req.query[k]).map((k) => [k, req.query[k]])));
    return res.redirect(`${row.return_origin}/oauth/${encodeURIComponent(req.params.provider)}/finish?${qs}`);
  }
  return finishCalendarSignIn(req, res);
});
app.get('/oauth/:provider/finish', finishCalendarSignIn);

require('./routes/public')(app);
require('./routes/admin')(app);

// Background jobs: abandoned-lead alerts, recovery emails, reminders
let jobRunning = false;
async function runJobs() {
  if (jobRunning) return;
  jobRunning = true;
  try {
    await L.processAbandoned();
    await BK.sendReminders();
    await MSG.processDue();
    db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  } catch (e) { console.error('[jobs]', e); } finally { jobRunning = false; }
}

if (require.main === module) {
  // Optional one-time demo data on a fresh database (Railway: set SEED_DEMO=true for the first deploy)
  if (process.env.SEED_DEMO === 'true' && !db.get('SELECT 1 FROM businesses LIMIT 1')) {
    try { require('../scripts/seed').seed(); } catch (e) { console.error('[seed]', e); }
  }
  // Catalogs imported before combination pricing existed are quoting the plain sum of two services
  // where the price sheet gives the pair a price. Fix them here rather than waiting for someone to
  // notice and re-upload; it marks itself done, so it runs once per catalog and never again.
  CATALOG_REPAIR.repairAll();
  const port = Number(process.env.PORT) || 3000;
  http.createServer(app.handler).listen(port, () => {
    console.log(`${APP_NAME} running on ${baseUrl()} (port ${port})`);
    setInterval(runJobs, Number(process.env.JOB_INTERVAL_MS) || 60000).unref();
    setTimeout(runJobs, 5000).unref();
  });
}

module.exports = { app, runJobs };
