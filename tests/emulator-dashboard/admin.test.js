const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const { createDashboardUser } = require('../../functions/dashboard-provisioning');
const {
  createDashboardHospital, listDashboardHospitals, setDashboardHospitalStatus, listDashboardAudit,
} = require('../../functions/dashboard-admin');

test('hospital management, cascading deactivation, and scoped audit', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'admin-test');
  const db = app.firestore(), auth = app.auth();
  let sysUid;
  const reject = (promise, c) => assert.rejects(promise, (e) => e.code === c);
  try {
    const sysUser = await auth.createUser({ email: 'sys-admin@example.test' });
    await auth.setCustomUserClaims(sysUser.uid, { role: 'SYSTEM_ADMIN' });
    sysUid = sysUser.uid;
    await db.collection('dashboardUsers').doc(sysUser.uid).set({ role: 'SYSTEM_ADMIN', status: 'active' });
    const sys = (data) => ({ auth: { uid: sysUser.uid, token: { role: 'SYSTEM_ADMIN' } }, data });
    const hospital = { name: 'North', code: 'North-1', licenseNo: 'L1', phone: '1', address: 'A', city: 'C', country: 'X' };

    await reject(createDashboardHospital({ data: hospital }, db), 'unauthenticated');
    const { id } = await createDashboardHospital(sys(hospital), db);
    assert.equal(id, 'north-1');
    await reject(createDashboardHospital(sys(hospital), db), 'already-exists');
    await reject(createDashboardHospital(sys({ ...hospital, code: 'Bad Code' }), db), 'invalid-argument');
    await reject(createDashboardHospital(sys({ ...hospital, extra: 'x' }), db), 'invalid-argument');
    await createDashboardHospital(sys({ ...hospital, name: 'South', code: 'south' }), db);

    const ha = await createDashboardUser(sys({ email: 'ha-n@example.test', name: 'HA', role: 'HOSPITAL_ADMIN', hospitalId: 'north-1' }), db, auth);
    const haReq = (data) => ({ auth: { uid: ha.uid, token: { role: 'HOSPITAL_ADMIN', hospitalId: 'north-1' } }, data });
    const nurse = await createDashboardUser(haReq({ email: 'n@example.test', name: 'N', role: 'NURSE', hospitalId: 'north-1' }), db, auth);

    assert.equal((await listDashboardHospitals(sys(), db)).length, 2);
    assert.deepEqual((await listDashboardHospitals(haReq(), db)).map((h) => h.id), ['north-1']);
    await reject(setDashboardHospitalStatus(haReq({ id: 'north-1', status: 'inactive' }), db, auth), 'permission-denied');
    await reject(createDashboardHospital(haReq(hospital), db), 'permission-denied');

    const off = await setDashboardHospitalStatus(sys({ id: 'north-1', status: 'inactive' }), db, auth);
    assert.equal(off.usersAffected, 2);
    assert.equal((await auth.getUser(nurse.uid)).disabled, true);
    await reject(listDashboardHospitals(haReq(), db), 'permission-denied');
    await reject(createDashboardUser(sys({ email: 'late@example.test', name: 'L', role: 'HOSPITAL_ADMIN', hospitalId: 'north-1' }), db, auth), 'invalid-argument');

    await setDashboardHospitalStatus(sys({ id: 'north-1', status: 'active' }), db, auth);
    assert.equal((await auth.getUser(ha.uid)).disabled, false);
    assert.equal((await auth.getUser(nurse.uid)).disabled, true);

    const global = await listDashboardAudit(sys(), db);
    assert.ok(global.some((e) => e.action === 'hospital_created'));
    const own = await listDashboardAudit(haReq(), db);
    assert.ok(own.length > 0 && own.every((e) => e.hospitalId === 'north-1'));
    await reject(listDashboardAudit({ auth: { uid: nurse.uid, token: { role: 'NURSE', hospitalId: 'north-1' } }, data: {} }, db), 'permission-denied');
  } finally {
    // The shared emulator must not keep a System Admin: the bootstrap test requires none.
    if (sysUid) await db.collection('dashboardUsers').doc(sysUid).delete();
    await app.delete();
  }
});
