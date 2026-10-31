(function () {
  const { $app, S, esc, fmt, badge, toast, guard } = window.UI;

  const NAV = [['dashboard', 'Dashboard'], ['search', 'Patient Search']];
  const shell = (active, html) => window.UI.shell(NAV, 'Nursing Workspace', active, html);
  const alertBox = (cls, html) => `<div class="alert ${cls}" role="alert">${html}</div>`;
  const TABS = [['', 'Basic Information'], ['record', 'Record Vitals'], ['history', 'Vital History']];
  const FIELDS = [['temp', 'Temperature (°C)', '0.1'], ['pulse', 'Pulse (bpm)', '1'], ['bpSys', 'Systolic BP (mmHg)', '1'], ['bpDia', 'Diastolic BP (mmHg)', '1'],
    ['rr', 'Respiratory rate (/min)', '1'], ['spo2', 'Oxygen saturation (%)', '1'], ['weightKg', 'Weight (kg)', '0.1'], ['pain', 'Pain score (0–10)', '1']];
  let flash = '';
  const takeFlash = () => { const f = flash; flash = ''; return f ? alertBox('danger', esc(f)) : ''; };
  const age = (dob) => { const d = new Date(dob), n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--; return a; };

  function patientList(rows) {
    if (!rows.length) return '<p class="mut">No patients.</p>';
    return `<div class="tablewrap"><table><thead><tr><th>HRID</th><th>Name</th><th>Age</th><th>Gender</th><th></th></tr></thead><tbody>
      ${rows.map((p) => `<tr><td><code>${esc(p.hrid)}</code></td><td>${esc(p.name)}</td><td>${age(p.dob)}</td><td>${esc(p.gender)}</td><td><a class="btn sm" href="#/patient/${esc(p.hrid)}">Open</a></td></tr>`).join('')}</tbody></table></div>`;
  }
  function hridForm(err) {
    return `<form data-form="hrid" class="card"><h2>Find patient by HRID</h2>${err ? alertBox('danger', esc(err)) : ''}
      <div class="toolbar"><input name="hrid" placeholder="HDW-YYYYMMDD-XXXXXXXX" required maxlength="24" autocomplete="off" aria-label="HRID"><button class="primary" type="submit">Open</button></div></form>`;
  }

  const nz = (x) => (x == null ? '—' : x);
  const vitalCells = (v) => `<td>${nz(v.temp)}</td><td>${nz(v.pulse)}</td><td>${v.bpSys != null ? v.bpSys + '/' + v.bpDia : '—'}</td><td>${nz(v.rr)}</td><td>${nz(v.spo2)}</td><td>${nz(v.weightKg)}</td><td>${nz(v.pain)}</td>`;
  const VHEAD = '<th>°C</th><th>Pulse</th><th>BP</th><th>RR</th><th>SpO₂ %</th><th>kg</th><th>Pain</th>';

  function dashboardView() {
    const e = S.nurseRecentEntries();
    return shell('dashboard', `<h1>Nursing Dashboard</h1>${takeFlash()}${hridForm()}
      <div class="two"><div class="card"><h2>Recently viewed patients</h2>${patientList(S.nurseRecentPatients())}</div>
      <div class="card"><h2>My recent vitals entries</h2>${e.length ? `<table><thead><tr><th>Patient</th><th>When</th><th>BP</th><th>Flags</th></tr></thead><tbody>
        ${e.map((v) => `<tr><td>${esc(v.patientName)}</td><td>${esc(fmt(v.recordedAt))}</td><td>${v.bpSys != null ? v.bpSys + '/' + v.bpDia : '—'}</td><td>${v.flags.length ? badge('high') + ' ' + esc(v.flags.join(', ')) : '—'}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">No entries yet.</p>'}</div></div>`);
  }

  function searchView(err, results) {
    return shell('search', `<h1>Patient Search</h1>${takeFlash()}${hridForm(err)}
      <form data-form="secondary" class="card"><h2>Secondary lookup</h2><p class="mut">Date of birth plus full name or phone number, patients at your hospital only.</p>
        <div class="toolbar"><input name="name" placeholder="Full name" aria-label="Full name"><input name="phone" placeholder="Phone" aria-label="Phone"><input name="dob" type="date" required aria-label="Date of birth"><button type="submit">Search</button></div>
        ${results ? (results.length ? patientList(results) : '<p class="mut">No matching patient.</p>') : ''}</form>`);
  }

  function header(d, tab) {
    const p = d.patient;
    return `<div class="ptitle"><h1>${esc(p.name)}</h1><code>${esc(p.hrid)}</code><span class="mut">${p.age} y · ${esc(p.gender)}</span></div>
      ${d.allergies.length ? alertBox('danger', '<b>Allergies:</b> ' + d.allergies.map((a) => esc(a.name) + ' (' + esc(a.reaction) + ')').join(', ')) : ''}
      <nav class="tabs" aria-label="Patient sections">${TABS.map(([k, l]) => `<a class="${k === tab ? 'active' : ''}" href="#/patient/${esc(p.hrid)}${k ? '/' + k : ''}">${l}</a>`).join('')}</nav>`;
  }

  function infoTab(d) {
    const p = d.patient, v = d.vitals[0];
    return `<div class="two"><div class="card"><h2>Patient information</h2>
      <p>Name: <b>${esc(p.name)}</b></p><p>HRID: <code>${esc(p.hrid)}</code></p><p>Date of birth: ${esc(p.dob)} (${p.age} y)</p><p>Gender: ${esc(p.gender)}</p>
      <p>Phone: ${esc(p.phone) || '—'}</p><p>Emergency contact: ${esc(p.emergencyName) || '—'} ${esc(p.emergencyPhone)}</p><p>Registered at: ${esc(p.hospitalName)}</p></div>
      <div class="card"><h2>Latest vitals</h2>${v ? `<p class="mut">${esc(fmt(v.recordedAt))} by ${esc(v.recordedByName)}</p><div class="tablewrap"><table><thead><tr>${VHEAD}</tr></thead><tbody><tr>${vitalCells(v)}</tr></tbody></table></div>
        ${v.flags.length ? alertBox('warn', 'Outside typical range: ' + esc(v.flags.join(', ')) + '. Escalate per ward protocol.') : ''}` : '<p class="mut">No vitals recorded.</p>'}
      <a class="btn primary" href="#/patient/${esc(p.hrid)}/record">Record vitals</a></div></div>`;
  }

  function recordTab(d, err, f, corrects) {
    f = f || {};
    return `<form data-form="vitals" class="card" data-hrid="${esc(d.patient.hrid)}" data-corrects="${esc(corrects || '')}"><h2>${corrects ? 'Update vital measurements' : 'Record vitals'}</h2>
      <p class="mut">${corrects ? 'This creates a new entry that references the earlier one; the original measurement is kept unchanged.' : 'Leave a field empty if it was not measured.'}</p>
      ${err ? alertBox('danger', esc(err)) : ''}
      ${FIELDS.map(([k, l, step]) => `<label>${l}<input name="${k}" type="number" step="${step}" inputmode="decimal" value="${esc(f[k] == null ? '' : f[k])}"></label>`).join('')}
      <label>Notes<textarea name="notes" rows="2" maxlength="300">${esc(f.notes || '')}</textarea></label>
      <p><button class="primary" type="submit">Save vitals</button></p></form>`;
  }

  function historyTab(d) {
    const hid = S.session().hospitalId;
    return `<div class="card"><h2>Vital history</h2>${d.vitals.length ? `<div class="tablewrap"><table><thead><tr><th>Recorded</th>${VHEAD}<th>Flags</th><th>By</th><th></th></tr></thead><tbody>
      ${d.vitals.map((v) => `<tr><td>${esc(fmt(v.recordedAt))}${v.correctsId ? '<br><span class="pill">update</span>' : ''}</td>${vitalCells(v)}<td>${v.flags.length ? esc(v.flags.join(', ')) : '—'}</td><td>${esc(v.recordedByName)}<br><span class="mut">${esc(v.hospitalName)}</span></td>
      <td>${v.hospitalId === hid ? `<a class="btn sm" href="#/patient/${esc(d.patient.hrid)}/update/${esc(v.id)}">New entry from this</a>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">No vitals recorded.</p>'}
      <p class="mut">Entries are append-only; corrections are saved as new entries.</p></div>`;
  }

  function patientView(hrid, tab, arg, err, f) {
    const d = S.nurseOpenPatient(hrid);
    if (!d) { flash = 'That patient is not accessible at your hospital.'; location.hash = '#/search'; return ''; }
    let body, active = tab;
    if (tab === 'update') {
      body = recordTab(d, err, f || d.vitals.find((v) => v.id === arg) || {}, arg); active = 'record';
    } else {
      const fn = { '': () => infoTab(d), record: () => recordTab(d, err, f), history: () => historyTab(d) }[tab];
      if (!fn) return patientView(hrid, '');
      body = fn();
    }
    return shell('search', header(d, active) + body);
  }

  async function render() {
    await S.ready();
    if (!guard('nurse')) return;
    S.touch();
    const [a, b, c, e] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
    let html;
    if (a === 'patient' && b) html = patientView(decodeURIComponent(b), c || '', e);
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
      const r = S.nurseFindPatient(d.hrid);
      if (r.ok) location.hash = '#/patient/' + r.patient.hrid; else $app.innerHTML = searchView(r.error);
    } else if (k === 'secondary') {
      const r = S.nurseSearchSecondary(d);
      $app.innerHTML = searchView(r.ok ? '' : r.error, r.ok ? r.results : null);
    } else if (k === 'vitals') {
      const corrects = form.dataset.corrects;
      const r = S.nurseRecordVitals(hrid, d, corrects);
      if (r.ok) { toast(r.entry.flags.length ? 'Vitals saved — outside range: ' + r.entry.flags.join(', ') : 'Vitals saved'); location.hash = '#/patient/' + hrid + '/history'; }
      else $app.innerHTML = patientView(hrid, corrects ? 'update' : 'record', corrects, r.error, d);
    }
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b && b.dataset.action === 'logout') { S.logout(); location.href = '/'; }
  });

  window.addEventListener('hashchange', render);
  render();
})();
