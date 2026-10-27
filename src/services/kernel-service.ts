import { runWorkspaceChatTurn, resolveChatDurableLocale, loadChatProfileContext, clampMaxAgentSteps, type ChatProgressEvent } from "./chat-agent.ts";
// ── Kernel Service: wraps Kernel operations for Obsidian plugin ────────────
//
// All view/modal components call this service instead of directly accessing
// the Kernel. This centralizes:
// - Kernel context creation (with AI provider from settings)
// - Writeback mode: plugin data is a display cache; operational truth is topmind.yaml
// - Error handling and evidence extraction
// - Backup/receipt keep count wiring (via process.env)

import type { App } from "obsidian";
import { Notice, requestUrl, type Plugin, TFile } from "obsidian";
import type { TopmindSettings, StreamPeriod, StreamEntry, SuggestionCard, TodoItem } from "../types";
import type { AiProvider } from "../bridge/ai-provider";
import { createAiProvider } from "../bridge/ai-provider.ts";
import { createKernelContextFromApp, type KernelContext, getKernel } from "../bridge/kernel-loader.ts";
import { getVaultBasePath, getEngineRoot } from "../bridge/vault-bridge.ts";
import {
  parseStreamEntries,
  normalizeSuggestionList,
  mapKernelSuggestion,
  mapApplySuggestionResult,
  mergeSoftSuggestionSession,
  stripFrontmatter,
  isRecord,
} from "../utils.ts";
import { AI_PROVIDER_PRESETS, PROVIDER_DEFAULT_MODELS } from "../constants.ts";
import {
  captureToWorkspace,
  listStreamPeriodsForWorkspace,
  reconcilePeriodNote,
  readTodosFromWorkspace,
  initWorkspaceStructure,
  resolveContractWritebackMode,
  mirrorWritebackModeToContract,
  readWorkspaceWindow,
  preciseEditWorkspace,
  createInboxNoteInWorkspace,
  appendStreamEntryToWorkspace,
  acceptPendingWrite,
  listPendingWrites,
  rejectPendingWrite,
  type WorkspaceReadOpts,
  type WorkspaceEditOpts,
} from "./kernel-workspace-ops.ts";
import { fetchUrlForCapture, buildFetchMarkdown, type FetchCaptureResult } from "./capture-fetch.ts";
import { sanitizeAiContent } from "#kernel/ai-content-sanitize.mjs";
import { t, getLocale } from "../i18n";
import { buildChatContext } from "./chat-context.ts";
import { readWorkspaceState, writeWorkspaceState } from "#kernel/workspace-state.mjs";
import { cancellableOperationProvider } from "./operation-provider";
import { createChatMemoryProposal } from "./chat-memory-proposal";
import { buildFocusContext, captureChatFocus, refreshBoundFocus, editorWriteConflict, type ChatFocus } from "./editor-context.ts";
import { resolveTaskContract, type TaskContract } from "#kernel/agent-task-contract.mjs";
import { hasConfiguredProvider, getProviderKey } from "../types.ts";

// ── Node.js built-ins ──
// esbuild platform:'node' keeps these as require() calls (works in Electron).
// Using ESM imports for type safety — esbuild converts to CJS require in output.
import fs from "node:fs";
import path from "node:path";

interface CachedModel {
  model: { categories: { role: string; directory: string; name: string }[]; contract?: Record<string, unknown> };
  contractMtime: number; // topmind.yaml mtime when cached
}

export class KernelService {
  private app: App;
  private plugin: Plugin;
  private settings: TopmindSettings;
  private context: KernelContext | null = null;
  private lastSettingsHash: string = "";
  private cachedModel: CachedModel | null = null;
  /** Kernel generateSuggestions session (soft refresh keeps fingerprint-skipped cards). */
  private suggestionSession: SuggestionCard[] = [];
  /** Last kernel suggest tick — soft path loads cache when the window has not changed. */
  private lastSuggestKernelAt = 0;
  private suggestInFlight: Promise<SuggestionCard[]> | null = null;
  private serviceEpoch = 0;
  /** Confirm-gated cards from memory_organize / topic_classify (survive suggest force). */
  private opSuggestionSession: SuggestionCard[] = [];
  private chatProposalSession: SuggestionCard[] = [];
  private proposalStoreError = "";
  private pendingReadError = "";
  private suggestionDropped = new Set<string>();

  constructor(app: App, plugin: Plugin, settings: TopmindSettings) {
    this.app = app;
    this.plugin = plugin;
    this.settings = settings;
    this.applyRuntimeSettings();
    this.loadChatProposals();
  }

  /** Update settings (rebuilds context if AI config changed) */
  updateSettings(settings: TopmindSettings): void {
    // Include routing, default model and per-model options; never log this value.
    const hash = JSON.stringify([settings.ai, settings.aiProvider, settings.aiApiKey, settings.aiBaseUrl, settings.aiModel, settings.localeOverride]);
    if (hash !== this.lastSettingsHash) {
      this.serviceEpoch += 1;
      this.suggestInFlight = null;
      this.context = null; // Force rebuild on next call
    }
    this.settings = settings;
    this.lastSettingsHash = hash;
    this.applyRuntimeSettings();
  }

  /** Invalidate cached model (call when topmind.yaml or dir structure changes) */
  invalidateCache(): void {
    this.cachedModel = null;
  }

  /** Clean up resources on plugin unload */
  dispose(): void {
    this.serviceEpoch += 1;
    this.suggestInFlight = null;
    this.context = null;
    this.cachedModel = null;
    this.lastSettingsHash = "";
    this.suggestionSession = [];
    this.opSuggestionSession = [];
    this.chatProposalSession = [];
    this.suggestionDropped.clear();
    this.lastSuggestKernelAt = 0;
    // Do not leave keep-count overrides in the shared renderer process.
    delete process.env.BACKUP_KEEP;
    delete process.env.RECEIPT_KEEP;
  }

