// ── Shared confirm gate for irreversible / destructive UI actions ───────────
//
// Used by views (new chat, clear history, clear todos) and settings.
// Keep this tiny — Obsidian Modal + two buttons, no custom chrome.

import { Modal, type App as ObsidianApp } from "obsidian";
import { t } from "../i18n";

export class ConfirmModal extends Modal {
  constructor(
    app: ObsidianApp,
    private readonly titleText: string,
    private readonly bodyText: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.createEl("h3", { text: this.titleText });
    this.contentEl.createEl("p", { text: this.bodyText });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = buttons.createEl("button", { text: t("dialog_cancel") });
    cancelBtn.addEventListener("click", () => this.close());
    const confirmBtn = buttons.createEl("button", {
      text: t("dialog_confirm"),
      cls: "mod-warning",
    });
    confirmBtn.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Open a confirm dialog; run `onConfirm` only on explicit confirm. */
export function confirmAction(
  app: ObsidianApp,
  title: string,
  body: string,
  onConfirm: () => void,
): void {
  new ConfirmModal(app, title, body, onConfirm).open();
}
