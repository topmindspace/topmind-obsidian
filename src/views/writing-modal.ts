import { Modal, Notice, Setting, FuzzySuggestModal, type TFile } from "obsidian";
import type TopmindPlugin from "../main.ts";
import { getLocale, t } from "../i18n/index.ts";
import { getKernel } from "../bridge/kernel-loader.ts";
import { prepareWritingDelivery, exportWritingDelivery } from "../services/writing-delivery.ts";
import { editorWriteConflict } from "../services/editor-context.ts";
import { WRITING_ACTIONS, WRITING_THEMES, type WritingPlatform, type WritingTheme } from "../generated/writing/article-renderer.mjs";
import { openSidebarDock } from "../services/view-openers.ts";
import { SidebarDockView } from "./sidebar-dock-view.ts";

export class WritingModal extends Modal {
  private actionId = "";
  private requirements = "";
  private output: "review" | "edit" = "review";
  private allowWeb = false;
  private platform: WritingPlatform = "wechat";
  private theme: WritingTheme = "minimal-ink";
  private generation = 0;
  constructor(private plugin: TopmindPlugin, private source: string) { super(plugin.app); }
  onOpen(): void { this.render(); }
  onClose(): void { this.generation++; this.contentEl.empty(); }
  private render(): void {
    const generation = ++this.generation;
    const { contentEl } = this;
    contentEl.empty(); this.modalEl.addClass("tm-writing-modal");
    contentEl.createEl("h2", { text: t("writing_title") });
    contentEl.createEl("p", { text: t("writing_setup_hint") });
    contentEl.createEl("p", { text: this.source || t("writing_choose_source"), cls: "tm-writing-source" });
    new Setting(contentEl).setName(t("writing_source")).addButton(button => button.setButtonText(t("writing_choose_source")).onClick(() => {
      const owner = this;
      new class extends FuzzySuggestModal<TFile> {
        getItems(): TFile[] { return owner.app.vault.getMarkdownFiles(); }
        getItemText(file: TFile): string { return file.path; }
        onChooseItem(file: TFile): void { owner.source = file.path; owner.render(); }
      }(this.app).open();
    }));
    contentEl.createEl("h3", { text: t("writing_ai_task") });
    const actions = contentEl.createDiv({ cls: "tm-writing-actions" });
    for (const action of WRITING_ACTIONS) {
      const button = actions.createEl("button", { text: getLocale().startsWith("zh") ? action.zh : action.en });
      button.setAttribute("aria-pressed", String(this.actionId === action.id));
      button.addEventListener("click", () => {
        this.actionId = action.id;
        if (["topmind-cover", "topmind-poster"].includes(action.id)) this.output = "review";
        this.render();
      });
    }
    const action = WRITING_ACTIONS.find(item => item.id === this.actionId);
    if (action) {
      contentEl.createEl("p", { text: t(`writing_action_${action.id}` as Parameters<typeof t>[0]) });
      new Setting(contentEl).setName(t("writing_requirements")).addTextArea(input => input.setValue(this.requirements).onChange(value => { this.requirements = value; }));
      new Setting(contentEl).setName(t("writing_result_mode")).addDropdown(dropdown => dropdown.addOptions(["topmind-cover", "topmind-poster"].includes(action.id) ? { review: t("writing_review_only") } : { review: t("writing_review_only"), edit: t("writing_edit_source") }).setValue(this.output).onChange(value => { this.output = value as "review" | "edit"; }));
      contentEl.createEl("p", { text: t("writing_task_scope", { path: this.source || t("writing_choose_source") }), cls: "tm-writing-source" });
      new Setting(contentEl).setName(t("writing_allow_web")).addToggle(toggle => toggle.setValue(this.allowWeb).onChange(value => { this.allowWeb = value; }));
      new Setting(contentEl).addButton(button => button.setButtonText(t("writing_start")).setCta().setDisabled(!this.source).onClick(() => { void this.startAction(); }));
    }
    contentEl.createEl("h3", { text: t("writing_local_delivery") });
    new Setting(contentEl).setName(t("writing_format")).addDropdown(dropdown => dropdown.addOptions({ wechat: t("writing_wechat"), x: "X Article", text: t("writing_text") }).setValue(this.platform).onChange(value => { this.platform = value as WritingPlatform; this.render(); }));
    new Setting(contentEl).setName(t("writing_theme")).addDropdown(dropdown => dropdown.addOptions(Object.fromEntries(Object.keys(WRITING_THEMES).map(id => [id, id]))).setValue(this.theme).onChange(value => { this.theme = value as WritingTheme; this.render(); }));
    const controls = contentEl.createDiv({ cls: "tm-writing-actions" });
    const preview = controls.createEl("button", { text: t("writing_preview"), cls: "mod-cta" });
    const copy = controls.createEl("button", { text: t("writing_copy") }); copy.disabled = true;
    const exportButton = controls.createEl("button", { text: t("writing_export") }); exportButton.disabled = true;
    const status = contentEl.createEl("p", { attr: { role: "status" }, cls: "tm-writing-status" });
    const container = contentEl.createDiv();
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
    contentEl.createEl("p", { text: t("writing_boundary"), cls: "tm-writing-source" });
  }
  private async startAction(): Promise<void> {
    const action = WRITING_ACTIONS.find(item => item.id === this.actionId);
    if (!action || !this.source) return;
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
  }
}
