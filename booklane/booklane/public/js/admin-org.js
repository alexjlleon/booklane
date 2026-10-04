/* Admin: teams and booking types.
   Who does the work, and what kind of work it is. Two lists, deliberately separate. */
(function () {
  'use strict';
  const { esc, api, $, $$ } = A;
  // The role lives on A.me.business, the same place every other screen reads it from. There is no
  // A.me.membership, so this threw before the screen could draw anything at all.
  const isAdmin = () => ['owner', 'admin'].includes((A.me.business || {}).role);

  const teamCard = (t, members, editable) => `<div class="panel" data-team="${t.id}" style="padding:14px">
    <div class="panel-head" style="margin-bottom:10px"><div style="display:flex;align-items:center;gap:8px">
      <span class="bar" style="display:inline-block;width:4px;height:20px;border-radius:2px;background:${esc(t.color)}"></span>
      <div><b>${esc(t.name)}</b>${t.active ? '' : ' <span class="pill">Hidden</span>'}
        <div class="small muted">${t.members.length} ${t.members.length === 1 ? 'person' : 'people'}${t.description ? ` · ${esc(t.description)}` : ''}</div></div>
    </div>${editable ? `<div><button class="btn btn-ghost btn-sm" data-edit-team="${t.id}">Edit</button>
      <button class="icon-x" data-del-team="${t.id}" title="Delete">&times;</button></div>` : ''}</div>
    ${t.members.length ? `<div class="small">${t.members.map((id) => esc((members.find((m) => m.id === id) || {}).name || 'Someone')).join(', ')}</div>`
    : '<div class="small muted">Nobody on this team yet.</div>'}
    ${editable ? `<form class="team-edit" data-form-team="${t.id}" hidden style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
      ${A.field('Team name', `<input class="input" name="name" value="${esc(t.name)}">`)}
      ${A.field('What they do', `<input class="input" name="description" value="${esc(t.description || '')}" placeholder="Optional. Shown under the heading on your booking page.">`)}
      ${A.field('Colour', `<input class="input" name="color" type="color" value="${esc(t.color)}" style="width:72px;padding:4px">`)}
      ${A.field('Who is on it', `<div class="checks">${members.map((m) => `<label class="check"><input type="checkbox" name="members" value="${m.id}" ${t.members.includes(m.id) ? 'checked' : ''}><span>${esc(m.name)}</span></label>`).join('')
    || '<span class="small muted">Invite people on the People screen first.</span>'}</div>`, 'Somebody can be on more than one team.')}
      <label class="check"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}><span>Show this team on the booking page</span></label>
      <div style="margin-top:10px"><button class="btn btn-primary btn-sm">Save</button>
        <button type="button" class="btn btn-ghost btn-sm" data-cancel-team="${t.id}">Cancel</button></div></form>` : ''}
  </div>`;

  const typeRow = (t, editable) => `<div class="panel" data-type="${t.id}" style="padding:14px">
    <div class="panel-head" style="margin-bottom:0"><div><b>${esc(t.name)}</b>${t.active ? '' : ' <span class="pill">Hidden</span>'}
      ${t.description ? `<div class="small muted">${esc(t.description)}</div>` : ''}</div>
      ${editable ? `<div><button class="btn btn-ghost btn-sm" data-edit-type="${t.id}">Edit</button>
        <button class="icon-x" data-del-type="${t.id}" title="Delete">&times;</button></div>` : ''}</div>
    ${editable ? `<form data-form-type="${t.id}" hidden style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
      ${A.field('Type name', `<input class="input" name="name" value="${esc(t.name)}">`)}
      ${A.field('Description', `<input class="input" name="description" value="${esc(t.description || '')}" placeholder="Optional. Shown under the heading on your booking page.">`)}
      <label class="check"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}><span>Show this heading on the booking page</span></label>
      <div style="margin-top:10px"><button class="btn btn-primary btn-sm">Save</button>
        <button type="button" class="btn btn-ghost btn-sm" data-cancel-type="${t.id}">Cancel</button></div></form>` : ''}
  </div>`;

  A.route('/org', {
    title: 'Teams & types',
    async render() {
      const d = await api('GET', '/org');
      const editable = isAdmin();
      return `<div class="topbar"><div><h1>Teams &amp; types</h1>
        <div class="sub">Who does the work, and what kind of booking it is. Booking pages are filed under both.</div></div></div>
        <div class="cols-2">
          <div>
            <div class="section-label" style="margin-bottom:8px">Teams</div>
            <p class="desc" style="margin-top:0">A department, like Imaging or Sales. Shown on each booking page card.</p>
            <div class="stack">${d.teams.length ? d.teams.map((t) => teamCard(t, d.members, editable)).join('') : '<p class="muted">No teams yet.</p>'}</div>
            ${editable ? `<form class="panel" id="new-team" style="margin-top:14px"><h2>Add a team</h2>
              ${A.field('Team name', '<input class="input" name="name" placeholder="Imaging Team">')}
              ${A.field('What they do', '<input class="input" name="description" placeholder="Optional">')}
              ${A.field('Who is on it', `<div class="checks">${d.members.map((m) => `<label class="check"><input type="checkbox" name="members" value="${m.id}"><span>${esc(m.name)}</span></label>`).join('')
        || '<span class="small muted">Invite people on the People screen first.</span>'}</div>`)}
              <button class="btn btn-primary">Add team</button></form>` : ''}
          </div>
          <div>
            <div class="section-label" style="margin-bottom:8px">Booking types</div>
            <p class="desc" style="margin-top:0">What the customer is choosing between, like Imaging Sessions or Sales Calls. These become the headings on your booking page, in this order.</p>
            <div class="stack">${d.booking_types.length ? d.booking_types.map((t) => typeRow(t, editable)).join('') : '<p class="muted">No types yet.</p>'}</div>
            ${editable ? `<form class="panel" id="new-type" style="margin-top:14px"><h2>Add a booking type</h2>
              ${A.field('Type name', '<input class="input" name="name" placeholder="Imaging Sessions">')}
              ${A.field('Description', '<input class="input" name="description" placeholder="Optional">')}
              <button class="btn btn-primary">Add type</button></form>` : ''}
          </div>
        </div>
        <p class="muted small" style="margin-top:18px">Set a page's team and type on <a href="#/event-types">Booking pages</a>.</p>`;
    },
    mount(root) {
      // A form that was never opened sends nothing, so an edit of one team cannot blank another.
      const payload = (form) => {
        const fd = new FormData(form);
        const body = { name: fd.get('name'), description: fd.get('description') || '' };
        if (form.querySelector('[name="color"]')) body.color = fd.get('color');
        if (form.querySelector('[name="members"]')) body.members = fd.getAll('members').map(Number);
        if (form.querySelector('[name="active"]')) body.active = !!fd.get('active');
        return body;
      };
      const submit = (form, method, url, msg) => form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await A.guard(() => api(method, url, payload(form)), msg); A.render(); }
        catch (err) { A.showErrors(form, err.details); }
      });
      for (const [id, url, msg] of [['#new-team', '/teams', 'Team added'], ['#new-type', '/booking-types', 'Type added']]) {
        const f = $(id, root); if (f) submit(f, 'POST', url, msg);
      }
      for (const f of $$('[data-form-team]', root)) submit(f, 'PATCH', `/teams/${f.dataset.formTeam}`, 'Team saved');
      for (const f of $$('[data-form-type]', root)) submit(f, 'PATCH', `/booking-types/${f.dataset.formType}`, 'Type saved');

      const toggle = (sel, on) => { const f = $(sel, root); if (f) f.hidden = !on; };
      root.addEventListener('click', async (e) => {
        const t = e.target;
        const et = t.closest('[data-edit-team]'); if (et) return toggle(`[data-form-team="${et.dataset.editTeam}"]`, true);
        const ct = t.closest('[data-cancel-team]'); if (ct) return toggle(`[data-form-team="${ct.dataset.cancelTeam}"]`, false);
        const ey = t.closest('[data-edit-type]'); if (ey) return toggle(`[data-form-type="${ey.dataset.editType}"]`, true);
        const cy = t.closest('[data-cancel-type]'); if (cy) return toggle(`[data-form-type="${cy.dataset.cancelType}"]`, false);
        // Deleting unfiles the pages rather than refusing, so say that before it happens.
        const dt = t.closest('[data-del-team]');
        if (dt && confirm('Delete this team?\n\nBooking pages filed under it keep working, they just stop showing a team.')) {
          const r = await A.guard(() => api('DELETE', `/teams/${dt.dataset.delTeam}`), 'Team deleted');
          if (r.pages_unassigned) A.toast(`${r.pages_unassigned} booking page${r.pages_unassigned === 1 ? '' : 's'} no longer shows a team`);
          return A.render();
        }
        const dy = t.closest('[data-del-type]');
        if (dy && confirm('Delete this booking type?\n\nPages under it keep working, they move to the unlabelled group at the bottom of your booking page.')) {
          const r = await A.guard(() => api('DELETE', `/booking-types/${dy.dataset.delType}`), 'Type deleted');
          if (r.pages_unassigned) A.toast(`${r.pages_unassigned} booking page${r.pages_unassigned === 1 ? '' : 's'} moved to the unlabelled group`);
          return A.render();
        }
      });
    },
  });
})();
