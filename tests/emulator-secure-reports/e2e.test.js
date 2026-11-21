const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const admin = require('../../functions/node_modules/firebase-admin');
const { provisionSecureReportAccounts } = require('../../scripts/provision-secure-report');

const PROJECT = 'demo-carevault-isolated', PASSWORD = 'synthetic-Passw0rd-only';
const FUNCTIONS = `http://127.0.0.1:5001/${PROJECT}/asia-south1/`;
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake';
let app, db, ids;
const tokens = {};

async function token(email) {
  const response = await fetch(AUTH, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  return (await response.json()).idToken;
}

async function call(name, who, data) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = 'Bearer ' + tokens[who];
  const response = await fetch(FUNCTIONS + name, { method: 'POST', headers, body: JSON.stringify({ data }) });
  const body = await response.json();
  return body.error ? { error: body.error.status, message: body.error.message } : body.result;
}

async function waitFor(check, label, ms = 90000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + label);
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
}

const upload = (who, fixture, title = 'Synthetic report') => call('uploadSecureReport', who, {
  patientId: ids.patientId, title, pdf: fs.readFileSync('synthetic-reports/' + fixture).toString('base64'),
});
const extracted = (reportId, status = 'complete') => waitFor(async () => {
  const value = await call('getSecureReportStatus', 'lab', { reportId });
  return value.status === status ? value : null;
}, 'extraction ' + status);

before(async () => {
  app = admin.initializeApp({ projectId: PROJECT, storageBucket: PROJECT + '.appspot.com' }, 'secure-report-e2e');
  db = app.firestore();
  ids = await provisionSecureReportAccounts(app, PASSWORD, {});
  await db.doc('secureReportUsers/other-doctor').set({ status: 'active', role: 'doctor', hospitalId: 'synthetic-hospital-2' });
  await app.auth().createUser({ uid: 'other-doctor', email: 'other.doctor@carevault.example', password: PASSWORD });
  for (const [name, email] of [['doctor', ids.doctor], ['lab', ids.lab], ['patient', ids.patient], ['other', 'other.doctor@carevault.example']]) {
    tokens[name] = await token(email);
  }
});

after(async () => { await app.delete(); });

test('unauthenticated and unprovisioned callers are rejected', async () => {
  assert.equal((await call('getSecureReportStatus', null, { reportId: 'x' })).error, 'UNAUTHENTICATED');
  assert.equal((await call('getSecureReportIdentity', 'doctor', {})).role, 'doctor');
  assert.equal((await call('getSecureReportIdentity', 'patient', {})).role, 'patient');
  await app.auth().createUser({ email: 'stranger@carevault.example', password: PASSWORD });
  tokens.stranger = await token('stranger@carevault.example');
  assert.equal((await call('getSecureReportIdentity', 'stranger', {})).error, 'PERMISSION_DENIED');
  assert.equal((await upload('other', '01-fictional-laboratory-report.pdf')).error, 'PERMISSION_DENIED');
  assert.equal((await upload('patient', '01-fictional-laboratory-report.pdf')).error, 'PERMISSION_DENIED');
});

