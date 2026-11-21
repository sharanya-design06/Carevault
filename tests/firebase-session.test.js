const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(flag, fetchImpl, initial = {}, extra = {}) {
  const store = { ...initial }, timers = new Map(), listeners = {};
  let nextTimer = 0;
  const window = { CAREVAULT_REMOTE: { apiKey: 'k', projectId: 'p', firebaseLogin: flag },
    addEventListener: (type, handler) => { listeners[type] = handler; } };
  vm.runInNewContext(fs.readFileSync('public/assets/js/firebase-session.js', 'utf8'), {
    window, fetch: fetchImpl, JSON, Date, Number, String, Promise, Error, encodeURIComponent,
    console: { warn() {} }, ...extra,
    setTimeout: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    sessionStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
  });
  return { FS: window.FirebaseSession, store, timers, listeners };
}
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('Firebase sign-in resolves username, creates a role session and is disabled unless flagged', async () => {
  assert.equal(load(false, null).FS.enabled, false);
  const calls = [];
  const { FS, store } = load(true, async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/lookupLoginEmail')) return reply(200, { result: { email: 'pcc@example.test' } });
    if (url.includes('signInWithPassword')) return reply(200, { idToken: 't1', expiresIn: '3600', email: 'pcc@example.test', displayName: 'Pat' });
    if (url.endsWith('/getDashboardIdentity')) return reply(200, { result: { uid: 'u1', role: 'PCC', hospitalId: 'h1' } });
    return reply(404, {});
  });
  assert.deepEqual({ ...await FS.login('Pat.Coord', 'pw') }, { ok: true, role: 'pcc' });
  assert.equal(JSON.parse(calls[0].init.body).data.identifier, 'Pat.Coord');
  assert.equal(calls[2].init.headers.Authorization, 'Bearer t1');
  const session = FS.session();
  assert.equal(session.role, 'pcc');
  assert.equal(session.hospitalId, 'h1');
  FS.logout();
  assert.equal(FS.session(), null);
  assert.equal(Object.keys(store).length, 0);
});

test('failed password and unprovisioned accounts cannot create a session', async () => {
  const run = async (identity) => {
    const { FS } = load(true, async (url) => {
      if (url.endsWith('/lookupLoginEmail')) return reply(200, { result: { email: 'x@example.test' } });
      if (url.includes('signInWithPassword')) return identity === 'badpw' ? reply(400, { error: { message: 'INVALID_PASSWORD' } }) : reply(200, { idToken: 't', expiresIn: '3600' });
      return reply(403, { error: { status: 'PERMISSION_DENIED', message: 'Dashboard access denied.' } });
    });

    const result = await FS.login('x', 'y');
    assert.equal(FS.session(), null);
    return result;
  };
  const a = await run('badpw'), b = await run('unprovisioned');
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  await assert.rejects(load(true, null).FS.call('getPccPatients'), /Signed out/);
});

test('dashboard guards use the Firebase session even when common.js loads first', () => {
  const app = {}, location = { replace(url) { this.target = url; } }, end = [];
  const window = { Store: { session: () => ({ role: 'sysadmin', name: 'Demo' }) } };
  const document = { getElementById: (id) => id === 'app' ? app : {} };
  vm.runInNewContext(fs.readFileSync('public/assets/js/common.js', 'utf8'), { window, document, location });
  window.FirebaseSession = {
    enabled: true, session: () => ({ role: 'doctor', name: 'Fictional', email: 'd@example.test' }),
    onEnd: (listener) => end.push(listener),
  };
  assert.equal(window.UI.guard('doctor'), true);
  assert.match(window.UI.shell([], 'Doctor', '', ''), /Fictional/);
  assert.equal(window.UI.guard('sysadmin'), false);
  assert.equal(location.target, '/doctor/');
  end[0]();
  assert.equal(location.target, '/');
});

