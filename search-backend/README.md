# Search Backend

This folder belongs to the search/retrieval teammate.

## Your job

Improve the retrieval logic beyond simple cosine similarity.

## Interface to implement

See `docs/api-contracts.md` for the searchMemory function contract.

## The current implementation

`extension/utils/storage.js` already has a working keyword + cosine
hybrid search. You can enhance it or replace it entirely.

## Ideas

- HNSW index for faster approximate nearest neighbour search
- BM25 keyword scoring
- Re-ranking with a cross-encoder
- Time-decay weighting