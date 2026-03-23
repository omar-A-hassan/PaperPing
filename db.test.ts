import { test, expect, beforeEach, describe } from "bun:test";
import {
  initDB,
  storePaper,
  queryMemory,
  addSubscription,
  removeSubscription,
  listSubscriptions,
  listRecentPapers,
  isAlreadyRead,
  getPaperByRefId,
  updateLastChecked,
  getBriefingLastSent,
  setBriefingLastSent,
  // Three-tier memory
  getSession,
  upsertSession,
  clearSession,
  getSessionLastActivity,
  storeSessionSummary,
  getRecentSessionSummaries,
  getUserProfile,
  saveUserProfile,
  mergeProfileDelta,
  pinPaper,
  getActivePapers,
  unpinPaper,
  clearActivePapers,
  getBriefingConfig,
  setBriefingConfig,
  recordSentGuid,
  isSentGuid,
} from "./db";

function samplePaper(
  overrides?: Partial<{
    type: string;
    ref_id: string;
    title: string;
    authors: string;
    digest: string;
    topics: string;
  }>
) {
  return {
    type: "arxiv",
    ref_id: "2301.00001",
    title: "Attention Is All You Need",
    authors: "Vaswani et al.",
    digest:
      "🔬 FOUND: Introduced the Transformer architecture.\n💡 MATTERS: Powers modern LLMs.\n⚠️ LIMIT: Quadratic attention complexity.",
    topics: "attention,transformer,efficiency",
    ...overrides,
  };
}

beforeEach(() => {
  initDB(":memory:");
});

describe("storePaper", () => {
  test("stores a paper and retrieves it via queryMemory", () => {
    storePaper(samplePaper());
    const results = queryMemory("attention");
    expect(results).toHaveLength(1);
    expect(results[0]!.ref_id).toBe("2301.00001");
  });

  test("INSERT OR IGNORE — duplicate ref_id results in 1 row", () => {
    storePaper(samplePaper());
    storePaper(samplePaper());
    const results = queryMemory("attention");
    expect(results).toHaveLength(1);
  });

  test("listRecentPapers returns newest first", () => {
    storePaper(samplePaper({ ref_id: "2301.00001", title: "Paper A" }));
    storePaper(samplePaper({ ref_id: "2301.00002", title: "Paper B" }));
    const papers = listRecentPapers(5);
    expect(papers[0]!.ref_id).toBe("2301.00002");
  });

  test("FTS index is populated after storePaper", () => {
    storePaper(samplePaper());
    // FTS should find the paper
    const results = queryMemory("transformer");
    expect(results).toHaveLength(1);
  });

  test("duplicate storePaper does not create duplicate FTS entry", () => {
    storePaper(samplePaper());
    storePaper(samplePaper()); // INSERT OR IGNORE — no FTS insert
    const results = queryMemory("attention");
    expect(results).toHaveLength(1);
  });
});

describe("queryMemory (FTS5)", () => {
  test("returns empty array for no match", () => {
    storePaper(samplePaper());
    expect(queryMemory("quantum")).toHaveLength(0);
  });

  test("matches on digest content", () => {
    storePaper(samplePaper());
    expect(queryMemory("Transformer")).toHaveLength(1);
  });

  test("matches on topics", () => {
    storePaper(samplePaper());
    expect(queryMemory("transformer")).toHaveLength(1);
  });

  test("multi-word query matches papers containing all terms", () => {
    storePaper(samplePaper({
      ref_id: "2301.00001",
      digest: "🔬 FOUND: state space models for sequence modeling.",
      topics: "state-space,sequence",
    }));
    storePaper(samplePaper({
      ref_id: "2301.00002",
      digest: "🔬 FOUND: attention mechanism for transformers.",
      topics: "attention,transformer",
    }));
    // Only the first paper has both "state" and "space"
    const results = queryMemory("state space");
    expect(results).toHaveLength(1);
    expect(results[0]!.ref_id).toBe("2301.00001");
  });

  test("porter stemming — 'efficient' matches 'efficiency'", () => {
    storePaper(samplePaper({ topics: "attention,transformer,efficiency" }));
    const results = queryMemory("efficient");
    expect(results).toHaveLength(1);
  });

  test("porter stemming — 'editing' matches 'edit'", () => {
    storePaper(samplePaper({
      digest: "🔬 FOUND: fast edit operations on sequences.",
      topics: "editing,sequence",
    }));
    const results = queryMemory("edit");
    expect(results).toHaveLength(1);
  });

  test("invalid FTS syntax returns empty array (no throw)", () => {
    storePaper(samplePaper());
    // Unbalanced quote is invalid FTS5 syntax
    expect(() => queryMemory("\"unclosed quote")).not.toThrow();
    expect(queryMemory("\"unclosed quote")).toHaveLength(0);
  });

  test("% and _ are treated as literal characters, not wildcards", () => {
    storePaper(samplePaper({ topics: "cs.LG", digest: "a cs.LG paper" }));
    // FTS5 tokenizes these — no wildcard expansion
    expect(queryMemory("c%LG")).toHaveLength(0);
    expect(queryMemory("c_LG")).toHaveLength(0);
  });
});

