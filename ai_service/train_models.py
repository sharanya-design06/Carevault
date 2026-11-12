import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import StratifiedKFold, cross_val_predict, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from xgboost import XGBClassifier

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = Path(__file__).resolve().parent / "models"
RANDOM_STATE = 42
TEST_SIZE = 0.2
CV_FOLDS = 5
MINIMUM_RECALL_FOR_THRESHOLD = 0.5

TASKS = {
    "diabetes": {
        "path": ROOT / "diabetes.csv",
        "target": "Outcome",
        "features": [
            "Pregnancies", "Glucose", "BloodPressure", "SkinThickness",
            "Insulin", "BMI", "DiabetesPedigreeFunction", "Age",
        ],
        "positiveLabel": "diabetes outcome in source dataset",
        "dataset": "Repository diabetes.csv (768 rows; provenance/fitness require review)",
        "populationLimitation": "Pima Indians benchmark; all records are women aged 21 or older.",
        "zeroIsMissing": ["Glucose", "BloodPressure", "SkinThickness", "Insulin", "BMI"],
    },
    "cardiac": {
        "path": ROOT / "heart.csv",
        "target": "target",
        "features": [
            "age", "sex", "cp", "trestbps", "chol", "fbs", "restecg",
            "thalach", "exang", "oldpeak", "slope", "ca", "thal",
        ],
        "positiveLabel": "positive heart-disease label in source dataset",
        "dataset": "Repository heart.csv (303 rows; provenance/fitness require review)",
        "populationLimitation": "Small historic Cleveland cohort; representativeness for current patients is unknown.",
    },
    "liver": {
        "path": ROOT / "liver.csv",
        "target": "Dataset",
        "features": [
            "Age", "Gender", "Total_Bilirubin", "Direct_Bilirubin",
            "Alkaline_Phosphotase", "Alamine_Aminotransferase",
            "Aspartate_Aminotransferase", "Total_Protiens", "Albumin",
            "Albumin_and_Globulin_Ratio",
        ],
        "positiveLabel": "Dataset=1 (liver disease) in source dataset",
        "dataset": "Repository liver.csv (583 rows; provenance/fitness require review)",
        "populationLimitation": "Indian Liver Patient Dataset; representativeness outside its source cohort is unknown.",
        "genderEncoding": {"Female": 0, "Male": 1},
        "positiveValue": 1,
        "negativeValue": 2,
    },
}


