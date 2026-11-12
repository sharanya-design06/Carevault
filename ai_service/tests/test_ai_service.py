import unittest

from fastapi import HTTPException
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer

from ai_service import app as service
from ai_service.acquire_brfss import normalize_chunk
from ai_service.train_brfss import choose_threshold
from ai_service.train_models import TASKS, prepare_data
from ai_service.train_summarizer import extractive_summary


class AiServiceTests(unittest.TestCase):
    def test_normalizes_and_orders_interaction_pairs(self):
        self.assertEqual(service.pair_key("Café", "DRUG-A"), service.pair_key("drug a", "cafe"))

    def test_extracts_labs_without_grabbing_patient_birth_year(self):
        result = service.summarize_text(
            "LABORATORY REPORT: HbA1c and lipid panel\n"
            "Patient: Anna Rivera\nDate of birth: 1988-04-12\n"
            "HbA1c 7.4 % Ref 4.0 - 5.6 HIGH\n"
            "Fasting glucose 132 mg/dL Ref 70 - 99 HIGH",
            1,
        )
        values = {item["test"]: item["value"] for item in result["findings"]}
        self.assertEqual(values["HbA1c"], 7.4)
        self.assertEqual(values["Fasting glucose"], 132)
        self.assertEqual(result["model"], "local-structured-extraction-v1")

    def test_interactions_report_unknown_source_severity(self):
        original_index, original_error = service.interaction_index, service.interaction_error
        try:
            service.interaction_index = {
                service.pair_key("Levofloxacin", "Metformin"): [
                    "Metformin may increase the hypoglycemic activities of Levofloxacin."
                ]
            }
            service.interaction_error = None
            result = service.check_interactions(service.InteractionRequest(
                medication="Levofloxacin", current_medications=["Metformin"]
            ))
            self.assertEqual(result["alerts"][0]["severity"], "unknown")
            self.assertIn("does not provide a severity", result["alerts"][0]["message"])
        finally:
            service.interaction_index, service.interaction_error = original_index, original_error

    def test_allergy_class_match_is_reported_as_major(self):
        result = service.check_interactions(service.InteractionRequest(
            medication="amoxicillin",
            allergies=[{"name": "Penicillin", "reaction": "Rash"}],
        ))
        self.assertEqual(result["alerts"][0]["type"], "allergy")
        self.assertEqual(result["alerts"][0]["severity"], "major")

    def test_missing_hypertension_model_is_explicit(self):
        with self.assertRaises(HTTPException) as raised:
            service.predict("hypertension", service.PredictionRequest(features={"age": 60}))
        self.assertEqual(raised.exception.status_code, 501)

    def test_available_disease_datasets_map_to_binary_labels_and_full_features(self):
        diabetes_x, diabetes_y = prepare_data(TASKS["diabetes"])
        heart_x, heart_y = prepare_data(TASKS["cardiac"])
        liver_x, liver_y = prepare_data(TASKS["liver"])
        self.assertEqual(len(diabetes_x.columns), 8)
        self.assertEqual(len(heart_x.columns), 13)
        self.assertEqual(len(liver_x.columns), 10)
        self.assertEqual(set(liver_y.unique()), {0, 1})
        self.assertEqual(int(liver_y.sum()), 416)
        self.assertTrue(diabetes_x["Insulin"].isna().any())

    def test_extractive_summary_only_returns_source_sentences(self):
        text = "Patient has diabetes. Blood glucose is elevated. Follow up in clinic."
        vectorizer = TfidfVectorizer(stop_words="english").fit([text])
        summary = extractive_summary(text, vectorizer)
        for sentence in summary.split(". "):
            self.assertIn(sentence.strip(), text)

    def test_brfss_target_mapping_excludes_unknown_and_gestational_codes(self):
        frame = pd.DataFrame({
            "_AGEG5YR": [5, 6, 7, 8],
            "SEXVAR": [1, 2, 1, 2],
            "GENHLTH": [2, 3, 4, 5],
            "PHYSHLTH": [88, 4, 77, 99],
            "MENTHLTH": [2, 88, 77, 99],
            "EXERANY2": [1, 2, 1, 9],
            "SMOKE100": [2, 1, 2, 7],
            "_BMI5": [2450, 9999, 1800, 3000],
            "_INCOMG1": [5, 11, 99, 2],
            "_EDUCAG": [3, 2, 9, 1],
            "_RACEGR3": [1, 2, 9, 8],
            "CVDINFR4": [1, 2, 7, 9],
            "CVDSTRK3": [2, 1, 7, 9],
            "CHCKDNY2": [1, 2, 7, 9],
            "DIFFWALK": [2, 1, 7, 9],
            "ASTHMA3": [1, 2, 7, 9],
            "HAVARTH4": [2, 1, 7, 9],
            "CHECKUP1": [1, 8, 7, 9],
            "DIABETE4": [1, 3, 2, 4],
            "CVDCRHD4": [1, 2, 7, 9],
            "_LLCPWT": [1.0, 2.0, 3.0, 4.0],
            "_STATE": [1, 2, 3, 4],
        })
        result = normalize_chunk(frame)
        self.assertEqual(result["diabetes"].iloc[:2].tolist(), [1, 0])
        self.assertEqual(result["heart_disease"].iloc[:2].tolist(), [1, 0])
        self.assertTrue(result["diabetes"].iloc[2:].isna().all())
        self.assertEqual(result["_BMI5"].iloc[0], 24.5)
        self.assertEqual(result["CVDINFR4"].iloc[:2].tolist(), [1, 2])
        self.assertTrue(result["CVDINFR4"].iloc[2:].isna().all())
        self.assertEqual(result["CHECKUP1"].iloc[:2].tolist(), [1, 8])
        self.assertTrue(result["CHECKUP1"].iloc[2:].isna().all())
        self.assertEqual(result["PHYSHLTH"].iloc[0], 0)
        self.assertTrue(result["PHYSHLTH"].iloc[2:].isna().all())

    def test_brfss_threshold_selection_respects_minimum_recall(self):
        threshold = choose_threshold(
            labels=[1] * 12 + [0] * 8,
            scores=[
                0.9, 0.4, 0.2, 0.8, 0.6, 0.7, 0.1, 0.3, 0.7, 0.8,
                0.4, 0.8, 0.8, 0.4, 0.9, 0.3, 0.3, 0.7, 0.6, 0.2,
            ],
            weights=[1] * 20,
        )
        self.assertAlmostEqual(threshold, 0.4)


if __name__ == "__main__":
    unittest.main()
