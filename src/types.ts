// ── Shared type definitions ────────────────────────────────────────────────

/** Narrow `unknown` to a plain object record (rejects arrays and null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * AI provider identifiers — aligned with Desktop's provider IDs.
 * Adding providers here automatically makes them available in settings + AI adapter.
 */
export type AiProviderType =
  | "none"
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "moonshot"
  | "zhipu"
  | "minimax"
  | "xai"
  | "ollama"
  | "custom";

const AI_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "none",
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "moonshot",
  "zhipu",
  "minimax",
  "xai",
  "ollama",
  "custom",
]);

export function isAiProviderType(value: unknown): value is AiProviderType {
  return typeof value === "string" && AI_PROVIDER_TYPES.has(value);
}

/** Writeback mode */
export type WritebackMode = "auto" | "confirm";

/** Timeline sort order */
export type TimelineOrder = "desc" | "asc";

/** Capture target */
export type CaptureTarget = "stream" | "inbox";

/**
 * Multi-provider API key storage — mirrors Desktop's `ai.manual` structure.
 * All keys are stored simultaneously; the user picks a `sourcePreference`.
 * (Type alias, not interface — so it carries an implicit index signature
 * when treated as `Record<string, unknown>` during settings restore.)
 */
export type AiManualKeys = {
  openAiKey: string;
  anthropicKey: string;
  googleKey: string;
  xaiKey: string;
  groqKey: string;
  mistralKey: string;
  openrouterKey: string;
  deepseekKey: string;
  moonshotKey: string;
  zhipuKey: string;
  minimaxKey: string;
  qwenKey: string;
  doubaoKey: string;
  siliconflowKey: string;
  baiduKey: string;
  hunyuanKey: string;
  customBaseUrl: string;
  customKey: string;
  ollamaBaseUrl: string;
  /** Optional per-provider base URL overrides (proxy / regional endpoint). */
  baseUrlOverrides: Record<string, string>;
};

/**
 * AI configuration block — aligned with Desktop's `ai` settings shape.
 * Supports multi-provider simultaneously (not one-at-a-time like the old model).
 */
export interface AiConfig {
  /** Preferred provider ID ("" = auto, picks first configured). */
  sourcePreference: string;
  /** Default model override (empty = provider default). */
  defaultModel: string;
  /** All provider keys — configure once, switch preference anytime. */
  manual: AiManualKeys;
}

/** Plugin settings */
export interface TopmindSettings {
  // ── Stream Workbench ──
  autoOpenWorkbench: boolean;
  timelineOrder: TimelineOrder;
  autoTag: boolean;
  /** "" = auto (follow Obsidian locale), "zh-CN" / "en-US" = override. */
  localeOverride: string;
  /** Stream + memory browse: dense list vs single-column cards. */
  feedLayout: "list" | "card";

  // ── AI (multi-provider, aligned with Desktop) ──
  ai: AiConfig;
  /** Legacy compat — migrated to ai.sourcePreference on load. Still read by old code paths. */
  aiProvider: AiProviderType;
  aiApiKey: string;
  aiBaseUrl: string;
  aiModel: string;
  writebackMode: WritebackMode;
  /** Host pref; Desktop name is autoPrepareSuggestions (same semantics). */
  autoSuggest: boolean;
  autoMaintainTodos: boolean;
  /** Agent tool→reason loop budget per chat turn (3–80, default 32). Desktop maxAgentSteps parity. */
  maxAgentSteps: number;

  // ── Security & Archive ──
  backupKeep: number;
  receiptKeep: number;
}

/** Empty multi-provider key store. */
export const EMPTY_AI_MANUAL: AiManualKeys = {
  openAiKey: "",
  anthropicKey: "",
  googleKey: "",
  xaiKey: "",
  groqKey: "",
  mistralKey: "",
  openrouterKey: "",
  deepseekKey: "",
  moonshotKey: "",
  zhipuKey: "",
  minimaxKey: "",
  qwenKey: "",
  doubaoKey: "",
  siliconflowKey: "",
  baiduKey: "",
  hunyuanKey: "",
  customBaseUrl: "",
  customKey: "",
  ollamaBaseUrl: "",
  baseUrlOverrides: {},
};

/** Default settings */
export const DEFAULT_SETTINGS: TopmindSettings = {
  // Stream
  autoOpenWorkbench: false,
  timelineOrder: "desc",
  autoTag: true,
  localeOverride: "",
  feedLayout: "list",

  // AI — multi-provider model (aligned with Desktop)
  ai: {
    sourcePreference: "",
    defaultModel: "",
    manual: { ...EMPTY_AI_MANUAL },
  },
  // Legacy compat fields (migrated on load; not used for new multi-provider path)
  aiProvider: "none",
  aiApiKey: "",
  aiBaseUrl: "https://api.deepseek.com/v1",
  aiModel: "deepseek-chat",
  // Display cache only — operational truth is topmind.yaml writeback.mode.
  // Default matches the contract default ("auto") so an uninitialized workspace
  // never shows "confirm" while the Kernel would run "auto".
  writebackMode: "auto",
  autoSuggest: true,
  autoMaintainTodos: false,
  maxAgentSteps: 32,

  // Security
  backupKeep: 3,
  receiptKeep: 50,
};

