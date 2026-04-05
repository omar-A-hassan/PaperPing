import {
  getSession,
  upsertSession,
  clearSession,
  getSessionLastActivity,
  storeSessionSummary,
  getRecentSessionSummaries,
  storeSessionEmbedding,
  findSimilarSessions,
  getUserProfile,
  saveUserProfile,
  mergeProfileDelta,
  getActivePapers,
  clearActivePapers,
  MessageTurn,
  ScholarUserProfile,
} from "./db";
import { getEmbedding } from "./embedder";
import { LLM_PROVIDER, LLM_MODEL } from "./config";
import { callSimpleText } from "./llmClient";

// ─── Token budget constants ────────────────────────────────────────────────────
export const SESSION_TTL_MS = 60 * 60 * 1000; // 60 min idle → new session
const RAW_TURNS_TOKEN_BUDGET = 4_000;
const RAW_TURNS_MAX_COUNT = 12;
const COMPRESS_OLDEST_N = 6;

// ─── Token counting (fast approximation) ─────────────────────────────────────
function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function countTurnsTokens(turns: MessageTurn[]): number {
  return turns.reduce((sum, t) => {
    const content = typeof t.content === "string"
      ? t.content
      : t.content.map((b: any) => b.text ?? b.content ?? "").join("");
    return sum + countTokens(content) + 4; // ~4 overhead per turn
  }, 0);
}

// ─── Assembled context (LLM input) ────────────────────────────────────────────
export interface AssembledContext {
  systemPrompt: string;
  messages: MessageTurn[];
  profileBlock: string;
  pastSessionsBlock: string;
  activePapersBlock: string;
  sessionSummaryBlock: string;
}

// ─── Profile rendering ────────────────────────────────────────────────────────
function renderProfileProse(profile: ScholarUserProfile): string {
  if (!profile.sessionCount) {
    return "New user — no profile built yet.";
  }

  const parts: string[] = [];

  if (profile.name || profile.role) {
    const who = [profile.name, profile.role].filter(Boolean).join(", ");
    parts.push(who);
  }

  if (Object.keys(profile.expertiseDomains).length > 0) {
    const domains = Object.entries(profile.expertiseDomains)
      .map(([d, l]) => `${l}-level knowledge of ${d}`)
      .join(", ");
    parts.push(`with ${domains}`);
  }

  if (profile.primaryInterests.length > 0) {
    parts.push(`Primary interests: ${profile.primaryInterests.slice(0, 5).join(", ")}`);
  }

  if (profile.activeProjects.length > 0) {
    const projects = profile.activeProjects
      .slice(0, 3)
      .map((p) => `"${p.name}" (${p.description})`)
      .join("; ");
    parts.push(`Currently working on: ${projects}`);
  }

  const prefs: string[] = [];
  if (profile.preferredResponseLength !== "adaptive") {
    prefs.push(`prefers ${profile.preferredResponseLength} responses`);
  }
  if (profile.prefersExamples) prefs.push("likes examples");
  if (prefs.length > 0) parts.push(prefs.join(", "));

  if (profile.knownFacts.length > 0) {
    const facts = profile.knownFacts
      .slice(0, 5)
      .map((f) => f.fact)
      .join("; ");
    parts.push(`Known facts: ${facts}`);
  }

  const count = profile.sessionCount;
  const first = profile.firstSeen.slice(0, 10);
  parts.push(`${count} session${count !== 1 ? "s" : ""}, first seen ${first}`);

  return parts.join(". ") + ".";
}

