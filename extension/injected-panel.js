// injected-panel.js — runs inside the iframe

const resultsEl = document.getElementById('results');
const queryTextEl = document.getElementById('queryText');
const closeBtn = document.getElementById('closeBtn');

// Get query passed via URL hash from search-trigger.js
const query = decodeURIComponent(location.hash.slice(1)) || '';
queryTextEl.textContent = query ? `"${query}"` : '—';

// ── Load results ──────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'SEARCH_QUERY', query }, (response) => {
  const results = response?.results || [];
  renderResults(results);
});

function renderResults(results) {
  if (results.length === 0) {
    resultsEl.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🧠</div>
        <div class="empty-text">No memories yet for this topic. Keep browsing and Local Mind will learn.</div>
      </div>`;
    return;
  }

  resultsEl.innerHTML = '';
  results.slice(0, 3).forEach((page, i) => {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = page.url;
    card.target = '_blank';
    card.rel = 'noopener';
    card.style.animationDelay = `${i * 60}ms`;

    const domain = extractDomain(page.url);
    const title = highlight(page.title || domain, query);
    const score = page.score !== undefined
      ? `<span class="card-score">${Math.round(page.score * 100)}%</span>`
      : '';

    card.innerHTML = `
      <div class="card-title">${title}</div>
      <div class="card-meta">
        <span class="card-domain">${domain}</span>
        ${score}
      </div>`;

    resultsEl.appendChild(card);
  });
}

// ── Buttons ───────────────────────────────────────────────────────────────────

closeBtn.addEventListener('click', () => {
  window.parent.postMessage({ type: 'LM_CLOSE' }, '*');
});



// ── Helpers ───────────────────────────────────────────────────────────────────

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); }
  catch { return url; }
}

function highlight(text, query) {
  if (!query || !text) return text || '';
  const words = query.split(/\s+/).filter(w => w.length > 2);
  let result = text;
  words.forEach(word => {
    result = result.replace(new RegExp(`(${word})`, 'gi'), '<mark>$1</mark>');
  });
  return result;
}

// ── Sync theme with sidebar ───────────────────────────────────────
chrome.storage.session.get('lmTheme', (data) => {
  if (data.lmTheme === 'light') {
    document.documentElement.classList.add('light');
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.lmTheme) {
    document.documentElement.classList.toggle('light', changes.lmTheme.newValue === 'light');
  }
});