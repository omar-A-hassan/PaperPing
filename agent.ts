import { IMessageSDK } from "@photon-ai/imessage-kit";
import { Database } from "bun:sqlite";
import {
  initDB,
  recordSentGuid,
  isSentGuid,
  purgeSentGuids,
  getBriefingLastSent,
  setBriefingLastSent,
  getBriefingConfig,
  isAlreadyRead,
  getPaperByRefId,
  storePaper,
  pinPaper,
} from "./db";
import { agentLoop } from "./agentLoop";
import { sendMorningBriefing } from "./briefing";
import { YOUR_NUMBER, LLM_PROVIDER, LLM_MODEL, ANTHROPIC_API_KEY, OPENROUTER_API_KEY } from "./config";

// Re-export so other modules can import provider config from a single place
export { LLM_PROVIDER, LLM_MODEL, ANTHROPIC_API_KEY, OPENROUTER_API_KEY };

// ─── SDK ──────────────────────────────────────────────────────────────────────
const sdk = new IMessageSDK({
  watcher: {
    pollInterval: 2000,
    unreadOnly: false,
    excludeOwnMessages: false, // must be false for self-chat (user texts own number)
    // Echo prevention is handled by the two guards below (GUID + content)
  },
});

// ─── Content-based echo guard (in-memory, survives brief restart gaps) ────────
// GUIDs are the primary guard. Content-hash is secondary — covers cases where
// the SDK returns no GUID (e.g. self-send on macOS mirrors the message back
// without an outbound GUID on the echo row).
const SENT_TEXT_TTL_MS = 5 * 60 * 1000; // 5 min
const recentlySentTexts = new Map<string, number>(); // key -> timestamp

function markSentText(text: string): void {
  recentlySentTexts.set(text.slice(0, 300), Date.now());
  // Prune stale entries
  const cutoff = Date.now() - SENT_TEXT_TTL_MS;
  for (const [k, v] of recentlySentTexts) {
    if (v < cutoff) recentlySentTexts.delete(k);
  }
}

function wasRecentlySent(text: string): boolean {
  const ts = recentlySentTexts.get(text.slice(0, 300));
  return !!ts && Date.now() - ts < SENT_TEXT_TTL_MS;
}

async function send(to: string, text: string): Promise<void> {
  console.log(`[send] ${JSON.stringify(text.slice(0, 80))}`);
  // Mark content BEFORE sdk.send() — the SDK polls every 2s and can echo the message
  // back before sdk.send() returns, causing a loop if we mark after.
  markSentText(text);
  const result = await sdk.send(to, text);

  // Try every known GUID path the SDK might return
  const guid =
    (result as any)?.guid ??
    (result as any)?.message?.guid ??
    (result as any)?.data?.guid ??
    null;

  if (guid) {
    recordSentGuid(guid);
    console.log(`[send] guid=${guid}`);
  } else {
    console.log(`[send] no guid — result keys: ${Object.keys(result ?? {}).join(",")}`);
  }
}

// ─── Per-sender message queue (prevents concurrent processing & session races) ─
// Pattern: openai/openclaws — sequential processing per conversation, no concurrency
const senderQueues = new Map<string, Promise<void>>();

function enqueueMessage(sender: string, handler: () => Promise<void>): void {
  const prev = senderQueues.get(sender) ?? Promise.resolve();
  const next = prev.then(handler).catch((err: unknown) => {
    console.error(`[queue] unhandled handler error: ${err}`);
  });
  senderQueues.set(sender, next);
  // Clean up map entry once finished so it doesn't grow forever
  next.finally(() => {
    if (senderQueues.get(sender) === next) senderQueues.delete(sender);
  });
}

// ─── Full Disk Access check ───────────────────────────────────────────────────
function checkFullDiskAccess(): void {
  try {
    const chatDb = new Database(
      `${process.env.HOME}/Library/Messages/chat.db`,
      { readonly: true }
    );
    chatDb.query("SELECT 1 FROM message LIMIT 1").get();
    chatDb.close();
  } catch (err: any) {
    if (err?.message?.includes("SQLITE_CANTOPEN")) {
      console.error(
        "  Scholar needs Full Disk Access.\n" +
        "     System Settings -> Privacy & Security -> Full Disk Access -> add Terminal (or your app)"
      );
      process.exit(1);
    }
    // Other errors (e.g. table not found) mean we DO have access — ignore
  }
}

// ─── Config validation ────────────────────────────────────────────────────────
function validateConfig(): void {
  if (!["anthropic", "openrouter"].includes(LLM_PROVIDER)) {
    throw new Error(
      `Unsupported LLM_PROVIDER "${LLM_PROVIDER}". Use "anthropic" or "openrouter".`
    );
  }
  if (LLM_PROVIDER === "anthropic" && !ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY for Anthropic mode");
  }
  if (LLM_PROVIDER === "openrouter" && !OPENROUTER_API_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY for OpenRouter mode");
  }
}

