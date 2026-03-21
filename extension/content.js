// Injected into every page. Extracts meaningful text after user dwells.

const DWELL_TIME_MS = 1000;
const MAX_TEXT_LENGTH = 20000;

let dwellTimer = null;
let hasExtracted = false;

function extractPageContent() {
  if (hasExtracted) return;
  hasExtracted = true;

  const noiseTags = ['nav', 'footer', 'header', 'script', 'style', 'noscript', 'aside'];
  const clone = document.body.cloneNode(true);
  noiseTags.forEach(tag => clone.querySelectorAll(tag).forEach(el => el.remove()));

  const mainEl = clone.querySelector('article, main, [role="main"]') || clone;
  const rawText = mainEl.innerText || mainEl.textContent || '';
  const cleanText = rawText.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);

  if (cleanText.length < 100) return;

  const payload = {
    type: 'PAGE_CONTENT',
    url: location.href,
    title: document.title,
    text: cleanText,
    timestamp: Date.now(),
  };

  chrome.runtime.sendMessage(payload).catch(() => {});
}

function startDwellTracking() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && dwellTimer) {
      clearTimeout(dwellTimer);
    } else if (!document.hidden && !hasExtracted) {
      dwellTimer = setTimeout(extractPageContent, DWELL_TIME_MS);
    }
  });

  if (!document.hidden) {
    dwellTimer = setTimeout(extractPageContent, DWELL_TIME_MS);
  }
}

startDwellTracking();
