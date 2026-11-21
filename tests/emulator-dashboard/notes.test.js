const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const { assignPatientCare, addClinicalRecord } = require('../../functions/dashboard-clinical');
const {
  saveDashboardNote, signDashboardNote, addDashboardNoteAddendum, listDashboardNotes, getDashboardNoteVersions, markEncounterBillingCleared, listOpenEncounters,
} = require('../../functions/dashboard-notes');

test('notes are versioned, signed notes only take addenda, and the encounter locks after discharge and billing', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'notes-test');
  const db = app.firestore();
  const hrid = 'HDW-20260101-NOTE0001';
  const tok = {
    PCC: { role: 'PCC', hospitalId: 'nA' }, GP: { role: 'DOCTOR', subType: 'GENERAL_PRIMARY', hospitalId: 'nA' },
    GP2: { role: 'DOCTOR', subType: 'GENERAL_PRIMARY', hospitalId: 'nA' }, SURG: { role: 'DOCTOR', subType: 'SURGEON', hospitalId: 'nA' },
    ANES: { role: 'DOCTOR', subType: 'ANESTHETIST', hospitalId: 'nA' }, NUR: { role: 'NURSE', hospitalId: 'nA' },
    OUT: { role: 'DOCTOR', subType: 'SPECIALIST', hospitalId: 'nB' }, PCCB: { role: 'PCC', hospitalId: 'nB' },
  };
  const as = (uid, data) => ({ auth: { uid, token: tok[uid] }, data });
  const reject = (promise, c) => assert.rejects(promise, (e) => e.code === c);
  const consult = { complaint: 'Cough', history: 'Two weeks', assessment: 'Viral', plan: 'Rest' };
  try {
    for (const id of ['nA', 'nB']) await db.collection('dashboardHospitals').doc(id).set({ status: 'active' });
    for (const [uid, t] of Object.entries(tok)) await db.collection('dashboardUsers').doc(uid).set({ status: 'active', ...t });
    await db.collection('dashboardPatients').doc(hrid).set({ hrid, name: 'Fictional', dob: '2000-01-02', gender: 'Other', hospitalId: 'nA', status: 'active', authUid: null, shareWithOtherHospitals: false });
    const enc = db.collection('dashboardEncounters').doc('enc-note');
    await enc.set({ patientId: hrid, hrid, hospitalId: 'nA', status: 'open', locked: false, type: 'outpatient' });
    for (const uid of ['GP', 'GP2', 'SURG', 'ANES', 'NUR']) await assignPatientCare(as('PCC', { hrid, uid }), db);

    // Writers: role, sub-type and care relationship.
    await reject(saveDashboardNote(as('NUR', { hrid, noteType: 'consultation', content: consult }), db), 'permission-denied');
    await reject(saveDashboardNote(as('PCC', { hrid, noteType: 'consultation', content: consult }), db), 'permission-denied');
    await reject(saveDashboardNote(as('OUT', { hrid, noteType: 'consultation', content: consult }), db), 'permission-denied');
    await reject(saveDashboardNote(as('GP', { hrid, noteType: 'operative', content: { procedure: 'x' } }), db), 'permission-denied');
    await reject(saveDashboardNote(as('GP', { hrid, noteType: 'anesthesia', content: { chart: 'x' } }), db), 'permission-denied');
    await reject(saveDashboardNote(as('GP', { hrid, noteType: 'consultation', content: { bogus: 'x' } }), db), 'invalid-argument');
    await reject(saveDashboardNote(as('GP', { hrid, noteType: 'progress', content: { plan: 'x' } }), db), 'failed-precondition');
    await reject(saveDashboardNote({ data: { hrid } }, db), 'unauthenticated');

    // Drafts are editable, each edit is a new version, and only the author sees them.
    const { noteId } = await saveDashboardNote(as('GP', { hrid, noteType: 'consultation', content: { complaint: 'Cough' } }), db);
    assert.deepEqual(await saveDashboardNote(as('GP', { hrid, noteType: 'consultation', noteId, content: consult }), db), { noteId, version: 2 });
    await reject(saveDashboardNote(as('GP', { noteType: 'consultation', noteId, baseVersion: 1, content: consult }), db), 'aborted');
    await reject(saveDashboardNote(as('GP2', { noteType: 'consultation', noteId, content: consult }), db), 'permission-denied');
    assert.deepEqual((await listDashboardNotes(as('GP2', { hrid }), db)), []);
    assert.equal((await listDashboardNotes(as('GP', { hrid }), db))[0].status, 'draft');
    assert.deepEqual((await getDashboardNoteVersions(as('GP', { noteId }), db)).map((v) => v.content.complaint), ['Cough', 'Cough']);
    await reject(getDashboardNoteVersions(as('GP2', { noteId }), db), 'permission-denied');
    await reject(signDashboardNote(as('GP2', { noteId }), db), 'permission-denied');
    const incomplete = await saveDashboardNote(as('GP', { hrid, noteType: 'consultation', content: { complaint: 'Only this' } }), db);
    await reject(signDashboardNote(as('GP', { noteId: incomplete.noteId }), db), 'failed-precondition');

    // Signed notes are locked; corrections are addenda.
    assert.deepEqual(await signDashboardNote(as('GP', { noteId }), db), { noteId, status: 'signed', encounterLocked: false });
    await reject(saveDashboardNote(as('GP', { noteType: 'consultation', noteId, content: consult }), db), 'failed-precondition');
    await reject(signDashboardNote(as('GP', { noteId }), db), 'failed-precondition');
    await reject(addDashboardNoteAddendum(as('GP2', { noteId, text: 'x', reason: 'y' }), db), 'permission-denied');
    await reject(addDashboardNoteAddendum(as('GP', { noteId: incomplete.noteId, text: 'x', reason: 'y' }), db), 'failed-precondition');
    await reject(addDashboardNoteAddendum(as('GP', { noteId, text: '', reason: 'y' }), db), 'invalid-argument');
    await addDashboardNoteAddendum(as('GP', { noteId, text: 'Plan changed to antibiotics', reason: 'Culture result' }), db);
    const seen = (await listDashboardNotes(as('GP2', { hrid }), db)).find((n) => n.id === noteId);
    assert.equal(seen.content.plan, 'Rest', 'the original content is preserved');
    assert.equal(seen.addenda[0].reason, 'Culture result');
    assert.equal(seen.own, false);
    assert.equal((await listDashboardNotes(as('NUR', { hrid }), db)).length, 1);
    await reject(listDashboardNotes(as('PCC', { hrid }), db), 'permission-denied');
    assert.equal((await db.collection('dashboardNotes').doc(noteId).collection('versions').get()).size, 2);

    // Sub-type specific notes.
    const op = await saveDashboardNote(as('SURG', { hrid, noteType: 'operative', content: { consentConfirmed: true, procedure: 'Appendectomy' } }), db);
    await signDashboardNote(as('SURG', { noteId: op.noteId }), db);
    const an = await saveDashboardNote(as('ANES', { hrid, noteType: 'anesthesia', content: { preAssessment: 'ASA 1', chart: 'Stable' } }), db);
    await signDashboardNote(as('ANES', { noteId: an.noteId }), db);
    await reject(saveDashboardNote(as('SURG', { hrid, noteType: 'operative', content: { consentConfirmed: 'yes' } }), db), 'invalid-argument');

    // Locking needs both a signed discharge summary and cleared billing, in any order.
    const discharge = { diagnosis: 'Viral URTI', medicines: 'Paracetamol', followUp: '1 week', warningSigns: 'Fever' };
    const d1 = await saveDashboardNote(as('GP', { hrid, noteType: 'discharge', content: discharge }), db);
    await reject(markEncounterBillingCleared(as('GP', { encounterId: 'enc-note' }), db), 'permission-denied');
    await reject(markEncounterBillingCleared(as('PCCB', { encounterId: 'enc-note' }), db), 'permission-denied');
    assert.equal((await signDashboardNote(as('GP', { noteId: d1.noteId }), db)).encounterLocked, false);
    assert.equal((await enc.get()).get('locked'), false);
    const worklist = await listOpenEncounters(as('PCC', {}), db);
    const mine = worklist.find((r) => r.encounterId === 'enc-note');
    assert.deepEqual([mine.hrid, mine.dischargeSigned, mine.billingCleared], [hrid, true, false]);
    assert.deepEqual(Object.keys(mine).sort(), ['billingCleared', 'dischargeSigned', 'encounterId', 'hrid', 'openedAt', 'patientName', 'visitType'], 'no clinical content is returned');
    await reject(listOpenEncounters(as('GP', {}), db), 'permission-denied');
    assert.equal((await listOpenEncounters(as('PCCB', {}), db)).some((r) => r.encounterId === 'enc-note'), false, 'other hospitals see nothing');
    assert.deepEqual(await markEncounterBillingCleared(as('PCC', { encounterId: 'enc-note' }), db), { encounterId: 'enc-note', encounterLocked: true });
    assert.equal((await listOpenEncounters(as('PCC', {}), db)).some((r) => r.encounterId === 'enc-note'), false, 'locked encounters leave the worklist');
    const locked = (await enc.get()).data();
    assert.equal(locked.locked, true);
    assert.equal(locked.status, 'closed');

    await reject(saveDashboardNote(as('GP', { hrid, noteType: 'consultation', content: consult }), db), 'failed-precondition');
    await reject(addClinicalRecord(as('NUR', { hrid, type: 'vitals', data: { pulse: 70 } }), db), 'failed-precondition');
    await reject(markEncounterBillingCleared(as('PCC', { encounterId: 'enc-note' }), db), 'failed-precondition');
    await addDashboardNoteAddendum(as('GP', { noteId, text: 'Late correction', reason: 'Typo' }), db);
    assert.equal((await listDashboardNotes(as('GP', { hrid }), db)).find((n) => n.id === noteId).addenda.length, 2);

    // Billing first, then discharge, also locks.
    const enc2 = db.collection('dashboardEncounters').doc('enc-note-2');
    await enc2.set({ patientId: hrid, hrid, hospitalId: 'nA', status: 'open', locked: false, type: 'inpatient' });
    assert.equal((await markEncounterBillingCleared(as('PCC', { encounterId: 'enc-note-2' }), db)).encounterLocked, false);
    const prog = await saveDashboardNote(as('GP', { hrid, noteType: 'progress', content: { assessment: 'Improving', plan: 'Continue' } }), db);
    await signDashboardNote(as('GP', { noteId: prog.noteId }), db);
    const d2 = await saveDashboardNote(as('GP', { hrid, noteType: 'discharge', content: discharge }), db);
    assert.equal((await signDashboardNote(as('GP', { noteId: d2.noteId }), db)).encounterLocked, true);

    const actions = (await db.collection('dashboardAudit').where('patientId', '==', hrid).get()).docs.map((d) => d.get('action'));
    for (const a of ['note_saved', 'note_signed', 'note_addendum_added', 'encounter_locked', 'billing_cleared', 'sensitive_record_read']) assert.ok(actions.includes(a), a);
  } finally {
    await app.delete();
  }
});
