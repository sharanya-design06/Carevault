// Live smoke test of the dashboard backend using synthetic accounts only.
// Also runs against the emulators (npm run test:smoke) when FUNCTIONS_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST are set.
// Usage: SYNTH_PASSWORD='<new strong password>' GOOGLE_APPLICATION_CREDENTIALS=<service-account JSON outside the repo> \
//   node scripts/live-smoke.js [--keep]
// Creates a throwaway hospital pair and users, exercises the deployed callables over HTTPS, then deletes everything
// it created (pass --keep to leave the data for inspection). Passwords come only from the environment.
const assert = require('node:assert/strict');
const { randomBytes, createHmac, createHash } = require('node:crypto');
const admin = require('../functions/node_modules/firebase-admin');

const EMULATOR = Boolean(process.env.FUNCTIONS_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
const PROJECT = EMULATOR ? (process.env.GCLOUD_PROJECT || 'demo-carevault-isolated') : 'care-vault-project';
const REGION = 'asia-south1';
const API_KEY = /apiKey:\s*'([^']+)'/.exec(require('node:fs').readFileSync(__dirname + '/../public/assets/js/remote-config.js', 'utf8'))[1];
const PASSWORD = process.env.SYNTH_PASSWORD;
const KEEP = process.argv.includes('--keep');

if (!PASSWORD || PASSWORD.length < 12) { console.error('Set SYNTH_PASSWORD (at least 12 characters) in the environment.'); process.exit(2); }
if (!EMULATOR && !process.env.GOOGLE_APPLICATION_CREDENTIALS) { console.error('Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON file outside the repo.'); process.exit(2); }

admin.initializeApp({ projectId: PROJECT });
const auth = admin.auth(), db = admin.firestore();
const run = randomBytes(3).toString('hex');
const email = (name) => `synthetic.${name}.${run}@carevault.example`;
const created = { uids: [], hospitals: [], hrids: [] };
let passed = 0;

const authBase = EMULATOR ? 'http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST + '/identitytoolkit.googleapis.com' : 'https://identitytoolkit.googleapis.com';
const idpost = async (method, body) => {
  const path = method.startsWith('mfa') ? '/v2/accounts/' : '/v1/accounts:';
  const res = await fetch(authBase + path + method + '?key=' + API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
};

// RFC 6238 code from an authenticator secret; adjacent windows are accepted by Identity Platform, and a code just used for
// enrolment is refused for sign-in, so callers try the next window first.
const b32 = (text) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of text.replace(/=+$/, '')) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};
const totp = (secret, offset = 0) => {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = createHmac('sha1', b32(secret)).update(counter).digest(); const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
};
const secrets = new Map();

// Staff must sign in with a second factor on the live project (the emulator has no TOTP, so it skips this).
async function signIn(addr, { withoutMfa = false } = {}) {
  let res = await idpost('signInWithPassword', { email: addr, password: PASSWORD, returnSecureToken: true });
  if (!res.ok) throw new Error('Sign-in failed for ' + addr + ': ' + (res.body.error && res.body.error.message));
  if (EMULATOR || withoutMfa) return res.body.idToken;
  if (res.body.idToken && !secrets.has(addr)) {
    const start = await idpost('mfaEnrollment:start', { idToken: res.body.idToken, totpEnrollmentInfo: {} });
    const info = start.body.totpSessionInfo;
    assert.ok(start.ok && info, 'MFA enrolment start failed for ' + addr);
    const fin = await idpost('mfaEnrollment:finalize', { idToken: res.body.idToken, displayName: 'Synthetic', totpVerificationInfo: { sessionInfo: info.sessionInfo, verificationCode: totp(info.sharedSecretKey) } });
    assert.ok(fin.ok, 'MFA enrolment failed for ' + addr);
    secrets.set(addr, info.sharedSecretKey);
    res = await idpost('signInWithPassword', { email: addr, password: PASSWORD, returnSecureToken: true });
  }
  assert.ok(res.body.mfaPendingCredential, 'expected a second-factor challenge for ' + addr);
  const factor = res.body.mfaInfo.find((i) => i.totpInfo);
  for (const offset of [1, 0, -1]) {
    const done = await idpost('mfaSignIn:finalize', { mfaPendingCredential: res.body.mfaPendingCredential, mfaEnrollmentId: factor.mfaEnrollmentId, totpVerificationInfo: { verificationCode: totp(secrets.get(addr), offset) } });
    if (done.ok) return done.body.idToken;
    // A rejected code consumes the pending credential, so start the sign-in again before the next window.
    res = await idpost('signInWithPassword', { email: addr, password: PASSWORD, returnSecureToken: true });
  }
  throw new Error('Second factor was not accepted for ' + addr);
}

