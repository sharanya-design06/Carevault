const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { resolveDashboardIdentity } = require('./dashboard-identity');
const { createHash } = require('node:crypto');
const { issueInvitation } = require('./dashboard-invitations');

const SUBTYPES = {
  DOCTOR: ['GENERAL_PRIMARY', 'SPECIALIST', 'SURGEON', 'RADIOLOGIST', 'PATHOLOGIST', 'ANESTHETIST'],
  LAB: ['SAMPLE_PHLEBOTOMY', 'PATHOLOGY_BIOCHEMISTRY', 'RADIOLOGY', 'MICROBIOLOGY'],
};
// Roles each actor may create; hospital-scoped actors only within their own hospital.
const CREATABLE = {
  SYSTEM_ADMIN: ['SYSTEM_ADMIN', 'HOSPITAL_ADMIN'],
  HOSPITAL_ADMIN: ['PCC', 'DOCTOR', 'LAB', 'PHARMACIST', 'NURSE'],
  PCC: ['DOCTOR', 'LAB', 'PHARMACIST', 'NURSE'],
};
const FIELDS = new Set(['email', 'role', 'hospitalId', 'subType', 'name', 'username']);
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const LOOKUP_WINDOW_MS = 60 * 1000;
const LOOKUP_MAX_REQUESTS = 10;

const bad = () => new HttpsError('invalid-argument', 'Invalid account details.');
const denied = () => new HttpsError('permission-denied', 'Account management denied.');

async function limitUsernameLookup(request, db) {
  const raw = request.rawRequest;
  const ip = raw && (raw.ip || (raw.socket && raw.socket.remoteAddress));
  if (typeof ip !== 'string' || !ip || ip.length > 64) {
    throw new HttpsError('unavailable', 'Sign-in lookup is temporarily unavailable.');
  }
  const windowStart = Math.floor(Date.now() / LOOKUP_WINDOW_MS) * LOOKUP_WINDOW_MS;
  const key = createHash('sha256').update(ip).digest('hex') + '_' + windowStart;
  const ref = db.collection('dashboardLookupRateLimits').doc(key);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const count = snapshot.exists ? snapshot.get('count') : 0;
    if (count >= LOOKUP_MAX_REQUESTS) {
      throw new HttpsError('resource-exhausted', 'Too many username sign-in attempts. Try again in a minute.');
    }
    const value = {
      count: count + 1,
      expiresAt: new Date(windowStart + 2 * LOOKUP_WINDOW_MS),
    };
    if (snapshot.exists) tx.update(ref, value);
    else tx.create(ref, value);
  });
}

function checkedUser(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).some((key) => !FIELDS.has(key)) ||
      typeof data.email !== 'string' || data.email.length > 254 || !EMAIL.test(data.email) ||
      typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 120 ||
      typeof data.role !== 'string') throw bad();
  if (data.username !== undefined && (typeof data.username !== 'string' || !USERNAME.test(data.username))) throw bad();
  const subtypes = SUBTYPES[data.role];
  if (subtypes ? !subtypes.includes(data.subType) : data.subType !== undefined) throw bad();
  return { ...data, email: data.email.toLowerCase(), name: data.name.trim() };
}

async function actorFor(request, db) {
  return db.runTransaction((tx) => resolveDashboardIdentity(request, db, tx));
}

async function activeHospital(db, hospitalId) {
  const hospital = await db.collection('dashboardHospitals').doc(hospitalId).get();
  if (!hospital.exists || hospital.data().status !== 'active') throw bad();
}

