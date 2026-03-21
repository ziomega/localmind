import re
import numpy as np
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("all-MiniLM-L6-v2")


def _clean_text(text: str) -> str:
    # Normalize whitespace so semantically similar pages map more consistently.
    return re.sub(r"\s+", " ", (text or "").strip())


def _chunk_words(text: str, chunk_size: int = 180, overlap: int = 40):
    words = text.split()
    if not words:
        return []

    chunks = []
    step = max(1, chunk_size - overlap)
    for i in range(0, len(words), step):
        chunk = words[i : i + chunk_size]
        if not chunk:
            continue
        chunks.append(" ".join(chunk))
        if i + chunk_size >= len(words):
            break
    return chunks


def _l2_normalize(vec: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(vec)
    if norm > 0:
        return vec / norm
    return vec


def get_embedding(text):
    cleaned = _clean_text(text)
    if not cleaned:
        return [0.0] * model.get_sentence_embedding_dimension()

    words = cleaned.split()

    # For long documents, embed overlapping chunks and mean-pool.
    if len(words) > 220:
        chunks = _chunk_words(cleaned)
        chunk_vectors = model.encode(
            chunks,
            convert_to_numpy=True,
            normalize_embeddings=True,
            batch_size=16,
        )
        pooled = chunk_vectors.mean(axis=0)
        pooled = _l2_normalize(pooled.astype("float32"))
        return pooled.tolist()

    vector = model.encode(
        cleaned,
        convert_to_numpy=True,
        normalize_embeddings=True,
    )
    vector = _l2_normalize(vector.astype("float32"))
    return vector.tolist()