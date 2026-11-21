// One-time creation of the first System Admin. Refuses to run if one already exists.
// Usage: node scripts/bootstrap-admin.js <email> <name>   (uses Application Default Credentials or emulators)

async function bootstrapSystemAdmin(admin, email, name) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email || '') || !name) throw new Error('Valid email and name required.');
  const db = admin.firestore(), auth = admin.auth();
  const existing = await db.collection('dashboardUsers').where('role', '==', 'SYSTEM_ADMIN').limit(1).get();
  if (!existing.empty) throw new Error('A System Admin already exists; refusing to bootstrap.');
  const user = await auth.createUser({ email: email.toLowerCase(), displayName: name });
  await auth.setCustomUserClaims(user.uid, { role: 'SYSTEM_ADMIN' });
  await db.collection('dashboardUsers').doc(user.uid).create({
    role: 'SYSTEM_ADMIN', name, email: email.toLowerCase(), status: 'active',
    createdBy: 'bootstrap', createdAt: new Date(),
  });
  return { uid: user.uid };
}

module.exports = { bootstrapSystemAdmin };

if (require.main === module) {
  const admin = require('../functions/node_modules/firebase-admin');
  const [email, name] = process.argv.slice(2);
  admin.initializeApp(process.env.GCLOUD_PROJECT ? { projectId: process.env.GCLOUD_PROJECT } : undefined);
  bootstrapSystemAdmin(admin, email, name)
    .then(({ uid }) => console.log('Created System Admin', uid))
    .catch((error) => { console.error(error.message); process.exit(1); });
}
