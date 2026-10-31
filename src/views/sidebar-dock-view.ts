// ── Sidebar Dock View: AI Copilot Panel in Obsidian right sidebar ───────────
//
// Chat owns conversation state; the dock renders it and keeps keyboard focus,
// unsent drafts and other tabs independent from background progress.

import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, setIcon, Menu, Component } from "obsidian";
import type TopmindPlugin from "../main";
import { t, getLocale } from "../i18n";
import { VIEW_TYPE_SIDEBAR_DOCK } from "../constants";
import { AI_PROVIDER_PRESETS, PROVIDER_DEFAULT_MODELS } from "../constants";
import type { SuggestionCard, TodoItem } from "../types";
import { renderSuggestionCard } from "./suggestion-card";
import { hasConfiguredProvider } from "../types";
import { aiTaskManager, type TaskProgress, type AiTask } from "../services/ai-task-manager";
import { resolveProviderCatalog, applyModelOptions, credentialsForProvider } from "../services/models-dev";
import { bindImeEnterGuard, footerStatusTitle, isImeEnter } from "../utils";
import { confirmAction } from "./confirm-modal";
import { openStreamWorkbench, openPluginSettings } from "../services/view-openers";
import { captureChatFocus, type ChatFocus } from "../services/editor-context";
import { ChatController, type ChatMessage } from "../services/chat-session";
import { WritingModal } from "./writing-modal";
import { buildResultFooter } from "#kernel/agent-goal-protocol.mjs";

let sidebarSequence = 0;

type SidebarTab = "todos" | "suggestions" | "chat" | "history";

