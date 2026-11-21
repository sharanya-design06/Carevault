#!/usr/bin/env python3
"""
CareVault Patient Health Report Generator
Generates comprehensive health reports with disease risk assessment and allergy alerts
"""

import json
import joblib
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List


class PatientReportGenerator:
    def __init__(self):
        self.model_dir = Path(__file__).parent / "ai_service" / "models"
        self.models = {}
        self.load_models()
    
    def load_models(self):
        """Load all available disease prediction models"""
        for condition in ["diabetes", "cardiac", "liver"]:
            model_path = self.model_dir / f"{condition}.joblib"
            if model_path.exists():
                try:
                    self.models[condition] = joblib.load(model_path)
                    print(f"[+] Loaded {condition} model")
                except Exception as e:
                    print(f"[-] Failed to load {condition} model: {e}")
    
    def predict_disease_risk(self, condition: str, features: Dict[str, float]) -> Dict[str, Any]:
        """Predict disease risk based on patient features"""
        if condition not in self.models:
            return {
                "condition": condition,
                "error": f"No model available for {condition}"
            }
        
        artifact = self.models[condition]
        model = artifact["model"]
        feature_names = artifact["features"]
        
        # Prepare features in correct order
        try:
            values = [features.get(name, 0) for name in feature_names]
            score = float(model.predict_proba([values])[0][1])
            
            risk_level = "High" if score >= artifact["threshold"] else "Moderate" if score >= 0.4 else "Low"
            
            return {
                "condition": condition,
                "riskScore": round(score * 100, 2),
                "riskLevel": risk_level,
                "threshold": round(artifact["threshold"] * 100, 2),
                "prediction": "positive" if score >= artifact["threshold"] else "negative",
                "model": artifact.get("selectedModel", "Unknown"),
                "metrics": artifact.get("metrics", {}),
                "populationLimitation": artifact.get("populationLimitation", "Unknown population"),
                "clinicalUse": False
            }
        except Exception as e:
            return {
                "condition": condition,
                "error": str(e),
                "riskScore": 0,
                "riskLevel": "Unknown"
            }
    
    def generate_allergy_alerts(self, allergies: List[Dict[str, str]]) -> List[Dict[str, str]]:
        """Generate allergy alerts for the patient"""
        alerts = []
        for allergy in allergies:
            allergen = allergy.get("name", "Unknown")
            reaction = allergy.get("reaction", "Not specified")
            severity = allergy.get("severity", "Unknown")
            
            alerts.append({
                "allergen": allergen,
                "reaction": reaction,
                "severity": severity,
                "alertType": "Critical" if severity.lower() in ["severe", "anaphylaxis"] else "Warning",
                "recommendedAction": f"Avoid all forms of {allergen} and cross-reactive substances"
            })
        
        return alerts
    
    def generate_report(self, patient_data: Dict[str, Any]) -> Dict[str, Any]:
        """Generate complete patient health report"""
        
        patient_name = patient_data.get("name", "Unknown")
        patient_id = patient_data.get("id", "")
        
        print(f"\n{'='*80}")
        print(f"Generating Health Report for: {patient_name}")
        print(f"{'='*80}\n")
        
        # Extract patient features
        features = patient_data.get("features", {})
        allergies = patient_data.get("allergies", [])
        medications = patient_data.get("medications", [])
        vital_signs = patient_data.get("vitalSigns", {})
        lab_results = patient_data.get("labResults", {})
        
        # Assess disease risks
        disease_risks = {}
        risk_conditions = ["diabetes", "cardiac", "liver"]
        
        for condition in risk_conditions:
            risk = self.predict_disease_risk(condition, features)
            disease_risks[condition] = risk
        
        # Generate allergy alerts
        allergy_alerts = self.generate_allergy_alerts(allergies)
        
        # Create hypertension risk assessment (since model not available, use rule-based)
        hypertension_risk = self.assess_hypertension_risk(vital_signs, lab_results)
        disease_risks["hypertension"] = hypertension_risk
        
        # Compile comprehensive report
        report = {
            "reportMetadata": {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "patientName": patient_name,
                "patientID": patient_id,
                "reportType": "Comprehensive Health Risk Assessment",
                "clinicalValidation": False,
                "disclaimer": "This report is for research/demo purposes only. Not validated for clinical use."
            },
            "patientInformation": {
                "name": patient_name,
                "age": patient_data.get("age"),
                "gender": patient_data.get("gender"),
                "bloodType": patient_data.get("bloodType"),
                "dateOfBirth": patient_data.get("dateOfBirth")
            },
            "vitalSigns": vital_signs,
            "labResults": lab_results,
            "currentMedications": medications,
            "diseaseRiskAssessment": disease_risks,
            "allergyAlerts": {
                "totalAlergies": len(allergy_alerts),
                "alerts": allergy_alerts,
                "criticalAlerts": [a for a in allergy_alerts if a["alertType"] == "Critical"],
                "warnings": [a for a in allergy_alerts if a["alertType"] == "Warning"]
            },
            "summaryReport": self.generate_summary(patient_name, disease_risks, allergy_alerts),
            "recommendations": self.generate_recommendations(disease_risks, allergies)
        }
        
        return report
    
    def assess_hypertension_risk(self, vital_signs: Dict, lab_results: Dict) -> Dict[str, Any]:
        """Assess hypertension risk using rule-based approach"""
        systolic = vital_signs.get("systolicBP", 0)
        diastolic = vital_signs.get("diastolicBP", 0)
        age = vital_signs.get("age", 0)
        bmi = lab_results.get("BMI", 0)
        
        # Rule-based hypertension risk assessment
        risk_score = 0
        risk_factors = []
        
        if systolic >= 140 or diastolic >= 90:
            risk_score += 40
            risk_factors.append("Current elevated blood pressure (Stage 2 Hypertension)")
        elif systolic >= 130 or diastolic >= 80:
            risk_score += 25
            risk_factors.append("Elevated blood pressure (Stage 1 Hypertension)")
        
        if age > 60:
            risk_score += 15
            risk_factors.append("Age over 60")
        
        if bmi > 30:
            risk_score += 15
            risk_factors.append("Obesity (BMI > 30)")
        elif bmi > 25:
            risk_score += 10
            risk_factors.append("Overweight (BMI > 25)")
        
        # Cap score at 100
        risk_score = min(risk_score, 100)
        
        risk_level = "High" if risk_score >= 60 else "Moderate" if risk_score >= 40 else "Low"
        
        return {
            "condition": "hypertension",
            "riskScore": risk_score,
            "riskLevel": risk_level,
            "riskFactors": risk_factors,
            "model": "Rule-based assessment (ML model not available)",
            "populationLimitation": "General population"
        }
    
    def generate_summary(self, patient_name: str, disease_risks: Dict, allergies: List) -> str:
        """Generate AI-powered summary of the report"""
        
        # Count high-risk conditions
        high_risk_count = sum(1 for risk in disease_risks.values() 
                             if risk.get("riskLevel") == "High")
        moderate_risk_count = sum(1 for risk in disease_risks.values() 
                                 if risk.get("riskLevel") == "Moderate")
        
        summary_parts = [
            f"CLINICAL SUMMARY FOR {patient_name.upper()}",
            f"\nReport generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} UTC",
            f"\n{'='*60}",
            "\nDISEASE RISK ASSESSMENT:",
            "-" * 60
        ]
        
        # List risk levels for each disease
        for condition, risk in disease_risks.items():
            if "error" not in risk:
                risk_level = risk.get("riskLevel", "Unknown")
                risk_score = risk.get("riskScore", 0)
                
                emoji = "[H]" if risk_level == "High" else "[M]" if risk_level == "Moderate" else "[L]"
                summary_parts.append(
                    f"{emoji} {condition.upper():15} - {risk_level:10} Risk "
                    f"({risk_score}%)"
                )
        
        summary_parts.append(f"\n{'-'*60}")
        summary_parts.append(f"HIGH RISK CONDITIONS: {high_risk_count}")
        summary_parts.append(f"MODERATE RISK CONDITIONS: {moderate_risk_count}")
        
        if allergies:
            summary_parts.append(f"\nALLERGY ALERTS: WARNING - {len(allergies)} documented allergy(ies)")
            for allergy in allergies:
                allergen = allergy.get('allergen', allergy.get('name', 'Unknown'))
                reaction = allergy.get('reaction', 'Not specified')
                summary_parts.append(f"  - {allergen}: {reaction}")
        
        summary_parts.append(f"\n{'-'*60}")
        summary_parts.append("\nKEY FINDINGS:")
        summary_parts.append("• Comprehensive disease risk assessment completed")
        summary_parts.append("• Critical allergy information documented")
        summary_parts.append("• Patient data analyzed across multiple disease models")
        
        summary_parts.append("\n!!! DISCLAIMER: This is a research/demonstration report.")
        summary_parts.append("Not validated for clinical diagnosis or treatment decisions.")
        summary_parts.append("Consult qualified healthcare providers for medical advice.")
        
        return "\n".join(summary_parts)
    
    def generate_recommendations(self, disease_risks: Dict, allergies: List) -> List[str]:
        """Generate clinical recommendations based on risk assessment"""
        
        recommendations = []
        
        # Disease-specific recommendations
        if disease_risks.get("diabetes", {}).get("riskLevel") == "High":
            recommendations.append("[DIABETES] Schedule HbA1c test and glucose monitoring. Consider endocrinology referral.")
        
        if disease_risks.get("cardiac", {}).get("riskLevel") == "High":
            recommendations.append("[CARDIAC] Perform ECG and echocardiography. Cardiology consultation recommended.")
        
        if disease_risks.get("liver", {}).get("riskLevel") == "High":
            recommendations.append("[LIVER] Obtain liver function tests (LFTs) and hepatology assessment.")
        
        if disease_risks.get("hypertension", {}).get("riskLevel") == "High":
            recommendations.append("[HYPERTENSION] Monitor BP regularly. Consider antihypertensive therapy and lifestyle modifications.")
        
        # Allergy-specific recommendations
        if allergies:
            recommendations.append(f"[ALLERGIES] Document all {len(allergies)} allergies in EHR. Avoid cross-reactive substances.")
        
        # General recommendations
        recommendations.extend([
            "[GENERAL] Lifestyle modifications (diet, exercise) for all identified risk factors.",
            "[FOLLOW-UP] Schedule follow-up appointments in 1-3 months.",
            "[MEDICATION REVIEW] Verify all medications are appropriate given identified risks and allergies."
        ])
        
        return recommendations


