const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const { getDashboardPatient } = require('../../functions/dashboard-registration');
const { assignPatientCare, addClinicalRecord, listClinicalRecords, listMyPatients, setPriorityCare } = require('../../functions/dashboard-clinical');
const { setHospitalBmiPolicy } = require('../../functions/dashboard-admin');
const { computeBmi } = require('../../functions/dashboard-triage');

test('BMI is calculated per policy and age', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  assert.deepEqual(computeBmi({ weightKg: 70, heightCm: 175 }, '1990-01-01', 'WHO', now), { bmi: 22.9, bmiCategory: 'Normal', bmiBasis: 'WHO' });
  assert.equal(computeBmi({ weightKg: 70, heightCm: 175 }, '1990-01-01', 'ASIA_PACIFIC', now).bmiCategory, 'Normal');
  assert.equal(computeBmi({ weightKg: 72, heightCm: 170 }, '1990-01-01', 'WHO', now).bmiCategory, 'Normal');
  assert.equal(computeBmi({ weightKg: 72, heightCm: 170 }, '1990-01-01', 'ASIA_PACIFIC', now).bmiCategory, 'Overweight');
  assert.equal(computeBmi({ weightKg: 75, heightCm: 170 }, '1990-01-01', 'ASIA_PACIFIC', now).bmiCategory, 'Obese');
  assert.equal(computeBmi({ weightKg: 85, heightCm: 170 }, '1990-01-01', undefined, now).bmiCategory, 'Overweight');
  assert.equal(computeBmi({ weightKg: 95, heightCm: 170 }, '1990-01-01', 'WHO', now).bmiCategory, 'Obese');
  assert.equal(computeBmi({ weightKg: 50, heightCm: 175 }, '1990-01-01', 'WHO', now).bmiCategory, 'Underweight');
  assert.deepEqual(computeBmi({ weightKg: 30, heightCm: 140 }, '2015-01-01', 'WHO', now), { bmi: 15.3, bmiCategory: null, bmiBasis: 'age_percentile_required' });
  assert.deepEqual(computeBmi({ weightKg: 70 }, '1990-01-01', 'WHO', now), {});
  assert.throws(() => computeBmi({ weightKg: 300, heightCm: 100 }, '1990-01-01', 'WHO', now), (e) => e.code === 'invalid-argument');
});