describe("subscriptions", () => {
  test("addSubscription stores a subscription", () => {
    addSubscription("cs.LG");
    expect(listSubscriptions()).toHaveLength(1);
  });

  test("INSERT OR IGNORE — duplicate topic results in 1 row", () => {
    addSubscription("cs.LG");
    addSubscription("cs.LG");
    expect(listSubscriptions()).toHaveLength(1);
  });

  test("removeSubscription returns true when found, false when not found", () => {
    addSubscription("cs.LG");
    expect(removeSubscription("cs.LG")).toBe(true);
    expect(removeSubscription("cs.LG")).toBe(false);
  });

  test("listSubscriptions returns all topics", () => {
    addSubscription("cs.LG");
    addSubscription("cs.CL");
    const subs = listSubscriptions();
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => s.topic)).toContain("cs.LG");
    expect(subs.map((s) => s.topic)).toContain("cs.CL");
  });

  test("updateLastChecked sets last_checked for a topic", () => {
    addSubscription("cs.LG");
    updateLastChecked("cs.LG");
    const subs = listSubscriptions();
    expect(subs[0]!.last_checked).not.toBeNull();
  });
});

describe("listRecentPapers", () => {
  test("withDigest=false does not include digest field", () => {
    storePaper(samplePaper());
    const papers = listRecentPapers(5, false);
    expect((papers[0] as any).digest).toBeUndefined();
  });

  test("withDigest=true includes digest field", () => {
    storePaper(samplePaper());
    const papers = listRecentPapers(5, true);
    expect((papers[0] as any).digest).toBeDefined();
    expect(typeof (papers[0] as any).digest).toBe("string");
  });
});

describe("getPaperByRefId", () => {
  test("returns paper when found", () => {
    storePaper(samplePaper());
    const paper = getPaperByRefId("2301.00001");
    expect(paper).not.toBeNull();
    expect(paper!.ref_id).toBe("2301.00001");
    expect(paper!.title).toBe("Attention Is All You Need");
    expect(paper!.digest).toContain("Transformer");
  });

  test("returns null when not found", () => {
    expect(getPaperByRefId("9999.99999")).toBeNull();
  });
});

describe("sent_guid echo guard", () => {
  test("isSentGuid returns false when not recorded", () => {
    expect(isSentGuid("nonexistent-guid")).toBe(false);
  });

  test("recordSentGuid + isSentGuid round-trip", () => {
    recordSentGuid("test-guid-abc");
    expect(isSentGuid("test-guid-abc")).toBe(true);
  });

  test("different GUIDs are independent", () => {
    recordSentGuid("guid-1");
    expect(isSentGuid("guid-1")).toBe(true);
    expect(isSentGuid("guid-2")).toBe(false);
  });
});

describe("briefingLastSent", () => {
  test("getBriefingLastSent returns null when unset", () => {
    expect(getBriefingLastSent()).toBeNull();
  });

  test("setBriefingLastSent + getBriefingLastSent round-trip", () => {
    setBriefingLastSent("2026-03-23");
    expect(getBriefingLastSent()).toBe("2026-03-23");
  });
});

