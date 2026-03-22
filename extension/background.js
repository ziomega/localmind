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
const BACKEND_STORE_URL = 'http://127.0.0.1:8000/store';
const BOOKMARK_RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BOOKMARK_FETCH_TIMEOUT_MS = 5000;

// ── Keyboard shortcut: open memory sidebar ────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-sidebar') return;
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    const wid = win?.id;
    if (wid != null) await chrome.sidePanel.open({ windowId: wid });
  } catch (err) {
    console.warn('[LocalMind] Shortcut open-sidebar failed:', err);
  }
});

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
      return { results: await handleSearch(message.query, message.sourceFilter || 'all') };

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

    case 'CLEAR_MEMORY': {
    const allData = await chrome.storage.local.get(null);
    const now = Date.now();

    const cutoff = {
        hour: now - 60 * 60 * 1000,
        day:  now - 24 * 60 * 60 * 1000,
        all:  0,
    }[message.range || 'all'];

    const pageKeys = Object.keys(allData).filter(k => {
        if (!k.startsWith('page_')) return false;
        if (message.range === 'all') return true;
        return (allData[k].timestamp || 0) >= cutoff;
    });

    await chrome.storage.local.remove(pageKeys);

    if (message.range === 'all') {
        await chrome.storage.session.clear();
        await chrome.action.setBadgeText({ text: '' });
        await chrome.action.setTitle({ title: 'Open Local Mind' });
    }

    return { ok: true };
    }

    case 'DELETE_PAGE': {
    const key = 'page_' + btoa(encodeURIComponent(message.url)).replace(/[^a-z0-9]/gi, '').slice(0, 40);
    await chrome.storage.local.remove(key);
    return { ok: true };
    }

    default:
    return { error: 'Unknown message type' };
    }
}

// ── Indexing ──────────────────────────────────────────────────────────────────

async function indexPage({ url, title, text, timestamp }) {
  if (!url) return;
  const key = urlToKey(url);
  const existing = await chrome.storage.local.get(key);
  if (existing[key]) {
    const age = Date.now() - existing[key].timestamp;
    if (age < 24 * 60 * 60 * 1000) return;
  }

  console.log('[LocalMind] Indexing:', title);
  const embedding = await generateEmbedding(text, {
    taskType: 'RETRIEVAL_DOCUMENT',
    title: title || undefined,
  });

  await savePageToMemory({
    url, title,
    text: text.slice(0, 500),
    embedding,
    timestamp,
    domain: new URL(url).hostname,
    sourceType: 'website',
    category: 'Visited Website',
  });

  await sendToBackendStore({
    url,
    title: title || url,
    content: text.slice(0, 2000),
  });
}

// ── Search ────────────────────────────────────────────────────────────────────

async function handleSearch(query, sourceFilter = 'all') {
  if (!query || query.trim().length < 2) return [];
  const queryEmbedding = await generateEmbedding(query, { taskType: 'RETRIEVAL_QUERY' });
  return await searchMemory({ queryEmbedding, queryText: query, topK: 20, sourceFilter });
}

function urlToKey(url) {
  return 'page_' + btoa(encodeURIComponent(url))    .replace(/[^a-z0-9]/gi, '').slice(0, 40);
}

function bookmarkIdToKey(bookmarkId) {
  return 'bookmark_' + bookmarkId;
}

function categorizeBookmark(bookmark, folderPath) {
  const name = `${bookmark.title || ''} ${folderPath || ''}`.toLowerCase();
  if (name.includes('work') || name.includes('project') || name.includes('docs')) return 'Work';
  if (name.includes('learn') || name.includes('course') || name.includes('tutorial')) return 'Learning';
  if (name.includes('news') || name.includes('blog')) return 'News';
  if (name.includes('shop') || name.includes('buy') || name.includes('deal')) return 'Shopping';
  return 'General';
}

function normalizeBookmarkText({ title, url, folderPath, category }) {
  return `Bookmark title: ${title || 'Untitled'}.
Bookmark url: ${url}
Bookmark folder: ${folderPath || 'Root'}
Bookmark category: ${category}`.replace(/\s+/g, ' ').trim();
}

function storageKeyForStableId(stableId) {
  return 'page_' + btoa(encodeURIComponent(stableId)).replace(/[^a-z0-9]/gi, '').slice(0, 40);
}

function stripHtmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchBookmarkPageText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BOOKMARK_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return '';
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html')) return '';
    const html = await res.text();
    return stripHtmlToText(html).slice(0, 4000);
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

