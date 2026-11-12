import hashlib
import json
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
ARCHIVE_NAME = "LLCP2024XPT.zip"
ARCHIVE_URL = "https://www.cdc.gov/brfss/annual_data/2024/files/LLCP2024XPT.zip"
DATASET_URL = "https://www.cdc.gov/brfss/annual_data/annual_2024.html"
CODEBOOK_URL = "https://www.cdc.gov/brfss/annual_data/2024/zip/codebook24_llcp-v2-508.zip"
CHUNK_SIZE = 25_000
TARGETS = {"diabetes": "DIABETE4", "heart_disease": "CVDCRHD4"}
FEATURES = [
    "_AGEG5YR", "SEXVAR", "GENHLTH", "PHYSHLTH", "MENTHLTH",
    "EXERANY2", "SMOKE100", "_BMI5", "_INCOMG1", "_EDUCAG", "_RACEGR3",
]
REQUIRED_COLUMNS = set(FEATURES + list(TARGETS.values()) + ["_LLCPWT", "_STATE"])


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize_chunk(frame):
    missing = REQUIRED_COLUMNS.difference(frame.columns)
    if missing:
        raise ValueError(f"CDC file is missing required variables: {', '.join(sorted(missing))}")
    ordered_columns = FEATURES + list(TARGETS.values()) + ["_LLCPWT", "_STATE"]
    frame = frame[ordered_columns].copy()
    for column in FEATURES + list(TARGETS.values()) + ["_LLCPWT", "_STATE"]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")

    frame["_BMI5"] = frame["_BMI5"].where(frame["_BMI5"].between(1000, 9998)) / 100
    for column in ("_AGEG5YR",):
        frame[column] = frame[column].where(frame[column].between(1, 14))
    for column in ("SEXVAR",):
        frame[column] = frame[column].where(frame[column].isin([1, 2]))
    frame["GENHLTH"] = frame["GENHLTH"].where(frame["GENHLTH"].between(1, 5))
    for column in ("PHYSHLTH", "MENTHLTH"):
        frame[column] = frame[column].replace(88, 0).where(lambda values: values.between(0, 30))
    for column in ("EXERANY2", "SMOKE100"):
        frame[column] = frame[column].map({1: 1, 2: 0})
    frame["_INCOMG1"] = frame["_INCOMG1"].where(frame["_INCOMG1"].between(1, 11))
    frame["_EDUCAG"] = frame["_EDUCAG"].where(frame["_EDUCAG"].between(1, 4))
    frame["_RACEGR3"] = frame["_RACEGR3"].where(frame["_RACEGR3"].between(1, 8))
    frame["_LLCPWT"] = frame["_LLCPWT"].where(frame["_LLCPWT"] > 0)
    frame["_STATE"] = frame["_STATE"].where(frame["_STATE"] > 0)

    frame["diabetes"] = frame["DIABETE4"].map({1: 1, 3: 0})
    frame["heart_disease"] = frame["CVDCRHD4"].map({1: 1, 2: 0})
    frame = frame.drop(columns=["DIABETE4", "CVDCRHD4"])
    frame = frame.dropna(subset=["_LLCPWT", "_STATE"])
    return frame


def acquire():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    archive_path = RAW_DIR / ARCHIVE_NAME
    if not archive_path.exists():
        request = urllib.request.Request(
            ARCHIVE_URL,
            headers={"User-Agent": "CareVault research dataset preparation"},
        )
        with urllib.request.urlopen(request, timeout=60) as response, archive_path.open("wb") as target:
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                target.write(block)

    output_path = PROCESSED_DIR / "brfss_2024_self_report.csv"
    row_count = 0
    with zipfile.ZipFile(archive_path) as archive:
        members = [name for name in archive.namelist() if name.strip().lower().endswith(".xpt")]
        if len(members) != 1:
            raise ValueError("Expected exactly one XPT file in the CDC archive.")
        with archive.open(members[0]) as source:
            batches = pd.read_sas(source, format="xport", iterator=True, chunksize=CHUNK_SIZE)
            for index, batch in enumerate(batches):
                prepared = normalize_chunk(batch)
                prepared.to_csv(
                    output_path, mode="w" if index == 0 else "a",
                    header=index == 0, index=False,
                )
                row_count += len(prepared)
    if row_count == 0:
        raise ValueError("CDC dataset produced no usable rows.")
    manifest = {
        "dataset": "CDC 2024 Behavioral Risk Factor Surveillance System (BRFSS), combined landline and cell phone data",
        "source": DATASET_URL,
        "archive": ARCHIVE_URL,
        "codebook": CODEBOOK_URL,
        "archiveSha256": sha256_file(archive_path),
        "archiveBytes": archive_path.stat().st_size,
        "processedRows": row_count,
        "features": FEATURES,
        "targets": {
            "diabetes": "DIABETE4: yes (1) vs no (3); gestational-only, prediabetes, unknown/refused excluded",
            "heart_disease": "CVDCRHD4: yes (1) vs no (2); unknown/refused excluded",
        },
        "outcomeMeaning": "Cross-sectional self-reported prior diagnosis, not incident disease or clinical prediction.",
        "surveyDesign": {
            "weight": "_LLCPWT",
            "geographicGroup": "_STATE",
            "limitations": "Training report is an exploratory benchmark; it does not fully model BRFSS complex survey strata/PSU design.",
        },
        "rowsAreDeidentifiedPublicSurveyData": True,
    }
    (PROCESSED_DIR / "brfss_2024_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    acquire()
