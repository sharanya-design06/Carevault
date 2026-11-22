const { createHash } = require('node:crypto');
const { HttpsError } = require('firebase-functions/v2/https');

function text(data, field, maxLength, required = false) {
  const value = data[field];
  if (value !== undefined && typeof value !== 'string') {
    throw new HttpsError('invalid-argument', `${field} must be text.`);
  }
  const result = (value || '').trim();
  if ((required && !result) || result.length > maxLength) {
    throw new HttpsError('invalid-argument', `${field} is missing or too long.`);
  }
  return result;
}

function hospitalInput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Hospital details are required.');
  }
  const email = text(data, 'email', 254, true).toLowerCase();
  const code = text(data, 'code', 24, true).toUpperCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Enter a valid administrator email.');
  }
  if (!/^[A-Z0-9][A-Z0-9_-]{1,23}$/.test(code)) {
    throw new HttpsError('invalid-argument', 'Hospital code must be 2-24 letters, digits, dashes or underscores.');
  }
  const id = text(data, 'id', 128);
  if (id && !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new HttpsError('invalid-argument', 'Invalid hospital ID.');
  }
  const hospital = {
    name: text(data, 'name', 120, true),
    adminName: text(data, 'adminName', 120, true),
    email, code,
  };
  for (const field of ['phone', 'address', 'city', 'country', 'licenseNo']) {
    hospital[field] = text(data, field, 200);
  }
  return { hospital, id };
}

const digest = (value) => createHash('sha256').update(value).digest('hex');

function createHospitalHandler({ auth, db, sendInvitation, logger }) {
  return async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in is required.');
    if (!['SYSTEM_ADMIN', 'sysadmin'].includes(request.auth.token.role)) {
      throw new HttpsError('permission-denied', 'Only a System Admin can provision hospitals.');
    }
    const caller = await auth.getUser(request.auth.uid);
    if (caller.disabled || !['SYSTEM_ADMIN', 'sysadmin'].includes(caller.customClaims?.role)) {
      throw new HttpsError('permission-denied', 'Your System Admin access is no longer active.');
    }
    const { hospital: input, id: requestedId } = hospitalInput(request.data);
    try {
      // Preserve IDs for hospitals created by the older demo registration flow.
      const legacySnapshot = await db.doc('carevault/hospitals').get();
      let legacyHospitals = [];
      if (legacySnapshot.exists) {
        legacyHospitals = JSON.parse(legacySnapshot.get('json'));
        if (!Array.isArray(legacyHospitals)) throw new Error('Invalid legacy hospital data.');
      }
      const legacy = legacyHospitals.find((hospital) =>
        String(hospital.code || '').trim().toUpperCase() === input.code);
      if (legacy && String(legacy.email || '').trim().toLowerCase() !== input.email) {
        throw new HttpsError('already-exists', 'This hospital code belongs to a different administrator.');
      }
      if (legacy?.status === 'inactive') {
        throw new HttpsError('failed-precondition', 'Reactivate the hospital through the approved administration flow before provisioning.');
      }
      const hospitalId = legacy?.id || requestedId || 'hos_' + digest(input.code).slice(0, 24);
      if (typeof hospitalId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(hospitalId)) {
        throw new HttpsError('failed-precondition', 'The existing hospital has an invalid ID.');
      }
      if (requestedId && requestedId !== hospitalId) {
        throw new HttpsError('failed-precondition', 'The supplied ID does not match the existing hospital.');
      }
      const ref = db.doc('hospitalAccounts/' + hospitalId);
      const snapshot = await ref.get();
      const existing = snapshot.exists ? snapshot.data() : null;
      if (requestedId && !legacy && !existing) {
        throw new HttpsError('not-found', 'The hospital to repair was not found.');
      }
      if (existing && (existing.hospital.email !== input.email || existing.hospital.code !== input.code)) {
        throw new HttpsError('already-exists', 'This hospital is already linked to another account.');
      }
      if (existing?.hospital.status === 'inactive') {
        throw new HttpsError('failed-precondition', 'This hospital is inactive.');
      }
      const uid = 'hospital_admin_' + digest(hospitalId).slice(0, 40);
      let user;
      try {
        user = await auth.getUserByEmail(input.email);
      } catch (error) {
        if (error.code !== 'auth/user-not-found') throw error;
        try {
          user = await auth.createUser({ uid, email: input.email, displayName: input.adminName });
        } catch (error) {
          if (!['auth/email-already-exists', 'auth/uid-already-exists'].includes(error.code)) throw error;
          user = await auth.getUserByEmail(input.email);
        }
      }
      if (user.uid !== uid || user.disabled ||
          (user.customClaims?.role && user.customClaims.role !== 'HOSPITAL_ADMIN') ||
          (user.customClaims?.hospitalId && user.customClaims.hospitalId !== hospitalId)) {
        throw new HttpsError('failed-precondition', 'An existing Firebase account cannot be reassigned. Contact your administrator.');
      }
      await auth.setCustomUserClaims(uid, {
        ...user.customClaims, role: 'HOSPITAL_ADMIN', hospitalId, name: input.adminName,
      });
      const hospital = {
        ...input, id: hospitalId, status: 'active', invite: null,
        createdAt: existing?.hospital.createdAt || legacy?.createdAt || new Date().toISOString(),
      };
      await ref.set({ hospital, adminUid: uid, invitationStatus: 'pending' });
      const link = await auth.generatePasswordResetLink(input.email);
      try {
        await sendInvitation(hospital, link);
      } catch (error) {
        logger.error('Hospital account invitation delivery failed.', { code: error.code || 'email-delivery-failed' });
        throw new HttpsError('unavailable', 'The Firebase account was created, but its setup email could not be sent. Retry the same hospital details after fixing email delivery.');
      }
      hospital.invitationSentAt = new Date().toISOString();
      await ref.set({ hospital, adminUid: uid, invitationStatus: 'sent' });
      return { hospital };
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logger.error('Hospital account provisioning failed.', { code: error.code || 'provisioning-failed' });
      throw new HttpsError('internal', 'Hospital provisioning failed. Check the function logs and retry the same hospital details.');
    }
  };
}

module.exports = { createHospitalHandler };
