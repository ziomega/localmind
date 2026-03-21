# API Contracts — Local Mind

## Extension ↔ Embedding Engine

File: `extension/utils/embeddings.js`

Function the extension calls:
  generateEmbedding(text: string) → Promise<float[]>

- Input: plain text string, max ~5000 characters
- Output: float array, length 384
- Must run entirely locally (no external network calls)
- Teammate option A: replace the stub function body directly
- Teammate option B: run a local server at http://localhost:8080/embed
  that accepts POST { text: string } and returns { embedding: float[] }

## Extension ↔ Search Backend

File: `extension/utils/storage.js`

Function the extension calls:
  searchMemory({ queryEmbedding, queryText, topK }) → Promise<Page[]>

Page shape:
  { url, title, text, embedding, timestamp, domain, score }

The default keyword+cosine implementation is already in storage.js.
Teammate can replace the searchMemory function body with a more
sophisticated retrieval approach if needed.