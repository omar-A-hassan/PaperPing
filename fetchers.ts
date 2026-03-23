import { ANTHROPIC_API_KEY, OPENROUTER_API_KEY, LLM_PROVIDER, LLM_MODEL } from "./config";

const DIGEST_SYSTEM_PROMPT = `You are a research paper digest assistant. Given a paper's title and abstract, reply with EXACTLY 3 sentences in this format:

🔬 FOUND: [One sentence on the core finding or method]
💡 MATTERS: [One sentence on why this is significant or useful]
⚠️ LIMIT: [One sentence on the key limitation or caveat]

Be specific. Use numbers/metrics if present. No filler words. Total reply under 80 words.`;

// ─── Helper ───────────────────────────────────────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, retries: number, delayMs = 2000): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, delayMs));
    return withRetry(fn, retries - 1, delayMs * 2);
  }
}

// ─── fetchArxiv ───────────────────────────────────────────────────────────────
export async function fetchArxiv(id: string): Promise<string> {
  return withRetry(async () => {
    const cleanId = id.replace(/v\d+$/, "");
    const url = `https://export.arxiv.org/abs/${cleanId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`arXiv fetch failed: ${res.status}`);
    const html = await res.text();

    const titleMatch = html.match(/<h1 class="title[^"]*"[^>]*>(.*?)<\/h1>/s);
    const title =
      titleMatch?.[1]?.replace(/<[^>]+>/g, "").replace("Title:", "").trim() ?? "Unknown";

    const abstractMatch = html.match(
      /<blockquote class="abstract[^"]*"[^>]*>(.*?)<\/blockquote>/s
    );
    const abstract =
      abstractMatch?.[1]?.replace(/<[^>]+>/g, "").replace("Abstract:", "").trim() ?? "";

    const authorsMatch = html.match(/<div class="authors">(.*?)<\/div>/s);
    const authors =
      authorsMatch?.[1]?.replace(/<[^>]+>/g, "").replace("Authors:", "").trim() ?? "";

    if (!abstract) throw new Error("Could not parse abstract from arXiv");
    return `Title: ${title}\nAuthors: ${authors}\n\nAbstract:\n${abstract}`;
  }, 2, 3000);
}

// ─── fetchArxivFeed ───────────────────────────────────────────────────────────
export interface ArxivPaper {
  arxivId: string;
  title: string;
  authors: string;
  abstract: string;
  publishedDate: string;
}

const CATEGORY_RE = /^[a-z-]+\.[A-Z]+$/;

export async function fetchArxivFeed(topic: string): Promise<ArxivPaper[]> {
  return withRetry(async () => {
    const prefix = CATEGORY_RE.test(topic) ? "cat" : "all";
    const url = `https://export.arxiv.org/api/query?search_query=${prefix}:${encodeURIComponent(topic)}&sortBy=submittedDate&max_results=10`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`arXiv feed fetch failed: ${res.status}`);
    const xml = await res.text();

    try {
      const dom = new DOMParser().parseFromString(xml, "text/xml");
      const entries = dom.querySelectorAll("entry");
      const papers: ArxivPaper[] = [];

      for (const entry of Array.from(entries)) {
        const idText = entry.querySelector("id")?.textContent ?? "";
        const arxivIdMatch = idText.match(/(\d{4}\.\d{4,5}(?:v\d+)?)/);
        if (!arxivIdMatch) continue;

        const authorNames = Array.from(entry.querySelectorAll("author name")).map(
          (n: Element) => n.textContent?.trim() ?? ""
        );

        papers.push({
          arxivId: arxivIdMatch[1]!,
          title: entry.querySelector("title")?.textContent?.trim() ?? "",
          authors: authorNames.join(", "),
          abstract: entry.querySelector("summary")?.textContent?.trim() ?? "",
          publishedDate: entry.querySelector("published")?.textContent?.trim() ?? "",
        });
      }
      return papers;
    } catch {
      return [];
    }
  }, 1);
}

// ─── generateDigest ───────────────────────────────────────────────────────────
function extractOpenRouterText(data: any): string {
  const message = data?.choices?.[0]?.message;

  const collectText = (value: any): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((item) => collectText(item)).join("");
    if (!value || typeof value !== "object") return "";
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return collectText(value.content);
    return "";
  };

  const text = collectText(message?.content).trim();
  if (text) return text;

  const fallback = collectText(data?.choices?.[0]).trim();
  if (fallback) return fallback;

  throw new Error("OpenRouter response parsing failed");
}

export async function generateDigest(paperText: string): Promise<string> {
  return withRetry(async () => {
    if (LLM_PROVIDER === "openrouter") {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          max_tokens: 400,
          reasoning: { effort: "none" },
          messages: [
            { role: "system", content: DIGEST_SYSTEM_PROMPT },
            { role: "user", content: paperText },
          ],
        }),
      });
      if (!response.ok) throw new Error(`OpenRouter API error: ${response.status}`);
      return extractOpenRouterText(await response.json());
    }

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
        system: DIGEST_SYSTEM_PROMPT,
        messages: [{ role: "user", content: paperText }],
      }),
    });
    if (!response.ok) throw new Error(`Claude API error: ${response.status}`);
    const data = await response.json();
    return data.content[0].text.trim();
  }, 1);
}
