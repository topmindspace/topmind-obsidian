// ── Sidebar Dock View: AI Copilot Panel in Obsidian right sidebar ───────────
//
// Design: tabbed command center — all AI capabilities in one place.
// - Header: AI status + model badge + quick settings button + task badge
// - Tab bar: Todos | Suggestions | Chat | History
// - 动态流的家是主区 Stream View（能力单家，不进 Dock）
// - Tab content: rich, interactive panels
// - Quick actions row at bottom with optional labels
//
// UIUX (2026-08-11 refactor):
// - Header buttons: icon + text labels (with responsive hide on narrow)
// - Bottom actions: icon-first (labels opt-in via eye toggle)
// - Chat message buttons: icon-only with tooltips
// - Suggestion refresh: icon-only
// - Todo open file: icon-only
// - Chat send: icon-only with send icon
// - All loading states use spinners

import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, setIcon, Menu, Component } from "obsidian";
import type TopmindPlugin from "../main";
import { t } from "../i18n";
import { VIEW_TYPE_SIDEBAR_DOCK, VIEW_TYPE_STREAM_WORKBENCH } from "../constants";
import { AI_PROVIDER_PRESETS, PROVIDER_DEFAULT_MODELS } from "../constants";
import type { SuggestionCard } from "../types";
import { renderSuggestionCard } from "./suggestion-card";
import { hasConfiguredProvider } from "../types";
import { aiTaskManager, type TaskProgress, type AiTask } from "../services/ai-task-manager";
import { resolveProviderCatalog, applyModelOptions, credentialsForProvider } from "../services/models-dev";
import { bindImeEnterGuard, compactChatMessages, isImeEnter, resolveChatCompactBudget } from "../utils";
import { buildResultFooter } from "#kernel/agent-goal-protocol.mjs";

// ── Node.js built-ins (esbuild platform:'node' converts to require) ──
import fs from "node:fs";
import path from "node:path";

type SidebarTab = "todos" | "suggestions" | "chat" | "history";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Folded chain-of-thought (not the visible answer). */
  reasoning?: string;
  /** Whether this message was an error */
  isError?: boolean;
  /** Turn was paused (not abandoned) — keep goal ledger for Resume. */
  paused?: boolean;
  /** Hard stop / abandon. Distinct from paused. */
  cancelled?: boolean;
  stopReason?: "paused" | "cancelled";
  /** The user message that triggered this AI response (for regenerate) */
  prompt?: string;
  /** Agent tool timeline for continuous-work visibility. */
  toolCalls?: Array<{ tool: string; ok: boolean; summary?: string }>;
  steps?: number;
  autoContinues?: number;
  stepLimitHit?: boolean;
  /** Structured goal snapshot (Desktop goalSummary parity). */
  goal?: {
    goal?: string;
    plan?: string[];
    criteria?: string[];
    openCriteria?: string[];
    pathReceipts?: string[];
    status?: string;
    blockReason?: string | null;
    autoContinues?: number;
    checksRun?: string[];
    assumptions?: string[];
  } | null;
}


/** Runtime shape check for persisted goal payloads (no `as` on the return). */
function isGoalLike(v: unknown): v is NonNullable<ChatMessage["goal"]> {
  return !!v && typeof v === "object";
}

export class SidebarDockView extends ItemView {
  plugin: TopmindPlugin;
  private refreshTimer: number | null = null;
  private activeTab: SidebarTab = "chat";
  private chatHistory: ChatMessage[] = [];
  private chatThinking = false;
  /** True while a turn is paused waiting for Resume / redirect / abandon. */
  private chatPaused = false;
  /** Live agent progress line while a turn is working (step / tool / auto-continue). */
  private chatStatus = "";
  /** Turn start timestamp for elapsed progress. */
  private chatStartedAt = 0;
  /** Folded reasoning shown while the turn is still running. */
  private chatReasoningLive = "";
  /** Set by pause/stop; the in-flight turn checks it between steps. */
  private chatAbort: { aborted: boolean; pause?: boolean } | null = null;
  /** Set on user-initiated chat renders (tab open / send) — never on vault-event refreshes. */
  private chatFocusOnRender = false;
  /** Re-entrancy guard for suggestion generation (workbench parity). */
  private suggestionsInFlight = false;
  private contentContainer!: HTMLElement;
  private taskUnsub: (() => void) | null = null;
  /** Currently selected provider in chat model switcher */
  private chatProviderOverride = "";
  /** Currently selected model in chat model switcher */
  private chatModelOverride = "";
  /** Selected model context window (tokens) — drives compact budget (Desktop parity). */
  private chatContextLimit: number | undefined;
  /** Last resolved provider model catalog (for contextLimit lookup). */
  private chatModelCatalog: { id: string; contextLimit?: number }[] = [];
  /** Unsent chat draft preserved across full re-renders (settings refresh). */
  private pendingChatDraft = "";
  /** Markdown children for the current tab paint — unloaded before each rebuild. */
  private renderComp = new Component();

  constructor(leaf: WorkspaceLeaf, plugin: TopmindPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_SIDEBAR_DOCK;
  }