test('upload → extraction → consent-gated AI summary → clinician review → approved patient view', async () => {
  const uploaded = await upload('lab', '01-fictional-laboratory-report.pdf', 'Synthetic lab report');
  assert.equal(uploaded.status, 'queued', JSON.stringify(uploaded));
  const { reportId } = uploaded;
  const status = await extracted(reportId);
  assert.equal(status.pageCount, 1);
  assert.deepEqual(status.unreadablePages, []);

  assert.equal((await call('getSecureReportPage', 'lab', { reportId, page: 1 })).page.lines[4].text.slice(0, 8), 'Glucose:');
  assert.equal((await call('getSecureReportPage', 'other', { reportId, page: 1 })).error, 'PERMISSION_DENIED');
  const original = await call('getSecureReportOriginal', 'lab', { reportId });
  assert.equal(Buffer.from(original.pdf, 'base64').subarray(0, 5).toString(), '%PDF-');

  // No patient AI consent yet, and lab staff may never request a summary.
  assert.equal((await call('requestSecureReportSummary', 'doctor', { reportId })).error, 'PERMISSION_DENIED');
  assert.equal((await call('requestSecureReportSummary', 'lab', { reportId })).error, 'PERMISSION_DENIED');
  assert.equal((await call('getSecureReportAiConsent', 'patient', {})).aiProcessingConsent, false);
  assert.equal((await call('setSecureReportAiConsent', 'doctor', { aiProcessingConsent: true })).error, 'PERMISSION_DENIED');
  assert.equal((await call('setSecureReportAiConsent', 'patient', { aiProcessingConsent: 'yes' })).error, 'INVALID_ARGUMENT');
  assert.equal((await call('setSecureReportAiConsent', 'patient', { aiProcessingConsent: true })).aiProcessingConsent, true);

  const generated = await call('requestSecureReportSummary', 'doctor', { reportId });
  assert.equal(generated.status, 'complete', JSON.stringify(generated));
  assert.equal((await call('getSecureReportAiStatus', 'doctor', { reportId })).status, 'complete');

  const draft = await call('getSecureReportSummary', 'doctor', { reportId });
  const texts = draft.summary.statements.map((statement) => statement.text);
  assert.ok(texts.includes('Glucose is 118 mg/dL (reference 70-99 mg/dL), flagged High.'));
  assert.equal(draft.summary.model, 'carevault-extractive');
  assert.equal(draft.verification.blocking, false);
  assert.ok(draft.verification.statements.every((item) => item.sources.length && item.issues.length === 0));

  // The patient sees nothing until a clinician approves this exact version.
  assert.equal((await call('getSecureReportSummary', 'patient', { reportId })).error, 'FAILED_PRECONDITION');
  assert.equal((await call('getSecureReportSummary', 'lab', { reportId })).error, 'PERMISSION_DENIED');
  const review = { reportId, version: draft.summary.version, digest: draft.digest, action: 'approve' };
  assert.equal((await call('reviewSecureReportSummary', 'doctor', review)).error, 'FAILED_PRECONDITION');
  assert.equal((await call('reviewSecureReportSummary', 'doctor', { ...review, sourceReviewConfirmed: true, digest: 'stale' })).error, 'FAILED_PRECONDITION');
  assert.equal((await call('reviewSecureReportSummary', 'patient', { ...review, sourceReviewConfirmed: true })).error, 'PERMISSION_DENIED');
  assert.equal((await call('reviewSecureReportSummary', 'doctor', { ...review, sourceReviewConfirmed: true })).status, 'approved');

  const approved = await call('getSecureReportSummary', 'patient', { reportId });
  assert.deepEqual(approved.summary.statements.map((statement) => statement.text), texts);
  assert.equal(approved.summary.statements[0].sources, undefined, 'patients receive no page citations');
  assert.equal(approved.verification, undefined);

  // Withdrawing consent immediately blocks every reader.
  assert.equal((await call('setSecureReportAiConsent', 'patient', { aiProcessingConsent: false })).aiProcessingConsent, false);
  assert.equal((await call('getSecureReportSummary', 'patient', { reportId })).error, 'PERMISSION_DENIED');
  assert.equal((await call('getSecureReportSummary', 'doctor', { reportId })).error, 'PERMISSION_DENIED');
  assert.equal((await call('requestSecureReportSummary', 'doctor', { reportId })).error, 'PERMISSION_DENIED');
  await call('setSecureReportAiConsent', 'patient', { aiProcessingConsent: true });

  // Regenerating invalidates the previous approval.
  assert.equal((await call('requestSecureReportSummary', 'doctor', { reportId })).status, 'complete');
  assert.equal((await call('getSecureReportSummary', 'patient', { reportId })).error, 'FAILED_PRECONDITION');

  const actions = (await db.collection('secureReportAudit').where('reportId', '==', reportId).get()).docs.map((doc) => doc.get('action'));
  for (const action of ['upload', 'extraction-complete', 'ai-summary-started', 'ai-summary-complete', 'read-ai-summary', 'review-ai-summary', 'read-original-report']) {
    assert.ok(actions.includes(action), 'missing audit event ' + action);
  }
  const audited = JSON.stringify((await db.collection('secureReportAudit').get()).docs.map((doc) => doc.data()));
  assert.ok(!audited.includes('Glucose is 118'), 'audit records must not contain report text');
});

