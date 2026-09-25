// ── AI Provider: requestUrl-based adapter for Kernel AiProvider interface ───
//
// Multi-provider support — aligned with Desktop's provider list:
//   OpenAI · Anthropic · Google Gemini · DeepSeek · Moonshot · Zhipu ·
//   MiniMax · xAI · Ollama · Custom
//
// API call strategies:
//   - OpenAI-compatible (OpenAI, DeepSeek, Moonshot, Zhipu, MiniMax, xAI, Ollama, Custom)
//     → POST {baseUrl}/chat/completions
//   - Anthropic native → POST {baseUrl}/messages
//   - Google Gemini → POST {baseUrl}/models/{model}:generateContent
//
// The Kernel's AiProvider interface is:
//   { generate(prompt: string, context?: object) => Promise<string> }
//
// Includes transient error retry (matches Kernel's AI provider resilience).
//
// CRITICAL: Uses Obsidian's `requestUrl` instead of raw `fetch`.
// Obsidian's CSP blocks `fetch` to external URLs on some platforms
// (especially Windows), causing AI API calls to fail silently.
// `requestUrl` bypasses CSP and is the recommended HTTP API for Obsidian plugins.

import { requestUrl } from "obsidian";
import type { TopmindSettings } from "../types";
import { AI_PROVIDER_PRESETS } from "../constants.ts";
import { isTransientError, isRecord, isUnknownArray } from "../utils.ts";
import { getProviderKey, hasConfiguredProvider } from "../types.ts";

// Re-export for callers that previously imported from this module
export { isTransientError };

export interface AiProvider {
  generate(prompt: string, context?: unknown): Promise<string>;
}

/** Max retry attempts for transient errors (5xx, 429, network). */
const MAX_RETRIES = 2;
/** Base retry delay in ms (exponential backoff: delay * 2^attempt). */
const RETRY_BASE_DELAY = 500;

/**
 * Per-operation request timeout (ms). Non-streaming `requestUrl` must cover the
 * whole generation — Desktop's 30s floor killed long agent turns mid-task.
 * Short extraction stays tight; chat / analysis get a real budget.
 */
const OP_TIMEOUT_MS: Record<string, number> = {
  memory_extract: 60_000,
  topic_classify: 60_000,
  todo_extract: 60_000,
  todo_maintain: 120_000,
  memory_organize: 180_000,
  inbox_organize: 180_000,
  period_analysis: 300_000,
  period_digest: 300_000,
  topic_summary: 300_000,
  chat: 480_000,
};
const DEFAULT_TIMEOUT_MS = 180_000;

function resolveTimeoutMs(operation: string): number {
  return OP_TIMEOUT_MS[operation] || DEFAULT_TIMEOUT_MS;
}

// ── Legacy compat: resolve from old single-provider settings ────────────────

/**
 * Resolve the effective base URL and model from settings + provider presets.
 * Uses the new multi-provider `ai.manual` if keys are configured there,
 * falling back to legacy `aiProvider`/`aiApiKey`/`aiBaseUrl`/`aiModel`.
 */
