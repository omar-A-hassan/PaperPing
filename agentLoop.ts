import {
  getSession,
  upsertSession,
  getSessionLastActivity,
  clearSession,
  MessageTurn,
} from "./db";
import {
  assembleContext,
  maybeCompress,
  endSession,
  SESSION_TTL_MS,
} from "./memory";
import {
  executeTool,
  toAnthropicTools,
  toOpenRouterTools,
} from "./tools";
import { LLM_PROVIDER, LLM_MODEL, ANTHROPIC_API_KEY, OPENROUTER_API_KEY } from "./config";

// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_TOOL_ITERATIONS = 5;

// ─── Anthropic wire types ─────────────────────────────────────────────────────
type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, any> };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
};

// ─── OpenRouter wire types ────────────────────────────────────────────────────
type OpenRouterMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

// ─── agentLoop ────────────────────────────────────────────────────────────────
// The primary entry point. Replaces handleMessage() in agent.ts.
// Returns the final text reply to send to the user.
export async function agentLoop(
  userMessage: string,
  sender: string
): Promise<string> {
  // ── Session boundary check ────────────────────────────────────────────────
  const lastActivity = getSessionLastActivity(sender);
  if (lastActivity) {
    const idleMs = Date.now() - new Date(lastActivity).getTime();
    if (idleMs > SESSION_TTL_MS) {
      // Previous session ended — finalize it in background, start fresh
      endSession(sender).catch((err) =>
        console.error(`[agent-loop] endSession failed: ${err}`)
      );
      clearSession(sender);
    }
  }

  // ── Add user turn to session ──────────────────────────────────────────────
  const session = getSession(sender);
  const history = session?.messages ?? [];
  const updatedHistory: MessageTurn[] = [
    ...history,
    { role: "user", content: userMessage },
  ];
  upsertSession(sender, updatedHistory);

  // ── Assemble context ──────────────────────────────────────────────────────
  const ctx = await assembleContext(sender, userMessage);

  // ── Run LLM loop ──────────────────────────────────────────────────────────
  let finalReply: string;
  try {
    if (LLM_PROVIDER === "openrouter") {
      finalReply = await runOpenRouterLoop(ctx.systemPrompt, ctx.messages, sender);
    } else {
      finalReply = await runAnthropicLoop(ctx.systemPrompt, ctx.messages, sender);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    finalReply = `❌ Something went wrong: ${msg}`;
  }

  // ── Persist assistant turn ────────────────────────────────────────────────
  const sessionAfter = getSession(sender);
  const historyAfter = sessionAfter?.messages ?? [];
  upsertSession(sender, [
    ...historyAfter,
    { role: "assistant", content: finalReply },
  ]);

  // ── Compress if needed (async, non-blocking) ──────────────────────────────
  maybeCompress(sender).catch((err) =>
    console.error(`[agent-loop] compress failed: ${err}`)
  );

  return finalReply;
}

// ─── Anthropic loop ───────────────────────────────────────────────────────────
async function runAnthropicLoop(
  systemPrompt: string,
  contextMessages: MessageTurn[],
  sender: string
): Promise<string> {
  const tools = toAnthropicTools();
  // Convert MessageTurn[] to Anthropic wire format
  const messages: AnthropicMessage[] = contextMessages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string"
      ? m.content
      : (m.content as AnthropicContent[]),
  }));

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const body: Record<string, any> = {
      model: LLM_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools,
    };

    // On last iteration, don't allow tool use — force text response
    if (iteration === MAX_TOOL_ITERATIONS - 1) {
      body.tool_choice = { type: "none" };
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json();
    const content: AnthropicContent[] = data.content ?? [];
    const stopReason: string = data.stop_reason ?? "end_turn";

    // Add assistant turn to messages
    messages.push({ role: "assistant", content });

    // If no tool calls, extract text and return
    const toolUseBlocks = content.filter((b) => b.type === "tool_use") as Array<{
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, any>;
    }>;

    if (stopReason !== "tool_use" || toolUseBlocks.length === 0) {
      const textBlock = content.find((b) => b.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      return textBlock?.text?.trim() ?? "I'm not sure how to respond to that.";
    }

    // Execute all tool calls and collect results
    const toolResults: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }> = [];

    for (const block of toolUseBlocks) {
      console.log(`[tool] ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`);
      const result = await executeTool(block.name, block.input, sender);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
      });
    }

    // Add tool results as a user turn
    messages.push({ role: "user", content: toolResults as any });
  }

  // Should not reach here (last iteration forces text), but safety fallback
  return "I ran into an issue processing your request. Please try again.";
}

// ─── OpenRouter loop ──────────────────────────────────────────────────────────
export async function runOpenRouterLoop(
  systemPrompt: string,
  contextMessages: MessageTurn[],
  sender: string
): Promise<string> {
  const tools = toOpenRouterTools();
  const messages: OpenRouterMessage[] = [
    { role: "system", content: systemPrompt },
    ...contextMessages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: typeof m.content === "string" ? m.content : null,
    })),
  ];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const body: Record<string, any> = {
      model: LLM_MODEL,
      max_tokens: 1024,
      reasoning: { effort: "none" },
      messages,
      tools,
    };

    // Force text on last iteration
    if (iteration === MAX_TOOL_ITERATIONS - 1) {
      delete body.tools;
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();
    const choice = data?.choices?.[0];
    const message = choice?.message;

    if (!message) {
      throw new Error("OpenRouter: empty response");
    }

    // No tool calls → return text.
    // We intentionally do NOT check finish_reason here — many models (Nemotron,
    // Mistral, Llama, etc.) return "stop" even when emitting tool_calls.
    // The only reliable signal is whether tool_calls is populated.
    if (!message.tool_calls || message.tool_calls.length === 0) {
      const text = extractOpenRouterText(message);
      return text || "I'm not sure how to respond to that.";
    }

    // Add assistant turn with tool calls
    messages.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: message.tool_calls,
    });

    // Execute tool calls
    for (const toolCall of message.tool_calls) {
      let input: Record<string, any> = {};
      try {
        input = JSON.parse(toolCall.function.arguments);
      } catch {
        input = {};
      }

      console.log(`[tool] ${toolCall.function.name}(${JSON.stringify(input).slice(0, 80)})`);
      const result = await executeTool(toolCall.function.name, input, sender);

      messages.push({
        role: "tool",
        content: result.content,
        tool_call_id: toolCall.id,
      });
    }
  }

  return "I ran into an issue processing your request. Please try again.";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractOpenRouterText(message: any): string {
  if (typeof message?.content === "string") return message.content.trim();
  if (Array.isArray(message?.content)) {
    return message.content
      .map((b: any) => (typeof b?.text === "string" ? b.text : ""))
      .join("")
      .trim();
  }
  return "";
}
