import csv
import io
import math
import os
import re
import unicodedata
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import joblib
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pypdf import PdfReader

from ai_service.train_summarizer import extractive_summary

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 200
MODEL_DIR = Path(os.environ.get("CAREVAULT_MODEL_DIR", ROOT / "ai_service" / "models"))
INTERACTION_CSV = Path(os.environ.get("CAREVAULT_INTERACTION_CSV", ROOT / "db_drug_interactions.csv"))
summarizer_vectorizer = None
transformer_summarizer = None
SEVERITY_EXAMPLES = {
    ("warfarin", "ibuprofen"): ("major", "Bleeding risk is significantly increased."),
    ("warfarin", "naproxen"): ("major", "Bleeding risk is significantly increased."),
    ("warfarin", "aspirin"): ("major", "Bleeding risk is significantly increased."),
    ("lisinopril", "potassium"): ("major", "Risk of hyperkalaemia."),
    ("lisinopril", "spironolactone"): ("major", "Risk of hyperkalaemia."),
    ("lisinopril", "ibuprofen"): ("moderate", "NSAIDs can reduce antihypertensive effect and harm kidney function."),
    ("simvastatin", "clarithromycin"): ("contraindicated", "Raised statin exposure; risk of rhabdomyolysis."),
    ("atorvastatin", "clarithromycin"): ("major", "Raised statin exposure; risk of muscle toxicity."),
    ("sertraline", "tramadol"): ("major", "Risk of serotonin syndrome and seizures."),
    ("digoxin", "amiodarone"): ("major", "Digoxin levels may rise to toxic range."),
    ("methotrexate", "trimethoprim"): ("major", "Risk of severe bone-marrow suppression."),
    ("sildenafil", "nitroglycerin"): ("contraindicated", "Profound hypotension."),
    ("clopidogrel", "omeprazole"): ("moderate", "Omeprazole may reduce clopidogrel effectiveness."),
}
DRUG_CLASSES = {
    "penicillins": {"penicillin", "penicillins", "amoxicillin", "ampicillin", "flucloxacillin", "piperacillin"},
    "cephalosporins": {"cephalosporins", "cefalexin", "cephalexin", "cefazolin", "ceftriaxone", "cefuroxime"},
    "sulfonamides": {"sulfa", "sulfonamides", "sulfamethoxazole", "trimethoprim sulfamethoxazole", "sulfasalazine"},
    "nsaids": {"nsaids", "ibuprofen", "naproxen", "diclofenac", "ketorolac", "aspirin"},
    "opioids": {"opioids", "codeine", "morphine", "tramadol", "oxycodone"},
    "macrolides": {"macrolides", "azithromycin", "clarithromycin", "erythromycin"},
    "statins": {"statins", "atorvastatin", "simvastatin", "rosuvastatin", "pravastatin"},
}
DRUG_CLASS_FORMS = {
    normalize: drug_class
    for drug_class, members in DRUG_CLASSES.items()
    for member in members
    for normalize in [" ".join(re.sub(r"[^a-z0-9]+", " ", member.lower()).split())]
}
LAB_TESTS = [
    ("HbA1c", re.compile(r"\b(?:hba1c|glycated h(?:a)?emoglobin)\b", re.I), "%", 4, 5.6),
    ("Fasting glucose", re.compile(r"\b(?:fasting )?glucose\b", re.I), "mg/dL", 70, 99),
    ("Total cholesterol", re.compile(r"\btotal cholesterol\b", re.I), "mg/dL", 0, 199),
    ("LDL cholesterol", re.compile(r"\bldl\b", re.I), "mg/dL", 0, 129),
    ("HDL cholesterol", re.compile(r"\bhdl\b", re.I), "mg/dL", 40, 200),
    ("Triglycerides", re.compile(r"\btriglycerides?\b", re.I), "mg/dL", 0, 149),
    ("Creatinine", re.compile(r"\bcreatinine\b", re.I), "mg/dL", 0.6, 1.3),
    ("eGFR", re.compile(r"\begfr\b", re.I), "mL/min/1.73m²", 60, 200),
    ("Hemoglobin", re.compile(r"\b(?:haemoglobin|hemoglobin)(?!\s*a1c)\b", re.I), "g/dL", 12, 17.5),
]
FINDING_LINE = re.compile(
    r"^\s*(?P<test>[A-Za-z][A-Za-z0-9 /().-]{1,60}?)\s+"
    r"(?P<value>-?\d+(?:\.\d+)?)\s*(?P<unit>%|mg/dL|g/dL|mmol/L|mL/min(?:/1\.73m²)?)?",
    re.I,
)
HIGHLIGHT_TERMS = re.compile(
    r"\b(?:impression|conclusion|findings|interpretation|assessment|abnormal|"
    r"positive|negative|elevated|low|high|critical|recommendation)\b",
    re.I,
)
interaction_index: dict[tuple[str, str], list[str]] = {}
interaction_error: str | None = None


