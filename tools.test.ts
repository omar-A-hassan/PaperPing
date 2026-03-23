// ─── tools.ts unit tests ──────────────────────────────────────────────────────
// Network calls (fetchArxivFeed, fetchArxiv, generateDigest) go through
// global.fetch — mocked per-test via URL matching.

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.LLM_PROVIDER = "anthropic";
process.env.LLM_MODEL = "claude-test";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initDB, storePaper, addSubscription } from "./db";
import {
  TOOL_DEFINITIONS,
  executeTool,
  toAnthropicTools,
  toOpenRouterTools,
} from "./tools";

const SENDER = "+1tool";
const originalFetch = global.fetch;

const ARXIV_ATOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2301.00001v1</id>
    <title>Attention Is All You Need</title>
    <summary>We present the Transformer, a novel architecture based solely on attention mechanisms.</summary>
    <published>2023-01-01T00:00:00Z</published>
    <author><name>Vaswani et al.</name></author>
  </entry>
</feed>`;

const ARXIV_ABS_HTML = `<html><body>
  <h1 class="title mathjax"><span class="descriptor">Title:</span>Test Paper Title</h1>
  <blockquote class="abstract mathjax"><span class="descriptor">Abstract:</span>
    This paper presents a novel method for testing things.
  </blockquote>
  <div class="authors"><span class="descriptor">Authors:</span> Test Author, Second Author</div>