async function sendToBackendStore({ url, title, content }) {
  try {
    await fetch(BACKEND_STORE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title, content }),
    });
  } catch (err) {
    console.warn('[LocalMind] Failed to sync memory to backend:', err);
  }
}

function collectBookmarksWithPath(nodes, parentPath = '') {
  const out = [];
  for (const node of nodes || []) {
    const thisPath = node.title ? `${parentPath}/${node.title}` : parentPath;
    if (node.url) out.push({ ...node, folderPath: thisPath || 'Root' });
    if (node.children?.length) out.push(...collectBookmarksWithPath(node.children, thisPath));
  }
  return out;
}

async function indexBookmark(bookmark, folderPath = 'Root') {
  if (!bookmark?.url) return;
  let hostname = '';
  try {
    hostname = new URL(bookmark.url).hostname;
  } catch {
    return;
  }

  const category = categorizeBookmark(bookmark, folderPath);
  const memoryId = bookmarkIdToKey(bookmark.id);
  const storageKey = storageKeyForStableId(memoryId);
  const existing = await chrome.storage.local.get(storageKey);
  const existingRecord = existing[storageKey];
  const shouldRefreshRemoteContent =
    !existingRecord?.fetchedContent ||
    (Date.now() - (existingRecord?.contentFetchedAt || 0)) > BOOKMARK_RESYNC_INTERVAL_MS;

  let fetchedContent = existingRecord?.fetchedContent || '';
  if (shouldRefreshRemoteContent) {
    fetchedContent = await fetchBookmarkPageText(bookmark.url);
  }

  const baseText = normalizeBookmarkText({
    title: bookmark.title,
    url: bookmark.url,
    folderPath,
    category,
  });
  const text = fetchedContent
    ? `${baseText}\n\nPage content snapshot: ${fetchedContent}`.slice(0, 5000)
    : baseText;

  const embedding = await generateEmbedding(text, {
    taskType: 'RETRIEVAL_DOCUMENT',
    title: bookmark.title || undefined,
  });
  await savePageToMemory({
    memoryId,
    url: bookmark.url,
    title: bookmark.title || bookmark.url,
    text,
    embedding,
    timestamp: Date.now(),
    domain: hostname,
    sourceType: 'bookmark',
    category,
    bookmarkFolder: folderPath,
    fetchedContent,
    contentFetchedAt: Date.now(),
  });

  await sendToBackendStore({
    url: bookmark.url,
    title: `${bookmark.title || bookmark.url} [Bookmark]`,
    content: text,
  });
}

async function getBookmarkFolderPath(bookmark) {
  if (!bookmark?.parentId) return 'Root';
  const parts = [];
  let currentId = bookmark.parentId;
  while (currentId) {
    const nodes = await chrome.bookmarks.get(currentId);
    const node = nodes?.[0];
    if (!node) break;
    if (node.title) parts.unshift(node.title);
    if (!node.parentId || node.id === '0') break;
    currentId = node.parentId;
  }
  return parts.length ? `/${parts.join('/')}` : 'Root';
}

async function syncAllBookmarks() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const bookmarks = collectBookmarksWithPath(tree);
    for (const bookmark of bookmarks) {
      await indexBookmark(bookmark, bookmark.folderPath || 'Root');
    }
  } catch (err) {
    console.warn('[LocalMind] Bookmark sync failed:', err);
  }
}

// ── History sync on install ───────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  console.log('[LocalMind] Installed. Syncing recent history...');
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const historyItems = chrome.history?.search
    ? await chrome.history.search({
        text: '', startTime: oneWeekAgo, maxResults: 200,
      })
    : [];

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

  await syncAllBookmarks();
});

chrome.bookmarks.onCreated.addListener(async (_id, bookmark) => {
  const folderPath = await getBookmarkFolderPath(bookmark);
  await indexBookmark(bookmark, folderPath);
});

chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  try {
    const [bookmark] = await chrome.bookmarks.get(id);
    if (!bookmark?.url) return;
    const folderPath = await getBookmarkFolderPath(bookmark);
    await indexBookmark({
      ...bookmark,
      title: changeInfo.title || bookmark.title,
      url: changeInfo.url || bookmark.url,
    }, folderPath);
  } catch (err) {
    console.warn('[LocalMind] Bookmark update sync failed:', err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await syncAllBookmarks();
});