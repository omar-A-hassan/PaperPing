import type { IMessageSDK } from "@photon-ai/imessage-kit";
import {
  listSubscriptions,
  isAlreadyRead,
  updateLastChecked,
  getBriefingConfig,
  getUserProfile,
  listRecentPapers,
} from "./db";
import { fetchArxivFeed, generateDigest } from "./fetchers";
import type { ArxivPaper } from "./fetchers";
import { LLM_PROVIDER, LLM_MODEL, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, YOUR_NUMBER } from "./config";

// ─── Relevance scoring ────────────────────────────────────────────────────────
// Score a paper against user profile keywords.
// Returns a float in [0, 1].
function scoreRelevance(paper: ArxivPaper, interests: string[], pastTitles: string[]): number {
  const haystack = `${paper.title} ${paper.abstract} ${paper.authors}`.toLowerCase();

  let score = 0;
  let total = 0;

  // Score against user interests (weight 1.0 each)
  for (const interest of interests) {
    total += 1;
    const keywords = interest.toLowerCase().split(/[\s,]+/);
    if (keywords.some((kw) => kw.length > 2 && haystack.includes(kw))) {
      score += 1;
    }
  }

  // Score against past paper titles (weight 0.5 each, up to 10)
  const titleSample = pastTitles.slice(0, 10);
  for (const pastTitle of titleSample) {
    total += 0.5;
    const words = pastTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
    const matchCount = words.filter((w) => haystack.includes(w)).length;
    if (matchCount >= 2) score += 0.5;
  }

  return total > 0 ? score / total : 0;
}

// ─── "Why you'd like this" note ──────────────────────────────────────────────
// One-sentence explanation why this paper matches the user's profile.
async function generateWhyNote(paper: ArxivPaper, interestsProse: string): Promise<string> {
  const prompt = `Given this user profile summary: "${interestsProse}"

Why would they be interested in this paper: "${paper.title}" — ${paper.abstract.slice(0, 300)}?

One sentence only. Be specific. Reference their actual work or interests. No filler phrases like "based on your interest".`;

  try {
    if (LLM_PROVIDER === "openrouter") {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          max_tokens: 80,
          reasoning: { effort: "none" },
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) return "";
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      return typeof text === "string" ? text.trim() : "";
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
        max_tokens: 80,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) return "";
    const data = await response.json();
    return data.content[0].text.trim();
  } catch {
    return "";
  }
}

function paperToText(p: ArxivPaper): string {
  return `Title: ${p.title}\nAuthors: ${p.authors}\n\nAbstract:\n${p.abstract}`;
}

// ─── Serendipity neighbors ────────────────────────────────────────────────────
const NEIGHBOR_CATEGORIES: Record<string, string[]> = {
  "cs.LG": ["stat.ML", "cs.NE", "cs.CV"],
  "cs.CL": ["cs.AI", "cs.IR", "cs.HC"],
  "cs.CV": ["cs.LG", "cs.GR", "eess.IV"],
  "cs.AI": ["cs.LG", "cs.CL", "cs.RO"],
  "cs.RO": ["cs.AI", "cs.SY", "cs.CV"],
  "stat.ML": ["cs.LG", "cs.ST", "math.ST"],
};

function getNeighborCategory(topic: string): string | null {
  const neighbors = NEIGHBOR_CATEGORIES[topic] ?? [];
  if (neighbors.length === 0) return null;
  // Deterministic daily rotation based on date
  const dayOfYear = Math.floor(Date.now() / 86_400_000);
  return neighbors[dayOfYear % neighbors.length] ?? null;
}