test('Firebase login page avoids demo store and sends reset requests through Firebase', async () => {
  const app = { innerHTML: '' }, listeners = {}, calls = [];
  const location = { hash: '', href: '', replace(url) { this.target = url; } };
  const window = {
    UI: { $app: app, S: { ready() { throw new Error('demo store accessed'); } }, esc: String, ROLE_HOME: { doctor: '/doctor/' } },
    FirebaseSession: {
      enabled: true, session: () => null,
      login: async (identifier, password) => { calls.push([identifier, password]); return { ok: true, role: 'doctor' }; },
      requestPasswordReset: async (email) => { calls.push(email); },
    },
    addEventListener: (type, handler) => { listeners[type] = handler; },
  };
  vm.runInNewContext(fs.readFileSync('public/assets/js/auth.js', 'utf8'), {
    window, location, document: { addEventListener: (type, handler) => { listeners[type] = handler; } },
    FormData: class { constructor(form) { return Object.entries(form.values); } }, URLSearchParams,
  });
  assert.match(app.innerHTML, /provisioned Firebase account/);
  const submit = async (type, values) => listeners.submit({
    preventDefault() {},
    target: { closest: () => ({ dataset: { form: type }, values, querySelector: () => ({ disabled: false }) }) },
  });
  await submit('login', { email: 'd@example.test', password: 'secret' });
  assert.equal(location.href, '/doctor/');
  location.hash = '#/forgot-password';
  listeners.hashchange();
  assert.match(app.innerHTML, /Account email/);
  assert.doesNotMatch(app.innerHTML, /demo mailbox/);
  await submit('forgot', { email: 'd@example.test' });
  assert.equal(calls[1], 'd@example.test');
  assert.match(app.innerHTML, /Firebase will send/);
});

test('Firebase sessions never accept a legacy demo session or a different project', () => {
  const demo = JSON.stringify({ role: 'doctor', id: 'demo', exp: Date.now() + 60000 });
  assert.equal(load(true, null, { 'carevault.session.v4': demo }).FS.session(), null);
  const foreign = JSON.stringify({ role: 'doctor', idToken: 't', projectId: 'other', exp: Date.now() + 60000 });
  assert.equal(load(true, null, { 'carevault.firebase-session.v1': foreign }).FS.session(), null);
});

test('enabling Firebase without configuration never falls back to demo login', async () => {
  const window = { CAREVAULT_REMOTE: { firebaseLogin: true }, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync('public/assets/js/firebase-session.js', 'utf8'), {
    window, sessionStorage: { getItem: () => null }, setTimeout() {}, clearTimeout() {},
    JSON, Date, Number, String, Promise, Error, encodeURIComponent,
  });
  assert.equal(window.FirebaseSession.enabled, true);
  assert.match((await window.FirebaseSession.login('x', 'y')).error, /not configured/);
  await assert.rejects(window.FirebaseSession.requestPasswordReset('x@example.test'), /not configured/);
});

test('expired sessions are cleared and notify dashboard listeners', () => {
  const key = 'carevault.firebase-session.v1';
  const value = JSON.stringify({ role: 'doctor', idToken: 't', projectId: 'p', exp: Date.now() + 60000 });
  const { FS, store, timers } = load(true, null, { [key]: value });
  let ended = 0;
  FS.onEnd(() => { ended++; });
  store[key] = JSON.stringify({ ...JSON.parse(value), exp: Date.now() - 1 });
  [...timers.values()][0]();
  assert.equal(FS.session(), null);
  assert.equal(store[key], undefined);
  assert.equal(ended, 1);
});

test('logout prevents a pending login or callable response from restoring access', async () => {
  let finishIdentity;
  const identity = new Promise((resolve) => { finishIdentity = resolve; });
  const { FS } = load(true, async (url) => {
    if (url.endsWith('/lookupLoginEmail')) return reply(200, { result: { email: 'd@example.test' } });
    if (url.includes('signInWithPassword')) return reply(200, { idToken: 't', expiresIn: '3600' });
    return identity;
  });
  const pending = FS.login('doctor', 'password');
  await new Promise((resolve) => setImmediate(resolve));
  FS.logout();
  finishIdentity(reply(200, { result: { uid: 'u', role: 'DOCTOR' } }));
  assert.equal((await pending).ok, false);
  assert.equal(FS.session(), null);

  let finishCall;
  const waiting = new Promise((resolve) => { finishCall = resolve; });
  const value = JSON.stringify({ role: 'doctor', idToken: 't', projectId: 'p', exp: Date.now() + 60000 });
  const second = load(true, async () => waiting, { 'carevault.firebase-session.v1': value });
  const call = second.FS.call('getDashboardPatient', {});
  second.FS.logout();
  finishCall(reply(200, { result: { name: 'fictional' } }));
  await assert.rejects(call, /Signed out/);
});

