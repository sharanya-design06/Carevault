const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const { requestPatientOtp, verifyPatientOtp, MAX_ATTEMPTS } = require('../../functions/dashboard-otp');

test('patients sign in with a single-use, expiring, attempt-limited one-time code', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'otp-test');
  const db = app.firestore(), auth = app.auth();
  let ipCounter = 0;
  const call = (data) => ({ data, rawRequest: { ip: '10.0.0.' + (++ipCounter) } });
  const reject = (promise, code) => assert.rejects(promise, (e) => e.code === code);
  const mails = [];
  const mail = async (m) => { mails.push(m); };
  const codeFrom = () => /sign-in code is (\d{6})/.exec(mails[mails.length - 1].text)[1];
  try {
    const hrid = 'HDW-20260101-OTPA0001';
    const patient = await auth.createUser({ email: 'otp.patient@example.test' });
    await auth.setCustomUserClaims(patient.uid, { role: 'PATIENT', patientId: hrid });
    await db.collection('dashboardUsers').doc(patient.uid).set({ role: 'PATIENT', patientId: hrid, email: 'otp.patient@example.test', status: 'active', registeredHospitalId: 'oA' });
    await db.collection('dashboardPatients').doc(hrid).set({ hrid, name: 'Fictional', phoneKey: '9876543210', authUid: patient.uid, status: 'active', hospitalId: 'oA' });
    const staff = await auth.createUser({ email: 'otp.staff@example.test' });
    await db.collection('dashboardUsers').doc(staff.uid).set({ role: 'DOCTOR', email: 'otp.staff@example.test', status: 'active', hospitalId: 'oA', subType: 'SPECIALIST' });

    // Unknown accounts and staff look identical to real ones and send nothing.
    for (const id of ['nobody@example.test', 'otp.staff@example.test', 'not valid', '']) {
      assert.deepEqual(await requestPatientOtp(call({ identifier: id }), db, mail), { sent: true, ttlSeconds: 300 });
    }
    assert.equal(mails.length, 0);
    await reject(verifyPatientOtp(call({ identifier: 'otp.staff@example.test', code: '123456' }), db, auth), 'permission-denied');

    // A valid request mails a code that works once.
    await requestPatientOtp(call({ identifier: 'OTP.Patient@example.test ' }), db, mail);
    assert.equal(mails.length, 1);
    assert.doesNotMatch(mails[0].text, /HDW-|Fictional/, 'the message carries no identifying detail');
    const first = codeFrom();
    await requestPatientOtp(call({ identifier: 'otp.patient@example.test' }), db, mail);
    assert.equal(mails.length, 1, 'a second request inside the cooldown sends nothing');
    await reject(verifyPatientOtp(call({ identifier: 'otp.patient@example.test', code: 'abc' }), db, auth), 'permission-denied');
    const wrong = first === '000000' ? '000001' : '000000';
    await reject(verifyPatientOtp(call({ identifier: 'otp.patient@example.test', code: wrong }), db, auth), 'permission-denied');
    const ok = await verifyPatientOtp(call({ identifier: 'otp.patient@example.test', code: first }), db, auth);
    assert.equal(typeof ok.token, 'string');
    await reject(verifyPatientOtp(call({ identifier: 'otp.patient@example.test', code: first }), db, auth), 'permission-denied');

    // Too many wrong guesses kill the challenge, even for the right code.
    await db.collection('dashboardOtp').doc(patient.uid).delete();
    await requestPatientOtp(call({ identifier: 'otp.patient@example.test' }), db, mail);
    const second = codeFrom();
    const bad = second === '111111' ? '222222' : '111111';
    for (let i = 0; i < MAX_ATTEMPTS; i++) await reject(verifyPatientOtp(call({ identifier: 'otp.patient@example.test', code: bad }), db, auth), 'permission-denied');
    await reject(verifyPatientOtp(call({ identifier: 'otp.patient@example.test', code: second }), db, auth), 'permission-denied');

    // Codes expire.
    await db.collection('dashboardOtp').doc(patient.uid).delete();
    await requestPatientOtp(call({ identifier: 'otp.patient@example.test' }), db, mail);
    const third = codeFrom();
    await db.collection('dashboardOtp').doc(patient.uid).update({ expiresAt: new Date(Date.now() - 1000) });
    await reject(verifyPatientOtp(call({ identifier: 'otp.patient@example.test', code: third }), db, auth), 'permission-denied');

    // A phone number works when it identifies exactly one patient with a login.
    await db.collection('dashboardOtp').doc(patient.uid).delete();
    await requestPatientOtp(call({ identifier: '+91 98765 43210' }), db, mail);
    assert.equal(mails.length, 4);
    const viaPhone = codeFrom();
    assert.equal(typeof (await verifyPatientOtp(call({ identifier: '9876543210', code: viaPhone }), db, auth)).token, 'string');
    await db.collection('dashboardPatients').doc('HDW-20260101-OTPA0002').set({ hrid: 'HDW-20260101-OTPA0002', phoneKey: '9876543210', authUid: 'someone', status: 'active', hospitalId: 'oA' });
    const before = mails.length;
    await requestPatientOtp(call({ identifier: '9876543210' }), db, mail);
    assert.equal(mails.length, before, 'a shared phone number is ambiguous, so nothing is sent');

    // A disabled account gets no token; a failed delivery leaves no usable challenge.
    await db.collection('dashboardOtp').doc(patient.uid).delete();
    await requestPatientOtp(call({ identifier: 'otp.patient@example.test' }), db, mail);
    const fourth = codeFrom();
    await auth.updateUser(patient.uid, { disabled: true });
    await reject(verifyPatientOtp(call({ identifier: 'otp.patient@example.test', code: fourth }), db, auth), 'permission-denied');
    await db.collection('dashboardOtp').doc(patient.uid).delete();
    await requestPatientOtp(call({ identifier: 'otp.patient@example.test' }), db, async () => { throw new Error('smtp down'); });
    assert.equal((await db.collection('dashboardOtp').doc(patient.uid).get()).exists, false);

    // Per-IP throttle.
    const same = { rawRequest: { ip: '203.0.113.9' }, data: { identifier: 'nobody@example.test' } };
    for (let i = 0; i < 10; i++) await requestPatientOtp(same, db, mail);
    await reject(requestPatientOtp(same, db, mail), 'resource-exhausted');

    const audit = (await db.collection('dashboardAudit').where('actorUid', '==', patient.uid).get()).docs.map((d) => d.get('action'));
    for (const action of ['patient_otp_requested', 'patient_otp_verified', 'patient_otp_failed']) assert.ok(audit.includes(action), action);
  } finally { await app.delete(); }
});