  private loadChatProposals(): void {
    try {
      const raw = readWorkspaceState<unknown>(this.getVaultPath(), "chat-proposals.json", []);
      if (!Array.isArray(raw) || raw.length > 20) throw new Error("invalid-chat-proposals");
      const target = getKernel().globalProfileRelPath?.(this.getVaultPath()) || `${this.memoryDirRel()}/profile.md`;
      this.chatProposalSession = raw.map(value => {
        if (!isRecord(value) || !isRecord(value.payload) || typeof value.title !== "string") throw new Error("invalid-chat-proposal");
        return createChatMemoryProposal({ ...value.payload, content: value.payload.content || value.payload.entry, title: value.title }, target);
      });
    } catch (error) { this.proposalStoreError = error instanceof Error ? error.message : String(error); }
  }

  /** Drop a suggestion from the session (apply success or user dismiss). */
  dropSuggestion(id: string): void {
    if (!id) return;
    if (this.chatProposalSession.some(card => card.id === id)) {
      const next = this.chatProposalSession.filter(card => card.id !== id);
      try { writeWorkspaceState(this.getVaultPath(), "chat-proposals.json", next); }
      catch { new Notice(t("notice_proposal_state_failed")); }
      this.chatProposalSession = next;
    }
    this.suggestionDropped.add(id);
    this.suggestionSession = this.suggestionSession.filter((s) => s.id !== id);
    this.opSuggestionSession = this.opSuggestionSession.filter((s) => s.id !== id);
  }

  /** Kernel session first, then op cards not already shown. */
  private visibleSuggestions(): SuggestionCard[] {
    return mergeSoftSuggestionSession(
      [...this.opSuggestionSession, ...this.chatProposalSession],
      this.suggestionSession,
      this.suggestionDropped,
    );
  }

  /** Cached confirm cards — paint these without a kernel round-trip. */
  peekSuggestions(): SuggestionCard[] {
    return this.visibleSuggestions();
  }

  /**
   * Apply settings that affect Kernel runtime behavior via env vars.
   *
   * The Kernel's writeback-engine reads BACKUP_KEEP and RECEIPT_KEEP from
   * process.env at write time. This is the only bridge available because
   * the Kernel is bundled (no direct config injection point).
   *
   * Side effect: modifies process.env globally within the plugin's process.
   * This is safe because Obsidian plugins share the same Electron renderer
   * process, and these env vars are topmind-specific (no naming collision risk).
   */
  private applyRuntimeSettings(): void {
    // Wire backupKeep to Kernel's expected env var
    process.env.BACKUP_KEEP = String(this.settings.backupKeep);
    // Wire receiptKeep to Kernel's receipt rotation env var
    process.env.RECEIPT_KEEP = String(this.settings.receiptKeep);
  }

  /** Host UI locale for product AI (suggest / todo / ops). `auto` / empty → app language. */
  private surfaceUiLocale(): string | null {
    const override = this.settings.localeOverride;
    if (override && override !== "auto") return override;
    return getLocale() || null;
  }

  /** Get or create the kernel context */
  private getContext(): KernelContext {
    if (!this.context) {
      const aiProvider = createAiProvider(this.settings);
      this.context = createKernelContextFromApp(this.app, this.plugin, aiProvider, this.surfaceUiLocale());
    }
    return this.context;
  }

  /** Hydrate settings.writebackMode from workspace contract for Settings UI. */
  hydrateWritebackModeFromContract(): "auto" | "confirm" | null {
    const mode = resolveContractWritebackMode(getKernel(), this.getVaultPath());
    if (mode) this.settings.writebackMode = mode;
    return mode;
  }

  /** Persist Settings dropdown into topmind.yaml (operational truth). */
  mirrorWritebackMode(mode: "auto" | "confirm"): { ok: boolean; error?: string } {
    const result = mirrorWritebackModeToContract(getKernel(), this.getVaultPath(), mode);
    if (result.ok) {
      this.settings.writebackMode = mode;
      this.invalidateCache();
    }
    return result;
  }

  // ── Workspace ──────────────────────────────────────────────────────────

  /** Check if current vault is a topmind workspace */
  isWorkspaceReady(): boolean {
    try {
      const basePath = this.getVaultPath();
      return fs.existsSync(path.join(basePath, "topmind.yaml"));
    } catch {
      return false;
    }
  }

  /**
   * Initialize workspace structure in current vault.
   * First-time (no NN- categories): seed full template layout (Desktop parity)
   * so loose-stream「动态」exists. Subsequent calls only ensure required roles.
   */
  initWorkspace(templateId: string = "stream"): { ok: boolean; error?: string } {
    const result = initWorkspaceStructure(
      getKernel(),
      this.getVaultPath(),
      this.getEngineRoot(),
      templateId,
    );
    if (result.ok) {
      this.invalidateCache();
      this.hydrateWritebackModeFromContract();
    }
    return result;
  }

  /** Load contract from topmind.yaml (reads file each call, but cached at model level) */
  loadContract(): Record<string, unknown> {
    const kernel = getKernel();
    return kernel.loadContract(this.getVaultPath());
  }

  /**
   * Resolve workspace model with caching.
   * Exposed for command handlers that need category info (e.g., open inbox).
   */
  getResolvedModel(): { categories: { role: string; directory: string; name: string }[]; contract?: Record<string, unknown> } {
    return this.getResolvedModelInternal();
  }

  /**
   * Stream-relevant vault paths derived from the resolved contract
   * (loose-stream category directories) — replaces the hardcoded `1\d-`
   * prefix heuristic that went stale on customized contracts.
   */
  isStreamRelevantPath(relPath: string): boolean {
    const p = relPath.replace(/\\/g, "/");
    if (/(?:^|\/)todo\.md$/u.test(p)) return true;
    const profile = this.profileRelPath();
    const slash = profile.lastIndexOf("/");
    const memDir = slash > 0 ? profile.slice(0, slash) : "memory";
    if (p === `${memDir}/periodic` || p.startsWith(`${memDir}/periodic/`)) return true;
    try {
      const dirs = (this.getResolvedModel().categories || [])
        .filter((c) => c.role === "loose-stream" || c.role === "stream")
        .map((c) => String(c.directory || "").replace(/\\/g, "/"))
        .filter(Boolean);
      if (dirs.length > 0) {
        return dirs.some((d) => p === d || p.startsWith(`${d}/`));
      }
    } catch {
      /* fall through to convention fallback */
    }
    // Pre-contract fallback: stream categories use the 10-19 range by convention
    return /^1\d-/u.test(p);
  }

