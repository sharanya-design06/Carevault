const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { activeActor } = require('./dashboard-registration');

const HRID = /^HDW-\d{8}-[A-Z0-9]{8}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const bad = () => new HttpsError('invalid-argument', 'Invalid request.');
const denied = () => new HttpsError('permission-denied', 'Patient access denied.');

// PCC gives a registered patient of their own hospital a login. The password is set by the patient via the invite link.
async function createPatientAccount(request, db, auth) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { hrid, email } = request.data || {};
  if (typeof hrid !== 'string' || !HRID.test(hrid) || typeof email !== 'string' || email.length > 254 || !EMAIL.test(email)) throw bad();
  const address = email.toLowerCase();
  const actor = await db.runTransaction((tx) => activeActor(request, db, tx));
  if (actor.role !== 'PCC') throw denied();
  const patientRef = db.collection('dashboardPatients').doc(hrid);
  const patient = await patientRef.get();
  if (!patient.exists || patient.data().hospitalId !== actor.hospitalId || patient.data().status === 'inactive') throw denied();
  if (patient.data().authUid) throw new HttpsError('already-exists', 'Patient already has an account.');

  let user;
  try {
    user = await auth.createUser({ email: address, displayName: patient.data().name, emailVerified: false });
  } catch (error) {
    if (error.code === 'auth/email-already-exists') throw new HttpsError('already-exists', 'Email already in use.');
    throw error;
  }
  try {
    await auth.setCustomUserClaims(user.uid, { role: 'PATIENT', patientId: hrid });
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(patientRef);
      if (fresh.data().authUid) throw new HttpsError('already-exists', 'Patient already has an account.');
      tx.update(patientRef, { authUid: user.uid, email: address });
      tx.create(db.collection('dashboardUsers').doc(user.uid), {
        role: 'PATIENT', patientId: hrid, name: patient.data().name, email: address, status: 'active',
        registeredHospitalId: actor.hospitalId, createdBy: actor.uid, createdAt: FieldValue.serverTimestamp(),
      });
      tx.create(db.collection('dashboardAudit').doc(), {
        action: 'patient_account_created', actorUid: actor.uid, actorRole: actor.role,
        hospitalId: actor.hospitalId, patientId: hrid, targetUid: user.uid, timestamp: FieldValue.serverTimestamp(),
      });
    });
  } catch (error) {
    await auth.deleteUser(user.uid);
    throw error;
  }
  return { uid: user.uid, hrid };
}

// Only the patient decides whether other hospitals' care teams may reach their record.
async function setPatientSharing(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { share } = request.data || {};
  if (typeof share !== 'boolean') throw bad();
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (actor.role !== 'PATIENT') throw denied();
    const ref = db.collection('dashboardPatients').doc(actor.patientId);
    const patient = await tx.get(ref);
    if (!patient.exists || patient.data().authUid !== actor.uid) throw denied();
    tx.update(ref, { shareWithOtherHospitals: share });
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'sharing_changed', actorUid: actor.uid, actorRole: actor.role, patientId: actor.patientId,
      hospitalId: patient.data().hospitalId, status: share ? 'shared' : 'private', timestamp: FieldValue.serverTimestamp(),
    });
    return { share };
  });
}

async function getMySharing(request, db) {
  const actor = await db.runTransaction((tx) => activeActor(request, db, tx));
  if (actor.role !== 'PATIENT') throw denied();
  const patient = await db.collection('dashboardPatients').doc(actor.patientId).get();
  return { share: patient.exists && patient.data().shareWithOtherHospitals === true };
}

module.exports = { createPatientAccount, setPatientSharing, getMySharing };
