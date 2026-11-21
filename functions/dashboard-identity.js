const { HttpsError } = require('firebase-functions/v2/https');

const ROLES = new Set([
  'SYSTEM_ADMIN', 'HOSPITAL_ADMIN', 'PCC', 'DOCTOR', 'LAB', 'PHARMACIST', 'NURSE', 'PATIENT',
]);
const SUBTYPES = {
  DOCTOR: new Set(['GENERAL_PRIMARY', 'SPECIALIST', 'SURGEON', 'RADIOLOGIST', 'PATHOLOGIST', 'ANESTHETIST']),
  LAB: new Set(['SAMPLE_PHLEBOTOMY', 'PATHOLOGY_BIOCHEMISTRY', 'RADIOLOGY', 'MICROBIOLOGY']),
};

// A sign-in stays valid for a bounded time however often its ID token is refreshed (auth_time never changes on refresh).
const MAX_SESSION_MS = { PATIENT: 24 * 60 * 60 * 1000, STAFF: 12 * 60 * 60 * 1000 };
const sessionError = (message) => new HttpsError('unauthenticated', message);

// Rejects tokens from before the account's last server-side revocation, and sign-ins older than the maximum session age.
// Real Firebase ID tokens always carry auth_time; tokens without it never come from Firebase and are not session-checked here.
function checkSession(user, token, now = Date.now()) {
  if (typeof token.auth_time !== 'number' || !Number.isFinite(token.auth_time)) return;
  const revokedAt = user.sessionsValidAfter && typeof user.sessionsValidAfter.toMillis === 'function' ? user.sessionsValidAfter.toMillis() : 0;
  if (token.auth_time < Math.floor(revokedAt / 1000)) throw sessionError('This session was signed out. Please sign in again.');
  if (now - token.auth_time * 1000 > (user.role === 'PATIENT' ? MAX_SESSION_MS.PATIENT : MAX_SESSION_MS.STAFF)) {
    throw sessionError('This session has expired. Please sign in again.');
  }
}

const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
  !value.includes('/') && value !== '.' && value !== '..';
const absent = (value) => value === undefined || value === null;

// Staff (every role except PATIENT) must have signed in with a second factor when REQUIRE_STAFF_MFA=true.
// Patients use phone OTP, which is handled separately.
const mfaRequired = (role) => role !== 'PATIENT' && process.env.REQUIRE_STAFF_MFA === 'true';
const mfaVerified = (token) => !!(token.firebase && token.firebase.sign_in_second_factor);

// request.auth must be supplied by Firebase callable token verification, not by client data.
// getDashboardIdentity alone passes allowWithoutMfa so a staff member can reach the MFA enrolment step.
async function resolveDashboardIdentity(request, db, tx, { allowWithoutMfa = false } = {}) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { uid, token } = request.auth;
  if (!validId(uid) || !token || typeof token !== 'object') {
    throw new HttpsError('permission-denied', 'Dashboard access denied.');
  }
  const snapshot = await tx.get(db.collection('dashboardUsers').doc(uid));
  if (!snapshot.exists) throw new HttpsError('permission-denied', 'Dashboard access denied.');
  const user = snapshot.data();
  if (!user || user.status !== 'active' || !ROLES.has(user.role) || token.role !== user.role) {
    throw new HttpsError('permission-denied', 'Dashboard access denied.');
  }
  checkSession(user, token);
  const subtypeOptions = SUBTYPES[user.role];
  if (subtypeOptions
    ? !subtypeOptions.has(user.subType) || token.subType !== user.subType
    : !absent(user.subType) || !absent(token.subType)) {
    throw new HttpsError('permission-denied', 'Dashboard access denied.');
  }
  const staff = user.role !== 'SYSTEM_ADMIN' && user.role !== 'PATIENT';
  if (staff
    ? !validId(user.hospitalId) || token.hospitalId !== user.hospitalId
    : !absent(user.hospitalId) || !absent(token.hospitalId)) {
    throw new HttpsError('permission-denied', 'Dashboard access denied.');
  }
  if (user.role === 'PATIENT'
    ? !validId(user.patientId) || token.patientId !== user.patientId
    : !absent(user.patientId) || !absent(token.patientId)) {
    throw new HttpsError('permission-denied', 'Dashboard access denied.');
  }
  if (!allowWithoutMfa && mfaRequired(user.role) && !mfaVerified(token)) {
    throw new HttpsError('failed-precondition', 'Multi-factor authentication required.');
  }
  return {
    uid,
    role: user.role,
    ...(staff ? { hospitalId: user.hospitalId } : {}),
    ...(subtypeOptions ? { subType: user.subType } : {}),
    ...(user.role === 'PATIENT' ? { patientId: user.patientId } : {}),
  };
}

module.exports = { resolveDashboardIdentity, mfaRequired, mfaVerified, checkSession, MAX_SESSION_MS };