/**
 * Migrate old single-provider settings to the new multi-provider model.
 * Called during loadSettings — ensures seamless upgrade for existing users.
 *
 * Migration rules:
 * - If `ai.manual` already has keys → new model is active, keep legacy fields in sync.
 * - If old `aiProvider` !== "none" and has an `aiApiKey` → populate the matching
 *   key in `ai.manual` and set `sourcePreference`.
 * - Ollama (no key needed) → set `ollamaBaseUrl` from `aiBaseUrl`.
 * - Custom → set `customBaseUrl` + `customKey`.
 */
export function migrateSettings(raw: Record<string, unknown>): TopmindSettings {
  // Deep-clone DEFAULT_SETTINGS to avoid mutating the shared constant.
  // Object.assign only shallow-copies, so nested objects like `ai` would
  // be shared references — mutation in one call would corrupt all subsequent calls.
  const merged: TopmindSettings = structuredClone(DEFAULT_SETTINGS);
  // Preserve unknown top-level keys (future schema) without losing the typed shape.
  Object.assign(merged, raw);

  const rawAi = isRecord(raw.ai) ? raw.ai : null;
  const nextAi: AiConfig = {
    // Keep unknown raw.ai keys (future schema additions) so load→save
    // cycles don't silently strip them.
    sourcePreference: "",
    defaultModel: "",
    manual: { ...EMPTY_AI_MANUAL },
  };
  if (rawAi) {
    Object.assign(nextAi, rawAi);
  }
  merged.ai = nextAi;

  if (merged.feedLayout !== "list" && merged.feedLayout !== "card") {
    merged.feedLayout = "list";
  }

  // If raw has an ai object, merge its fields into our deep-cloned copy
  if (rawAi) {
    if (typeof rawAi.sourcePreference === "string") {
      merged.ai.sourcePreference = rawAi.sourcePreference;
    }
    if (typeof rawAi.defaultModel === "string") {
      merged.ai.defaultModel = rawAi.defaultModel;
    } else if (rawAi.defaultModel === null || rawAi.defaultModel === undefined) {
      merged.ai.defaultModel = "";
    }
    if (isRecord(rawAi.manual)) {
      const manual: AiManualKeys = { ...EMPTY_AI_MANUAL };
      Object.assign(manual, rawAi.manual);
      merged.ai.manual = manual;
    }
  }

  // Ensure manual has all keys (forward compat — new providers added later)
  merged.ai.manual = { ...EMPTY_AI_MANUAL, ...merged.ai.manual };

  // Migrate old single-provider fields if manual is empty and aiProvider is set
  const oldProvider = typeof raw.aiProvider === "string" ? raw.aiProvider : undefined;
  const oldKey = typeof raw.aiApiKey === "string" ? raw.aiApiKey : undefined;
  const oldBaseUrl = typeof raw.aiBaseUrl === "string" ? raw.aiBaseUrl : undefined;
  const oldModel = typeof raw.aiModel === "string" ? raw.aiModel : undefined;

  // Only string secrets count — `baseUrlOverrides: {}` is always present and
  // must not block legacy single-provider migration.
  const hasAnyNewKey = Object.entries(merged.ai.manual).some(
    ([k, v]) => k !== "baseUrlOverrides" && typeof v === "string" && v,
  );

  if (!hasAnyNewKey && oldProvider && oldProvider !== "none") {
    const m = merged.ai.manual;
    switch (oldProvider) {
      case "openai":
        m.openAiKey = oldKey || "";
        break;
      case "anthropic":
        m.anthropicKey = oldKey || "";
        break;
      case "deepseek":
        m.deepseekKey = oldKey || "";
        break;
      case "ollama":
        m.ollamaBaseUrl = oldBaseUrl || "http://127.0.0.1:11434/v1";
        break;
      case "custom":
        m.customBaseUrl = oldBaseUrl || "";
        m.customKey = oldKey || "";
        break;
    }
    merged.ai.sourcePreference = oldProvider;
    merged.ai.defaultModel = oldModel || "";
  }

  // Sync legacy aiProvider from sourcePreference for backward compat
  if (merged.ai.sourcePreference && isAiProviderType(merged.ai.sourcePreference)) {
    merged.aiProvider = merged.ai.sourcePreference;
  }

  // ── Type normalization: a damaged data.json (hand-edited, partially written)
  // must not leak junk values into the UI or the Kernel env bridge. Mirrors
  // Desktop's per-field normalize in settings-core.
  if (merged.timelineOrder !== "asc" && merged.timelineOrder !== "desc") {
    merged.timelineOrder = "desc";
  }
  if (merged.writebackMode !== "auto" && merged.writebackMode !== "confirm") {
    merged.writebackMode = "auto";
  }
  if (
    merged.localeOverride !== "" &&
    merged.localeOverride !== "zh-CN" &&
    merged.localeOverride !== "en-US"
  ) {
    merged.localeOverride = "";
  }
  const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  merged.backupKeep = clampInt(merged.backupKeep, 0, 10, 3);
  merged.receiptKeep = clampInt(merged.receiptKeep, 10, 200, 50);
  merged.maxAgentSteps = clampInt(merged.maxAgentSteps, 3, 80, 32);
  merged.autoOpenWorkbench = merged.autoOpenWorkbench === true;
  merged.autoTag = merged.autoTag !== false;
  merged.autoSuggest = merged.autoSuggest !== false;
  merged.autoMaintainTodos = merged.autoMaintainTodos === true;

  return merged;
}