  /** Workspace-relative 我的情况 path (contract memory.dir + profile file). */
  profileRelPath(): string {
    const vault = this.getVaultPath();
    try {
      const abs = getKernel().resolveMemoryLayerPath?.(vault, "global");
      if (typeof abs === "string" && abs) {
        return path.relative(vault, abs).replace(/\\/g, "/");
      }
    } catch {
      /* fall through */
    }
    // Last-resort fallback only — kernel `resolveMemoryLayerPath` / `globalProfileRelPath`
    // is the truth (contract memory.dir + profile file). Never write through this constant.
    return "memory/profile.md";
  }

  /** Structured inventory of profile facts (Desktop listProfileFacts parity). */
  profileFacts(): {
    exists: boolean;
    profilePath: string;
    sections: Array<{ title: string; role: string | null; isHistory: boolean; facts: Array<{ text: string; key: string; date: string | null; fid?: string | null }> }>;
    activeCount: number;
    historyCount: number;
  } | null {
    try {
      const kernel = getKernel();
      if (typeof kernel.listProfileFacts !== "function") return null;
      return kernel.listProfileFacts(this.getVaultPath());
    } catch {
      return null;
    }
  }

  /** Deterministic profile health (near-dupes / oversized / large history). */
  profileHealth(): { healthy: boolean; issues: string[]; nearDupes?: unknown[]; exactDupes?: unknown[]; activeCount?: number; historyCount?: number } | null {
    try {
      const kernel = getKernel();
      if (typeof kernel.analyzeProfileHealth !== "function") return null;
      return kernel.analyzeProfileHealth(this.getVaultPath());
    } catch {
      return null;
    }
  }

  /** Keyword search over profile facts (Desktop searchProfile parity). */
  searchProfile(query: string, opts?: { includeHistory?: boolean; limit?: number }): { hits?: Array<{ text: string; section: string; date: string | null; history?: boolean }>; count?: number } | null {
    try {
      const kernel = getKernel();
      if (typeof kernel.searchProfile !== "function") return null;
      return kernel.searchProfile(this.getVaultPath(), query, opts);
    } catch {
      return null;
    }
  }

