(function () {
  const { $app, S, esc, fmt, badge, toast, logTable, guard, refocus } = window.UI;

  const NAV = [['dashboard', 'Dashboard'], ['search', 'Patient Search'], ['history', 'Access History']];
  const shell = (active, html) => window.UI.shell(NAV, 'Doctor Workspace', active, html);
  const age = (dob) => { const d = new Date(dob), n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--; return a; };
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : '—');
  const TABS = [['', 'Overview'], ['history', 'Medical History'], ['timeline', 'Health Timeline'], ['reports', 'Reports'], ['risk', 'Disease Risk'], ['diagnosis', 'New Diagnosis'], ['prescribe', 'Prescription']];
  let flash = '';

  const alertBox = (cls, html) => `<div class="alert ${cls}" role="alert">${html}</div>`;
  const takeFlash = () => { const f = flash; flash = ''; return f ? alertBox('danger', esc(f)) : ''; };

  function patientList(rows) {
    if (!rows.length) return '<p class="mut">No patients.</p>';
    return `<div class="tablewrap"><table><thead><tr><th>HRID</th><th>Name</th><th>Age</th><th>Gender</th><th></th></tr></thead><tbody>
      ${rows.map((p) => `<tr><td><code>${esc(p.hrid)}</code></td><td>${esc(p.name)}</td><td>${age(p.dob)}</td><td>${esc(p.gender)}</td>
      <td><a class="btn sm" href="#/patient/${esc(p.hrid)}">Open</a></td></tr>`).join('')}</tbody></table></div>`;
  }

  function hridForm(err) {
    return `<form data-form="hrid" class="card"><h2>Search by HRID</h2>${err ? alertBox('danger', esc(err)) : ''}
      <div class="toolbar"><input name="hrid" placeholder="HDW-YYYYMMDD-XXXXXXXX" required maxlength="24" autocomplete="off" aria-label="HRID">
      <button class="primary" type="submit">Open record</button></div>
      <p class="mut">Every record access is written to the audit log.</p></form>`;
  }

  function dashboardView() {
    const rec = S.doctorRecentPatients();
    return shell('dashboard', `<h1>Doctor Dashboard</h1>${takeFlash()}
      ${hridForm()}
      <div class="two">
        <div class="card"><h2>Recently viewed patients</h2>${patientList(rec)}</div>
        <div class="card"><h2>Clinical actions</h2>
          <div class="actions"><a class="btn primary" href="#/search">Patient search</a><a class="btn" href="#/emergency">Emergency access</a><a class="btn" href="#/history">My access history</a></div>
          <p class="mut">Open a patient to see the health timeline, AI summaries, risk indicators, allergies and medications, and to enter diagnoses or prescriptions.</p></div>
      </div>
      <div class="card"><h2>My recent activity</h2>${logTable(S.doctorAccessHistory().slice(0, 6), true)}</div>`);
  }

  function searchView(err, results) {
    return shell('search', `<h1>Patient Search</h1>${takeFlash()}${hridForm(err)}
      <form data-form="secondary" class="card"><h2>Secondary lookup</h2>
        <p class="mut">Approved method: date of birth plus full name or phone number (exact match, patients at your hospital).</p>
        <div class="toolbar"><input name="name" placeholder="Full name" aria-label="Full name"><input name="phone" placeholder="Phone" aria-label="Phone">
        <input name="dob" type="date" required aria-label="Date of birth"><button type="submit">Search</button></div>
        ${results ? (results.length ? patientList(results) : '<p class="mut">No matching patient. If this is an emergency, use Emergency Access with the HRID.</p>') : ''}</form>
      <p><a href="#/emergency">Patient from another hospital in an emergency? Use Emergency Access →</a></p>`);
  }

  function historyView() {
    return shell('history', `<h1>Access History</h1><div class="card">${logTable(S.doctorAccessHistory(), true)}</div>`);
  }

  function emergencyView(hrid, err) {
    return shell('search', `<h1>Emergency Access</h1>
      ${alertBox('warn', '<b>Break-glass access.</b> Your identity, hospital, the time and your reason are recorded and reviewed by the patient\'s hospital. Access lasts 30 minutes.')}
      ${err ? alertBox('danger', esc(err)) : ''}
      <form data-form="emergency" class="card">
        <label>HRID<input name="hrid" required value="${esc(hrid || '')}" placeholder="HDW-YYYYMMDD-XXXXXXXX" autocomplete="off"></label>
        <label>Emergency category<select name="category" required><option value="">Select…</option>${S.EMERGENCY_CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
        <label>Reason (15–500 characters)<textarea name="reason" required minlength="15" maxlength="500" rows="4"></textarea></label>
        <label class="check"><input type="checkbox" name="ack" required> I understand this access is audited and must be clinically justified.</label>
        <p><button class="primary" type="submit">Request emergency access</button> <a class="btn" href="#/search">Cancel</a></p></form>`);
  }

  function header(d, tab) {
    const p = d.patient;
    return `<div class="ptitle"><h1>${esc(p.name)}</h1><code>${esc(p.hrid)}</code><span class="mut">${age(p.dob)} y · ${esc(p.gender)} · DOB ${esc(p.dob)}</span></div>
      <p class="mut">Home hospital: ${esc(p.hospitalName)}</p>
      ${d.emergency ? alertBox('warn', `<b>Emergency access active</b> until ${esc(fmt(d.emergency.expiresAt))}. Reason: ${esc(d.emergency.reason)}`) : ''}
      ${d.allergies.length ? alertBox('danger', '<b>Allergies:</b> ' + d.allergies.map((a) => esc(a.name) + ' (' + esc(a.reaction) + ')').join(', ')) : ''}
      <nav class="tabs" aria-label="Patient sections">${TABS.map(([k, l]) => `<a class="${k === tab ? 'active' : ''}" href="#/patient/${esc(p.hrid)}${k ? '/' + k : ''}">${l}</a>`).join('')}</nav>`;
  }

  const prov = (r) => `<span class="pill hosp">${esc(r.hospitalName)}</span><span class="mut">${esc(r.author || '')}</span>`;
  const hiddenNote = (d) => (d.hidden ? alertBox('info', `${d.hidden} record(s) from other hospitals are not shared and are hidden. Use Emergency Access if clinically necessary.`) : '');

  function allergyPanel(d) {
    return `<div class="card"><h2>Allergies</h2>${d.allergies.length ? `<table><thead><tr><th>Allergen</th><th>Reaction</th><th>Severity</th><th>Source</th></tr></thead><tbody>
      ${d.allergies.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.reaction)}</td><td>${badge(a.severity)}</td><td>${esc(a.hospitalName)}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">No allergies documented (not the same as no known allergies — confirm with the patient).</p>'}</div>`;
  }
  function medPanel(d) {
    return `<div class="card"><h2>Current medications</h2>${d.medications.length ? `<table><thead><tr><th>Medication</th><th>Dose</th><th>Instructions</th><th>Prescriber</th><th>Source</th></tr></thead><tbody>
      ${d.medications.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.dose)}</td><td>${esc(m.instructions)}</td><td>${esc(m.prescribedBy)}</td><td>${esc(m.hospitalName)}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">No current medications documented.</p>'}</div>`;
  }
  function riskBars(d, detail) {
    return `${d.risks.map((r) => `<div class="risk"><div><b>${esc(r.condition)}</b></div>
      <progress max="100" value="${r.score}" aria-label="${esc(r.condition)} risk score">${r.score}</progress>
      <div>${badge(r.level.toLowerCase())} ${r.diagnosed ? '' : r.score + '/100'}<br><span class="mut">Confidence ${r.confidence}%</span></div></div>
      ${detail ? `<details><summary>Factors</summary><ul>${r.factors.map((f) => `<li>${esc(f.label)}: ${f.known ? f.earned + '/' + f.max : '<span class="mut">data not available</span>'}</li>`).join('')}</ul></details>` : ''}`).join('')}
      <p class="mut">Screening estimate from a transparent rule-based heuristic, not a validated clinical model. Confidence reflects data completeness. Does not replace clinical judgement.</p>`;
  }
  function summaryBlock(r) {
    if (r.processingStatus === 'processing') return '<p>' + badge('processing') + ' AI summary is being generated…</p>';
    const s = r.summary;
    if (!s) return '<p class="mut">No summary available.</p>';
    return `<p>${esc(s.headline)}</p>${s.findings.length ? `<table><thead><tr><th>Test</th><th>Value</th><th>Reference</th><th>Flag</th></tr></thead><tbody>
      ${s.findings.map((f) => `<tr><td>${esc(f.test)}</td><td>${esc(f.value)} ${esc(f.unit)}</td><td>${esc(f.range)}</td><td>${badge(f.flag)}</td></tr>`).join('')}</tbody></table>` : ''}
      <p class="mut">AI-generated (${esc(s.model || 'demo')}), demo only — requires clinician review against the source PDF.</p>`;
  }

  function overviewTab(d) {
    const p = d.patient, c = p.clinical || {};
    const vit = [['BP', c.bpSys ? c.bpSys + '/' + c.bpDia + ' mmHg' : ''], ['BMI', c.bmi], ['HbA1c', c.hba1c ? c.hba1c + ' %' : ''], ['LDL', c.ldl ? c.ldl + ' mg/dL' : ''], ['eGFR', c.egfr]].filter((v) => v[1]);
    return `<div class="two">${allergyPanel(d)}${medPanel(d)}</div>
      <div class="card"><h2>Disease risk indicators</h2>${riskBars(d, false)}</div>
      ${vit.length ? `<div class="card"><h2>Latest vitals</h2><p>${vit.map((v) => `<span class="pill">${esc(v[0])}: ${esc(v[1])}</span>`).join(' ')}</p></div>` : ''}
      <div class="card"><h2>Latest AI report summaries</h2>${d.reports.slice(0, 3).map((r) => `<h3><a href="#/report/${esc(r.id)}">${esc(r.title)}</a> <span class="mut">${day(r.uploadedAt)}</span></h3>${summaryBlock(r)}`).join('') || '<p class="mut">No reports.</p>'}</div>
      <div class="card"><h2>Recent timeline</h2>${timelineList(d.timeline.slice(0, 4))}</div>
      <div class="card actions"><a class="btn primary" href="#/patient/${esc(p.hrid)}/diagnosis">New diagnosis</a><a class="btn primary" href="#/patient/${esc(p.hrid)}/prescribe">New prescription</a></div>`;
  }

  function timelineList(items) {
    if (!items.length) return '<p class="mut">No visible records.</p>';
    return `<ul class="timeline">${items.map((t) => `<li><b>${esc(t.title)}</b> <span class="pill">${esc(t.type)}</span>${t.icd ? `<span class="pill">${esc(t.icd)}</span>` : ''}
      <div>${esc(t.details || '')}</div><div class="meta">${esc(fmt(t.createdAt))} · ${prov(t)}${t.reportId ? ` · <a href="#/report/${esc(t.reportId)}">Open report</a>` : ''}</div></li>`).join('')}</ul>`;
  }

  let histType = '';
  function historyTab(d) {
    const types = Array.from(new Set(d.timeline.map((t) => t.type)));
    const rows = d.timeline.filter((t) => !histType || t.type === histType);
    return `<div class="card"><div class="toolbar"><select id="htype" aria-label="Record type"><option value="">All types</option>${types.map((t) => `<option ${t === histType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div class="tablewrap"><table><thead><tr><th>Date</th><th>Type</th><th>Title</th><th>Details</th><th>Hospital</th><th>Author</th></tr></thead><tbody>
      ${rows.map((t) => `<tr><td>${day(t.createdAt)}</td><td>${esc(t.type)}</td><td>${esc(t.title)}</td><td>${esc(t.details || '')}</td><td>${esc(t.hospitalName)}</td><td>${esc(t.author || '')}</td></tr>`).join('')}</tbody></table></div>
      ${hiddenNote(d)}
      <form data-form="amend" data-hrid="${esc(d.patient.hrid)}"><h3>Add an amendment</h3>
        <p class="mut">Original records cannot be changed. An amendment is saved as a new linked entry under your name and hospital.</p>
        <label>Record to amend<select name="recordId" required>${d.timeline.filter((t) => t.type !== 'amendment').map((t) => `<option value="${esc(t.id)}">${esc(day(t.createdAt))} · ${esc(t.type)} · ${esc(t.title)}</option>`).join('')}</select></label>
        <label>Amendment<textarea name="text" required minlength="5" maxlength="1000"></textarea></label>
        <label>Reason<input name="reason" required minlength="5" maxlength="200"></label>
        <button class="primary" type="submit">Save amendment</button></form></div>`;
  }

  function reportsTab(d) {
    return `<div class="card"><h2>Medical reports</h2>${d.reports.length ? `<table><thead><tr><th>Title</th><th>Category</th><th>Uploaded</th><th>Hospital</th><th>AI status</th><th></th></tr></thead><tbody>
      ${d.reports.map((r) => `<tr><td>${esc(r.title)}</td><td>${esc(r.category)}</td><td>${day(r.uploadedAt)}</td><td>${esc(r.hospitalName)}</td><td>${badge(r.processingStatus)}</td><td><a class="btn sm" href="#/report/${esc(r.id)}">View</a></td></tr>`).join('')}</tbody></table>` : '<p class="mut">No visible reports.</p>'}${hiddenNote(d)}</div>`;
  }

  function diagnosisTab(d, err) {
    return `<form data-form="diagnosis" class="card" data-hrid="${esc(d.patient.hrid)}"><h2>New diagnosis</h2>
      <p class="mut">Recorded against ${esc(d.patient.hrid)}, your hospital and your account.</p>${err ? alertBox('danger', esc(err)) : ''}
      <label>Diagnosis<input name="title" required maxlength="120"></label>
      <label>ICD-10 code (optional)<input name="icd" placeholder="E11.9" maxlength="8"></label>
      <label>Status<select name="dxStatus"><option value="provisional">Provisional</option><option value="confirmed">Confirmed</option></select></label>
      <label>Severity<select name="severity"><option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option></select></label>
      <label>Notes<textarea name="notes" rows="4" maxlength="1000"></textarea></label>
      <p><button class="primary" type="submit">Save diagnosis</button></p></form>`;
  }

  function alertsHtml(res) {
    if (!res) return '';
    if (!res.alerts.length) return alertBox('ok', 'No allergy or interaction alerts found for this medication.');
    return res.alerts.map((a) => alertBox(a.severity === 'major' || a.severity === 'contraindicated' ? 'danger' : 'warn', `<b>${esc(a.type === 'allergy' ? 'Allergy alert' : a.type === 'duplicate' ? 'Duplicate therapy' : 'Interaction')} · ${esc(a.severity)}</b><br>${esc(a.message)}`)).join('');
  }
  function prescribeTab(d, err, form) {
    const f = form || {};
    return `<form data-form="prescribe" class="card" data-hrid="${esc(d.patient.hrid)}"><h2>Prescription</h2>${err ? alertBox('danger', esc(err)) : ''}
      <label>Medication<input name="name" list="drugs" required maxlength="80" autocomplete="off" value="${esc(f.name || '')}"></label>
      <datalist id="drugs">${S.DRUG_NAMES.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <div id="alerts" aria-live="polite">${alertsHtml(f.check)}</div>
      <label>Dose<input name="dose" required maxlength="40" placeholder="500 mg" value="${esc(f.dose || '')}"></label>
      <label>Route<select name="route">${['Oral', 'IV', 'IM', 'Topical', 'Inhaled'].map((r) => `<option ${r === f.route ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label>Frequency<input name="frequency" required maxlength="40" placeholder="Twice daily" value="${esc(f.frequency || '')}"></label>
      <label>Duration<input name="duration" maxlength="40" value="${esc(f.duration || '')}"></label>
      <label>Indication<input name="indication" maxlength="120" value="${esc(f.indication || '')}"></label>
      ${f.needsOverride ? `<label>Override reason (required, min 10 characters)<textarea name="override" rows="3" required minlength="10" maxlength="300"></textarea></label>` : ''}
      <p><button type="button" data-action="check">Check safety</button> <button class="primary" type="submit">${f.needsOverride ? 'Prescribe despite alerts' : 'Prescribe'}</button></p></form>
      ${medPanel(d)}`;
  }

  function riskTab(d) { return `<div class="card"><h2>Disease risk dashboard</h2>${riskBars(d, true)}</div>`; }

  function patientView(hrid, tab, err, extra) {
    const d = S.doctorOpenPatient(hrid);
    if (!d) { flash = 'That patient is not accessible. Use Emergency Access if clinically necessary.'; location.hash = '#/search'; return ''; }
    const body = { '': () => overviewTab(d), history: () => historyTab(d), timeline: () => `<div class="card"><h2>Health timeline</h2>${timelineList(d.timeline)}${hiddenNote(d)}</div>`,
      reports: () => reportsTab(d), risk: () => riskTab(d), diagnosis: () => diagnosisTab(d, err), prescribe: () => prescribeTab(d, err, extra) }[tab];
    if (!body) return patientView(hrid, '');
    return shell('search', header(d, tab) + body());
  }

  let reportTimer = null;
  function reportView(id, msg) {
    const r = S.doctorReport(id);
    if (!r.ok) return shell('search', `<h1>Report</h1>${alertBox('danger', esc(r.error))}`);
    const x = r.report;
    if (x.processingStatus === 'processing') reportTimer = setTimeout(render, 1000);
    return shell('search', `<p><a href="#/patient/${esc(x.hrid)}/reports">← Reports</a></p><h1>${esc(x.title)}</h1>${msg ? alertBox('danger', esc(msg)) : ''}
      <div class="card"><h2>Details</h2><p>Patient: ${esc(r.patient.name)} <code>${esc(x.hrid)}</code></p>
      <p>Category: ${esc(x.category)} · Uploaded ${esc(fmt(x.uploadedAt))} by ${esc(x.uploadedByName || x.uploadedBy)} at ${esc(x.hospitalName)}</p>
      <p>File: ${esc(x.fileName)} ${x.hasFile ? '' : '<span class="mut">(demo seed record, no file)</span>'}</p>
      ${x.hasFile ? `<button data-action="openPdf" data-id="${esc(x.id)}">Open PDF</button>` : ''}</div>
      <div class="card"><h2>AI report summary</h2>${summaryBlock(x)}</div>`);
  }

  async function render() {
    await S.ready();
    if (!guard('doctor')) return;
    S.touch();
    clearTimeout(reportTimer);
    const parts = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
    const [a, b, c] = parts;
    let html;
    if (a === 'patient' && b) html = patientView(decodeURIComponent(b), c || '');
    else if (a === 'report' && b) html = reportView(b);
    else if (a === 'emergency') html = emergencyView(b);
    else if (a === 'search') html = searchView();
    else if (a === 'history') html = historyView();
    else html = dashboardView();
    if (html) $app.innerHTML = html;
  }

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const k = form.dataset.form, hrid = form.dataset.hrid;
    if (k === 'hrid') {
      const r = S.doctorFindPatient(d.hrid);
      if (r.ok) location.hash = '#/patient/' + r.patient.hrid;
      else $app.innerHTML = searchView(r.error);
    } else if (k === 'secondary') {
      const r = S.doctorSearchSecondary(d);
      $app.innerHTML = searchView(r.ok ? '' : r.error, r.ok ? r.results : null);
    } else if (k === 'emergency') {
      const r = S.doctorEmergencyAccess(d.hrid, d.reason, d.category);
      if (r.ok) { toast('Emergency access granted for 30 minutes'); location.hash = '#/patient/' + String(d.hrid).trim().toUpperCase(); }
      else $app.innerHTML = emergencyView(d.hrid, r.error);
    } else if (k === 'diagnosis') {
      const r = S.doctorCreateDiagnosis(hrid, d);
      if (r.ok) { toast('Diagnosis saved'); location.hash = '#/patient/' + hrid + '/history'; } else $app.innerHTML = patientView(hrid, 'diagnosis', r.error);
    } else if (k === 'amend') {
      const r = S.doctorAmendRecord(d.recordId, d);
      if (r.ok) { toast('Amendment saved'); render(); } else toast(r.error);
    } else if (k === 'prescribe') {
      const r = S.doctorCreatePrescription(hrid, d, d.override || '');
      if (r.ok) { toast(r.alerts && r.alerts.length ? 'Prescribed with alerts acknowledged' : 'Prescription saved'); location.hash = '#/patient/' + hrid; }
      else $app.innerHTML = patientView(hrid, 'prescribe', r.error, Object.assign({}, d, { needsOverride: !!r.needsOverride, check: r.alerts ? { alerts: r.alerts } : null }));
    }
  });

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    if (b.dataset.action === 'logout') { S.logout(); location.href = '/'; }
    else if (b.dataset.action === 'check') {
      const form = b.closest('form'), r = S.doctorMedicationCheck(form.dataset.hrid, form.elements.name.value);
      if (r.ok === false) { toast(r.error || 'Enter a medication first'); return; }
      form.querySelector('#alerts').innerHTML = alertsHtml(r);
    } else if (b.dataset.action === 'openPdf') {
      const r = await S.doctorReportFile(b.dataset.id);
      if (!r.ok) { toast(r.error); return; }
      const url = URL.createObjectURL(r.blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'htype') { histType = e.target.value; render(); }
    else if (e.target.name === 'name' && e.target.closest('form[data-form="prescribe"]')) {
      const form = e.target.closest('form'), v = e.target.value.trim();
      if (v) { const r = S.doctorMedicationCheck(form.dataset.hrid, v); if (r && r.alerts) form.querySelector('#alerts').innerHTML = alertsHtml(r); }
    }
  });

  window.addEventListener('hashchange', render);
  render();
})();
