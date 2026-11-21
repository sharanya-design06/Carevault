// Provisions synthetic secure-report accounts. Idempotent. Never use real people or patient data.
//   Emulator: FIREBASE_AUTH_EMULATOR_HOST/FIRESTORE_EMULATOR_HOST set, or use `npm run test:e2e`.
//   Live:     SECURE_REPORT_DEMO_PASSWORD='<new strong password>' GOOGLE_APPLICATION_CREDENTIALS=... \
//             node scripts/provision-secure-report.js care-vault-project

const DEFAULTS = {
  hospitalId: 'synthetic-hospital-1',
  patientId: 'synthetic-patient-001',
  doctor: 'synthetic.doctor@carevault.example',
  lab: 'synthetic.lab@carevault.example',
  patient: 'synthetic.patient@carevault.example',
};

async function ensureUser(auth, email, password, displayName) {
  try {
    const existing = await auth.getUserByEmail(email);
    await auth.updateUser(existing.uid, { password, displayName });
    return existing.uid;
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    return (await auth.createUser({ email, password, displayName, emailVerified: true })).uid;
  }
}

async function provisionSecureReportAccounts(admin, password, overrides = {}) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Provide a password of at least 12 characters.');
  const config = { ...DEFAULTS, ...overrides }, db = admin.firestore(), auth = admin.auth();
  const uids = {
    doctor: await ensureUser(auth, config.doctor, password, 'Synthetic Doctor'),
    lab: await ensureUser(auth, config.lab, password, 'Synthetic Lab Technician'),
    patient: await ensureUser(auth, config.patient, password, 'Synthetic Patient'),
  };
  const now = new Date();
  await db.doc('secureReportUsers/' + uids.doctor).set({ status: 'active', role: 'doctor', hospitalId: config.hospitalId, provisionedAt: now });
  await db.doc('secureReportUsers/' + uids.lab).set({ status: 'active', role: 'lab', hospitalId: config.hospitalId, provisionedAt: now });
  await db.doc('secureReportUsers/' + uids.patient).set({ status: 'active', role: 'patient', patientId: config.patientId, provisionedAt: now });
  await db.doc('secureReportPatients/' + config.patientId).set({
    status: 'active', authUid: uids.patient, shareWithOtherHospitals: false, aiProcessingConsent: false, provisionedAt: now,
  }, { merge: true });
  for (const uid of [uids.doctor, uids.lab]) {
    await db.doc('secureReportCare/' + uid + '/patients/' + config.patientId).set({
      status: 'active', hospitalId: config.hospitalId, provisionedAt: now,
    });
  }
  return { uids, ...config };
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Enables secure reports for an EXISTING Firebase account without touching its password or profile.
 *   doctor/lab: { email, role, hospitalId, patientIds: [...] }  (adds the care relationship for each patient)
 *   patient:    { email, role: 'patient', patientId }           (consent stays as the patient set it; off if new)
 */
async function linkSecureReportAccount(admin, { email, role, hospitalId, patientIds = [], patientId }) {
  if (!['doctor', 'lab', 'patient'].includes(role)) throw new Error('Role must be doctor, lab or patient.');
  const db = admin.firestore(), user = await admin.auth().getUserByEmail(email), now = new Date();
  if (role === 'patient') {
    if (!ID.test(patientId || '')) throw new Error('A valid patientId is required.');
    await db.doc('secureReportUsers/' + user.uid).set({ status: 'active', role, patientId, provisionedAt: now });
    await db.doc('secureReportPatients/' + patientId).set({
      status: 'active', authUid: user.uid, provisionedAt: now,
    }, { merge: true });
    const patient = (await db.doc('secureReportPatients/' + patientId).get()).data();
    const defaults = {};
    if (typeof patient.aiProcessingConsent !== 'boolean') defaults.aiProcessingConsent = false;
    if (typeof patient.shareWithOtherHospitals !== 'boolean') defaults.shareWithOtherHospitals = false;
    if (Object.keys(defaults).length) await db.doc('secureReportPatients/' + patientId).set(defaults, { merge: true });
    return { uid: user.uid, role, patientId };
  }
  if (!ID.test(hospitalId || '') || !patientIds.length || !patientIds.every((id) => ID.test(id))) {
    throw new Error('A hospitalId and valid patientIds are required for staff.');
  }
  await db.doc('secureReportUsers/' + user.uid).set({ status: 'active', role, hospitalId, provisionedAt: now });
  for (const id of patientIds) {
    await db.doc('secureReportCare/' + user.uid + '/patients/' + id).set({ status: 'active', hospitalId, provisionedAt: now });
  }
  return { uid: user.uid, role, hospitalId, patientIds };
}

module.exports = { provisionSecureReportAccounts, linkSecureReportAccount, DEFAULTS };

if (require.main === module) {
  const admin = require('../functions/node_modules/firebase-admin');
  const projectId = process.argv[2] || process.env.GCLOUD_PROJECT;
  if (!projectId) { console.error('Usage: node scripts/provision-secure-report.js <projectId>'); process.exit(1); }
  admin.initializeApp({ projectId });
  provisionSecureReportAccounts(admin, process.env.SECURE_REPORT_DEMO_PASSWORD)
    .then((result) => {
      console.log('Provisioned synthetic accounts in', projectId);
      console.log(JSON.stringify({ doctor: result.doctor, lab: result.lab, patient: result.patient, patientId: result.patientId }, null, 2));
    })
    .catch((error) => { console.error(error.message); process.exit(1); });
}
