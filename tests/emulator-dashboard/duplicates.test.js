const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const { registerDashboardPatient, getDashboardPatient } = require('../../functions/dashboard-registration');
const { findDashboardPatient } = require('../../functions/dashboard-lookup');
const { assignPatientCare, addClinicalRecord, listClinicalRecords } = require('../../functions/dashboard-clinical');
const { listDuplicateCandidates, reviewDuplicateCandidate } = require('../../functions/dashboard-duplicates');
const { scoreDuplicate, nameSimilarity } = require('../../functions/dashboard-duplicate-detection');

test('duplicate scoring favours identity evidence and penalises mismatches', () => {
  const base = { nameKey: 'aarav sharma', dob: '1990-04-05', gender: 'Male', phoneKey: '9876543210', abhaId: '' };
  assert.ok(nameSimilarity('aarav sharma', 'aarav sharmaa') > 0.85);
  assert.ok(nameSimilarity('aarav sharma', 'meera iyer') < 0.3);
  assert.ok(scoreDuplicate(base, { ...base, nameKey: 'aarav sharmaa' }).score >= 0.6);
  assert.ok(scoreDuplicate(base, { ...base, nameKey: 'meera iyer' }).score < 0.6, 'a shared birth date or phone alone is not enough');
  assert.ok(scoreDuplicate(base, { ...base, gender: 'Female' }).score < scoreDuplicate(base, base).score);
  assert.ok(scoreDuplicate({ ...base, abhaId: '12345678901234' }, { ...base, nameKey: 'x y', dob: '2000-01-01', phoneKey: '', abhaId: '12345678901234' }).score >= 0.6);
});

