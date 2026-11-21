const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { activeActor, patientCard } = require('./dashboard-registration');

const MAX_MERGED = 20;
const bad = () => new HttpsError('invalid-argument', 'Invalid request.');
const denied = () => new HttpsError('permission-denied', 'Duplicate review denied.');
const millis = (value) => (value && value.toMillis ? value.toMillis() : null);

const card = (doc) => ({ ...patientCard(doc.data()), phone: doc.get('phone') || '', hasAccount: !!doc.get('authUid') });

async function listDuplicateCandidates(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (actor.role !== 'PCC') throw denied();
    const pending = await tx.get(db.collection('dashboardDuplicateCandidates').where('hospitalId', '==', actor.hospitalId)
      .where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(50));
    const rows = [];
    for (const doc of pending.docs) {
      const [first, second] = await Promise.all(doc.get('patientIds').map((id) => tx.get(db.collection('dashboardPatients').doc(id))));
      // A candidate whose patients were merged or deactivated since is no longer reviewable.
      if (!first.exists || !second.exists || first.get('status') !== 'active' || second.get('status') !== 'active') continue;
      rows.push({
        id: doc.id, score: doc.get('score'), reasons: doc.get('reasons'), model: doc.get('model'),
        createdAt: millis(doc.get('createdAt')), patients: [card(first), card(second)],
      });
    }
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'duplicate_candidates_read', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
      patientIds: rows.flatMap((row) => row.patients.map((p) => p.hrid)), timestamp: FieldValue.serverTimestamp(),
    });
    return rows;
  });
}

// Merging never moves or rewrites records. The secondary record is retired and points at the primary, whose history
// then reads through to the secondary's records, so each record keeps its original patient ID and provenance.
async function reviewDuplicateCandidate(request, db) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { candidateId, decision, primaryHrid } = request.data || {};
  if (typeof candidateId !== 'string' || !candidateId || candidateId.includes('/') || !['merge', 'reject'].includes(decision)) throw bad();
  return db.runTransaction(async (tx) => {
    const actor = await activeActor(request, db, tx);
    if (actor.role !== 'PCC') throw denied();
    const ref = db.collection('dashboardDuplicateCandidates').doc(candidateId);
    const candidate = await tx.get(ref);
    if (!candidate.exists || candidate.get('hospitalId') !== actor.hospitalId) throw denied();
    if (candidate.get('status') !== 'pending') throw new HttpsError('failed-precondition', 'This match was already reviewed.');
    const ids = candidate.get('patientIds');
    const timestamp = FieldValue.serverTimestamp();
    const review = { reviewedBy: actor.uid, reviewedAt: timestamp };

    if (decision === 'reject') {
      tx.update(ref, { status: 'rejected', ...review });
      tx.create(db.collection('dashboardAudit').doc(), {
        action: 'duplicate_rejected', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
        patientIds: ids, candidateId, timestamp,
      });
      return { candidateId, status: 'rejected' };
    }

    if (!ids.includes(primaryHrid)) throw bad();
    const secondaryHrid = ids.find((id) => id !== primaryHrid);
    const [primary, secondary] = await Promise.all([primaryHrid, secondaryHrid].map((id) => tx.get(db.collection('dashboardPatients').doc(id))));
    const sameHospital = (p) => p.exists && p.get('status') === 'active' && p.get('hospitalId') === actor.hospitalId;
    if (!sameHospital(primary) || !sameHospital(secondary)) throw new HttpsError('failed-precondition', 'Both patients must be active at this hospital.');
    if (secondary.get('authUid')) {
      throw new HttpsError('failed-precondition', 'The patient with a login must be kept as the primary record.');
    }
    const mergedFrom = [...new Set([...(primary.get('mergedFrom') || []), secondaryHrid, ...(secondary.get('mergedFrom') || [])])];
    if (mergedFrom.length > MAX_MERGED) throw new HttpsError('failed-precondition', 'Too many records are already merged into this patient.');
    const others = await tx.get(db.collection('dashboardDuplicateCandidates').where('patientIds', 'array-contains', secondaryHrid)
      .where('status', '==', 'pending').limit(50));

    tx.update(secondary.ref, { status: 'inactive', mergedInto: primaryHrid, mergedAt: timestamp, mergedBy: actor.uid });
    tx.update(primary.ref, { mergedFrom });
    tx.update(ref, { status: 'merged', primaryHrid, ...review });
    others.docs.filter((doc) => doc.id !== candidateId).forEach((doc) => tx.update(doc.ref, { status: 'superseded', ...review }));
    tx.create(db.collection('dashboardAudit').doc(), {
      action: 'duplicate_merged', actorUid: actor.uid, actorRole: actor.role, hospitalId: actor.hospitalId,
      patientId: primaryHrid, mergedPatientId: secondaryHrid, candidateId, timestamp,
    });
    return { candidateId, status: 'merged', primaryHrid };
  });
}

module.exports = { listDuplicateCandidates, reviewDuplicateCandidate };
