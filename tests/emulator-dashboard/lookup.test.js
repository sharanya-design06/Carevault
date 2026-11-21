const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const { registerDashboardPatient } = require('../../functions/dashboard-registration');
const { findDashboardPatient, openDashboardEncounter } = require('../../functions/dashboard-lookup');
const { assignPatientCare, addClinicalRecord, listClinicalRecords } = require('../../functions/dashboard-clinical');

test('patient lookup methods, hospital scoping and encounter linking', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'lookup-test');
  const db = app.firestore();
  const tok = { PCC: { role: 'PCC', hospitalId: 'lkA' }, PCCB: { role: 'PCC', hospitalId: 'lkB' },
    NUR: { role: 'NURSE', hospitalId: 'lkA' }, HADM: { role: 'HOSPITAL_ADMIN', hospitalId: 'lkA' } };
  const as = (uid, data) => ({ auth: { uid, token: tok[uid] }, data });
  const reject = (promise, c) => assert.rejects(promise, (e) => e.code === c);
  const find = (uid, method, value) => findDashboardPatient(as(uid, { method, value }), db);
  try {
    for (const id of ['lkA', 'lkB']) await db.collection('dashboardHospitals').doc(id).set({ status: 'active' });
    for (const [uid, t] of Object.entries(tok)) await db.collection('dashboardUsers').doc(uid).set({ status: 'active', ...t });

    const base = { name: 'Aarav  Sharma', dob: '1990-04-05', gender: 'Male', visitType: 'outpatient', phone: '+91 98765-43210',
      abhaId: '12-3456-7890-1234', hospitalPatientId: 'MRN-001' };
    const { hrid, encounterId } = await registerDashboardPatient(as('PCC', { ...base, requestId: 'lookup-request-0001' }), db);
    await reject(registerDashboardPatient(as('PCC', { ...base, name: 'Other Person', requestId: 'lookup-request-0002' }), db), 'already-exists');
    await reject(registerDashboardPatient(as('PCC', { ...base, abhaId: '123', hospitalPatientId: '', requestId: 'lookup-request-0003' }), db), 'invalid-argument');
    assert.equal((await registerDashboardPatient(as('PCCB', { ...base, name: 'Sibling', requestId: 'lookup-request-0004' }), db)).hrid.startsWith('HDW-'), true,
      'the same hospital patient ID may exist at another hospital');

    for (const [method, value] of [['hrid', hrid], ['qr', 'carevault:' + hrid.toLowerCase()], ['phone', '09876543210'],
      ['abha', '12345678901234'], ['hospitalId', 'MRN-001'], ['demographics', { name: 'aarav sharma', dob: '1990-04-05', gender: 'Male' }]]) {
      const found = await find('PCC', method, value);
      assert.deepEqual(found.map((p) => p.hrid), [hrid], method);
      assert.equal(found[0].phone, undefined, 'lookup cards carry no contact details');
    }
    assert.deepEqual(await find('PCCB', 'hrid', hrid), [], 'another hospital cannot find the patient');
    assert.deepEqual(await find('PCC', 'demographics', { name: 'Aarav Sharma', dob: '1990-04-06', gender: 'Male' }), []);
    assert.equal((await find('NUR', 'phone', '9876543210')).length, 1);
    await reject(find('HADM', 'hrid', hrid), 'permission-denied');
    await reject(find('PCC', 'demographics', { name: 'Aarav Sharma' }), 'invalid-argument');
    await reject(find('PCC', 'sql', 'x'), 'invalid-argument');
    await reject(find('PCC', 'phone', '12'), 'invalid-argument');
    await reject(findDashboardPatient({ data: { method: 'hrid', value: hrid } }, db), 'unauthenticated');

    const audit = (await db.collection('dashboardAudit').where('action', '==', 'patient_lookup').get()).docs.map((d) => JSON.stringify(d.data()));
    assert.ok(audit.length >= 7 && audit.every((e) => !e.includes('9876543210') && !e.includes('MRN-001') && !e.includes('Aarav')));

    await reject(openDashboardEncounter(as('PCC', { hrid, visitType: 'outpatient' }), db), 'failed-precondition');
    await reject(openDashboardEncounter(as('PCCB', { hrid, visitType: 'outpatient' }), db), 'permission-denied');
    await reject(openDashboardEncounter(as('NUR', { hrid, visitType: 'outpatient' }), db), 'permission-denied');
    await db.collection('dashboardEncounters').doc(encounterId).update({ status: 'closed' });
    await reject(addClinicalRecord(as('NUR', { hrid, type: 'vitals', data: { pulse: 70 } }), db), 'permission-denied');
    await assignPatientCare(as('PCC', { hrid, uid: 'NUR' }), db);
    await reject(addClinicalRecord(as('NUR', { hrid, type: 'vitals', data: { pulse: 70 } }), db), 'failed-precondition');
    const next = await openDashboardEncounter(as('PCC', { hrid, visitType: 'inpatient' }), db);
    assert.notEqual(next.encounterId, encounterId);
    await addClinicalRecord(as('NUR', { hrid, type: 'vitals', data: { pulse: 70 } }), db);
    const [record] = await listClinicalRecords(as('NUR', { hrid }), db);
    assert.equal(record.encounterId, next.encounterId);
  } finally {
    await app.delete();
  }
});
