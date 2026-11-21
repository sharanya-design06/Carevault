const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { activeActor, patientScope } = require('./dashboard-registration');
const { QUEUE_RANK, UNTRIAGED_RANK, computeBmi, checkedTriage, checkedPriorityCare } = require('./dashboard-triage');

const CLINICAL = ['DOCTOR', 'LAB', 'PHARMACIST', 'NURSE'];
const HRID = /^HDW-\d{8}-[A-Z0-9]{8}$/;
const bad = () => new HttpsError('invalid-argument', 'Invalid request.');
const denied = () => new HttpsError('permission-denied', 'Patient access denied.');

// Which record types each role may write, and which it may read.
const WRITES = { NURSE: ['vitals', 'triage'], DOCTOR: ['diagnosis', 'prescription'] };
const READS = { DOCTOR: ['vitals', 'triage', 'diagnosis', 'prescription'], NURSE: ['vitals', 'triage'], PHARMACIST: ['prescription'], LAB: [], PATIENT: ['vitals', 'diagnosis', 'prescription'] };
const VITALS = {
  temp: [30, 45], pulse: [20, 250], bpSys: [50, 260], bpDia: [30, 160], spo2: [50, 100],
  rr: [4, 80], weightKg: [0.3, 500], heightCm: [30, 250], pain: [0, 10],
};

const text = (value, max, required = true) => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw bad();
  return value.trim();
};
const exactKeys = (data, allowed) => {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some((k) => !allowed.includes(k))) throw bad();
};

function checkedRecord(type, data) {
  if (type === 'vitals') {
    exactKeys(data, Object.keys(VITALS));
    const out = {};
    for (const [key, [min, max]] of Object.entries(VITALS)) {
      if (data[key] === undefined) continue;
      if (typeof data[key] !== 'number' || !Number.isFinite(data[key]) || data[key] < min || data[key] > max) throw bad();
      out[key] = data[key];
    }
    if (!Object.keys(out).length) throw bad();
    if (out.pain !== undefined && !Number.isInteger(out.pain)) throw bad();
    return out;
  }
  if (type === 'triage') return checkedTriage(data);
  if (type === 'diagnosis') {
    exactKeys(data, ['condition', 'notes']);
    return { condition: text(data.condition, 200), notes: text(data.notes, 1000, false) };
  }
  if (type === 'prescription') {
    exactKeys(data, ['drug', 'dose', 'frequency', 'days']);
    if (!Number.isInteger(data.days) || data.days < 1 || data.days > 365) throw bad();
    return { drug: text(data.drug, 120), dose: text(data.dose, 60), frequency: text(data.frequency, 60), days: data.days };
  }
  throw bad();
}

const hridOf = (data) => {
  const hrid = data && data.hrid;
  if (typeof hrid !== 'string' || !HRID.test(hrid)) throw bad();
  return hrid;
};

async function patientFor(tx, db, hrid) {
  const snapshot = await tx.get(db.collection('dashboardPatients').doc(hrid));
  if (!snapshot.exists || snapshot.data().status === 'inactive') throw denied();
  return snapshot.data();
}

// PCC assigns (or ends) a clinician's care of a patient in the same hospital. This is the only way care access is created.
async function assignPatientCare(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const hrid = hridOf(request.data);
  const { uid, status = 'active' } = request.data;
  if (typeof uid !== 'string' || !uid || uid.includes('/') || !['active', 'ended'].includes(status)) throw bad();
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (actor.role !== 'PCC') throw denied();
    const patient = await patientFor(tx, db, hrid);
    const target = await tx.get(db.collection('dashboardUsers').doc(uid));
    if (patient.hospitalId !== actor.hospitalId || !target.exists || target.data().status !== 'active' ||
        !CLINICAL.includes(target.data().role) || target.data().hospitalId !== actor.hospitalId) throw denied();
    tx.set(db.collection('dashboardCare').doc(uid).collection('patients').doc(hrid), {
      status, hospitalId: actor.hospitalId, patientId: hrid, assignedBy: actor.uid, updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(db.collection('dashboardAudit').doc(), {
      action: status === 'active' ? 'care_assigned' : 'care_ended', actorUid: actor.uid, actorRole: actor.role,
      hospitalId: actor.hospitalId, patientId: hrid, targetUid: uid, timestamp: FieldValue.serverTimestamp(),
    });
    return { hrid, uid, status };
  });
}

