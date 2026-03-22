# LocalMind


Privacy-first browser memory assistant that helps you semantically search what you have read.
<!-- Replace with your hosted banner image URL
![LocalMind Banner](./Screenshots/banner.png) -->
https://localmind-beta.vercel.app/

## Screenshots

<!-- Replace these with real screenshots as you add assets -->

### 1) Landing Page
![Landing Page](./Screenshots/LandingPage.png)

### 2) Chat with History Assistant
![Chat with History Assistant](./Screenshots/Chat.png)

### 3) Analytics Dashboard
![Analytics Dashboard](./Screenshots/DashBoard.png)

### 4) Sidebar Memory Search
![Sidebar Memory Search](./Screenshots/SideBar.png)

### 5) Timeline and Results
![Timeline and Results](./Screenshots/Result.png)

### Screenshot Notes

- Keep file names lowercase with hyphens.
- Prefer PNG for UI screenshots.
- Recommended width: 1400px or higher for clarity.
- If images are not committed yet, these placeholders will simply render as broken links until assets are added.

LocalMind combines:
- A Chrome extension that captures and indexes page content.
- A local FastAPI backend for embeddings, vector search, analytics, and chat.
- Dashboard and landing pages for analytics and product presentation.

## Features

- Semantic memory search over visited pages and bookmarks.
- Two-stage UX: instant local retrieval + optional AI-generated answer.
- Timeline and analytics (domains, dates, visit activity, tracked time).
- Chat assistant over browsing history with source references.
- Local-first architecture with optional external providers.

## Repository Structure

- backend/: FastAPI server, embedding pipeline, FAISS memory store.
- extension/: Chrome extension (service worker, content scripts, sidebar, dashboard).
- frontend/: Standalone static pages (landing and dashboard variants).
- docs/: API contract and technical documentation.

## Tech Stack

- Backend: FastAPI, Uvicorn, FAISS, sentence-transformers, NumPy.
- Extension: Chrome Extension Manifest V3, vanilla JavaScript, chrome.storage APIs.
- UI: HTML/CSS/JS, Chart.js.
- LLM/Embeddings:
	- Local embedding model in backend (all-MiniLM-L6-v2).
	- Optional Gemini embedding API from extension.
	- Ollama/Pollinations path for chat generation.

## Prerequisites

- Python 3.8+
- Google Chrome (or Chromium-based browser)
- Optional: Ollama running locally for chat

## Quick Start

### 1) Start backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python server.py
```

Backend runs on:
- http://127.0.0.1:8000

### 2) Load extension

1. Open chrome://extensions
2. Enable Developer mode
3. Click Load unpacked
4. Select the extension/ folder
5. Click extension icon and open side panel

### 3) Optional local chat model (Ollama)

Install and run Ollama, then pull the configured model used by backend:

```bash
ollama pull qwen2.5:0.5b
```

## Core API Endpoints

- GET /test: Health check
- POST /embed: Generate embedding for text
- POST /store: Store page memory in vector index
- POST /query: Query memories and generate concise answer
- GET /analytics: Dashboard metrics and records
- POST /chat-history: Source-backed conversational history responses

## How It Works

1. Extension content script extracts meaningful page text after dwell time.
2. Background worker creates embeddings and stores records locally.
3. Records are optionally synced to backend vector store.
4. Query requests run semantic retrieval + reranking.
5. Dashboard and sidebar render results, analytics, and chat output.

## Configuration Notes

- Gemini API key (optional for extension embeddings):
	- Stored in chrome.storage.local as geminiApiKey.
- Chat provider:
	- Default backend path is Ollama with fallback behavior.
- Data files:
	- backend/data/index.faiss
	- backend/data/metadata.json

## Development Tips

- If backend is not running, analytics/chat views will show connection errors.
- If no results appear yet, browse a few pages and wait for indexing.
- Clear memory from sidebar controls to reset local storage state.

## Documentation

- API contract: docs/api-contracts.md
- Technical report: docs/AllYouNeedToKnow.tex

## Roadmap Ideas

- Authentication and stricter CORS for production.
- Approximate nearest-neighbor indexing for larger datasets.
- Better backup/restore and encrypted-at-rest support.
- Cross-device sync with explicit privacy controls.

## License

This project is licensed under the MIT License. See the LICENSE file for details.