# Example patient data for Anna Rivera
def create_anna_rivera_data() -> Dict[str, Any]:
    """Create patient data for Anna Rivera"""
    return {
        "name": "Anna Rivera",
        "id": "PAT-2024-00547",
        "age": 58,
        "gender": "Female",
        "bloodType": "O+",
        "dateOfBirth": "1966-03-15",
        "vitalSigns": {
            "age": 58,
            "systolicBP": 148,
            "diastolicBP": 92,
            "heartRate": 82,
            "temperature": 98.6,
            "respiratoryRate": 18,
            "oxygenSaturation": 97
        },
        "labResults": {
            "glucose": 185,
            "HbA1c": 8.2,
            "totalCholesterol": 245,
            "LDLCholesterol": 165,
            "HDLCholesterol": 35,
            "triglycerides": 220,
            "creatinine": 1.4,
            "eGFR": 45,
            "hemoglobin": 13.2,
            "BMI": 32.5
        },
        "medications": [
            "Metformin 500mg BID",
            "Lisinopril 10mg OD",
            "Atorvastatin 20mg OD",
            "Aspirin 81mg OD"
        ],
        "allergies": [
            {
                "name": "Penicillin",
                "reaction": "Severe rash and angioedema",
                "severity": "Severe",
                "dateRecorded": "2015-06-20"
            },
            {
                "name": "Sulfonamides",
                "reaction": "Steven-Johnson Syndrome (historical)",
                "severity": "Severe",
                "dateRecorded": "2008-04-10"
            },
            {
                "name": "Shellfish",
                "reaction": "Throat swelling and difficulty breathing",
                "severity": "Severe",
                "dateRecorded": "2019-08-15"
            },
            {
                "name": "NSAIDs",
                "reaction": "GI bleeding (prior episode)",
                "severity": "Severe",
                "dateRecorded": "2018-02-28"
            },
            {
                "name": "Metformin",
                "reaction": "Gastrointestinal upset",
                "severity": "Moderate",
                "dateRecorded": "2020-01-10"
            }
        ],
        "features": {
            "Pregnancies": 3,
            "Glucose": 185,
            "BloodPressure": 92,
            "SkinThickness": 28,
            "Insulin": 110,
            "BMI": 32.5,
            "DiabetesPedigreeFunction": 0.45,
            "Age": 58,
            "age": 58,
            "sex": 0,
            "cp": 2,
            "trestbps": 148,
            "chol": 245,
            "fbs": 1,
            "restecg": 1,
            "thalach": 82,
            "exang": 1,
            "oldpeak": 1.5,
            "slope": 1,
            "ca": 1,
            "thal": 2
        }
    }


