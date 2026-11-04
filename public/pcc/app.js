(function () {
  const { $app, S, esc, fmt, badge, toast, logTable, guard, refocus } = window.UI;

  const SLUG = { doctor: 'Doctor', nurse: 'Nurse', 'lab-technician': 'Lab Technician', pharmacist: 'Pharmacist' };
  const NAV = [
    ['dashboard', 'Dashboard'], ['patients/new', 'Register New Patient'], ['patients', 'Patient List'],
    ['staff/new/doctor', 'Create Doctor Account'], ['staff/new/nurse', 'Create Nurse Account'],
    ['staff/new/lab-technician', 'Create Lab Technician Account'], ['staff/new/pharmacist', 'Create Pharmacist Account'],
    ['staff', 'Staff List'],
  ];
  const shell = (active, html) => {
    const h = S.myHospital();
    return window.UI.shell(NAV, (h ? h.name : 'Hospital') + ' – Patient Care Coordinator', active, html);
  };
  const age = (dob) => { const d = new Date(dob), n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--; return a; };
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : '—');

  function dashboardView() {
    const pts = S.patients(), st = S.pccStaff();
    const week = Date.now() - 7 * 864e5;
    return shell('dashboard', `<h1>Patient Care Coordination</h1>
      <div class="grid">
        <div class="stat"><b>${pts.length}</b><span>Registered patients</span></div>
        <div class="stat"><b>${pts.filter((p) => new Date(p.createdAt) > week).length}</b><span>Registered (7 days)</span></div>
        <div class="stat"><b>${pts.filter((p) => p.status === 'pending').length}</b><span>Patient invitations pending</span></div>
        <div class="stat"><b>${st.filter((u) => u.status === 'active').length}</b><span>Active clinical staff</span></div>
        <div class="stat"><b>${st.filter((u) => u.status === 'pending').length}</b><span>Staff awaiting activation</span></div>
      </div>
      <div class="actions card"><a class="btn primary" href="#/patients/new">Register new patient</a><a class="btn" href="#/patients">Patient list</a>
        <a class="btn" href="#/staff/new/doctor">Create doctor</a><a class="btn" href="#/staff/new/nurse">Create nurse</a>
        <a class="btn" href="#/staff/new/lab-technician">Create lab technician</a><a class="btn" href="#/staff/new/pharmacist">Create pharmacist</a>
        <a class="btn" href="#/staff">Staff list</a></div>
      <div class="two">
        <div class="card"><h2>Latest registrations</h2>${patientTable(pts.slice(0, 5))}</div>
        <div class="card"><h2>My recent activity</h2>${logTable(S.pccAudit().slice(0, 6), true)}</div>
      </div>`);
  }

  function patientTable(rows) {
    if (!rows.length) return '<p class="mut">No patients found.</p>';
    return `<div class="tablewrap"><table><thead><tr><th>HRID</th><th>Name</th><th>Age</th><th>Gender</th><th>Phone</th><th>Status</th><th>Registered</th><th></th></tr></thead><tbody>
      ${rows.map((p) => `<tr><td><code>${esc(p.hrid)}</code></td><td>${esc(p.name)}</td><td>${age(p.dob)}</td><td>${esc(p.gender)}</td><td>${esc(p.phone) || '—'}</td><td>${badge(p.status)}</td><td>${day(p.createdAt)}</td>
      <td><a class="btn sm" href="#/patients/${esc(p.id)}">Details</a></td></tr>`).join('')}</tbody></table></div>`;
  }

  function patientsView(q = '', st = '') {
    const ql = q.toLowerCase();
    const rows = S.patients().filter((p) => (!st || p.status === st) && (!q || (p.name + p.hrid + p.phone + p.email).toLowerCase().includes(ql)));
    return shell('patients', `<h1>Patient List</h1>
      <div class="toolbar"><input id="pq" type="search" placeholder="Search name, HRID, phone, email…" value="${esc(q)}" aria-label="Search">
        <select id="ps" aria-label="Status">${['', 'active', 'pending', 'registered'].map((s) => `<option value="${s}" ${s === st ? 'selected' : ''}>${s || 'All statuses'}</option>`).join('')}</select>
        <a class="btn primary" href="#/patients/new">+ Register new patient</a></div>
      <div class="card">${patientTable(rows)}<p class="mut">${rows.length} patient(s) registered through your hospital.</p></div>`);
  }

  function registerView(err, created) {
    if (created) {
      return shell('patients/new', `<h1>Patient registered</h1><div class="card">
        <p><b>${esc(created.name)}</b> was registered. Health Record ID (HRID):</p>
        <p class="big"><code>${esc(created.hrid)}</code></p>
        ${created.invite ? `<p>An account invitation was issued to <b>${esc(created.email)}</b>, valid until ${fmt(created.invite.expiresAt)}. The patient sets their own password.</p>
          <p class="mut">The link is also emailed to the registered address. You can share it manually too:</p><div class="linkbox">${esc(S.inviteLink(created))}</div>`
          : '<p class="mut">No email was provided, so no patient account was created. The patient is identified by HRID only.</p>'}
        <p class="actions"><a class="btn primary" href="#/patients/${esc(created.id)}">View details</a><a class="btn" href="#/patients/new">Register another</a></p></div>`);
    }
    const f = (id, label, type = 'text', req = false, extra = '') => `<div><label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" ${req ? 'required' : ''} maxlength="120" ${extra}></div>`;
    const today = new Date().toISOString().slice(0, 10);
    return shell('patients/new', `<h1>Register New Patient</h1><form class="card" data-form="patient">
      <div class="formrow">${f('name', 'Full name', 'text', true)}${f('dob', 'Date of birth', 'date', true, `max="${today}"`)}</div>
      <div class="formrow"><div><label for="gender">Gender</label><select id="gender" name="gender" required><option value="">Select…</option><option>Female</option><option>Male</option><option>Other</option></select></div>
        ${f('phone', 'Phone', 'tel')}</div>
      ${f('email', 'Email (optional – creates a patient account invitation)', 'email')}
      ${f('address', 'Address')}
      <h2 class="mut">Emergency contact</h2>
      <div class="formrow">${f('emergencyName', 'Name')}${f('emergencyPhone', 'Phone', 'tel')}</div>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
      <p><button class="primary" type="submit">Register &amp; generate HRID</button></p></form>`);
  }

  function patientDetailView(id) {
    const p = S.patient(id);
    if (!p) return shell('patients', '<h1>Patient not found</h1><a href="#/patients">Back</a>');
    return shell('patients', `<h1>${esc(p.name)} ${badge(p.status)}</h1>
      <p><a class="btn" href="#/patients">← Patient list</a></p>
      <div class="two"><div class="card"><h2>Registration information</h2><dl class="kv">
        <dt>HRID</dt><dd><code>${esc(p.hrid)}</code></dd><dt>Date of birth</dt><dd>${day(p.dob)} (age ${age(p.dob)})</dd><dt>Gender</dt><dd>${esc(p.gender)}</dd>
        <dt>Phone</dt><dd>${esc(p.phone) || '—'}</dd><dt>Email</dt><dd>${esc(p.email) || '—'}</dd><dt>Address</dt><dd>${esc(p.address) || '—'}</dd>
        <dt>Emergency contact</dt><dd>${esc(p.emergencyName) || '—'} ${esc(p.emergencyPhone)}</dd>
        <dt>Registered</dt><dd>${fmt(p.createdAt)} by ${esc(p.registeredBy)}</dd>
        <dt>Account</dt><dd>${p.status === 'active' ? 'Active' : p.status === 'pending' ? 'Invitation valid until ' + fmt(p.invite && p.invite.expiresAt) : 'No account (HRID only)'}</dd></dl>
        <p class="mut">Clinical records are not available in this workspace.</p></div>
      ${p.status === 'pending' ? `<div class="card"><h2>Account invitation</h2><button data-action="resendPatient" data-id="${esc(id)}">Regenerate / resend invitation</button><div class="linkbox">${esc(S.inviteLink(p))}</div></div>` : ''}</div>`);
  }

  function addStaffView(slug, err, created) {
    const role = SLUG[slug];
    if (!role) return shell('', '<h1>Page not found</h1>');
    const active = 'staff/new/' + slug;
    if (created) {
      return shell(active, `<h1>${esc(role)} account created</h1><div class="card">
        <p><b>${esc(created.name)}</b> was created with status ${badge('pending')}. A password-setup invitation was issued to <b>${esc(created.email)}</b>, valid until ${fmt(created.invite.expiresAt)}.
        The staff member sets their own password.</p>
        <p class="mut">The link is also emailed to the registered address. You can share it manually too:</p><div class="linkbox">${esc(S.inviteLink(created))}</div>
        <p class="actions"><a class="btn primary" href="#/staff">Staff list</a><a class="btn" href="#/${active}">Create another</a></p></div>`);
    }
    return shell(active, `<h1>Create ${esc(role)} Account</h1><form class="card" data-form="addStaff"><input type="hidden" name="role" value="${esc(role)}">
      <div class="formrow"><div><label for="name">Full name</label><input id="name" name="name" required maxlength="100"></div>
      <div><label for="email">Work email</label><input id="email" name="email" type="email" required maxlength="120"></div></div>
      <div class="formrow"><div><label for="department">Department</label><input id="department" name="department" required maxlength="80"></div>
      <div><label for="phone">Phone</label><input id="phone" name="phone" type="tel" maxlength="40"></div></div>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
      <p><button class="primary" type="submit">Create &amp; send password-setup invitation</button></p></form>`);
  }

  function staffView(q = '', st = '', role = '') {
    const ql = q.toLowerCase();
    const rows = S.pccStaff().filter((u) => (!st || u.status === st) && (!role || u.role === role) && (!q || (u.name + u.email + u.department).toLowerCase().includes(ql)));
    const sel = (id, list, cur, all, label) => `<select id="${id}" aria-label="${label}"><option value="">${all}</option>${list.map((v) => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
    return shell('staff', `<h1>Staff List</h1>
      <div class="toolbar"><input id="sq" type="search" placeholder="Search name, email, department…" value="${esc(q)}" aria-label="Search">
        ${sel('ss', ['active', 'pending', 'suspended'], st, 'All statuses', 'Status')}${sel('sr', S.PCC_ROLES, role, 'All roles', 'Role')}</div>
      <div class="card">${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>
        ${rows.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(u.department)}</td><td>${badge(u.status === 'suspended' ? 'inactive' : u.status)}</td><td>${fmt(u.lastLogin)}</td>
        <td>${u.status !== 'suspended' ? `<button class="sm danger" data-action="deactivate" data-id="${esc(u.id)}">Deactivate</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">No staff found.</p>'}
        <p class="mut">Deactivated accounts can only be reactivated by the Hospital Admin.</p></div>`);
  }

  let flashErr = '';
  async function render() {
    await S.ready();
    if (!guard('pcc')) return;
    S.touch();
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    let html;
    if (parts[0] === undefined) { location.replace('#/dashboard'); return; }
    if (parts[0] === 'dashboard') html = dashboardView();
    else if (parts[0] === 'patients' && parts[1] === 'new') html = registerView(flashErr);
    else if (parts[0] === 'patients' && parts[1]) html = patientDetailView(parts[1]);
    else if (parts[0] === 'patients') html = patientsView();
    else if (parts[0] === 'staff' && parts[1] === 'new') html = addStaffView(parts[2], flashErr);
    else if (parts[0] === 'staff') html = staffView();
    else html = shell('', '<h1>Page not found</h1>');
    flashErr = '';
    $app.innerHTML = html;
  }

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    if (form.dataset.form === 'patient') {
      const r = S.registerPatient(d);
      if (r.ok) $app.innerHTML = registerView('', r.patient); else { flashErr = r.error; render(); }
    } else if (form.dataset.form === 'addStaff') {
      const r = S.pccAddStaff(d);
      const slug = Object.keys(SLUG).find((k) => SLUG[k] === d.role);
      if (r.ok) $app.innerHTML = addStaffView(slug, '', r.user); else { flashErr = r.error; render(); }
    }
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.action) {
      case 'logout': S.logout(); location.href = '/'; break;
      case 'resendPatient': S.resendPatientInvite(id); toast('Invitation regenerated'); render(); break;
      case 'deactivate': if (confirm('Deactivate this staff account? They will lose access immediately.')) { S.pccDeactivate(id); toast('Staff deactivated'); render(); } break;
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    const v = (i) => document.getElementById(i).value;
    if (t.id === 'pq' || t.id === 'ps') refocus(patientsView(v('pq'), v('ps')), '#' + t.id);
    else if (t.id === 'sq' || t.id === 'ss' || t.id === 'sr') refocus(staffView(v('sq'), v('ss'), v('sr')), '#' + t.id);
  });

  window.addEventListener('hashchange', render);
  render();
})();
