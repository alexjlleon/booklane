/* Admin: things people buy outright, like albums. A product is paid for first and scheduled after,
   which is why it lives here rather than under Sessions.

   Two editable lists do the work. Option groups are pick-one, and a choice can carry its own price,
   which is how the 8x8 and the 10x10 share a page. Add-ons are pick-any with a quantity. A group can
   be limited to "only when" a particular choice is picked, so the cover choice belongs to the 10x10. */
(function () {
  'use strict';
  const { esc, api, $, $$ } = A;

  const dollars = (cents) => (Number(cents || 0) / 100).toFixed(2);
  const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const stat = (k, v, s) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}</div><div class="s">${s}</div></div>`;

  A.route('/products', {
    title: 'Products',
    async render() {
      const [data, pay] = await Promise.all([api('GET', '/products'), api('GET', '/payments').catch(() => null)]);
      A.cache.products = data;
      const sold = data.products.reduce((n, p) => n + p.sold_count, 0);
      const cents = data.products.reduce((n, p) => n + p.sold_cents, 0);

      const banner = pay && pay.configured ? '' : `<div class="panel warn-box"><h2>Card payments are off</h2>
        <p class="desc">Nothing here can be bought until your Stripe keys are in. Add them under <a href="#/settings/integrations">Settings &rarr; Integrations</a>.</p></div>`;

      if (!data.products.length) {
        return `${banner}<div class="panel"><div class="empty-state">
          <h3>Nothing for sale yet</h3>
          <p>A product is something they pay for and then book a call about, like a photo album. Add the options they choose between, the extras they can add, and which booking page to offer once the money is in.</p>
          <button type="button" class="btn btn-primary" data-new>Add a product</button>
        </div></div>`;
      }

      return `${banner}
      <div class="row between" style="margin-bottom:16px">
        <div><h1 style="font-size:24px;font-weight:800">Products</h1><div class="small muted" style="margin-top:2px">Bought outright, then scheduled.</div></div>
        <button type="button" class="btn btn-primary" data-new>Add a product</button>
      </div>

      <div class="stats">
        ${stat('Sold', sold, sold ? `<a href="#/orders">view orders</a>` : 'no orders yet')}
        ${stat('Taken', A.money(cents / 100), 'across every product')}
        ${stat('Live', data.products.filter((p) => p.active).length, `of ${data.products.length}`)}
      </div>

      <div class="panel">
        <table class="table"><thead><tr><th>PRODUCT</th><th>FROM</th><th>OPTIONS</th><th>EXTRAS</th><th>AFTER PAYMENT</th><th>SOLD</th><th></th></tr></thead>
        <tbody>${data.products.map((p) => {
    const prices = [p.base_cents].concat(p.option_groups.flatMap((g) => g.choices.map((c) => p.base_cents + c.price_cents))).filter((n) => n > 0);
    const from = prices.length ? A.money(Math.min(...prices) / 100) : 'not priced yet';
    const after = p.followup_event_type_id ? (data.event_types.find((e) => e.id === p.followup_event_type_id) || {}).name || 'a booking page' : 'nothing scheduled';
    return `<tr${p.active ? '' : ' style="opacity:.55"'}>
          <td><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="pill lost">Off</span>'}<div class="small muted"><a href="${esc(p.url)}" target="_blank">${esc(p.url.replace(/^https?:\/\/[^/]+/, ''))}</a></div></td>
          <td>${esc(from)}</td>
          <td>${p.option_groups.length ? esc(p.option_groups.map((g) => `${g.label} (${g.choices.length})`).join(', ')) : '<span class="muted">none</span>'}</td>
          <td>${p.addons.length ? p.addons.length : '<span class="muted">none</span>'}</td>
          <td class="small">${esc(after)}</td>
          <td>${p.sold_count ? `${p.sold_count} · ${esc(A.money(p.sold_cents / 100))}` : ''}</td>
          <td class="row" style="gap:6px"><a class="btn btn-link btn-sm" href="${esc(p.url)}" target="_blank">View</a><button type="button" class="btn btn-link btn-sm" data-edit="${p.id}">Edit</button></td>
        </tr>`;
  }).join('')}</tbody></table>
      </div>`;
    },
    events(root) {
      const data = A.cache.products;
      root.addEventListener('click', (e) => {
        if (e.target.closest('[data-new]')) editProduct(null, data);
        const ed = e.target.closest('[data-edit]');
        if (ed) editProduct(data.products.find((p) => p.id === Number(ed.dataset.edit)), data);
      });
    },
  });

  // ---------------- the editor ----------------
  function editProduct(x, data) {
    // Local model, re-rendered on add/remove. Ids are generated here so a group can point at a
    // choice before either has been saved.
    const groups = JSON.parse(JSON.stringify(x ? x.option_groups : []));
    const addons = JSON.parse(JSON.stringify(x ? x.addons : []));
    const etOptions = Object.assign({ '': 'Nothing — just take the payment' },
      Object.fromEntries(data.event_types.map((e) => [e.id, e.name])));

    const allChoices = () => groups.flatMap((g, gi) => g.choices.map((c) => ({ gi, id: c.id, label: `${g.label || `Group ${gi + 1}`}: ${c.label || 'untitled'}` })));

    const groupHtml = (g, gi) => {
      const earlier = allChoices().filter((c) => c.gi < gi);
      return `<div class="panel sub" data-group-row="${gi}">
        <div class="row between"><b>Option group ${gi + 1}</b><button type="button" class="btn btn-link btn-sm" data-rm-group="${gi}">Remove</button></div>
        <div class="grid-2">
          ${A.field('What are they choosing?', `<input class="input" data-g-label="${gi}" value="${esc(g.label || '')}" placeholder="Album">`)}
          ${A.field('Hint (optional)', `<input class="input" data-g-hint="${gi}" value="${esc(g.hint || '')}">`)}
        </div>
        <label class="toggle"><input type="checkbox" data-g-req="${gi}" ${g.required === false ? '' : 'checked'}><span class="sw"></span><span>They must pick one</span></label>
        ${earlier.length ? `<div class="field"><label>Only show this group when</label>
          <div class="stack" style="gap:6px">${earlier.map((c) => `<label class="check"><input type="checkbox" data-g-gate="${gi}" value="${esc(c.id)}" ${(g.applies_to || []).includes(c.id) ? 'checked' : ''}><span>${esc(c.label)}</span></label>`).join('')}</div>
          <div class="help">Leave all unticked to always show it. Ticking the 10x10 is what makes the cover choice belong to that album only.</div></div>` : ''}
        ${A.field('Shown as', `<select class="select" data-g-layout="${gi}">${[['list', 'A list'], ['cards', 'Picture cards'], ['swatches', 'Small swatches']].map(([v, l]) => `<option value="${v}" ${(g.layout || 'list') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`,
    'Picture cards suit sizes. Swatches suit covers, where the material is the point.')}
        <div class="field"><label>Choices</label>
          <table class="table compact"><thead><tr><th>Label</th><th>Picture URL</th><th style="width:110px">Price</th><th></th></tr></thead><tbody>
          ${g.choices.map((c, ci) => `<tr>
            <td><input class="input" data-c-label="${gi}.${ci}" value="${esc(c.label || '')}" placeholder="8x8 Square"></td>
            <td><input class="input" data-c-img="${gi}.${ci}" value="${esc(c.image_url || '')}" placeholder="https://…"></td>
            <td><input class="input" type="number" step="0.01" min="0" data-c-price="${gi}.${ci}" value="${esc(dollars(c.price_cents))}"></td>
            <td><button type="button" class="btn btn-link btn-sm" data-rm-choice="${gi}.${ci}">&times;</button></td>
          </tr>`).join('')}
          </tbody></table>
          <button type="button" class="btn btn-ghost btn-sm" data-add-choice="${gi}">Add a choice</button>
          <div class="help">Leave Price at 0 when the price depends on a combination — set those in the price table below.</div>
        </div>
      </div>`;
    };

    const addonHtml = () => `<div class="field"><label>Custom features they can add</label>
      <table class="table compact"><thead><tr><th>Label</th><th style="width:110px">Price</th><th style="width:90px">Max</th><th></th></tr></thead><tbody>
      ${addons.map((a, i) => `<tr>
        <td><input class="input" data-a-label="${i}" value="${esc(a.label || '')}" placeholder="Extra spread (2 pages)"><input class="input" data-a-hint="${i}" value="${esc(a.hint || '')}" placeholder="Optional note" style="margin-top:5px;font-size:13px">
          <div class="row" style="gap:12px;margin-top:6px">
            <label class="check"><input type="checkbox" data-a-stepper="${i}" ${a.ui === 'stepper' ? 'checked' : ''}><span>Counter, not a tickbox</span></label>
            <label class="check"><input type="checkbox" data-a-per="${i}" ${a.per_unit ? 'checked' : ''}><span>One per copy</span></label>
            <input class="input" data-a-unit="${i}" value="${esc(a.unit_label || '')}" placeholder="per spread" style="width:130px;font-size:13px">
          </div>
          ${(a.price_rules || []).length ? `<div class="small muted" style="margin-top:6px">Priced by combination · ${(a.price_rules || []).length} rule${(a.price_rules || []).length === 1 ? '' : 's'}</div>` : ''}
        </td>
        <td><input class="input" type="number" step="0.01" min="0" data-a-price="${i}" value="${esc(dollars(a.price_cents))}" ${(a.price_rules || []).length ? 'disabled title="Set by the price table"' : ''}></td>
        <td><input class="input" type="number" step="1" min="1" max="200" data-a-max="${i}" value="${esc(a.max_qty || 1)}"></td>
        <td><button type="button" class="btn btn-link btn-sm" data-rm-addon="${i}">&times;</button></td>
      </tr>`).join('')}
      </tbody></table>
      <button type="button" class="btn btn-ghost btn-sm" data-add-addon>Add a custom feature</button>
      <div class="help">These appear after the options, each with its own quantity box when Max is above 1.</div></div>`;

    const body = () => `
      <div class="panel stack">
        ${A.field('Name', `<input class="input" data-bind="name" value="${esc(x ? x.name : '')}" placeholder="Photo Album">`)}
        ${A.field('What the customer reads', `<textarea class="textarea" data-bind="description" rows="3">${esc(x ? x.description : '')}</textarea>`)}
        ${A.field('Base price', `<input class="input" type="number" step="0.01" min="0" data-bind="base_price" data-type="number" value="${esc(dollars(x ? x.base_cents : 0))}">`,
    'Charged on top of whatever they choose. Leave it at 0 when the choices carry the whole price, which is how the albums work.')}
        <div class="grid-2">
          ${A.field('Smallest order', `<input class="input" type="number" min="1" max="100" data-bind="min_qty" data-type="number" value="${x ? x.min_qty : 1}">`)}
          ${A.field('Most they can order', `<input class="input" type="number" min="1" max="100" data-bind="max_qty" data-type="number" value="${x ? x.max_qty : 10}">`)}
        </div>
        ${A.field('Pages included in the base price', `<input class="input" type="number" min="0" max="500" step="2" data-bind="settings.base_pages" data-type="number" value="${esc((x && x.settings && x.settings.base_pages) || 0)}">`,
    'Shown on the counter so they can see the running page total. Leave 0 if it does not apply.')}
        ${A.field('Offer after payment', A.select('followup_event_type_id', x ? (x.followup_event_type_id || '') : '', etOptions),
    'The booking page they are sent to once the money is in. For albums this is the design call.')}
        ${x ? A.toggle('active', x.active, 'Live on the website') : ''}
      </div>
      <div id="groups">${groups.map(groupHtml).join('')}</div>
      <button type="button" class="btn btn-ghost btn-sm" data-add-group>Add an option group</button>
      <div class="panel sub" id="addons">${addonHtml()}</div>
      ${x ? `<div class="panel sub">
        <div class="row between"><b>Price table</b><span class="small muted">${(x.price_rules || []).length} combination${(x.price_rules || []).length === 1 ? '' : 's'} priced</span></div>
        <p class="help" style="margin:6px 0 10px">When the price depends on a combination — a size <i>and</i> a cover — paste it here instead of typing it. One line each: the choices, then the price. Tabs, commas and pipes all work, so a copy out of a spreadsheet lands as-is. Any label that isn't a choice yet gets added.</p>
        <textarea class="textarea" id="matrix-text" rows="6" placeholder="8x8 Square, Printed, 166&#10;8x8 Square, Velvet, 190&#10;8x11 Landscape, Suede, 240"></textarea>
        ${A.field('Applies to', `<select class="select" id="matrix-target"><option value="product">The product price</option>${addons.map((a) => `<option value="${esc(a.id)}">${esc(a.label || 'an extra')}</option>`).join('')}</select>`)}
        <button type="button" class="btn btn-ghost btn-sm" data-matrix>Load these prices</button>
        <div class="help">Saves straight away, separately from the rest of this form.</div>
      </div>` : '<div class="help" style="margin-top:12px">Create the product first, then you can paste a price table for combinations like size &times; cover.</div>'}`;

    const el = A.drawer(`<div class="drawer-head"><div><div class="small muted">Product</div><h2>${x ? esc(x.name) : 'New product'}</h2></div><button class="icon-x" data-close-drawer aria-label="Close">&times;</button></div>
    <form id="prod-form">
      <div id="prod-body">${body()}</div>
      <div class="row between" style="margin-top:16px">
        ${x ? '<button type="button" class="btn btn-danger" data-del>Delete</button>' : '<span></span>'}
        <div class="row"><button type="button" class="btn btn-ghost" data-close-drawer>Cancel</button>
        <button type="submit" class="btn btn-primary">${x ? 'Save product' : 'Create product'}</button></div>
      </div>
    </form>`, (el) => wire(el));

    // Read every row out of the DOM, so nothing is lost when the lists are re-rendered.
    function harvest(root) {
      $$('[data-group-row]', root).forEach((row) => {
        const gi = Number(row.dataset.groupRow);
        const g = groups[gi];
        if (!g) return;
        g.label = $(`[data-g-label="${gi}"]`, root).value;
        g.hint = $(`[data-g-hint="${gi}"]`, root).value;
        g.required = $(`[data-g-req="${gi}"]`, root).checked;
        const lay = $(`[data-g-layout="${gi}"]`, root);
        if (lay) g.layout = lay.value;
        g.applies_to = $$(`[data-g-gate="${gi}"]`, root).filter((c) => c.checked).map((c) => c.value);
        g.choices.forEach((c, ci) => {
          const lab = $(`[data-c-label="${gi}.${ci}"]`, root);
          const pr = $(`[data-c-price="${gi}.${ci}"]`, root);
          const img = $(`[data-c-img="${gi}.${ci}"]`, root);
          if (lab) { c.label = lab.value; if (!c.id) c.id = slug(c.label) || `choice-${ci + 1}`; }
          if (img) c.image_url = img.value;
          if (pr) c.price_cents = Math.round(Number(pr.value || 0) * 100);
        });
        if (!g.id) g.id = slug(g.label) || `group-${gi + 1}`;
      });
      addons.forEach((a, i) => {
        const lab = $(`[data-a-label="${i}"]`, root);
        if (!lab) return;
        a.label = lab.value;
        a.hint = $(`[data-a-hint="${i}"]`, root).value;
        const pr = $(`[data-a-price="${i}"]`, root);
        if (pr && !pr.disabled) a.price_cents = Math.round(Number(pr.value || 0) * 100);
        a.max_qty = Math.max(1, Number($(`[data-a-max="${i}"]`, root).value || 1));
        a.ui = $(`[data-a-stepper="${i}"]`, root).checked ? 'stepper' : 'check';
        a.per_unit = $(`[data-a-per="${i}"]`, root).checked;
        a.unit_label = $(`[data-a-unit="${i}"]`, root).value;
        if (!a.id) a.id = slug(a.label) || `extra-${i + 1}`;
      });
    }

    function repaintLists(root) {
      harvest(root);
      $('#groups', root).innerHTML = groups.map(groupHtml).join('');
      $('#addons', root).innerHTML = addonHtml();
    }

    function wire(root) {
      root.addEventListener('click', (e) => {
        const t = e.target;
        if (t.closest('[data-add-group]')) { harvest(root); groups.push({ id: '', label: '', hint: '', required: true, applies_to: [], choices: [{ id: '', label: '', price_cents: 0 }] }); repaintLists(root); }
        else if (t.closest('[data-rm-group]')) { harvest(root); groups.splice(Number(t.closest('[data-rm-group]').dataset.rmGroup), 1); repaintLists(root); }
        else if (t.closest('[data-add-choice]')) { harvest(root); groups[Number(t.closest('[data-add-choice]').dataset.addChoice)].choices.push({ id: '', label: '', price_cents: 0 }); repaintLists(root); }
        else if (t.closest('[data-rm-choice]')) {
          harvest(root);
          const [gi, ci] = t.closest('[data-rm-choice]').dataset.rmChoice.split('.').map(Number);
          groups[gi].choices.splice(ci, 1); repaintLists(root);
        } else if (t.closest('[data-add-addon]')) { harvest(root); addons.push({ id: '', label: '', hint: '', price_cents: 0, max_qty: 1, ui: 'check', per_unit: false, unit_label: '', price_rules: [] }); repaintLists(root); }
        else if (t.closest('[data-rm-addon]')) { harvest(root); addons.splice(Number(t.closest('[data-rm-addon]').dataset.rmAddon), 1); repaintLists(root); }
      });

      const mx = $('[data-matrix]', root);
      if (mx) mx.addEventListener('click', async () => {
        const text = $('#matrix-text', root).value.trim();
        if (!text) return A.toast('Paste some rows first', true);
        try {
          const r = await A.guard(() => api('POST', `/products/${x.id}/price-matrix`, { text, target: $('#matrix-target', root).value }));
          A.toast(`${r.rules} combination${r.rules === 1 ? '' : 's'} priced${r.choices_added ? `, ${r.choices_added} new choice${r.choices_added === 1 ? '' : 's'} added` : ''}`);
          A.closeDrawer(); A.render();
        } catch (e) { /* toast shown */ }
      });

      $('#prod-form', root).addEventListener('submit', async (ev) => {
        ev.preventDefault();
        harvest(root);
        let payload;
        try { payload = A.collect($('#prod-body', root)); } catch (err) { return A.toast(err.message, true); }
        payload.base_cents = Math.round(Number(payload.base_price || 0) * 100);
        delete payload.base_price;
        payload.option_groups = groups.filter((g) => g.choices.some((c) => c.label.trim()));
        payload.addons = addons.filter((a) => a.label.trim());
        payload.followup_event_type_id = payload.followup_event_type_id ? Number(payload.followup_event_type_id) : null;
        if (!x) payload.active = true;
        try {
          await A.guard(() => (x ? api('PATCH', `/products/${x.id}`, payload) : api('POST', '/products', payload)), x ? 'Saved' : 'Product created');
          A.closeDrawer(); A.render();
        } catch (err) { A.showErrors(root, err.details); }
      });

      const del = $('[data-del]', root);
      if (del) del.addEventListener('click', async () => {
        if (!confirm(`Delete "${x.name}"?${x.sold_count ? ' It has been sold, so it will be switched off instead of deleted.' : ' This cannot be undone.'}`)) return;
        try { await A.guard(() => api('DELETE', `/products/${x.id}`), 'Done'); A.closeDrawer(); A.render(); } catch (e) { /* toast shown */ }
      });
    }
    return el;
  }
})();