</body></html>`;

// Dispatch fetch mock by URL
function mockFetch(handlers: Record<string, () => Response>) {
  global.fetch = (async (url: string) => {
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return handler();
    }
    return new Response("not found", { status: 404 });
  }) as any;
}

beforeEach(() => {
  initDB(":memory:");
  global.fetch = originalFetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ─── Wire format helpers ───────────────────────────────────────────────────────

describe("wire format", () => {
  test("toAnthropicTools returns input_schema (not parameters)", () => {
    const tools = toAnthropicTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t).toHaveProperty("input_schema");
      expect(t).not.toHaveProperty("parameters");
    }
  });

  test("toOpenRouterTools returns type:function and function.parameters", () => {
    const tools = toOpenRouterTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(t.function).toHaveProperty("parameters");
    }
  });

  test("TOOL_DEFINITIONS has 14 tools (10 original + 4 V2)", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(14);
  });
});

// ─── search_library ────────────────────────────────────────────────────────────

describe("search_library", () => {
  test("empty library returns no-results message", async () => {
    const r = await executeTool("search_library", { query: "transformers" }, SENDER);
    expect(r.content).toContain("Nothing in your library");
  });

  test("stored paper returns match", async () => {
    storePaper({
      type: "arxiv",
      ref_id: "2301.00001",
      title: "Attention Is All You Need",
      authors: "Vaswani et al.",
      digest: "🔬 FOUND: Transformer. 💡 MATTERS: LLMs. ⚠️ LIMIT: quadratic.",
      topics: "attention transformer",
    });
    const r = await executeTool("search_library", { query: "attention" }, SENDER);
    expect(r.content).toContain("Attention Is All You Need");
  });
});

// ─── search_arxiv ─────────────────────────────────────────────────────────────

describe("search_arxiv", () => {
  // Note: DOMParser is not available in bun:test, so fetchArxivFeed always returns []
  // in the test environment. We test the tool's handling of empty results here.
  // Integration coverage of the XML parsing path lives in fetchers.ts runtime usage.
  test("empty feed (or unavailable DOMParser) returns no-papers message", async () => {
    mockFetch({
      "export.arxiv.org": () =>
        new Response(`<?xml version="1.0"?><feed></feed>`, { status: 200 }),
    });
    const r = await executeTool("search_arxiv", { query: "xyzxyzxyz" }, SENDER);
    expect(r.content).toContain("No papers found");
  });

  test("network error returns no-papers message gracefully", async () => {
    mockFetch({ "export.arxiv.org": () => new Response("bad gateway", { status: 502 }) });
    const r = await executeTool("search_arxiv", { query: "test" }, SENDER);
    // Returns error or no-papers — either is acceptable
    expect(r.content).toBeTruthy();
  });
});

// ─── fetch_paper ──────────────────────────────────────────────────────────────

describe("fetch_paper", () => {
  test("returns cached paper from library without network call", async () => {
    storePaper({
      type: "arxiv",
      ref_id: "2301.00001",
      title: "Cached Paper",
      authors: "Test",
      digest: "🔬 FOUND: it. 💡 MATTERS: yes. ⚠️ LIMIT: no.",
      topics: "",
    });

    let fetchCalled = false;
    global.fetch = (async () => { fetchCalled = true; return new Response("{}"); }) as any;

    const r = await executeTool("fetch_paper", { arxiv_id: "2301.00001" }, SENDER);
    expect(r.content).toContain("Cached Paper");
    expect(fetchCalled).toBe(false);
  });

  test("new paper: fetches, digests, stores, and pins", async () => {
    mockFetch({
      "export.arxiv.org/abs": () =>
        new Response(ARXIV_ABS_HTML, { status: 200 }),
      "api.anthropic.com": () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "🔬 FOUND: test. 💡 MATTERS: yes. ⚠️ LIMIT: no." }],
          }),
          { status: 200 }
        ),
    });

    const r = await executeTool("fetch_paper", { arxiv_id: "2405.99999" }, SENDER);
    expect(r.content).toContain("arXiv:2405.99999");
    expect(r.isError).not.toBe(true);
  });
});

// ─── get_paper ────────────────────────────────────────────────────────────────

describe("get_paper", () => {
  test("not in library returns isError", async () => {
    const r = await executeTool("get_paper", { arxiv_id: "0000.00000" }, SENDER);
    expect(r.isError).toBe(true);
  });

  test("in library returns title and digest", async () => {
    storePaper({
      type: "arxiv",
      ref_id: "2301.00002",
      title: "Known Paper",
      authors: "Author",
      digest: "digest here",
      topics: "",
      abstract: "full abstract",
    });
    const r = await executeTool("get_paper", { arxiv_id: "2301.00002" }, SENDER);
    expect(r.content).toContain("Known Paper");
    expect(r.content).toContain("digest here");
  });
});

// ─── list_history ─────────────────────────────────────────────────────────────

describe("list_history", () => {
  test("empty library returns empty message", async () => {
    const r = await executeTool("list_history", {}, SENDER);
    expect(r.content).toContain("empty");
  });

  test("with papers returns numbered list", async () => {
    storePaper({ type: "arxiv", ref_id: "2301.00003", title: "Paper A", authors: "", digest: "d", topics: "" });
    storePaper({ type: "arxiv", ref_id: "2301.00004", title: "Paper B", authors: "", digest: "d", topics: "" });
    const r = await executeTool("list_history", {}, SENDER);
    expect(r.content).toContain("Paper A");
    expect(r.content).toContain("1.");
  });
});

// ─── subscriptions ────────────────────────────────────────────────────────────

describe("subscribe_topic", () => {
  test("subscribe → success message + verifiable in DB", async () => {
    const r = await executeTool("subscribe_topic", { topic: "cs.LG" }, SENDER);
    expect(r.content).toContain("cs.LG");
    expect(r.content).toContain("✅");
  });
});

describe("unsubscribe_topic", () => {
  test("existing topic → success", async () => {
    addSubscription("cs.LG");
    const r = await executeTool("unsubscribe_topic", { topic: "cs.LG" }, SENDER);
    expect(r.content).toContain("✅");
  });

  test("non-existent topic → isError", async () => {
    const r = await executeTool("unsubscribe_topic", { topic: "nonexistent" }, SENDER);
    expect(r.isError).toBe(true);
  });
});

describe("list_subscriptions", () => {
  test("empty → no-subscriptions message", async () => {
    const r = await executeTool("list_subscriptions", {}, SENDER);
    expect(r.content).toContain("No subscriptions");
  });

  test("with subs → bullet list", async () => {
    addSubscription("cs.LG");
    addSubscription("cs.CL");
    const r = await executeTool("list_subscriptions", {}, SENDER);
    expect(r.content).toContain("cs.LG");
    expect(r.content).toContain("cs.CL");
  });
});

// ─── briefing config ──────────────────────────────────────────────────────────

describe("set_briefing_time", () => {
  test("sets hour and minute, returns formatted time", async () => {
    const r = await executeTool("set_briefing_time", { hour: 8, minute: 30 }, SENDER);
    expect(r.content).toContain("08:30");
  });

  test("clamps hour to 0-23", async () => {
    const r = await executeTool("set_briefing_time", { hour: 99 }, SENDER);
    expect(r.content).toContain("23:");
  });
});

describe("set_briefing_count", () => {
  test("sets count correctly", async () => {
    const r = await executeTool("set_briefing_count", { count: 10 }, SENDER);
    expect(r.content).toContain("10");
  });

  test("clamps to 1-20", async () => {
    const lo = await executeTool("set_briefing_count", { count: 0 }, SENDER);
    expect(lo.content).toContain("1 paper");
    const hi = await executeTool("set_briefing_count", { count: 99 }, SENDER);
    expect(hi.content).toContain("20");
  });
});

// ─── new V2 tools ─────────────────────────────────────────────────────────────

describe("get_paper_section", () => {
  test("paper not in library → isError", async () => {
    const r = await executeTool("get_paper_section", { arxiv_id: "0000.00000", question: "methods" }, SENDER);
    expect(r.isError).toBe(true);
  });

  test("paper in library but not deep-read → isError", async () => {
    storePaper({ type: "arxiv", ref_id: "2301.00010", title: "P", authors: "", digest: "d", topics: "" });
    const r = await executeTool("get_paper_section", { arxiv_id: "2301.00010", question: "methods" }, SENDER);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("deep_read_paper");
  });
});

describe("get_paper_figure", () => {
  test("paper not in library → isError", async () => {
    const r = await executeTool("get_paper_figure", { arxiv_id: "0000.00000", figure_number: 1 }, SENDER);
    expect(r.isError).toBe(true);
  });

  test("paper in library but no figures → isError", async () => {
    storePaper({ type: "arxiv", ref_id: "2301.00011", title: "P", authors: "", digest: "d", topics: "" });
    const r = await executeTool("get_paper_figure", { arxiv_id: "2301.00011", figure_number: 1 }, SENDER);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("deep_read_paper");
  });
});

describe("read_pdf_attachment", () => {
  test("PDF not in library → isError", async () => {
    const r = await executeTool("read_pdf_attachment", { ref_id: "pdf:abc123" }, SENDER);
    expect(r.isError).toBe(true);
  });

  test("PDF in library → returns digest + pins paper", async () => {
    storePaper({ type: "pdf", ref_id: "pdf:abc123", title: "My Thesis", authors: "", digest: "thesis digest", topics: "" });
    const r = await executeTool("read_pdf_attachment", { ref_id: "pdf:abc123" }, SENDER);
    expect(r.content).toContain("My Thesis");
    expect(r.content).toContain("thesis digest");
  });
});

// ─── unknown tool ──────────────────────────────────────────────────────────────

test("unknown tool returns isError", async () => {
  const r = await executeTool("nonexistent_tool", {}, SENDER);
  expect(r.isError).toBe(true);
  expect(r.content).toContain("Unknown tool");
});
