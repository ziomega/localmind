# 🧠 Local Mind

> Privacy-first agentic memory layer for your browser.

## Structure

| Folder | Owner | What it does |
|--------|-------|-------------|
| `extension/` | UI teammate | Chrome extension — sidebar, content script, background worker |
| `embedding-engine/` | Embeddings teammate | Local model that converts page text to vectors |
| `search-backend/` | Search teammate | Retrieval logic and indexing improvements |
| `docs/` | Everyone | Architecture decisions and API contracts |

## Quickstart (Extension)

1. `cd extension && pip install Pillow && python generate_icons.py`
2. Open `chrome://extensions` → Developer Mode ON → Load unpacked → select `extension/`
3. Click the Local Mind icon → Open Memory Sidebar

## Integration

See `docs/api-contracts.md` for how the three parts connect.
```

---

## Step 5: Update `.gitignore`

Open `.gitignore` and add these lines at the bottom:
```
# Extension
*.crx
*.pem
extension/icons/*.png

# Python
__pycache__/
*.pyc
.venv/

# OS
.DS_Store
Thumbs.db

# Node (if teammates use it)
node_modules/