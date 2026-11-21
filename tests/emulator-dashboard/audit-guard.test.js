const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');

const wait = async (check, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

// Relies on the audit triggers loaded by the Functions emulator.
test('audit entries are anchored, and edits or deletions are reversed', async () => {
  const app = admin.initializeApp({ projectId: 'demo-carevault-isolated' }, 'audit-guard-test');
  const db = app.firestore();
  try {
    const ref = db.collection('dashboardAudit').doc('guard-1');
    await ref.set({ action: 'login_success', actorRole: 'NURSE', hospitalId: 'g1', timestamp: admin.firestore.Timestamp.fromMillis(1700000000000) });
    const anchor = db.collection('auditAnchors').doc('dashboardAudit__guard-1');
    await wait(async () => (await anchor.get()).exists);

    await ref.update({ action: 'nothing_to_see', hospitalId: 'other' });
    await wait(async () => (await ref.get()).get('action') === 'login_success');
    assert.equal((await ref.get()).get('hospitalId'), 'g1');

    await ref.delete();
    await wait(async () => (await ref.get()).exists);
    const restored = (await ref.get()).data();
    assert.equal(restored.action, 'login_success');
    assert.equal(restored.timestamp.toMillis(), 1700000000000);

  } finally {
    await app.delete();
  }
});