test('triage orders the worklist, BMI is server-calculated, and the Priority Care flag stays neutral', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'triage-test');
  const db = app.firestore();
  const tok = { PCC: { role: 'PCC', hospitalId: 'tA' }, NUR: { role: 'NURSE', hospitalId: 'tA' }, DOC: { role: 'DOCTOR', subType: 'GENERAL_PRIMARY', hospitalId: 'tA' },
    PHA: { role: 'PHARMACIST', hospitalId: 'tA' }, HADM: { role: 'HOSPITAL_ADMIN', hospitalId: 'tA' }, HADMB: { role: 'HOSPITAL_ADMIN', hospitalId: 'tB' },
    OUT: { role: 'NURSE', hospitalId: 'tB' } };
  const as = (uid, data) => ({ auth: { uid, token: tok[uid] }, data });
  const reject = (promise, c) => assert.rejects(promise, (e) => e.code === c);
  const hrids = ['HDW-20260101-TRIA0001', 'HDW-20260101-TRIA0002', 'HDW-20260101-TRIA0003', 'HDW-20260101-TRIA0004'];
  try {
    for (const id of ['tA', 'tB']) await db.collection('dashboardHospitals').doc(id).set({ status: 'active' });
    for (const [uid, t] of Object.entries(tok)) await db.collection('dashboardUsers').doc(uid).set({ status: 'active', ...t });
    const dobs = ['1990-03-03', '1950-01-01', '2018-05-05', '1985-07-07'];
    for (const [i, hrid] of hrids.entries()) {
      await db.collection('dashboardPatients').doc(hrid).set({ hrid, name: 'Patient ' + i, dob: dobs[i], gender: 'Other', hospitalId: 'tA', status: 'active', authUid: null, shareWithOtherHospitals: false });
      await db.collection('dashboardEncounters').doc('enc-' + i).set({ patientId: hrid, hrid, hospitalId: 'tA', status: 'open', locked: false, type: 'outpatient', createdAt: admin.firestore.Timestamp.fromMillis(1000 + i) });
      await assignPatientCare(as('PCC', { hrid, uid: 'NUR' }), db);
      await assignPatientCare(as('PCC', { hrid, uid: 'DOC' }), db);
    }

    // BMI: calculated by the server, never accepted from the caller, and never overwritten.
    const vit = (data, hrid = hrids[0]) => addClinicalRecord(as('NUR', { hrid, type: 'vitals', data }), db);
    const first = await vit({ pulse: 70, weightKg: 85, heightCm: 170, pain: 2, rr: 16 });
    assert.deepEqual([first.bmi, first.bmiCategory, first.bmiBasis], [29.4, 'Overweight', 'WHO']);
    await reject(vit({ weightKg: 85, heightCm: 170, bmi: 18 }), 'invalid-argument');
    await reject(vit({ weightKg: 300, heightCm: 100 }), 'invalid-argument');
    await reject(vit({ weightKg: 70, heightCm: 5 }), 'invalid-argument');
    await reject(vit({ pain: 2.5 }), 'invalid-argument');
    assert.equal((await vit({ weightKg: 70 })).bmi, undefined, 'weight alone saves without a BMI');
    const child = await vit({ weightKg: 15, heightCm: 100 }, hrids[2]);
    assert.deepEqual([child.bmi, child.bmiCategory, child.bmiBasis], [15, null, 'age_percentile_required']);

    await setHospitalBmiPolicy(as('HADM', { policy: 'ASIA_PACIFIC' }), db);
    assert.equal((await vit({ weightKg: 85, heightCm: 170 })).bmiCategory, 'Obese');
    await reject(setHospitalBmiPolicy(as('NUR', { policy: 'WHO' }), db), 'permission-denied');
    await reject(setHospitalBmiPolicy(as('HADM', { policy: 'EU' }), db), 'invalid-argument');
    assert.equal((await db.collection('dashboardHospitals').doc('tB').get()).get('bmiPolicy'), undefined, 'a hospital admin only changes their own hospital');
    const history = (await listClinicalRecords(as('NUR', { hrid: hrids[0] }), db)).filter((r) => r.type === 'vitals');
    assert.equal(history.length, 3, 'every accepted entry is a new timestamped record; rejected ones save nothing');

    // Triage validation and the worklist.
    const triage = (hrid, data) => addClinicalRecord(as('NUR', { hrid, type: 'triage', data }), db);
    await reject(triage(hrids[0], { chiefComplaint: 'Cough' }), 'invalid-argument');
    await reject(triage(hrids[0], { queuePriority: 'urgent' }), 'invalid-argument');
    await reject(triage(hrids[0], { chiefComplaint: 'Cough', queuePriority: 'urgent', fallRisk: 'extreme' }), 'invalid-argument');
    await reject(addClinicalRecord(as('DOC', { hrid: hrids[0], type: 'triage', data: { chiefComplaint: 'x', queuePriority: 'urgent' } }), db), 'permission-denied');
    assert.deepEqual((await listMyPatients(as('DOC'), db)).map((p) => p.hrid), hrids, 'untriaged patients wait in arrival order');
    await triage(hrids[0], { chiefComplaint: 'Cough', queuePriority: 'non_urgent', allergies: 'Penicillin', fallRisk: 'low' });
    await triage(hrids[1], { chiefComplaint: 'Chest pain', queuePriority: 'emergent', pressureSoreRisk: 'moderate' });
    await triage(hrids[3], { chiefComplaint: 'Sprain', queuePriority: 'non_urgent' });
    assert.deepEqual((await listMyPatients(as('DOC'), db)).map((p) => p.hrid), [hrids[1], hrids[0], hrids[3], hrids[2]]);

    // Priority Care: neutral for non-clinicians, and a shorter wait within the same triage level.
    await reject(setPriorityCare(as('PHA', { hrid: hrids[3], active: true, categories: ['elderly'] }), db), 'permission-denied');
    await reject(setPriorityCare(as('OUT', { hrid: hrids[3], active: true, categories: ['elderly'] }), db), 'permission-denied');
    await reject(setPriorityCare(as('NUR', { hrid: hrids[3], active: true, categories: ['hiv'] }), db), 'invalid-argument');
    await reject(setPriorityCare(as('NUR', { hrid: hrids[3], active: true, categories: [] }), db), 'invalid-argument');
    await setPriorityCare(as('NUR', { hrid: hrids[3], active: true, categories: ['immunocompromised'] }), db);
    const worklist = await listMyPatients(as('DOC'), db);
    assert.deepEqual(worklist.map((p) => p.hrid), [hrids[1], hrids[3], hrids[0], hrids[2]]);
    assert.equal(worklist[1].priorityCare, true);
    const pccView = await getDashboardPatient(as('PCC', { hrid: hrids[3] }), db);
    assert.equal(pccView.priorityCare, true);
    assert.equal(JSON.stringify(pccView).includes('immunocompromised'), false, 'the PCC never sees the reasons');
    const nurseView = await getDashboardPatient(as('NUR', { hrid: hrids[3] }), db);
    assert.deepEqual(nurseView.priorityCareCategories, ['immunocompromised']);
    assert.deepEqual((await getDashboardPatient(as('NUR', { hrid: hrids[1] }), db)).suggestedPriorityCategories, ['elderly']);
    await assignPatientCare(as('PCC', { hrid: hrids[3], uid: 'PHA' }), db);
    assert.equal((await getDashboardPatient(as('PHA', { hrid: hrids[3] }), db)).priorityCareCategories, undefined);
    await setPriorityCare(as('PCC', { hrid: hrids[0], active: true, categories: ['disabled'] }), db);
    await setPriorityCare(as('PCC', { hrid: hrids[0], active: false }), db);
    assert.equal((await getDashboardPatient(as('PCC', { hrid: hrids[0] }), db)).priorityCare, false);

    const encounter = (await db.collection('dashboardEncounters').doc('enc-1').get()).data();
    assert.equal(encounter.queuePriority, 'emergent');
    const audit = (await db.collection('dashboardAudit').where('action', '==', 'priority_care_set').get()).docs;
    assert.ok(audit.length >= 3 && audit.every((d) => !JSON.stringify(d.data()).includes('immunocompromised')), 'audit entries omit the reasons');
  } finally {
    await app.delete();
  }
});
