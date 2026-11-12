import json
import re
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.model_selection import GroupShuffleSplit

ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "mtsamples.csv"
MODEL_DIR = Path(__file__).resolve().parent / "models"
RANDOM_STATE = 42
TEST_SIZE = 0.2
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9])")
WORD = re.compile(r"\b[a-z0-9]+\b", re.I)


def split_sentences(text):
    sentences = []
    for line in str(text or "").replace("\r", "").split("\n"):
        line = re.sub(r"\s+", " ", line).strip()
        for segment in re.split(r"[|]+", line):
            for sentence in SENTENCE_SPLIT.split(segment):
                sentence = sentence.strip()
                if 4 <= len(sentence.split()) and len(sentence) <= 500:
                    sentences.append(sentence)
    return sentences


def extractive_summary(text, vectorizer, max_sentences=3, max_chars=700):
    sentences = split_sentences(text)
    if not sentences:
        return ""
    matrix = vectorizer.transform(sentences)
    centroid = np.asarray(matrix.mean(axis=0)).ravel()
    scores = np.asarray(matrix @ centroid).ravel()
    scores += np.array([0.2 / (index + 1) for index in range(len(sentences))])
    ranked = sorted(range(len(sentences)), key=lambda index: (-scores[index], index))
    selected = []
    length = 0
    for index in ranked:
        sentence = sentences[index]
        if length + len(sentence) > max_chars:
            continue
        selected.append(index)
        length += len(sentence) + 1
        if len(selected) == max_sentences:
            break
    return " ".join(sentences[index] for index in sorted(selected))


def lcs_length(first, second):
    previous = [0] * (len(second) + 1)
    for token in first:
        current = [0]
        for index, other in enumerate(second, 1):
            current.append(previous[index - 1] + 1 if token == other else max(previous[index], current[-1]))
        previous = current
    return previous[-1]


def rouge_scores(summary, reference):
    summary_words = WORD.findall(summary.lower())
    reference_words = WORD.findall(reference.lower())
    summary_bigrams = list(zip(summary_words, summary_words[1:]))
    reference_bigrams = list(zip(reference_words, reference_words[1:]))

    def f1(overlap, predicted_count, reference_count):
        precision = overlap / predicted_count if predicted_count else 0
        recall = overlap / reference_count if reference_count else 0
        return 2 * precision * recall / (precision + recall) if precision + recall else 0

    unigram_overlap = sum(min(summary_words.count(word), reference_words.count(word)) for word in set(summary_words))
    bigram_overlap = sum(min(summary_bigrams.count(pair), reference_bigrams.count(pair)) for pair in set(summary_bigrams))
    lcs = lcs_length(summary_words, reference_words)
    return {
        "rouge1F1": f1(unigram_overlap, len(summary_words), len(reference_words)),
        "rouge2F1": f1(bigram_overlap, len(summary_bigrams), len(reference_bigrams)),
        "rougeLF1": f1(lcs, len(summary_words), len(reference_words)),
    }


def main():
    frame = pd.read_csv(DATA_PATH).dropna(subset=["description", "transcription"])
    frame["description"] = frame["description"].astype(str).str.strip()
    frame["transcription"] = frame["transcription"].astype(str).str.strip()
    frame = frame[(frame["description"] != "") & (frame["transcription"] != "")]
    train_indices, test_indices = next(GroupShuffleSplit(
        n_splits=1, test_size=TEST_SIZE, random_state=RANDOM_STATE,
    ).split(frame, groups=frame["description"]))
    train, test = frame.iloc[train_indices], frame.iloc[test_indices]
    vectorizer = TfidfVectorizer(
        lowercase=True, stop_words="english", ngram_range=(1, 2),
        max_features=50000, sublinear_tf=True,
    )
    vectorizer.fit(train["transcription"])
    scores = []
    for row in test.itertuples(index=False):
        summary = extractive_summary(row.transcription, vectorizer)
        scores.append(rouge_scores(summary, row.description))
    evaluation = {
        key: round(float(np.mean([score[key] for score in scores])), 4)
        for key in ("rouge1F1", "rouge2F1", "rougeLF1")
    }
    metadata = {
        "model": "tfidf-extractive-v1",
        "dataset": "Repository mtsamples.csv; description used as a short reference, provenance/fitness require review",
        "trainingRows": int(len(train)),
        "testRows": int(len(test)),
        "testSize": TEST_SIZE,
        "randomState": RANDOM_STATE,
        "splitGroupedBy": "description",
        "maxSentences": 3,
        "evaluation": evaluation,
        "clinicalValidation": False,
    }
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump({"vectorizer": vectorizer, **metadata}, MODEL_DIR / "summarizer.joblib")
    (MODEL_DIR / "summarizer-report.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps(metadata, indent=2))
    print(f"\nResearch-only extractive summarizer saved to {MODEL_DIR}")


if __name__ == "__main__":
    main()