export function resolveAiEndpoint(settings: TopmindSettings): {
  baseUrl: string;
  model: string;
  apiKey: string;
  provider: string;
} {
  // Try new multi-provider model first
  const ai = settings.ai;
  const overrides = ai.manual.baseUrlOverrides || {};
  const overrideOf = (id: string) => {
    const v = overrides[id];
    return typeof v === "string" ? v.trim().replace(/\/+$/u, "") : "";
  };
  if (ai && hasConfiguredProvider(ai)) {
    const pref = ai.sourcePreference || "";
    // If preference is set and has a key, use it
    if (pref && pref !== "none") {
      const meta = AI_PROVIDER_PRESETS[pref];
      const key = getProviderKey(pref, ai.manual);
      // For ollama, URL is sufficient; for others, need key
      const isReady = pref === "ollama"
        ? Boolean(ai.manual.ollamaBaseUrl)
        : Boolean(key);
      if (isReady) {
        const baseUrl = overrideOf(pref)
          || (pref === "ollama"
            ? (ai.manual.ollamaBaseUrl || meta?.baseUrl || "")
            : pref === "custom"
              ? ai.manual.customBaseUrl
              : (meta?.baseUrl || ""));
        const model = ai.defaultModel || meta?.model || "";
        return { baseUrl, model, apiKey: key || "", provider: pref };
      }
      // Preference set but key missing — fall through to auto-select
      // This handles the edge case where user set preference but then cleared the key
    }
    // Auto: pick first configured provider
    for (const [pid, meta] of Object.entries(AI_PROVIDER_PRESETS)) {
      if (pid === "custom" || pid === "ollama") continue;
      const key = getProviderKey(pid, ai.manual);
      if (key) {
        const model = ai.defaultModel || meta.model;
        return { baseUrl: overrideOf(pid) || meta.baseUrl, model, apiKey: key, provider: pid };
      }
    }
    // Check ollama
    if (ai.manual.ollamaBaseUrl) {
      const meta = AI_PROVIDER_PRESETS.ollama;
      return {
        baseUrl: ai.manual.ollamaBaseUrl,
        model: ai.defaultModel || meta.model,
        apiKey: "ollama",
        provider: "ollama",
      };
    }
    // Check custom
    if (ai.manual.customBaseUrl && ai.manual.customKey) {
      return {
        baseUrl: ai.manual.customBaseUrl,
        model: ai.defaultModel || "",
        apiKey: ai.manual.customKey,
        provider: "custom",
      };
    }
  }

  // Fallback: legacy single-provider fields
  const provider = settings.aiProvider || "none";
  const preset = AI_PROVIDER_PRESETS[provider] || AI_PROVIDER_PRESETS.custom;
  const legacyOverride = settings.ai.manual?.baseUrlOverrides?.[provider];
  const baseUrl =
    (typeof legacyOverride === "string" && legacyOverride.trim()) ||
    settings.aiBaseUrl ||
    preset.baseUrl;
  const model = settings.aiModel || preset.model;
  const apiKey = settings.aiApiKey || "";
  return { baseUrl, model, apiKey, provider };
}

/**
 * Create a Kernel-compatible AI Provider from plugin settings.
 * Returns null when AI is not configured (product works without AI).
 *
 * Uses the new multi-provider `ai.manual` if available, falling back to
 * legacy single-provider fields for backward compatibility.
 */
export function createAiProvider(settings: TopmindSettings): AiProvider | null {
  const { provider, baseUrl, model, apiKey } = resolveAiEndpoint(settings);

  if (provider === "none") return null;
  const isOllama = provider === "ollama";
  if (!isOllama && !apiKey) return null;
  if (!baseUrl || !model) return null;

  const meta = AI_PROVIDER_PRESETS[provider];
  const apiType = meta?.apiType || "openai-compat";

  return {
    async generate(prompt: string, context: unknown = {}): Promise<string> {
      const ctx = isRecord(context) ? context : {};
      const operation = typeof ctx.operation === "string" ? ctx.operation : "generic";
      const explicitMaxTokens = typeof ctx.maxOutputTokens === "number" && ctx.maxOutputTokens > 0
        ? ctx.maxOutputTokens
        : undefined;
      const explicitTemperature = typeof ctx.temperature === "number"
        ? ctx.temperature
        : undefined;
      const systemPrompt = typeof ctx.systemPrompt === "string"
        ? ctx.systemPrompt
        : resolveSystemPrompt(operation);
      const maxTokens = explicitMaxTokens ?? resolveMaxTokens(operation);
      const temperature = explicitTemperature ?? resolveTemperature(operation, model);
      const shouldAbort = typeof ctx.shouldAbort === "function"
        ? (ctx.shouldAbort as () => boolean)
        : undefined;
      const foldReasoning = ctx.foldReasoning !== false;

      const callOpts: CallOpts = { systemPrompt, maxTokens, temperature, operation, shouldAbort, foldReasoning };

      try {
        if (apiType === "anthropic") {
          return await callAnthropic(baseUrl, model, apiKey, prompt, callOpts);
        }
        if (apiType === "google") {
          return await callGoogleGemini(baseUrl, model, apiKey, prompt, callOpts);
        }
        return await callOpenAICompatible(baseUrl, model, apiKey, prompt, callOpts);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (callOpts.temperature !== undefined && /temperature.*(?:not supported|unsupported|invalid)/i.test(msg)) {
          const fallbackOpts: CallOpts = { ...callOpts, temperature: undefined };
          if (apiType === "anthropic") {
            return await callAnthropic(baseUrl, model, apiKey, prompt, fallbackOpts);
          }
          if (apiType === "google") {
            return await callGoogleGemini(baseUrl, model, apiKey, prompt, fallbackOpts);
          }
          return await callOpenAICompatible(baseUrl, model, apiKey, prompt, fallbackOpts);
        }
        throw err;
      }
    },
  };
}

