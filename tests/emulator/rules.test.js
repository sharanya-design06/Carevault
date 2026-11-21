const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc } = require('firebase/firestore');
const { ref, getBytes, uploadBytes } = require('firebase/storage');
const { initializeApp, deleteApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = require('firebase/auth');
const admin = require('../../functions/node_modules/firebase-admin');
const { resolveDashboardIdentity } = require('../../functions/dashboard-identity');
const { getDashboardIdentity, registerDashboardPatient } = require('../../functions/dashboard-registration');

const projectId = 'demo-carevault-isolated';
let environment;

before(async () => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:18080');
  assert.equal(process.env.FIREBASE_STORAGE_EMULATOR_HOST, '127.0.0.1:19199');
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:19099');
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') },
    storage: { rules: fs.readFileSync('storage.rules', 'utf8') },
  });
  await environment.clearFirestore();
  await environment.clearStorage();
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'carevault/patients'), { synthetic: true });
    await setDoc(doc(context.firestore(), 'secureReports/report1'), { synthetic: true });
    await uploadBytes(ref(context.storage(), 'reports/report1'), new Uint8Array([1, 2, 3]));
    await uploadBytes(ref(context.storage(), 'secure-reports/report1'), new Uint8Array([1, 2, 3]));
  });
});

after(async () => {
  if (environment) await environment.cleanup();
});

test('new dashboard and secure-report collections deny all client access', async () => {
  for (const identity of ['anonymous', 'authenticated']) {
    const context = identity === 'anonymous'
      ? environment.unauthenticatedContext() : environment.authenticatedContext('synthetic-user');
    for (const path of ['secureReports/report1', 'dashboardUsers/user1',
      'dashboardPatients/patient1', 'dashboardEncounters/encounter1', 'dashboardAudit/event1',
      'dashboardCare/staff1/patients/patient1', 'dashboardHospitals/hospital1', 'dashboardAccessGrants/g1', 'dashboardUsernames/u1', 'dashboardNotifications/n1',
      'dashboardRegistrationRequests/user1_request', 'dashboardRecords/record1',
      'dashboardLookupRateLimits/ip-window', 'dashboardInvitations/hash1', 'dashboardNotes/note1', 'dashboardNotes/note1/versions/1', 'dashboardNotes/note1/addenda/a1', 'auditAnchors/dashboardAudit__e1', 'dashboardDuplicateCandidates/c1']) {
      const document = doc(context.firestore(), path);
      await assertFails(getDoc(document));
      await assertFails(setDoc(document, { synthetic: true }));
    }
  }
});

test('legacy demo paths are closed to every client; everything else is denied by default', async () => {
  for (const identity of ['anonymous', 'authenticated']) {
    const context = identity === 'anonymous'
      ? environment.unauthenticatedContext() : environment.authenticatedContext('synthetic-user');
    for (const path of ['carevault/patients', 'carevault/public-demo', 'secureReports/report1', 'anything-else/doc1']) {
      await assertFails(getDoc(doc(context.firestore(), path)));
      await assertFails(setDoc(doc(context.firestore(), path), { synthetic: true }));
    }
    for (const path of ['reports/report1', `reports/${identity}-test.pdf`, 'secure-reports/report1', 'other/report1']) {
      await assertFails(getBytes(ref(context.storage(), path)));
      await assertFails(uploadBytes(ref(context.storage(), path), new Uint8Array([4]), { contentType: 'application/pdf' }));
    }
  }
});

test('emulator data is available to privileged test setup', async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    await assertSucceeds(getDoc(doc(context.firestore(), 'carevault/patients')));
    await assertSucceeds(getBytes(ref(context.storage(), 'reports/report1')));
  });
});

test('Firebase sign-in and verified claims resolve only an active server assignment', async () => {
  const server = admin.initializeApp({ projectId }, 'dashboard-identity-test');
  const client = initializeApp({ projectId, apiKey: 'synthetic-emulator-key' }, 'dashboard-identity-test');
  try {
    const auth = getAuth(client);
    connectAuthEmulator(auth, 'http://127.0.0.1:19099', { disableWarnings: true });
    const user = await server.auth().createUser({
      uid: 'synthetic-doctor', email: 'doctor@example.test', password: 'synthetic-test-password',
    });

    await server.auth().setCustomUserClaims(user.uid, {
      role: 'DOCTOR', subType: 'GENERAL_PRIMARY', hospitalId: 'hospital1',
    });
    const database = server.firestore();
    const userRef = database.collection('dashboardUsers').doc(user.uid);
    await userRef.set({ status: 'active', role: 'DOCTOR', subType: 'GENERAL_PRIMARY', hospitalId: 'hospital1' });
    const signedIn = await signInWithEmailAndPassword(auth, 'doctor@example.test', 'synthetic-test-password');
    const token = await server.auth().verifyIdToken(await signedIn.user.getIdToken());
    const request = { auth: { uid: token.uid, token } };
    const resolve = () => database.runTransaction((tx) => resolveDashboardIdentity(request, database, tx));
    assert.deepEqual(await resolve(), {
      uid: user.uid, role: 'DOCTOR', subType: 'GENERAL_PRIMARY', hospitalId: 'hospital1',
    });
    await database.collection('dashboardHospitals').doc('hospital1').set({ status: 'active' });
    await assert.rejects(registerDashboardPatient({ ...request, data: {
      name: 'Fictional Patient', dob: '2000-01-02', gender: 'Other', visitType: 'outpatient',
      requestId: 'synthetic-request-0002',
    } }, database), (error) => error.code === 'permission-denied');
    await userRef.update({ hospitalId: 'hospital2' });
    await assert.rejects(resolve(), (error) => error.code === 'permission-denied');
    await userRef.update({ hospitalId: 'hospital1', status: 'inactive' });
    await assert.rejects(resolve(), (error) => error.code === 'permission-denied');
    await server.auth().deleteUser(user.uid);
  } finally {
    await deleteApp(client);
    await server.delete();
  }
});

