const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { activeActor, patientScope, HRID } = require('./dashboard-registration');

const bad = () => new HttpsError('invalid-argument', 'Invalid note.');
const denied = () => new HttpsError('permission-denied', 'Note access denied.');
const READERS = ['DOCTOR', 'NURSE'];
const MAX_TEXT = 5000;

// Structured templates. `required` fields must be filled before a note can be signed.
const NOTE_TYPES = {
  consultation: { fields: ['complaint', 'history', 'examination', 'assessment', 'plan'], required: ['complaint', 'assessment', 'plan'] },
  progress: { fields: ['subjective', 'objective', 'assessment', 'plan'], required: ['assessment', 'plan'], inpatientOnly: true },
  referral: { fields: ['toSpecialty', 'reason', 'summary'], required: ['toSpecialty', 'reason'] },
  operative: { fields: ['consentConfirmed', 'procedure', 'findings', 'implants', 'postOpOrders'], required: ['consentConfirmed', 'procedure'], subTypes: ['SURGEON'] },
  anesthesia: { fields: ['preAssessment', 'chart', 'recovery'], required: ['preAssessment', 'chart'], subTypes: ['ANESTHETIST'] },
  discharge: { fields: ['diagnosis', 'procedures', 'results', 'medicines', 'followUp', 'warningSigns'], required: ['diagnosis', 'medicines', 'followUp', 'warningSigns'] },
};

const hridOf = (data) => {
  if (!data || typeof data.hrid !== 'string' || !HRID.test(data.hrid)) throw bad();
  return data.hrid;
};
const idOf = (value) => {
  if (typeof value !== 'string' || !value || value.length > 128 || value.includes('/')) throw bad();
  return value;
};

function checkedContent(type, content) {
  const spec = NOTE_TYPES[type];
  if (!spec || !content || typeof content !== 'object' || Array.isArray(content) ||
      Object.keys(content).some((key) => !spec.fields.includes(key))) throw bad();
  const out = {};
  for (const key of spec.fields) {
    const value = content[key];
    if (value === undefined) continue;
    if (key === 'consentConfirmed') {
      if (typeof value !== 'boolean') throw bad();
    } else if (typeof value !== 'string' || value.length > MAX_TEXT) throw bad();
    out[key] = typeof value === 'string' ? value.trim() : value;
  }
  if (!Object.keys(out).length) throw bad();
  return out;
}

const filled = (content, key) => (key === 'consentConfirmed' ? content[key] === true : typeof content[key] === 'string' && content[key].length > 0);

function mayWrite(actor, type) {
  const spec = NOTE_TYPES[type];
  return actor.role === 'DOCTOR' && (!spec.subTypes || spec.subTypes.includes(actor.subType));
}

async function openEncounter(tx, db, hrid, hospitalId) {
  const open = await tx.get(db.collection('dashboardEncounters').where('patientId', '==', hrid)
    .where('hospitalId', '==', hospitalId).where('status', '==', 'open').limit(1));
  if (open.empty) throw new HttpsError('failed-precondition', 'This patient has no open encounter.');
  return open.docs[0];
}

// An encounter closes and locks once the discharge summary is signed and billing is cleared, in either order.
function lockPatch(encounter, patch) {
  const merged = { ...encounter, ...patch };
  return merged.dischargeSigned && merged.billingCleared
    ? { ...patch, status: 'closed', locked: true, closedAt: FieldValue.serverTimestamp() } : patch;
}

async function loadNote(tx, db, actor, noteId) {
  const ref = db.collection('dashboardNotes').doc(noteId);
  const snapshot = await tx.get(ref);
  if (!snapshot.exists) throw denied();
  const note = snapshot.data();
  const patientSnapshot = await tx.get(db.collection('dashboardPatients').doc(note.patientId));
  if (!patientSnapshot.exists || patientSnapshot.get('status') === 'inactive') throw denied();
  const scope = await patientScope(tx, db, actor, note.patientId, patientSnapshot.data());
  return { ref, note, scope, patient: patientSnapshot.data() };
}

// Drafts are private to their author; a reasoned cross-hospital grant only ever shows signed notes.
const visibleTo = (actor, scope, note) => READERS.includes(actor.role) &&
  (note.status === 'signed' ? ['care', 'reasoned'].includes(scope) : scope === 'care' && note.authorUid === actor.uid);

