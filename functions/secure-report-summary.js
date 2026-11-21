const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');
const { createHash } = require('node:crypto');
const { id, uid, authorize, audit } = require('./secure-report-auth');
const { summarizePages, ENGINE, ENGINE_VERSION } = require('./report-summarizer');
const { verifySources } = require('./summary-verification');

const REGION = 'asia-south1';
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const LEASE_MS = 5 * 60 * 1000;
const COMMENT_LIMIT = 300;
const ACTIONS = new Set(['approve', 'reject', 'incorrect', 'not-useful']);
const LIMITATIONS = 'Experimental extractive draft. Not clinically validated. Compare every statement with the original report; text extraction and OCR can be inaccurate.';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const digestOf = (summary) => sha256(canonical(summary));

async function authorizeReport(tx, actor, reportId, roles, requireAiConsent) {
  const ref = admin.firestore().doc('secureReports/' + reportId), snapshot = await tx.get(ref);
  if (!snapshot.exists) throw new HttpsError('permission-denied', 'Report access denied.');
  const report = snapshot.data();
  id(report.patientId);
  const { user } = await authorize(tx, actor, {
    patientId: report.patientId, reportHospital: report.hospitalId, roles, requireAiConsent,
  });
  return { ref, report, user };
}

function pageLoader(reportId, jobId) {
  return async (page) => {
    const [bytes] = await admin.storage().bucket().file(
      'secure-reports/extractions/' + reportId + '/' + jobId + '/' + page + '.json').download();
    if (bytes.length > MAX_PAGE_BYTES) throw new Error('Extracted page exceeds the processing limit');
    return bytes;
  };
}

async function verify(reportId, report) {
  try {
    return await verifySources(report.summary, report.pageCount, pageLoader(reportId, report.jobId));
  } catch (error) {
    logger.error('Secure summary source verification failed', { code: error.code || error.name });
    throw new HttpsError('failed-precondition', 'A referenced extracted page could not be verified.');
  }
}

function issueCounts(verification) {
  const counts = {};
  for (const statement of verification.statements) for (const issue of statement.issues) counts[issue.code] = (counts[issue.code] || 0) + 1;
  return counts;
}

function approved(report) {
  const review = report.review;
  return !!(review && review.status === 'approved' && report.summary && review.version === report.summary.version &&
    review.digest === digestOf(report.summary) && review.sourceDigest === report.summary.sourceDigest);
}

function ready(report) {
  return report.status === 'complete' && Number.isSafeInteger(report.pageCount) && report.pageCount >= 1 &&
    report.pageCount <= 100 && typeof report.jobId === 'string' &&
    !(report.unreadablePages || []).length && !(report.ocrWithoutText || []).length;
}

const FAILURES = {
  REPORT_TOO_LARGE: 'The report is too large to summarize completely. No draft was saved.',
  NO_READABLE_TEXT: 'The report contained no readable text to summarize. No draft was saved.',
  'permission-denied': 'AI processing authorization was revoked or the report changed. No draft was saved.',
};

