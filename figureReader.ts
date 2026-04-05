// ─── Scientific figure understanding ─────────────────────────────────────────
// Fetches a figure image from arXiv and describes it via the configured LLM.
// Provider routing and wire format live in llmClient.ts.

import { callVisionLLM, SupportedMediaType } from "./llmClient";

function detectMediaType(url: string, contentType: string): SupportedMediaType | "image/svg+xml" {
  const ct = contentType.toLowerCase();
  if (ct.includes("svg") || url.endsWith(".svg"))                                       return "image/svg+xml";
  if (ct.includes("png")  || url.match(/\.png($|\?)/i))                                return "image/png";
  if (ct.includes("jpeg") || ct.includes("jpg") || url.match(/\.(jpg|jpeg)($|\?)/i))   return "image/jpeg";
  if (ct.includes("gif")  || url.match(/\.gif($|\?)/i))                                return "image/gif";
  if (ct.includes("webp") || url.match(/\.webp($|\?)/i))                               return "image/webp";
  return "image/png"; // safe default for arXiv (most figures are PNG)
}

export async function describeFigure(
  figureUrl:    string,
  figureNumber: number,
  paperTitle:   string,
  caption = ""
): Promise<string> {
  const res = await fetch(figureUrl, {
    headers: { "User-Agent": "PaperPing-Agent/1.0" },
  });
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status} — ${figureUrl}`);

  const mediaType = detectMediaType(figureUrl, res.headers.get("content-type") ?? "");

  // SVG can't be sent to vision models — return metadata only
  if (mediaType === "image/svg+xml") {
    return `Figure ${figureNumber} is an SVG diagram.${caption ? ` Caption: "${caption}"` : ""}`;
  }

  const imageBase64 = Buffer.from(await res.arrayBuffer()).toString("base64");

  const prompt = `This is Figure ${figureNumber} from "${paperTitle}".${
    caption ? ` Caption: "${caption}".` : ""
  }

Describe in 3-4 concise sentences:
1. What type of figure is this? (graph, diagram, architecture, table, etc.)
2. What does it show specifically?
3. What is the key insight or finding it communicates?

Use technical ML/research language. Be specific with numbers or labels if visible.`;

  return callVisionLLM(imageBase64, mediaType, prompt);
}
