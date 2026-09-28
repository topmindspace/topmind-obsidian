// ── i18n: lightweight bilingual support (zh-CN default, en-US fallback) ─────
//
// Same pattern as UTR's i18n-strings.mjs — no external i18n library needed.
// Locale resolved from Obsidian's getLanguage() (public API since 1.8.7)
// or plugin settings. Falls back to navigator.language / zh-CN.

import { getLanguage } from "obsidian";
import { zhCN } from "./locales/zh-CN";
import { enUS } from "./locales/en-US";

type LocaleStrings = typeof zhCN;
export type LocaleKey = keyof LocaleStrings;

const LOCALES: Record<string, LocaleStrings> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

let currentLocale: string = "zh-CN";

/** Map any language tag to a supported locale. */
export function normalizeLocale(locale: string | null | undefined): "zh-CN" | "en-US" {
  const raw = String(locale || "").trim();
  if (!raw) return "zh-CN";
  if (raw === "zh-CN" || raw === "en-US") return raw;
  if (raw.startsWith("zh")) return "zh-CN";
  if (raw.startsWith("en")) return "en-US";
  // Unknown tag (fr, ja, …) → English is the safer product default.
  return "en-US";
}

/** Read Obsidian's current UI language via the public API. */
export function detectObsidianLocale(): string {
  try {
    const lang = getLanguage();
    if (typeof lang === "string" && lang) return lang;
  } catch {
    /* getLanguage may throw on very old hosts — fall through */
  }
  if (typeof navigator !== "undefined" && navigator.language) {
    return navigator.language;
  }
  return "zh-CN";
}

/** Set the active locale */
export function setLocale(locale: string): void {
  currentLocale = normalizeLocale(locale);
}

/** Get the active locale */
export function getLocale(): string {
  return currentLocale;
}

/** Translate a key, with optional {{var}} interpolation. */
export function t(key: LocaleKey, vars?: Record<string, string | number>): string {
  const strings = LOCALES[currentLocale] || LOCALES["zh-CN"];
  let s = strings[key] || zhCN[key] || String(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return s;
}
