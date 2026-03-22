// sidebar.js — Local Mind Sidebar UI Logic

const searchInput = document.getElementById('searchInput');
const searchSpinner = document.getElementById('searchSpinner');
const timelineSection = document.getElementById('timelineSection');
const resultsSection = document.getElementById('resultsSection');
const emptyState = document.getElementById('emptyState');
const timelineList = document.getElementById('timelineList');
const resultsList = document.getElementById('resultsList');
const resultsLabel = document.getElementById('resultsLabel');
const clearBtn = document.getElementById('clearSearch');
const indexedCount = document.getElementById('indexedCount');
const exampleQueries = document.getElementById('exampleQueries');
const sourceFilters = document.getElementById('sourceFilters');
const sourceFilterButtons = Array.from(document.querySelectorAll('.source-chip'));

let refreshTimeout = null;
let activeSourceFilter = 'all';

// let searchTimeout = null;
const themeToggle = document.getElementById('themeToggle');
const copyToast = document.getElementById('copyToast');
const queryAnswer = document.getElementById('queryAnswer');

let searchTimeout = null;
let activeDropdown = null;
/** True only when the current search text came from GET_PENDING_QUERY (SERP auto-fill). */
let searchFromAutoSerp = false;

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.classList.add('light');
    themeToggle.textContent = '☀️';
  } else {
    document.documentElement.classList.remove('light');
    themeToggle.textContent = '🌙';
  }
}

async function initTheme() {
  let theme = 'dark';
  try {
    const { lmTheme } = await chrome.storage.local.get('lmTheme');
    if (lmTheme === 'light' || lmTheme === 'dark') theme = lmTheme;
    else {
      const legacy = localStorage.getItem('lm-theme');
      if (legacy === 'light' || legacy === 'dark') theme = legacy;
    }
  } catch (_) {
    const legacy = localStorage.getItem('lm-theme');
    if (legacy === 'light' || legacy === 'dark') theme = legacy;
  }
  localStorage.setItem('lm-theme', theme);
  try {
    await chrome.storage.local.set({ lmTheme: theme });
  } catch (_) { /* ignore */ }
  applyTheme(theme);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.lmTheme) return;
  const next = changes.lmTheme.newValue;
  if (next !== 'light' && next !== 'dark') return;
  localStorage.setItem('lm-theme', next);
  applyTheme(next);
});

themeToggle.addEventListener('click', async () => {
  const isLight = document.documentElement.classList.contains('light');
  const next = isLight ? 'dark' : 'light';
  localStorage.setItem('lm-theme', next);
  try {
    await chrome.storage.local.set({ lmTheme: next });
    await chrome.storage.session.set({ lmTheme: next });
  } catch (_) {
    chrome.storage.session.set({ lmTheme: next });
  }
  applyTheme(next);
});

const openDashboardBtn = document.getElementById('openDashboardBtn');
openDashboardBtn?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

document.getElementById('openHomeBtn')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('home.html') });
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await initTheme();
  await loadTimeline();
  await updateIndexCount();
}

// ── Timeline ──────────────────────────────────────────────────────────────────

async function loadTimeline() {
  const response = await bgMessage({ type: 'GET_RECENT', limit: 30 });
  const pages = response?.pages || [];

  if (pages.length === 0) {
    timelineList.innerHTML = `
      <div class="empty-state" style="padding: 24px">
        <div class="empty-icon">🧠</div>
        <p class="empty-title">No pages indexed yet</p>
        <p class="empty-sub">Browse any page for 8+ seconds and Local Mind will start learning.</p>
      </div>`;
    return;
  }

  timelineList.innerHTML = '';
  const grouped = groupByDate(pages);

  for (const [label, group] of Object.entries(grouped)) {
    const groupEl = document.createElement('div');
    groupEl.className = 'date-group';
    groupEl.innerHTML = `<div class="date-label">${label}</div>`;
    group.forEach((page, i) => groupEl.appendChild(createCard(page, i * 30)));
    timelineList.appendChild(groupEl);
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
  searchFromAutoSerp = false;
  clearTimeout(searchTimeout);
  const q = searchInput.value.trim();
  if (!q) { showTimeline(); return; }
  searchTimeout = setTimeout(() => runSearch(q), 350);
});