def normalize_drug(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value.lower()).split())


def pair_key(first: str, second: str) -> tuple[str, str]:
    return tuple(sorted((normalize_drug(first), normalize_drug(second))))


def load_interactions() -> None:
    global interaction_index, interaction_error
    try:
        index: dict[tuple[str, str], list[str]] = {}
        with INTERACTION_CSV.open(newline="", encoding="utf-8-sig") as source:
            reader = csv.DictReader(source)
            if reader.fieldnames != ["Drug 1", "Drug 2", "Interaction Description"]:
                raise ValueError("Unexpected columns in the interaction CSV.")
            for row in reader:
                first, second = row["Drug 1"].strip(), row["Drug 2"].strip()
                description = row["Interaction Description"].strip()
                if first and second and description:
                    index.setdefault(pair_key(first, second), []).append(description)
        if not index:
            raise ValueError("The interaction CSV contains no usable entries.")
        interaction_index = index
        interaction_error = None
    except (OSError, UnicodeError, csv.Error, ValueError) as error:
        interaction_index = {}
        interaction_error = str(error)


class InteractionRequest(BaseModel):
    medication: str = Field(min_length=1, max_length=120)
    current_medications: list[str] = Field(default_factory=list, max_length=100)
    allergies: list[dict[str, Any]] = Field(default_factory=list, max_length=100)


class PredictionRequest(BaseModel):
    features: dict[str, float | int] = Field(min_length=1, max_length=20)


def extract_pdf_text(content: bytes) -> tuple[str, int]:
    try:
        reader = PdfReader(io.BytesIO(content), strict=False)
        if len(reader.pages) > MAX_PDF_PAGES:
            raise HTTPException(413, f"PDF is limited to {MAX_PDF_PAGES} pages.")
        pages = [page.extract_text() or "" for page in reader.pages]
        text = "\n".join(pages).strip()
        if not text:
            raise HTTPException(422, "No selectable text found. Scanned PDFs require OCR, which is not configured.")
        return text, len(reader.pages)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(422, "Could not read the PDF. Verify the file and try again.") from error


def summarize_text(text: str, page_count: int) -> dict[str, Any]:
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines() if line.strip()]
    findings: list[dict[str, Any]] = []
    seen_tests: set[str] = set()
    for line in lines:
        for test, pattern, unit, low, high in LAB_TESTS:
            if test in seen_tests or not pattern.search(line):
                continue
            match = FINDING_LINE.search(line)
            if not match:
                continue
            value = float(match.group("value"))
            findings.append({
                "test": test, "value": value, "unit": unit,
                "range": f"{low}–{high}",
                "flag": "low" if value < low else "high" if value > high else "normal",
            })
            seen_tests.add(test)
    abnormal = [finding for finding in findings if finding["flag"] != "normal"]
    highlights = []
    for line in lines:
        if HIGHLIGHT_TERMS.search(line) and line not in highlights:
            highlights.append(line[:400])
        if len(highlights) == 5:
            break
    if findings:
        headline = (
            f"Extracted {len(findings)} common lab value(s) from {page_count} page(s); "
            f"{len(abnormal)} are outside configured reference ranges"
            + (": " + ", ".join(item["test"] for item in abnormal) if abnormal else "")
            + "."
        )
    else:
        headline = (
            "No recognized common lab values were found. Review the report manually; "
            "reference ranges and test coverage vary by laboratory."
        )
    if not highlights:
        highlights = ["No matching conclusion or findings text was detected."]
    if transformer_summarizer:
        summary_text = transformer_summarizer.summarize(text)
        summary_model = "local-biobert-t5-finetuned-v1"
    elif summarizer_vectorizer:
        summary_text = extractive_summary(text, summarizer_vectorizer)
        summary_model = "local-tfidf-extractive-v1"
    else:
        summary_text = ""
        summary_model = "local-structured-extraction-v1"
    return {
        "headline": headline,
        "summaryText": summary_text,
        "findings": findings,
        "highlights": highlights,
        "extracted": bool(findings or highlights[0] != "No matching conclusion or findings text was detected."),
        "model": summary_model,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "pageCount": page_count,
        "limitations": [
            "Automated summaries are research-only and may omit or misstate clinical details; review the source report.",
            "Scanned image OCR and disease diagnosis are not supported.",
            "Configured reference ranges may not match the laboratory's own ranges.",
        ],
    }


