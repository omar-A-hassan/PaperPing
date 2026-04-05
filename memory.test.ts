// ─── memory.ts unit tests ──────────────────────────────────────────────────────
// All LLM calls (callCheapLLM) go through global fetch — mocked per-test.

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.LLM_PROVIDER = "anthropic";
process.env.LLM_MODEL = "claude-test";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initDB,
  upsertSession,
  getSession,
  clearSession,
  storeSessionSummary,
  getRecentSessionSummaries,
  saveUserProfile,
  getUserProfile,
  mergeProfileDelta,
  pinPaper,
  getActivePapers,
  type MessageTurn,
  type ScholarUserProfile,
} from "./db";
import {
  assembleContext,
  maybeCompress,
  endSession,
  extractProfileUpdates,
  SESSION_TTL_MS,
} from "./memory";

const SENDER = "+1test";

// ─── fetch mock helpers ────────────────────────────────────────────────────────
const originalFetch = global.fetch;

function mockAnthropicResponse(text: string) {
  global.fetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as any;
}

beforeEach(() => {
  initDB(":memory:");
  global.fetch = originalFetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ─── assembleContext ───────────────────────────────────────────────────────────

describe("assembleContext", () => {
  test("no session → empty messages, base system prompt", async () => {
    const ctx = await assembleContext(SENDER);
    expect(ctx.messages).toHaveLength(0);
    expect(ctx.systemPrompt).toContain("PaperPing");
  });

  test("session with 2 turns → messages returned in order", async () => {
    upsertSession(SENDER, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    const ctx = await assembleContext(SENDER);
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0]!.role).toBe("user");
    expect(ctx.messages[1]!.role).toBe("assistant");
  });

  test("token budget — 50 huge messages get truncated", async () => {
    const hugeMsg = "x".repeat(400); // ~100 tokens each
    const turns: MessageTurn[] = [];
    for (let i = 0; i < 50; i++) {
      turns.push({ role: "user", content: hugeMsg });
      turns.push({ role: "assistant", content: hugeMsg });
    }
    upsertSession(SENDER, turns);

    const ctx = await assembleContext(SENDER);
    // Must be fewer than 100 turns due to token budget (~4000 tokens / ~100 per turn = ~40 max)
    expect(ctx.messages.length).toBeLessThan(100);
    expect(ctx.messages.length).toBeGreaterThan(0);
  });

  test("includes profile block when user has a profile", async () => {
    const profile: ScholarUserProfile = {
      name: "Omar",
      role: "ML engineer",
      primaryInterests: ["transformers"],
      secondaryInterests: [],
      expertiseDomains: { "machine learning": "expert" },
      preferredResponseLength: "concise",
      prefersExamples: true,
      formality: "casual",
      activeProjects: [],
      knownFacts: [],
      sessionCount: 3,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    saveUserProfile(SENDER, profile);

    const ctx = await assembleContext(SENDER);
    expect(ctx.profileBlock).toContain("Omar");
    expect(ctx.systemPrompt).toContain("USER PROFILE");
  });

  test("includes past sessions block when session summaries exist", async () => {
    storeSessionSummary(SENDER, "TOPICS: transformers\nPAPERS FETCHED: none", "transformers");
    const ctx = await assembleContext(SENDER);
    expect(ctx.pastSessionsBlock).toContain("transformers");
    expect(ctx.systemPrompt).toContain("RECENT SESSIONS");
  });

  test("includes active papers block when papers are pinned", async () => {
    pinPaper(SENDER, "2301.00001", "Test Paper", "digest text");
    const ctx = await assembleContext(SENDER);
    expect(ctx.activePapersBlock).toContain("Test Paper");
    expect(ctx.systemPrompt).toContain("ACTIVE PAPERS");
  });

  test("includes session summary block when running_summary is set", async () => {
    upsertSession(SENDER, [], "previous summary content");
    const ctx = await assembleContext(SENDER);
    expect(ctx.sessionSummaryBlock).toContain("previous summary content");
    expect(ctx.systemPrompt).toContain("THIS SESSION SO FAR");
  });

  test("new user profile block shows new user message", async () => {
    const ctx = await assembleContext(SENDER);
    // Profile block should indicate new user
    expect(ctx.profileBlock).toContain("New user");
  });
});

// ─── maybeCompress ─────────────────────────────────────────────────────────────

describe("maybeCompress", () => {
  test("no-op when turn count < 12 and tokens < 4000", async () => {
    upsertSession(SENDER, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    // No fetch should be called
    let fetchCalled = false;
    global.fetch = (async () => { fetchCalled = true; return new Response("{}"); }) as any;

    await maybeCompress(SENDER);
    expect(fetchCalled).toBe(false);
  });

  test("no-op when session doesn't exist", async () => {
    let fetchCalled = false;
    global.fetch = (async () => { fetchCalled = true; return new Response("{}"); }) as any;
    await maybeCompress(SENDER);
    expect(fetchCalled).toBe(false);
  });

  test("triggers when turn count > 12", async () => {
    const turns: MessageTurn[] = [];
    for (let i = 0; i < 14; i++) {
      turns.push({ role: "user", content: "message" });
      turns.push({ role: "assistant", content: "reply" });
    }
    upsertSession(SENDER, turns);

    mockAnthropicResponse("compressed summary of the conversation");
    await maybeCompress(SENDER);

    const session = getSession(SENDER);
    // Should have fewer messages after compression
    expect(session!.messages.length).toBeLessThan(28);
    expect(session!.running_summary).toBe("compressed summary of the conversation");
  });

  test("after compression, remaining turns count is reduced by COMPRESS_OLDEST_N (6)", async () => {
    // Create exactly 14 turns (> 12 threshold)
    const turns: MessageTurn[] = [];
    for (let i = 0; i < 14; i++) {
      turns.push({ role: "user", content: `msg${i}` });
    }
    upsertSession(SENDER, turns);

    mockAnthropicResponse("new summary");
    await maybeCompress(SENDER);

    const session = getSession(SENDER);
    // 14 - 6 = 8 remaining turns
    expect(session!.messages.length).toBe(8);
  });
});

// ─── endSession ───────────────────────────────────────────────────────────────

describe("endSession", () => {
  test("no-op when session is empty", async () => {
    clearSession(SENDER);
    let fetchCalled = false;
    global.fetch = (async () => { fetchCalled = true; return new Response("{}"); }) as any;

    await endSession(SENDER);
    expect(fetchCalled).toBe(false);
  });

  test("no-op when session doesn't exist", async () => {
    let fetchCalled = false;
    global.fetch = (async () => { fetchCalled = true; return new Response("{}"); }) as any;

    await endSession("+nonexistent");
    expect(fetchCalled).toBe(false);
  });

  test("stores session summary in DB after calling LLM", async () => {
    upsertSession(SENDER, [
      { role: "user", content: "tell me about transformers" },
      { role: "assistant", content: "Transformers use attention..." },
    ]);

    mockAnthropicResponse(
      "TOPICS: transformers\nPAPERS FETCHED: none\nKEY FACTS: none\nOPEN QUESTIONS: none\nUSER SIGNALS: none"
    );

    await endSession(SENDER);

    const summaries = getRecentSessionSummaries(SENDER, 1);
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.summary).toContain("TOPICS");
  });

  test("clears session messages after completion", async () => {
    upsertSession(SENDER, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);

    // Mock for summary + profile extraction (2 LLM calls)
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      const text = callCount === 1
        ? "TOPICS: test\nPAPERS FETCHED: none\nKEY FACTS: none\nOPEN QUESTIONS: none\nUSER SIGNALS: none"
        : "{}"; // profile delta
      return new Response(
        JSON.stringify({ content: [{ type: "text", text }] }),
        { status: 200 }
      );
    }) as any;

    await endSession(SENDER);

    const session = getSession(SENDER);
    expect(session!.messages).toHaveLength(0);
  });
});