// ── OpenAI-compatible API call (/chat/completions) ──────────────────────────

interface CallOpts {
  systemPrompt?: string;
  maxTokens: number;
  temperature?: number;
  operation: string;
  shouldAbort?: () => boolean;
  /** false → return visible body only (no `<think>` fold). Default true (chat). */
  foldReasoning?: boolean;
}

/** Keep provider reasoning out of the visible answer; chat UI folds `<think>`.
 *  `fold: false` returns only the visible body (AI Polish / ops / tests). */
function foldModelReasoning(text: string, reasoning: string, fold = true): string {
  const visible = String(text || "");
  const thought = String(reasoning || "").trim();
  if (!thought) return visible;
  if (!fold) return visible;
  if (visible.includes(thought)) return visible;
  return `<think>\n${thought}\n</think>\n${visible}`;
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

async function callOpenAICompatible(
  baseUrl: string,
  model: string,
  apiKey: string,
  prompt: string,
  opts: CallOpts,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.systemPrompt) {
    messages.push({ role: "system", content: opts.systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.maxTokens,
  };
  if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const send = (msgs: Array<{ role: string; content: string }>) =>
    fetchWithRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, messages: msgs }),
    }, opts.operation, opts.shouldAbort);

  let data: Record<string, unknown>;
  try {
    data = await send(messages);
  } catch (err) {
    // Reasoning models (o1 / DeepSeek-R1 / …) reject a `system` role. Desktop
    // self-heals by folding the system prompt into the first user turn — same
    // recovery here so Obsidian does not hard-fail where Desktop succeeds.
    const msg = err instanceof Error ? err.message : String(err);
    const systemRejected =
      /does not support.*system|unsupported.*system.*role|invalid.*system.*role|system.*role.*(unsupported|invalid|not supported)|only.*user.*and.*assistant/iu.test(msg) ||
      (/\bsystem\b/iu.test(msg) && /\b(role|message|prompt)\b/iu.test(msg) && /\b(unsupported|invalid|not supported|not allowed|reject)/iu.test(msg));
    if (opts.systemPrompt && systemRejected) {
      data = await send([
        { role: "user", content: `${opts.systemPrompt}\n\n---\n\n${prompt}` },
      ]);
    } else {
      throw err;
    }
  }

  // OpenAI-compatible response: { choices: [{ message: { content, reasoning_content } }] }
  const choices = isUnknownArray(data.choices) ? data.choices : [];
  const first = choices[0];
  const message = isRecord(first) && isRecord(first.message) ? first.message : null;
  const text = message && typeof message.content === "string" ? message.content : "";
  const reasoning = message
    ? [message.reasoning_content, message.reasoning]
        .filter((part) => typeof part === "string")
        .join("\n\n")
    : "";
  if (!text && !reasoning) {
    console.warn(`[topmind] AI ${opts.operation}: empty response from ${model}`);
  }
  return foldModelReasoning(text, reasoning, opts.foldReasoning !== false);
}

