/** Chat state belongs to one workspace and one run. Views only render it. */
import { readWorkspaceState, writeWorkspaceState } from "#kernel/workspace-state.mjs";
import { compactChatMessages, resolveChatCompactBudget } from "../utils.ts";
import { persistableChatFocus, type ChatFocus } from "./editor-context.ts";
import type { ChatProgressEvent } from "./chat-agent.ts";
import type { TaskContract } from "#kernel/agent-task-contract.mjs";

export interface ChatGoal {
  task?: TaskContract;
  goal?: string; plan?: string[]; criteria?: string[]; openCriteria?: string[];
  pathReceipts?: string[]; status?: string; blockReason?: string | null;
  autoContinues?: number; checksRun?: string[]; assumptions?: string[];
}
export interface ChatMessage {
  role: "user" | "assistant"; content: string; reasoning?: string; isError?: boolean;
  paused?: boolean; cancelled?: boolean; stopReason?: "paused" | "cancelled";
  prompt?: string; focus?: ChatFocus;
  toolCalls?: Array<{ tool: string; ok: boolean; summary?: string; pending?: boolean; needsConfirm?: boolean }>;
  steps?: number; autoContinues?: number; stepLimitHit?: boolean; goal?: ChatGoal | null;
}
interface Run { id: string; status: "running" | "paused" | "finished"; prompt: string; focus?: ChatFocus; }
interface SessionState { version: 1; messages: ChatMessage[]; goal: ChatGoal | null; run: Run | null; }
interface ChatResult {
  content: string; reasoning?: string; toolCalls?: ChatMessage["toolCalls"]; steps?: number;
  autoContinues?: number; stepLimitHit?: boolean; goal?: ChatGoal | null;
  stopReason?: "paused" | "cancelled";
}
type ChatOptions = {
  focus: ChatFocus | null; shouldAbort: () => boolean; stopKind: () => "paused" | "cancelled";
  contextLimit?: number | null; priorGoal: ChatGoal | null; onProgress: (event: ChatProgressEvent) => void;
};
interface ControllerOptions {
  root: () => string;
  chat: (prompt: string, history: ChatMessage[], options: ChatOptions) => Promise<ChatResult>;
  copy: () => { paused: string; stopped: string; error: string };
}
const FILE = "chat-session.json";
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function validateGoal(value: unknown): value is ChatGoal | null {
  if (value === null) return true;
  if (!record(value)) return false;
  return ["plan", "criteria", "openCriteria", "pathReceipts", "checksRun", "assumptions"].every(key => value[key] === undefined || (Array.isArray(value[key]) && value[key].every(item => typeof item === "string")))
    && ["goal", "status", "blockReason"].every(key => value[key] == null || typeof value[key] === "string");
}
function validateMessages(value: unknown): value is ChatMessage[] {
  return Array.isArray(value) && value.every(message => record(message) && ["user", "assistant"].includes(String(message.role)) && typeof message.content === "string"
    && (message.reasoning === undefined || typeof message.reasoning === "string")
    && (message.prompt === undefined || typeof message.prompt === "string")
    && (message.focus === undefined || (record(message.focus) && typeof message.focus.path === "string"))
    && (message.goal === undefined || validateGoal(message.goal))
    && (message.toolCalls === undefined || (Array.isArray(message.toolCalls) && message.toolCalls.every(call => record(call) && typeof call.tool === "string" && typeof call.ok === "boolean"))));
}
function validateState(value: unknown): value is SessionState {
  return record(value) && value.version === 1 && validateMessages(value.messages) && validateGoal(value.goal)
    && (value.run === null || (record(value.run) && typeof value.run.id === "string" && typeof value.run.prompt === "string" && ["running", "paused", "finished"].includes(String(value.run.status)) && (value.run.focus === undefined || (record(value.run.focus) && typeof value.run.focus.path === "string"))));
}

export class ChatController {
  messages: ChatMessage[] = [];
  goal: ChatGoal | null = null;
  thinking = false;
  paused = false;
  startedAt = 0;
  reasoning = "";
  storageError = "";
  focus: ChatFocus | null = null;
  gate: { aborted: boolean; pause?: boolean } | null = null;
  private run: Run | null = null;
  private closed = false;
  private contextLimit?: number | null;
  constructor(private options: ControllerOptions) {}

  load(): void {
    try {
      const state = readWorkspaceState<SessionState | null>(this.options.root(), FILE, null, validateState);
      if (state) { this.messages = state.messages; this.goal = state.goal; this.run = state.run; }
      else {
        this.messages = readWorkspaceState<ChatMessage[]>(this.options.root(), "chat-history.json", [], validateMessages);
        this.goal = readWorkspaceState<ChatGoal | null>(this.options.root(), "chat-goal.json", null, validateGoal);
      }
      this.focus = this.run?.focus || this.messages.at(-1)?.focus || null;
      this.paused = this.run?.status === "running" || this.run?.status === "paused" || this.messages.at(-1)?.paused === true;
      this.storageError = "";
      this.closed = false;
    } catch (error) { this.storageError = error instanceof Error ? error.message : String(error); }
  }

