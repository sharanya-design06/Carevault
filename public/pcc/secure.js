// PCC dashboard backed by Firebase sign-in and server-authorized callables (active when firebaseLogin is enabled).
(function () {
  const FS = window.FirebaseSession;
  if (!FS || !FS.enabled) return;
  const { $app, esc, badge, toast, guard } = window.UI;

  const ROLES = { doctor: ['Doctor', 'DOCTOR'], nurse: ['Nurse', 'NURSE'], 'lab-technician': ['Lab Technician', 'LAB'], pharmacist: ['Pharmacist', 'PHARMACIST'] };
  const SUBTYPES = {
    DOCTOR: ['GENERAL_PRIMARY', 'SPECIALIST', 'SURGEON', 'RADIOLOGIST', 'PATHOLOGIST', 'ANESTHETIST'],
    LAB: ['SAMPLE_PHLEBOTOMY', 'PATHOLOGY_BIOCHEMISTRY', 'RADIOLOGY', 'MICROBIOLOGY'],
  };
  const NAV = [
    ['dashboard', 'Dashboard'], ['lookup', 'Check-In / Lookup'], ['patients/new', 'Register New Patient'], ['duplicates', 'Duplicate Review'], ['patients', 'Patient List'], ['billing', 'Billing Clearance'],
    ['staff/new/doctor', 'Create Doctor Account'], ['staff/new/nurse', 'Create Nurse Account'],
    ['staff/new/lab-technician', 'Create Lab Technician Account'], ['staff/new/pharmacist', 'Create Pharmacist Account'],
    ['staff', 'Staff List'],
  ];
  const shell = (active, html) => window.UI.shell(NAV, 'Patient Care Coordinator', active, html);
  const label = (v) => String(v || '').replace(/_/g, ' ').toLowerCase();
  const message = (e) => (e && e.message === 'Signed out' ? null : (e && e.message) || 'Request failed.');
  const newRequestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, '0')).join('');

  let registerRequestId = newRequestId();
  let flash = '';
  let lookupResult = null;

  function patientTable(rows) {
    if (!rows.length) return '<p class="mut">No patients found.</p>';
    return `<div class="tablewrap"><table><thead><tr><th>HRID</th><th>Name</th><th>Date of birth</th><th>Gender</th><th></th></tr></thead><tbody>
      ${rows.map((p) => `<tr><td><code>${esc(p.hrid)}</code></td><td>${esc(p.name)}${p.priorityCare ? ' <span class="badge" title="Priority Care">★ Priority Care</span>' : ''}</td><td>${esc(p.dob)}</td><td>${esc(p.gender)}</td>
      <td><a class="btn sm" href="#/patients/${esc(p.hrid)}">Details</a></td></tr>`).join('')}</tbody></table></div>`;
  }

  function dashboardView(patients, staff) {
    return shell('dashboard', `<h1>Patient Care Coordination</h1><div class="grid">
      <div class="stat"><b>${patients.length}</b><span>Registered patients (latest 50)</span></div>
      <div class="stat"><b>${staff.filter((u) => u.status === 'active').length}</b><span>Active clinical staff</span></div></div>
      <div class="card"><h2>Latest registrations</h2>${patientTable(patients.slice(0, 5))}</div>`);
  }

  function patientsView(patients) {
    return shell('patients', `<h1>Patient List</h1><div class="card">${patientTable(patients)}</div>`);
  }

  function registerView(err, created) {
    if (created) {
      return shell('patients/new', `<h1>Patient registered</h1><div class="card">
        <p>Health Record ID (HRID):</p><p class="big"><code>${esc(created.hrid)}</code></p>
        ${created.possibleDuplicates ? `<div class="alert warn" role="alert">${esc(created.possibleDuplicates)} possible duplicate record(s) found. <a href="#/duplicates">Review them</a> before this patient is treated.</div>` : ''}
        <p class="actions"><a class="btn primary" href="#/patients/${esc(created.hrid)}">View details</a><a class="btn" href="#/patients/new">Register another</a></p></div>`);
    }
    const f = (id, text, type = 'text', req = false, extra = '') => `<div><label for="${id}">${text}</label><input id="${id}" name="${id}" type="${type}" ${req ? 'required' : ''} maxlength="120" ${extra}></div>`;
    const today = new Date().toISOString().slice(0, 10);
    return shell('patients/new', `<h1>Register New Patient</h1><form class="card" data-form="patient">
      <div class="formrow">${f('name', 'Full name', 'text', true)}${f('dob', 'Date of birth', 'date', true, `max="${today}"`)}</div>
      <div class="formrow"><div><label for="gender">Gender</label><select id="gender" name="gender" required><option value="">Select…</option><option>Female</option><option>Male</option><option>Other</option></select></div>
        <div><label for="visitType">Visit type</label><select id="visitType" name="visitType" required><option value="outpatient">Outpatient</option><option value="inpatient">Inpatient</option><option value="emergency">Emergency</option></select></div></div>
      <div class="formrow">${f('phone', 'Phone', 'tel')}${f('address', 'Address')}</div>
      <div class="formrow">${f('abhaId', 'ABHA number (14 digits)', 'text', false, 'inputmode="numeric" pattern="[0-9 -]{14,20}"')}${f('hospitalPatientId', 'Hospital patient ID', 'text', false, 'maxlength="32"')}</div>
      <h2 class="mut">Emergency contact</h2>
      <div class="formrow">${f('emergencyName', 'Name')}${f('emergencyPhone', 'Phone', 'tel')}</div>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
      <p><button class="primary" type="submit">Register &amp; generate HRID</button></p></form>`);
  }

  function lookupView(err) {
    const methods = [['hrid', 'HRID'], ['qr', 'QR code (scanned)'], ['phone', 'Phone number'], ['abha', 'ABHA number'], ['hospitalId', 'Hospital patient ID'], ['demographics', 'Name + date of birth + gender']];
    const result = lookupResult === null ? '' : `<div class="card"><h2>Matches</h2>${patientTable(lookupResult)}</div>`;
    return shell('lookup', `<h1>Patient Check-In / Lookup</h1><form class="card" data-form="lookup">
      <div class="formrow"><div><label for="method">Look up by</label><select id="method" name="method">${methods.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}</select></div>
      <div><label for="value">Identifier</label><input id="value" name="value" maxlength="120" autocomplete="off"></div></div>
      <p class="mut">For name + date of birth + gender, fill in the three fields below instead.</p>
      <div class="formrow"><div><label for="dname">Full name</label><input id="dname" name="dname" maxlength="120"></div>
      <div><label for="ddob">Date of birth</label><input id="ddob" name="ddob" type="date"></div>
      <div><label for="dgender">Gender</label><select id="dgender" name="dgender"><option value="">Select…</option><option>Female</option><option>Male</option><option>Other</option></select></div></div>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
      <p><button class="primary" type="submit">Search</button></p><p class="mut">Searches cover this hospital's patients and are audited.</p></form>${result}`);
  }

  function duplicatesView(rows) {
    const person = (p) => `<td><b>${esc(p.name)}</b><br><code>${esc(p.hrid)}</code><br>${esc(p.dob)} · ${esc(p.gender)}<br>${esc(p.phone) || '—'}${p.hasAccount ? '<br><span class="mut">Has a patient login</span>' : ''}</td>`;
    return shell('duplicates', `<h1>Duplicate Review</h1><p class="mut">Suggestions come from a rule-based check (${esc(rows[0] ? rows[0].model : 'rules-v1')}) and are never applied automatically. Merging retires one record and links it to the other; no clinical record is changed or deleted.</p>
      ${rows.length ? rows.map((c) => `<div class="card"><h2>Match score ${esc(Math.round(c.score * 100))}% <span class="mut">(${esc(c.reasons.join(', '))})</span></h2>
        <table><tbody><tr>${c.patients.map(person).join('')}</tr></tbody></table>
        <p class="actions">${c.patients.map((p, i) => `<button class="sm primary" data-action="merge" data-id="${esc(c.id)}" data-primary="${esc(p.hrid)}">Merge into ${esc(p.hrid)}</button>`).join(' ')}
        <button class="sm" data-action="not-duplicate" data-id="${esc(c.id)}">Not a duplicate</button></p></div>`).join('') : '<div class="card"><p class="mut">No possible duplicates to review.</p></div>'}`);
  }

  function billingView(rows) {
    const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—');
    return shell('billing', `<h1>Billing Clearance</h1><p class="mut">An encounter closes and locks once the doctor has signed the discharge summary and billing is cleared here, in either order. This is a placeholder for the billing module: it records that the account is settled, not the amounts.</p>
      <div class="card">${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Patient</th><th>Visit</th><th>Opened</th><th>Discharge signed</th><th>Billing</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.patientName)}<br><code>${esc(r.hrid)}</code></td><td>${esc(r.visitType)}</td><td>${esc(when(r.openedAt))}</td>
        <td>${r.dischargeSigned ? badge('active') + ' signed' : '<span class="mut">pending</span>'}</td><td>${r.billingCleared ? badge('active') + ' cleared' : '<span class="mut">not cleared</span>'}</td>
        <td>${r.billingCleared ? '' : `<button class="sm primary" data-action="clear-billing" data-id="${esc(r.encounterId)}">Mark billing cleared</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">No open encounters.</p>'}</div>`);
  }

  function patientDetailView(p, clinicians) {
    return shell('patients', `<h1>${esc(p.name)}</h1><p><a class="btn" href="#/patients">← Patient list</a></p>
      <div class="card"><h2>Registration information</h2><dl class="kv"><dt>HRID</dt><dd><code>${esc(p.hrid)}</code></dd>
      <dt>Date of birth</dt><dd>${esc(p.dob)}</dd><dt>Gender</dt><dd>${esc(p.gender)}</dd></dl>
      <p class="mut">Clinical records are not available in this workspace.</p></div>
      <form class="card" data-form="priority"><h2>Priority Care</h2><input type="hidden" name="hrid" value="${esc(p.hrid)}">
      <p class="mut">Flag a vulnerable patient (elderly, child, pregnant, disabled or other) so staff see a neutral Priority Care marker.</p>
      <div class="formrow">${['elderly', 'child', 'pregnant', 'disabled'].map((c) => `<label><input type="checkbox" name="cat" value="${c}"> ${c}</label>`).join('')}</div>
      <p><button class="primary" type="submit" name="active" value="on">${p.priorityCare ? 'Update flag' : 'Set Priority Care'}</button>${p.priorityCare ? ' <button class="sm" type="submit" name="active" value="off" formnovalidate>Clear flag</button>' : ''}</p></form>
      <form class="card" data-form="encounter"><h2>New visit</h2><input type="hidden" name="hrid" value="${esc(p.hrid)}">
      <label for="visitType">Visit type</label><select id="visitType" name="visitType"><option value="outpatient">Outpatient</option><option value="inpatient">Inpatient</option><option value="emergency">Emergency</option></select>
      <p><button class="primary" type="submit">Open encounter</button></p><p class="mut">Every order, note, result and bill of a visit links to its encounter.</p></form>
      ${p.hasAccount ? '' : `<form class="card" data-form="patientAccount"><h2>Patient login</h2><input type="hidden" name="hrid" value="${esc(p.hrid)}">
      <label for="pemail">Patient email</label><input id="pemail" name="email" type="email" required maxlength="120">
      <p><button class="primary" type="submit">Create login &amp; send setup email</button></p></form>`}
      <form class="card" data-form="assign"><h2>Assign care</h2><input type="hidden" name="hrid" value="${esc(p.hrid)}">
      ${clinicians.length ? `<label for="uid">Clinician</label><select id="uid" name="uid" required>${clinicians.map((u) => `<option value="${esc(u.uid)}">${esc(u.name)} (${esc(label(u.role))})</option>`).join('')}</select>
      <p><button class="primary" type="submit">Assign to this patient</button></p>` : '<p class="mut">No active clinical staff to assign.</p>'}
      <p class="mut">Assigned clinicians can view this patient and add records for their role.</p></form>`);
  }

  function addStaffView(slug, err, created) {
    const entry = ROLES[slug];
    if (!entry) return shell('', '<h1>Page not found</h1>');
    const [roleName, role] = entry, active = 'staff/new/' + slug;
    if (created) {
      return shell(active, `<h1>${esc(roleName)} account created</h1><div class="card">
        <p>The account was created. ${created.emailed ? 'A password-setup email was sent.' : `<span class="err" role="alert">The setup email could not be sent; use Resend from the staff list.</span>`}</p>
        <p class="actions"><a class="btn primary" href="#/staff">Staff list</a><a class="btn" href="#/${active}">Create another</a></p></div>`);
    }
    const subtype = SUBTYPES[role] ? `<div><label for="subType">Specialty</label><select id="subType" name="subType" required>${SUBTYPES[role].map((v) => `<option value="${v}">${esc(label(v))}</option>`).join('')}</select></div>` : '';
    return shell(active, `<h1>Create ${esc(roleName)} Account</h1><form class="card" data-form="addStaff"><input type="hidden" name="role" value="${role}">
      <div class="formrow"><div><label for="name">Full name</label><input id="name" name="name" required maxlength="100"></div>
      <div><label for="email">Work email</label><input id="email" name="email" type="email" required maxlength="120"></div></div>
      <div class="formrow"><div><label for="username">Username (optional)</label><input id="username" name="username" maxlength="32" pattern="[a-z0-9][a-z0-9._-]{2,31}"></div>${subtype}</div>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
      <p><button class="primary" type="submit">Create &amp; send password-setup email</button></p></form>`);
  }

  function staffView(staff) {
    return shell('staff', `<h1>Staff List</h1><div class="card">${staff.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      ${staff.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(label(u.role))}${u.subType ? ' (' + esc(label(u.subType)) + ')' : ''}</td><td>${badge(u.status === 'inactive' ? 'inactive' : 'active')}</td>
      <td>${u.status === 'active' ? `<button class="sm" data-action="invite" data-id="${esc(u.uid)}">Resend setup email</button> <button class="sm danger" data-action="deactivate" data-id="${esc(u.uid)}">Deactivate</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">No staff found.</p>'}
      <p class="mut">Deactivated accounts can only be reactivated by the Hospital Admin.</p></div>`);
  }

  async function render() {
    if (!guard('pcc')) return;
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (!parts.length) { location.replace('#/dashboard'); return; }
    const err = flash; flash = '';
    try {
      let html;
      if (parts[0] === 'dashboard') html = dashboardView(await FS.call('getPccPatients'), await FS.call('listDashboardUsers'));
      else if (parts[0] === 'lookup') html = lookupView(err);
      else if (parts[0] === 'billing') html = billingView(await FS.call('listOpenEncounters'));
      else if (parts[0] === 'duplicates') html = duplicatesView(await FS.call('listDuplicateCandidates'));
      else if (parts[0] === 'patients' && parts[1] === 'new') html = registerView(err);
      else if (parts[0] === 'patients' && parts[1]) {
        const [patient, users] = await Promise.all([FS.call('getDashboardPatient', { hrid: parts[1] }), FS.call('listDashboardUsers')]);
        html = patientDetailView(patient, users.filter((u) => u.status === 'active' && ['DOCTOR', 'NURSE', 'LAB', 'PHARMACIST'].includes(u.role)));
      }
      else if (parts[0] === 'patients') html = patientsView(await FS.call('getPccPatients'));
      else if (parts[0] === 'staff' && parts[1] === 'new') html = addStaffView(parts[2], err);
      else if (parts[0] === 'staff') html = staffView(await FS.call('listDashboardUsers'));
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
    const d = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      if (form.dataset.form === 'patient') {
        const result = await FS.call('registerDashboardPatient', { ...d, requestId: registerRequestId });
        registerRequestId = newRequestId();
        $app.innerHTML = registerView('', result);
      } else if (form.dataset.form === 'lookup') {
        const demographics = d.method === 'demographics';
        lookupResult = await FS.call('findDashboardPatient', {
          method: d.method, value: demographics ? { name: d.dname, dob: d.ddob, gender: d.dgender } : d.value,
        });
        render(); button.disabled = false;
      } else if (form.dataset.form === 'priority') {
        const active = e.submitter && e.submitter.value === 'on';
        try {
          await FS.call('setPriorityCare', { hrid: d.hrid, active, ...(active ? { categories: new FormData(form).getAll('cat') } : {}) });
          toast(active ? 'Priority Care set' : 'Priority Care cleared'); render();
        } catch (error) {
          const text = message(error);
          if (text === null) { location.replace('/'); return; }
          toast(active ? 'Choose at least one category' : text);
        }
        button.disabled = false;
      } else if (form.dataset.form === 'encounter') {
        try {
          await FS.call('openDashboardEncounter', { hrid: d.hrid, visitType: d.visitType });
          toast('Encounter opened');
        } catch (error) {
          const text = message(error);
          if (text === null) { location.replace('/'); return; }
          toast(text);
        }
        button.disabled = false;
      } else if (form.dataset.form === 'patientAccount') {
        const created = await FS.call('createPatientAccount', { hrid: d.hrid, email: d.email });
        let emailed = true;
        try { await FS.call('sendDashboardInvite', { uid: created.uid }); } catch (error) { emailed = false; }
        toast(emailed ? 'Login created; setup email sent' : 'Login created; email failed'); render();
      } else if (form.dataset.form === 'assign') {
        await FS.call('assignPatientCare', { hrid: d.hrid, uid: d.uid });
        toast('Care assigned'); button.disabled = false;
      } else if (form.dataset.form === 'addStaff') {
        const hospital = FS.session().hospitalId;
        const { subType, username, ...rest } = d;
        const created = await FS.call('createDashboardUser', { ...rest, hospitalId: hospital, ...(subType ? { subType } : {}), ...(username ? { username } : {}) });
        let emailed = true;
        try { await FS.call('sendDashboardInvite', { uid: created.uid }); } catch (error) { emailed = false; }
        const slug = Object.keys(ROLES).find((k) => ROLES[k][1] === d.role);
        $app.innerHTML = addStaffView(slug, '', { emailed });
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
      } else if (b.dataset.action === 'merge' && confirm('Merge these records? The other record will be retired and linked to ' + b.dataset.primary + '. This is audited and cannot be undone here.')) {
        b.disabled = true;
        await FS.call('reviewDuplicateCandidate', { candidateId: b.dataset.id, decision: 'merge', primaryHrid: b.dataset.primary });
        toast('Records merged'); render();
      } else if (b.dataset.action === 'clear-billing' && confirm('Confirm this account is settled? If the discharge summary is already signed, the encounter will lock and can then change only through addenda.')) {
        b.disabled = true;
        const result = await FS.call('markEncounterBillingCleared', { encounterId: b.dataset.id });
        toast(result.encounterLocked ? 'Billing cleared; encounter locked' : 'Billing cleared'); render();
      } else if (b.dataset.action === 'not-duplicate') {
        b.disabled = true;
        await FS.call('reviewDuplicateCandidate', { candidateId: b.dataset.id, decision: 'reject' });
        toast('Marked as not a duplicate'); render();
      } else if (b.dataset.action === 'deactivate' && confirm('Deactivate this staff account? They will lose access immediately.')) {
        await FS.call('setDashboardUserStatus', { uid: b.dataset.id, status: 'inactive' });
        toast('Staff deactivated'); render();
      }
    } catch (error) { toast(message(error) || 'Signed out'); }
  });

  window.addEventListener('hashchange', render);
  render();
})();
