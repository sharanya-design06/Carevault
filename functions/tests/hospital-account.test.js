const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHospitalHandler } = require('../hospital-account');

const details = { name: 'Test Hospital', adminName: 'Test Administrator', email: 'admin@example.test', code: 'TEST' };
const request = (data = details) => ({ auth: { uid: 'system-admin', token: { role: 'SYSTEM_ADMIN' } }, data });

function fixture() {
  const documents = new Map();
  const users = new Map();
  const emails = [];
  const errors = [];
  const auth = {
    async getUser() { return { disabled: false, customClaims: { role: 'SYSTEM_ADMIN' } }; },
    async getUserByEmail(email) {
      if (!users.has(email)) throw Object.assign(new Error('Missing user'), { code: 'auth/user-not-found' });
      return users.get(email);
    },
    async createUser(data) {
      if (users.has(data.email)) {
        throw Object.assign(new Error('Existing user'), { code: 'auth/email-already-exists' });
      }
      users.set(data.email, { ...data, disabled: false });
      return users.get(data.email);
    },
    async setCustomUserClaims(uid, claims) {
      const user = [...users.values()].find((entry) => entry.uid === uid);
      user.customClaims = claims;
    },
    async generatePasswordResetLink() { return 'https://example.test/firebase-password-action'; },
  };
  const db = {
    doc(path) {
      return {
        async get() {
          return { exists: documents.has(path), data: () => documents.get(path), get: (field) => documents.get(path)?.[field] };
        },
        async set(value) { documents.set(path, structuredClone(value)); },
      };
    },
  };
  const sendInvitation = async (hospital, link) => { emails.push({ hospital, link }); };
  const logger = { error: (...args) => errors.push(args) };
  return { documents, users, emails, errors, auth, db, sendInvitation, logger };
}

test('rejects anonymous and non-system-admin callers before creating accounts', async () => {
  const state = fixture();
  const handler = createHospitalHandler(state);
  await assert.rejects(handler({ data: details }), { code: 'unauthenticated' });
  await assert.rejects(handler({ auth: { uid: 'staff', token: { role: 'DOCTOR' } }, data: details }), { code: 'permission-denied' });
  assert.equal(state.users.size, 0);
});

test('rejects disabled or demoted System Admins even with an older token', async () => {
  const state = fixture();
  state.auth.getUser = async () => ({ disabled: false, customClaims: { role: 'DOCTOR' } });
  await assert.rejects(createHospitalHandler(state)(request()), { code: 'permission-denied' });
  state.auth.getUser = async () => ({ disabled: true, customClaims: { role: 'SYSTEM_ADMIN' } });
  await assert.rejects(createHospitalHandler(state)(request()), { code: 'permission-denied' });
  assert.equal(state.users.size, 0);
});

test('creates a Firebase hospital account with server-selected claims and sends a Firebase action link', async () => {
  const state = fixture();
  const handler = createHospitalHandler(state);
  const { hospital } = await handler(request({ ...details, email: ' ADMIN@example.test ', role: 'SYSTEM_ADMIN', password: 'ignored' }));
  const user = state.users.get(details.email);
  assert.equal(user.customClaims.role, 'HOSPITAL_ADMIN');
  assert.equal(user.customClaims.hospitalId, hospital.id);
  assert.equal(user.password, undefined);
  assert.equal(hospital.password, undefined);
  assert.equal(hospital.invite, null);
  assert.equal(state.emails.length, 1);
  assert.equal(state.emails[0].link, 'https://example.test/firebase-password-action');
  assert.equal(state.documents.get('hospitalAccounts/' + hospital.id).invitationStatus, 'sent');
  const retry = await handler(request());
  assert.equal(retry.hospital.id, hospital.id);
  assert.equal(state.users.size, 1);
});

test('repairs a legacy hospital without changing its ID or creating a second account on retry', async () => {
  const state = fixture();
  state.documents.set('carevault/hospitals', { json: JSON.stringify([{ ...details, id: 'hos_legacy', createdAt: '2026-01-01' }]) });
  const handler = createHospitalHandler(state);
  const first = await handler(request({ ...details, id: 'hos_legacy' }));
  const retry = await handler(request({ ...details, id: 'hos_legacy' }));
  assert.equal(first.hospital.id, 'hos_legacy');
  assert.equal(retry.hospital.id, 'hos_legacy');
  assert.equal(first.hospital.createdAt, '2026-01-01');
  assert.equal(state.users.size, 1);
});

test('concurrent requests do not create multiple hospital administrators', async () => {
  const state = fixture();
  const handler = createHospitalHandler(state);
  const results = await Promise.all([handler(request()), handler(request())]);
  assert.equal(results[0].hospital.id, results[1].hospital.id);
  assert.equal(state.users.size, 1);
});

test('does not reactivate an inactive legacy hospital', async () => {
  const state = fixture();
  state.documents.set('carevault/hospitals', {
    json: JSON.stringify([{ ...details, id: 'hos_legacy', status: 'inactive' }]),
  });
  await assert.rejects(createHospitalHandler(state)(request()), { code: 'failed-precondition' });
  assert.equal(state.users.size, 0);
});

test('does not take over existing Firebase users or change their claims', async () => {
  const state = fixture();
  state.users.set(details.email, { uid: 'existing-user', customClaims: { role: 'DOCTOR', hospitalId: 'another-hospital' } });
  await assert.rejects(createHospitalHandler(state)(request()), { code: 'failed-precondition' });
  assert.equal(state.users.get(details.email).customClaims.role, 'DOCTOR');
  assert.equal(state.documents.size, 0);
  assert.equal(state.emails.length, 0);
});

test('reports email failure and allows retry without duplicate accounts', async () => {
  const state = fixture();
  const handler = createHospitalHandler({ ...state, sendInvitation: async () => { throw new Error('SMTP unavailable'); } });
  await assert.rejects(handler(request()), { code: 'unavailable' });
  assert.equal(state.users.size, 1);
  assert.equal([...state.documents.values()][0].invitationStatus, 'pending');
  assert.equal(state.errors.length, 1);
  await createHospitalHandler(state)(request());
  assert.equal(state.users.size, 1);
  assert.equal([...state.documents.values()][0].invitationStatus, 'sent');
});

test('invalid input and mismatched hospital IDs cannot create accounts', async () => {
  const state = fixture();
  const handler = createHospitalHandler(state);
  await assert.rejects(handler(request({ ...details, email: 'invalid' })), { code: 'invalid-argument' });
  await assert.rejects(handler(request({ ...details, id: 'unknown' })), { code: 'not-found' });
  state.documents.set('carevault/hospitals', { json: JSON.stringify([{ ...details, id: 'hos_legacy' }]) });
  await assert.rejects(handler(request({ ...details, id: 'different' })), { code: 'failed-precondition' });
  await assert.rejects(handler(request({ ...details, email: 'another@example.test' })), { code: 'already-exists' });
  assert.equal(state.users.size, 0);
});
