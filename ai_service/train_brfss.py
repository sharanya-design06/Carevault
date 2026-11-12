import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    f1_score,
    precision_score,
    precision_recall_curve,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import GroupShuffleSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from xgboost import XGBClassifier

DATA_PATH = Path(__file__).resolve().parent / "data" / "processed" / "brfss_2024_self_report.csv"
MANIFEST_PATH = DATA_PATH.with_name("brfss_2024_manifest.json")
MODEL_DIR = Path(__file__).resolve().parent / "models"
RANDOM_STATE = 42
TEST_SIZE = 0.2
MINIMUM_RECALL = 0.5
TARGETS = {
    "diabetes": "diabetes",
    "heart_disease": "heart_disease",
}
CATEGORICAL_FEATURES = ["_AGEG5YR", "SEXVAR", "GENHLTH", "EXERANY2", "SMOKE100", "_INCOMG1", "_EDUCAG", "_RACEGR3"]
NUMERIC_FEATURES = ["PHYSHLTH", "MENTHLTH", "_BMI5"]
FEATURES = CATEGORICAL_FEATURES + NUMERIC_FEATURES


def build_preprocessor():
    categories = Pipeline([
        ("imputer", SimpleImputer(strategy="most_frequent")),
        ("encode", OneHotEncoder(handle_unknown="ignore")),
    ])
    continuous = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
    ])
    return ColumnTransformer([
        ("categories", categories, CATEGORICAL_FEATURES),
        ("continuous", continuous, NUMERIC_FEATURES),
    ])


def build_estimators():
    return {
        "logistic_regression": Pipeline([
            ("preprocess", build_preprocessor()),
            ("model", LogisticRegression(max_iter=1000, n_jobs=1)),
        ]),
        "random_forest": Pipeline([
            ("preprocess", build_preprocessor()),
            ("model", RandomForestClassifier(
                n_estimators=200, max_depth=14, min_samples_leaf=8,
                n_jobs=-1, random_state=RANDOM_STATE,
            )),
        ]),
        "xgboost": Pipeline([
            ("preprocess", build_preprocessor()),
            ("model", XGBClassifier(
                n_estimators=250, max_depth=4, learning_rate=0.05,
                subsample=0.85, colsample_bytree=0.85,
                eval_metric="logloss", tree_method="hist",
                n_jobs=4, random_state=RANDOM_STATE,
            )),
        ]),
    }


def metrics_for(labels, scores, threshold, weights):
    labels = np.asarray(labels)
    scores = np.asarray(scores)
    weights = np.asarray(weights)
    predicted = scores >= threshold
    return {
        "accuracy": round(float(accuracy_score(labels, predicted, sample_weight=weights)), 4),
        "precision": round(float(precision_score(labels, predicted, sample_weight=weights, zero_division=0)), 4),
        "recall": round(float(recall_score(labels, predicted, sample_weight=weights, zero_division=0)), 4),
        "f1": round(float(f1_score(labels, predicted, sample_weight=weights, zero_division=0)), 4),
        "aucRoc": round(float(roc_auc_score(labels, scores, sample_weight=weights)), 4),
        "averagePrecision": round(float(average_precision_score(labels, scores, sample_weight=weights)), 4),
    }


def choose_threshold(labels, scores, weights):
    precision, recall, thresholds = precision_recall_curve(
        labels, scores, sample_weight=weights,
    )
    eligible = []
    for index, threshold in enumerate(thresholds):
        if recall[index] >= MINIMUM_RECALL:
            f1 = 2 * precision[index] * recall[index] / (precision[index] + recall[index] or 1)
            eligible.append((precision[index], f1, float(threshold)))

    baseline = metrics_for(labels, scores, 0.5, weights)
    if baseline["recall"] >= MINIMUM_RECALL:
        eligible.append((baseline["precision"], baseline["f1"], 0.5))
    return max(eligible)[-1] if eligible else 0.5


def fit_with_weights(estimator, features, labels, weights):
    estimator.fit(features, labels, model__sample_weight=weights)
    return estimator