describe("sessions (Tier 1 working memory)", () => {
  test("getSession returns null when no session exists", () => {
    expect(getSession("+1234567890")).toBeNull();
  });

  test("upsertSession + getSession round-trip", () => {
    const msgs = [
      { role: "user" as const, content: "What is attention?" },
      { role: "assistant" as const, content: "Attention is a mechanism..." },
    ];
    upsertSession("+1234567890", msgs);
    const session = getSession("+1234567890");
    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(2);
    expect(session!.messages[0]!.role).toBe("user");
    expect(session!.messages[0]!.content).toBe("What is attention?");
    expect(session!.running_summary).toBe("");
  });

  test("upsertSession with running_summary persists summary", () => {
    upsertSession("+1234567890", [], "This session was about transformers.");
    const session = getSession("+1234567890");
    expect(session!.running_summary).toBe("This session was about transformers.");
  });

  test("upsertSession preserves running_summary when not provided", () => {
    upsertSession("+1234567890", [], "Initial summary.");
    upsertSession("+1234567890", [{ role: "user", content: "hi" }]);
    const session = getSession("+1234567890");
    expect(session!.running_summary).toBe("Initial summary.");
  });

  test("clearSession resets messages and summary", () => {
    upsertSession("+1234567890", [{ role: "user", content: "hi" }], "Some summary");
    clearSession("+1234567890");
    const session = getSession("+1234567890");
    expect(session!.messages).toHaveLength(0);
    expect(session!.running_summary).toBe("");
  });

  test("getSessionLastActivity returns updated_at", () => {
    upsertSession("+1234567890", []);
    const activity = getSessionLastActivity("+1234567890");
    expect(activity).not.toBeNull();
    expect(new Date(activity!).getTime()).toBeGreaterThan(0);
  });

  test("different senders have independent sessions", () => {
    upsertSession("+1111111111", [{ role: "user", content: "hello from 1" }]);
    upsertSession("+2222222222", [{ role: "user", content: "hello from 2" }]);
    const s1 = getSession("+1111111111");
    const s2 = getSession("+2222222222");
    expect((s1!.messages[0]!.content as string)).toBe("hello from 1");
    expect((s2!.messages[0]!.content as string)).toBe("hello from 2");
  });

  test("sessions are empty after re-init (new in-memory DB)", () => {
    upsertSession("+1234567890", [{ role: "user", content: "hello" }]);
    initDB(":memory:");
    expect(getSession("+1234567890")).toBeNull();
  });
});

describe("session_summaries (Tier 2 episodic memory)", () => {
  test("getRecentSessionSummaries returns empty when none stored", () => {
    expect(getRecentSessionSummaries("+1234567890")).toHaveLength(0);
  });

  test("storeSessionSummary + getRecentSessionSummaries round-trip", () => {
    storeSessionSummary("+1234567890", "Discussed Mamba paper.", "mamba,ssm");
    const summaries = getRecentSessionSummaries("+1234567890");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.summary).toBe("Discussed Mamba paper.");
  });

  test("getRecentSessionSummaries returns newest first", () => {
    storeSessionSummary("+1234567890", "Session 1", "topic1");
    storeSessionSummary("+1234567890", "Session 2", "topic2");
    const summaries = getRecentSessionSummaries("+1234567890", 3);
    expect(summaries[0]!.summary).toBe("Session 2");
  });

  test("getRecentSessionSummaries respects limit", () => {
    for (let i = 0; i < 5; i++) {
      storeSessionSummary("+1234567890", `Session ${i}`, `topic${i}`);
    }
    expect(getRecentSessionSummaries("+1234567890", 3)).toHaveLength(3);
  });
});