async function runSearch(query) {
  showSpinner(true);
  exampleQueries.classList.add('hidden');

  const response = await bgMessage({ type: 'SEARCH_QUERY', query });
  const results = response?.results || [];

  showSpinner(false);
  timelineSection.classList.add('hidden');
  resultsSection.classList.remove('hidden');
  emptyState.classList.add('hidden');

  try {
    // Stage 1: Get local vector search results immediately (up to 3).
    const localResults = await getLocalVectorResults(query, activeSourceFilter);
    
    showSpinner(false);
    resultsLabel.textContent = `${localResults.length} result${localResults.length !== 1 ? 's' : ''} for "${query}"`;

    if (localResults.length === 0) {
      resultsList.innerHTML = '';
      emptyState.classList.remove('hidden');
      queryAnswer.classList.add('hidden');
    } else {
      renderGroupedResults(localResults, query);
    }

    // Stage 2: Show pending state and fetch AI answer in background.
    displayPendingAnswer();
    fetchAIAnswer(query);

  } catch (err) {
    showSpinner(false);
    console.error('[LocalMind] Search failed:', err);
    queryAnswer.textContent = 'Search failed. Try again.';
    queryAnswer.classList.remove('hidden');
  }
}

function displayPendingAnswer() {
  queryAnswer.innerHTML = '<div class="answer-pending">⏳ Summarizing answer...</div>';
  queryAnswer.classList.remove('hidden');
}

async function getLocalVectorResults(query, sourceFilter = 'all') {
  const response = await bgMessage({ type: 'SEARCH_QUERY', query, sourceFilter });
  const results = response?.results || [];
  return results.slice(0, 12);
}

async function fetchAIAnswer(query) {
  try {
    const res = await fetch('http://127.0.0.1:8000/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      timeout: 120000,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const answer = data?.answer || '';

    if (answer) {
      queryAnswer.textContent = answer;
      queryAnswer.classList.remove('hidden');
    }
  } catch (err) {
    console.warn('[LocalMind] AI answer fetch failed:', err);
    queryAnswer.textContent = 'AI response unavailable.';
  }
}



async function refreshSidebarContent() {
  const activeQuery = searchInput.value.trim();
  if (activeQuery) {
    await runSearch(activeQuery);
  } else {
    await loadTimeline();
    showTimeline();
  }
  await updateIndexCount();
}

function scheduleSidebarRefresh() {
  if (refreshTimeout) clearTimeout(refreshTimeout);
  // Batch rapid storage writes into one UI refresh.
  refreshTimeout = setTimeout(() => {
    refreshSidebarContent().catch((err) => {
      console.warn('[LocalMind] Failed to refresh sidebar:', err);
    });
  }, 120);
}

// ── Clear search ──────────────────────────────────────────────────────────────

clearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchFromAutoSerp = false;
  setSourceFilter('all');
  showTimeline();
});

function showTimeline() {
  timelineSection.classList.remove('hidden');
  resultsSection.classList.add('hidden');
  emptyState.classList.add('hidden');
  exampleQueries.classList.remove('hidden');
  showSpinner(false);
}

// ── Example chips ─────────────────────────────────────────────────────────────

document.querySelectorAll('.eq-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    searchFromAutoSerp = false;
    searchInput.value = btn.dataset.q;
    searchInput.focus();
    runSearch(btn.dataset.q);
  });
});

sourceFilters?.addEventListener('click', (event) => {
  const btn = event.target.closest('.source-chip');
  if (!btn) return;
  const nextFilter = btn.dataset.filter || 'all';
  setSourceFilter(nextFilter);
  const q = searchInput.value.trim();
  if (q) runSearch(q);
});

function setSourceFilter(nextFilter) {
  activeSourceFilter = nextFilter;
  sourceFilterButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === nextFilter);
  });
}

function classifySource(page) {
  if (page.sourceType === 'bookmark') return 'bookmarks';
  if (page.fromHistory) return 'history';
  return 'visited';
}

function getGroupLabel(groupKey) {
  if (groupKey === 'bookmarks') return 'Bookmarks';
  if (groupKey === 'visited') return 'Visited Pages';
  if (groupKey === 'history') return 'History';
  return 'Other';
}

function renderGroupedResults(results, query) {
  resultsList.innerHTML = '';
  const groups = {
    bookmarks: [],
    visited: [],
    history: [],
  };
  results.forEach((item) => {
    const source = classifySource(item);
    if (!groups[source]) groups[source] = [];
    groups[source].push(item);
  });

  let cardIndex = 0;
  ['bookmarks', 'visited', 'history'].forEach((groupKey) => {
    const items = groups[groupKey];
    if (!items?.length) return;
    const groupWrap = document.createElement('div');
    groupWrap.className = 'results-group';
    groupWrap.innerHTML = `<div class="results-group-label">${getGroupLabel(groupKey)}</div>`;
    items.forEach((page) => {
      groupWrap.appendChild(createCard(page, cardIndex * 35, query));
      cardIndex += 1;
    });
    resultsList.appendChild(groupWrap);
  });
}