  private ownsRun(id: string): boolean {
    try {
      const state = readWorkspaceState<SessionState | null>(this.options.root(), FILE, null, validateState);
      return state?.run?.id === id;
    } catch (error) { this.storageError = error instanceof Error ? error.message : String(error); return false; }
  }
  save(): void {
    if (this.storageError) throw new Error(this.storageError);
    const budget = resolveChatCompactBudget(this.contextLimit);
    const messages = compactChatMessages(this.messages, { maxMessages: budget.maxMessages, keepRecent: budget.keepRecent })
      .map(message => ({ ...message, ...(message.focus ? { focus: persistableChatFocus(message.focus) } : {}) }));
    writeWorkspaceState(this.options.root(), FILE, { version: 1, messages, goal: this.goal, run: this.run });
  }
  clear(): void {
    if (this.thinking) return;
    this.messages = []; this.goal = null; this.run = null; this.focus = null; this.paused = false;
    this.save();
  }
  pause(): void {
    if (this.gate) { this.gate.aborted = true; this.gate.pause = true; }
    this.paused = true;
    if (this.run && this.ownsRun(this.run.id)) { this.run.status = "paused"; this.save(); }
  }
  cancel(): void {
    if (this.gate) { this.gate.aborted = true; this.gate.pause = false; }
    this.paused = false; this.goal = null;
    if (this.run && this.ownsRun(this.run.id)) { this.run.status = "finished"; this.save(); }
  }
  close(): void { this.closed = true; if (this.thinking) this.pause(); }

  async send(prompt: string, focus: ChatFocus | null, options: { contextLimit?: number | null; retry?: boolean; onStart?: () => void; onProgress?: (event: ChatProgressEvent) => void; onFinish?: () => void } = {}): Promise<void> {
    if (!prompt.trim() || this.thinking) return;
    if (this.storageError) throw new Error(this.storageError);
    let history: ChatMessage[];
    if (options.retry) {
      const lastUser = this.messages.map(message => message.role).lastIndexOf("user");
      if (lastUser < 0 || this.messages[lastUser].content !== prompt) throw new Error("retry-target-is-not-last-turn");
      focus = focus || this.messages[lastUser].focus || null;
      this.messages = this.messages.slice(0, lastUser + 1);
      history = this.messages.slice(0, lastUser);
    } else {
      history = [...this.messages];
      this.messages.push({ role: "user", content: prompt, focus: persistableChatFocus(focus) });
    }
    const gate = { aborted: false, pause: false };
    this.gate = gate; this.thinking = true; this.paused = false; this.reasoning = ""; this.startedAt = Date.now(); this.contextLimit = options.contextLimit;
    this.focus = focus;
    this.run = { id: `run-${Date.now()}-${Math.random().toString(36).slice(2)}`, status: "running", prompt, focus: persistableChatFocus(focus) };
    const id = this.run.id;
    let persisted = false;
    try {
      this.save(); persisted = true; options.onStart?.();
      const result = await this.options.chat(prompt, history, {
        focus, contextLimit: options.contextLimit, priorGoal: this.goal,
        shouldAbort: () => gate.aborted || !this.ownsRun(id),
        stopKind: () => gate.pause ? "paused" : "cancelled",
        onProgress: event => {
          if (!this.ownsRun(id)) return;
          if (event.reasoning) this.reasoning = event.reasoning;
          if (event.goal) this.goal = event.goal;
          if (event.kind === "checkpoint") this.save();
          if (!this.closed) options.onProgress?.(event);
        },
      });
      if (!this.ownsRun(id)) return;
      const stopReason = result.stopReason || (gate.pause ? "paused" : gate.aborted ? "cancelled" : undefined);
      const copy = this.options.copy();
      this.goal = stopReason === "cancelled" ? null : result.goal || this.goal;
      this.messages.push({ role: "assistant", content: result.content || (stopReason === "paused" ? copy.paused : stopReason === "cancelled" ? copy.stopped : "..."), reasoning: result.reasoning || this.reasoning || undefined,
        prompt, focus: persistableChatFocus(focus), toolCalls: result.toolCalls, steps: result.steps, autoContinues: result.autoContinues, stepLimitHit: result.stepLimitHit,
        paused: stopReason === "paused" || undefined, cancelled: stopReason === "cancelled" || undefined, stopReason, goal: this.goal });
      this.paused = stopReason === "paused";
      this.run.status = this.paused ? "paused" : "finished";
      this.save();
    } catch (error) {
      if (!persisted) { this.storageError = error instanceof Error ? error.message : String(error); throw error; }
      if (this.ownsRun(id)) {
        const copy = this.options.copy();
        this.paused = gate.pause;
        this.messages.push({ role: "assistant", content: gate.aborted ? (gate.pause ? copy.paused : copy.stopped) : `${copy.error}: ${error instanceof Error ? error.message : String(error)}`,
          isError: !gate.aborted || undefined, prompt, focus: persistableChatFocus(focus), paused: gate.pause || undefined, goal: gate.pause ? this.goal : null });
        this.run.status = gate.pause ? "paused" : "finished";
        this.save();
      }
    } finally {
      this.gate = null; this.thinking = false; this.reasoning = "";
      if (!this.closed) options.onFinish?.();
    }
  }
}
