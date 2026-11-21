const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const admin = require('firebase-admin');

const ID = /^[A-Za-z0-9_-]{1,128}$/;

const denied = () => new HttpsError('permission-denied', 'Report access denied.');

function id(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new HttpsError('invalid-argument', 'Invalid identifier.');
  return value;
}

function uid(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  return id(request.auth.uid);
}

/**
 * Authorizes an account against provisioned secure-report documents (Admin SDK only; clients cannot write them):
 *   secureReportUsers/{uid}                       status, role (doctor|lab|patient), hospitalId | patientId
 *   secureReportPatients/{patientId}              status, authUid, shareWithOtherHospitals, aiProcessingConsent
 *   secureReportCare/{uid}/patients/{patientId}   status, hospitalId
 * Staff need an active care relationship in their own hospital; other hospitals' reports also need patient sharing.
 */
async function authorize(tx, actor, { patientId, reportHospital, roles, requireAiConsent = false }) {
  const db = admin.firestore();
  const [userSnap, patientSnap] = await Promise.all([
    tx.get(db.doc('secureReportUsers/' + actor)),
    tx.get(db.doc('secureReportPatients/' + patientId)),
  ]);
  if (!userSnap.exists || !patientSnap.exists) throw denied();
  const user = userSnap.data(), patient = patientSnap.data();
  if (user.status !== 'active' || !roles.includes(user.role) || patient.status !== 'active' ||
      (requireAiConsent && patient.aiProcessingConsent !== true)) throw denied();
  if (user.role === 'patient') {
    if (patient.authUid !== actor || user.patientId !== patientId) throw denied();
  } else {
    if (typeof user.hospitalId !== 'string' || !ID.test(user.hospitalId)) throw denied();
    const careSnap = await tx.get(db.doc('secureReportCare/' + actor + '/patients/' + patientId));
    const care = careSnap.exists ? careSnap.data() : null;
    if (!care || care.status !== 'active' || care.hospitalId !== user.hospitalId ||
        (reportHospital !== undefined && reportHospital !== user.hospitalId && patient.shareWithOtherHospitals !== true)) {
      throw denied();
    }
  }
  return { user, patient };
}

function audit(tx, actor, role, reportId, action, details = {}) {
  tx.create(admin.firestore().collection('secureReportAudit').doc(), {
    action, actorUid: actor, actorRole: role, reportId: reportId || null,
    timestamp: FieldValue.serverTimestamp(), ...details,
  });
}

module.exports = { ID, id, uid, authorize, audit, denied };
