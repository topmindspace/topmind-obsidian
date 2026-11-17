import { Modal, Notice, Setting, FuzzySuggestModal, type TFile } from "obsidian";
import type TopmindPlugin from "../main.ts";
import { getLocale, t } from "../i18n/index.ts";
import { getKernel } from "../bridge/kernel-loader.ts";
import { prepareWritingDelivery, exportWritingDelivery } from "../services/writing-delivery.ts";
import { captureChatFocus, editorWriteConflict } from "../services/editor-context.ts";
import { WRITING_ACTIONS, WRITING_THEMES, type WritingPlatform, type WritingTheme } from "../generated/writing/article-renderer.mjs";
import { openSidebarDock } from "../services/view-openers.ts";
import { SidebarDockView } from "./sidebar-dock-view.ts";

export class WritingModal extends Modal {
  private actionId = "topmind-revise";
  private tab: "write" | "preview" = "write";
  private requirements = "";
  private output: "review" | "edit" = "review";
  private allowWeb = false;
  private platform: WritingPlatform = "wechat";
  private theme: WritingTheme = "minimal-ink";
  private generation = 0;
  private starting = false;
  private moreOpen = false;
  private settingsOpen = false;
  constructor(private plugin: TopmindPlugin, private source = "") { super(plugin.app); this.source ||= captureChatFocus(this.app.workspace)?.path || ""; const preferred = plugin.settings?.writingTheme; if (preferred && Object.prototype.hasOwnProperty.call(WRITING_THEMES, preferred)) this.theme = preferred as WritingTheme; }
  onOpen(): void { this.render(); }
  onClose(): void { this.generation++; this.contentEl.empty(); }

  private renderAndFocus(selector: string): void {
    this.render();
    this.contentEl.querySelector<HTMLElement>(selector)?.focus();
  }

