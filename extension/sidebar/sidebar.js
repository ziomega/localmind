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

let searchTimeout = null;

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await loadTimeline();
  await updateIndexCount();
}

// ── Timeline (default view) ───────────────────────────────────────────────────

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

    group.forEach((page, i) => {
      const card = createCard(page, i * 30);
      groupEl.appendChild(card);
    });

    timelineList.appendChild(groupEl);
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  const q = searchInput.value.trim();

  if (!q) {
    showTimeline();
    return;
  }

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

  resultsLabel.textContent = `${results.length} result${results.length !== 1 ? 's' : ''} for "${query}"`;

  if (results.length === 0) {
    resultsList.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  resultsList.innerHTML = '';
  results.forEach((page, i) => {
    resultsList.appendChild(createCard(page, i * 40, query));
  });
}

// ── Clear search ──────────────────────────────────────────────────────────────

clearBtn.addEventListener('click', () => {
  searchInput.value = '';
  showTimeline();
});

function showTimeline() {
  timelineSection.classList.remove('hidden');
  resultsSection.classList.add('hidden');
  emptyState.classList.add('hidden');
  exampleQueries.classList.remove('hidden');
  showSpinner(false);
}

// ── Example query chips ───────────────────────────────────────────────────────

document.querySelectorAll('.eq-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    searchInput.value = btn.dataset.q;
    searchInput.focus();
    runSearch(btn.dataset.q);
  });
});

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
      ${page.fromHistory ? '<span class="card-tag">history</span>' : ''}
    </div>
  `;

  return card;
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

// ── Check for pending query (triggered by browser search) ────────────────────

async function checkForPendingQuery() {
  const response = await bgMessage({ type: 'GET_PENDING_QUERY' });
  if (response?.query) {
    searchInput.value = response.query;
    runSearch(response.query);
  }
}

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