test('verified PCC registers a patient and encounter atomically in their active hospital', async () => {
  const server = admin.initializeApp({ projectId }, 'registration-test');
  const client = initializeApp({ projectId, apiKey: 'synthetic-emulator-key' }, 'registration-test');
  try {
    const auth = getAuth(client);
    connectAuthEmulator(auth, 'http://127.0.0.1:19099', { disableWarnings: true });
    const user = await server.auth().createUser({
      uid: 'synthetic-pcc', email: 'pcc@example.test', password: 'synthetic-test-password',
    });
    await server.auth().setCustomUserClaims(user.uid, { role: 'PCC', hospitalId: 'hospital1' });
    const database = server.firestore();
    await database.collection('dashboardUsers').doc(user.uid).set({
      status: 'active', role: 'PCC', hospitalId: 'hospital1',
    });
    await database.collection('dashboardHospitals').doc('hospital1').set({ status: 'active' });
    const signedIn = await signInWithEmailAndPassword(auth, 'pcc@example.test', 'synthetic-test-password');
    const token = await server.auth().verifyIdToken(await signedIn.user.getIdToken());
    const request = {
      auth: { uid: token.uid, token },
      data: {
        name: 'Fictional Patient', dob: '2000-01-02', gender: 'Other',
        visitType: 'outpatient', requestId: 'synthetic-request-0003',
      },
    };
    assert.deepEqual(await getDashboardIdentity(request, database), {
      uid: user.uid, role: 'PCC', hospitalId: 'hospital1', mfaRequired: false, mfaVerified: false,
    });
    const created = await registerDashboardPatient(request, database);
    assert.match(created.hrid, /^HDW-\d{8}-[A-Z0-9]{8}$/);
    const patient = (await database.collection('dashboardPatients').doc(created.hrid).get()).data();
    const encounter = (await database.collection('dashboardEncounters').doc(created.encounterId).get()).data();
    const audits = await database.collection('dashboardAudit').where('encounterId', '==', created.encounterId).get();
    assert.equal(patient.hospitalId, 'hospital1');
    assert.equal(patient.createdBy, user.uid);
    assert.equal(encounter.hrid, created.hrid);
    assert.equal(encounter.hospitalId, 'hospital1');
    assert.equal(encounter.status, 'open');
    assert.equal(encounter.locked, false);
    assert.equal(audits.size, 1);
    assert.equal(audits.docs[0].data().actorUid, user.uid);
    assert.equal(JSON.stringify(audits.docs[0].data()).includes('Fictional Patient'), false);

    await assert.rejects(registerDashboardPatient({ data: request.data }, database),
      (error) => error.code === 'unauthenticated');
    await assert.rejects(registerDashboardPatient({ ...request, data: { ...request.data, hospitalId: 'hospital2' } }, database),
      (error) => error.code === 'invalid-argument');
    await assert.rejects(registerDashboardPatient({ ...request, data: { ...request.data, dob: '2001-02-29' } }, database),
      (error) => error.code === 'invalid-argument');
    assert.deepEqual(await registerDashboardPatient(request, database), created);
    await assert.rejects(registerDashboardPatient({ ...request, data: {
      ...request.data, name: 'Different Fictional Patient',
    } }, database), (error) => error.code === 'failed-precondition');
    await database.collection('dashboardHospitals').doc('hospital1').update({ status: 'inactive' });
    await assert.rejects(registerDashboardPatient(request, database), (error) => error.code === 'permission-denied');
    await assert.rejects(getDashboardIdentity(request, database), (error) => error.code === 'permission-denied');
    assert.equal((await database.collection('dashboardPatients').get()).size, 1);
    assert.equal((await database.collection('dashboardEncounters').get()).size, 1);
    assert.equal((await database.collection('dashboardAudit').get()).size, 1);
    await server.auth().deleteUser(user.uid);
  } finally {
    await deleteApp(client);
    await server.delete();
  }
});
