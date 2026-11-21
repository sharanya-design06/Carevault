// Hospital Admin dashboard backed by Firebase sign-in and server-authorized callables (active when firebaseLogin is enabled).
(function () {
  const FS = window.FirebaseSession;
  if (!FS || !FS.enabled) return;
  const { $app, esc, badge, toast, guard } = window.UI;

  const ROLES = ['PCC', 'DOCTOR', 'LAB', 'PHARMACIST', 'NURSE'];
  const SUBTYPES = {
    DOCTOR: ['GENERAL_PRIMARY', 'SPECIALIST', 'SURGEON', 'RADIOLOGIST', 'PATHOLOGIST', 'ANESTHETIST'],
    LAB: ['SAMPLE_PHLEBOTOMY', 'PATHOLOGY_BIOCHEMISTRY', 'RADIOLOGY', 'MICROBIOLOGY'],
  };
  const NAV = [['dashboard', 'Dashboard'], ['profile', 'Hospital Profile'], ['staff', 'Staff'], ['staff/new', 'Create Staff Account'], ['audit', 'Audit Logs']];
  const shell = (active, html) => window.UI.shell(NAV, 'Hospital Admin', active, html);
  const label = (v) => String(v || '').replace(/_/g, ' ').toLowerCase();
  const message = (e) => (e && e.message === 'Signed out' ? null : (e && e.message) || 'Request failed.');
  let flash = '';

  function dashboardView(hospital, staff) {
    const count = (s) => staff.filter((u) => u.status === s).length;
    const roles = {};
    staff.forEach((u) => { roles[u.role] = (roles[u.role] || 0) + 1; });
    return shell('dashboard', `<h1>${esc(hospital ? hospital.name : 'Hospital')}</h1><div class="grid">
      <div class="stat"><b>${staff.length}</b><span>Total staff</span></div><div class="stat"><b>${count('active')}</b><span>Active</span></div>
      <div class="stat"><b>${count('inactive')}</b><span>Inactive</span></div></div>
      <div class="actions card"><a class="btn primary" href="#/staff/new">Create staff account</a><a class="btn" href="#/staff">Manage staff</a><a class="btn" href="#/audit">Audit logs</a></div>
      <div class="card"><h2>Staff by role</h2>${Object.keys(roles).length ? `<table><tbody>${Object.entries(roles).map(([r, n]) => `<tr><td>${esc(label(r))}</td><td>${n}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">No staff.</p>'}</div>`);
  }

  function profileView(h) {
    if (!h) return shell('profile', '<h1>Hospital Profile</h1><p class="mut">Hospital not found.</p>');
    const row = (l, v) => `<dt>${l}</dt><dd>${esc(v)}</dd>`;
    return shell('profile', `<h1>Hospital Profile</h1><div class="card"><p class="mut">Managed by the platform System Admin.</p><dl class="kv">
      ${row('Name', h.name)}${row('Code', h.code)}${row('License no.', h.licenseNo)}${row('Phone', h.phone)}${row('Address', h.address + ', ' + h.city + ', ' + h.country)}<dt>Status</dt><dd>${badge(h.status)}</dd></dl></div>`);
  }

  function staffView(staff) {
    return shell('staff', `<h1>Staff</h1><div class="card">${staff.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      ${staff.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(label(u.role))}${u.subType ? ' (' + esc(label(u.subType)) + ')' : ''}</td><td>${badge(u.status === 'inactive' ? 'inactive' : 'active')}</td>
      <td>${u.status === 'active'
        ? `<button class="sm" data-action="invite" data-id="${esc(u.uid)}">Resend setup email</button> <button class="sm danger" data-action="status" data-status="inactive" data-id="${esc(u.uid)}">Deactivate</button>`
        : `<button class="sm primary" data-action="status" data-status="active" data-id="${esc(u.uid)}">Reactivate</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">No staff found.</p>'}</div>`);
  }

  function addStaffView(err, created) {
    if (created) {
      return shell('staff/new', `<h1>Staff account created</h1><div class="card"><p>${created.emailed ? 'A password-setup email was sent.' : '<span class="err" role="alert">The setup email could not be sent; use Resend from the staff list.</span>'}</p>
        <p class="actions"><a class="btn primary" href="#/staff">Staff list</a><a class="btn" href="#/staff/new">Create another</a></p></div>`);
    }
    return shell('staff/new', `<h1>Create Staff Account</h1><form class="card" data-form="addStaff">
      <div class="formrow"><div><label for="name">Full name</label><input id="name" name="name" required maxlength="100"></div>
      <div><label for="email">Work email</label><input id="email" name="email" type="email" required maxlength="120"></div></div>
      <div class="formrow"><div><label for="role">Role</label><select id="role" name="role" required>${ROLES.map((r) => `<option value="${r}">${esc(label(r))}</option>`).join('')}</select></div>
      <div><label for="subType">Specialty (doctor / lab only)</label><select id="subType" name="subType"><option value="">—</option>${[...new Set([...SUBTYPES.DOCTOR, ...SUBTYPES.LAB])].map((v) => `<option value="${v}">${esc(label(v))}</option>`).join('')}</select></div></div>
      <div class="formrow"><div><label for="username">Username (optional)</label><input id="username" name="username" maxlength="32" pattern="[a-z0-9][a-z0-9._-]{2,31}"></div></div>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
      <p><button class="primary" type="submit">Create &amp; send password-setup email</button></p></form>`);
  }

  function auditView(rows) {
    return shell('audit', `<h1>Hospital Audit Logs</h1><div class="card">${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Time</th><th>Event</th><th>By</th><th>Detail</th></tr></thead><tbody>
      ${rows.map((l) => `<tr><td>${esc(l.timestamp ? new Date(l.timestamp).toLocaleString() : '—')}</td><td>${esc(label(l.action))}</td><td>${esc(label(l.actorRole))}</td><td>${esc(label(l.targetRole || l.status || l.accessScope || ''))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">No events.</p>'}
      <p class="mut">Latest 100 events for your hospital. Read-only.</p></div>`);
  }

  async function render() {
    if (!guard('hospitaladmin')) return;
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (!parts.length) { location.replace('#/dashboard'); return; }
    const err = flash; flash = '';
    try {
      let html;
      if (parts[0] === 'dashboard') {
        const [hs, staff] = await Promise.all([FS.call('listDashboardHospitals'), FS.call('listDashboardUsers')]);
        html = dashboardView(hs[0], staff);
      } else if (parts[0] === 'profile') html = profileView((await FS.call('listDashboardHospitals'))[0]);
      else if (parts[0] === 'staff' && parts[1] === 'new') html = addStaffView(err);
      else if (parts[0] === 'staff') html = staffView(await FS.call('listDashboardUsers'));
      else if (parts[0] === 'audit') html = auditView(await FS.call('listDashboardAudit'));
      else html = shell('', '<h1>Page not found</h1>');
      $app.innerHTML = html;
    } catch (e) {
      const text = message(e);
      if (text === null) { location.replace('/'); return; }
      $app.innerHTML = shell('', `<h1>Unavailable</h1><div class="err" role="alert">${esc(text)}</div>`);
    }
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const { subType, username, ...rest } = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const created = await FS.call('createDashboardUser', {
        ...rest, hospitalId: FS.session().hospitalId,
        ...(subType ? { subType } : {}), ...(username ? { username } : {}),
      });
      let emailed = true;
      try { await FS.call('sendDashboardInvite', { uid: created.uid }); } catch (error) { emailed = false; }
      $app.innerHTML = addStaffView('', { emailed });
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
      } else if (b.dataset.action === 'status' && (b.dataset.status === 'active' || confirm('Deactivate this account? They will lose access immediately.'))) {
        await FS.call('setDashboardUserStatus', { uid: b.dataset.id, status: b.dataset.status });
        toast('Status updated'); render();
      }
    } catch (error) { toast(message(error) || 'Signed out'); }
  });

  window.addEventListener('hashchange', render);
  render();
})();
