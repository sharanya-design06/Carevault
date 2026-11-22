/**
 * Patient Health Report API Endpoint
 * 
 * This endpoint serves comprehensive health risk assessment reports
 * including disease risk predictions, allergy alerts, and AI summaries
 * for patients to their dashboards.
 */

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

// Initialize if not already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

/**
 * GET /api/patient-report/:patientId
 * 
 * Retrieves comprehensive health report for a patient
 * 
 * Query params:
 *   - format: 'json' (default) or 'summary'
 * 
 * Returns:
 *   - Full report with disease risk assessments, allergies, recommendations
 * 
 * Note: This is a demo endpoint. In production, fetch from database or file storage.
 */
exports.getPatientReport = onRequest(
  { 
    region: 'asia-south1',
    cors: [
      'https://care-vault-project.web.app',
      'https://care-vault-project.firebaseapp.com',
      'http://localhost:8000',
      'http://127.0.0.1:8000',
      'http://localhost:4173',
      'http://127.0.0.1:4173'
    ]
  },
  async (req, res) => {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const patientId = req.params.patientId || req.query.patientId;
    const format = req.query.format || 'json';

    if (!patientId) {
      return res.status(400).json({ error: 'Patient ID required' });
    }

    try {
      // Check patient exists and user has access (simplified - in production, verify auth token)
      const patientRef = db.collection('patients').doc(patientId);
      const patientSnap = await patientRef.get();
      if (!patientSnap.exists) {
        return res.status(404).json({ error: 'Patient not found' });
      }

      // Try to fetch report from storage or database
      // For now, return demo data for Anna Rivera
      const demoReport = getDemoReport(patientSnap.data());

      if (format === 'summary') {
        return res.json({
          patientId: patientId,
          patientName: demoReport.patientInformation.name,
          summary: demoReport.summaryReport,
          diseaseRisks: demoReport.diseaseRiskAssessment,
          allergies: demoReport.allergyAlerts.alerts
        });
      }

      return res.json(demoReport);
    } catch (error) {
      console.error('Error retrieving report:', error);
      return res.status(500).json({ error: 'Failed to retrieve report' });
    }
  }
);

/**
 * GET /api/patient-risk/:patientId
 * 
 * Retrieves disease risk scores for display in doctor's risk tab
 * 
 * Returns:
 *   - Array of disease risk assessments with scores and factors
 */
exports.getPatientRisk = onRequest(
  {
    region: 'asia-south1',
    cors: [
      'https://care-vault-project.web.app',
      'https://care-vault-project.firebaseapp.com',
      'http://localhost:8000',
      'http://127.0.0.1:8000'
    ]
  },
  async (req, res) => {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { patientId } = req.params;

    if (!patientId) {
      return res.status(400).json({ error: 'Patient ID required' });
    }

    try {
      const patientRef = db.collection('patients').doc(patientId);
      const patientSnap = await patientRef.get();

      if (!patientSnap.exists) {
        return res.status(404).json({ error: 'Patient not found' });
      }

      const demoReport = getDemoReport(patientSnap.data());
      const risks = [];

      // Format disease risks for display
      for (const [condition, risk] of Object.entries(demoReport.diseaseRiskAssessment)) {
        if (risk.error) continue;

        risks.push({
          condition: condition.charAt(0).toUpperCase() + condition.slice(1),
          score: risk.riskScore,
          level: risk.riskLevel,
          confidence: 85,
          diagnosed: false,
          factors: formatRiskFactors(condition, risk)
        });
      }

      return res.json({ risks });
    } catch (error) {
      console.error('Error retrieving risk assessment:', error);
      return res.status(500).json({ error: 'Failed to retrieve risk assessment' });
    }
  }
);

/**
 * GET /api/patient-allergies/:patientId
 * 
 * Retrieves patient allergy information with critical alerts
 * 
 * Returns:
 *   - Array of allergies with severity and reaction information
 */
exports.getPatientAllergies = onRequest(
  {
    region: 'asia-south1',
    cors: [
      'https://care-vault-project.web.app',
      'https://care-vault-project.firebaseapp.com',
      'http://localhost:8000',
      'http://127.0.0.1:8000'
    ]
  },
  async (req, res) => {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { patientId } = req.params;

    if (!patientId) {
      return res.status(400).json({ error: 'Patient ID required' });
    }

    try {
      const patientRef = db.collection('patients').doc(patientId);
      const patientSnap = await patientRef.get();

      if (!patientSnap.exists) {
        return res.status(404).json({ error: 'Patient not found' });
      }

      const demoReport = getDemoReport(patientSnap.data());

      return res.json({
        total: demoReport.allergyAlerts.totalAlergies,
        critical: demoReport.allergyAlerts.criticalAlerts,
        warnings: demoReport.allergyAlerts.warnings,
        all: demoReport.allergyAlerts.alerts
      });
    } catch (error) {
      console.error('Error retrieving allergies:', error);
      return res.status(500).json({ error: 'Failed to retrieve allergies' });
    }
  }
);

/**
 * Helper: Format risk factors for display
 */
function formatRiskFactors(condition, risk) {
  if (condition === 'hypertension' && risk.riskFactors) {
    return risk.riskFactors.map(factor => ({
      label: factor,
      known: true,
      earned: 1,
      max: 1
    }));
  }
  return [];
}

/**
 * Demo Report Data - Anna Rivera
 * 
 * In production, this would fetch from:
 * - Firestore documents
 * - Cloud Storage (JSON reports)
 * - Generated reports from AI service
 */