// ── Anthropic native API call (/v1/messages) ────────────────────────────────

async function callAnthropic(
  baseUrl: string,
  model: string,
  apiKey: string,
  prompt: string,
  opts: CallOpts,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };

  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }
  if (opts.systemPrompt) {
    body.system = opts.systemPrompt;
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/messages`;
  const data = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, opts.operation, opts.shouldAbort);

  // Anthropic response: { content: [{ type: "text", text: "..." }] }
  const contentBlocks = isUnknownArray(data.content) ? data.content : [];
  let text = "";
  let reasoning = "";
  for (const block of contentBlocks) {
    if (!isRecord(block)) continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      reasoning = reasoning ? `${reasoning}\n\n${block.thinking}` : block.thinking;
      continue;
    }
    if (typeof block.text === "string" && (block.type === "text" || !text)) {
      text = block.text;
    }
  }
  if (!text && !reasoning) {
    console.warn(`[topmind] AI ${opts.operation}: empty response from ${model}`);
  }
  return foldModelReasoning(text, reasoning, opts.foldReasoning !== false);
}

// ── Google Gemini API call (/v1beta/models/{model}:generateContent) ─────────

async function callGoogleGemini(
  baseUrl: string,
  model: string,
  apiKey: string,
  prompt: string,
  opts: CallOpts,
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models/${model}:generateContent?key=${apiKey}`;
  // Gemini uses system_instruction for system prompt (separate from contents)
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: opts.maxTokens,
  };
  if (opts.temperature !== undefined) {
    generationConfig.temperature = opts.temperature;
  }
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  };
  if (opts.systemPrompt) {
    body.systemInstruction = {
      parts: [{ text: opts.systemPrompt }],
    };
  }

  const data = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, opts.operation, opts.shouldAbort);

  // Gemini response: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
  const candidates = isUnknownArray(data.candidates) ? data.candidates : [];
  const firstCandidate = candidates[0];
  const parts = isRecord(firstCandidate) && isRecord(firstCandidate.content) && isUnknownArray(firstCandidate.content.parts)
    ? firstCandidate.content.parts
    : [];
  let text = "";
  let reasoning = "";
  for (const part of parts) {
    if (!isRecord(part) || typeof part.text !== "string") continue;
    if (part.thought === true) {
      reasoning = reasoning ? `${reasoning}\n\n${part.text}` : part.text;
    } else {
      text += part.text;
    }
  }
  if (!text && !reasoning) {
    console.warn(`[topmind] AI ${opts.operation}: empty response from ${model}`);
  }
  return foldModelReasoning(text, reasoning, opts.foldReasoning !== false);
}

// ── requestUrl with transient error retry ──────────────────────────────────
//
// Uses Obsidian's `requestUrl` instead of raw `fetch` to bypass CSP
// restrictions that block external HTTP requests on Windows and some
// other platforms. `requestUrl` is the recommended HTTP API for Obsidian
// plugins and works consistently across all platforms.

