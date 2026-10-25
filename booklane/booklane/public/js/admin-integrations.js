/* The Twilio and Resend cards on the Integrations tab.
   Secrets are never sent to this page: a saved key arrives as a masked tail, and leaving the mask
   in place on save means "leave it alone". */
(function () {
  'use strict';
  const { esc, api, $, $$ } = A;

  const FIELD_HELP = {
    TWILIO_ACCOUNT_SID: 'Twilio console home. Starts AC.',
    TWILIO_AUTH_TOKEN: 'Next to the Account SID in the Twilio console.',
    TWILIO_FROM_NUMBER: 'The Twilio number texts come from, e.g. +18325550123.',
    TWILIO_MESSAGING_SERVICE_SID: 'Optional. Use instead of a single number if you have a Messaging Service. Starts MG.',
    RESEND_API_KEY: 'Resend dashboard → API Keys. Starts re_.',
    EMAIL_FROM: 'How emails appear, e.g. Weddings Unlimited <hello@weddingsunlimited.com>. The domain must be verified in Resend.',
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
    host.innerHTML = ['twilio', 'resend'].map((p) => card(s[p], s.mask)).join('');
    // The cards are redrawn after every save, but the host element stays the same. Attaching the
    // handlers again on each redraw made one click fire once per earlier save (four test emails
    // for one press), so they are attached once per host.
    if (!host.dataset.wired) { host.dataset.wired = '1'; wire(host); }
  };

  function stateBadge(p) {
    if (p.ready) return '<span class="pill booked">Connected</span>';
    if (p.fields.some((f) => f.set)) return '<span class="pill partial">Partly set up</span>';
    return '<span class="pill lost">Not set up</span>';
  }

  function activityLine(p) {
    const a = p.activity || {};
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
        <div class="help">${esc(p.webhook.label || '')}</div></div>` : '';

    const testRow = `<div class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
          <button type="button" class="btn btn-ghost" data-check="${p.provider}">Check connection</button>
          <div class="field" style="flex:1;min-width:200px;margin:0"><label>Send a test to</label>
            <input class="input" data-testto="${p.provider}" placeholder="${p.provider === 'twilio' ? 'your mobile number' : 'you@example.com'}"></div>
          <button type="button" class="btn btn-ghost" data-sendtest="${p.provider}" ${p.ready ? '' : 'disabled title="Finish setting this up first"'}>Send test</button>
        </div>`;

    return `<div class="panel" data-provider="${p.provider}">
      <div class="panel-head"><div><h2>${esc(p.name)} ${stateBadge(p)}</h2><p class="desc" style="margin:0">${esc(p.what)}</p></div></div>
      ${missing}
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
    });
  }
})();
