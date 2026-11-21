const { HttpsError } = require('firebase-functions/v2/https');
const { resolveDashboardIdentity } = require('./dashboard-identity');

const ROLES = { SYSTEM_ADMIN: 'system_admin', HOSPITAL_ADMIN: 'hospital_admin', PCC: 'pcc', DOCTOR: 'doctor', LAB: 'lab', PHARMACIST: 'pharmacist', NURSE: 'nurse', PATIENT: 'patient' };
const STAFF = new Set(['doctor', 'lab', 'pharmacist', 'nurse', 'pcc', 'hospital_admin']);
const denied = () => new HttpsError('permission-denied', 'Report access denied.');

// null means the account is a legacy secure-report account; an existing dashboard account is never downgraded.
async function dashboardActor(tx, db, uid, request) {
  const ref = db.doc('dashboardUsers/' + uid);
  const snapshot = await tx.get(ref);
  if (!snapshot.exists) return null;
  const actor = request
    ? await resolveDashboardIdentity(request, db, tx)
    : (() => {
      const user = snapshot.data();
      const role = ROLES[user.role];
      if (user.status !== 'active' || !role || STAFF.has(role) && (typeof user.hospitalId !== 'string' || !user.hospitalId) ||
          role === 'patient' && (typeof user.patientId !== 'string' || !user.patientId)) throw denied();
      return { uid, role: user.role, hospitalId: user.hospitalId, patientId: user.patientId };
    })();
  const role = ROLES[actor.role];
  if (!role) throw denied();
  if (actor.hospitalId) {
    const hospital = await tx.get(db.doc('dashboardHospitals/' + actor.hospitalId));
    if (!hospital.exists || hospital.data().status !== 'active') throw denied();
  }
  return { ...actor, role, source: 'dashboard' };
}

// Returns normalized report identity data or denies access. Called only after dashboardActor returned a dashboard account.
async function authorizeDashboardReport(tx, db, actor, patientId, reportHospital, allowedRoles, requireAiConsent = false) {
  if (!allowedRoles.includes(actor.role)) throw denied();
  const patientSnapshot = await tx.get(db.doc('dashboardPatients/' + patientId));
  if (!patientSnapshot.exists || patientSnapshot.data().status !== 'active') throw denied();
  const patient = patientSnapshot.data();
  if (requireAiConsent && patient.aiProcessingConsent !== true) throw denied();
  if (actor.role === 'patient') {
    if (patient.authUid !== actor.uid || actor.patientId !== patientId) throw denied();
  } else {
    if (reportHospital === undefined && patient.hospitalId !== actor.hospitalId) throw denied();
    const careSnapshot = await tx.get(db.doc('dashboardCare/' + actor.uid + '/patients/' + patientId));
    const care = careSnapshot.exists ? careSnapshot.data() : null;
    if (!care || care.status !== 'active' || care.hospitalId !== actor.hospitalId ||
        reportHospital !== actor.hospitalId && patient.shareWithOtherHospitals !== true) throw denied();
  }
  return {
    user: { uid: actor.uid, role: actor.role, hospitalId: actor.hospitalId, patientId: actor.patientId, status: 'active' },
    patient, source: 'dashboard',
  };
}

module.exports = { dashboardActor, authorizeDashboardReport };
