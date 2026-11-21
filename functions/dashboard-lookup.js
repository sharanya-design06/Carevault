const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { activeActor, patientCard, phoneKeyOf, abhaKeyOf, nameKeyOf, HRID } = require('./dashboard-registration');

const LOOKUP_ROLES = ['PCC', 'DOCTOR', 'NURSE', 'LAB', 'PHARMACIST'];
const bad = () => new HttpsError('invalid-argument', 'Invalid lookup request.');
const denied = () => new HttpsError('permission-denied', 'Patient lookup denied.');

// Builds the Firestore query for one lookup method; every query is limited to the caller's hospital.
function queryFor(db, hospitalId, method, value) {
  const patients = () => db.collection('dashboardPatients').where('hospitalId', '==', hospitalId);
  if (method === 'hrid' || method === 'qr') {
    // QR codes carry the HRID, optionally behind a "carevault:" prefix.
    const hrid = typeof value === 'string' ? value.trim().replace(/^carevault:/i, '').toUpperCase() : '';
    if (!HRID.test(hrid)) throw bad();
    return patients().where('hrid', '==', hrid);
  }
  if (method === 'phone') {
    const key = phoneKeyOf(value);
    if (!key) throw bad();
    return patients().where('phoneKey', '==', key);
  }
  if (method === 'abha') {
    const key = abhaKeyOf(value);
    if (!/^\d{14}$/.test(key)) throw bad();
    return patients().where('abhaId', '==', key);
  }
  if (method === 'hospitalId') {
    if (typeof value !== 'string' || !value.trim() || value.length > 32) throw bad();
    return patients().where('hospitalPatientId', '==', value.trim());
  }
  if (method === 'demographics') {
    const { name, dob, gender } = value || {};
    const nameKey = nameKeyOf(name);
    if (!nameKey || nameKey.length > 120 || !/^\d{4}-\d{2}-\d{2}$/.test(dob) || !['Female', 'Male', 'Other'].includes(gender)) throw bad();
    return patients().where('nameKey', '==', nameKey).where('dob', '==', dob).where('gender', '==', gender);
  }
  throw bad();
}

async function findDashboardPatient(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { method, value } = request.data || {};
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (!LOOKUP_ROLES.includes(actor.role)) throw denied();
    const snapshot = await tx.get(queryFor(db, actor.hospitalId, method, value).limit(10));
    const matches = snapshot.docs.filter((doc) => doc.get('status') !== 'inactive');
    // The audit entry records the method and results, never the identifier that was searched for.
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'patient_lookup', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
      lookupMethod: method, resultCount: matches.length, patientIds: matches.map((doc) => doc.id),
      timestamp: FieldValue.serverTimestamp(),
    });
    return matches.map((doc) => patientCard(doc.data()));
  });
}

async function openDashboardEncounter(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { hrid, visitType } = request.data || {};
  if (typeof hrid !== 'string' || !HRID.test(hrid) || !['outpatient', 'inpatient', 'emergency'].includes(visitType)) throw bad();
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (actor.role !== 'PCC') throw denied();
    const patient = await tx.get(db.collection('dashboardPatients').doc(hrid));
    if (!patient.exists || patient.get('status') === 'inactive' || patient.get('hospitalId') !== actor.hospitalId) throw denied();
    const open = await tx.get(db.collection('dashboardEncounters').where('patientId', '==', hrid)
      .where('hospitalId', '==', actor.hospitalId).where('status', '==', 'open').limit(1));
    if (!open.empty) throw new HttpsError('failed-precondition', 'This patient already has an open encounter.');
    const ref = db.collection('dashboardEncounters').doc();
    const timestamp = FieldValue.serverTimestamp();
    tx.create(ref, {
      patientId: hrid, hrid, hospitalId: actor.hospitalId, createdBy: actor.uid,
      type: visitType, status: 'open', locked: false, createdAt: timestamp,
    });
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'encounter_opened', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
      patientId: hrid, encounterId: ref.id, timestamp,
    });
    return { hrid, encounterId: ref.id };
  });
}

module.exports = { findDashboardPatient, openDashboardEncounter };
