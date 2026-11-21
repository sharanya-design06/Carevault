/*
 * Emails invitation and password-reset links. The browser only sends a token; the function finds the account
 * that owns it in Firestore and mails the address registered there, so callers cannot choose the recipient or link.
 */
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp();
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');
const SITE = 'https://care-vault-project.web.app';
const COLLECTIONS = ['hospitals', 'users', 'patients', 'admins'];

async function readList(key) {
  const snap = await admin.firestore().doc('carevault/' + key).get();
  if (!snap.exists) return [];
  const list = JSON.parse(snap.get('json'));
  if (!Array.isArray(list)) throw new Error('Invalid invitation collection: ' + key);
  return list;
}

async function findOwner(kind, token) {
  const field = kind === 'reset' ? 'reset' : 'invite';
  for (const key of COLLECTIONS) {
    const hit = (await readList(key)).find((x) => x && x[field] && x[field].token === token);
    if (hit) return { owner: hit, expiresAt: hit[field].expiresAt };
  }
  return null;
}

exports.sendInvite = onRequest({ region: 'asia-south1', secrets: [SMTP_USER, SMTP_PASS], cors: [SITE, 'https://care-vault-project.firebaseapp.com'] }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const { kind, token } = req.body || {};
  if ((kind !== 'invite' && kind !== 'reset') || typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return res.status(400).json({ ok: false });

  let found;
  try {
    found = await findOwner(kind, token);
  } catch (e) {
    logger.error('Invitation lookup failed', e);
    return res.status(503).json({ ok: false });
  }
  if (!found || !found.owner.email || !Number.isFinite(Date.parse(found.expiresAt)) || Date.parse(found.expiresAt) <= Date.now()) return res.status(404).json({ ok: false });

  const isReset = kind === 'reset';
  const link = SITE + '/#/' + (isReset ? 'reset-password' : 'setup-password') + '?token=' + encodeURIComponent(token);
  const name = found.owner.name || found.owner.adminName || '';
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() } });
  try {
    const result = await transport.sendMail({
      from: '"CareVault" <' + SMTP_USER.value() + '>',
      to: found.owner.email,
      subject: isReset ? 'CareVault password reset' : 'Your CareVault account invitation',
      text: 'Hello' + (name ? ' ' + name : '') + ',\n\n' + (isReset ? 'Use this link to reset your password' : 'Use this link to set your password and activate your account') +
        ' (valid until ' + new Date(found.expiresAt).toUTCString() + '):\n\n' + link + '\n\nIf you did not expect this email, ignore it.\n'
    });
    if (!result.accepted || !result.accepted.length) throw new Error('SMTP server did not accept the recipient');
  } catch (e) {
    logger.error('Invitation email delivery failed', e);
    return res.status(503).json({ ok: false });
  }
  res.json({ ok: true });
});

Object.assign(exports, require('./secure-report-processing'));
Object.assign(exports, require('./secure-report-summary'));
Object.assign(exports, require('./dashboard-api'));
Object.assign(exports, require('./audit-guard'));
