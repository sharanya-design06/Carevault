const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Loads a secure dashboard script against a fake DOM and canned callable results.
async function load(file, hash, role, replies, pathname = '/', formData = FormData) {
  const calls = [];
  const app = { innerHTML: '' };
  const listeners = {};
  const location = { hash, pathname, replace(url) { this.replaced = url; } };
  const window = {
    addEventListener: () => {},
    FirebaseSession: {
      enabled: true, session: () => ({ id: 'me', hospitalId: 'h1', hrid: 'HDW-20260101-AAAAAAAA' }), logout() {},
      call: async (name, data) => { calls.push([name, data]); if (!(name in replies)) throw new Error('unexpected ' + name); return replies[name]; },
    },
    UI: {
      $app: app, esc: (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
      badge: (s) => `[${s}]`, toast() {}, guard: (r) => r === role,
      shell: (nav, title, active, html) => html,
    },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    window, location, document: { addEventListener: (type, fn) => { listeners[type] = fn; } },
    confirm: () => true, FormData: formData, crypto, console,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { app, calls, location, window, listeners };
}

const hospital = { id: 'h1', name: 'North <b>', code: 'h1', licenseNo: 'L', phone: '1', address: 'A', city: 'C', country: 'X', status: 'active' };
const staff = [{ uid: 'u1', name: 'Dr <i>X</i>', email: 'x@e.test', role: 'DOCTOR', subType: 'SPECIALIST', status: 'active' },
  { uid: 'u2', name: 'Nina', email: 'n@e.test', role: 'NURSE', status: 'inactive' }];

test('hospital admin dashboard and staff list render escaped server data', async () => {
  const dash = await load('public/hospital-admin/secure.js', '#/dashboard', 'hospitaladmin', { listDashboardHospitals: [hospital], listDashboardUsers: staff });
  assert.match(dash.app.innerHTML, /North &#60;b&#62;/);
  assert.doesNotMatch(dash.app.innerHTML, /North <b>/);
  const list = await load('public/hospital-admin/secure.js', '#/staff', 'hospitaladmin', { listDashboardUsers: staff });
  assert.match(list.app.innerHTML, /Deactivate/);
  assert.match(list.app.innerHTML, /Reactivate/);
  assert.doesNotMatch(list.app.innerHTML, /<i>/);
});

test('system admin hospitals and audit views render', async () => {
  const hs = await load('public/system-admin/secure.js', '#/hospitals', 'sysadmin', { listDashboardHospitals: [hospital] });
  assert.match(hs.app.innerHTML, /Add admin/);
  const audit = await load('public/system-admin/secure.js', '#/audit', 'sysadmin', { listDashboardAudit: [{ action: 'hospital_created', actorRole: 'SYSTEM_ADMIN', hospitalId: 'h1', timestamp: '2026-01-01T00:00:00Z' }] });
  assert.match(audit.app.innerHTML, /hospital created/);
});

test('a signed-out session redirects to the login page and unrelated roles are not rendered', async () => {
  const out = await load('public/system-admin/secure.js', '#/hospitals', 'sysadmin', {});
  assert.equal(out.location.replaced, undefined);
  const denied = await load('public/hospital-admin/secure.js', '#/staff', 'someone-else', { listDashboardUsers: staff });
  assert.equal(denied.calls.length, 0);
});

test('clinician pages show role-specific forms and a read-only banner without care', async () => {
  const card = { hrid: 'HDW-20260101-AAAAAAAA', name: 'Pat', dob: '2000-01-01', gender: 'Other', phone: '' };
  const rec = [{ id: 'r1', type: 'prescription', data: { drug: 'Synthetol', dose: '5mg', frequency: 'daily', days: 3 }, status: 'pending', createdAt: 0 }];
  const replies = { getDashboardPatient: card, listMyPatients: [card], listClinicalRecords: rec };
  const hash = '#/patient/' + card.hrid;
  const nurse = await load('public/assets/js/clinical-secure.js', hash, 'nurse', replies, '/nurse/');
  assert.match(nurse.app.innerHTML, /data-form="vitals"/);
  assert.doesNotMatch(nurse.app.innerHTML, /data-form="prescription"/);
  const doctor = await load('public/assets/js/clinical-secure.js', hash, 'doctor', replies, '/doctor/');
  assert.match(doctor.app.innerHTML, /data-form="prescription"/);
  const pharmacist = await load('public/assets/js/clinical-secure.js', hash, 'pharmacist', replies, '/pharmacist/');
  assert.match(pharmacist.app.innerHTML, /Mark dispensed/);
  const noCare = await load('public/assets/js/clinical-secure.js', hash, 'doctor', { ...replies, listMyPatients: [] }, '/doctor/');
  assert.match(noCare.app.innerHTML, /Read-only view/);
  assert.doesNotMatch(noCare.app.innerHTML, /data-form="diagnosis"/);
});

test('saving vitals for a patient under 18 shows a caution that no BMI category was assigned', async () => {
  const card = { hrid: 'HDW-20260101-AAAAAAAA', name: 'Kid', dob: '2018-01-01', gender: 'Other', phone: '' };
  const replies = { getDashboardPatient: card, listMyPatients: [card], listClinicalRecords: [], listDashboardNotes: [], addClinicalRecord: { id: 'r', bmi: 15, bmiCategory: null, bmiBasis: 'age_percentile_required' } };
  const entries = [['hrid', card.hrid], ['weightKg', '30'], ['heightCm', '140']];
  const nurse = await load('public/assets/js/clinical-secure.js', '#/patient/' + card.hrid, 'nurse', replies, '/nurse/', function () { return entries[Symbol.iterator](); });
  assert.doesNotMatch(nurse.app.innerHTML, /BMI-for-age/);
  const form = { dataset: { form: 'vitals' }, querySelector: () => ({ disabled: false }) };
  await nurse.listeners.submit({ target: { closest: () => form }, preventDefault() {} });
  assert.match(nurse.app.innerHTML, /under 18.*BMI-for-age/);
  replies.addClinicalRecord = { id: 'r2', bmi: 22, bmiCategory: 'Normal', bmiBasis: 'WHO' };
  await nurse.listeners.submit({ target: { closest: () => form }, preventDefault() {} });
  assert.doesNotMatch(nurse.app.innerHTML, /BMI-for-age/);
});

test('PCC billing clearance lists open encounters and clears billing through the callable', async () => {
  const row = { encounterId: 'enc1', hrid: 'HDW-20260101-AAAAAAAA', patientName: 'Pat <x>', visitType: 'inpatient', openedAt: 0, dischargeSigned: true, billingCleared: false };
  const replies = { listOpenEncounters: [row], markEncounterBillingCleared: { encounterId: 'enc1', encounterLocked: true } };
  const pcc = await load('public/pcc/secure.js', '#/billing', 'pcc', replies, '/pcc/');
  assert.match(pcc.app.innerHTML, /Pat &#60;x&#62;/);
  assert.match(pcc.app.innerHTML, /data-action="clear-billing" data-id="enc1"/);
  assert.doesNotMatch(pcc.app.innerHTML, /Pat <x>/);
  assert.deepEqual(pcc.calls[0], ['listOpenEncounters', undefined]);
});

test('patient portal renders own record, notifications and the sharing control', async () => {
  const me = { hrid: 'HDW-20260101-AAAAAAAA', name: 'Pat <x>', dob: '2000-01-01', gender: 'Other', phone: '', address: '', emergencyName: '', emergencyPhone: '' };
  const replies = {
    getDashboardPatient: me, listClinicalRecords: [{ id: 'r', type: 'diagnosis', data: { condition: 'Fictional flu' }, createdAt: 0 }],
    getPatientNotifications: [{ id: 'n', viewingHospitalId: 'hB', reason: 'Referral', createdAt: 0 }], getMySharing: { share: false },
  };
  const run = async (hash) => load('public/patient/secure.js', hash, 'patient', replies);
  const dash = await run('#/dashboard');
  assert.match(dash.app.innerHTML, /Pat &#60;x&#62;/);
  assert.match(dash.app.innerHTML, /Fictional flu/);
  assert.match((await run('#/notifications')).app.innerHTML, /Hospital <b>hB<\/b> viewed your record/);
  assert.match((await run('#/sharing')).app.innerHTML, /type="checkbox" name="share" >/);
});