  private render(): void {
    const generation = ++this.generation;
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("tm-writing-modal");
    this.modalEl.classList.toggle("tm-writing-modal-preview", this.tab === "preview");
    contentEl.createEl("h2", { text: t("writing_title") });
    const sourceCard = contentEl.createDiv({ cls: "tm-writing-source-card" });
    const activePath = captureChatFocus(this.app.workspace)?.path;
    const sourceText = sourceCard.createDiv({ cls: "tm-writing-source-text" });
    sourceText.createSpan({ text: this.source === activePath ? t("writing_active_note") : t("writing_source"), cls: "tm-writing-source" });
    sourceText.createDiv({ text: this.source.split("/").pop() || t("writing_choose_source"), cls: "tm-writing-source-title" });
    if (this.source) sourceText.createDiv({ text: this.source, cls: "tm-writing-source tm-writing-source-path" });
    const sourceActions = sourceCard.createDiv({ cls: "tm-writing-source-actions" });
    if (activePath && this.source !== activePath) {
      const activeButton = sourceActions.createEl("button", { text: t("writing_use_active"), cls: "tm-chip" });
      activeButton.addEventListener("click", () => { this.source = activePath; this.renderAndFocus("[data-writing-choose-source]"); });
    }
    const chooseSource = sourceActions.createEl("button", { text: t("writing_choose_source"), cls: "tm-chip", attr: { "data-writing-choose-source": "" } });
    chooseSource.addEventListener("click", () => {
      const owner = this;
      new class extends FuzzySuggestModal<TFile> {
        getItems(): TFile[] { return owner.app.vault.getMarkdownFiles(); }
        getItemText(file: TFile): string { return file.path; }
        onChooseItem(file: TFile): void { owner.source = file.path; owner.renderAndFocus("[data-writing-choose-source]"); }
      }(this.app).open();
    });
    const tabs = contentEl.createDiv({ cls: "tm-writing-tabs", attr: { role: "tablist", "aria-label": t("writing_title") } });
    for (const id of ["write", "preview"] as const) {
      const button = tabs.createEl("button", { text: t(id === "write" ? "writing_ai_task" : "writing_local_delivery"), attr: { role: "tab", id: `tm-writing-tab-${id}`, "aria-selected": String(this.tab === id), "aria-controls": "tm-writing-panel", tabindex: this.tab === id ? "0" : "-1" } });
      const choose = (next: "write" | "preview") => { this.tab = next; this.renderAndFocus(`#tm-writing-tab-${next}`); };
      button.addEventListener("click", () => choose(id));
      button.addEventListener("keydown", event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); choose(event.key === "Home" ? "write" : event.key === "End" ? "preview" : id === "write" ? "preview" : "write"); }
      });
    }
    const panel = contentEl.createDiv({ cls: "tm-writing-panel", attr: { role: "tabpanel", id: "tm-writing-panel", "aria-labelledby": `tm-writing-tab-${this.tab}` } });
    if (this.tab === "write") {
    panel.createEl("p", { text: t("writing_pick_action"), cls: "tm-writing-intro" });
    const primaryIds = ["topmind-revise", "topmind-briefs", "topmind-wechat-post", "topmind-x-article"];
    const moreIds = ["topmind-format", "topmind-viral-posts", "topmind-cover", "topmind-poster"];
    const renderChoice = (parent: HTMLElement, action: (typeof WRITING_ACTIONS)[number]) => {
      const titleId = `tm-writing-title-${action.id}`;
      const descriptionId = `tm-writing-description-${action.id}`;
      const button = parent.createEl("button", {
        cls: "tm-writing-choice",
        attr: { type: "button", "aria-pressed": String(this.actionId === action.id), "aria-labelledby": titleId, "aria-describedby": descriptionId, "data-writing-action": action.id },
      });
      button.createSpan({ text: getLocale().startsWith("zh") ? action.zh : action.en, cls: "tm-writing-choice-title", attr: { id: titleId } });
      button.createSpan({ text: t(`writing_action_${action.id}` as Parameters<typeof t>[0]), cls: "tm-writing-choice-desc", attr: { id: descriptionId } });
      button.addEventListener("click", () => {
        this.actionId = action.id;
        if (!["topmind-revise", "topmind-format"].includes(action.id)) this.output = "review";
        this.renderAndFocus(`[data-writing-action="${action.id}"]`);
      });
    };
    const primary = panel.createDiv({ cls: "tm-writing-actions-grid" });
    for (const action of WRITING_ACTIONS.filter(item => primaryIds.includes(item.id))) renderChoice(primary, action);
    const more = panel.createEl("details", { cls: "tm-writing-more" });
    more.open = this.moreOpen || moreIds.includes(this.actionId);
    more.addEventListener("toggle", () => { this.moreOpen = more.open; });
    more.createEl("summary", { text: t("writing_more_actions") });
    const moreGrid = more.createDiv({ cls: "tm-writing-actions-grid" });
    for (const action of WRITING_ACTIONS.filter(item => moreIds.includes(item.id))) renderChoice(moreGrid, action);
    const action = WRITING_ACTIONS.find(item => item.id === this.actionId);
    if (action) {
      new Setting(panel).setName(t("writing_requirements")).addTextArea(input => input.setValue(this.requirements).onChange(value => { this.requirements = value; }));
      if (["topmind-revise", "topmind-format"].includes(action.id)) {
        new Setting(panel).setName(t("writing_result_mode")).addDropdown(dropdown => dropdown.addOptions({ review: t("writing_review_only"), edit: t("writing_edit_source") }).setValue(this.output).onChange(value => { this.output = value as "review" | "edit"; }));
      }
      const settings = panel.createEl("details", { cls: "tm-writing-more" });
      settings.open = this.settingsOpen;
      settings.addEventListener("toggle", () => { this.settingsOpen = settings.open; });
      settings.createEl("summary", { text: t("writing_more_settings") });
      new Setting(settings).setName(t("writing_allow_web")).addToggle(toggle => toggle.setValue(this.allowWeb).onChange(value => { this.allowWeb = value; }));
      settings.createEl("p", { text: t("writing_context_hint"), cls: "tm-writing-source" });
      const footer = panel.createDiv({ cls: "tm-writing-footer" });
      if (!this.source) footer.createSpan({ text: t("writing_choose_source_first"), cls: "tm-writing-source" });
      const start = footer.createEl("button", { text: t("writing_start"), cls: "mod-cta" });
      start.disabled = !this.source || this.starting;
      start.addEventListener("click", () => { void this.startAction(); });
    }
    return;
    }
    panel.createEl("p", { text: t("writing_preview_hint"), cls: "tm-writing-source" });

    new Setting(panel).setName(t("writing_format")).addDropdown(dropdown => {
      dropdown.selectEl.setAttribute("data-writing-format", "");
      dropdown.addOptions({ wechat: t("writing_wechat"), x: "X Article", text: t("writing_text") })
        .setValue(this.platform).onChange(value => { this.platform = value as WritingPlatform; this.renderAndFocus("[data-writing-format]"); });
    });
    new Setting(panel).setName(t("writing_theme")).addDropdown(dropdown => {
      dropdown.selectEl.setAttribute("data-writing-theme", "");
      dropdown.addOptions(Object.fromEntries(Object.keys(WRITING_THEMES).map(id => [id, t(`writing_theme_${id}` as Parameters<typeof t>[0])])))
        .setValue(this.theme).onChange(value => { this.theme = value as WritingTheme; this.renderAndFocus("[data-writing-theme]"); });
    });
    const preview = panel.createEl("button", { text: t("writing_preview"), cls: "mod-cta tm-writing-generate" });
    const diagnostics = panel.createDiv();
    const controls = panel.createDiv({ cls: "tm-writing-actions" });
    const copy = controls.createEl("button", { text: t("writing_copy") });
    const exportButton = controls.createEl("button", { text: t("writing_export") });
    const status = panel.createEl("p", { attr: { role: "status" }, cls: "tm-writing-status" });
    const container = panel.createDiv();
    let prepared: Awaited<ReturnType<typeof prepareWritingDelivery>> | null = null;
    let busy = false;
    const root = this.plugin.kernelService.getVaultPath();
    const source = this.source;
    const { platform, theme } = this;
    const check = () => { const conflict = editorWriteConflict(this.app.workspace, root, [source]); if (conflict) throw new Error(conflict); };
    const syncControls = () => {
      preview.disabled = busy || !source;
      copy.disabled = busy || !prepared;
      exportButton.disabled = copy.disabled;
    };
    const setStatus = (text: string, kind = "success") => { status.textContent = text; status.dataset.kind = kind; };
    const clearPreview = () => { prepared = null; diagnostics.empty(); container.empty(); };
    const perform = async (operation: () => Promise<void>) => {
      if (busy) return;
      busy = true; syncControls(); setStatus("");
      try { await operation(); }
      catch (error) {
        if (generation === this.generation) setStatus(error instanceof Error ? error.message : String(error), "error");
      } finally { busy = false; syncControls(); }
    };
    syncControls();
    preview.addEventListener("click", () => { void perform(async () => {
      clearPreview(); check();
      const next = await prepareWritingDelivery(root, source, platform, theme);
      if (generation !== this.generation) return;
      prepared = next;
      const { delivery } = next;
      if (delivery.diagnostics.length) {
        const checks = diagnostics.createDiv({ cls: "tm-writing-checks", attr: { "data-writing-checks": "" } });
        checks.createEl("p", { text: t("writing_review", { count: delivery.diagnostics.length }) });
        const list = checks.createEl("ul");
        for (const code of new Set(delivery.diagnostics.map(item => item.code))) {
          list.createEl("li", { text: t(`writing_diagnostic_${code}` as Parameters<typeof t>[0]) });
        }
      } else setStatus(t("writing_ready"));
      if (delivery.images.length) {
        const details = diagnostics.createEl("details", { cls: "tm-writing-more", attr: { "data-writing-images": "" } });
        details.open = delivery.images.some(image => image.status === "missing");
        details.createEl("summary", { text: t("writing_images", { count: delivery.images.length }) });
        const list = details.createEl("ul", { cls: "tm-writing-images" });
        for (const image of delivery.images) {
          const row = list.createEl("li");
          row.createSpan({ text: t(`writing_image_${image.status}` as Parameters<typeof t>[0]), cls: image.status === "missing" ? "tm-writing-missing" : "" });
          row.createEl("code", { text: image.source });
        }
      }
      if (platform === "text") container.createEl("pre", { text: delivery.text, cls: "tm-writing-text" });
      else { const frame = container.createEl("iframe", { attr: { title: t("writing_preview"), sandbox: "" }, cls: "tm-writing-preview" }); frame.srcdoc = delivery.html; }
    }); });
    const current = async () => {
      const item = prepared;
      if (!item) return null;
      check();
      const next = await prepareWritingDelivery(root, source, platform, theme);
      if (generation !== this.generation) return null;
      if (next.sourceHash !== item.sourceHash || next.delivery.html !== item.delivery.html) {
        clearPreview();
        throw new Error(t("writing_stale"));
      }
      check();
      return item;
    };
    copy.addEventListener("click", () => { void perform(async () => {
        const item = await current();
        if (!item) return;
        if (platform === "text") await navigator.clipboard.writeText(item.delivery.text);
        else await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([item.delivery.body], { type: "text/html" }), "text/plain": new Blob([item.delivery.text], { type: "text/plain" }) })]);
        if (generation === this.generation) setStatus(t("writing_copied"));
    }); });
    exportButton.addEventListener("click", () => { void perform(async () => {
        const item = await current();
        if (!item) return;
        const result = exportWritingDelivery({ kernel: getKernel(), workspaceRoot: root }, source, item.sourceHash, item.delivery);
        const checklist = result.checklist;
        const changedPaths = checklist?.ok ? [result.relativePath, checklist.relativePath] : [result.relativePath];
        this.plugin.kernelService.notifyFilesChanged(changedPaths);
        if (checklist && !checklist.ok) {
          setStatus(t("writing_export_partial", { path: result.relativePath, checklistPath: checklist.relativePath }), "error");
        } else {
          setStatus(checklist ? t("writing_export_with_checklist", { path: result.relativePath, checklistPath: checklist.relativePath }) : t("writing_export_path", { path: result.relativePath }));
        }
        status.scrollIntoView({ block: "nearest" });
    }); });
    panel.createEl("p", { text: t("writing_boundary"), cls: "tm-writing-source" });
  }
  private async startAction(): Promise<void> {
    const action = WRITING_ACTIONS.find(item => item.id === this.actionId);
    if (!action || !this.source || this.starting) return;
    this.starting = true;
    try {
      const source = this.source;
      const root = this.plugin.kernelService.getVaultPath();
      const conflict = editorWriteConflict(this.app.workspace, root, [source]);
      if (conflict) throw new Error(conflict);
      const zh = getLocale().startsWith("zh");
      const prompt = action.id === "topmind-cover" ? (zh ? "按 topmind-cover，只准备封面提示词和构图方案，不生成图片。" : "Use topmind-cover to prepare a cover prompt only; do not generate images.")
        : action.id === "topmind-poster" ? (zh ? "按 topmind-poster，只提供 HTML 排版方案，不生成 PNG。" : "Use topmind-poster to provide HTML/layout only; do not generate PNG.")
        : zh ? action.prompt : action.promptEn;
      const output = ["topmind-revise", "topmind-format"].includes(action.id) ? this.output : "review";
      const text = `${prompt}\n${zh ? "目标文章" : "Target article"}：${source}\n${output === "review" ? t("writing_review_only") : t("writing_edit_source")}${this.requirements.trim() ? `\n${this.requirements.trim()}` : ""}`;
      const focus = { path: source, taskIntent: { targetPath: source, skillId: action.id, output, allowWeb: this.allowWeb } };
      const leaf = await openSidebarDock(this.app);
      if (!(leaf?.view instanceof SidebarDockView)) throw new Error(t("writing_sidebar_unavailable"));
      if (leaf.view.isWritingBusy()) throw new Error(t("chat_working"));
      this.close();
      await leaf.view.startWriting(text, focus);
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    finally { this.starting = false; }
  }
}
