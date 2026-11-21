const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDashboardIdentity } = require('../functions/dashboard-identity');

function harness(user) {
  const db = { collection: (name) => ({ doc: (uid) => ({ name, uid }) }) };
  const tx = {
    async get(ref) {
      assert.equal(ref.name, 'dashboardUsers');
      assert.equal(ref.uid, 'user1');
      return { exists: !!user, data: () => user };
    },
  };
  const request = (token, data = {}) => ({ auth: { uid: 'user1', token }, data });
  return { db, tx, request, resolve: (req) => resolveDashboardIdentity(req, db, tx) };
}

const denies = (promise, code = 'permission-denied') =>
  assert.rejects(promise, (error) => error.code === code);

test('all eight provisioned roles resolve only their server-controlled identity', async () => {
  for (const role of ['SYSTEM_ADMIN', 'HOSPITAL_ADMIN', 'PCC', 'DOCTOR', 'LAB', 'PHARMACIST', 'NURSE', 'PATIENT']) {
    const user = { status: 'active', role };
    const token = { role };
    if (!['SYSTEM_ADMIN', 'PATIENT'].includes(role)) user.hospitalId = token.hospitalId = 'hospital1';
    if (role === 'DOCTOR') user.subType = token.subType = 'SURGEON';
    if (role === 'LAB') user.subType = token.subType = 'RADIOLOGY';
    if (role === 'PATIENT') user.patientId = token.patientId = 'patient1';
    const h = harness(user);
    const result = await h.resolve(h.request(token, { role: 'SYSTEM_ADMIN', hospitalId: 'other' }));
    assert.equal(result.uid, 'user1');
    assert.equal(result.role, role);
    assert.equal(result.hospitalId, user.hospitalId);
    assert.equal(result.subType, user.subType);
    assert.equal(result.patientId, user.patientId);
  }
});

test('missing authentication, absent users and inactive accounts are rejected', async () => {
  const h = harness({ status: 'active', role: 'SYSTEM_ADMIN' });
  await denies(h.resolve({}), 'unauthenticated');
  await denies(harness(null).resolve(h.request({ role: 'SYSTEM_ADMIN' })));
  for (const status of ['inactive', 'suspended', 'pending', undefined]) {
    await denies(harness({ status, role: 'SYSTEM_ADMIN' }).resolve(h.request({ role: 'SYSTEM_ADMIN' })));
  }
});

test('stale or invalid role, hospital and specialty claims fail closed', async () => {
  const user = { status: 'active', role: 'DOCTOR', subType: 'SURGEON', hospitalId: 'hospital1' };
  const h = harness(user);
  for (const token of [
    { role: 'SYSTEM_ADMIN', subType: 'SURGEON', hospitalId: 'hospital1' },
    { role: 'DOCTOR', subType: 'SURGEON', hospitalId: 'hospital2' },
    { role: 'DOCTOR', subType: 'RADIOLOGIST', hospitalId: 'hospital1' },
    { role: 'DOCTOR', hospitalId: 'hospital1' },
  ]) await denies(h.resolve(h.request(token)));
  const bad = harness({ ...user, subType: 'MICROBIOLOGY' });
  await denies(bad.resolve(bad.request({ role: 'DOCTOR', subType: 'MICROBIOLOGY', hospitalId: 'hospital1' })));
});

test('invalid scopes and inconsistent patient or staff assignments are rejected', async () => {
  const cases = [
    [{ status: 'active', role: 'NURSE', hospitalId: '../other' }, { role: 'NURSE', hospitalId: '../other' }],
    [{ status: 'active', role: 'NURSE', hospitalId: 'hospital1', patientId: 'patient1' }, { role: 'NURSE', hospitalId: 'hospital1' }],
    [{ status: 'active', role: 'PATIENT' }, { role: 'PATIENT' }],
    [{ status: 'active', role: 'PATIENT', patientId: 'patient1', hospitalId: 'hospital1' }, { role: 'PATIENT', hospitalId: 'hospital1' }],
    [{ status: 'active', role: 'PATIENT', patientId: 'patient1' }, { role: 'PATIENT', patientId: 'patient2' }],
    [{ status: 'active', role: 'DOCTOR', hospitalId: 'hospital1' }, { role: 'DOCTOR', hospitalId: 'hospital1', patientId: 'patient1' }],
    [{ status: 'active', role: 'SYSTEM_ADMIN' }, { role: 'SYSTEM_ADMIN', subType: 'SURGEON' }],
    [{ status: 'active', role: 'OTHER' }, { role: 'OTHER' }],
  ];
  for (const [user, token] of cases) {
    const h = harness(user);
    await denies(h.resolve(h.request(token)));
  }
});

