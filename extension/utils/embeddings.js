// Gemini Embedding API — https://ai.google.dev/api/embeddings
// Set API key: chrome.storage.local.set({ geminiApiKey: 'YOUR_KEY' }) (e.g. from DevTools on the service worker).

const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent`;
const MAX_INPUT_CHARS = 10000;
const FALLBACK_EMBED_DIM = 256;

async function getGeminiApiKey() {
  const stored = await chrome.storage.local.get(['geminiApiKey', 'GEMINI_API_KEY']);
  const key = (stored.geminiApiKey || stored.GEMINI_API_KEY || '').trim();
  return key || null;
}

/**
 * @param {string} text
 * @param {{ taskType?: string; title?: string }} [options]
 *   taskType: RETRIEVAL_DOCUMENT (default) or RETRIEVAL_QUERY for asymmetric search.
 *   title: optional document title; only used with RETRIEVAL_DOCUMENT (improves quality per API docs).
 * @returns {Promise<number[]>}
 */
export async function generateEmbedding(text, options = {}) {
  const trimmed = (text || '').slice(0, MAX_INPUT_CHARS);
  if (!trimmed.trim()) {
    throw new Error('[LocalMind] Cannot embed empty text');
  }

  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    console.warn('[LocalMind] Gemini API key missing. Using local fallback embedding.');
    return generateLocalFallbackEmbedding(trimmed);
  }

  const taskType = options.taskType || 'RETRIEVAL_DOCUMENT';
  const body = {
    model: `models/${GEMINI_EMBED_MODEL}`,
    content: { parts: [{ text: trimmed }] },
    taskType,
  };
  if (options.title && taskType === 'RETRIEVAL_DOCUMENT') {
    body.title = options.title.slice(0, 512);
  }

  try {
    const res = await fetch(EMBED_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`[LocalMind] Gemini embedContent failed ${res.status}: ${detail.slice(0, 500)}`);
    }

    const data = await res.json();
    const values = data.embedding?.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error('[LocalMind] Gemini embedContent: missing embedding.values in response');
    }
    return values;
  } catch (err) {
    console.warn('[LocalMind] Gemini embedding failed. Using local fallback embedding.', err);
    return generateLocalFallbackEmbedding(trimmed);
  }
}

function generateLocalFallbackEmbedding(text) {
  const vec = new Array(FALLBACK_EMBED_DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];

  for (const token of tokens) {
    const h = fnv1a32(token);
    const idx = h % FALLBACK_EMBED_DIM;
    vec[idx] += 1;
  }

  // L2 normalization keeps cosine similarity stable across document sizes.
  let norm = 0;
  for (let i = 0; i < vec.length; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i += 1) vec[i] = vec[i] / norm;
  }
  return vec;
}

function fnv1a32(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
