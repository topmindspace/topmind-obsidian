import { Modal, Notice, Setting } from "obsidian";
import type TopmindPlugin from "../main.ts";
import { getLocale, t } from "../i18n/index.ts";
import { getKernel } from "../bridge/kernel-loader.ts";
import { prepareWritingDelivery, exportWritingDelivery } from "../services/writing-delivery.ts";
import { editorWriteConflict } from "../services/editor-context.ts";
import { WRITING_ACTIONS, WRITING_THEMES, type WritingPlatform, type WritingTheme } from "../generated/writing/article-renderer.mjs";
import { openSidebarDock } from "../services/view-openers.ts";
import { SidebarDockView } from "./sidebar-dock-view.ts";

export class WritingModal extends Modal {
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
    contentEl.createEl("p", { text: this.source || t("writing_choose_source"), cls: "tm-writing-source" });
    const actions = contentEl.createDiv({ cls: "tm-writing-actions" });
    for (const action of WRITING_ACTIONS) {
      const button = actions.createEl("button", { text: getLocale().startsWith("zh") ? action.zh : action.en });
      button.addEventListener("click", () => {
        this.close();
        void openSidebarDock(this.app).then(leaf => {
          if (leaf?.view instanceof SidebarDockView) void leaf.view.startWriting(`${getLocale().startsWith("zh") ? action.prompt : action.promptEn}\nSource：${this.source}`);
        });
      });
    }
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
}
