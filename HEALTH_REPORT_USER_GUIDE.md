# Health Report Feature - User Guide

## 🏥 For Patients: Accessing the Health Report

### Step 1: Login to Patient Dashboard
- Navigate to patient login page
- Enter your credentials (use demo account: anna rivera or test patient)

### Step 2: Navigate to Health Report
Once logged in:
- Look at the left navigation menu
- Click on **"Health Report"** (new menu item)

### Step 3: View Your Report
The report displays:

#### 🔴 Disease Risk Assessment
- **Diabetes** (High Risk) - 90.85%
- **Hypertension** (Moderate Risk) - 55%
- **Cardiac** (Low Risk) - 33.67%
- **Liver** (Low Risk) - 21.6%

Each risk card shows:
- Risk score with color coding (Red=High, Orange=Moderate, Green=Low)
- Specific risk factors contributing to the score
- Confidence level of assessment

#### ⚠️ Critical Allergy Alerts
Prominently displayed with severity:
1. **Penicillin** - Severe rash and angioedema
2. **Sulfonamides** - Steven-Johnson Syndrome history
3. **NSAIDs** - GI bleeding history  
4. **Shellfish** - Throat swelling and breathing difficulty
5. **Metformin** (Warning) - Gastrointestinal upset

Each allergy shows:
- Allergen name
- Reaction details
- Severity level
- **Recommended Action** - Important precautions

#### 📋 Clinical Summary
AI-generated report summary including:
- Overview of disease risk conditions
- Number of high and moderate risk conditions
- Allergy documentation status
- Key findings

#### 💡 Health Recommendations
Personalized recommendations:
- Schedule HbA1c test and glucose monitoring
- Document all allergies in EHR
- Lifestyle modifications needed
- Follow-up appointment timing
- Medication verification

---

## 👨‍⚕️ For Doctors: Accessing Comprehensive Health Report

### Step 1: Login to Doctor Dashboard
- Navigate to doctor login page
- Enter your credentials

### Step 2: Search for Patient
Two methods:

**Method A: Direct HRID Search**
- In the HRID search box on dashboard
- Enter patient HRID (e.g., HDW-20240101-XXXXXXXX)
- Click "Open record"

**Method B: Patient Search**
- Click "Patient Search" in navigation
- Use secondary lookup with:
  - Full name
  - Phone number
  - Date of birth
- Click "Search"

### Step 3: Navigate to Disease Risk Tab
Once patient record is open:
- You'll see tabs: Overview | Medical History | Health Timeline | Reports | **Disease Risk** | ...
- Click the **"Disease Risk"** tab

### Step 4: Load Full Report
In the Disease Risk tab:
- You'll see "Disease Risk Dashboard" with screening scores
- Scroll to "Comprehensive Health Report" section
- Click **"Load Full Report"** button

### Step 5: Review Complete Assessment
The comprehensive report shows:

#### Patient Information
- Name and HRID
- Age, gender, DOB
- Generation timestamp
- Research disclaimer

#### Disease Risk Assessment
Risk cards displayed in a grid showing:
- **Diabetes** (High Risk 90.85%)
  - Contributing risk factors listed
- **Hypertension** (Moderate Risk 55%)
  - Elevated BP and obesity flagged
- **Cardiac** (Low Risk 33.67%)
- **Liver** (Low Risk 21.6%)

Each card is color-coded:
- 🔴 Red = High Risk (action recommended)
- 🟠 Orange = Moderate Risk (monitor closely)
- 🟢 Green = Low Risk

#### Critical Allergy Alerts
Highlighted in danger box:
- Each allergy with reaction details
- Severity level
- **Recommended Action** box with precautions

#### Warnings Section
Moderate severity allergies requiring attention but not life-threatening

#### Clinical Summary
Pre-formatted clinical summary:
```
CLINICAL SUMMARY
Report for patient, 58-year-old Female

DISEASE RISK ASSESSMENT:
[H] DIABETES - High Risk (90.85%)
[M] HYPERTENSION - Moderate Risk (55%)
[L] CARDIAC - Low Risk (33.67%)
[L] LIVER - Low Risk (21.6%)

HIGH RISK CONDITIONS: 1
MODERATE RISK CONDITIONS: 1

ALLERGY ALERTS: 5 documented allergies

KEY FINDINGS:
• Comprehensive disease risk assessment completed
• Critical allergy information documented
• Patient data analyzed across multiple disease models
```