test('duplicates are suggested, reviewed by the PCC, and merged without rewriting records', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'duplicates-test');
  const db = app.firestore();
  const tok = { PCC: { role: 'PCC', hospitalId: 'dA' }, PCCB: { role: 'PCC', hospitalId: 'dB' }, NUR: { role: 'NURSE', hospitalId: 'dA' }, DOC: { role: 'DOCTOR', subType: 'SPECIALIST', hospitalId: 'dA' } };
  const as = (uid, data) => ({ auth: { uid, token: tok[uid] }, data });
  const reject = (promise, c) => assert.rejects(promise, (e) => e.code === c);
  let n = 0;
  const register = (uid, fields) => registerDashboardPatient(as(uid, { dob: '1990-04-05', gender: 'Male', visitType: 'outpatient', phone: '9876543210', requestId: 'dup-request-' + String(++n).padStart(6, '0'), ...fields }), db);
  try {
    for (const id of ['dA', 'dB']) await db.collection('dashboardHospitals').doc(id).set({ status: 'active' });
    for (const [uid, t] of Object.entries(tok)) await db.collection('dashboardUsers').doc(uid).set({ status: 'active', ...t });

    const first = await register('PCC', { name: 'Aarav Sharma' });
    assert.equal(first.possibleDuplicates, undefined);
    const unrelated = await register('PCC', { name: 'Meera Iyer', phone: '5550001111' });
    assert.equal(unrelated.possibleDuplicates, undefined, 'same birth date alone is not a match');
    const typo = await register('PCC', { name: 'Aarav Sharmaa' });
    assert.equal(typo.possibleDuplicates, 1);
    assert.equal((await register('PCCB', { name: 'Aarav Sharma' })).possibleDuplicates, undefined, 'suggestions never cross hospitals');
    const third = await register('PCC', { name: 'Aarav  sharma', phone: '5550002222' });
    assert.equal(third.possibleDuplicates, 2);

    await reject(listDuplicateCandidates(as('NUR'), db), 'permission-denied');
    const pending = await listDuplicateCandidates(as('PCC'), db);
    assert.equal(pending.length, 3);
    assert.ok(pending.every((c) => c.model === 'rules-v1' && c.score >= 0.6 && c.reasons.length && c.patients.length === 2));
    assert.deepEqual(await listDuplicateCandidates(as('PCCB'), db), []);
    const pair = (a, b) => pending.find((c) => c.patients.map((p) => p.hrid).sort().join() === [a, b].sort().join());

    // Rejecting keeps both patients and removes the suggestion; it is not suggested again.
    await reject(reviewDuplicateCandidate(as('PCCB', { candidateId: pair(first.hrid, typo.hrid).id, decision: 'reject' }), db), 'permission-denied');
    await reject(reviewDuplicateCandidate(as('NUR', { candidateId: pair(first.hrid, typo.hrid).id, decision: 'reject' }), db), 'permission-denied');
    await reject(reviewDuplicateCandidate(as('PCC', { candidateId: pair(first.hrid, typo.hrid).id, decision: 'delete' }), db), 'invalid-argument');
    await reviewDuplicateCandidate(as('PCC', { candidateId: pair(first.hrid, typo.hrid).id, decision: 'reject' }), db);
    await reject(reviewDuplicateCandidate(as('PCC', { candidateId: pair(first.hrid, typo.hrid).id, decision: 'reject' }), db), 'failed-precondition');
    assert.equal((await listDuplicateCandidates(as('PCC'), db)).length, 2);

    // Merge: the secondary is retired, its records stay under its own ID and read through to the primary.
    await assignPatientCare(as('PCC', { hrid: third.hrid, uid: 'NUR' }), db);
    await addClinicalRecord(as('NUR', { hrid: third.hrid, type: 'vitals', data: { pulse: 66 } }), db);
    await assignPatientCare(as('PCC', { hrid: first.hrid, uid: 'NUR' }), db);
    await addClinicalRecord(as('NUR', { hrid: first.hrid, type: 'vitals', data: { pulse: 71 } }), db);
    const mergeId = pair(first.hrid, third.hrid).id;
    await reject(reviewDuplicateCandidate(as('PCC', { candidateId: mergeId, decision: 'merge', primaryHrid: 'HDW-20260101-NOPE0000' }), db), 'invalid-argument');
    await db.collection('dashboardPatients').doc(third.hrid).update({ authUid: 'has-login' });
    await reject(reviewDuplicateCandidate(as('PCC', { candidateId: mergeId, decision: 'merge', primaryHrid: first.hrid }), db), 'failed-precondition');
    await db.collection('dashboardPatients').doc(third.hrid).update({ authUid: null });
    assert.deepEqual(await reviewDuplicateCandidate(as('PCC', { candidateId: mergeId, decision: 'merge', primaryHrid: first.hrid }), db),
      { candidateId: mergeId, status: 'merged', primaryHrid: first.hrid });

    const retired = (await db.collection('dashboardPatients').doc(third.hrid).get()).data();
    assert.equal(retired.status, 'inactive');
    assert.equal(retired.mergedInto, first.hrid);
    assert.deepEqual((await db.collection('dashboardPatients').doc(first.hrid).get()).get('mergedFrom'), [third.hrid]);
    await reject(getDashboardPatient(as('PCC', { hrid: third.hrid }), db), 'permission-denied');
    assert.deepEqual(await findDashboardPatient(as('PCC', { method: 'hrid', value: third.hrid }), db), []);
    const history = await listClinicalRecords(as('NUR', { hrid: first.hrid }), db);
    assert.deepEqual(history.map((r) => [r.data.pulse, r.encounterId ? 'enc' : 'none']).sort(), [[66, 'enc'], [71, 'enc']]);
    assert.deepEqual(new Set(history.map((r) => r.data.pulse)), new Set([66, 71]));
    const originals = await db.collection('dashboardRecords').where('patientId', '==', third.hrid).get();
    assert.equal(originals.size, 1, 'the original record keeps its own patient ID');

    // Candidates that involved the retired record are no longer reviewable.
    assert.deepEqual(await listDuplicateCandidates(as('PCC'), db), []);
    const audit = (await db.collection('dashboardAudit').where('hospitalId', '==', 'dA').get()).docs.map((d) => d.get('action'));
    for (const a of ['duplicate_rejected', 'duplicate_merged', 'duplicate_candidates_read']) assert.ok(audit.includes(a), a);
  } finally {
    await app.delete();
  }
});
