/* The Stripe, Twilio and Resend cards on the Integrations tab.
   Secrets are never sent to this page: a saved key arrives as a masked tail, and leaving the mask
   in place on save means "leave it alone". */
(function () {
  'use strict';
  const { esc, api, $, $$ } = A;

  const FIELD_HELP = {
    STRIPE_SECRET_KEY: 'Stripe dashboard → Developers → API keys → Secret key. Starts sk_test_ or sk_live_.',
    STRIPE_WEBHOOK_SECRET: 'From the webhook you add below. Starts whsec_.',
    TWILIO_ACCOUNT_SID: 'Twilio console home. Starts AC.',
    TWILIO_AUTH_TOKEN: 'Next to the Account SID in the Twilio console.',
    TWILIO_FROM_NUMBER: 'The Twilio number texts come from, e.g. +18325550123.',
    TWILIO_MESSAGING_SERVICE_SID: 'Optional. Use instead of a single number if you have a Messaging Service. Starts MG.',
    RESEND_API_KEY: 'Resend dashboard → API Keys. Starts re_.',
    EMAIL_FROM: 'How emails appear, e.g. Weddings Unlimited <hello@weddingsunlimited.com>. The domain must be verified in Resend.',
    SQUARE_ACCESS_TOKEN: 'Square Developer console → your application → Credentials → Access token. Use the Production token to take real money.',
    SQUARE_LOCATION_ID: 'Square Developer console → Locations. Payments are taken against this location.',
    SQUARE_WEBHOOK_SIGNATURE_KEY: 'From the webhook subscription you add below, not the API key.',
    SQUARE_ENVIRONMENT: 'production or sandbox. Sandbox takes fake cards, for testing the flow.',
  };

  // Rendered into a placeholder on the existing Integrations tab.
  A.renderProviders = async function renderProviders(host) {
    if (!host) return;
    host.innerHTML = '<div class="panel"><div class="empty-state"><span class="spinner"></span></div></div>';
    let s;
    try {
      s = await api('GET', '/integrations/providers');
    } catch (e) {
      host.innerHTML = `<div class="panel"><div class="empty-state"><h3>Could not load integrations</h3><p>${esc(e.message)}</p></div></div>`;
      return;
    }
    A.cache.providers = s;
    // Card payments first, with the choice of provider above them, then the rest.
    host.innerHTML = paymentChoice(s) + ['stripe', 'square', 'twilio', 'resend'].map((p) => card(s[p], s.mask)).join('');
    wire(host);
  };

  /**
   * Which provider this business takes cards through.
   *
   * Two businesses on this install can use different ones, and each supplies its own keys, so
   * nothing here is shared. The choice is only offered once something is actually set up.
   */
  function paymentChoice(s) {
    const pay = s.payments || {};
    const ready = { stripe: s.stripe.ready, square: s.square.ready };
    const options = ['stripe', 'square'];
    const current = pay.chosen || pay.effective || '';
    return `<div class="panel">
      <div class="row between"><h2 style="font-size:16px;font-weight:800">Card payments</h2>
        ${pay.ready ? `<span class="pill booked">Taking payments through ${esc(s[pay.effective] ? s[pay.effective].name : pay.effective)}</span>` : '<span class="pill lost">Not taking payments yet</span>'}</div>
      <p class="desc">Pick one. Each business on this install connects its own account, so your keys are yours alone.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        ${options.map((p) => `<label class="opt radio${current === p ? ' is-on' : ''}" style="flex:1;min-width:200px">
          <input type="radio" name="payprovider" value="${p}" data-payprovider ${current === p ? 'checked' : ''}>
          <span class="tick"></span>
          <span class="opt-stack"><span>${esc(s[p].name)}</span>
          <span class="opt-hint">${ready[p] ? 'Ready' : 'Needs its keys below'}</span></span>
        </label>`).join('')}
      </div>
      ${current && !ready[current] ? `<div class="help" style="margin-top:8px">${esc(s[current].name)} is chosen but not finished: ${esc((s[current].missing || []).join(', '))}.</div>` : ''}
    </div>`;
  }

  function stateBadge(p) {
    if (p.ready) return '<span class="pill booked">Connected</span>';
    if (p.fields.some((f) => f.set)) return '<span class="pill partial">Partly set up</span>';
    return '<span class="pill lost">Not set up</span>';
  }

  function activityLine(p) {
    const a = p.activity || {};
    if (p.provider === 'stripe') {
      return `${a.paid_orders || 0} paid order${a.paid_orders === 1 ? '' : 's'} · ${A.money(a.paid_total || 0)} taken · ${p.webhook.received || 0} webhook event${p.webhook.received === 1 ? '' : 's'} received`
        + (a.stuck ? ` · <span style="color:#c0392b">${a.stuck} paid but not booked</span>` : '');
    }
    if (p.provider === 'square') {
      return `${a.paid_orders || 0} paid order${a.paid_orders === 1 ? '' : 's'} · ${A.money(a.paid_total || 0)} taken · ${p.webhook.received || 0} webhook event${p.webhook.received === 1 ? '' : 's'} received`;
    }
    if (p.provider === 'twilio') {
      return `${a.sent_7d || 0} text${a.sent_7d === 1 ? '' : 's'} in 7 days · ${a.segments_7d || 0} segment${a.segments_7d === 1 ? '' : 's'} · ${a.optouts || 0} opted out`
        + (a.failed_7d ? ` · <span style="color:#c0392b">${a.failed_7d} failed</span>` : '');
    }
    return `${a.sent_7d || 0} email${a.sent_7d === 1 ? '' : 's'} sent in 7 days`
      + (a.failed_7d ? ` · <span style="color:#c0392b">${a.failed_7d} failed</span>` : '')
      + (a.logged_only_7d ? ` · <span style="color:#b7791f">${a.logged_only_7d} only written to the log, not sent</span>` : '');
  }

  function field(f, mask) {
    const help = FIELD_HELP[f.key] || '';
    const fromEnv = f.source === 'env';
    const value = f.secret ? '' : (f.set ? String(f.hint || '') : '');
    return `<div class="field">
      <label>${esc(f.label)} ${fromEnv ? '<span class="pill" title="Set as an environment variable in Railway">from Railway</span>' : ''}</label>
      <input class="input" data-key="${esc(f.key)}" type="${f.secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false"
        value="${esc(value)}" placeholder="${f.secret && f.set ? esc(mask) : ''}">
      <div class="help">${f.secret && f.set ? `Saved as <code class="code">${esc(f.hint)}</code>. Leave blank to keep it. ` : ''}${esc(help)}</div>
    </div>`;
  }

  function card(p, mask) {
    const missing = p.missing.length
      ? `<div class="small" style="color:#b7791f;margin-bottom:10px">Still needed: <b>${p.missing.map(esc).join('</b>, <b>')}</b></div>` : '';
    const webhook = p.webhook ? `<div class="field"><label>Webhook URL</label>
        <div class="copy-row"><code class="code" style="flex:1;overflow:auto">${esc(p.webhook.url)}</code>
        <button type="button" class="btn btn-ghost btn-sm" data-copy="${esc(p.webhook.url)}">Copy</button></div>
        <div class="help">${p.webhook.events
    ? `Add this in Stripe → Developers → Webhooks, subscribed to <b>${p.webhook.events.map(esc).join('</b>, <b>')}</b>, then paste its signing secret above.`
    : esc(p.webhook.label || '')}</div></div>` : '';

    const lastTest = p.provider === 'stripe' && p.last_test ? `<div class="${p.last_test.status === 'webhook_received' ? 'ok-box' : 'panel warn-box'}" style="padding:10px 12px;margin-bottom:12px">
        <div class="small">${p.last_test.status === 'webhook_received'
    ? `<b>Last connection test passed.</b> $${Number(p.last_test.amount || 0).toFixed(2)} in ${esc(p.last_test.mode || '')} mode, and the webhook came back. Refund it in Stripe when you are ready.`
    : `<b>Connection test started but the webhook has not come back.</b> Started ${esc(A.ago(p.last_test.started_at))} by ${esc(p.last_test.started_by || '')}. If you completed the payment and this has not changed, the webhook is not reaching us.`}</div></div>` : '';

    const testRow = p.provider === 'stripe'
      ? `<div class="row" style="gap:8px;flex-wrap:wrap">
          <button type="button" class="btn btn-ghost" data-check="${p.provider}">Check connection</button>
          <button type="button" class="btn btn-ghost" data-charge="1" ${p.ready ? '' : 'disabled title="Save both keys first"'}>Run a $1 end-to-end test</button>
        </div>`
      : `<div class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
          <button type="button" class="btn btn-ghost" data-check="${p.provider}">Check connection</button>
          <div class="field" style="flex:1;min-width:200px;margin:0"><label>Send a test to</label>
            <input class="input" data-testto="${p.provider}" placeholder="${p.provider === 'twilio' ? 'your mobile number' : 'you@example.com'}"></div>
          <button type="button" class="btn btn-ghost" data-sendtest="${p.provider}" ${p.ready ? '' : 'disabled title="Finish setting this up first"'}>Send test</button>
        </div>`;

    return `<div class="panel" data-provider="${p.provider}">
      <div class="panel-head"><div><h2>${esc(p.name)} ${stateBadge(p)}</h2><p class="desc" style="margin:0">${esc(p.what)}</p></div></div>
      ${missing}
      ${lastTest}
      ${p.note ? `<div class="small muted" style="margin-bottom:12px">${esc(p.note)}</div>` : ''}
      <div class="stack">${p.fields.map((f) => field(f, mask)).join('')}${webhook}</div>
      <div class="row between" style="margin-top:14px">
        <div class="small muted">${activityLine(p)}</div>
        <button type="button" class="btn btn-primary btn-sm" data-save="${p.provider}">Save ${esc(p.name)} keys</button>
      </div>
      <hr>
      ${testRow}
      <div class="small" data-result="${p.provider}" style="margin-top:10px"></div>
    </div>`;
  }

  function wire(host) {
    const resultBox = (provider) => $(`[data-result="${provider}"]`, host);
    const show = (provider, ok, message, extra) => {
      const box = resultBox(provider);
      if (!box) return;
      box.innerHTML = `<div class="${ok ? 'ok-box' : 'panel warn-box'}" style="padding:10px 12px"><div class="small">${ok ? '' : '<b>Not working: </b>'}${esc(message)}</div>${extra || ''}</div>`;
    };

    // Switching provider is its own tiny save, so it takes effect without touching any key.
    host.addEventListener('change', async (e) => {
      const pick = e.target.closest('[data-payprovider]');
      if (!pick || !pick.checked) return;
      try {
        await A.guard(() => api('PUT', '/integrations/providers/payments', { PAYMENT_PROVIDER: pick.value }), null);
        A.toast(`Card payments set to ${pick.value === 'square' ? 'Square' : 'Stripe'}`);
        await A.renderProviders(host);
      } catch (err) { /* toast already shown */ }
    });

    host.addEventListener('click', async (e) => {
      const save = e.target.closest('[data-save]');
      if (save) {
        const provider = save.dataset.save;
        const panel = save.closest('[data-provider]');
        const body = {};
        for (const input of $$('[data-key]', panel)) {
          // Blank on a secret that is already saved means "leave it alone".
          const existing = (A.cache.providers[provider].fields.find((f) => f.key === input.dataset.key) || {});
          if (input.value === '' && existing.secret && existing.set) continue;
          body[input.dataset.key] = input.value;
        }
        save.disabled = true;
        try {
          const r = await A.guard(() => api('PUT', `/integrations/providers/${provider}`, body), r2 => null);
          A.toast(r.changed.length ? `Saved: ${r.changed.join(', ')}` : 'Nothing changed');
          await A.renderProviders(host);
        } catch (err) { /* toast already shown */ } finally { save.disabled = false; }
        return;
      }

      const check = e.target.closest('[data-check]');
      if (check) {
        const provider = check.dataset.check;
        check.disabled = true;
        resultBox(provider).innerHTML = '<span class="spinner"></span>';
        try {
          const r = await api('POST', `/integrations/providers/${provider}/check`, {});
          const details = r.details ? `<div class="small muted" style="margin-top:6px">${Object.entries(r.details).map(([k, v]) => `${esc(A.label(k))}: <b>${esc(String(v))}</b>`).join(' · ')}</div>` : '';
          const warn = r.warning ? `<div class="small" style="color:#b7791f;margin-top:6px"><b>Worth knowing: </b>${esc(r.warning)}</div>` : '';
          show(provider, r.ok, r.message, details + warn);
        } catch (err) { show(provider, false, err.message); } finally { check.disabled = false; }
        return;
      }

      const send = e.target.closest('[data-sendtest]');
      if (send) {
        const provider = send.dataset.sendtest;
        const to = ($(`[data-testto="${provider}"]`, host) || {}).value || '';
        send.disabled = true;
        try {
          const r = await api('POST', `/integrations/providers/${provider}/send-test`, { to });
          show(provider, true, `Sent to ${r.to}.${r.segments ? ` ${r.segments} segment${r.segments === 1 ? '' : 's'}.` : ''} Nothing went to any customer.`);
        } catch (err) { show(provider, false, err.message); } finally { send.disabled = false; }
        return;
      }

      if (e.target.closest('[data-charge]')) {
        const typed = prompt('This puts a REAL charge on a REAL card — yours.\n\nIt opens a $1 Stripe checkout for you to pay, then checks that the webhook comes back. Refund it in Stripe afterwards.\n\nType CHARGE to continue:');
        if (!typed) return;
        try {
          const r = await api('POST', '/integrations/stripe/test-charge', { confirm: typed, amount_cents: 100 });
          show('stripe', true, `Opening a $${r.amount.toFixed(2)} checkout in a new tab. Pay it, then come back and reload this page to see whether the webhook arrived.`);
          window.open(r.url, '_blank', 'noopener');
        } catch (err) { show('stripe', false, err.message); }
      }
    });
  }
})();