test('password reset uses Firebase, avoids account enumeration and surfaces service errors', async () => {
  const requests = [];
  const { FS } = load(true, async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return reply(400, { error: { message: 'EMAIL_NOT_FOUND' } });
  });
  await FS.requestPasswordReset(' x@example.test ');
  assert.match(requests[0].url, /accounts:sendOobCode/);
  assert.deepEqual(requests[0].body, { requestType: 'PASSWORD_RESET', email: 'x@example.test' });
  const bad = load(true, async () => reply(503, { error: { message: 'unavailable' } }));
  await assert.rejects(bad.FS.requestPasswordReset('x@example.test'), /temporarily unavailable/);
});

test('MFA sign-in asks for an authenticator code and opens a session only after it is accepted', async () => {
  const bodies = {};
  const { FS } = load(true, async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/lookupLoginEmail')) return reply(200, { result: { email: 'd@example.test' } });
    if (url.includes('signInWithPassword')) return reply(200, { mfaPendingCredential: 'pending-1', mfaInfo: [{ mfaEnrollmentId: 'e1', totpInfo: {} }] });
    if (url.includes('/v2/accounts/mfaSignIn:finalize?')) {
      bodies.finalize = body;
      return body.totpVerificationInfo.verificationCode === '123456' ? reply(200, { idToken: 't-mfa', refreshToken: 'r' }) : reply(400, { error: { message: 'INVALID_CODE' } });
    }
    if (url.endsWith('/getDashboardIdentity')) return reply(200, { result: { uid: 'u1', role: 'DOCTOR', subType: 'SURGEON', hospitalId: 'h1', mfaRequired: true, mfaVerified: true } });
    return reply(404, {});
  });
  assert.deepEqual({ ...await FS.login('d', 'pw') }, { ok: false, mfaRequired: true });
  assert.equal(FS.session(), null);
  assert.equal((await FS.verifyMfa('abc')).ok, false, 'malformed codes are rejected before any request');
  assert.match((await FS.verifyMfa('000000')).error, /not accepted/);
  assert.equal(FS.session(), null);
  assert.deepEqual({ ...await FS.verifyMfa('123456') }, { ok: true, role: 'doctor' });
  assert.deepEqual(bodies.finalize, { mfaPendingCredential: 'pending-1', mfaEnrollmentId: 'e1', totpVerificationInfo: { verificationCode: '123456' } });
  assert.equal(FS.session().idToken, 't-mfa');
  assert.equal((await FS.verifyMfa('123456')).expired, true, 'the pending credential is single use');
});

test('a staff sign-in that still needs MFA gets no session until an authenticator is enrolled', async () => {
  const sent = {};
  const { FS } = load(true, async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/lookupLoginEmail')) return reply(200, { result: { email: 'n@example.test' } });
    if (url.includes('signInWithPassword')) return reply(200, { idToken: 't1', expiresIn: '3600', email: 'n@example.test' });
    if (url.endsWith('/getDashboardIdentity')) return reply(200, { result: { uid: 'u2', role: 'NURSE', hospitalId: 'h1', mfaRequired: true, mfaVerified: false } });
    if (url.includes('/v2/accounts/mfaEnrollment:start?')) { sent.start = body; return reply(200, { totpSessionInfo: { sharedSecretKey: 'SECRETKEY', verificationCodeLength: 6, periodSec: 30, sessionInfo: 'si-1' } }); }
    if (url.includes('/v2/accounts/mfaEnrollment:finalize?')) { sent.finalize = body; return reply(200, { idToken: 'new' }); }
    return reply(404, {});
  });
  assert.deepEqual({ ...await FS.login('n', 'pw') }, { ok: false, mfaEnrollment: true });
  assert.equal(FS.session(), null);
  const setup = await FS.startMfaEnrollment();
  assert.equal(setup.secret, 'SECRETKEY');
  assert.match(setup.uri, /^otpauth:\/\/totp\/Care%20Vault%3An%40example\.test\?secret=SECRETKEY&issuer=Care%20Vault&digits=6&period=30$/);
  assert.equal(sent.start.idToken, 't1');
  assert.deepEqual({ ...await FS.finishMfaEnrollment('654321') }, { ok: true });
  assert.deepEqual(sent.finalize.totpVerificationInfo, { sessionInfo: 'si-1', verificationCode: '654321' });
  assert.equal(FS.session(), null, 'enrolment never creates a session; the user signs in again');
  assert.equal((await FS.finishMfaEnrollment('654321')).expired, true);
});

