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
  constructor(private plugin: TopmindPlugin, private source = "") { super(plugin.app); this.source ||= captureChatFocus(this.app.workspace)?.path || ""; const preferred = plugin.settings?.writingTheme; if (preferred && Object.prototype.hasOwnProperty.call(WRITING_THEMES, preferred)) this.theme = preferred as WritingTheme; }
  onOpen(): void { this.render(); }
  onClose(): void { this.generation++; this.contentEl.empty(); }
  private render(): void {
    const generation = ++this.generation;
    const { contentEl } = this;
    contentEl.empty(); this.modalEl.addClass("tm-writing-modal");
    contentEl.createEl("h2", { text: t("writing_title") });
    const sourceCard = contentEl.createDiv({ cls: "tm-writing-source-card" });
    const activePath = captureChatFocus(this.app.workspace)?.path;
    sourceCard.createEl("span", { text: this.source === activePath ? t("writing_active_note") : t("writing_source"), cls: "tm-writing-source" });
    sourceCard.createEl("h3", { text: this.source.split("/").pop() || t("writing_choose_source"), cls: "tm-writing-source-title" });
    if (this.source) sourceCard.createEl("p", { text: this.source, cls: "tm-writing-source" });
    if (activePath && this.source !== activePath) {
      const activeButton = sourceCard.createEl("button", { text: t("writing_use_active"), cls: "tm-chip" });
      activeButton.addEventListener("click", () => { this.source = activePath; this.render(); });
    }
    new Setting(sourceCard).setName(t("writing_source")).addButton(button => button.setButtonText(t("writing_choose_source")).onClick(() => {
      const owner = this;
      new class extends FuzzySuggestModal<TFile> {
        getItems(): TFile[] { return owner.app.vault.getMarkdownFiles(); }
        getItemText(file: TFile): string { return file.path; }
        onChooseItem(file: TFile): void { owner.source = file.path; owner.render(); }
      }(this.app).open();
    }));
    const tabs = contentEl.createDiv({ cls: "tm-writing-tabs", attr: { role: "tablist", "aria-label": t("writing_title") } });
    for (const id of ["write", "preview"] as const) {
      const button = tabs.createEl("button", { text: t(id === "write" ? "writing_ai_task" : "writing_local_delivery"), attr: { role: "tab", id: `tm-writing-tab-${id}`, "aria-selected": String(this.tab === id), "aria-controls": "tm-writing-panel", tabindex: this.tab === id ? "0" : "-1" } });
      const choose = (next: "write" | "preview") => { this.tab = next; this.render(); this.contentEl.querySelector<HTMLElement>(`#tm-writing-tab-${next}`)?.focus(); };
      button.addEventListener("click", () => choose(id));
      button.addEventListener("keydown", event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); choose(event.key === "Home" ? "write" : event.key === "End" ? "preview" : id === "write" ? "preview" : "write"); }
      });
    }
    const panel = contentEl.createDiv({ cls: "tm-writing-panel", attr: { role: "tabpanel", id: "tm-writing-panel", "aria-labelledby": `tm-writing-tab-${this.tab}` } });
    if (this.tab === "write") {
    const actions = panel.createDiv({ cls: "tm-writing-actions-grid" });
    const groups = [
      { title: t("writing_group_refine"), ids: ["topmind-revise", "topmind-format"] },
      { title: t("writing_group_adapt"), ids: ["topmind-briefs", "topmind-viral-posts", "topmind-wechat-post", "topmind-x-article"] },
      { title: t("writing_group_visual"), ids: ["topmind-cover", "topmind-poster"] },
    ];
    for (const group of groups) {
      const section = actions.createDiv({ cls: "tm-writing-action-group" });
      section.createEl("h4", { text: group.title });
      const buttons = section.createDiv({ cls: "tm-writing-actions" });
      for (const action of WRITING_ACTIONS.filter(item => group.ids.includes(item.id))) {
        const button = buttons.createEl("button", { text: getLocale().startsWith("zh") ? action.zh : action.en, attr: { "aria-pressed": String(this.actionId === action.id), "data-writing-action": action.id } });
        button.addEventListener("click", () => {
          this.actionId = action.id;
          if (["topmind-cover", "topmind-poster"].includes(action.id)) this.output = "review";
          this.render(); this.contentEl.querySelector<HTMLElement>(`[data-writing-action="${action.id}"]`)?.focus();
        });
      }
    }
    const action = WRITING_ACTIONS.find(item => item.id === this.actionId);
    if (action) {
      panel.createEl("p", { text: t(`writing_action_${action.id}` as Parameters<typeof t>[0]) });
      new Setting(panel).setName(t("writing_requirements")).addTextArea(input => input.setValue(this.requirements).onChange(value => { this.requirements = value; }));
      new Setting(panel).setName(t("writing_result_mode")).addDropdown(dropdown => dropdown.addOptions(["topmind-cover", "topmind-poster"].includes(action.id) ? { review: t("writing_review_only") } : { review: t("writing_review_only"), edit: t("writing_edit_source") }).setValue(this.output).onChange(value => { this.output = value as "review" | "edit"; }));
      panel.createEl("p", { text: t("writing_context_hint"), cls: "tm-writing-source" });
      new Setting(panel).setName(t("writing_allow_web")).addToggle(toggle => toggle.setValue(this.allowWeb).onChange(value => { this.allowWeb = value; }));
      new Setting(panel).addButton(button => button.setButtonText(t("writing_start")).setCta().setDisabled(!this.source).onClick(() => { void this.startAction(); }));
    }
    return;
    }
    panel.createEl("p", { text: t("writing_preview_hint"), cls: "tm-writing-source" });

    new Setting(panel).setName(t("writing_format")).addDropdown(dropdown => dropdown.addOptions({ wechat: t("writing_wechat"), x: "X Article", text: t("writing_text") }).setValue(this.platform).onChange(value => { this.platform = value as WritingPlatform; this.render(); }));
    new Setting(panel).setName(t("writing_theme")).addDropdown(dropdown => dropdown.addOptions(Object.fromEntries(Object.keys(WRITING_THEMES).map(id => [id, t(`writing_theme_${id}` as Parameters<typeof t>[0])]))).setValue(this.theme).onChange(value => { this.theme = value as WritingTheme; this.render(); }));
    const controls = panel.createDiv({ cls: "tm-writing-actions" });
    const preview = controls.createEl("button", { text: t("writing_preview"), cls: "mod-cta" });
    const copy = controls.createEl("button", { text: t("writing_copy") }); copy.disabled = true;
    const exportButton = controls.createEl("button", { text: t("writing_export") }); exportButton.disabled = true;
    const status = panel.createEl("p", { attr: { role: "status" }, cls: "tm-writing-status" });
    const container = panel.createDiv();
    let prepared: Awaited<ReturnType<typeof prepareWritingDelivery>> | null = null;
    const root = this.plugin.kernelService.getVaultPath();
    const check = () => { const conflict = editorWriteConflict(this.app.workspace, root, [this.source]); if (conflict) throw new Error(conflict); };
    preview.disabled = !this.source;
    preview.addEventListener("click", () => { void (async () => {
      preview.disabled = true; copy.disabled = true; exportButton.disabled = true;
      try {
        check(); const next = await prepareWritingDelivery(root, this.source, this.platform, this.theme);
        if (generation !== this.generation) return;
        prepared = next; container.empty();
        if (this.platform === "text") container.createEl("pre", { text: next.delivery.text, cls: "tm-writing-text" });
        else { const frame = container.createEl("iframe", { attr: { title: t("writing_preview"), sandbox: "" }, cls: "tm-writing-preview" }); frame.srcdoc = next.delivery.html; }
        status.textContent = next.delivery.diagnostics.length ? t("writing_review", { count: next.delivery.diagnostics.length }) : t("writing_ready");
        if (next.delivery.images.length) container.createEl("pre", { text: next.delivery.checklist, cls: "tm-writing-text" });
        copy.disabled = false; exportButton.disabled = false;
      } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
      finally { preview.disabled = false; }
    })(); });
    const current = async () => {
      if (!prepared) throw new Error("preview-required"); check();
      const next = await prepareWritingDelivery(root, this.source, this.platform, this.theme);
      if (generation !== this.generation) throw new Error(t("writing_stale"));
      if (next.sourceHash !== prepared.sourceHash || next.delivery.html !== prepared.delivery.html) throw new Error(t("writing_stale"));
      return prepared;
    };
    copy.addEventListener("click", () => { void (async () => {
      try { const item = await current();
        if (this.platform === "text") await navigator.clipboard.writeText(item.delivery.text);
        else await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([item.delivery.body], { type: "text/html" }), "text/plain": new Blob([item.delivery.text], { type: "text/plain" }) })]);
        status.textContent = t("writing_copied");
      } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    })(); });
    exportButton.addEventListener("click", () => { void (async () => {
      try { const item = await current();
        const result = exportWritingDelivery({ kernel: getKernel(), workspaceRoot: root }, this.source, item.sourceHash, item.delivery);
        status.textContent = result.relativePath; this.plugin.kernelService.notifyFilesChanged([result.relativePath]); new Notice(t("writing_exported"));
      } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    })(); });
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
      const text = `${prompt}\n${zh ? "目标文章" : "Target article"}：${source}\n${this.output === "review" ? t("writing_review_only") : t("writing_edit_source")}\n${this.requirements}`;
      const focus = { path: source, taskIntent: { targetPath: source, skillId: action.id, output: this.output, allowWeb: this.allowWeb } };
      const leaf = await openSidebarDock(this.app);
      if (!(leaf?.view instanceof SidebarDockView)) throw new Error(t("writing_sidebar_unavailable"));
      if (leaf.view.isWritingBusy()) throw new Error(t("chat_working"));
      this.close();
      await leaf.view.startWriting(text, focus);
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    finally { this.starting = false; }
  }
}
