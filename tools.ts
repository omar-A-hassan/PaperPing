import {
  queryMemory,
  addSubscription,
  removeSubscription,
  listSubscriptions,
  listRecentPapers,
  getPaperByRefId,
  setBriefingConfig,
  pinPaper,
  storePaper,
  updatePaperFullText,
  updatePaperFigureUrls,
  getPaperFigureUrls,
} from "./db";
import { fetchArxiv, fetchArxivFeed, generateDigest } from "./fetchers";

// ─── Tool definitions ─────────────────────────────────────────────────────────
// JSON Schema definitions for both Anthropic and OpenRouter tool-use wire formats.

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>; // JSON Schema
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "search_library",
    description:
      "Full-text search the user's saved paper library. Use when the user asks about papers they've read, or wants to recall something from their library. Returns matching papers with title, arXiv ID, and digest.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — keywords, topics, or author names.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 5, max 10).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_arxiv",
    description:
      "Search arXiv for recent papers on a topic or in a category (e.g. cs.LG). Use for discovery or when the user asks about new/recent papers. Returns a numbered list of papers.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query (keywords) or arXiv category (e.g. cs.LG, cs.CL, stat.ML).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_paper",
    description:
      "Fetch, digest, and save an arXiv paper by ID. Use when the user provides an arXiv link or ID, or picks a paper from search results. Returns title, arXiv ID, and 3-sentence digest.",
    inputSchema: {
      type: "object",
      properties: {
        arxiv_id: {
          type: "string",
          description: "arXiv paper ID (e.g. 2301.00001 or 2301.00001v2).",
        },
      },
      required: ["arxiv_id"],
    },
  },
  {
    name: "get_paper",
    description:
      "Get full details (title, digest, abstract) for a paper already in the library by arXiv ID. Use when the user asks for more detail on a known paper.",
    inputSchema: {
      type: "object",
      properties: {
        arxiv_id: {
          type: "string",
          description: "arXiv paper ID.",
        },
      },
      required: ["arxiv_id"],
    },
  },
  {
    name: "list_history",
    description:
      "List the user's recently read papers. Use when the user asks 'what have I read?' or wants to see their reading history.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max papers to return (default 5, max 20).",
        },
      },
      required: [],
    },
  },
  {
    name: "subscribe_topic",
    description:
      "Subscribe the user to morning briefings for an arXiv category or keyword. Use when the user says 'follow X', 'subscribe to X', or 'get me papers on X every day'. Infer the best arXiv category when possible (e.g. 'ML' → 'cs.LG', 'NLP' → 'cs.CL', 'computer vision' → 'cs.CV').",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Topic or arXiv category to subscribe to (e.g. 'cs.LG', 'cs.CL', 'transformers').",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "unsubscribe_topic",
    description:
      "Remove a morning briefing subscription. Use when the user says 'unfollow X', 'stop sending me X', or 'remove X from my topics'.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Topic or arXiv category to unsubscribe from.",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "list_subscriptions",
    description:
      "List the user's current morning briefing subscriptions. Use when the user asks 'what am I following?' or 'what are my topics?'.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "set_briefing_time",
    description:
      "Change the time the morning briefing is sent. Use when the user says 'send my briefing at 8am' or 'change briefing to 9:30'. Default is 7:00am.",
    inputSchema: {
      type: "object",
      properties: {
        hour: {
          type: "number",
          description: "Hour in 24-hour format (0–23).",
        },
        minute: {
          type: "number",
          description: "Minute (0–59). Defaults to 0.",
        },
      },
      required: ["hour"],
    },
  },
  {
    name: "deep_read_paper",
    description:
      "Fetch and store the FULL text of an arXiv paper (all sections, not just abstract). Use when the user says 'deep read', 'read the full paper', 'explain section 3', or wants detailed analysis beyond the abstract. Takes 5-15 seconds. After loading, use get_paper_section for specific questions.",
    inputSchema: {
      type: "object",
      properties: {
        arxiv_id: { type: "string", description: "arXiv paper ID (e.g. 2301.00001)." },
      },
      required: ["arxiv_id"],
    },
  },
  {
    name: "get_paper_section",
    description:
      "Find the most relevant passage from a fully-read paper to answer a specific question. Use when the user asks a detailed question about a paper that was previously deep-read.",
    inputSchema: {
      type: "object",
      properties: {
        arxiv_id: { type: "string", description: "arXiv paper ID." },
        question: { type: "string", description: "The specific question or topic to find." },
      },
      required: ["arxiv_id", "question"],
    },
  },
  {
    name: "get_paper_figure",
    description:
      "Describe a specific figure from an arXiv paper using vision AI. Use when the user asks 'what does figure 2 show?' or 'describe the architecture diagram'. The paper must have been deep-read first.",
    inputSchema: {
      type: "object",
      properties: {
        arxiv_id: { type: "string", description: "arXiv paper ID." },
        figure_number: {
          type: "number",
          description: "Figure number (1-indexed). Use 1 for the first figure.",
        },
      },
      required: ["arxiv_id", "figure_number"],
    },
  },
  {
    name: "read_pdf_attachment",
    description:
      "Get details about a PDF that was previously attached and processed in this conversation. Use when the user asks about an attached PDF they already sent.",
    inputSchema: {
      type: "object",
      properties: {
        ref_id: {
          type: "string",
          description: "The PDF ref_id (format: pdf:{sha1}).",
        },
      },
      required: ["ref_id"],
    },
  },
  {
    name: "set_briefing_count",
    description:
      "Change how many papers are included in the morning briefing. Use when the user says 'show me 10 papers' or 'only 3 papers per day'. Default is 5.",
    inputSchema: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of papers per briefing (1–20).",
        },
      },
      required: ["count"],
    },
  },
];