async function saveDashboardNote(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { noteType, noteId, baseVersion } = request.data || {};
  const content = checkedContent(noteType, request.data.content);
  if (noteId !== undefined) idOf(noteId);
  if (baseVersion !== undefined && !Number.isInteger(baseVersion)) throw bad();
  const hrid = noteId === undefined ? hridOf(request.data) : undefined;
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (!mayWrite(actor, noteType)) throw denied();
    const timestamp = FieldValue.serverTimestamp();
    if (noteId === undefined) {
      const patientSnapshot = await tx.get(db.collection('dashboardPatients').doc(hrid));
      if (!patientSnapshot.exists || patientSnapshot.get('status') === 'inactive') throw denied();
      if ((await patientScope(tx, db, actor, hrid, patientSnapshot.data())) !== 'care') throw denied();
      const encounter = await openEncounter(tx, db, hrid, actor.hospitalId);
      if (NOTE_TYPES[noteType].inpatientOnly && encounter.get('type') !== 'inpatient') {
        throw new HttpsError('failed-precondition', 'Progress notes belong to inpatient encounters.');
      }
      const ref = db.collection('dashboardNotes').doc();
      tx.create(ref, {
        patientId: hrid, encounterId: encounter.id, hospitalId: actor.hospitalId, noteType, status: 'draft', version: 1, content,
        sensitive: true, authorUid: actor.uid, authorRole: actor.role, authorSubType: actor.subType, createdAt: timestamp, updatedAt: timestamp,
      });
      tx.create(ref.collection('versions').doc('1'), { version: 1, content, authorUid: actor.uid, createdAt: timestamp });
      tx.create(db.collection('dashboardAudit').doc(), {
        action: 'note_saved', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
        patientId: hrid, encounterId: encounter.id, noteId: ref.id, noteType, version: 1, timestamp,
      });
      return { noteId: ref.id, version: 1 };
    }
    const { ref, note, scope } = await loadNote(tx, db, actor, noteId);
    const encounter = await tx.get(db.collection('dashboardEncounters').doc(note.encounterId));
    if (note.authorUid !== actor.uid || note.hospitalId !== actor.hospitalId || scope !== 'care' || note.noteType !== noteType) throw denied();
    if (note.status !== 'draft') throw new HttpsError('failed-precondition', 'Signed notes cannot be edited; add an addendum.');
    if (!encounter.exists || encounter.get('locked')) throw new HttpsError('failed-precondition', 'This encounter is locked.');
    if (baseVersion !== undefined && baseVersion !== note.version) throw new HttpsError('aborted', 'The note changed; reload it.');
    const version = note.version + 1;
    tx.update(ref, { content, version, updatedAt: timestamp });
    tx.create(ref.collection('versions').doc(String(version)), { version, content, authorUid: actor.uid, createdAt: timestamp });
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'note_saved', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
      patientId: note.patientId, encounterId: note.encounterId, noteId, noteType, version, timestamp,
    });
    return { noteId, version };
  });
}

async function signDashboardNote(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const noteId = idOf(request.data && request.data.noteId);
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    const { ref, note, scope } = await loadNote(tx, db, actor, noteId);
    const encounterRef = db.collection('dashboardEncounters').doc(note.encounterId);
    const encounter = await tx.get(encounterRef);
    if (!mayWrite(actor, note.noteType) || note.authorUid !== actor.uid || note.hospitalId !== actor.hospitalId || scope !== 'care') throw denied();
    if (note.status !== 'draft') throw new HttpsError('failed-precondition', 'This note is already signed.');
    if (!encounter.exists || encounter.get('locked')) throw new HttpsError('failed-precondition', 'This encounter is locked.');
    const missing = NOTE_TYPES[note.noteType].required.filter((key) => !filled(note.content, key));
    if (missing.length) throw new HttpsError('failed-precondition', 'Complete these fields before signing: ' + missing.join(', '));
    const timestamp = FieldValue.serverTimestamp();
    tx.update(ref, { status: 'signed', signedAt: timestamp, signedBy: actor.uid, updatedAt: timestamp });
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'note_signed', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
      patientId: note.patientId, encounterId: note.encounterId, noteId, noteType: note.noteType, version: note.version, timestamp,
    });
    let locked = false;
    if (note.noteType === 'discharge') {
      const patch = lockPatch(encounter.data(), { dischargeSigned: true });
      tx.update(encounterRef, patch);
      locked = patch.locked === true;
      if (locked) {
        tx.create(db.collection('dashboardAudit').doc(), {
          action: 'encounter_locked', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
          patientId: note.patientId, encounterId: note.encounterId, timestamp,
        });
      }
    }
    return { noteId, status: 'signed', encounterLocked: locked };
  });
}

// Corrections to a signed note are dated addenda that state what changed and why; they stay allowed after the encounter locks.
async function addDashboardNoteAddendum(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const noteId = idOf(request.data && request.data.noteId);
  const { text, reason } = request.data;
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT ||
      typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw bad();
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    const { ref, note, scope } = await loadNote(tx, db, actor, noteId);
    if (!mayWrite(actor, note.noteType) || note.authorUid !== actor.uid || note.hospitalId !== actor.hospitalId || scope !== 'care') throw denied();
    if (note.status !== 'signed') throw new HttpsError('failed-precondition', 'Only signed notes take addenda; edit the draft instead.');
    const addendum = ref.collection('addenda').doc();
    const timestamp = FieldValue.serverTimestamp();
    tx.create(addendum, { text: text.trim(), reason: reason.trim(), authorUid: actor.uid, createdAt: timestamp });
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'note_addendum_added', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
      patientId: note.patientId, encounterId: note.encounterId, noteId, addendumId: addendum.id, timestamp,
    });
    return { noteId, addendumId: addendum.id };
  });
}

const millis = (value) => (value && value.toMillis ? value.toMillis() : null);

