const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { createHash, randomInt } = require('node:crypto');
const logger = require('firebase-functions/logger');
const { resolveDashboardIdentity, mfaRequired, mfaVerified } = require('./dashboard-identity');
const { recordDevice } = require('./dashboard-sessions');
const { suggestedCategories } = require('./dashboard-triage');
const { MODEL, pairId, findDuplicateCandidates } = require('./dashboard-duplicate-detection');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const GRANT_MS = 24 * 60 * 60 * 1000;
const CLINICAL = ['DOCTOR', 'LAB', 'PHARMACIST', 'NURSE'];
const HRID = /^HDW-\d{8}-[A-Z0-9]{8}$/;
const FIELDS = new Set([
  'name', 'dob', 'gender', 'visitType', 'phone', 'address', 'emergencyName', 'emergencyPhone', 'requestId',
  'abhaId', 'hospitalPatientId',
]);
const ABHA = /^\d{14}$/;
const HOSPITAL_PATIENT_ID = /^[A-Za-z0-9][A-Za-z0-9/_-]{1,31}$/;

// Normalised keys let lookups match regardless of formatting; the raw values are kept for display.
const phoneKeyOf = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 6 ? digits.slice(-10) : '';
};
const abhaKeyOf = (abha) => String(abha || '').replace(/[\s-]/g, '');
const nameKeyOf = (name) => String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function checkedRegistration(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).some((key) => !FIELDS.has(key)) ||
      typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 120 ||
      typeof data.dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.dob) ||
      !['Female', 'Male', 'Other'].includes(data.gender) ||
      !['outpatient', 'inpatient', 'emergency'].includes(data.visitType)) {
    throw new HttpsError('invalid-argument', 'Invalid registration details.');
  }
  const date = new Date(data.dob + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== data.dob ||
      data.dob > new Date().toISOString().slice(0, 10)) {
    throw new HttpsError('invalid-argument', 'Invalid date of birth.');
  }
  const optional = (key, max) => {
    const value = data[key] === undefined ? '' : data[key];
    if (typeof value !== 'string' || value.length > max) {
      throw new HttpsError('invalid-argument', 'Invalid registration details.');
    }
    return value.trim();
  };
  const phone = optional('phone', 20), emergencyPhone = optional('emergencyPhone', 20);
  const phonePattern = /^$|^\+?[\d\s()-]{6,20}$/;
  if (!phonePattern.test(phone) || !phonePattern.test(emergencyPhone)) {
    throw new HttpsError('invalid-argument', 'Invalid registration details.');
  }
  const abhaId = optional('abhaId', 20), hospitalPatientId = optional('hospitalPatientId', 32);
  if ((abhaId && !ABHA.test(abhaKeyOf(abhaId))) || (hospitalPatientId && !HOSPITAL_PATIENT_ID.test(hospitalPatientId))) {
    throw new HttpsError('invalid-argument', 'Invalid registration details.');
  }
  if (typeof data.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(data.requestId)) {
    throw new HttpsError('invalid-argument', 'Invalid registration request.');
  }
  return {
    name: data.name.trim(), dob: data.dob, gender: data.gender, visitType: data.visitType,
    phone, address: optional('address', 200), emergencyName: optional('emergencyName', 80), emergencyPhone,
    abhaId: abhaKeyOf(abhaId), hospitalPatientId, requestId: data.requestId,
  };
}

async function activeActor(request, db, tx, options) {
  const actor = await resolveDashboardIdentity(request, db, tx, options);
  if (actor.hospitalId) {
    const hospital = await tx.get(db.collection('dashboardHospitals').doc(actor.hospitalId));
    if (!hospital.exists || hospital.data().status !== 'active') {
      throw new HttpsError('permission-denied', 'Dashboard access denied.');
    }
  }
  return actor;
}