exports.requestSecureReportSummary = onCall({ region: REGION, memory: '512MiB', timeoutSeconds: 300 }, async (request) => {
  const actor = uid(request), reportId = id(request.data && request.data.reportId);
  const db = admin.firestore(), reportRef = db.doc('secureReports/' + reportId), jobId = db.collection('secureReportAiJobs').doc().id;
  const claimed = await db.runTransaction(async (tx) => {
    const { ref, report, user } = await authorizeReport(tx, actor, reportId, ['doctor'], true);
    if (!ready(report)) {
      throw new HttpsError('failed-precondition', 'Complete extraction, and resolve unreadable pages, before generating a summary.');
    }
    const lease = report.aiLeaseUntil && (typeof report.aiLeaseUntil.toMillis === 'function'
      ? report.aiLeaseUntil.toMillis() : new Date(report.aiLeaseUntil).getTime());
    if (report.aiStatus === 'processing' && lease > Date.now()) return { running: report.aiJobId };
    tx.update(ref, {
      aiStatus: 'processing', aiJobId: jobId, aiLeaseUntil: new Date(Date.now() + LEASE_MS),
      aiError: FieldValue.delete(), summary: FieldValue.delete(), review: FieldValue.delete(),
    });
    audit(tx, actor, user.role, reportId, 'ai-summary-started', {
      aiJobId: jobId, engine: ENGINE, engineVersion: ENGINE_VERSION, extractionJobId: report.jobId, sourcePageCount: report.pageCount,
    });
    return { role: user.role, extractionJobId: report.jobId, pageCount: report.pageCount };
  });
  if (claimed.running) return { reportId, status: 'processing', jobId: claimed.running };

  try {
    const load = pageLoader(reportId, claimed.extractionJobId), pages = [];
    for (let number = 1; number <= claimed.pageCount; number++) {
      const page = JSON.parse((await load(number)).toString('utf8'));
      if (!page || page.page !== number || !Array.isArray(page.lines) || page.lines.some((line) =>
        !line || line.page !== number || !['pdf', 'ocr'].includes(line.source) || typeof line.text !== 'string')) {
        throw new Error('Extracted page is missing or malformed.');
      }
      pages.push(page);
    }
    const { statements, inputCharacters } = summarizePages(pages);
    const draft = {
      text: statements.map((statement) => statement.text).join('\n'), statements, version: jobId,
      model: ENGINE, modelVersion: ENGINE_VERSION, generatedAt: new Date().toISOString(),
      inputs: 'All ' + claimed.pageCount + ' extracted page(s); PDF text and English OCR where needed',
      limitations: LIMITATIONS,
    };
    const verification = await verifySources(draft, claimed.pageCount, load);
    const summary = { ...draft, sourceDigest: verification.sourceDigest };
    await db.runTransaction(async (tx) => {
      const { report, user } = await authorizeReport(tx, actor, reportId, ['doctor'], true);
      if (report.aiJobId !== jobId || report.aiStatus !== 'processing' || report.jobId !== claimed.extractionJobId) {
        throw new HttpsError('permission-denied', 'Report access denied.');
      }
      tx.update(reportRef, {
        aiStatus: 'complete', aiCompletedAt: FieldValue.serverTimestamp(), aiLeaseUntil: FieldValue.delete(),
        aiError: FieldValue.delete(), summary, review: FieldValue.delete(),
      });
      audit(tx, actor, user.role, reportId, 'ai-summary-complete', {
        aiJobId: jobId, engine: ENGINE, engineVersion: ENGINE_VERSION, extractionJobId: claimed.extractionJobId,
        sourcePageCount: claimed.pageCount, inputCharacters, statementCount: statements.length,
        summaryDigest: digestOf(summary), issueCounts: issueCounts(verification),
      });
    });
    return { reportId, status: 'complete', jobId };
  } catch (error) {
    logger.error('Secure report AI summary failed', { code: error.code || error.name });
    const message = FAILURES[error.code] || 'Summary generation failed. Review the extraction and retry.';
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(reportRef);
      if (!snapshot.exists || snapshot.data().aiJobId !== jobId || snapshot.data().aiStatus !== 'processing') return;
      tx.update(reportRef, {
        aiStatus: 'failed', aiError: message, aiFailedAt: FieldValue.serverTimestamp(),
        aiLeaseUntil: FieldValue.delete(), summary: FieldValue.delete(), review: FieldValue.delete(),
      });
      audit(tx, actor, claimed.role, reportId, 'ai-summary-failed', {
        aiJobId: jobId, engine: ENGINE, engineVersion: ENGINE_VERSION, errorCode: error.code || error.name,
      });
    });
    return { reportId, status: 'failed', jobId, error: message };
  }
});

exports.getSecureReportAiStatus = onCall({ region: REGION }, async (request) => {
  const actor = uid(request), reportId = id(request.data && request.data.reportId);
  return admin.firestore().runTransaction(async (tx) => {
    const { report, user } = await authorizeReport(tx, actor, reportId, ['doctor'], false);
    audit(tx, actor, user.role, reportId, 'read-ai-summary-status', { aiJobId: report.aiJobId || null });
    return { reportId, status: report.aiStatus || 'not-started', error: report.aiError || null };
  });
});

exports.getSecureReportSummary = onCall({ region: REGION, memory: '512MiB', timeoutSeconds: 120 }, async (request) => {
  const actor = uid(request), reportId = id(request.data && request.data.reportId);
  const db = admin.firestore();
  const first = await db.runTransaction((tx) => authorizeReport(tx, actor, reportId, ['doctor', 'patient'], true));
  const { report: loaded, user: reader } = first;
  if (!loaded.summary || !Array.isArray(loaded.summary.statements)) {
    throw new HttpsError('failed-precondition', 'A reviewable summary is not available.');
  }
  if (reader.role === 'patient' && !approved(loaded)) {
    throw new HttpsError('failed-precondition', 'A clinician-approved summary is not available.');
  }
  const verification = await verify(reportId, loaded);
  if (verification.sourceDigest !== loaded.summary.sourceDigest) {
    throw new HttpsError('failed-precondition', 'The source extraction changed. Generate a new summary.');
  }
  const digest = digestOf(loaded.summary);
  await db.runTransaction(async (tx) => {
    const { report, user } = await authorizeReport(tx, actor, reportId, ['doctor', 'patient'], true);
    if (!report.summary || digestOf(report.summary) !== digest || (user.role === 'patient' && !approved(report))) {
      throw new HttpsError('failed-precondition', 'The summary changed. Load it again.');
    }
    audit(tx, actor, user.role, reportId, 'read-ai-summary', {
      summaryVersion: report.summary.version, summaryDigest: digest, statementCount: report.summary.statements.length,
      engine: report.summary.model, engineVersion: report.summary.modelVersion, issueCounts: issueCounts(verification),
    });
  });
  const meta = {
    version: loaded.summary.version, model: loaded.summary.model, modelVersion: loaded.summary.modelVersion,
    inputs: loaded.summary.inputs, limitations: loaded.summary.limitations,
  };
  if (reader.role === 'patient') {
    return { summary: { ...meta, statements: loaded.summary.statements.map(({ text, category }) => ({ text, category })) }, digest };
  }
  return {
    summary: { ...meta, statements: loaded.summary.statements }, digest,
    review: loaded.review ? { status: loaded.review.status, action: loaded.review.action, version: loaded.review.version } : null,
    verification: { statements: verification.statements, blocking: verification.blocking },
  };
});

