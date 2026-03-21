from fastapi import FastAPI
from pydantic import BaseModel
from embed import get_embedding
from memory import add_memory, search_memory
import requests
import re
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# -------- CORS --------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OLLAMA_GEN_URL = "http://localhost:11434/api/generate"
MATCH_LIMIT = 3

IRRELEVANT_PATTERNS = [
    r"\bcookie(s)?\b",
    r"\bprivacy policy\b",
    r"\bterms of service\b",
    r"\ball rights reserved\b",
    r"\bsubscribe\b",
    r"\bsign\s?in\b",
    r"\blog\s?in\b",
    r"\bsign\s?up\b",
    r"\bcreate account\b",
    r"\bmenu\b",
    r"\bnavigation\b",
    r"\bskip to content\b",
]

# -------- Request Models --------
class Page(BaseModel):
    url: str
    title: str
    content: str

class Query(BaseModel):
    query: str

class EmbedRequest(BaseModel):
    text: str


def _clean_text(text: str) -> str:
    text = (text or "").replace("\u00a0", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _split_sentences(text: str):
    if not text:
        return []
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


def _is_irrelevant_sentence(sentence: str) -> bool:
    s = sentence.lower().strip()
    if len(s) < 35:
        return True
    if sum(ch.isdigit() for ch in s) > len(s) * 0.35:
        return True
    for pattern in IRRELEVANT_PATTERNS:
        if re.search(pattern, s):
            return True
    return False


def _keyword_set(text: str):
    words = re.findall(r"[a-zA-Z]{3,}", (text or "").lower())
    stop = {
        "the", "and", "for", "that", "with", "this", "from", "you", "your",
        "are", "was", "were", "have", "has", "had", "into", "about", "they",
        "them", "their", "will", "would", "there", "what", "when", "where",
    }
    return {w for w in words if w not in stop}


def condense_content(title: str, content: str, max_chars: int = 1400) -> str:
    cleaned = _clean_text(content)
    if not cleaned:
        return ""

    sentences = _split_sentences(cleaned)
    if not sentences:
        return cleaned[:max_chars]

    title_terms = _keyword_set(title)
    doc_terms = _keyword_set(cleaned)

    scored = []
    for i, sentence in enumerate(sentences):
        if _is_irrelevant_sentence(sentence):
            continue

        sent_terms = _keyword_set(sentence)
        if not sent_terms:
            continue

        title_overlap = len(sent_terms & title_terms)
        doc_overlap = len(sent_terms & doc_terms)
        length_bonus = min(len(sentence), 220) / 220.0
        score = (title_overlap * 2.0) + (doc_overlap * 0.25) + length_bonus
        scored.append((score, i, sentence))

    if not scored:
        fallback = [s for s in sentences if len(s) >= 35][:8]
        text = " ".join(fallback) if fallback else cleaned
        return text[:max_chars]

    # Keep highest-signal sentences, then restore original order for readability.
    top = sorted(scored, key=lambda x: x[0], reverse=True)[:10]
    top_sorted = sorted(top, key=lambda x: x[1])

    out = []
    total = 0
    for _, _, sentence in top_sorted:
        if total + len(sentence) + 1 > max_chars:
            break
        out.append(sentence)
        total += len(sentence) + 1

    if not out:
        return top_sorted[0][2][:max_chars]
    return " ".join(out)


def rerank_results(query: str, candidates: list, top_k: int = 3) -> list:
    query_terms = _keyword_set(query)
    if not candidates:
        return []

    scored = []
    for item in candidates:
        title = item.get("title", "")
        content = item.get("content", "")
        semantic = float(item.get("semantic_score", 0.0))

        title_terms = _keyword_set(title)
        content_terms = _keyword_set(content)

        # Prefer items whose title/content share intent words with the query.
        title_overlap = len(query_terms & title_terms)
        content_overlap = len(query_terms & content_terms)
        has_exact_phrase = 1.0 if query.lower() in f"{title} {content}".lower() else 0.0

        lexical_score = (title_overlap * 0.5) + (content_overlap * 0.2) + has_exact_phrase
        final_score = (semantic * 0.7) + (lexical_score * 0.3)

        enriched = dict(item)
        enriched["score"] = round(final_score, 4)
        scored.append(enriched)

    scored.sort(key=lambda x: x.get("score", 0.0), reverse=True)
    return scored[:top_k]

# -------- Health Check --------
@app.get("/test")
def test():
    return {"message": "Backend connected!"}

# -------- Embed Endpoint --------
@app.post("/embed")
def embed(req: EmbedRequest):
    try:
        vector = get_embedding(req.text)
        return {"embedding": vector}
    except Exception as e:
        print("Embed Error:", e)
        return {"embedding": []}

# -------- Store Endpoint --------
@app.post("/store")
def store(page: Page):
    try:
        if not page.content.strip():
            return {"status": "empty content skipped"}

        condensed_content = condense_content(page.title, page.content)
        if not condensed_content:
            return {"status": "empty content skipped"}

        text_for_embedding = f"{page.title}\n\n{condensed_content}".strip()
        embedding = get_embedding(text_for_embedding)

        add_memory(embedding, {
            "url": page.url,
            "title": page.title,
            "content": condensed_content
        })

        return {"status": "stored"}

    except Exception as e:
        print("Store Error:", e)
        return {"status": "error"}

# -------- LLM Answer --------
def generate_answer(query, context):
    print("Generating answer with context length:", len(context))
    print("Query:", query)
    try:
        prompt = f"""
You are a smart personal memory assistant.

Use ONLY the context below to answer the question.

- Be concise (2-3 sentences)
- use contextual meaning of question and compare with context to find relevant info
- If answer is not found, say "I couldn't find anything relevant."

Context:
{context}

Question: {query}

Answer:
"""

        response = requests.post(
            OLLAMA_GEN_URL,
            json={
                "model": "qwen2.5:0.5b",
                "stream": False,
                "prompt": prompt
            },
            timeout=60
        )

        return response.json().get("response", "No response from model.")

    except Exception as e:
        print("LLM Error:", e)
        return "Error generating answer."

# -------- Query Endpoint --------
@app.post("/query")
def query(q: Query):
    try:
        query_vector = get_embedding(q.query)

        # Retrieve multiple nearest vectors and keep up to top-3 matches.
        candidates = search_memory(query_vector, k=MATCH_LIMIT)
        results = rerank_results(q.query, candidates, top_k=MATCH_LIMIT)

        if not results:
            return {
                "answer": "No memory found yet. Browse something first!",
                "sources": []
            }

        context = "\n\n".join([r["content"] for r in results])
        print("Context for LLM:", context[:500])  # print first 500 chars of context

        answer = generate_answer(q.query, context)

        # Clean sources (only send useful fields)
        sources = [
            {
                "url": r["url"],
                "title": r.get("title", "Untitled"),
                "score": r.get("score", 0.0),
                "semantic_score": r.get("semantic_score", 0.0)
            }
            for r in results
        ]

        return {
            "answer": answer.strip(),
            "sources": sources
        }

    except Exception as e:
        print("Query Error:", e)
        return {
            "answer": "Something went wrong.",
            "sources": []
        }