// The worklist is sorted by triage priority, then Priority Care patients first, then longest waiting.
async function listMyPatients(request, db) {
  const actor = await db.runTransaction((tx) => activeActor(request, db, tx));
  if (!CLINICAL.includes(actor.role)) throw denied();
  const care = await db.collection('dashboardCare').doc(actor.uid).collection('patients')
    .where('status', '==', 'active').limit(100).get();
  const cards = await Promise.all(care.docs.filter((d) => d.get('hospitalId') === actor.hospitalId).map(async (doc) => {
    const patient = await db.collection('dashboardPatients').doc(doc.id).get();
    if (!patient.exists || patient.get('status') === 'inactive') return null;
    const encounters = await db.collection('dashboardEncounters').where('patientId', '==', doc.id)
      .where('hospitalId', '==', actor.hospitalId).where('status', '==', 'open').limit(1).get();
    const encounter = encounters.empty ? null : encounters.docs[0];
    const { hrid, name, dob, gender } = patient.data();
    const queuePriority = encounter && encounter.get('queuePriority') || null;
    const since = encounter && (encounter.get('triagedAt') || encounter.get('createdAt'));
    return {
      hrid, name, dob, gender, queuePriority, priorityCare: patient.get('priorityCare.active') === true,
      waitingSince: since && since.toMillis ? since.toMillis() : null,
    };
  }));
  return cards.filter(Boolean).sort((a, b) =>
    (QUEUE_RANK[a.queuePriority] || UNTRIAGED_RANK) - (QUEUE_RANK[b.queuePriority] || UNTRIAGED_RANK) ||
    Number(b.priorityCare) - Number(a.priorityCare) ||
    (a.waitingSince || Infinity) - (b.waitingSince || Infinity));
}

// The neutral Priority Care flag. The PCC and clinicians set it; only clinicians can read the reasons behind it.
async function setPriorityCare(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const hrid = hridOf(request.data);
  const value = checkedPriorityCare(request.data);
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (!['PCC', 'NURSE', 'DOCTOR'].includes(actor.role)) throw denied();
    const patient = await patientFor(tx, db, hrid);
    const scope = await patientScope(tx, db, actor, hrid, patient);
    if (actor.role !== 'PCC' && scope !== 'care') throw denied();
    const timestamp = FieldValue.serverTimestamp();
    tx.update(db.collection('dashboardPatients').doc(hrid), {
      priorityCare: { ...value, setBy: actor.uid, setByRole: actor.role, setAt: timestamp },
    });
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'priority_care_set', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
      patientId: hrid, active: value.active, timestamp,
    });
    return { hrid, active: value.active };
  });
}