def train_task(task, target, frame, source):
    subset = frame.dropna(subset=[target, "_LLCPWT", "_STATE"]).copy()
    labels = subset[target].astype(int)
    weights = subset["_LLCPWT"].astype(float)
    groups = subset["_STATE"].astype(int)
    if labels.nunique() != 2 or weights.le(0).any():
        raise ValueError(f"{task}: expected both classes and positive survey weights.")
    outer = GroupShuffleSplit(n_splits=1, test_size=TEST_SIZE, random_state=RANDOM_STATE)
    train_idx, test_idx = next(outer.split(subset[FEATURES], labels, groups))
    train = subset.iloc[train_idx]
    test = subset.iloc[test_idx]

    inner = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=RANDOM_STATE + 1)
    fit_idx, validation_idx = next(inner.split(
        train[FEATURES], train[target], train["_STATE"],
    ))
    fit = train.iloc[fit_idx]
    validation = train.iloc[validation_idx]

    benchmark = {}
    for name, estimator in build_estimators().items():
        calibration_model = fit_with_weights(
            estimator, fit[FEATURES], fit[target].astype(int), fit["_LLCPWT"].astype(float),
        )
        validation_scores = calibration_model.predict_proba(validation[FEATURES])[:, 1]
        threshold = choose_threshold(
            validation[target].astype(int).to_numpy(),
            validation_scores,
            validation["_LLCPWT"].astype(float).to_numpy(),
        )
        validation_metrics = metrics_for(
            validation[target].astype(int).to_numpy(), validation_scores, threshold,
            validation["_LLCPWT"].astype(float).to_numpy(),
        )
        benchmark[name] = {"threshold": round(float(threshold), 4), "validation": validation_metrics}

    selected_name = max(
        benchmark,
        key=lambda name: (
            benchmark[name]["validation"]["precision"],
            benchmark[name]["validation"]["recall"],
            benchmark[name]["validation"]["aucRoc"],
        ),
    )
    threshold = benchmark[selected_name]["threshold"]
    final_model = fit_with_weights(
        build_estimators()[selected_name],
        train[FEATURES],
        train[target].astype(int),
        train["_LLCPWT"].astype(float),
    )
    test_scores = final_model.predict_proba(test[FEATURES])[:, 1]
    result = {
        "task": task,
        "targetDefinition": source["targets"][task],
        "dataset": source["dataset"],
        "source": source["source"],
        "rows": int(len(subset)),
        "positiveRows": int(labels.sum()),
        "trainingStates": sorted(train["_STATE"].astype(int).unique().tolist()),
        "testStates": sorted(test["_STATE"].astype(int).unique().tolist()),
        "split": "20% held-out states; model/threshold selection uses training states only",
        "selectedModel": selected_name,
        "threshold": threshold,
        "minimumValidationRecall": MINIMUM_RECALL,
        "validationMetrics": benchmark[selected_name]["validation"],
        "holdoutMetrics": metrics_for(
            test[target].astype(int).to_numpy(), test_scores, threshold,
            test["_LLCPWT"].astype(float).to_numpy(),
        ),
        "benchmark": benchmark,
        "features": FEATURES,
        "limitations": [
            "The target is a respondent's self-reported prior diagnosis, not incident disease or a clinical diagnosis.",
            "Survey weights are used, but this training script does not fully model BRFSS strata and primary sampling units.",
            "One year and a geographic holdout do not establish clinical transportability.",
            "This model is an exploratory benchmark and is not exposed as a CareVault patient prediction endpoint.",
        ],
    }
    joblib.dump({"model": final_model, **result}, MODEL_DIR / f"brfss_2024_{task}.joblib")
    return result


def main():
    if not DATA_PATH.is_file() or not MANIFEST_PATH.is_file():
        raise FileNotFoundError("Run `python -m ai_service.acquire_brfss` before this benchmark.")
    frame = pd.read_csv(DATA_PATH)
    source = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    results = {
        task: train_task(task, target, frame, source)
        for task, target in TARGETS.items()
    }
    path = MODEL_DIR / "brfss-2024-training-report.json"
    path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))
    print(f"\nResearch-only geographic holdout report written to {path}")


if __name__ == "__main__":
    main()
