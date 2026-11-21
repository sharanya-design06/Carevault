const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const { createDashboardUser, sendDashboardInvite } = require('../../functions/dashboard-provisioning');
const { checkDashboardInvite, completeDashboardInvite } = require('../../functions/dashboard-invitations');

test('invitations are single-use, expire after 5 minutes and are superseded by a newer one', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'invitation-expiry-test');
  const db = app.firestore(), auth = app.auth();
  try {
    await db.collection('dashboardHospitals').doc('inv-h').set({ status: 'active' });
    const sys = (data) => ({ auth: { uid: 'inv-ha', token: { role: 'HOSPITAL_ADMIN', hospitalId: 'inv-h' } }, data });
    await db.collection('dashboardUsers').doc('inv-ha').set({ role: 'HOSPITAL_ADMIN', hospitalId: 'inv-h', status: 'active', email: 'inv-ha@example.test', name: 'HA' });
    const made = await createDashboardUser(sys({ email: 'inv-nurse@example.test', name: 'Nurse', role: 'NURSE', hospitalId: 'inv-h' }), db, auth);

    const mails = [];
    const send = () => sendDashboardInvite(sys({ uid: made.uid }), db, auth, async (m) => { mails.push(m); });
    const tokenIn = (m) => /set-password\/\?token=([A-Za-z0-9_-]{43})/.exec(m.text)[1];
    const call = (fn, data) => fn({ data }, db, auth);
    const code = (promise) => assert.rejects(promise, (e) => e.code === 'failed-precondition');

    await send();
    const first = tokenIn(mails[0]);
    assert.match(mails[0].text, /expires at .* \(5 minutes/);
    const stored = (await db.collection('dashboardInvitations').get()).docs;
    assert.ok(stored.every((d) => d.id !== first), 'the raw token must not be stored');

    assert.deepEqual(await call(checkDashboardInvite, { token: first }), { email: 'inv-nurse@example.test' });
    await assert.rejects(call(completeDashboardInvite, { token: first, password: 'short' }), (e) => e.code === 'invalid-argument');
    assert.deepEqual(await call(checkDashboardInvite, { token: first }), { email: 'inv-nurse@example.test' }, 'a rejected password does not consume the token');

    await send();
    await code(call(checkDashboardInvite, { token: first }));
    const second = tokenIn(mails[1]);

    const secondRef = (await db.collection('dashboardInvitations').where('used', '==', false).get()).docs[0].ref;
    assert.ok(secondRef.id !== first);
    const sent = (await secondRef.get()).get('createdAt').toMillis();
    assert.equal((await secondRef.get()).get('expiresAt').toMillis() - sent, 5 * 60 * 1000);
    await secondRef.update({ expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000) });
    await code(call(checkDashboardInvite, { token: second }));
    await code(call(completeDashboardInvite, { token: second, password: 'Synthetic-Pass-123' }));

    await send();
    const third = tokenIn(mails[2]);
    const results = await Promise.allSettled([
      call(completeDashboardInvite, { token: third, password: 'Synthetic-Pass-123' }),
      call(completeDashboardInvite, { token: third, password: 'Another-Pass-4567' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    await code(call(completeDashboardInvite, { token: third, password: 'Third-Pass-89012' }));
    assert.equal((await auth.getUser(made.uid)).emailVerified, true);
    const audit = await db.collection('dashboardAudit').where('action', '==', 'invite_completed').get();
    assert.equal(audit.size, 1);
    await code(call(checkDashboardInvite, { token: 'x'.repeat(43) }));
  } finally {
    await app.delete();
  }
});
