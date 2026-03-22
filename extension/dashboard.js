const API_BASE = 'http://127.0.0.1:8000';

const state = {
	data: null,
	rows: [],
	filtered: [],
	onlyTimed: false,
	charts: {},
	typingTimer: null,
};

const WAITING_MESSAGES = [
	'Give me ten seconds, photographic memory is kicking in...',
	'Working this like a closing argument, one sec...',
	'Scanning your tabs, dates, and receipts now...',
	'Cross-checking timelines and content, hold on...',
	'Pulling the strongest source-backed answer...',
	'Connecting where you read it and when you read it...',
	'Locking in the cleanest play from your history...',
];

const els = {
	kTotalRecords: document.getElementById('kTotalRecords'),
	kUniqueUrls: document.getElementById('kUniqueUrls'),
	kUniqueDomains: document.getElementById('kUniqueDomains'),
	kDupes: document.getElementById('kDupes'),
	kAvgLen: document.getElementById('kAvgLen'),
	kTrackedTime: document.getElementById('kTrackedTime'),
	historyBody: document.getElementById('historyBody'),
	chatWindow: document.getElementById('chatWindow'),
	chatForm: document.getElementById('chatForm'),
	chatInput: document.getElementById('chatInput'),
	chatSendBtn: document.getElementById('chatSendBtn'),
	chatSources: document.getElementById('chatSources'),
	refreshBtn: document.getElementById('refreshBtn'),
	themeToggle: document.getElementById('themeToggle'),
	searchInput: document.getElementById('searchInput'),
	onlyTimedBtn: document.getElementById('onlyTimedBtn'),
	downloadBtn: document.getElementById('downloadBtn'),
	lastSync: document.getElementById('lastSync'),
	errorMsg: document.getElementById('errorMsg'),
};

els.refreshBtn.addEventListener('click', loadAnalytics);
els.themeToggle.addEventListener('click', toggleTheme);
els.chatForm.addEventListener('submit', onChatSubmit);
document.querySelectorAll('.chat-chip').forEach((chip) => {
	chip.addEventListener('click', () => {
		els.chatInput.value = chip.dataset.q || '';
		els.chatInput.focus();
	});
});
els.searchInput.addEventListener('input', applyFilters);
els.onlyTimedBtn.addEventListener('click', () => {
	state.onlyTimed = !state.onlyTimed;
	els.onlyTimedBtn.classList.toggle('primary', state.onlyTimed);
	applyFilters();
});
els.downloadBtn.addEventListener('click', downloadData);

function formatNumber(n) {
	return new Intl.NumberFormat().format(n || 0);
}

function formatDuration(ms) {
	if (!ms || ms <= 0) return 'N/A';
	const totalSeconds = Math.floor(ms / 1000);
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function formatDate(iso) {
	if (!iso) return 'Unknown';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return 'Unknown';
	return d.toLocaleString();
}

function safeDestroy(name) {
	if (state.charts[name]) {
		state.charts[name].destroy();
	}
}

async function readSyncedTheme() {
	try {
		if (typeof chrome !== 'undefined' && chrome.storage?.local) {
			const { lmTheme } = await chrome.storage.local.get('lmTheme');
			if (lmTheme === 'light' || lmTheme === 'dark') return lmTheme;
		}
	} catch (_) { /* ignore */ }
	const legacy = localStorage.getItem('lm-theme') || localStorage.getItem('localmind-theme');
	if (legacy === 'light' || legacy === 'dark') return legacy;
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
	document.documentElement.setAttribute('data-theme', theme);
	els.themeToggle.textContent = theme === 'dark' ? 'Light' : 'Dark';
}

async function persistTheme(next) {
	localStorage.setItem('lm-theme', next);
	try {
		if (typeof chrome !== 'undefined' && chrome.storage?.local) {
			await chrome.storage.local.set({ lmTheme: next });
			await chrome.storage.session.set({ lmTheme: next });
		}
	} catch (_) { /* ignore */ }
}

async function toggleTheme() {
	const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
	const next = current === 'dark' ? 'light' : 'dark';
	await persistTheme(next);
	applyTheme(next);
	if (state.data) {
		renderDateChart(state.data.visits_by_date || []);
		renderHourChart(state.data.visits_by_hour || []);
	}
}

async function openMemorySidebar() {
	try {
		if (typeof chrome === 'undefined' || !chrome.windows || !chrome.sidePanel) return;
		const win = await chrome.windows.getCurrent();
		if (win?.id != null) await chrome.sidePanel.open({ windowId: win.id });
	} catch (err) {
		console.warn('[LocalMind] Could not open memory sidebar', err);
	}
}

async function bootstrap() {
	const theme = await readSyncedTheme();
	applyTheme(theme);
	try {
		if (typeof chrome !== 'undefined' && chrome.storage?.local) {
			await chrome.storage.local.set({ lmTheme: theme });
		}
	} catch (_) { /* ignore */ }

	if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
		chrome.storage.onChanged.addListener((changes, area) => {
			if (area !== 'local' || !changes.lmTheme) return;
			const v = changes.lmTheme.newValue;
			if (v === 'light' || v === 'dark') {
				applyTheme(v);
				localStorage.setItem('lm-theme', v);
				if (state.data) {
					renderDateChart(state.data.visits_by_date || []);
					renderHourChart(state.data.visits_by_hour || []);
				}
			}
		});
	}

	const openSidebarBtn = document.getElementById('openSidebarBtn');
	if (openSidebarBtn) openSidebarBtn.addEventListener('click', () => openMemorySidebar());

	loadAnalytics();
}

