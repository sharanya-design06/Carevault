const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const { bootstrapSystemAdmin } = require('../../scripts/bootstrap-admin');
const { createDashboardUser, setDashboardUserStatus, sendDashboardInvite, lookupLoginEmail, listDashboardUsers } = require('../../functions/dashboard-provisioning');

test('bootstrap, scoped provisioning, and deactivation', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'provisioning-test');
  const db = app.firestore(), auth = app.auth();
  const as = (uid, claims, data) => ({ auth: { uid, token: claims }, data });
  const code = (error) => error.code;
  try {
    const { uid: sys } = await bootstrapSystemAdmin(app, 'Admin@Example.test', 'Synthetic Admin');
    await assert.rejects(bootstrapSystemAdmin(app, 'second@example.test', 'Second'), /already exists/);
    assert.deepEqual((await auth.getUser(sys)).customClaims, { role: 'SYSTEM_ADMIN' });
    await db.collection('dashboardHospitals').doc('h1').set({ status: 'active' });
    await db.collection('dashboardHospitals').doc('h2').set({ status: 'active' });
    const sysReq = (data) => as(sys, { role: 'SYSTEM_ADMIN' }, data);

    const ha = await createDashboardUser(sysReq({
      email: 'ha1@example.test', name: 'HA One', role: 'HOSPITAL_ADMIN', hospitalId: 'h1' }), db, auth);
    const haReq = (data) => as(ha.uid, { role: 'HOSPITAL_ADMIN', hospitalId: 'h1' }, data);
    const doc = await createDashboardUser(haReq({
      email: 'doc@example.test', username: 'dr.doc', name: 'Doc', role: 'DOCTOR', subType: 'SPECIALIST', hospitalId: 'h1' }), db, auth);
    assert.deepEqual((await auth.getUser(doc.uid)).customClaims,
      { role: 'DOCTOR', subType: 'SPECIALIST', hospitalId: 'h1' });

    const reject = (promise, c) => assert.rejects(promise, (e) => code(e) === c);
    await reject(createDashboardUser(haReq({ email: 'x@example.test', name: 'X', role: 'SYSTEM_ADMIN' }), db, auth), 'permission-denied');
    await reject(createDashboardUser(haReq({ email: 'x@example.test', name: 'X', role: 'HOSPITAL_ADMIN', hospitalId: 'h1' }), db, auth), 'permission-denied');
    await reject(createDashboardUser(haReq({ email: 'x@example.test', name: 'X', role: 'NURSE', hospitalId: 'h2' }), db, auth), 'permission-denied');
    await reject(createDashboardUser(haReq({ email: 'x@example.test', name: 'X', role: 'DOCTOR', hospitalId: 'h1' }), db, auth), 'invalid-argument');
    await reject(createDashboardUser(haReq({ email: 'doc@example.test', name: 'D', role: 'NURSE', hospitalId: 'h1' }), db, auth), 'already-exists');
    await reject(createDashboardUser(as(doc.uid, { role: 'DOCTOR', subType: 'SPECIALIST', hospitalId: 'h1' },
      { email: 'y@example.test', name: 'Y', role: 'NURSE', hospitalId: 'h1' }), db, auth), 'permission-denied');
    await reject(createDashboardUser({ data: {} }, db, auth), 'unauthenticated');
    await reject(createDashboardUser(haReq({ email: 'z@example.test', username: 'dr.doc', name: 'Z', role: 'NURSE', hospitalId: 'h1' }), db, auth), 'already-exists');
    await reject(createDashboardUser(haReq({ email: 'z@example.test', username: 'Bad Name', name: 'Z', role: 'NURSE', hospitalId: 'h1' }), db, auth), 'invalid-argument');
    assert.equal((await auth.getUserByEmail('z@example.test').catch(() => null)), null);

    const lookup = (identifier, ip = '198.51.100.10') =>
      lookupLoginEmail({ data: { identifier }, rawRequest: { ip } }, db);
    assert.deepEqual(await lookup('DR.DOC'), { email: 'doc@example.test' });
    assert.deepEqual(await lookupLoginEmail({ data: { identifier: 'a@b.test' } }, db), { email: 'a@b.test' });
    assert.match((await lookup('nobody')).email, /@unknown\.invalid$/);
    for (let i = 0; i < 8; i++) await lookup('unknown-' + i);
    await assert.rejects(lookup('blocked'), (error) => error.code === 'resource-exhausted');
    assert.match((await lookup('dr.doc', '198.51.100.11')).email, /@example\.test$/);
    await assert.rejects(lookupLoginEmail({ data: { identifier: 'missing-ip' } }, db),
      (error) => error.code === 'unavailable');

    const sent = [];
    const mail = async (m) => { sent.push(m); };
    await sendDashboardInvite(haReq({ uid: doc.uid }), db, auth, mail);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'doc@example.test');
    assert.match(sent[0].text, /https:\/\/care-vault-project\.web\.app\/set-password\/\?token=[^\s&]+/);
    await reject(sendDashboardInvite(haReq({ uid: sys }), db, auth, mail), 'permission-denied');
    await reject(sendDashboardInvite(haReq({ uid: doc.uid }), db, auth, async () => { throw new Error('smtp'); }), 'unavailable');
    assert.equal(sent.length, 1);

    await reject(setDashboardUserStatus(haReq({ uid: ha.uid, status: 'inactive' }), db, auth), 'permission-denied');
    const ha2 = await createDashboardUser(sysReq({
      email: 'ha2@example.test', name: 'HA Two', role: 'HOSPITAL_ADMIN', hospitalId: 'h2' }), db, auth);
    const other = await createDashboardUser(as(ha2.uid, { role: 'HOSPITAL_ADMIN', hospitalId: 'h2' }, {
      email: 'n2@example.test', name: 'N2', role: 'NURSE', hospitalId: 'h2' }), db, auth);
    await reject(setDashboardUserStatus(haReq({ uid: other.uid, status: 'inactive' }), db, auth), 'permission-denied');

    const listed = await listDashboardUsers(haReq({}), db);
    assert.deepEqual(listed.map((u) => u.email), ['doc@example.test']);
    assert.equal((await listDashboardUsers(sysReq({}), db)).every((u) => ['SYSTEM_ADMIN', 'HOSPITAL_ADMIN'].includes(u.role)), true);
    await reject(listDashboardUsers(as(doc.uid, { role: 'DOCTOR', subType: 'SPECIALIST', hospitalId: 'h1' }, {}), db), 'permission-denied');

    await setDashboardUserStatus(haReq({ uid: doc.uid, status: 'inactive' }), db, auth);
    assert.equal((await auth.getUser(doc.uid)).disabled, true);
    assert.equal((await db.collection('dashboardUsers').doc(doc.uid).get()).get('status'), 'inactive');
    await setDashboardUserStatus(haReq({ uid: doc.uid, status: 'active' }), db, auth);
    assert.equal((await auth.getUser(doc.uid)).disabled, false);
  } finally {
    await app.delete();
  }
});
