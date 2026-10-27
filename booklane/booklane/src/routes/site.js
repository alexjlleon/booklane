'use strict';
// The platform's own public pages: the home page, the privacy policy and the terms.
//
// Google reviews these before it lets any Google account connect a calendar without a warning
// screen: the home page has to say what the app does and link the privacy policy, and the policy
// has to say plainly what Google data is used, how and why. Keep them true to the code. If
// Availvo starts reading anything new from a calendar, the policy changes in the same release.
//
// Who runs the platform and where to write are settings, so a change of owner or address is a
// variable in Railway rather than a code change:
//   PLATFORM_OWNER  (default "Weddings Unlimited LLC")
//   SUPPORT_EMAIL   (default alex@weddingsunlimited.com)
const db = require('../db');
const { page, APP_NAME } = require('../views');
const { esc } = require('../lib/util');

const owner = () => process.env.PLATFORM_OWNER || 'Weddings Unlimited LLC';
const support = () => process.env.SUPPORT_EMAIL || 'alex@weddingsunlimited.com';
const UPDATED = 'October 27, 2026';

const footer = () => `<footer class="site-foot">
  <a href="/">${esc(APP_NAME)}</a><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a><a href="mailto:${esc(support())}">Contact</a>
  <span>© ${new Date().getFullYear()} ${esc(owner())}</span>
</footer>`;

function legal(title, body) {
  return page({ title: `${title} · ${APP_NAME}`, description: `${APP_NAME} ${title.toLowerCase()}`, scripts: [], styles: ['app.css'],
    body: `<main class="legal"><a class="legal-home" href="/"><span class="logo-mark"></span>${esc(APP_NAME)}</a>
      <h1>${esc(title)}</h1><p class="muted">Last updated ${UPDATED}</p>${body}</main>${footer()}` });
}

