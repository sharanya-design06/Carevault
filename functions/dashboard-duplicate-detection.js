// Rule-based duplicate suggestions ("rules-v1"); the interface matches the planned AI service. It only suggests:
// a PCC reviews every match and nothing is merged without human confirmation.
const MODEL = 'rules-v1';
const THRESHOLD = 0.6;

const bigrams = (text) => {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  const out = new Map();
  for (let i = 0; i < compact.length - 1; i++) out.set(compact.slice(i, i + 2), (out.get(compact.slice(i, i + 2)) || 0) + 1);
  return out;
};

// Sørensen–Dice similarity over character pairs, so small typos still score high.
function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = bigrams(a), y = bigrams(b);
  let overlap = 0, total = 0;
  for (const [pair, count] of x) overlap += Math.min(count, y.get(pair) || 0), total += count;
  for (const count of y.values()) total += count;
  return total ? (2 * overlap) / total : 0;
}

function scoreDuplicate(a, b) {
  const reasons = [];
  let score = 0;
  if (a.abhaId && a.abhaId === b.abhaId) { score += 0.6; reasons.push('same ABHA number'); }
  const similarity = nameSimilarity(a.nameKey, b.nameKey);
  if (similarity >= 0.85) { score += 0.5; reasons.push(similarity === 1 ? 'same name' : 'very similar name'); }
  else if (similarity >= 0.7) { score += 0.3; reasons.push('similar name'); }
  if (a.dob === b.dob) { score += 0.3; reasons.push('same date of birth'); }
  if (a.phoneKey && a.phoneKey === b.phoneKey) { score += 0.25; reasons.push('same phone number'); }
  if (a.gender !== b.gender) score -= 0.3;
  return { score: Math.round(Math.min(1, Math.max(0, score)) * 100) / 100, reasons };
}

const pairId = (a, b) => [a, b].sort().join('__');

// Finds likely duplicates among the same hospital's active patients. Must run before any write in the transaction.
async function findDuplicateCandidates(tx, db, hospitalId, patient) {
  const base = () => db.collection('dashboardPatients').where('hospitalId', '==', hospitalId);
  const queries = [base().where('dob', '==', patient.dob)];
  if (patient.phoneKey) queries.push(base().where('phoneKey', '==', patient.phoneKey));
  if (patient.abhaId) queries.push(base().where('abhaId', '==', patient.abhaId));
  const seen = new Map();
  for (const query of queries) {
    for (const doc of (await tx.get(query.limit(50))).docs) {
      if (doc.id !== patient.hrid && doc.get('status') === 'active') seen.set(doc.id, doc.data());
    }
  }
  return [...seen.values()]
    .map((other) => ({ other, ...scoreDuplicate(patient, other) }))
    .filter((match) => match.score >= THRESHOLD);
}

module.exports = { MODEL, THRESHOLD, nameSimilarity, scoreDuplicate, pairId, findDuplicateCandidates };
