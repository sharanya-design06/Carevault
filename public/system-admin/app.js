(function () {
  const { $app, S, esc, fmt, badge, hname, toast, logTable, csv, guard, refocus } = window.UI;

  const NAV = [
    ['dashboard', 'Dashboard'], ['hospitals', 'Hospitals'], ['hospitals/new', 'Register Hospital'],
    ['users', 'User Management'], ['audit', 'Global Audit Logs'], ['config', 'System Configuration'],
  ];
  const shell = (active, html) => window.UI.shell(NAV, 'System Admin Console', active, html);

  function dashboardView() {
    const hs = S.hospitals(), us = S.users(), logs = S.audit();
    const c = (arr, k, v) => arr.filter((x) => x[k] === v).length;
    const day = Date.now() - 864e5;
    const recent = logs.filter((l) => new Date(l.ts).getTime() > day);
    const alerts = logs.filter((l) => l.outcome !== 'success').slice(0, 5);
    return shell('dashboard', `<h1>Dashboard</h1>
      ${S.config().maintenanceMode ? '<div class="card"><span class="badge warning">Maintenance mode is ON</span></div>' : ''}
      <div class="grid">
        <div class="stat"><b>${hs.length}</b><span>Hospitals</span></div>
        <div class="stat"><b>${c(hs, 'status', 'active')}</b><span>Active</span></div>
        <div class="stat"><b>${c(hs, 'status', 'pending')}</b><span>Pending setup</span></div>
        <div class="stat"><b>${c(hs, 'status', 'inactive')}</b><span>Inactive</span></div>
        <div class="stat"><b>${us.length}</b><span>Platform users</span></div>
        <div class="stat"><b>${recent.length}</b><span>Events (24h)</span></div>
        <div class="stat"><b>${recent.filter((l) => l.outcome === 'failure').length}</b><span>Failures (24h)</span></div>
      </div>
      <div class="actions card"><a class="btn primary" href="#/hospitals/new">Register hospital</a>
        <a class="btn" href="#/hospitals">Manage hospitals</a><a class="btn" href="#/users">Manage users</a>
        <a class="btn" href="#/audit">View audit logs</a><a class="btn" href="#/config">System configuration</a></div>
      <div class="two">
        <div class="card"><h2>Recent activity</h2>${logTable(logs.slice(0, 6), true)}</div>
        <div class="card"><h2>Security alerts</h2>${alerts.length ? logTable(alerts, true) : '<p class="mut">No alerts.</p>'}</div>
      </div>`);
  }

  function hospitalsView(q = '', st = '') {
    const rows = S.hospitals().filter((h) => (!st || h.status === st) && (!q || (h.name + h.code + h.city + h.email).toLowerCase().includes(q.toLowerCase())));
    return shell('hospitals', `<h1>Hospitals</h1>
      <div class="toolbar"><input id="hq" type="search" placeholder="Search name, code, city…" value="${esc(q)}" aria-label="Search">
        <select id="hs" aria-label="Status filter">${['', 'active', 'pending', 'inactive'].map((s) => `<option value="${s}" ${s === st ? 'selected' : ''}>${s || 'All statuses'}</option>`).join('')}</select>
        <a class="btn primary" href="#/hospitals/new">+ Register hospital</a></div>
      <div class="card tablewrap"><table><thead><tr><th>Name</th><th>Code</th><th>City</th><th>Status</th><th>Users</th><th>Registered</th><th></th></tr></thead><tbody>
      ${rows.map((h) => `<tr><td>${esc(h.name)}</td><td>${esc(h.code)}</td><td>${esc(h.city)}</td><td>${badge(h.status)}</td><td>${S.usersOf(h.id).length}</td><td>${fmt(h.createdAt)}</td>
        <td class="actions"><a class="btn sm" href="#/hospitals/${esc(h.id)}">Details</a><a class="btn sm" href="#/hospitals/${esc(h.id)}/manage">Manage</a></td></tr>`).join('') || '<tr><td colspan="7" class="mut">No hospitals found.</td></tr>'}
      </tbody></table></div>`);
  }

  function addHospitalView(err, created) {
    if (created) {
      return shell('hospitals/new', `<h1>Hospital registered</h1><div class="card">
        <p><b>${esc(created.name)}</b> was created with status ${badge('pending')}. A password-setup invitation was issued to <b>${esc(created.email)}</b>
        (valid until ${fmt(created.invite.expiresAt)}).</p>
        <p class="mut">The link is also emailed to the registered address. You can share it manually too:</p>
        <div class="linkbox">${esc(S.inviteLink(created))}</div>
        <p class="actions"><a class="btn primary" href="#/hospitals/${esc(created.id)}">View details</a><a class="btn" href="#/hospitals/new">Register another</a></p></div>`);
    }
    const f = (id, label, type = 'text', req = true) => `<div><label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" ${req ? 'required' : ''} maxlength="120"></div>`;
    return shell('hospitals/new', `<h1>Register Hospital</h1><form class="card" data-form="addHospital">
      <div class="formrow">${f('name', 'Hospital name')}${f('code', 'Hospital code (short, unique)')}</div>
      <div class="formrow">${f('licenseNo', 'License / registration no.')}${f('phone', 'Phone', 'tel')}</div>
      <div class="formrow">${f('address', 'Address')}${f('city', 'City')}</div>
      ${f('country', 'Country')}
      <h2 class="mut">Hospital administrator (receives invitation)</h2>
      <div class="formrow">${f('adminName', 'Admin full name')}${f('email', 'Admin email', 'email')}</div>
      ${f('username', 'Hospital username (optional; generated from the code if blank)', 'text', false)}
      <p class="mut">No password is set here. The hospital receives a secure link and creates its own password.</p>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
      <p><button class="primary" type="submit">Create &amp; send invitation</button></p></form>`);
  }

  function hospitalDetailView(id) {
    const h = S.hospital(id);
    if (!h) return shell('hospitals', '<h1>Hospital not found</h1><a href="#/hospitals">Back</a>');
    const logs = S.audit().filter((l) => l.hospitalId === id).slice(0, 8);
    return shell('hospitals', `<h1>${esc(h.name)} ${badge(h.status)}</h1>
      <p class="actions"><a class="btn" href="#/hospitals">← All hospitals</a><a class="btn primary" href="#/hospitals/${esc(id)}/manage">Manage</a></p>
      <div class="two"><div class="card"><h2>Hospital information</h2><dl class="kv">
        <dt>Code</dt><dd>${esc(h.code)}</dd><dt>License no.</dt><dd>${esc(h.licenseNo)}</dd><dt>Address</dt><dd>${esc(h.address)}, ${esc(h.city)}, ${esc(h.country)}</dd>
        <dt>Phone</dt><dd>${esc(h.phone)}</dd><dt>Admin</dt><dd>${esc(h.adminName)} (${esc(h.email)})</dd><dt>Username</dt><dd>${esc(h.username || '')}</dd>
        <dt>Registered</dt><dd>${fmt(h.createdAt)}</dd>
        <dt>Account</dt><dd>${h.invite ? 'Invitation pending until ' + fmt(h.invite.expiresAt) : 'Password set'}</dd></dl></div>
      <div class="card"><h2>Associated users</h2>${userTable(S.usersOf(id), false)}</div></div>
      <div class="card"><h2>Recent administrative activity</h2>${logTable(logs, true)}</div>`);
  }

  function manageView(id) {
    const h = S.hospital(id);
    if (!h) return shell('hospitals', '<h1>Hospital not found</h1>');
    const canActivate = !h.invite;
    return shell('hospitals', `<h1>Manage: ${esc(h.name)} ${badge(h.status)}</h1>
      <p><a class="btn" href="#/hospitals/${esc(id)}">← Details</a></p>
      <div class="card"><h2>Access</h2>
        <p class="mut">Deactivating blocks all hospital users from signing in. Data is retained.</p>
        <div class="actions">
          ${h.status === 'active' ? `<button class="danger" data-action="deactivate" data-id="${esc(id)}">Deactivate hospital</button>`
            : `<button class="primary" data-action="activate" data-id="${esc(id)}" ${canActivate ? '' : 'disabled'}>Activate hospital</button>`}
        </div>${canActivate ? '' : '<p class="mut">Can be activated once the administrator completes password setup.</p>'}</div>
      ${h.invite ? `<div class="card"><h2>Invitation</h2><p>Expires ${fmt(h.invite.expiresAt)}.</p>
        <button data-action="resend" data-id="${esc(id)}">Regenerate / resend invitation</button><div class="linkbox">${esc(S.inviteLink(h))}</div></div>` : ''}
      <form class="card" data-form="editHospital"><h2>Contact details</h2><input type="hidden" name="id" value="${esc(id)}">
        <div class="formrow"><div><label for="phone">Phone</label><input id="phone" name="phone" value="${esc(h.phone)}" required></div>
        <div><label for="address">Address</label><input id="address" name="address" value="${esc(h.address)}" required></div></div>
        <p><button class="primary" type="submit">Save</button></p></form>
      <div class="card"><h2>Hospital users</h2>${userTable(S.usersOf(id), true)}</div>`);
  }

  function userTable(users, withActions) {
    if (!users.length) return '<p class="mut">No users.</p>';
    return `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Hospital</th><th>Status</th><th>Last login</th>${withActions ? '<th></th>' : ''}</tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${hname(u.hospitalId)}</td><td>${badge(u.status)}</td><td>${fmt(u.lastLogin)}</td>
      ${withActions ? `<td class="actions"><button class="sm" data-action="${u.status === 'active' ? 'suspendUser' : 'activateUser'}" data-id="${esc(u.id)}">${u.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
        <button class="sm" data-action="forceReset" data-id="${esc(u.id)}">Force reset</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
  }

  function usersView(q = '', st = '') {
    const rows = S.users().filter((u) => (!st || u.status === st) && (!q || (u.name + u.email + u.role).toLowerCase().includes(q.toLowerCase())));
    return shell('users', `<h1>User Management</h1>
      <p class="mut">System Admin can suspend/reactivate accounts and force password resets. Clinical data is not accessible here.</p>
      <div class="toolbar"><input id="uq" type="search" placeholder="Search name, email, role…" value="${esc(q)}" aria-label="Search">
        <select id="us" aria-label="Status">${['', 'active', 'suspended'].map((s) => `<option value="${s}" ${s === st ? 'selected' : ''}>${s || 'All statuses'}</option>`).join('')}</select></div>
      <div class="card">${userTable(rows, true)}</div>`);
  }

  function auditFilterRows(f) {
    return S.audit().filter((l) =>
      (!f.category || l.category === f.category) && (!f.outcome || l.outcome === f.outcome) &&
      (!f.hospital || l.hospitalId === f.hospital) &&
      (!f.q || (l.action + l.actor).toLowerCase().includes(f.q.toLowerCase())) &&
      (!f.from || new Date(l.ts) >= new Date(f.from)) && (!f.to || new Date(l.ts) <= new Date(f.to + 'T23:59:59')));
  }
  let auditF = { category: '', outcome: '', hospital: '', q: '', from: '', to: '' };

  function auditView() {
    const opt = (list, cur, all) => `<option value="">${all}</option>` + list.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const rows = auditFilterRows(auditF);
    return shell('audit', `<h1>Global Audit Logs</h1>
      <div class="toolbar" id="auditbar">
        <input data-f="q" type="search" placeholder="Search event/actor" value="${esc(auditF.q)}" aria-label="Search">
        <select data-f="category" aria-label="Category">${opt(['login', 'access', 'account', 'security', 'emergency', 'clinical', 'report'].map((x) => [x, x]), auditF.category, 'All categories')}</select>
        <select data-f="outcome" aria-label="Outcome">${opt(['success', 'failure', 'warning'].map((x) => [x, x]), auditF.outcome, 'All outcomes')}</select>
        <select data-f="hospital" aria-label="Hospital">${opt(S.hospitals().map((h) => [h.id, h.name]), auditF.hospital, 'All hospitals')}</select>
        <input data-f="from" type="date" value="${esc(auditF.from)}" aria-label="From"><input data-f="to" type="date" value="${esc(auditF.to)}" aria-label="To">
        <button data-action="exportAudit">Export CSV</button></div>
      <div class="card">${logTable(rows, false)}<p class="mut">${rows.length} event(s). Logs are read-only.</p></div>`);
  }

  function configView() {
    const c = S.config();
    const num = (k, l, min, max) => `<div><label for="${k}">${l}</label><input id="${k}" name="${k}" type="number" min="${min}" max="${max}" value="${esc(c[k])}" required></div>`;
    return shell('config', `<h1>System Configuration</h1><form class="card" data-form="config">
      <div class="formrow">${num('sessionTimeoutMin', 'Session timeout (minutes)', 5, 240)}${num('minPasswordLength', 'Minimum password length', 8, 64)}</div>
      <div class="formrow">${num('maxFailedLogins', 'Max failed logins before lockout', 3, 20)}${num('lockoutMin', 'Lockout duration (minutes)', 1, 1440)}</div>
      <div class="formrow">${num('inviteExpiryDays', 'Invitation validity (days)', 1, 30)}${num('auditRetentionDays', 'Audit log retention (days)', 90, 3650)}</div>
      <label for="supportEmail">Support email</label><input id="supportEmail" name="supportEmail" type="email" value="${esc(c.supportEmail)}" required>
      <label class="check"><input type="checkbox" name="requireMfa" ${c.requireMfa ? 'checked' : ''}>Require multi-factor authentication for admins</label>
      <label class="check"><input type="checkbox" name="maintenanceMode" ${c.maintenanceMode ? 'checked' : ''}>Maintenance mode (blocks hospital sign-ins)</label>
      <p><button class="primary" type="submit">Save configuration</button> <button type="button" data-action="resetDemo">Reset demo data</button></p></form>`);
  }

  let flashErr = '';
  async function render() {
    await S.ready();
    if (!guard('sysadmin')) return;
    S.touch();
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    let html;
    switch (parts[0]) {
      case undefined: location.replace('#/dashboard'); return;
      case 'dashboard': html = dashboardView(); break;
      case 'hospitals':
        if (parts[1] === 'new') html = addHospitalView(flashErr);
        else if (parts[1] && parts[2] === 'manage') html = manageView(parts[1]);
        else if (parts[1]) html = hospitalDetailView(parts[1]);
        else html = hospitalsView();
        break;
      case 'users': html = usersView(); break;
      case 'audit': html = auditView(); break;
      case 'config': html = configView(); break;
      default: html = shell('', '<h1>Page not found</h1>');
    }
    flashErr = '';
    $app.innerHTML = html;
  }

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    switch (form.dataset.form) {
      case 'addHospital': {
        const r = S.addHospital(d);
        if (r.ok) $app.innerHTML = addHospitalView('', r.hospital); else { flashErr = r.error; render(); }
        break;
      }
      case 'editHospital': S.updateHospital(d.id, { phone: d.phone.trim(), address: d.address.trim() }); toast('Saved'); render(); break;
      case 'config': {
        const cfg = {};
        ['sessionTimeoutMin', 'minPasswordLength', 'maxFailedLogins', 'lockoutMin', 'inviteExpiryDays', 'auditRetentionDays'].forEach((k) => { cfg[k] = Math.max(1, parseInt(d[k], 10) || 1); });
        cfg.supportEmail = d.supportEmail.trim(); cfg.requireMfa = 'requireMfa' in d; cfg.maintenanceMode = 'maintenanceMode' in d;
        S.saveConfig(cfg); toast('Configuration saved'); break;
      }
    }
  });

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.action) {
      case 'logout': S.logout(); location.href = '/'; break;
      case 'activate': S.setStatus(id, 'active') ? toast('Hospital activated') : toast('Cannot activate yet'); render(); break;
      case 'deactivate': if (confirm('Deactivate this hospital? All its users will lose access.')) { S.setStatus(id, 'inactive'); toast('Hospital deactivated'); render(); } break;
      case 'resend': S.resendInvite(id); toast('Invitation regenerated'); render(); break;
      case 'suspendUser': if (confirm('Suspend this user?')) { S.setUserStatus(id, 'suspended'); render(); } break;
      case 'activateUser': S.setUserStatus(id, 'active'); render(); break;
      case 'forceReset': S.forceReset(id); toast('Password reset required at next login'); break;
      case 'exportAudit': {
        S.logExport();
        const url = URL.createObjectURL(new Blob([csv(auditFilterRows(auditF))], { type: 'text/csv' }));
        const a = document.createElement('a'); a.href = url; a.download = 'audit-logs.csv'; a.click(); URL.revokeObjectURL(url); break;
      }
      case 'resetDemo': if (confirm('Reset all demo data?')) { await S.resetDemo(); S.logout(); location.href = '/'; } break;
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'hq' || t.id === 'hs') refocus(hospitalsView(document.getElementById('hq').value, document.getElementById('hs').value), '#' + t.id);
    else if (t.id === 'uq' || t.id === 'us') refocus(usersView(document.getElementById('uq').value, document.getElementById('us').value), '#' + t.id);
    else if (t.dataset && t.dataset.f) { auditF[t.dataset.f] = t.value; refocus(auditView(), `[data-f="${t.dataset.f}"]`); }
  });

  window.addEventListener('hashchange', render);
  render();
})();
