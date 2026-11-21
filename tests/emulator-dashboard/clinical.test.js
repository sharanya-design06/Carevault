const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const { getDashboardPatient, requestCrossHospitalAccess } = require('../../functions/dashboard-registration');
const {
  assignPatientCare, listMyPatients, addClinicalRecord, listClinicalRecords, dispensePrescription,
} = require('../../functions/dashboard-clinical');
const { listSensitiveAudit } = require('../../functions/dashboard-admin');

test('care assignment gates clinical records by role, hospital and grant type', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'clinical-test');
  const db = app.firestore();
  const hrid = 'HDW-20260101-CLIN0001';
  const tok = { PCC: { role: 'PCC', hospitalId: 'cA' }, DOC: { role: 'DOCTOR', subType: 'SPECIALIST', hospitalId: 'cA' },
    NUR: { role: 'NURSE', hospitalId: 'cA' }, PHA: { role: 'PHARMACIST', hospitalId: 'cA' }, LAB: { role: 'LAB', subType: 'RADIOLOGY', hospitalId: 'cA' },
    HADM: { role: 'HOSPITAL_ADMIN', hospitalId: 'cA' }, SYS: { role: 'SYSTEM_ADMIN' },
    OUT: { role: 'DOCTOR', subType: 'SPECIALIST', hospitalId: 'cB' }, PAT: { role: 'PATIENT', patientId: hrid } };
  const as = (uid, data) => ({ auth: { uid, token: tok[uid] }, data });
  const reject = (promise, c) => assert.rejects(promise, (e) => e.code === c);
  try {
    for (const id of ['cA', 'cB']) await db.collection('dashboardHospitals').doc(id).set({ status: 'active' });
    for (const [uid, t] of Object.entries(tok)) await db.collection('dashboardUsers').doc(uid).set({ status: 'active', ...t });
    await db.collection('dashboardPatients').doc(hrid).set({ hrid, name: 'Fictional', dob: '2000-01-02', gender: 'Other', hospitalId: 'cA', status: 'active', authUid: 'PAT', shareWithOtherHospitals: false });

    // A record needs an open encounter at the author's hospital.
    await db.collection('dashboardEncounters').doc('enc-clin').set({ patientId: hrid, hrid, hospitalId: 'cA', status: 'open', locked: false, type: 'outpatient' });

    // No care relationship yet.
    await reject(getDashboardPatient(as('DOC', { hrid }), db), 'permission-denied');
    await reject(addClinicalRecord(as('NUR', { hrid, type: 'vitals', data: { pulse: 70 } }), db), 'permission-denied');
    assert.deepEqual(await listMyPatients(as('DOC'), db), []);

    // Only the PCC of the same hospital may assign, and only same-hospital clinicians.
    await reject(assignPatientCare(as('DOC', { hrid, uid: 'DOC' }), db), 'permission-denied');
    await reject(assignPatientCare(as('PCC', { hrid, uid: 'OUT' }), db), 'permission-denied');
    await reject(assignPatientCare(as('PCC', { hrid, uid: 'PCC' }), db), 'permission-denied');
    await reject(assignPatientCare({ data: { hrid, uid: 'DOC' } }, db), 'unauthenticated');
    for (const uid of ['DOC', 'NUR', 'PHA']) await assignPatientCare(as('PCC', { hrid, uid }), db);
    assert.equal((await listMyPatients(as('DOC'), db))[0].hrid, hrid);

    // Writes: role-specific, validated.
    await addClinicalRecord(as('NUR', { hrid, type: 'vitals', data: { pulse: 72, temp: 36.8 } }), db);
    await reject(addClinicalRecord(as('NUR', { hrid, type: 'vitals', data: { pulse: 900 } }), db), 'invalid-argument');
    await reject(addClinicalRecord(as('NUR', { hrid, type: 'diagnosis', data: { condition: 'x' } }), db), 'permission-denied');
    await addClinicalRecord(as('DOC', { hrid, type: 'diagnosis', data: { condition: 'Fictional flu' } }), db);
    const rx = await addClinicalRecord(as('DOC', { hrid, type: 'prescription', data: { drug: 'Synthetol', dose: '5mg', frequency: 'daily', days: 5 } }), db);
    await reject(addClinicalRecord(as('DOC', { hrid, type: 'prescription', data: { drug: 'Synthetol', dose: '5mg', frequency: 'daily', days: 5, extra: 1 } }), db), 'invalid-argument');
    await reject(addClinicalRecord(as('LAB', { hrid, type: 'vitals', data: { pulse: 70 } }), db), 'permission-denied');

    // Reads are filtered by role.
    const types = async (uid) => (await listClinicalRecords(as(uid, { hrid }), db)).map((r) => r.type).sort();
    assert.deepEqual(await types('DOC'), ['diagnosis', 'prescription', 'vitals']);
    assert.deepEqual(await types('NUR'), ['vitals']);
    assert.deepEqual(await types('PHA'), ['prescription']);
    assert.deepEqual(await types('PAT'), ['diagnosis', 'prescription', 'vitals']);
    const records = await db.collection('dashboardRecords').where('patientId', '==', hrid).get();
    assert.ok(records.docs.length > 0);
    assert.ok(records.docs.every((doc) => doc.get('sensitive') === true));
    assert.ok((await listClinicalRecords(as('DOC', { hrid }), db)).every((record) => record.sensitive));
    await reject(listClinicalRecords(as('LAB', { hrid }), db), 'permission-denied');
    await reject(listClinicalRecords(as('PCC', { hrid }), db), 'permission-denied');
    await reject(listClinicalRecords(as('OUT', { hrid }), db), 'permission-denied');

    // Dispensing: pharmacist only, once.
    await reject(dispensePrescription(as('NUR', { recordId: rx.id }), db), 'permission-denied');
    await dispensePrescription(as('PHA', { recordId: rx.id }), db);
    await reject(dispensePrescription(as('PHA', { recordId: rx.id }), db), 'failed-precondition');

    // A cross-hospital grant allows reading but never writing.
    await requestCrossHospitalAccess(as('OUT', { hrid, reason: 'Referred for a second opinion.' }), db);
    assert.deepEqual(await types('OUT'), ['diagnosis', 'prescription', 'vitals']);
    await reject(addClinicalRecord(as('OUT', { hrid, type: 'diagnosis', data: { condition: 'x' } }), db), 'permission-denied');

    const hospitalAudit = await listSensitiveAudit(as('HADM'), db);
    assert.ok(hospitalAudit.some((event) => event.actorUid === 'OUT' && event.viewerHospitalId === 'cB' &&
      event.patientId === hrid && event.accessScope === 'reasoned'));
    assert.ok(hospitalAudit.every((event) => !('recordIds' in event) && !('data' in event)));
    assert.deepEqual(await listSensitiveAudit(as('OUT'), db), []);
    await reject(listSensitiveAudit(as('PAT'), db), 'permission-denied');
    await reject(listSensitiveAudit(as('SYS'), db), 'permission-denied');

    // Ending care removes access.
    await assignPatientCare(as('PCC', { hrid, uid: 'NUR', status: 'ended' }), db);
    await reject(listClinicalRecords(as('NUR', { hrid }), db), 'permission-denied');
    assert.deepEqual(await listMyPatients(as('NUR'), db), []);
    const actions = (await db.collection('dashboardAudit').where('patientId', '==', hrid).get()).docs.map((d) => d.get('action'));
    for (const a of ['care_assigned', 'record_added', 'records_read', 'prescription_dispensed', 'care_ended']) assert.ok(actions.includes(a), a);
  } finally {
    await db.collection('dashboardUsers').doc('SYS').delete();
    await app.delete();
  }
});
