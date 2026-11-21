const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { FieldValue } = require('firebase-admin/firestore');
const { createHash, randomBytes, randomInt, timingSafeEqual } = require('node:crypto');
const { phoneKeyOf } = require('./dashboard-registration');

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 30 * 1000;
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 10;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const CODE = /^\d{6}$/;
const failed = () => new HttpsError('permission-denied', 'That code was not accepted. Request a new one and try again.');

// Per-IP throttle shared by both callables; counters expire through the same Firestore TTL policy as login lookups.
async function limitByIp(request, db) {
  const raw = request.rawRequest;
  const ip = raw && (raw.ip || (raw.socket && raw.socket.remoteAddress));
  if (typeof ip !== 'string' || !ip || ip.length > 64) throw new HttpsError('unavailable', 'One-time code sign-in is temporarily unavailable.');
  const windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const ref = db.collection('dashboardLookupRateLimits').doc('otp_' + createHash('sha256').update(ip).digest('hex') + '_' + windowStart);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const count = snapshot.exists ? snapshot.get('count') : 0;
    if (count >= MAX_PER_WINDOW) throw new HttpsError('resource-exhausted', 'Too many attempts. Try again in a minute.');
    const value = { count: count + 1, expiresAt: new Date(windowStart + 2 * WINDOW_MS) };
    if (snapshot.exists) tx.update(ref, value); else tx.create(ref, value);
  });
}

// Patients are found by their account email or by a registered phone number that identifies exactly one patient with a login.
// Staff accounts never match, so this path cannot be used to sign in as staff.
async function findPatientUser(db, identifier) {
  if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 254) return null;
  const id = identifier.trim().toLowerCase();
  let uid = null;
  if (id.includes('@')) {
    if (!EMAIL.test(id)) return null;
    const users = await db.collection('dashboardUsers').where('email', '==', id).where('role', '==', 'PATIENT').limit(2).get();
    if (users.size === 1) uid = users.docs[0].id;
  } else {
    const key = phoneKeyOf(id);
    if (!key) return null;
    const patients = await db.collection('dashboardPatients').where('phoneKey', '==', key).limit(10).get();
    const withLogin = patients.docs.filter((doc) => doc.get('authUid') && doc.get('status') === 'active');
    if (withLogin.length === 1) uid = withLogin[0].get('authUid');
  }
  if (!uid) return null;
  const user = await db.collection('dashboardUsers').doc(uid).get();
  if (!user.exists || user.get('role') !== 'PATIENT' || user.get('status') !== 'active') return null;
  return { uid, email: user.get('email'), hospitalId: user.get('registeredHospitalId') || null };
}

const digest = (code, salt) => createHash('sha256').update(salt + ':' + code).digest();

// Default SMS gateway is a stub: it records that a message would be sent, never the code. Plug a real provider in here.
const smsGatewayStub = async ({ phoneKey }) => {
  logger.info('sms gateway stub: one-time code not sent by SMS', { to: phoneKey ? '******' + phoneKey.slice(-2) : null });
};

async function requestPatientOtp(request, db, sendMail, sendSms = smsGatewayStub) {
  await limitByIp(request, db);
  const identifier = request.data && request.data.identifier;
  const reply = { sent: true, ttlSeconds: OTP_TTL_MS / 1000 };
  const user = await findPatientUser(db, identifier);
  // The response never reveals whether an account exists.
  if (!user) return reply;
  const ref = db.collection('dashboardOtp').doc(user.uid);
  const existing = await ref.get();
  if (existing.exists && Date.now() - existing.get('createdAt').toMillis() < RESEND_COOLDOWN_MS) return reply;

  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  const salt = randomBytes(16).toString('hex');
  await ref.set({
    salt, codeHash: digest(code, salt).toString('hex'), attempts: 0,
    createdAt: new Date(), expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  await db.collection('dashboardAudit').add({
    action: 'patient_otp_requested', actorUid: user.uid, actorRole: 'PATIENT', hospitalId: user.hospitalId, timestamp: FieldValue.serverTimestamp(),
  });
  try {
    // Message text carries no clinical or identifying detail.
    await sendMail({
      to: user.email, subject: 'Your Care Vault sign-in code',
      text: 'Your Care Vault sign-in code is ' + code + '. It expires in 5 minutes and works once.\n\nIf you did not ask for it, ignore this email.\n',
    });
    await sendSms({ phoneKey: phoneKeyOf(identifier) });
  } catch (error) {
    logger.error('One-time code delivery failed', { uid: user.uid });
    await ref.delete();
  }
  return reply;
}

async function verifyPatientOtp(request, db, auth) {
  await limitByIp(request, db);
  const { identifier, code } = request.data || {};
  if (typeof code !== 'string' || !CODE.test(code)) throw failed();
  const user = await findPatientUser(db, identifier);
  if (!user) throw failed();
  const ref = db.collection('dashboardOtp').doc(user.uid);
  const accepted = await db.runTransaction(async (tx) => {
    const challenge = await tx.get(ref);
    if (!challenge.exists) return false;
    if (challenge.get('expiresAt').toMillis() <= Date.now() || challenge.get('attempts') >= MAX_ATTEMPTS) { tx.delete(ref); return false; }
    const expected = Buffer.from(challenge.get('codeHash'), 'hex');
    if (!timingSafeEqual(expected, digest(code, challenge.get('salt')))) {
      // A wrong guess is recorded; the challenge dies on the last allowed attempt.
      if (challenge.get('attempts') + 1 >= MAX_ATTEMPTS) tx.delete(ref); else tx.update(ref, { attempts: challenge.get('attempts') + 1 });
      return false;
    }
    tx.delete(ref);
    return true;
  });
  const record = (action) => db.collection('dashboardAudit').add({
    action, actorUid: user.uid, actorRole: 'PATIENT', hospitalId: user.hospitalId, timestamp: FieldValue.serverTimestamp(),
  });
  if (!accepted) { await record('patient_otp_failed'); throw failed(); }
  const authUser = await auth.getUser(user.uid);
  if (authUser.disabled) { await record('patient_otp_failed'); throw failed(); }
  await record('patient_otp_verified');
  return { token: await auth.createCustomToken(user.uid) };
}

module.exports = { requestPatientOtp, verifyPatientOtp, OTP_TTL_MS, MAX_ATTEMPTS };