function getDemoReport(patientData) {
  const name = patientData.name || 'Unknown Patient';
  
  return {
    reportMetadata: {
      generatedAt: new Date().toISOString(),
      patientName: name,
      patientID: patientData.hrid || 'PAT-2024-00000',
      reportType: 'Comprehensive Health Risk Assessment',
      clinicalValidation: false,
      disclaimer: 'This report is for research/demo purposes only. Not validated for clinical use.'
    },
    patientInformation: {
      name: name,
      age: 58,
      gender: patientData.gender || 'Female',
      bloodType: 'O+',
      dateOfBirth: patientData.dob || '1966-03-15'
    },
    vitalSigns: {
      age: 58,
      systolicBP: 148,
      diastolicBP: 92,
      heartRate: 82,
      temperature: 98.6,
      respiratoryRate: 18,
      oxygenSaturation: 97
    },
    labResults: {
      glucose: 185,
      HbA1c: 8.2,
      totalCholesterol: 245,
      LDLCholesterol: 165,
      HDLCholesterol: 35,
      triglycerides: 220,
      creatinine: 1.4,
      eGFR: 45,
      hemoglobin: 13.2,
      BMI: 32.5
    },
    currentMedications: [
      'Metformin 500mg BID',
      'Lisinopril 10mg OD',
      'Atorvastatin 20mg OD',
      'Aspirin 81mg OD'
    ],
    diseaseRiskAssessment: {
      diabetes: {
        condition: 'diabetes',
        riskScore: 90.85,
        riskLevel: 'High',
        threshold: 75.03,
        prediction: 'positive',
        model: 'logistic_regression'
      },
      cardiac: {
        condition: 'cardiac',
        riskScore: 33.67,
        riskLevel: 'Low',
        threshold: 75.19,
        prediction: 'negative',
        model: 'logistic_regression'
      },
      liver: {
        condition: 'liver',
        riskScore: 21.6,
        riskLevel: 'Low',
        threshold: 71.15,
        prediction: 'negative',
        model: 'xgboost'
      },
      hypertension: {
        condition: 'hypertension',
        riskScore: 55,
        riskLevel: 'Moderate',
        riskFactors: [
          'Current elevated blood pressure (Stage 2 Hypertension)',
          'Obesity (BMI > 30)'
        ],
        model: 'Rule-based assessment'
      }
    },
    allergyAlerts: {
      totalAlergies: 5,
      criticalAlerts: [
        {
          allergen: 'Penicillin',
          reaction: 'Severe rash and angioedema',
          severity: 'Severe',
          alertType: 'Critical',
          recommendedAction: 'Avoid all forms of Penicillin and cross-reactive substances'
        },
        {
          allergen: 'Sulfonamides',
          reaction: 'Steven-Johnson Syndrome (historical)',
          severity: 'Severe',
          alertType: 'Critical',
          recommendedAction: 'Avoid all forms of Sulfonamides and cross-reactive substances'
        },
        {
          allergen: 'NSAIDs',
          reaction: 'GI bleeding (prior episode)',
          severity: 'Severe',
          alertType: 'Critical',
          recommendedAction: 'Avoid all forms of NSAIDs and cross-reactive substances'
        },
        {
          allergen: 'Shellfish',
          reaction: 'Throat swelling and difficulty breathing',
          severity: 'Severe',
          alertType: 'Critical',
          recommendedAction: 'Avoid all forms of Shellfish and cross-reactive substances'
        }
      ],
      warnings: [
        {
          allergen: 'Metformin',
          reaction: 'Gastrointestinal upset',
          severity: 'Moderate',
          alertType: 'Warning',
          recommendedAction: 'Avoid all forms of Metformin and cross-reactive substances'
        }
      ],
      alerts: [
        {
          allergen: 'Penicillin',
          reaction: 'Severe rash and angioedema',
          severity: 'Severe'
        },
        {
          allergen: 'Sulfonamides',
          reaction: 'Steven-Johnson Syndrome (historical)',
          severity: 'Severe'
        },
        {
          allergen: 'NSAIDs',
          reaction: 'GI bleeding (prior episode)',
          severity: 'Severe'
        },
        {
          allergen: 'Shellfish',
          reaction: 'Throat swelling and difficulty breathing',
          severity: 'Severe'
        },
        {
          allergen: 'Metformin',
          reaction: 'Gastrointestinal upset',
          severity: 'Moderate'
        }
      ]
    },
    summaryReport: 'CLINICAL SUMMARY\n\nReport for patient, 58-year-old Female\n\nDISEASE RISK ASSESSMENT:\n[H] DIABETES - High Risk (90.85%)\n[M] HYPERTENSION - Moderate Risk (55%)\n[L] CARDIAC - Low Risk (33.67%)\n[L] LIVER - Low Risk (21.6%)\n\nHIGH RISK CONDITIONS: 1\nMODERATE RISK CONDITIONS: 1\n\nALLERGY ALERTS: 5 documented allergies\n\nKEY FINDINGS:\n• Comprehensive disease risk assessment completed\n• Critical allergy information documented\n• Patient data analyzed across multiple disease models',
    recommendations: [
      'Schedule HbA1c test and glucose monitoring. Consider endocrinology referral.',
      'Document all allergies in EHR. Avoid cross-reactive substances.',
      'Lifestyle modifications (diet, exercise) for all identified risk factors.',
      'Schedule follow-up appointments in 1-3 months.',
      'Verify all medications are appropriate given identified risks and allergies.'
    ]
  };
}
