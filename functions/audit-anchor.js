const logger = require('firebase-functions/logger');

// Audit entries are write-once. Each new entry is copied to an anchor record and to Cloud Logging, so a later
// edit or deletion (for example by someone with console access) is reversed and leaves a high-severity log entry.
// Route the `auditMirror` log entries to a log bucket with a locked retention policy for tamper evidence (see README).
const canonical = (value) => {
  if (value && typeof value.toMillis === 'function') return { _ts: value.toMillis() };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const anchorRef = (db, collection, id) => db.collection('auditAnchors').doc(collection + '__' + id);

async function mirrorAuditEntry(db, collection, id, data) {
  if (!data) return;
  await anchorRef(db, collection, id).create({ collection, id, data }).catch((error) => {
    if (error.code !== 6) throw error;
  });
  logger.info('audit entry', { auditMirror: true, collection, id, entry: canonical(data) });
}

// `current` is the document as it now exists, or null if it was deleted. Returns true when it had to be restored.
async function enforceAuditEntry(db, collection, id, current) {
  const anchor = await anchorRef(db, collection, id).get();
  if (!anchor.exists) return false;
  const original = anchor.get('data');
  if (current && same(current, original)) return false;
  await db.collection(collection).doc(id).set(original);
  logger.error('Audit entry was modified or deleted and has been restored', {
    auditTamper: true, collection, id, deleted: current === null,
  });
  return true;
}

module.exports = { mirrorAuditEntry, enforceAuditEntry };