exports.reviewSecureReportSummary = onCall({ region: REGION, memory: '512MiB', timeoutSeconds: 120 }, async (request) => {
  const actor = uid(request), data = request.data || {}, reportId = id(data.reportId);
  if (!ACTIONS.has(data.action)) throw new HttpsError('invalid-argument', 'Choose a valid review action.');
  const comment = typeof data.comment === 'string' ? data.comment.trim().slice(0, COMMENT_LIMIT) : '';
  const db = admin.firestore();
  const { report: loaded } = await db.runTransaction((tx) => authorizeReport(tx, actor, reportId, ['doctor'], true));
  if (!loaded.summary || !Array.isArray(loaded.summary.statements)) {
    throw new HttpsError('failed-precondition', 'A reviewable summary is not available.');
  }
  const digest = digestOf(loaded.summary);
  if (data.version !== loaded.summary.version || data.digest !== digest) {
    throw new HttpsError('failed-precondition', 'The summary or sources changed. Review them again.');
  }
  const verification = await verify(reportId, loaded);
  if (verification.sourceDigest !== loaded.summary.sourceDigest) {
    throw new HttpsError('failed-precondition', 'The summary or source extraction changed. Review it again.');
  }
  if (data.action === 'approve') {
    if (data.sourceReviewConfirmed !== true) {
      throw new HttpsError('failed-precondition', 'Confirm manual review of every statement and its original source.');
    }
    if (verification.blocking) {
      throw new HttpsError('failed-precondition', 'Correct or reject the flagged summary before approval.');
    }
  }
  await db.runTransaction(async (tx) => {
    const { ref, report, user } = await authorizeReport(tx, actor, reportId, ['doctor'], true);
    if (!report.summary || digestOf(report.summary) !== digest) {
      throw new HttpsError('failed-precondition', 'The summary changed. Load it again.');
    }
    const status = data.action === 'approve' ? 'approved' : 'rejected';
    tx.update(ref, { review: {
      status, action: data.action, version: report.summary.version, digest, sourceDigest: report.summary.sourceDigest,
      reviewedBy: actor, reviewedAt: new Date().toISOString(),
    } });
    if (data.action === 'incorrect' || data.action === 'not-useful') {
      tx.create(db.collection('secureReportFeedback').doc(), {
        reportId, category: data.action, comment, summaryVersion: report.summary.version, summaryDigest: digest,
        actorUid: actor, timestamp: FieldValue.serverTimestamp(),
      });
    }
    audit(tx, actor, user.role, reportId, 'review-ai-summary', {
      reviewAction: data.action, summaryVersion: report.summary.version, summaryDigest: digest,
      statementCount: report.summary.statements.length, issueCounts: issueCounts(verification),
      sourceReviewConfirmed: data.sourceReviewConfirmed === true,
    });
  });
  return { reportId, status: data.action === 'approve' ? 'approved' : 'rejected' };
});

async function patientRecord(tx, actor) {
  const db = admin.firestore(), userSnap = await tx.get(db.doc('secureReportUsers/' + actor));
  const user = userSnap.exists ? userSnap.data() : null;
  if (!user || user.status !== 'active' || user.role !== 'patient') throw new HttpsError('permission-denied', 'Report access denied.');
  const patientId = id(user.patientId), ref = db.doc('secureReportPatients/' + patientId), snapshot = await tx.get(ref);
  if (!snapshot.exists || snapshot.data().status !== 'active' || snapshot.data().authUid !== actor) {
    throw new HttpsError('permission-denied', 'Report access denied.');
  }
  return { ref, patientId, patient: snapshot.data() };
}

exports.getSecureReportAiConsent = onCall({ region: REGION }, async (request) => {
  const actor = uid(request);
  return admin.firestore().runTransaction(async (tx) => {
    const { patientId, patient } = await patientRecord(tx, actor);
    audit(tx, actor, 'patient', null, 'read-ai-processing-consent', { patientId });
    return { aiProcessingConsent: patient.aiProcessingConsent === true };
  });
});

exports.setSecureReportAiConsent = onCall({ region: REGION }, async (request) => {
  const actor = uid(request), consent = request.data && request.data.aiProcessingConsent;
  if (typeof consent !== 'boolean') throw new HttpsError('invalid-argument', 'AI consent must be true or false.');
  return admin.firestore().runTransaction(async (tx) => {
    const { ref, patientId } = await patientRecord(tx, actor);
    tx.update(ref, { aiProcessingConsent: consent, aiProcessingConsentUpdatedAt: FieldValue.serverTimestamp() });
    audit(tx, actor, 'patient', null, consent ? 'ai-processing-consent-granted' : 'ai-processing-consent-withdrawn', { patientId });
    return { aiProcessingConsent: consent };
  });
});