describe("user_profiles (Tier 3 semantic memory)", () => {
  test("getUserProfile returns default profile for new sender", () => {
    const profile = getUserProfile("+1234567890");
    expect(profile.primaryInterests).toEqual([]);
    expect(profile.sessionCount).toBe(0);
  });

  test("saveUserProfile + getUserProfile round-trip", () => {
    const profile = getUserProfile("+1234567890");
    profile.primaryInterests = ["transformers", "attention"];
    profile.sessionCount = 3;
    saveUserProfile("+1234567890", profile);
    const loaded = getUserProfile("+1234567890");
    expect(loaded.primaryInterests).toContain("transformers");
    expect(loaded.sessionCount).toBe(3);
  });

  test("mergeProfileDelta merges arrays and counts sessions", () => {
    mergeProfileDelta("+1234567890", {
      primaryInterests: ["mamba", "ssm"],
      sessionCount: 1,
    });
    const profile = getUserProfile("+1234567890");
    expect(profile.primaryInterests).toContain("mamba");
    expect(profile.sessionCount).toBe(1);
  });

  test("mergeProfileDelta merges expertiseDomains additively", () => {
    mergeProfileDelta("+1234567890", { expertiseDomains: { "deep learning": "expert" } });
    mergeProfileDelta("+1234567890", { expertiseDomains: { "distributed systems": "intermediate" } });
    const profile = getUserProfile("+1234567890");
    expect(profile.expertiseDomains["deep learning"]).toBe("expert");
    expect(profile.expertiseDomains["distributed systems"]).toBe("intermediate");
  });
});

describe("active_papers (pinned context)", () => {
  test("getActivePapers returns empty when none pinned", () => {
    expect(getActivePapers("+1234567890")).toHaveLength(0);
  });

  test("pinPaper + getActivePapers round-trip", () => {
    pinPaper("+1234567890", "2301.00001", "Paper A", "digest A");
    const papers = getActivePapers("+1234567890");
    expect(papers).toHaveLength(1);
    expect(papers[0]!.ref_id).toBe("2301.00001");
  });

  test("pinPaper evicts oldest when over MAX (3)", () => {
    pinPaper("+1234567890", "2301.00001", "Paper 1", "d1");
    pinPaper("+1234567890", "2301.00002", "Paper 2", "d2");
    pinPaper("+1234567890", "2301.00003", "Paper 3", "d3");
    pinPaper("+1234567890", "2301.00004", "Paper 4", "d4"); // should evict oldest
    const papers = getActivePapers("+1234567890");
    expect(papers).toHaveLength(3);
    // Most recent 3 should be kept
    const ids = papers.map((p) => p.ref_id);
    expect(ids).not.toContain("2301.00001");
    expect(ids).toContain("2301.00004");
  });

  test("unpinPaper removes specific paper", () => {
    pinPaper("+1234567890", "2301.00001", "Paper 1", "d1");
    pinPaper("+1234567890", "2301.00002", "Paper 2", "d2");
    unpinPaper("+1234567890", "2301.00001");
    const papers = getActivePapers("+1234567890");
    expect(papers).toHaveLength(1);
    expect(papers[0]!.ref_id).toBe("2301.00002");
  });

  test("clearActivePapers removes all for sender", () => {
    pinPaper("+1234567890", "2301.00001", "Paper 1", "d1");
    clearActivePapers("+1234567890");
    expect(getActivePapers("+1234567890")).toHaveLength(0);
  });
});

describe("briefingConfig", () => {
  test("getBriefingConfig returns defaults when unset", () => {
    const config = getBriefingConfig("+1234567890");
    expect(config.hour).toBe(7);
    expect(config.minute).toBe(0);
    expect(config.paper_count).toBe(5);
  });

  test("setBriefingConfig + getBriefingConfig round-trip", () => {
    setBriefingConfig("+1234567890", { hour: 9, paper_count: 10 });
    const config = getBriefingConfig("+1234567890");
    expect(config.hour).toBe(9);
    expect(config.minute).toBe(0); // unchanged
    expect(config.paper_count).toBe(10);
  });

  test("setBriefingConfig partial update preserves other fields", () => {
    setBriefingConfig("+1234567890", { hour: 8, minute: 30, paper_count: 7 });
    setBriefingConfig("+1234567890", { hour: 6 });
    const config = getBriefingConfig("+1234567890");
    expect(config.hour).toBe(6);
    expect(config.minute).toBe(30); // preserved
    expect(config.paper_count).toBe(7); // preserved
  });
});
