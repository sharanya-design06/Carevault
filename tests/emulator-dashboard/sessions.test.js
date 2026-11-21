const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const { revokeMySessions, recordDevice } = require('../../functions/dashboard-sessions');
const { getDashboardIdentity } = require('../../functions/dashboard-registration');
const { resolveDashboardIdentity } = require('../../functions/dashboard-identity');

test('sign-out revokes sessions server-side and new browsers are audited once', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'sessions-test');
  const db = app.firestore(), auth = app.auth();
  const reject = (promise, c) => assert.rejects(promise, (e) => e.code === c);
  try {
    await db.collection('dashboardHospitals').doc('sA').set({ status: 'active' });
    const user = await auth.createUser({ email: 'sessions.pcc@example.test' });
    await db.collection('dashboardUsers').doc(user.uid).set({ status: 'active', role: 'PCC', hospitalId: 'sA' });
    const request = (data, authTime) => ({ auth: { uid: user.uid, token: { role: 'PCC', hospitalId: 'sA', auth_time: authTime } }, data });
    const nowSeconds = Math.floor(Date.now() / 1000);

    await reject(revokeMySessions({ data: {} }, db, auth), 'unauthenticated');
    assert.equal((await getDashboardIdentity(request({}, nowSeconds - 5), db)).role, 'PCC');

    // Devices: only a valid id is recorded, a repeat is not "new", and a different browser is.
    const deviceA = 'a'.repeat(32), deviceB = 'b'.repeat(32);
    assert.equal((await getDashboardIdentity(request({ deviceId: 'not-a-device-id' }, nowSeconds), db)).newDevice, undefined);
    assert.equal((await getDashboardIdentity(request({ deviceId: deviceA }, nowSeconds), db)).newDevice, true);
    assert.equal((await getDashboardIdentity(request({ deviceId: deviceA }, nowSeconds), db)).newDevice, undefined);
    assert.equal((await recordDevice(db, { uid: user.uid, role: 'PCC', hospitalId: 'sA' }, deviceB)).newDevice, true);
    const devices = await db.collection('dashboardDevices').where('uid', '==', user.uid).get();
    assert.equal(devices.size, 2);
    assert.ok(devices.docs.every((d) => !JSON.stringify(d.data()).includes(deviceA)), 'only a hash of the browser id is stored');
    const newDeviceAudits = (await db.collection('dashboardAudit').where('action', '==', 'new_device_sign_in').where('actorUid', '==', user.uid).get()).size;
    assert.equal(newDeviceAudits, 2);

    // Revocation: older tokens are refused straight away, a fresh sign-in works.
    const before = nowSeconds - 120;
    assert.deepEqual(await revokeMySessions(request({}, before), db, auth), { revoked: true });
    assert.ok((await db.collection('dashboardUsers').doc(user.uid).get()).get('sessionsValidAfter'));
    const tx = (fn) => db.runTransaction(fn);
    await reject(tx((t) => resolveDashboardIdentity(request({}, before), db, t)), 'unauthenticated');
    assert.equal((await tx((t) => resolveDashboardIdentity(request({}, Math.floor(Date.now() / 1000) + 1), db, t))).role, 'PCC');
    assert.equal((await db.collection('dashboardAudit').where('action', '==', 'sessions_revoked').where('actorUid', '==', user.uid).get()).size, 1);
    assert.ok((await auth.getUser(user.uid)).tokensValidAfterTime, 'refresh tokens are revoked in Firebase Auth too');
  } finally { await app.delete(); }
});