async function createDashboardUser(request, db, auth) {
  const actor = await actorFor(request, db);
  const input = checkedUser(request.data);
  if (!(CREATABLE[actor.role] || []).includes(input.role)) throw denied();
  const staff = input.role !== 'SYSTEM_ADMIN';
  if (staff) {
    if (typeof input.hospitalId !== 'string' || !input.hospitalId || input.hospitalId.includes('/')) throw bad();
    if (actor.role !== 'SYSTEM_ADMIN' && input.hospitalId !== actor.hospitalId) throw denied();
    await activeHospital(db, input.hospitalId);
  } else if (input.hospitalId !== undefined) throw bad();

  const claims = {
    role: input.role,
    ...(staff ? { hospitalId: input.hospitalId } : {}),
    ...(input.subType ? { subType: input.subType } : {}),
  };
  let user;
  try {
    user = await auth.createUser({ email: input.email, displayName: input.name, emailVerified: false });
  } catch (error) {
    if (error.code === 'auth/email-already-exists') throw new HttpsError('already-exists', 'Email already in use.');
    throw error;
  }
  try {
    await auth.setCustomUserClaims(user.uid, claims);
    const batch = db.batch();
    batch.create(db.collection('dashboardUsers').doc(user.uid), {
      ...claims, name: input.name, email: input.email, status: 'active',
      ...(input.username ? { username: input.username } : {}),
      createdBy: actor.uid, createdAt: FieldValue.serverTimestamp(),
    });
    if (input.username) batch.create(db.collection('dashboardUsernames').doc(input.username), { uid: user.uid });
    batch.create(db.collection('dashboardAudit').doc(), {
      action: 'user_created', actorUid: actor.uid, actorRole: actor.role,
      hospitalId: input.hospitalId || null, targetUid: user.uid, targetRole: input.role,
      timestamp: FieldValue.serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    await auth.deleteUser(user.uid);
    if (error.code === 6) throw new HttpsError('already-exists', 'Username already in use.');
    throw error;
  }
  return { uid: user.uid, role: input.role };
}

async function setDashboardUserStatus(request, db, auth) {
  const actor = await actorFor(request, db);
  const { uid, status } = request.data || {};
  if (typeof uid !== 'string' || !uid || uid.includes('/') || !['active', 'inactive'].includes(status)) throw bad();
  if (uid === actor.uid) throw denied();
  const ref = db.collection('dashboardUsers').doc(uid);
  const target = await ref.get();
  if (!target.exists) throw denied();
  const { role, hospitalId } = target.data();
  const allowed = (CREATABLE[actor.role] || []).includes(role) &&
    (actor.role === 'SYSTEM_ADMIN' || hospitalId === actor.hospitalId);
  if (!allowed) throw denied();
  if (status === 'active' && actor.role === 'PCC') throw denied();
  await ref.update({ status });
  await auth.updateUser(uid, { disabled: status === 'inactive' });
  if (status === 'inactive') await auth.revokeRefreshTokens(uid);
  await db.collection('dashboardAudit').add({
    action: 'user_status_changed', actorUid: actor.uid, actorRole: actor.role,
    hospitalId: hospitalId || null, targetUid: uid, status, timestamp: FieldValue.serverTimestamp(),
  });
  return { uid, status };
}

const SITE = 'https://care-vault-project.web.app';

// Sends a Firebase password-setup link to the address registered for the account, never to a caller-chosen one.
async function sendDashboardInvite(request, db, auth, sendMail) {
  const actor = await actorFor(request, db);
  const { uid } = request.data || {};
  if (typeof uid !== 'string' || !uid || uid.includes('/')) throw bad();
  const target = await db.collection('dashboardUsers').doc(uid).get();
  if (!target.exists) throw denied();
  const { role, hospitalId, email, name, status, registeredHospitalId } = target.data();
  const allowed = ((CREATABLE[actor.role] || []).includes(role) &&
    (actor.role === 'SYSTEM_ADMIN' || hospitalId === actor.hospitalId)) ||
    (role === 'PATIENT' && actor.role === 'PCC' && registeredHospitalId === actor.hospitalId);
  if (!allowed || status !== 'active') throw denied();
  const { token, expiresAt } = await issueInvitation(db, uid);
  const link = SITE + '/set-password/?token=' + encodeURIComponent(token);
  await db.collection('dashboardAudit').add({
    action: 'invite_sent', actorUid: actor.uid, actorRole: actor.role,
    hospitalId: hospitalId || null, targetUid: uid, timestamp: FieldValue.serverTimestamp(),
  });
  try {
    await sendMail({
      to: email, subject: 'Your CareVault account',
      text: 'Hello ' + name + ',\n\nUse this link to set your password and sign in. It can be used once and expires at ' +
        new Date(expiresAt).toUTCString() + ' (5 minutes after this email was sent):\n\n' + link +
        '\n\nIf you did not expect this email, ignore it.\n',
    });
  } catch (error) {
    throw new HttpsError('unavailable', 'The invitation email could not be sent.');
  }
  return { sent: true };
}

// Maps a username to its sign-in email. Unknown usernames get a stable decoy so the response shape is identical.
async function lookupLoginEmail(request, db) {
  const identifier = request.data && request.data.identifier;
  if (typeof identifier !== 'string' || identifier.length > 254) throw bad();
  const id = identifier.trim().toLowerCase();
  if (id.includes('@')) return { email: id };
  await limitUsernameLookup(request, db);
  const decoy = { email: id.replace(/[^a-z0-9._-]/g, '').slice(0, 32) + '@unknown.invalid' };
  if (!USERNAME.test(id)) return decoy;
  const name = await db.collection('dashboardUsernames').doc(id).get();
  if (!name.exists) return decoy;
  const user = await db.collection('dashboardUsers').doc(name.data().uid).get();
  return user.exists && user.data().status === 'active' ? { email: user.data().email } : decoy;
}

// Lists only the accounts this actor is allowed to manage.
async function listDashboardUsers(request, db) {
  const actor = await actorFor(request, db);
  const roles = CREATABLE[actor.role];
  if (!roles) throw denied();
  const query = actor.role === 'SYSTEM_ADMIN'
    ? db.collection('dashboardUsers').where('role', 'in', roles)
    : db.collection('dashboardUsers').where('hospitalId', '==', actor.hospitalId);
  const snapshot = await query.limit(500).get();
  return snapshot.docs.filter((doc) => roles.includes(doc.get('role'))).map((doc) => {
    const { name, email, role, subType, status, username, hospitalId } = doc.data();
    return { uid: doc.id, name, email, role, subType: subType || null, status, username: username || null, hospitalId: hospitalId || null };
  });
}

module.exports = { listDashboardUsers, createDashboardUser, setDashboardUserStatus, sendDashboardInvite, lookupLoginEmail };
