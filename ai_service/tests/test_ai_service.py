import asyncio
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import HTTPException
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer

from ai_service import app as service
from ai_service.acquire_brfss import normalize_chunk
from ai_service.train_brfss import choose_threshold
from ai_service.train_models import TASKS, prepare_data
from ai_service.train_precision_models import evaluate, select_threshold
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
        self.assertEqual(result["model"], "local-rule-extractive-v1")
        self.assertTrue(result["summaryText"])
        self.assertIn("HbA1c 7.4", result["summaryText"])

    def test_extracts_liver_model_values_without_inventing_reference_flags(self):
        result = service.summarize_text(
            "Liver panel\nTotal bilirubin 1.2 mg/dL\n"
            "Direct bilirubin 0.3 mg/dL\nALT 28 U/L\nAlbumin 4.2 g/dL",
            1,
        )
        findings = {item["test"]: item for item in result["findings"]}
        self.assertEqual(findings["Total bilirubin"]["value"], 1.2)
        self.assertEqual(findings["Alanine aminotransferase"]["value"], 28)
        self.assertEqual(findings["Albumin"]["flag"], "unknown")
        self.assertEqual(findings["Albumin"]["range"], "Not configured")
        self.assertIn("0 are outside configured reference ranges", result["headline"])

    def test_prefers_local_biobert_t5_summary_when_available(self):
        original_summarizer, original_vectorizer = (
            service.transformer_summarizer, service.summarizer_vectorizer,
        )
        try:
            class StubSummarizer:
                def summarize(self, text):
                    return "Generated local summary."

            service.transformer_summarizer = StubSummarizer()
            service.summarizer_vectorizer = None
            result = service.summarize_text("A clinical report sentence.", 1)
            self.assertEqual(result["summaryText"], "Generated local summary.")
            self.assertEqual(result["model"], "local-biobert-t5-finetuned-v1")
            self.assertTrue(any("research-only" in item for item in result["limitations"]))
        finally:
            service.transformer_summarizer = original_summarizer
            service.summarizer_vectorizer = original_vectorizer

    def test_identifies_dynamic_pretrained_summarizer(self):
        original_summarizer, original_mode, original_vectorizer = (
            service.transformer_summarizer,
            service.transformer_summarizer_mode,
            service.summarizer_vectorizer,
        )
        try:
            class StubSummarizer:
                def summarize(self, text):
                    return "Generated pretrained summary."

            service.transformer_summarizer = StubSummarizer()
            service.transformer_summarizer_mode = "local-biobert-flan-t5-pretrained-v1"
            service.summarizer_vectorizer = None
            result = service.summarize_text("A clinical report sentence.", 1)
            self.assertEqual(result["summaryText"], "Generated pretrained summary.")
            self.assertEqual(result["model"], "local-biobert-flan-t5-pretrained-v1")
            self.assertEqual(service.health()["summaryMode"], "local-biobert-flan-t5-pretrained")
        finally:
            service.transformer_summarizer = original_summarizer
            service.transformer_summarizer_mode = original_mode
            service.summarizer_vectorizer = original_vectorizer

    def test_loads_pretrained_summarizer_when_finetuned_weights_are_missing(self):
        original_summarizer, original_mode, original_error = (
            service.transformer_summarizer,
            service.transformer_summarizer_mode,
            service.summary_load_error,
        )
        try:
            fake_module = types.ModuleType("ai_service.transformer_summarizer")
            fake_module.load_pretrained_biobert_t5_summarizer = Mock(return_value=object())

            async def startup():
                async with service.lifespan(None):
                    pass

            with tempfile.TemporaryDirectory() as model_dir:
                with (
                    patch.object(service, "MODEL_DIR", Path(model_dir)),
                    patch.object(service, "load_interactions"),
                    patch.dict(sys.modules, {"ai_service.transformer_summarizer": fake_module}),
                ):
                    asyncio.run(startup())

            fake_module.load_pretrained_biobert_t5_summarizer.assert_called_once_with()
            self.assertEqual(service.health()["summaryMode"], "local-biobert-flan-t5-pretrained")
            self.assertIsNone(service.health()["summaryLoadError"])
        finally:
            service.transformer_summarizer = original_summarizer
            service.transformer_summarizer_mode = original_mode
            service.summary_load_error = original_error

    def test_keeps_service_available_when_pretrained_summarizer_is_unavailable(self):
        original_summarizer, original_mode, original_error, original_vectorizer = (
            service.transformer_summarizer,
            service.transformer_summarizer_mode,
            service.summary_load_error,
            service.summarizer_vectorizer,
        )
        try:
            fake_module = types.ModuleType("ai_service.transformer_summarizer")
            fake_module.load_pretrained_biobert_t5_summarizer = Mock(
                side_effect=ImportError("optional dependencies are missing"),
            )

            async def startup():
                async with service.lifespan(None):
                    pass

            with tempfile.TemporaryDirectory() as model_dir:
                with (
                    patch.object(service, "MODEL_DIR", Path(model_dir)),
                    patch.object(service, "load_interactions"),
                    patch.dict(sys.modules, {"ai_service.transformer_summarizer": fake_module}),
                ):
                    asyncio.run(startup())

            status = service.health()
            self.assertEqual(status["summaryMode"], "local-rule-extractive")
            self.assertFalse(status["summaryModel"])
            self.assertIn("Pretrained BioBERT/Flan-T5 unavailable", status["summaryLoadError"])
        finally:
            service.transformer_summarizer = original_summarizer
            service.transformer_summarizer_mode = original_mode
            service.summary_load_error = original_error
            service.summarizer_vectorizer = original_vectorizer

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

    def test_condition_caution_uses_confirmed_patient_diagnoses(self):
        original_index, original_error = service.interaction_index, service.interaction_error
        try:
            service.interaction_index = {}
            service.interaction_error = None
            result = service.check_interactions(service.InteractionRequest(
                medication="ibuprofen",
                conditions=["N18.3 Chronic kidney disease stage 3"],
            ))
            self.assertEqual(result["alerts"][0]["type"], "condition")
            self.assertEqual(result["alerts"][0]["severity"], "unknown")
            self.assertIn("limited review prompt", result["alerts"][0]["message"])
        finally:
            service.interaction_index, service.interaction_error = original_index, original_error

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

    def test_brfss_threshold_selection_targets_precision(self):
        threshold, target_met = choose_threshold(
            labels=[1, 1, 0, 0, 0, 0],
            scores=[0.95, 0.8, 0.7, 0.2, 0.1, 0.05],
            weights=[1] * 6,
        )
        self.assertTrue(target_met)
        self.assertAlmostEqual(threshold, 0.8)

    def test_brfss_threshold_makes_no_predictions_when_precision_target_is_unreachable(self):
        threshold, target_met = choose_threshold(
            labels=[0, 0, 1, 1],
            scores=[0.99, 0.95, 0.8, 0.7],
            weights=[1] * 4,
        )
        self.assertFalse(target_met)
        self.assertGreater(threshold, 0.99)

    def test_precision_threshold_requires_strict_target_and_sufficient_predictions(self):
        labels = [1] * 9 + [0] + [1]
        scores = [1 - index * 0.01 for index in range(11)]
        self.assertAlmostEqual(select_threshold(labels, scores), 0.9)
        self.assertIsNone(select_threshold(labels[:10], scores[:10]))

    def test_precision_threshold_also_requires_accuracy_over_target(self):
        labels = [1] * 10 + [0] * 10 + [1] * 10
        scores = [0.9] * 10 + [0.2] * 20
        self.assertIsNone(select_threshold(labels, scores))

    def test_precision_is_undefined_when_no_test_predictions_are_positive(self):
        result = evaluate([0, 1], [0.2, 0.3], 0.9)
        self.assertIsNone(result["precision"])
        self.assertEqual(result["predictedPositiveRows"], 0)


if __name__ == "__main__":
    unittest.main()
