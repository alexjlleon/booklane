'use strict';
const db = require('../db');
const { esc } = require('./util');

const FROM = process.env.EMAIL_FROM || 'Booklane <onboarding@resend.dev>';

async function sendEmail({ to, subject, html, text, attachments, replyTo, businessId, fromName }) {
  const recipients = [].concat(to || []).map((s) => String(s).trim()).filter(Boolean);
  if (!recipients.length) return { status: 'skipped' };
  let status = 'logged', provider = 'log', error = null;
  const key = process.env.RESEND_API_KEY;
  if (key) {
    provider = 'resend';
    try {
      let from = FROM;
      if (fromName) { const addr = (FROM.match(/<([^>]+)>/) || [null, FROM])[1]; from = `${fromName.replace(/[<>"]/g, '')} <${addr}>`; }
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from, to: recipients, subject, html, text, reply_to: replyTo || undefined,
          attachments: (attachments || []).map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) status = 'sent';
      else { status = 'failed'; error = (await r.text()).slice(0, 500); }
    } catch (e) { status = 'failed'; error = String(e.message || e); }
  } else if (process.env.NODE_ENV !== 'test') {
    console.log(`[email:log] to=${recipients.join(',')} subject="${subject}"`);
  }
  db.run('INSERT INTO email_log (business_id, to_addr, subject, html, status, provider, error) VALUES (?,?,?,?,?,?,?)',
    businessId || null, recipients.join(', '), subject, html, status, provider, error);
  if (error) console.warn('[email] failed:', error);
  return { status, error };
}

function layout(business, { heading, body, cta, footer }) {
  const color = business?.brand_color || '#6d4aff';
  return `<!doctype html><html><body style="margin:0;background:#f4f3f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1b26">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden" cellpadding="0" cellspacing="0">
<tr><td style="background:${esc(color)};padding:18px 28px;color:#fff;font-weight:700;font-size:16px">${esc(business?.name || 'Booklane')}</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.3">${esc(heading)}</h1>
<div style="font-size:15px;line-height:1.6;color:#3b3848">${body}</div>
${cta ? `<p style="margin:26px 0 6px"><a href="${esc(cta.url)}" style="background:${esc(color)};color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">${esc(cta.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px;background:#faf9fc;color:#8a8697;font-size:12px">${footer || esc([business?.phone, business?.email, business?.website].filter(Boolean).join(' · '))}</td></tr>
</table></td></tr></table></body></html>`;
}

function rows(pairs) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:10px 0">${pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<tr><td style="padding:7px 0;color:#8a8697;width:38%;vertical-align:top;border-bottom:1px solid #eeecf3">${esc(k)}</td><td style="padding:7px 0;vertical-align:top;border-bottom:1px solid #eeecf3">${esc(v)}</td></tr>`)
    .join('')}</table>`;
}

module.exports = { sendEmail, layout, rows };
