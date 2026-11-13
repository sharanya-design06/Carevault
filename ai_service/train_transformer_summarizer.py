import json
from pathlib import Path

import pandas as pd
import torch
from sklearn.model_selection import GroupShuffleSplit
from transformers import (
    AutoModel,
    AutoModelForSeq2SeqLM,
    AutoTokenizer,
    DataCollatorForSeq2Seq,
    Seq2SeqTrainer,
    Seq2SeqTrainingArguments,
)

from ai_service.train_summarizer import rouge_scores
from ai_service.transformer_summarizer import BiobertT5Summarizer

ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "mtsamples.csv"
MODEL_DIR = Path(__file__).resolve().parent / "models" / "biobert_t5_summarizer"
BIOBERT_CHECKPOINT = "dmis-lab/biobert-base-cased-v1.2"
T5_CHECKPOINT = "google/flan-t5-small"
RANDOM_STATE = 42
TEST_SIZE = 0.2
INPUT_MAX_LENGTH = 512
TARGET_MAX_LENGTH = 128


class SummaryDataset:
    def __init__(self, inputs, targets, tokenizer):
        self.inputs = inputs
        self.targets = targets
        self.tokenizer = tokenizer

    def __len__(self):
        return len(self.inputs)

    def __getitem__(self, index):
        source = self.tokenizer(
            "summarize medical report: " + self.inputs[index],
            truncation=True, max_length=INPUT_MAX_LENGTH,
        )
        target = self.tokenizer(
            text_target=self.targets[index],
            truncation=True, max_length=TARGET_MAX_LENGTH,
        )
        source["labels"] = target["input_ids"]
        return source


def load_pairs():
    frame = pd.read_csv(DATA_PATH).dropna(subset=["description", "transcription"])
    frame["description"] = frame["description"].astype(str).str.strip()
    frame["transcription"] = frame["transcription"].astype(str).str.strip()
    frame = frame[
        (frame["description"] != "") & (frame["transcription"] != "")
    ].drop_duplicates(subset=["description", "transcription"])
    train_indices, test_indices = next(GroupShuffleSplit(
        n_splits=1, test_size=TEST_SIZE, random_state=RANDOM_STATE,
    ).split(frame, groups=frame["description"]))
    return frame.iloc[train_indices], frame.iloc[test_indices]


def main():
    train, test = load_pairs()
    biobert_tokenizer = AutoTokenizer.from_pretrained(BIOBERT_CHECKPOINT)
    biobert = AutoModel.from_pretrained(BIOBERT_CHECKPOINT)
    selector = BiobertT5Summarizer(
        biobert, biobert_tokenizer, None, None,
    )
    train_inputs = [selector.select_context(text) for text in train["transcription"]]
    test_inputs = [selector.select_context(text) for text in test["transcription"]]
    biobert.to("cpu")
    del selector
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    train_targets = train["description"].tolist()
    test_targets = test["description"].tolist()

    t5_tokenizer = AutoTokenizer.from_pretrained(T5_CHECKPOINT)
    t5 = AutoModelForSeq2SeqLM.from_pretrained(T5_CHECKPOINT)
    trainer = Seq2SeqTrainer(
        model=t5,
        args=Seq2SeqTrainingArguments(
            output_dir=str(MODEL_DIR / "training"),
            num_train_epochs=2,
            per_device_train_batch_size=2,
            per_device_eval_batch_size=2,
            gradient_accumulation_steps=4,
            learning_rate=5e-5,
            eval_strategy="epoch",
            save_strategy="no",
            logging_steps=50,
            predict_with_generate=True,
            generation_max_length=TARGET_MAX_LENGTH,
            report_to="none",
            use_cpu=not torch.cuda.is_available(),
        ),
        train_dataset=SummaryDataset(train_inputs, train_targets, t5_tokenizer),
        eval_dataset=SummaryDataset(test_inputs, test_targets, t5_tokenizer),
        data_collator=DataCollatorForSeq2Seq(t5_tokenizer, model=t5),
        processing_class=t5_tokenizer,
    )
    trainer.train()
    predictions = trainer.predict(
        SummaryDataset(test_inputs, test_targets, t5_tokenizer),
        max_length=TARGET_MAX_LENGTH,
        num_beams=4,
    ).predictions
    predicted_texts = t5_tokenizer.batch_decode(
        predictions, skip_special_tokens=True,
    )
    metrics = {
        key: round(
            sum(rouge_scores(prediction, reference)[key]
                for prediction, reference in zip(predicted_texts, test_targets))
            / len(test_targets),
            4,
        )
        for key in ("rouge1F1", "rouge2F1", "rougeLF1")
    }

    report = {
        "model": "biobert-context-selection+fine-tuned-flan-t5-small",
        "biobertCheckpoint": BIOBERT_CHECKPOINT,
        "t5Checkpoint": T5_CHECKPOINT,
        "dataset": "Repository mtsamples.csv; description is a weak, non-clinician-reviewed reference",
        "trainingRows": len(train),
        "testRows": len(test),
        "testSize": TEST_SIZE,
        "randomState": RANDOM_STATE,
        "splitGroupedBy": "description",
        "bioBertContextSelectionMaxSentences": 12,
        "evaluation": metrics,
        "clinicalValidation": False,
        "limitations": [
            "Dataset descriptions are weak targets, not verified clinical summaries.",
            "ROUGE overlap does not measure clinical correctness or hallucination.",
            "Research prototype only; clinician review of the source report is required.",
        ],
    }
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    biobert.save_pretrained(MODEL_DIR / "biobert")
    biobert_tokenizer.save_pretrained(MODEL_DIR / "biobert")
    trainer.save_model(MODEL_DIR / "t5")
    t5_tokenizer.save_pretrained(MODEL_DIR / "t5")
    (MODEL_DIR / "training-report.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8",
    )
    print(json.dumps(report, indent=2))
    print(f"\nResearch-only BioBERT/T5 model saved to {MODEL_DIR}")


if __name__ == "__main__":
    main()