// ─── assembleContext ──────────────────────────────────────────────────────────
// Builds the full LLM input for every call. Respects token budgets.
// queryText: the user's current message — used to semantically retrieve
// past sessions most relevant to what they're asking about.
// Falls back to recency-based retrieval when Ollama is unavailable.
export async function assembleContext(sender: string, queryText?: string): Promise<AssembledContext> {
  const profile = getUserProfile(sender);
  const session = getSession(sender);
  const activePapers = getActivePapers(sender);

  // ── Past sessions: semantic (when Ollama available) or recency fallback ──
  let pastSummaries: Array<{ summary: string; created_at: string }>;
  if (queryText) {
    const embedding = await getEmbedding(queryText);
    if (embedding) {
      pastSummaries = findSimilarSessions(sender, embedding, 3);
      // Fall back to recency if semantic returned nothing (e.g. no embeddings stored yet)
      if (pastSummaries.length === 0) {
        pastSummaries = getRecentSessionSummaries(sender, 3);
      }
    } else {
      pastSummaries = getRecentSessionSummaries(sender, 3);
    }
  } else {
    pastSummaries = getRecentSessionSummaries(sender, 3);
  }

  // ── Profile block (≤ 600 tok) ───────────────────────────────────────────
  const profileBlock = renderProfileProse(profile);

  // ── Past sessions block (≤ 1,500 tok, 3 sessions × 500 tok each) ───────
  let pastSessionsBlock = "";
  if (pastSummaries.length > 0) {
    pastSessionsBlock = pastSummaries
      .map((s, i) => `Session ${i + 1} (${s.created_at.slice(0, 10)}):\n${s.summary}`)
      .join("\n\n");
    // Trim to budget
    if (countTokens(pastSessionsBlock) > 1_500) {
      // Keep most recent sessions, truncate earliest
      let budget = 1_500;
      const kept: string[] = [];
      for (const s of pastSummaries) {
        const text = `${s.created_at.slice(0, 10)}:\n${s.summary}`;
        const toks = countTokens(text);
        if (budget >= toks) {
          kept.push(text);
          budget -= toks;
        }
      }
      pastSessionsBlock = kept.join("\n\n");
    }
  }

  // ── Active papers block (≤ 900 tok, up to 3 papers) ─────────────────────
  let activePapersBlock = "";
  if (activePapers.length > 0) {
    activePapersBlock = activePapers
      .map((p) => `"${p.title}" (arXiv:${p.ref_id})\n${p.digest}`)
      .join("\n\n");
    if (countTokens(activePapersBlock) > 900) {
      activePapersBlock = activePapersBlock.slice(0, 900 * 4);
    }
  }

  // ── Session summary block (≤ 400 tok) ────────────────────────────────────
  let sessionSummaryBlock = session?.running_summary ?? "";
  if (countTokens(sessionSummaryBlock) > 400) {
    sessionSummaryBlock = sessionSummaryBlock.slice(0, 400 * 4);
  }

  // ── Raw turns (≤ 4,000 tok, newest first) ────────────────────────────────
  // Take as many turns as fit, starting from most recent
  const allTurns = session?.messages ?? [];
  const fittingTurns: MessageTurn[] = [];
  let tokensSoFar = 0;

  for (let i = allTurns.length - 1; i >= 0; i--) {
    const turn = allTurns[i]!;
    const content = typeof turn.content === "string"
      ? turn.content
      : turn.content.map((b: any) => b.text ?? b.content ?? "").join("");
    const toks = countTokens(content) + 4;
    if (tokensSoFar + toks > RAW_TURNS_TOKEN_BUDGET) break;
    fittingTurns.unshift(turn);
    tokensSoFar += toks;
  }

  // ── Build system prompt ───────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(
    profileBlock,
    pastSessionsBlock,
    activePapersBlock,
    sessionSummaryBlock
  );

  return {
    systemPrompt,
    messages: fittingTurns,
    profileBlock,
    pastSessionsBlock,
    activePapersBlock,
    sessionSummaryBlock,
  };
}

