/*
 * CareVault data layer (demo). Persists to localStorage.
 * Replace the functions on `Store` with Firebase Auth / Firestore / Cloud Functions
 * calls for production; the UI only talks to this object.
 */
(function () {
  const KEY = 'carevault.sysadmin.v5';
  const SESSION_KEY = 'carevault.session.v4';
  const SESSION_MS = 30 * 60 * 1000;

  const uid = (p) => p + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const now = () => new Date().toISOString();
  const daysAgo = (d, h = 0) => new Date(Date.now() - d * 864e5 - h * 36e5).toISOString();

  const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
  const PBKDF2_ITER = 150000;
  async function pbkdf2(pw, salt, iter) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256)));
  }
  // Salted, slow hash. Browser-side only for the demo; production must hash on the server.
  async function hashPw(pw) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return 'pbkdf2$' + PBKDF2_ITER + '$' + hex(salt) + '$' + await pbkdf2(String(pw), salt, PBKDF2_ITER);
  }
  function safeEq(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  }
  // Also accepts the legacy unsalted SHA-256 hashes (seed data); callers re-hash them after a successful check.
  async function verifyPw(pw, stored) {
    if (!stored) return false;
    const p = String(stored).split('$');
    if (p[0] === 'pbkdf2' && p.length === 4) {
      const salt = new Uint8Array(p[2].match(/../g).map((h) => parseInt(h, 16)));
      return safeEq(await pbkdf2(String(pw), salt, parseInt(p[1], 10)), p[3]);
    }
    return safeEq(await sha256(String(pw)), stored);
  }
  const isLegacyHash = (h) => !String(h || '').startsWith('pbkdf2$');
  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function randToken() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  const ROLE_OF = { 'Hospital Admin': 'hospitaladmin', PCC: 'pcc', Doctor: 'doctor', 'Lab Technician': 'lab', Pharmacist: 'pharmacist', Nurse: 'nurse' };
  // ---------- Clinical helpers (Doctor / Lab) ----------
  const HRID_RE = /^HDW-\d{8}-[A-Z0-9]{8}$/;
  const HRID_MSG = 'Enter a valid HRID (format HDW-YYYYMMDD-XXXXXXXX).';
  const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
  const RESET_MINUTES = 30;
  const REPORT_CATEGORIES = ['Blood test', 'Imaging', 'Pathology', 'Microbiology', 'Other'];
  const EMERGENCY_CATEGORIES = ['Unconscious / unable to consent', 'Life-threatening condition', 'Patient transferred from another hospital', 'Other emergency'];
  const SEVERE = ['major', 'contraindicated'];
  const DRUG_CLASSES = {
    penicillins: ['penicillin', 'penicillins', 'amoxicillin', 'ampicillin', 'flucloxacillin', 'piperacillin', 'amoxicillin-clavulanate'],
    cephalosporins: ['cephalosporins', 'cefalexin', 'cephalexin', 'cefazolin', 'ceftriaxone', 'cefuroxime'],
    sulfonamides: ['sulfa', 'sulfa drugs', 'sulfonamides', 'sulfamethoxazole', 'trimethoprim-sulfamethoxazole', 'sulfasalazine'],
    nsaids: ['nsaids', 'ibuprofen', 'naproxen', 'diclofenac', 'ketorolac', 'aspirin'],
    opioids: ['opioids', 'codeine', 'morphine', 'tramadol', 'oxycodone'],
    macrolides: ['macrolides', 'azithromycin', 'clarithromycin', 'erythromycin'],
    statins: ['statins', 'atorvastatin', 'simvastatin', 'rosuvastatin', 'pravastatin'],
  };
  const CROSS_REACTIVE = [['penicillins', 'cephalosporins']];
  // [drugA, drugB, severity, message] – small demo table, not a substitute for a licensed drug database.
  const DRUG_INTERACTIONS = [
    ['warfarin', 'ibuprofen', 'major', 'Bleeding risk is significantly increased.'],
    ['warfarin', 'naproxen', 'major', 'Bleeding risk is significantly increased.'],
    ['warfarin', 'aspirin', 'major', 'Bleeding risk is significantly increased.'],
    ['lisinopril', 'potassium', 'major', 'Risk of hyperkalaemia.'],
    ['lisinopril', 'spironolactone', 'major', 'Risk of hyperkalaemia.'],
    ['lisinopril', 'ibuprofen', 'moderate', 'NSAIDs can reduce antihypertensive effect and harm kidney function.'],
    ['simvastatin', 'clarithromycin', 'contraindicated', 'Raised statin exposure; risk of rhabdomyolysis.'],
    ['atorvastatin', 'clarithromycin', 'major', 'Raised statin exposure; risk of muscle toxicity.'],
    ['sertraline', 'tramadol', 'major', 'Risk of serotonin syndrome and seizures.'],
    ['digoxin', 'amiodarone', 'major', 'Digoxin levels may rise to toxic range.'],
    ['methotrexate', 'trimethoprim', 'major', 'Risk of severe bone-marrow suppression.'],
    ['sildenafil', 'nitroglycerin', 'contraindicated', 'Profound hypotension.'],
    ['clopidogrel', 'omeprazole', 'moderate', 'Omeprazole may reduce clopidogrel effectiveness.'],
  ];
  const DRUG_NAMES = Array.from(new Set(Object.keys(DRUG_CLASSES).reduce((l, c) => l.concat(DRUG_CLASSES[c].filter((n) => !Object.keys(DRUG_CLASSES).includes(n) && !['nsaids', 'opioids', 'sulfa', 'sulfa drugs', 'penicillin'].includes(n))), [])
    .concat(['warfarin', 'lisinopril', 'metformin', 'amlodipine', 'paracetamol', 'omeprazole', 'clopidogrel', 'sertraline', 'digoxin', 'amiodarone', 'methotrexate', 'sildenafil', 'nitroglycerin', 'spironolactone', 'potassium chloride', 'trimethoprim', 'furosemide', 'metoprolol', 'prednisolone', 'salbutamol', 'insulin glargine']))).sort();
  const LAB_TESTS = [
    ['HbA1c', /hba1c|glycated h(?:a)?emoglobin/i, '%', 4, 5.6],
    ['Fasting glucose', /(?:fasting )?glucose/i, 'mg/dL', 70, 99],
    ['Total cholesterol', /total cholesterol/i, 'mg/dL', 0, 199],
    ['LDL cholesterol', /\bldl\b/i, 'mg/dL', 0, 129],
    ['HDL cholesterol', /\bhdl\b/i, 'mg/dL', 40, 200],
    ['Triglycerides', /triglycerides?/i, 'mg/dL', 0, 149],
    ['Creatinine', /creatinine/i, 'mg/dL', 0.6, 1.3],
    ['eGFR', /\begfr\b/i, 'mL/min/1.73m²', 60, 200],
    ['Hemoglobin', /h(?:a)?emoglobin(?! ?a1c)/i, 'g/dL', 12, 17.5],
  ];

  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
  const normHrid = (v) => String(v == null ? '' : v).trim().toUpperCase();
  const hosName = (id) => (db.hospitals.find((h) => h.id === id) || {}).name || 'Unknown hospital';
  const withHospital = (x) => Object.assign({}, x, { hospitalName: hosName(x.hospitalId) });
  const limitedPatient = (p) => ({ id: p.id, hrid: p.hrid, name: p.name, dob: p.dob, gender: p.gender });
  const ageOf = (dob) => { const d = new Date(dob), n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--; return a; };
  const classesOf = (n) => Object.keys(DRUG_CLASSES).filter((c) => DRUG_CLASSES[c].includes(n));

  const activeGrant = (s, hrid) => db.emergencyGrants.find((g) => g.hrid === hrid && g.actor === s.email && g.hospitalId === s.hospitalId && new Date(g.expiresAt) > new Date());
  // A clinician may open a patient registered at their own hospital, or any patient while an emergency grant is active.
  function clinicianAccess(s, hrid) {
    const patient = db.patients.find((p) => p.hrid === normHrid(hrid));
    if (!patient) return null;
    const grant = activeGrant(s, patient.hrid);
    return patient.hospitalId === s.hospitalId || grant ? { patient, grant } : null;
  }
  // Records from other hospitals are visible only when shared, or during an emergency grant.
  const sharingAllowed = (hrid) => { const p = db.patients.find((x) => x.hrid === hrid); return !p || !p.consent || p.consent.shareWithOtherHospitals !== false; };
  const visibleItem = (s, grant, item) => !!grant || item.hospitalId === s.hospitalId || (item.shared === true && sharingAllowed(item.hrid));

  const VITAL_LIMITS = { temp: [30, 45, 'Temperature (°C)'], pulse: [20, 250, 'Pulse (bpm)'], bpSys: [50, 260, 'Systolic BP'], bpDia: [30, 160, 'Diastolic BP'], rr: [4, 80, 'Respiratory rate'], spo2: [50, 100, 'Oxygen saturation (%)'], weightKg: [1, 400, 'Weight (kg)'], pain: [0, 10, 'Pain score'] };
  function vitalFlags(v) {
    const f = [];
    if (v.temp != null && (v.temp >= 38 || v.temp < 35.5)) f.push('Temperature');
    if (v.pulse != null && (v.pulse < 50 || v.pulse > 110)) f.push('Pulse');
    if ((v.bpSys != null && (v.bpSys >= 140 || v.bpSys < 90)) || (v.bpDia != null && v.bpDia >= 90)) f.push('Blood pressure');
    if (v.rr != null && (v.rr < 10 || v.rr > 24)) f.push('Respiratory rate');
    if (v.spo2 != null && v.spo2 < 94) f.push('Oxygen saturation');
    return f;
  }
  const withFlags = (v) => Object.assign(withHospital(v), { flags: vitalFlags(v) });
  const role = (r) => { const s = currentAdmin(); return s && s.role === r ? s : null; };

  function secondarySearch(s, q) {
    const name = norm(q && q.name), phone = String((q && q.phone) || '').replace(/\D/g, ''), dob = String((q && q.dob) || '');
    if (!dob || (!name && !phone)) return { ok: false, error: 'Enter date of birth plus full name or phone number.' };
    const results = db.patients.filter((p) => p.dob === dob && ((name && norm(p.name) === name) || (phone && String(p.phone || '').replace(/\D/g, '') === phone)) && clinicianAccess(s, p.hrid)).map(limitedPatient);
    log('access', 'success', 'Secondary patient lookup (' + (name ? 'name' : 'phone') + ' + date of birth): ' + results.length + ' match(es)', s.email, s.hospitalId);
    return { ok: true, results };
  }

  function drugAlerts(hrid, rawName) {
    const n = norm(rawName), alerts = [], mine = classesOf(n);
    db.allergies.filter((a) => a.hrid === hrid).forEach((a) => {
      const an = norm(a.name), ac = classesOf(an);
      const same = an === n, sameClass = ac.some((c) => mine.includes(c));
      const cross = !same && !sameClass && CROSS_REACTIVE.some(([x, y]) => (ac.includes(x) && mine.includes(y)) || (ac.includes(y) && mine.includes(x)));
      const reaction = a.reaction || 'reaction not recorded';
      if (same || sameClass) alerts.push({ type: 'allergy', severity: 'major', message: 'Documented ' + a.name + ' allergy (' + reaction + '); ' + rawName + ' is ' + (same ? 'the same agent.' : 'in the same drug class.') });
      else if (cross) alerts.push({ type: 'allergy', severity: 'moderate', message: 'Documented ' + a.name + ' allergy (' + reaction + '); cross-reactivity with ' + rawName + ' is possible.' });
    });
    db.medications.filter((m) => m.hrid === hrid && m.status === 'current').forEach((m) => {
      const cur = norm(m.name);
      if (cur === n) alerts.push({ type: 'duplicate', severity: 'moderate', message: m.name + ' is already a current medication (' + m.dose + ').' });
      DRUG_INTERACTIONS.forEach(([x, y, severity, message]) => {
        if ((n.includes(x) && cur.includes(y)) || (n.includes(y) && cur.includes(x))) alerts.push({ type: 'interaction', severity, message: rawName + ' + ' + m.name + ': ' + message });
      });
    });
    return alerts;
  }

  // Rule-based screening estimate from documented data; not a validated clinical model.
  function computeRisks(p, recs) {
    const age = ageOf(p.dob), c = p.clinical || {}, male = p.gender === 'Male';
    const dx = (re) => recs.some((r) => r.type === 'diagnosis' && re.test((r.icd || '') + ' ' + r.title));
    const DM = dx(/\bE1[01]|diabet/i), HTN = dx(/\bI1[0-5]|hypertens/i), CKD = dx(/\bN18|kidney|renal/i), CAD = dx(/\bI2[0-5]|coronary|myocard/i);
    const known = (v) => v !== undefined && v !== null && v !== '';
    const f = (label, max, earned, isKnown) => ({ label, max, earned: isKnown ? earned : 0, known: !!isKnown });
    const level = (score) => (score < 25 ? 'Low' : score < 50 ? 'Moderate' : 'High');
    const build = (condition, diagnosed, factors) => {
      const max = factors.reduce((t, x) => t + x.max, 0), got = factors.reduce((t, x) => t + x.earned, 0), kmax = factors.filter((x) => x.known).reduce((t, x) => t + x.max, 0);
      const score = diagnosed ? 100 : Math.round(100 * got / max);
      return { condition, score, level: diagnosed ? 'Diagnosed' : level(score), confidence: Math.round(40 + 60 * kmax / max), diagnosed, factors };
    };
    return [
      build('Cardiovascular disease', CAD, [
        f('Age', 3, age >= 65 ? 3 : age >= 50 ? 2 : age >= 40 ? 1 : 0, true), f('Male sex', 1, male ? 1 : 0, true),
        f('Systolic blood pressure', 2, c.bpSys >= 140 ? 2 : c.bpSys >= 130 ? 1 : 0, known(c.bpSys)), f('LDL cholesterol', 2, c.ldl >= 160 ? 2 : c.ldl >= 130 ? 1 : 0, known(c.ldl)),
        f('Smoking', 2, c.smoker ? 2 : 0, known(c.smoker)), f('Diabetes diagnosis', 2, DM ? 2 : 0, true),
        f('BMI ≥ 30', 1, c.bmi >= 30 ? 1 : 0, known(c.bmi)), f('Family history', 1, c.familyHistory ? 1 : 0, known(c.familyHistory))]),
      build('Type 2 diabetes', DM, [
        f('HbA1c', 6, c.hba1c >= 6.5 ? 6 : c.hba1c >= 5.7 ? 3 : 0, known(c.hba1c)), f('BMI', 2, c.bmi >= 30 ? 2 : c.bmi >= 25 ? 1 : 0, known(c.bmi)),
        f('Age ≥ 45', 1, age >= 45 ? 1 : 0, true), f('Family history', 1, c.familyHistory ? 1 : 0, known(c.familyHistory)), f('Hypertension diagnosis', 1, HTN ? 1 : 0, true)]),
      build('Hypertension', HTN, [
        f('Blood pressure', 5, c.bpSys >= 140 || c.bpDia >= 90 ? 5 : c.bpSys >= 130 || c.bpDia >= 80 ? 2 : 0, known(c.bpSys) || known(c.bpDia)),
        f('BMI', 2, c.bmi >= 30 ? 2 : c.bmi >= 25 ? 1 : 0, known(c.bmi)), f('Age ≥ 55', 1, age >= 55 ? 1 : 0, true),
        f('Smoking', 1, c.smoker ? 1 : 0, known(c.smoker)), f('Family history', 1, c.familyHistory ? 1 : 0, known(c.familyHistory))]),
      build('Chronic kidney disease', CKD, [
        f('eGFR', 6, c.egfr < 60 ? 6 : c.egfr < 90 ? 2 : 0, known(c.egfr)), f('Diabetes diagnosis', 2, DM ? 2 : 0, true),
        f('Hypertension diagnosis', 2, HTN ? 2 : 0, true), f('Age ≥ 60', 1, age >= 60 ? 1 : 0, true)]),
    ];
  }

  // Best-effort extraction of common lab values from PDF text; compressed or scanned PDFs yield no values.
  function summarizeReport(buf) {
    const text = new TextDecoder('latin1').decode(new Uint8Array(buf).subarray(0, 3 * 1024 * 1024));
    const findings = [];
    LAB_TESTS.forEach(([test, re, unit, lo, hi]) => {
      const m = new RegExp('(?:' + re.source + ')[^0-9\\n\\r]{0,25}(\\d+(?:\\.\\d+)?)', 'i').exec(text);
      if (!m) return;
      const value = parseFloat(m[1]);
      findings.push({ test, value, unit, range: lo + '–' + hi, flag: value < lo ? 'low' : value > hi ? 'high' : 'normal' });
    });
    const abnormal = findings.filter((x) => x.flag !== 'normal');
    return {
      headline: findings.length
        ? findings.length + ' value(s) extracted automatically; ' + abnormal.length + ' outside the reference range' + (abnormal.length ? ': ' + abnormal.map((x) => x.test).join(', ') : '') + '.'
        : 'No structured values could be extracted automatically (scanned or compressed PDF). Manual review of the PDF is required.',
      findings, extracted: findings.length > 0, model: 'demo-heuristic-v0', generatedAt: now(),
    };
  }

  const idbOpen = () => new Promise((res, rej) => { const r = indexedDB.open('carevault-files', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const idbLocalPut = async (key, value) => { const d = await idbOpen(); return new Promise((res, rej) => { const t = d.transaction('files', 'readwrite'); t.objectStore('files').put(value, key); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); };
  const idbLocalGet = async (key) => { const d = await idbOpen(); return new Promise((res, rej) => { const q = d.transaction('files').objectStore('files').get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
  // Shared Cloud Storage when available; otherwise (e.g. Storage not enabled yet) keep the file in this browser only.
  async function idbPut(key, value) {
    if (REMOTE) { try { return await REMOTE.putFile(key, value); } catch (e) { console.warn('CareVault file storage unavailable, saving locally:', e.message); } }
    return idbLocalPut(key, value);
  }
  async function idbGet(key) {
    if (REMOTE) { try { const f = await REMOTE.getFile(key); if (f) return f; } catch (e) { /* fall through to local copy */ } }
    return idbLocalGet(key);
  }
  const readBytes = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(file); });
  async function sha256Bytes(buf) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join(''); }

  async function processReport(id) {
    const r = db && db.reports.find((x) => x.id === id);
    if (!r) return;
    try {
      const buf = await idbGet(id);
      if (!buf) throw new Error('stored file not found');
      await new Promise((res) => setTimeout(res, 1500));
      r.summary = summarizeReport(buf); r.processingStatus = 'complete';
    } catch (e) {
      r.processingStatus = 'failed'; r.summary = { headline: 'Processing failed: ' + e.message, findings: [], extracted: false };
    }
    r.processedAt = now();
    save();
  }

  async function reportFileFor(s, id) {
    const r = db.reports.find((x) => x.id === id);
    let ok = false;
    if (r && s.role === 'lab') ok = r.hospitalId === s.hospitalId;
    else if (r && s.role === 'patient') ok = r.hrid === s.hrid;
    else if (r) { const a = clinicianAccess(s, r.hrid); ok = !!a && visibleItem(s, a.grant, r); }
    if (!ok) return { ok: false, error: 'Report not available.' };
    const buf = r.hasFile ? await idbGet(r.id) : null;
    if (!buf) return { ok: false, error: 'No file is stored for this report (demo seed data).' };
    log('report', 'success', 'Report file opened: ' + r.hrid + ' (' + r.id + ')', s.email, s.hospitalId);
    return { ok: true, blob: new Blob([buf], { type: 'application/pdf' }), fileName: r.fileName };
  }

  function createRx(s, hrid, order, overrideReason) {
    if (!s) return { ok: false, error: 'Not allowed.' };
    const a = clinicianAccess(s, hrid);
    if (!a) return { ok: false, error: 'Patient access is not permitted or has expired.' };
    const f = (k, max) => String(order[k] || '').trim().slice(0, max);
    const name = f('name', 80), dose = f('dose', 40), route = f('route', 30), frequency = f('frequency', 60), duration = f('duration', 60), indication = f('indication', 120);
    if (!name || !dose || !frequency) return { ok: false, error: 'Medication, dose and frequency are required.' };
    const alerts = drugAlerts(a.patient.hrid, name), blocking = alerts.some((x) => SEVERE.includes(x.severity));
    const reason = String(overrideReason || '').trim();
    if (blocking && reason.length < 10) return { ok: false, needsOverride: true, alerts, error: 'Serious safety alerts must be reviewed; enter an override reason (min 10 characters) to proceed.' };
    const instructions = [route, frequency, duration && 'for ' + duration, indication && '(' + indication + ')'].filter(Boolean).join(', ');
    db.medications.unshift({ id: uid('med'), hrid: a.patient.hrid, name, dose, instructions, status: 'current', hospitalId: s.hospitalId, prescribedBy: s.name, createdAt: now() });
    db.clinicalRecords.unshift({ id: uid('rec'), hrid: a.patient.hrid, type: 'prescription', title: 'Prescription: ' + name, details: dose + ' — ' + instructions, hospitalId: s.hospitalId, authorId: s.id, author: s.name, createdAt: now(), shared: true });
    log('clinical', alerts.length ? 'warning' : 'success', 'Prescription entered for ' + a.patient.hrid + ': ' + name + (blocking ? ' (safety alert overridden: ' + reason.slice(0, 200) + ')' : alerts.length ? ' (' + alerts.length + ' alert(s) acknowledged)' : ''), s.email, s.hospitalId);
    return { ok: true, alerts };
  }

  const patientSelf = () => { const s = role('patient'); return s ? db.patients.find((p) => p.id === s.id) : null; };
  // Staff access events about this patient (emergency events are written once per hospital; show them once).
  function patientAccessEvents(p) {
    const seen = new Set();
    return db.audit.filter((l) => ['access', 'clinical', 'report', 'emergency'].includes(l.category) && l.actor !== p.email && l.action.indexOf(p.hrid) !== -1)
      .filter((l) => { const k = l.category + '|' + l.actor + '|' + l.action; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((l) => { const u = db.users.find((x) => x.email === l.actor); return { id: l.id, ts: l.ts, category: l.category, outcome: l.outcome, action: l.action, actor: u ? u.name + ' (' + u.role + ')' : 'Staff member', hospitalName: u ? hosName(u.hospitalId) : hosName(l.hospitalId) }; });
  }

  let db = null;

  const REMOTE = window.Remote && window.Remote.enabled ? window.Remote : null;
  const adopt = (merged) => { Object.keys(merged).forEach((k) => { if (JSON.stringify(db[k]) !== JSON.stringify(merged[k])) db[k] = merged[k]; }); localStorage.setItem(KEY, JSON.stringify(db)); };

  function save() {
    localStorage.setItem(KEY, JSON.stringify(db));
    if (REMOTE) REMOTE.push(db).then((m) => { if (db) { adopt(m); mailPending(); } }).catch((e) => console.warn('CareVault shared storage:', e.message));
  }

  // Emails invitation and reset links created in this session, once they are in shared storage (the function
  // reads them from there). Tokens that came from storage or other people's sync were handled by whoever made them.
  const seenTokens = new Set();
  function tokensOf(d) {
    const out = [];
    ['hospitals', 'users', 'patients'].forEach((k) => (d[k] || []).forEach((x) => { if (x && x.email && x.invite && x.invite.token) out.push(['invite', x.invite.token, x.invite.expiresAt]); }));
    ['admins', 'users', 'patients'].forEach((k) => (d[k] || []).forEach((x) => { if (x && x.email && x.reset && x.reset.token) out.push(['reset', x.reset.token, x.reset.expiresAt]); }));
    return out;
  }
  function markSeen(d) { tokensOf(d).forEach((t) => seenTokens.add(t[1])); }
  function mailPending() {
    tokensOf(db).forEach(([kind, token, exp]) => {
      if (seenTokens.has(token) || new Date(exp) <= new Date()) return;
      seenTokens.add(token);
      REMOTE.sendMail(kind, token).catch((e) => console.warn('CareVault email:', e.message));
    });
  }

  // Pick up changes other team members saved to shared storage.
  function startSync() {
    const refresh = () => REMOTE.pull().then((r) => { if (db) { markSeen(r); Object.keys(r).forEach((k) => { db[k] = REMOTE.merge(db[k], r[k], true); }); } localStorage.setItem(KEY, JSON.stringify(db)); }).catch(() => {});
    setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }

  async function seed() {
    const hp = await sha256('Hospital@123');
    db = {
      admins: [{ id: 'adm_1', role: 'sysadmin', name: 'System Administrator', email: 'sysadmin@carevault.com', passwordHash: await sha256('Admin@123'), failed: 0, lockedUntil: 0 }],
      hospitals: [
        { id: 'hos_1', name: 'St. Mary General Hospital', code: 'SMGH', email: 'admin@stmary.example', phone: '+1 555 0101', address: '12 Park Ave', city: 'Boston', country: 'USA', licenseNo: 'LIC-10231', adminName: 'Dr. Helen Cho', status: 'active', createdAt: daysAgo(90), invite: null },
        { id: 'hos_2', name: 'Riverside Medical Center', code: 'RMC', email: 'it@riverside.example', phone: '+1 555 0102', address: '88 River Rd', city: 'Austin', country: 'USA', licenseNo: 'LIC-20987', adminName: 'Mark Ellis', status: 'active', createdAt: daysAgo(45), invite: null },
        { id: 'hos_3', name: 'Lakeview Children\'s Clinic', code: 'LCC', email: 'office@lakeview.example', phone: '+1 555 0103', address: '5 Lake St', city: 'Chicago', country: 'USA', licenseNo: 'LIC-33410', adminName: 'Priya Nair', status: 'pending', createdAt: daysAgo(2), invite: { token: 'demo-token-lcc', expiresAt: new Date(Date.now() + 3 * 864e5).toISOString() } },
        { id: 'hos_4', name: 'Sunrise Care Hospital', code: 'SCH', email: 'admin@sunrise.example', phone: '+1 555 0104', address: '301 Sun Blvd', city: 'Phoenix', country: 'USA', licenseNo: 'LIC-44872', adminName: 'Omar Khan', status: 'inactive', createdAt: daysAgo(200), invite: null },
      ],
      users: [
        { id: 'usr_1', name: 'Dr. Helen Cho', email: 'admin@stmary.example', role: 'Hospital Admin', department: 'Administration', phone: '+1 555 0111', hospitalId: 'hos_1', status: 'active', lastLogin: daysAgo(0, 3), createdAt: daysAgo(90), invite: null, passwordHash: hp },
        { id: 'usr_2', name: 'Dr. James Wu', email: 'jwu@stmary.example', role: 'Doctor', department: 'Cardiology', phone: '+1 555 0112', hospitalId: 'hos_1', status: 'active', lastLogin: daysAgo(0, 8), createdAt: daysAgo(80), invite: null, passwordHash: hp },
        { id: 'usr_3', name: 'Nina Patel', email: 'npatel@stmary.example', role: 'Nurse', department: 'Emergency', phone: '+1 555 0113', hospitalId: 'hos_1', status: 'active', lastLogin: daysAgo(1), createdAt: daysAgo(60), invite: null, passwordHash: hp },
        { id: 'usr_7', name: 'Leo Brandt', email: 'lbrandt@stmary.example', role: 'Receptionist', department: 'Front Desk', phone: '+1 555 0114', hospitalId: 'hos_1', status: 'pending', lastLogin: null, createdAt: daysAgo(1), invite: { token: 'demo-token-staff', expiresAt: new Date(Date.now() + 6 * 864e5).toISOString() }, passwordHash: null },
        { id: 'usr_8', name: 'Grace Miller', email: 'pcc@stmary.example', role: 'PCC', department: 'Patient Care Coordination', phone: '+1 555 0115', hospitalId: 'hos_1', status: 'active', lastLogin: daysAgo(0, 5), createdAt: daysAgo(70), invite: null, passwordHash: hp },
        { id: 'usr_9', name: 'Lab Technician', email: 'lab@stmary.example', role: 'Lab Technician', department: 'Laboratory', phone: '+1 555 0116', hospitalId: 'hos_1', status: 'active', lastLogin: null, createdAt: daysAgo(30), invite: null, passwordHash: hp },
        { id: 'usr_4', name: 'Mark Ellis', email: 'it@riverside.example', role: 'Hospital Admin', department: 'Administration', phone: '', hospitalId: 'hos_2', status: 'active', lastLogin: daysAgo(2), createdAt: daysAgo(45), invite: null, passwordHash: hp },
        { id: 'usr_5', name: 'Dr. Sara Lopez', email: 'slopez@riverside.example', role: 'Doctor', department: 'Neurology', phone: '', hospitalId: 'hos_2', status: 'suspended', lastLogin: daysAgo(30), createdAt: daysAgo(40), invite: null, passwordHash: hp },
        { id: 'usr_6', name: 'Omar Khan', email: 'admin@sunrise.example', role: 'Hospital Admin', department: 'Administration', phone: '', hospitalId: 'hos_4', status: 'active', lastLogin: daysAgo(60), createdAt: daysAgo(200), invite: null, passwordHash: hp },
      ],
      patients: [
        { id: 'pat_1', hrid: 'HR-7K3M9QX2A4', name: 'Anna Rivera', dob: '1988-04-12', gender: 'Female', phone: '+1 555 0201', email: 'anna.rivera@example.com', address: '9 Elm St, Boston', emergencyName: 'Luis Rivera', emergencyPhone: '+1 555 0202', hospitalId: 'hos_1', registeredBy: 'pcc@stmary.example', createdAt: daysAgo(12), status: 'active', invite: null },
        { id: 'pat_2', hrid: 'HR-4HN8T2WC5D', name: 'Tom Becker', dob: '1975-09-30', gender: 'Male', phone: '+1 555 0203', email: '', address: '44 Oak Ave, Boston', emergencyName: 'Jill Becker', emergencyPhone: '+1 555 0204', hospitalId: 'hos_1', registeredBy: 'pcc@stmary.example', createdAt: daysAgo(5), status: 'registered', invite: null },
        { id: 'pat_3', hrid: 'HR-9D2XK6PM3F', name: 'Maya Singh', dob: '2001-01-22', gender: 'Female', phone: '+1 555 0205', email: 'maya.singh@example.com', address: '71 Pine Rd, Boston', emergencyName: 'Ravi Singh', emergencyPhone: '+1 555 0206', hospitalId: 'hos_1', registeredBy: 'pcc@stmary.example', createdAt: daysAgo(1), status: 'pending', invite: { token: 'demo-token-patient', expiresAt: new Date(Date.now() + 6 * 864e5).toISOString() } },
        { id: 'pat_4', hrid: 'HR-5R8W2JH6PM', name: 'Jordan Lee', dob: '1969-06-03', gender: 'Other', phone: '+1 555 0301', email: '', address: '', emergencyName: '', emergencyPhone: '', hospitalId: 'hos_2', registeredBy: 'pcc@riverside.example', createdAt: daysAgo(50), status: 'registered', invite: null },
      ],
      clinicalRecords: [
        { id: 'rec_1', hrid: 'HR-7K3M9QX2A4', type: 'diagnosis', title: 'Essential hypertension', icd: 'I10', dxStatus: 'confirmed', severity: 'moderate', details: 'Diagnosed at Riverside; lifestyle measures and ACE inhibitor started.', hospitalId: 'hos_2', author: 'Dr. Sara Lopez', createdAt: daysAgo(1100), shared: true },
        { id: 'rec_2', hrid: 'HR-7K3M9QX2A4', type: 'diagnosis', title: 'Type 2 diabetes mellitus', icd: 'E11.9', dxStatus: 'confirmed', severity: 'moderate', details: 'HbA1c 7.9% at diagnosis; metformin started.', hospitalId: 'hos_1', author: 'Dr. James Wu', createdAt: daysAgo(380), shared: true },
        { id: 'rec_3', hrid: 'HR-7K3M9QX2A4', type: 'visit', title: 'Cardiology follow-up', details: 'Blood pressure 142/90; continue lifestyle measures.', hospitalId: 'hos_1', author: 'Dr. James Wu', createdAt: daysAgo(30), shared: true },
        { id: 'rec_4', hrid: 'HR-7K3M9QX2A4', type: 'lab', title: 'Lipid panel', details: 'Total cholesterol 182 mg/dL; LDL 104 mg/dL.', hospitalId: 'hos_2', author: 'Riverside Laboratory', createdAt: daysAgo(8), shared: true },
        { id: 'rec_5', hrid: 'HR-7K3M9QX2A4', type: 'diagnosis', title: 'Seasonal allergic rhinitis', icd: 'J30.2', dxStatus: 'confirmed', severity: 'mild', details: 'Documented at primary care visit.', hospitalId: 'hos_1', author: 'Dr. James Wu', createdAt: daysAgo(20), shared: true },
        { id: 'rec_6', hrid: 'HR-7K3M9QX2A4', type: 'visit', title: 'Mental health consultation', details: 'Not shared with other hospitals.', hospitalId: 'hos_2', author: 'Dr. Sara Lopez', createdAt: daysAgo(200), shared: false },
        { id: 'rec_7', hrid: 'HR-4HN8T2WC5D', type: 'prescription', title: 'Prescription: Warfarin', details: '5 mg — once daily', hospitalId: 'hos_1', author: 'Dr. James Wu', createdAt: daysAgo(90), shared: true },
        { id: 'rec_8', hrid: 'HR-5R8W2JH6PM', type: 'visit', title: 'Emergency department visit', details: 'Triage and initial assessment recorded.', hospitalId: 'hos_2', author: 'Riverside Emergency Department', createdAt: daysAgo(2), shared: false },
        { id: 'rec_9', hrid: 'HR-5R8W2JH6PM', type: 'diagnosis', title: 'Chronic kidney disease stage 3', icd: 'N18.3', dxStatus: 'confirmed', severity: 'moderate', details: 'eGFR 48 mL/min/1.73m².', hospitalId: 'hos_2', author: 'Dr. Sara Lopez', createdAt: daysAgo(60), shared: false },
      ],
      allergies: [
        { id: 'alg_1', hrid: 'HR-7K3M9QX2A4', name: 'Penicillin', reaction: 'Rash', severity: 'moderate', hospitalId: 'hos_1', recordedAt: daysAgo(120) },
        { id: 'alg_2', hrid: 'HR-7K3M9QX2A4', name: 'Sulfonamides', reaction: 'Hives', severity: 'mild', hospitalId: 'hos_2', recordedAt: daysAgo(900) },
        { id: 'alg_3', hrid: 'HR-5R8W2JH6PM', name: 'Codeine', reaction: 'Nausea and vomiting', severity: 'mild', hospitalId: 'hos_2', recordedAt: daysAgo(300) },
      ],
      medications: [
        { id: 'med_1', hrid: 'HR-7K3M9QX2A4', name: 'Lisinopril', dose: '10 mg', instructions: 'Oral, once daily', status: 'current', hospitalId: 'hos_2', prescribedBy: 'Dr. Sara Lopez', createdAt: daysAgo(1100) },
        { id: 'med_2', hrid: 'HR-7K3M9QX2A4', name: 'Metformin', dose: '500 mg', instructions: 'Oral, twice daily', status: 'current', hospitalId: 'hos_1', prescribedBy: 'Dr. James Wu', createdAt: daysAgo(380) },
        { id: 'med_3', hrid: 'HR-4HN8T2WC5D', name: 'Warfarin', dose: '5 mg', instructions: 'Oral, once daily', status: 'current', hospitalId: 'hos_1', prescribedBy: 'Dr. James Wu', createdAt: daysAgo(90) },
      ],
      reports: [
        { id: 'report_1', hrid: 'HR-7K3M9QX2A4', title: 'HbA1c and lipid panel', category: 'Blood test', fileName: 'hba1c-lipid-panel.pdf', mimeType: 'application/pdf', size: 0, sha256: '', hasFile: false,
          hospitalId: 'hos_1', uploadedBy: 'lab@stmary.example', uploadedByName: 'Lab Technician', uploadedAt: daysAgo(4), processingStatus: 'complete', processedAt: daysAgo(4), shared: true,
          summary: { headline: '3 value(s) extracted automatically; 2 outside the reference range: HbA1c, LDL cholesterol.', extracted: true, model: 'demo-heuristic-v0', generatedAt: daysAgo(4),
            findings: [{ test: 'HbA1c', value: 7.4, unit: '%', range: '4–5.6', flag: 'high' }, { test: 'LDL cholesterol', value: 142, unit: 'mg/dL', range: '0–129', flag: 'high' }, { test: 'HDL cholesterol', value: 52, unit: 'mg/dL', range: '40–200', flag: 'normal' }] } },
        { id: 'report_2', hrid: 'HR-7K3M9QX2A4', title: 'Renal function panel', category: 'Blood test', fileName: 'renal-panel.pdf', mimeType: 'application/pdf', size: 0, sha256: '', hasFile: false,
          hospitalId: 'hos_2', uploadedBy: 'lab@riverside.example', uploadedByName: 'Riverside Laboratory', uploadedAt: daysAgo(40), processingStatus: 'complete', processedAt: daysAgo(40), shared: true,
          summary: { headline: '2 value(s) extracted automatically; 0 outside the reference range.', extracted: true, model: 'demo-heuristic-v0', generatedAt: daysAgo(40),
            findings: [{ test: 'Creatinine', value: 0.9, unit: 'mg/dL', range: '0.6–1.3', flag: 'normal' }, { test: 'eGFR', value: 78, unit: 'mL/min/1.73m²', range: '60–200', flag: 'normal' }] } },
        { id: 'report_3', hrid: 'HR-7K3M9QX2A4', title: 'Psychology assessment', category: 'Other', fileName: 'assessment.pdf', mimeType: 'application/pdf', size: 0, sha256: '', hasFile: false,
          hospitalId: 'hos_2', uploadedBy: 'lab@riverside.example', uploadedByName: 'Riverside Laboratory', uploadedAt: daysAgo(200), processingStatus: 'complete', processedAt: daysAgo(200), shared: false,
          summary: { headline: 'No structured values could be extracted automatically (scanned or compressed PDF). Manual review of the PDF is required.', findings: [], extracted: false, model: 'demo-heuristic-v0', generatedAt: daysAgo(200) } },
      ],
      emergencyGrants: [],
      audit: [],
      config: {
        sessionTimeoutMin: 30, maxFailedLogins: 5, lockoutMin: 15, minPasswordLength: 10,
        requireMfa: false, inviteExpiryDays: 7, auditRetentionDays: 365, maintenanceMode: false,
        supportEmail: 'support@carevault.com',
      },
    };
    const vitals = { 'HR-7K3M9QX2A4': { bpSys: 142, bpDia: 90, bmi: 31.2, smoker: false, ldl: 142, hba1c: 7.4, egfr: 78, familyHistory: true },
      'HR-4HN8T2WC5D': { bpSys: 128, bpDia: 82, bmi: 27, smoker: true }, 'HR-5R8W2JH6PM': { bpSys: 150, bpDia: 92, bmi: 29, smoker: false, hba1c: 6.0, egfr: 48 } };
    db.patients.forEach((p) => { if (vitals[p.hrid]) p.clinical = vitals[p.hrid]; p.consent = { shareWithOtherHospitals: true, notifyOnEmergency: true }; });
    const anna = db.patients.find((x) => x.hrid === 'HR-7K3M9QX2A4');
    anna.status = 'active'; anna.passwordHash = hp; anna.invite = null;
    db.users.push({ id: 'usr_10', name: 'Priya Shah', email: 'pharm@stmary.example', role: 'Pharmacist', department: 'Pharmacy', phone: '+1 555 0117', hospitalId: 'hos_1', status: 'active', lastLogin: null, createdAt: daysAgo(30), invite: null, passwordHash: hp });
    db.medications.push({ id: 'med_4', hrid: 'HR-7K3M9QX2A4', name: 'Omeprazole', dose: '20 mg', instructions: 'Oral, once daily for 8 weeks', status: 'completed', hospitalId: 'hos_1', prescribedBy: 'Dr. James Wu', createdAt: daysAgo(200) });
    const vit = (hrid, d, o) => Object.assign({ id: uid('vit'), hrid, hospitalId: 'hos_1', recordedBy: 'npatel@stmary.example', recordedByName: 'Nina Patel', recordedAt: daysAgo(d), shared: true, notes: '', correctsId: null }, o);
    db.vitals = [
      vit('HR-7K3M9QX2A4', 30, { temp: 36.8, pulse: 78, bpSys: 138, bpDia: 88, rr: 16, spo2: 98, weightKg: 84 }),
      vit('HR-7K3M9QX2A4', 7, { temp: 36.9, pulse: 82, bpSys: 142, bpDia: 90, rr: 16, spo2: 97, weightKg: 83.5 }),
      vit('HR-7K3M9QX2A4', 1, { temp: 37.1, pulse: 76, bpSys: 136, bpDia: 86, rr: 15, spo2: 98, weightKg: 83 }),
      vit('HR-4HN8T2WC5D', 5, { temp: 36.6, pulse: 72, bpSys: 128, bpDia: 82, rr: 14, spo2: 96 }),
    ];
    const seedEvents = [
      ['login', 'success', 'Hospital Admin login', 'admin@stmary.example', 'hos_1', 3],
      ['login', 'failure', 'Failed login attempt', 'jwu@stmary.example', 'hos_1', 9],
      ['access', 'success', 'Viewed patient record list', 'npatel@stmary.example', 'hos_1', 20],
      ['account', 'success', 'User suspended', 'sysadmin@carevault.com', 'hos_2', 48],
      ['security', 'warning', 'Multiple failed logins from new IP', 'unknown', 'hos_2', 50],
      ['account', 'success', 'Hospital deactivated', 'sysadmin@carevault.com', 'hos_4', 200],
    ];
    seedEvents.forEach(([category, outcome, action, actor, hospitalId, h]) =>
      db.audit.push({ id: uid('log'), ts: daysAgo(0, h), category, outcome, action, actor, hospitalId, ip: '203.0.113.' + (h % 200 + 1) }));
    save();
  }

  async function load() {
    if (db) return;
    let remote = null;
    if (REMOTE) {
      try { remote = await REMOTE.pull(); } catch (e) { console.warn('CareVault shared storage unavailable, using local cache:', e.message); }
    }
    // Only a complete remote copy can stand alone; a partial one (e.g. an interrupted first push) is overlaid on local/seed data.
    if (remote && remote.admins && remote.users && remote.patients && remote.hospitals && remote.audit) db = remote;
    else {
      if (!db) { try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) { db = null; } }
      if (!db) await seed();
      if (remote) { Object.keys(remote).forEach((k) => { db[k] = REMOTE.merge(db[k], remote[k], true); }); save(); }
    }
    if (REMOTE) { markSeen(db); startSync(); }
    ['clinicalRecords', 'allergies', 'medications', 'reports', 'emergencyGrants'].forEach((key) => {
      if (!Array.isArray(db[key])) db[key] = [];
    });
    if (!Array.isArray(db.mailbox)) db.mailbox = [];
    migrate();
    db.reports.filter((r) => r.processingStatus === 'processing').forEach((r) => processReport(r.id));
  }

  const accountLists = () => [db.admins, db.users, db.patients, db.hospitals];
  function uniqueUsername(base) {
    let b = String(base || 'user').toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z0-9]+/, '');
    if (b.length < 3) b = (b + 'user').slice(0, 8);
    b = b.slice(0, 28);
    const taken = new Set([].concat(...accountLists()).map((x) => x.username).filter(Boolean));
    let u = b, i = 1;
    while (taken.has(u)) u = b + (++i);
    return u;
  }

  // Upgrades older stored data: legacy HR-… IDs become HDW-YYYYMMDD-XXXXXXXX and every account gets a username.
  function migrate() {
    const map = {};
    db.patients.forEach((p) => {
      const m = /^HR-([A-Z0-9]{8})[A-Z0-9]{2}$/.exec(p.hrid || '');
      if (m) map[p.hrid] = 'HDW-' + String(p.createdAt || now()).slice(0, 10).replace(/-/g, '') + '-' + m[1];
    });
    if (Object.keys(map).length) {
      let s = JSON.stringify(db);
      Object.keys(map).forEach((k) => { s = s.split(k).join(map[k]); });
      db = JSON.parse(s);
    }
    db.admins.forEach((a) => { if (!a.username) a.username = uniqueUsername(a.email.split('@')[0]); });
    db.hospitals.forEach((h) => { if (!h.username) h.username = uniqueUsername((h.code || 'hospital').toLowerCase() + '.admin'); });
    db.users.forEach((u) => {
      if (u.username) return;
      const h = u.role === 'Hospital Admin' && db.hospitals.find((x) => x.email === u.email);
      u.username = h ? h.username : uniqueUsername(u.email.split('@')[0]);
    });
    db.patients.forEach((p) => { if (!p.username && p.email) p.username = uniqueUsername(p.email.split('@')[0]); });
    save();
  }

  function log(category, outcome, action, actor, hospitalId) {
    db.audit.unshift({ id: uid('log'), ts: now(), category, outcome, action, actor: actor || 'system', hospitalId: hospitalId || null, ip: 'client' });
    const max = db.config.auditRetentionDays * 864e5;
    db.audit = db.audit.filter((l) => Date.now() - new Date(l.ts).getTime() <= max);
    save();
  }

  const currentAdmin = () => {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY));
      if (!s || Date.now() > s.exp) { sessionStorage.removeItem(SESSION_KEY); return null; }
      return s;
    } catch (e) { return null; }
  };
  const touch = () => {
    const s = currentAdmin();
    if (s) { s.exp = Date.now() + (db ? db.config.sessionTimeoutMin : 30) * 60 * 1000; sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
  };

  const Store = {
    ready: load,
    session: currentAdmin,
    touch,

    async login(ident, password) {
      await load();
      const email = String(ident).trim().toLowerCase();
      const bad = { ok: false, error: 'Invalid username/email or password.' };
      const is = (x) => x.email === email || x.username === email;
      const sa = db.admins.find(is);
      const hu = sa ? null : db.users.find((x) => is(x) && ROLE_OF[x.role]);
      const pt = sa || hu ? null : db.patients.find((x) => x.passwordHash && (String(x.email || '').toLowerCase() === email || x.username === email));
      const a = sa || hu || pt;
      if (!a) { log('login', 'failure', 'Login failed (unknown account)', email); return bad; }
      const hid = hu ? hu.hospitalId : pt ? pt.hospitalId : null;
      if (a.lockedUntil > Date.now()) return { ok: false, error: 'Account temporarily locked. Try again later.' };
      if (!(await verifyPw(password, a.passwordHash))) {
        a.failed = (a.failed || 0) + 1;
        if (a.failed >= db.config.maxFailedLogins) { a.lockedUntil = Date.now() + db.config.lockoutMin * 60000; a.failed = 0; log('security', 'warning', 'Account locked after failed logins', a.email, hid); }
        else log('login', 'failure', 'Login failed', a.email, hid);
        save();
        return bad;
      }
      if (hu) {
        const h = db.hospitals.find((x) => x.id === hid);
        const why = !h || h.status !== 'active' ? 'Your hospital account is not active.'
          : hu.status !== 'active' ? 'Your account is not active.'
          : db.config.maintenanceMode ? 'The platform is under maintenance. Try again later.' : null;
        if (why) { log('login', 'failure', 'Login blocked: ' + why, a.email, hid); return { ok: false, error: why }; }
        hu.lastLogin = now();
      } else if (pt) {
        const why = pt.status !== 'active' ? 'Your account is not active.' : db.config.maintenanceMode ? 'The platform is under maintenance. Try again later.' : null;
        if (why) { log('login', 'failure', 'Login blocked: ' + why, pt.email, hid); return { ok: false, error: why }; }
      }
      a.failed = 0; a.lockedUntil = 0;
      if (isLegacyHash(a.passwordHash)) a.passwordHash = await hashPw(password);
      const role = hu ? ROLE_OF[hu.role] : pt ? 'patient' : 'sysadmin';
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: a.id, name: a.name, email: a.email, role, hospitalId: hid, hrid: pt ? pt.hrid : undefined, exp: Date.now() + db.config.sessionTimeoutMin * 60000 }));
      log('login', 'success', (hu ? hu.role : pt ? 'Patient' : 'System Admin') + ' login', a.email, hid);
      save();
      return { ok: true, role };
    },
    logout() {
      const s = currentAdmin();
      if (s) log('login', 'success', 'Logout', s.email, s.hospitalId);
      sessionStorage.removeItem(SESSION_KEY);
    },
    // ---------- Doctor ----------
    DRUG_NAMES, REPORT_CATEGORIES, EMERGENCY_CATEGORIES,
    doctorFindPatient(hrid) {
      const s = role('doctor');
      const id = normHrid(hrid);
      if (!HRID_RE.test(id)) return { ok: false, error: HRID_MSG };
      const a = clinicianAccess(s, id);
      if (!a) { log('access', 'failure', 'Patient lookup failed or restricted: ' + id, s.email, s.hospitalId); return { ok: false, error: 'No accessible patient found for that HRID. If this is an emergency, use Emergency Access.' }; }
      return { ok: true, patient: limitedPatient(a.patient), emergency: !!a.grant };
    },
    doctorSearchSecondary(q) { return secondarySearch(role('doctor'), q); },
    doctorOpenPatient(hrid) {
      const s = role('doctor');
      const a = s && clinicianAccess(s, hrid);
      if (!a) return null;
      const p = a.patient, vis = (i) => visibleItem(s, a.grant, i);
      const allRecs = db.clinicalRecords.filter((r) => r.hrid === p.hrid), allReps = db.reports.filter((r) => r.hrid === p.hrid);
      const records = allRecs.filter(vis).map(withHospital), reports = allReps.filter(vis).map(withHospital);
      const action = 'Clinical record accessed: ' + p.hrid;
      if (!db.audit.some((l) => l.actor === s.email && l.action === action && Date.now() - new Date(l.ts).getTime() < 5 * 60000)) log('access', 'success', action, s.email, s.hospitalId);
      const timeline = records.map((r) => ({ id: r.id, type: r.type, title: r.title, details: r.details, icd: r.icd, hospitalId: r.hospitalId, hospitalName: r.hospitalName, author: r.author, createdAt: r.createdAt }))
        .concat(reports.map((r) => ({ id: r.id, type: 'report', title: r.title, details: r.summary ? r.summary.headline : 'Report uploaded', hospitalId: r.hospitalId, hospitalName: r.hospitalName, author: r.uploadedByName || r.uploadedBy, createdAt: r.uploadedAt, reportId: r.id })))
        .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
      return {
        patient: Object.assign(limitedPatient(p), { phone: p.phone, hospitalId: p.hospitalId, hospitalName: hosName(p.hospitalId), clinical: p.clinical || {} }),
        records, reports, timeline, hidden: allRecs.length - records.length + allReps.length - reports.length,
        allergies: db.allergies.filter((x) => x.hrid === p.hrid).map(withHospital),
        medications: db.medications.filter((m) => m.hrid === p.hrid && m.status === 'current').map(withHospital),
        risks: computeRisks(p, records),
        emergency: a.grant ? { expiresAt: a.grant.expiresAt, reason: a.grant.reason } : null,
      };
    },
    doctorReport(id) {
      const s = role('doctor');
      const r = s && db.reports.find((x) => x.id === id);
      const a = r && clinicianAccess(s, r.hrid);
      if (!a || !visibleItem(s, a.grant, r)) return { ok: false, error: 'Report not available.' };
      return { ok: true, report: withHospital(r), patient: limitedPatient(a.patient) };
    },
    doctorReportFile(id) { return reportFileFor(role('doctor'), id); },
    doctorEmergencyAccess(hrid, reason, category) {
      const s = role('doctor');
      const id = normHrid(hrid), why = String(reason || '').trim();
      if (!HRID_RE.test(id)) return { ok: false, error: 'Enter a valid HRID.' };
      if (!EMERGENCY_CATEGORIES.includes(category)) return { ok: false, error: 'Select an emergency category.' };
      if (why.length < 15 || why.length > 500) return { ok: false, error: 'Describe the emergency in 15–500 characters.' };
      const patient = db.patients.find((p) => p.hrid === id);
      if (!patient) { log('emergency', 'failure', 'Emergency access attempted for unknown HRID ' + id, s.email, s.hospitalId); return { ok: false, error: 'No patient found for that HRID.' }; }
      if (patient.hospitalId === s.hospitalId) return { ok: false, error: 'This patient is registered at your hospital; use standard patient search.' };
      const grant = { id: uid('emg'), hrid: id, actor: s.email, actorName: s.name, hospitalId: s.hospitalId, category, reason: why, createdAt: now(), expiresAt: new Date(Date.now() + 30 * 60000).toISOString() };
      db.emergencyGrants.push(grant);
      const msg = 'Emergency access to ' + id + ' by ' + s.name + ' (' + s.email + '), ' + hosName(s.hospitalId) + ' [' + category + ']: ' + why;
      log('emergency', 'warning', msg, s.email, s.hospitalId);
      log('emergency', 'warning', msg, s.email, patient.hospitalId);
      return { ok: true, grant };
    },
    doctorAccessHistory() {
      const s = role('doctor');
      return s ? db.audit.filter((l) => l.actor === s.email && ['access', 'emergency', 'clinical', 'report'].includes(l.category)) : [];
    },
    doctorRecentPatients() {
      const s = role('doctor');
      if (!s) return [];
      const seen = [];
      db.audit.filter((l) => l.actor === s.email && l.action.indexOf('Clinical record accessed: ') === 0).forEach((l) => { const h = l.action.slice(26); if (!seen.includes(h)) seen.push(h); });
      return seen.map((h) => clinicianAccess(s, h)).filter(Boolean).slice(0, 5).map((a) => limitedPatient(a.patient));
    },
    doctorCreateDiagnosis(hrid, d) {
      const s = role('doctor');
      const a = clinicianAccess(s, hrid);
      if (!a) return { ok: false, error: 'Patient access is not permitted or has expired.' };
      const title = String(d.title || '').trim(), icd = String(d.icd || '').trim().toUpperCase(), notes = String(d.notes || '').trim();
      if (title.length < 2 || title.length > 120) return { ok: false, error: 'Diagnosis title is required (2–120 characters).' };
      if (icd && !/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/.test(icd)) return { ok: false, error: 'ICD-10 code format looks invalid (e.g. E11.9).' };
      if (!['provisional', 'confirmed'].includes(d.dxStatus) || !['mild', 'moderate', 'severe'].includes(d.severity)) return { ok: false, error: 'Select status and severity.' };
      if (notes.length > 1000) return { ok: false, error: 'Notes must be 1000 characters or fewer.' };
      db.clinicalRecords.unshift({ id: uid('rec'), hrid: a.patient.hrid, type: 'diagnosis', title, icd, dxStatus: d.dxStatus, severity: d.severity, details: notes || 'No additional notes.', hospitalId: s.hospitalId, authorId: s.id, author: s.name, createdAt: now(), shared: true });
      log('clinical', 'success', 'Diagnosis entered for ' + a.patient.hrid + (a.grant ? ' (emergency access)' : ''), s.email, s.hospitalId);
      return { ok: true };
    },
    // Originals are never edited: a correction is a new linked record that keeps the original intact.
    doctorAmendRecord(recordId, d) {
      const s = role('doctor');
      const orig = db.clinicalRecords.find((r) => r.id === recordId && r.type !== 'amendment');
      const a = orig && clinicianAccess(s, orig.hrid);
      if (!a || !visibleItem(s, a.grant, orig)) return { ok: false, error: 'Record not available.' };
      const text = String((d && d.text) || '').trim(), why = String((d && d.reason) || '').trim();
      if (text.length < 5 || text.length > 1000) return { ok: false, error: 'Amendment text is required (5–1000 characters).' };
      if (why.length < 5 || why.length > 200) return { ok: false, error: 'A reason is required (5–200 characters).' };
      db.clinicalRecords.unshift({ id: uid('rec'), hrid: orig.hrid, type: 'amendment', amends: orig.id, title: 'Amendment to: ' + orig.title, details: text + ' (Reason: ' + why + ')', hospitalId: s.hospitalId, authorId: s.id, author: s.name, createdAt: now(), shared: true });
      log('clinical', 'success', 'Amendment added to record ' + orig.id + ' for ' + orig.hrid + (a.grant ? ' (emergency access)' : ''), s.email, s.hospitalId);
      return { ok: true };
    },
    doctorMedicationCheck(hrid, name) {
      const s = role('doctor');
      if (!s || !clinicianAccess(s, hrid)) return { ok: false, error: 'Patient access is not permitted or has expired.', alerts: [] };
      if (!norm(name)) return { ok: false, error: 'Medication name is required.', alerts: [] };
      const alerts = drugAlerts(normHrid(hrid), String(name).trim());
      return { ok: true, alerts, blocking: alerts.some((x) => SEVERE.includes(x.severity)) };
    },
    doctorCreatePrescription(hrid, order, overrideReason) { return createRx(role('doctor'), hrid, order, overrideReason); },
    pharmCreatePrescription(hrid, order, overrideReason) { return createRx(role('pharmacist'), hrid, order, overrideReason); },

    // ---------- Lab Technician ----------
    labFindPatient(hrid) {
      const s = role('lab');
      const id = normHrid(hrid);
      if (!HRID_RE.test(id)) return { ok: false, error: HRID_MSG };
      const a = clinicianAccess(s, id);
      if (!a) { log('access', 'failure', 'Lab patient lookup failed: ' + id, s.email, s.hospitalId); return { ok: false, error: 'No patient with that HRID was found at your hospital.' }; }
      return { ok: true, patient: limitedPatient(a.patient) };
    },
    labSearchSecondary(q) { return secondarySearch(role('lab'), q); },
    async labUploadReport(d) {
      const s = role('lab');
      const a = clinicianAccess(s, d.hrid);
      if (!a) return { ok: false, error: 'Patient not found at your hospital. Verify the HRID.' };
      const title = String(d.title || '').trim(), file = d.file;
      if (title.length < 3 || title.length > 120) return { ok: false, error: 'Report title is required (3–120 characters).' };
      if (!REPORT_CATEGORIES.includes(d.category)) return { ok: false, error: 'Select a report category.' };
      if (!file || !file.size) return { ok: false, error: 'Choose a PDF file.' };
      if (file.size > 10 * 1024 * 1024) return { ok: false, error: 'The PDF must be 10 MB or smaller.' };
      if (!/\.pdf$/i.test(file.name) || file.type !== 'application/pdf') return { ok: false, error: 'Only PDF files are accepted.' };
      const buf = await readBytes(file);
      if (new TextDecoder().decode(new Uint8Array(buf, 0, 5)) !== '%PDF-') return { ok: false, error: 'The selected file is not a valid PDF.' };
      const id = uid('report');
      try { await idbPut(id, buf); } catch (e) { return { ok: false, error: 'This browser could not store the file.' }; }
      const item = { id, hrid: a.patient.hrid, title, category: d.category, fileName: String(file.name).replace(/[^\w.\- ()]/g, '_').slice(0, 120), mimeType: 'application/pdf', size: file.size, sha256: await sha256Bytes(buf), hasFile: true,
        hospitalId: s.hospitalId, uploadedBy: s.email, uploadedByName: s.name, uploadedAt: now(), processingStatus: 'processing', processedAt: null, summary: null, shared: true };
      db.reports.unshift(item);
      log('report', 'success', 'Medical report uploaded for ' + item.hrid + ': ' + item.fileName, s.email, s.hospitalId);
      save();
      processReport(id);
      return { ok: true, report: item };
    },
    labReports(scope) {
      const s = role('lab');
      if (!s) return [];
      return db.reports.filter((r) => r.hospitalId === s.hospitalId && (scope !== 'mine' || r.uploadedBy === s.email))
        .map((r) => Object.assign(withHospital(r), { patientName: (db.patients.find((p) => p.hrid === r.hrid) || {}).name || '—' }));
    },
    labReport(id) { return Store.labReports().find((r) => r.id === id); },
    labReportFile(id) { return reportFileFor(role('lab'), id); },


    // ---------- Pharmacist ----------
    pharmFindPatient(hrid) {
      const s = role('pharmacist');
      const id = normHrid(hrid);
      if (!HRID_RE.test(id)) return { ok: false, error: HRID_MSG };
      const a = clinicianAccess(s, id);
      if (!a) { log('access', 'failure', 'Pharmacy patient lookup failed: ' + id, s.email, s.hospitalId); return { ok: false, error: 'No patient with that HRID was found at your hospital.' }; }
      return { ok: true, patient: limitedPatient(a.patient) };
    },
    pharmSearchSecondary(q) { return secondarySearch(role('pharmacist'), q); },
    pharmOpenPatient(hrid) {
      const s = role('pharmacist');
      const a = s && clinicianAccess(s, hrid);
      if (!a) return null;
      const p = a.patient, action = 'Medication profile accessed: ' + p.hrid;
      if (!db.audit.some((l) => l.actor === s.email && l.action === action && Date.now() - new Date(l.ts).getTime() < 5 * 60000)) log('access', 'success', action, s.email, s.hospitalId);
      const meds = db.medications.filter((m) => m.hrid === p.hrid).map(withHospital);
      return {
        patient: Object.assign(limitedPatient(p), { hospitalName: hosName(p.hospitalId) }),
        allergies: db.allergies.filter((x) => x.hrid === p.hrid).map(withHospital),
        medications: meds.filter((m) => m.status === 'current'),
        history: meds.filter((m) => m.status === 'current' || visibleItem(s, null, m)).sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt)),
      };
    },
    pharmMedicationCheck(hrid, name) {
      const s = role('pharmacist');
      if (!s || !clinicianAccess(s, hrid)) return { ok: false, error: 'Patient access is not permitted.', alerts: [] };
      if (!norm(name)) return { ok: false, error: 'Medication name is required.', alerts: [] };
      const alerts = drugAlerts(normHrid(hrid), String(name).trim());
      return { ok: true, alerts, blocking: alerts.some((x) => SEVERE.includes(x.severity)) };
    },
    pharmRecentPatients() {
      const s = role('pharmacist');
      if (!s) return [];
      const seen = [];
      db.audit.filter((l) => l.actor === s.email && l.action.indexOf('Medication profile accessed: ') === 0).forEach((l) => { const h = l.action.slice(29); if (!seen.includes(h)) seen.push(h); });
      return seen.map((h) => clinicianAccess(s, h)).filter(Boolean).slice(0, 5).map((a) => limitedPatient(a.patient));
    },
    pharmRecentEntries() {
      const s = role('pharmacist');
      return s ? db.medications.filter((m) => m.hospitalId === s.hospitalId && m.prescribedBy === s.name).slice(0, 8).map((m) => Object.assign({}, m, { patientName: (db.patients.find((p) => p.hrid === m.hrid) || {}).name || '—' })) : [];
    },

    // ---------- Nurse ----------
    nurseFindPatient(hrid) {
      const s = role('nurse');
      const id = normHrid(hrid);
      if (!HRID_RE.test(id)) return { ok: false, error: HRID_MSG };
      const a = clinicianAccess(s, id);
      if (!a) { log('access', 'failure', 'Nursing patient lookup failed: ' + id, s.email, s.hospitalId); return { ok: false, error: 'No patient with that HRID was found at your hospital.' }; }
      return { ok: true, patient: limitedPatient(a.patient) };
    },
    nurseSearchSecondary(q) { return secondarySearch(role('nurse'), q); },
    nurseOpenPatient(hrid) {
      const s = role('nurse');
      const a = s && clinicianAccess(s, hrid);
      if (!a) return null;
      const p = a.patient, action = 'Nursing record accessed: ' + p.hrid;
      if (!db.audit.some((l) => l.actor === s.email && l.action === action && Date.now() - new Date(l.ts).getTime() < 5 * 60000)) log('access', 'success', action, s.email, s.hospitalId);
      const vitals = db.vitals.filter((v) => v.hrid === p.hrid && visibleItem(s, null, v)).map(withFlags).sort((x, y) => new Date(y.recordedAt) - new Date(x.recordedAt));
      return {
        patient: Object.assign(limitedPatient(p), { age: ageOf(p.dob), phone: p.phone, emergencyName: p.emergencyName, emergencyPhone: p.emergencyPhone, hospitalName: hosName(p.hospitalId) }),
        allergies: db.allergies.filter((x) => x.hrid === p.hrid).map(withHospital),
        vitals,
      };
    },
    nurseRecordVitals(hrid, d, correctsId) {
      const s = role('nurse');
      const a = s && clinicianAccess(s, hrid);
      if (!a) return { ok: false, error: 'Patient access is not permitted.' };
      const v = {};
      for (const k of Object.keys(VITAL_LIMITS)) {
        const raw = String(d[k] == null ? '' : d[k]).trim();
        if (raw === '') continue;
        const n = Number(raw);
        const [lo, hi, label] = VITAL_LIMITS[k];
        if (!isFinite(n) || n < lo || n > hi) return { ok: false, error: label + ' must be a number between ' + lo + ' and ' + hi + '.' };
        v[k] = n;
      }
      if (!Object.keys(v).length) return { ok: false, error: 'Enter at least one measurement.' };
      if ((v.bpSys != null) !== (v.bpDia != null)) return { ok: false, error: 'Enter both systolic and diastolic blood pressure.' };
      if (v.bpSys != null && v.bpSys <= v.bpDia) return { ok: false, error: 'Systolic pressure must be higher than diastolic.' };
      const notes = String(d.notes || '').trim();
      if (notes.length > 300) return { ok: false, error: 'Notes must be 300 characters or fewer.' };
      if (correctsId && !db.vitals.some((x) => x.id === correctsId && x.hrid === a.patient.hrid && x.hospitalId === s.hospitalId)) return { ok: false, error: 'The entry being updated was not found.' };
      const entry = Object.assign({ id: uid('vit'), hrid: a.patient.hrid, hospitalId: s.hospitalId, recordedBy: s.email, recordedByName: s.name, recordedAt: now(), notes, correctsId: correctsId || null, shared: true }, v);
      db.vitals.unshift(entry);
      log('clinical', 'success', 'Vitals recorded for ' + a.patient.hrid + (correctsId ? ' (updates entry ' + correctsId + ')' : ''), s.email, s.hospitalId);
      return { ok: true, entry: withFlags(entry) };
    },
    nurseRecentPatients() {
      const s = role('nurse');
      if (!s) return [];
      const seen = [];
      db.audit.filter((l) => l.actor === s.email && l.action.indexOf('Nursing record accessed: ') === 0).forEach((l) => { const h = l.action.slice(25); if (!seen.includes(h)) seen.push(h); });
      return seen.map((h) => clinicianAccess(s, h)).filter(Boolean).slice(0, 5).map((a) => limitedPatient(a.patient));
    },
    nurseRecentEntries() {
      const s = role('nurse');
      return s ? db.vitals.filter((v) => v.hospitalId === s.hospitalId && v.recordedBy === s.email).slice(0, 8).map((v) => Object.assign(withFlags(v), { patientName: (db.patients.find((p) => p.hrid === v.hrid) || {}).name || '—' })) : [];
    },

    // ---------- Patient ----------
    patientOverview() {
      const p = patientSelf();
      if (!p) return null;
      const records = db.clinicalRecords.filter((r) => r.hrid === p.hrid).map(withHospital);
      const reports = db.reports.filter((r) => r.hrid === p.hrid).map(withHospital);
      const timeline = records.map((r) => ({ id: r.id, type: r.type, title: r.title, details: r.details, icd: r.icd, hospitalName: r.hospitalName, author: r.author, createdAt: r.createdAt }))
        .concat(reports.map((r) => ({ id: r.id, type: 'report', title: r.title, details: r.summary ? r.summary.headline : 'Report uploaded', hospitalName: r.hospitalName, author: r.uploadedByName || r.uploadedBy, createdAt: r.uploadedAt, reportId: r.id })))
        .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
      const events = patientAccessEvents(p);
      return {
        patient: { id: p.id, hrid: p.hrid, name: p.name, dob: p.dob, gender: p.gender, phone: p.phone || '', email: p.email, address: p.address || '', emergencyName: p.emergencyName || '', emergencyPhone: p.emergencyPhone || '', hospitalName: hosName(p.hospitalId) },
        records, reports, timeline,
        allergies: db.allergies.filter((x) => x.hrid === p.hrid).map(withHospital),
        medications: db.medications.filter((m) => m.hrid === p.hrid).map(withHospital).sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt)),
        vitals: db.vitals.filter((v) => v.hrid === p.hrid).map(withFlags).slice(0, 5),
        consent: Object.assign({ shareWithOtherHospitals: true, notifyOnEmergency: true }, p.consent),
        accessCount: events.length, emergencyCount: events.filter((e) => e.category === 'emergency').length,
      };
    },
    patientReportFile(id) { return reportFileFor(role('patient'), id); },
    patientUpdateContact(d) {
      const p = patientSelf();
      if (!p) return { ok: false, error: 'Not allowed.' };
      const f = (k, max) => String(d[k] || '').trim().slice(0, max);
      const phone = f('phone', 20), emergencyPhone = f('emergencyPhone', 20), phoneRe = /^$|^\+?[\d\s()-]{6,20}$/;
      if (!phoneRe.test(phone) || !phoneRe.test(emergencyPhone)) return { ok: false, error: 'Enter valid phone numbers (digits, spaces, + ( ) - only).' };
      Object.assign(p, { phone, emergencyPhone, address: f('address', 200), emergencyName: f('emergencyName', 80) });
      log('account', 'success', 'Patient updated contact details: ' + p.hrid, p.email, p.hospitalId);
      return { ok: true };
    },
    patientAccessHistory() {
      const p = patientSelf();
      return p ? patientAccessEvents(p) : [];
    },
    patientEmergencyHistory() {
      const p = patientSelf();
      return p ? patientAccessEvents(p).filter((e) => e.category === 'emergency') : [];
    },
    patientSetConsent(d) {
      const p = patientSelf();
      if (!p) return { ok: false, error: 'Not allowed.' };
      p.consent = { shareWithOtherHospitals: !!d.shareWithOtherHospitals, notifyOnEmergency: !!d.notifyOnEmergency };
      log('account', 'success', 'Consent preferences updated for ' + p.hrid + ': cross-hospital sharing ' + (p.consent.shareWithOtherHospitals ? 'allowed' : 'not allowed'), p.email, p.hospitalId);
      return { ok: true };
    },
    async patientChangePassword(current, next, confirm) {
      const p = patientSelf();
      if (!p) return { ok: false, error: 'Not allowed.' };
      if (!(await verifyPw(String(current), p.passwordHash))) { log('security', 'failure', 'Password change failed (wrong current password)', p.email, p.hospitalId); return { ok: false, error: 'Current password is incorrect.' }; }
      if (String(next).length < db.config.minPasswordLength) return { ok: false, error: 'New password must be at least ' + db.config.minPasswordLength + ' characters.' };
      if (next !== confirm) return { ok: false, error: 'New passwords do not match.' };
      if (next === current) return { ok: false, error: 'New password must differ from the current one.' };
      p.passwordHash = await hashPw(String(next));
      log('security', 'success', 'Patient changed password', p.email, p.hospitalId);
      return { ok: true };
    },

    hospitals: () => db.hospitals.slice(),
    hospital: (id) => db.hospitals.find((h) => h.id === id),
    users: () => db.users.slice(),
    usersOf: (hid) => db.users.filter((u) => u.hospitalId === hid),
    audit: () => db.audit.slice(),
    config: () => Object.assign({}, db.config),

    addHospital(data) {
      const email = data.email.trim().toLowerCase();
      if (db.hospitals.some((h) => h.email === email)) return { ok: false, error: 'A hospital with this admin email already exists.' };
      if (db.hospitals.some((h) => h.code === data.code.trim().toUpperCase())) return { ok: false, error: 'Hospital code already in use.' };
      let username = String(data.username || '').trim().toLowerCase();
      if (username) {
        if (!USERNAME_RE.test(username)) return { ok: false, error: 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.' };
        if ([].concat(...accountLists()).some((x) => x.username === username)) return { ok: false, error: 'This username is already taken.' };
      } else username = uniqueUsername(data.code.trim().toLowerCase() + '.admin');
      const h = Object.assign({}, data, { id: uid('hos'), email, username, code: data.code.trim().toUpperCase(), status: 'pending', createdAt: now() });
      h.invite = { token: randToken(), expiresAt: new Date(Date.now() + db.config.inviteExpiryDays * 864e5).toISOString() };
      db.hospitals.unshift(h);
      log('account', 'success', 'Hospital registered; invitation issued', currentAdmin().email, h.id);
      return { ok: true, hospital: h };
    },
    resendInvite(id) {
      const h = Store.hospital(id);
      if (!h || h.status === 'active' && !h.invite) return { ok: false, error: 'Hospital already set up.' };
      h.invite = { token: randToken(), expiresAt: new Date(Date.now() + db.config.inviteExpiryDays * 864e5).toISOString() };
      log('account', 'success', 'Invitation re-sent', currentAdmin().email, id);
      return { ok: true, hospital: h };
    },
    inviteLink: (h) => location.origin + '/#/setup-password?token=' + encodeURIComponent(h.invite.token),
    setStatus(id, status) {
      const h = Store.hospital(id);
      if (!h) return false;
      if (status === 'active' && h.invite) return false; // must finish password setup first
      h.status = status;
      log('account', 'success', status === 'active' ? 'Hospital activated' : 'Hospital deactivated', currentAdmin().email, id);
      return true;
    },
    updateHospital(id, patch) {
      Object.assign(Store.hospital(id), patch);
      log('account', 'success', 'Hospital details updated', currentAdmin().email, id);
    },
    // Forgot password: username + registered email must belong to the same account. The reply is always the same,
    // so it never reveals whether an account exists. Real email delivery needs a backend; the demo writes to a mailbox page.
    async requestReset(username, email) {
      await load();
      const u = norm(username), e = norm(email);
      const acc = u && e ? [].concat(db.admins, db.users, db.patients).find((x) => x.username === u && norm(x.email) === e && x.passwordHash) : null;
      if (acc && acc.status !== 'suspended' && acc.status !== 'inactive') {
        const token = randToken();
        acc.reset = { token, expiresAt: new Date(Date.now() + RESET_MINUTES * 60000).toISOString() };
        db.mailbox.unshift({ id: uid('mail'), to: acc.email, subject: 'CareVault password reset', link: location.origin + '/#/reset-password?token=' + encodeURIComponent(token), ts: now(), expiresAt: acc.reset.expiresAt });
        db.mailbox = db.mailbox.slice(0, 20);
        log('security', 'success', 'Password reset link issued', acc.email, acc.hospitalId);
      } else log('security', 'failure', 'Password reset requested for unmatched username/email', e || 'unknown');
      save();
      return { ok: true };
    },
    async completeReset(token, password) {
      await load();
      const acc = token ? [].concat(db.admins, db.users, db.patients).find((x) => x.reset && x.reset.token === token) : null;
      if (!acc) return { ok: false, error: 'This reset link is invalid or has already been used.' };
      if (new Date(acc.reset.expiresAt) < new Date()) { acc.reset = null; save(); return { ok: false, error: 'This reset link has expired. Request a new one.' }; }
      if (String(password).length < db.config.minPasswordLength) return { ok: false, error: 'Password must be at least ' + db.config.minPasswordLength + ' characters.' };
      acc.passwordHash = await hashPw(String(password));
      acc.reset = null; acc.failed = 0; acc.lockedUntil = 0;
      log('security', 'success', 'Password reset completed', acc.email, acc.hospitalId);
      save();
      return { ok: true };
    },
    mailbox: () => (db.mailbox || []).filter((m) => new Date(m.expiresAt) > new Date()),
    async completeSetup(token, password) {
      const h = db.hospitals.find((x) => x.invite && x.invite.token === token);
      const u = h ? null : db.users.find((x) => x.invite && x.invite.token === token);
      const p = h || u ? null : db.patients.find((x) => x.invite && x.invite.token === token);
      const target = h || u || p;
      if (!token || !target) return { ok: false, error: 'Invalid or already used invitation link.' };
      if (new Date(target.invite.expiresAt) < new Date()) return { ok: false, error: 'This invitation has expired. Ask your administrator to resend it.' };
      if (password.length < db.config.minPasswordLength) return { ok: false, error: 'Password must be at least ' + db.config.minPasswordLength + ' characters.' };
      const hash = await hashPw(password);
      target.invite = null;
      if (h) {
        h.status = 'active';
        db.users.push({ id: uid('usr'), name: h.adminName, email: h.email, username: h.username, role: 'Hospital Admin', department: 'Administration', phone: h.phone, hospitalId: h.id, status: 'active', lastLogin: null, createdAt: now(), invite: null, passwordHash: hash });
        log('account', 'success', 'Hospital admin set password; account activated', h.email, h.id);
      } else if (p) {
        p.status = 'active'; p.passwordHash = hash;
        log('account', 'success', 'Patient account activated: ' + p.hrid, p.email, p.hospitalId);
      } else {
        u.status = 'active'; u.passwordHash = hash;
        log('account', 'success', 'Staff set password; account activated', u.email, u.hospitalId);
      }
      return { ok: true };
    },
    setUserStatus(id, status) {
      const u = db.users.find((x) => x.id === id);
      if (!u) return;
      u.status = status;
      log('account', 'success', status === 'suspended' ? 'User suspended' : 'User reactivated', currentAdmin().email, u.hospitalId);
    },
    forceReset(id) {
      const u = db.users.find((x) => x.id === id);
      log('security', 'success', 'Password reset forced for ' + u.email, currentAdmin().email, u.hospitalId);
    },
    saveConfig(cfg) {
      Object.assign(db.config, cfg);
      log('security', 'success', 'System configuration updated', currentAdmin().email);
    },
    logExport() { log('security', 'success', 'Audit log exported', currentAdmin().email); },
    STAFF_ROLES: ['PCC', 'Doctor', 'Nurse', 'Receptionist', 'Pharmacist', 'Lab Technician', 'Billing Staff'],
    myHospital() { const s = currentAdmin(); return s && s.hospitalId ? Store.hospital(s.hospitalId) : null; },
    staff() { const s = currentAdmin(); return s && s.hospitalId ? db.users.filter((u) => u.hospitalId === s.hospitalId) : []; },
    staffMember(id) { return Store.staff().find((u) => u.id === id); },
    hospitalAudit() { const s = currentAdmin(); return s && s.hospitalId ? db.audit.filter((l) => l.hospitalId === s.hospitalId) : []; },
    updateProfile(patch) {
      const h = Store.myHospital(); if (!h) return false;
      ['phone', 'address', 'city', 'country'].forEach((k) => { if (patch[k] != null) h[k] = String(patch[k]).trim(); });
      log('account', 'success', 'Hospital profile updated', currentAdmin().email, h.id);
      return true;
    },
    addStaff(d) {
      const s = currentAdmin(); const h = Store.myHospital();
      if (!h) return { ok: false, error: 'Not allowed.' };
      if (!Store.STAFF_ROLES.includes(d.role)) return { ok: false, error: 'Invalid role.' };
      const email = d.email.trim().toLowerCase();
      if (db.users.some((u) => u.email === email) || db.admins.some((a) => a.email === email) || db.hospitals.some((x) => x.email === email)) return { ok: false, error: 'An account with this email already exists.' };
      const u = { id: uid('usr'), name: d.name.trim(), email, username: uniqueUsername(email.split('@')[0]), role: d.role, department: d.department.trim(), phone: d.phone.trim(), hospitalId: h.id, status: 'pending', lastLogin: null, createdAt: now(), passwordHash: null,
        invite: { token: randToken(), expiresAt: new Date(Date.now() + db.config.inviteExpiryDays * 864e5).toISOString() } };
      db.users.unshift(u);
      log('account', 'success', 'Staff account created (' + u.role + '); activation invitation issued to ' + email, s.email, h.id);
      return { ok: true, user: u };
    },
    resendStaffInvite(id) {
      const u = Store.staffMember(id);
      if (!u || u.status !== 'pending') return { ok: false, error: 'Only pending accounts can be re-invited.' };
      u.invite = { token: randToken(), expiresAt: new Date(Date.now() + db.config.inviteExpiryDays * 864e5).toISOString() };
      log('account', 'success', 'Staff invitation re-sent to ' + u.email, currentAdmin().email, u.hospitalId);
      return { ok: true, user: u };
    },
    setStaffStatus(id, status) {
      const s = currentAdmin(); const u = Store.staffMember(id);
      if (!u || u.role === 'Hospital Admin' || u.id === s.id || u.status === 'pending' || !['active', 'suspended'].includes(status)) return false;
      if (status === 'active' && !u.passwordHash) {
        u.status = 'pending';
        u.invite = { token: randToken(), expiresAt: new Date(Date.now() + db.config.inviteExpiryDays * 864e5).toISOString() };
      } else u.status = status;
      log('account', 'success', (status === 'suspended' ? 'Staff suspended: ' : 'Staff reactivated: ') + u.email, s.email, u.hospitalId);
      return true;
    },
    updateStaff(id, d) {
      const u = Store.staffMember(id);
      if (!u || u.role === 'Hospital Admin' || !Store.STAFF_ROLES.includes(d.role)) return false;
      Object.assign(u, { role: d.role, department: d.department.trim(), phone: d.phone.trim() });
      log('account', 'success', 'Staff details updated: ' + u.email, currentAdmin().email, u.hospitalId);
      return true;
    },
    staffForceReset(id) {
      const u = Store.staffMember(id);
      if (!u || u.role === 'Hospital Admin' || u.status !== 'active') return false;
      log('security', 'success', 'Password reset forced for ' + u.email, currentAdmin().email, u.hospitalId);
      return true;
    },
    PCC_ROLES: ['Doctor', 'Nurse', 'Lab Technician', 'Pharmacist'],
    patients() { const s = currentAdmin(); return s && s.hospitalId ? db.patients.filter((p) => p.hospitalId === s.hospitalId) : []; },
    patient(id) { return Store.patients().find((p) => p.id === id); },
    pccStaff() { return Store.staff().filter((u) => Store.PCC_ROLES.includes(u.role)); },
    pccStaffMember(id) { return Store.pccStaff().find((u) => u.id === id); },
    pccAudit() { const s = currentAdmin(); return s ? Store.hospitalAudit().filter((l) => l.actor === s.email) : []; },
    // HRID: unambiguous alphabet, random, unique across the platform.
    newHrid() {
      const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const ymd = now().slice(0, 10).replace(/-/g, '');
      for (;;) {
        const a = new Uint8Array(8); crypto.getRandomValues(a);
        const id = 'HDW-' + ymd + '-' + Array.from(a).map((b) => A[b % A.length]).join('');
        if (!db.patients.some((p) => p.hrid === id)) return id;
      }
    },
    registerPatient(d) {
      const s = currentAdmin();
      const name = String(d.name || '').trim(), email = String(d.email || '').trim().toLowerCase();
      if (!name || !d.dob || !d.gender) return { ok: false, error: 'Name, date of birth and gender are required.' };
      if (new Date(d.dob) > new Date()) return { ok: false, error: 'Date of birth cannot be in the future.' };
      if (email && (db.patients.some((p) => p.email === email) || db.users.some((u) => u.email === email) || db.admins.some((a) => a.email === email) || db.hospitals.some((x) => x.email === email))) return { ok: false, error: 'An account with this email already exists.' };
      const p = { id: uid('pat'), hrid: Store.newHrid(), username: email ? uniqueUsername(email.split('@')[0]) : '', name, dob: d.dob, gender: d.gender, phone: String(d.phone || '').trim(), email, address: String(d.address || '').trim(),
        emergencyName: String(d.emergencyName || '').trim(), emergencyPhone: String(d.emergencyPhone || '').trim(), hospitalId: s.hospitalId, registeredBy: s.email, createdAt: now(),
        status: email ? 'pending' : 'registered', invite: email ? { token: randToken(), expiresAt: new Date(Date.now() + db.config.inviteExpiryDays * 864e5).toISOString() } : null };
      db.patients.unshift(p);
      log('account', 'success', 'Patient registered: ' + p.hrid + (email ? ' (account invitation issued)' : ' (no account)'), s.email, s.hospitalId);
      return { ok: true, patient: p };
    },
    resendPatientInvite(id) {
      const p = Store.patient(id);
      if (!p || p.status !== 'pending') return { ok: false, error: 'Only pending patient accounts can be re-invited.' };
      p.invite = { token: randToken(), expiresAt: new Date(Date.now() + db.config.inviteExpiryDays * 864e5).toISOString() };
      log('account', 'success', 'Patient invitation re-sent: ' + p.hrid, currentAdmin().email, p.hospitalId);
      return { ok: true, patient: p };
    },
    pccAddStaff(d) {
      if (!Store.PCC_ROLES.includes(d.role)) return { ok: false, error: 'Not allowed to create this role.' };
      return rawAddStaff.call(Store, d);
    },
    pccDeactivate(id) {
      const s = currentAdmin(); const u = Store.pccStaffMember(id);
      if (!u || u.status === 'suspended') return false;
      u.status = 'suspended'; u.invite = null;
      log('account', 'success', 'Staff deactivated: ' + u.email + ' (' + u.role + ')', s.email, u.hospitalId);
      return true;
    },
    persist: () => save(),
    resetDemo: async () => { db = null; localStorage.removeItem(KEY); await seed(); },
  };

  // Persist after every mutating call.
  const rawAddStaff = Store.addStaff; // unwrapped; PCC reaches it only through role-restricted pccAddStaff
  const GUARDS = {
    sysadmin: ['addHospital', 'resendInvite', 'setStatus', 'updateHospital', 'setUserStatus', 'forceReset', 'saveConfig', 'logExport'],
    hospitaladmin: ['updateProfile', 'addStaff', 'resendStaffInvite', 'setStaffStatus', 'updateStaff', 'staffForceReset'],
    pcc: ['registerPatient', 'resendPatientInvite', 'pccAddStaff', 'pccDeactivate'],
    doctor: ['doctorFindPatient', 'doctorSearchSecondary', 'doctorOpenPatient', 'doctorReport', 'doctorReportFile', 'doctorEmergencyAccess', 'doctorAccessHistory', 'doctorRecentPatients', 'doctorCreateDiagnosis', 'doctorAmendRecord', 'doctorMedicationCheck', 'doctorCreatePrescription'],
    pharmacist: ['pharmFindPatient', 'pharmSearchSecondary', 'pharmOpenPatient', 'pharmMedicationCheck', 'pharmCreatePrescription', 'pharmRecentPatients', 'pharmRecentEntries'],
    nurse: ['nurseFindPatient', 'nurseSearchSecondary', 'nurseOpenPatient', 'nurseRecordVitals', 'nurseRecentPatients', 'nurseRecentEntries'],
    patient: ['patientOverview', 'patientReportFile', 'patientUpdateContact', 'patientAccessHistory', 'patientEmergencyHistory', 'patientSetConsent', 'patientChangePassword'],
    lab: ['labFindPatient', 'labSearchSecondary', 'labUploadReport', 'labReports', 'labReport', 'labReportFile'],
  };
  const OBJ_RESULT = ['pharmFindPatient', 'pharmSearchSecondary', 'pharmMedicationCheck', 'pharmCreatePrescription', 'nurseFindPatient', 'nurseSearchSecondary', 'nurseRecordVitals', 'patientReportFile', 'patientUpdateContact', 'patientSetConsent', 'patientChangePassword', 'addHospital', 'addStaff', 'resendInvite', 'resendStaffInvite', 'registerPatient', 'resendPatientInvite', 'pccAddStaff',
    'doctorFindPatient', 'doctorSearchSecondary', 'doctorReport', 'doctorReportFile', 'doctorEmergencyAccess', 'doctorCreateDiagnosis', 'doctorAmendRecord', 'doctorMedicationCheck', 'doctorCreatePrescription', 'labFindPatient', 'labSearchSecondary', 'labUploadReport', 'labReportFile'];
  const LIST_RESULT = ['pharmRecentPatients', 'pharmRecentEntries', 'nurseRecentPatients', 'nurseRecentEntries', 'patientAccessHistory', 'patientEmergencyHistory', 'doctorAccessHistory', 'doctorRecentPatients', 'labReports'];
  const NEED = {};
  Object.keys(GUARDS).forEach((r) => GUARDS[r].forEach((n) => { NEED[n] = r; }));
  Object.keys(NEED).concat(['completeSetup']).forEach((n) => {
    const f = Store[n];
    Store[n] = function () {
      const s = currentAdmin();
      if (NEED[n] && (!s || s.role !== NEED[n])) return OBJ_RESULT.includes(n) ? { ok: false, error: 'Not allowed.' } : LIST_RESULT.includes(n) ? [] : false;
      const r = f.apply(this, arguments);
      const done = () => save();
      if (r && typeof r.then === 'function') return r.then((v) => { done(); return v; });
      done();
      return r;
    };
  });

  window.Store = Store;
})();
