(function () {
  const { $app, S, esc, fmt, badge, toast, guard } = window.UI;

  const NAV = [['dashboard', 'Dashboard'], ['profile', 'My Profile'], ['hrid', 'My HRID'], ['history', 'Medical History'], ['timeline', 'Health Timeline'],
    ['reports', 'Medical Reports'], ['prescriptions', 'Prescription History'], ['allergies', 'Allergy Information'], ['access', 'Access History'],
    ['emergency', 'Emergency Access History'], ['consent', 'Consent Management'], ['settings', 'Account Settings'], ['password', 'Change Password']];
  const shell = (active, html) => window.UI.shell(NAV, 'My Health Record', active, html);
  const alertBox = (cls, html) => `<div class="alert ${cls}" role="alert">${html}</div>`;
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : '—');
  const age = (dob) => { const d = new Date(dob), n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--; return a; };
  let reportTimer = null;

  const prov = (r) => `<span class="pill hosp">${esc(r.hospitalName)}</span><span class="mut">${esc(r.author || '')}</span>`;
  function timelineList(items) {
    if (!items.length) return '<p class="mut">No records yet.</p>';
    return `<ul class="timeline">${items.map((t) => `<li><b>${esc(t.title)}</b> <span class="pill">${esc(t.type)}</span>${t.icd ? `<span class="pill">${esc(t.icd)}</span>` : ''}
      <div>${esc(t.details || '')}</div><div class="meta">${esc(fmt(t.createdAt))} · ${prov(t)}${t.reportId ? ` · <a href="#/reports/${esc(t.reportId)}">Open report</a>` : ''}</div></li>`).join('')}</ul>`;
  }
  function summaryBlock(r) {
    if (r.processingStatus === 'processing') return '<p>' + badge('processing') + ' A summary is being generated…</p>';
    const s = r.summary;
    if (!s) return '<p class="mut">No summary available.</p>';
    return `<p>${esc(s.headline)}</p>${s.findings.length ? `<table><thead><tr><th>Test</th><th>Your value</th><th>Reference</th><th>Flag</th></tr></thead><tbody>
      ${s.findings.map((f) => `<tr><td>${esc(f.test)}</td><td>${esc(f.value)} ${esc(f.unit)}</td><td>${esc(f.range)}</td><td>${badge(f.flag)}</td></tr>`).join('')}</tbody></table>` : ''}
      <p class="mut">Automatically generated demo summary. It is not medical advice; discuss results with your clinician.</p>`;
  }
  function medsTable(rows) {
    if (!rows.length) return '<p class="mut">No medications recorded.</p>';
    return `<div class="tablewrap"><table><thead><tr><th>Medication</th><th>Dose</th><th>Instructions</th><th>Prescriber</th><th>Hospital</th><th>Date</th><th>Status</th></tr></thead><tbody>
      ${rows.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.dose)}</td><td>${esc(m.instructions)}</td><td>${esc(m.prescribedBy)}</td><td>${esc(m.hospitalName)}</td><td>${day(m.createdAt)}</td><td>${badge(m.status)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  const allergyTable = (rows) => (rows.length ? `<div class="tablewrap"><table><thead><tr><th>Allergen</th><th>Reaction</th><th>Severity</th><th>Recorded at</th><th>Date</th></tr></thead><tbody>
    ${rows.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.reaction)}</td><td>${badge(a.severity)}</td><td>${esc(a.hospitalName)}</td><td>${day(a.recordedAt)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">No allergies recorded.</p>');
  const accessTable = (rows) => (rows.length ? `<div class="tablewrap"><table><thead><tr><th>Time</th><th>Who</th><th>Hospital</th><th>Type</th><th>Event</th><th>Outcome</th></tr></thead><tbody>
    ${rows.map((l) => `<tr><td>${esc(fmt(l.ts))}</td><td>${esc(l.actor)}</td><td>${esc(l.hospitalName)}</td><td>${esc(l.category)}</td><td>${esc(l.action)}</td><td>${badge(l.outcome)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">No events.</p>');

  function dashboardView(d) {
    const p = d.patient;
    return shell('dashboard', `<h1>Welcome, ${esc(p.name)}</h1>
      <div class="grid"><div class="stat"><b>${esc(p.hrid)}</b><span>My HRID</span></div><div class="stat"><b>${d.records.length}</b><span>Clinical records</span></div>
        <div class="stat"><b>${d.reports.length}</b><span>Reports</span></div><div class="stat"><b>${d.medications.filter((m) => m.status === 'current').length}</b><span>Current medications</span></div>
        <div class="stat"><b>${d.accessCount}</b><span>Staff access events</span></div><div class="stat"><b>${d.emergencyCount}</b><span>Emergency accesses</span></div></div>
      ${d.emergencyCount ? alertBox('warn', `Your record was opened in an emergency ${d.emergencyCount} time(s). <a href="#/emergency">Review</a>`) : ''}
      <div class="two"><div class="card"><h2>Consent</h2><p>Sharing with other hospitals: ${d.consent.shareWithOtherHospitals ? badge('active') : badge('suspended')}</p><a class="btn" href="#/consent">Manage consent</a></div>
      <div class="card"><h2>Allergies</h2>${d.allergies.length ? d.allergies.map((a) => `<span class="pill">${esc(a.name)}</span>`).join(' ') : '<p class="mut">None recorded.</p>'}</div></div>
      <div class="card"><h2>Latest reports</h2>${d.reports.slice(0, 2).map((r) => `<h3><a href="#/reports/${esc(r.id)}">${esc(r.title)}</a> <span class="mut">${day(r.uploadedAt)}</span></h3>${summaryBlock(r)}`).join('') || '<p class="mut">No reports.</p>'}</div>
      <div class="card"><h2>Recent timeline</h2>${timelineList(d.timeline.slice(0, 4))}</div>`);
  }

  function profileView(d, err, ok) {
    const p = d.patient, v = (x) => esc(x || '');
    return shell('profile', `<h1>My Profile</h1>${err ? alertBox('danger', esc(err)) : ''}${ok ? alertBox('ok', 'Contact details updated.') : ''}
      <div class="card"><h2>Identity</h2><p>Name: <b>${esc(p.name)}</b></p><p>Date of birth: ${esc(p.dob)} (${age(p.dob)} y) · ${esc(p.gender)}</p><p>Email: ${esc(p.email)}</p><p>Registered at: ${esc(p.hospitalName)}</p>
        <p class="mut">Identity details can only be corrected by your hospital's registration desk.</p></div>
      <form data-form="contact" class="card"><h2>Contact information</h2>
        <label>Phone<input name="phone" maxlength="20" value="${v(p.phone)}"></label>
        <label>Address<input name="address" maxlength="200" value="${v(p.address)}"></label>
        <label>Emergency contact name<input name="emergencyName" maxlength="80" value="${v(p.emergencyName)}"></label>
        <label>Emergency contact phone<input name="emergencyPhone" maxlength="20" value="${v(p.emergencyPhone)}"></label>
        <p><button class="primary" type="submit">Save changes</button></p></form>`);
  }

  function hridView(d) {
    return shell('hrid', `<h1>My HRID</h1><div class="card"><p>Your Health Record ID:</p><p class="big"><code>${esc(d.patient.hrid)}</code></p>
      <p class="mut">Share this with clinicians so they can find your record. Anyone with your HRID still needs permission to open it.</p></div>`);
  }

  function reportsView(d) {
    return shell('reports', `<h1>Medical Reports</h1><div class="card">${d.reports.length ? `<table><thead><tr><th>Title</th><th>Category</th><th>Date</th><th>Hospital</th><th>Summary</th><th></th></tr></thead><tbody>
      ${d.reports.map((r) => `<tr><td>${esc(r.title)}</td><td>${esc(r.category)}</td><td>${day(r.uploadedAt)}</td><td>${esc(r.hospitalName)}</td><td>${r.summary ? esc(r.summary.headline) : badge(r.processingStatus)}</td><td><a class="btn sm" href="#/reports/${esc(r.id)}">View</a></td></tr>`).join('')}</tbody></table>` : '<p class="mut">No reports.</p>'}</div>`);
  }
  function reportView(d, id) {
    const r = d.reports.find((x) => x.id === id);
    if (!r) return shell('reports', `<h1>Report</h1>${alertBox('danger', 'Report not found.')}`);
    if (r.processingStatus === 'processing') reportTimer = setTimeout(render, 1000);
    return shell('reports', `<p><a href="#/reports">← Reports</a></p><h1>${esc(r.title)}</h1>
      <div class="card"><h2>Details</h2><p>${esc(r.category)} · ${esc(fmt(r.uploadedAt))} · ${esc(r.hospitalName)}</p><p>File: ${esc(r.fileName)} ${r.hasFile ? '' : '<span class="mut">(demo seed record, no file)</span>'}</p>
        ${r.hasFile ? `<button data-action="openPdf" data-id="${esc(r.id)}">Open PDF</button>` : ''}</div>
      <div class="card"><h2>AI report summary</h2>${summaryBlock(r)}</div>`);
  }

  function consentView(d, msg) {
    const c = d.consent;
    return shell('consent', `<h1>Consent Management</h1>${msg ? alertBox('ok', esc(msg)) : ''}
      <form data-form="consent" class="card">
        <label class="check"><input type="checkbox" name="shareWithOtherHospitals" ${c.shareWithOtherHospitals ? 'checked' : ''}> Allow clinicians at other hospitals to see records that were marked as shareable</label>
        <label class="check"><input type="checkbox" name="notifyOnEmergency" ${c.notifyOnEmergency ? 'checked' : ''}> Notify me when my record is opened in an emergency</label>
        <p class="mut">Clinicians at your own hospital can always see your record for care. In a genuine emergency, a doctor may open your record regardless of this setting; this is always audited and listed in your Emergency Access History. Notification delivery requires the production backend.</p>
        <p><button class="primary" type="submit">Save preferences</button></p></form>`);
  }

  function settingsView(d) {
    return shell('settings', `<h1>Account Settings</h1><div class="card"><p>Sign-in email: <b>${esc(d.patient.email)}</b></p><p>HRID: <code>${esc(d.patient.hrid)}</code></p>
      <p>Session timeout: ${esc(String(S.config().sessionTimeoutMin))} minutes of inactivity.</p>
      <div class="actions"><a class="btn" href="#/password">Change password</a><a class="btn" href="#/profile">Update contact details</a><a class="btn" href="#/consent">Consent preferences</a></div></div>`);
  }

  function passwordView(err, ok) {
    return shell('password', `<h1>Change Password</h1>${err ? alertBox('danger', esc(err)) : ''}${ok ? alertBox('ok', 'Password changed.') : ''}
      <form data-form="password" class="card" autocomplete="off">
        <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
        <label>New password (min ${esc(String(S.config().minPasswordLength))} characters)<input type="password" name="next" required minlength="${esc(String(S.config().minPasswordLength))}" autocomplete="new-password"></label>
        <label>Confirm new password<input type="password" name="confirm" required autocomplete="new-password"></label>
        <p><button class="primary" type="submit">Change password</button></p></form>`);
  }

  async function render() {
    clearTimeout(reportTimer);
    await S.ready();
    if (!guard('patient')) return;
    S.touch();
    const d = S.patientOverview();
    if (!d) { $app.innerHTML = '<div class="card">Account not available.</div>'; return; }
    const [a, b] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
    const views = {
      dashboard: () => dashboardView(d), profile: () => profileView(d), hrid: () => hridView(d),
      history: () => shell('history', `<h1>Medical History</h1><div class="card"><div class="tablewrap"><table><thead><tr><th>Date</th><th>Type</th><th>Title</th><th>Details</th><th>Hospital</th><th>Author</th></tr></thead><tbody>
        ${d.timeline.map((t) => `<tr><td>${day(t.createdAt)}</td><td>${esc(t.type)}</td><td>${esc(t.title)}</td><td>${esc(t.details || '')}</td><td>${esc(t.hospitalName)}</td><td>${esc(t.author || '')}</td></tr>`).join('')}</tbody></table></div></div>`),
      timeline: () => shell('timeline', `<h1>Health Timeline</h1><div class="card">${timelineList(d.timeline)}</div>`),
      reports: () => (b ? reportView(d, b) : reportsView(d)),
      prescriptions: () => shell('prescriptions', `<h1>Prescription History</h1><div class="card">${medsTable(d.medications)}</div>`),
      allergies: () => shell('allergies', `<h1>Allergy Information</h1><div class="card">${allergyTable(d.allergies)}</div>`),
      access: () => shell('access', `<h1>Access History</h1><p class="mut">Staff who opened or changed your record, including denied attempts.</p><div class="card">${accessTable(S.patientAccessHistory())}</div>`),
      emergency: () => shell('emergency', `<h1>Emergency Access History</h1><div class="card">${accessTable(S.patientEmergencyHistory())}</div>`),
      consent: () => consentView(d), settings: () => settingsView(d), password: () => passwordView(),
    };
    $app.innerHTML = (views[a] || views.dashboard)();
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const k = form.dataset.form;
    const d = Object.fromEntries(new FormData(form));
    if (k === 'contact') {
      const r = S.patientUpdateContact(d);
      $app.innerHTML = profileView(S.patientOverview(), r.ok ? '' : r.error, r.ok);
    } else if (k === 'consent') {
      S.patientSetConsent({ shareWithOtherHospitals: !!d.shareWithOtherHospitals, notifyOnEmergency: !!d.notifyOnEmergency });
      $app.innerHTML = consentView(S.patientOverview(), 'Preferences saved.');
    } else if (k === 'password') {
      const r = await S.patientChangePassword(d.current, d.next, d.confirm);
      $app.innerHTML = passwordView(r.ok ? '' : r.error, r.ok);
    }
  });

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    if (b.dataset.action === 'logout') { S.logout(); location.href = '/'; }
    else if (b.dataset.action === 'openPdf') {
      const r = await S.patientReportFile(b.dataset.id);
      if (!r.ok) { toast(r.error); return; }
      const url = URL.createObjectURL(r.blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  });

  window.addEventListener('hashchange', render);
  render();
})();
