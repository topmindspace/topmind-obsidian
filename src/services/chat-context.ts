import { classifyTurn, matchQueryIntents } from "#kernel/agent-goal-protocol.mjs";

type ContextKind = "stream" | "todos" | "profile" | "reflections";
type Loaders = Record<ContextKind, () => string | Promise<string>>;

/** Prefetch hints only: all normal read tools remain available to the agent. */
export async function buildChatContext(userText: string, loaders: Loaders): Promise<string[]> {
  const kind = classifyTurn(userText);
  if (kind === "light") return [];
  const tools = new Set(matchQueryIntents(userText)?.tools || []);
  const review = /整理本周|复盘|反思|规划|\b(?:weekly review|reflect|plan my)\b/iu.test(userText);
  const wanted: Record<ContextKind, boolean> = {
    stream: tools.has("list_recent_stream") || review,
    todos: tools.has("list_todos") || review,
    // Preserve durable preferences for work, but a todo lookup needs no profile.
    profile: kind === "task" || tools.has("list_recent_memories"),
    reflections: review,
  };
  const titles: Record<ContextKind, string> = {
    stream: "Recent Stream Entries",
    todos: "Current Todos",
    profile: "User Profile",
    reflections: "Recent Reflections (extracted insights)",
  };
  const parts: string[] = [];
  let remaining = 8000;
  for (const key of Object.keys(wanted) as ContextKind[]) {
    if (!wanted[key] || remaining <= 0) continue;
    try {
      const raw = String(await loaders[key]() || "").trim();
      if (!raw) continue;
      const cap = Math.min(2000, remaining);
      const body = raw.length > cap ? `${raw.slice(0, cap)}\n…(truncated; use read tools for full context)` : raw;
      parts.push(`## ${titles[key]}\n${body}`);
      remaining -= body.length;
    } catch {
      // Missing optional context must not block chat; tools can retry explicitly.
    }
  }
  return parts;
}
