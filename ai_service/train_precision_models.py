import json

import joblib
import numpy as np
from sklearn.metrics import precision_recall_curve
from sklearn.model_selection import StratifiedKFold, cross_val_predict, train_test_split

from ai_service.train_models import (
    MODEL_DIR,
    CV_FOLDS,
    RANDOM_STATE,
    TASKS,
    TEST_SIZE,
    build_estimators,
    metrics_for,
    prepare_data,
)

TARGET_PRECISION = 0.90
TARGET_ACCURACY = 0.90
MINIMUM_VALIDATION_POSITIVES = 10


def select_threshold(labels, scores):
    labels = np.asarray(labels)
    scores = np.asarray(scores)
    precision, recall, thresholds = precision_recall_curve(labels, scores)
    positive_counts = np.array([np.count_nonzero(scores >= threshold) for threshold in thresholds])
    accuracy = np.array([np.mean((scores >= threshold) == labels) for threshold in thresholds])
    eligible = np.flatnonzero(
        (precision[:-1] > TARGET_PRECISION)
        & (accuracy > TARGET_ACCURACY)
        & (positive_counts >= MINIMUM_VALIDATION_POSITIVES)
    )
    if not len(eligible):
        return None
    best = max(eligible, key=lambda index: (recall[index], precision[index], thresholds[index]))
    return float(thresholds[best])


def evaluate(labels, scores, threshold):
    scores = np.asarray(scores)
    metrics = metrics_for(labels, scores, threshold)
    metrics["predictedPositiveRows"] = int(np.count_nonzero(scores >= threshold))
    if not metrics["predictedPositiveRows"]:
        metrics["precision"] = None
    return metrics


def train_task(condition, config):
    features, labels = prepare_data(config)
    train_features, test_features, train_labels, test_labels = train_test_split(
        features, labels, test_size=TEST_SIZE, random_state=RANDOM_STATE,
        stratify=labels,
    )
    folds = StratifiedKFold(n_splits=CV_FOLDS, shuffle=True, random_state=RANDOM_STATE)
    candidates = {}
    for name, model in build_estimators(train_labels.to_numpy()).items():
        scores = cross_val_predict(
            model, train_features, train_labels, cv=folds, method="predict_proba", n_jobs=1,
        )[:, 1]
        labels_array = train_labels.to_numpy()
        threshold = select_threshold(labels_array, scores)
        diagnostic_threshold = max(
            (value for value in np.unique(scores)
             if np.count_nonzero(scores >= value) >= MINIMUM_VALIDATION_POSITIVES),
            key=lambda value: np.mean((scores >= value) == labels_array),
        )
        candidates[name] = {
            "validationTargetMet": threshold is not None,
            "threshold": threshold,
            "validation": evaluate(train_labels, scores, threshold) if threshold is not None else None,
            "bestValidationAccuracyDiagnostic": evaluate(train_labels, scores, diagnostic_threshold),
        }

    eligible = [name for name in candidates if candidates[name]["validationTargetMet"]]
    result = {
        "condition": condition,
        "dataset": config["dataset"],
        "populationLimitation": config["populationLimitation"],
        "trainingRows": len(train_labels),
        "validationMethod": f"{CV_FOLDS}-fold out-of-fold predictions on training rows",
        "testRows": len(test_labels),
        "targetPrecision": TARGET_PRECISION,
        "targetAccuracy": TARGET_ACCURACY,
        "targetRule": "precision and accuracy strictly above 0.90 with at least 10 positive validation predictions",
        "selectionRule": "highest validation recall among eligible models, then precision",
        "candidateValidation": candidates,
        "selectedModel": None,
        "test": None,
        "testTargetMet": False,
        "clinicalValidation": False,
        "limitations": [
            "The test split was previously used in model development and is not an independent external validation.",
            "Validation estimates are optimistic because thresholds and models are selected on those same predictions.",
            "Small samples and threshold selection can produce unstable precision; no clinical use.",
        ],
    }
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    artifact_path = MODEL_DIR / f"precision_research_{condition}.joblib"
    if eligible:
        selected = max(
            eligible,
            key=lambda name: (
                candidates[name]["validation"]["recall"],
                candidates[name]["validation"]["precision"],
            ),
        )
        model = build_estimators(train_labels.to_numpy())[selected]
        model.fit(train_features, train_labels)
        threshold = candidates[selected]["threshold"]
        scores = model.predict_proba(test_features)[:, 1]
        test_metrics = evaluate(test_labels, scores, threshold)
        test_precision = (
            float(np.mean(test_labels.to_numpy()[scores >= threshold]))
            if test_metrics["predictedPositiveRows"] else None
        )
        result.update({
            "selectedModel": selected,
            "threshold": threshold,
            "test": test_metrics,
            "testTargetMet": (
                test_precision is not None and test_precision > TARGET_PRECISION
                and np.mean((scores >= threshold) == test_labels.to_numpy()) > TARGET_ACCURACY
            ),
        })
        joblib.dump({"model": model, "features": config["features"], **result}, artifact_path)
    else:
        joblib.dump({"model": None, "features": config["features"], **result}, artifact_path)
    return result


def main():
    results = {condition: train_task(condition, config) for condition, config in TASKS.items()}
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    report_path = MODEL_DIR / "precision-research-report.json"
    report_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))
    print(f"\nResearch-only models and report written to {MODEL_DIR}")


if __name__ == "__main__":
    main()
