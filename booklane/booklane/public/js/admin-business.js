/* Admin views: quote catalog, team, settings */
(function () {
  'use strict';
  const { esc, api, $, $$ } = A;
  const isAdmin = () => ['owner', 'admin'].includes(A.me.business.role);

  // ---------- Quote catalog ----------
  const PRICING = { flat: 'Flat price', hourly: 'Per hour', per_unit: 'Per unit (lights, guests…)' };
  const MODES = { base: 'Sets the price (packages / tiers)', add: 'Adds a flat amount', per_unit: 'Adds per hour / unit' };

  function serviceEditor(svc) {
    const s = JSON.parse(JSON.stringify(svc));
    const render = (el) => {
      el.innerHTML = `<div class="drawer-head"><div><div class="small muted">Quote catalog</div><h2>${s.id ? esc(s.name) : 'New service'}</h2></div><button class="icon-x" data-close-drawer aria-label="Close">×</button></div>
        <div class="panel" id="svc-basics">
          <div class="grid-2">${A.field('Name', A.input('name', s.name))}${A.field('Category', A.input('category', s.category, 'placeholder="e.g. Photo & Video"'))}</div>
          ${A.field('Description', A.textarea('description', s.description, 'rows="2"'))}
          <div class="grid-2">${A.field('Badge (optional)', A.input('badge', s.badge, 'placeholder="Most popular"'))}${A.field('Pricing', A.select('pricing_type', s.pricing_type, PRICING))}</div>
          <div class="grid-2">${A.field(s.option_groups.some((g) => g.mode === 'base') ? 'Base price (replaced by package)' : s.pricing_type === 'flat' ? 'Price' : 'Price per ' + (s.pricing_type === 'hourly' ? 'hour' : 'unit'), A.input('base_price', s.base_price, 'type="number" min="0" step="0.01" data-type="number"'))}
            ${s.pricing_type !== 'flat' ? A.field('Unit label', A.input('unit_label', s.unit_label, 'placeholder="hours, lights, guests"')) : '<div></div>'}</div>
          ${s.pricing_type !== 'flat' ? `<div class="grid-2" style="grid-template-columns:1fr 1fr 1fr">${A.field('Minimum', A.input('min_qty', s.min_qty, 'type="number" min="1" data-type="number"'))}${A.field('Maximum', A.input('max_qty', s.max_qty, 'type="number" min="1" data-type="number"'))}${A.field('Default', A.input('default_qty', s.default_qty, 'type="number" min="1" data-type="number"'))}</div>` : ''}
          ${A.toggle('active', s.active, 'Show in quote builder')}
        </div>
        <div class="panel"><div class="panel-head"><div><h2>Options</h2><p class="desc" style="margin:0">Packages, tiers or choices. Use "Sets the price" for packages.</p></div><button class="btn btn-ghost btn-sm" data-add-group>+ Option group</button></div>
          ${s.option_groups.map((g, gi) => `<div class="q-edit" data-g="${gi}"><div class="row between"><b class="small">Group ${gi + 1}</b><button class="icon-x" data-rm-group>×</button></div>
            <div class="grid-2">${A.field('Group name', `<input class="input" data-gf="name" value="${esc(g.name)}">`)}${A.field('How it prices', `<select class="select" data-gf="mode">${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${g.mode === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
            <div class="row" style="margin-bottom:10px">${A.toggle('_', g.required, 'Must pick one').replace('data-bind="_"', 'data-gf="required"')}${A.toggle('_', g.multi, 'Can pick several').replace('data-bind="_"', 'data-gf="multi"')}</div>
            ${g.choices.map((c, ci) => `<div class="interval" data-c="${ci}" style="margin-bottom:6px"><input class="input" style="flex:2;min-width:140px" placeholder="Choice name" data-cf="name" value="${esc(c.name)}"><input class="input" style="width:110px" type="number" step="0.01" placeholder="Price" data-cf="price" value="${c.price}">
              <input class="input" style="flex:3;min-width:160px" placeholder="What's included (optional)" data-cf="description" value="${esc(c.description || '')}"><label class="check" title="Default"><input type="radio" name="def-${gi}" data-cf="default" ${c.default ? 'checked' : ''}>Default</label><button class="icon-x" data-rm-choice>×</button></div>`).join('')}
            <button class="btn btn-link btn-sm" data-add-choice>+ Add choice</button></div>`).join('') || '<p class="muted small">No options. The service is sold at its base price.</p>'}
        </div>
        <div class="panel"><div class="panel-head"><div><h2>Add-ons</h2><p class="desc" style="margin:0">Extras customers can tick on.</p></div><button class="btn btn-ghost btn-sm" data-add-addon>+ Add-on</button></div>
          ${s.addons.map((a, ai) => `<div class="interval" data-a="${ai}" style="margin-bottom:6px"><input class="input" style="flex:2;min-width:160px" placeholder="Add-on name" data-af="name" value="${esc(a.name)}"><input class="input" style="width:110px" type="number" step="0.01" placeholder="Price" data-af="price" value="${a.price}">
            <label class="small muted">Max qty</label><input class="input" style="width:80px" type="number" min="1" data-af="max" value="${a.max || 1}">
            ${s.pricing_type !== 'flat' ? `<select class="select" data-af="per" style="width:auto"><option value="each" ${a.per !== 'unit' ? 'selected' : ''}>each</option><option value="unit" ${a.per === 'unit' ? 'selected' : ''}>per ${esc(s.unit_label || 'unit')}</option></select>` : ''}
            <button class="icon-x" data-rm-addon>×</button></div>`).join('') || '<p class="muted small">No add-ons.</p>'}
        </div>
        <div class="row between" style="margin-top:16px"><span class="small muted" id="svc-preview"></span><div class="row"><button class="btn btn-ghost" data-close-drawer>Cancel</button><button class="btn btn-primary" data-save-svc>Save service</button></div></div>`;
      const pv = $('#svc-preview', el); if (pv) pv.textContent = `Starts at ${A.money(window.BLPricing.startingPrice(s))}`;
    };
    A.drawer('', (el) => {
      render(el);
      const syncBasics = () => Object.assign(s, A.collect($('#svc-basics', el)));
      el.addEventListener('input', (e) => {
        const t = e.target;
        const g = t.closest('[data-g]'), c = t.closest('[data-c]'), a = t.closest('[data-a]');
        if (t.dataset.gf) { const grp = s.option_groups[Number(g.dataset.g)]; grp[t.dataset.gf] = t.type === 'checkbox' ? t.checked : t.value; }
        else if (t.dataset.cf) { const grp = s.option_groups[Number(g.dataset.g)]; const ch = grp.choices[Number(c.dataset.c)]; if (t.dataset.cf === 'default') grp.choices.forEach((x, i) => (x.default = i === Number(c.dataset.c))); else ch[t.dataset.cf] = t.dataset.cf === 'price' ? Number(t.value) : t.value; }
        else if (t.dataset.af) { const ad = s.addons[Number(a.dataset.a)]; ad[t.dataset.af] = ['price', 'max'].includes(t.dataset.af) ? Number(t.value) : t.value; }
        else if (t.closest('#svc-basics')) syncBasics();
        const pv = $('#svc-preview', el); if (pv) pv.textContent = `Starts at ${A.money(window.BLPricing.startingPrice(s))}`;
      });
      el.addEventListener('change', (e) => { if (e.target.dataset.bind === 'pricing_type' || e.target.dataset.gf === 'mode') { syncBasics(); render(el); } });
      el.addEventListener('click', async (e) => {
        const t = e.target.closest('button'); if (!t) return;
        const g = t.closest('[data-g]');
        syncBasics();
        if (t.hasAttribute('data-add-group')) { s.option_groups.push({ id: '', name: 'Package', mode: 'base', required: true, multi: false, choices: [{ id: '', name: 'Standard', price: 0, default: true }] }); render(el); }
        if (t.hasAttribute('data-rm-group')) { s.option_groups.splice(Number(g.dataset.g), 1); render(el); }
        if (t.hasAttribute('data-add-choice')) { s.option_groups[Number(g.dataset.g)].choices.push({ id: '', name: '', price: 0 }); render(el); }
        if (t.hasAttribute('data-rm-choice')) { s.option_groups[Number(g.dataset.g)].choices.splice(Number(t.closest('[data-c]').dataset.c), 1); render(el); }
        if (t.hasAttribute('data-add-addon')) { s.addons.push({ id: '', name: '', price: 0, max: 1, per: 'each' }); render(el); }
        if (t.hasAttribute('data-rm-addon')) { s.addons.splice(Number(t.closest('[data-a]').dataset.a), 1); render(el); }
        if (t.hasAttribute('data-save-svc')) {
          s.option_groups.forEach((gr) => { gr.id = gr.id || gr.name; gr.choices.forEach((c) => (c.id = c.id || c.name)); });
          s.addons.forEach((ad) => (ad.id = ad.id || ad.name));
          await A.guard(() => (s.id ? api('PATCH', `/services/${s.id}`, s) : api('POST', '/services', s)), 'Service saved');
          A.closeDrawer(); A.render();
        }
      });
    });
  }

  // ---------- Spreadsheet import ----------
  function importDrawer() {
    let file = null, parsed = null;
    A.drawer(`<div class="drawer-head"><div><div class="small muted">Quote catalog</div><h2>Import a spreadsheet</h2></div><button class="icon-x" data-close-drawer aria-label="Close">&times;</button></div>
      <div>
        <p class="desc">Upload an .xlsx or .csv. The first row should be column headings. A sheet named <b>Bundles</b> is read as bundle pricing; everything else is read as services.</p>
        <div class="panel" style="padding:12px;margin-bottom:14px"><div class="small"><b>Services columns:</b> Category, Service, Description, Price, Unit, Min, Max<br><b>Bundles columns:</b> Bundle, Services (separated by ;), Type (price / amount / percent), Value</div>
          <a class="btn btn-link btn-sm" href="#" data-sample>Download a template</a></div>
        <input type="file" id="imp-file" class="input" accept=".xlsx,.csv,.tsv,.txt">
        <div id="imp-out" style="margin-top:14px"></div>
      </div>
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:18px"><button class="btn btn-ghost" data-close-drawer>Cancel</button><button class="btn btn-primary" id="imp-go" disabled>Preview</button></div>`,
    (el) => {
      const out = $('#imp-out', el), go = $('#imp-go', el);
      $('#imp-file', el).addEventListener('change', (ev) => { file = ev.target.files[0] || null; parsed = null; go.disabled = !file; go.textContent = 'Preview'; out.innerHTML = ''; });
      $('[data-sample]', el).addEventListener('click', (ev) => {
        ev.preventDefault();
        const csv = 'Category,Service,Description,Price,Unit,Min,Max\nEntertainment,DJ / MC,5 hours of coverage,1200,flat,,\nEntertainment,Photo Booth,3 hour open-air booth,800,flat,,\nLighting,Uplighting,Per fixture,25,per unit,8,40\n';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'catalog-template.csv'; a.click();
      });
      go.addEventListener('click', async () => {
        if (!file) return;
        const mode = ($('[name=imp-mode]:checked', el) || {}).value || 'merge';
        go.disabled = true; go.textContent = parsed ? 'Importing…' : 'Reading…';
        try {
          const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
          const r = await api('POST', '/services/import', { filename: file.name, data, mode, confirm: !!parsed });
          if (r.preview) {
            parsed = r;
            out.innerHTML = previewHtml(r);
            go.textContent = 'Import';
          } else {
            A.toast(`Imported ${r.added} new and ${r.updated} updated service${r.added + r.updated === 1 ? '' : 's'}${r.bundles ? `, ${r.bundles} bundle${r.bundles === 1 ? '' : 's'}` : ''}`);
            A.closeDrawer(); A.render();
            return;
          }
        } catch (err) { out.innerHTML = `<div class="warn-box">${esc(err.message)}</div>`; go.textContent = 'Preview'; parsed = null; }
        go.disabled = false;
      });
    });
  }

  function previewHtml(r) {
    const svc = r.services.map((s) => `<tr><td>${esc(s.category || '')}</td><td>${esc(s.name)}</td><td>${A.money(s.base_price)}</td><td class="small muted">${s.pricing_type === 'per_unit' ? `per ${esc(s.unit_label || 'unit')} (${s.min_qty}–${s.max_qty})` : 'flat'}</td></tr>`).join('');
    const bun = r.bundles.map((b) => `<tr><td>${esc(b.name)}</td><td class="small">${esc((b.service_names || []).join(', ')) || `any ${b.min_services} services`}</td><td>${b.type === 'percent' ? `${b.value}% off` : b.type === 'amount' ? `${A.money(b.value)} off` : A.money(b.value)}</td></tr>`).join('');
    return `${r.warnings.length ? `<div class="warn-box" style="margin-bottom:12px"><b>Check these:</b><ul style="margin:6px 0 0 16px">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      <h3 style="margin:0 0 6px">${r.services.length} service${r.services.length === 1 ? '' : 's'}</h3>
      ${svc ? `<div class="table-wrap"><table class="t"><thead><tr><th>Category</th><th>Service</th><th>Price</th><th>Pricing</th></tr></thead><tbody>${svc}</tbody></table></div>` : '<p class="muted small">None found.</p>'}
      ${bun ? `<h3 style="margin:16px 0 6px">${r.bundles.length} bundle${r.bundles.length === 1 ? '' : 's'}</h3><div class="table-wrap"><table class="t"><thead><tr><th>Bundle</th><th>Applies to</th><th>Price / discount</th></tr></thead><tbody>${bun}</tbody></table></div>
        <p class="small muted" style="margin-top:6px">Importing bundles replaces the bundle list in Settings → Quotes.</p>` : ''}
      <div class="panel" style="padding:12px;margin-top:16px"><label class="label">What should happen to services already in your catalog?</label>
        <label class="check"><input type="radio" name="imp-mode" value="merge" checked><span>Update matching names, keep everything else</span></label>
        <label class="check"><input type="radio" name="imp-mode" value="replace"><span>Also hide services that are not in this file</span></label></div>`;
  }

  A.route('/catalog', {
    title: 'Quote catalog',
    async render() {
      const [rows, biz] = await Promise.all([api('GET', '/services'), api('GET', '/business')]);
      A.cache.services = rows;
      const qs = biz.settings.quote;
      return `<div class="topbar"><div><h1>Quote catalog</h1><div class="sub">Services, packages and add-ons customers can build a quote from.</div></div>
        <div class="tools"><a class="btn btn-ghost" href="/b/${esc(A.me.business.slug)}/quote" target="_blank">Preview builder</a>${isAdmin() ? '<button class="btn btn-ghost" data-import>Import spreadsheet</button><button class="btn btn-primary" data-new>+ Add service</button>' : ''}</div></div>
        ${qs.enabled ? '' : '<div class="warn-box" style="margin-bottom:16px">The quote builder is turned off. Turn it on in <a href="#/settings/quote">Settings → Quotes</a>.</div>'}
        <div class="panel" style="padding:0">${rows.length ? rows.map((s, i) => `<div class="svc-row"><div class="row" style="flex-direction:column;gap:0">${isAdmin() ? `<button class="icon-x" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button><button class="icon-x" data-down="${i}" ${i === rows.length - 1 ? 'disabled' : ''} title="Move down">↓</button>` : ''}</div>
          <div class="grow"><div class="row"><b>${esc(s.name)}</b>${s.badge ? `<span class="pill quoted">${esc(s.badge)}</span>` : ''}${s.active ? '' : '<span class="pill">Hidden</span>'}</div>
            <div class="small muted">${esc(s.category || 'No category')} · ${esc(PRICING[s.pricing_type])} · ${s.option_groups.reduce((a, g) => a + g.choices.length, 0)} options · ${s.addons.length} add-ons</div></div>
          <div class="num"><b>from ${A.money(window.BLPricing.startingPrice(s))}</b></div>
          ${isAdmin() ? `<button class="btn btn-ghost btn-sm" data-edit="${s.id}">Edit</button><button class="icon-x" data-del="${s.id}" title="Delete">×</button>` : ''}</div>`).join('')
          : '<div class="empty-state"><h3>No services yet</h3><p>Add your first service with its packages and add-ons.</p></div>'}</div>
        <div class="panel"><div class="panel-head"><div><h2>Pricing rules</h2><p class="desc" style="margin:0">Tax ${Number(qs.tax_rate) || 0}% · Deposit ${qs.deposit_type === 'flat' ? A.money(qs.deposit_value) : (Number(qs.deposit_value) || 0) + '%'} · ${esc(((qs.bundles || []).map((b) => b.name || (b.type === 'price' ? 'Bundle price' : 'Bundle discount')).concat((qs.bundle_discounts || []).map((b) => `${Number(b.percent)}% off ${Number(b.min_services)}+`))).join(', ') || 'No bundles')}</p></div><a class="btn btn-ghost btn-sm" href="#/settings/quote">Edit rules</a></div></div>`;
    },
    mount(root) {
      root.addEventListener('click', async (e) => {
        const rows = A.cache.services;
        const t = e.target.closest('button'); if (!t) return;
        if (t.hasAttribute('data-import')) importDrawer();
        if (t.hasAttribute('data-new')) serviceEditor({ name: '', category: '', description: '', pricing_type: 'flat', base_price: 0, unit_label: '', min_qty: 1, max_qty: 1, default_qty: 1, option_groups: [], addons: [], active: true, badge: '' });
        if (t.dataset.edit) serviceEditor(rows.find((s) => String(s.id) === t.dataset.edit));
        if (t.dataset.del && confirm('Delete this service? Existing quotes keep their line items.')) { await A.guard(() => api('DELETE', `/services/${t.dataset.del}`), 'Deleted'); A.render(); }
        if (t.dataset.up || t.dataset.down) {
          const i = Number(t.dataset.up || t.dataset.down), j = t.dataset.up ? i - 1 : i + 1;
          const ids = rows.map((s) => s.id); [ids[i], ids[j]] = [ids[j], ids[i]];
          await A.guard(() => api('POST', '/services/reorder', { ids })); A.render();
        }
      });
    },
  });

  // ---------- Team ----------
  A.route('/team', {
    title: 'Team',
    async render() {
      const rows = await api('GET', '/team');
      return `<div class="topbar"><div><h1>Team</h1><div class="sub">People who can take calls or manage this business.</div></div></div>
        <div class="cols-2"><div class="panel" style="padding-bottom:6px"><div class="table-wrap"><table class="t"><thead><tr><th>Person</th><th>Role</th><th>Setup</th><th></th></tr></thead><tbody>
          ${rows.map((m) => `<tr><td><b>${esc(m.name)}</b>${m.id === A.me.user.id ? ' <span class="small muted">(you)</span>' : ''}${m.status === 'invited' ? ' <span class="pill partial">Invite pending</span>' : ''}<div class="small muted">${esc(m.email)}</div></td>
            <td>${isAdmin() ? `<select class="select btn-sm" data-role="${m.id}" style="width:auto">${['host', 'admin', 'owner'].map((r) => `<option ${m.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>` : A.pill(m.role)}</td>
            <td class="small">${m.has_hours ? '<span class="pill booked">Hours set</span>' : '<span class="pill partial">No hours</span>'} ${m.calendars.length ? `<span class="pill booked">${m.calendars.length} calendar</span>` : '<span class="pill">No calendar</span>'}</td>
            <td class="num">${isAdmin() ? `<a class="btn btn-ghost btn-sm" href="#/availability?user_id=${m.id}">Hours</a>${m.id !== A.me.user.id ? ` <button class="icon-x" data-remove="${m.id}" title="Remove">×</button>` : ''}` : ''}</td></tr>`).join('')}</tbody></table></div></div>
        ${isAdmin() ? `<form class="panel" id="invite"><h2>Invite a team member</h2><p class="desc">They get an email link to join and set their own password.</p>
          ${A.field('Name', '<input class="input" name="name">')}${A.field('Email', '<input class="input" name="email" type="email">')}
          ${A.field('Role', '<select class="select" name="role"><option value="host">Host (takes calls, sees leads)</option><option value="admin">Admin (manages settings)</option><option value="owner">Owner</option></select>')}
          <button class="btn btn-primary">Send invite</button><div id="invite-out" style="margin-top:12px"></div></form>` : ''}</div>`;
    },
    mount(root) {
      const f = $('#invite', root);
      if (f) f.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const r = await api('POST', '/team', Object.fromEntries(new FormData(f)));
          $('#invite-out', root).innerHTML = r.invite_url
            ? `<div class="warn-box">Invite created, but email is not set up on the server, so send them this link yourself:<div class="copy-row" style="margin-top:8px"><input class="input" readonly value="${esc(r.invite_url)}"><button type="button" class="btn btn-ghost btn-sm" data-copy="${esc(r.invite_url)}">Copy</button></div></div>`
            : '<div class="ok-box">Invite sent. They will show up here once they accept.</div>';
          if (!r.invite_url) setTimeout(() => A.render(), 1500);
        } catch (err) { A.toast(err.message, true); A.showErrors(f, err.details); }
      });
      root.addEventListener('change', async (e) => { const r = e.target.dataset.role; if (r) { await A.guard(() => api('PATCH', `/team/${r}`, { role: e.target.value }), 'Role updated').catch(() => A.render()); } });
      root.addEventListener('click', async (e) => { const r = e.target.closest('[data-remove]'); if (r && confirm('Remove this person from the business?')) { await A.guard(() => api('DELETE', `/team/${r.dataset.remove}`), 'Removed'); A.render(); } });
    },
  });

  // ---------- Settings ----------
  const TABS = { general: 'Branding & page', leads: 'Leads & alerts', quote: 'Quotes', integrations: 'Integrations', emails: 'Email log' };
  const lines = (arr) => (arr || []).join('\n');

  async function settingsView(p) {
    const tab = p.tab || 'general';
    const b = await api('GET', '/business');
    A.cache.biz = b;
    const s = b.settings;
    const tabs = `<div class="tabs">${Object.entries(TABS).map(([k, v]) => `<a href="#/settings/${k}" class="${k === tab ? 'on' : ''}">${v}</a>`).join('')}</div>`;
    let body = '';
    if (tab === 'general') {
      body = `<div class="cols-even"><div class="panel"><h2>Business</h2>
        ${A.field('Business name', A.input('name', b.name))}
        ${A.field('Page link', `<div class="copy-row"><span class="small muted">/b/</span>${A.input('slug', b.slug)}</div>`, 'Changing this breaks links you already shared.')}
        ${A.field('Timezone', A.tzSelect('timezone', b.timezone))}
        <div class="grid-2">${A.field('Public email', A.input('email', b.email))}${A.field('Phone', A.input('phone', b.phone))}</div>
        ${A.field('Website', A.input('website', b.website))}
        <div class="grid-2">${A.field('Logo URL', A.input('logo_url', b.logo_url, 'placeholder="https://…/logo.png"'))}${A.field('Brand color', A.input('brand_color', b.brand_color, 'type="color" style="height:46px;padding:4px"'))}</div></div>
        <div class="panel"><h2>Page copy</h2>
        ${A.field('Tagline', A.input('settings.tagline', s.tagline))}
        ${A.field('Urgency message (optional)', A.input('settings.urgency_text', s.urgency_text, 'placeholder="Only 4 spots left this week"'))}
        ${A.field('Trust points (one per line)', `<textarea class="textarea" rows="3" data-bind="settings.trust_points" data-type="lines">${esc(lines(s.trust_points))}</textarea>`)}
        ${A.field('Privacy note', A.input('settings.privacy_note', s.privacy_note))}
        ${A.field('SMS consent text', A.textarea('settings.sms_consent_text', s.sms_consent_text, 'rows="3"'))}</div></div>`;
    } else if (tab === 'leads') {
      const L = s.leads, N = s.notifications;
      body = `<div class="cols-even"><div class="panel"><h2>Partial leads</h2><p class="desc">When someone stops partway, we keep what they entered and can alert you.</p>
        <div class="stack">${A.toggle('settings.leads.notify_team_on_partial', L.notify_team_on_partial, 'Email the team about partial leads')}
        ${A.toggle('settings.leads.partial_requires_contact', L.partial_requires_contact, 'Only alert when we have an email or phone')}
        ${A.field('Treat as abandoned after (minutes idle)', A.input('settings.leads.abandoned_after_min', L.abandoned_after_min, 'type="number" min="5" data-type="number"'))}
        ${A.toggle('settings.leads.send_recovery_email', L.send_recovery_email, 'Email the customer a “finish where you left off” link')}
        ${A.field('Send that email after (minutes idle)', A.input('settings.leads.recovery_delay_min', L.recovery_delay_min, 'type="number" min="10" data-type="number"'))}</div></div>
        <div class="panel"><h2>Notifications</h2>
        ${A.field('Team emails (one per line)', `<textarea class="textarea" rows="3" data-bind="settings.notifications.team_emails" data-type="lines">${esc(lines(N.team_emails))}</textarea>`, 'Leave blank to use the business email and owners.')}
        <div class="stack">${A.toggle('settings.notifications.notify_on_booking', N.notify_on_booking, 'New bookings')}${A.toggle('settings.notifications.notify_on_quote', N.notify_on_quote, 'New quotes')}
        ${A.toggle('settings.notifications.notify_on_contract', N.notify_on_contract, 'Contract requests')}${A.toggle('settings.notifications.notify_on_callback', N.notify_on_callback, 'Call back requests')}</div></div></div>`;
    } else if (tab === 'quote') {
      const Q = s.quote;
      const ets = (await api('GET', '/event-types')).event_types;
      const svcs = await api('GET', '/services');
      body = `<div class="cols-even"><div class="panel"><h2>Quote builder</h2>
        <div class="stack" style="margin-bottom:14px">${A.toggle('settings.quote.enabled', Q.enabled, 'Quote builder is live')}${A.toggle('settings.quote.require_event_date', Q.require_event_date, 'Require an event date')}</div>
        ${A.field('Title', A.input('settings.quote.title', Q.title))}${A.field('Intro', A.textarea('settings.quote.intro', Q.intro, 'rows="2"'))}
        ${A.field('Ask for contact info', A.select('settings.quote.contact_step_position', Q.contact_step_position, { before_review: 'After services, before showing the full quote', first: 'First step (captures the most leads)' }))}
        ${A.field('Event types (one per line)', `<textarea class="textarea" rows="4" data-bind="settings.quote.event_types" data-type="lines">${esc(lines(Q.event_types))}</textarea>`)}
        <div class="grid-2">${A.field('Cities / areas (one per line)', `<textarea class="textarea" rows="4" data-bind="settings.quote.cities" data-type="lines">${esc(lines(Q.cities))}</textarea>`, 'Blank = free text')}${A.field('Guest count ranges', `<textarea class="textarea" rows="4" data-bind="settings.quote.guest_ranges" data-type="lines">${esc(lines(Q.guest_ranges))}</textarea>`)}</div>
        ${A.field('Terms shown under the quote', A.textarea('settings.quote.terms', Q.terms, 'rows="3"'))}</div>
        <div class="panel"><div class="panel-head"><div><h2>Questions on the first step</h2><p class="desc" style="margin:0">Add, remove or reorder what the quote builder asks before showing services.</p></div>
          <button type="button" class="btn btn-ghost btn-sm" data-add-qf>+ Question</button></div>
          <div id="qfields" class="stack" style="gap:10px;margin-top:10px">${(Q.fields || []).map((f) => qfieldRow(f)).join('')}</div></div>
        <div class="panel"><h2>Contact step</h2><p class="desc">Which contact details the quote builder asks for.</p>
          <div class="stack" style="margin-top:10px">${A.toggle('settings.quote.ask_last_name', Q.ask_last_name !== false, 'Ask for last name')}${A.toggle('settings.quote.ask_phone', Q.ask_phone !== false, 'Ask for phone')}${A.toggle('settings.quote.require_phone', !!Q.require_phone, 'Phone is required')}${A.toggle('settings.quote.ask_company', !!Q.ask_company, 'Ask for company')}</div></div>
        <div class="stack"><div class="panel"><h2>Pricing rules</h2>
          <div class="grid-2">${A.field('Currency', A.select('settings.quote.currency', Q.currency, { USD: 'USD', CAD: 'CAD', MXN: 'MXN', EUR: 'EUR', GBP: 'GBP', AUD: 'AUD' }))}${A.field('Tax rate %', A.input('settings.quote.tax_rate', Q.tax_rate, 'type="number" step="0.01" min="0" data-type="number"'))}</div>
          <div class="grid-2">${A.field('Deposit type', A.select('settings.quote.deposit_type', Q.deposit_type, { percent: 'Percent of total', flat: 'Flat amount' }))}${A.field('Deposit value', A.input('settings.quote.deposit_value', Q.deposit_value, 'type="number" step="0.01" min="0" data-type="number"'))}</div>
          ${A.field('Quote valid for (days)', A.input('settings.quote.expires_days', Q.expires_days, 'type="number" min="1" data-type="number"'))}
          <label class="label">Bundles</label><p class="desc" style="margin:2px 0 8px">Pick the services a bundle covers, or leave them all unticked and set a minimum count. When several bundles match, the customer gets the best one.</p>
          <div id="bundles" class="stack" style="gap:10px;margin:8px 0">${legacyBundles(Q).map((t) => bundleRow(t, svcs)).join('')}</div><button type="button" class="btn btn-link btn-sm" data-add-bundle>+ Add bundle</button></div>
        <div class="panel"><h2>Next steps offered</h2><div class="stack">${A.toggle('settings.quote.next_steps.contract', Q.next_steps.contract, 'Request a contract')}${A.toggle('settings.quote.next_steps.book_call', Q.next_steps.book_call, 'Book a call')}${A.toggle('settings.quote.next_steps.callback', Q.next_steps.callback, 'Have us call me')}</div>
          <div style="margin-top:14px">${A.field('Call type used for “Book a call”', A.select('settings.quote.call_event_type_id', Q.call_event_type_id || '', Object.assign({ '': 'First active call type' }, Object.fromEntries(ets.map((e) => [e.id, e.name])))))}</div>
          <label class="label">Ask for in the contract request</label><div class="stack" style="margin-top:8px">${Object.entries({ billing_address: 'Billing address', venue_address: 'Venue address', event_start_time: 'Start time', event_end_time: 'End time', planner_name: 'Planner name' }).map(([k, v]) => A.toggle(`settings.quote.contract_fields.${k}`, Q.contract_fields[k], v)).join('')}</div></div></div></div>`;
    } else if (tab === 'integrations') {
      const BB = s.integrations.boothbook, W = s.integrations.webhook;
      const events = ['lead.partial', 'lead.completed', 'booking.created', 'booking.cancelled', 'quote.submitted', 'contract.requested', 'callback.requested'];
      body = `<div class="cols-even"><div class="panel"><h2>BoothBook</h2><p class="desc">Send contract requests to BoothBook as leads. BoothBook's API is invite only, so confirm the endpoint and field names with BoothBook support, then test here.</p>
        <div class="stack" style="margin-bottom:12px">${A.toggle('settings.integrations.boothbook.enabled', BB.enabled, 'Push contract requests to BoothBook')}</div>
        ${A.field('Endpoint URL', A.input('settings.integrations.boothbook.url', BB.url, 'placeholder="https://booking.yourdomain.com/api/…/leads"'))}
        <div class="grid-2">${A.field('Client key', A.input('settings.integrations.boothbook.key', BB.key))}${A.field('Client secret', A.input('settings.integrations.boothbook.secret', BB.secret, 'type="password" autocomplete="off"'))}</div>
        ${A.field('Send as', A.select('settings.integrations.boothbook.format', BB.format, { form: 'Form fields (key, secret, …)', json: 'JSON body' }))}
        ${A.field('Field mapping (our field → BoothBook field)', `<textarea class="textarea code" style="background:#16131f;color:#eee" rows="8" data-bind="settings.integrations.boothbook.field_map" data-type="json">${esc(JSON.stringify(BB.field_map, null, 2))}</textarea>`, 'Available: first_name, last_name, email, phone, event_date, event_type, venue, guests, notes, quote_total, quote_url, event_start_time, event_end_time, venue_address, billing_address, source')}
        ${A.field('Extra static fields (JSON)', `<textarea class="textarea code" style="background:#16131f;color:#eee" rows="3" data-bind="settings.integrations.boothbook.static_fields" data-type="json">${esc(JSON.stringify(BB.static_fields, null, 2))}</textarea>`)}
        <div class="row"><button type="button" class="btn btn-ghost btn-sm" data-test="boothbook" data-dry="1">Preview payload</button><button type="button" class="btn btn-ghost btn-sm" data-test="boothbook">Send test lead</button></div><div id="bb-out" style="margin-top:10px"></div></div>
        <div class="stack"><div class="panel"><h2>Webhook (Zapier, Make, your CRM)</h2><p class="desc">We POST JSON for each event you pick. Works with Zapier's “Catch Hook”, including Zapier's BoothBook “Create Lead” action.</p>
          <div class="stack" style="margin-bottom:12px">${A.toggle('settings.integrations.webhook.enabled', W.enabled, 'Send webhooks')}</div>
          ${A.field('URL', A.input('settings.integrations.webhook.url', W.url, 'placeholder="https://hooks.zapier.com/…"'))}
          ${A.field('Signing secret (optional)', A.input('settings.integrations.webhook.secret', W.secret, 'type="password" autocomplete="off"'), 'Signed as X-Booklane-Signature: sha256=HMAC(body)')}
          <label class="label">Events</label><div class="mini-grid" style="margin:8px 0 12px">${events.map((ev) => `<label class="check"><input type="checkbox" data-wh="${ev}" ${W.events.includes(ev) ? 'checked' : ''}><span>${ev}</span></label>`).join('')}</div>
          <button type="button" class="btn btn-ghost btn-sm" data-test="webhook">Send test webhook</button><div id="wh-out" style="margin-top:10px"></div></div>
        <div class="panel"><h2>Email delivery</h2>${A.me.app.email_provider === 'resend' ? '<div class="ok-box">Sending through Resend.</div>' : '<div class="warn-box">No email provider set, so emails are only logged. Add RESEND_API_KEY and EMAIL_FROM to your server environment to send real emails.</div>'}
          <button type="button" class="btn btn-ghost btn-sm" style="margin-top:10px" data-test="email">Send me a test email</button></div></div></div>`;
    } else if (tab === 'emails') {
      const rows = await api('GET', '/emails');
      body = `<div class="panel">${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Sent</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>${rows.map((e) => `<tr class="click" data-email="${e.id}"><td class="small muted">${esc(A.dt(e.created_at))}</td><td class="small">${esc(e.to_addr)}</td><td>${esc(e.subject)}${e.error ? `<div class="small" style="color:var(--err)">${esc(e.error.slice(0, 160))}</div>` : ''}</td><td>${A.pill(e.status === 'sent' ? 'booked' : e.status === 'failed' ? 'failed' : 'partial').replace(/>[^<]+</, `>${esc(e.status)}<`)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">No emails yet.</div>'}</div>`;
    }
    const savable = !['emails'].includes(tab);
    return `<div class="topbar"><div><h1>Settings</h1><div class="sub">${esc(b.name)}</div></div>${savable && isAdmin() ? '<div class="tools"><button class="btn btn-primary" data-save-settings>Save changes</button></div>' : ''}</div>${tabs}<form id="settings-form" onsubmit="return false">${body}</form>`;
  }
  const QFIELD_TYPES = { text: 'Short text', textarea: 'Paragraph', choice: 'Choose one (cards)', choice_select: 'Choose one (dropdown)', multi: 'Choose several', date: 'Date', number: 'Number', email: 'Email', phone: 'Phone' };

  function qfieldRow(f) {
    f = f || { id: '', label: '', type: 'text', options: [], required: false, full: true };
    const builtin = ['event_type', 'event_date', 'city', 'venue', 'guests'].includes(f.id);
    return `<div class="panel" data-qfield style="padding:12px" data-id="${esc(f.id)}">
      <div class="row" style="gap:6px;align-items:center;flex-wrap:nowrap">
        <input class="input" style="flex:1;min-width:90px" placeholder="Question" data-qf="label" value="${esc(f.label || '')}">
        <select class="input" style="width:150px;flex:none" data-qf="type">${Object.entries(QFIELD_TYPES).map(([k, v]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <button type="button" class="icon-x" data-qf-move="-1" title="Move up">&uarr;</button>
        <button type="button" class="icon-x" data-qf-move="1" title="Move down">&darr;</button>
        <button type="button" class="icon-x" data-rm-qfield title="Remove">&times;</button>
      </div>
      <div class="row" style="gap:14px;margin-top:8px;align-items:center">
        <label class="check"><input type="checkbox" data-qf="required" ${f.required ? 'checked' : ''}><span>Required</span></label>
        <label class="check"><input type="checkbox" data-qf="full" ${f.full ? 'checked' : ''}><span>Full width</span></label>
        ${builtin ? `<span class="small muted">Answers save as <code>${esc(f.id)}</code></span>` : ''}
      </div>
      <div data-qf-opts style="margin-top:8px;${['choice', 'choice_select', 'multi'].includes(f.type) ? '' : 'display:none'}">
        ${A.field('Choices (one per line)', `<textarea class="textarea" rows="3" data-qf="options">${esc((f.options || []).join('\n'))}</textarea>`, builtin ? 'Leave blank to use the list above' : '')}
      </div></div>`;
  }

  // Old percent-only tiers are shown as ordinary bundles so nothing is lost on save.
  function legacyBundles(Q) {
    const list = (Q.bundles || []).slice();
    for (const t of Q.bundle_discounts || []) list.push({ name: '', type: 'percent', value: t.percent, service_ids: [], min_services: t.min_services, label: t.label || '' });
    return list.length ? list : [];
  }

  function bundleRow(t, svcs) {
    t = t || { name: '', type: 'price', value: 0, service_ids: [], min_services: 0, label: '' };
    const ids = (t.service_ids || []).map(Number);
    const types = { price: 'these services cost', amount: 'take this much off', percent: 'take this % off' };
    return `<div class="panel" data-bundle style="padding:12px">
      <div class="row" style="gap:6px;align-items:center;flex-wrap:nowrap">
        <input class="input" style="flex:1;min-width:90px" placeholder="Bundle name (shown on the quote)" data-bf="name" value="${esc(t.name || t.label || '')}">
        <select class="input" style="width:150px;flex:none" data-bf="type">${Object.entries(types).map(([k, v]) => `<option value="${k}" ${t.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input class="input" type="number" min="0" step="0.01" style="width:100px;flex:none" data-bf="value" value="${Number(t.value) || 0}">
        <button type="button" class="icon-x" data-rm-bundle title="Remove">&times;</button>
      </div>
      <div style="margin-top:8px"><label class="label">Applies when the customer picks</label>
        <div class="mini-grid" style="margin:6px 0">${(svcs || []).map((sv) => `<label class="check"><input type="checkbox" data-bsvc="${sv.id}" ${ids.includes(Number(sv.id)) ? 'checked' : ''}><span>${esc(sv.name)}</span></label>`).join('') || '<span class="small muted">Add services to your catalog first.</span>'}</div>
        <div class="row" style="gap:8px;align-items:center"><span class="small muted">or any</span><input class="input" type="number" min="0" max="50" style="width:80px" data-bf="min_services" value="${Number(t.min_services) || 0}"><span class="small muted">services (0 = off)</span></div>
      </div></div>`;
  }

  function settingsMount(root, p) {
    const tab = p.tab || 'general';
    const form = $('#settings-form', root);
    root.addEventListener('change', (e) => {
      if (e.target.dataset.qf === 'type') {
        const card = e.target.closest('[data-qfield]');
        $('[data-qf-opts]', card).style.display = ['choice', 'choice_select', 'multi'].includes(e.target.value) ? '' : 'none';
      }
    });
    root.addEventListener('click', async (e) => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.hasAttribute('data-add-qf')) $('#qfields', root).insertAdjacentHTML('beforeend', qfieldRow(null));
      if (t.hasAttribute('data-rm-qfield')) t.closest('[data-qfield]').remove();
      if (t.hasAttribute('data-qf-move')) {
        const card = t.closest('[data-qfield]'), dir = Number(t.dataset.qfMove);
        const sib = dir < 0 ? card.previousElementSibling : card.nextElementSibling;
        if (sib) card.parentNode.insertBefore(dir < 0 ? card : sib, dir < 0 ? sib : card);
      }
      if (t.hasAttribute('data-add-bundle')) { const sv = await api('GET', '/services'); $('#bundles', root).insertAdjacentHTML('beforeend', bundleRow(null, sv)); }
      if (t.hasAttribute('data-rm-bundle')) t.closest('[data-bundle]').remove();
      if (t.hasAttribute('data-save-settings') || t.dataset.test) {
        let body;
        try { body = A.collect(form); } catch (err) { return A.toast(err.message, true); }
        if (tab === 'quote') {
          body.settings.quote.fields = $$('[data-qfield]', root).map((r) => ({
            id: r.dataset.id || '', label: $('[data-qf=label]', r).value, type: $('[data-qf=type]', r).value,
            options: $('[data-qf=options]', r).value.split('\n').map((x) => x.trim()).filter(Boolean),
            required: $('[data-qf=required]', r).checked, full: $('[data-qf=full]', r).checked,
          })).filter((f) => f.label.trim());
          body.settings.quote.bundles = $$('[data-bundle]', root).map((r) => ({
            name: $('[data-bf=name]', r).value, type: $('[data-bf=type]', r).value, value: Number($('[data-bf=value]', r).value) || 0,
            service_ids: $$('[data-bsvc]', r).filter((x) => x.checked).map((x) => Number(x.dataset.bsvc)),
            min_services: Number($('[data-bf=min_services]', r).value) || 0, label: '',
          })).filter((b) => b.value > 0 && (b.service_ids.length || b.min_services));
          body.settings.quote.bundle_discounts = [];
          const cid = body.settings.quote.call_event_type_id; body.settings.quote.call_event_type_id = cid ? Number(cid) : null;
        }
        if (tab === 'integrations') body.settings.integrations.webhook.events = $$('[data-wh]', root).filter((x) => x.checked).map((x) => x.dataset.wh);
        try {
          if (savable(tab)) await api('PATCH', '/business', body);
          if (t.hasAttribute('data-save-settings')) { A.toast('Settings saved'); A.me = await api('GET', '/auth/me'); return A.render(); }
        } catch (err) { A.showErrors(form, err.details); return A.toast(err.message, true); }
        const r = await A.guard(() => api('POST', '/integrations/test', { type: t.dataset.test, dry_run: !!t.dataset.dry }));
        const out = t.dataset.test === 'boothbook' ? $('#bb-out', root) : t.dataset.test === 'webhook' ? $('#wh-out', root) : null;
        if (out) out.innerHTML = `${r.preview ? `<div class="small muted" style="margin-bottom:4px">Payload</div><div class="code">${esc(JSON.stringify(r.preview, null, 2))}</div>` : ''}${r.result ? `<div class="${r.result.ok ? 'ok-box' : 'warn-box'}" style="margin-top:8px">${r.result.ok ? 'Success' : 'Failed'}${r.result.status ? ` · HTTP ${r.result.status}` : ''}${r.result.error ? ` · ${esc(r.result.error)}` : ''}${r.result.response ? `<div class="small" style="margin-top:6px;word-break:break-all">${esc(r.result.response.slice(0, 400))}</div>` : ''}</div>` : ''}`;
        else if (r.result) A.toast(r.result.status === 'sent' ? 'Test email sent' : `Email ${r.result.status}${r.result.error ? ': ' + r.result.error : ' (logged only)'}`, r.result.status === 'failed');
      }
    });
    root.addEventListener('click', async (e) => {
      const row = e.target.closest('[data-email]');
      if (row) { const em = await api('GET', `/emails/${row.dataset.email}`); A.drawer(`<div class="drawer-head"><div><div class="small muted">${esc(em.to_addr)}</div><h2>${esc(em.subject)}</h2></div><button class="icon-x" data-close-drawer>×</button></div><iframe style="width:100%;height:80vh;border:0;border-radius:12px;background:#fff" sandbox srcdoc="${esc(em.html || '')}"></iframe>`); }
    });
  }
  const savable = (tab) => tab !== 'emails';
  A.route('/settings', { title: 'Settings', render: (p) => settingsView(p), mount: settingsMount });
  A.route('/settings/:tab', { title: 'Settings', render: (p) => settingsView(p), mount: settingsMount });
})();
A.start();