test('changed source extraction invalidates the draft and blocks review', async () => {
  await call('setSecureReportAiConsent', 'patient', { aiProcessingConsent: true });
  const { reportId } = await upload('lab', '02-fictional-ct-chest-report.pdf', 'Synthetic CT report');
  await extracted(reportId);
  assert.equal((await call('requestSecureReportSummary', 'doctor', { reportId })).status, 'complete');
  const draft = await call('getSecureReportSummary', 'doctor', { reportId });
  assert.ok(draft.summary.statements.some((statement) => statement.text === 'Impression: indeterminate 8 mm right upper lobe nodule.'));

  const report = (await db.doc('secureReports/' + reportId).get()).data();
  const file = app.storage().bucket().file(`secure-reports/extractions/${reportId}/${report.jobId}/1.json`);
  const page = JSON.parse((await file.download())[0].toString());
  page.lines = page.lines.map((line) => ({ ...line, text: line.text.replace('8 mm', '9 mm') }));
  await file.save(JSON.stringify(page));
  assert.equal((await call('getSecureReportSummary', 'doctor', { reportId })).error, 'FAILED_PRECONDITION');
  const review = { reportId, version: draft.summary.version, digest: draft.digest, action: 'approve', sourceReviewConfirmed: true };
  assert.equal((await call('reviewSecureReportSummary', 'doctor', review)).error, 'FAILED_PRECONDITION');
});

test('rejection feedback is categorized and a multi-page report is summarized completely', async () => {
  await call('setSecureReportAiConsent', 'patient', { aiProcessingConsent: true });
  const { reportId } = await upload('lab', '07-fictional-long-report-limit-test.pdf', 'Synthetic long report');
  assert.equal((await extracted(reportId)).pageCount, 2);
  assert.equal((await call('requestSecureReportSummary', 'doctor', { reportId })).status, 'complete');
  const draft = await call('getSecureReportSummary', 'doctor', { reportId });
  const cited = draft.summary.statements.reduce((total, statement) => total + statement.sources.length, 0);
  assert.equal(cited, 22);
  const rejected = await call('reviewSecureReportSummary', 'doctor', {
    reportId, version: draft.summary.version, digest: draft.digest, action: 'not-useful', comment: 'Synthetic test feedback',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal((await db.collection('secureReportFeedback').where('reportId', '==', reportId).get()).size, 1);
  assert.equal((await call('getSecureReportSummary', 'patient', { reportId })).error, 'FAILED_PRECONDITION');
});

test('invalid PDFs fail extraction, can be retried, and cannot be summarized', async () => {
  const bad = await call('uploadSecureReport', 'lab', {
    patientId: ids.patientId, title: 'Synthetic invalid', pdf: Buffer.from('%PDF-not-a-real-document').toString('base64'),
  });
  const failed = await extracted(bad.reportId, 'failed');
  assert.match(failed.error, /Extraction failed/);
  assert.equal((await call('requestSecureReportSummary', 'doctor', { reportId: bad.reportId })).error, 'FAILED_PRECONDITION');
  assert.equal((await call('retrySecureReport', 'other', { reportId: bad.reportId })).error, 'PERMISSION_DENIED');
  assert.equal((await call('retrySecureReport', 'lab', { reportId: bad.reportId })).status, 'queued');
  assert.equal((await call('uploadSecureReport', 'lab', { patientId: ids.patientId, title: 'x', pdf: 'AAAA' })).error, 'INVALID_ARGUMENT');
});