def build_estimators(y_train):
    class_counts = np.bincount(y_train)
    if len(class_counts) != 2 or np.any(class_counts == 0):
        raise ValueError("Both outcome classes are required for training.")
    scale_pos_weight = class_counts[0] / class_counts[1]
    return {
        "logistic_regression": Pipeline([
            ("imputer", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("model", LogisticRegression(
                class_weight="balanced", max_iter=2000, random_state=RANDOM_STATE,
            )),
        ]),
        "random_forest": Pipeline([
            ("imputer", SimpleImputer(strategy="median")),
            ("model", RandomForestClassifier(
                n_estimators=400, class_weight="balanced",
                random_state=RANDOM_STATE, n_jobs=-1,
            )),
        ]),
        "xgboost": Pipeline([
            ("imputer", SimpleImputer(strategy="median")),
            ("model", XGBClassifier(
                n_estimators=250, max_depth=3, learning_rate=0.04,
                subsample=0.85, colsample_bytree=0.85,
                scale_pos_weight=scale_pos_weight,
                eval_metric="logloss", random_state=RANDOM_STATE,
                n_jobs=1, tree_method="hist",
            )),
        ]),
        "svm": Pipeline([
            ("imputer", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("model", SVC(
                C=1.0, kernel="rbf", probability=True,
                class_weight="balanced", random_state=RANDOM_STATE,
            )),
        ]),
    }


def choose_threshold(labels, scores):
    candidates = np.unique(np.concatenate(([0.5], scores)))
    eligible = []
    for threshold in candidates:
        predicted = scores >= threshold
        recall = recall_score(labels, predicted, zero_division=0)
        if recall >= MINIMUM_RECALL_FOR_THRESHOLD:
            precision = precision_score(labels, predicted, zero_division=0)
            f1 = f1_score(labels, predicted, zero_division=0)
            eligible.append((precision, f1, recall, float(threshold)))
    return max(eligible)[-1] if eligible else 0.5


def metrics_for(labels, scores, threshold):
    predicted = scores >= threshold
    return {
        "accuracy": round(float(accuracy_score(labels, predicted)), 4),
        "precision": round(float(precision_score(labels, predicted, zero_division=0)), 4),
        "recall": round(float(recall_score(labels, predicted, zero_division=0)), 4),
        "f1": round(float(f1_score(labels, predicted, zero_division=0)), 4),
        "aucRoc": round(float(roc_auc_score(labels, scores)), 4),
        "averagePrecision": round(float(average_precision_score(labels, scores)), 4),
    }


def nested_cross_validation(name, features, labels):
    outer = StratifiedKFold(n_splits=CV_FOLDS, shuffle=True, random_state=RANDOM_STATE)
    fold_metrics = []
    for fold, (train_indices, validation_indices) in enumerate(outer.split(features, labels)):
        x_train, x_validation = features.iloc[train_indices], features.iloc[validation_indices]
        y_train, y_validation = labels.iloc[train_indices], labels.iloc[validation_indices]
        inner = StratifiedKFold(
            n_splits=3, shuffle=True, random_state=RANDOM_STATE + fold + 1,
        )
        inner_scores = cross_val_predict(
            build_estimators(y_train.to_numpy())[name],
            x_train, y_train, cv=inner, method="predict_proba", n_jobs=1,
        )[:, 1]
        threshold = choose_threshold(y_train.to_numpy(), inner_scores)
        fitted = build_estimators(y_train.to_numpy())[name]
        fitted.fit(x_train, y_train)
        validation_scores = fitted.predict_proba(x_validation)[:, 1]
        fold_metrics.append(metrics_for(y_validation.to_numpy(), validation_scores, threshold))
    return {
        "mean": {
            key: round(float(np.mean([fold[key] for fold in fold_metrics])), 4)
            for key in fold_metrics[0]
        },
        "standardDeviation": {
            key: round(float(np.std([fold[key] for fold in fold_metrics])), 4)
            for key in fold_metrics[0]
        },
    }


def prepare_data(config):
    frame = pd.read_csv(config["path"])
    required = config["features"] + [config["target"]]
    missing = [column for column in required if column not in frame.columns]
    if missing:
        raise ValueError(f"{config['path'].name}: missing columns: {', '.join(missing)}")
    frame = frame[required].copy()
    if "Gender" in frame:
        frame["Gender"] = frame["Gender"].map(config["genderEncoding"])
    frame = frame.apply(pd.to_numeric, errors="coerce")
    frame = frame.replace([np.inf, -np.inf], np.nan).dropna(subset=[config["target"]])
    if config.get("zeroIsMissing"):
        frame[config["zeroIsMissing"]] = frame[config["zeroIsMissing"]].replace(0, np.nan)
    if "positiveValue" in config:
        labels = frame[config["target"]].map({
            config["negativeValue"]: 0,
            config["positiveValue"]: 1,
        })
    else:
        labels = frame[config["target"]]
    usable = labels.notna()
    features = frame.loc[usable, config["features"]]
    labels = labels.loc[usable].astype(int)
    if set(labels.unique()) != {0, 1}:
        raise ValueError(f"{config['path'].name}: expected two binary outcome classes.")
    if features.isna().all(axis=1).any():
        keep = ~features.isna().all(axis=1)
        features, labels = features.loc[keep], labels.loc[keep]
    if labels.value_counts().min() < CV_FOLDS + 1:
        raise ValueError(f"{config['path'].name}: too few examples in the smaller class.")
    return features, labels


def train_task(condition, config):
    features, labels = prepare_data(config)
    x_train, x_test, y_train, y_test = train_test_split(
        features, labels, test_size=TEST_SIZE, random_state=RANDOM_STATE,
        stratify=labels,
    )
    benchmark = {}
    for name, estimator in build_estimators(y_train.to_numpy()).items():
        nested_metrics = nested_cross_validation(name, x_train, y_train)
        folds = StratifiedKFold(n_splits=CV_FOLDS, shuffle=True, random_state=RANDOM_STATE)
        out_of_fold_scores = cross_val_predict(
            estimator, x_train, y_train, cv=folds, method="predict_proba", n_jobs=1,
        )[:, 1]
        threshold = choose_threshold(y_train.to_numpy(), out_of_fold_scores)
        fitted = build_estimators(y_train.to_numpy())[name]
        fitted.fit(x_train, y_train)
        test_scores = fitted.predict_proba(x_test)[:, 1]
        benchmark[name] = {
            "threshold": round(threshold, 4),
            "crossValidation": nested_metrics,
            "test": metrics_for(y_test.to_numpy(), test_scores, threshold),
        }

    selected_name = max(
        benchmark,
        key=lambda name: (
            benchmark[name]["crossValidation"]["mean"]["precision"],
            benchmark[name]["crossValidation"]["mean"]["recall"],
            benchmark[name]["crossValidation"]["mean"]["aucRoc"],
        ),
    )
    selected_threshold = benchmark[selected_name]["threshold"]
    selected = build_estimators(labels.to_numpy())[selected_name]
    selected.fit(features, labels)
    metadata = {
        "condition": condition,
        "features": config["features"],
        "positiveLabel": config["positiveLabel"],
        "populationLimitation": config["populationLimitation"],
        "dataset": config["dataset"],
        "rowCount": int(len(features)),
        "positiveCount": int(labels.sum()),
        "testSize": TEST_SIZE,
        "testRows": int(len(y_test)),
        "crossValidationFolds": CV_FOLDS,
        "randomState": RANDOM_STATE,
        "selectedModel": selected_name,
        "selectionRule": (
            "highest nested cross-validation mean precision, then recall, then AUC-ROC; "
            f"final threshold selected on training-only out-of-fold scores with recall >= {MINIMUM_RECALL_FOR_THRESHOLD}"
        ),
        "threshold": selected_threshold,
        "metrics": benchmark[selected_name]["test"],
        "crossValidationMetrics": benchmark[selected_name]["crossValidation"]["mean"],
        "crossValidationStandardDeviation": benchmark[selected_name]["crossValidation"]["standardDeviation"],
        "benchmark": benchmark,
        "clinicalValidation": False,
    }
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": selected, **metadata}, MODEL_DIR / f"{condition}.joblib")
    return metadata


def main():
    results = {condition: train_task(condition, config) for condition, config in TASKS.items()}
    report_path = MODEL_DIR / "training-report.json"
    report_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))
    print(f"\nResearch-only artifacts and holdout metrics written to {MODEL_DIR}")


if __name__ == "__main__":
    main()
