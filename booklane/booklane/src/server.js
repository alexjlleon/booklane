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

app.get('/app', (req, res) => res.html(page({ title: `${APP_NAME} dashboard`, scripts: ['pricing.js', 'admin-core.js', 'admin-main.js', 'admin-setup.js', 'admin-business.js'], styles: ['app.css', 'admin.css'], bodyClass: 'admin' })));

app.get('/oauth/:provider/start', (req, res) => {
  requireAuth(req);
  const p = req.params.provider;
  if (!calendars.PROVIDERS[p]) throw new HttpError(404, 'Unknown provider');
  if (!calendars.isConfigured(p)) return res.redirect(`/app#/calendars?error=${encodeURIComponent(`${calendars.PROVIDERS[p].label} is not configured on the server yet`)}`);
  res.redirect(calendars.startAuth(p, req.user.id));
});
app.get('/oauth/:provider/callback', async (req, res) => {
  const p = req.params.provider;
  if (req.query.error) return res.redirect(`/app#/calendars?error=${encodeURIComponent(req.query.error_description || req.query.error)}`);
  try {
    if (!calendars.PROVIDERS[p]) throw new HttpError(404, 'Unknown provider');
    const r = await calendars.finishAuth(p, req.query.code, req.query.state, req.user?.id);
    res.redirect(`/app#/calendars?connected=${encodeURIComponent(r.email || p)}`);
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
  try { await L.processAbandoned(); await BK.sendReminders(); db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now()); } catch (e) { console.error('[jobs]', e); } finally { jobRunning = false; }
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  http.createServer(app.handler).listen(port, () => {
    console.log(`${APP_NAME} running on ${baseUrl()} (port ${port})`);
    setInterval(runJobs, Number(process.env.JOB_INTERVAL_MS) || 60000).unref();
    setTimeout(runJobs, 5000).unref();
  });
}

module.exports = { app, runJobs };
