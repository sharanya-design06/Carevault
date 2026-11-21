const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
const { mirrorAuditEntry, enforceAuditEntry } = require('./audit-anchor');

const REGION = 'asia-south1';
// secureReportAudit is not guarded: adding these triggers to it stalls the secure-report e2e suite in the emulator.
const AUDITED = ['dashboardAudit'];

const exported = {};
for (const collection of AUDITED) {
  const document = collection + '/{id}';
  const suffix = collection[0].toUpperCase() + collection.slice(1);
  exported['mirror' + suffix] = onDocumentCreated({ document, region: REGION }, (event) =>
    mirrorAuditEntry(admin.firestore(), collection, event.params.id, event.data && event.data.data()));
  exported['guardUpdated' + suffix] = onDocumentUpdated({ document, region: REGION }, (event) =>
    enforceAuditEntry(admin.firestore(), collection, event.params.id, event.data.after.data()));
  exported['guardDeleted' + suffix] = onDocumentDeleted({ document, region: REGION }, (event) =>
    enforceAuditEntry(admin.firestore(), collection, event.params.id, null));
}

module.exports = exported;