test('enrolment explains an unverified email and cancelling sign-in drops the pending state', async () => {
  const { FS } = load(true, async (url) => {
    if (url.endsWith('/lookupLoginEmail')) return reply(200, { result: { email: 'n@example.test' } });
    if (url.includes('signInWithPassword')) return reply(200, { idToken: 't1', expiresIn: '3600' });
    if (url.endsWith('/getDashboardIdentity')) return reply(200, { result: { uid: 'u2', role: 'NURSE', hospitalId: 'h1', mfaRequired: true, mfaVerified: false } });
    if (url.includes('/v2/accounts/mfaEnrollment:start?')) return reply(400, { error: { message: 'UNVERIFIED_EMAIL' } });
    return reply(404, {});
  });
  await FS.login('n', 'pw');
  assert.match((await FS.startMfaEnrollment()).error, /email address must be verified/);
  FS.cancelMfa();
  assert.equal((await FS.startMfaEnrollment()).expired, true);
});

test('the login page shows the code step, then the enrolment step, and returns to sign-in afterwards', async () => {
  const app = { innerHTML: '' }, listeners = {}, calls = [];
  const location = { hash: '', href: '', replace(url) { this.target = url; } };
  const results = [{ ok: false, mfaRequired: true }, { ok: false, error: 'That code was not accepted.' }, { ok: true, role: 'doctor' }];
  const window = {
    UI: { $app: app, S: {}, esc: (v) => String(v).replace(/</g, '&lt;'), ROLE_HOME: { doctor: '/doctor/' } },
    FirebaseSession: {
      enabled: true, session: () => null, logout() { calls.push('logout'); }, cancelMfa() { calls.push('cancel'); },
      login: async () => (calls.push('login'), calls.loginResult || results.shift()),
      verifyMfa: async (code) => (calls.push('verify:' + code), results.shift()),
      startMfaEnrollment: async () => ({ ok: true, secret: 'SETUPKEY1' }),
      finishMfaEnrollment: async (code) => (calls.push('finish:' + code), { ok: true }),
    },
    addEventListener: (type, handler) => { listeners[type] = handler; },
  };
  vm.runInNewContext(fs.readFileSync('public/assets/js/auth.js', 'utf8'), {
    window, location, document: { addEventListener: (type, handler) => { listeners[type] = handler; } },
    FormData: class { constructor(form) { return Object.entries(form.values); } }, URLSearchParams,
  });
  const submit = async (type, values) => listeners.submit({
    preventDefault() {},
    target: { closest: () => ({ dataset: { form: type }, values, querySelector: () => ({ disabled: false }) }) },
  });
  await submit('login', { email: 'd', password: 'pw' });
  assert.match(app.innerHTML, /Two-step verification/);
  assert.match(app.innerHTML, /data-form="mfa"/);
  await submit('mfa', { code: '111111' });
  assert.match(app.innerHTML, /That code was not accepted/);
  assert.match(app.innerHTML, /data-form="mfa"/, 'a wrong code stays on the code step');
  await submit('mfa', { code: '222222' });
  assert.equal(location.href, '/doctor/');

  calls.loginResult = { ok: false, mfaEnrollment: true };
  await submit('login', { email: 'n', password: 'pw' });
  assert.match(app.innerHTML, /data-form="mfa-enroll"/);
  assert.match(app.innerHTML, /SETUPKEY1/);
  await submit('mfa-enroll', { code: '333333' });
  assert.match(app.innerHTML, /Two-step verification is on\. Sign in again/);
  assert.match(app.innerHTML, /data-form="login"/);
  assert.ok(calls.includes('logout'));
});

