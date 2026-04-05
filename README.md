# PaperPing

> Text a paper. Get the point.

PaperPing runs locally on your Mac. Text it an arXiv link, a question, or a paper you want to understand — it reads the paper, answers follow-up questions, subscribes you to morning briefings, and builds a memory of everything you've studied over time.

Built with [Photon iMessage Kit](https://github.com/photon-hq/imessage-kit), [Bun](https://bun.sh), and SQLite. Your library is stored locally at `~/.scholar/scholar.db` — your conversation history and papers never leave your machine, but messages and paper content are sent to your configured LLM provider (Anthropic or OpenRouter) to generate responses and digests.

---

## Pre-built App

Don't want to build from source? The pre-built Mac app (`PaperPing.app`) includes a menu bar icon, a guided setup wizard, and a one-click DMG installer.


---

## Setup

```bash
# 1. Install Bun (if not already)
curl -fsSL https://bun.sh/install | bash

# 2. Install dependencies
bun install

# 3. Grant Full Disk Access to Terminal (dev/source mode)
#    System Settings → Privacy & Security → Full Disk Access → add Terminal

# 4. Set required environment variables
export YOUR_PHONE_NUMBER="+1234567890"   # your own number

# Use Anthropic (default)
export ANTHROPIC_API_KEY="sk-ant-..."

# OR use OpenRouter (any model)
export LLM_PROVIDER="openrouter"
export OPENROUTER_API_KEY="sk-or-..."
export LLM_MODEL="openrouter/auto"       # optional, defaults to auto

# 5. (Optional) Install Ollama for semantic memory
#    brew install ollama && ollama pull nomic-embed-text
#    Without Ollama, PaperPing falls back to recency-based session retrieval

# 6. Run
bun run agent.ts
```

---

## What you can do

PaperPing is conversational — just text naturally. These are the things it understands:

| What you send | What PaperPing does |
|---|---|
| `arxiv.org/abs/2405.21060` or `2405.21060` | Fetch the paper, generate a 3-sentence digest, save to library |
| `find me recent papers on Mamba` | Search arXiv, return numbered list |
| `fetch 2` | Fetch paper #2 from the last search |
| `deep read 2405.21060` | Download full paper text from arXiv HTML |
| `what does figure 3 show?` | Describe the figure using a vision model |
| `explain section 4` | Retrieve the relevant passage from full text |
| `what did I read about attention?` | Full-text search your library |
| `follow cs.LG` | Subscribe to daily morning briefings for a category |
| `follow NLP` | Same — PaperPing infers `cs.CL` |
| `unfollow cs.LG` | Remove a subscription |
| `my topics` | List active subscriptions |
| `my history` | Your 5 most recently read papers |
| `send my briefing at 8am` | Change briefing time |
| _(drag a PDF into iMessage)_ | Parse the PDF, generate digest, save to library |
| Anything else | Free-form conversation with your research context |

**arXiv category codes:** `cs.LG` (machine learning), `cs.CL` (NLP), `cs.AI`, `cs.CV`, `cs.RO`, `stat.ML`, `math.OC`

---

## Morning Briefing

Subscribe to a topic and PaperPing texts you at 7am with the newest papers — no prompt needed.

```
☀️ Good morning! Here's what's new in your fields:

📄 State Space Duality (arXiv:2405.21060)
🔬 FOUND: Mamba-2 unifies SSMs and attention through structured state space duality, achieving 2-8x faster training than Mamba-1.
💡 MATTERS: Enables transformer-parity language modeling at 5x the throughput with a clean theoretical framework.
⚠️ LIMIT: Evaluation focuses on language tasks; vision and multimodal benchmarks are not included.

You're following: cs.LG, cs.CL
```

Change time: text `send my briefing at 8:30am`

---

## Memory Architecture

PaperPing maintains three tiers of memory across all sessions:

**Tier 1 — Working memory (this conversation)**
Raw turns from the current session, compressed into a rolling summary as the conversation grows. Never truncates — always compresses.

**Tier 2 — Episodic memory (past sessions)**
At the end of each session (after 60 min of idle), PaperPing summarizes the full conversation (topics, papers fetched, open questions) and stores it. These summaries are retrieved at the start of your next conversation, either by recency or — if Ollama is running — by semantic similarity to what you're asking about.

**Tier 3 — Semantic memory (your profile)**
PaperPing tracks your research interests, expertise level per domain, communication preferences, and ongoing projects. This profile is built automatically from your conversations and injected into every LLM call to personalize responses.

---

## Full Paper Reading

Beyond abstracts, PaperPing can read complete papers:

```
You:      deep read 2405.21060
PaperPing:  📖 Loading full paper... done (42 sections extracted)

You:      what is the exact complexity of the SSD algorithm?
PaperPing:  [retrieves section 3.2] The SSD algorithm runs in O(TLN²)
          time where T is sequence length, L is number of layers...

You:      what does figure 4 show?
PaperPing:  Figure 4 shows a comparison of training throughput between
          Mamba-2 and FlashAttention-2 across sequence lengths...
```

---

## PDF Attachments

Drag any PDF into iMessage and PaperPing will parse it, generate a digest, and add it to your library — same as arXiv papers.

---

## Architecture

```
You (iMessage)
    │
    ▼
agent.ts  ──── per-sender queue (sequential, no races)
    │
    ├── PDF attachment? ──▶ pdfReader.ts ──▶ generateDigest()
    │
    └── text message ──▶ agentLoop.ts
                              │
                    assembleContext()  (memory.ts)
                    ┌────────┬──────────────┬────────────────────────┐
                    │        │              │                        │
                 system   profile       past sessions           raw turns
                 prompt   (tier 3)   (tier 2, semantic         (tier 1,
                                      or recency)              compressed)
                    └────────┴──────────────┴────────────────────────┘
                              │
                    LLM call  (Anthropic or OpenRouter)
                    ┌─────────────────────────────────┐
                    │  tool calls (up to 5 iterations) │
                    │                                  │
                    │  search_library  ──▶ db.ts (FTS5)│
                    │  search_arxiv    ──▶ fetchers.ts │
                    │  fetch_paper     ──▶ fetchers.ts │
                    │  deep_read_paper ──▶ arxivHtml.ts│
                    │  get_paper_section               │
                    │  get_paper_figure──▶ figureReader│
                    │  subscribe_topic ──▶ db.ts       │
                    │  list_history    ──▶ db.ts       │
                    └─────────────────────────────────┘
                              │
                    final text reply
                              │
                    maybeCompress()  (background, no-op if < 12 turns)
                              │
                    sdk.send() ──▶ You (iMessage)

── 7am daily ──▶ briefing.ts
                    │
                    fetchArxivFeed() per subscription
                    filter: not already read, newer than last_checked
                    generateDigest() × N papers
                    sdk.send() ──▶ You
```

**Database** (`~/.scholar/scholar.db`):
- `sessions` — current conversation turns + rolling summary per user
- `session_summaries` — episodic memory with FTS5 index
- `session_summary_embeddings` — vec0 vector index (if Ollama/sqlite-vec available)
- `user_profiles` — semantic user model
- `active_papers` — pinned papers injected into every conversation
- `papers` — full library with abstract, digest, full text, figure URLs
- `subscriptions` — morning briefing topics
- `briefing_config` — time + paper count per user

---

## Requirements

- macOS (iMessage access via `~/Library/Messages/chat.db`)
- [Bun](https://bun.sh) runtime
- Full Disk Access granted to Terminal
- Anthropic API key **or** OpenRouter API key
- (Optional) [Ollama](https://ollama.com) + `nomic-embed-text` for semantic session retrieval

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `YOUR_PHONE_NUMBER` | Yes | Your own iMessage number (e.g. `+1234567890`) |
| `ANTHROPIC_API_KEY` | If using Anthropic | Default provider |
| `LLM_PROVIDER` | No | `"anthropic"` (default) or `"openrouter"` |
| `OPENROUTER_API_KEY` | If using OpenRouter | |
| `LLM_MODEL` | No | Defaults to `claude-sonnet-4-20250514` (Anthropic) or `openrouter/auto` |

---

## Development

```bash
bun test           # run all tests (109 tests)
bunx tsc --noEmit  # type check
bun --watch agent.ts  # dev mode with hot reload
```

Tests use in-memory SQLite and mock all network calls (arXiv, Anthropic, OpenRouter, Ollama). No API keys needed to run tests.

```bash
bun test           # run all tests (112 tests)
```