def check_interactions(request: InteractionRequest) -> dict[str, Any]:
    if interaction_error:
        raise HTTPException(503, "Drug-interaction data is unavailable: " + interaction_error)
    candidate = request.medication.strip()
    if not candidate:
        raise HTTPException(422, "Medication name is required.")
    alerts = []
    candidate_name = normalize_drug(candidate)
    candidate_classes = {DRUG_CLASS_FORMS[candidate_name]} if candidate_name in DRUG_CLASS_FORMS else set()
    for allergy in request.allergies:
        allergen = str(allergy.get("name", "")).strip()
        allergen_name = normalize_drug(allergen)
        allergen_classes = {DRUG_CLASS_FORMS[allergen_name]} if allergen_name in DRUG_CLASS_FORMS else set()
        cross_reactive = (
            ("penicillins" in allergen_classes and "cephalosporins" in candidate_classes)
            or ("cephalosporins" in allergen_classes and "penicillins" in candidate_classes)
        )
        if allergen and (allergen_name == candidate_name or candidate_classes.intersection(allergen_classes) or cross_reactive):
            alerts.append({
                "type": "allergy", "severity": "major" if allergen_name == candidate_name or candidate_classes.intersection(allergen_classes) else "moderate",
                "message": f"Documented allergy to {allergen} ({allergy.get('reaction') or 'reaction not recorded'}); possible match or cross-reactivity with {candidate}.",
            })
    for current in request.current_medications:
        current = current.strip()
        if not current:
            continue
        if normalize_drug(current) == candidate_name:
            alerts.append({
                "type": "duplicate", "severity": "unknown",
                "message": f"{candidate} is already listed as a current medication ({current}).",
            })
        key = pair_key(candidate, current)
        severity_example = SEVERITY_EXAMPLES.get(key)
        descriptions = interaction_index.get(key, [])
        if severity_example:
            severity, description = severity_example
            alerts.append({
                "type": "interaction", "severity": severity,
                "message": f"{candidate} + {current}: {description}",
            })
        elif descriptions:
            alerts.extend({
                "type": "interaction", "severity": "unknown",
                "message": (
                    f"{candidate} + {current}: {description} "
                    "The dataset does not provide a severity rating."
                ),
            } for description in descriptions[:5])
    return {
        "alerts": alerts,
        "matchedPairs": len([item for item in alerts if item["type"] == "interaction"]),
        "source": "Bundled CSV with unverified provenance plus demo severity examples",
        "coverage": "Incomplete; no alert does not mean a combination is safe.",
    }


def load_model(condition: str) -> dict[str, Any]:
    artifact = MODEL_DIR / f"{condition}.joblib"
    if not artifact.is_file():
        raise HTTPException(503, f"No trained {condition} prototype model is installed. Run the training command first.")
    try:
        return joblib.load(artifact)
    except (OSError, ValueError, EOFError) as error:
        raise HTTPException(503, f"The {condition} model artifact could not be loaded.") from error


