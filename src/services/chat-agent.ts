/** Conversation/goal orchestration. Filesystem operations live in kernel-workspace-ops. */
import fs from "node:fs";
import { estimateTokens, resolveContextBudget, clipContext, compactPromptBlocks, articleHistory, needsActiveDocument } from "#kernel/agent-context-policy.mjs";
import path from "node:path";
import type { KernelApi } from "../bridge/kernel-loader.ts";
import { stripFrontmatter, isRecord, parseJsonUnknown, compactChatMessages } from "../utils.ts";
import { AGENT_STEPS_MIN, AGENT_STEPS_MAX, AGENT_STEPS_DEFAULT, MAX_AUTO_CONTINUES, clampMaxAgentSteps, describeWritebackModeForPrompt } from "#kernel/agent-policy.mjs";
export { AGENT_STEPS_MIN, AGENT_STEPS_MAX, AGENT_STEPS_DEFAULT, MAX_AUTO_CONTINUES, clampMaxAgentSteps };
import { memoryFence } from "#kernel/agent-tool-policy.mjs";
import { buildAgentToolCatalog, formatAgentToolGuide, normalizeAgentToolCall, filterAgentToolsForTurn } from "#kernel/agent-tool-catalog.mjs";
import { classifyTurn, type TurnKind, applyGoalUpdate, assessGoalCompletion, buildContinuePrompt, buildGoalProtocolPrompt, buildTaskLedger, decideAutoContinue, harvestPathReceipts, rejectBareDone, resolveMaxAutoContinues, restoreSessionGoal, type GoalState } from "#kernel/agent-goal-protocol.mjs";
import { runAgentTool, loadSkill } from "./workspace-agent-tools.ts";
import { resolveTaskContract, createTaskExecutionGuard, taskContractPrompt, taskAllowsTool, taskStopMessage, documentTaskOutcome, workspaceWriteOutcome, resumesWorkspaceTask, resumeExecutionPrompt, isTaskExecutionCheckpoint, type TaskIntent, type TaskContract, type TaskExecutionCheckpoint } from "#kernel/agent-task-contract.mjs";
import { getPendingWriteReviews } from "#kernel/pending-writes.mjs";
import { captureToWorkspace, readWorkspaceWindow, preciseEditWorkspace, resolveContractWritebackMode, appendStreamEntryToWorkspace } from "./kernel-workspace-ops.ts";
import { explicitProfileChange } from "./chat-memory-proposal.ts";

export type WorkspaceChatGenerate = (
  prompt: string,
  context?: Record<string, unknown>,
) => Promise<string>;

export interface ChatProgressEvent {
  kind: "step" | "tool" | "continue" | "done" | "checkpoint";
  goal?: { task?: TaskContract; execution?: TaskExecutionCheckpoint; goal: string; plan: string[]; criteria: string[]; openCriteria: string[]; pathReceipts: string[]; modifiedPaths?: string[]; status: string; blockReason: string | null; autoContinues: number };
  step: number;
  maxSteps: number;
  tool?: string;
  autoContinues?: number;
  note?: string;
  /** Folded reasoning so far (API reasoning_content / <think>), not the answer. */
  reasoning?: string;
}

export interface WorkspaceChatTurnOpts {
  taskContract?: TaskContract;
  configDir?: string;
  userMessage: string;
  history?: Array<{ role: "user" | "assistant"; content: string; focus?: {path: string} }>;
  focus?: { path: string; unsaved?: boolean; contentHash?: string; taskIntent?: TaskIntent } | null;
  beforeWrite?: (relativePaths: string[]) => string | null;
  onMemoryProposal?: (call: Record<string, unknown>) => { id: string; targetPath: string };
  generate: WorkspaceChatGenerate;
  locale?: string;
  writebackMode?: "auto" | "confirm";
  systemExtra?: string;
  maxSteps?: number;
  /** Auto-continue when the step budget is exhausted mid-task (default true). */
  autoContinue?: boolean;
  /** Model context window (tokens) — scales session compact budget. */
  contextLimit?: number | null;
  engineRoot?: string;
  onProgress?: (ev: ChatProgressEvent) => void;
  /** Return true to stop before the next model call or tool write. */
  shouldAbort?: () => boolean;
  /**
   * Why the host aborted. Pause keeps the ledger; cancel is the only
   * cancelled stop. Default when aborted with no kind: cancelled.
   */
  stopKind?: () => "paused" | "cancelled";
  /** Host HTTP for fetch_url (Obsidian requestUrl). Never global fetch. */
  fetchPage?: (url: string) => Promise<{ ok: boolean; status?: number; text?: string; error?: string }>;
  /**
   * Session-level GoalState from the previous turn (Desktop .goal.json parity).
   * Merged only when the user goal text is the same task — a new task starts clean.
   */
  priorGoal?: {
    task?: TaskContract;
    execution?: TaskExecutionCheckpoint;
    goal?: string;
    plan?: string[];
    criteria?: string[];
    doneCriteria?: string[];
    pathReceipts?: string[];
    status?: string;
    blockReason?: string | null;
    /** UI snapshot name for the open list (saved chat-goal.json). */
    openCriteria?: string[];
  } | null;
}

const KNOWN_TOOLS = new Set([...Object.keys(buildAgentToolCatalog({ host: "obsidian" })), "capture"]);

function stripThinking(raw: string): string {
  let s = String(raw || "");
  s = s.replace(/<think>[\s\S]*?<\/think>/giu, "\n");
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/giu, "\n");
  s = s.replace(/```(?:thinking|reasoning)\s*[\s\S]*?```/giu, "\n");
  return s.trim();
}

/**
 * A tool call occupies the entire reply after removing provider reasoning.
 * Keep code samples embedded in a final answer as visible reply content.
 */
export function parseToolCall(text: string): Record<string, unknown> | null {
  const source = text.trim();
  const call = parseStandaloneToolCall(source);
  if (call) return call;
  const cleaned = stripThinking(source);
  return cleaned !== source ? parseStandaloneToolCall(cleaned) : null;
}

