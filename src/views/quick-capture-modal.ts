// ── Quick Capture Modal: zero-friction capture ─────────────────────────────
//
// Design: open → focus → type → Enter → done.
// Esc closes without saving. Tab works naturally (textarea → tag input → target).
// Auto-resize textarea. Visual feedback on submit.
// Enhanced: better visual polish, keyboard hints, URL detection indicator.

import { Modal, Notice, setIcon } from "obsidian";
import type TopmindPlugin from "../main";
import { t } from "../i18n";
import type { CaptureTarget } from "../types";
import { bindImeEnterGuard, extractTags, isImeEnter, isLoneUrlCapture } from "../utils";

export class QuickCaptureModal extends Modal {
  plugin: TopmindPlugin;
  private submitting = false;
  private closed = false;
  private targetChosen = false;
  private urlAutoRouted = false;
  private fetchBtn: HTMLButtonElement | null = null;
  textarea!: HTMLTextAreaElement;
  targetSelect!: HTMLSelectElement;
  tagInput!: HTMLInputElement;
  submitBtn!: HTMLButtonElement;
  urlHintEl: HTMLElement | null = null;
  charCountEl: HTMLElement | null = null;

  constructor(app: import("obsidian").App, plugin: TopmindPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    this.closed = false;
    this.submitting = false;
    this.targetChosen = false;
    this.urlAutoRouted = false;
    modalEl.addClass("tm-quick-capture-modal");
    contentEl.empty();
    contentEl.addClass("tm-quick-capture-content");

    // Title with icon
    const titleDiv = contentEl.createDiv({ cls: "tm-modal-title" });
    const titleIcon = titleDiv.createSpan({ cls: "tm-modal-icon" });
    setIcon(titleIcon, "pencil");
    titleDiv.createSpan({ text: t("quick_capture_title") });

    // Textarea with wrapper for char count
    const textareaWrap = contentEl.createDiv({ cls: "tm-quick-capture-textarea-wrap" });
    this.textarea = textareaWrap.createEl("textarea", {
      cls: "tm-quick-capture-textarea",
      attr: { placeholder: t("quick_capture_placeholder"), rows: "3", autofocus: "true", "aria-label": t("quick_capture_title") },
    });

    // Character count + URL hint
    const metaBar = textareaWrap.createDiv({ cls: "tm-quick-capture-meta" });
    this.urlHintEl = metaBar.createSpan({ cls: "tm-url-hint tm-url-hint-hidden" });
    const urlIcon = this.urlHintEl.createSpan({ cls: "tm-url-hint-icon" });
    setIcon(urlIcon, "link");
    this.urlHintEl.createSpan({ text: t("compose_url_hint") });
    const fetchBtn = this.urlHintEl.createEl("button", {
      cls: "tm-url-fetch-btn",
      text: t("compose_url_fetch"),
    });
    this.fetchBtn = fetchBtn;
    fetchBtn.addEventListener("click", () => {
      void this.fetchUrlToInbox(fetchBtn);
    });

    this.charCountEl = metaBar.createSpan({ cls: "tm-char-count" });
    this.charCountEl.textContent = "0";
    this.charCountEl.setAttribute("aria-hidden", "true");

    // Footer
    const footer = contentEl.createDiv({ cls: "tm-quick-capture-footer" });

    // Left: target + tags
    const leftDiv = footer.createDiv({ cls: "tm-footer-left" });

    const targetDiv = leftDiv.createDiv({ cls: "tm-quick-capture-target" });
    const targetLabel = targetDiv.createEl("label", { text: t("quick_capture_target"), cls: "tm-footer-label" });
    this.targetSelect = targetDiv.createEl("select");
    this.targetSelect.id = "tm-quick-capture-target";
    targetLabel.setAttribute("for", this.targetSelect.id);
    this.targetSelect.createEl("option", { value: "stream", text: t("quick_capture_target_stream") });
    this.targetSelect.createEl("option", { value: "inbox", text: t("quick_capture_target_inbox") });

    const tagDiv = leftDiv.createDiv({ cls: "tm-quick-capture-tags" });
    const tagLabel = tagDiv.createEl("label", { text: t("quick_capture_tags"), cls: "tm-footer-label" });
    this.tagInput = tagDiv.createEl("input", {
      cls: "tm-tag-input",
      attr: { type: "text", placeholder: t("quick_capture_tags_placeholder") },
    });
    this.tagInput.id = "tm-quick-capture-tags";
    tagLabel.setAttribute("for", this.tagInput.id);

    // Right: hints + submit
    const rightDiv = footer.createDiv({ cls: "tm-footer-right" });
    rightDiv.createSpan({
      text: `${t("quick_capture_hint_enter_note")}  ${t("quick_capture_hint_shift_enter")}`,
      cls: "tm-hint",
    });

    this.submitBtn = footer.createEl("button", {
      text: t("quick_capture_note_it"),
      cls: "tm-submit-btn mod-cta",
    });
    this.submitBtn.setAttribute("aria-label", t("quick_capture_note_it"));
    this.submitBtn.disabled = true;

    // Focus input
    window.setTimeout(() => this.textarea.focus(), 50);

    // Auto-grow textarea + char count + URL detection
    this.textarea.addEventListener("input", () => {
      this.textarea.setCssStyles({ height: "auto" });
      this.textarea.setCssStyles({ height: `${Math.min(this.textarea.scrollHeight, 300)}px` });
      this.updateCharCount();
      this.updateUrlHint();
      this.updateSubmitState();
    });

    // Enter submits, Shift+Enter newline. IME candidate confirm must not submit.
    const captureIme = bindImeEnterGuard(this.textarea);
    this.textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        if (isImeEnter(e, captureIme)) return;
        e.preventDefault();
        this.submit();
      }
      // Esc closes without saving
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    // Submit button
    this.submitBtn.addEventListener("click", () => this.submit());

