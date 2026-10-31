(function () {
  const { $app, S, esc, fmt, badge, toast, guard } = window.UI;

  const NAV = [['dashboard', 'Dashboard'], ['search', 'Patient Search']];
  const shell = (active, html) => window.UI.shell(NAV, 'Pharmacy Workspace', active, html);
  const age = (dob) => { const d = new Date(dob), n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--; return a; };
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : '—');
  const alertBox = (cls, html) => `<div class="alert ${cls}" role="alert">${html}</div>`;
  const TABS = [['', 'Medications & Allergies'], ['prescribe', 'Add Prescription'], ['history', 'Prescription History']];
  let flash = '';
  const takeFlash = () => { const f = flash; flash = ''; return f ? alertBox('danger', esc(f)) : ''; };

  function patientList(rows) {
    if (!rows.length) return '<p class="mut">No patients.</p>';
    return `<div class="tablewrap"><table><thead><tr><th>HRID</th><th>Name</th><th>Age</th><th>Gender</th><th></th></tr></thead><tbody>
      ${rows.map((p) => `<tr><td><code>${esc(p.hrid)}</code></td><td>${esc(p.name)}</td><td>${age(p.dob)}</td><td>${esc(p.gender)}</td><td><a class="btn sm" href="#/patient/${esc(p.hrid)}">Open</a></td></tr>`).join('')}</tbody></table></div>`;
  }
  function hridForm(err) {
    return `<form data-form="hrid" class="card"><h2>Find patient by HRID</h2>${err ? alertBox('danger', esc(err)) : ''}
      <div class="toolbar"><input name="hrid" placeholder="HDW-YYYYMMDD-XXXXXXXX" required maxlength="24" autocomplete="off" aria-label="HRID"><button class="primary" type="submit">Open</button></div></form>`;
  }

  function dashboardView() {
    const entries = S.pharmRecentEntries();
    return shell('dashboard', `<h1>Pharmacy Dashboard</h1>${takeFlash()}${hridForm()}
      <div class="two"><div class="card"><h2>Recently viewed patients</h2>${patientList(S.pharmRecentPatients())}</div>
      <div class="card"><h2>My recent medication entries</h2>${entries.length ? `<table><thead><tr><th>Patient</th><th>Medication</th><th>Entered</th></tr></thead><tbody>
        ${entries.map((m) => `<tr><td>${esc(m.patientName)}</td><td>${esc(m.name)} ${esc(m.dose)}</td><td>${day(m.createdAt)}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">No entries yet.</p>'}</div></div>`);
  }

  function searchView(err, results) {
    return shell('search', `<h1>Patient Search</h1>${takeFlash()}${hridForm(err)}
      <form data-form="secondary" class="card"><h2>Secondary lookup</h2><p class="mut">Date of birth plus full name or phone number, patients at your hospital only.</p>
        <div class="toolbar"><input name="name" placeholder="Full name" aria-label="Full name"><input name="phone" placeholder="Phone" aria-label="Phone"><input name="dob" type="date" required aria-label="Date of birth"><button type="submit">Search</button></div>
        ${results ? (results.length ? patientList(results) : '<p class="mut">No matching patient.</p>') : ''}</form>`);
  }

  function header(d, tab) {
    const p = d.patient;
    return `<div class="ptitle"><h1>${esc(p.name)}</h1><code>${esc(p.hrid)}</code><span class="mut">${age(p.dob)} y · ${esc(p.gender)} · DOB ${esc(p.dob)}</span></div>
      ${d.allergies.length ? alertBox('danger', '<b>Allergies:</b> ' + d.allergies.map((a) => esc(a.name) + ' (' + esc(a.reaction) + ')').join(', ')) : alertBox('info', 'No allergies documented. Confirm with the patient before dispensing.')}
      <nav class="tabs" aria-label="Patient sections">${TABS.map(([k, l]) => `<a class="${k === tab ? 'active' : ''}" href="#/patient/${esc(p.hrid)}${k ? '/' + k : ''}">${l}</a>`).join('')}</nav>`;
  }

  function medsTable(rows, withStatus) {
    if (!rows.length) return '<p class="mut">No medications to show.</p>';
    return `<div class="tablewrap"><table><thead><tr><th>Medication</th><th>Dose</th><th>Instructions</th><th>Prescriber</th><th>Source</th><th>Date</th>${withStatus ? '<th>Status</th>' : ''}</tr></thead><tbody>
      ${rows.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.dose)}</td><td>${esc(m.instructions)}</td><td>${esc(m.prescribedBy)}</td><td>${esc(m.hospitalName)}</td><td>${day(m.createdAt)}</td>${withStatus ? `<td>${badge(m.status)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
  }

  function overviewTab(d) {
    return `<div class="card"><h2>Current medications</h2>${medsTable(d.medications)}</div>
      <div class="card"><h2>Allergy profile</h2>${d.allergies.length ? `<table><thead><tr><th>Allergen</th><th>Reaction</th><th>Severity</th><th>Source</th></tr></thead><tbody>
      ${d.allergies.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.reaction)}</td><td>${badge(a.severity)}</td><td>${esc(a.hospitalName)}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">None documented.</p>'}</div>
      <p><a class="btn primary" href="#/patient/${esc(d.patient.hrid)}/prescribe">Add prescription / medication</a></p>`;
  }

  function alertsHtml(res) {
    if (!res) return '';
    if (!res.alerts.length) return alertBox('ok', 'No allergy or interaction alerts found for this medication.');
    return res.alerts.map((a) => {
      const crit = a.severity === 'major' || a.severity === 'contraindicated';
      return alertBox(crit ? 'danger' : 'warn', `<b>${crit ? 'CRITICAL' : 'Warning'} · ${esc(a.type === 'allergy' ? 'Allergy' : a.type === 'duplicate' ? 'Duplicate therapy' : 'Drug interaction')} (${esc(a.severity)})</b><br>${esc(a.message)}`);
    }).join('');
  }

  function prescribeTab(d, err, f) {
    f = f || {};
    return `<form data-form="prescribe" class="card" data-hrid="${esc(d.patient.hrid)}"><h2>Add prescription / medication</h2>${err ? alertBox('danger', esc(err)) : ''}
      <label>Medication<input name="name" list="drugs" required maxlength="80" autocomplete="off" value="${esc(f.name || '')}"></label>
      <datalist id="drugs">${S.DRUG_NAMES.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <div id="alerts" aria-live="polite">${alertsHtml(f.check)}</div>
      <label>Dose<input name="dose" required maxlength="40" value="${esc(f.dose || '')}"></label>
      <label>Route<select name="route">${['Oral', 'IV', 'IM', 'Topical', 'Inhaled'].map((r) => `<option ${r === f.route ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label>Frequency<input name="frequency" required maxlength="60" value="${esc(f.frequency || '')}"></label>
      <label>Duration<input name="duration" maxlength="60" value="${esc(f.duration || '')}"></label>
      <label>Indication<input name="indication" maxlength="120" value="${esc(f.indication || '')}"></label>
      ${f.needsOverride ? '<label>Override reason (required for critical alerts, min 10 characters)<textarea name="override" rows="3" required minlength="10" maxlength="300"></textarea></label>' : ''}
      <p><button type="button" data-action="check">Check interactions &amp; allergies</button> <button class="primary" type="submit">${f.needsOverride ? 'Finalize despite critical alert' : 'Finalize'}</button></p></form>
      <div class="card"><h2>Current medications</h2>${medsTable(d.medications)}</div>`;
  }

  function patientView(hrid, tab, err, f) {
    const d = S.pharmOpenPatient(hrid);
    if (!d) { flash = 'That patient is not accessible at your hospital.'; location.hash = '#/search'; return ''; }
    const body = { '': () => overviewTab(d), prescribe: () => prescribeTab(d, err, f), history: () => `<div class="card"><h2>Prescription history</h2>${medsTable(d.history, true)}</div>` }[tab];
    if (!body) return patientView(hrid, '');
    return shell('search', header(d, tab) + body());
  }

  async function render() {
    await S.ready();
    if (!guard('pharmacist')) return;
    S.touch();
    const [a, b, c] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
    let html;
    if (a === 'patient' && b) html = patientView(decodeURIComponent(b), c || '');
    else if (a === 'search') html = searchView();
    else html = dashboardView();
    if (html) $app.innerHTML = html;
  }

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form)), k = form.dataset.form, hrid = form.dataset.hrid;
    if (k === 'hrid') {
      const r = S.pharmFindPatient(d.hrid);
      if (r.ok) location.hash = '#/patient/' + r.patient.hrid; else $app.innerHTML = searchView(r.error);
    } else if (k === 'secondary') {
      const r = S.pharmSearchSecondary(d);
      $app.innerHTML = searchView(r.ok ? '' : r.error, r.ok ? r.results : null);
    } else if (k === 'prescribe') {
      const r = S.pharmCreatePrescription(hrid, d, d.override || '');
      if (r.ok) { toast(r.alerts && r.alerts.length ? 'Saved with alerts acknowledged' : 'Prescription saved'); location.hash = '#/patient/' + hrid + '/history'; }
      else $app.innerHTML = patientView(hrid, 'prescribe', r.error, Object.assign({}, d, { needsOverride: !!r.needsOverride, check: r.alerts ? { alerts: r.alerts } : null }));
    }
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    if (b.dataset.action === 'logout') { S.logout(); location.href = '/'; }
    else if (b.dataset.action === 'check') {
      const form = b.closest('form'), r = S.pharmMedicationCheck(form.dataset.hrid, form.elements.name.value);
      if (r.ok === false) { toast(r.error); return; }
      form.querySelector('#alerts').innerHTML = alertsHtml(r);
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.name === 'name' && e.target.closest('form[data-form="prescribe"]') && e.target.value.trim()) {
      const form = e.target.closest('form'), r = S.pharmMedicationCheck(form.dataset.hrid, e.target.value);
      if (r && r.alerts) form.querySelector('#alerts').innerHTML = alertsHtml(r);
    }
  });

  window.addEventListener('hashchange', render);
  render();
})();