async function addClinicalRecord(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const hrid = hridOf(request.data);
  const { type } = request.data;
  const content = checkedRecord(type, request.data.data);
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (!(WRITES[actor.role] || []).includes(type)) throw denied();
    const patient = await patientFor(tx, db, hrid);
    // Records may only be written under a care relationship, never under a cross-hospital view grant.
    if ((await patientScope(tx, db, actor, hrid, patient)) !== 'care') throw denied();
    // Every record belongs to the patient's open encounter at the author's hospital.
    const open = await tx.get(db.collection('dashboardEncounters').where('patientId', '==', hrid)
      .where('hospitalId', '==', actor.hospitalId).where('status', '==', 'open').limit(1));
    if (open.empty) throw new HttpsError('failed-precondition', 'Open an encounter for this patient first.');
    let stored = content;
    if (type === 'vitals') {
      const hospital = await tx.get(db.collection('dashboardHospitals').doc(actor.hospitalId));
      stored = { ...content, ...computeBmi(content, patient.dob, hospital.get('bmiPolicy')) };
    }
    const ref = db.collection('dashboardRecords').doc();
    const timestamp = FieldValue.serverTimestamp();
    if (type === 'triage') {
      // Completing triage puts the patient in the doctor's priority-sorted worklist.
      tx.update(open.docs[0].ref, { queuePriority: content.queuePriority, triagedAt: timestamp });
    }
    tx.create(ref, {
      patientId: hrid, encounterId: open.docs[0].id, hospitalId: actor.hospitalId, type, data: stored, sensitive: true,
      ...(type === 'prescription' ? { status: 'pending' } : {}),
      authorUid: actor.uid, authorRole: actor.role, createdAt: timestamp,
    });
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'record_added', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
      patientId: hrid, encounterId: open.docs[0].id, recordId: ref.id, recordType: type, timestamp,
    });
    return { id: ref.id, ...(type === 'vitals' && stored.bmi !== undefined
      ? { bmi: stored.bmi, bmiCategory: stored.bmiCategory, bmiBasis: stored.bmiBasis } : {}) };
  });
}

async function listClinicalRecords(request, db) {
  const hrid = hridOf(request.data);
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    const types = READS[actor.role];
    if (!types) throw denied();
    const patient = await patientFor(tx, db, hrid);
    const scope = await patientScope(tx, db, actor, hrid, patient);
    // A merged patient's history includes the records of the retired duplicates, each still under its original ID.
    const snapshot = await tx.get(db.collection('dashboardRecords').where('patientId', 'in', [hrid, ...(patient.mergedFrom || [])])
      .orderBy('createdAt', 'desc').limit(100));
    const records = snapshot.docs.filter((doc) => types.includes(doc.get('type')));
    const sensitiveRecords = records.filter((doc) => doc.get('sensitive') === true);
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'records_read', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId || null,
      patientId: hrid, accessScope: scope, timestamp: FieldValue.serverTimestamp(),
    });
    if (sensitiveRecords.length) {
      tx.create(db.collection('dashboardAudit').doc(), {
        action: 'sensitive_record_read', actorUid: actor.uid, actorRole: actor.role,
        hospitalId: patient.hospitalId, viewerHospitalId: actor.hospitalId || null,
        patientId: hrid, recordIds: sensitiveRecords.map((doc) => doc.id),
        recordTypes: [...new Set(sensitiveRecords.map((doc) => doc.get('type')))],
        accessScope: scope, timestamp: FieldValue.serverTimestamp(),
      });
    }
    return records.map((doc) => {
      const { type, data, status, authorRole, createdAt, encounterId, hospitalId } = doc.data();
      return {
        id: doc.id, encounterId: encounterId || null, hospitalId, type, data, status: status || null, authorRole,
        sensitive: doc.get('sensitive') === true, createdAt: createdAt.toMillis(),
      };
    });
  });
}

async function dispensePrescription(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { recordId } = request.data || {};
  if (typeof recordId !== 'string' || !recordId || recordId.includes('/')) throw bad();
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (actor.role !== 'PHARMACIST') throw denied();
    const ref = db.collection('dashboardRecords').doc(recordId);
    const record = await tx.get(ref);
    if (!record.exists || record.data().type !== 'prescription') throw denied();
    const patient = await patientFor(tx, db, record.data().patientId);
    if ((await patientScope(tx, db, actor, record.data().patientId, patient)) !== 'care') throw denied();
    if (record.data().status !== 'pending') throw new HttpsError('failed-precondition', 'Prescription already processed.');
    const timestamp = FieldValue.serverTimestamp();
    tx.update(ref, { status: 'dispensed', dispensedBy: actor.uid, dispensedAt: timestamp });
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'prescription_dispensed', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
      patientId: record.data().patientId, recordId, timestamp,
    });
    return { id: recordId, status: 'dispensed' };
  });
}

module.exports = {
  assignPatientCare, listMyPatients, addClinicalRecord, listClinicalRecords, dispensePrescription, setPriorityCare,
};