// ── Card factory ──────────────────────────────────────────────────────────────

function createCard(page, delay = 0, highlight = '') {
  const card = document.createElement('a');
  card.className = 'memory-card';
  card.href = page.url;
  card.target = '_blank';
  card.rel = 'noopener';
  card.style.animationDelay = `${delay}ms`;

  const domain = extractDomain(page.url);
  const time = formatRelativeTime(page.timestamp);
  const snippet = page.text
    ? highlightKeywords(page.text.slice(0, 120) + '…', highlight)
    : '';
  const scoreHTML = page.score !== undefined
    ? `<span class="card-score">${Math.round(page.score * 100)}%</span>`
    : '';

  card.innerHTML = `
    <div class="card-top">
      <span class="card-title">${highlightKeywords(page.title || domain, highlight)}</span>
      ${scoreHTML}
    </div>
    ${snippet ? `<div class="card-snippet">${snippet}</div>` : ''}
    <div class="card-meta">
      <span class="card-domain">${domain}</span>
      <span class="card-time">${time}</span>
      ${page.sourceType === 'bookmark' ? '<span class="card-tag">bookmark</span>' : ''}
      ${page.category ? `<span class="card-tag">${page.category.toLowerCase()}</span>` : ''}
      ${page.fromHistory ? '<span class="card-tag">history</span>' : ''}
    </div>
    <button class="card-menu-btn" title="Options">⋯</button>
  `;

  // ── 3-dot menu ──────────────────────────────────────────────────────────────
  const menuBtn = card.querySelector('.card-menu-btn');

  menuBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeActiveDropdown();

    const dropdown = document.createElement('div');
    dropdown.className = 'card-dropdown';
    dropdown.innerHTML = `
      <button class="copy-url-btn">
        <span class="menu-icon">🔗</span> Copy URL
      </button>
      <button class="copy-title-btn">
        <span class="menu-icon">📋</span> Copy title
      </button>
      <hr/>
      <button class="delete-btn danger">
        <span class="menu-icon">🗑</span> Remove from memory
      </button>
    `;

    // Position dropdown using fixed coords relative to the button
    const btnRect = menuBtn.getBoundingClientRect();
    dropdown.style.top = `${btnRect.bottom + 4}px`;
    dropdown.style.right = `${window.innerWidth - btnRect.right}px`;

    document.body.appendChild(dropdown);
    activeDropdown = dropdown;

    // Copy URL
    dropdown.querySelector('.copy-url-btn').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(page.url);
      showToast('URL copied!');
      closeActiveDropdown();
    });

    // Copy title
    dropdown.querySelector('.copy-title-btn').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(page.title || domain);
      showToast('Title copied!');
      closeActiveDropdown();
    });

    // Delete
    dropdown.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeActiveDropdown();
      await bgMessage({ type: 'DELETE_PAGE', url: page.url });
      card.style.transition = 'all 0.2s ease';
      card.style.opacity = '0';
      card.style.transform = 'translateX(10px)';
      setTimeout(() => { card.remove(); updateIndexCount(); }, 200);
    });
  });

  return card;
}

// Close dropdown when clicking outside
document.addEventListener('click', () => closeActiveDropdown());

function closeActiveDropdown() {
  if (activeDropdown) {
    activeDropdown.remove();
    activeDropdown = null;
  }
}

// ── Copy toast ────────────────────────────────────────────────────────────────

function showToast(msg = 'Copied!') {
  copyToast.textContent = msg;
  copyToast.classList.add('show');
  setTimeout(() => copyToast.classList.remove('show'), 1800);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function highlightKeywords(text, query) {
  if (!query || !text) return text || '';
  const words = query.split(/\s+/).filter(w => w.length > 2);
  let result = text;
  words.forEach(word => {
    const re = new RegExp(`(${word})`, 'gi');
    result = result.replace(re, '<mark>$1</mark>');
  });
  return result;
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); }
  catch { return url; }
}

function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function groupByDate(pages) {
  const groups = {};
  pages.forEach(page => {
    const d = new Date(page.timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    let label;
    if (isSameDay(d, today)) label = 'Today';
    else if (isSameDay(d, yesterday)) label = 'Yesterday';
    else label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    if (!groups[label]) groups[label] = [];
    groups[label].push(page);
  });
  return groups;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function showSpinner(on) {
  searchSpinner.classList.toggle('active', on);
}

async function updateIndexCount() {
  const response = await bgMessage({ type: 'GET_RECENT', limit: 9999 });
  const count = response?.pages?.length || 0;
  indexedCount.textContent = `${count} page${count !== 1 ? 's' : ''} indexed`;
}

// ── Background messaging ──────────────────────────────────────────────────────

function bgMessage(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[LocalMind]', chrome.runtime.lastError.message);
        resolve({});
      } else {
        resolve(response);
      }
    });
  });
}