test('identity lookup failures propagate instead of granting access', async () => {
  const h = harness({ status: 'active', role: 'SYSTEM_ADMIN' });
  h.tx.get = async () => { throw new Error('database unavailable'); };
  await assert.rejects(h.resolve(h.request({ role: 'SYSTEM_ADMIN' })), /database unavailable/);
});

test('with REQUIRE_STAFF_MFA, staff need a second factor but patients and the enrolment step do not', async () => {
  process.env.REQUIRE_STAFF_MFA = 'true';
  try {
    const staff = { status: 'active', role: 'PCC', hospitalId: 'hospital1' };
    const h = harness(staff);
    const claims = { role: 'PCC', hospitalId: 'hospital1' };
    await denies(h.resolve(h.request(claims)), 'failed-precondition');
    await denies(h.resolve(h.request({ ...claims, firebase: { sign_in_provider: 'password' } })), 'failed-precondition');
    assert.equal((await h.resolve(h.request({ ...claims, firebase: { sign_in_second_factor: 'totp' } }))).role, 'PCC');
    assert.equal((await resolveDashboardIdentity(h.request(claims), h.db, h.tx, { allowWithoutMfa: true })).role, 'PCC');
    const admin = harness({ status: 'active', role: 'SYSTEM_ADMIN' });
    await denies(admin.resolve(admin.request({ role: 'SYSTEM_ADMIN' })), 'failed-precondition');
    const patient = harness({ status: 'active', role: 'PATIENT', patientId: 'p1' });
    assert.equal((await patient.resolve(patient.request({ role: 'PATIENT', patientId: 'p1' }))).role, 'PATIENT');
  } finally { delete process.env.REQUIRE_STAFF_MFA; }
});

test('tokens older than the maximum session age or issued before a revocation are refused', async () => {
  const { MAX_SESSION_MS } = require('../functions/dashboard-identity');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const staff = { status: 'active', role: 'PCC', hospitalId: 'h1' };
  const claims = (extra) => ({ role: 'PCC', hospitalId: 'h1', ...extra });
  let h = harness(staff);
  assert.equal((await h.resolve(h.request(claims({ auth_time: nowSeconds - 60 })))).role, 'PCC');
  assert.equal((await h.resolve(h.request(claims()))).role, 'PCC', 'tokens without auth_time are not session-checked');
  await denies(h.resolve(h.request(claims({ auth_time: nowSeconds - MAX_SESSION_MS.STAFF / 1000 - 60 }))), 'unauthenticated');

  const patient = { status: 'active', role: 'PATIENT', patientId: 'p1' };
  h = harness(patient);
  const pToken = (age) => ({ role: 'PATIENT', patientId: 'p1', auth_time: nowSeconds - age });
  assert.equal((await h.resolve(h.request(pToken(20 * 3600)))).role, 'PATIENT', 'patients get a longer session than staff');
  await denies(h.resolve(h.request(pToken(25 * 3600))), 'unauthenticated');

  const revokedAt = Date.now() - 10 * 60 * 1000;
  h = harness({ ...staff, sessionsValidAfter: { toMillis: () => revokedAt } });
  await denies(h.resolve(h.request(claims({ auth_time: Math.floor(revokedAt / 1000) - 5 }))), 'unauthenticated');
  assert.equal((await h.resolve(h.request(claims({ auth_time: Math.floor(revokedAt / 1000) + 5 })))).role, 'PCC', 'a new sign-in after the revocation works');
});