// ─── Morning briefing loop ────────────────────────────────────────────────────
function startBriefingLoop(sdkInstance: IMessageSDK): void {
  setInterval(async () => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Fire during the configured 5-minute window (reads per-user config from DB)
    const briefingCfg = getBriefingConfig(YOUR_NUMBER);
    if (hour !== briefingCfg.hour || minute < briefingCfg.minute || minute >= briefingCfg.minute + 5) return;

    // Check if we've already sent today
    const today = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const lastSent = getBriefingLastSent();
    if (lastSent === today) return;

    // Mark as sent BEFORE fetching (prevents duplicate if interrupted)
    setBriefingLastSent(today);

    await sendMorningBriefing(sdkInstance, YOUR_NUMBER);
  }, 60_000);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  checkFullDiskAccess();
  validateConfig();
  initDB(); // uses ~/.scholar/scholar.db

  // Purge any stale sent-GUID entries from previous sessions
  purgeSentGuids();

  startBriefingLoop(sdk);

  await sdk.startWatching({
    onDirectMessage: async (msg) => {
      const text = msg.text?.trim() ?? "";

      // Guard 1: persisted GUID (survives restarts, primary defence)
      if (msg.guid && isSentGuid(msg.guid)) {
        console.log(`[skip] guid-match msgid=${msg.id} guid=${msg.guid}`);
        return;
      }

      // Guard 2: in-memory content match (handles SDK returning no GUID)
      if (wasRecentlySent(text)) {
        console.log(`[skip] content-match msgid=${msg.id}`);
        return;
      }

      if (!text) {
        console.log(`[skip] empty text msgid=${msg.id}`);
        return;
      }

      // ── PDF attachment handler (V2.1) ──────────────────────────────────────
      const attachments = (msg as any).attachments as Array<{
        id: string; filename: string; mimeType: string; path: string; size: number;
      }> | undefined;

      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          if (att.mimeType === "application/pdf" || att.filename?.endsWith(".pdf")) {
            enqueueMessage(YOUR_NUMBER, async () => {
              try {
                const { parsePdf } = await import("./pdfReader");
                const { generateDigest } = await import("./fetchers");
                const pdfDoc = await parsePdf(att.path, att.filename ?? "attachment.pdf");

                if (isAlreadyRead(pdfDoc.refId)) {
                  const cached = getPaperByRefId(pdfDoc.refId);
                  if (cached) {
                    pinPaper(YOUR_NUMBER, cached.ref_id, cached.title, cached.digest);
                    await send(YOUR_NUMBER, `📎 Already in library: "${cached.title}"\n\n${cached.digest}`);
                    return;
                  }
                }

                const digest = await generateDigest(
                  `Title: ${pdfDoc.title}\nAuthors: ${pdfDoc.authors}\n\nAbstract:\n${pdfDoc.text.slice(0, 1000)}`
                );

                storePaper({
                  type: "pdf",
                  ref_id: pdfDoc.refId,
                  title: pdfDoc.title,
                  authors: pdfDoc.authors,
                  digest,
                  topics: "",
                  abstract: pdfDoc.text.slice(0, 1000),
                });
                pinPaper(YOUR_NUMBER, pdfDoc.refId, pdfDoc.title, digest);

                await send(
                  YOUR_NUMBER,
                  `📎 ${pdfDoc.title} (${pdfDoc.numpages}p)\n${pdfDoc.refId}\n\n${digest}`
                );
              } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : "Unknown error";
                await send(YOUR_NUMBER, `⚠️ Couldn't read PDF: ${errMsg}. Try pasting the abstract.`);
              }
            });
            return; // handled
          }
        }
      }

      console.log(`[recv] msgid=${msg.id} text=${JSON.stringify(text.slice(0, 60))}`);

      // Enqueue so messages are processed one at a time per sender.
      // Each handler gets a 3-second timer — if the LLM hasn't replied yet,
      // we send a "thinking" ack so the user knows the message was received.
      enqueueMessage(YOUR_NUMBER, async () => {
        let ackSent = false;
        const ackTimer = setTimeout(async () => {
          ackSent = true;
          await send(YOUR_NUMBER, "🔍 On it...");
        }, 3000);

        try {
          const reply = await agentLoop(text, YOUR_NUMBER);
          clearTimeout(ackTimer);
          // Skip reply if we already sent an ack for the same content (shouldn't happen,
          // but guard for pathological cases)
          await send(YOUR_NUMBER, reply);
        } catch (err: unknown) {
          clearTimeout(ackTimer);
          const errMsg = err instanceof Error ? err.message : "Unknown error";
          console.error(`[error] msgid=${msg.id} handler threw: ${errMsg}`);
          await send(YOUR_NUMBER, `❌ Something went wrong: ${errMsg}`);
        }
      });
    },
    onError: (err) => console.error(`[watcher-error] ${err.message}`),
  });

  console.log("📚 Scholar Agent started. Watching for messages...");
}

main().catch(console.error);

// Graceful shutdown
process.on("SIGINT", () => {
  process.exit(0);
});
