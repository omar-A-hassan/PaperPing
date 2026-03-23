// ─── Local Ollama embeddings (nomic-embed-text, 768 dims) ─────────────────────
// Returns null on any failure — callers must fall back to recency-based retrieval.
// Uses Ollama running locally (http://localhost:11434) — no API key, no cost.

const OLLAMA_API = "http://localhost:11434/api/embeddings";
export const EMBEDDING_MODEL = "nomic-embed-text";
export const EMBEDDING_DIM = 768;

export async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await fetch(OLLAMA_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
      // Fail fast — if Ollama isn't running, don't stall session assembly
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { embedding?: number[] };
    const emb = data?.embedding;
    if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIM) return null;
    return emb;
  } catch {
    // Ollama not running, network error, or timeout — graceful fallback
    return null;
  }
}