/**
 * Check if any provider is configured (has a key or URL).
 */
export function hasConfiguredProvider(ai: AiConfig): boolean {
  const m = ai.manual;
  return Boolean(
    m.openAiKey ||
      m.anthropicKey ||
      m.googleKey ||
      m.xaiKey ||
      m.groqKey ||
      m.mistralKey ||
      m.openrouterKey ||
      m.deepseekKey ||
      m.moonshotKey ||
      m.zhipuKey ||
      m.minimaxKey ||
      m.qwenKey ||
      m.doubaoKey ||
      m.siliconflowKey ||
      m.baiduKey ||
      m.hunyuanKey ||
      (m.customBaseUrl && m.customKey) ||
      m.ollamaBaseUrl,
  );
}

/**
 * Get the key/URL for a specific provider from the manual keys.
 */
export function getProviderKey(provider: string, manual: AiManualKeys): string {
  switch (provider) {
    case "openai": return manual.openAiKey;
    case "anthropic": return manual.anthropicKey;
    case "google": return manual.googleKey;
    case "xai": return manual.xaiKey;
    case "groq": return manual.groqKey;
    case "mistral": return manual.mistralKey;
    case "openrouter": return manual.openrouterKey;
    case "deepseek": return manual.deepseekKey;
    case "moonshot": return manual.moonshotKey;
    case "zhipu": return manual.zhipuKey;
    case "minimax": return manual.minimaxKey;
    case "qwen": return manual.qwenKey;
    case "doubao": return manual.doubaoKey;
    case "siliconflow": return manual.siliconflowKey;
    case "baidu": return manual.baiduKey;
    case "hunyuan": return manual.hunyuanKey;
    case "custom": return manual.customKey;
    case "ollama": return "ollama"; // sentinel — no real key needed
    default: return "";
  }
}

/** Stream period info */
export interface StreamPeriod {
  period: string;
  relPath: string;
  title: string;
  entryCount: number;
  mtime: number;
  /** Kernel list flag: false = still needs tidy (未整理). Stamp absence is not this signal. */
  reconciled?: boolean;
}

/** Stream entry (parsed from period note) */
export interface StreamEntry {
  time: string;
  text: string;
  tags: string[];
  rawLine: string;
  lineOffset: number;
  heading?: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Suggestion card data.
 *
 * `kind` aligns with the Kernel suggest-engine kinds (single truth: the kinds
 * `generateSuggestions` / ai-operation-engine actually emit):
 * - suggest-engine rules: `inbox_organize` | `stale_topic` | `catch_all` |
 *   `stream_digest` | `promote_memory` | `open_profile`
 * - suggest-engine AI blocks: `ai_summary` (activity digest)
 * - ai-operation-engine ops: `create_topic` (topic_classify),
 *   `promote_memory`/`ai_summary` (memory_organize)
 *
 * `inbox_review` is no longer emitted (age is a placement review via
 * `inbox_organize`, not an archive card). Kernel keeps a legacy apply case.
 *
 * `todo_extract` / `topic_classify` are operation ids, never card kinds —
 * they must not appear here (parity guarded by tests/suggest-surface-parity).
 */
export interface SuggestionCard {
  id: string;
  kind: SuggestionKind;
  title: string;
  summary: string;
  impact: ImpactLevel;
  payload?: Record<string, unknown>;
  targetPath?: string;
}

/** All suggestion kinds the Kernel may produce. */
export type SuggestionKind =
  | "create_topic"
  | "promote_memory"
  | "ai_summary"
  | "inbox_organize"
  | "stale_topic"
  | "catch_all"
  | "stream_digest"
  | "open_profile";

/** Impact level (matches Kernel suggest-engine). */
export type ImpactLevel = "high" | "medium" | "low";

/**
 * Todo item — field names align with Kernel todo-engine TodoItem (`done`, not `completed`).
 */
export interface TodoItem {
  id: string;
  text: string;
  /** Completion status (Kernel field name is `done`). */
  done: boolean;
  dueDate?: string;
  createdAt?: string;
  completedAt?: string;
  source?: string;
  /** Period note where this todo was extracted from (e.g. "2026-W32"). */
  sourcePeriod?: string;
}