    // Target change — manual override removes URL hint
    this.targetSelect.addEventListener("change", () => {
      this.targetChosen = true;
      this.urlAutoRouted = false;
      if (this.urlHintEl && this.targetSelect.value !== "inbox") {
        this.urlHintEl.addClass("tm-url-hint-hidden");
      }
    });
  }

  private updateCharCount(): void {
    if (!this.charCountEl) return;
    const len = this.textarea.value.length;
    // Quiet by design (UI/UX 2.0 §27): stay hidden until the limit is in play.
    const softLimit = 2000;
    const warnAt = Math.floor(softLimit * 0.8);
    const visible = len >= warnAt;
    this.charCountEl.textContent = String(len);
    this.charCountEl.classList.toggle("tm-char-count-visible", visible);
    this.charCountEl.classList.toggle("tm-char-count-warn", len >= softLimit);
    // Hidden counter is decorative; once visible it is real status for AT.
    if (visible) this.charCountEl.removeAttribute("aria-hidden");
    else this.charCountEl.setAttribute("aria-hidden", "true");
  }

  private updateSubmitState(): void {
    this.submitBtn.disabled = this.submitting || !this.textarea.value.trim();
  }

  private setBusy(busy: boolean): void {
    this.submitting = busy;
    this.textarea.disabled = busy;
    this.tagInput.disabled = busy;
    this.targetSelect.disabled = busy;
    if (this.fetchBtn) this.fetchBtn.disabled = busy;
    this.updateSubmitState();
  }

  private updateUrlHint(): void {
    if (!this.urlHintEl) return;
    const isUrl = isLoneUrlCapture(this.textarea.value.trim());
    this.urlHintEl.classList.toggle("tm-url-hint-hidden", !isUrl);
    if (isUrl && !this.targetChosen) {
      this.targetSelect.value = "inbox";
      this.urlAutoRouted = true;
    } else if (!isUrl && this.urlAutoRouted) {
      this.targetSelect.value = "stream";
      this.urlAutoRouted = false;
    }
  }

  /** 抓取 → Inbox 独立文章（Desktop handleFetchToInbox parity）。 */
  private async fetchUrlToInbox(btn: HTMLButtonElement): Promise<void> {
    const text = this.textarea.value.trim();
    if (!text || !isLoneUrlCapture(text) || this.submitting) return;
    const original = btn.textContent;
    this.setBusy(true);
    btn.textContent = t("compose_url_fetching");
    try {
      const result = await this.plugin.kernelService.fetchUrlForCapture(text);
      if (this.closed) return;
      if (!result.ok) {
        new Notice(`${t("compose_url_fetch_fail")}: ${result.error || ""}`);
        return;
      }
      const body = this.plugin.kernelService.buildFetchMarkdown(result);
      const res = this.plugin.kernelService.capture(body, { target: "inbox", tags: [] });
      // capture() already toasts written / pending / failed with path.
      if (res.ok) {
        this.modalEl.addClass("tm-modal-submitted");
        window.setTimeout(() => this.close(), 120);
      }
    } catch (err) {
      console.error("[topmind] quick-capture fetch failed:", err);
      new Notice(t("compose_url_fetch_fail"));
    } finally {
      if (!this.closed) { this.setBusy(false); btn.textContent = original; }
    }
  }

  private submit(): void {
    if (this.submitting) return;
    const text = this.textarea.value.trim();
    if (!text) return;

    const target = this.targetSelect.value as CaptureTarget;

    // Merge auto-extracted tags with manually entered tags
    let tags = this.plugin.settings.autoTag ? extractTags(text) : [];
    const manualTags = extractTags(this.tagInput.value);
    const existing = new Set(tags.map((t) => t.toLowerCase()));
    for (const mt of manualTags) {
      if (!existing.has(mt.toLowerCase())) {
        tags.push(mt);
        existing.add(mt.toLowerCase());
      }
    }

    // Disable during write
    this.setBusy(true);
    this.submitBtn.empty();
    this.submitBtn.createSpan({ cls: "tm-btn-spinner" });

    try {
      const result = this.plugin.kernelService.capture(text, { target, tags });
      if (result.ok) {
        this.modalEl.addClass("tm-modal-submitted");
        window.setTimeout(() => this.close(), 120);
        return;
      }
    } catch {
      new Notice(t("notice_write_failed"));
    }
    this.setBusy(false);
    this.submitBtn.empty();
    this.submitBtn.textContent = t("quick_capture_note_it");
    this.textarea.focus();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }
}
