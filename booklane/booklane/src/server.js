'use strict';
const http = require('node:http');
const path = require('node:path');
const { createRouter, serveStatic, HttpError } = require('./lib/router');
const { loadSession, requireAuth } = require('./lib/auth');
const { page, APP_NAME } = require('./views');
const { baseUrl } = require('./lib/util');
const calendars = require('./services/calendars');
const L = require('./services/leads');
const BK = require('./services/bookings');
const MSG = require('./services/messaging');
const SESS = require('./services/sessions');
const CATALOG_REPAIR = require('./services/catalog-repair');
const db = require('./db');

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const app = createRouter();

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

app.get('/', (req, res) => {
  const first = db.get('SELECT slug FROM businesses ORDER BY id LIMIT 1');
  if (process.env.HOME_REDIRECT === 'business' && first) return res.redirect(`/b/${first.slug}`);
  res.html(page({ title: `${APP_NAME} · Scheduling + quotes`, description: 'Let customers book a call or build their own quote in minutes.', scripts: [], styles: ['app.css'],
    body: `<main class="home"><div class="home-card"><div class="logo-mark"></div><h1>${APP_NAME}</h1><p>Booking pages that capture every lead, plus a quote builder customers actually finish.</p>
    <div class="home-actions"><a class="btn btn-primary btn-lg" href="/app#/signup">Create your booking page</a><a class="btn btn-ghost btn-lg" href="/app#/login">Log in</a></div>
    ${first ? `<p class="muted small">See a live example: <a href="/b/${first.slug}">/b/${first.slug}</a></p>` : ''}</div></main>` }));
});

app.get('/app', (req, res) => res.html(page({ title: `${APP_NAME} dashboard`, scripts: ['pricing.js', 'admin-core.js', 'admin-main.js', 'admin-setup.js', 'admin-business.js', 'admin-org.js', 'admin-sessions.js', 'admin-products.js', 'admin-forms.js', 'admin-messaging.js', 'admin-integrations.js'], styles: ['app.css', 'admin.css'], bodyClass: 'admin' })));

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
  res.redirect(calendars.startAuth(p, req.user.id, target));
});
app.get('/oauth/:provider/callback', async (req, res) => {
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
});

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
    SESS.releaseExpiredHolds();
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