// Decides how an actor may reach a patient (self, registration, care, reasoned) or throws permission-denied.
// Every read of patient data must go through this, and it must run before any write in the transaction.
async function patientScope(tx, db, actor, hrid, patient) {
  let accessScope;
  if (actor.role === 'PATIENT') {
    if (patient.authUid !== actor.uid || actor.patientId !== hrid) {
      throw new HttpsError('permission-denied', 'Patient access denied.');
    }
    accessScope = 'self';
  } else if (actor.role === 'PCC') {
    if (patient.hospitalId !== actor.hospitalId) throw new HttpsError('permission-denied', 'Patient access denied.');
    accessScope = 'registration';
  } else if (['DOCTOR', 'LAB', 'PHARMACIST', 'NURSE'].includes(actor.role)) {
    const careSnapshot = await tx.get(db.collection('dashboardCare').doc(actor.uid)
      .collection('patients').doc(hrid));
    const grantSnapshot = await tx.get(db.collection('dashboardAccessGrants').doc(actor.uid + '_' + hrid));
    const grant = grantSnapshot.exists ? grantSnapshot.data() : null;
    const grantActive = grant && grant.hospitalId === actor.hospitalId &&
      grant.expiresAt.toMillis() > Date.now();
    const careOk = careSnapshot.exists && careSnapshot.data().status === 'active' &&
      careSnapshot.data().hospitalId === actor.hospitalId &&
      (patient.hospitalId === actor.hospitalId || patient.shareWithOtherHospitals === true);
    if (!careOk && !grantActive) throw new HttpsError('permission-denied', 'Patient access denied.');
    accessScope = careOk ? 'care' : 'reasoned';
  } else {
    throw new HttpsError('permission-denied', 'Patient access denied.');
  }
  return accessScope;
}

// Also tells the client whether this sign-in still needs a second factor (enrolment or code) before it may continue.
async function getDashboardIdentity(request, db) {
  const actor = await db.runTransaction((tx) => activeActor(request, db, tx, { allowWithoutMfa: true }));
  const needsMfa = mfaRequired(actor.role), verified = mfaVerified(request.auth.token);
  // The browser is only remembered once the sign-in is complete, so a password-only attempt never counts as a known device.
  const device = !needsMfa || verified ? await recordDevice(db, actor, request.data && request.data.deviceId) : { newDevice: false };
  return { ...actor, mfaRequired: needsMfa, mfaVerified: verified, ...(device.newDevice ? { newDevice: true } : {}) };
}

async function registerDashboardPatient(request, db) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  const input = checkedRegistration(request.data);
  const { requestId, ...registration } = input;
  const requestHash = createHash('sha256').update(JSON.stringify(registration)).digest('hex');
  const idempotencyRef = db.collection('dashboardRegistrationRequests').doc(
    request.auth.uid + '_' + requestId,
  );

  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (actor.role !== 'PCC') throw new HttpsError('permission-denied', 'Patient registration denied.');
    const previous = await tx.get(idempotencyRef);
    if (previous.exists) {
      const saved = previous.data();
      if (saved.actorUid !== actor.uid || saved.requestHash !== requestHash) {
        throw new HttpsError('failed-precondition', 'Registration request ID was already used.');
      }
      return saved.result;
    }
    if (registration.hospitalPatientId) {
      const taken = await tx.get(db.collection('dashboardPatients').where('hospitalId', '==', actor.hospitalId)
        .where('hospitalPatientId', '==', registration.hospitalPatientId).limit(1));
      if (!taken.empty) throw new HttpsError('already-exists', 'That hospital patient ID is already in use.');
    }
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const hrid = 'HDW-' + date + '-' + suffix;
    const stored = {
      hrid, ...registration, phoneKey: phoneKeyOf(registration.phone), nameKey: nameKeyOf(registration.name),
      authUid: null, status: 'active', shareWithOtherHospitals: false,
      hospitalId: actor.hospitalId, createdBy: actor.uid,
    };
    const candidates = await findDuplicateCandidates(tx, db, actor.hospitalId, stored);
    const patientRef = db.collection('dashboardPatients').doc(hrid);
    const encounterRef = db.collection('dashboardEncounters').doc();
    const auditRef = db.collection('dashboardAudit').doc();
    const timestamp = FieldValue.serverTimestamp();
    tx.create(patientRef, { ...stored, createdAt: timestamp });
    tx.create(encounterRef, {
      patientId: hrid, hrid, hospitalId: actor.hospitalId, createdBy: actor.uid,
      type: input.visitType, status: 'open', locked: false, createdAt: timestamp,
    });
    tx.create(auditRef, {
      action: 'patient_registered', actorUid: actor.uid, actorRole: actor.role,
      hospitalId: actor.hospitalId, patientId: hrid, encounterId: encounterRef.id,
      timestamp,
    });
    for (const match of candidates) {
      tx.create(db.collection('dashboardDuplicateCandidates').doc(pairId(hrid, match.other.hrid)), {
        hospitalId: actor.hospitalId, patientIds: [hrid, match.other.hrid], score: match.score, reasons: match.reasons,
        model: MODEL, status: 'pending', createdAt: timestamp,
      });
    }
    const result = { hrid, encounterId: encounterRef.id, ...(candidates.length ? { possibleDuplicates: candidates.length } : {}) };
    tx.create(idempotencyRef, {
      actorUid: actor.uid, requestHash, result, createdAt: timestamp,
    });
    return result;
  });
}

