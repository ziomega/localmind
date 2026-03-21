const PAGE_PREFIX = 'page_';
const MAX_STORED_PAGES = 2000;

export async function savePageToMemory(record) {
  const key = PAGE_PREFIX + btoa(encodeURIComponent(record.url)).replace(/[^a-z0-9]/gi, '').slice(0, 40);
  await chrome.storage.local.set({ [key]: record });
  await pruneIfNeeded();
}

export async function getRecentPages(limit = 20) {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(PAGE_PREFIX))
    .map(([, v]) => v)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

export async function searchMemory({ queryEmbedding, queryText, topK = 10 }) {
  const all = await chrome.storage.local.get(null);
  const pages = Object.entries(all)
    .filter(([k]) => k.startsWith(PAGE_PREFIX))
    .map(([, v]) => v)
    .filter(p => p.title || p.text);

  const withScores = pages.map(page => {
    let score = 0;

    if (page.embedding && queryEmbedding && page.embedding.length === queryEmbedding.length) {
      score += cosineSimilarity(page.embedding, queryEmbedding) * 0.7;
    }

    const lq = queryText.toLowerCase();
    if ((page.title || '').toLowerCase().includes(lq)) score += 0.3;
    if ((page.text || '').toLowerCase().includes(lq)) score += 0.15;

    const ageDays = (Date.now() - page.timestamp) / (1000 * 60 * 60 * 24);
    score += Math.max(0, (7 - ageDays) / 7) * 0.1;

    return { ...page, score };
  });

  return withScores
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

async function pruneIfNeeded() {
  const all = await chrome.storage.local.get(null);
  const pageKeys = Object.keys(all)
    .filter(k => k.startsWith(PAGE_PREFIX))
    .map(k => ({ key: k, timestamp: all[k].timestamp || 0 }))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (pageKeys.length > MAX_STORED_PAGES) {
    const toDelete = pageKeys.slice(0, pageKeys.length - MAX_STORED_PAGES).map(p => p.key);
    await chrome.storage.local.remove(toDelete);
  }
}

export async function deletePageFromMemory(url) {
  const key = PAGE_PREFIX + btoa(encodeURIComponent(url)).replace(/[^a-z0-9]/gi, '').slice(0, 40);
  await chrome.storage.local.remove(key);
}