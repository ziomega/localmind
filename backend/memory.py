import faiss
import numpy as np
import json
import os

DIM = 384  # embedding size for all-MiniLM-L6-v2
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INDEX_FILE = os.path.join(BASE_DIR, "data", "index.faiss")
META_FILE = os.path.join(BASE_DIR, "data", "metadata.json")

# Load or create index
if os.path.exists(INDEX_FILE):
    index = faiss.read_index(INDEX_FILE)
else:
    index = faiss.IndexFlatL2(DIM)

# Load metadata
if os.path.exists(META_FILE):
    with open(META_FILE, "r") as f:
        metadata = json.load(f)
else:
    metadata = []

def save():
    faiss.write_index(index, INDEX_FILE)
    with open(META_FILE, "w") as f:
        json.dump(metadata, f)


def _normalize_rows(vec: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vec, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return vec / norms

def add_memory(vector, data):
    vec = np.array([vector], dtype="float32")
    vec = _normalize_rows(vec)
    index.add(vec)
    metadata.append(data)
    save()

def search_memory(query_vector, k=3, min_similarity=0.10):
    if index.ntotal == 0:
        return []

    vec = np.array([query_vector], dtype="float32")
    vec = _normalize_rows(vec)
    D, I = index.search(vec, k)

    results = []
    for distance, i in zip(D[0], I[0]):
        if i < 0 or i >= len(metadata):
            continue
        # For normalized vectors: cosine_similarity = 1 - (L2^2 / 2)
        cosine_sim = float(1.0 - (max(float(distance), 0.0) / 2.0))
        if cosine_sim < min_similarity:
            continue
        item = dict(metadata[i])
        item["score"] = round(cosine_sim, 4)
        results.append(item)
    return results