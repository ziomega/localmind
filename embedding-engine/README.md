# Embedding Engine

This folder belongs to the embedding engine teammate.

## Your job

Implement a local embedding model that the Chrome extension can call.

## Interface to implement

See `docs/api-contracts.md` for the exact function signature.

## Options

1. **Replace the stub directly** — edit `extension/utils/embeddings.js`
2. **Run a local server** — build a small server here that listens on
   `http://localhost:8080/embed` and the extension calls into it

## Suggested stack

- Python + FastAPI + sentence-transformers (all-MiniLM-L6-v2 model)
- Or: ONNX runtime for fully in-browser inference   