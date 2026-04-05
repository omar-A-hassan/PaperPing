import { callSimpleText } from "./llmClient";
import { DOMParser } from "@xmldom/xmldom";

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
      const entries = Array.from(dom.getElementsByTagName("entry"));
      const papers: ArxivPaper[] = [];

      for (const entry of entries) {
        const idText = entry.getElementsByTagName("id")[0]?.textContent ?? "";
        const arxivIdMatch = idText.match(/(\d{4}\.\d{4,5}(?:v\d+)?)/);
        if (!arxivIdMatch) continue;

        const authorEls = Array.from(entry.getElementsByTagName("author"));
        const authorNames = authorEls.map(
          (a) => a.getElementsByTagName("name")[0]?.textContent?.trim() ?? ""
        ).filter(Boolean);

        papers.push({
          arxivId: arxivIdMatch[1]!,
          title: entry.getElementsByTagName("title")[0]?.textContent?.trim() ?? "",
          authors: authorNames.join(", "),
          abstract: entry.getElementsByTagName("summary")[0]?.textContent?.trim() ?? "",
          publishedDate: entry.getElementsByTagName("published")[0]?.textContent?.trim() ?? "",
        });
      }
      return papers;
    } catch {
      return [];
    }
  }, 1);
}

// ─── generateDigest ───────────────────────────────────────────────────────────
export async function generateDigest(paperText: string): Promise<string> {
  return withRetry(
    () => callSimpleText(
      [{ role: "user", content: paperText }],
      { system: DIGEST_SYSTEM_PROMPT, maxTokens: 400 }
    ),
    1
  );
}