function patientCard(patient) {
  return {
    hrid: patient.hrid, name: patient.name, dob: patient.dob, gender: patient.gender,
    hospitalId: patient.hospitalId, priorityCare: !!(patient.priorityCare && patient.priorityCare.active),
  };
}

async function getPccPatients(request, db) {
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (actor.role !== 'PCC') throw new HttpsError('permission-denied', 'Patient list access denied.');
    const patients = await tx.get(db.collection('dashboardPatients')
      .where('hospitalId', '==', actor.hospitalId).orderBy('createdAt', 'desc').limit(50));
    const auditRef = db.collection('dashboardAudit').doc();
    tx.create(auditRef, {
      action: 'patient_list_read', actorUid: actor.uid, actorRole: actor.role,
      hospitalId: actor.hospitalId, patientIds: patients.docs.map((snapshot) => snapshot.id),
      timestamp: FieldValue.serverTimestamp(),
    });
    return patients.docs.map((snapshot) => patientCard(snapshot.data()));
  });
}

async function getDashboardPatient(request, db) {
  const hrid = request.data && request.data.hrid;
  if (typeof hrid !== 'string' || !/^HDW-\d{8}-[A-Z0-9]{8}$/.test(hrid)) {
    throw new HttpsError('invalid-argument', 'Invalid patient identifier.');
  }
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    const patientRef = db.collection('dashboardPatients').doc(hrid);
    const patientSnapshot = await tx.get(patientRef);
    if (!patientSnapshot.exists || patientSnapshot.data().status === 'inactive') {
      throw new HttpsError('permission-denied', 'Patient access denied.');
    }
    const patient = patientSnapshot.data();
    const accessScope = await patientScope(tx, db, actor, hrid, patient);
    const auditRef = db.collection('dashboardAudit').doc();
    tx.create(auditRef, {
      action: 'patient_profile_read', actorUid: actor.uid, actorRole: actor.role,
      hospitalId: actor.hospitalId || null, patientId: hrid, accessScope,
      timestamp: FieldValue.serverTimestamp(),
    });
    if (actor.role === 'PCC') return { ...patientCard(patient), hasAccount: !!patient.authUid };
    return {
      ...patientCard(patient), phone: patient.phone || '',
      ...(actor.role === 'PATIENT' ? {
        address: patient.address || '', emergencyName: patient.emergencyName || '',
        emergencyPhone: patient.emergencyPhone || '',
      } : {}),
      // Clinicians see the reasons behind the flag and age-based suggestions; everyone else only sees that it is set.
      ...(['NURSE', 'DOCTOR'].includes(actor.role) ? {
        priorityCareCategories: (patient.priorityCare && patient.priorityCare.categories) || [],
        suggestedPriorityCategories: suggestedCategories(patient.dob),
      } : {}),
    };
  });
}

