from fastapi import FastAPI
from pydantic import BaseModel
from embed import get_embedding
from memory import add_memory, search_memory, get_all_memories
import requests
import re
import random
from collections import Counter
from datetime import datetime
from urllib.parse import urlparse
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


class ChatRequest(BaseModel):
    message: str


STOP_WORDS = {
    "this", "that", "with", "from", "have", "were", "will", "your", "about", "which",
    "when", "where", "what", "into", "than", "then", "them", "they", "been", "also",
    "more", "some", "such", "only", "over", "very", "into", "onto", "just", "page",
    "home", "news", "today", "latest", "search", "google", "wikipedia", "chess", "world",
}


MIKE_OPENERS = [
    "Quick read from your history:",
    "Here is the cleanest play:",
    "Straight answer, no fluff:",
    "You are looking at this pattern:",
]

MIKE_MEMORY_FLEX = [
    "Photographic memory check complete.",
    "Memory scan locked in.",
    "Pattern match confirmed from your browsing trail.",
    "Timeline and content alignment confirmed.",
]

MIKE_FAST_LINES = [
    "Fast lane answer:",
    "No need to overthink this:",
    "Quick pull from your trail:",
    "Clean read, right away:",
]


def _parse_event_datetime(item: dict):
    visited_at = item.get("visited_at")
    if visited_at:
        try:
            return datetime.fromisoformat(str(visited_at).replace("Z", "+00:00"))
        except Exception:
            pass

    ts = item.get("timestamp")
    if ts is not None:
        try:
            tsf = float(ts)
            if tsf > 1e12:
                tsf /= 1000.0
            return datetime.fromtimestamp(tsf)
        except Exception:
            pass

    visited_date = item.get("visited_date")
    if visited_date:
        try:
            return datetime.fromisoformat(str(visited_date))
        except Exception:
            pass

    return None


def _event_sort_ts(item: dict) -> float:
    dt = _parse_event_datetime(item)
    if dt is not None:
        try:
            return float(dt.timestamp())
        except Exception:
            pass
    ts = item.get("timestamp")
    try:
        tsf = float(ts)
        if tsf > 1e12:
            tsf /= 1000.0
        return tsf
    except Exception:
        return 0.0


def _extract_domain(url: str) -> str:
    if not url:
        return "unknown"
    try:
        parsed = urlparse(url)
        return parsed.netloc or "unknown"
    except Exception:
        return "unknown"


def _extract_keywords(text: str) -> list:
    words = re.findall(r"[a-zA-Z]{4,}", (text or "").lower())
    return [w for w in words if w not in STOP_WORDS]


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


def rerank_results(query: str, candidates: list, top_k: int = 3, min_score: float = 0.10) -> list:
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
    return [r for r in scored[:top_k] if r.get("score", 0.0) >= min_score]

# -------- Health Check --------
@app.get("/test")
def test():
    return {"message": "Backend connected!"}


@app.get("/analytics")
def analytics(limit: int = 1000):
    records = get_all_memories()
    if limit > 0:
        records = records[-limit:]

    domain_counter = Counter()
    date_counter = Counter()
    hour_counter = Counter()
    keyword_counter = Counter()
    url_counter = Counter()
    total_content_chars = 0
    total_time_spent_ms = 0
    records_with_time_spent = 0
    enriched = []

    for i, item in enumerate(records):
        url = item.get("url", "")
        title = item.get("title", "Untitled")
        content = item.get("content", "")
        domain = _extract_domain(url)
        dt = _parse_event_datetime(item)
        visited_at = dt.isoformat() if dt else None
        visited_date = dt.date().isoformat() if dt else item.get("visited_date")

        time_spent_ms = item.get("time_spent_ms")
        try:
            time_spent_ms = int(time_spent_ms) if time_spent_ms is not None else None
        except Exception:
            time_spent_ms = None

        domain_counter[domain] += 1
        url_counter[url] += 1
        if visited_date:
            date_counter[str(visited_date)] += 1
        if dt:
            hour_counter[dt.hour] += 1

        total_content_chars += len(content or "")
        if time_spent_ms and time_spent_ms > 0:
            total_time_spent_ms += time_spent_ms
            records_with_time_spent += 1

        for kw in _extract_keywords(f"{title} {content[:500]}"):
            keyword_counter[kw] += 1

        enriched.append({
            "id": i + 1,
            "url": url,
            "title": title,
            "domain": domain,
            "visited_at": visited_at,
            "visited_date": visited_date,
            "hour": dt.hour if dt else None,
            "time_spent_ms": time_spent_ms,
            "content_length": len(content or ""),
            "snippet": (content or "")[:240],
        })

    unique_urls = len({r.get("url") for r in records if r.get("url")})
    unique_domains = len(domain_counter)
    duplicate_urls = sum(1 for _, c in url_counter.items() if c > 1)

    top_domains = [
        {"domain": d, "count": c}
        for d, c in domain_counter.most_common(12)
    ]
    top_keywords = [
        {"keyword": k, "count": c}
        for k, c in keyword_counter.most_common(20)
    ]
    visits_by_date = [
        {"date": d, "count": date_counter[d]}
        for d in sorted(date_counter.keys())
    ]
    visits_by_hour = [
        {"hour": h, "count": hour_counter.get(h, 0)}
        for h in range(24)
    ]

    summary = {
        "total_records": len(records),
        "unique_urls": unique_urls,
        "unique_domains": unique_domains,
        "duplicate_urls": duplicate_urls,
        "avg_content_length": round((total_content_chars / len(records)), 1) if records else 0,
        "total_time_spent_ms": total_time_spent_ms,
        "records_with_time_spent": records_with_time_spent,
    }

    return {
        "summary": summary,
        "top_domains": top_domains,
        "top_keywords": top_keywords,
        "visits_by_date": visits_by_date,
        "visits_by_hour": visits_by_hour,
        "records": list(reversed(enriched)),
    }

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