module.exports = function site(app) {
  // The platform's own home page. Neutral on purpose: it is the front door for every company on
  // Availvo, so it names none of them. A company's domain never reaches here; it is rewritten above.
  app.get('/', (req, res) => {
    const first = db.get('SELECT slug FROM businesses ORDER BY id LIMIT 1');
    if (process.env.HOME_REDIRECT === 'business' && first) return res.redirect(`/b/${first.slug}`);
    const signup = process.env.ALLOW_SIGNUP !== 'false';
    res.html(page({ title: `${APP_NAME} · Booking pages and quotes for service businesses`,
      description: `${APP_NAME} gives service businesses booking pages, custom forms and a quote builder, connected to their Google or Outlook calendar so customers only see times that are really free.`,
      scripts: [], styles: ['app.css'],
      body: `<main class="home"><div class="home-card"><div class="logo-mark"></div><h1>${esc(APP_NAME)}</h1>
      <p>Booking pages that capture every lead, round robin across your team, and a quote builder customers actually finish.</p>
      <ul class="home-points"><li>Your own domain and branding</li><li>Google and Outlook calendars, with busy times respected</li><li>Email and text reminders, and team performance at a glance</li></ul>
      <div class="home-actions">${signup ? '<a class="btn btn-primary btn-lg" href="/app#/signup">Create your booking page</a>' : ''}<a class="btn ${signup ? 'btn-ghost' : 'btn-primary'} btn-lg" href="/app#/login">Log in</a></div></div>

      <section class="home-more">
        <h2>What ${esc(APP_NAME)} does</h2>
        <p>${esc(APP_NAME)} is a scheduling and lead-capture platform for service businesses. A business sets up booking pages and forms, puts them on its website, and its customers use them to book a call, request a date, or build a quote. Every booking lands on the right person's calendar, and every half-finished form is still saved as a lead so nobody falls through the cracks.</p>
        <div class="home-grid">
          <div><h3>Booking pages</h3><p>Customers pick a time that is genuinely open. Calls can go to one person or be shared across a team by round robin.</p></div>
          <div><h3>Custom forms</h3><p>Any flow, from two questions behind a button to a full date check and booking, in the business's own look.</p></div>
          <div><h3>Quotes</h3><p>Customers build a price from the business's own catalog and ask for a contract or a call.</p></div>
          <div><h3>Reminders</h3><p>Emails and texts before and after each booking, written by the business.</p></div>
        </div>
        <h2>How ${esc(APP_NAME)} uses your calendar</h2>
        <p>When a team member connects their Google Calendar or Outlook calendar, ${esc(APP_NAME)} uses that connection for two things only:</p>
        <ul class="home-list">
          <li><b>Checking when you are busy.</b> ${esc(APP_NAME)} asks your calendar which times are taken, so customers are never offered a time you already have plans. For Google Calendar this is Google's free/busy service, which returns only start and end times, never what the events are.</li>
          <li><b>Adding bookings to your calendar.</b> When a customer books with you, ${esc(APP_NAME)} adds that booking to your calendar, and updates or removes it if the booking is moved or cancelled. It does not change or delete any other event.</li>
        </ul>
        <p>Calendar access is stored encrypted, is never sold or shared for advertising, and can be removed at any time from ${esc(APP_NAME)} or from your Google account. The details are in our <a href="/privacy">privacy policy</a>.</p>
      </section></main>${footer()}` }));
  });

  app.get('/privacy', (req, res) => res.html(legal('Privacy policy', `
    <p>${esc(APP_NAME)} ("we", "us") is a scheduling and lead-capture platform operated by ${esc(owner())}. This policy explains what information ${esc(APP_NAME)} collects, how it is used, and the choices you have. It applies to ${esc(APP_NAME)} at app.availvo.co, availvo.co and every booking page or form a business runs on ${esc(APP_NAME)}, including on its own domain.</p>

    <h2>Who this covers</h2>
    <p><b>Account holders</b> are the businesses and team members who sign in to ${esc(APP_NAME)}. <b>Customers</b> are the people who use a business's booking pages, forms or quotes. When you are a customer, the business you are booking with decides what it asks you and what it does with your answers; ${esc(APP_NAME)} stores and processes that information on the business's behalf.</p>

    <h2>Information we collect</h2>
    <ul>
      <li><b>Account information:</b> name, email address, phone number, time zone, and a password (stored only as a one-way hash).</li>
      <li><b>Business settings:</b> booking pages, hours, forms, prices and message templates the business creates.</li>
      <li><b>What customers enter:</b> name, email, phone, the answers to a business's questions, and the time they book. Forms save as you go, so answers are kept even if a form is not finished.</li>
      <li><b>Where a booking came from:</b> the address and title of the web page a booking form was embedded on.</li>
      <li><b>Connected calendar data</b>, described in the next section.</li>
      <li><b>Technical information:</b> a sign-in cookie for account holders, and your browser's local storage to keep a form's progress if you reload the page. We do not use advertising or tracking cookies.</li>
    </ul>

    <h2>Google Calendar and Outlook calendar data</h2>
    <p>An account holder can connect a Google Calendar or Microsoft Outlook calendar. When they do, they sign in with Google or Microsoft and approve the access below. ${esc(APP_NAME)} uses it only to provide the scheduling features that person set up.</p>
    <p><b>Google Calendar.</b> ${esc(APP_NAME)} requests these Google permissions:</p>
    <ul>
      <li><b>Your email address</b> (<code>openid</code>, <code>email</code>), to show which Google account is connected.</li>
      <li><b>Free/busy information</b> (<code>calendar.freebusy</code>), to find which times are already taken so customers are only offered open times. Google returns only the start and end of busy periods, not event titles, descriptions, locations or attendees.</li>
      <li><b>Creating and managing events</b> (<code>calendar.events</code>), to add a booking to your calendar when a customer books, and to update or remove that same event if the booking is rescheduled or cancelled. ${esc(APP_NAME)} only changes events it created. It does not read, change or delete your other events.</li>
    </ul>
    <p><b>Microsoft Outlook.</b> ${esc(APP_NAME)} reads the start, end, subject, all-day flag and free/busy status of events in the time range being booked, to decide which times are taken, and creates, updates and removes the events for its own bookings. Event subjects are used only to decide availability and to show the account holder why a time is blocked; they are not stored.</p>
    <p><b>How we store it.</b> The sign-in tokens Google and Microsoft issue are encrypted with AES-256-GCM before they are stored. Busy times are held in memory for a few minutes to keep pages fast and are not saved to our database.</p>
    <p><b>Limited use.</b> ${esc(APP_NAME)}'s use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements. In particular, Google user data is used only to provide and improve the scheduling features the user can see; it is not sold, not used for advertising, not used to build profiles, and not used to train artificial intelligence or machine learning models. No person at ${esc(APP_NAME)} reads Google user data, except with the user's permission, for security purposes such as investigating abuse, or where required by law.</p>
    <p><b>Removing access.</b> You can disconnect a calendar at any time on the Calendars screen in ${esc(APP_NAME)}; this deletes the stored tokens and, for Google, also revokes ${esc(APP_NAME)}'s access with Google. You can also remove access from your Google account at <a href="https://myaccount.google.com/permissions" rel="noopener">myaccount.google.com/permissions</a>, or from your Microsoft account.</p>

    <h2>How we use information</h2>
    <ul>
      <li>To run booking pages, forms and quotes, and put bookings on the right calendar.</li>
      <li>To send the emails and texts a business has set up: confirmations, reminders and follow-ups, and alerts to the business's own team.</li>
      <li>To show a business its own leads, bookings and reports.</li>
      <li>To keep ${esc(APP_NAME)} secure and working, and to answer support requests.</li>
    </ul>
    <p>We do not sell personal information, and we do not use it for advertising.</p>

    <h2>Text messages</h2>
    <p>Businesses may text customers who give a mobile number and agree to receive texts. Message and data rates may apply. Reply STOP to any message to stop receiving texts from that business, and START to receive them again. Phone numbers and text consent are never shared with third parties or affiliates for marketing.</p>

    <h2>Who we share information with</h2>
    <p>Only the service providers that make ${esc(APP_NAME)} work, each of which processes data on our behalf:</p>
    <ul>
      <li><b>Railway</b> hosts the application and its database in the United States.</li>
      <li><b>Resend</b> delivers email.</li>
      <li><b>Twilio</b> delivers text messages.</li>
      <li><b>Google</b> and <b>Microsoft</b>, for connected calendars, as described above.</li>
      <li>A business may connect its own tools, such as its CRM or a webhook. Information from that business's pages is then sent to those tools at the business's direction.</li>
    </ul>
    <p>We may also disclose information if required by law, or to protect the rights and safety of our users or the public.</p>

    <h2>How long we keep it</h2>
    <p>Account and business information is kept while the account is open. Customer submissions are kept for the business until it deletes them or closes its account. Calendar tokens are deleted as soon as the calendar is disconnected. When an account is closed, its data is deleted within 30 days, except where we must keep it longer by law.</p>

    <h2>Security</h2>
    <p>${esc(APP_NAME)} is served only over HTTPS. Passwords are hashed, calendar tokens and provider keys are encrypted at rest, and access to production systems is limited to the people who run ${esc(APP_NAME)}.</p>

    <h2>Your choices and rights</h2>
    <p>You can see and update your account details in ${esc(APP_NAME)}, disconnect calendars at any time, and ask us to export or delete your information by writing to <a href="mailto:${esc(support())}">${esc(support())}</a>. If you are a customer of a business on ${esc(APP_NAME)}, you can also ask that business directly. Depending on where you live, you may have further rights under laws such as the CCPA; we will honour them.</p>

    <h2>Children</h2>
    <p>${esc(APP_NAME)} is not intended for children under 13, and we do not knowingly collect their information.</p>

    <h2>Changes</h2>
    <p>If this policy changes, we will update the date above, and for significant changes we will tell account holders by email before the change takes effect.</p>

    <h2>Contact</h2>
    <p>${esc(owner())}<br><a href="mailto:${esc(support())}">${esc(support())}</a></p>`)));

  app.get('/terms', (req, res) => res.html(legal('Terms of service', `
    <p>These terms apply to anyone who creates an account on ${esc(APP_NAME)}, which is operated by ${esc(owner())}. By creating an account or using ${esc(APP_NAME)}, you agree to them.</p>
    <h2>Your account</h2>
    <p>Keep your sign-in details private and tell us at <a href="mailto:${esc(support())}">${esc(support())}</a> if you think someone else has used your account. You are responsible for what happens under your account and for the people you invite to your business.</p>
    <h2>Your content and your customers</h2>
    <p>You own the content you put into ${esc(APP_NAME)} and the information your customers submit. You give us permission to store and process it only to run ${esc(APP_NAME)} for you. You are responsible for having the right to collect your customers' information, for the messages you send them, and for getting consent before texting anyone.</p>
    <h2>Acceptable use</h2>
    <p>Do not use ${esc(APP_NAME)} to send spam, to collect information under false pretences, to impersonate anyone, or for anything unlawful. Do not try to break, overload or get around the security of ${esc(APP_NAME)}. We may suspend accounts that do.</p>
    <h2>Connected services</h2>
    <p>When you connect Google, Microsoft or another service, your use of that service is also governed by its own terms. You can disconnect it at any time. How we use calendar data is set out in our <a href="/privacy">privacy policy</a>.</p>
    <h2>Availability and changes</h2>
    <p>We work to keep ${esc(APP_NAME)} running and accurate, but it is provided "as is", without warranties of any kind. Always confirm important bookings with your customers. We may change or improve features over time and will give notice of significant changes.</p>
    <h2>Liability</h2>
    <p>To the extent the law allows, ${esc(owner())} is not liable for indirect or consequential losses, such as lost bookings or lost profits, arising from your use of ${esc(APP_NAME)}.</p>
    <h2>Ending your account</h2>
    <p>You can stop using ${esc(APP_NAME)} and ask us to close your account at any time. We may close accounts that break these terms.</p>
    <h2>Governing law</h2>
    <p>These terms are governed by the laws of the State of Texas.</p>
    <h2>Contact</h2>
    <p>${esc(owner())}<br><a href="mailto:${esc(support())}">${esc(support())}</a></p>`)));
};
