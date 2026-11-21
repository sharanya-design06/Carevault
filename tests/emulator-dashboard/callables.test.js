const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../../functions/node_modules/firebase-admin');
const { initializeApp, deleteApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut } = require('firebase/auth');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');

test('callables enforce identity, PCC scope, care relationships and patient ownership', async () => {
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:19099');
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:18080');
  const projectId = 'demo-carevault-isolated';
  const server = admin.initializeApp({ projectId }, 'callable-test');
  const client = initializeApp({ projectId, apiKey: 'synthetic-emulator-key' }, 'callable-test');
  try {
    const auth = getAuth(client), functions = getFunctions(client, 'asia-south1');
    connectAuthEmulator(auth, 'http://127.0.0.1:19099', { disableWarnings: true });
    connectFunctionsEmulator(functions, '127.0.0.1', 15001);
    const identity = httpsCallable(functions, 'getDashboardIdentity');
    const register = httpsCallable(functions, 'registerDashboardPatient');
    const listPatients = httpsCallable(functions, 'getPccPatients');
    const getPatient = httpsCallable(functions, 'getDashboardPatient');
    const input = {
      name: 'Fictional Patient', dob: '2000-01-02', gender: 'Other', visitType: 'outpatient',
      phone: '+1 555 0100', address: '1 Synthetic Way', emergencyName: 'Fictional Contact',
      emergencyPhone: '+1 555 0101', requestId: 'synthetic-request-0001',
    };
    await assert.rejects(identity({}), (error) => error.code === 'functions/unauthenticated');
    await assert.rejects(register(input), (error) => error.code === 'functions/unauthenticated');
    await assert.rejects(listPatients({}), (error) => error.code === 'functions/unauthenticated');
    await assert.rejects(getPatient({ hrid: 'HDW-20200101-ABCDEFGH' }),
      (error) => error.code === 'functions/unauthenticated');

    await server.auth().createUser({
      uid: 'synthetic-pcc', email: 'pcc@example.test', password: 'synthetic-test-password',
    });
    await server.auth().setCustomUserClaims('synthetic-pcc', { role: 'PCC', hospitalId: 'hospital1' });
    const db = server.firestore();
    const pccRef = db.collection('dashboardUsers').doc('synthetic-pcc');
    const hospitalRef = db.collection('dashboardHospitals').doc('hospital1');
    await pccRef.set({ status: 'active', role: 'PCC', hospitalId: 'hospital1' });
    await hospitalRef.set({ status: 'active' });
    await signInWithEmailAndPassword(auth, 'pcc@example.test', 'synthetic-test-password');
    assert.deepEqual((await identity({})).data, { uid: 'synthetic-pcc', role: 'PCC', hospitalId: 'hospital1', mfaRequired: false, mfaVerified: false });

    const { hrid, encounterId } = (await register(input)).data;
    assert.deepEqual((await register(input)).data, { hrid, encounterId });
    await assert.rejects(register({ ...input, name: 'Different Fictional Patient' }),
      (error) => error.code === 'functions/failed-precondition');
    assert.match(hrid, /^HDW-\d{8}-[A-Z0-9]{8}$/);
    const patientRef = db.collection('dashboardPatients').doc(hrid);
    assert.equal((await patientRef.get()).get('hospitalId'), 'hospital1');
    assert.equal((await db.collection('dashboardEncounters').doc(encounterId).get()).get('hrid'), hrid);
    assert.deepEqual((await listPatients({})).data.map(({ hrid: id }) => id), [hrid]);
    assert.deepEqual((await getPatient({ hrid })).data, {
      hrid, name: input.name, dob: input.dob, gender: input.gender, hospitalId: 'hospital1', priorityCare: false, hasAccount: false,
    });
    const profileAudit = await db.collection('dashboardAudit').where('patientId', '==', hrid).get();
    assert.equal(profileAudit.docs.filter((event) => event.data().action === 'patient_profile_read').length, 1);
    assert.equal(profileAudit.docs.some((event) => JSON.stringify(event.data()).includes(input.phone)), false);
    assert.equal(profileAudit.docs.some((event) => JSON.stringify(event.data()).includes(input.address)), false);
    await assert.rejects(register({ ...input, hospitalId: 'hospital2' }),
      (error) => error.code === 'functions/invalid-argument');
    await assert.rejects(register({ ...input, dob: '2001-02-29' }),
      (error) => error.code === 'functions/invalid-argument');
    await assert.rejects(register({ ...input, phone: 'bad' }),
      (error) => error.code === 'functions/invalid-argument');
    await assert.rejects(register({ ...input, requestId: undefined }),
      (error) => error.code === 'functions/invalid-argument');

    await server.auth().createUser({
      uid: 'synthetic-doctor', email: 'doctor@example.test', password: 'synthetic-test-password',
    });
    await server.auth().setCustomUserClaims('synthetic-doctor', {
      role: 'DOCTOR', subType: 'GENERAL_PRIMARY', hospitalId: 'hospital1',
    });
    await db.collection('dashboardUsers').doc('synthetic-doctor').set({
      status: 'active', role: 'DOCTOR', subType: 'GENERAL_PRIMARY', hospitalId: 'hospital1',
    });
    const careRef = db.collection('dashboardCare').doc('synthetic-doctor').collection('patients').doc(hrid);
    await careRef.set({ status: 'active', hospitalId: 'hospital1' });
    await signOut(auth);
    await signInWithEmailAndPassword(auth, 'doctor@example.test', 'synthetic-test-password');
    await assert.rejects(listPatients({}), (error) => error.code === 'functions/permission-denied');
    assert.equal((await getPatient({ hrid })).data.name, input.name);
    await careRef.update({ status: 'inactive' });
    await assert.rejects(getPatient({ hrid }), (error) => error.code === 'functions/permission-denied');
    await careRef.update({ status: 'active', hospitalId: 'hospital2' });
    await assert.rejects(getPatient({ hrid }), (error) => error.code === 'functions/permission-denied');
    await careRef.update({ hospitalId: 'hospital1' });
    await patientRef.update({ shareWithOtherHospitals: true });
    assert.equal((await getPatient({ hrid })).data.hrid, hrid);
    await patientRef.update({ shareWithOtherHospitals: false });

    await server.auth().createUser({
      uid: 'synthetic-patient', email: 'patient@example.test', password: 'synthetic-test-password',
    });
    await server.auth().setCustomUserClaims('synthetic-patient', { role: 'PATIENT', patientId: hrid });
    await db.collection('dashboardUsers').doc('synthetic-patient').set({
      status: 'active', role: 'PATIENT', patientId: hrid,
    });
    await patientRef.update({ authUid: 'synthetic-patient' });
    await signOut(auth);
    await signInWithEmailAndPassword(auth, 'patient@example.test', 'synthetic-test-password');
    const ownPatient = (await getPatient({ hrid })).data;
    assert.equal(ownPatient.address, input.address);
    assert.equal(ownPatient.emergencyPhone, input.emergencyPhone);
    await assert.rejects(getPatient({ hrid: 'HDW-20200101-ABCDEFGH' }),
      (error) => error.code === 'functions/permission-denied');

    await signOut(auth);
    await signInWithEmailAndPassword(auth, 'pcc@example.test', 'synthetic-test-password');
    await hospitalRef.update({ status: 'inactive' });
    await assert.rejects(identity({}), (error) => error.code === 'functions/permission-denied');
    await assert.rejects(register(input), (error) => error.code === 'functions/permission-denied');
    assert.equal((await db.collection('dashboardPatients').get()).size, 1);
    assert.equal((await db.collection('dashboardEncounters').get()).size, 1);
    await server.auth().deleteUsers(['synthetic-pcc', 'synthetic-doctor', 'synthetic-patient']);
  } finally {
    await deleteApp(client);
    await server.delete();
  }
});