def _format_chat_context_item(item: dict) -> str:
    title = item.get("title", "Untitled")
    url = item.get("url", "")
    domain = _extract_domain(url)
    dt = _parse_event_datetime(item)
    visited_at = dt.isoformat() if dt else (item.get("visited_at") or item.get("visited_date") or "unknown")
    time_spent_ms = item.get("time_spent_ms")
    try:
        time_spent_label = f"{int(time_spent_ms) // 1000}s" if time_spent_ms is not None else "unknown"
    except Exception:
        time_spent_label = "unknown"
    content = _clean_text(item.get("content", ""))[:700]
    return (
        f"Title: {title}\n"
        f"URL: {url}\n"
        f"Domain: {domain}\n"
        f"Visited: {visited_at}\n"
        f"Time Spent: {time_spent_label}\n"
        f"Content: {content}"
    )


def _chat_sources_from_results(results: list) -> list:
    sources = []
    seen = set()
    for r in results:
        key = (r.get("url", ""), r.get("title", ""))
        if key in seen:
            continue
        seen.add(key)
        sources.append({
            "title": r.get("title", "Untitled"),
            "url": r.get("url", ""),
            "domain": _extract_domain(r.get("url", "")),
            "score": r.get("score", r.get("semantic_score", 0.0)),
        })
    return sources


def _query_variants_for_chat(message: str) -> list:
    cleaned = _clean_text(message)
    if not cleaned:
        return []

    variants = [cleaned]
    terms = re.findall(r"[a-zA-Z]{3,}", cleaned.lower())
    if len(terms) >= 2:
        variants.append(" ".join(terms[: min(6, len(terms))]))
    if len(terms) >= 3:
        variants.append(" ".join(terms[-min(5, len(terms)) :]))

    deduped = []
    seen = set()
    for v in variants:
        key = v.strip().lower()
        if key and key not in seen:
            deduped.append(v)
            seen.add(key)
    return deduped[:3]


def _extract_time_intent(message: str) -> str:
    m = (message or "").lower()
    if "today" in m:
        return "today"
    if "yesterday" in m:
        return "yesterday"
    if "this week" in m or "last 7 days" in m:
        return "week"
    return ""


def _is_metadata_query(message: str) -> bool:
    m = (message or "").lower()
    probes = [
        "when", "date", "visited", "visit", "time", "spent", "how long",
        "last", "first", "timeline", "history", "day", "today", "yesterday",
    ]
    return any(p in m for p in probes)


def _apply_time_intent_filter(items: list, intent: str) -> list:
    if not intent:
        return items

    now = datetime.now()
    if intent == "today":
        target = now.date()
        return [i for i in items if (_parse_event_datetime(i) and _parse_event_datetime(i).date() == target)]
    if intent == "yesterday":
        target = now.date().fromordinal(now.date().toordinal() - 1)
        return [i for i in items if (_parse_event_datetime(i) and _parse_event_datetime(i).date() == target)]
    if intent == "week":
        min_date = now.date().fromordinal(now.date().toordinal() - 6)
        return [i for i in items if (_parse_event_datetime(i) and _parse_event_datetime(i).date() >= min_date)]
    return items