function buildSystemPrompt(
  profileBlock: string,
  pastSessionsBlock: string,
  activePapersBlock: string,
  sessionSummaryBlock: string
): string {
  const sections: string[] = [
    `You are PaperPing, a research assistant that lives in iMessage. You help the user discover, understand, and remember academic papers.`,
  ];

  if (profileBlock && profileBlock !== "New user — no profile built yet.") {
    sections.push(`USER PROFILE:\n${profileBlock}`);
  }

  if (pastSessionsBlock) {
    sections.push(`RECENT SESSIONS:\n${pastSessionsBlock}`);
  }

  if (activePapersBlock) {
    sections.push(`ACTIVE PAPERS (recently fetched, in-context):\n${activePapersBlock}`);
  }

  if (sessionSummaryBlock) {
    sections.push(`THIS SESSION SO FAR:\n${sessionSummaryBlock}`);
  }

  sections.push(`STYLE:
- Concise. Max 2-3 short paragraphs per reply. Plain text, no markdown headers.
- Adapt formality and detail level to the user profile.
- When citing: "the [topic] paper (arXiv:XXXX.XXXXX)"
- When you don't know something, search rather than guess.

TOOL RULES:
- User asks about papers they've read → call search_library first.
- User asks about new/recent papers → call search_arxiv.
- User wants a specific paper by ID or URL → call fetch_paper.
- Discovery ("show me papers on X") → call search_arxiv, present numbered list, wait for user to pick. Resolve "fetch 2" from prior search results in history.
- User references "that paper", "it", "the first one" → resolve from active papers above.
- When subscribing → infer best arXiv category (e.g. "ML" → "cs.LG", "NLP" → "cs.CL").
- Never fabricate paper titles, authors, or findings.
- If a topic isn't in context, say so and offer to search.`);

  return sections.join("\n\n");
}