function chartTheme() {
	const style = getComputedStyle(document.documentElement);
	const accent = style.getPropertyValue('--accent').trim() || '#7c6af7';
	const accent2 = style.getPropertyValue('--accent2').trim() || '#9d8fff';
	const text2 = style.getPropertyValue('--text2').trim() || '#9898aa';
	const grid = style.getPropertyValue('--border').trim() || '#1e1e26';
	const bg2 = style.getPropertyValue('--bg2').trim() || '#0f0f12';
	return { accent, accent2, text2, grid, bg2 };
}

function renderKpis(summary) {
	els.kTotalRecords.textContent = formatNumber(summary.total_records);
	els.kUniqueUrls.textContent = formatNumber(summary.unique_urls);
	els.kUniqueDomains.textContent = formatNumber(summary.unique_domains);
	els.kDupes.textContent = formatNumber(summary.duplicate_urls);
	els.kAvgLen.textContent = formatNumber(summary.avg_content_length);
	els.kTrackedTime.textContent = formatDuration(summary.total_time_spent_ms);
}

function renderDateChart(points) {
	const t = chartTheme();
	const labels = points.map(p => p.date);
	const values = points.map(p => p.count);
	safeDestroy('date');
	state.charts.date = new Chart(document.getElementById('dateChart'), {
		type: 'line',
		data: {
			labels,
			datasets: [{
				label: 'Visits',
				data: values,
				borderColor: t.accent,
				backgroundColor: 'rgba(124,106,247,0.18)',
				fill: true,
				tension: 0.35,
				pointRadius: 3,
				pointBackgroundColor: t.accent2
			}]
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: { legend: { display: false } },
			scales: {
				y: { beginAtZero: true, ticks: { color: t.text2 }, grid: { color: t.grid } },
				x: { ticks: { color: t.text2 }, grid: { color: t.grid } }
			}
		}
	});
}

function renderHourChart(points) {
	const t = chartTheme();
	const labels = points.map(p => `${String(p.hour).padStart(2, '0')}:00`);
	const values = points.map(p => p.count);
	safeDestroy('hour');
	state.charts.hour = new Chart(document.getElementById('hourChart'), {
		type: 'bar',
		data: {
			labels,
			datasets: [{
				label: 'Visits',
				data: values,
				backgroundColor: t.accent,
				borderRadius: 6,
				maxBarThickness: 24
			}]
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: { legend: { display: false } },
			scales: {
				y: { beginAtZero: true, ticks: { color: t.text2 }, grid: { color: t.grid } },
				x: { ticks: { color: t.text2 }, grid: { color: t.grid } }
			}
		}
	});
}

