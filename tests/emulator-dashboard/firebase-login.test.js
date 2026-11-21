const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const admin = require('../../functions/node_modules/firebase-admin');

test('main login and password reset work with Firebase and server-verified roles', async () => {
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:19099');
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:18080');
  const projectId = 'demo-carevault-isolated';
  const server = admin.initializeApp({ projectId }, 'browser-login-test');
  const authBase = 'http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1/accounts:';
  const functionsBase = 'http://127.0.0.1:15001/' + projectId + '/asia-south1/';
  const testFetch = (url, options) => {
    const identityBase = 'https://identitytoolkit.googleapis.com/v1/accounts:';
    const callableBase = 'https://asia-south1-' + projectId + '.cloudfunctions.net/';
    if (url.startsWith(identityBase)) return fetch(authBase + url.slice(identityBase.length), options);
    if (url.startsWith(callableBase)) return fetch(functionsBase + url.slice(callableBase.length), options);
    throw new Error('Unexpected non-emulator request');
  };
  const store = new Map(), listeners = {}, app = { innerHTML: '' };
  const location = { hash: '', href: '', replace(value) { this.href = value; } };
  const window = {
    CAREVAULT_REMOTE: { apiKey: 'emulator-key', projectId, firebaseLogin: true },
    addEventListener(type, handler) { listeners[type] = handler; },
  };
  const context = {
    window, location, fetch: testFetch, console,
    sessionStorage: {
      getItem: (key) => store.get(key) || null,
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
    document: { addEventListener(type, handler) { listeners[type] = handler; } },
    setTimeout() { return 1; }, clearTimeout() {}, URLSearchParams,
    FormData: class { constructor(form) { return Object.entries(form.values); } },
  };
  vm.runInNewContext(fs.readFileSync('public/assets/js/firebase-session.js', 'utf8'), context);
  const FS = window.FirebaseSession;
  window.UI = {
    $app: app, S: { ready() { throw new Error('Demo store must not be used'); } },
    esc: String, ROLE_HOME: { doctor: '/doctor/', patient: '/patient/' },
  };
  vm.runInNewContext(fs.readFileSync('public/assets/js/auth.js', 'utf8'), context);
  const submit = (type, values) => listeners.submit({
    preventDefault() {},
    target: { closest: () => ({ dataset: { form: type }, values, querySelector: () => ({ disabled: false }) }) },
  });
  const postAuth = async (method, body) => {
    const response = await fetch(authBase + method + '?key=emulator-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { ok: response.ok, body: await response.json() };
  };
  try {
    const db = server.firestore(), auth = server.auth();
    await db.collection('dashboardHospitals').doc('login-hospital').set({ status: 'active' });
    for (const user of [
      { uid: 'login-doctor', email: 'login-doctor@example.test', claims: { role: 'DOCTOR', subType: 'GENERAL_PRIMARY', hospitalId: 'login-hospital' } },
      { uid: 'login-patient', email: 'login-patient@example.test', claims: { role: 'PATIENT', patientId: 'login-patient-id' } },
      { uid: 'login-unprovisioned', email: 'login-unprovisioned@example.test' },
    ]) {
      await auth.createUser({ uid: user.uid, email: user.email, password: 'Synthetic-Password-1' });
      if (user.claims) {
        await auth.setCustomUserClaims(user.uid, user.claims);
        await db.collection('dashboardUsers').doc(user.uid).set({ ...user.claims, status: 'active' });
      }
    }

    await submit('login', { email: 'login-doctor@example.test', password: 'Synthetic-Password-1' });
    assert.equal(location.href, '/doctor/');
    assert.equal(FS.session().role, 'doctor');
    assert.equal((await FS.call('getDashboardIdentity')).uid, 'login-doctor');
    FS.logout();
    assert.equal(FS.session(), null);

    const patient = await FS.login('login-patient@example.test', 'Synthetic-Password-1');
    assert.equal(patient.role, 'patient');
    assert.equal(FS.session().hrid, 'login-patient-id');
    FS.logout();
    assert.equal((await FS.login('login-unprovisioned@example.test', 'Synthetic-Password-1')).ok, false);
    assert.equal((await FS.login('login-doctor@example.test', 'wrong-password')).ok, false);
    assert.equal(FS.session(), null);

    location.hash = '#/forgot-password';
    listeners.hashchange();
    await submit('forgot', { email: 'login-doctor@example.test' });
    assert.match(app.innerHTML, /Check your email/);
    const response = await fetch('http://127.0.0.1:19099/emulator/v1/projects/' + projectId + '/oobCodes');
    assert.equal(response.ok, true);
    const { oobCodes } = await response.json();
    const reset = oobCodes.find((code) => code.email === 'login-doctor@example.test' && code.requestType === 'PASSWORD_RESET');
    assert.ok(reset);
    assert.equal((await postAuth('resetPassword', { oobCode: reset.oobCode, newPassword: 'Synthetic-Password-2' })).ok, true);
    assert.equal((await FS.login('login-doctor@example.test', 'Synthetic-Password-1')).ok, false);
    assert.equal((await FS.login('login-doctor@example.test', 'Synthetic-Password-2')).role, 'doctor');
    FS.logout();
  } finally {
    await server.delete();
  }
});