async function listDashboardNotes(request, db) {
  const hrid = hridOf(request.data);
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (!READERS.includes(actor.role)) throw denied();
    const patientSnapshot = await tx.get(db.collection('dashboardPatients').doc(hrid));
    if (!patientSnapshot.exists || patientSnapshot.get('status') === 'inactive') throw denied();
    const scope = await patientScope(tx, db, actor, hrid, patientSnapshot.data());
    const snapshot = await tx.get(db.collection('dashboardNotes').where('patientId', 'in', [hrid, ...(patientSnapshot.get('mergedFrom') || [])]).orderBy('createdAt', 'desc').limit(100));
    const notes = snapshot.docs.filter((doc) => visibleTo(actor, scope, doc.data()));
    const addenda = await Promise.all(notes.map((doc) => tx.get(doc.ref.collection('addenda').orderBy('createdAt', 'asc').limit(50))));
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'sensitive_record_read', actorUid: actor.uid, actorRole: actor.role,
      hospitalId: patientSnapshot.get('hospitalId'), viewerHospitalId: actor.hospitalId || null, patientId: hrid,
      recordIds: notes.map((doc) => doc.id), recordTypes: ['note'], accessScope: scope, timestamp: FieldValue.serverTimestamp(),
    });
    return notes.map((doc, index) => {
      const n = doc.data();
      return {
        id: doc.id, noteType: n.noteType, status: n.status, version: n.version, content: n.content, encounterId: n.encounterId,
        hospitalId: n.hospitalId, authorRole: n.authorRole, authorSubType: n.authorSubType || null, own: n.authorUid === actor.uid,
        createdAt: millis(n.createdAt), signedAt: millis(n.signedAt),
        addenda: addenda[index].docs.map((a) => ({ id: a.id, text: a.get('text'), reason: a.get('reason'), createdAt: millis(a.get('createdAt')) })),
      };
    });
  });
}

async function getDashboardNoteVersions(request, db) {
  const noteId = idOf(request.data && request.data.noteId);
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    const { ref, note, scope } = await loadNote(tx, db, actor, noteId);
    if (!visibleTo(actor, scope, note)) throw denied();
    const versions = await tx.get(ref.collection('versions').orderBy('version', 'asc').limit(200));
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'note_versions_read', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId || null,
      patientId: note.patientId, noteId, accessScope: scope, timestamp: FieldValue.serverTimestamp(),
    });
    return versions.docs.map((v) => ({ version: v.get('version'), content: v.get('content'), createdAt: millis(v.get('createdAt')) }));
  });
}

// Placeholder gate until the billing module exists: the PCC confirms the account is settled, which can complete the lock.
async function markEncounterBillingCleared(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const encounterId = idOf(request.data && request.data.encounterId);
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (actor.role !== 'PCC') throw denied();
    const ref = db.collection('dashboardEncounters').doc(encounterId);
    const encounter = await tx.get(ref);
    if (!encounter.exists || encounter.get('hospitalId') !== actor.hospitalId) throw denied();
    if (encounter.get('locked')) throw new HttpsError('failed-precondition', 'This encounter is already locked.');
    const patch = lockPatch(encounter.data(), { billingCleared: true });
    tx.update(ref, patch);
    const timestamp = FieldValue.serverTimestamp();
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'billing_cleared', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
      patientId: encounter.get('patientId'), encounterId, timestamp,
    });
    if (patch.locked) {
      tx.create(db.collection('dashboardAudit').doc(), {
        action: 'encounter_locked', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
        patientId: encounter.get('patientId'), encounterId, timestamp,
      });
    }
    return { encounterId, encounterLocked: patch.locked === true };
  });
}

// The PCC's billing-clearance worklist: this hospital's open encounters with the two lock conditions. Equality-only
// filters need no composite index; no clinical content is returned (the PCC sees only visit type and lock state).
async function listOpenEncounters(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (actor.role !== 'PCC') throw denied();
    const open = await tx.get(db.collection('dashboardEncounters')
      .where('hospitalId', '==', actor.hospitalId).where('status', '==', 'open').limit(200));
    const patients = await Promise.all(open.docs.map((doc) => tx.get(db.collection('dashboardPatients').doc(doc.get('patientId')))));
    const rows = open.docs.map((doc, i) => ({
      encounterId: doc.id, hrid: doc.get('patientId'), patientName: patients[i].exists ? patients[i].get('name') : '',
      visitType: doc.get('type'), openedAt: doc.get('createdAt') && doc.get('createdAt').toMillis ? doc.get('createdAt').toMillis() : 0,
      dischargeSigned: doc.get('dischargeSigned') === true, billingCleared: doc.get('billingCleared') === true,
    })).sort((a, b) => b.openedAt - a.openedAt);
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'open_encounters_read', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
      encounterIds: rows.map((row) => row.encounterId), timestamp: FieldValue.serverTimestamp(),
    });
    return rows;
  });
}

module.exports = {
  listOpenEncounters, saveDashboardNote, signDashboardNote, addDashboardNoteAddendum, listDashboardNotes, getDashboardNoteVersions, markEncounterBillingCleared,
};
