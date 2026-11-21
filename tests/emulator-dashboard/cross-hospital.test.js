const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const {
  requestCrossHospitalAccess, getDashboardPatient, getPatientNotifications,
} = require('../../functions/dashboard-registration');

test('reasoned cross-hospital access is audited, notified, scoped and expires', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'cross-hospital-test');
  const db = app.firestore();
  const hrid = 'HDW-20260101-ABCD1234', other = 'HDW-20260101-ZZZZ9999';
  const as = (uid, token, data) => ({ auth: { uid, token }, data });
  const doctorToken = { role: 'DOCTOR', subType: 'SPECIALIST', hospitalId: 'hB' };
  const doctor = (data) => as('docB', doctorToken, data);
  const reject = (promise, code) => assert.rejects(promise, (e) => e.code === code);
  try {
    for (const id of ['hA', 'hB']) await db.collection('dashboardHospitals').doc(id).set({ status: 'active' });
    await db.collection('dashboardUsers').doc('docB').set({ status: 'active', ...doctorToken });
    await db.collection('dashboardUsers').doc('docA').set({ status: 'active', ...doctorToken, hospitalId: 'hA' });
    await db.collection('dashboardUsers').doc('patA').set({ status: 'active', role: 'PATIENT', patientId: hrid });
    for (const id of [hrid, other]) {
      await db.collection('dashboardPatients').doc(id).set({
        hrid: id, name: 'Fictional', dob: '2000-01-02', gender: 'Other', hospitalId: 'hA',
        status: 'active', shareWithOtherHospitals: false, authUid: id === hrid ? 'patA' : null,
      });
    }
    await reject(getDashboardPatient(doctor({ hrid }), db), 'permission-denied');
    await reject(requestCrossHospitalAccess(doctor({ hrid, reason: 'short' }), db), 'invalid-argument');
    await reject(requestCrossHospitalAccess(as('docA', { ...doctorToken, hospitalId: 'hA' },
      { hrid, reason: 'Same hospital needs no reason.' }), db), 'permission-denied');
    await reject(requestCrossHospitalAccess({ data: { hrid } }, db), 'unauthenticated');

    const grant = await requestCrossHospitalAccess(doctor({ hrid, reason: 'Referred for a specialist opinion.' }), db);
    assert.ok(grant.expiresAt > Date.now() && grant.expiresAt <= Date.now() + 24 * 3600e3);
    assert.equal((await getDashboardPatient(doctor({ hrid }), db)).hrid, hrid);
    await reject(getDashboardPatient(doctor({ hrid: other }), db), 'permission-denied');

    const audit = await db.collection('dashboardAudit').where('patientId', '==', hrid).get();
    const granted = audit.docs.map((d) => d.data()).find((d) => d.action === 'cross_hospital_access_granted');
    assert.equal(granted.reason, 'Referred for a specialist opinion.');
    assert.equal(granted.hospitalId, 'hB');
    assert.equal(audit.docs.some((d) => d.data().accessScope === 'reasoned'), true);

    const notices = (await getPatientNotifications(as('patA', { role: 'PATIENT', patientId: hrid }, {}), db));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].viewingHospitalId, 'hB');
    await reject(getPatientNotifications(doctor({}), db), 'permission-denied');

    await db.collection('dashboardAccessGrants').doc('docB_' + hrid).update({
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000) });
    await reject(getDashboardPatient(doctor({ hrid }), db), 'permission-denied');
  } finally {
    await app.delete();
  }
});

test('notification emails are attempted after the grant and failures do not block access', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'cross-hospital-email-test');
  const db = app.firestore();
  const hrid = 'HDW-20260101-EMAIL123', noEmailHrid = 'HDW-20260101-NOEMAIL1';
  const token = { role: 'DOCTOR', subType: 'SPECIALIST', hospitalId: 'email-hB' };
  const request = (id) => ({ auth: { uid: 'email-doc', token }, data: { hrid: id, reason: 'Referral for specialist review.' } });
  try {
    for (const id of ['email-hA', 'email-hB']) await db.collection('dashboardHospitals').doc(id).set({ status: 'active' });
    await db.collection('dashboardUsers').doc('email-doc').set({ ...token, status: 'active' });
    await db.collection('dashboardPatients').doc(hrid).set({
      hrid, name: 'Synthetic Patient', hospitalId: 'email-hA', status: 'active', email: 'patient@example.test',
    });
    await db.collection('dashboardPatients').doc(noEmailHrid).set({
      hrid: noEmailHrid, name: 'Synthetic Patient Two', hospitalId: 'email-hA', status: 'active',
    });

    const sent = [];
    const grant = await requestCrossHospitalAccess(request(hrid), db, async (message) => { sent.push(message); });
    assert.ok(grant.expiresAt > Date.now());
    assert.equal(sent[0].to, 'patient@example.test');
    assert.match(sent[0].text, /Referral for specialist review/);
    assert.equal((await db.collection('dashboardNotifications').where('patientId', '==', hrid).get()).docs[0].get('emailStatus'), 'sent');

    const failure = await requestCrossHospitalAccess(request(hrid), db, async () => { throw new Error('SMTP unavailable'); });
    assert.ok(failure.expiresAt > Date.now());
    const notifications = await db.collection('dashboardNotifications').where('patientId', '==', hrid).get();
    assert.ok(notifications.docs.some((doc) => doc.get('emailStatus') === 'failed'));
    assert.ok((await db.collection('dashboardAccessGrants').doc('email-doc_' + hrid).get()).exists);

    let unexpectedlySent = false;
    await requestCrossHospitalAccess(request(noEmailHrid), db, async () => { unexpectedlySent = true; });
    assert.equal(unexpectedlySent, false);
    const noEmail = await db.collection('dashboardNotifications').where('patientId', '==', noEmailHrid).get();
    assert.equal(noEmail.docs[0].get('emailStatus'), 'no_email');
  } finally {
    await app.delete();
  }
});
