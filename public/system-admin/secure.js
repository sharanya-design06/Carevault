// System Admin console backed by Firebase sign-in and server-authorized callables (active when firebaseLogin is enabled).
(function () {
  const FS = window.FirebaseSession;
  if (!FS || !FS.enabled) return;
  const { $app, esc, badge, toast, guard } = window.UI;

  const NAV = [['dashboard', 'Dashboard'], ['hospitals', 'Hospitals'], ['hospitals/new', 'Register Hospital'], ['admins', 'System Admins'], ['audit', 'Global Audit Logs']];
  const shell = (active, html) => window.UI.shell(NAV, 'System Admin Console', active, html);
  const label = (v) => String(v || '').replace(/_/g, ' ').toLowerCase();
  const message = (e) => (e && e.message === 'Signed out' ? null : (e && e.message) || 'Request failed.');
  const HOSPITAL_FIELDS = [['name', 'Hospital name'], ['code', 'Hospital code (letters, digits, hyphens)'], ['licenseNo', 'License / registration no.'], ['phone', 'Phone'], ['address', 'Address'], ['city', 'City'], ['country', 'Country']];
  let flash = '';

  function dashboardView(hospitals, admins, audit) {
    const count = (s) => hospitals.filter((h) => h.status === s).length;
    return shell('dashboard', `<h1>Dashboard</h1><div class="grid">
      <div class="stat"><b>${hospitals.length}</b><span>Hospitals</span></div><div class="stat"><b>${count('active')}</b><span>Active</span></div>
      <div class="stat"><b>${count('inactive')}</b><span>Inactive</span></div><div class="stat"><b>${admins.length}</b><span>System Admins</span></div></div>
      <div class="actions card"><a class="btn primary" href="#/hospitals/new">Register hospital</a><a class="btn" href="#/hospitals">Manage hospitals</a><a class="btn" href="#/admins">System Admins</a><a class="btn" href="#/audit">Audit logs</a></div>
      <div class="card"><h2>Recent activity</h2>${auditTable(audit.slice(0, 6))}</div>`);
  }

  function hospitalsView(hospitals, users) {
    const admins = users.filter((u) => u.role === 'HOSPITAL_ADMIN');
    return shell('hospitals', `<h1>Hospitals</h1><div class="card tablewrap"><table><thead><tr><th>Name</th><th>Code</th><th>City</th><th>Status</th><th>Hospital admins</th><th></th></tr></thead><tbody>
      ${hospitals.map((h) => `<tr><td>${esc(h.name)}</td><td>${esc(h.code)}</td><td>${esc(h.city)}</td><td>${badge(h.status === 'inactive' ? 'inactive' : 'active')}</td><td class="actions">
      ${admins.filter((u) => u.hospitalId === h.id).map((u) => `<div>${esc(u.name)} (${esc(u.email)}) ${u.status === 'active' && h.status === 'active' ? `<button class="sm" data-action="invite" data-id="${esc(u.uid)}">Resend setup email</button>` : badge('inactive')}</div>`).join('') || '<span class="mut">No Firebase administrator</span>'}</td><td class="actions">
      <a class="btn sm" href="#/hospitals/${esc(h.id)}/admin">Add admin</a>
      ${h.status === 'active' ? `<button class="sm danger" data-action="hospitalStatus" data-status="inactive" data-id="${esc(h.id)}">Deactivate</button>` : `<button class="sm primary" data-action="hospitalStatus" data-status="active" data-id="${esc(h.id)}">Activate</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="mut">No hospitals found.</td></tr>'}
      </tbody></table></div>`);
  }

  function registerHospitalView(err) {
    const f = ([id, text]) => `<div><label for="${id}">${text}</label><input id="${id}" name="${id}" required maxlength="120"></div>`;
    return shell('hospitals/new', `<h1>Register Hospital</h1><form class="card" data-form="addHospital">
      <div class="formrow">${HOSPITAL_FIELDS.slice(0, 2).map(f).join('')}</div><div class="formrow">${HOSPITAL_FIELDS.slice(2, 4).map(f).join('')}</div>
      <div class="formrow">${HOSPITAL_FIELDS.slice(4, 5).map(f).join('')}</div><div class="formrow">${HOSPITAL_FIELDS.slice(5).map(f).join('')}</div>
      <h2 class="mut">First Hospital Admin</h2><div class="formrow"><div><label for="adminName">Full name</label><input id="adminName" name="adminName" required maxlength="100"></div>
      <div><label for="adminEmail">Email</label><input id="adminEmail" name="adminEmail" type="email" required maxlength="120"></div></div>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
      <p><button class="primary" type="submit">Register &amp; send setup email</button></p></form>`);
  }

  function hospitalAdminView(id, err, done) {
    if (done) return shell('hospitals', `<h1>Hospital Admin created</h1><div class="card"><p>${done.emailed ? 'A password-setup email was sent.' : '<span class="err" role="alert">The setup email could not be sent. Check email configuration, then use Resend setup email on the Hospitals page.</span>'}</p><p><a class="btn primary" href="#/hospitals">Hospitals</a></p></div>`);
    return shell('hospitals', `<h1>Add Hospital Admin</h1><form class="card" data-form="addHospitalAdmin"><input type="hidden" name="hospitalId" value="${esc(id)}">
      <div class="formrow"><div><label for="name">Full name</label><input id="name" name="name" required maxlength="100"></div><div><label for="email">Email</label><input id="email" name="email" type="email" required maxlength="120"></div></div>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}<p><button class="primary" type="submit">Create &amp; send setup email</button></p></form>`);
  }

  function adminsView(admins, err, done) {
    return shell('admins', `<h1>System Admins</h1><p class="mut">System Admins have full platform access. Only invite people who need it.</p>
      ${done ? `<div class="card">${done.emailed ? 'A password-setup email was sent.' : '<span class="err" role="alert">The setup email could not be sent; use Resend.</span>'}</div>` : ''}
      <form class="card" data-form="addSystemAdmin"><h2>Add System Admin</h2><div class="formrow"><div><label for="name">Full name</label><input id="name" name="name" required maxlength="100"></div>
      <div><label for="email">Email</label><input id="email" name="email" type="email" required maxlength="120"></div></div>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}<p><button class="primary" type="submit">Create &amp; send setup email</button></p></form>
      <div class="card"><h2>All System Admins</h2><div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr></thead><tbody>
      ${admins.filter((u) => u.role === 'SYSTEM_ADMIN').map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${badge(u.status === 'inactive' ? 'inactive' : 'active')}</td><td>${u.uid === FS.session().id ? '<span class="mut">You</span>'
        : u.status === 'active' ? `<button class="sm" data-action="invite" data-id="${esc(u.uid)}">Resend setup email</button> <button class="sm danger" data-action="userStatus" data-status="inactive" data-id="${esc(u.uid)}">Deactivate</button>`
        : `<button class="sm primary" data-action="userStatus" data-status="active" data-id="${esc(u.uid)}">Reactivate</button>`}</td></tr>`).join('')}</tbody></table></div></div>`);
  }

  function auditTable(rows) {
    if (!rows.length) return '<p class="mut">No events.</p>';
    return `<div class="tablewrap"><table><thead><tr><th>Time</th><th>Event</th><th>By</th><th>Hospital</th><th>Detail</th></tr></thead><tbody>
      ${rows.map((l) => `<tr><td>${esc(l.timestamp ? new Date(l.timestamp).toLocaleString() : '—')}</td><td>${esc(label(l.action))}</td><td>${esc(label(l.actorRole))}</td><td>${esc(l.hospitalId || '—')}</td><td>${esc(label(l.targetRole || l.status || l.accessScope || ''))}</td></tr>`).join('')}</tbody></table></div>`;
  }

  async function render() {
    if (!guard('sysadmin')) return;
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (!parts.length) { location.replace('#/dashboard'); return; }
    const err = flash; flash = '';
    try {
      let html;
      if (parts[0] === 'dashboard') {
        const [hs, us, audit] = await Promise.all([FS.call('listDashboardHospitals'), FS.call('listDashboardUsers'), FS.call('listDashboardAudit')]);
        html = dashboardView(hs, us.filter((u) => u.role === 'SYSTEM_ADMIN'), audit);
      } else if (parts[0] === 'hospitals' && parts[1] === 'new') html = registerHospitalView(err);
      else if (parts[0] === 'hospitals' && parts[2] === 'admin') html = hospitalAdminView(parts[1], err);
      else if (parts[0] === 'hospitals') {
        const [hospitals, users] = await Promise.all([FS.call('listDashboardHospitals'), FS.call('listDashboardUsers')]);
        html = hospitalsView(hospitals, users);
      }
      else if (parts[0] === 'admins') html = adminsView(await FS.call('listDashboardUsers'), err);
      else if (parts[0] === 'audit') html = shell('audit', `<h1>Global Audit Logs</h1><div class="card">${auditTable(await FS.call('listDashboardAudit'))}<p class="mut">Latest 100 events. Read-only.</p></div>`);
      else html = shell('', '<h1>Page not found</h1>');
      $app.innerHTML = html;
    } catch (e) {
      const text = message(e);
      if (text === null) { location.replace('/'); return; }
      $app.innerHTML = shell('', `<h1>Unavailable</h1><div class="err" role="alert">${esc(text)}</div>`);
    }
  }

  async function createAdminAccount(role, fields) {
    const created = await FS.call('createDashboardUser', { ...fields, role });
    try { await FS.call('sendDashboardInvite', { uid: created.uid }); return { emailed: true }; } catch (error) { return { emailed: false }; }
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    form.querySelector('button[type="submit"]').disabled = true;
    const kind = form.dataset.form;
    try {
      if (kind === 'addHospital') {
        const { adminName, adminEmail, ...hospital } = d;
        const { id } = await FS.call('createDashboardHospital', hospital);
        const done = await createAdminAccount('HOSPITAL_ADMIN', { name: adminName, email: adminEmail, hospitalId: id });
        $app.innerHTML = hospitalAdminView(id, '', done);
      } else if (kind === 'addHospitalAdmin') {
        $app.innerHTML = hospitalAdminView(d.hospitalId, '', await createAdminAccount('HOSPITAL_ADMIN', d));
      } else if (kind === 'addSystemAdmin') {
        $app.innerHTML = adminsView(await FS.call('listDashboardUsers'), '', await createAdminAccount('SYSTEM_ADMIN', d));
      }
    } catch (error) {
      const text = message(error);
      if (text === null) { location.replace('/'); return; }
      flash = text; render();
    }
  });

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    if (b.dataset.action === 'logout') { FS.logout(); location.href = '/'; return; }
    try {
      if (b.dataset.action === 'invite') {
        b.disabled = true;
        await FS.call('sendDashboardInvite', { uid: b.dataset.id });
        toast('Setup email sent'); b.disabled = false;
      } else if (b.dataset.action === 'userStatus' && (b.dataset.status === 'active' || confirm('Deactivate this System Admin?'))) {
        await FS.call('setDashboardUserStatus', { uid: b.dataset.id, status: b.dataset.status });
        toast('Status updated'); render();
      } else if (b.dataset.action === 'hospitalStatus' && (b.dataset.status === 'active' || confirm('Deactivate this hospital? All its users lose access.'))) {
        await FS.call('setDashboardHospitalStatus', { id: b.dataset.id, status: b.dataset.status });
        toast('Hospital updated'); render();
      }
    } catch (error) {
      if (b.dataset.action === 'invite') b.disabled = false;
      toast(message(error) || 'Signed out');
    }
  });

  window.addEventListener('hashchange', render);
  render();
})();
