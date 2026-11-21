const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const { dashboardActor, authorizeDashboardReport } = require('../../functions/secure-report-dashboard-auth');

test('secure reports accept Firebase dashboard identity and honor active care and AI consent', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'secure-report-integration-test');
  const db = app.firestore();
  const hrid = 'HDW-20260101-RPT00001';
  const token = { role: 'DOCTOR', subType: 'SPECIALIST', hospitalId: 'rpt-h1' };
  const request = { auth: { uid: 'report-doctor', token }, data: {} };
  const fail = (promise, code) => assert.rejects(promise, (e) => e.code === code);
  try {
    await db.collection('dashboardHospitals').doc('rpt-h1').set({ status: 'active' });
    await db.collection('dashboardUsers').doc('report-doctor').set({ ...token, status: 'active' });
    await db.collection('dashboardPatients').doc(hrid).set({
      hrid, name: 'Synthetic Report Patient', hospitalId: 'rpt-h1', status: 'active',
      authUid: null, shareWithOtherHospitals: false, aiProcessingConsent: true,
    });
    const txRun = (fn) => db.runTransaction(fn);
    const actor = await txRun((tx) => dashboardActor(tx, db, 'report-doctor', request));
    assert.equal(actor.role, 'doctor');
    await fail(txRun((tx) => authorizeDashboardReport(tx, db, actor, hrid, 'rpt-h1', ['doctor'], true)), 'permission-denied');

    await db.collection('dashboardCare').doc('report-doctor').collection('patients').doc(hrid)
      .set({ status: 'active', hospitalId: 'rpt-h1' });
    const access = await txRun((tx) => authorizeDashboardReport(tx, db, actor, hrid, 'rpt-h1', ['doctor'], true));
    assert.equal(access.patient.name, 'Synthetic Report Patient');
    await fail(txRun((tx) => authorizeDashboardReport(tx, db, actor, hrid, 'rpt-h2', ['doctor'], true)), 'permission-denied');
    await db.collection('dashboardPatients').doc(hrid).update({ aiProcessingConsent: false });
    await fail(txRun((tx) => authorizeDashboardReport(tx, db, actor, hrid, 'rpt-h1', ['doctor'], true)), 'permission-denied');
    await fail(txRun((tx) => authorizeDashboardReport(tx, db, actor, hrid, 'rpt-h1', ['lab'], false)), 'permission-denied');
  } finally {
    await app.delete();
  }
});