def _is_simple_chat_query(message: str) -> bool:
    m = (message or "").strip().lower()
    if not m:
        return True

    greeting = {"hi", "hello", "hey", "yo", "sup", "hii", "heyy"}
    if m in greeting:
        return True

    quick_patterns = [
        r"\bhelp\b",
        r"\bwhat can you do\b",
        r"\bhow many\b",
        r"\btotal records\b",
        r"\btotal domains\b",
        r"\btoday\b",
        r"\byesterday\b",
        r"\blast 7 days\b",
        r"\bthis week\b",
        r"\brecent\b",
        r"\blatest\b",
    ]
    if any(re.search(p, m) for p in quick_patterns):
        return True

    return len(m.split()) <= 4


def _format_brief_items(items: list, limit: int = 3) -> str:
    lines = []
    for i, item in enumerate(items[:limit], start=1):
        title = item.get("title", "Untitled")
        domain = _extract_domain(item.get("url", ""))
        dt = _parse_event_datetime(item)
        when = dt.strftime("%Y-%m-%d %H:%M") if dt else "unknown time"
        lines.append(f"{i}. {title} ({domain}) on {when}")
    return "\n".join(lines)


def _simple_chat_reply(message: str) -> tuple[str, list]:
    m = (message or "").strip().lower()
    all_records = get_all_memories()
    recent = sorted(all_records, key=_event_sort_ts, reverse=True)

    opener = random.choice(MIKE_FAST_LINES)

    if m in {"", "hi", "hello", "hey", "yo", "sup", "hii", "heyy"}:
        reply = (
            f"{opener} You can ask about what you read, when you visited it, and how long you stayed. "
            "Try: 'what did you visit today' or 'show recent chess pages'."
        )
        return reply, []

    if "help" in m or "what can you do" in m:
        reply = (
            f"{opener} You can get source-backed answers for content, timeline, domains, and time spent. "
            "Ask things like: 'what did you read yesterday', 'which domain did you visit most', or 'how long on chess.com'."
        )
        return reply, []

    if "how many" in m or "total records" in m or "total domains" in m:
        unique_domains = len({_extract_domain(i.get("url", "")) for i in all_records if i.get("url")})
        reply = (
            f"{opener} You currently have {len(all_records)} records across {unique_domains} domains. "
            f"{random.choice(MIKE_MEMORY_FLEX)}"
        )
        return reply, []

    time_intent = _extract_time_intent(m)
    if time_intent:
        scoped = _apply_time_intent_filter(recent, time_intent)
        if not scoped:
            return f"{opener} No matching visits found for that time window yet.", []
        brief = _format_brief_items(scoped, limit=4)
        reply = f"{opener} Here are your top matches for {time_intent}:\n{brief}\n{random.choice(MIKE_MEMORY_FLEX)}"
        return reply, scoped[:5]

    if "recent" in m or "latest" in m:
        if not recent:
            return f"{opener} No recent records found yet.", []
        brief = _format_brief_items(recent, limit=4)
        reply = f"{opener} Most recent history hits:\n{brief}"
        return reply, recent[:5]

    return "", []


def retrieve_chat_candidates(user_message: str, per_query_k: int = 14) -> list:
    variants = _query_variants_for_chat(user_message)
    pooled = []
    for v in variants:
        qv = get_embedding(v)
        pooled.extend(search_memory(qv, k=per_query_k))

    # Keep best item per URL+title using semantic score.
    best = {}
    for item in pooled:
        key = (item.get("url", ""), item.get("title", ""))
        prev = best.get(key)
        if prev is None or float(item.get("semantic_score", 0.0)) > float(prev.get("semantic_score", 0.0)):
            best[key] = item

    candidates = list(best.values())

    # For timeline/visit-intent questions, blend in recent records so date answers stay reliable.
    if _is_metadata_query(user_message):
        all_records = get_all_memories()
        recent = sorted(
            all_records,
            key=_event_sort_ts,
            reverse=True,
        )[:25]
        for item in recent:
            key = (item.get("url", ""), item.get("title", ""))
            if key not in best:
                boosted = dict(item)
                boosted["semantic_score"] = max(float(boosted.get("semantic_score", 0.0)), 0.08)
                best[key] = boosted
        candidates = list(best.values())

    candidates = rerank_results(user_message, candidates, top_k=10)

    intent = _extract_time_intent(user_message)
    if intent:
        filtered = _apply_time_intent_filter(candidates, intent)
        if filtered:
            return filtered[:8]

    return candidates[:8]


