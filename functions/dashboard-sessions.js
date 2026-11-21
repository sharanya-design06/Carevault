const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { FieldValue } = require('firebase-admin/firestore');
const { createHash } = require('node:crypto');

const DEVICE_ID = /^[a-f0-9]{32}$/;

// Signs the caller out everywhere: refresh tokens are revoked, and every ID token issued before now is refused by the
// dashboard callables straight away rather than at its hourly expiry. Works for any signed-in account, including one
// that has not finished the second factor, so sign-out can never be blocked.
async function revokeMySessions(request, db, auth) {
  if (!request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const uid = request.auth.uid;
  const ref = db.collection('dashboardUsers').doc(uid);
  const user = await ref.get();
  await auth.revokeRefreshTokens(uid);
  if (!user.exists) return { revoked: true };
  await ref.update({ sessionsValidAfter: FieldValue.serverTimestamp() });
  await db.collection('dashboardAudit').add({
    action: 'sessions_revoked', actorUid: uid, actorRole: user.get('role'), hospitalId: user.get('hospitalId') || user.get('registeredHospitalId') || null,
    timestamp: FieldValue.serverTimestamp(),
  });
  return { revoked: true };
}

// Remembers which browsers an account has signed in from. A first sign-in from a new browser is audited so a hospital
// admin (or the patient's own access history) can spot an unfamiliar device. Only a hash of the random browser id is kept.
async function recordDevice(db, actor, deviceId) {
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return { newDevice: false };
  const key = createHash('sha256').update(deviceId).digest('hex').slice(0, 32);
  const ref = db.collection('dashboardDevices').doc(actor.uid + '__' + key);
  try {
    return await db.runTransaction(async (tx) => {
      const seen = await tx.get(ref);
      const now = FieldValue.serverTimestamp();
      if (seen.exists) { tx.update(ref, { lastSeenAt: now, signIns: FieldValue.increment(1) }); return { newDevice: false }; }
      const hospitalId = actor.hospitalId || null;
      tx.create(ref, { uid: actor.uid, role: actor.role, hospitalId, firstSeenAt: now, lastSeenAt: now, signIns: 1 });
      tx.create(db.collection('dashboardAudit').doc(), {
        action: 'new_device_sign_in', actorUid: actor.uid, actorRole: actor.role, hospitalId, timestamp: now,
      });
      return { newDevice: true };
    });
  } catch (error) {
    // Device bookkeeping must never block a valid sign-in.
    logger.error('Device check failed', { uid: actor.uid });
    return { newDevice: false };
  }
}

module.exports = { revokeMySessions, recordDevice };