function escapeHtml(text) {
	return String(text || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function addChatMessage(role, message, meta = '') {
	const wrap = document.createElement('div');
	wrap.className = `chat-msg ${role}`;
	const metaHtml = meta ? `<div class="chat-meta">${escapeHtml(meta)}</div>` : '';
	wrap.innerHTML = `${metaHtml}${escapeHtml(message)}`;
	els.chatWindow.appendChild(wrap);
	els.chatWindow.scrollTop = els.chatWindow.scrollHeight;
	return wrap;
}

function randomWaitingMessage() {
	return WAITING_MESSAGES[Math.floor(Math.random() * WAITING_MESSAGES.length)];
}

function addTypingIndicator() {
	const wrap = document.createElement('div');
	wrap.className = 'chat-msg bot';
	wrap.id = 'typingIndicator';
	wrap.innerHTML = `<div class="chat-meta">Mike Ross</div><div class="chat-typing"><span></span><span></span><span></span></div><div class="chat-meta" id="typingHint">${escapeHtml(randomWaitingMessage())}</div>`;
	els.chatWindow.appendChild(wrap);
	els.chatWindow.scrollTop = els.chatWindow.scrollHeight;

	state.typingTimer = setInterval(() => {
		const hint = document.getElementById('typingHint');
		if (!hint) return;
		hint.textContent = randomWaitingMessage();
	}, 2200);
}

function removeTypingIndicator() {
	if (state.typingTimer) {
		clearInterval(state.typingTimer);
		state.typingTimer = null;
	}
	const el = document.getElementById('typingIndicator');
	if (el) el.remove();
}

function renderChatSourcesPanel(sources) {
	els.chatSources.innerHTML = '';
	if (!sources || sources.length === 0) {
		els.chatSources.innerHTML = '<div class="chat-source muted">No sources yet. Ask Mike Ross a question.</div>';
		return;
	}
	sources.slice(0, 5).forEach((s, i) => {
		const item = document.createElement('div');
		item.className = 'chat-source';
		item.innerHTML = `${i + 1}. ${escapeHtml(s.title || 'Untitled')}<small>${escapeHtml(s.domain || 'unknown')}</small>`;
		els.chatSources.appendChild(item);
	});
}

function setChatWelcome(summary = {}, topDomains = []) {
	els.chatWindow.innerHTML = '';
	const totalRecords = summary.total_records || 0;
	const uniqueDomains = summary.unique_domains || 0;
	const domainFacts = (topDomains || []).slice(0, 3)
		.map((d, i) => `${i + 1}. ${d.domain}: ${d.count}`)
		.join('\n');

	const intro = [
		`You now have ${formatNumber(totalRecords)} records across ${formatNumber(uniqueDomains)} domains.`,
		domainFacts ? `Most active domains right now:\n${domainFacts}` : '',
		"Ask for timelines, patterns, or source-backed answers from your browsing history.",
	].filter(Boolean).join('\n\n');

	addChatMessage(
		'bot',
		intro,
		'Mike Ross'
	);
	renderChatSourcesPanel([]);
}

function formatChatSources(sources) {
	if (!sources || sources.length === 0) return '';
	const top = sources.slice(0, 3);
	return top.map((s, i) => `${i + 1}. ${s.title || 'Untitled'} (${s.domain || 'unknown'})`).join('\n');
}

async function onChatSubmit(event) {
	event.preventDefault();
	const message = (els.chatInput.value || '').trim();
	if (!message) return;

	addChatMessage('user', message, 'You');
	els.chatInput.value = '';
	els.chatSendBtn.disabled = true;
	els.chatSendBtn.textContent = '...';
	addTypingIndicator();

	try {
		const res = await fetch(`${API_BASE}/chat-history`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message }),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		removeTypingIndicator();
		addChatMessage('bot', data.reply || 'No reply available.', data.bot || 'Mike Ross');
		const sourceText = formatChatSources(data.sources || []);
		if (sourceText) {
			addChatMessage('bot', sourceText, 'Sources');
		}
		renderChatSourcesPanel(data.sources || []);
	} catch (err) {
		console.error('[LocalMind Chat]', err);
		removeTypingIndicator();
		addChatMessage('bot', 'I could not read your history right now. Try again.', 'Mike Ross');
	} finally {
		els.chatSendBtn.disabled = false;
		els.chatSendBtn.textContent = 'Send';
	}
}

function toSearchBlob(r) {
	return `${r.title || ''} ${r.domain || ''} ${r.url || ''} ${r.snippet || ''}`.toLowerCase();
}

function renderTable(rows) {
	els.historyBody.innerHTML = '';
	rows.forEach(r => {
		const tr = document.createElement('tr');
		tr.innerHTML = `
			<td>${r.id}</td>
			<td>${r.title || 'Untitled'}</td>
			<td><span class="tag">${r.domain || 'unknown'}</span></td>
			<td>${formatDate(r.visited_at || r.visited_date)}</td>
			<td>${formatDuration(r.time_spent_ms)}</td>
			<td class="snippet">${(r.snippet || '').replace(/</g, '&lt;')}</td>
			<td><a class="url" href="${r.url}" target="_blank" rel="noopener">${r.url || ''}</a></td>
		`;
		els.historyBody.appendChild(tr);
	});
}

function applyFilters() {
	if (!state.rows) return;
	const query = els.searchInput.value.trim().toLowerCase();
	let rows = [...state.rows];
	if (state.onlyTimed) {
		rows = rows.filter(r => Number(r.time_spent_ms) > 0);
	}
	if (query) {
		rows = rows.filter(r => toSearchBlob(r).includes(query));
	}
	state.filtered = rows;
	renderTable(rows);
}

function downloadData() {
	if (!state.data) return;
	const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `localmind-analytics-${new Date().toISOString().slice(0,19).replace(/[:T]/g, '-')}.json`;
	a.click();
	URL.revokeObjectURL(url);
}

async function loadAnalytics() {
	els.errorMsg.textContent = '';
	els.refreshBtn.disabled = true;
	els.refreshBtn.textContent = 'Refreshing...';

	try {
		const res = await fetch(`${API_BASE}/analytics?limit=2000`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		state.data = data;
		state.rows = data.records || [];

		renderKpis(data.summary || {});
		renderDateChart(data.visits_by_date || []);
		renderHourChart(data.visits_by_hour || []);
		applyFilters();
		setChatWelcome(data.summary || {}, data.top_domains || []);

		els.lastSync.textContent = `Last sync: ${new Date().toLocaleString()}`;
	} catch (err) {
		console.error('[LocalMind Dashboard]', err);
		els.errorMsg.textContent = `Could not load analytics from ${API_BASE}/analytics. Ensure backend is running.`;
	} finally {
		els.refreshBtn.disabled = false;
		els.refreshBtn.textContent = 'Refresh Analytics';
	}
}

bootstrap();