// ── Clear all memory ──────────────────────────────────────────────────────────

document.getElementById('clearMemoryBtn').addEventListener('click', () => {
  const footer = document.querySelector('.status-bar');
  footer.classList.add('hidden');

  const confirmBar = document.createElement('div');
  confirmBar.className = 'confirm-bar';
  confirmBar.innerHTML = `
    <div style="width:100%">
      <div style="font-size:11px;color:var(--danger);margin-bottom:10px;font-weight:500;">
        ⚠️ Clear memory
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">
        <button class="clear-option-btn" data-range="hour">
          🕐 Last hour
        </button>
        <button class="clear-option-btn" data-range="day">
          🕰 Last 24 hours
        </button>
        <button class="clear-option-btn danger" data-range="all">
          🗑 All data — cannot be undone
        </button>
      </div>
      <button class="confirm-no" id="confirmNo" style="width:100%">Cancel</button>
    </div>
  `;

  // Inject option button styles
  const s = document.createElement('style');
  s.textContent = `
    .clear-option-btn {
      width: 100%;
      padding: 8px 12px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 7px;
      color: var(--text-secondary);
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
      transition: all 0.15s;
    }
    .clear-option-btn:hover {
      background: var(--bg-card-hover);
      border-color: var(--border);
      color: var(--text-primary);
    }
    .clear-option-btn.danger {
      color: var(--danger);
      border-color: var(--danger-dim);
    }
    .clear-option-btn.danger:hover {
      background: var(--danger-dim);
    }
  `;
  document.head.appendChild(s);

  document.querySelector('.shell').appendChild(confirmBar);

  // Cancel
  document.getElementById('confirmNo').addEventListener('click', () => {
    confirmBar.remove();
    footer.classList.remove('hidden');
  });

  // Option buttons
  confirmBar.querySelectorAll('.clear-option-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const range = btn.dataset.range;
      await bgMessage({ type: 'CLEAR_MEMORY', range });
      confirmBar.remove();
      footer.classList.remove('hidden');

    const labels = {
    hour: 'Last hour cleared.',
    day: 'Last 24 hours cleared.',
    all: 'All memory cleared.',
    };

    if (range === 'all') {
    // Full wipe — show empty state
    timelineList.innerHTML = `
        <div class="empty-state" style="padding: 24px">
        <div class="empty-icon">🧠</div>
        <p class="empty-title">${labels[range]}</p>
        <p class="empty-sub">Browse any page for 8+ seconds and Local Mind will start learning again.</p>
        </div>`;
    indexedCount.textContent = '0 pages indexed';
    } else {
    // Partial clear — reload timeline with remaining pages
    showToast(labels[range]);
    await loadTimeline();
    await updateIndexCount();
    }

    showTimeline();
    });
  });
});
// ── Check for pending query ───────────────────────────────────────────────────

async function checkForPendingQuery() {
  const response = await bgMessage({ type: 'GET_PENDING_QUERY' });
  if (response?.query) {
    searchFromAutoSerp = true;
    searchInput.value = response.query;
    runSearch(response.query);
  }
}

function resetAutoSerpSearchUi() {
  searchInput.value = '';
  searchFromAutoSerp = false;
  queryAnswer.classList.add('hidden');
  setSourceFilter('all');
  showTimeline();
}

async function syncSearchUiIfLeftSerp() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tabs[0]?.url;
  if (!url) return;
  const r = await bgMessage({ type: 'EXTRACT_SEARCH_QUERY_FROM_URL', url });
  if (r?.query || !searchFromAutoSerp) return;
  resetAutoSerpSearchUi();
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active || !tab.url) return;
  if (changeInfo.status !== 'complete') return;
  syncSearchUiIfLeftSerp();
});

chrome.tabs.onActivated.addListener(() => {
  syncSearchUiIfLeftSerp();
});

// ── Auto-refresh on new browser search ───────────────────────────────────────

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const hasPageUpdate = Object.keys(changes).some((key) => key.startsWith('page_'));
  if (!hasPageUpdate) return;
  scheduleSidebarRefresh();
});

// ── Date group label styles ───────────────────────────────────────────────────

const style = document.createElement('style');
style.textContent = `
  .date-group { margin-bottom: 12px; }
  .date-label {
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin-bottom: 6px;
    padding-left: 2px;
  }
`;
document.head.appendChild(style);

// ── Start ─────────────────────────────────────────────────────────────────────

init();
checkForPendingQuery();