  getDisplayText(): string {
    return t("sidebar_dock_title");
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    await this.loadChatHistory();
    await this.render();
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path === "topmind.yaml") {
          this.plugin.kernelService.invalidateCache();
        }
        if (this.plugin.kernelService.isStreamRelevantPath(file.path) || file.path === "topmind.yaml") {
          this.scheduleContentRefresh(450);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.plugin.kernelService.isStreamRelevantPath(file.path)) {
          this.scheduleContentRefresh(450);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.plugin.kernelService.isStreamRelevantPath(file.path)) {
          this.scheduleContentRefresh(450);
        }
      }),
    );

    // Subscribe to AI task progress
    this.taskUnsub = aiTaskManager.subscribe((progress) => {
      // Only re-render if history tab is active
      if (this.activeTab === "history") {
        void this.renderActiveTab();
      }
      // badge only for other tabs — never re-render / reset tab selection
      // Update header task badge
      this.updateHeaderTaskBadge(progress);
    });
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.taskUnsub?.();
    this.renderComp.unload();
  }

  // ── Chat History Persistence ──────────────────────────────────────────

  /** Chat history file path: {vault}/.topmind/chat-history.json */
  private get chatHistoryPath(): string {
    return path.join(this.plugin.kernelService.getVaultPath(), ".topmind", "chat-history.json");
  }

  /** Session goal snapshot (Desktop .goal.json parity). */
  private get chatGoalPath(): string {
    return path.join(this.plugin.kernelService.getVaultPath(), ".topmind", "chat-goal.json");
  }

  private saveChatGoal(goal: ChatMessage["goal"] | null | undefined): void {
    try {
      const dir = path.dirname(this.chatGoalPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.chatGoalPath, JSON.stringify(goal || null, null, 2), "utf-8");
    } catch { /* non-fatal */ }
  }

  private loadChatGoal(): ChatMessage["goal"] | null {
    try {
      if (!fs.existsSync(this.chatGoalPath)) return null;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.chatGoalPath, "utf-8"));
      return isGoalLike(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Load persisted chat history from disk (best-effort, non-fatal). */
  private async loadChatHistory(): Promise<void> {
    try {
      const filePath = this.chatHistoryPath;
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const budget = resolveChatCompactBudget(this.chatContextLimit);
        this.chatHistory = compactChatMessages(parsed as ChatMessage[], {
          maxMessages: budget.maxMessages,
          keepRecent: budget.keepRecent,
        });
      }
    } catch {
      // Corrupt or missing file — start fresh
    }
  }

  /** Save chat history to disk (best-effort, non-fatal). */
  private saveChatHistory(): void {
    try {
      const filePath = this.chatHistoryPath;
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Session compact (Desktop parity) — scale with model context window.
      const budget = resolveChatCompactBudget(this.chatContextLimit);
      const toSave = compactChatMessages(this.chatHistory, {
        maxMessages: budget.maxMessages,
        keepRecent: budget.keepRecent,
      });
      fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), "utf-8");
    } catch {
      // Disk full / permissions — non-fatal
    }
  }

  private scheduleRefresh(delay: number): void {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => { void this.refreshActiveTab(); }, delay);
  }

  /**
   * Vault-edit refresh: content tabs only. Suggestions regenerate via the
   * explicit refresh button (kernel fingerprints guard the AI pass), and chat
   * must never re-render mid-typing — it would lose the draft input.
   */
  private scheduleContentRefresh(delay: number): void {
    if (this.activeTab === "chat" || this.activeTab === "suggestions") return;
    this.scheduleRefresh(delay);
  }

  /** Full re-render (header + tabs + content) */
  private async render(): Promise<void> {
    try {
      await this.renderInner();
    } catch (err) {
      console.error("[topmind] sidebar render failed:", err);
      this.contentEl.empty();
      this.contentEl.createDiv({
        cls: "tm-empty-state",
        text: `Topmind: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async renderInner(): Promise<void> {
    const { contentEl } = this;
    // Preserve unsent chat draft across settings-driven full re-renders.
    const existingInput = contentEl.querySelector<HTMLTextAreaElement>("textarea.tm-chat-input");
    if (existingInput && existingInput.value) {
      this.pendingChatDraft = existingInput.value;
    }
    contentEl.empty();
    contentEl.addClass("tm-sidebar-dock");

    if (!this.plugin.kernelService.isWorkspaceReady()) {
      this.renderWorkspaceInit(contentEl);
      return;
    }

    // ── Header ──
    this.renderHeader(contentEl);

    // ── Tab Bar ──
    this.renderTabBar(contentEl);

    // ── Tab Content ──
    this.contentContainer = contentEl.createDiv({ cls: "tm-tab-content" });
    await this.renderActiveTab();

    // ── Bottom Quick Actions ──
  }

  /** Refresh only the active tab content (lighter than full render) */
  private async refreshActiveTab(): Promise<void> {
    if (this.contentContainer) {
      const savedScroll = this.contentContainer.scrollTop;
      await this.renderActiveTab();
      if (savedScroll > 0) {
        this.contentContainer.scrollTop = savedScroll;
        window.requestAnimationFrame(() => {
          this.contentContainer.scrollTop = savedScroll;
        });
      }
    }
  }

  // ── Header ─────────────────────────────────────────────────────────────

  private renderHeader(container: HTMLElement): void {
    // Header is now minimal: task badge only. AI status + model live on the
    // chat input foot (with send), per IA — one control row, no header clutter.
    const header = container.createDiv({ cls: "tm-sidebar-header tm-sidebar-header-min" });
    const taskBadge = header.createDiv({ cls: "tm-task-badge tm-task-badge-hidden" });
    taskBadge.setAttribute("data-header-badge", "true");
  }

  /** Open plugin settings tab */
  private openSettings(): void {
    const setting = (this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting;
    setting?.open();
    setting?.openTabById("topmind-stream");
  }

  /** Run AI quick test and update the status indicator */
  private async runAiQuickTest(statusEl: HTMLElement): Promise<void> {
    const labelEl = statusEl.querySelector(".tm-status-label");
    const dotEl = statusEl.querySelector(".tm-status-dot");
    if (!labelEl || !dotEl) return;

    const originalText = labelEl.textContent;
    labelEl.textContent = t("ai_checking");
    dotEl.className = "tm-status-dot tm-dot-checking";

    const result = await this.plugin.kernelService.quickTestAi();
    if (result.ok) {
      labelEl.textContent = t("ai_test_ok");
      dotEl.className = "tm-status-dot tm-dot-ok";
    } else {
      labelEl.textContent = t("ai_test_fail");
      dotEl.className = "tm-status-dot tm-dot-error";
      new Notice(`${t("ai_test_fail")}: ${result.error || ""}`);
    }

    // Restore original after 3 seconds
    window.setTimeout(() => {
      labelEl.textContent = originalText;
      dotEl.className = `tm-status-dot ${result.ok ? "tm-dot-ok" : "tm-dot-off"}`;
    }, 3000);
  }

  /** Update header task badge from progress */
  private updateHeaderTaskBadge(progress: TaskProgress): void {
    const badge = this.contentEl.querySelector("[data-header-badge]");
    if (!badge) return;

    const el = badge as HTMLElement;
    if (progress.multiActive === 0) {
      el.addClass("tm-task-badge-hidden");
      el.empty();
      return;
    }

    el.removeClass("tm-task-badge-hidden");
    el.empty();

    const active = progress.active;
    if (active) {
      el.addClass("tm-task-badge-active");
      const label = el.createSpan({ cls: "tm-task-badge-label" });
      label.textContent = active.label;
      const dot = el.createSpan({ cls: "tm-task-badge-dot" });
      dot.setAttribute("aria-hidden", "true");
    } else if (progress.queued.length > 0) {
      el.createSpan({
        text: t("task_queued_count", { count: progress.queued.length }),
        cls: "tm-task-badge-label",
      });
    }
  }

  // ── Tab Bar ────────────────────────────────────────────────────────────

  private renderTabBar(container: HTMLElement): void {
    const tabBar = container.createDiv({ cls: "tm-tab-bar" });
    tabBar.setAttribute("role", "tablist");

    // 动态流的家是主区 Stream View，不进 AI Dock（能力单家 · 对齐 Desktop）
    // Order matches Desktop AI workspace: 对话 first (agent spine), then confirm faces.
    const tabs: { id: SidebarTab; label: string; icon: string }[] = [
      { id: "chat", label: t("sidebar_tab_chat"), icon: "bot" },
      { id: "suggestions", label: t("sidebar_tab_suggestions"), icon: "lightbulb" },
      { id: "todos", label: t("sidebar_tab_todos"), icon: "list-checks" },
      { id: "history", label: t("sidebar_tab_history"), icon: "activity" },
    ];

    for (const tab of tabs) {
      const isActive = this.activeTab === tab.id;
      const btn = tabBar.createEl("button", {
        cls: `tm-tab-btn ${isActive ? "tm-tab-active" : ""}`,
        attr: { "data-tab-id": tab.id },
      });
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(isActive));
      const iconSpan = btn.createSpan({ cls: "tm-tab-icon" });
      setIcon(iconSpan, tab.icon);
      btn.createSpan({ text: tab.label, cls: "tm-tab-label" });
      btn.setAttribute("aria-label", tab.label);
      btn.addEventListener("click", () => {
        // Update tab active states without full re-render
        this.activeTab = tab.id;
        if (tab.id === "chat") this.chatFocusOnRender = true;
        const allBtns = tabBar.querySelectorAll(".tm-tab-btn");
        allBtns.forEach((b) => {
          b.classList.remove("tm-tab-active");
          b.setAttribute("aria-selected", "false");
        });
        btn.classList.add("tm-tab-active");
        btn.setAttribute("aria-selected", "true");
        // Only re-render tab content, not the full view
        void this.renderActiveTab();
      });
    }
  }

  // ── Tab Content Dispatcher ─────────────────────────────────────────────

  private async renderActiveTab(): Promise<void> {
    try {
      await this.renderActiveTabInner();
    } catch (err) {
      console.error("[topmind] sidebar tab render failed:", err);
      if (this.contentContainer) {
        this.contentContainer.empty();
        this.contentContainer.createDiv({
          cls: "tm-empty-state",
          text: `Topmind: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  private async renderActiveTabInner(): Promise<void> {
    if (!this.contentContainer) return;
    // Preserve unsent chat draft when re-rendering the active tab (e.g. thinking indicator).
    const existingChatInput = this.contentContainer.querySelector<HTMLTextAreaElement>("textarea.tm-chat-input");
    if (existingChatInput && existingChatInput.value && !this.pendingChatDraft) {
      this.pendingChatDraft = existingChatInput.value;
    }
    // Drop previous MarkdownRenderer children before wiping the DOM — progress
    // ticks re-render the chat tab often, and those children attach to us.
    this.renderComp.unload();
    this.renderComp = new Component();
    this.renderComp.load();
    this.contentContainer.empty();

    switch (this.activeTab) {
      case "todos":
        this.renderTodosTab(this.contentContainer);
        break;
      case "suggestions":
        await this.renderSuggestionsTab(this.contentContainer);
        break;
      case "chat":
        this.renderChatTab(this.contentContainer);
        break;
      case "history":
        this.renderHistoryTab(this.contentContainer);
        break;
    }
  }

  // ── Todos Tab ──────────────────────────────────────────────────────────

  private renderTodosTab(container: HTMLElement): void {
    const todoSection = container.createDiv({ cls: "tm-sidebar-section" });

    // Todo action bar at top of todos tab
    const openFileBar = todoSection.createDiv({ cls: "tm-todo-open-file-bar" });

    if (hasConfiguredProvider(this.plugin.settings.ai)) {
      const aiMaintainBtn = openFileBar.createEl("button", {
        cls: "tm-btn-secondary tm-btn-sm",
      });
      setIcon(aiMaintainBtn, "sparkles");
      aiMaintainBtn.createSpan({ text: t("sidebar_op_todo") });
      aiMaintainBtn.setAttribute("aria-label", t("sidebar_op_todo"));
      aiMaintainBtn.setAttribute("title", t("sidebar_op_todo"));
      aiMaintainBtn.addEventListener("click", () => {
        void this.plugin.enqueueAiOperation("todo_maintain", "op_label_todo_maintain", "notice_todo_done", "sidebar", true);
      });
    }

    const openFileBtn = openFileBar.createEl("button", {
      cls: "tm-btn-ghost tm-btn-icon tm-btn-sm clickable-icon",
    });
    setIcon(openFileBtn, "file-text");
    openFileBtn.setAttribute("aria-label", t("todo_open_file"));
    openFileBtn.setAttribute("title", t("todo_open_file"));
    openFileBtn.addEventListener("click", () => {
      void this.app.workspace.openLinkText(this.plugin.kernelService.todoRelPath(), "", false);
    });

    const todos = this.plugin.kernelService.readTodos();
    const activeTodos = todos.filter((item) => !item.done);
    const doneTodos = todos.filter((item) => item.done);

    if (activeTodos.length === 0) {
      const empty = todoSection.createDiv({ cls: "tm-empty-state tm-empty-compact" });
      const icon = empty.createDiv({ cls: "tm-empty-icon" });
      setIcon(icon, "check-check");
      empty.createDiv({ text: t("sidebar_no_todos") });
    } else {
      for (const todo of activeTodos.slice(0, 20)) {
        const item = todoSection.createDiv({ cls: "tm-todo-item" });
        const checkbox = item.createEl("input", {
          attr: { type: "checkbox", "aria-label": todo.text },
          cls: "tm-todo-checkbox",
        });
        checkbox.addEventListener("change", () => {
          const toggled = this.plugin.kernelService.toggleTodo(todo.id);
          if (!toggled.ok) {
            checkbox.checked = !checkbox.checked;
            return;
          }
          if (checkbox.checked) {
            item.classList.add("tm-completed");
          }
        });
        item.createSpan({ cls: "tm-todo-text", text: todo.text });
        if (todo.sourcePeriod) {
          const srcBtn = item.createEl("button", {
            cls: "tm-todo-source",
            attr: { "aria-label": t("todo_open_source") },
          });
          setIcon(srcBtn, "external-link");
          srcBtn.createSpan({ text: ` ${todo.sourcePeriod}` });
          srcBtn.addEventListener("click", (e: MouseEvent) => {
            e.stopPropagation();
            // Prefer the live stream category from the workspace model; if the
            // role is missing, fall back to a bare-filename link (Obsidian
            // resolves it vault-wide) instead of a hardcoded "10-动态" path.
            const streamDir =
              this.plugin.kernelService.getResolvedModel()?.categories
                ?.find((c) => c.role === "loose-stream")?.directory;
            const link = streamDir
              ? `${streamDir}/${todo.sourcePeriod}.md`
              : `${todo.sourcePeriod}.md`;
            void this.app.workspace.openLinkText(link, "", false);
          });
        }
        if (todo.dueDate) {
          const dueSpan = item.createSpan({ cls: "tm-todo-due" });
          setIcon(dueSpan, "calendar");
          dueSpan.createSpan({ text: ` ${todo.dueDate}` });
        }
        // Hover delete button (shown on hover)
        const deleteBtn = item.createEl("button", {
          cls: "tm-todo-delete",
          attr: { "aria-label": t("todo_row_delete"), title: t("todo_row_delete") },
        });
        setIcon(deleteBtn, "trash-2");
        deleteBtn.addEventListener("click", (e: MouseEvent) => {
          e.stopPropagation();
          item.classList.add("tm-card-removing");
          window.setTimeout(() => {
            this.plugin.kernelService.deleteTodo(todo.id);
            void this.refreshActiveTab();
          }, 150);
        });
      }

      if (doneTodos.length > 0) {
        const doneHeader = todoSection.createDiv({ cls: "tm-todo-done-header" });
        const doneIcon = doneHeader.createSpan({ cls: "tm-todo-done-label" });
        setIcon(doneIcon, "check");
        doneIcon.createSpan({ text: ` ${doneTodos.length} ${t("sidebar_todos_done")}` });
        // Clear completed button
        const clearDoneBtn = doneHeader.createEl("button", {
          cls: "tm-btn-mini tm-todo-clear-done",
        });
        setIcon(clearDoneBtn, "trash-2");
        clearDoneBtn.setAttribute("aria-label", t("todo_clear_completed"));
        clearDoneBtn.setAttribute("title", t("todo_clear_completed"));
        clearDoneBtn.addEventListener("click", () => {
          for (const done of doneTodos) {
            this.plugin.kernelService.deleteTodo(done.id);
          }
          void this.refreshActiveTab();
        });
      }

      if (activeTodos.length > 20) {
        const viewAllBtn = todoSection.createEl("button", {
          cls: "tm-view-all",
          text: t("sidebar_view_all_todos"),
        });
        viewAllBtn.addEventListener("click", () => {
          void this.app.workspace.openLinkText(this.plugin.kernelService.todoRelPath(), "", false);
        });
      }
    }
  }

  // ── Suggestions Tab ────────────────────────────────────────────────────

  private renderPendingWrites(container: HTMLElement): number {
    const pending = this.plugin.kernelService.listPendingWrites();
    if (pending.length === 0) return 0;
    const section = container.createDiv({ cls: "tm-sidebar-section tm-pending-writes" });
    section.createDiv({ cls: "tm-suggestion-summary", text: t("pending_writes_title") });
    for (const item of pending) {
      const card = section.createDiv({ cls: "tm-suggestion-card tm-pending-write-card" });
      card.createDiv({ cls: "tm-suggestion-title", text: item.relativePath });
      const actions = card.createDiv({ cls: "tm-suggestion-actions" });
      // Confirm must not be blind: the stashed content is inspectable in place.
      const preview = actions.createEl("button", {
        cls: "tm-btn-secondary tm-btn-sm",
        text: t("pending_writes_preview"),
      });
      preview.setAttribute("aria-label", t("pending_writes_preview"));
      preview.setAttribute("aria-expanded", "false");
      let previewBox: HTMLElement | null = null;
      preview.addEventListener("click", () => {
        if (previewBox) {
          previewBox.remove();
          previewBox = null;
          preview.setText(t("pending_writes_preview"));
          preview.setAttribute("aria-expanded", "false");
          return;
        }
        previewBox = card.createDiv({ cls: "tm-pending-preview" });
        const meta = previewBox.createDiv({ cls: "tm-pending-preview-meta" });
        meta.setText(
          t("pending_writes_preview_meta", { chars: item.content.length }),
        );
        previewBox.createEl("pre", { text: item.content });
        preview.setText(t("pending_writes_hide_preview"));
        preview.setAttribute("aria-expanded", "true");
      });
      const accept = actions.createEl("button", {
        cls: "tm-btn-primary tm-btn-sm",
        text: t("pending_writes_accept"),
      });
      accept.setAttribute("aria-label", t("pending_writes_accept"));
      accept.addEventListener("click", () => {
        this.plugin.kernelService.acceptPendingWrite(item.id);
        void this.renderSuggestionsTab(container);
      });
      const reject = actions.createEl("button", {
        cls: "tm-btn-secondary tm-btn-sm",
        text: t("pending_writes_reject"),
      });
      reject.setAttribute("aria-label", t("pending_writes_reject"));
      reject.addEventListener("click", () => {
        this.plugin.kernelService.rejectPendingWrite(item.id);
        void this.renderSuggestionsTab(container);
      });
    }
    return pending.length;
  }

  private paintSuggestionCards(container: HTMLElement, suggestions: SuggestionCard[]): void {
    if (suggestions.length === 0) return;
    const summaryEl = container.createDiv({ cls: "tm-suggestion-summary" });
    summaryEl.createSpan({
      text: t("sidebar_suggestions_count", { count: suggestions.length }),
      cls: "tm-suggestion-count-badge",
    });
    for (const sugg of suggestions) {
      this.renderSuggestionCard(container, sugg);
    }
  }

  private async renderSuggestionsTab(container: HTMLElement, opts: { force?: boolean } = {}): Promise<void> {
    const force = opts.force === true;
    container.empty();
    const pendingCount = this.renderPendingWrites(container);
    const aiConfigured = hasConfiguredProvider(this.plugin.settings.ai);
    if (!aiConfigured) {
      if (pendingCount === 0) {
        this.renderEmptyState(container, t("suggestions_no_ai"), t("suggestions_no_ai_hint"), "lightbulb");
      }
      return;
    }

    this.renderSuggestionRefreshButton(container);

    const cached = this.plugin.kernelService.peekSuggestions();
    if (!force && cached.length > 0) {
      this.paintSuggestionCards(container, cached);
      if (this.plugin.settings.autoSuggest && !this.suggestionsInFlight) {
        void this.softRefreshSuggestions(container);
      }
      return;
    }

    if (this.suggestionsInFlight) {
      const progressEl = container.createDiv({ cls: "tm-task-progress-inline" });
      progressEl.createSpan({ text: t("suggestions_loading") });
      return;
    }

    const loadingEl = container.createDiv({ cls: "tm-task-progress-inline" });
    loadingEl.createSpan({ text: t("suggestions_loading") });

    this.suggestionsInFlight = true;
    try {
      const suggestions = await this.plugin.kernelService.generateSuggestions({ force });
      container.empty();
      const pendingAfter = this.renderPendingWrites(container);
      this.renderSuggestionRefreshButton(container);
      if (suggestions.length === 0) {
        if (pendingAfter === 0) {
          const emptyTitle = this.plugin.settings.autoSuggest
            ? t("sidebar_no_suggestions")
            : t("suggestions_disabled");
          const emptyHint = this.plugin.settings.autoSuggest
            ? t("suggestions_empty_hint")
            : t("suggestions_disabled_hint");
          this.renderEmptyState(container, emptyTitle, emptyHint, "lightbulb", this.plugin.settings.autoSuggest
            ? { label: t("sidebar_op_suggestions"), onClick: () => { void this.renderSuggestionsTab(container, { force: true }); } }
            : undefined);
        }
        return;
      }
      this.paintSuggestionCards(container, suggestions);
    } catch (err) {
      container.empty();
      this.renderEmptyState(
        container,
        t("error"),
        err instanceof Error ? err.message : String(err),
        "alert-circle",
      );
    } finally {
      this.suggestionsInFlight = false;
    }
  }

  /** Background regenerate — keep cached cards on screen. */
  private async softRefreshSuggestions(container: HTMLElement): Promise<void> {
    if (this.suggestionsInFlight) return;
    this.suggestionsInFlight = true;
    try {
      const suggestions = await this.plugin.kernelService.generateSuggestions({ force: false });
      if (this.activeTab !== "suggestions") return;
      container.empty();
      this.renderPendingWrites(container);
      this.renderSuggestionRefreshButton(container);
      this.paintSuggestionCards(container, suggestions);
    } finally {
      this.suggestionsInFlight = false;
    }
  }

  private async acceptAllSuggestions(): Promise<void> {
    const cards = this.plugin.kernelService.peekSuggestions();
    if (cards.length === 0) return;
    const n = new Notice(
      t("notice_executing_progress", { current: 0, total: cards.length, title: cards[0]?.title || "" }),
      0,
    );
    let ok = 0;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      n.setMessage(t("notice_executing_progress", {
        current: i + 1,
        total: cards.length,
        title: card.title,
      }));
      const result = await this.plugin.kernelService.applySuggestion(card, { silent: true });
      if (result.ok) ok += 1;
    }
    n.hide();
    new Notice(t("notice_accept_all_done", { count: ok }));
    await this.refreshActiveTab();
  }

  /** Action bar at top of suggestions tab: reconcile period + AI operations + force-refresh. */
  private renderSuggestionRefreshButton(container: HTMLElement): void {
    const refreshBar = container.createDiv({ cls: "tm-suggestion-refresh-bar" });

    // 1. Organize period button — sort glyph (整理)
    const organizeBtn = refreshBar.createEl("button", {
      cls: "tm-btn-secondary tm-btn-sm",
    });
    setIcon(organizeBtn, "arrow-down-wide-narrow");
    organizeBtn.createSpan({ text: t("stream_organize") });
    organizeBtn.setAttribute("aria-label", t("stream_organize"));
    organizeBtn.setAttribute("title", t("stream_organize"));
    organizeBtn.addEventListener("click", () => { void (async () => {
      new Notice(t("notice_organizing"));
      const streamCtx = await this.plugin.kernelService.getStreamContext();
      if (streamCtx.current) {
        this.plugin.kernelService.reconcilePeriod(streamCtx.current.relPath);
      }
      const aiQueued = this.plugin.settings.autoMaintainTodos
        && hasConfiguredProvider(this.plugin.settings.ai);
      if (aiQueued) {
        void this.plugin.enqueueAiOperation("todo_maintain", "op_label_todo_maintain", "notice_todo_done", "sidebar", true);
      } else {
        new Notice(t("notice_organize_done"));
      }
      void this.refreshActiveTab();
    })(); });

    // 2. AI operations dropdown button (if AI configured)
    if (hasConfiguredProvider(this.plugin.settings.ai)) {
      const aiOpsBtn = refreshBar.createEl("button", {
        cls: "tm-btn-ghost tm-btn-icon tm-btn-sm clickable-icon",
      });
      setIcon(aiOpsBtn, "sparkles");
      aiOpsBtn.setAttribute("aria-label", t("sidebar_op_menu"));
      aiOpsBtn.setAttribute("title", t("sidebar_op_menu"));
      aiOpsBtn.addEventListener("click", (evt: MouseEvent) => {
        const menu = new Menu();
        menu.addItem((item) => {
          item.setTitle(t("sidebar_op_memory"))
            .setIcon("user")
            .onClick(() => {
              void this.plugin.enqueueAiOperation("memory_organize", "op_label_memory_organize", "notice_memory_done", "all");
            });
        });
        menu.addItem((item) => {
          item.setTitle(t("sidebar_op_classify"))
            .setIcon("tag")
            .onClick(() => {
              void this.plugin.enqueueAiOperation("topic_classify", "op_label_topic_classify", "notice_classify_done", "suggest");
            });
        });
        menu.showAtMouseEvent(evt);
      });
    }

    const acceptAllBtn = refreshBar.createEl("button", {
      cls: "tm-btn-secondary tm-btn-sm",
    });
    setIcon(acceptAllBtn, "check");
    acceptAllBtn.createSpan({ text: t("suggestions_accept_all") });
    acceptAllBtn.setAttribute("aria-label", t("suggestions_accept_all"));
    acceptAllBtn.setAttribute("title", t("suggestions_accept_all"));
    acceptAllBtn.addEventListener("click", () => { void this.acceptAllSuggestions(); });

    // 3. Force-refresh button
    const refreshBtn = refreshBar.createEl("button", {
      cls: "tm-btn-ghost tm-btn-icon tm-btn-sm clickable-icon",
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.setAttribute("aria-label", t("cmd_refresh_suggestions"));
    refreshBtn.setAttribute("title", t("cmd_refresh_suggestions"));
    refreshBtn.addEventListener("click", () => { void (async () => {
      refreshBtn.disabled = true;
      await this.renderSuggestionsTab(container, { force: true });
    })(); });
  }

  private renderSuggestionCard(container: HTMLElement, sugg: SuggestionCard): void {
    // Shared card surface — 动作词汇与 Desktop 对齐（见 views/suggestion-card.ts）
    renderSuggestionCard(container, sugg, {
      apply: (s) => this.plugin.kernelService.applySuggestion(s),
      dismiss: (s) => this.plugin.kernelService.dropSuggestion(s.id),
      refresh: () => this.refreshActiveTab(),
      openVaultPath: async (p) => {
        await this.app.workspace.openLinkText(p, "", false);
      },
    });
  }

  // ── Chat Tab ───────────────────────────────────────────────────────────

  private renderChatTab(container: HTMLElement): void {
    const aiConfigured = hasConfiguredProvider(this.plugin.settings.ai);
    if (!aiConfigured) {
      this.renderEmptyState(container, t("chat_no_ai"), t("chat_no_ai_hint"), "message-circle");
      // Add actionable configure button
      const actionDiv = container.createDiv({ cls: "tm-empty-action" });
      const configureBtn = actionDiv.createEl("button", {
        cls: "tm-btn-init-workspace mod-cta",
        text: t("empty_action_configure"),
      });
      configureBtn.addEventListener("click", () => this.openSettings());
      return;
    }

    container.addClass("tm-chat-container");

    // ── Model switcher bar ──
    // ── Context bar (UI/UX 2.0 §31): make the workspace context explicit ──
    void this.renderChatContextBar(container);

    // Chat messages area
    const messagesEl = container.createDiv({ cls: "tm-chat-messages" });

    if (this.chatHistory.length === 0) {
      const emptyDiv = messagesEl.createDiv({ cls: "tm-chat-empty" });
      const chatIcon = emptyDiv.createDiv({ cls: "tm-chat-empty-icon" });
      setIcon(chatIcon, "bot");
      emptyDiv.createDiv({ text: t("chat_empty"), cls: "tm-chat-empty-title" });
      emptyDiv.createDiv({ text: t("chat_empty_hint"), cls: "tm-chat-empty-hint" });
      // Starter prompts — click fills the composer (Quiet UI: one clear next step).
      const starters = emptyDiv.createDiv({ cls: "tm-chat-starters" });
      for (const prompt of [
        t("chat_starter_digest"),
        t("chat_starter_todos"),
        t("chat_starter_profile"),
      ]) {
        const chip = starters.createEl("button", {
          text: prompt,
          cls: "tm-chat-starter-chip",
          attr: { type: "button" },
        });
        chip.addEventListener("click", () => {
          const input = container.querySelector<HTMLTextAreaElement>("textarea.tm-chat-input");
          if (input) {
            input.value = prompt;
            input.focus();
            input.dispatchEvent(new Event("input"));
          }
        });
      }
    } else {
      for (const msg of this.chatHistory) {
        this.renderChatMessage(messagesEl, msg);
      }
      // Scroll to bottom
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // Thinking / agent-working indicator
    if (this.chatThinking) {
      const thinkingEl = messagesEl.createDiv({ cls: "tm-chat-message tm-chat-ai tm-chat-thinking" });
      thinkingEl.setAttribute("role", "status");
      thinkingEl.setAttribute("aria-live", "polite");
      thinkingEl.createSpan({ cls: "tm-chat-role", text: t("chat_ai") });
      thinkingEl.createDiv({ cls: "tm-loading-spinner tm-loading-spinner-sm" });
      thinkingEl.createSpan({
        cls: "tm-chat-thinking-dots",
        text: this.chatStatus || t("chat_thinking"),
        attr: { "data-chat-status": "true" },
      });
      if (this.chatReasoningLive.trim()) {
        // Progressive disclosure (UI/UX 2.0 §38): thinking/trace stays folded.
        const fold = thinkingEl.createEl("details", { cls: "tm-chat-reasoning" });
        const summary = fold.createEl("summary", { cls: "tm-chat-reasoning-summary" });
        summary.setAttribute("title", t("chat_reasoning_show"));
        const reasonIcon = summary.createSpan({ cls: "tm-chat-reasoning-icon" });
        setIcon(reasonIcon, "file-text");
        summary.createSpan({ cls: "tm-chat-reasoning-label", text: t("chat_reasoning") });
        summary.createSpan({
          cls: "tm-chat-reasoning-meta",
          text: t("chat_reasoning_chars", { count: this.chatReasoningLive.trim().length }),
          attr: { "data-chat-reasoning-meta": "true" },
        });
        const pre = fold.createEl("pre", {
          cls: "tm-chat-reasoning-body tm-chat-reasoning-live",
          attr: { "data-chat-reasoning-live": "true" },
        });
        pre.setText(this.chatReasoningLive);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // Chat input area — input on top, foot row below (send/clear right).
    const inputArea = container.createDiv({ cls: "tm-chat-input-area" });
    const input = inputArea.createEl("textarea", {
      cls: "tm-chat-input",
      attr: {
        placeholder: t("chat_placeholder"),
        rows: "2",
        "aria-label": t("chat_title"),
      },
    });
    if (this.pendingChatDraft) {
      input.value = this.pendingChatDraft;
      this.pendingChatDraft = "";
      input.setCssStyles({ height: "auto" });
      input.setCssStyles({ height: `${Math.min(input.scrollHeight, 100)}px` });
    }

    const inputFoot = inputArea.createDiv({ cls: "tm-chat-input-foot" });

    // Left: status dot (no words) + provider/model
    const footLeft = inputFoot.createDiv({ cls: "tm-footer-left" });
    this.renderFooterStatus(footLeft);
    this.renderHeaderModelChip(footLeft);

    // Right: new chat · send
    const footRight = inputFoot.createDiv({ cls: "tm-footer-right" });
    const newChatBtn = footRight.createEl("button", {
      cls: "tm-chat-clear-btn clickable-icon",
      attr: { "aria-label": t("chat_new_chat"), title: t("chat_new_chat") },
    });
    setIcon(newChatBtn, "message-square-plus");
    newChatBtn.addEventListener("click", () => {
      this.chatHistory = [];
      this.saveChatHistory();
      void this.renderActiveTab();
    });

    const sendBtn = footRight.createEl("button", {
      cls: "tm-btn-primary tm-btn-icon mod-cta",
      attr: { "aria-label": t("chat_send"), title: t("chat_send") },
    });
    setIcon(sendBtn, "send");

    // Auto-grow textarea
    input.addEventListener("input", () => {
      input.setCssStyles({ height: "auto" });
      input.setCssStyles({ height: `${Math.min(input.scrollHeight, 100)}px` });
    });

    // Enter to send, Shift+Enter for newline. IME confirm must not send.
    // Esc while thinking → PAUSE (Desktop parity: interrupt, not abandon).
    const chatIme = bindImeEnterGuard(input);
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.chatThinking) {
        e.preventDefault();
        this.pauseChat();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        if (isImeEnter(e, chatIme)) return;
        e.preventDefault();
        if (this.chatThinking) return;
        if (this.chatPaused) {
          void this.resumeChat(input);
          return;
        }
        void this.sendChatMessage(input);
      }
    });

    if (this.chatThinking) {
      // Pause is an interrupt, not the destructive/error treatment.
      sendBtn.classList.remove("tm-btn-primary");
      sendBtn.classList.add("tm-btn-secondary");
      setIcon(sendBtn, "square");
      sendBtn.setAttribute("aria-label", t("chat_pause"));
      sendBtn.setAttribute("title", t("chat_pause"));
      sendBtn.addEventListener("click", () => this.pauseChat());
    } else if (this.chatPaused) {
      setIcon(sendBtn, "play");
      sendBtn.setAttribute("aria-label", t("chat_resume"));
      sendBtn.setAttribute("title", t("chat_resume"));
      sendBtn.addEventListener("click", () => void this.resumeChat(input));
    } else {
      sendBtn.addEventListener("click", () => { void this.sendChatMessage(input); });
    }

    // Focus only on user-initiated renders — vault-event refreshes must not
    // steal focus from the editor while the user is typing elsewhere.
    if (this.chatFocusOnRender) {
      this.chatFocusOnRender = false;
      window.setTimeout(() => input.focus(), 50);
    }
  }

  /** Quiet context strip — what the agent can see right now (UI/UX 2.0 §31). */
  private async renderChatContextBar(container: HTMLElement): Promise<void> {
    const bar = container.createDiv({ cls: "tm-chat-context-bar", attr: { role: "status" } });
    bar.createSpan({ text: t("chat_context_label"), cls: "tm-chat-context-label" });

    const sources: string[] = [];
    try {
      const ctx = await this.plugin.kernelService.getStreamContext();
      if (ctx.current) {
        const { entries } = await this.plugin.kernelService.readPeriodNoteAsync(ctx.current.relPath);
        if (entries.length > 0) {
          sources.push(t("chat_context_stream"));
        }
      }
    } catch {
      /* stream unavailable */
    }
    try {
      const active = this.plugin.kernelService.readTodos().filter((todo) => !todo.done);
      if (active.length > 0) {
        sources.push(t("chat_context_todos"));
      }
    } catch {
      /* todos unavailable */
    }
    try {
      const health = this.plugin.kernelService.profileHealth?.();
      if (health && (health.activeCount || 0) > 0) {
        sources.push(t("chat_context_profile"));
      }
    } catch {
      /* profile unavailable */
    }

    if (sources.length === 0) {
      bar.createSpan({ text: t("chat_context_empty"), cls: "tm-chat-context-empty" });
      return;
    }
    for (const label of sources) {
      bar.createSpan({ text: label, cls: "tm-chip tm-chat-context-chip" });
    }
  }

  /** Status dot only (no label). Click = quick test / settings. */
  private renderFooterStatus(container: HTMLElement): void {
    const aiReady = hasConfiguredProvider(this.plugin.settings.ai);
    const statusDiv = container.createDiv({ cls: "tm-footer-status" });
    statusDiv.setAttribute("role", "button");
    statusDiv.setAttribute("tabindex", "0");
    statusDiv.setAttribute("aria-label", aiReady ? t("sidebar_ai_ready") : t("sidebar_ai_off"));
    statusDiv.setAttribute("title", (aiReady ? t("settings_ai_quick_test") : t("chat_configure_ai")) + " · build 2026-09-28b");
    const dot = statusDiv.createSpan({ cls: `tm-status-dot ${aiReady ? "tm-dot-ok" : "tm-dot-off"}` });
    dot.setAttribute("aria-hidden", "true");
    statusDiv.addEventListener("click", () => {
      if (aiReady) void this.runAiQuickTest(statusDiv);
      else this.openSettings();
    });
    statusDiv.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        statusDiv.click();
      }
    });
  }

  /** Compact provider·model control in the dock header (one row, no extra chrome). */
  private renderHeaderModelChip(container: HTMLElement): void {
    const providers = this.plugin.kernelService.getConfiguredProviders();
    const activeProvider =
      this.chatProviderOverride || this.plugin.settings.ai.sourcePreference || providers[0]?.id || "";
    const wrap = container.createDiv({ cls: "tm-header-model" });
    wrap.setAttribute("title", t("chat_model_select"));

    const preset = AI_PROVIDER_PRESETS[activeProvider];
    // Model only — provider is implied by the model list (less chrome).
    const modelSelect = wrap.createEl("select", {
      cls: "tm-header-model-select tm-header-model-model",
      attr: { "aria-label": t("chat_model_select") },
    });

    modelSelect.createEl("option", { value: "", text: t("settings_ai_model_default") });
    if (preset?.model) {
      modelSelect.createEl("option", { value: preset.model, text: preset.model });
    }
    for (const m of PROVIDER_DEFAULT_MODELS[activeProvider] || []) {
      if (m.id !== preset?.model) modelSelect.createEl("option", { value: m.id, text: m.label });
    }
    const currentModel = this.chatModelOverride || this.plugin.settings.ai.defaultModel || "";
    if (currentModel && !Array.from(modelSelect.options).some((o) => o.value === currentModel)) {
      modelSelect.createEl("option", { value: currentModel, text: currentModel });
    }
    modelSelect.value = currentModel;
    modelSelect.addEventListener("change", () => { void (async () => {
      this.chatModelOverride = modelSelect.value;
      this.plugin.settings.ai.defaultModel = modelSelect.value;
      this.plugin.settings.aiModel = modelSelect.value;
      const entry = (this.chatModelCatalog || []).find((m) => m.id === modelSelect.value);
      this.chatContextLimit = entry?.contextLimit;
      await this.plugin.saveSettings();
    })(); });
    void this.loadChatModels(activeProvider, modelSelect, currentModel);
  }


  /** Resolve official + community + curated and update the chat model select. */
  private async loadChatModels(providerId: string, selectEl: HTMLSelectElement, currentValue: string): Promise<void> {
    try {
      const creds = credentialsForProvider(providerId, this.plugin.settings.ai.manual);
      const result = await resolveProviderCatalog(providerId, creds);
      this.chatModelCatalog = result.models || [];
      const preset = AI_PROVIDER_PRESETS[providerId];
      applyModelOptions(selectEl, result.models, {
        currentValue,
        presetModel: preset?.model || null,
        defaultLabel: t("settings_ai_model_default"),
      });
      const entry = (result.models || []).find((m) => m.id === (currentValue || selectEl.value));
      this.chatContextLimit = entry?.contextLimit;
    } catch {
      // Network failed — curated options already on screen
    }
  }

  private renderChatMessage(container: HTMLElement, msg: ChatMessage): void {
    const msgEl = container.createDiv({
      cls: `tm-chat-message ${msg.role === "user" ? "tm-chat-user" : "tm-chat-ai"}${msg.isError ? " tm-chat-error-msg" : ""}`,
    });
    msgEl.createSpan({ cls: "tm-chat-role", text: msg.role === "user" ? t("chat_you") : t("chat_ai") });

    if (msg.role === "assistant" && !msg.isError && msg.reasoning?.trim()) {
      const fold = msgEl.createEl("details", { cls: "tm-chat-reasoning" });
      const summary = fold.createEl("summary", { cls: "tm-chat-reasoning-summary" });
      summary.setAttribute("title", t("chat_reasoning_show"));
      const reasonIcon = summary.createSpan({ cls: "tm-chat-reasoning-icon" });
      setIcon(reasonIcon, "file-text");
      summary.createSpan({ cls: "tm-chat-reasoning-label", text: t("chat_reasoning") });
      summary.createSpan({
        cls: "tm-chat-reasoning-meta",
        text: t("chat_reasoning_chars", { count: msg.reasoning.trim().length }),
      });
      const pre = fold.createEl("pre", { cls: "tm-chat-reasoning-body" });
      pre.setText(msg.reasoning);
    }
    if (msg.role === "assistant" && !msg.isError && (msg.toolCalls?.length || msg.steps)) {
      const toolsEl = msgEl.createDiv({ cls: "tm-chat-tools" });
      const count = msg.toolCalls?.filter((tc) => tc.ok).length ?? 0;
      const allTools = msg.toolCalls || [];
      // Progressive disclosure (UI/UX 2.0 §38): tool telemetry stays folded.
      // Hide the fold entirely when there is nothing to inspect (0 steps).
      if (allTools.length > 0) {
        const toolFold = toolsEl.createEl("details", { cls: "tm-chat-reasoning tm-chat-tools-fold" });
        const toolSummary = toolFold.createEl("summary", { cls: "tm-chat-reasoning-summary" });
        const toolIcon = toolSummary.createSpan({ cls: "tm-chat-reasoning-icon" });
        setIcon(toolIcon, "wrench");
        toolSummary.createSpan({
          cls: "tm-chat-reasoning-label",
          text: t("chat_tool_steps", { count }),
        });
        const toolRow = toolFold.createDiv({ cls: "tm-chat-tools" });
        const shown = allTools.slice(0, 12);
        for (const tc of shown) {
          const rel = String(tc.summary || "").trim();
          const isPath = tc.ok && rel && /\.(?:md|txt|json|ya?ml|csv|png|jpe?g|webp)$/i.test(rel) && !rel.includes("\n");
          const label = isPath
            ? (rel.length > 36 ? `…${rel.slice(-35)}` : rel)
            : tc.tool;
          const chip = toolRow.createEl("button", {
            cls: `tm-chat-tool-chip${tc.ok ? "" : " tm-chat-tool-chip-fail"}`,
            text: label,
            attr: { type: "button", title: isPath ? `${tc.tool} · ${rel}` : tc.summary || tc.tool },
          });
          if (isPath) {
            chip.addEventListener("click", (e: MouseEvent) => {
              e.stopPropagation();
              void this.app.workspace.openLinkText(rel, "", false);
            });
          } else {
            chip.setAttr("disabled", "true");
            chip.addClass("tm-chat-tool-chip-static");
          }
        }
        if (allTools.length > shown.length) {
          toolRow.createSpan({
            cls: "tm-chat-tools-label",
            text: `+${allTools.length - shown.length}`,
            attr: { title: t("chat_tool_steps", { count: allTools.length }) },
          });
        }
      }
      if (msg.stepLimitHit || (msg.autoContinues || 0) > 0) {
        toolsEl.createSpan({
          cls: "tm-chat-tools-limit",
          text: t("chat_auto_continue", { count: msg.autoContinues || 1 }),
        });
      }
      // Structured goal chip (Desktop Run Card parity). Never claim done from a [DONE] regex.
      const goal = msg.goal;
      if (goal) {
        const open = (goal.openCriteria || []).length;
        const total = (goal.criteria || []).length || (goal.plan || []).length;
        const done = (goal.criteria || []).length
          ? Math.max(0, (goal.criteria || []).length - open)
          : 0;
        const plan = goal.plan || [];
        const criteria = goal.criteria || [];
        const openSet = new Set(goal.openCriteria || []);
        if (total > 0) {
          const ledgerBtn = toolsEl.createEl("button", {
            cls: "tm-chat-tool-chip",
            text: t("chat_goal_plan", { done, total }),
            attr: {
              type: "button",
              "aria-expanded": "false",
              title: t("chat_goal_plan", { done, total }),
            },
          });
          const ledger = msgEl.createDiv({ cls: "tm-goal-ledger" });
          if (plan.length) {
            const ol = ledger.createEl("ol", { cls: "tm-goal-plan-list" });
            plan.forEach((step, i) => {
              const li = ol.createEl("li", { cls: "tm-goal-plan-item" });
              li.createSpan({ cls: "tm-goal-plan-num", text: String(i + 1) });
              li.createSpan({ text: step });
            });
          }
          if (criteria.length) {
            const ul = ledger.createEl("ul", { cls: "tm-goal-criteria-list" });
            criteria.forEach((c) => {
              const isDone = !openSet.has(c);
              const li = ul.createEl("li", {
                cls: `tm-goal-criterion${isDone ? " tm-goal-criterion-done" : ""}`,
              });
              li.createSpan({ text: isDone ? "✓" : "○", attr: { "aria-hidden": "true" } });
              li.createSpan({ text: c });
            });
          }
          ledgerBtn.addEventListener("click", (e: MouseEvent) => {
            e.stopPropagation();
            const showing = ledger.hasClass("tm-goal-ledger-open");
            ledger.toggleClass("tm-goal-ledger-open", !showing);
            ledgerBtn.setAttribute("aria-expanded", showing ? "false" : "true");
          });
        }
        if (open > 0) {
          toolsEl.createSpan({
            cls: "tm-chat-tools-limit",
            text: t("chat_goal_open_criteria", { count: open }),
          });
        }
        if (goal.status === "blocked") {
          toolsEl.createSpan({
            cls: "tm-chat-incomplete",
            text: t("chat_goal_blocked"),
            attr: { title: goal.blockReason || t("chat_incomplete_hint") },
          });
        } else if (goal.status === "incomplete" || (goal.status !== "done" && open > 0)) {
          toolsEl.createSpan({
            cls: "tm-chat-incomplete",
            text: t("chat_incomplete"),
            attr: { title: t("chat_incomplete_hint") },
          });
        } else if (goal.status === "done") {
          toolsEl.createSpan({
            cls: "tm-chat-goal-done",
            text: t("chat_goal_done"),
          });
        }
      }
    }

    const bodyEl = msgEl.createDiv({ cls: "tm-chat-body" });

    if (msg.role === "assistant" && !msg.isError) {
      // Render markdown for AI responses (answer only)
      void MarkdownRenderer.render(this.app, msg.content, bodyEl, "", this.renderComp);
      // Add action buttons for AI messages (icon-only with tooltips)
      const actionsEl = msgEl.createDiv({ cls: "tm-chat-msg-actions" });

      // Copy button
      const copyBtn = actionsEl.createEl("button", { cls: "tm-chat-msg-btn clickable-icon" });
      setIcon(copyBtn, "copy");
      copyBtn.setAttribute("aria-label", t("chat_copy"));
      copyBtn.setAttribute("title", t("chat_copy"));
      copyBtn.addEventListener("click", () => {
        void navigator.clipboard.writeText(msg.content).then(() => {
          copyBtn.addClass("tm-copied");
          window.setTimeout(() => copyBtn.removeClass("tm-copied"), 1500);
        }).catch(() => {
          new Notice(t("error"));
        });
      });

      // Regenerate button (only if there's a prompt)
      if (msg.prompt) {
        const regenBtn = actionsEl.createEl("button", { cls: "tm-chat-msg-btn clickable-icon" });
        setIcon(regenBtn, "refresh-cw");
        regenBtn.setAttribute("aria-label", t("chat_regenerate"));
        regenBtn.setAttribute("title", t("chat_regenerate"));
        regenBtn.addEventListener("click", () => {
          // Remove this message and regenerate
          const idx = this.chatHistory.lastIndexOf(msg);
          if (idx >= 0) {
            this.chatHistory.splice(idx, 1);
            void this.regenerateResponse(msg.prompt!);
          }
        });
      }
    } else if (msg.role === "assistant" && msg.isError) {
      // Error message with retry button
      bodyEl.textContent = msg.content;
      const actionsEl = msgEl.createDiv({ cls: "tm-chat-msg-actions" });
      if (msg.prompt) {
        const retryBtn = actionsEl.createEl("button", { cls: "tm-chat-msg-btn tm-chat-retry-btn" });
        setIcon(retryBtn, "refresh-cw");
        retryBtn.setAttribute("aria-label", t("chat_retry"));
        retryBtn.setAttribute("title", t("chat_retry"));
        retryBtn.addEventListener("click", () => {
          const idx = this.chatHistory.lastIndexOf(msg);
          if (idx >= 0) {
            this.chatHistory.splice(idx, 1);
            void this.regenerateResponse(msg.prompt!);
          }
        });
      }
    } else {
      bodyEl.textContent = msg.content;
    }

    // Terminal agent result footer (Desktop honesty parity). Renders only when a
    // real goal snapshot is present — never invented check evidence.
    if (msg.role === "assistant" && !msg.isError && msg.goal) {
      this.renderResultFooter(msgEl, msg);
    }
  }

  /**
   * Result footer: Changes (path footprint) + Verified / Assumed / Could not.
   * Segments come from the shared protocol helper. Empty segments say none.
   * Path receipts are never labeled Verified.
   */
  private renderResultFooter(msgEl: HTMLElement, msg: ChatMessage): void {
    const goal = msg.goal;
    const model = buildResultFooter(goal);
    if (!goal || !model) return;

    const okTools = (msg.toolCalls || []).filter((tc) => tc.ok).length;
    const footer = msgEl.createDiv({ cls: "tm-goal-footer" });
    footer.createDiv({
      cls: "tm-goal-footer-summary",
      text: t("chat_result_summary", { done: okTools, writes: model.changes.length }),
    });

    const row = (labelKey: "chat_result_changes" | "chat_result_verified" | "chat_result_assumed" | "chat_result_could_not") => {
      const r = footer.createDiv({ cls: "tm-goal-footer-row" });
      r.createSpan({ cls: "tm-goal-footer-label", text: t(labelKey) });
      return r.createDiv({ cls: "tm-goal-footer-vals" });
    };

    const fill = (el: HTMLElement, items: string[], asPath = false) => {
      if (!items.length) {
        el.createSpan({ cls: "tm-goal-footer-none", text: t("chat_result_none") });
        return;
      }
      for (const item of items.slice(0, 8)) {
        if (asPath) {
          const chip = el.createEl("button", {
            cls: "tm-goal-footer-chip",
            text: item.length > 36 ? `…${item.slice(-35)}` : item,
            attr: { type: "button", title: item },
          });
          chip.addEventListener("click", (e: MouseEvent) => {
            e.stopPropagation();
            void this.app.workspace.openLinkText(item, "", false);
          });
        } else {
          el.createSpan({ cls: "tm-goal-footer-item", text: item });
        }
      }
    };

    fill(row("chat_result_changes"), model.changes, true);
    fill(row("chat_result_verified"), model.verified);
    fill(row("chat_result_assumed"), model.assumed);
    fill(row("chat_result_could_not"), model.couldNot);
  }

  private stopChat(): void {
    // Hard stop / abandon — honest cancelled semantics.
    if (this.chatAbort) {
      this.chatAbort.aborted = true;
      this.chatAbort.pause = false;
    }
    this.chatPaused = false;
    this.chatStatus = t("chat_stopped");
    const statusEl = this.contentContainer?.querySelector("[data-chat-status]");
    if (statusEl) statusEl.textContent = this.chatStatus;
  }

  /**
   * Pause ≠ abandon (Desktop parity): abort the call but keep the goal ledger
   * so Resume can continue the open criteria. Finished edits stay on disk.
   */
  private pauseChat(): void {
    if (!this.chatThinking) return;
    if (this.chatAbort) {
      this.chatAbort.aborted = true;
      this.chatAbort.pause = true;
    }
    this.chatPaused = true;
    this.chatStatus = t("chat_paused");
    const statusEl = this.contentContainer?.querySelector("[data-chat-status]");
    if (statusEl) statusEl.textContent = this.chatStatus;
  }

  /** Resume a paused turn. Optional `redirect` is folded into the continue prompt. */
  private async resumeChat(input?: HTMLTextAreaElement | null, redirect?: string): Promise<void> {
    if (!this.chatPaused || this.chatThinking) return;
    this.chatPaused = false;
    const goal = this.loadChatGoal();
    const extra = String(redirect || input?.value || "").trim();
    const parts = [
      "[系统] 任务被用户暂停后恢复，可能尚未完成。请继续完成用户原始目标；若已完成则给出简短结论与路径回执。",
    ];
    if (goal?.goal) parts.push(`原目标：${goal.goal}`);
    if (goal?.plan?.length) {
      parts.push(`计划：\n${goal.plan.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
    }
    if (goal?.openCriteria?.length) {
      parts.push(`未完成验收项：\n${goal.openCriteria.map((s) => `- ${s}`).join("\n")}`);
    }
    if (extra) parts.push(`用户补充指示：${extra}`);
    parts.push("先更新/执行剩余步骤，再收尾。收尾时输出结论 + 路径回执 + [DONE]；若无法完成则 [INCOMPLETE 原因]。");
    if (input) {
      input.value = "";
      input.setCssStyles({ height: "auto" });
    }
    await this.sendChatMessageText(parts.join("\n"));
  }

  /** Abandon a paused turn (true cancel). */
  private abandonPausedChat(): void {
    if (!this.chatPaused) return;
    this.chatPaused = false;
    this.saveChatGoal(null);
    this.stopChat();
    void this.renderActiveTab();
  }

  /** Update the working row in place so a progress tick does not rebuild the composer. */
  private patchChatWorkingRow(): void {
    const statusEl = this.contentContainer?.querySelector("[data-chat-status]");
    if (statusEl) statusEl.textContent = this.chatStatus || t("chat_thinking");
    const live = this.chatReasoningLive.trim();
    const pre = this.contentContainer?.querySelector("[data-chat-reasoning-live]");
    if (pre && live) {
      pre.textContent = live;
      const meta = this.contentContainer?.querySelector("[data-chat-reasoning-meta]");
      if (meta) meta.textContent = t("chat_reasoning_chars", { count: live.length });
      return;
    }
    if (!statusEl || (live && !pre)) void this.renderActiveTab();
  }

  private async sendChatMessage(input: HTMLTextAreaElement): Promise<void> {
    const text = input.value.trim();
    if (!text || this.chatThinking) return;
    input.value = "";
    input.setCssStyles({ height: "auto" });
    await this.sendChatMessageText(text);
  }

  private async sendChatMessageText(text: string): Promise<void> {
    if (!text || this.chatThinking) return;

    // Add user message
    this.chatHistory.push({ role: "user", content: text });
    this.saveChatHistory();

    const gate = { aborted: false, pause: false };
    this.chatAbort = gate;
    this.chatThinking = true;
    this.chatPaused = false;
    this.chatStartedAt = Date.now();
    this.chatStatus = t("chat_working");
    this.chatReasoningLive = "";
    this.chatFocusOnRender = true;
    void this.renderActiveTab();

    try {
      const response = await this.plugin.kernelService.chat(text, this.chatHistory.slice(0, -1), {
        shouldAbort: () => gate.aborted,
        stopKind: () => (gate.pause ? "paused" : "cancelled"),
        contextLimit: this.chatContextLimit,
        priorGoal: this.loadChatGoal(),
        onProgress: (ev) => {
          this.chatStatus = this.formatChatProgress(ev);
          if (ev.reasoning) this.chatReasoningLive = ev.reasoning;
          this.patchChatWorkingRow();
        },
      });
      const stopReason = response.stopReason
        || (gate.pause ? "paused" as const : gate.aborted ? "cancelled" as const : undefined);
      const goal = response.goal || (stopReason === "paused" ? this.loadChatGoal() : null);
      this.chatHistory.push({
        role: "assistant",
        content: response.content || (stopReason === "paused" ? t("chat_paused") : stopReason === "cancelled" ? t("chat_stopped") : "..."),
        reasoning: response.reasoning || this.chatReasoningLive || undefined,
        prompt: text,
        toolCalls: response.toolCalls,
        steps: response.steps,
        autoContinues: response.autoContinues,
        stepLimitHit: response.stepLimitHit,
        paused: stopReason === "paused" || undefined,
        cancelled: stopReason === "cancelled" || undefined,
        stopReason,
        goal,
      });
      this.saveChatGoal(stopReason === "cancelled" ? null : goal);
      this.saveChatHistory();
    } catch (err) {
      if (gate.aborted || (err instanceof Error && err.name === "AbortError")) {
        this.chatHistory.push({
          role: "assistant",
          content: gate.pause ? t("chat_paused") : t("chat_stopped"),
          reasoning: this.chatReasoningLive || undefined,
          prompt: text,
          paused: gate.pause || undefined,
          goal: gate.pause ? this.loadChatGoal() : null,
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.chatHistory.push({
          role: "assistant",
          content: `${t("chat_error")}: ${msg}`,
          isError: true,
          prompt: text,
        });
      }
      this.saveChatHistory();
    } finally {
      this.chatAbort = null;
      this.chatThinking = false;
      if (!gate.pause) this.chatPaused = false;
      this.chatStatus = gate.pause ? t("chat_paused") : "";
      this.chatReasoningLive = "";
      this.chatFocusOnRender = true;
      void this.renderActiveTab();
    }
  }

  private formatChatProgress(ev: { kind: string; step: number; maxSteps: number; tool?: string; autoContinues?: number }): string {
    const stepPart = t("chat_step_progress", { step: ev.step, max: ev.maxSteps });
    const elapsed = this.chatStartedAt
      ? ` ${Math.max(0, Math.floor((Date.now() - this.chatStartedAt) / 1000))}s`
      : "";
    if (ev.kind === "tool" && ev.tool) {
      return `${stepPart} · ${t("chat_tool_running", { tool: ev.tool })}${elapsed}`;
    }
    if (ev.kind === "continue") {
      return `${stepPart} · ${t("chat_auto_continue", { count: ev.autoContinues || 1 })}${elapsed}`;
    }
    if (ev.kind === "done") {
      return t("chat_working");
    }
    return `${stepPart} · ${t("chat_working")}${elapsed}`;
  }

  /** Regenerate the AI response for a given prompt */
  private async regenerateResponse(prompt: string): Promise<void> {
    if (this.chatThinking) return;

    const gate = { aborted: false };
    this.chatAbort = gate;
    this.chatThinking = true;
    this.chatStartedAt = Date.now();
    this.chatStatus = t("chat_working");
    this.chatReasoningLive = "";
    void this.renderActiveTab();

    try {
      // Context = history up to (excluding) the user message being regenerated,
      // so the prompt is sent exactly once as the final turn.
      let lastUserIdx = -1;
      for (let i = this.chatHistory.length - 1; i >= 0; i--) {
        const m = this.chatHistory[i];
        if (m.role === "user" && m.content === prompt) {
          lastUserIdx = i;
          break;
        }
      }
      const history = lastUserIdx >= 0
        ? this.chatHistory.slice(0, lastUserIdx)
        : [...this.chatHistory];
      const response = await this.plugin.kernelService.chat(prompt, history, {
        shouldAbort: () => gate.aborted,
        contextLimit: this.chatContextLimit,
        priorGoal: this.loadChatGoal(),
        onProgress: (ev) => {
          this.chatStatus = this.formatChatProgress(ev);
          if (ev.reasoning) this.chatReasoningLive = ev.reasoning;
          this.patchChatWorkingRow();
        },
      });
      this.chatHistory.push({
        role: "assistant",
        content: response.content || (gate.aborted ? t("chat_stopped") : "..."),
        reasoning: response.reasoning || this.chatReasoningLive || undefined,
        prompt,
        toolCalls: response.toolCalls,
        steps: response.steps,
        autoContinues: response.autoContinues,
        stepLimitHit: response.stepLimitHit,
        goal: (response as { goal?: ChatMessage["goal"] }).goal || null,
      });
      this.saveChatGoal((response as { goal?: ChatMessage["goal"] }).goal || null);
      this.saveChatHistory();
    } catch (err) {
      if (gate.aborted || (err instanceof Error && err.name === "AbortError")) {
        this.chatHistory.push({
          role: "assistant",
          content: t("chat_stopped"),
          reasoning: this.chatReasoningLive || undefined,
          prompt,
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.chatHistory.push({
          role: "assistant",
          content: `${t("chat_error")}: ${msg}`,
          isError: true,
          prompt,
        });
      }
      this.saveChatHistory();
    } finally {
      this.chatAbort = null;
      this.chatThinking = false;
      this.chatStatus = "";
      this.chatReasoningLive = "";
      void this.renderActiveTab();
    }
  }

  // ── History Tab (AI Task History) ───────────────────────────────────────

  private renderHistoryTab(container: HTMLElement): void {
    const section = container.createDiv({ cls: "tm-sidebar-section" });
    const progress = aiTaskManager.getProgress();

    // Active task (if any)
    if (progress.active) {
      const activeEl = section.createDiv({ cls: "tm-history-active" });
      this.renderTaskItem(activeEl, progress.active, true);
    }

    // Queued tasks
    if (progress.queued.length > 0) {
      const queuedHeader = section.createDiv({ cls: "tm-history-section-header" });
      queuedHeader.createSpan({
        text: t("task_queued_count", { count: progress.queued.length }),
      });
      for (const task of progress.queued) {
        this.renderTaskItem(section, task, false);
      }
    }

    // Recent history
    const recent = progress.recent.slice().reverse(); // newest first
    if (recent.length === 0) {
      this.renderEmptyState(section, t("task_no_history"), "", "history");
    } else {
      const recentHeader = section.createDiv({ cls: "tm-history-section-header" });
      recentHeader.createSpan({ text: t("task_recent") });

      // Clear history button
      const clearBtn = recentHeader.createEl("button", {
        cls: "tm-btn-mini tm-history-clear",
      });
      setIcon(clearBtn, "trash-2");
      clearBtn.setAttribute("aria-label", t("task_clear_history"));
      clearBtn.setAttribute("title", t("task_clear_history"));
      clearBtn.addEventListener("click", () => {
        aiTaskManager.clearHistory();
      });

      for (const task of recent) {
        this.renderTaskItem(section, task, false);
      }
    }
  }

  private renderTaskItem(container: HTMLElement, task: AiTask, isActive: boolean): void {
    const item = container.createDiv({
      cls: `tm-history-item tm-history-${task.status}${isActive ? " tm-history-item-active" : ""}`,
    });

    // Status icon
    const iconSpan = item.createDiv({ cls: "tm-history-icon" });
    const iconName = this.getTaskStatusIcon(task.status);
    setIcon(iconSpan, iconName);

    // Label + status
    const body = item.createDiv({ cls: "tm-history-body" });
    body.createDiv({ cls: "tm-history-label", text: task.label });

    const meta = body.createDiv({ cls: "tm-history-meta" });
    meta.createSpan({ text: this.getTaskStatusLabel(task.status), cls: `tm-history-status tm-history-status-${task.status}` });

    if (task.result?.summary) {
      meta.createSpan({ text: ` · ${task.result.summary.slice(0, 60)}`, cls: "tm-history-summary" });
    }
    if (task.error) {
      meta.createSpan({ text: ` · ${task.error.slice(0, 60)}`, cls: "tm-history-error" });
    }

    // Time
    if (task.finishedAt) {
      const elapsed = task.finishedAt - (task.startedAt || task.finishedAt);
      if (elapsed > 0) {
        meta.createSpan({ text: ` · ${(elapsed / 1000).toFixed(1)}s`, cls: "tm-history-duration" });
      }
    }

    // Abort button for active task
    if (isActive) {
      const abortBtn = item.createEl("button", { cls: "tm-btn-mini tm-history-abort" });
      setIcon(abortBtn, "x");
      abortBtn.setAttribute("aria-label", t("task_abort"));
      abortBtn.setAttribute("title", t("task_abort"));
      abortBtn.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        aiTaskManager.abort();
      });
    }
  }

  private getTaskStatusIcon(status: string): string {
    switch (status) {
      case "pending": return "clock";
      case "running": return "loader";
      case "done": return "check-circle";
      case "error": return "alert-circle";
      case "aborted": return "x-circle";
      default: return "circle";
    }
  }

  private getTaskStatusLabel(status: string): string {
    switch (status) {
      case "pending": return t("task_pending");
      case "running": return t("task_running");
      case "done": return t("task_done");
      case "error": return t("task_error");
      case "aborted": return t("task_aborted");
      default: return status;
    }
  }

  // ── Bottom Actions ─────────────────────────────────────────────────────

  private renderBottomActions(container: HTMLElement): void {
    const actionsBar = container.createDiv({ cls: "tm-sidebar-bottom-actions" });
    const aiConfigured = hasConfiguredProvider(this.plugin.settings.ai);

    // 2 slots: capture (primary) · organize menu (merged — no separate AI 整理).
    const captureBtn = actionsBar.createEl("button", {
      cls: "tm-sidebar-action-btn tm-sidebar-capture-primary mod-cta",
    });
    const iconSpan = captureBtn.createSpan({ cls: "tm-action-icon-span" });
    setIcon(iconSpan, "pencil");
    captureBtn.createSpan({ text: t("sidebar_btn_capture"), cls: "tm-sidebar-action-label" });
    captureBtn.setAttribute("aria-label", t("sidebar_btn_capture"));
    captureBtn.setAttribute("title", t("sidebar_btn_capture"));
    captureBtn.addEventListener("click", () => this.plugin.openQuickCapture());

    const orgBtn = actionsBar.createEl("button", { cls: "tm-sidebar-action-btn" });
    const orgIcon = orgBtn.createSpan({ cls: "tm-action-icon-span" });
    setIcon(orgIcon, "arrow-down-wide-narrow");
    orgBtn.createSpan({ text: t("sidebar_btn_organize"), cls: "tm-sidebar-action-label" });
    orgBtn.setAttribute("aria-label", t("sidebar_btn_organize"));
    orgBtn.setAttribute("title", t("sidebar_btn_organize"));
    orgBtn.addEventListener("click", (evt: MouseEvent) => {
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle(t("stream_organize")).setIcon("arrow-down-wide-narrow").onClick(() => { void (async () => {
          new Notice(t("notice_organizing"));
          const streamCtx = await this.plugin.kernelService.getStreamContext();
          if (streamCtx.current) this.plugin.kernelService.reconcilePeriod(streamCtx.current.relPath);
          if (aiConfigured && this.plugin.settings.autoMaintainTodos) {
            void this.plugin.enqueueAiOperation("todo_maintain", "op_label_todo_maintain", "notice_todo_done", "sidebar", true);
          } else {
            new Notice(t("notice_organize_done"));
          }
          void this.refreshActiveTab();
        })(); });
      });
      if (aiConfigured) {
        menu.addItem((item) => {
          item.setTitle(t("sidebar_btn_todo")).setIcon("list-checks").onClick(() => {
            void this.plugin.enqueueAiOperation("todo_maintain", "op_label_todo_maintain", "notice_todo_done", "sidebar");
          });
        });
        menu.addItem((item) => {
          item.setTitle(t("sidebar_btn_classify")).setIcon("tag").onClick(() => {
            void this.plugin.enqueueAiOperation("topic_classify", "op_label_topic_classify", "notice_classify_done", "suggest");
          });
        });
        menu.addItem((item) => {
          item.setTitle(t("sidebar_btn_memory")).setIcon("user").onClick(() => {
            void this.plugin.enqueueAiOperation("memory_organize", "op_label_memory_organize", "notice_memory_done", "all");
          });
        });
      } else {
        menu.addItem((item) => item.setTitle(t("chat_configure_ai")).setIcon("settings").onClick(() => this.openSettings()));
      }
      menu.showAtMouseEvent(evt);
    });
  }

  private addActionButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    handler: () => void | Promise<void>,
  ): void {
    const btn = parent.createEl("button", { cls: "tm-sidebar-action-btn" });
    const iconSpan = btn.createSpan({ cls: "tm-action-icon-span" });
    setIcon(iconSpan, icon);
    btn.createSpan({ text: label, cls: "tm-sidebar-action-label" });
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    btn.addEventListener("click", () => { void handler(); });
  }

  /** Enqueue an AI task with progress tracking */
  // ── Helpers ────────────────────────────────────────────────────────────

  private renderEmptyState(container: HTMLElement, title: string, hint: string, iconName?: string, action?: { label: string; onClick: () => void }): void {
    const div = container.createDiv({ cls: "tm-empty-state tm-empty-compact" });
    if (iconName) {
      const iconDiv = div.createDiv({ cls: "tm-empty-icon" });
      setIcon(iconDiv, iconName);
    }
    div.createDiv({ text: title, cls: "tm-empty-title" });
    if (hint) {
      div.createDiv({ text: hint, cls: "tm-empty-hint" });
    }
    if (action) {
      const actionWrap = div.createDiv({ cls: "tm-empty-action" });
      const btn = actionWrap.createEl("button", { text: action.label, cls: "tm-btn-secondary" });
      btn.addEventListener("click", action.onClick);
    }
  }

  private renderWorkspaceInit(container: HTMLElement): void {
    const emptyDiv = container.createDiv({ cls: "tm-empty-state tm-workspace-init" });
    emptyDiv.createDiv({ text: t("init_workspace_desc"), cls: "tm-init-desc" });
    const initBtn = emptyDiv.createEl("button", {
      cls: "tm-btn-init-workspace mod-cta",
      text: t("init_workspace"),
    });
    initBtn.setAttribute("aria-label", t("init_workspace"));
    initBtn.addEventListener("click", () => {
      const result = this.plugin.kernelService.initWorkspace("stream");
      if (result.ok) {
        new Notice(t("init_workspace_success"));
        void this.render();
      } else {
        new Notice(`${t("init_workspace_failed")}: ${result.error || ""}`);
      }
    });
  }

  /** Public refresh — called from main.ts after operations.
   *  Only repaint the active tab + badge; a full render() would wipe the
   *  tab bar and reset the user's selected tab (flicker bug). */
  async refresh(): Promise<void> {
    if (!this.contentContainer) {
      await this.render();
      return;
    }
    await this.renderActiveTab();
  }

  /** Jump to a tab (e.g. stream view count chip → suggestions). */
  revealTab(tab: SidebarTab): void {
    if (this.activeTab === tab) {
      void this.renderActiveTab();
      return;
    }
    this.activeTab = tab;
    if (tab === "chat") this.chatFocusOnRender = true;
    void this.render();
  }

  private async openWorkbench(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_STREAM_WORKBENCH);
    if (existing.length > 0) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    // New leaf — never replace the tab the user is currently reading.
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_STREAM_WORKBENCH, active: true });
  }
}