@asynccontextmanager
async def lifespan(_: FastAPI):
    global summarizer_vectorizer, transformer_summarizer
    load_interactions()
    transformer_path = MODEL_DIR / "biobert_t5_summarizer"
    if transformer_path.is_dir():
        try:
            from ai_service.transformer_summarizer import load_biobert_t5_summarizer

            transformer_summarizer = load_biobert_t5_summarizer(transformer_path)
        except (ImportError, OSError, ValueError, RuntimeError) as error:
            raise RuntimeError("The local BioBERT/T5 summarizer could not be loaded.") from error
    summarizer_path = MODEL_DIR / "summarizer.joblib"
    if summarizer_path.is_file() and transformer_summarizer is None:
        try:
            summarizer_vectorizer = joblib.load(summarizer_path)["vectorizer"]
        except (OSError, ValueError, EOFError, KeyError) as error:
            raise RuntimeError("The trained report summarizer artifact could not be loaded.") from error
    yield


app = FastAPI(
    title="CareVault Local AI Prototype",
    description="Local-only research/demo service. Not validated for clinical use.",
    version="0.1.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def local_origin_only(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin:
        host = (urlsplit(origin).hostname or "").lower()
        if host not in {"localhost", "127.0.0.1", "::1"}:
            return JSONResponse(status_code=403, content={"detail": "This local AI service only accepts local browser origins."})
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/ai/health")
def health():
    return {
        "ok": True,
        "mode": "local-research-prototype",
        "interactionDataLoaded": bool(interaction_index),
        "interactionDataError": interaction_error,
        "models": {
            condition: (MODEL_DIR / f"{condition}.joblib").is_file()
            for condition in ("diabetes", "cardiac", "liver")
        },
        "hypertensionModel": False,
        "summaryModel": transformer_summarizer is not None or summarizer_vectorizer is not None,
        "summaryMode": (
            "local-biobert-t5-finetuned" if transformer_summarizer
            else "local-tfidf-extractive" if summarizer_vectorizer
            else "local-structured-extraction"
        ),
        "clinicalValidation": False,
    }


@app.post("/api/ai/v1/summarize")
async def summarize(file: UploadFile = File(...)):
    if file.content_type != "application/pdf" and not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(415, "Upload a PDF report.")
    content = await file.read(MAX_PDF_BYTES + 1)
    if len(content) > MAX_PDF_BYTES:
        raise HTTPException(413, "PDF is limited to 10 MB.")
    if not content.startswith(b"%PDF-"):
        raise HTTPException(415, "The uploaded file is not a valid PDF.")
    text, pages = extract_pdf_text(content)
    return summarize_text(text, pages)


@app.post("/api/ai/v1/interactions/check")
def interactions(request: InteractionRequest):
    return check_interactions(request)


@app.post("/api/ai/v1/predict/{condition}")
def predict(condition: str, request: PredictionRequest):
    if condition not in {"diabetes", "cardiac", "liver"}:
        if condition == "hypertension":
            raise HTTPException(501, "The repository has no labeled hypertension training dataset.")
        raise HTTPException(404, "Unsupported prediction task.")
    artifact = load_model(condition)
    model = artifact["model"]
    feature_names = artifact["features"]
    missing = [name for name in feature_names if name not in request.features]
    if missing:
        raise HTTPException(422, "Missing model inputs: " + ", ".join(missing))
    values = [request.features[name] for name in feature_names]
    if not all(math.isfinite(float(value)) for value in values):
        raise HTTPException(422, "Model inputs must be finite numbers.")
    try:
        score = float(model.predict_proba([values])[0][1])
    except (ValueError, TypeError) as error:
        raise HTTPException(422, "Invalid model input values.") from error
    return {
        "condition": condition,
        "model": artifact["selectedModel"],
        "modelScore": round(score, 4),
        "decisionThreshold": artifact["threshold"],
        "prediction": "positive" if score >= artifact["threshold"] else "negative",
        "positiveLabel": artifact["positiveLabel"],
        "populationLimitation": artifact["populationLimitation"],
        "metrics": artifact["metrics"],
        "dataset": artifact["dataset"],
        "clinicalUse": False,
        "notice": "Research/demo estimate, not a diagnosis or calibrated clinical risk.",
    }


@app.get("/api/ai", include_in_schema=False)
def app_entry():
    return FileResponse(PUBLIC / "index.html")


app.mount("/", StaticFiles(directory=PUBLIC, html=True), name="public")
