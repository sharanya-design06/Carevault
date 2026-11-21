const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { resolveDashboardIdentity } = require('./dashboard-identity');
const { activeActor } = require('./dashboard-registration');

const CODE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const FIELDS = ['name', 'code', 'licenseNo', 'phone', 'address', 'city', 'country'];
const bad = () => new HttpsError('invalid-argument', 'Invalid hospital details.');
const denied = () => new HttpsError('permission-denied', 'Hospital management denied.');

const actorFor = (request, db) => db.runTransaction((tx) => resolveDashboardIdentity(request, db, tx));

function summary(id, data) {
  const { name, code, licenseNo, phone, address, city, country, status } = data;
  return { id, name, code, licenseNo, phone, address, city, country, status };
}

async function createDashboardHospital(request, db) {
  const actor = await actorFor(request, db);
  if (actor.role !== 'SYSTEM_ADMIN') throw denied();
  const input = request.data;
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !FIELDS.includes(key)) ||
      FIELDS.some((key) => typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 120)) throw bad();
  const code = input.code.trim().toLowerCase();
  if (!CODE.test(code)) throw bad();
  const hospital = { status: 'active', createdBy: actor.uid, createdAt: FieldValue.serverTimestamp() };
  FIELDS.forEach((key) => { hospital[key] = input[key].trim(); });
  hospital.code = code;
  const batch = db.batch();
  batch.create(db.collection('dashboardHospitals').doc(code), hospital);
  batch.create(db.collection('dashboardAudit').doc(), {
    action: 'hospital_created', actorUid: actor.uid, actorRole: actor.role, hospitalId: code,
    timestamp: FieldValue.serverTimestamp(),
  });
  try {
    await batch.commit();
  } catch (error) {
    if (error.code === 6) throw new HttpsError('already-exists', 'Hospital code already in use.');
    throw error;
  }
  return { id: code };
}

async function listDashboardHospitals(request, db) {
  const actor = await actorFor(request, db);
  if (actor.role === 'HOSPITAL_ADMIN') {
    const own = await db.collection('dashboardHospitals').doc(actor.hospitalId).get();
    return own.exists ? [summary(own.id, own.data())] : [];
  }
  if (actor.role !== 'SYSTEM_ADMIN') throw denied();
  const snapshot = await db.collection('dashboardHospitals').limit(500).get();
  return snapshot.docs.map((doc) => summary(doc.id, doc.data()));
}

// Deactivating a hospital also deactivates its users; reactivating restores only its Hospital Admins.
async function setDashboardHospitalStatus(request, db, auth) {
  const actor = await actorFor(request, db);
  if (actor.role !== 'SYSTEM_ADMIN') throw denied();
  const { id, status } = request.data || {};
  if (typeof id !== 'string' || !id || id.includes('/') || !['active', 'inactive'].includes(status)) throw bad();
  const ref = db.collection('dashboardHospitals').doc(id);
  if (!(await ref.get()).exists) throw denied();
  await ref.update({ status });
  const users = await db.collection('dashboardUsers').where('hospitalId', '==', id).limit(500).get();
  const targets = users.docs.filter((doc) => status === 'inactive'
    ? doc.get('status') === 'active'
    : doc.get('status') === 'inactive' && doc.get('role') === 'HOSPITAL_ADMIN');
  for (const doc of targets) {
    await doc.ref.update({ status });
    await auth.updateUser(doc.id, { disabled: status === 'inactive' });
    if (status === 'inactive') await auth.revokeRefreshTokens(doc.id);
  }
  await db.collection('dashboardAudit').add({
    action: 'hospital_status_changed', actorUid: actor.uid, actorRole: actor.role, hospitalId: id, status,
    usersAffected: targets.length, timestamp: FieldValue.serverTimestamp(),
  });
  return { id, status, usersAffected: targets.length };
}

// System Admin sees all events; Hospital Admin sees only their own hospital's.
async function listDashboardAudit(request, db) {
  const actor = await actorFor(request, db);
  if (actor.role !== 'SYSTEM_ADMIN' && actor.role !== 'HOSPITAL_ADMIN') throw denied();
  const base = db.collection('dashboardAudit');
  const query = actor.role === 'SYSTEM_ADMIN' ? base : base.where('hospitalId', '==', actor.hospitalId);
  const snapshot = await query.orderBy('timestamp', 'desc').limit(100).get();
  return snapshot.docs.map((doc) => {
    const { action, actorRole, hospitalId, targetRole, status, accessScope, timestamp } = doc.data();
    return {
      id: doc.id, action, actorRole, hospitalId: hospitalId || null, targetRole: targetRole || null,
      status: status || null, accessScope: accessScope || null,
      timestamp: timestamp && timestamp.toDate ? timestamp.toDate().toISOString() : null,
    };
  });
}

// Every active hospital staff role can inspect read events for sensitive records owned by their hospital.
async function listSensitiveAudit(request, db) {
  const actor = await db.runTransaction((tx) => activeActor(request, db, tx));
  if (!['HOSPITAL_ADMIN', 'PCC', 'DOCTOR', 'LAB', 'PHARMACIST', 'NURSE'].includes(actor.role)) throw denied();
  const snapshot = await db.collection('dashboardAudit')
    .where('hospitalId', '==', actor.hospitalId)
    .where('action', '==', 'sensitive_record_read')
    .orderBy('timestamp', 'desc')
    .limit(100).get();
  return snapshot.docs.map((doc) => {
    const { actorUid, actorRole, viewerHospitalId, patientId, recordTypes, accessScope, timestamp } = doc.data();
    return {
      id: doc.id, actorUid, actorRole, viewerHospitalId: viewerHospitalId || null,
      patientId, recordTypes: recordTypes || [], accessScope,
      timestamp: timestamp && timestamp.toDate ? timestamp.toDate().toISOString() : null,
    };
  });
}

// BMI category cut-offs follow hospital policy: WHO adult cut-offs by default, Asia-Pacific optional.
async function setHospitalBmiPolicy(request, db) {
  const actor = await actorFor(request, db);
  const { policy, hospitalId } = request.data || {};
  if (!['WHO', 'ASIA_PACIFIC'].includes(policy)) throw bad();
  const target = actor.role === 'SYSTEM_ADMIN' ? hospitalId : actor.hospitalId;
  if (!['SYSTEM_ADMIN', 'HOSPITAL_ADMIN'].includes(actor.role) || typeof target !== 'string' || !target || target.includes('/')) throw denied();
  const ref = db.collection('dashboardHospitals').doc(target);
  if (!(await ref.get()).exists) throw denied();
  await ref.update({ bmiPolicy: policy });
  await db.collection('dashboardAudit').add({
    action: 'bmi_policy_changed', actorUid: actor.uid, actorRole: actor.role, hospitalId: target, status: policy,
    timestamp: FieldValue.serverTimestamp(),
  });
  return { hospitalId: target, policy };
}

module.exports = {
  createDashboardHospital, listDashboardHospitals, setDashboardHospitalStatus, listDashboardAudit, listSensitiveAudit,
  setHospitalBmiPolicy,
};
