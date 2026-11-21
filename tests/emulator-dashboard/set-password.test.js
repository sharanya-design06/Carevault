const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');

// Firebase's own reset-link flow, which Forgot Password still uses (invitations use dashboard-invitations.js).
test('an invite code sets the password and allows sign-in; reuse fails', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'set-password-test');
  const host = 'http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST + '/identitytoolkit.googleapis.com/v1/accounts:';
  const post = async (method, body) => {
    const response = await fetch(host + method + '?key=fake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: response.ok, body: await response.json() };
  };
  try {
    await app.auth().createUser({ email: 'setpw@example.test' });
    const link = await app.auth().generatePasswordResetLink('setpw@example.test', { url: 'https://care-vault-project.web.app' });
    const code = new URL(link).searchParams.get('oobCode');
    assert.ok(code);
    const info = await post('resetPassword', { oobCode: code });
    assert.equal(info.body.email, 'setpw@example.test');
    assert.equal((await post('signInWithPassword', { email: 'setpw@example.test', password: 'Synthetic-Pass-1', returnSecureToken: true })).ok, false);
    assert.ok((await post('resetPassword', { oobCode: code, newPassword: 'Synthetic-Pass-1' })).ok);
    assert.ok((await post('signInWithPassword', { email: 'setpw@example.test', password: 'Synthetic-Pass-1', returnSecureToken: true })).body.idToken);
    assert.equal((await post('resetPassword', { oobCode: code, newPassword: 'Another-Pass-22' })).ok, false);
  } finally {
    await app.delete();
  }
});