// ─── Main briefing function ───────────────────────────────────────────────────
export async function sendMorningBriefing(sdk: IMessageSDK, to: string): Promise<void> {
  try {
    const subscriptions = listSubscriptions();

    if (subscriptions.length === 0) {
      await sdk.send(
        to,
        `☀️ Good morning! You have no topics yet.\nText "follow cs.LG" to start getting morning briefings.`
      );
      return;
    }

    // Read per-user config
    const config = getBriefingConfig(to);
    const maxPapers = config.paper_count;

    // Read user profile for relevance scoring
    const profile = getUserProfile(to);
    const interests = profile.primaryInterests.concat(profile.secondaryInterests);
    const pastPaperRows = listRecentPapers(20);
    const pastTitles = pastPaperRows.map((p) => p.title);
    const interestsProse = interests.slice(0, 5).join(", ") || "general research";

    // Candidate pool across all subscriptions
    interface Candidate {
      paper: ArxivPaper;
      topic: string;
      score: number;
      isSerendipity: boolean;
    }
    const candidates: Candidate[] = [];

    for (const sub of subscriptions) {
      try {
        const papers = await fetchArxivFeed(sub.topic);
        const cutoff = sub.last_checked ? new Date(sub.last_checked) : new Date(0);

        for (const paper of papers) {
          if (new Date(paper.publishedDate) <= cutoff) continue;
          if (isAlreadyRead(paper.arxivId)) continue;

          const score = scoreRelevance(paper, interests, pastTitles);
          candidates.push({ paper, topic: sub.topic, score, isSerendipity: false });
        }

        updateLastChecked(sub.topic);
      } catch {
        await sdk.send(to, `⚠️ Couldn't fetch new papers for ${sub.topic} today.`);
      }
    }

    // Serendipity: one neighboring-category paper (~15% of slots, at least 1)
    const serendipitySlot = Math.max(1, Math.round(maxPapers * 0.15));
    const serendipityTopics = new Set<string>();
    for (const sub of subscriptions) {
      const neighbor = getNeighborCategory(sub.topic);
      if (neighbor && !serendipityTopics.has(neighbor)) {
        serendipityTopics.add(neighbor);
        try {
          const papers = await fetchArxivFeed(neighbor);
          for (const paper of papers.slice(0, 5)) {
            if (isAlreadyRead(paper.arxivId)) continue;
            candidates.push({ paper, topic: neighbor, score: 0, isSerendipity: true });
            break; // one serendipity paper per neighbor category
          }
        } catch {
          // non-critical, ignore serendipity fetch failures
        }
      }
    }

    if (candidates.length === 0) {
      await sdk.send(to, `☀️ No new papers today for your topics. Check back tomorrow!`);
      return;
    }

    // Sort: serendipity gets its own slot; rest sorted by relevance score descending
    const mainCandidates = candidates
      .filter((c) => !c.isSerendipity)
      .sort((a, b) => b.score - a.score);
    const serendipityCandidates = candidates.filter((c) => c.isSerendipity);

    // Pick papers: (maxPapers - serendipitySlot) from main + up to serendipitySlot from serendipity
    const mainSlots = maxPapers - Math.min(serendipitySlot, serendipityCandidates.length);
    const toSend: Candidate[] = [
      ...mainCandidates.slice(0, mainSlots),
      ...serendipityCandidates.slice(0, serendipitySlot),
    ];

    if (toSend.length === 0) {
      await sdk.send(to, `☀️ No new papers today. Check back tomorrow!`);
      return;
    }

    // Header
    await sdk.send(to, `☀️ Your morning briefing — ${new Date().toDateString()}`);

    // Send each paper
    for (const candidate of toSend) {
      const { paper, isSerendipity } = candidate;

      let digest: string;
      try {
        digest = await generateDigest(paperToText(paper));
      } catch {
        await sdk.send(to, `⚠️ Couldn't summarize "${paper.title}" — check arXiv directly.`);
        continue;
      }

      // "Why note" if user has interests
      let whyNote = "";
      if (interests.length > 0) {
        whyNote = await generateWhyNote(paper, interestsProse);
      }

      const prefix = isSerendipity ? `🎲 Outside your usual topics (${candidate.topic}):\n` : "";
      const why = whyNote ? `\n💬 ${whyNote}` : "";
      const message = `${prefix}📄 ${paper.title}\narXiv:${paper.arxivId}\n\n${digest}${why}`;
      await sdk.send(to, message.slice(0, 1800));
    }

    // Footer
    const topics = subscriptions.map((s) => s.topic).join(", ");
    await sdk.send(to, `Following: ${topics}\nReply with any arXiv link to add it to your library.`);
  } catch (err) {
    console.error("[sendMorningBriefing] unexpected error:", err);
  }
}
