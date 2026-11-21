const test = require('node:test');
const assert = require('node:assert/strict');
const { linkSecureReportAccount } = require('../scripts/provision-secure-report');

function fakeAdmin(existing = {}) {
  const docs = new Map(Object.entries(existing)), users = { 'a@x.test': { uid: 'uid-a' }, 'p@x.test': { uid: 'uid-p' } };
  let passwordTouched = false;
  return {
    docs, passwordTouched: () => passwordTouched,
    auth: () => ({
      getUserByEmail: async (email) => { if (!users[email]) throw Object.assign(new Error('no user'), { code: 'auth/user-not-found' }); return users[email]; },
      updateUser: async () => { passwordTouched = true; }, createUser: async () => { passwordTouched = true; },
    }),
    firestore: () => ({ doc: (path) => ({
      set: async (value, options) => { docs.set(path, options && options.merge ? { ...docs.get(path), ...value } : value); },
      get: async () => ({ data: () => docs.get(path) }),
    }) }),
  };
}

test('linking a doctor adds access and care records without touching the account', async () => {
  const admin = fakeAdmin();
  await linkSecureReportAccount(admin, { email: 'a@x.test', role: 'doctor', hospitalId: 'hos_1', patientIds: ['HDW-20261106-JSZE4X3N'] });
  assert.equal(admin.docs.get('secureReportUsers/uid-a').role, 'doctor');
  assert.equal(admin.docs.get('secureReportCare/uid-a/patients/HDW-20261106-JSZE4X3N').hospitalId, 'hos_1');
  assert.equal(admin.passwordTouched(), false);
});

test('linking a patient keeps an existing consent choice and defaults new ones to off', async () => {
  const fresh = fakeAdmin();
  await linkSecureReportAccount(fresh, { email: 'p@x.test', role: 'patient', patientId: 'HDW-1' });
  assert.equal(fresh.docs.get('secureReportPatients/HDW-1').aiProcessingConsent, false);
  assert.equal(fresh.docs.get('secureReportPatients/HDW-1').authUid, 'uid-p');
  const existing = fakeAdmin({ 'secureReportPatients/HDW-1': { aiProcessingConsent: true, shareWithOtherHospitals: true } });
  await linkSecureReportAccount(existing, { email: 'p@x.test', role: 'patient', patientId: 'HDW-1' });
  assert.equal(existing.docs.get('secureReportPatients/HDW-1').aiProcessingConsent, true);
  assert.equal(existing.docs.get('secureReportPatients/HDW-1').shareWithOtherHospitals, true);
});

test('invalid roles, identifiers and unknown accounts are rejected', async () => {
  const admin = fakeAdmin();
  await assert.rejects(linkSecureReportAccount(admin, { email: 'a@x.test', role: 'admin' }), /Role must be/);
  await assert.rejects(linkSecureReportAccount(admin, { email: 'a@x.test', role: 'doctor', hospitalId: 'bad id', patientIds: ['x'] }), /hospitalId/);
  await assert.rejects(linkSecureReportAccount(admin, { email: 'p@x.test', role: 'patient', patientId: '../x' }), /patientId/);
  await assert.rejects(linkSecureReportAccount(admin, { email: 'nobody@x.test', role: 'patient', patientId: 'HDW-1' }), /no user/);
  assert.equal(admin.docs.size, 0);
});
