// ─── LLM provider config ──────────────────────────────────────────────────────
// Single source of truth for LLM configuration, shared across all modules.

export const YOUR_NUMBER        = process.env.YOUR_PHONE_NUMBER  ?? "+1234567890";
export const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  ?? "";
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
export const XAI_API_KEY        = process.env.XAI_API_KEY        ?? "";
export const GEMINI_API_KEY     = process.env.GEMINI_API_KEY     ?? "";

export const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();
export const LLM_MODEL    = process.env.LLM_MODEL
  ?? (LLM_PROVIDER === "openrouter" ? "openrouter/auto" : "claude-sonnet-4-5");

// ─── Vision model ─────────────────────────────────────────────────────────────
// VISION_MODEL may differ from LLM_MODEL when the chosen text model (e.g. a
// reasoning model like deepseek-r1) doesn't support image input.
// Always uses LLM_PROVIDER's endpoint — only the model slug may differ.
export const VISION_MODEL = process.env.VISION_MODEL ?? (() => {
  switch (LLM_PROVIDER) {
    case "openrouter": return "qwen/qwen2.5-vl-32b-instruct:free";
    case "grok":       return "grok-2-vision-1212";
    case "gemini":     return "gemini-2.5-flash";
    default:           return LLM_MODEL; // anthropic: same model supports vision
  }
})();
