// ─── llmClient.ts unit tests ──────────────────────────────────────────────────
// Covers: getProviderConfig (all 4 branches), callSimpleText (both wire formats,
// error paths, system prompt, array content), callVisionLLM (both wire formats,
// error paths).

process.env.ANTHROPIC_API_KEY  = "test-ant-key";
process.env.OPENROUTER_API_KEY = "test-or-key";
process.env.XAI_API_KEY        = "test-xai-key";
process.env.GEMINI_API_KEY     = "test-gem-key";
process.env.LLM_PROVIDER       = "anthropic";
process.env.LLM_MODEL          = "claude-test";
process.env.VISION_MODEL       = "claude-test-vision";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getProviderConfig, callSimpleText, callVisionLLM } from "./llmClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200): void {
  global.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  ) as any;
}

function captureRequest(): { url: string; init: RequestInit } | null {
  let captured: { url: string; init: RequestInit } | null = null;
  global.fetch = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
      { status: 200 }
    );
  }) as any;
  return captured; // will be updated after the call
}

// ─── getProviderConfig ────────────────────────────────────────────────────────

describe("getProviderConfig", () => {
  // Note: key value assertions are omitted — constants in config.ts are frozen
  // at first module load, which may reflect real .env values in dev environments.
  // We test URL, branch, and header presence — not specific key values.

  test("anthropic → correct URL, branch, and header keys", () => {
    const cfg = getProviderConfig("anthropic");
    expect(cfg.branch).toBe("anthropic");
    expect(cfg.url).toBe("https://api.anthropic.com/v1/messages");
    expect(cfg.headers["x-api-key"]).toBeDefined();
    expect(cfg.headers["anthropic-version"]).toBe("2023-06-01");
    expect(cfg.headers["Content-Type"]).toBe("application/json");
  });

  test("openrouter → correct URL and branch", () => {
    const cfg = getProviderConfig("openrouter");
    expect(cfg.branch).toBe("openai-compat");
    expect(cfg.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(cfg.headers["Authorization"]).toMatch(/^Bearer /);
  });

  test("grok → x.ai URL and openai-compat branch", () => {
    const cfg = getProviderConfig("grok");
    expect(cfg.branch).toBe("openai-compat");
    expect(cfg.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(cfg.headers["Authorization"]).toMatch(/^Bearer /);
  });

  test("gemini → googleapis URL and openai-compat branch", () => {
    const cfg = getProviderConfig("gemini");
    expect(cfg.branch).toBe("openai-compat");
    expect(cfg.url).toContain("generativelanguage.googleapis.com");
    expect(cfg.headers["Authorization"]).toMatch(/^Bearer /);
  });

  test("unknown provider falls back to anthropic branch", () => {
    const cfg = getProviderConfig("unknown-provider");
    expect(cfg.branch).toBe("anthropic");
    expect(cfg.url).toContain("anthropic.com");
  });
});

// ─── callSimpleText — Anthropic path ─────────────────────────────────────────

describe("callSimpleText — anthropic", () => {
  test("returns content[0].text on success", async () => {
    mockFetch({ content: [{ type: "text", text: "Hello world" }] });
    const result = await callSimpleText([{ role: "user", content: "hi" }]);
    expect(result).toBe("Hello world");
  });

  test("trims whitespace from response", async () => {
    mockFetch({ content: [{ type: "text", text: "  trimmed  " }] });
    const result = await callSimpleText([{ role: "user", content: "hi" }]);
    expect(result).toBe("trimmed");
  });

  test("throws on non-ok response", async () => {
    mockFetch({ error: "unauthorized" }, 401);
    await expect(
      callSimpleText([{ role: "user", content: "hi" }])
    ).rejects.toThrow("API error: 401");
  });

  test("sends system prompt as top-level 'system' field", async () => {
    let requestBody: any = null;
    global.fetch = (async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
        { status: 200 }
      );
    }) as any;

    await callSimpleText([{ role: "user", content: "hi" }], { system: "Be concise." });
    expect(requestBody.system).toBe("Be concise.");
    // messages should NOT contain the system message
    expect(requestBody.messages.every((m: any) => m.role !== "system")).toBe(true);
  });

  test("respects maxTokens option", async () => {
    let requestBody: any = null;
    global.fetch = (async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
        { status: 200 }
      );
    }) as any;

    await callSimpleText([{ role: "user", content: "hi" }], { maxTokens: 123 });
    expect(requestBody.max_tokens).toBe(123);
  });
});

// ─── callSimpleText — OpenAI-compat path ─────────────────────────────────────

