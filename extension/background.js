import { savePageToMemory, searchMemory, getRecentPages } from './utils/storage.js';
import { generateEmbedding } from './utils/embeddings.js';

// ── Search engine URL patterns ────────────────────────────────────────────────

const SEARCH_ENGINES = [
  { hostname: 'www.google.com',     param: 'q',      path: '/search' },
  { hostname: 'www.bing.com',       param: 'q',      path: '/search' },
  { hostname: 'duckduckgo.com',     param: 'q',      path: '/'       },
  { hostname: 'search.yahoo.com',   param: 'p',      path: '/search' },
  { hostname: 'search.brave.com',   param: 'q',      path: '/search' },
];

// ── Open sidebar when extension icon is clicked ───────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: 'Open Local Mind' });
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// ── Auto-enable sidebar on search engine pages ────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.url) return;

  const query = extractSearchQuery(tab.url);

  if (query) {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'sidebar/sidebar.html',
      enabled: true,
    });

    await chrome.storage.session.set({
      pendingQuery: query,
      pendingTabId: tabId,
    });

  } else {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'sidebar/sidebar.html',
      enabled: true,
    });
  }
});

// ── Extract search query from URL ─────────────────────────────────────────────

function extractSearchQuery(url) {
  try {
    const u = new URL(url);
    const engine = SEARCH_ENGINES.find(e => e.hostname === u.hostname);
    if (!engine) return null;
    if (!u.pathname.startsWith(engine.path)) return null;
    const q = u.searchParams.get(engine.param);
    return q && q.trim().length > 0 ? q.trim() : null;
  } catch {
    return null;
  }
}

// ── Message Router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    console.error('[LocalMind BG]', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {

    case 'OPEN_SIDEBAR_WITH_QUERY': {
      await chrome.storage.session.set({ pendingQuery: message.query });
      await chrome.action.setBadgeText({ text: '●' });
      await chrome.action.setBadgeBackgroundColor({ color: '#7c6af7' });
      await chrome.action.setTitle({ title: 'Local Mind — click to see memory results' });
      return { ok: true };
    }

    case 'PAGE_CONTENT':
      await indexPage(message);
      return { ok: true };

    case 'SEARCH_QUERY':
      return { results: await handleSearch(message.query) };

    case 'GET_RECENT':
      return { pages: await getRecentPages(message.limit || 20) };

    case 'GET_PENDING_QUERY': {
      const data = await chrome.storage.session.get(['pendingQuery', 'pendingTabId']);
      if (data.pendingQuery) {
        await chrome.storage.session.remove(['pendingQuery', 'pendingTabId']);
        return { query: data.pendingQuery };
      }
      return { query: null };
    }

    default:
      return { error: 'Unknown message type' };
  }
}

// ── Indexing ──────────────────────────────────────────────────────────────────

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

// ── Search ────────────────────────────────────────────────────────────────────

async function handleSearch(query) {
  if (!query || query.trim().length < 2) return [];
  const queryEmbedding = await generateEmbedding(query);
  return await searchMemory({ queryEmbedding, queryText: query, topK: 10 });
}

function urlToKey(url) {
  return 'page_' + btoa(encodeURIComponent(url)).replace(/[^a-z0-9]/gi, '').slice(0, 40);
}

// ── History sync on install ───────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  console.log('[LocalMind] Installed. Syncing recent history...');
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const historyItems = await chrome.history.search({
    text: '', startTime: oneWeekAgo, maxResults: 200,
  });

  for (const item of historyItems) {
    if (!item.url) continue;
    const key = urlToKey(item.url);
    const existing = await chrome.storage.local.get(key);
    if (!existing[key]) {
      try {
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
      } catch (e) { /* skip invalid URLs */ }
    }
  }
});