// Returns { ok, data } or { ok: false, status } so negative checks can assert on the callable error status.
async function call(fn, data, token) {
  const base = EMULATOR ? `http://${process.env.FUNCTIONS_EMULATOR_HOST}/${PROJECT}/${REGION}` : `https://${REGION}-${PROJECT}.cloudfunctions.net`;
  // A cold function can answer 503 while the regional Cloud Run CPU quota is briefly exhausted; the next try succeeds.
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(`${base}/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ data }),
    });
    if (res.status !== 503) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const body = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: body.result } : { ok: false, status: body.error && body.error.status };
}
const ok = async (fn, data, token) => { const r = await call(fn, data, token); assert.ok(r.ok, `${fn} failed: ${r.status}`); return r.data; };
const denied = async (fn, data, token, status) => { const r = await call(fn, data, token); assert.equal(r.ok, false, fn + ' should have been rejected'); assert.equal(r.status, status, fn); };
const step = async (name, fn) => { await fn(); passed++; console.log('  ok  ' + name); };

// Accounts are created through the real callable; the password is set directly with the Admin SDK in place of the
// emailed invitation, so no email is sent to the synthetic addresses.
async function provision(token, spec) {
  const { uid } = await ok('createDashboardUser', spec, token);
  created.uids.push(uid);
  await auth.updateUser(uid, { password: PASSWORD, emailVerified: true });
  return uid;
}

async function main() {
  const sysUid = (await auth.createUser({ email: email('sysadmin'), password: PASSWORD, emailVerified: true })).uid;
  created.uids.push(sysUid);
  await auth.setCustomUserClaims(sysUid, { role: 'SYSTEM_ADMIN' });
  await db.collection('dashboardUsers').doc(sysUid).create({
    role: 'SYSTEM_ADMIN', name: 'Synthetic System Admin', email: email('sysadmin'), status: 'active', createdBy: 'live-smoke', createdAt: new Date(),
  });

  const a = `synth-${run}-a`, b = `synth-${run}-b`;
  const hospital = (code) => ({ name: 'Synthetic ' + code, code, licenseNo: 'SYN-' + run, phone: '000000', address: 'Synthetic St', city: 'Testville', country: 'IN' });
  const sys = await signIn(email('sysadmin'));

  console.log('Project ' + PROJECT + ', run ' + run);
  await step('unauthenticated calls are rejected', () => denied('listDashboardHospitals', {}, null, 'UNAUTHENTICATED'));
  await step('system admin creates two hospitals', async () => {
    for (const code of [a, b]) { await ok('createDashboardHospital', hospital(code), sys); created.hospitals.push(code); }
    const ids = (await ok('listDashboardHospitals', {}, sys)).map((h) => h.id);
    assert.ok(ids.includes(a) && ids.includes(b));
  });

  await provision(sys, { email: email('admin-a'), name: 'Admin A', role: 'HOSPITAL_ADMIN', hospitalId: a });
  await provision(sys, { email: email('admin-b'), name: 'Admin B', role: 'HOSPITAL_ADMIN', hospitalId: b });
  const tokA = await signIn(email('admin-a')), tokB = await signIn(email('admin-b'));

  const pccUid = await provision(tokA, { email: email('pcc'), name: 'PCC A', role: 'PCC', hospitalId: a });
  const docUid = await provision(tokA, { email: email('doctor'), name: 'Doctor A', role: 'DOCTOR', subType: 'SPECIALIST', hospitalId: a });
  const nurseUid = await provision(tokA, { email: email('nurse'), name: 'Nurse A', role: 'NURSE', hospitalId: a });
  const pccB = await provision(tokB, { email: email('pcc-b'), name: 'PCC B', role: 'PCC', hospitalId: b });
  const [pcc, doc, nurse, pccBTok] = await Promise.all([email('pcc'), email('doctor'), email('nurse'), email('pcc-b')].map(signIn));

  await step('login lookup and verified identity (role, sub-type, hospital)', async () => {
    assert.deepEqual(await ok('lookupLoginEmail', { identifier: email('doctor') }), { email: email('doctor') });
    const id = await ok('getDashboardIdentity', {}, doc);
    assert.equal(id.role, 'DOCTOR'); assert.equal(id.subType, 'SPECIALIST'); assert.equal(id.hospitalId, a);
  });
  await step('provisioning is scoped (no privilege escalation or cross-hospital creation)', async () => {
    await denied('createDashboardUser', { email: email('x1'), name: 'X', role: 'SYSTEM_ADMIN' }, tokA, 'PERMISSION_DENIED');
    await denied('createDashboardUser', { email: email('x2'), name: 'X', role: 'NURSE', hospitalId: b }, tokA, 'PERMISSION_DENIED');
    await denied('createDashboardUser', { email: email('x3'), name: 'X', role: 'NURSE', hospitalId: a }, nurse, 'PERMISSION_DENIED');
    await denied('createDashboardUser', { email: email('x4'), name: 'X', role: 'DOCTOR', hospitalId: a }, tokA, 'INVALID_ARGUMENT');
  });

  let hrid;
  await step('PCC registers a patient with an HRID and encounter', async () => {
    const r = await ok('registerDashboardPatient', { name: 'Synthetic Patient', dob: '1990-01-15', gender: 'Other', visitType: 'outpatient', phone: '5550100', requestId: 'live-smoke-req-' + run }, pcc);
    assert.match(r.hrid, /^HDW-\d{8}-[A-Z0-9]{8}$/); assert.ok(r.encounterId);
    hrid = r.hrid; created.hrids.push(hrid);
  });
  await step('clinicians need an active care assignment from the PCC', async () => {
    await denied('addClinicalRecord', { hrid, type: 'diagnosis', data: { condition: 'Synthetic condition' } }, doc, 'PERMISSION_DENIED');
    await denied('assignPatientCare', { hrid, uid: docUid }, doc, 'PERMISSION_DENIED');
    await ok('assignPatientCare', { hrid, uid: docUid }, pcc);
    await ok('assignPatientCare', { hrid, uid: nurseUid }, pcc);
  });
  await step('role-limited clinical writes and sensitive-read audit', async () => {
    await ok('addClinicalRecord', { hrid, type: 'diagnosis', data: { condition: 'Synthetic condition', notes: 'live smoke' } }, doc);
    await ok('addClinicalRecord', { hrid, type: 'vitals', data: { pulse: 72, spo2: 98 } }, nurse);
    await denied('addClinicalRecord', { hrid, type: 'diagnosis', data: { condition: 'Nurse may not diagnose' } }, nurse, 'PERMISSION_DENIED');
    await denied('addClinicalRecord', { hrid, type: 'vitals', data: { pulse: 9999 } }, nurse, 'INVALID_ARGUMENT');
    const records = await ok('listClinicalRecords', { hrid }, doc);
    assert.deepEqual(records.map((r) => r.type).sort(), ['diagnosis', 'vitals']);
    assert.ok(records.every((r) => r.sensitive === true));
    const audit = await ok('listSensitiveAudit', {}, doc);
    assert.ok(audit.some((e) => e.patientId === hrid));
  });
  await step('hospital isolation: other hospital cannot read, assign or see the patient', async () => {
    await denied('listClinicalRecords', { hrid }, pccBTok, 'PERMISSION_DENIED');
    await denied('assignPatientCare', { hrid, uid: pccB }, pccBTok, 'PERMISSION_DENIED');
    assert.equal((await ok('getPccPatients', {}, pccBTok)).length, 0);
    assert.ok((await ok('getPccPatients', {}, pcc)).length >= 1);
    await denied('listDashboardHospitals', {}, nurse, 'PERMISSION_DENIED');
  });
  await step('deactivation disables sign-in and hospital deactivation cascades', async () => {
    await ok('setDashboardUserStatus', { uid: nurseUid, status: 'inactive' }, tokA);
    assert.equal((await auth.getUser(nurseUid)).disabled, true);
    await assert.rejects(signIn(email('nurse')));
    const r = await ok('setDashboardHospitalStatus', { id: b, status: 'inactive' }, sys);
    assert.ok(r.usersAffected >= 2);
    await assert.rejects(signIn(email('pcc-b')));
  });
  await step('staff MFA is enforced: a password-only token is refused until a second factor is used', async () => {
    if (EMULATOR) return; // the Auth emulator has no TOTP
    const passwordOnly = await signIn(email('doctor'), { withoutMfa: true });
    await denied('listMyPatients', {}, passwordOnly, 'FAILED_PRECONDITION');
    const identity = await ok('getDashboardIdentity', {}, passwordOnly);
    assert.equal(identity.mfaRequired, true); assert.equal(identity.mfaVerified, false);
    assert.equal((await ok('getDashboardIdentity', { deviceId: 'a'.repeat(32) }, doc)).mfaVerified, true);
  });
  await step('patient one-time code sign-in, session revocation and new-device audit', async () => {
    if (EMULATOR) return; // custom-token signing needs the real IAM service
    const account = await ok('createPatientAccount', { hrid, email: email('patient') }, pcc);
    created.uids.push(account.uid);
    await auth.updateUser(account.uid, { emailVerified: true });
    await denied('verifyPatientOtp', { identifier: email('patient'), code: '123456' }, null, 'PERMISSION_DENIED');
    const code = String(Math.floor(100000 + Math.random() * 900000)), salt = randomBytes(8).toString('hex');
    await db.collection('dashboardOtp').doc(account.uid).set({
      salt, codeHash: createHash('sha256').update(salt + ':' + code).digest('hex'), attempts: 0, createdAt: new Date(), expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    const { token } = await ok('verifyPatientOtp', { identifier: email('patient'), code }, null);
    await denied('verifyPatientOtp', { identifier: email('patient'), code }, null, 'PERMISSION_DENIED'); // single use
    const exchanged = await idpost('signInWithCustomToken', { token, returnSecureToken: true });
    assert.ok(exchanged.ok && exchanged.body.refreshToken, 'custom token exchange');
    const device = 'c'.repeat(32);
    const identity = await ok('getDashboardIdentity', { deviceId: device }, exchanged.body.idToken);
    assert.equal(identity.role, 'PATIENT'); assert.equal(identity.newDevice, true);
    assert.equal((await ok('getDashboardIdentity', { deviceId: device }, exchanged.body.idToken)).newDevice, undefined);
    await ok('revokeMySessions', {}, exchanged.body.idToken);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await denied('getDashboardIdentity', {}, exchanged.body.idToken, 'UNAUTHENTICATED');
    const refreshed = await fetch('https://securetoken.googleapis.com/v1/token?key=' + API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(exchanged.body.refreshToken),
    });
    assert.ok(!refreshed.ok, 'the revoked refresh token no longer works');
    const fresh = await idpost('signInWithCustomToken', { token: (await (async () => {
      await db.collection('dashboardOtp').doc(account.uid).set({ salt, codeHash: createHash('sha256').update(salt + ':' + code).digest('hex'), attempts: 0, createdAt: new Date(), expiresAt: new Date(Date.now() + 300000) });
      return ok('verifyPatientOtp', { identifier: email('patient'), code }, null);
    })()).token, returnSecureToken: true });
    assert.equal((await ok('getDashboardIdentity', {}, fresh.body.idToken)).role, 'PATIENT', 'signing in again after a revocation works');
  });
  await step('audit trail records the actions (system-wide and hospital-scoped)', async () => {
    const global = await ok('listDashboardAudit', {}, sys);
    for (const action of ['hospital_created', 'patient_registered']) assert.ok(global.some((e) => e.action === action), 'missing ' + action);
    const own = await ok('listDashboardAudit', {}, tokA);
    assert.ok(own.length > 0 && own.every((e) => e.hospitalId === a));
  });
}

async function cleanup() {
  for (const uid of created.uids) {
    await auth.deleteUser(uid).catch(() => {});
    await db.collection('dashboardUsers').doc(uid).delete().catch(() => {});
    await db.collection('dashboardOtp').doc(uid).delete().catch(() => {});
    const devices = await db.collection('dashboardDevices').where('uid', '==', uid).get().catch(() => ({ docs: [] }));
    await Promise.all(devices.docs.map((d) => d.ref.delete()));
    await db.recursiveDelete(db.collection('dashboardCare').doc(uid)).catch(() => {});
  }
  for (const hrid of created.hrids) {
    await db.collection('dashboardPatients').doc(hrid).delete().catch(() => {});
    for (const col of ['dashboardEncounters', 'dashboardRecords', 'dashboardNotifications']) {
      const snap = await db.collection(col).where('patientId', '==', hrid).get();
      await Promise.all(snap.docs.map((d) => d.ref.delete()));
    }
  }
  for (const code of created.hospitals) {
    await db.collection('dashboardHospitals').doc(code).delete().catch(() => {});
    const audit = await db.collection('dashboardAudit').where('hospitalId', '==', code).get();
    // The audit guard restores deleted entries, so remove each entry's anchor (also synthetic) first.
    await Promise.all(audit.docs.map((d) => db.collection('auditAnchors').doc('dashboardAudit__' + d.id).delete()));
    await Promise.all(audit.docs.map((d) => d.ref.delete()));
  }
  const reg = await db.collection('dashboardRegistrationRequests').get();
  await Promise.all(reg.docs.filter((d) => d.id.endsWith('_live-smoke-req-' + run)).map((d) => d.ref.delete()));
}

main()
  .then(() => console.log(`\nAll ${passed} live checks passed.`))
  .catch((e) => { console.error('\nLIVE CHECK FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    if (KEEP) console.log('--keep: synthetic data left in place (run ' + run + ').');
    else { await cleanup(); console.log('Synthetic data removed.'); }
    process.exit(process.exitCode || 0);
  });