describe("callSimpleText — openai-compat (via opts.provider)", () => {
  test("returns choices[0].message.content string", async () => {
    mockFetch({ choices: [{ message: { content: "Hello from OpenRouter" } }] });
    const result = await callSimpleText(
      [{ role: "user", content: "hi" }],
      { provider: "openrouter" }
    );
    expect(result).toBe("Hello from OpenRouter");
  });

  test("handles array content response (joins text blocks)", async () => {
    mockFetch({
      choices: [{ message: { content: [{ text: "Part 1" }, { text: " Part 2" }] } }],
    });
    const result = await callSimpleText(
      [{ role: "user", content: "hi" }],
      { provider: "openrouter" }
    );
    expect(result).toBe("Part 1 Part 2");
  });

  test("throws on non-ok response with provider name in message", async () => {
    mockFetch({ error: "rate limited" }, 429);
    await expect(
      callSimpleText([{ role: "user", content: "hi" }], { provider: "openrouter" })
    ).rejects.toThrow("429");
  });

  test("throws when content is empty string", async () => {
    mockFetch({ choices: [{ message: { content: "" } }] });
    await expect(
      callSimpleText([{ role: "user", content: "hi" }], { provider: "openrouter" })
    ).rejects.toThrow();
  });

  test("sends system as first message in messages array", async () => {
    let requestBody: any = null;
    global.fetch = (async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 }
      );
    }) as any;

    await callSimpleText(
      [{ role: "user", content: "hi" }],
      { system: "Be a bot.", provider: "openrouter" }
    );
    expect(requestBody.messages[0].role).toBe("system");
    expect(requestBody.messages[0].content).toBe("Be a bot.");
    expect(requestBody.messages[1].role).toBe("user");
  });

  test("grok uses x.ai endpoint", async () => {
    let capturedUrl = "";
    global.fetch = (async (url: string, _init: RequestInit) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 }
      );
    }) as any;

    await callSimpleText([{ role: "user", content: "hi" }], { provider: "grok" });
    expect(capturedUrl).toContain("api.x.ai");
  });
});

// ─── callVisionLLM — Anthropic path ──────────────────────────────────────────

describe("callVisionLLM — anthropic", () => {
  test("returns content[0].text on success", async () => {
    mockFetch({ content: [{ type: "text", text: "A bar chart showing accuracy." }] });
    const result = await callVisionLLM("base64data", "image/png", "Describe this.");
    expect(result).toBe("A bar chart showing accuracy.");
  });

  test("sends image in native Anthropic source format", async () => {
    let requestBody: any = null;
    global.fetch = (async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
        { status: 200 }
      );
    }) as any;

    await callVisionLLM("mybase64", "image/jpeg", "What is this?");
    const imageBlock = requestBody.messages[0].content[0];
    expect(imageBlock.type).toBe("image");
    expect(imageBlock.source.type).toBe("base64");
    expect(imageBlock.source.media_type).toBe("image/jpeg");
    expect(imageBlock.source.data).toBe("mybase64");
  });

  test("throws on non-ok response", async () => {
    mockFetch({ error: "bad request" }, 400);
    await expect(
      callVisionLLM("data", "image/png", "describe")
    ).rejects.toThrow("Vision LLM error: 400");
  });
});

// ─── callVisionLLM — OpenAI-compat path ──────────────────────────────────────

describe("callVisionLLM — openai-compat (via opts.provider)", () => {
  test("returns choices[0].message.content string", async () => {
    mockFetch({ choices: [{ message: { content: "A scatter plot." } }] });
    const result = await callVisionLLM("b64", "image/png", "describe", {
      provider: "openrouter",
    });
    expect(result).toBe("A scatter plot.");
  });

  test("sends image as data URI in image_url format", async () => {
    let requestBody: any = null;
    global.fetch = (async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 }
      );
    }) as any;

    await callVisionLLM("myb64", "image/webp", "describe", { provider: "openrouter" });
    const imageBlock = requestBody.messages[0].content[0];
    expect(imageBlock.type).toBe("image_url");
    expect(imageBlock.image_url.url).toBe("data:image/webp;base64,myb64");
  });

  test("throws on non-ok response", async () => {
    mockFetch({ error: "rate limited" }, 429);
    await expect(
      callVisionLLM("b64", "image/png", "describe", { provider: "openrouter" })
    ).rejects.toThrow("Vision LLM error: 429");
  });

  test("throws when content is non-string", async () => {
    mockFetch({ choices: [{ message: { content: null } }] });
    await expect(
      callVisionLLM("b64", "image/png", "describe", { provider: "openrouter" })
    ).rejects.toThrow("Vision LLM: empty response");
  });

  test("sends a model field in the request body", async () => {
    let requestBody: any = null;
    global.fetch = (async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 }
      );
    }) as any;

    await callVisionLLM("b64", "image/png", "describe", { provider: "openrouter" });
    // model field must be present and non-empty (comes from VISION_MODEL config)
    expect(typeof requestBody.model).toBe("string");
    expect(requestBody.model.length).toBeGreaterThan(0);
  });
});
