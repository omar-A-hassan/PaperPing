// ─── Scientific figure understanding (V2.3) ──────────────────────────────────
// Fetches a figure image and describes it using the configured vision LLM.
// Supports Anthropic native vision and OpenRouter vision.

import { LLM_PROVIDER, LLM_MODEL, ANTHROPIC_API_KEY, OPENROUTER_API_KEY } from "./config";

type SupportedMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

function detectMediaType(url: string, contentType: string): SupportedMediaType | "image/svg+xml" {
  const ct = contentType.toLowerCase();
  if (ct.includes("svg") || url.endsWith(".svg")) return "image/svg+xml";
  if (ct.includes("png") || url.match(/\.png($|\?)/i)) return "image/png";
  if (ct.includes("jpeg") || ct.includes("jpg") || url.match(/\.(jpg|jpeg)($|\?)/i)) return "image/jpeg";
  if (ct.includes("gif") || url.match(/\.gif($|\?)/i)) return "image/gif";
  if (ct.includes("webp") || url.match(/\.webp($|\?)/i)) return "image/webp";
  return "image/png"; // safe default for arXiv (most figures are PNG)
}

export async function describeFigure(
  figureUrl: string,
  figureNumber: number,
  paperTitle: string,
  caption = ""
): Promise<string> {
  const res = await fetch(figureUrl, {
    headers: { "User-Agent": "Scholar-Agent/1.0" },
  });
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status} — ${figureUrl}`);

  const mediaType = detectMediaType(figureUrl, res.headers.get("content-type") ?? "");

  // SVG can't be sent to vision models — return metadata
  if (mediaType === "image/svg+xml") {
    return `Figure ${figureNumber} is an SVG diagram.${caption ? ` Caption: "${caption}"` : ""}`;
  }

  const arrayBuffer = await res.arrayBuffer();
  const imageBase64 = Buffer.from(arrayBuffer).toString("base64");

  const prompt = `This is Figure ${figureNumber} from "${paperTitle}".${
    caption ? ` Caption: "${caption}".` : ""
  }

Describe in 3-4 concise sentences:
1. What type of figure is this? (graph, diagram, architecture, table, etc.)
2. What does it show specifically?
3. What is the key insight or finding it communicates?

Use technical ML/research language. Be specific with numbers or labels if visible.`;

  if (LLM_PROVIDER === "openrouter") {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:${mediaType};base64,${imageBase64}` },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Vision LLM error: ${response.status} — ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content.trim();
    throw new Error("Vision LLM: empty response");
  }

  // Anthropic: native base64 image content blocks
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: imageBase64 },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vision LLM error: ${response.status} — ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.content[0].text.trim();
}