async function fetchWithRetry(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  operation: string,
  shouldAbort?: () => boolean,
): Promise<Record<string, unknown>> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (shouldAbort?.()) throw abortError();
    try {
      // requestUrl can't cancel the socket. Stop still abandons the result
      // so the agent loop will not run the next tool.
      const requestPromise = requestUrl({
        url,
        method: init.method,
        headers: init.headers,
        body: init.body,
        throw: false, // Handle HTTP errors manually for retry logic
      });

      let timeoutTimer: number | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = window.setTimeout(() => reject(new Error("AI request timeout")), resolveTimeoutMs(operation));
      });
      const racers: Array<Promise<typeof requestPromise extends Promise<infer R> ? R : never>> = [
        requestPromise,
        timeoutPromise,
      ];
      if (shouldAbort) {
        racers.push(new Promise<never>((_, reject) => {
          const timer = window.setInterval(() => {
            if (shouldAbort()) {
              window.clearInterval(timer);
              reject(abortError());
            }
          }, 200);
          void requestPromise.finally(() => window.clearInterval(timer));
        }));
      }

      let res: Awaited<typeof requestPromise>;
      try {
        res = await Promise.race(racers);
      } finally {
        if (timeoutTimer !== undefined) window.clearTimeout(timeoutTimer);
      }

      if (res.status < 200 || res.status >= 300) {
        const errText = res.text || `HTTP ${res.status}`;
        // Retry on 5xx (transient server errors) and 429 (rate limit)
        if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
          // For 429, respect Retry-After header if present
          const retryAfter = res.headers?.["Retry-After"] || res.headers?.["retry-after"];
          const delay = retryAfter
            ? Math.min(parseInt(retryAfter, 10) * 1000, 10_000)
            : RETRY_BASE_DELAY * Math.pow(2, attempt);
          lastError = new Error(`AI ${res.status}: ${errText}`);
          await sleep(delay);
          continue;
        }
        throw new Error(`AI request failed (${res.status}): ${errText}`);
      }

      // Success path: no console noise (Obsidian plugin guidelines).
      const json: unknown = res.json;
      return isRecord(json) ? json : {};
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      // Retry on network errors and timeouts
      if (attempt < MAX_RETRIES && isTransientError(err)) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
        continue;
      }
      // Real failures only — avoid success-path console spam
      console.error(`[topmind] AI ${operation} failed:`, err);
      throw err;
    }
  }

  throw lastError || new Error("AI request failed after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Resolve max_tokens based on operation type.
 * Byte-aligned with Desktop's ai-provider-adapter.mjs OP_LIMITS.
 */
function resolveMaxTokens(operation: string): number {
  switch (operation) {
    case "topic_summary":
      return 16384;
    case "period_analysis":
    case "period_digest":
    case "inbox_organize":
    case "memory_organize":
    case "ai_summary":
    case "write_digest":
    case "todo_extract":
    case "todo_maintain":
      return 12288;
    case "memory_extract":
    case "topic_classify":
      return 4096;
    default:
      return 12288;
  }
}

/**
 * Detect if a model ID is a reasoning / thinking model that prohibits custom temperature.
 * Tight patterns — aligned with Desktop (avoid matching o10-/o30- style ids or
 * generic thinking ids that accept temperature).
 */
export function isReasoningModel(modelId?: string): boolean {
  if (!modelId || typeof modelId !== "string") return false;
  const lower = modelId.toLowerCase();
  return (
    lower.includes("reasoner") ||
    lower.includes("deepseek-r1") ||
    /^o[134](-mini|-preview)?(?:[-/]|$)/.test(lower) ||
    lower.includes("qwq") ||
    /(^|[-/])thinking([-/]|$)/.test(lower)
  );
}

/**
 * Resolve temperature based on operation type and target model capabilities.
 * Aligned with Desktop's ai-provider-adapter.mjs.
 */
function resolveTemperature(operation: string, modelId?: string): number | undefined {
  if (isReasoningModel(modelId)) return undefined;
  switch (operation) {
    case "todo_maintain":
    case "todo_extract":
    case "memory_extract":
    case "memory_organize":
    case "topic_classify":
    case "inbox_organize":
      return 0.3;
    case "period_analysis":
    case "period_digest":
    case "topic_summary":
    case "ai_summary":
    case "write_digest":
      return 0.5;
    case "chat":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Default system prompt for structured output operations.
 * Mirrors Desktop's resolveSystemPrompt — ensures structured ops
 * get clean output without thinking tags or preamble.
 */
const STRUCTURED_OPS = new Set([
  "inbox_organize",
  "topic_classify",
  "memory_organize",
  "todo_extract",
  "todo_maintain",
]);

function resolveSystemPrompt(operation: string): string | undefined {
  if (STRUCTURED_OPS.has(operation)) {
    return "You are a precise content analysis assistant. Follow output format instructions exactly. Output only the requested format — no preamble, no thinking tags, no markdown code fences unless explicitly requested.";
  }
  return undefined;
}