// ─── maybeCompress ────────────────────────────────────────────────────────────
// Called after every LLM response. Compresses oldest turns when budget is full.
export async function maybeCompress(sender: string): Promise<void> {
  const session = getSession(sender);
  if (!session) return;

  const turns = session.messages;
  const tokenCount = countTurnsTokens(turns);
  const shouldCompress = tokenCount > RAW_TURNS_TOKEN_BUDGET || turns.length > RAW_TURNS_MAX_COUNT;

  if (!shouldCompress) return;

  // Take oldest COMPRESS_OLDEST_N turns for compression
  const toCompress = turns.slice(0, COMPRESS_OLDEST_N);
  const remaining = turns.slice(COMPRESS_OLDEST_N);

  if (toCompress.length === 0) return;

  const oldTurnsText = toCompress
    .map((t) => {
      const content = typeof t.content === "string"
        ? t.content
        : t.content.map((b: any) => b.text ?? b.content ?? "").join("");
      return `${t.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");

  const existingSummary = session.running_summary;

  const compressionPrompt = existingSummary
    ? `Given this existing summary of the conversation:\n\n${existingSummary}\n\nAnd these ${toCompress.length} older turns:\n\n${oldTurnsText}\n\nProduce an updated running summary under 300 words. Preserve: key decisions, facts learned, papers discussed, open questions from the user. Discard: pleasantries, repeated clarifications, filler. Be dense and factual.`
    : `Summarize these ${toCompress.length} conversation turns in under 300 words. Preserve: key decisions, facts learned, papers discussed, open questions from the user. Discard: pleasantries, repeated clarifications, filler. Be dense and factual.\n\n${oldTurnsText}`;

  try {
    const newSummary = await callCheapLLM(compressionPrompt);
    upsertSession(sender, remaining, newSummary);
  } catch (err) {
    console.error(`[memory] compression failed: ${err}`);
    // On failure, just drop oldest turns rather than growing forever
    upsertSession(sender, remaining, existingSummary);
  }
}

// ─── endSession ──────────────────────────────────────────────────────────────
// Called when session TTL expires (idle > 60 min). Summarizes, updates profile, clears.
export async function endSession(sender: string): Promise<void> {
  const session = getSession(sender);
  if (!session) return;

  const turns = session.messages;
  if (turns.length === 0 && !session.running_summary) {
    clearSession(sender);
    return;
  }

  // Build full session content for summarization
  const recentTurnsText = turns
    .map((t) => {
      const content = typeof t.content === "string"
        ? t.content
        : t.content.map((b: any) => b.text ?? b.content ?? "").join("");
      return `${t.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");

  const fullContent = [
    session.running_summary ? `PREVIOUS SUMMARY:\n${session.running_summary}` : "",
    recentTurnsText ? `RECENT TURNS:\n${recentTurnsText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const summaryPrompt = `Generate a structured session summary from this conversation. Format exactly as:

TOPICS: [comma-separated topics that were actively researched or discussed]
PAPERS FETCHED: [list as "arXiv:ID — one-line description of what was learned", or "none"]
KEY FACTS: [new facts established about the user's situation or work, or "none"]
OPEN QUESTIONS: [things the user indicated wanting to follow up on, or "none"]
USER SIGNALS: [communication preferences, expertise shown, frustrations observed, or "none"]

Conversation:
${fullContent}`;

  let sessionSummary = "";
  try {
    sessionSummary = await callCheapLLM(summaryPrompt);
  } catch (err) {
    console.error(`[memory] endSession summary failed: ${err}`);
    sessionSummary = session.running_summary || "Session ended (summary unavailable).";
  }

  // Extract topics from summary for FTS indexing
  const topicsMatch = sessionSummary.match(/^TOPICS:\s*(.+)$/m);
  const topics = topicsMatch?.[1]?.trim() ?? "";

  const summaryId = storeSessionSummary(sender, sessionSummary, topics);

  // Embed summary for future semantic retrieval (non-critical, ignore failures)
  if (summaryId > 0) {
    try {
      const embedding = await getEmbedding(sessionSummary);
      if (embedding) storeSessionEmbedding(summaryId, embedding);
    } catch { /* Ollama not running — recency fallback handles it */ }
  }

  // Update user profile
  try {
    const profile = getUserProfile(sender);
    await extractProfileUpdates(sender, sessionSummary, profile);
  } catch (err) {
    console.error(`[memory] profile update failed: ${err}`);
  }

  clearSession(sender);
  clearActivePapers(sender);
}

// ─── extractProfileUpdates ────────────────────────────────────────────────────
// Extracts profile delta from session summary and merges into user profile.
export async function extractProfileUpdates(
  sender: string,
  sessionSummary: string,
  existingProfile: ScholarUserProfile
): Promise<void> {
  const profileProse = renderProfileProse(existingProfile);

  const profilePrompt = `Given this existing user profile:
${profileProse}

And this session summary:
${sessionSummary}

What should be updated in the user profile? Output a JSON object with ONLY the fields that changed. Use these exact field names:
- "primaryInterests": array of strings (update if discussed >2 turns)
- "secondaryInterests": array of strings
- "expertiseDomains": object mapping domain name to "novice"|"intermediate"|"expert"
- "preferredResponseLength": "concise"|"detailed"|"adaptive"
- "prefersExamples": boolean
- "formality": "casual"|"professional"
- "activeProjects": array of {name, description, lastMentioned} objects
- "knownFacts": array of {fact, confidence, lastConfirmed} objects
- "role": string
- "name": string

Rules:
- Only update fields with moderate-to-high confidence signals from THIS session.
- Do NOT speculate. Only include fields where the session clearly demonstrated change.
- For expertise: update only if the user demonstrated knowledge (asked deep questions, used jargon, self-stated).
- For interests: update only if discussed multiple turns OR user explicitly stated.
- If nothing changed for a field, omit it entirely.
- Output ONLY valid JSON, no explanation, no markdown.`;

  try {
    const deltaJson = await callCheapLLM(profilePrompt);
    // Strip markdown code fences if present
    const cleaned = deltaJson.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const delta = JSON.parse(cleaned) as Partial<ScholarUserProfile>;
    mergeProfileDelta(sender, { ...delta, sessionCount: 1 });
  } catch (err) {
    console.error(`[memory] profile delta parse failed: ${err}`);
    // Still bump session count even if parsing fails
    mergeProfileDelta(sender, { sessionCount: 1 });
  }
}

// ─── callCheapLLM ─────────────────────────────────────────────────────────────
// Thin wrapper — provider routing lives in llmClient.ts.
async function callCheapLLM(prompt: string): Promise<string> {
  return callSimpleText([{ role: "user", content: prompt }]);
}