  /** Restore an archived fact back into an active section (confirm-gated kernel). */
  restoreProfileFact(match: string, section?: string): { ok?: boolean; operation?: string; reason?: string; note?: string; wroteFiles?: boolean } | null {
    try {
      const kernel = getKernel();
      if (typeof kernel.restoreProfileEntry !== "function") return null;
      const evidence = kernel.restoreProfileEntry({
        workspaceRoot: this.getVaultPath(),
        match,
        section,
        actor: "user",
        confirmed: true,
      });
      return { ok: evidence?.wroteFiles !== false && evidence?.operation !== "skip", ...evidence };
    } catch (err) {
      return { ok: false, reason: "error", note: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Workspace-relative personal todo path (contract memory.dir). */
  todoRelPath(): string {
    const vault = this.getVaultPath();
    try {
      const kernel = getKernel();
      if (typeof kernel.resolveTodoRelPath === "function") {
        return kernel.resolveTodoRelPath(vault);
      }
      const abs = kernel.resolveTodoPath?.(vault);
      if (typeof abs === "string" && abs) {
        return path.relative(vault, abs).replace(/\\/g, "/");
      }
    } catch {
      /* fall through */
    }
    // Last-resort fallback only — kernel resolveTodoRelPath is the truth.
    return "memory/todo.md";
  }

  /** Absolute memory-plane directory. */
  memoryDirAbs(): string {
    const vault = this.getVaultPath();
    try {
      const abs = getKernel().resolveMemoryDir?.(vault);
      if (typeof abs === "string" && abs) return abs;
    } catch {
      /* fall through */
    }
    return path.join(vault, "memory");
  }

  /** Relative memory-plane directory (workspace-relative). */
  memoryDirRel(): string {
    const profile = this.profileRelPath();
    const slash = profile.lastIndexOf("/");
    return slash > 0 ? profile.slice(0, slash) : "memory";
  }

  /**
   * Resolve workspace model with caching.
   * Caches based on topmind.yaml mtime — invalidates when config changes.
   * This avoids repeated disk scans (discoverCategoryDirs) on every UI refresh.
   */
  private getResolvedModelInternal(): { categories: { role: string; directory: string; name: string }[]; contract?: Record<string, unknown> } {
    const kernel = getKernel();
    const workspaceRoot = this.getVaultPath();
    const engineRoot = this.getEngineRoot();
    const yamlPath = path.join(workspaceRoot, "topmind.yaml");

    let contractMtime = 0;
    try {
      contractMtime = fs.statSync(yamlPath).mtimeMs;
    } catch {
      // topmind.yaml missing — mtime 0 forces fresh resolve
    }

    if (this.cachedModel && this.cachedModel.contractMtime === contractMtime) {
      return this.cachedModel.model;
    }

    const contract = this.loadContract();
    const model = kernel.resolveWorkspaceModel({
      workspaceRoot,
      engineRoot,
      config: contract,
    });

    this.cachedModel = { model, contractMtime };
    return model;
  }

  // ── Stream ─────────────────────────────────────────────────────────────

  /**
   * Get stream period list (newest first).
   * Awaits Kernel `listStreamPeriods({ workspaceRoot, engineRoot, config })`.
   */
  async getStreamContext(): Promise<{ periods: StreamPeriod[]; current: StreamPeriod | null }> {
    try {
      return await listStreamPeriodsForWorkspace(
        getKernel(),
        this.getVaultPath(),
        this.getEngineRoot(),
      );
    } catch (err) {
      console.error("[topmind] getStreamContext failed:", err);
      return { periods: [], current: null };
    }
  }

  /** Read a period note and parse entries asynchronously (preferred) */
  async readPeriodNoteAsync(relPath: string): Promise<{ content: string; entries: StreamEntry[] }> {
    try {
      const file = this.app.vault.getAbstractFileByPath(relPath);
      let raw = "";
      if (file instanceof TFile) {
        raw = await this.app.vault.cachedRead(file);
      } else if (await this.app.vault.adapter.exists(relPath)) {
        raw = await this.app.vault.adapter.read(relPath);
      }
      const content = stripFrontmatter(raw);
      const entries = parseStreamEntries(content);
      return { content, entries };
    } catch {
      return { content: "", entries: [] };
    }
  }

  /** Read a period note and parse entries */
  readPeriodNote(relPath: string): { content: string; entries: StreamEntry[] } {
    try {
      const file = this.app.vault.getAbstractFileByPath(relPath);
      let raw = "";
      if (file instanceof TFile) {
        // Vault readSync fallback if present (internal desktop API)
        const vault: unknown = this.app.vault;
        if (isRecord(vault) && typeof vault.readSync === "function") {
          const read: unknown = Reflect.apply(vault.readSync, vault, [file]);
          raw = typeof read === "string" ? read : "";
        } else {
          raw = "";
        }
      }
      if (!raw) {
        const workspaceRoot = this.getVaultPath();
        const absPath = path.join(workspaceRoot, relPath);
        if (fs.existsSync(absPath)) {
          raw = fs.readFileSync(absPath, "utf-8");
        }
      }
      // Strip frontmatter before parsing — entries live in the body only
      const content = stripFrontmatter(raw);
      const entries = parseStreamEntries(content);
      return { content, entries };
    } catch {
      return { content: "", entries: [] };
    }
  }

  /** Capture text to stream (or inbox) via writeback-engine */
  capture(text: string, opts: { target?: "stream" | "inbox"; tags?: string[] } = {}): {
    ok: boolean;
    path?: string;
    error?: string;
  } {
    if (!this.isWorkspaceReady()) {
      new Notice(t("notice_workspace_not_ready"));
      return { ok: false, error: "workspace-not-ready" };
    }

    const result = captureToWorkspace(
      getKernel(),
      this.getVaultPath(),
      this.getEngineRoot(),
      text,
      {
        target: opts.target,
        tags: opts.tags,
        // omit writebackMode — Kernel uses topmind.yaml
      },
    );

    if (result.ok) {
      new Notice(`${t("notice_written")} → ${result.path}`);
    } else if (result.error === "pending-confirmation") {
      new Notice(t("notice_write_pending"));
    } else if (result.error && result.error !== "empty-text") {
      new Notice(`${t("notice_write_failed")}: ${result.error}`);
    }
    return result;
  }

  /** Append continuation to a stream entry (1:1 with Desktop) */
  appendStreamEntry(opts: {
    relativePath: string;
    content: string;
    heading?: string;
    startLine?: number;
    endLine?: number;
    anchorText?: string;
  }): { ok: boolean; path?: string; pending?: boolean; needsConfirm?: boolean; error?: string } {
    if (!this.isWorkspaceReady()) {
      new Notice(t("notice_workspace_not_ready"));
      return { ok: false, error: "workspace-not-ready" };
    }

    const result = appendStreamEntryToWorkspace(
      getKernel(),
      this.getVaultPath(),
      this.cachedModel?.model.contract,
      opts,
    );

    if (result.pending || result.needsConfirm || result.error === "pending-confirmation") {
      new Notice(t("notice_write_pending"));
    } else if (result.ok) {
      new Notice(`${t("notice_written")} → ${result.path}`);
    } else {
      new Notice(`${t("notice_write_failed")}: ${result.error || "unknown"}`);
    }
    return result;
  }

  /**
   * URL 抓取（记一下「抓取」按钮）— Desktop fetchUrl parity。
   * GitHub markdown → raw；普通网页 → HTML 启发式提取。
   */
  async fetchUrlForCapture(url: string): Promise<FetchCaptureResult> {
    return fetchUrlForCapture(async (u: string) => {
      try {
        const r = await requestUrl({ url: u, method: "GET" });
        return {
          ok: r.status >= 200 && r.status < 400,
          status: r.status,
          text: String(r.text || ""),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }, url);
  }

  /** Compact source header + body for a fetch result (Desktop buildFetchMarkdown parity). */
  buildFetchMarkdown(result: FetchCaptureResult): string {
    return buildFetchMarkdown(result, {
      source: t("capture_meta_source"),
      author: t("capture_meta_author"),
      site: t("capture_meta_site"),
      noBody: t("capture_meta_no_body"),
    });
  }

  /** Quick AI polish for composer text (does not write to disk) */
  async polishText(rawText: string): Promise<string | null> {
    const text = String(rawText || "").trim();
    if (!text) return null;
    if (!hasConfiguredProvider(this.settings.ai)) {
      new Notice(t("chat_configure_ai"));
      return null;
    }

    try {
      const provider = createAiProvider(this.settings);
      if (!provider) {
        new Notice(t("chat_configure_ai"));
        return null;
      }
      const isZh = (this.surfaceUiLocale() || "").toLowerCase().startsWith("zh");
      const prompt = isZh
        ? `请润色以下随手记内容，使其表达更通顺、专业，同时保留原意与信息量。只输出润色后的正文，不要包含任何前置或后置说明解释、不要包含标签符号：\n\n${text}`
        : `Please polish the following note to make it smoother and more professional while preserving its original meaning and details. Output only the polished replacement text without any preamble or explanation:\n\n${text}`;
      const res = await provider.generate(prompt, { operation: "polish", foldReasoning: true });
      // Never leak thinking / meta into the composer — only the polished body.
      const cleaned = sanitizeAiContent(String(res || ""));
      return cleaned.trim() || null;
    } catch (e) {
      new Notice(`${t("notice_polish_failed")}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  createInboxNote(): { ok: boolean; path?: string; error?: string } {
    if (!this.isWorkspaceReady()) {
      new Notice(t("notice_workspace_not_ready"));
      return { ok: false, error: "workspace-not-ready" };
    }
    const result = createInboxNoteInWorkspace(
      getKernel(),
      this.getVaultPath(),
      this.getEngineRoot(),
    );
    if (!result.ok) {
      new Notice(`${t("notice_write_failed")}: ${result.error || ""}`.trim());
    }
    return result;
  }

  listPendingWrites() {
    try { const pending = listPendingWrites(this.getVaultPath()); this.pendingReadError = ""; return pending; }
    catch (error) { this.pendingReadError = error instanceof Error ? error.message : String(error); return []; }
  }
  reviewStorageError(): string { return this.pendingReadError || this.proposalStoreError; }

  acceptPendingWrite(id: string): { ok: boolean; path?: string; error?: string } {
    const item = this.listPendingWrites().find(entry => entry.id === id);
    if (item) {
      const conflict = editorWriteConflict(this.app.workspace, this.getVaultPath(), [item.relativePath]);
      if (conflict) {
        new Notice(`${t("notice_execute_failed")}: ${conflict}`);
        return { ok: false, error: conflict };
      }
    }
    const result = acceptPendingWrite(getKernel(), this.getVaultPath(), id);
    if (result.ok) {
      new Notice(t("notice_pending_accepted"));
    } else {
      new Notice(`${t("notice_execute_failed")}: ${result.error || ""}`.trim());
    }
    return result;
  }

  rejectPendingWrite(id: string): boolean {
    try {
      const ok = rejectPendingWrite(this.getVaultPath(), id);
      if (ok) new Notice(t("notice_pending_rejected"));
      return ok;
    } catch { new Notice(t("review_storage_error")); return false; }
  }

  /**
   * Reconcile a period note — deterministic Kernel reconcilePeriodBody(body, opts)
   * returns `{ body, changed }` (not `{ reconciled }`).
   */
  reconcilePeriod(relPath: string): { ok: boolean; reconciled: boolean; error?: string } {
    return reconcilePeriodNote(
      getKernel(),
      this.getVaultPath(),
      this.getEngineRoot(),
      relPath,
      {},
    );
  }

  // ── Suggestions ────────────────────────────────────────────────────────

  /**
   * Generate AI suggestions.
   * Soft (default): Kernel call without force, merge session so fingerprint skip
   * does not vanish cards. Manual refresh passes `{ force: true }` (Desktop parity).
   * `autoSuggest` off skips the Kernel call unless force — session/op cards still show.
   */
  async generateSuggestions(opts: { force?: boolean } = {}): Promise<SuggestionCard[]> {
    if (this.suggestInFlight) return this.suggestInFlight;
    const pending = this.generateSuggestionsOnce(opts);
    this.suggestInFlight = pending;
    try { return await pending; }
    finally { if (this.suggestInFlight === pending) this.suggestInFlight = null; }
  }

  private async generateSuggestionsOnce(opts: { force?: boolean }): Promise<SuggestionCard[]> {
    const force = opts.force === true;
    const cached = this.visibleSuggestions();
    if (!this.settings.autoSuggest && !force) {
      return cached;
    }
    // Soft path: reuse session cards when we just ran (Desktop 5s throttle).
    // Kernel fingerprints still skip the LLM when the activity window is unchanged.
    if (!force && cached.length > 0 && Date.now() - this.lastSuggestKernelAt < 5000) {
      return cached;
    }

    const epoch = this.serviceEpoch;
    const ctx = this.getContext();
    const raw = await ctx.generateSuggestions({ force, localeOverride: this.surfaceUiLocale() });
    if (epoch !== this.serviceEpoch) return this.visibleSuggestions();
    this.lastSuggestKernelAt = Date.now();
    // Kernel returns Suggestion[] directly; normalizeSuggestionList also
    // accepts legacy { suggestions: [] } for forward compatibility.
    const mapped = normalizeSuggestionList(raw)
      .map(mapKernelSuggestion)
      .filter((s) => s.id && !this.suggestionDropped.has(s.id));
    this.suggestionSession = force
      ? mapped
      : mergeSoftSuggestionSession(this.suggestionSession, mapped, this.suggestionDropped);
    return this.visibleSuggestions();
  }

  /**
   * Apply (accept) a suggestion after user confirm.
   * Maps Kernel skip/failure (ok:false, wroteFiles:false, operation:skip) to
   * surface failure so the UI keeps the card and does not show a false success.
   */
  async applySuggestion(suggestion: SuggestionCard, opts: { silent?: boolean } = {}): Promise<{
    ok: boolean;
    error?: string;
    openPath?: string;
    matchedText?: string;
    matchExact?: boolean;
    matchScore?: number;
  }> {
    const silent = opts.silent === true;
    const working = silent
      ? null
      : new Notice(`${t("notice_executing")}: ${suggestion.title}`, 0);
    try {
      const ctx = this.getContext();
      const result = await ctx.applySuggestion(
        {
          id: suggestion.id,
          kind: suggestion.kind,
          title: suggestion.title,
          summary: suggestion.summary,
          impact: suggestion.impact,
          payload: suggestion.payload,
          targetPath: suggestion.targetPath,
        },
        { localeOverride: this.surfaceUiLocale() },
      );

      const mapped = mapApplySuggestionResult(result, suggestion);
      working?.hide();
      if (mapped.ok) {
        this.dropSuggestion(suggestion.id);
        if (!silent) {
          // Fuzzy update/retire: say which live fact was actually rewritten.
          const fuzzy = Boolean(mapped.matchedText) && mapped.matchExact === false;
          const suffix = fuzzy && mapped.matchedText
            ? ` · ${t("notice_fuzzy_matched", { fact: mapped.matchedText.slice(0, 40) })}`
            : "";
          new Notice(`${t("notice_executed")}: ${suggestion.title}${suffix}`);
        }
        return mapped;
      }
      if (!silent) new Notice(`${t("notice_execute_failed")}: ${mapped.error || suggestion.title}`);
      return mapped;
    } catch (err) {
      working?.hide();
      const msg = err instanceof Error ? err.message : String(err);
      if (!silent) new Notice(`${t("notice_execute_failed")}: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  // ── AI Operations ──────────────────────────────────────────────────────

  /** Run AI operation (todo_maintain, memory_organize, topic_classify) */
  async runOperation(id: string, opts: { force?: boolean; shouldAbort?: () => boolean } = {}): Promise<{
    ok: boolean;
    summary: string;
    suggestions?: SuggestionCard[];
  }> {
    try {
      const ctx = this.getContext();
      if (opts.shouldAbort?.()) return { ok: false, summary: "Operation cancelled" };
      const aiProvider = ctx.aiProvider && opts.shouldAbort ? cancellableOperationProvider(ctx.aiProvider, opts.shouldAbort) : ctx.aiProvider;
      const result = await ctx.runOperation({
        id, aiProvider,
        options: { force: opts.force, localeOverride: this.surfaceUiLocale() },
      });
      if (opts.shouldAbort?.()) return { ok: false, summary: "Operation cancelled" };
      const suggestions = normalizeSuggestionList(result.suggestions)
        .map(mapKernelSuggestion)
        .filter((s) => s.id && !this.suggestionDropped.has(s.id));
      if (suggestions.length > 0) {
        this.opSuggestionSession = mergeSoftSuggestionSession(
          this.opSuggestionSession,
          suggestions,
          this.suggestionDropped,
        );
      }
      return {
        ok: result.ok,
        summary: result.summary || "",
        suggestions,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: msg };
    }
  }

  // ── Todo ────────────────────────────────────────────────────────────────

  /** Read todo list (read-only — does NOT create the todo file as a side effect) */
  readTodos(): TodoItem[] {
    return readTodosFromWorkspace(getKernel(), this.getVaultPath());
  }

  /** Toggle todo completion */
  toggleTodo(id: string): { ok: boolean; error?: string } {
    try {
      const kernel = getKernel();
      const workspaceRoot = this.getVaultPath();
      const contract = this.loadContract();
      const result = kernel.toggleTodoItem(workspaceRoot, id, contract, { actor: "user" });
      if (result && result.ok === false) {
        new Notice(t("notice_execute_failed"));
        return { ok: false, error: "write-failed" };
      }
      return { ok: true };
    } catch (err) {
      console.error("[topmind] toggleTodo failed:", err);
      const error = err instanceof Error ? err.message : String(err);
      new Notice(`${t("notice_execute_failed")}: ${error}`);
      return { ok: false, error };
    }
  }

  /** User gestures use the same Kernel mutation path and report failures. */
  private mutateTodo(action: () => unknown): { ok: boolean; error?: string } {
    try {
      const result = action() as { ok?: boolean; error?: string; reason?: string } | undefined;
      if (!result || result.ok === false) throw new Error(result?.error || result?.reason || "write-failed");
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      new Notice(`${t("notice_execute_failed")}: ${error}`);
      return { ok: false, error };
    }
  }

  addTodo(text: string): { ok: boolean; error?: string } {
    if (!text.trim()) return { ok: false, error: "empty-todo" };
    return this.mutateTodo(() => getKernel().addTodoItem?.(this.getVaultPath(), text.trim(), {
      actor: "user", source: "manual", confirmed: true,
    }));
  }

  deleteTodo(id: string): { ok: boolean; error?: string } {
    return this.mutateTodo(() => getKernel().deleteTodoItem?.(this.getVaultPath(), id, this.loadContract(), { actor: "user" }));
  }

  clearCompletedTodos(): { ok: boolean; error?: string } {
    return this.mutateTodo(() => getKernel().clearCompleted?.(this.getVaultPath(), this.loadContract(), { actor: "user" }));
  }

  /** Resolve actual indexed paths, including year folders and sticky streams. */
  async todoSourcePath(period: string): Promise<string | null> {
    const { periods } = await this.getStreamContext();
    return periods.find((item) => item.period === period || item.relPath === period)?.relPath || null;
  }

  // ── AI Chat ────────────────────────────────────────────────────────────

  /** Windowed workspace read — same Kernel contract as Desktop read_file. */
  readFileWindow(opts: WorkspaceReadOpts) {
    return readWorkspaceWindow(getKernel(), this.getVaultPath(), opts);
  }

  /** Unique-span edit via writeback — same matcher as Desktop edit_file. */
  preciseEdit(opts: WorkspaceEditOpts) {
    const mode = resolveContractWritebackMode(getKernel(), this.getVaultPath()) || this.settings.writebackMode;
    return preciseEditWorkspace(getKernel(), this.getVaultPath(), {
      ...opts,
      writebackMode: opts.writebackMode || mode,
      confirmed: opts.confirmed ?? mode !== "confirm",
    });
  }

  /**
   * Chat with AI about the user's notes, todos, and stream.
   * Builds context, then runs a multi-step Kernel-backed agent loop
   * (discover → act → answer) with auto-continue on step exhaustion.
   */
  async chat(
    userMessage: string,
    history: Array<{ role: "user" | "assistant"; content: string }> = [],
    opts: {
      onProgress?: (ev: ChatProgressEvent) => void;
      focus?: ChatFocus | null;
      shouldAbort?: () => boolean;
      /** Pause keeps the ledger; cancel is the only cancelled stop. */
      stopKind?: () => "paused" | "cancelled";
      /** Model context window (tokens) for session compact budget. */
      contextLimit?: number | null;
      /** Session goal from the previous turn (same-task restore). */
      priorGoal?: {
        task?: TaskContract;
        goal?: string;
        plan?: string[];
        criteria?: string[];
        doneCriteria?: string[];
        pathReceipts?: string[];
        status?: string;
        blockReason?: string | null;
        openCriteria?: string[];
      } | null;
    } = {},
  ): Promise<{
    content: string;
    reasoning: string;
    steps: number;
    toolCalls: Array<{ tool: string; ok: boolean; summary?: string; pending?: boolean; needsConfirm?: boolean }>;
    autoContinues: number;
    stepLimitHit: boolean;
    stopReason?: "paused" | "cancelled";
    cancelled?: boolean;
    goal?: {
      goal: string;
      plan: string[];
      criteria: string[];
      openCriteria: string[];
      pathReceipts: string[];
      status: string;
      blockReason: string | null;
      autoContinues: number;
    };
  }> {
    let aiProvider: AiProvider | null = null;
    try {
      const ctx = this.getContext();
      const bound = ctx?.aiProvider;
      if (bound && typeof bound.generate === "function") {
        aiProvider = { generate: (prompt, context) => bound.generate(prompt, context) };
      }
    } catch {
      // Context creation failed — fall through to manual creation
    }

    if (!aiProvider) {
      aiProvider = createAiProvider(this.settings);
    }

    if (!aiProvider) {
      throw new Error(t("settings_ai_test_no_key"));
    }
    // Capture for the generate closure — `let` narrowing does not survive capture.
    const activeAi: AiProvider = aiProvider;

    const currentFocus = captureChatFocus(this.app.workspace);
    let requestedFocus = opts.focus === undefined ? currentFocus : opts.focus;
    const taskContract = resolveTaskContract({ userText: userMessage, focusPath: requestedFocus?.path, intent: requestedFocus?.taskIntent, priorTask: opts.priorGoal?.task, capabilities: { vision: false, imageGeneration: false, imageRendering: false } });
    if (taskContract.kind === "document" && taskContract.targetPath && taskContract.targetPath !== requestedFocus?.path) requestedFocus = { path: taskContract.targetPath };
    const contextParts = taskContract.kind === "document" ? [] : await buildChatContext(userMessage, {
      stream: async () => {
        const ctx = await this.getStreamContext();
        if (!ctx.current) return "";
        const { entries } = await this.readPeriodNoteAsync(ctx.current.relPath);
        return [...entries].reverse().slice(0, 20).map((e) => `- ${e.time} ${e.text}`).join("\n");
      },
      todos: () => this.readTodos().filter((todo) => !todo.done).slice(0, 10)
        .map((todo) => `- ${todo.text}${todo.dueDate ? ` (due: ${todo.dueDate})` : ""}`).join("\n"),
      profile: () => loadChatProfileContext(getKernel(), this.getVaultPath(), this.settings.localeOverride || getLocale() || "zh-CN"),
      reflections: async () => (await this.loadRecentReflections()) || "",
    });

    const focus = buildFocusContext(this.getVaultPath(), refreshBoundFocus(this.app.workspace, requestedFocus));
    if (focus) contextParts.unshift(focus.prompt);

    const uiLocale = this.settings.localeOverride || getLocale() || "zh-CN";
    const kernel = getKernel();
    const durable = resolveChatDurableLocale(kernel, this.getVaultPath(), userMessage);
    const isZh = durable === "zh";
    const systemPrompt = isZh
      ? "你是嵌入在 topmind Obsidian 插件中的 AI 助手。" +
        "你帮助用户反思笔记、规划任务、整理思路，并可经写闸精确改工作区 .md。" +
        "回答简洁实用，引用用户的真实数据时要有针对性。" +
        "不要输出思考过程、<think> 标签或 reasoning 围栏，只给用户可见结论。\n\n" +
        (contextParts.length > 0
          ? "以下是用户当前的上下文：\n\n" + contextParts.join("\n\n")
          : "暂无工作区上下文。")
      : "You are a helpful AI assistant embedded in the topmind Obsidian plugin. " +
        "You help the user reflect on their notes, plan tasks, organize thoughts, and make precise Kernel-backed .md edits. " +
        "Be concise, practical, and reference the user's actual data when relevant. " +
        "Do not output thinking process, <think> tags, or reasoning fences — only the user-visible answer.\n\n" +
        (contextParts.length > 0
          ? "Here is the user's current context:\n\n" + contextParts.join("\n\n")
          : "No workspace context available yet.");

    const turn = await runWorkspaceChatTurn(kernel, this.getVaultPath(), {
      taskContract,
      userMessage,
      history,
      focus: focus ? { path: focus.focus.path, unsaved: focus.unsaved, contentHash: focus.contentHash, taskIntent: focus.focus.taskIntent } : requestedFocus ? { path: requestedFocus.path, taskIntent: requestedFocus.taskIntent } : null,
      beforeWrite: paths => editorWriteConflict(this.app.workspace, this.getVaultPath(), paths),
      onMemoryProposal: (call) => {
        const target = kernel.globalProfileRelPath?.(this.getVaultPath()) || `${this.memoryDirRel()}/profile.md`;
        const card = createChatMemoryProposal(call, target);
        if (this.proposalStoreError) throw new Error(this.proposalStoreError);
        const next = [...this.chatProposalSession.filter(existing => existing.id !== card.id), card];
        if (next.length > 20) throw new Error("chat-proposals queue is full");
        writeWorkspaceState(this.getVaultPath(), "chat-proposals.json", next);
        this.chatProposalSession = next;
        this.suggestionDropped.delete(card.id);
        return { id: card.id, targetPath: target };
      },
      generate: (prompt, context) => activeAi.generate(prompt, context),
      locale: uiLocale,
      // omit writebackMode — runWorkspaceChatTurn reads topmind.yaml
      systemExtra: systemPrompt,
      maxSteps: clampMaxAgentSteps(this.settings.maxAgentSteps),
      contextLimit: opts.contextLimit,
      onProgress: opts.onProgress,
      shouldAbort: opts.shouldAbort,
      stopKind: opts.stopKind,
      engineRoot: this.getEngineRoot(),
      configDir: this.app.vault.configDir,
      priorGoal: opts.priorGoal ?? null,
      // fetch_url must go through Obsidian requestUrl (never global fetch).
      fetchPage: async (url: string) => {
        try {
          const r = await requestUrl({ url, method: "GET" });
          return {
            ok: r.status >= 200 && r.status < 400,
            status: r.status,
            text: String(r.text || ""),
          };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    });

    // Agent writes already hit disk via the write gate — poke vault listeners now.
    this.notifyFilesChanged(
      turn.toolCalls.filter((t) => t.ok && ["edit_file", "save_file", "save_note", "capture", "capture_url", "append_stream_entry", "add_todo", "toggle_todo", "update_todo", "set_todo_due", "delete_todo"].includes(t.tool)).map((t) => t.summary),
    );

    return {
      content: turn.body || "...",
      reasoning: turn.reasoning || "",
      steps: turn.steps,
      toolCalls: turn.toolCalls,
      autoContinues: turn.autoContinues,
      stepLimitHit: turn.stepLimitHit,
      stopReason: turn.stopReason,
      cancelled: turn.cancelled,
      goal: turn.goal,
    };
  }

  /**
   * Explicit vault notify after agent writes (fs already lands via writeback;
   * this keeps ItemViews / metadataCache in lockstep without waiting on FSEvents).
   */
  notifyFilesChanged(relPaths: Array<string | undefined | null>): void {
    for (const rel of relPaths) {
      if (!rel) continue;
      const norm = String(rel).replace(/\\/g, "/");
      const abs = this.app.vault.getAbstractFileByPath(norm);
      if (abs instanceof TFile) {
        try {
          this.app.vault.trigger("modify", abs);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  /**
   * Load recent periodic reflections from memory/periodic/ for chat context.
   * Reads the most recent reflection file (current year) and trims to 2000 chars.
   * Returns null if no reflections exist.
   */
  private async loadRecentReflections(): Promise<string | null> {
    try {
      const memRel = this.memoryDirRel();
      const periodicRel = `${memRel}/periodic`;
      if (!(await this.app.vault.adapter.exists(periodicRel))) return null;

      const candidates: { path: string; mtime: number }[] = [];
      const list = await this.app.vault.adapter.list(periodicRel);
      for (const f of list.files) {
        if (!f.endsWith(".md")) continue;
        const norm = f.replace(/\\/g, "/");
        const stat = await this.app.vault.adapter.stat(norm);
        if (stat && stat.type === "file") {
          candidates.push({ path: norm, mtime: stat.mtime });
        }
      }
      for (const dir of list.folders) {
        const base = dir.replace(/\\/g, "/").split("/").pop() || "";
        if (/^\d{4}$/u.test(base)) {
          const subList = await this.app.vault.adapter.list(dir);
          for (const f of subList.files) {
            if (!f.endsWith(".md")) continue;
            const norm = f.replace(/\\/g, "/");
            const stat = await this.app.vault.adapter.stat(norm);
            if (stat && stat.type === "file") {
              candidates.push({ path: norm, mtime: stat.mtime });
            }
          }
        }
      }

      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.mtime - a.mtime);

      const content = await this.app.vault.adapter.read(candidates[0].path);
      // Trim to 2000 chars — enough for key insights without overwhelming context
      return content.slice(0, 2000);
    } catch {
      return null;
    }
  }

  // ── AI Availability ──────────────────────────────────────────────────

  /**
   * Check if AI is configured (has at least one provider with keys).
   * This is a synchronous check — does not make network requests.
   */
  isAiConfigured(): boolean {
    return hasConfiguredProvider(this.settings.ai);
  }

  /**
   * Get list of configured providers for model switcher UI.
   * Returns array of { id, label, model } for each provider that has keys.
   */  
  getConfiguredProviders(): { id: string; label: string; model: string }[] {
    const result: { id: string; label: string; model: string }[] = [];
    for (const [pid, meta] of Object.entries(AI_PROVIDER_PRESETS)) {
      if (pid === "custom") {
        if (this.settings.ai.manual.customBaseUrl && this.settings.ai.manual.customKey) {
          result.push({
            id: pid,
            label: meta.label,
            model: this.settings.ai.defaultModel || "",
          });
        }
      } else if (pid === "ollama") {
        if (this.settings.ai.manual.ollamaBaseUrl) {
          result.push({
            id: pid,
            label: meta.label,
            model: this.settings.ai.defaultModel || meta.model,
          });
        }
      } else {
        const key = getProviderKey(pid, this.settings.ai.manual);
        if (key) {
          result.push({
            id: pid,
            label: meta.label,
            model: this.settings.ai.defaultModel || meta.model,
          });
        }
      }
    }
    return result;
  }

  /**
   * Get available models for a provider (from static defaults).
   * For dynamic model lists, use getModelsForProvider from models-dev.ts.
   */
  getProviderModels(providerId: string): { id: string; label: string }[] {
    const preset = AI_PROVIDER_PRESETS[providerId];
    const models = PROVIDER_DEFAULT_MODELS[providerId] || [];
    const result = [...models];
    // Add preset default if not already in list
    if (preset?.model && !result.some((m) => m.id === preset.model)) {
      result.unshift({ id: preset.model, label: `${preset.model} (${t("settings_ai_model_default")})` });
    }
    return result;
  }

  /**
   * Quick AI availability test — sends a minimal request to check connectivity.
   * Returns { ok, error? }.
   */
  async quickTestAi(): Promise<{ ok: boolean; error?: string }> {
    const provider = createAiProvider(this.settings);
    if (!provider) {
      return { ok: false, error: t("settings_ai_test_no_key") };
    }
    try {
      const reply = await provider.generate("Reply with: OK", { operation: "test", foldReasoning: false });
      if (reply && reply.trim().length > 0) {
        return { ok: true };
      }
      return { ok: false, error: "empty response" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Create an AI provider from current settings for connection testing.
   * Returns the provider without creating a full Kernel context.
   */
  testAiConnection(): AiProvider {
    return createAiProvider(this.settings) || {
      async generate(): Promise<string> {
        throw new Error("AI provider not configured");
      },
    };
  }

  /** Get the vault base path (public for settings tab contract doctor) */
  getVaultPath(): string {
    return getVaultBasePath(this.app);
  }

  private getEngineRoot(): string {
    return getEngineRoot(this.plugin, this.getVaultPath());
  }
}
