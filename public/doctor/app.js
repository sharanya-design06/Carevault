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
      ${Number.isFinite(r.score) ? `<progress max="100" value="${r.score}" aria-label="${esc(r.condition)} screening score">${r.score}</progress>` : '<p class="mut">Insufficient data for a screening score.</p>'}
      <div>${badge(r.level.toLowerCase())} ${r.diagnosed || !Number.isFinite(r.score) ? '' : r.score + '/100 screening score'}<br><span class="mut">Data completeness ${r.confidence}%</span></div></div>
      ${detail ? `<details><summary>Factors</summary><ul>${r.factors.map((f) => `<li>${esc(f.label)}: ${f.known ? f.earned + '/' + f.max : '<span class="mut">data not available</span>'}</li>`).join('')}</ul></details>` : ''}`).join('')}
      <p class="mut">Experimental, rule-based screening scores—not disease predictions or probabilities. Missing measurements are excluded from the score. These unvalidated demo estimates must not guide care; clinician review is required.</p>`;
  }
  function summaryBlock(r) {
    if (r.processingStatus === 'processing') return '<p>' + badge('processing') + ' Local report extraction is running…</p>';
    const s = r.summary;
    if (!s) return '<p class="mut">No summary available.</p>';
    return `<p>${esc(s.headline)}</p>${s.summaryText ? `<p>${esc(s.summaryText)}</p>` : ''}
      ${s.findings.length ? `<table><thead><tr><th>Test</th><th>Value</th><th>Reference</th><th>Flag</th></tr></thead><tbody>
      ${s.findings.map((f) => `<tr><td>${esc(f.test)}</td><td>${esc(f.value)} ${esc(f.unit)}</td><td>${esc(f.range)}</td><td>${badge(f.flag)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${Array.isArray(s.highlights) && s.highlights.length ? `<h3>Report text highlights</h3><ul>${s.highlights.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}
      <p class="mut">Automated local extraction (${esc(s.model || 'demo')}); not an AI diagnosis. Check every value against the source PDF.</p>`;
  }

  function overviewTab(d) {
    const p = d.patient, c = p.clinical || {};
    const vit = [['BP', c.bpSys ? c.bpSys + '/' + c.bpDia + ' mmHg' : ''], ['BMI', c.bmi], ['HbA1c', c.hba1c ? c.hba1c + ' %' : ''], ['LDL', c.ldl ? c.ldl + ' mg/dL' : ''], ['eGFR', c.egfr]].filter((v) => v[1]);
    return `<div class="two">${allergyPanel(d)}${medPanel(d)}</div>
      <div class="card"><h2>Disease risk indicators</h2>${riskBars(d, false)}</div>
      ${vit.length ? `<div class="card"><h2>Latest vitals</h2><p>${vit.map((v) => `<span class="pill">${esc(v[0])}: ${esc(v[1])}</span>`).join(' ')}</p></div>` : ''}
      <div class="card"><h2>Latest automated report summaries</h2>${d.reports.slice(0, 3).map((r) => `<h3><a href="#/report/${esc(r.id)}">${esc(r.title)}</a> <span class="mut">${day(r.uploadedAt)}</span></h3>${summaryBlock(r)}`).join('') || '<p class="mut">No reports.</p>'}</div>
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
    if (!res.alerts.length) return alertBox('warn', 'No alert was found in the available interaction data. This does not confirm the medication is safe; verify the full medication list with a pharmacist.');
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
      <p class="mut">Interaction data may be incomplete and may not provide severity ratings. Verify alerts with a pharmacist.</p>
      <p><button type="button" data-action="check">Check safety</button> <button class="primary" type="submit">${f.needsOverride ? 'Prescribe despite alerts' : 'Prescribe'}</button></p></form>
      ${medPanel(d)}`;
  }

  function modelField(name, label, value, min, max, step = 'any') {
    return `<label>${label}<input name="${name}" type="number" value="${esc(value ?? '')}" min="${min}" max="${max}" step="${step}" required></label>`;
  }
  function modelChoice(name, label, options, value) {
    return `<label>${label}<select name="${name}" required><option value="">Select…</option>${options.map(([key, text]) => `<option value="${key}" ${String(value) === String(key) ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`;
  }
  function modelFields(condition, d) {
    const p = d.patient, c = p.clinical || {}, patientAge = Number.isFinite(age(p.dob)) ? age(p.dob) : '';
    if (condition === 'diabetes') {
      let glucose = '';
      for (const report of d.reports) {
        const findings = report.summary && report.summary.findings || [];
        const finding = findings.find((item) => /fasting glucose/i.test(item.test));
        if (finding) { glucose = finding.value; break; }
      }
      return modelField('Pregnancies', 'Pregnancies', '', 0, 30, 1) +
        modelField('Glucose', 'Glucose (mg/dL)', glucose, 0, 400) +
        modelField('BloodPressure', 'Diastolic blood pressure (mmHg)', c.bpDia, 0, 200) +
        modelField('SkinThickness', 'Skin thickness (mm)', '', 0, 150) +
        modelField('Insulin', 'Insulin (µU/mL)', '', 0, 1000) +
        modelField('BMI', 'BMI (kg/m²)', c.bmi, 0, 100) +
        modelField('DiabetesPedigreeFunction', 'Diabetes pedigree function (dataset value)', '', 0, 5) +
        modelField('Age', 'Age (years)', patientAge, 1, 120, 1);
    }
    const sex = /^female$/i.test(p.gender) ? 0 : /^male$/i.test(p.gender) ? 1 : '';
    if (condition === 'cardiac') {
      return modelField('age', 'Age (years)', patientAge, 1, 120, 1) +
        modelChoice('sex', 'Dataset sex code (0=female, 1=male)', [[0, '0 — Female'], [1, '1 — Male']], sex) +
        modelChoice('cp', 'Chest-pain category (dataset code)', [[0, '0'], [1, '1'], [2, '2'], [3, '3']]) +
        modelField('trestbps', 'Resting blood pressure (mmHg)', c.bpSys, 0, 300) +
        modelField('chol', 'Total cholesterol (mg/dL)', '', 0, 700) +
        modelChoice('fbs', 'Fasting blood sugar > 120 mg/dL', [[0, '0 — No'], [1, '1 — Yes']]) +
        modelChoice('restecg', 'Resting ECG (dataset code)', [[0, '0'], [1, '1'], [2, '2']]) +
        modelField('thalach', 'Maximum heart rate', '', 0, 300) +
        modelChoice('exang', 'Exercise-induced angina', [[0, '0 — No'], [1, '1 — Yes']]) +
        modelField('oldpeak', 'ST depression (oldpeak)', '', 0, 20) +
        modelChoice('slope', 'ST segment slope (dataset code)', [[0, '0'], [1, '1'], [2, '2']]) +
        modelChoice('ca', 'Number of major vessels (dataset code)', [[0, '0'], [1, '1'], [2, '2'], [3, '3'], [4, '4']]) +
        modelChoice('thal', 'Thalassemia (dataset code)', [[0, '0'], [1, '1'], [2, '2'], [3, '3']]);
    }
    return modelField('Age', 'Age (years)', patientAge, 1, 120, 1) +
      modelChoice('Gender', 'Dataset gender', [[0, 'Female'], [1, 'Male']], sex) +
      modelField('Total_Bilirubin', 'Total bilirubin', '', 0, 100) +
      modelField('Direct_Bilirubin', 'Direct bilirubin', '', 0, 100) +
      modelField('Alkaline_Phosphotase', 'Alkaline phosphatase', '', 0, 10000) +
      modelField('Alamine_Aminotransferase', 'Alanine aminotransferase (ALT)', '', 0, 10000) +
      modelField('Aspartate_Aminotransferase', 'Aspartate aminotransferase (AST)', '', 0, 10000) +
      modelField('Total_Protiens', 'Total proteins', '', 0, 100) +
      modelField('Albumin', 'Albumin', '', 0, 100) +
      modelField('Albumin_and_Globulin_Ratio', 'Albumin/globulin ratio', '', 0, 100);
  }
  function modelPopulationNote(condition) {
    const text = condition === 'diabetes'
      ? 'Pima Indians benchmark; all records are women aged 21 or older.'
      : condition === 'cardiac'
        ? 'Small historic Cleveland cohort; representativeness for current patients is unknown.'
        : 'Indian Liver Patient Dataset; representativeness outside its source cohort is unknown.';
    return `<p class="mut" data-model-population><b>Dataset scope:</b> ${esc(text)}</p>`;
  }
  function riskTab(d) {
    return `<div class="card"><h2>Disease risk dashboard</h2>${riskBars(d, true)}</div>
      <div class="card"><h2>Research model assessment</h2>
      <p class="mut">Optional locally trained research models. They return an uncalibrated dataset score, not a diagnosis or clinical risk. Confirm every input against the source record. No patient identifier is sent to the local service.</p>
      <form data-form="ai-predict" data-hrid="${esc(d.patient.hrid)}"><label>Model<select name="condition" data-model-condition><option value="diabetes">Diabetes</option><option value="cardiac">Heart disease</option><option value="liver">Liver disease</option></select></label>
      <div class="grid" data-model-fields>${modelFields('diabetes', d)}</div>${modelPopulationNote('diabetes')}<p><button class="primary" type="submit">Run local research model</button></p></form>
      <div data-model-result aria-live="polite"></div><p class="mut">Requires the local Python AI service and trained model artifacts. <a href="/docs" target="_blank" rel="noopener">Local service API documentation</a>.</p></div>`;
  }

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
      <div class="card"><h2>Automated report summary</h2>${summaryBlock(x)}</div>`);
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

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const k = form.dataset.form, hrid = form.dataset.hrid;
    if (k === 'ai-predict') {
      const condition = String(d.condition);
      const fields = condition === 'diabetes'
        ? ['Pregnancies', 'Glucose', 'BloodPressure', 'SkinThickness', 'Insulin', 'BMI', 'DiabetesPedigreeFunction', 'Age']
        : condition === 'cardiac'
          ? ['age', 'sex', 'cp', 'trestbps', 'chol', 'fbs', 'restecg', 'thalach', 'exang', 'oldpeak', 'slope', 'ca', 'thal']
          : ['Age', 'Gender', 'Total_Bilirubin', 'Direct_Bilirubin', 'Alkaline_Phosphotase', 'Alamine_Aminotransferase', 'Aspartate_Aminotransferase', 'Total_Protiens', 'Albumin', 'Albumin_and_Globulin_Ratio'];
      const features = Object.fromEntries(fields.map((name) => [name, Number(d[name])]));
      const output = form.parentElement.querySelector('[data-model-result]');
      output.innerHTML = alertBox('warn', 'Running the local research model…');
      form.querySelector('button[type="submit"]').disabled = true;
      form.elements.condition.disabled = true;
      try {
        const response = await fetch('/api/ai/v1/predict/' + condition, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ features }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || 'The local model request failed.');
        const metrics = result.metrics;
        output.innerHTML = alertBox('warn', `<b>${esc(result.prediction === 'positive' ? 'Positive model screen' : 'Negative model screen')} (${Math.round(result.modelScore * 100)}% score)</b><br>
          Target: ${esc(result.positiveLabel)} · Model: ${esc(result.model)} · Threshold: ${esc(result.decisionThreshold)}<br>
          Holdout precision: ${esc(metrics.precision)} · recall: ${esc(metrics.recall)} · F1: ${esc(metrics.f1)} · AUC-ROC: ${esc(metrics.aucRoc)}<br>
          Population limitation: ${esc(result.populationLimitation)}<br>
          ${esc(result.notice)}`);
      } catch (error) {
        output.innerHTML = alertBox('danger', `Local model unavailable: ${esc(error.message)} Train the models and run the Python AI service on this origin.`);
      } finally {
        form.querySelector('button[type="submit"]').disabled = false;
        form.elements.condition.disabled = false;
      }
    } else if (k === 'hrid') {
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
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      const r = await S.doctorCreatePrescription(hrid, d, d.override || '');
      if (r.ok) { toast(r.alerts && r.alerts.length ? 'Prescribed with alerts acknowledged' : 'Prescription saved'); location.hash = '#/patient/' + hrid; }
      else $app.innerHTML = patientView(hrid, 'prescribe', r.error, Object.assign({}, d, { needsOverride: !!r.needsOverride, check: r.alerts ? { alerts: r.alerts } : null }));
    }
  });

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    if (b.dataset.action === 'logout') { S.logout(); location.href = '/'; }
    else if (b.dataset.action === 'check') {
      const form = b.closest('form'), output = form.querySelector('#alerts');
      b.disabled = true;
      output.textContent = 'Checking available interaction data…';
      const r = await S.doctorMedicationCheck(form.dataset.hrid, form.elements.name.value);
      b.disabled = false;
      if (r.ok === false) { output.innerHTML = alertBox('warn', esc(r.error || 'Enter a medication first')); return; }
      form.querySelector('#alerts').innerHTML = alertsHtml(r);
    } else if (b.dataset.action === 'openPdf') {
      const r = await S.doctorReportFile(b.dataset.id);
      if (!r.ok) { toast(r.error); return; }
      const url = URL.createObjectURL(r.blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  });

  document.addEventListener('change', async (e) => {
    if (e.target.id === 'htype') { histType = e.target.value; render(); }
    else if (e.target.matches('[data-model-condition]')) {
      const form = e.target.closest('form');
      form.querySelector('[data-model-fields]').innerHTML = modelFields(e.target.value, S.doctorOpenPatient(form.dataset.hrid) || {});
      form.querySelector('[data-model-population]').outerHTML = modelPopulationNote(e.target.value);
      form.parentElement.querySelector('[data-model-result]').innerHTML = '';
    }
    else if (e.target.name === 'name' && e.target.closest('form[data-form="prescribe"]')) {
      const form = e.target.closest('form'), v = e.target.value.trim();
      if (v) {
        const output = form.querySelector('#alerts');
        output.textContent = 'Checking available interaction data…';
        const r = await S.doctorMedicationCheck(form.dataset.hrid, v);
        output.innerHTML = r.ok ? alertsHtml(r) : alertBox('warn', esc(r.error));
      }
    }
  });

  window.addEventListener('hashchange', render);
  render();
})();
