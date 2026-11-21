const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { FieldValue } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { id, uid, authorize, audit } = require('./secure-report-auth');

const REGION = 'asia-south1';
const MAX_FILE = 10 * 1024 * 1024;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const LEASE_MS = 11 * 60 * 1000;
const STAFF = ['doctor', 'lab'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function loadReport(tx, reportId) {
  const ref = admin.firestore().doc('secureReports/' + reportId), snapshot = await tx.get(ref);
  if (!snapshot.exists) throw new HttpsError('permission-denied', 'Report access denied.');
  const report = snapshot.data();
  id(report.patientId);
  return { ref, report };
}

exports.getSecureReportIdentity = onCall({ region: REGION }, async (request) => {
  const actor = uid(request), snapshot = await admin.firestore().doc('secureReportUsers/' + actor).get();
  const user = snapshot.exists ? snapshot.data() : null;
  if (!user || user.status !== 'active' || !['doctor', 'lab', 'patient'].includes(user.role)) {
    throw new HttpsError('permission-denied', 'Report access denied.');
  }
  return { role: user.role };
});

exports.uploadSecureReport = onCall({ region: REGION, memory: '512MiB', timeoutSeconds: 120 }, async (request) => {
  const actor = uid(request), data = request.data || {}, patientId = id(data.patientId);
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  if (title.length < 3 || title.length > 120) {
    throw new HttpsError('invalid-argument', 'Report title must contain 3 to 120 characters.');
  }
  if (typeof data.pdf !== 'string' || data.pdf.length > Math.ceil(MAX_FILE / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.pdf)) {
    throw new HttpsError('invalid-argument', 'Invalid PDF data or file exceeds 10 MiB.');
  }
  const bytes = Buffer.from(data.pdf, 'base64');
  if (bytes.length > MAX_FILE || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new HttpsError('invalid-argument', 'Choose a PDF file of at most 10 MiB.');
  }
  const db = admin.firestore();
  await db.runTransaction((tx) => authorize(tx, actor, { patientId, roles: STAFF }));
  const reportRef = db.collection('secureReports').doc(), jobRef = db.collection('secureReportJobs').doc();
  const object = admin.storage().bucket().file('secure-reports/originals/' + reportRef.id + '.pdf');
  let saved = false;
  try {
    await object.save(bytes, { contentType: 'application/pdf', resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
    saved = true;
    await db.runTransaction(async (tx) => {
      const { user } = await authorize(tx, actor, { patientId, roles: STAFF });
      tx.create(reportRef, {
        patientId, hospitalId: user.hospitalId, title, uploadedBy: actor, fileSha256: sha256(bytes),
        status: 'queued', jobId: jobRef.id, createdAt: FieldValue.serverTimestamp(),
      });
      tx.create(jobRef, { reportId: reportRef.id, actor, createdAt: FieldValue.serverTimestamp() });
      audit(tx, actor, user.role, reportRef.id, 'upload');
    });
  } catch (error) {
    logger.error('Secure report upload failed', { reportId: reportRef.id, code: error.code || error.name });
    if (saved) await object.delete().catch(() => {});
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'Report upload failed. Try again.');
  }
  return { reportId: reportRef.id, status: 'queued' };
});

exports.getSecureReportStatus = onCall({ region: REGION }, async (request) => {
  const actor = uid(request), reportId = id(request.data && request.data.reportId);
  return admin.firestore().runTransaction(async (tx) => {
    const { report } = await loadReport(tx, reportId);
    const { user } = await authorize(tx, actor, { patientId: report.patientId, reportHospital: report.hospitalId, roles: STAFF });
    audit(tx, actor, user.role, reportId, 'read-processing-status');
    return {
      reportId, status: report.status, pageCount: report.pageCount || 0,
      unreadablePages: report.unreadablePages || [], ocrWithoutText: report.ocrWithoutText || [],
      aiStatus: report.aiStatus || 'not-started', aiError: report.aiError || null,
      error: report.processingError || null,
    };
  });
});

exports.retrySecureReport = onCall({ region: REGION }, async (request) => {
  const actor = uid(request), reportId = id(request.data && request.data.reportId);
  const db = admin.firestore(), jobRef = db.collection('secureReportJobs').doc();
  await db.runTransaction(async (tx) => {
    const { ref, report } = await loadReport(tx, reportId);
    const { user } = await authorize(tx, actor, { patientId: report.patientId, reportHospital: report.hospitalId, roles: STAFF });
    if (report.status !== 'failed') throw new HttpsError('failed-precondition', 'Only failed reports can be retried.');
    tx.update(ref, {
      status: 'queued', jobId: jobRef.id, processingError: FieldValue.delete(),
      aiStatus: FieldValue.delete(), aiError: FieldValue.delete(), summary: FieldValue.delete(), review: FieldValue.delete(),
    });
    tx.create(jobRef, { reportId, actor, createdAt: FieldValue.serverTimestamp() });
    audit(tx, actor, user.role, reportId, 'retry-extraction');
  });
  return { reportId, status: 'queued' };
});

exports.getSecureReportPage = onCall({ region: REGION, memory: '512MiB' }, async (request) => {
  const actor = uid(request), data = request.data || {}, reportId = id(data.reportId);
  if (!Number.isSafeInteger(data.page) || data.page < 1) throw new HttpsError('invalid-argument', 'Invalid page number.');
  const jobId = await admin.firestore().runTransaction(async (tx) => {
    const { report } = await loadReport(tx, reportId);
    const { user } = await authorize(tx, actor, { patientId: report.patientId, reportHospital: report.hospitalId, roles: STAFF });
    if (report.status !== 'complete' || data.page > report.pageCount) {
      throw new HttpsError('failed-precondition', 'The requested page is not available.');
    }
    audit(tx, actor, user.role, reportId, 'read-extracted-page', { page: data.page });
    return id(report.jobId);
  });
  try {
    const [bytes] = await admin.storage().bucket().file(
      'secure-reports/extractions/' + reportId + '/' + jobId + '/' + data.page + '.json').download();
    if (bytes.length > MAX_PAGE_BYTES) throw new Error('Extracted page too large');
    return { page: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    logger.error('Secure report page read failed', { reportId, page: data.page, code: error.code || error.name });
    throw new HttpsError('internal', 'The extracted page could not be read.');
  }
});

exports.getSecureReportOriginal = onCall({ region: REGION, memory: '512MiB', timeoutSeconds: 120 }, async (request) => {
  const actor = uid(request), reportId = id(request.data && request.data.reportId);
  const db = admin.firestore();
  const read = async (tx) => {
    const { report } = await loadReport(tx, reportId);
    const { user } = await authorize(tx, actor, { patientId: report.patientId, reportHospital: report.hospitalId, roles: STAFF });
    return { report, user };
  };
  const { report } = await db.runTransaction(read);
  let bytes;
  try {
    [bytes] = await admin.storage().bucket().file('secure-reports/originals/' + reportId + '.pdf').download();
    if (bytes.length > MAX_FILE || sha256(bytes) !== report.fileSha256) throw new Error('Stored report integrity check failed');
  } catch (error) {
    logger.error('Secure original report read failed', { reportId, code: error.code || error.name });
    throw new HttpsError('internal', 'The original report could not be read.');
  }
  await db.runTransaction(async (tx) => {
    const current = await read(tx);
    if (current.report.fileSha256 !== report.fileSha256) throw new HttpsError('failed-precondition', 'The report changed. Please try again.');
    audit(tx, actor, current.user.role, reportId, 'read-original-report');
  });
  return { pdf: bytes.toString('base64') };
});

async function extract(bytes, bucket, reportId, jobId) {
  const { extractReportPages } = await import('./report-extraction.mjs');
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');
  const { createWorker } = require('tesseract.js');
  const options = {
    standardFontDataUrl: path.join(__dirname, 'node_modules/pdfjs-dist/standard_fonts') + path.sep,
    cMapUrl: path.join(__dirname, 'node_modules/pdfjs-dist/cmaps') + path.sep,
    cMapPacked: true,
  };
  const ocr = {
    createCanvas: () => createCanvas(1, 1),
    async createWorker() {
      const worker = await createWorker('eng', 1, {
        langPath: path.join(__dirname, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int'), cacheMethod: 'none',
      });
      return { recognize: (canvas) => worker.recognize(canvas.toBuffer('image/png')), terminate: () => worker.terminate() };
    },
  };
  return extractReportPages(bytes, async (page) => {
    const json = JSON.stringify(page);
    if (Buffer.byteLength(json) > MAX_PAGE_BYTES) throw new Error('Extracted page exceeds the processing limit');
    await bucket.file('secure-reports/extractions/' + reportId + '/' + jobId + '/' + page.page + '.json')
      .save(json, { contentType: 'application/json', resumable: false });
  }, pdf, options, ocr);
}

exports.processSecureReport = onDocumentCreated({
  document: 'secureReportJobs/{jobId}', region: REGION, retry: true, memory: '2GiB', timeoutSeconds: 540, concurrency: 1,
}, async (event) => {
  const jobId = id(event.params.jobId), job = event.data.data(), reportId = id(job.reportId);
  const db = admin.firestore(), reportRef = db.doc('secureReports/' + reportId);
  const claimed = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(reportRef);
    if (!snapshot.exists) return null;
    const report = snapshot.data();
    if (report.jobId !== jobId || ['complete', 'failed'].includes(report.status)) return null;
    const lease = report.leaseUntil && (typeof report.leaseUntil.toMillis === 'function'
      ? report.leaseUntil.toMillis() : new Date(report.leaseUntil).getTime());
    if (report.status === 'processing' && lease > Date.now()) throw new Error('Processing lease is still active');
    tx.update(reportRef, { status: 'processing', leaseUntil: new Date(Date.now() + LEASE_MS) });
    return report;
  });
  if (!claimed) return;
  try {
    const bucket = admin.storage().bucket();
    const [bytes] = await bucket.file('secure-reports/originals/' + reportId + '.pdf').download();
    if (bytes.length > MAX_FILE || sha256(bytes) !== claimed.fileSha256) throw new Error('Stored report integrity check failed');
    const result = await extract(bytes, bucket, reportId, jobId);
    await db.runTransaction(async (tx) => {
      const current = await tx.get(reportRef);
      if (!current.exists || current.data().jobId !== jobId || current.data().status !== 'processing') return;
      tx.update(reportRef, {
        status: 'complete', pageCount: result.pages.length, ocrPages: result.ocrPages,
        unreadablePages: result.pages.filter((p) => !p.readable).map((p) => p.page),
        ocrWithoutText: result.pages.filter((p) => p.ocr && !p.ocrTextFound).map((p) => p.page),
        processedAt: FieldValue.serverTimestamp(), leaseUntil: FieldValue.delete(), processingError: FieldValue.delete(),
      });
      audit(tx, job.actor, 'system', reportId, 'extraction-complete', { jobId });
    });
  } catch (error) {
    logger.error('Secure report extraction failed', { reportId, jobId, code: error.code || error.name });
    await db.runTransaction(async (tx) => {
      const current = await tx.get(reportRef);
      if (!current.exists || current.data().jobId !== jobId || current.data().status !== 'processing') return;
      tx.update(reportRef, {
        status: 'failed',
        processingError: error.code === 'report-page-limit'
          ? 'Report exceeds the 100-page processing limit. Split it into smaller PDFs.'
          : 'Extraction failed. Check the PDF and retry.',
        processedAt: FieldValue.serverTimestamp(), leaseUntil: FieldValue.delete(),
      });
      audit(tx, job.actor, 'system', reportId, 'extraction-failed', { jobId, errorCode: error.code || error.name });
    });
  }
});