export class SidebarDockView extends ItemView {
  plugin: TopmindPlugin;
  private refreshTimer: number | null = null;
  private activeTab: SidebarTab = "chat";
  private readonly tabIdPrefix = `tm-dock-${++sidebarSequence}`;
  private chatController: ChatController | null = null;
  private get chat(): ChatController {
    return this.chatController ||= new ChatController({
      root: () => this.plugin.kernelService.getVaultPath(),
      chat: (prompt, history, options) => this.plugin.kernelService.chat(prompt, history, options),
      copy: () => ({ paused: t("chat_paused"), stopped: t("chat_stopped"), error: t("chat_error") }),
    });
  }
  private get chatHistory(): ChatMessage[] { return this.chat.messages; }
  private get chatThinking(): boolean { return this.chatController?.thinking || false; }
  private closed = false;
  /** True while a turn is paused waiting for Resume / redirect / abandon. */
  private get chatPaused(): boolean { return this.chatController?.paused || false; }
  private set chatPaused(value: boolean) { this.chat.paused = value; }
  /** Live agent progress line while a turn is working (step / tool / auto-continue). */
  private chatStatus = "";
  /** Turn start timestamp for elapsed progress. */
  private get chatStartedAt(): number { return this.chatController?.startedAt || 0; }
  /** Folded reasoning shown while the turn is still running. */
  private get chatReasoningLive(): string { return this.chatController?.reasoning || ""; }
  /** Set on user-initiated chat renders (tab open / send) — never on vault-event refreshes. */
  private chatFocusOnRender = false;
  /** Re-entrancy guard for suggestion generation (workbench parity). */
  private suggestionRequest: Promise<SuggestionCard[]> | null = null;
  private get suggestionsInFlight(): boolean { return this.suggestionRequest !== null; }
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
  private todoDraft = "";
  private todoQuery = "";
  private todoVisible = 20;
  private completedVisible = 20;
  private completedOpen = false;
  private chatViewport = { top: 0, follow: true };
  private chatScrollToLatest = false;
  private chatResizeObserver: ResizeObserver | null = null;
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
    this.closed = false;
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

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      captureChatFocus(this.app.workspace);
      const strip = this.contentContainer?.querySelector(".tm-chat-context-bar");
      if (this.activeTab !== "chat" || !strip?.parentElement) return;
      const parent = strip.parentElement;
      const next = strip.nextSibling;
      strip.remove();
      void this.renderChatContextBar(parent).then(() => {
        const replacement = parent.querySelector(".tm-chat-context-bar");
        if (replacement) parent.insertBefore(replacement, next);
      });
    }));

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
    this.closed = true;
    this.captureChatViewport();
    this.chatController?.close();
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.taskUnsub?.();
    this.renderComp.unload();
  }

  private loadChatGoal(): ChatMessage["goal"] | null { return this.chat.goal; }
  private async loadChatHistory(): Promise<void> { this.chat.load(); }

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
    this.captureChatViewport();
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
      const activeInput = document.activeElement as HTMLInputElement | null;
      const focusClass = activeInput?.classList.contains("tm-todo-filter-input") ? "tm-todo-filter-input"
        : activeInput?.classList.contains("tm-todo-add-input") ? "tm-todo-add-input" : "";
      const selection = focusClass ? [activeInput?.selectionStart, activeInput?.selectionEnd] : null;
      await this.renderActiveTab();
      if (focusClass && this.activeTab === "todos" && !this.closed && (document.activeElement === document.body || document.activeElement === activeInput)) {
        const replacement = this.contentContainer.querySelector<HTMLInputElement>(`.${focusClass}`);
        replacement?.focus();
        if (selection?.[0] != null && selection[1] != null) replacement?.setSelectionRange?.(selection[0], selection[1]);
      }
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
    openPluginSettings(this.app, this.plugin.manifest.id);
  }

  /** Run AI quick test and update the status indicator */
  private async runAiQuickTest(statusEl: HTMLButtonElement): Promise<void> {
    if (statusEl.disabled) return;
    const dotEl = statusEl.querySelector(".tm-status-dot");
    const originalTitle = statusEl.getAttribute("title") || "";
    statusEl.disabled = true;
    statusEl.setAttribute("aria-busy", "true");
    statusEl.setAttribute("aria-label", t("ai_checking"));
    statusEl.setAttribute("title", t("ai_checking"));
    if (dotEl) dotEl.className = "tm-status-dot tm-dot-checking";
    try {
      const result = await this.plugin.kernelService.quickTestAi();
      const label = result.ok ? t("ai_test_ok") : t("ai_test_fail");
      statusEl.setAttribute("aria-label", label);
      statusEl.setAttribute("title", `${label} · ${t("settings_ai_quick_test")}`);
      if (dotEl) dotEl.className = `tm-status-dot ${result.ok ? "tm-dot-ok" : "tm-dot-error"}`;
      new Notice(result.ok ? label : `${label}: ${result.error || ""}`);
    } catch {
      statusEl.setAttribute("aria-label", t("ai_test_fail"));
      statusEl.setAttribute("title", originalTitle);
      if (dotEl) dotEl.className = "tm-status-dot tm-dot-error";
      new Notice(t("ai_test_fail"));
    } finally {
      statusEl.disabled = false;
      statusEl.removeAttribute("aria-busy");
    }
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
    tabBar.setAttribute("aria-label", t("sidebar_dock_title"));

    // 动态流的家是主区 Stream View，不进 AI Dock（能力单家 · 对齐 Desktop）
    // Order matches Desktop AI workspace: 对话 first (agent spine), then confirm faces.
    const tabs: { id: SidebarTab; label: string; icon: string }[] = [
      { id: "chat", label: t("sidebar_tab_chat"), icon: "bot" },
      { id: "suggestions", label: t("sidebar_tab_suggestions"), icon: "lightbulb" },
      { id: "todos", label: t("sidebar_tab_todos"), icon: "list-checks" },
      { id: "history", label: t("sidebar_tab_history"), icon: "activity" },
    ];

    const tabBtns: HTMLButtonElement[] = [];
    for (const tab of tabs) {
      const isActive = this.activeTab === tab.id;
      const btn = tabBar.createEl("button", {
        cls: `tm-tab-btn ${isActive ? "tm-tab-active" : ""}`,
        attr: { "data-tab-id": tab.id, type: "button" },
      });
      btn.id = `${this.tabIdPrefix}-${tab.id}`;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-controls", `${this.tabIdPrefix}-panel`);
      btn.setAttribute("title", tab.label);
      btn.setAttribute("aria-selected", String(isActive));
      // Roving tabindex: only the active tab is in the tab order.
      btn.tabIndex = isActive ? 0 : -1;
      const iconSpan = btn.createSpan({ cls: "tm-tab-icon" });
      setIcon(iconSpan, tab.icon);
      btn.createSpan({ text: tab.label, cls: "tm-tab-label" });
      btn.setAttribute("aria-label", tab.label);
      tabBtns.push(btn);
      const activate = (focusComposer: boolean) => {
        this.activeTab = tab.id;
        this.chatFocusOnRender = tab.id === "chat" && focusComposer;
        tabBtns.forEach((b, i) => {
          const on = tabs[i].id === tab.id;
          b.classList.toggle("tm-tab-active", on);
          b.setAttribute("aria-selected", String(on));
          b.tabIndex = on ? 0 : -1;
        });
        void this.renderActiveTab();
      };
      btn.addEventListener("click", (event: MouseEvent) => activate(event.detail > 0));
      // WAI-ARIA tabs: Left/Right move focus+select, Home/End jump.
      btn.addEventListener("keydown", (e: KeyboardEvent) => {
        const idx = tabBtns.indexOf(btn);
        let next = -1;
        if (e.key === "ArrowRight") next = (idx + 1) % tabBtns.length;
        else if (e.key === "ArrowLeft") next = (idx - 1 + tabBtns.length) % tabBtns.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = tabBtns.length - 1;
        else return;
        e.preventDefault();
        tabBtns[next].focus();
        tabBtns[next].click();
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
    this.captureChatViewport();
    this.contentContainer.id = `${this.tabIdPrefix}-panel`;
    this.contentContainer.setAttribute("role", "tabpanel");
    this.contentContainer.setAttribute("aria-labelledby", `${this.tabIdPrefix}-${this.activeTab}`);
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
    // Chat layout class must not leak onto todos/suggestions/history tabs.
    this.contentContainer.removeClass("tm-chat-container");

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

    const addRow = todoSection.createDiv({ cls: "tm-todo-add-row" });
    const addInput = addRow.createEl("input", { cls: "tm-todo-add-input", attr: { type: "text", placeholder: t("todo_add_placeholder"), "aria-label": t("todo_add_placeholder") } });
    const addBtn = addRow.createEl("button", { text: t("todo_add"), cls: "tm-btn-secondary tm-btn-sm" });
    addInput.value = this.todoDraft;
    addBtn.disabled = !addInput.value.trim();
    addInput.addEventListener("input", () => { this.todoDraft = addInput.value; addBtn.disabled = !addInput.value.trim(); });
    const add = () => {
      if (!addInput.value.trim()) return;
      if (this.plugin.kernelService.addTodo(addInput.value).ok) {
        this.todoDraft = "";
        addInput.value = "";
        void this.refreshActiveTab().then(() => this.contentContainer?.querySelector<HTMLInputElement>(".tm-todo-add-input")?.focus());
      }
    };
    addBtn.addEventListener("click", add);
    addInput.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); add(); }
    });

    const todos = this.plugin.kernelService.readTodos();
    let filterInput: HTMLInputElement | null = null;
    if (todos.filter(item => !item.done).length > 10 || this.todoQuery) {
      filterInput = todoSection.createEl("input", { cls: "tm-todo-filter-input", attr: { type: "search", placeholder: t("todo_filter"), "aria-label": t("todo_filter") } });
      filterInput.value = this.todoQuery;
    }
    const list = todoSection.createDiv({ cls: "tm-todo-list" });
    const paint = () => this.renderTodoList(list, todos, () => {
      this.todoQuery = "";
      this.todoVisible = 20;
      if (filterInput) { filterInput.value = ""; filterInput.focus(); }
      paint();
    });
    filterInput?.addEventListener("input", () => {
      this.todoQuery = filterInput!.value;
      this.todoVisible = 20;
      paint();
    });
    paint();
  }

  private renderTodoList(container: HTMLElement, todos: TodoItem[], clearFilter: () => void): void {
    container.empty();
    const query = this.todoQuery.normalize("NFKC").trim().toLocaleLowerCase();
    const activeTodos = todos.filter(item => !item.done && (!query || [item.text, item.dueDate, item.sourcePeriod].join(" ").normalize("NFKC").toLocaleLowerCase().includes(query)));
    const doneTodos = todos.filter(item => item.done);
    const activeList = container.createDiv({ cls: "tm-todo-active-list" });
    if (!activeTodos.length) {
      this.renderEmptyState(activeList, query ? t("todo_no_matches") : t("sidebar_no_todos"), query ? t("todo_no_matches_hint") : "", "check-check", query ? { label: t("todo_clear_filter"), onClick: clearFilter } : undefined);
    } else {
      for (const todo of activeTodos.slice(0, this.todoVisible)) this.renderTodoRow(activeList, todo);
      if (activeTodos.length > this.todoVisible) {
        const more = activeList.createEl("button", { cls: "tm-btn-secondary tm-todo-load-more", text: t("todo_load_more", { count: activeTodos.length - this.todoVisible }) });
        more.addEventListener("click", () => {
          const firstNew = this.todoVisible;
          this.todoVisible += 20;
          this.renderTodoList(container, todos, clearFilter);
          container.querySelectorAll<HTMLElement>(".tm-todo-item")[firstNew]?.querySelector<HTMLInputElement>("input")?.focus();
        });
      }
    }
    if (!doneTodos.length) return;
    const doneHeader = container.createDiv({ cls: "tm-todo-done-header" });
    const doneLabel = doneHeader.createSpan({ cls: "tm-todo-done-label", text: `${doneTodos.length} ${t("sidebar_todos_done")}` });
    doneLabel.setAttribute("aria-live", "polite");
    const clearDoneBtn = doneHeader.createEl("button", { cls: "tm-btn-mini tm-todo-clear-done", attr: { "aria-label": t("todo_clear_completed"), title: t("todo_clear_completed") } });
    setIcon(clearDoneBtn, "trash-2");
    clearDoneBtn.addEventListener("click", () => {
      confirmAction(this.app, t("confirm_clear_todos_title"), t("confirm_clear_todos_body"), () => {
        if (this.plugin.kernelService.clearCompletedTodos().ok) void this.refreshActiveTab();
      });
    });
    const completed = container.createEl("details", { cls: "tm-todo-completed" });
    completed.open = this.completedOpen;
    completed.createEl("summary", { text: t("todo_view_completed") });
    completed.addEventListener("toggle", () => { this.completedOpen = completed.open; });
    for (const todo of doneTodos.slice(0, this.completedVisible)) this.renderTodoRow(completed, todo);
    if (doneTodos.length > this.completedVisible) {
      const more = completed.createEl("button", { cls: "tm-btn-secondary", text: t("todo_load_more", { count: doneTodos.length - this.completedVisible }) });
      more.addEventListener("click", () => {
        this.completedVisible += 20;
        this.completedOpen = true;
        this.renderTodoList(container, todos, clearFilter);
      });
    }
  }

  private renderTodoRow(container: HTMLElement, todo: TodoItem): void {
    const item = container.createDiv({ cls: "tm-todo-item" });
    const toggle = item.createEl("label", { cls: "tm-todo-toggle", attr: { title: todo.text } });
    const checkbox = toggle.createEl("input", { attr: { type: "checkbox", "aria-label": todo.text }, cls: "tm-todo-checkbox" });
    checkbox.checked = todo.done;
    checkbox.addEventListener("change", () => {
      if (!this.plugin.kernelService.toggleTodo(todo.id).ok) { checkbox.checked = !checkbox.checked; return; }
      void this.refreshActiveTab();
    });
    item.createSpan({ cls: "tm-todo-text", text: todo.text });
    if (todo.sourcePeriod) {
      const source = item.createEl("button", { cls: "tm-todo-source", attr: { "aria-label": t("todo_open_source"), title: t("todo_open_source") } });
      setIcon(source, "external-link");
      source.createSpan({ text: ` ${todo.sourcePeriod}` });
      source.addEventListener("click", () => { void (async () => {
        const link = await this.plugin.kernelService.todoSourcePath(todo.sourcePeriod!);
        if (link) await this.app.workspace.openLinkText(link, "", false);
        else new Notice(t("todo_source_missing"));
      })().catch(() => new Notice(t("todo_source_missing"))); });
    }
    if (todo.dueDate) {
      const due = item.createSpan({ cls: "tm-todo-due" });setIcon(due, "calendar");due.createSpan({ text: ` ${todo.dueDate}` });
    }
    const remove = item.createEl("button", { cls: "tm-todo-delete", attr: { "aria-label": t("todo_row_delete"), title: t("todo_row_delete") } });
    setIcon(remove, "trash-2");
    remove.addEventListener("click", () => { if (this.plugin.kernelService.deleteTodo(todo.id).ok) void this.refreshActiveTab(); });
  }

  // ── Suggestions Tab ────────────────────────────────────────────────────

  private renderPendingWrites(container: HTMLElement): number {
    const pending = this.plugin.kernelService.listPendingWrites();
    if (this.plugin.kernelService.reviewStorageError?.()) container.createDiv({ text: t("review_storage_error"), cls: "tm-inline-error", attr: { role: "alert" } });
    if (pending.length === 0) return 0;
    const section = container.createDiv({ cls: "tm-sidebar-section tm-pending-writes" });
    section.createDiv({ cls: "tm-suggestion-summary", text: t("pending_writes_title") });
    for (const item of pending) {
      const card = section.createDiv({ cls: "tm-suggestion-card tm-pending-write-card" });
      card.createDiv({ cls: "tm-suggestion-title", text: item.operation === "delete" ? t("pending_delete_title", { path: item.relativePath }) : item.relativePath });
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
          item.operation === "delete" ? t("pending_delete_preview") : t("pending_writes_preview_meta", { chars: item.content.length }),
        );
        previewBox.createEl("pre", { text: item.content });
        preview.setText(t("pending_writes_hide_preview"));
        preview.setAttribute("aria-expanded", "true");
      });
      const accept = actions.createEl("button", {
        cls: "tm-btn-primary tm-btn-sm",
        text: item.operation === "delete" ? t("pending_delete_accept") : t("pending_writes_accept"),
      });
      accept.setAttribute("aria-label", item.operation === "delete" ? t("pending_delete_accept") : t("pending_writes_accept"));
      accept.addEventListener("click", () => {
        this.plugin.kernelService.acceptPendingWrite(item.id);
        void this.renderSuggestionsTab(this.contentContainer);
      });
      const reject = actions.createEl("button", {
        cls: "tm-btn-secondary tm-btn-sm",
        text: t("pending_writes_reject"),
      });
      reject.setAttribute("aria-label", t("pending_writes_reject"));
      reject.addEventListener("click", () => {
        this.plugin.kernelService.rejectPendingWrite(item.id);
        void this.renderSuggestionsTab(this.contentContainer);
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
    container = container.createDiv({ cls: "tm-suggestions-surface" });
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
      if (this.plugin.settings.autoSuggest || this.suggestionsInFlight) {
        void this.softRefreshSuggestions(container);
      }
      return;
    }

    const loadingEl = container.createDiv({ cls: "tm-task-progress-inline" });
    loadingEl.createSpan({ text: t("suggestions_loading") });

    try {
      const suggestions = await this.requestSuggestions(force);
      if (this.closed || container.isConnected === false) return;
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
            ? { label: t("sidebar_op_suggestions"), onClick: () => { void this.renderSuggestionsTab(this.contentContainer, { force: true }); } }
            : undefined);
        }
        return;
      }
      this.paintSuggestionCards(container, suggestions);
    } catch (err) {
      if (this.closed || container.isConnected === false) return;
      container.empty();
      this.renderPendingWrites(container);
      this.renderSuggestionRefreshButton(container);
      this.paintSuggestionCards(container, this.plugin.kernelService.peekSuggestions());
      container.createDiv({ cls: "tm-inline-error", text: `${t("notice_execute_failed")}: ${err instanceof Error ? err.message : String(err)}`, attr: { role: "alert" } });
    }
  }

  private requestSuggestions(force: boolean): Promise<SuggestionCard[]> {
    return this.suggestionRequest ||= this.plugin.kernelService.generateSuggestions({ force }).finally(() => { this.suggestionRequest = null; });
  }

  /** Background regenerate — keep cached cards on screen. */
  private async softRefreshSuggestions(container: HTMLElement): Promise<void> {
    try {
      const suggestions = await this.requestSuggestions(false);
      if (this.closed || container.isConnected === false) return;
      container.empty();
      this.renderPendingWrites(container);
      this.renderSuggestionRefreshButton(container);
      this.paintSuggestionCards(container, suggestions);
    } catch (err) {
      if (this.closed || container.isConnected === false) return;
      container.createDiv({ cls: "tm-inline-error", text: `${t("notice_execute_failed")}: ${err instanceof Error ? err.message : String(err)}`, attr: { role: "alert" } });
    }
  }

  /** Suggestions own review and refresh; organizing lives in the Stream view. */
  private renderSuggestionRefreshButton(container: HTMLElement): void {
    const refreshBar = container.createDiv({ cls: "tm-suggestion-refresh-bar" });

    // Advanced workspace operations stay behind one menu.
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


    const refreshBtn = refreshBar.createEl("button", {
      cls: "tm-btn-secondary tm-btn-sm",
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.createSpan({ text: t("sidebar_op_suggestions") });
    refreshBtn.setAttribute("aria-label", t("sidebar_op_suggestions"));
    refreshBtn.setAttribute("title", t("sidebar_op_suggestions"));
    refreshBtn.addEventListener("click", () => { void (async () => {
      refreshBtn.disabled = true;
      await this.renderSuggestionsTab(this.contentContainer, { force: true });
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
    if (this.chatController?.storageError) {
      this.renderEmptyState(container, t("chat_storage_error"), this.chatController.storageError, "alert-triangle", {
        label: t("chat_retry"), onClick: () => { this.chat.load(); void this.renderActiveTab(); },
      });
      return;
    }

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
      const captureBtn = actionDiv.createEl("button", { cls: "tm-btn-secondary", text: t("sidebar_open_workbench") });
      captureBtn.addEventListener("click", () => { void this.openWorkbench(); });
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
    }

    const jump = container.createEl("button", { cls: "tm-btn-secondary tm-chat-jump", text: t("chat_jump_latest"), attr: { type: "button" } });
    this.bindChatViewport(messagesEl, jump);

    // Chat input area — input on top, foot row below (send/clear right).
    const inputArea = container.createDiv({ cls: "tm-chat-input-area" });
    const input = inputArea.createEl("textarea", {
      cls: "tm-chat-input",
      attr: {
        placeholder: t("chat_placeholder"),
        rows: "2",
        "aria-label": t("chat_title"),
        "aria-describedby": `${this.tabIdPrefix}-input-hint`,
      },
    });
    if (this.pendingChatDraft) {
      input.value = this.pendingChatDraft;
      this.pendingChatDraft = "";
      input.setCssStyles({ height: "auto" });
      input.setCssStyles({ height: `${Math.min(input.scrollHeight, 100)}px` });
    }

    const inputHint = inputArea.createDiv({ cls: "tm-chat-input-hint", text: t("chat_input_hint") });
    inputHint.id = `${this.tabIdPrefix}-input-hint`;
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
    newChatBtn.disabled = this.chatThinking;
    newChatBtn.addEventListener("click", () => {
      if (this.chatHistory.length === 0) return;
      confirmAction(this.app, t("confirm_new_chat_title"), t("confirm_new_chat_body"), () => {
        this.chat.clear();
        this.chatScrollToLatest = true;
        this.pendingChatDraft = "";
        input.value = "";
        void this.renderActiveTab();
      });
    });

    const sendBtn = footRight.createEl("button", {
      cls: "tm-btn-primary tm-btn-icon mod-cta",
      attr: { "aria-label": t("chat_send"), title: t("chat_send") },
    });
    setIcon(sendBtn, "send");
    sendBtn.disabled = !this.chatThinking && !this.chatPaused && !input.value.trim();

    // Auto-grow textarea
    input.addEventListener("input", () => {
      sendBtn.disabled = !this.chatThinking && !this.chatPaused && !input.value.trim();
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

  /** Preserve a reading position before replacing this tab's DOM. */
  private captureChatViewport(): void {
    const pane = this.contentContainer?.querySelector<HTMLElement>(".tm-chat-messages");
    if (pane && pane.clientHeight > 0) {
      this.chatViewport = { top: pane.scrollTop, follow: pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 48 };
    }
    this.chatResizeObserver?.disconnect();
    this.chatResizeObserver = null;
  }

  private bindChatViewport(pane: HTMLElement, jump: HTMLButtonElement): void {
    if (this.chatScrollToLatest) { this.chatViewport.follow = true; this.chatScrollToLatest = false; }
    let restoring = true;
    jump.hidden = this.chatViewport.follow;
    const latest = () => {
      this.chatViewport.follow = true;
      pane.scrollTop = pane.scrollHeight;
      jump.hidden = true;
    };
    jump.addEventListener("click", latest);
    pane.addEventListener("scroll", () => {
      if (restoring || !pane.isConnected) return;
      this.chatViewport = { top: pane.scrollTop, follow: pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 48 };
      jump.hidden = this.chatViewport.follow;
    });
    const restore = () => {
      if (!pane.isConnected) return;
      pane.scrollTop = this.chatViewport.follow ? pane.scrollHeight : this.chatViewport.top;
      restoring = false;
      jump.hidden = this.chatViewport.follow;
    };
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(restore);
    else window.setTimeout(restore, 0);
    if (typeof ResizeObserver !== "undefined") {
      this.chatResizeObserver = new ResizeObserver(() => {
        if (!restoring && pane.isConnected && this.chatViewport.follow) latest();
      });
      for (const child of Array.from(pane.children)) this.chatResizeObserver.observe(child);
    }
  }

  /** Quiet context strip — what the agent can see right now (UI/UX 2.0 §31). */
  private async renderChatContextBar(container: HTMLElement): Promise<void> {
    const bar = container.createDiv({ cls: "tm-chat-context-bar", attr: { role: "status" } });
    bar.createSpan({ text: t("chat_context_label"), cls: "tm-chat-context-label" });

    const focus = this.chatThinking ? this.chat.focus : captureChatFocus(this.app.workspace);
    const writing = bar.createEl("button", { cls: "tm-chip", text: t("writing_title"), attr: { type: "button" } });
    writing.addEventListener("click", () => new WritingModal(this.plugin, focus?.path || "").open());
    if (this.plugin.settings.useMemory !== false) bar.createSpan({ text: t("chat_memory_context"), cls: "tm-chat-context-empty" });
    if (!focus) {
      bar.createSpan({ text: t("chat_context_no_object"), cls: "tm-chat-context-empty" });
      return;
    }
    const file = bar.createEl("button", { cls: "tm-chip tm-chat-context-chip", text: focus.path.split("/").pop() || focus.path,
      attr: { type: "button", title: focus.path, "aria-label": t("chat_context_current_object", { path: focus.path }) } });
    file.addEventListener("click", () => { void this.app.workspace.openLinkText(focus.path, "", false); });
    if (focus.selection) bar.createSpan({ cls: "tm-chip tm-chat-context-chip", text: t("chat_context_selection", { count: focus.selection.length }) });
    bar.createSpan({ text: t("chat_context_on_send"), cls: "tm-chat-context-empty" });
  }

  /** Status dot only (no label). Click = quick test / settings. */
  private renderFooterStatus(container: HTMLElement): void {
    const aiReady = hasConfiguredProvider(this.plugin.settings.ai);
    const statusDiv = container.createEl("button", { cls: "tm-footer-status clickable-icon", attr: { type: "button" } });
    statusDiv.setAttribute("aria-label", aiReady ? t("settings_ai_quick_test") : t("chat_configure_ai"));
    statusDiv.setAttribute("title", footerStatusTitle(aiReady ? t("settings_ai_quick_test") : t("chat_configure_ai")));
    const dot = statusDiv.createSpan({ cls: `tm-status-dot ${aiReady ? "tm-dot-ok" : "tm-dot-off"}` });
    dot.setAttribute("aria-hidden", "true");
    statusDiv.addEventListener("click", () => {
      if (aiReady) void this.runAiQuickTest(statusDiv);
      else this.openSettings();
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

    if (msg.role === "assistant" && msg.focus?.path) {
      const objectPath = msg.focus.path;
      const bound = msgEl.createEl("button", {
        cls: "tm-chat-object", text: t("chat_bound_object", { path: objectPath.split("/").pop() || objectPath }),
        attr: { type: "button", title: objectPath, "aria-label": t("chat_bound_object", { path: objectPath }) },
      });
      bound.addEventListener("click", () => { void this.app.workspace.openLinkText(objectPath, "", false); });
    }

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
            text: tc.pending || tc.needsConfirm ? `${label} · ${t("chat_tool_pending")}` : label,
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
      if (msg.prompt && this.chatHistory[this.chatHistory.length - 1] === msg) {
        const regenBtn = actionsEl.createEl("button", { cls: "tm-chat-msg-btn clickable-icon" });
        setIcon(regenBtn, "refresh-cw");
        regenBtn.setAttribute("aria-label", t("chat_regenerate"));
        regenBtn.setAttribute("title", t("chat_regenerate"));
        regenBtn.addEventListener("click", () => {
          // Remove this message and regenerate
          const idx = this.chatHistory.lastIndexOf(msg);
          if (idx >= 0) {
            this.chatHistory.splice(idx, 1);
            void this.regenerateResponse(msg.prompt!, msg.focus);
          }
        });
      }
    } else if (msg.role === "assistant" && msg.isError) {
      // Error message with retry button
      bodyEl.textContent = msg.content;
      const actionsEl = msgEl.createDiv({ cls: "tm-chat-msg-actions" });
      if (msg.prompt && !this.chatThinking && msg === this.chatHistory[this.chatHistory.length - 1]) {
        const retryBtn = actionsEl.createEl("button", { cls: "tm-chat-msg-btn tm-chat-retry-btn" });
        setIcon(retryBtn, "refresh-cw");
        retryBtn.setAttribute("aria-label", t("chat_retry"));
        retryBtn.setAttribute("title", t("chat_retry"));
        retryBtn.addEventListener("click", () => {
          const idx = this.chatHistory.lastIndexOf(msg);
          if (idx >= 0) {
            this.chatHistory.splice(idx, 1);
            void this.regenerateResponse(msg.prompt!, msg.focus);
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
   * Result footer: actual tool completion + referenced paths and available evidence.
   * A path footprint includes reads and must never be counted as file writes.
   * Path receipts are never labeled Verified.
   */
  private renderResultFooter(msgEl: HTMLElement, msg: ChatMessage): void {
    const goal = msg.goal;
    const model = buildResultFooter(goal);
    if (!goal || !model) return;

    const okTools = (msg.toolCalls || []).filter((tc) => tc.ok && !tc.pending && !tc.needsConfirm).length;
    const pendingTools = (msg.toolCalls || []).filter((tc) => tc.pending || tc.needsConfirm).length;
    const footer = msgEl.createDiv({ cls: "tm-goal-footer" });
    footer.createDiv({
      cls: "tm-goal-footer-summary",
      text: t("chat_result_summary", { done: okTools }),
    });

    if (pendingTools) footer.createDiv({ cls: "tm-goal-footer-summary", text: t("chat_result_pending", { count: pendingTools }) });

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
          el.createSpan({ cls: "tm-goal-footer-item", text: item === goal.blockReason && /^[a-z][a-z_-]+$/iu.test(item) ? t("chat_task_stopped") : item });
        }
      }
    };

    if (model.changes.length) fill(row("chat_result_changes"), model.changes, true);
    if (model.verified.length) fill(row("chat_result_verified"), model.verified);
    if (model.assumed.length) fill(row("chat_result_assumed"), model.assumed);
    if (model.couldNot.length) fill(row("chat_result_could_not"), model.couldNot);
  }

  private stopChat(): void {
    // Hard stop / abandon — honest cancelled semantics.
    this.chat.cancel();
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

    this.chat.pause();
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
    const zh = !String(getLocale() || "").startsWith("en");
    const parts = [
      zh
        ? "[系统] 任务被用户暂停后恢复，可能尚未完成。请继续完成用户原始目标；若已完成则给出简短结论与路径回执。"
        : "[System] Task resumed after a user pause and may be incomplete. Continue toward the original goal; if finished, give a short conclusion with path receipts.",
    ];
    if (goal?.goal) parts.push(zh ? `原目标：${goal.goal}` : `Original goal: ${goal.goal}`);
    if (goal?.plan?.length) {
      const list = goal.plan.map((s, i) => `${i + 1}. ${s}`).join("\n");
      parts.push(zh ? `计划：\n${list}` : `Plan:\n${list}`);
    }
    if (goal?.openCriteria?.length) {
      const list = goal.openCriteria.map((s) => `- ${s}`).join("\n");
      parts.push(zh ? `未完成验收项：\n${list}` : `Open acceptance criteria:\n${list}`);
    }
    if (extra) parts.push(zh ? `用户补充指示：${extra}` : `User follow-up: ${extra}`);
    parts.push(
      zh
        ? "先更新/执行剩余步骤，再收尾。收尾时输出结论 + 路径回执 + [DONE]；若无法完成则 [INCOMPLETE 原因]。"
        : "Continue remaining steps first, then close. Finish with conclusion + path receipts + [DONE]; if blocked use [INCOMPLETE reason].",
    );
    if (input) {
      input.value = "";
      input.setCssStyles({ height: "auto" });
    }
    await this.sendChatMessageText(parts.join("\n"), this.chat.focus);
  }

  /** Abandon a paused turn (true cancel). */
  private abandonPausedChat(): void {
    if (!this.chatPaused) return;
    this.chat.cancel();
    this.stopChat();
    void this.renderActiveTab();
  }

  /** Update the working row in place so a progress tick does not rebuild the composer. */
  private patchChatWorkingRow(): void {
    if (this.closed || this.activeTab !== "chat") return;
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
  isWritingBusy(): boolean { return this.chatThinking; }
  async startWriting(text: string, focus: ChatFocus): Promise<void> {
    this.activeTab = "chat";
    await this.renderActiveTab();
    await this.sendChatMessageText(text, focus);
  }

  private async sendChatMessageText(text: string, boundFocus?: ChatFocus | null): Promise<void> {
    const focus = boundFocus === undefined ? captureChatFocus(this.app.workspace) : boundFocus;
    await this.executeChat(text, focus);
  }

  private async executeChat(text: string, focus: ChatFocus | null, retry = false): Promise<void> {
    try {
      await this.chat.send(text, focus, { retry, contextLimit: this.chatContextLimit,
        onStart: () => { this.chatScrollToLatest = true; this.chatStatus = t("chat_working"); this.chatFocusOnRender = true; void this.renderActiveTab(); },
        onProgress: event => { this.chatStatus = this.formatChatProgress(event); this.patchChatWorkingRow(); },
        onFinish: () => {
          this.chatStatus = this.chatPaused ? t("chat_paused") : "";
          if (this.closed || this.activeTab !== "chat") return;
          this.chatFocusOnRender = !!this.contentContainer?.contains(document.activeElement);
          void this.renderActiveTab();
        },
      });
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
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

  /** Retry only the final user turn, preserving its original object. */
  private async regenerateResponse(prompt: string, focus?: ChatFocus): Promise<void> {
    await this.executeChat(prompt, focus || null, true);
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
      this.renderEmptyState(section, t("task_no_history"), t("task_no_history_hint"), "history");
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
        confirmAction(this.app, t("confirm_clear_history_title"), t("confirm_clear_history_body"), () => {
          aiTaskManager.clearHistory();
        });
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
    await openStreamWorkbench(this.app);
  }
}
