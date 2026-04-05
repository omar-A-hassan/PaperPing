// ─── Shared LLM HTTP client (V1.0) ────────────────────────────────────────────
// Single source of truth for provider routing, URL resolution, and wire format.
// All LLM callers (agentLoop, memory, fetchers, figureReader) import from here.

import {
  ANTHROPIC_API_KEY,
  OPENROUTER_API_KEY,
  XAI_API_KEY,
  GEMINI_API_KEY,
  LLM_PROVIDER,
  LLM_MODEL,
  VISION_MODEL,
} from "./config";

// ─── Provider config ──────────────────────────────────────────────────────────

export type ProviderBranch = "anthropic" | "openai-compat";

export interface ProviderConfig {
  branch:  ProviderBranch;
  url:     string;
  headers: Record<string, string>;
}

export function getProviderConfig(provider: string = LLM_PROVIDER): ProviderConfig {
  switch (provider) {
    case "grok":
      return {
        branch:  "openai-compat",
        url:     "https://api.x.ai/v1/chat/completions",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${XAI_API_KEY}` },
      };
    case "gemini":
      return {
        branch:  "openai-compat",
        url:     "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GEMINI_API_KEY}` },
      };
    case "openrouter":
      return {
        branch:  "openai-compat",
        url:     "https://openrouter.ai/api/v1/chat/completions",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENROUTER_API_KEY}` },
      };
    default: // "anthropic"
      return {
        branch:  "anthropic",
        url:     "https://api.anthropic.com/v1/messages",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      };
  }
}

// ─── callSimpleText ───────────────────────────────────────────────────────────
// Non-tool-use text completion. Used by memory (compression/profile) and
// fetchers (digest generation). Handles both wire formats transparently.

type SimpleMessage = { role: "user" | "assistant"; content: string };

export async function callSimpleText(
  messages: SimpleMessage[],
  opts: { model?: string; system?: string; maxTokens?: number; provider?: string } = {}
): Promise<string> {
  const cfg        = getProviderConfig(opts.provider);
  const model      = opts.model ?? LLM_MODEL;
  const maxTokens  = opts.maxTokens ?? 500;

  const providerName = opts.provider ?? LLM_PROVIDER;

  if (cfg.branch === "openai-compat") {
    const outMessages = opts.system
      ? [{ role: "system" as const, content: opts.system }, ...messages]
      : messages;

    const response = await fetch(cfg.url, {
      method:  "POST",
      headers: cfg.headers,
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: outMessages }),
    });
    if (!response.ok) throw new Error(`${providerName} API error: ${response.status}`);

    const data    = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("").trim();
      if (text) return text;
    }
    throw new Error(`${LLM_PROVIDER}: empty response`);
  }

  // Anthropic native format
  const body: Record<string, any> = {
    model,
    max_tokens: maxTokens,
    messages,
  };
  if (opts.system) body.system = opts.system;

  const response = await fetch(cfg.url, {
    method:  "POST",
    headers: cfg.headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${providerName} API error: ${response.status}`);
  const data = await response.json();
  return data.content[0].text.trim();
}

// ─── callVisionLLM ────────────────────────────────────────────────────────────
// Vision completion (image + text → text). Used by figureReader.
// Always uses LLM_PROVIDER for the endpoint; model defaults to VISION_MODEL
// (which may differ from LLM_MODEL when the text model doesn't support images).

export type SupportedMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export async function callVisionLLM(
  imageBase64: string,
  mediaType:   SupportedMediaType,
  prompt:      string,
  opts: { model?: string; maxTokens?: number; provider?: string } = {}
): Promise<string> {
  const cfg       = getProviderConfig(opts.provider ?? LLM_PROVIDER);
  const model     = opts.model ?? VISION_MODEL;
  const maxTokens = opts.maxTokens ?? 300;

  if (cfg.branch === "openai-compat") {
    const response = await fetch(cfg.url, {
      method:  "POST",
      headers: cfg.headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Vision LLM error: ${response.status} — ${errText.slice(0, 200)}`);
    }
    const data    = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content.trim();
    throw new Error("Vision LLM: empty response");
  }

  // Anthropic native vision format
  const response = await fetch(cfg.url, {
    method:  "POST",
    headers: cfg.headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vision LLM error: ${response.status} — ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.content[0].text.trim();
}
