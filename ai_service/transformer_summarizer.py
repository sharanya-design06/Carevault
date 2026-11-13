import re
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModel, AutoModelForSeq2SeqLM, AutoTokenizer

from ai_service.train_summarizer import split_sentences


class BiobertT5Summarizer:
    def __init__(self, biobert, biobert_tokenizer, t5, t5_tokenizer):
        self.biobert = biobert
        self.biobert_tokenizer = biobert_tokenizer
        self.t5 = t5
        self.t5_tokenizer = t5_tokenizer
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.biobert.to(self.device).eval()
        if self.t5 is not None:
            self.t5.to(self.device).eval()

    def select_context(self, text: str, max_sentences: int = 12) -> str:
        sentences = split_sentences(text)
        if len(sentences) <= max_sentences:
            return " ".join(sentences)

        candidate_positions = np.linspace(
            0, len(sentences) - 1, num=min(160, len(sentences)), dtype=int,
        )
        candidates = [sentences[index] for index in candidate_positions]
        embeddings = []
        with torch.inference_mode():
            for start in range(0, len(candidates), 16):
                encoded = self.biobert_tokenizer(
                    candidates[start:start + 16], padding=True, truncation=True,
                    max_length=128, return_tensors="pt",
                )
                encoded = {key: value.to(self.device) for key, value in encoded.items()}
                hidden = self.biobert(**encoded).last_hidden_state
                mask = encoded["attention_mask"].unsqueeze(-1)
                batch_embeddings = (hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)
                embeddings.append(batch_embeddings)
            embeddings = torch.cat(embeddings)
            embeddings = torch.nn.functional.normalize(embeddings, p=2, dim=1)
            centroid = torch.nn.functional.normalize(embeddings.mean(dim=0), p=2, dim=0)
            scores = (embeddings @ centroid).cpu().numpy()

        selected = sorted(
            range(len(candidates)),
            key=lambda index: (-float(scores[index]), index),
        )[:max_sentences]
        return " ".join(sentences[candidate_positions[index]] for index in sorted(selected))

    def summarize(self, text: str) -> str:
        context = self.select_context(text)
        if not context:
            return ""
        prompt = "summarize medical report: " + context
        inputs = self.t5_tokenizer(
            prompt, return_tensors="pt", truncation=True, max_length=512,
        )
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with torch.inference_mode():
            generated = self.t5.generate(
                **inputs, max_new_tokens=160, num_beams=4, do_sample=False,
            )
        return re.sub(r"\s+", " ", self.t5_tokenizer.decode(
            generated[0], skip_special_tokens=True,
        )).strip()


def load_biobert_t5_summarizer(model_dir: Path) -> BiobertT5Summarizer:
    biobert_dir = model_dir / "biobert"
    t5_dir = model_dir / "t5"
    if not biobert_dir.is_dir() or not t5_dir.is_dir():
        raise FileNotFoundError("BioBERT/T5 summarizer model files are incomplete.")

    biobert_tokenizer = AutoTokenizer.from_pretrained(
        biobert_dir, local_files_only=True,
    )
    biobert = AutoModel.from_pretrained(biobert_dir, local_files_only=True)
    t5_tokenizer = AutoTokenizer.from_pretrained(t5_dir, local_files_only=True)
    t5 = AutoModelForSeq2SeqLM.from_pretrained(t5_dir, local_files_only=True)
    return BiobertT5Summarizer(biobert, biobert_tokenizer, t5, t5_tokenizer)
