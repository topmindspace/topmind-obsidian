import { createHash } from "node:crypto";
import type { SuggestionCard } from "../types";

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