#### Clinical Recommendations
1. Schedule HbA1c test and glucose monitoring - Consider endocrinology referral
2. Document all allergies in EHR - Avoid cross-reactive substances
3. Lifestyle modifications (diet, exercise) for all identified risk factors
4. Schedule follow-up appointments in 1-3 months
5. Verify all medications are appropriate given identified risks and allergies

#### Research Disclaimer
*Important:* All reports include clear disclaimers that:
- Reports are for research/demo purposes
- Not validated for clinical use
- Must be confirmed with clinician
- Not a substitute for professional medical advice

---

## 📊 Data Included in Reports

### Vital Signs
- Blood Pressure: 148/92 mmHg (Stage 2 Hypertension)
- Heart Rate: 82 bpm
- Oxygen Saturation: 97%
- Temperature: 98.6°F
- Respiratory Rate: 18/min

### Lab Results
- **Glucose:** 185 mg/dL (elevated)
- **HbA1c:** 8.2% (poor control)
- **Cholesterol:** 245 mg/dL (high)
- **LDL:** 165 mg/dL (high)
- **HDL:** 35 mg/dL (low)
- **Triglycerides:** 220 mg/dL (high)
- **Creatinine:** 1.4 (mildly elevated)
- **eGFR:** 45 (mild kidney function decline)
- **Hemoglobin:** 13.2 g/dL

### Current Medications
- Metformin 500mg BID
- Lisinopril 10mg OD
- Atorvastatin 20mg OD
- Aspirin 81mg OD

---

## ⚙️ Technical Details

### API Endpoints

**Get Full Patient Report:**
```
GET /getPatientReport?patientId={patientId}&format=json
```

**Get Risk Assessment Only:**
```
GET /getPatientRisk?patientId={patientId}
```

**Get Allergies Only:**
```
GET /getPatientAllergies?patientId={patientId}
```

### Response Format
```json
{
  "reportMetadata": {...},
  "patientInformation": {...},
  "vitalSigns": {...},
  "labResults": {...},
  "currentMedications": [...],
  "diseaseRiskAssessment": {...},
  "allergyAlerts": {...},
  "summaryReport": "...",
  "recommendations": [...]
}
```

---

## 🔐 Privacy & Security

- Reports are retrieved on-demand when requested
- Patient authentication required for access
- Doctor access logged for audit purposes
- Demo data clearly marked as research/demo
- Not for clinical decision-making without verification
- All allergies prominently displayed with severity
- Cross-reactive substance warnings included

---

## 💡 Tips

### For Patients:
1. Review your disease risk scores regularly
2. Take note of critical allergy alerts
3. Share recommendations with your healthcare provider
4. Use this for informed health discussions with doctors
5. Track your health metrics over time

### For Doctors:
1. Use disease risk as screening tool, not diagnosis
2. Cross-reference allergy alerts with patient history
3. Consider risk factors when prescribing medications
4. Use clinical summary for decision support
5. Always verify data against source records
6. Customize follow-up based on risk levels

---

## ❓ FAQ

**Q: Is this a diagnosis?**
A: No. This is a risk assessment tool for research/informational purposes. Always consult with a healthcare provider for medical advice.

**Q: How often is the report updated?**
A: Reports are generated on-demand when requested based on the latest available patient data.

**Q: Can I export the report?**
A: Currently, reports can be viewed online. PDF export feature coming soon.

**Q: What should I do if I have new allergies?**
A: Contact your healthcare provider immediately to have them documented in your medical record.

**Q: Are the disease risk scores my actual diagnosis?**
A: No. These are screening scores from research models. Only a doctor can diagnose a disease.

---

## 📞 Support

For questions about:
- **Patient features** → Click "Settings" in patient dashboard
- **Doctor features** → Contact your hospital administrator
- **Technical issues** → Check the application logs or contact support team
