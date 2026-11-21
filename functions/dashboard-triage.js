const { HttpsError } = require('firebase-functions/v2/https');

const bad = () => new HttpsError('invalid-argument', 'Invalid request.');

const RISK = ['low', 'moderate', 'high'];
// Lower rank is seen first.
const QUEUE_RANK = { emergent: 1, urgent: 2, less_urgent: 3, non_urgent: 4 };
const UNTRIAGED_RANK = 5;
const PRIORITY_CATEGORIES = ['elderly', 'child', 'pregnant', 'disabled', 'immunocompromised', 'cognitively_impaired', 'fall_risk'];
const BMI_POLICIES = ['WHO', 'ASIA_PACIFIC'];
const ADULT_AGE = 18;

const ageInYears = (dob, now = new Date()) => {
  const born = new Date(dob + 'T00:00:00.000Z');
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  if (now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate())) age--;
  return age;
};

// Adult cut-offs follow hospital policy: WHO by default, Asia-Pacific optional.
function adultCategory(bmi, policy) {
  if (bmi < 18.5) return 'Underweight';
  if (policy === 'ASIA_PACIFIC') return bmi < 23 ? 'Normal' : bmi < 25 ? 'Overweight' : 'Obese';
  return bmi < 25 ? 'Normal' : bmi < 30 ? 'Overweight' : 'Obese';
}

// BMI is always calculated here; callers cannot supply it. Under 18s need a BMI-for-age percentile, which needs the
// WHO/CDC growth reference tables, so they get the BMI value and no adult category.
function computeBmi({ weightKg, heightCm }, dob, policy, now) {
  if (weightKg === undefined || heightCm === undefined) return {};
  const bmi = Math.round((weightKg / ((heightCm / 100) ** 2)) * 10) / 10;
  if (!Number.isFinite(bmi) || bmi < 8 || bmi > 100) throw new HttpsError('invalid-argument', 'Weight and height are not plausible together.');
  if (ageInYears(dob, now) < ADULT_AGE) return { bmi, bmiCategory: null, bmiBasis: 'age_percentile_required' };
  const used = BMI_POLICIES.includes(policy) ? policy : 'WHO';
  return { bmi, bmiCategory: adultCategory(bmi, used), bmiBasis: used };
}

const TRIAGE_TEXT = { chiefComplaint: 300, allergies: 500, currentMedications: 500 };

function checkedTriage(data) {
  const allowed = ['chiefComplaint', 'allergies', 'currentMedications', 'fallRisk', 'pressureSoreRisk', 'queuePriority'];
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some((key) => !allowed.includes(key))) throw bad();
  const out = {};
  for (const [key, max] of Object.entries(TRIAGE_TEXT)) {
    if (data[key] === undefined) continue;
    if (typeof data[key] !== 'string' || data[key].length > max) throw bad();
    out[key] = data[key].trim();
  }
  for (const key of ['fallRisk', 'pressureSoreRisk']) {
    if (data[key] === undefined) continue;
    if (!RISK.includes(data[key])) throw bad();
    out[key] = data[key];
  }
  if (!out.chiefComplaint || !Object.keys(QUEUE_RANK).includes(data.queuePriority)) throw bad();
  out.queuePriority = data.queuePriority;
  return out;
}

function checkedPriorityCare(data) {
  const { active, categories } = data || {};
  if (typeof active !== 'boolean') throw bad();
  if (!active) return { active: false, categories: [] };
  if (!Array.isArray(categories) || !categories.length || categories.length > PRIORITY_CATEGORIES.length ||
      new Set(categories).size !== categories.length || categories.some((c) => !PRIORITY_CATEGORIES.includes(c))) throw bad();
  return { active: true, categories };
}

// Suggestions come from age only; the nurse or doctor decides.
function suggestedCategories(dob, now) {
  const age = ageInYears(dob, now);
  return age >= 65 ? ['elderly'] : age < 5 ? ['child'] : [];
}

module.exports = {
  QUEUE_RANK, UNTRIAGED_RANK, PRIORITY_CATEGORIES, computeBmi, checkedTriage, checkedPriorityCare, suggestedCategories, ageInYears,
};
