// ─── LLM provider config ──────────────────────────────────────────────────────
// Single source of truth for LLM configuration, shared across all modules.

export const YOUR_NUMBER = process.env.YOUR_PHONE_NUMBER ?? "+1234567890";
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
export const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();
export const LLM_MODEL =
  process.env.LLM_MODEL ??
  (LLM_PROVIDER === "openrouter" ? "openrouter/auto" : "claude-sonnet-4-5");
