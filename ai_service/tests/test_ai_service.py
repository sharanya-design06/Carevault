import unittest

from fastapi import HTTPException
from sklearn.feature_extraction.text import TfidfVectorizer

from ai_service import app as service
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


if __name__ == "__main__":
    unittest.main()
