const { onCall } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const {
  getDashboardIdentity, registerDashboardPatient, getPccPatients, getDashboardPatient,
  requestCrossHospitalAccess, getPatientNotifications,
} = require('./dashboard-registration');

const OPTIONS = { region: 'asia-south1' };

exports.getDashboardIdentity = onCall(OPTIONS, (request) =>
  getDashboardIdentity(request, admin.firestore()));

exports.registerDashboardPatient = onCall(OPTIONS, (request) =>
  registerDashboardPatient(request, admin.firestore()));

exports.getPccPatients = onCall(OPTIONS, (request) =>
  getPccPatients(request, admin.firestore()));

exports.getDashboardPatient = onCall(OPTIONS, (request) =>
  getDashboardPatient(request, admin.firestore()));

const nodemailer = require('nodemailer');
const { defineSecret } = require('firebase-functions/params');
const {
  createDashboardUser, setDashboardUserStatus, sendDashboardInvite, lookupLoginEmail, listDashboardUsers,
} = require('./dashboard-provisioning');

const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');
const sendDashboardMail = async (message) => {
  const transport = nodemailer.createTransport({
    service: 'gmail', auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() },
  });
  const result = await transport.sendMail({ from: '"CareVault" <' + SMTP_USER.value() + '>', ...message });
  if (!result.accepted || !result.accepted.length) throw new Error('SMTP server did not accept the recipient');
};

exports.createDashboardUser = onCall(OPTIONS, (request) =>
  createDashboardUser(request, admin.firestore(), admin.auth()));

exports.setDashboardUserStatus = onCall(OPTIONS, (request) =>
  setDashboardUserStatus(request, admin.firestore(), admin.auth()));

exports.requestCrossHospitalAccess = onCall({ ...OPTIONS, secrets: [SMTP_USER, SMTP_PASS] }, (request) =>
  requestCrossHospitalAccess(request, admin.firestore(), sendDashboardMail));

exports.getPatientNotifications = onCall(OPTIONS, (request) =>
  getPatientNotifications(request, admin.firestore()));

exports.sendDashboardInvite = onCall({ ...OPTIONS, secrets: [SMTP_USER, SMTP_PASS] }, (request) =>
  sendDashboardInvite(request, admin.firestore(), admin.auth(), sendDashboardMail));

const { requestPatientOtp, verifyPatientOtp } = require('./dashboard-otp');
const { revokeMySessions } = require('./dashboard-sessions');

exports.revokeMySessions = onCall(OPTIONS, (request) => revokeMySessions(request, admin.firestore(), admin.auth()));

exports.requestPatientOtp = onCall({ ...OPTIONS, secrets: [SMTP_USER, SMTP_PASS] }, (request) =>
  requestPatientOtp(request, admin.firestore(), sendDashboardMail));

exports.verifyPatientOtp = onCall(OPTIONS, (request) => verifyPatientOtp(request, admin.firestore(), admin.auth()));

exports.lookupLoginEmail = onCall(OPTIONS, (request) => lookupLoginEmail(request, admin.firestore()));

exports.listDashboardUsers = onCall(OPTIONS, (request) => listDashboardUsers(request, admin.firestore()));

const {
  createDashboardHospital, listDashboardHospitals, setDashboardHospitalStatus, listDashboardAudit, listSensitiveAudit,
  setHospitalBmiPolicy,
} = require('./dashboard-admin');

exports.createDashboardHospital = onCall(OPTIONS, (request) => createDashboardHospital(request, admin.firestore()));

exports.listDashboardHospitals = onCall(OPTIONS, (request) => listDashboardHospitals(request, admin.firestore()));

exports.setDashboardHospitalStatus = onCall(OPTIONS, (request) =>
  setDashboardHospitalStatus(request, admin.firestore(), admin.auth()));

exports.listDashboardAudit = onCall(OPTIONS, (request) => listDashboardAudit(request, admin.firestore()));

exports.listSensitiveAudit = onCall(OPTIONS, (request) => listSensitiveAudit(request, admin.firestore()));

const {
  assignPatientCare, listMyPatients, addClinicalRecord, listClinicalRecords, dispensePrescription, setPriorityCare,
} = require('./dashboard-clinical');

exports.assignPatientCare = onCall(OPTIONS, (request) => assignPatientCare(request, admin.firestore()));

exports.listMyPatients = onCall(OPTIONS, (request) => listMyPatients(request, admin.firestore()));

exports.addClinicalRecord = onCall(OPTIONS, (request) => addClinicalRecord(request, admin.firestore()));

exports.listClinicalRecords = onCall(OPTIONS, (request) => listClinicalRecords(request, admin.firestore()));

exports.dispensePrescription = onCall(OPTIONS, (request) => dispensePrescription(request, admin.firestore()));

const { createPatientAccount, setPatientSharing, getMySharing } = require('./dashboard-patients');

exports.createPatientAccount = onCall(OPTIONS, (request) =>
  createPatientAccount(request, admin.firestore(), admin.auth()));

exports.setPatientSharing = onCall(OPTIONS, (request) => setPatientSharing(request, admin.firestore()));

exports.getMySharing = onCall(OPTIONS, (request) => getMySharing(request, admin.firestore()));

const { checkDashboardInvite, completeDashboardInvite } = require('./dashboard-invitations');

exports.checkDashboardInvite = onCall(OPTIONS, (request) =>
  checkDashboardInvite(request, admin.firestore(), admin.auth()));

exports.completeDashboardInvite = onCall(OPTIONS, (request) =>
  completeDashboardInvite(request, admin.firestore(), admin.auth()));

const { findDashboardPatient, openDashboardEncounter } = require('./dashboard-lookup');

exports.findDashboardPatient = onCall(OPTIONS, (request) => findDashboardPatient(request, admin.firestore()));

exports.openDashboardEncounter = onCall(OPTIONS, (request) => openDashboardEncounter(request, admin.firestore()));

const {
  saveDashboardNote, signDashboardNote, addDashboardNoteAddendum, listDashboardNotes, getDashboardNoteVersions, markEncounterBillingCleared, listOpenEncounters,
} = require('./dashboard-notes');

exports.saveDashboardNote = onCall(OPTIONS, (request) => saveDashboardNote(request, admin.firestore()));

exports.signDashboardNote = onCall(OPTIONS, (request) => signDashboardNote(request, admin.firestore()));

exports.addDashboardNoteAddendum = onCall(OPTIONS, (request) => addDashboardNoteAddendum(request, admin.firestore()));

exports.listDashboardNotes = onCall(OPTIONS, (request) => listDashboardNotes(request, admin.firestore()));

exports.getDashboardNoteVersions = onCall(OPTIONS, (request) => getDashboardNoteVersions(request, admin.firestore()));

exports.listOpenEncounters = onCall(OPTIONS, (request) => listOpenEncounters(request, admin.firestore()));

exports.markEncounterBillingCleared = onCall(OPTIONS, (request) => markEncounterBillingCleared(request, admin.firestore()));

exports.setPriorityCare = onCall(OPTIONS, (request) => setPriorityCare(request, admin.firestore()));

exports.setHospitalBmiPolicy = onCall(OPTIONS, (request) => setHospitalBmiPolicy(request, admin.firestore()));

const { listDuplicateCandidates, reviewDuplicateCandidate } = require('./dashboard-duplicates');

exports.listDuplicateCandidates = onCall(OPTIONS, (request) => listDuplicateCandidates(request, admin.firestore()));

exports.reviewDuplicateCandidate = onCall(OPTIONS, (request) => reviewDuplicateCandidate(request, admin.firestore()));
