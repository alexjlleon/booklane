/* Buy a product outright: pick your options, add anything extra, pay. The design call comes after
   the money, on the return page, because there is no slot to hold while you check out.

   Every figure on this page is confirmed by the server before it is shown as a total, so what a
   customer reads is what they will be charged even if the page has been tampered with. */
(function () {
  'use strict';
  const { esc, api, icons, $, $$ } = BL;
  const D = BL.data, biz = D.business, prod = D.product;
  const params = new URLSearchParams(location.search);
  const storeKey = `prod:${biz.slug}:${prod.slug}`;
  const C = prod.copy;

  const st = {
    i: 0,
    options: {},                 // groupId -> choiceId
    addons: {},                  // addonId -> qty
    qty: prod.default_qty,
    contact: { first_name: '', last_name: '', email: '', phone: '' },
    quote: null,                 // the server's own pricing of the current selection
    quoting: false,
    leadToken: null,
    busy: false,
    error: null,
    saveState: '',
  };
  const app = document.getElementById('app');

  // ---------- which groups are live right now ----------
  // A group with applies_to only shows once one of those choices is picked, which is how the cover
  // choice belongs to the 10x10 and not the 8x8.
  const chosenIds = () => new Set(Object.values(st.options).filter(Boolean).map(String));
  function liveGroups() {
    const picked = chosenIds();
    return prod.option_groups.filter((g) => !g.applies_to.length || g.applies_to.some((id) => picked.has(String(id))));
  }
  const groupsDone = () => liveGroups().every((g) => !g.required || st.options[g.id]);

  function stepList() {
    const out = ['choose'];
    if (prod.addons.length) out.push('extras');
    out.push('contact', 'pay');
    return out;
  }
  const steps = () => stepList();
  const cur = () => steps()[st.i];
  const isLast = () => st.i === steps().length - 1;

  const HEADS = {
    choose: () => ({ title: C.choose_label, sub: '' }),
    extras: () => ({ title: C.addons_label, sub: C.addons_hint }),
    contact: () => ({ title: 'Where should we send it?', sub: 'Your confirmation and the link to book your design call.' }),
    pay: () => ({ title: 'Your order', sub: '' }),
  };

  const cents = (n) => `$${(n / 100).toFixed(2).replace(/\.00$/, '')}`;

  // Mirrors the server's rule matcher so each choice can show its price before it is picked. The
  // server prices the order again from its own table, so a wrong guess here can never be charged.
  function matchRule(rules, picks) {
    let best = null; let bestKeys = -1;
    for (const r of rules || []) {
      const when = r.when || {};
      const keys = Object.keys(when);
      if (keys.some((k) => String(picks[k] || '') !== String(when[k]))) continue;
      if (keys.length > bestKeys) { best = r; bestKeys = keys.length; }
    }
    return best;
  }
  const basePrice = (picks) => {
    if (!prod.price_rules.length) {
      return prod.base_cents + prod.option_groups.reduce((n, g) => {
        const ch = g.choices.find((c) => c.id === picks[g.id]);
        return n + (ch ? ch.price_cents : 0);
      }, 0);
    }
    const r = matchRule(prod.price_rules, picks);
    return r ? r.price_cents + prod.base_cents : null;
  };
  /**
   * What this choice would cost, given what they have picked so far.
   *
   * Before the whole combination is settled there is no single answer - an 8x8 is $166 in a printed
   * cover and $298 in crystal - so show the cheapest it could be and say "from". Once the other
   * choices are in, exactly one rule survives and the figure becomes exact.
   */
  function choicePreview(g, ch) {
    const picks = Object.assign({}, st.options, { [g.id]: ch.id });
    if (!prod.price_rules.length) {
      const p = basePrice(picks);
      return p === null ? '' : cents(p);
    }
    const fits = prod.price_rules.filter((r) => Object.keys(r.when || {})
      .every((k) => picks[k] === undefined || String(picks[k]) === String(r.when[k])))
      .filter((r) => String((r.when || {})[g.id] || ch.id) === String(ch.id));
    if (!fits.length) return '';
    const prices = fits.map((r) => r.price_cents + prod.base_cents);
    const min = Math.min(...prices);
    return Math.max(...prices) === min ? cents(min) : `from ${cents(min)}`;
  }
  const addonUnit = (a) => {
    if (!(a.price_rules || []).length) return a.price_cents;
    const r = matchRule(a.price_rules, st.options);
    return r ? r.price_cents : null;
  };

  // ---------- lead capture, same as the other flows ----------
  const saver = BL.createSaver({
    url: () => (st.leadToken ? `/api/public/leads/${st.leadToken}` : null),
    onState: (s) => { st.saveState = s; const el = $('.save-state', app); if (el) el.className = `save-state ${s}`; },
  });
  let leadPromise = null;
  function ensureLead() {
    if (st.leadToken) return Promise.resolve(st.leadToken);
    if (!leadPromise) {
      leadPromise = api('POST', `/api/public/b/${biz.slug}/leads`, { source: 'booking', meta: Object.assign(BL.leadMeta(), { product: prod.slug }) })
        .then((r) => { st.leadToken = r.token; BL.store.set(storeKey, { token: r.token, at: Date.now() }); return r.token; })
        .catch(() => { leadPromise = null; return null; });
    }
    return leadPromise;
  }
  function capture(patch, now) { ensureLead().then((t) => t && saver.queue(Object.assign({ step_index: st.i, step_key: cur(), step_total: steps().length }, patch), now)); }

  // ---------- the server prices it, not us ----------
  let quoteSeq = 0;
  async function refreshQuote() {
    if (!groupsDone()) { st.quote = null; paint(); return; }
    const seq = ++quoteSeq;
    st.quoting = true; paint();
    try {
      const r = await api('POST', `/api/public/b/${biz.slug}/p/${prod.slug}/quote`, { selection: selection() });
      if (seq !== quoteSeq) return;
      st.quote = r; st.error = null;
    } catch (e) {
      if (seq !== quoteSeq) return;
      st.quote = null;
      if (e.status !== 422) st.error = e.message || 'Could not price that just now.';
    } finally {
      if (seq === quoteSeq) { st.quoting = false; paint(); }
    }
  }
  const selection = () => ({ options: st.options, addons: st.addons, qty: st.qty });

  // ---------- pieces ----------
  function side() {
    const q = st.quote;
    return `<aside class="booker-side">
      <div class="biz">${BL.logo(biz)}<div class="biz-name">${esc(biz.name)}</div></div>
      <div><h1 class="event-title">${esc(prod.name)}</h1>${prod.description ? `<p class="muted desc" style="margin:8px 0 0">${esc(prod.description)}</p>` : ''}</div>
      ${q ? `<div class="cart-side">${q.lines.map((l) => `
        <div class="cart-line"><span>${esc(l.label)}${l.qty > 1 ? ` <span class="muted">x${l.qty}</span>` : ''}${l.detail ? `<span class="cart-detail">${esc(l.detail)}</span>` : ''}</span><span>${esc(cents(l.line_cents))}</span></div>`).join('')}
        <div class="cart-line cart-total"><span>Total</span><span>${esc(cents(q.total_cents))}</span></div></div>` : ''}
      ${prod.schedules_after ? `<div class="meta-list"><div>${icons.cal}Design call booked after payment</div></div>` : ''}
      <ul class="trust">${(biz.settings.trust_points || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </aside>`;
  }

  const field = (name, label, input, required) =>
    `<div class="field"><label for="f-${name}">${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>${input}</div>`;

  const dims = (label) => {
    const m = String(label).match(/(\d+)\s*[x\u00d7]\s*(\d+)/i);
    if (!m) return null;
    let w = Number(m[1]); let h = Number(m[2]);
    // Zno writes "(Landscape) 8x11", meaning the 11 is the width. Trust the word over the order,
    // or a landscape album gets drawn standing up.
    const wide = /landscape/i.test(label); const tall = /portrait/i.test(label);
    if ((wide && h > w) || (tall && w > h)) { const t = w; w = h; h = t; }
    return { w, h };
  };

  /**
   * Until there are real photographs, draw the album. Shapes are scaled against the largest in the
   * group, so a 12x12 is visibly bigger than an 8x8 rather than just differently worded - which is
   * the one thing a size list on its own never manages to convey.
   */
  function shapeFor(label, biggest) {
    const d = dims(label);
    if (!d) return `<span class="pick-blank">${esc(label)}</span>`;
    const long = Math.max(d.w, d.h);
    const px = 34 + 44 * (biggest ? long / biggest : 1);
    return `<span class="pick-blank"><span class="pick-shape" style="width:${Math.round((d.w / long) * px)}px;height:${Math.round((d.h / long) * px)}px"></span></span>`;
  }

  function choiceHtml(g, ch) {
    const on = st.options[g.id] === ch.id;
    const price = choicePreview(g, ch);
    const input = `<input type="radio" name="g-${esc(g.id)}" value="${esc(ch.id)}" data-opt="${esc(g.id)}"${on ? ' checked' : ''}>`;
    if (g.layout === 'cards' || g.layout === 'swatches') {
      const biggest = Math.max(...g.choices.map((c) => { const d = dims(c.label); return d ? Math.max(d.w, d.h) : 0; }), 0);
      // A swatch with no picture says nothing useful, and repeating the label inside the tile just
      // prints it twice. Leave it empty until there is a real photograph of the material.
      const media = ch.image_url
        ? `<img src="${esc(ch.image_url)}" alt="" loading="lazy">`
        : (g.layout === 'swatches' ? '' : shapeFor(ch.label, biggest));
      return `<label class="pick pick-${esc(g.layout)}${on ? ' is-on' : ''}${!ch.image_url && g.layout === 'swatches' ? ' no-media' : ''}">
        ${input}
        <span class="pick-media">${media}</span>
        <span class="pick-body">
          <span class="pick-label">${esc(ch.label)}</span>
          ${ch.hint ? `<span class="opt-hint">${esc(ch.hint)}</span>` : ''}
          ${price ? `<span class="pick-price">${esc(price)}</span>` : ''}
        </span>
      </label>`;
    }
    return `<label class="opt radio${on ? ' is-on' : ''}">
      ${input}
      <span class="tick"></span>
      <span class="opt-stack"><span>${esc(ch.label)}</span>${ch.hint ? `<span class="opt-hint">${esc(ch.hint)}</span>` : ''}</span>
      ${price ? `<span class="opt-price">${esc(price)}</span>` : (ch.price_cents > 0 ? `<span class="opt-price">${esc(cents(ch.price_cents))}</span>` : '')}
    </label>`;
  }

  function renderChoose() {
    const groups = liveGroups();
    return groups.map((g) => `
      <div class="opt-group" data-group="${esc(g.id)}">
        ${groups.length > 1 ? `<h3 class="opt-group-title">${esc(g.label)}</h3>` : ''}
        ${g.hint ? `<p class="muted" style="margin:-2px 0 10px;font-size:14px">${esc(g.hint)}</p>` : ''}
        <div class="${g.layout === 'cards' ? 'pick-grid' : g.layout === 'swatches' ? 'pick-grid swatches' : 'options'}">${g.choices.map((ch) => choiceHtml(g, ch)).join('')}</div>
      </div>`).join('')
      + (prod.max_qty > 1 ? `
      <div class="field qty-field">
        <label for="f-qty">${esc(C.qty_label)}</label>
        <input class="input" id="f-qty" type="number" min="${prod.min_qty}" max="${prod.max_qty}" step="1" value="${esc(st.qty)}" data-qty>
      </div>` : '');
  }

  function stepperHtml(a) {
    const n = Number(st.addons[a.id] || 0);
    const unit = addonUnit(a);
    const pages = prod.base_pages ? prod.base_pages + n * 2 : 0;
    return `<div class="stepper-row">
      <div class="stepper-head">
        <div><b>${esc(a.label)}</b>${a.hint ? `<div class="opt-hint">${esc(a.hint)}</div>` : ''}</div>
        <div class="stepper-price">${unit === null ? '<span class="muted">choose your album first</span>' : `${esc(cents(unit))} ${esc(a.unit_label || 'each')}`}</div>
      </div>
      <div class="stepper">
        <button type="button" class="btn btn-ghost stepper-btn" data-step="${esc(a.id)}:-1" aria-label="Fewer" ${n <= 0 ? 'disabled' : ''}>&minus;</button>
        <input class="input stepper-input" type="number" min="0" max="${a.max_qty}" step="1" value="${n}" data-addon-qty="${esc(a.id)}" aria-label="${esc(a.label)}">
        <button type="button" class="btn btn-ghost stepper-btn" data-step="${esc(a.id)}:1" aria-label="More" ${n >= a.max_qty ? 'disabled' : ''}>+</button>
        ${pages ? `<span class="stepper-note">${esc(pages)} pages in total</span>` : ''}
      </div>
    </div>`;
  }

  function renderExtras() {
    const steppers = prod.addons.filter((a) => a.ui === 'stepper');
    const checks = prod.addons.filter((a) => a.ui !== 'stepper');
    return `${steppers.map(stepperHtml).join('')}
    ${checks.length ? `<div class="options list">${checks.map((a) => {
      const n = Number(st.addons[a.id] || 0);
      return `<div class="opt check${n > 0 ? ' is-on' : ''}">
        <label class="opt-main">
          <input type="checkbox" data-addon="${esc(a.id)}"${n > 0 ? ' checked' : ''}>
          <span class="tick"></span>
          <span class="opt-stack"><span>${esc(a.label)}</span>${a.hint ? `<span class="opt-hint">${esc(a.hint)}</span>` : ''}</span>
        </label>
        <span class="opt-right">
          ${a.max_qty > 1 && n > 0 ? `<input class="input input-qty" type="number" min="1" max="${a.max_qty}" step="1" value="${n}" data-addon-qty="${esc(a.id)}" aria-label="How many ${esc(a.label)}">` : ''}
          <span class="opt-price">${a.price_cents > 0 ? esc(cents(a.price_cents)) : 'Included'}</span>
        </span>
      </div>`;
    }).join('')}</div>` : ''}`;
  }

  function renderContact() {
    return `<form class="step-form" novalidate>
      <div class="grid-2">
        ${field('first_name', 'First name', `<input class="input" id="f-first_name" name="first_name" data-contact value="${esc(st.contact.first_name)}" autocomplete="given-name">`, true)}
        ${field('last_name', 'Last name', `<input class="input" id="f-last_name" name="last_name" data-contact value="${esc(st.contact.last_name)}" autocomplete="family-name">`, false)}
      </div>
      ${field('email', 'Email', `<input class="input" id="f-email" name="email" type="email" data-contact value="${esc(st.contact.email)}" autocomplete="email" inputmode="email">`, true)}
      ${field('phone', 'Mobile', `<input class="input" id="f-phone" name="phone" type="tel" data-contact value="${esc(st.contact.phone)}" autocomplete="tel" inputmode="tel">`, false)}
      ${biz.settings.privacy_note ? `<p class="muted small" style="margin-top:14px">${esc(biz.settings.privacy_note)}</p>` : ''}
    </form>`;
  }

  function renderPay() {
    const q = st.quote;
    if (!q) return `<p class="muted">${st.quoting ? 'Working out your total…' : 'Go back and choose your options.'}</p>`;
    return `<div class="price-panel">
      <div class="cart">${q.lines.map((l) => `
        <div class="cart-line"><span>${esc(l.label)}${l.detail ? `<span class="cart-detail">${esc(l.detail)}</span>` : ''}${l.qty > 1 ? ` <span class="muted">x${l.qty} at ${esc(cents(l.unit_cents))}</span>` : ''}</span><span>${esc(cents(l.line_cents))}</span></div>`).join('')}
        <div class="cart-line cart-total"><span>Total</span><span>${esc(cents(q.total_cents))}</span></div>
      </div>
      ${prod.schedules_after ? `<p>${esc(C.paid_blurb)}</p>` : ''}
      ${!prod.payments_ready ? '<div class="form-error" role="alert">Card payments are not switched on yet. Please call us and we will take your order.</div>' : ''}
    </div>`;
  }

  function ctaLabel() {
    if (!isLast()) return 'Continue';
    return C.pay_cta || 'Pay';
  }

  function paint() {
    const sideEl = $('.booker-side', app);
    if (sideEl) sideEl.outerHTML = side();
    if (cur() === 'pay') { const b = $('.step-body', app); if (b) b.innerHTML = renderPay(); }
    const btn = $('[data-next]', app);
    if (btn) btn.disabled = st.busy || (cur() === 'pay' && (!st.quote || !prod.payments_ready));
  }

  function render() {
    const step = cur();
    const total = steps().length;
    const head = HEADS[step]();
    let body = '';
    if (step === 'choose') body = renderChoose();
    else if (step === 'extras') body = renderExtras();
    else if (step === 'contact') body = renderContact();
    else body = renderPay();

    app.innerHTML = `<div class="shell"><div class="card booker">${side()}
      <main class="booker-main">
        <div class="progress" aria-label="Step ${st.i + 1} of ${total}"><div class="progress-bar"><span style="width:${Math.round(((st.i + 1) / total) * 100)}%"></span></div><div class="progress-count">${st.i + 1} / ${total}</div></div>
        <div class="step-head"><h2>${esc(head.title || '')}</h2>${head.sub ? `<p>${esc(head.sub)}</p>` : ''}</div>
        ${st.error ? `<div class="form-error" role="alert">${esc(st.error)}</div>` : ''}
        <div class="step-body">${body}</div>
        <div class="step-nav">
          <div>${st.i > 0 ? `<button type="button" class="btn btn-link" data-back>${icons.left} Back</button>` : `<span class="save-state ${st.saveState}"></span>`}</div>
          ${st.i > 0 ? `<span class="save-state ${st.saveState}"></span>` : ''}
          <button type="button" class="btn btn-primary btn-lg" data-next ${st.busy ? 'disabled' : ''}>${st.busy ? '<span class="spinner"></span>' : ''}${esc(ctaLabel())} ${isLast() || st.busy ? '' : icons.right}</button>
        </div>
      </main></div></div>${BL.powered()}`;
    paint();
  }

  // ---------- validation + navigation ----------
  function validate() {
    const step = cur();
    if (step === 'choose') {
      const missing = liveGroups().find((g) => g.required && !st.options[g.id]);
      if (missing) return `Please choose ${String(missing.label || 'an option').toLowerCase()}.`;
      if (st.qty < prod.min_qty || st.qty > prod.max_qty) return `Choose between ${prod.min_qty} and ${prod.max_qty}.`;
    }
    if (step === 'contact') {
      const errs = {};
      if (!st.contact.first_name.trim()) errs.first_name = 'Required';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(st.contact.email.trim())) errs.email = 'Enter a valid email';
      if (Object.keys(errs).length) { BL.fieldErrors(app, errs); return 'Please fix the highlighted fields.'; }
    }
    if (step === 'pay' && !prod.payments_ready) return 'Card payments are not switched on yet. Please call us and we will take your order.';
    if (step === 'pay' && !st.quote) return 'Go back and choose your options.';
    return null;
  }

  async function go(dir) {
    st.error = null;
    if (dir > 0) {
      const problem = validate();
      if (problem) { st.error = problem; return render(); }
      if (isLast()) return submit();
      st.i += 1;
    } else {
      st.i = Math.max(0, st.i - 1);
    }
    capture({}, false);
    render();
    if (cur() === 'pay' && !st.quote) refreshQuote();
  }

  async function submit() {
    st.busy = true; render();
    try {
      const r = await api('POST', `/api/public/b/${biz.slug}/p/${prod.slug}/checkout`, {
        selection: selection(), contact: st.contact, lead_token: st.leadToken,
      });
      if (r && r.checkout_url) { location.href = r.checkout_url; return; }
      throw new Error('Could not start the payment.');
    } catch (e) {
      st.busy = false;
      st.error = e.message || 'Could not start the payment.';
      if (e.details) BL.fieldErrors(app, e.details);
      render();
    }
  }

  // ---------- events ----------
  app.addEventListener('click', (e) => {
    const step = e.target.closest('[data-step]');
    if (step) {
      e.preventDefault();
      const [id, delta] = step.dataset.step.split(':');
      const a = prod.addons.find((x) => x.id === id);
      const next = Math.max(0, Math.min(a ? a.max_qty : 0, Number(st.addons[id] || 0) + Number(delta)));
      if (next > 0) st.addons[id] = next; else delete st.addons[id];
      render();
      refreshQuote();
      return;
    }
    if (e.target.closest('[data-next]')) { e.preventDefault(); go(1); }
    else if (e.target.closest('[data-back]')) { e.preventDefault(); go(-1); }
  });
  app.addEventListener('submit', (e) => { e.preventDefault(); go(1); });

  function onInput(e) {
    const t = e.target;
    if (t.hasAttribute('data-opt')) {
      const gid = t.getAttribute('data-opt');
      st.options[gid] = t.value;
      // Drop any choice whose group no longer applies, so a cover picked for the 10x10 does not
      // linger when they switch to the 8x8.
      const live = new Set(liveGroups().map((g) => g.id));
      for (const k of Object.keys(st.options)) if (!live.has(k)) delete st.options[k];
      capture({ answers: { [gid]: t.value } }, true);
      render();
      refreshQuote();
    } else if (t.hasAttribute('data-qty')) {
      st.qty = Math.max(prod.min_qty, Math.min(prod.max_qty, parseInt(t.value, 10) || prod.min_qty));
      refreshQuote();
    } else if (t.hasAttribute('data-addon')) {
      const id = t.getAttribute('data-addon');
      if (t.checked) st.addons[id] = Math.max(1, Number(st.addons[id] || 1));
      else delete st.addons[id];
      render();
      refreshQuote();
    } else if (t.hasAttribute('data-addon-qty')) {
      const id = t.getAttribute('data-addon-qty');
      const a = prod.addons.find((x) => x.id === id);
      const min = a && a.ui === 'stepper' ? 0 : 1;
      const n = Math.max(min, Math.min(a ? a.max_qty : 1, parseInt(t.value, 10) || 0));
      if (n > 0) st.addons[id] = n; else delete st.addons[id];
      refreshQuote();
    } else if (t.hasAttribute('data-contact')) {
      st.contact[t.name] = t.value;
      const fl = t.closest('.field');
      if (fl && fl.classList.contains('has-error')) { fl.classList.remove('has-error'); const fe = $('.field-error', fl); if (fe) fe.remove(); }
      capture({ contact: { [t.name]: st.contact[t.name] } }, e.type === 'change');
    }
  }
  app.addEventListener('input', onInput);
  app.addEventListener('change', (e) => { if (e.target.type === 'checkbox' || e.target.type === 'radio' || e.target.tagName === 'SELECT' || e.target.type === 'number') onInput(e); });

  // ---------- boot ----------
  // A single unconditional group with one choice needs no asking.
  (function prefill() {
    for (const g of prod.option_groups) {
      if (!g.applies_to.length && g.choices.length === 1) st.options[g.id] = g.choices[0].id;
    }
    const want = params.get('option');
    if (want) {
      for (const g of prod.option_groups) {
        const hit = g.choices.find((c) => c.id === want);
        if (hit) st.options[g.id] = hit.id;
      }
    }
  })();

  if (D.cancelled) st.error = 'Your payment was cancelled, so nothing was charged. Your choices are still here.';
  render();
  if (groupsDone()) refreshQuote();
})();