def main():
    """Main function to generate and display the report"""
    
    # Initialize report generator
    generator = PatientReportGenerator()
    
    # Create patient data
    anna_rivera = create_anna_rivera_data()
    
    # Generate comprehensive report
    report = generator.generate_report(anna_rivera)
    
    # Display formatted report
    print("\n" + "="*80)
    print("CAREVAULT - COMPREHENSIVE PATIENT HEALTH REPORT")
    print("="*80)
    
    # Metadata
    print(f"\n[REPORT METADATA]")
    print("-" * 80)
    for key, value in report["reportMetadata"].items():
        print(f"  {key}: {value}")
    
    # Patient Information
    print(f"\n[PATIENT INFORMATION]")
    print("-" * 80)
    for key, value in report["patientInformation"].items():
        print(f"  {key}: {value}")
    
    # Vital Signs
    print(f"\n[VITAL SIGNS]")
    print("-" * 80)
    for key, value in report["vitalSigns"].items():
        print(f"  {key}: {value}")
    
    # Lab Results
    print(f"\n[LABORATORY RESULTS]")
    print("-" * 80)
    for key, value in report["labResults"].items():
        print(f"  {key}: {value}")
    
    # Current Medications
    print(f"\n[CURRENT MEDICATIONS]")
    print("-" * 80)
    for med in report["currentMedications"]:
        print(f"  * {med}")
    
    # Disease Risk Assessment
    print(f"\n[DISEASE RISK ASSESSMENT]")
    print("-" * 80)
    for condition, risk in report["diseaseRiskAssessment"].items():
        if "error" not in risk:
            print(f"\n  {condition.upper()}")
            print(f"  {'-' * 40}")
            print(f"    Risk Level: {risk.get('riskLevel', 'N/A')}")
            print(f"    Risk Score: {risk.get('riskScore', 'N/A')}%")
            print(f"    Prediction: {risk.get('prediction', 'N/A')}")
            print(f"    Model: {risk.get('model', 'N/A')}")
            if 'riskFactors' in risk:
                print(f"    Risk Factors:")
                for factor in risk['riskFactors']:
                    print(f"      * {factor}")
    
    # Allergy Alerts
    print(f"\n[ALLERGY ALERTS]")
    print("-" * 80)
    allergy_data = report["allergyAlerts"]
    print(f"  Total Allergies: {allergy_data['totalAlergies']}")
    print(f"  Critical Alerts: {len(allergy_data['criticalAlerts'])}")
    print(f"  Warnings: {len(allergy_data['warnings'])}")
    
    if allergy_data["criticalAlerts"]:
        print(f"\n  [CRITICAL ALLERGIES]")
        for alert in allergy_data["criticalAlerts"]:
            print(f"    * {alert['allergen']}: {alert['reaction']}")
            print(f"      Action: {alert['recommendedAction']}")
    
    if allergy_data["warnings"]:
        print(f"\n  [WARNING ALLERGIES]")
        for alert in allergy_data["warnings"]:
            print(f"    * {alert['allergen']}: {alert['reaction']}")
            print(f"      Action: {alert['recommendedAction']}")
    
    # AI-Generated Summary
    print(f"\n[AI-GENERATED REPORT SUMMARY]")
    print("-" * 80)
    print(report["summaryReport"])
    
    # Recommendations
    print(f"\n[CLINICAL RECOMMENDATIONS]")
    print("-" * 80)
    for i, rec in enumerate(report["recommendations"], 1):
        print(f"  {i}. {rec}")
    
    print("\n" + "="*80)
    print("END OF REPORT")
    print("="*80 + "\n")
    
    # Save report as JSON
    output_path = Path(__file__).parent / "anna_rivera_health_report.json"
    with open(output_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f"[+] Report saved to: {output_path}\n")
    
    return report


if __name__ == "__main__":
    main()
