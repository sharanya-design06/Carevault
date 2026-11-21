const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const { createPatientAccount, setPatientSharing, getMySharing } = require('../../functions/dashboard-patients');
const { sendDashboardInvite } = require('../../functions/dashboard-provisioning');
const { getDashboardPatient, getPatientNotifications } = require('../../functions/dashboard-registration');
const { listClinicalRecords } = require('../../functions/dashboard-clinical');

test('patient account creation, own-record access and sharing control', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'patient-account-test');
  const db = app.firestore(), auth = app.auth();
  const hrid = 'HDW-20260101-PATA0001', other = 'HDW-20260101-PATA0002';
  const pcc = (data, hospitalId = 'pA') => ({ auth: { uid: 'pcc' + hospitalId, token: { role: 'PCC', hospitalId } }, data });
  const reject = (promise, c) => assert.rejects(promise, (e) => e.code === c);
  try {
    for (const id of ['pA', 'pB']) {
      await db.collection('dashboardHospitals').doc(id).set({ status: 'active' });
      await db.collection('dashboardUsers').doc('pcc' + id).set({ status: 'active', role: 'PCC', hospitalId: id });
    }
    for (const id of [hrid, other]) {
      await db.collection('dashboardPatients').doc(id).set({ hrid: id, name: 'Fictional', dob: '2000-01-02', gender: 'Other', hospitalId: 'pA', status: 'active', authUid: null, shareWithOtherHospitals: false });
    }
    await reject(createPatientAccount({ data: { hrid, email: 'p@example.test' } }, db, auth), 'unauthenticated');
    await reject(createPatientAccount(pcc({ hrid, email: 'p@example.test' }, 'pB'), db, auth), 'permission-denied');
    await reject(createPatientAccount(pcc({ hrid, email: 'bad' }), db, auth), 'invalid-argument');
    const { uid } = await createPatientAccount(pcc({ hrid, email: 'P@Example.test' }), db, auth);
    assert.deepEqual((await auth.getUser(uid)).customClaims, { role: 'PATIENT', patientId: hrid });
    await reject(createPatientAccount(pcc({ hrid, email: 'again@example.test' }), db, auth), 'already-exists');
    await reject(createPatientAccount(pcc({ hrid: other, email: 'p@example.test' }), db, auth), 'already-exists');
    assert.equal((await auth.getUserByEmail('again@example.test').catch(() => null)), null);

    const sent = [];
    await sendDashboardInvite(pcc({ uid }), db, auth, async (m) => { sent.push(m); });
    assert.equal(sent[0].to, 'p@example.test');
    await reject(sendDashboardInvite(pcc({ uid }, 'pB'), db, auth, async () => {}), 'permission-denied');

    const me = (data) => ({ auth: { uid, token: { role: 'PATIENT', patientId: hrid } }, data });
    assert.equal((await getDashboardPatient(me({ hrid }), db)).hrid, hrid);
    await reject(getDashboardPatient(me({ hrid: other }), db), 'permission-denied');
    assert.deepEqual(await listClinicalRecords(me({ hrid }), db), []);
    assert.deepEqual(await getPatientNotifications(me(), db), []);

    assert.deepEqual(await getMySharing(me(), db), { share: false });
    await setPatientSharing(me({ share: true }), db);
    assert.deepEqual(await getMySharing(me(), db), { share: true });
    await reject(setPatientSharing(me({ share: 'yes' }), db), 'invalid-argument');
    await reject(setPatientSharing(pcc({ share: true }), db), 'permission-denied');
    assert.ok((await db.collection('dashboardAudit').where('patientId', '==', hrid).get()).docs.some((d) => d.get('action') === 'sharing_changed'));
  } finally {
    await app.delete();
  }
});
