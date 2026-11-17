import { createHash } from "node:crypto";
import type { SuggestionCard } from "../types";

type ExplicitProfileChange = { content: string; match?: string };

/** Bind only literal facts or replacements named in the current user message. */
export function explicitProfileChange(userMessage: string): ExplicitProfileChange | null {
  const text = userMessage.trim();
  if (!text || text.length > 2000 || /[\r\n]/u.test(text)) return null;
  const replacement = text.match(/^(?:请\s*)?更新我的情况[：:]\s*把[「“]([^」”]+)[」”]\s*改(?:成|为)[「“]([^」”]+)[」”][。.]?$/u)
    || text.match(/^(?:please\s+)?update my profile:\s*replace "([^"]+)" with "([^"]+)"[.]?$/iu);
  if (replacement && replacement[1].trim() && replacement[2].trim()) return { match: replacement[1].trim(), content: replacement[2].trim() };
  const append = text.match(/^(?:请\s*)?记住(?:[：:]\s*|\s*(?=我))(.+)$/u)
    || text.match(/^(?:please\s+)?remember that\s+(.+)$/iu);
  const content = append?.[1]?.trim();
  return content ? { content } : null;
}

/** A chat can propose a profile change; only the existing suggestion apply path writes it. */
export function createChatMemoryProposal(call: Record<string, unknown>, targetPath: string): SuggestionCard {
  const action = String(call.action || "append_profile");
  if (!["append_profile", "update_profile", "retire_profile"].includes(action)) throw new Error("unsupported-memory-action");
  const content = String(call.content || "").trim();
  const match = String(call.match || "").trim();
  const section = String(call.section || "").trim();
  if (action !== "retire_profile" && (!content || content.length > 2000)) throw new Error("memory-content-required-max-2000");
  if (action !== "append_profile" && (!match || match.length > 500)) throw new Error("memory-match-required-max-500");
  if (section.length > 100) throw new Error("memory-section-too-long");
  const payload: Record<string, unknown> = { action };
  if (section) payload.section = section;
  if (action === "append_profile") payload.entry = content;
  if (action === "update_profile") { payload.match = match; payload.content = content; }
  if (action === "retire_profile") payload.match = match;
  const id = `chat-memory-${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16)}`;
  return {
    id, kind: "promote_memory", title: String(call.title || action).slice(0, 100),
    summary: action === "update_profile" ? `${match}\n→ ${content}` : content || match,
    impact: "medium", targetPath, payload,
  };
}
