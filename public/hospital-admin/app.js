(function () {
  const { $app, S, esc, fmt, badge, hname, toast, logTable, csv, guard, refocus } = window.UI;

  const NAV = [
    ['dashboard', 'Dashboard'], ['profile', 'Hospital Profile'], ['staff', 'Staff'],
    ['staff/new', 'Create Staff Account'], ['audit', 'Audit Logs'],
  ];
  const shell = (active, html) => {
    const hos = S.myHospital();
    return window.UI.shell(NAV, (hos ? hos.name : 'Hospital') + ' – Hospital Admin', active, html);
  };

  // ---------- Hospital Admin views ----------
  function hDashboardView() {
    const h = S.myHospital(), st = S.staff(), logs = S.hospitalAudit();
    const c = (k, v) => st.filter((x) => x[k] === v).length;
    const roles = {};
    st.forEach((u) => { roles[u.role] = (roles[u.role] || 0) + 1; });
    const pending = st.filter((u) => u.status === 'pending');
    return shell('dashboard', `<h1>${esc(h.name)}</h1>
      <div class="grid">
        <div class="stat"><b>${st.length}</b><span>Total staff</span></div>
        <div class="stat"><b>${c('status', 'active')}</b><span>Active</span></div>
        <div class="stat"><b>${c('status', 'pending')}</b><span>Pending activation</span></div>
        <div class="stat"><b>${c('status', 'suspended')}</b><span>Suspended</span></div>
        <div class="stat"><b>${logs.filter((l) => l.outcome === 'failure' && Date.now() - new Date(l.ts) < 864e5).length}</b><span>Failed logins (24h)</span></div>
      </div>
      <div class="actions card"><a class="btn primary" href="#/staff/new">Create staff account</a><a class="btn" href="#/staff">Manage staff</a>
        <a class="btn" href="#/profile">Hospital profile</a><a class="btn" href="#/audit">Audit logs</a></div>
      <div class="two">
        <div class="card"><h2>Staff by role</h2>${Object.keys(roles).length ? `<table><tbody>${Object.entries(roles).map(([r, n]) => `<tr><td>${esc(r)}</td><td>${n}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">No staff.</p>'}</div>
        <div class="card"><h2>Awaiting activation</h2>${pending.length ? `<table><tbody>${pending.map((u) => `<tr><td><a href="#/staff/${esc(u.id)}">${esc(u.name)}</a></td><td>${esc(u.role)}</td><td>expires ${fmt(u.invite && u.invite.expiresAt)}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">None.</p>'}</div>
      </div>
      <div class="card"><h2>Recent activity</h2>${logTable(logs.slice(0, 6), true)}</div>`);
  }

  function hProfileView() {
    const h = S.myHospital();
    const ro = (l, v) => `<dt>${l}</dt><dd>${esc(v)}</dd>`;
    return shell('profile', `<h1>Hospital Profile</h1><div class="two">
      <div class="card"><h2>Registered information</h2><p class="mut">Managed by the platform System Admin. Contact ${esc(S.config().supportEmail)} to change.</p><dl class="kv">
        ${ro('Name', h.name)}${ro('Code', h.code)}${ro('License no.', h.licenseNo)}${ro('Admin', h.adminName + ' (' + h.email + ')')}<dt>Status</dt><dd>${badge(h.status)}</dd>${ro('Registered', fmt(h.createdAt))}</dl></div>
      <form class="card" data-form="profile"><h2>Contact details</h2>
        <label for="phone">Phone</label><input id="phone" name="phone" value="${esc(h.phone)}" required maxlength="40">
        <label for="address">Address</label><input id="address" name="address" value="${esc(h.address)}" required maxlength="120">
        <div class="formrow"><div><label for="city">City</label><input id="city" name="city" value="${esc(h.city)}" required maxlength="80"></div>
        <div><label for="country">Country</label><input id="country" name="country" value="${esc(h.country)}" required maxlength="80"></div></div>
        <p><button class="primary" type="submit">Save changes</button></p></form></div>`);
  }

  function staffTable(rows) {
    if (!rows.length) return '<p class="mut">No staff found.</p>';
    return `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>
      ${rows.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(u.department)}</td><td>${badge(u.status)}</td><td>${fmt(u.lastLogin)}</td><td><a class="btn sm" href="#/staff/${esc(u.id)}">Details</a></td></tr>`).join('')}</tbody></table></div>`;
  }

  function hStaffView(q = '', st = '', role = '') {
    const rows = S.staff().filter((u) => (!st || u.status === st) && (!role || u.role === role) && (!q || (u.name + u.email + u.department).toLowerCase().includes(q.toLowerCase())));
    const sel = (id, list, cur, all, label) => `<select id="${id}" aria-label="${label}"><option value="">${all}</option>${list.map((v) => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
    return shell('staff', `<h1>Staff</h1>
      <div class="toolbar"><input id="sq" type="search" placeholder="Search name, email, department…" value="${esc(q)}" aria-label="Search">
        ${sel('ss', ['active', 'pending', 'suspended'], st, 'All statuses', 'Status')}${sel('sr', ['Hospital Admin'].concat(S.STAFF_ROLES), role, 'All roles', 'Role')}
        <a class="btn primary" href="#/staff/new">+ Create staff account</a></div>
      <div class="card">${staffTable(rows)}</div>`);
  }

  function hAddStaffView(err, created) {
    if (created) {
      return shell('staff/new', `<h1>Staff account created</h1><div class="card">
        <p><b>${esc(created.name)}</b> (${esc(created.role)}) was created with status ${badge('pending')}. An activation invitation was issued to <b>${esc(created.email)}</b>,
        valid until ${fmt(created.invite.expiresAt)}. The staff member sets their own password; you never see it.</p>
        <p class="mut">Email delivery needs a backend (Cloud Function). In this demo, share the link manually:</p>
        <div class="linkbox">${esc(S.inviteLink(created))}</div>
        <p class="actions"><a class="btn primary" href="#/staff/${esc(created.id)}">View details</a><a class="btn" href="#/staff/new">Create another</a></p></div>`);
    }
    return shell('staff/new', `<h1>Create Staff Account</h1><form class="card" data-form="addStaff">
      <div class="formrow"><div><label for="name">Full name</label><input id="name" name="name" required maxlength="100"></div>
      <div><label for="email">Work email</label><input id="email" name="email" type="email" required maxlength="120"></div></div>
      <div class="formrow"><div><label for="role">Role</label><select id="role" name="role" required>${S.STAFF_ROLES.map((r) => `<option>${esc(r)}</option>`).join('')}</select></div>
      <div><label for="department">Department</label><input id="department" name="department" required maxlength="80"></div></div>
      <label for="phone">Phone</label><input id="phone" name="phone" type="tel" maxlength="40">
      <p class="mut">Hospital Admin accounts can only be created by the System Admin.</p>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
      <p><button class="primary" type="submit">Create &amp; send activation invitation</button></p></form>`);
  }

  function hStaffDetailView(id) {
    const u = S.staffMember(id);
    if (!u) return shell('staff', '<h1>Staff member not found</h1><a href="#/staff">Back</a>');
    const me = S.session();
    const editable = u.role !== 'Hospital Admin';
    const logs = S.hospitalAudit().filter((l) => l.actor === u.email || l.action.includes(u.email)).slice(0, 8);
    const acts = [];
    if (u.status === 'pending') acts.push(`<button data-action="resendStaff" data-id="${esc(id)}">Resend invitation</button>`);
    if (editable && u.id !== me.id) {
      if (u.status === 'active') acts.push(`<button class="danger" data-action="suspendStaff" data-id="${esc(id)}">Suspend</button>`, `<button data-action="resetStaff" data-id="${esc(id)}">Force password reset</button>`);
      if (u.status === 'suspended') acts.push(`<button class="primary" data-action="activateStaff" data-id="${esc(id)}">Reactivate</button>`);
    }
    return shell('staff', `<h1>${esc(u.name)} ${badge(u.status)}</h1>
      <p><a class="btn" href="#/staff">← All staff</a></p>
      <div class="two"><div class="card"><h2>Account</h2><dl class="kv">
        <dt>Email</dt><dd>${esc(u.email)}</dd><dt>Role</dt><dd>${esc(u.role)}</dd><dt>Department</dt><dd>${esc(u.department)}</dd><dt>Phone</dt><dd>${esc(u.phone) || '—'}</dd>
        <dt>Created</dt><dd>${fmt(u.createdAt)}</dd><dt>Last login</dt><dd>${fmt(u.lastLogin)}</dd>
        <dt>Activation</dt><dd>${u.invite ? 'Invitation valid until ' + fmt(u.invite.expiresAt) : 'Complete'}</dd></dl>
        <div class="actions mt">${acts.join('')}</div>
        ${u.invite ? `<div class="linkbox">${esc(S.inviteLink(u))}</div>` : ''}</div>
      ${editable ? `<form class="card" data-form="editStaff"><h2>Edit details</h2><input type="hidden" name="id" value="${esc(id)}">
        <label for="role">Role</label><select id="role" name="role">${S.STAFF_ROLES.map((r) => `<option ${r === u.role ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
        <label for="department">Department</label><input id="department" name="department" value="${esc(u.department)}" required maxlength="80">
        <label for="phone">Phone</label><input id="phone" name="phone" value="${esc(u.phone)}" maxlength="40">
        <p><button class="primary" type="submit">Save</button></p></form>` : '<div class="card"><p class="mut">Hospital Admin accounts are managed by the System Admin.</p></div>'}</div>
      <div class="card"><h2>Related activity</h2>${logTable(logs, true)}</div>`);
  }

  let hAuditF = { category: '', outcome: '', q: '', from: '', to: '' };
  function hAuditRows() {
    const f = hAuditF;
    return S.hospitalAudit().filter((l) => (!f.category || l.category === f.category) && (!f.outcome || l.outcome === f.outcome) &&
      (!f.q || (l.action + l.actor).toLowerCase().includes(f.q.toLowerCase())) &&
      (!f.from || new Date(l.ts) >= new Date(f.from)) && (!f.to || new Date(l.ts) <= new Date(f.to + 'T23:59:59')));
  }
  function hAuditView() {
    const opt = (list, cur, all) => `<option value="">${all}</option>` + list.map((v) => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
    const rows = hAuditRows();
    return shell('audit', `<h1>Hospital Audit Logs</h1>
      <div class="toolbar"><input data-hf="q" type="search" placeholder="Search event/actor" value="${esc(hAuditF.q)}" aria-label="Search">
        <select data-hf="category" aria-label="Category">${opt(['login', 'access', 'account', 'security', 'emergency', 'clinical', 'report'], hAuditF.category, 'All categories')}</select>
        <select data-hf="outcome" aria-label="Outcome">${opt(['success', 'failure', 'warning'], hAuditF.outcome, 'All outcomes')}</select>
        <input data-hf="from" type="date" value="${esc(hAuditF.from)}" aria-label="From"><input data-hf="to" type="date" value="${esc(hAuditF.to)}" aria-label="To"></div>
      <div class="card">${logTable(rows, true)}<p class="mut">${rows.length} event(s) for your hospital. Logs are read-only.</p></div>`);
  }

  let flashErr = '';
  async function render() {
    await S.ready();
    if (!guard('hospitaladmin')) return;
    S.touch();
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    let html;
    if (parts[0] === undefined) { location.replace('#/dashboard'); return; }
    if (parts[0] === 'dashboard') html = hDashboardView();
    else if (parts[0] === 'profile') html = hProfileView();
    else if (parts[0] === 'audit') html = hAuditView();
    else if (parts[0] === 'staff' && parts[1] === 'new') html = hAddStaffView(flashErr);
    else if (parts[0] === 'staff' && parts[1]) html = hStaffDetailView(parts[1]);
    else if (parts[0] === 'staff') html = hStaffView();
    else html = shell('', '<h1>Page not found</h1>');
    flashErr = '';
    $app.innerHTML = html;
  }

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    switch (form.dataset.form) {
      case 'profile': S.updateProfile(d); toast('Profile updated'); render(); break;
      case 'addStaff': {
        const r = S.addStaff(d);
        if (r.ok) $app.innerHTML = hAddStaffView('', r.user); else { flashErr = r.error; render(); }
        break;
      }
      case 'editStaff': S.updateStaff(d.id, d) ? toast('Saved') : toast('Not allowed'); render(); break;
    }
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.action) {
      case 'logout': S.logout(); location.href = '/'; break;
      case 'resendStaff': S.resendStaffInvite(id); toast('Invitation regenerated'); render(); break;
      case 'suspendStaff': if (confirm('Suspend this staff member?')) { S.setStaffStatus(id, 'suspended'); render(); } break;
      case 'activateStaff': S.setStaffStatus(id, 'active'); render(); break;
      case 'resetStaff': S.staffForceReset(id) && toast('Password reset required at next login'); break;
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    const v = (i) => document.getElementById(i).value;
    if (t.id === 'sq' || t.id === 'ss' || t.id === 'sr') refocus(hStaffView(v('sq'), v('ss'), v('sr')), '#' + t.id);
    else if (t.dataset && t.dataset.hf) { hAuditF[t.dataset.hf] = t.value; refocus(hAuditView(), `[data-hf="${t.dataset.hf}"]`); }
  });

  window.addEventListener('hashchange', render);
  render();
})();