test('patient one-time code sign-in exchanges the server token and opens a patient session', async () => {
  const sent = {};
  const { FS } = load(true, async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/requestPatientOtp')) { sent.request = body; return reply(200, { result: { sent: true } }); }
    if (url.endsWith('/verifyPatientOtp')) {
      sent.verify = body;
      return body.data.code === '123456' ? reply(200, { result: { token: 'custom-token' } }) : reply(403, { error: { status: 'PERMISSION_DENIED', message: 'no' } });
    }
    if (url.includes('/v1/accounts:signInWithCustomToken?')) { sent.exchange = body; return reply(200, { idToken: 'otp-id', expiresIn: '3600', refreshToken: 'r' }); }
    if (url.endsWith('/getDashboardIdentity')) return reply(200, { result: { uid: 'p1', role: 'PATIENT', patientId: 'HDW-20260101-AAAAAAAA' } });
    return reply(404, {});
  });
  assert.deepEqual({ ...await FS.requestOtp(' p@example.test ') }, { ok: true });
  assert.deepEqual(sent.request.data, { identifier: 'p@example.test' });
  assert.match((await FS.verifyOtp('p@example.test', 'abc')).error, /6-digit/, 'malformed codes never reach the server');
  assert.equal(sent.verify, undefined);
  assert.match((await FS.verifyOtp('p@example.test', '000000')).error, /not accepted/);
  assert.equal(FS.session(), null);
  assert.deepEqual({ ...await FS.verifyOtp('p@example.test', '123456') }, { ok: true, role: 'patient' });
  assert.deepEqual(sent.exchange, { token: 'custom-token', returnSecureToken: true });
  assert.equal(FS.session().idToken, 'otp-id');
  assert.equal(FS.session().hrid, 'HDW-20260101-AAAAAAAA');
});

test('the login page offers a patient code sign-in that asks for the code after the request', async () => {
  const app = { innerHTML: '' }, listeners = {}, calls = [];
  const location = { hash: '#/otp', href: '', replace() {} };
  const window = {
    UI: { $app: app, S: {}, esc: (v) => String(v).replace(/</g, '&lt;'), ROLE_HOME: { patient: '/patient/' } },
    FirebaseSession: {
      enabled: true, session: () => null, cancelMfa() {},
      requestOtp: async (id) => (calls.push('request:' + id), { ok: true }),
      verifyOtp: async (id, code) => (calls.push('verify:' + id + ':' + code), code === '123456' ? { ok: true, role: 'patient' } : { ok: false, error: 'That code was not accepted.' }),
    },
    addEventListener: (type, handler) => { listeners[type] = handler; },
  };
  vm.runInNewContext(fs.readFileSync('public/assets/js/auth.js', 'utf8'), {
    window, location, document: { addEventListener: (type, handler) => { listeners[type] = handler; } },
    FormData: class { constructor(form) { return Object.entries(form.values); } }, URLSearchParams,
  });
  const submit = async (type, values) => listeners.submit({
    preventDefault() {}, target: { closest: () => ({ dataset: { form: type }, values, querySelector: () => ({ disabled: false }) }) },
  });
  assert.match(app.innerHTML, /data-form="otp-request"/);
  await submit('otp-request', { identifier: ' p@example.test ' });
  assert.match(app.innerHTML, /data-form="otp-verify"/);
  await submit('otp-verify', { code: '000000' });
  assert.match(app.innerHTML, /That code was not accepted/);
  assert.match(app.innerHTML, /data-form="otp-verify"/, 'a wrong code stays on the code step');
  await submit('otp-verify', { code: '123456' });
  assert.equal(location.href, '/patient/');
  assert.deepEqual(calls, ['request: p@example.test ', 'verify:p@example.test:000000', 'verify:p@example.test:123456']);
});

