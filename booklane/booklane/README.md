# Booklane

Booklane is a scheduling and quote platform that can host many businesses, similar to Calendly or TidyCal. It is built around two goals:

1. **Book a call quickly.** Customers go through a step-by-step flow: pick a time, give contact info, then answer your custom questions. Each step and field saves as they go. If someone leaves partway, you still get everything they entered, which step they reached, and the time they wanted. You can also get an alert, and the customer can get a "finish where you left off" email.
2. **Build your own quote.** Customers choose services, packages and add-ons and see a live total with bundle discounts, tax and deposit. From there they can **request a contract**, **book a call**, or ask you to **call them back**. A contract request is saved to the lead, emailed to your team, pushed to BoothBook and sent to your webhook (for example Zapier).

The app has no npm dependencies. It runs on Node 22.13+ (built-in `node:sqlite`), so there is no `npm install`.

## Run locally

```bash
npm run seed      # creates a demo business (sample prices) and prints the owner login
npm start         # http://localhost:3000
npm test          # end-to-end API tests
```

- Dashboard: `/app`
- Demo booking page: `/b/weddings-unlimited`
- Demo booking flow: `/b/weddings-unlimited/discovery-call`
- Demo quote builder: `/b/weddings-unlimited/quote`

The seed can be configured with `SEED_EMAIL=you@company.com SEED_PASSWORD=... npm run seed`.

## Deploy to Railway

1. Push this folder to a GitHub repo and create a Railway service from it. Railway uses the `Dockerfile`.
2. Add a **Volume** mounted at `/data`. The SQLite database lives there.
3. Set the variables from `.env.example`. At minimum set `BASE_URL`, `APP_SECRET` and `DATA_DIR=/data`. For real emails, also set `RESEND_API_KEY` and `EMAIL_FROM`.
4. Deploy, open `/app#/signup` and create your account. Then set `ALLOW_SIGNUP=false` if this is only for your businesses.
5. Optional: set `HOME_REDIRECT=business` so your domain root opens your booking page.

Keep **1 replica**. SQLite and the background job (partial-lead alerts, reminders) run inside the single process.

## Connect calendars

Each team member connects their own calendar under **Calendars**. Busy times block slots, and new bookings are added to the calendar. Google Meet and Teams links are created automatically when a call type uses them.

- **Google:** create an OAuth client (Web) in Google Cloud, enable the Calendar API and add the redirect URI `{BASE_URL}/oauth/google/callback`. Then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- **Microsoft 365 / Outlook:** create an App registration (Web) with the redirect URI `{BASE_URL}/oauth/microsoft/callback` and the delegated permissions `Calendars.ReadWrite`, `User.Read` and `offline_access`. Then set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.

Calendar tokens are stored encrypted using `APP_SECRET`.

## BoothBook

**Settings → Integrations → BoothBook** posts contract requests to a URL you configure. The request carries your client key and secret plus the mapped fields. BoothBook's developer API is invite-only and its public docs don't list the lead endpoint. So get the exact endpoint and field names from BoothBook (developer@boothbook.com), then:

1. Paste the endpoint URL, key and secret.
2. Adjust the **field mapping** JSON so our fields match BoothBook's names.
3. Click **Preview payload**, then **Send test lead**. The response is shown so you can confirm it worked.

If you would rather avoid the API, turn on the **Webhook** instead and point it at a Zapier "Catch Hook" that runs Zapier's BoothBook "Create Lead" action.

Each lead page also has a **Push to BoothBook** button for re-sending.

## Webhooks

Each event is sent as a JSON POST: `lead.partial`, `lead.completed`, `booking.created`, `booking.cancelled`, `quote.submitted`, `contract.requested`, `callback.requested`. If you set a secret, every request carries `X-Booklane-Signature: sha256=<HMAC of body>`.

## Embed on a website (WordPress / Avada)

Get the code from **Share & embed** and paste it into a Code / HTML block:

```html
<div data-booklane="b/your-business"></div>
<script src="https://book.example.com/embed.js" async></script>
```

For a popup instead: `<button data-booklane-popup="b/your-business/quote">Get a quote</button>` plus the same script tag. The iframe resizes itself. UTM parameters on your links are saved with each lead.

## How partial capture works

- A lead is created on the first real interaction (picking a time, typing, choosing an option), not on page view. That keeps bots and bounces out.
- Each step change saves right away. Typing is debounced (about 0.7s). When the tab closes, a `sendBeacon` flush sends anything still pending.
- The browser remembers the lead, so a returning visitor picks up where they left off. Recovery emails link to `?resume=<token>`.
- After `abandoned_after_min` minutes of inactivity, the background job emails your team (once), sends the `lead.partial` webhook and, if enabled, emails the customer a resume link.
- The dashboard's **Where people drop off** funnel shows how far visitors get in each form.

Tip: move the **Contact info** step earlier (Booking pages → Form steps) to capture more leads you can follow up with.

## Project layout

```
src/server.js            HTTP server, security headers, OAuth callbacks, background jobs
src/lib/                 router, auth/sessions, time zone math, email (Resend), ICS, crypto
src/services/            scheduling engine, bookings, leads, quotes, calendars, integrations
src/routes/public.js     booking pages + public API
src/routes/admin.js      dashboard API (scoped per business, role checks)
public/js/               booking flow, scheduler, quote builder, admin SPA, shared pricing engine
test/app.test.js         end-to-end tests (partial capture, double booking, round robin, pricing, BoothBook/webhook, isolation, hardening)
```

## Roles

- **Owner:** everything, including managing other owners.
- **Admin:** settings, booking pages, catalog and team (but not owners).
- **Host:** takes calls, sees leads and bookings, and manages their own hours and calendar.

Team members are invited by email and set their own password when they accept.
