// STUB — Teammate replaces this with the real embedding model call.
// Contract: takes a string, returns Promise<float[]> of length 384.

export async function generateEmbedding(text) {
  // Example of what teammate will replace this with:
  //
  // const response = await fetch('http://localhost:8080/embed', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ text }),
  // });
  // const data = await response.json();
  // return data.embedding;

  console.warn('[LocalMind] Using stub embeddings. Connect teammate API!');
  return new Array(384).fill(0);
}