async function requestCrossHospitalAccess(request, db, sendMail) {
  if (!request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { hrid, reason } = request.data || {};
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (typeof hrid !== 'string' || !HRID.test(hrid) || text.length < 10 || text.length > 500) {
    throw new HttpsError('invalid-argument', 'A patient identifier and a reason of 10-500 characters are required.');
  }
  const result = await db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (!CLINICAL.includes(actor.role)) throw new HttpsError('permission-denied', 'Patient access denied.');
    const patientSnapshot = await tx.get(db.collection('dashboardPatients').doc(hrid));
    if (!patientSnapshot.exists || patientSnapshot.data().status === 'inactive' ||
        patientSnapshot.data().hospitalId === actor.hospitalId) {
      throw new HttpsError('permission-denied', 'Patient access denied.');
    }
    const patient = patientSnapshot.data();
    const timestamp = FieldValue.serverTimestamp();
    const expiresAt = Timestamp.fromMillis(Date.now() + GRANT_MS);
    tx.set(db.collection('dashboardAccessGrants').doc(actor.uid + '_' + hrid), {
      actorUid: actor.uid, hospitalId: actor.hospitalId, patientId: hrid, reason: text,
      owningHospitalId: patient.hospitalId, createdAt: timestamp, expiresAt,
    });
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'cross_hospital_access_granted', actorUid: actor.uid, actorRole: actor.role,
      hospitalId: actor.hospitalId, owningHospitalId: patient.hospitalId, patientId: hrid,
      reason: text, expiresAt, timestamp,
    });
    const notificationRef = db.collection('dashboardNotifications').doc();
    tx.create(notificationRef, {
      patientId: hrid, type: 'cross_hospital_access', viewingHospitalId: actor.hospitalId,
      reason: text, emailStatus: patient.email ? 'pending' : 'no_email', read: false, createdAt: timestamp,
    });
    return {
      hrid, expiresAt: expiresAt.toMillis(), notificationPath: notificationRef.path,
      email: patient.email || null, viewingHospitalId: actor.hospitalId,
    };
  });
  if (result.email && sendMail) {
    let delivered = false;
    try {
      await sendMail({
        to: result.email,
        subject: 'CareVault: your health record was accessed',
        text: 'A care team at hospital ' + result.viewingHospitalId +
          ' accessed your health record. Reason: ' + text +
          '\n\nAccess expires at ' + new Date(result.expiresAt).toISOString() + '.\n',
      });
      delivered = true;
    } catch (error) {
      logger.warn('Patient access notification email failed', {
        notificationId: result.notificationPath.split('/').pop(), code: error.code || error.name,
      });
      try {
        await db.doc(result.notificationPath).update({ emailStatus: 'failed' });
      } catch (updateError) {
        logger.error('Failed to record patient notification email failure', {
          notificationId: result.notificationPath.split('/').pop(), code: updateError.code || updateError.name,
        });
      }
    }
    if (delivered) {
      try {
        await db.doc(result.notificationPath).update({ emailStatus: 'sent' });
      } catch (error) {
        logger.error('Failed to record patient notification email delivery', {
          notificationId: result.notificationPath.split('/').pop(), code: error.code || error.name,
        });
      }
    }
  }
  return { hrid: result.hrid, expiresAt: result.expiresAt };
}

async function getPatientNotifications(request, db) {
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (actor.role !== 'PATIENT') throw new HttpsError('permission-denied', 'Notification access denied.');
    const snapshot = await tx.get(db.collection('dashboardNotifications')
      .where('patientId', '==', actor.patientId).orderBy('createdAt', 'desc').limit(50));
    return snapshot.docs.map((doc) => {
      const { type, viewingHospitalId, reason, createdAt } = doc.data();
      return { id: doc.id, type, viewingHospitalId, reason, createdAt: createdAt.toMillis() };
    });
  });
}

module.exports = {
  activeActor, patientScope, patientCard, phoneKeyOf, abhaKeyOf, nameKeyOf, HRID,
  requestCrossHospitalAccess, getPatientNotifications, getDashboardIdentity, registerDashboardPatient, getPccPatients, getDashboardPatient,
};
