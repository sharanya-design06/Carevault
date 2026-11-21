const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { createHash, randomBytes } = require('node:crypto');

const INVITE_TTL_MS = 5 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hashOf = (token) => createHash('sha256').update(token).digest('hex');
const invalid = () => new HttpsError('failed-precondition', 'This link is invalid or has expired.');

// Only the SHA-256 of the token is stored, so a database read cannot reveal a usable link.
// A newer invitation for the same account supersedes any earlier unused one.
async function issueInvitation(db, uid) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const stale = await db.collection('dashboardInvitations').where('uid', '==', uid).where('used', '==', false).limit(50).get();
  const batch = db.batch();
  stale.forEach((doc) => batch.update(doc.ref, { used: true, supersededAt: FieldValue.serverTimestamp() }));
  batch.create(db.collection('dashboardInvitations').doc(hashOf(token)), {
    uid, used: false, createdAt: Timestamp.fromMillis(now), expiresAt: Timestamp.fromMillis(now + INVITE_TTL_MS),
  });
  await batch.commit();
  return { token, expiresAt: now + INVITE_TTL_MS };
}

function tokenOf(request) {
  const token = request.data && request.data.token;
  if (typeof token !== 'string' || !TOKEN.test(token)) throw invalid();
  return token;
}

const usable = (invitation) => invitation.exists && !invitation.get('used') && invitation.get('expiresAt').toMillis() > Date.now();

async function activeTarget(db, auth, uid) {
  const user = await db.collection('dashboardUsers').doc(uid).get();
  if (!user.exists || user.get('status') !== 'active') throw invalid();
  return { user: user.data(), record: await auth.getUser(uid) };
}

async function checkDashboardInvite(request, db, auth) {
  const invitation = await db.collection('dashboardInvitations').doc(hashOf(tokenOf(request))).get();
  if (!usable(invitation)) throw invalid();
  const { record } = await activeTarget(db, auth, invitation.get('uid'));
  return { email: record.email };
}

async function completeDashboardInvite(request, db, auth) {
  const token = tokenOf(request);
  const password = request.data.password;
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new HttpsError('invalid-argument', 'Choose a password of 12 to 128 characters.');
  }
  const ref = db.collection('dashboardInvitations').doc(hashOf(token));
  // The token is consumed first, so two concurrent submissions cannot both succeed.
  const uid = await db.runTransaction(async (tx) => {
    const invitation = await tx.get(ref);
    if (!usable(invitation)) throw invalid();
    tx.update(ref, { used: true, usedAt: FieldValue.serverTimestamp() });
    return invitation.get('uid');
  });
  const { user } = await activeTarget(db, auth, uid);
  try {
    await auth.updateUser(uid, { password, emailVerified: true });
  } catch (error) {
    await ref.update({ used: false, usedAt: FieldValue.delete() });
    if (String(error.code).startsWith('auth/invalid-password')) {
      throw new HttpsError('invalid-argument', 'Choose a stronger password.');
    }
    throw error;
  }
  await db.collection('dashboardAudit').add({
    action: 'invite_completed', actorUid: uid, actorRole: user.role,
    hospitalId: user.hospitalId || null, targetUid: uid, timestamp: FieldValue.serverTimestamp(),
  });
  return { done: true };
}

module.exports = { INVITE_TTL_MS, issueInvitation, checkDashboardInvite, completeDashboardInvite };