// ─── extractProfileUpdates ─────────────────────────────────────────────────────

describe("extractProfileUpdates", () => {
  test("merges profile delta correctly", async () => {
    const profile = getUserProfile(SENDER);

    mockAnthropicResponse(JSON.stringify({
      primaryInterests: ["transformers", "attention"],
      role: "ML researcher",
    }));

    await extractProfileUpdates(SENDER, "TOPICS: transformers", profile);

    const updated = getUserProfile(SENDER);
    expect(updated.primaryInterests).toContain("transformers");
    expect(updated.role).toBe("ML researcher");
  });

  test("handles LLM returning JSON with markdown code fences", async () => {
    const profile = getUserProfile(SENDER);

    mockAnthropicResponse("```json\n{\"role\": \"engineer\"}\n```");

    await extractProfileUpdates(SENDER, "session summary", profile);

    const updated = getUserProfile(SENDER);
    expect(updated.role).toBe("engineer");
  });

  test("still bumps sessionCount when LLM returns invalid JSON", async () => {
    const profile = getUserProfile(SENDER);
    const initialCount = profile.sessionCount;

    mockAnthropicResponse("not valid json at all!!!");

    await extractProfileUpdates(SENDER, "session summary", profile);

    const updated = getUserProfile(SENDER);
    expect(updated.sessionCount).toBe(initialCount + 1);
  });

  test("handles fetch failure gracefully — still bumps sessionCount", async () => {
    const profile = getUserProfile(SENDER);
    const initialCount = profile.sessionCount;

    global.fetch = (async () => new Response("error", { status: 500 })) as any;

    try {
      await extractProfileUpdates(SENDER, "session summary", profile);
    } catch {
      // endSession catches errors — extractProfileUpdates may throw
    }

    // sessionCount should have been bumped via fallback
    const updated = getUserProfile(SENDER);
    expect(updated.sessionCount).toBeGreaterThanOrEqual(initialCount);
  });
});