// ─── Tool handler ─────────────────────────────────────────────────────────────

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export async function executeTool(
  toolName: string,
  input: Record<string, any>,
  sender: string
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case "search_library": {
        const results = queryMemory(input.query as string, Math.min(input.limit ?? 5, 10));
        if (results.length === 0) {
          return { content: `Nothing in your library matches "${input.query}". Try fetching some papers first.` };
        }
        const lines = results.map((r, i) => {
          const date = r.read_at.slice(0, 10);
          const firstLine = r.digest.split("\n")[0] ?? "";
          return `${i + 1}. "${r.title}" (arXiv:${r.ref_id}) — ${date}\n   ${firstLine}`;
        });
        return { content: `Found ${results.length} paper${results.length === 1 ? "" : "s"}:\n\n${lines.join("\n\n")}` };
      }

      case "search_arxiv": {
        const papers = await fetchArxivFeed(input.query as string);
        if (papers.length === 0) {
          return { content: `No papers found for "${input.query}". Try a different query or arXiv category (e.g. cs.LG).` };
        }
        const lines = papers.slice(0, 10).map((p, i) => {
          const date = p.publishedDate.slice(0, 10);
          const abstract = p.abstract.slice(0, 150).replace(/\n/g, " ");
          return `${i + 1}. "${p.title}" — arXiv:${p.arxivId} (${date})\n   Authors: ${p.authors.split(", ").slice(0, 3).join(", ")}\n   ${abstract}…`;
        });
        return { content: `Found ${papers.length} papers on "${input.query}":\n\n${lines.join("\n\n")}\n\nSend "fetch [number]" to get the full digest for any paper.` };
      }

      case "fetch_paper": {
        const arxivId = (input.arxiv_id as string).replace(/v\d+$/, "");

        // Return cached if already in library
        const cached = getPaperByRefId(arxivId);
        if (cached) {
          pinPaper(sender, arxivId, cached.title, cached.digest);
          return {
            content: `📄 ${cached.title}\narXiv:${arxivId}\n\n${cached.digest}\n\nhttps://arxiv.org/abs/${arxivId}`,
          };
        }

        const paperText = await fetchArxiv(arxivId);
        const digest = await generateDigest(paperText);

        const titleMatch = paperText.match(/^Title: (.+)$/m);
        const authorsMatch = paperText.match(/^Authors: (.+)$/m);
        const title = titleMatch?.[1]?.trim() ?? "Unknown";
        const authors = authorsMatch?.[1]?.trim() ?? "";
        const abstractMatch = paperText.match(/^Abstract:\n([\s\S]+)$/m);
        const abstract = abstractMatch?.[1]?.trim() ?? "";

        storePaper({
          type: "arxiv",
          ref_id: arxivId,
          title,
          authors,
          digest,
          topics: "",
          abstract,
        });

        pinPaper(sender, arxivId, title, digest);

        return {
          content: `📄 ${title}\narXiv:${arxivId}\n\n${digest}\n\nhttps://arxiv.org/abs/${arxivId}`,
        };
      }

      case "get_paper": {
        const paper = getPaperByRefId(input.arxiv_id as string);
        if (!paper) {
          return {
            content: `Paper arXiv:${input.arxiv_id} is not in your library. Use fetch_paper to add it.`,
            isError: true,
          };
        }
        const abstractText = paper.abstract ? `\nAbstract: ${paper.abstract}` : "";
        return {
          content: `"${paper.title}" (arXiv:${paper.ref_id})\nAdded: ${paper.read_at.slice(0, 10)}\n\n${paper.digest}${abstractText}`,
        };
      }

      case "list_history": {
        const limit = Math.min(input.limit ?? 5, 20);
        const papers = listRecentPapers(limit);
        if (papers.length === 0) {
          return { content: "Your library is empty. Send an arXiv link to add your first paper." };
        }
        const lines = papers.map((p, i) => `${i + 1}. "${p.title}" — ${p.read_at.slice(0, 10)} (arXiv:${p.ref_id})`);
        return { content: `Recent papers (${papers.length}):\n\n${lines.join("\n")}` };
      }

      case "subscribe_topic": {
        addSubscription(input.topic as string);
        return {
          content: `✅ Subscribed to "${input.topic}". Morning briefings will include papers on this topic.`,
        };
      }

      case "unsubscribe_topic": {
        const removed = removeSubscription(input.topic as string);
        if (removed) {
          return { content: `✅ Unsubscribed from "${input.topic}".` };
        }
        return {
          content: `You weren't subscribed to "${input.topic}".`,
          isError: true,
        };
      }

      case "list_subscriptions": {
        const subs = listSubscriptions();
        if (subs.length === 0) {
          return { content: 'No subscriptions yet. Try "subscribe to cs.LG" to get daily ML papers.' };
        }
        const lines = subs.map((s) => `• ${s.topic}`);
        return { content: `Your subscriptions (${subs.length}):\n${lines.join("\n")}` };
      }

      case "set_briefing_time": {
        const hour = Math.max(0, Math.min(23, input.hour as number));
        const minute = Math.max(0, Math.min(59, input.minute ?? 0));
        setBriefingConfig(sender, { hour, minute });
        const h = String(hour).padStart(2, "0");
        const m = String(minute).padStart(2, "0");
        return { content: `✅ Morning briefing time set to ${h}:${m}.` };
      }

      case "set_briefing_count": {
        const count = Math.max(1, Math.min(20, input.count as number));
        setBriefingConfig(sender, { paper_count: count });
        return { content: `✅ Morning briefing will now include ${count} paper${count !== 1 ? "s" : ""}.` };
      }

      case "deep_read_paper": {
        const arxivId = (input.arxiv_id as string).replace(/v\d+$/, "");
        const existing = getPaperByRefId(arxivId);

        // Already deep-read — no need to re-fetch
        if (existing?.full_text && existing.full_text.length > 100) {
          pinPaper(sender, arxivId, existing.title, existing.digest);
          return {
            content: `"${existing.title}" is already fully loaded (${existing.full_text.length.toLocaleString()} chars across sections). Use get_paper_section to find specific passages.`,
          };
        }

        const { fetchArxivHtml } = await import("./arxivHtml");
        let fullTextData;
        try {
          fullTextData = await fetchArxivHtml(arxivId);
        } catch {
          return {
            content: `⚠️ Full text unavailable for arXiv:${arxivId} — the HTML version may not exist yet. The abstract-only version is still in your library.`,
            isError: true,
          };
        }

        if (existing) {
          // Paper already in library — just add full text
          updatePaperFullText(arxivId, fullTextData.fullText);
          if (fullTextData.figureUrls.length > 0) {
            updatePaperFigureUrls(arxivId, fullTextData.figureUrls);
          }
          pinPaper(sender, arxivId, existing.title, existing.digest);
          return {
            content: `📖 Full text loaded for "${existing.title}" — ${fullTextData.sections.length} sections, ${fullTextData.fullText.length.toLocaleString()} chars, ${fullTextData.figureUrls.length} figures. Use get_paper_section for specific passages.`,
          };
        }

        // Paper not yet in library — fetch abstract + full text together
        const paperText = await fetchArxiv(arxivId);
        const digest = await generateDigest(paperText);

        const titleMatch = paperText.match(/^Title: (.+)$/m);
        const authorsMatch = paperText.match(/^Authors: (.+)$/m);
        const title = titleMatch?.[1]?.trim() ?? "Unknown";
        const authors = authorsMatch?.[1]?.trim() ?? "";
        const abstractMatch = paperText.match(/^Abstract:\n([\s\S]+)$/m);
        const abstract = abstractMatch?.[1]?.trim() ?? "";

        storePaper({ type: "arxiv", ref_id: arxivId, title, authors, digest, topics: "", abstract });
        updatePaperFullText(arxivId, fullTextData.fullText);
        if (fullTextData.figureUrls.length > 0) {
          updatePaperFigureUrls(arxivId, fullTextData.figureUrls);
        }
        pinPaper(sender, arxivId, title, digest);

        return {
          content: `📖 Deep read complete: "${title}"\n${fullTextData.sections.length} sections · ${fullTextData.fullText.length.toLocaleString()} chars · ${fullTextData.figureUrls.length} figures\n\n${digest}\n\nUse get_paper_section for specific passages.`,
        };
      }

      case "get_paper_section": {
        const arxivId = (input.arxiv_id as string).replace(/v\d+$/, "");
        const paper = getPaperByRefId(arxivId);

        if (!paper) {
          return {
            content: `arXiv:${arxivId} is not in your library. Use fetch_paper or deep_read_paper first.`,
            isError: true,
          };
        }
        if (!paper.full_text || paper.full_text.length < 100) {
          return {
            content: `"${paper.title}" hasn't been deeply read yet. Use deep_read_paper first.`,
            isError: true,
          };
        }

        const { searchPassage } = await import("./arxivHtml");
        const passage = searchPassage(paper.full_text, input.question as string);
        return {
          content: `From "${paper.title}" (arXiv:${arxivId}):\n\n${passage}`,
        };
      }

      case "get_paper_figure": {
        const arxivId = (input.arxiv_id as string).replace(/v\d+$/, "");
        const figNum = Math.max(1, Math.floor(input.figure_number as number));
        const paper = getPaperByRefId(arxivId);

        if (!paper) {
          return {
            content: `arXiv:${arxivId} not in library. Use fetch_paper first.`,
            isError: true,
          };
        }

        const figureUrls = getPaperFigureUrls(arxivId);
        if (figureUrls.length === 0) {
          return {
            content: `No figures found for "${paper.title}". Use deep_read_paper first to load figures.`,
            isError: true,
          };
        }

        const figureUrl = figureUrls[figNum - 1];
        if (!figureUrl) {
          return {
            content: `Figure ${figNum} not found. This paper has ${figureUrls.length} figure${figureUrls.length !== 1 ? "s" : ""}.`,
            isError: true,
          };
        }

        const { describeFigure } = await import("./figureReader");
        try {
          const description = await describeFigure(figureUrl, figNum, paper.title);
          return {
            content: `Figure ${figNum} from "${paper.title}":\n\n${description}\n\n🖼 ${figureUrl}`,
          };
        } catch (err) {
          return {
            content: `⚠️ Couldn't describe figure ${figNum}: ${err instanceof Error ? err.message : err}`,
            isError: true,
          };
        }
      }

      case "read_pdf_attachment": {
        const paper = getPaperByRefId(input.ref_id as string);
        if (!paper) {
          return { content: `PDF not found in library (${input.ref_id}). Please send the PDF again.`, isError: true };
        }
        pinPaper(sender, paper.ref_id, paper.title, paper.digest);
        return { content: `📎 ${paper.title}\n\n${paper.digest}` };
      }

      default:
        return { content: `Unknown tool: ${toolName}`, isError: true };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { content: `Tool error (${toolName}): ${msg}`, isError: true };
  }
}

// ─── Wire format helpers ──────────────────────────────────────────────────────
// Convert our definitions to Anthropic / OpenRouter tool schemas.

export function toAnthropicTools(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, any>;
}> {
  return TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

export function toOpenRouterTools(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, any> };
}> {
  return TOOL_DEFINITIONS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}