const SESSION = 'carevault.firebase-session.v1', ACTIVE = 'carevault.last-active.v1';
const signedIn = async (extraRoutes = {}, extra = {}) => {
  const log = [];
  const harness = load(true, async (url, init) => {
    const body = init && init.body && init.body.startsWith('{') ? JSON.parse(init.body) : init && init.body;
    log.push({ url, body, auth: init && init.headers && init.headers.Authorization });
    for (const [match, handler] of Object.entries(extraRoutes)) if (url.includes(match)) return handler(body, init);
    if (url.endsWith('/lookupLoginEmail')) return reply(200, { result: { email: 'd@example.test' } });
    if (url.includes('signInWithPassword')) return reply(200, { idToken: 'id-1', refreshToken: 'refresh-1', expiresIn: '3600', email: 'd@example.test' });
    if (url.endsWith('/getDashboardIdentity')) return reply(200, { result: { uid: 'u1', role: 'DOCTOR', subType: 'SPECIALIST', hospitalId: 'h1' } });
    if (url.endsWith('/revokeMySessions')) return reply(200, { result: { revoked: true } });
    if (url.endsWith('/listMyPatients')) return reply(200, { result: [] });
    return reply(404, {});
  }, {}, extra);
  assert.equal((await harness.FS.login('d', 'pw')).ok, true);
  return { ...harness, log };
};

test('a session near expiry is refreshed with the refresh token and keeps working', async () => {
  const { FS, store, log } = await signedIn({
    'securetoken.googleapis.com': () => reply(200, { id_token: 'id-2', refresh_token: 'refresh-2', expires_in: '3600' }),
  });
  assert.equal(JSON.parse(store[SESSION]).refreshToken, 'refresh-1');
  const near = JSON.parse(store[SESSION]); near.exp = Date.now() + 30000; store[SESSION] = JSON.stringify(near);
  await FS.call('listMyPatients');
  const refresh = log.find((r) => r.url.includes('securetoken.googleapis.com'));
  assert.equal(refresh.body, 'grant_type=refresh_token&refresh_token=refresh-1');
  assert.equal(log[log.length - 1].auth, 'Bearer id-2', 'the call uses the refreshed token');
  const kept = JSON.parse(store[SESSION]);
  assert.deepEqual([kept.idToken, kept.refreshToken, kept.role], ['id-2', 'refresh-2', 'doctor']);
  assert.ok(kept.exp > Date.now() + 3000000);
});

test('a refresh the server rejects ends the session, but a network failure does not', async () => {
  const rejected = await signedIn({ 'securetoken.googleapis.com': () => reply(400, { error: { message: 'TOKEN_EXPIRED' } }) });
  const near = JSON.parse(rejected.store[SESSION]); near.exp = Date.now() + 30000; rejected.store[SESSION] = JSON.stringify(near);
  await assert.rejects(() => rejected.FS.call('listMyPatients'), /Signed out/);
  assert.equal(rejected.FS.session(), null);

  const offline = await signedIn({ 'securetoken.googleapis.com': () => { throw new Error('offline'); } });
  const soon = JSON.parse(offline.store[SESSION]); soon.exp = Date.now() + 30000; offline.store[SESSION] = JSON.stringify(soon);
  assert.deepEqual(await offline.FS.call('listMyPatients'), []);
  assert.ok(offline.FS.session(), 'the current token is still valid, so the session stays');
});

test('signing out revokes the sessions on the server before clearing the local one', async () => {
  const { FS, log } = await signedIn();
  FS.logout();
  const revoke = log.find((r) => r.url.endsWith('/revokeMySessions'));
  assert.equal(revoke.auth, 'Bearer id-1');
  assert.equal(FS.session(), null);
});

test('an idle session is signed out and revoked, an active one is not', async () => {
  const active = await signedIn();
  active.store[ACTIVE] = String(Date.now() - 60000);
  [...active.timers.values()].forEach((fn) => fn());
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(active.FS.session(), 'one quiet minute is within the staff limit');

  const idle = await signedIn();
  idle.store[ACTIVE] = String(Date.now() - 16 * 60 * 1000);
  [...idle.timers.values()].forEach((fn) => fn());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle.FS.session(), null);
  assert.ok(idle.log.some((r) => r.url.endsWith('/revokeMySessions')));
});

test('the browser sends a stable random device id with each sign-in', async () => {
  const local = {};
  const extra = { localStorage: { getItem: (k) => local[k] || null, setItem: (k, v) => { local[k] = v; } }, crypto: require('node:crypto').webcrypto };
  const first = await signedIn({}, extra);
  const second = await signedIn({}, extra);
  const ids = [first, second].map((h) => h.log.find((r) => r.url.endsWith('/getDashboardIdentity')).body.data.deviceId);
  assert.match(ids[0], /^[a-f0-9]{32}$/);
  assert.equal(ids[0], ids[1]);
});