function parseStandaloneToolCall(text: string): Record<string, unknown> | null {
  if (!text.startsWith("{") && !text.startsWith("```")) return null;
  const fence = text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu);
  try {
    const call = parseJsonUnknown(fence?.[1] ?? text);
    if (!isRecord(call)) return null;
    if (typeof call.tool === "string" && call.tool.trim()) return call;
    return call.tool === undefined && typeof call.name === "string" && isKnownTool(call.name) ? call : null;
  } catch {
    return null;
  }
}

export function isKnownTool(name: unknown): boolean {
  return KNOWN_TOOLS.has(String(name || ""));
}

function toolResultForModel(result: unknown): string {
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Same mapping as Desktop `resolvePromptLocale`: `en*` → English, else Chinese.
 * UI chrome only (tool-guide). Durable answer language is `resolveChatDurableLocale`.
 */
export function resolveChatPromptLocale(locale?: string | null): "zh" | "en" {
  if (locale == null || locale === "") return "zh";
  return String(locale).startsWith("en") ? "en" : "zh";
}

/**
 * Kernel 3-tier durable locale for chat answers / edit_file newText.
 * Explicit request → source script → workspace locale. UI chrome is not a tier.
 */
export function resolveChatDurableLocale(
  kernel: KernelApi,
  workspaceRoot: string,
  userMessage: string,
): "zh" | "en" {
  try {
    const contract = kernel.loadContract(workspaceRoot);
    if (typeof kernel.resolveAgentOutputLanguage === "function") {
      const loc = kernel.resolveAgentOutputLanguage({
        userText: userMessage,
        contract,
      });
      return loc === "en" ? "en" : "zh";
    }
  } catch {
    /* incomplete workspace in tests */
  }
  return "zh";
}

const CHAT_PROFILE_MAX_CHARS = 2000;

/**
 * Active profile facts for Obsidian chat. History is collapsed to a count —
 * never slice raw profile.md (archived lines look like current truth).
 */
export function loadChatProfileContext(
  kernel: KernelApi,
  workspaceRoot: string,
  locale?: string | null,
): string {
  try {
    const loc = resolveChatPromptLocale(locale);
    let collapsed = "";
    if (typeof kernel.readProfileActiveBody === "function") {
      collapsed = kernel.readProfileActiveBody(workspaceRoot, { locale: loc }) || "";
    }
    if (!collapsed && typeof kernel.collapseProfileHistoryBody === "function") {
      const rel = typeof kernel.globalProfileRelPath === "function"
        ? kernel.globalProfileRelPath(workspaceRoot)
        : "memory/profile.md";
      const abs = path.join(workspaceRoot, rel);
      if (fs.existsSync(abs)) {
        collapsed = kernel.collapseProfileHistoryBody(fs.readFileSync(abs, "utf8"), {
          locale: loc,
          profileRel: rel,
        });
      }
    }
    if (!collapsed) return "";
    const body = stripFrontmatter(collapsed).trim();
    if (!body) return "";
    return body.length > CHAT_PROFILE_MAX_CHARS
      ? `${body.slice(0, CHAT_PROFILE_MAX_CHARS)}\n…`
      : body;
  } catch {
    return "";
  }
}

export function durableChatAnswerGuide(locale: "zh" | "en"): string {
  return locale === "en"
    ? "User-visible answer language: English (unless this turn explicitly asked otherwise). Do not follow the UI chrome language for the answer or for edit_file newText."
    : "用户可见回答语言：中文（除非本轮明确要求其他语言）。回答和 edit_file 的 newText 不要跟 UI 界面语言走。";
}

/**
 * Chat tool + writeback/protection/edit + multi-step autonomy instructions.
 * Aligned with Desktop agent contract (tools → work until done → path receipt).
 */
export function buildObsidianChatToolGuide(locale?: string | null, writebackMode?: "auto" | "confirm", turnKind: TurnKind = "task", allowedTools?: string[], documentTask = false): string {
  const lang = resolveChatPromptLocale(locale);
  const en = lang === "en";
  const parts = [
    en ? "Work toward the requested outcome within the host task contract. Stop on completion, a blocker, or host limits. Reads and writes require real tools." : "在宿主任务约束内完成用户所需结果。完成、遇到阻塞或达到宿主上限时停止；读写必须依据真实工具结果。",
    en ? "When native function tools are unavailable, emit one JSON object with tool plus arguments, without extra prose." : "没有原生函数工具时，每次只输出一个包含 tool 和参数的 JSON 对象，不混入其他文字。",
    formatAgentToolGuide({ locale: en ? "en-US" : "zh-CN", host: "obsidian", turnKind, allowedTools }),
    en ? "Use read_file before editing incomplete context. edit_file performs a unique-span edit using oldText; reuse returned contentHash. No shell tool is available." : "上下文不完整时先 read_file；edit_file 使用唯一片段编辑并复用 contentHash。没有 shell 工具。",
    describeWritebackModeForPrompt(writebackMode, lang),
    en ? "For inferred memory changes, use propose_memory_change to create a review card. Explicit supported profile commands are applied by the host. Pending review does not change the profile." : "推测出的记忆变更用 propose_memory_change 生成审阅卡片。宿主直接处理受支持的明确画像指令，待确认时画像尚未修改。",
  ];
  if (documentTask) {
    parts.push(en
      ? "Deliver the requested article result and stop. Do not emit PLAN/DONE markers or invent new tasks."
      : "交付所需文章结果后停止，不输出 PLAN/DONE 标记，不增加额外任务。");
  } else if (turnKind !== "light") {
    parts.push(buildGoalProtocolPrompt(en ? "en" : "zh"));
  }
  return parts.join("\n\n");
}

export async function runWorkspaceChatTurn(
  kernel: KernelApi,
  workspaceRoot: string,
  opts: WorkspaceChatTurnOpts,
): Promise<{
  body: string;
  reasoning: string;
  edits: Array<Record<string, unknown>>;
  steps: number;
  toolCalls: Array<{ tool: string; ok: boolean; summary?: string; pending?: boolean; needsConfirm?: boolean }>;
  autoContinues: number;
  stepLimitHit: boolean;
  stopReason?: "paused" | "cancelled";
  cancelled?: boolean;
  goal?: {
    task?: TaskContract;
    execution?: TaskExecutionCheckpoint;
    goal: string;
    plan: string[];
    criteria: string[];
    openCriteria: string[];
    pathReceipts: string[];
    modifiedPaths?: string[];
    status: string;
    blockReason: string | null;
    autoContinues: number;
  };
}> {
  const articleReview = opts.taskContract?.kind === "document" && opts.taskContract.output === "review";
  const profileChange = !opts.focus?.taskIntent && !articleReview && explicitProfileChange(opts.userMessage);
  const resolvedTask = opts.taskContract || resolveTaskContract({ userText: opts.userMessage, focusPath: opts.focus?.path, intent: opts.focus?.taskIntent, priorTask: opts.priorGoal?.task, capabilities: { vision: false, imageGeneration: false, imageRendering: false } });
  const task = profileChange ? { ...resolvedTask, kind: "workspace", targetPath: null, blockReason: null } : resolvedTask;
  const resumes = resumesWorkspaceTask(opts.userMessage, opts.priorGoal?.task, opts.focus?.taskIntent);
  const checkpoint = resumes && isTaskExecutionCheckpoint(opts.priorGoal?.execution) ? opts.priorGoal.execution : null;
  const reviewIds = checkpoint?.reviews.map(entry => entry.id) || [];
  let reviews: ReturnType<typeof getPendingWriteReviews> = [];
  try { if (reviewIds.length) reviews = getPendingWriteReviews(workspaceRoot, reviewIds); }
  catch { /* Missing evidence blocks a resume. */ }
  const toolLimit = Math.max(1, Math.min(task.kind === "document" ? 16 : 48, Number(opts.maxSteps) || AGENT_STEPS_DEFAULT));
  const guard = createTaskExecutionGuard(task, {
    maxCalls: toolLimit, maxModelCalls: toolLimit + 4,
    checkpoint, reviews, priorAwaitingReview: resumes && opts.priorGoal?.blockReason === "awaiting_confirmation",
    toWorkspacePath: (value) => {
      if (typeof value !== "string" || !value) return null;
      const rel = path.relative(workspaceRoot, path.resolve(workspaceRoot, value)).replace(/\\/gu, "/");
      return rel && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel) ? rel : null;
    },
  });
  if (task.kind === "document" && opts.focus?.unsaved) guard.stop("unsaved-target");
  if (task.kind === "document" && task.targetPath && !guard.reason) {
    try {
      const root = fs.realpathSync(workspaceRoot);
      const absolute = fs.realpathSync(path.resolve(root, task.targetPath));
      const rel = path.relative(root, absolute);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !fs.statSync(absolute).isFile()) guard.stop("target-unavailable");
    } catch { guard.stop("target-unavailable"); }
  }
  const turnKind = task.kind === "document" ? task.output === "review" ? "query" : "task"
    : resumes ? classifyTurn(task.request)
    : opts.focus?.path && needsActiveDocument(opts.userMessage) && classifyTurn(opts.userMessage) === "light" ? "query" : classifyTurn(opts.userMessage);
  const callable = Object.fromEntries(Object.entries(filterAgentToolsForTurn(buildAgentToolCatalog({ host: "obsidian" }), turnKind)).filter(([name]) => taskAllowsTool(task, name)));
  if (guard.reason) return {
    body: taskStopMessage(guard.reason, opts.locale, task.targetPath), reasoning: "", edits: [], steps: 0, toolCalls: [], autoContinues: 0, stepLimitHit: false,
    goal: { goal: (resumes ? opts.priorGoal?.goal || task.request : opts.userMessage).slice(0, 400),
      plan: resumes ? opts.priorGoal?.plan || [] : [], criteria: resumes ? opts.priorGoal?.criteria || [] : [], openCriteria: resumes ? opts.priorGoal?.openCriteria || [] : [],
      pathReceipts: guard.priorPaths, status: "blocked", blockReason: guard.reason, autoContinues: 0, task: { ...task, blockReason: guard.reason }, execution: guard.execution },
  };
  if (profileChange) {
    const en = resolveChatPromptLocale(opts.locale) === "en";
    const profilePath = kernel.globalProfileRelPath?.(workspaceRoot) || "memory/profile.md";
    let evidence;
    let error: string | null = null;
    try {
      if (opts.shouldAbort?.()) throw new Error("task-cancelled-before-write");
      const conflict = opts.beforeWrite?.([profilePath]);
      if (conflict) throw new Error(conflict);
      const write = { workspaceRoot, actor: "ai" as const, confirmed: true };
      evidence = profileChange.match
        ? kernel.updateProfileEntry({ ...write, match: profileChange.match, content: profileChange.content, exactMatch: true })
        : kernel.appendProfileEntry({ ...write, entry: profileChange.content });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const wrote = evidence?.wroteFiles === true && !evidence.pending && !evidence.needsConfirm;
    const exists = !profileChange.match && evidence?.reason === "duplicate-fact";
    const reason = error || evidence?.reason || "profile-write-unverified";
    const body = wrote ? (en ? `Updated My Profile (${profilePath}).` : `已更新「我的情况」（${profilePath}）。`)
      : exists ? (en ? "This fact is already in My Profile." : "「我的情况」里已有这条信息。")
      : reason === "no-matching-fact" || reason === "ambiguous-profile-fact"
        ? (en ? "The old fact must match exactly one active profile entry. Copy its full wording and try again." : "请复制唯一一条现行记忆的完整原文，再试一次。")
        : (en ? `My Profile was not changed. ${reason}` : `「我的情况」未修改。${reason}`);
    return { body, reasoning: "", edits: [], steps: 0, toolCalls: [], autoContinues: 0, stepLimitHit: false,
      goal: { task, goal: opts.userMessage, plan: [], criteria: [], openCriteria: [], pathReceipts: wrote || exists ? [profilePath] : [],
        modifiedPaths: wrote ? [profilePath] : [], status: wrote || exists ? "done" : "incomplete", blockReason: wrote || exists ? null : reason, autoContinues: 0 } };
  }
  const originalKernel = kernel;
  let targetVersion = task.targetPath && task.kind === "document" ? fs.readFileSync(path.resolve(workspaceRoot, task.targetPath), "utf8") : null;
  kernel = { ...kernel, executeWrite: args => {
    if (opts.shouldAbort?.()) throw new Error("task-cancelled-before-write");
    const target = path.relative(workspaceRoot, String(args.targetPath)).replace(/\\/gu, "/");
    const conflict = opts.beforeWrite?.([target]);
    if (conflict) throw new Error(conflict);
    if (task.kind === "document" && target === task.targetPath && fs.readFileSync(String(args.targetPath), "utf8") !== targetVersion) {
      guard.stop("source-changed");
      throw new Error("source-changed");
    }
    const result = originalKernel.executeWrite(args);
    if (task.kind === "document" && target === task.targetPath && !result.pending && !result.needsConfirm && result.wroteFiles !== false) targetVersion = fs.readFileSync(String(args.targetPath), "utf8");
    return result;
  } };
  const durable = resolveChatDurableLocale(kernel, workspaceRoot, opts.userMessage);
  const chromeZh = resolveChatPromptLocale(opts.locale) === "zh";
  // Settings use clampMaxAgentSteps (3–80). Explicit opts.maxSteps is trusted
  // (tests / callers may pin a short budget).
  const maxSteps = Math.min(toolLimit, opts.maxSteps != null
    ? Math.max(1, Math.min(AGENT_STEPS_MAX, Math.floor(Number(opts.maxSteps) || 1)))
    : clampMaxAgentSteps(undefined));
  // Contract is truth. Never force a default override that could fork topmind.yaml
  // when the contract fails to load — leave writebackMode undefined then.
  const contractMode = resolveContractWritebackMode(kernel, workspaceRoot);
  const modeHint = contractMode || opts.writebackMode || "auto";
  const toolGuide = buildObsidianChatToolGuide(opts.locale, modeHint, turnKind, Object.keys(callable), task.kind === "document");
  const answerGuide = durableChatAnswerGuide(durable);
  const agentCtx = {
    kernel,
    workspaceRoot,
    engineRoot: opts.engineRoot,
    writebackMode: contractMode || opts.writebackMode,
    actor: "ai" as const,
    configDir: opts.configDir,
    fetchPage: opts.fetchPage,
  };
  const skillContext = task.skillId ? loadSkill(agentCtx, { skillId: task.skillId }) : null;
  const preloadedSkill = skillContext?.ok ? `## Host-preloaded skill: ${task.skillId}\n${String(skillContext.content || "").slice(0,16000)}\nUse this skill directly; do not list skills to rediscover it.` : "";

  const systemPrompt = [opts.systemExtra, answerGuide, toolGuide, preloadedSkill, taskContractPrompt(task), resumeExecutionPrompt(guard.priorPaths)].filter(Boolean).join("\n\n");
  const compactBudget = resolveContextBudget(opts.contextLimit, { fixedTokens: estimateTokens(systemPrompt) });
  const conversation: string[] = [`Current user request: ${task.kind === "document" ? task.request : opts.userMessage}`];
  const history = task.kind === "document" ? articleHistory(opts.history || [], task.targetPath) : compactChatMessages(opts.history || [], compactBudget);
  for (const msg of history) conversation.push(`Earlier ${msg.role === "user" ? "user" : "assistant"} exchange: ${msg.content}`);

  const edits: Array<Record<string, unknown>> = [];
  const toolCalls: Array<{ tool: string; ok: boolean; summary?: string; pending?: boolean; needsConfirm?: boolean }> = [];
  let lastRaw = "";
  let stepCount = 0;
  let autoContinues = 0;
  let stepLimitHit = false;
  let finished = false;
  let reasoningAcc = "";
  // "继续" and the host resume prompt keep the saved ledger. A new task does not.
  let goalState: GoalState = restoreSessionGoal(task.kind === "document" ? null : opts.priorGoal, task.kind === "document" ? task.request : opts.userMessage || "");
  if (resumes) {
    goalState = { ...goalState, status: "working", blockReason: null,
      pathReceipts: [...new Set([...goalState.pathReceipts, ...guard.priorPaths])] };
  }

  const goalPayload = () => ({
    task: { ...task, blockReason: goalState.blockReason || guard.reason },
    execution: guard.execution,
    goal: goalState.goal || "",
    plan: goalState.plan || [],
    criteria: goalState.criteria || [],
    openCriteria: goalState.doneCriteria || [],
    pathReceipts: (goalState.pathReceipts || []).slice(-12),
    modifiedPaths: guard.modifiedPaths.slice(-24),
    status: goalState.status || "idle",
    blockReason: goalState.blockReason || null,
    autoContinues,
  });

  const abortCopy = (kind: "paused" | "cancelled") => {
    if (kind === "paused") {
      return chromeZh
        ? "已暂停。任务台账和已经完成的修改都还在，可以继续。"
        : "Paused. The task ledger and finished edits are kept. You can resume.";
    }
    return chromeZh
      ? "已取消。这一步之前已经完成的修改会保留。"
      : "Cancelled. Edits that already finished are kept.";
  };

  const noteReasoning = (raw: string) => {
    if (typeof kernel.splitAssistantVisible !== "function") return;
    const splitNow = kernel.splitAssistantVisible(raw);
    const bit = String(splitNow?.reasoning || "").trim();
    if (!bit || reasoningAcc.includes(bit)) return;
    reasoningAcc = reasoningAcc ? `${reasoningAcc}\n\n${bit}` : bit;
  };

  const emit = (ev: ChatProgressEvent) => {
    try {
      opts.onProgress?.({ ...ev, goal: goalPayload() });
    } catch {
      /* progress must not break the agent */
    }
  };

  const execOneTool = async (call: Record<string, unknown>): Promise<string | null> => {
    const guardedArgs = call;
    call = normalizeAgentToolCall(call);
    const tool = String(call.tool);
    const report = (result: unknown) => {
      guard.afterTool(tool, guardedArgs, result);
      return toolResultForModel(result);
    };
    if (opts.focus?.path && !call.relativePath && (["read_file", "edit_file", "append_stream_entry"].includes(tool))) {
      call = { ...call, relativePath: opts.focus.path };
    }
    if (opts.focus?.unsaved && !opts.beforeWrite && ["save_file", "save_note", "edit_file", "delete_path", "rename_path", "move_to_topic", "publish_to_outputs", "append_stream_entry"].includes(tool)) {
      const affected = [call.relativePath, call.newPath, call.destRelativePath].map((p) => p ? path.relative(workspaceRoot, path.resolve(workspaceRoot, String(p))).replace(/\\/gu, "/") : "");
      if (affected.some((p) => p && (p === opts.focus?.path || opts.focus?.path.startsWith(`${p}/`)))) {
        toolCalls.push({ tool, ok: false, summary: opts.focus.path });
        return report({ ok: false, error: "unsaved-editor-changes", relativePath: opts.focus.path, hint: "Save the editor buffer before editing this file. Do not bypass via another write tool." });
      }
    }

    if (!callable[tool] && isKnownTool(tool)) {
      toolCalls.push({ tool, ok: false });
      return report({ ok: false, error: "tool-not-available-for-this-turn", hint: "This turn is conversational or read-only. Answer from read evidence; do not mutate the workspace." });
    }
    if (callable[tool]?.effect === "write") {
      const paths = [call.relativePath, call.newPath, call.destRelativePath].filter((value): value is string => typeof value === "string" && !!value);
      if (tool === "save_note" && call.topicId && call.filename) paths.push(`${String(call.topicId)}/${String(call.filename)}`);
      if (["add_todo", "toggle_todo", "update_todo", "set_todo_due", "delete_todo"].includes(tool)) paths.push(kernel.resolveTodoRelPath?.(workspaceRoot) || "memory/todo.md");
      const conflict = opts.beforeWrite?.(paths);
      if (conflict) { toolCalls.push({ tool, ok: false }); return report({ ok: false, error: conflict }); }
    }
    if (!isKnownTool(tool)) {
      return report({
        ok: false,
        error: `unknown tool: ${tool}`,
        hint: `Use only: ${[...KNOWN_TOOLS].join(", ")}. Re-emit a single JSON tool call.`,
      });
    }
    if (tool === "propose_memory_change") {
      try {
        if (!opts.onMemoryProposal) throw new Error("memory-proposal-host-unavailable");
        const proposal = opts.onMemoryProposal(call);
        toolCalls.push({ tool, ok: true, summary: proposal.targetPath, pending: true, needsConfirm: true });
        return report({ ok: true, pending: true, wroteFiles: false, ...proposal, hint: "A reviewable card exists in Suggestions. No memory was changed. Tell the user to review it there." });
      } catch (err) {
        toolCalls.push({ tool, ok: false });
        return report({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const fence = memoryFence(tool, call, { workspaceRoot });
    if (fence) {
      toolCalls.push({ tool, ok: false, summary: String(call.relativePath || call.targetTopicId || "") });
      return report({ ...fence, hint: "Use propose_memory_change for a reviewable memory suggestion." });
    }
    if (tool === "append_stream_entry") {
      const result = appendStreamEntryToWorkspace(kernel, workspaceRoot, kernel.loadContract(workspaceRoot), {
        relativePath: String(call.relativePath || opts.focus?.path || ""), content: String(call.content || ""), actor: "ai",
        heading: typeof call.heading === "string" ? call.heading : undefined,
        anchorText: typeof call.anchorText === "string" ? call.anchorText : undefined,
        writebackMode: contractMode || opts.writebackMode,
      });
      toolCalls.push({ tool, ok: result.ok, summary: result.path, pending: result.pending, needsConfirm: result.needsConfirm });
      return report(result);
    }
    if (tool === "read_file") {
      const read = readWorkspaceWindow(kernel, workspaceRoot, {
        relativePath: String(call.relativePath || ""),
        offset: typeof call.offset === "number" ? call.offset : undefined,
        limit: typeof call.limit === "number" ? call.limit : 400,
        around: typeof call.around === "string" ? call.around : undefined,
        heading: typeof call.heading === "string" ? call.heading : undefined,
      });
      toolCalls.push({ tool, ok: Boolean(read.ok), summary: String(call.relativePath || "") });
      if (!read.ok) return report(read);
      // Prefer numbered window; drop the raw twin so the model sees one body.
      const { numbered, ...windowRest } = read.window || ({} as Record<string, unknown>);
      return report({
        ...windowRest,
        content: (numbered as string) || (read.window as { content?: string })?.content || "",
        contentHash: read.contentHash,
      });
    }
    if (tool === "edit_file") {
      const edited = preciseEditWorkspace(kernel, workspaceRoot, {
        relativePath: String(call.relativePath || ""),
        oldText: String(call.oldText || ""),
        newText: String(call.newText ?? ""),
        replaceAll: Boolean(call.replaceAll),
        startLine: typeof call.startLine === "number" ? call.startLine : undefined,
        endLine: typeof call.endLine === "number" ? call.endLine : undefined,
        heading: typeof call.heading === "string" ? call.heading : undefined,
        expectedHash: typeof call.expectedHash === "string" ? call.expectedHash : undefined,
        actor: "ai",
        // Content edit always lands (graded-confirm Desktop parity).
        confirmed: true,
        writebackMode: contractMode || opts.writebackMode,
      });
      edits.push({ ...edited, tool: "edit_file", relativePath: call.relativePath });
      toolCalls.push({ tool, ok: Boolean(edited.ok), summary: String(call.relativePath || "") });
      let editNote = report(edited);
      try {
        const { buildRetryHint } = await import("#kernel/tool-retry-hints.mjs");
        const hint = buildRetryHint("edit_file", JSON.stringify(edited), {
          relativePath: String(call.relativePath || ""),
          locale: "en",
        });
        if (hint) editNote += `\nHINT: ${hint}`;
      } catch {
        if (edited.reason === "hash-mismatch" || edited.error === "hash-mismatch") {
          editNote += `\nHINT: file changed since last read — call read_file around= to refresh contentHash/oldText, then retry edit_file with the new expectedHash.`;
        } else if (edited.reason === "no-match" || edited.reason === "ambiguous") {
          editNote += `\nHINT: use nearby/context from the diagnostic, or read_file around= the phrase, then retry with exact oldText + expectedHash.`;
        }
      }
      return editNote;
    }
    if (tool === "capture" || tool === "capture_to_inbox") {
      const captured = captureToWorkspace(kernel, workspaceRoot, opts.engineRoot || workspaceRoot, String(call.content || ""), {
        target: call.forceInbox === true || call.target === "inbox" ? "inbox" : "stream",
        forceAtom: call.forceAtom === true,
        writebackMode: contractMode || opts.writebackMode,
      });
      toolCalls.push({ tool: "capture", ok: Boolean(captured.ok), summary: captured.path });
      return report({ ...captured, tool: "capture" });
    }
    if (tool === "capture_url") {
      // Desktop parity: one-shot fetch + ingest with source URL attached.
      const url = String(call.url || "").trim();
      if (!/^https?:\/\//iu.test(url)) {
        return report({ ok: false, tool, error: "only http(s) URLs are allowed" });
      }
      if (typeof agentCtx.fetchPage !== "function") {
        return report({ ok: false, tool, error: "fetchPage not provided by host" });
      }
      try {
        const { fetchUrlForCapture } = await import("./capture-fetch.ts");
        const fetched = await fetchUrlForCapture(agentCtx.fetchPage, url);
        if (!fetched.ok || !String(fetched.text || "").trim()) {
          const { buildRetryHint } = await import("#kernel/tool-retry-hints.mjs");
          return report({
            ok: false,
            tool,
            error: fetched.error || "page body empty",
            hint: buildRetryHint("capture_url", fetched.error || "page body empty", { locale: "zh" }) ||
              "抓取到的正文过短。可先 fetch_url 确认内容，或换来源。",
          });
        }
        const useTitle = String(call.title || fetched.title || "").trim();
        const note = String(call.note || "").trim();
        const header = `> 来源：${url}\n${useTitle ? `> 标题：${useTitle}\n` : ""}\n`;
        const body = `${header}${note ? `${note}\n\n` : ""}${fetched.text}`.trim();
        const captured = captureToWorkspace(kernel, workspaceRoot, opts.engineRoot || workspaceRoot, body, {
          target: call.forceInbox === true ? "inbox" : "stream",
          forceAtom: call.forceAtom === true,
          writebackMode: contractMode || opts.writebackMode,
        });
        toolCalls.push({ tool: "capture_url", ok: Boolean(captured.ok), summary: captured.path || url });
        return report({ ...captured, tool: "capture_url", url, title: useTitle });
      } catch (err) {
        return report({
          ok: false,
          tool,
          error: err instanceof Error ? err.message : String(err),
          hint: "抓取入库失败。确认 URL 有效且可访问。",
        });
      }
    }
    const result = await runAgentTool(agentCtx, call);
    if (!result) {
      return report({ ok: false, tool, error: "tool not dispatched", hint: "Re-emit a single JSON tool call." });
    }
    toolCalls.push({
      tool,
      ok: Boolean(result.ok),
      summary: String(result.relativePath || result.count || result.summary || ""),
      pending: Boolean(result.pending),
      needsConfirm: Boolean(result.needsConfirm || result.pending),
    });
    return report(result);
  };

  // Transient generate failures must not kill the whole turn (Desktop parity:
  // one in-loop retry, then surface the error as the answer). This is a root
  // cause of "AI 功能总是断" — a single network blip used to abort mid-task.
  let generateFailures = 0;
  const MAX_GENERATE_FAILURES = 2;

  const finishAborted = () => {
    const kind: "paused" | "cancelled" = opts.stopKind?.() === "paused" ? "paused" : "cancelled";
    const stoppedBody = abortCopy(kind);
    emit({
      kind: "done",
      step: stepCount,
      maxSteps,
      autoContinues,
      note: kind,
      reasoning: reasoningAcc,
    });
    // Keep any partial answer the model already produced (Desktop cancel
    // semantics) instead of throwing the draft away for a canned string.
    const partial = typeof kernel.splitAssistantVisible === "function"
      ? kernel.splitAssistantVisible(lastRaw).body
      : String(lastRaw || "").trim();
    const body = partial && !parseToolCall(lastRaw)
      ? `${partial}\n\n${stoppedBody}`
      : stoppedBody;
    return {
      body,
      reasoning: reasoningAcc,
      edits,
      steps: stepCount,
      toolCalls,
      autoContinues,
      stepLimitHit,
      stopReason: kind,
      cancelled: kind === "cancelled",
      goal: goalPayload(),
    };
  };

  for (;;) {
    if (opts.shouldAbort?.()) return finishAborted();
    let brokeOnFinalText = false;
    for (let step = 0; step < maxSteps; step++) {
      if (opts.shouldAbort?.()) return finishAborted();
      const checkpoint = task.kind === "document" ? `Host execution checkpoint: ${guard.calls} tool calls consumed, ${guard.writes} successful writes. Do not repeat completed writes. Read current source windows as needed.` : clipContext(buildTaskLedger(goalState, chromeZh ? "zh-CN" : "en-US"), 600);
      const stepSystem = `${systemPrompt}\n\n${checkpoint}`;
      const stepBudget = resolveContextBudget(opts.contextLimit, { fixedTokens: estimateTokens(stepSystem) });
      const fitted = compactPromptBlocks(conversation, stepBudget.maxTokens);
      if (fitted.overflow) { guard.stop("context-budget"); lastRaw = taskStopMessage("context-budget", opts.locale, task.targetPath); finished = true; break; }
      if (fitted.compacted) conversation.splice(0, conversation.length, ...fitted.blocks);
      if (!guard.beforeModel()) { finished = true; break; }
      stepCount += 1;
      emit({ kind: "step", step: stepCount, maxSteps, autoContinues, reasoning: reasoningAcc });
      const prompt = conversation.join("\n\n");
      let raw: unknown;
      let requestFailed = false;
      try {
        raw = await opts.generate(prompt, {
          operation: "chat",
          systemPrompt: stepSystem,
          maxOutputTokens: stepBudget.responseTokens,
          temperature: 0.4,
          shouldAbort: opts.shouldAbort,
        });
      } catch (err) {
        if (opts.shouldAbort?.() || (err instanceof Error && err.name === "AbortError")) {
          return finishAborted();
        }
        requestFailed = true;
      }
      lastRaw = String(raw || "");
      noteReasoning(lastRaw);
      if (opts.shouldAbort?.()) return finishAborted();
      if (requestFailed || !stripThinking(lastRaw)) {
        generateFailures += 1;
        if (generateFailures >= MAX_GENERATE_FAILURES) {
          const body = chromeZh
            ? "模型连续两次未返回可用回复。请稍后重试或检查服务商配置。"
            : "The model returned no usable reply twice. Retry later or check the provider settings.";
          goalState = { ...goalState, status: "incomplete", blockReason: "model-response-unavailable" };
          emit({ kind: "done", step: stepCount, maxSteps, autoContinues });
          return { body, reasoning: reasoningAcc, edits, steps: stepCount, toolCalls, autoContinues, stepLimitHit, goal: goalPayload() };
        }
        emit({ kind: "step", step: stepCount, maxSteps, tool: "retry", autoContinues });
        conversation.push(
          chromeZh
            ? "[系统] 上一轮回复为空。请继续完成原目标，或给出简短结论。"
            : "[System] Previous reply was empty. Continue the original goal or give a short conclusion.",
        );
        continue;
      }
      generateFailures = 0;
      const call = parseToolCall(lastRaw);
      if (!call) {
        // Model produced prose — fold into goal ledger and decide if it may stop.
        goalState = applyGoalUpdate(goalState, { text: stripThinking(lastRaw) });
        if (task.kind === "workspace" && guard.missingWrite && goalState.status !== "blocked") {
          finished = true;
          break;
        }
        harvestPathReceipts(lastRaw, goalState.pathReceipts);
        goalState = rejectBareDone(goalState, {
          toolCallCount: toolCalls.length,
          lastBody: stripThinking(lastRaw),
        });
        const assessment = assessGoalCompletion({
          state: goalState,
          lastBody: stripThinking(lastRaw),
          stepLimitHit: false,
          toolCallCount: toolCalls.length,
        });
        if (assessment.finished && assessment.confidence !== "low") {
          brokeOnFinalText = true;
          finished = true;
          break;
        }
        // Goal-aware continue decision (Desktop decideAutoContinue parity).
        const maxContinuesProse = resolveMaxAutoContinues({ assessment, baseMax: MAX_AUTO_CONTINUES });
        const decisionProse = decideAutoContinue({
          assessment,
          autoContinues,
          maxAutoContinues: maxContinuesProse,
          hasTools: toolCalls.length > 0,
          error: false,
          cancelled: false,
        });
        if (task.kind !== "document" && opts.autoContinue !== false && decisionProse.continue) {
          autoContinues += 1;
          emit({ kind: "continue", step: stepCount, maxSteps, autoContinues });
          conversation.push(`Assistant: ${lastRaw}`);
          conversation.push(
            `User: ${buildContinuePrompt(chromeZh ? "zh-CN" : "en-US", goalState, {
              extra: chromeZh ? "（继续完成未完成验收项）" : "(continue remaining criteria)",
            })}`,
          );
          continue;
        }
        brokeOnFinalText = true;
        finished = true;
        break;
      }

      if (opts.shouldAbort?.()) return finishAborted();
      const tool = String(call.tool || call.name || "");
      emit({ kind: "tool", step: stepCount, maxSteps, tool, autoContinues, reasoning: reasoningAcc });
      conversation.push(`Assistant: ${lastRaw}`);
      let toolNote: string | null;
      const normalized = normalizeAgentToolCall(call);
      const checked = guard.beforeTool(String(normalized.tool), normalized);
      try {
        if (!checked.ok) toolNote = toolResultForModel({ ok: false, error: checked.error });
        else if (checked.replay) toolNote = toolResultForModel({ ok: true, unchanged: true, wroteFiles: false, note: "Already completed in this task. Continue the remaining steps." });
        else toolNote = await execOneTool(checked.args || call);
      }
      catch (error) {
        toolCalls.push({ tool, ok: false });
        const failure = { ok: false, error: error instanceof Error ? error.message : String(error) };
        guard.afterTool(String(normalized.tool), checked.args || normalized, failure);
        toolNote = toolResultForModel(failure);
      }
      conversation.push(`Tool result (${tool}):\n${toolNote || ""}`);
      if (toolNote && !guard.pending) harvestPathReceipts(toolNote, goalState.pathReceipts);
      emit({ kind: "checkpoint", step: stepCount, maxSteps, tool, autoContinues });
      if (guard.reason || guard.pending) { finished = true; break; }
    }

    if (finished || brokeOnFinalText) break;

    // Callers that pin maxSteps can opt out of auto-continue (tests / one-shot).
    if (task.kind === "document" || opts.autoContinue === false) {
      stepLimitHit = true;
      break;
    }

    // Step budget exhausted → goal-aware continue (Desktop decideAutoContinue parity).
    const openAssessment = assessGoalCompletion({
      state: goalState,
      lastBody: stripThinking(lastRaw),
      stepLimitHit: true,
      toolCallCount: toolCalls.length,
    });
    const maxContinues = resolveMaxAutoContinues({ assessment: openAssessment, baseMax: MAX_AUTO_CONTINUES });
    // High-confidence done always stops (never re-close a finished task).
    if (
      openAssessment.finished &&
      openAssessment.confidence === "high" &&
      (openAssessment.reason === "done-mark" || String(openAssessment.reason || "").startsWith("met"))
    ) {
      finished = true;
      break;
    }
    const decision = decideAutoContinue({
      assessment: openAssessment,
      autoContinues,
      maxAutoContinues: maxContinues,
      hasTools: toolCalls.length > 0,
      error: false,
      cancelled: false,
    });
    if (autoContinues >= maxContinues) {
      stepLimitHit = true;
      // Budget exhaustion is terminal — honest incomplete (Desktop G6 parity).
      if (goalState.status !== "done") {
        goalState = {
          ...goalState,
          status: goalState.status === "blocked" ? "blocked" : "incomplete",
          blockReason: goalState.blockReason || "budget_exhausted",
        };
      }
      break;
    }
    // Skip continue when the last payload already looks like a real finish.
    if (!decision.continue && !openAssessment.reason?.includes("step-limit")) {
      if (openAssessment.finished && openAssessment.confidence !== "low") {
        finished = true;
        break;
      }
    }
    if (!decision.continue && openAssessment.finished) {
      finished = true;
      break;
    }
    autoContinues += 1;
    stepLimitHit = true;
    emit({ kind: "continue", step: stepCount, maxSteps, autoContinues });
    // Sticky ledger + open criteria so the continuation cannot lose the goal.
    conversation.push(`User: ${buildTaskLedger(goalState, chromeZh ? "zh-CN" : "en-US")}`);
    conversation.push(
      `User: ${buildContinuePrompt(chromeZh ? "zh-CN" : "en-US", goalState)}`,
    );

  }

  if (task.kind === "document") {
    const outcome = documentTaskOutcome(task, guard, { text: parseToolCall(lastRaw) ? "" : stripThinking(lastRaw), stepLimitHit, locale: opts.locale });
    goalState = { ...goalState, ...outcome, plan: [], criteria: [], doneCriteria: [] };
    emit({ kind: "done", step: stepCount, maxSteps, autoContinues });
    return { body: outcome.text, reasoning: reasoningAcc, edits, steps: stepCount, toolCalls, autoContinues, stepLimitHit,
      goal: { ...goalPayload(), task: { ...task, question: guard.question, blockReason: outcome.blockReason }, status: outcome.status, blockReason: outcome.blockReason } };
  }
  const workspaceOutcome = turnKind === "query" ? null : workspaceWriteOutcome(guard, opts.locale, goalState.status === "blocked");
  if (workspaceOutcome) {
    goalState = { ...goalState, status: workspaceOutcome.status, blockReason: workspaceOutcome.blockReason, doneCriteria: [...goalState.criteria] };
    emit({ kind: "done", step: stepCount, maxSteps, autoContinues });
    return { body: workspaceOutcome.text, reasoning: reasoningAcc, edits, steps: stepCount, toolCalls, autoContinues, stepLimitHit, goal: goalPayload() };
  }
  const split = typeof kernel.splitAssistantVisible === "function"
    ? kernel.splitAssistantVisible(lastRaw)
    : { body: String(lastRaw || "").trim(), reasoning: "" };
  noteReasoning(lastRaw);
  let body = split.body;
  goalState = rejectBareDone(goalState, {
    toolCallCount: toolCalls.length,
    lastBody: stripThinking(lastRaw),
  });
  const finalAssessment = assessGoalCompletion({
    state: goalState,
    lastBody: stripThinking(lastRaw),
    stepLimitHit: stepLimitHit && !finished,
    toolCallCount: toolCalls.length,
  });
  const incomplete =
    goalState.status === "incomplete" ||
    (goalState.doneCriteria?.length > 0 && !finalAssessment.finished) ||
    (!finished && stepLimitHit);
  if (finalAssessment.finished) {
    goalState = { ...goalState, status: "done", blockReason: null };
  }
  if (parseToolCall(lastRaw)) {
    const pending =
      edits.some((e) => e.pending || e.needsConfirm) ||
      toolCalls.some((t) => t.pending || t.needsConfirm || t.summary === "pending");
    const applied = edits.some((e) => e.ok) || toolCalls.some((t) => t.ok);
    const blocked = goalState.status === "blocked";
    if (chromeZh) {
      body = pending
        ? "写入已挂起，请在侧栏「建议」中接受或拒绝。"
        : blocked
          ? `需要你：${goalState.blockReason || "等待输入"}\n\n${buildTaskLedger(goalState, "zh-CN")}`
          : incomplete
            ? `任务未完成${stepLimitHit ? "（步数用尽）" : ""}：仍有验收项未达成。已执行 ${toolCalls.filter((t) => t.ok).length} 步工具调用；请继续会话或提高工具步数上限。\n\n${buildTaskLedger(goalState, "zh-CN")}`
            : applied
              ? `已完成文件操作（${toolCalls.filter((t) => t.ok).length} 步工具调用）。`
              : "未能完成修改，请根据工具返回的 nearby/context 再试。";
    } else {
      body = pending
        ? "Write is pending — accept or reject it in the sidebar Suggest tab."
        : blocked
          ? `Needs you: ${goalState.blockReason || "waiting for input"}\n\n${buildTaskLedger(goalState, "en-US")}`
          : incomplete
            ? `Task incomplete${stepLimitHit ? " (step budget exhausted)" : ""}: open acceptance criteria remain. ${toolCalls.filter((t) => t.ok).length} tool steps ran; continue the chat or raise max tool steps.\n\n${buildTaskLedger(goalState, "en-US")}`
            : applied
              ? `Finished workspace operations (${toolCalls.filter((t) => t.ok).length} tool steps).`
              : "Edit did not apply. Use the nearby/context from the tool result and retry.";
    }
  } else if (incomplete && !finalAssessment.finished) {
    // Prose close that still has open criteria — do not look like success.
    const suffix = chromeZh
      ? `\n\n${buildTaskLedger(goalState, "zh-CN")}\n\n[INCOMPLETE 验收未全部达成]`
      : `\n\n${buildTaskLedger(goalState, "en-US")}\n\n[INCOMPLETE open criteria remain]`;
    if (body && !body.includes("[INCOMPLETE")) body = `${body}${suffix}`;
    else if (!body) body = chromeZh ? `任务未完成。${suffix}` : `Task incomplete.${suffix}`;
  }
  if (guard.reason) {
    goalState = { ...goalState, status: "blocked", blockReason: guard.reason };
    body = guard.question || taskStopMessage(guard.reason, opts.locale, task.targetPath);
  }
  emit({ kind: "done", step: stepCount, maxSteps, autoContinues });
  return {
    body,
    reasoning: reasoningAcc || split.reasoning,
    edits,
    steps: stepCount,
    toolCalls,
    autoContinues,
    stepLimitHit,
    // Structured goal snapshot (Desktop goalSummary parity) — UI must render
    // the chip from this, never from a [DONE] regex on the body.
    goal: goalPayload(),
  };
}
