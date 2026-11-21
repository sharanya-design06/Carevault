// Doctor, nurse, pharmacist and lab dashboards backed by Firebase sign-in and server-authorized callables.
// The role is taken from the page path; the server re-checks it on every call.
(function () {
  const FS = window.FirebaseSession;
  if (!FS || !FS.enabled) return;
  const { $app, esc, badge, toast, guard } = window.UI;

  const PAGE = location.pathname.split('/')[1];
  const CFG = {
    doctor: { guard: 'doctor', title: 'Doctor Workspace', write: ['diagnosis', 'prescription'] },
    nurse: { guard: 'nurse', title: 'Nursing Workspace', write: ['vitals'] },
    pharmacist: { guard: 'pharmacist', title: 'Pharmacy Workspace', write: [] },
    lab: { guard: 'lab', title: 'Laboratory Workspace', write: [] },
  }[PAGE];
  if (!CFG) return;

  const NAV = [['dashboard', 'My Patients'], ['open', 'Open Patient by HRID']];
  const shell = (active, html) => window.UI.shell(NAV, CFG.title, active, html);
  const message = (e) => (e && e.message === 'Signed out' ? null : (e && e.message) || 'Request failed.');
  const when = (ms) => new Date(ms).toLocaleString();
  const label = (v) => String(v || '').replace(/_/g, ' ').toLowerCase();
  const num = (v) => (v === '' || v === undefined ? undefined : Number(v));
  const VITAL_FIELDS = [['temp', 'Temperature (°C)', '0.1'], ['pulse', 'Pulse (bpm)', '1'], ['bpSys', 'Systolic BP', '1'], ['bpDia', 'Diastolic BP', '1'], ['spo2', 'SpO₂ (%)', '1'],
    ['rr', 'Respiratory rate (/min)', '1'], ['weightKg', 'Weight (kg)', '0.1'], ['heightCm', 'Height (cm)', '0.1'], ['pain', 'Pain score (0–10)', '1']];
  const QUEUE = { emergent: 'Emergent', urgent: 'Urgent', less_urgent: 'Less urgent', non_urgent: 'Non-urgent' };
  const RISKS = ['low', 'moderate', 'high'];
  const CATEGORIES = ['elderly', 'child', 'pregnant', 'disabled', 'immunocompromised', 'cognitively_impaired', 'fall_risk'];
  const priorityTag = (on) => (on ? ' <span class="badge" title="Priority Care">★ Priority Care</span>' : '');
  // Display-only preview of the BMI the server will calculate and save (WHO adult cut-offs by default).
  const previewBmi = (w, h) => {
    if (!(w > 0) || !(h > 0)) return 'Enter weight and height to see BMI.';
    const bmi = Math.round((w / ((h / 100) ** 2)) * 10) / 10;
    if (!(bmi >= 8 && bmi <= 100)) return 'Weight and height are not plausible together.';
    return 'BMI ' + bmi + ' — the saved category follows hospital policy and age.';
  };
  const NOTE_TYPES = {
    consultation: ['Consultation note', [['complaint', 'Complaint'], ['history', 'History'], ['examination', 'Examination'], ['assessment', 'Assessment'], ['plan', 'Plan']]],
    progress: ['Progress note (inpatient)', [['subjective', 'Subjective'], ['objective', 'Objective'], ['assessment', 'Assessment'], ['plan', 'Plan']]],
    referral: ['Referral', [['toSpecialty', 'Refer to (specialty)'], ['reason', 'Reason'], ['summary', 'Summary']]],
    operative: ['Operative note (surgeon)', [['consentConfirmed', 'Consent confirmed'], ['procedure', 'Procedure'], ['findings', 'Findings'], ['implants', 'Implants used'], ['postOpOrders', 'Post-op orders']]],
    anesthesia: ['Anesthesia record (anesthetist)', [['preAssessment', 'Pre-anesthesia assessment'], ['chart', 'Anesthesia chart'], ['recovery', 'Recovery notes']]],
    discharge: ['Discharge summary', [['diagnosis', 'Diagnosis'], ['procedures', 'Procedures'], ['results', 'Results'], ['medicines', 'Medicines'], ['followUp', 'Follow-up'], ['warningSigns', 'Warning signs']]],
  };
  const NOTE_SUBTYPE = { operative: 'SURGEON', anesthesia: 'ANESTHETIST' };
  const writableNotes = () => (PAGE === 'doctor' ? Object.keys(NOTE_TYPES).filter((t) => !NOTE_SUBTYPE[t] || (FS.session() || {}).subType === NOTE_SUBTYPE[t]) : []);
  let flash = '';
  let caution = '';
  const CHILD_BMI_CAUTION = 'Caution: this patient is under 18, so no BMI category was assigned. Adult cut-offs do not apply; check the BMI against a BMI-for-age percentile chart.';

  function patientsView(rows) {
    return shell('dashboard', `<h1>My Patients</h1><div class="card">${rows.length ? `<div class="tablewrap"><table><thead><tr><th>HRID</th><th>Name</th><th>Date of birth</th><th>Gender</th><th>Priority</th><th></th></tr></thead><tbody>
      ${rows.map((p) => `<tr><td><code>${esc(p.hrid)}</code></td><td>${esc(p.name)}${priorityTag(p.priorityCare)}</td><td>${esc(p.dob)}</td><td>${esc(p.gender)}</td><td>${esc(QUEUE[p.queuePriority] || 'Not triaged')}</td><td><a class="btn sm" href="#/patient/${esc(p.hrid)}">Open</a></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="mut">No patients are assigned to you yet. The Patient Care Coordinator assigns patients to clinicians.</p>'}</div>`);
  }

  function openView(err) {
    return shell('open', `<h1>Open Patient by HRID</h1><form class="card" data-form="open"><label for="hrid">Health Record ID</label>
      <input id="hrid" name="hrid" required maxlength="24" pattern="HDW-[0-9]{8}-[A-Z0-9]{8}" placeholder="HDW-YYYYMMDD-XXXXXXXX">
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}<p><button class="primary" type="submit">Open</button></p>
      <p class="mut">Patients outside your care or hospital need a recorded reason; the patient is notified.</p></form>`);
  }

  function accessView(hrid, err) {
    return shell('open', `<h1>Access requires a reason</h1><form class="card" data-form="access"><input type="hidden" name="hrid" value="${esc(hrid)}">
      <p>This patient is not assigned to you. Another hospital's patient can be viewed for 24 hours with a recorded reason. The patient will be notified.</p>
      <label for="reason">Reason (10–500 characters)</label><textarea id="reason" name="reason" required minlength="10" maxlength="500"></textarea>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}<p><button class="primary" type="submit">Record reason &amp; view</button></p></form>`);
  }

  function recordLine(r) {
    const d = r.data || {};
    if (r.type === 'vitals') {
      const bmi = d.bmi === undefined ? '' : ` · BMI: ${esc(d.bmi)} (${d.bmiCategory ? esc(d.bmiCategory) : 'under 18: age percentile needed'})`;
      return VITAL_FIELDS.filter(([k]) => d[k] !== undefined).map(([k, l]) => `${esc(l)}: ${esc(d[k])}`).join(' · ') + bmi;
    }
    if (r.type === 'triage') {
      return `<b>${esc(d.chiefComplaint)}</b> · ${esc(QUEUE[d.queuePriority])}${d.allergies ? ' · Allergies: ' + esc(d.allergies) : ''}${d.currentMedications ? ' · Medicines: ' + esc(d.currentMedications) : ''}${d.fallRisk ? ' · Fall risk: ' + esc(d.fallRisk) : ''}${d.pressureSoreRisk ? ' · Pressure-sore risk: ' + esc(d.pressureSoreRisk) : ''}`;
    }
    if (r.type === 'diagnosis') return `<b>${esc(d.condition)}</b>${d.notes ? ' — ' + esc(d.notes) : ''}`;
    return `<b>${esc(d.drug)}</b> ${esc(d.dose)}, ${esc(d.frequency)}, ${esc(d.days)} day(s) ${badge(r.status === 'dispensed' ? 'active' : 'pending')} ${esc(r.status)}`;
  }

  function forms(hrid) {
    const out = [];
    if (CFG.write.includes('vitals')) {
      out.push(`<form class="card" data-form="vitals"><h2>Record vitals</h2><input type="hidden" name="hrid" value="${esc(hrid)}"><div class="formrow">
        ${VITAL_FIELDS.map(([k, l, step]) => `<div><label for="v-${k}">${l}</label><input id="v-${k}" name="${k}" type="number" step="${step}"></div>`).join('')}</div>
        <p id="bmi-preview" class="mut" role="status">${previewBmi()}</p>
        <p><button class="primary" type="submit">Save vitals</button></p></form>`);
      out.push(`<form class="card" data-form="triage"><h2>Triage</h2><input type="hidden" name="hrid" value="${esc(hrid)}">
        <label for="t-complaint">Chief complaint</label><input id="t-complaint" name="chiefComplaint" required maxlength="300">
        <div class="formrow"><div><label for="t-allergies">Allergies</label><input id="t-allergies" name="allergies" maxlength="500"></div>
        <div><label for="t-meds">Current medications</label><input id="t-meds" name="currentMedications" maxlength="500"></div></div>
        <div class="formrow"><div><label for="t-fall">Fall risk</label><select id="t-fall" name="fallRisk"><option value="">Not assessed</option>${RISKS.map((r) => `<option>${r}</option>`).join('')}</select></div>
        <div><label for="t-ps">Pressure-sore risk</label><select id="t-ps" name="pressureSoreRisk"><option value="">Not assessed</option>${RISKS.map((r) => `<option>${r}</option>`).join('')}</select></div>
        <div><label for="t-q">Queue priority</label><select id="t-q" name="queuePriority" required>${Object.entries(QUEUE).map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div></div>
        <p><button class="primary" type="submit">Complete triage</button></p></form>`);
    }
    if (CFG.write.includes('diagnosis')) {
      out.push(`<form class="card" data-form="diagnosis"><h2>New diagnosis</h2><input type="hidden" name="hrid" value="${esc(hrid)}">
        <label for="condition">Condition</label><input id="condition" name="condition" required maxlength="200"><label for="notes">Notes</label><textarea id="notes" name="notes" maxlength="1000"></textarea>
        <p><button class="primary" type="submit">Save diagnosis</button></p></form>`);
      out.push(`<form class="card" data-form="prescription"><h2>New prescription</h2><input type="hidden" name="hrid" value="${esc(hrid)}"><div class="formrow">
        <div><label for="drug">Medicine</label><input id="drug" name="drug" required maxlength="120"></div><div><label for="dose">Dose</label><input id="dose" name="dose" required maxlength="60"></div></div>
        <div class="formrow"><div><label for="frequency">Frequency</label><input id="frequency" name="frequency" required maxlength="60"></div><div><label for="days">Days</label><input id="days" name="days" type="number" min="1" max="365" required></div></div>
        <p><button class="primary" type="submit">Save prescription</button></p></form>`);
    }
    return out.join('');
  }

  function noteFields(type, values) {
    return NOTE_TYPES[type][1].map(([k, l]) => (k === 'consentConfirmed'
      ? `<label><input type="checkbox" name="${k}" ${values[k] ? 'checked' : ''}> ${esc(l)}</label>`
      : `<label for="n-${esc(type)}-${k}">${esc(l)}</label><textarea id="n-${esc(type)}-${k}" name="${k}" maxlength="5000">${esc(values[k] || '')}</textarea>`)).join('');
  }

  function noteCard(n, care) {
    const [title, fields] = NOTE_TYPES[n.noteType];
    const body = fields.filter(([k]) => n.content[k] !== undefined && n.content[k] !== '')
      .map(([k, l]) => `<dt>${esc(l)}</dt><dd>${k === 'consentConfirmed' ? (n.content[k] ? 'Yes' : 'No') : esc(n.content[k])}</dd>`).join('');
    const addenda = n.addenda.map((a) => `<p class="mut"><b>Addendum ${esc(when(a.createdAt))}</b> — ${esc(a.text)} <i>(reason: ${esc(a.reason)})</i></p>`).join('');
    let actions = '';
    if (care && n.own && n.status === 'draft') {
      actions = `<details><summary>Edit draft</summary><form data-form="note" data-type="${esc(n.noteType)}"><input type="hidden" name="noteId" value="${esc(n.id)}"><input type="hidden" name="baseVersion" value="${esc(n.version)}">
        ${noteFields(n.noteType, n.content)}<p><button class="primary" type="submit">Save new version</button></p></form></details>
        <p><button class="sm primary" data-action="sign-note" data-id="${esc(n.id)}">Sign note</button> <span class="mut">Signed notes cannot be edited; corrections are addenda.</span></p>`;
    } else if (care && n.own && n.status === 'signed') {
      actions = `<details><summary>Add addendum</summary><form data-form="addendum"><input type="hidden" name="noteId" value="${esc(n.id)}">
        <label for="a-${esc(n.id)}">What changed</label><textarea id="a-${esc(n.id)}" name="text" required maxlength="5000"></textarea>
        <label for="r-${esc(n.id)}">Why</label><input id="r-${esc(n.id)}" name="reason" required maxlength="500"><p><button class="primary" type="submit">Add dated addendum</button></p></form></details>`;
    }
    return `<div class="card"><h3>${esc(title)} ${badge(n.status === 'signed' ? 'active' : 'pending')} ${esc(n.status)} · v${esc(n.version)}</h3>
      <p class="mut">${esc(when(n.createdAt))} · ${esc(label(n.authorRole))}${n.authorSubType ? ' (' + esc(label(n.authorSubType)) + ')' : ''}</p><dl class="kv">${body}</dl>${addenda}${actions}</div>`;
  }

  function notesSection(hrid, notes, care) {
    if (notes === null) return '';
    const create = care ? writableNotes().map((t) => `<details><summary>New ${esc(NOTE_TYPES[t][0].toLowerCase())}</summary><form data-form="note" data-type="${t}"><input type="hidden" name="hrid" value="${esc(hrid)}">
      ${noteFields(t, {})}<p><button class="primary" type="submit">Save draft</button></p></form></details>`).join('') : '';
    return `<div class="card"><h2>Clinical notes</h2>${create}${notes.length ? '' : '<p class="mut">No notes visible to you yet.</p>'}</div>${notes.map((n) => noteCard(n, care)).join('')}`;
  }

  function priorityForm(p) {
    const chosen = p.priorityCareCategories && p.priorityCareCategories.length ? p.priorityCareCategories : (p.suggestedPriorityCategories || []);
    return `<form class="card" data-form="priority"><h2>Priority Care</h2><input type="hidden" name="hrid" value="${esc(p.hrid)}">
      <p class="mut">Staff elsewhere see only a neutral "Priority Care" marker, never the reasons. ${p.suggestedPriorityCategories && p.suggestedPriorityCategories.length ? 'Suggested from age: ' + p.suggestedPriorityCategories.map(label).join(', ') + '.' : ''}</p>
      <div class="formrow">${CATEGORIES.map((c) => `<label><input type="checkbox" name="cat" value="${c}" ${chosen.includes(c) ? 'checked' : ''}> ${esc(label(c))}</label>`).join('')}</div>
      <p><button class="primary" type="submit" name="active" value="on">${p.priorityCare ? 'Update flag' : 'Set Priority Care'}</button>
      ${p.priorityCare ? '<button class="sm" type="submit" name="active" value="off" formnovalidate>Clear flag</button>' : ''}</p></form>`;
  }

  function takeCaution() {
    const text = caution; caution = '';
    return text ? `<div class="alert warn" role="alert">${esc(text)}</div>` : '';
  }

  function patientView(p, records, care, err, notes) {
    const dispense = (r) => PAGE === 'pharmacist' && care && r.type === 'prescription' && r.status === 'pending'
      ? ` <button class="sm primary" data-action="dispense" data-id="${esc(r.id)}">Mark dispensed</button>` : '';
    return shell(care ? 'dashboard' : 'open', `<h1>${esc(p.name)}${priorityTag(p.priorityCare)}</h1><p><a class="btn" href="#/dashboard">← My patients</a></p>
      ${care ? '' : '<div class="alert warn" role="alert">Read-only view under a recorded reason. You cannot add records for this patient.</div>'}
      <div class="card"><h2>Patient</h2><dl class="kv"><dt>HRID</dt><dd><code>${esc(p.hrid)}</code></dd><dt>Date of birth</dt><dd>${esc(p.dob)}</dd><dt>Gender</dt><dd>${esc(p.gender)}</dd><dt>Phone</dt><dd>${esc(p.phone) || '—'}</dd></dl></div>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}${takeCaution()}${care ? forms(p.hrid) : ''}${care && (PAGE === 'nurse' || PAGE === 'doctor') ? priorityForm(p) : ''}
      ${notesSection(p.hrid, notes, care)}
      <div class="card"><h2>Records</h2>${records === null ? '<p class="mut">Your role does not include clinical records.</p>' : records.length
        ? `<table><tbody>${records.map((r) => `<tr><td>${esc(when(r.createdAt))}</td><td>${esc(label(r.type))}</td><td>${recordLine(r)}${dispense(r)}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">No records yet.</p>'}</div>`);
  }

  async function renderPatient(hrid, err) {
    let patient;
    try { patient = await FS.call('getDashboardPatient', { hrid }); } catch (e) {
      if (e && e.message !== 'Signed out' && /denied/i.test(e.message)) { $app.innerHTML = accessView(hrid, err); return; }
      throw e;
    }
    const mine = await FS.call('listMyPatients');
    let records = null;
    try { records = await FS.call('listClinicalRecords', { hrid }); } catch (e) { if (e && e.message === 'Signed out') throw e; }
    let notes = null;
    if (PAGE === 'doctor' || PAGE === 'nurse') {
      try { notes = await FS.call('listDashboardNotes', { hrid }); } catch (e) { if (e && e.message === 'Signed out') throw e; }
    }
    $app.innerHTML = patientView(patient, records, mine.some((m) => m.hrid === hrid), err, notes);
  }

  async function render() {
    if (!guard(CFG.guard)) return;
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (!parts.length) { location.replace('#/dashboard'); return; }
    const err = flash; flash = '';
    try {
      if (parts[0] === 'dashboard') $app.innerHTML = patientsView(await FS.call('listMyPatients'));
      else if (parts[0] === 'open') $app.innerHTML = openView(err);
      else if (parts[0] === 'patient' && parts[1]) await renderPatient(parts[1], err);
      else $app.innerHTML = shell('', '<h1>Page not found</h1>');
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
    const kind = form.dataset.form;
    form.querySelector('button[type="submit"]').disabled = true;
    try {
      if (kind === 'open') { location.hash = '#/patient/' + d.hrid.trim().toUpperCase(); return; }
      if (kind === 'access') { await FS.call('requestCrossHospitalAccess', { hrid: d.hrid, reason: d.reason }); await renderPatient(d.hrid); return; }
      if (kind === 'triage') {
        const data = {};
        for (const k of ['chiefComplaint', 'allergies', 'currentMedications', 'fallRisk', 'pressureSoreRisk', 'queuePriority']) if (d[k]) data[k] = d[k];
        await FS.call('addClinicalRecord', { hrid: d.hrid, type: 'triage', data });
        toast('Triage completed');
        await renderPatient(d.hrid);
        return;
      }
      if (kind === 'priority') {
        const active = e.submitter && e.submitter.value === 'on';
        await FS.call('setPriorityCare', { hrid: d.hrid, active, ...(active ? { categories: new FormData(form).getAll('cat') } : {}) });
        toast(active ? 'Priority Care set' : 'Priority Care cleared');
        await renderPatient(d.hrid);
        return;
      }
      if (kind === 'note') {
        const type = form.dataset.type, content = {};
        NOTE_TYPES[type][1].forEach(([k]) => {
          if (k === 'consentConfirmed') content[k] = d[k] === 'on';
          else if (d[k]) content[k] = d[k];
        });
        const edit = d.noteId ? { noteId: d.noteId, baseVersion: Number(d.baseVersion) } : { hrid: d.hrid };
        await FS.call('saveDashboardNote', { noteType: type, content, ...edit });
        toast('Note saved');
        await renderPatient(d.hrid || location.hash.split('/')[2]);
        return;
      }
      if (kind === 'addendum') {
        await FS.call('addDashboardNoteAddendum', { noteId: d.noteId, text: d.text, reason: d.reason });
        toast('Addendum added');
        await renderPatient(location.hash.split('/')[2]);
        return;
      }
      const { hrid, ...rest } = d;
      let data;
      if (kind === 'vitals') { data = {}; VITAL_FIELDS.forEach(([k]) => { if (num(rest[k]) !== undefined) data[k] = num(rest[k]); }); }
      else if (kind === 'diagnosis') data = { condition: rest.condition, ...(rest.notes ? { notes: rest.notes } : {}) };
      else data = { drug: rest.drug, dose: rest.dose, frequency: rest.frequency, days: Number(rest.days) };
      const saved = await FS.call('addClinicalRecord', { hrid, type: kind, data });
      if (kind === 'vitals' && saved && saved.bmiBasis === 'age_percentile_required') caution = CHILD_BMI_CAUTION;
      toast('Saved');
      await renderPatient(hrid);
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
    if (b.dataset.action === 'sign-note') {
      b.disabled = true;
      try { await FS.call('signDashboardNote', { noteId: b.dataset.id }); toast('Note signed'); render(); } catch (error) { toast(message(error) || 'Signed out'); b.disabled = false; }
      return;
    }
    if (b.dataset.action === 'dispense') {
      b.disabled = true;
      try { await FS.call('dispensePrescription', { recordId: b.dataset.id }); toast('Marked dispensed'); render(); } catch (error) { toast(message(error) || 'Signed out'); b.disabled = false; }
    }
  });

  document.addEventListener('input', (e) => {
    const form = e.target.closest('form[data-form="vitals"]');
    const out = document.getElementById('bmi-preview');
    if (form && out) out.textContent = previewBmi(Number(form.elements.weightKg.value), Number(form.elements.heightCm.value));
  });

  window.addEventListener('hashchange', render);
  render();
})();
