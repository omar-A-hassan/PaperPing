// ─── arXiv HTML full-text fetcher (V2.2) ──────────────────────────────────────
// Fetches https://arxiv.org/html/{id}, parses sections and figure URLs.
// Falls back gracefully for papers without HTML versions.

export interface ArxivSection {
  heading: string;
  text: string;
}

export interface ArxivFullText {
  arxivId: string;
  sections: ArxivSection[];
  fullText: string;       // all sections concatenated, up to 60 000 chars
  figureUrls: string[];   // absolute image URLs (up to 20)
}

export async function fetchArxivHtml(arxivId: string): Promise<ArxivFullText> {
  const cleanId = arxivId.replace(/v\d+$/, "");
  const url = `https://arxiv.org/html/${cleanId}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Scholar-Agent/1.0 (research assistant)" },
  });

  if (!res.ok) {
    throw new Error(`arXiv HTML fetch failed: ${res.status} — ${url}`);
  }

  const html = await res.text();
  return parseArxivHtml(html, cleanId);
}

export function parseArxivHtml(html: string, arxivId: string): ArxivFullText {
  // DOMParser is available globally in Bun (same Web Standard API as browser)
  const dom = new DOMParser().parseFromString(html, "text/html");

  const sections: ArxivSection[] = [];

  // arXiv HTML uses <section class="ltx_section"> elements
  const sectionElements = dom.querySelectorAll("section");

  if (sectionElements.length > 0) {
    for (const section of Array.from(sectionElements)) {
      const id = section.getAttribute("id") ?? "";
      // Skip bibliography, references, acknowledgements
      if (/bib|ref|ack|appendix/i.test(id)) continue;

      const headingEl = section.querySelector("h1,h2,h3,h4");
      const heading = headingEl?.textContent?.trim() ?? "";

      const paras = Array.from(section.querySelectorAll("p"))
        .map((p: Element) => p.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter((t: string) => t.length > 20);

      const text = paras.join("\n\n");
      if (text.length > 50) sections.push({ heading, text });
    }
  }

  // Fallback: extract all <p> if no sections found
  if (sections.length === 0) {
    const allParas = Array.from(
      dom.querySelectorAll("article p, .ltx_document p, main p, body p")
    )
      .map((p: Element) => p.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .filter((t: string) => t.length > 20)
      .join("\n\n");

    if (allParas.length > 0) sections.push({ heading: "Content", text: allParas });
  }

  // Extract figure image URLs — arXiv HTML uses relative paths like ./2301.00001.fig1.png
  const baseUrl = `https://arxiv.org/html/${arxivId}/`;
  const figureUrls = Array.from(dom.querySelectorAll("figure img"))
    .map((img: Element) => {
      const src = img.getAttribute("src") ?? "";
      if (src.startsWith("http")) return src;
      if (src.startsWith("./")) return baseUrl + src.slice(2);
      if (src.startsWith("/")) return `https://arxiv.org${src}`;
      return src ? baseUrl + src : "";
    })
    .filter((url: string) => url.length > 0)
    .slice(0, 20);

  const fullText = sections
    .map((s) => (s.heading ? `## ${s.heading}\n\n${s.text}` : s.text))
    .join("\n\n")
    .slice(0, 60_000);

  return { arxivId, sections, fullText, figureUrls };
}

// ─── Sliding-window passage search ───────────────────────────────────────────
// Finds the most relevant 1000-char window within fullText for a given query.
export function searchPassage(fullText: string, query: string, windowSize = 1_000): string {
  if (!fullText || fullText.length === 0) return "";
  if (fullText.length <= windowSize) return fullText;

  const queryWords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w: string) => w.length > 3);

  if (queryWords.length === 0) return fullText.slice(0, windowSize);

  const step = Math.max(1, Math.floor(windowSize / 2));
  let bestScore = -1;
  let bestStart = 0;

  for (let i = 0; i + windowSize <= fullText.length; i += step) {
    const window = fullText.slice(i, i + windowSize).toLowerCase();
    const score = queryWords.reduce(
      (s: number, w: string) => s + (window.split(w).length - 1),
      0
    );
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  return fullText.slice(bestStart, bestStart + windowSize);
}