def generate_history_chat_answer(user_message: str, context_items: list) -> str:
    if not context_items:
        return "I checked your history and found no strong matches yet. Give me a more specific clue like site name, topic, or time window."

    context_block = "\n\n".join(_format_chat_context_item(item) for item in context_items[:8])

    prompt = f"""
You are Mike Ross, a sharp personal history assistant with fast legal-room confidence.
Style:
- concise, confident, practical
- natural conversation tone (not robotic)
- witty and human, but not theatrical
- 4-8 short sentences
- explicitly reference where information came from (site/title)
- do not invent facts beyond context
- synthesize across multiple records when useful
- write in second-person guidance using "you" and "your"
- avoid first-person voice (do not use: I, me, my, mine, I've, I'll)
- do not quote or reproduce copyrighted TV dialogue

Task:
Answer the user based only on the browsing history context below.
If the answer is weak/partial, say what is missing and suggest a better follow-up query.
When possible, include timeline cues (today/yesterday/date) from the provided context.
If asked about date visited, when, or time spent, include explicit fields like Visited and Time Spent from matching records.
If multiple records match, rank the top 2-4 and state the most likely match first.

Browsing History Context:
{context_block}

User Message:
{user_message}

Mike Ross:
"""

    try:
        response = requests.post(
            OLLAMA_GEN_URL,
            json={
                "model": "qwen2.5:0.5b",
                "stream": False,
                "prompt": prompt,
            },
            timeout=60,
        )
        raw = response.json().get("response", "History was retrieved, but a response could not be generated right now.").strip()
        voiced = _normalize_mike_voice(raw)
        return _add_mike_flair(voiced, user_message)
    except Exception as e:
        print("Chat LLM Error:", e)
        top = context_items[:3]
        bullets = []
        for i, item in enumerate(top, start=1):
            bullets.append(f"{i}. {item.get('title', 'Untitled')} ({_extract_domain(item.get('url', ''))})")
        if not bullets:
            return "I found related history, but the response model is unavailable right now."
        return (
            "I found relevant items in your history. Here are the strongest matches right now:\n"
            + "\n".join(bullets)
            + "\nAsk me to narrow this by date, domain, or a specific detail."
        )


@app.post("/chat-history")
def chat_history(req: ChatRequest):
    try:
        message = (req.message or "").strip()
        if len(message) < 2:
            return {
                "bot": "Mike Ross",
                "reply": "Ask me anything about what you've read. I can trace pages, topics, and patterns from your history.",
                "sources": [],
            }

        # Bypass LLM for simple asks to keep chat fast and stable.
        if _is_simple_chat_query(message):
            fast_reply, fast_items = _simple_chat_reply(message)
            if fast_reply:
                return {
                    "bot": "Mike Ross",
                    "reply": fast_reply,
                    "sources": _chat_sources_from_results(fast_items),
                }

        ranked = retrieve_chat_candidates(message, per_query_k=14)

        reply = generate_history_chat_answer(message, ranked)
        sources = _chat_sources_from_results(ranked)

        return {
            "bot": "Mike Ross",
            "reply": reply,
            "sources": sources,
        }
    except Exception as e:
        print("Chat History Error:", e)
        return {
            "bot": "Mike Ross",
            "reply": "Something went wrong while reading your history. Try again in a moment.",
            "sources": [],
        }


def _normalize_mike_voice(text: str) -> str:
    if not text:
        return text
    out = text
    replacements = [
        (r"\bI'm\b", "You are"),
        (r"\bI am\b", "You are"),
        (r"\bI've\b", "You have"),
        (r"\bI'll\b", "You will"),
        (r"\bI'd\b", "You would"),
        (r"\bmy\b", "your"),
        (r"\bmine\b", "yours"),
        (r"\bme\b", "you"),
        (r"\bI\b", "You"),
    ]
    for pattern, replacement in replacements:
        out = re.sub(pattern, replacement, out)

    # Keep responses in the assistant persona even if model prepends labels.
    out = re.sub(r"^\s*(assistant|mike ross)\s*:\s*", "", out, flags=re.IGNORECASE)
    return out


def _add_mike_flair(text: str, user_message: str) -> str:
    if not text:
        return text

    trimmed = text.strip()
    lower = trimmed.lower()

    # Add occasional opening cadence so responses feel less templated.
    if random.random() < 0.45 and not lower.startswith(("quick read", "here is", "straight answer", "you are looking")):
        trimmed = f"{random.choice(MIKE_OPENERS)} {trimmed}"

    # Add occasional memory-flex line, especially for timeline/time/date questions.
    needs_memory_flex = _is_metadata_query(user_message) or any(k in lower for k in ["visited", "date", "time", "timeline"])
    if needs_memory_flex and random.random() < 0.55:
        if trimmed.endswith((".", "!", "?")):
            trimmed = f"{trimmed} {random.choice(MIKE_MEMORY_FLEX)}"
        else:
            trimmed = f"{trimmed}. {random.choice(MIKE_MEMORY_FLEX)}"

    return trimmed

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