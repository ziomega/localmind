import { savePageToMemory, searchMemory, getRecentPages } from './utils/storage.js';
import { generateEmbedding } from './utils/embeddings.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    console.error('[LocalMind BG]', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'PAGE_CONTENT':
      await indexPage(message);
      return { ok: true };

    case 'SEARCH_QUERY':
      return { results: await handleSearch(message.query) };

    case 'GET_RECENT':
      return { pages: await getRecentPages(message.limit || 20) };

    case 'OPEN_SIDEBAR':
      chrome.sidePanel.open({ tabId: message.tabId });
      return { ok: true };

    default:
      return { error: 'Unknown message type' };
  }
}

async function indexPage({ url, title, text, timestamp }) {
  const key = urlToKey(url);
  const existing = await chrome.storage.local.get(key);
  if (existing[key]) {
    const age = Date.now() - existing[key].timestamp;
    if (age < 24 * 60 * 60 * 1000) return;
  }

  console.log('[LocalMind] Indexing:', title);
  const embedding = await generateEmbedding(text);

  await savePageToMemory({
    url, title,
    text: text.slice(0, 500),
    embedding,
    timestamp,
    domain: new URL(url).hostname,
  });
}

async function handleSearch(query) {
  if (!query || query.trim().length < 2) return [];
  const queryEmbedding = await generateEmbedding(query);
  return await searchMemory({ queryEmbedding, queryText: query, topK: 10 });
}

function urlToKey(url) {
  return 'page_' + btoa(encodeURIComponent(url)).replace(/[^a-z0-9]/gi, '').slice(0, 40);
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[LocalMind] Installed. Syncing recent history...');
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const historyItems = await chrome.history.search({
    text: '', startTime: oneWeekAgo, maxResults: 200,
  });

  for (const item of historyItems) {
    const key = urlToKey(item.url);
    const existing = await chrome.storage.local.get(key);
    if (!existing[key]) {
      await chrome.storage.local.set({
        [key]: {
          url: item.url,
          title: item.title || item.url,
          text: '',
          embedding: null,
          timestamp: item.lastVisitTime,
          domain: new URL(item.url).hostname,
          fromHistory: true,
        }
      });
    }
  }
});
