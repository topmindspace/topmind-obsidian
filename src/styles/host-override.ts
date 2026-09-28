/**
 * Host-override CSS — leaf-scoped force-win layer + token bootstrap.
 *
 * Applied via `document.adoptedStyleSheets` (CSSStyleSheet, NOT a
 * `<style>` element). Community plugin review forbids createElement("style");
 * Obsidian's own styles.css loader can drop or partially apply the sheet, so
 * this module guarantees the product skin is visible.
 *
 * Byte source: kept in lockstep with the HOST OVERRIDE section at the end of
 * styles.css (see tests/style-compliance).
 */
export const HOST_OVERRIDE_CSS = `:root{
--tm-radius-sm:4px;--tm-radius-ctl:8px;--tm-radius-card:12px;--tm-radius-pill:999px;
--tm-hit:32px;--tm-hit-sm:28px;--tm-hit-lg:36px;--tm-hit-xs:24px;
--tm-gap-xs:4px;--tm-gap-sm:6px;--tm-gap-md:8px;--tm-gap-lg:12px;
--tm-feed-max-width:46rem;
--tm-bg-page:var(--background-secondary);--tm-bg-card:var(--background-primary);
--tm-bg-soft:var(--interactive-normal);--tm-bg-hover:var(--background-modifier-hover);
--tm-bg-sunken:var(--background-primary-alt);
--tm-line:var(--background-modifier-border);
--tm-line-strong:var(--background-modifier-border-hover,var(--background-modifier-border));
--tm-ink:var(--text-normal);--tm-ink-soft:var(--text-muted);--tm-ink-faint:var(--text-faint);
--tm-accent:var(--interactive-accent);--tm-accent-ink:var(--text-accent,var(--interactive-accent));
--tm-accent-soft:var(--nav-item-background-active,var(--background-modifier-hover));
--tm-accent-softer:var(--nav-item-background-active,var(--background-modifier-hover));
--tm-on-surface:var(--text-normal);--tm-on-surface-var:var(--text-muted);
--tm-state-hover:var(--background-modifier-hover);
--tm-shadow-card:var(--shadow-xs,none);--tm-elev-1:var(--shadow-xs,none);--tm-input-shadow:var(--input-shadow,none);
--tm-type-display:var(--font-ui-large);--tm-type-title:var(--font-ui-medium);
--tm-type-body:var(--font-ui-small);--tm-type-label:var(--font-ui-small);--tm-type-meta:var(--font-ui-smaller);
--tm-lh-body:var(--line-height-normal,1.5);--tm-lh-tight:var(--line-height-tight,1.25);
--tm-transition:120ms ease
}

.workspace-leaf-content .tm-page,.workspace-leaf-content .tm-wb-shell{box-sizing:border-box;width:100%;max-width:48rem;margin:0 auto;padding:0 clamp(18px,3vw,36px) 32px;display:flex;flex-direction:column;gap:10px}
.workspace-leaf-content .tm-wb-hero,.workspace-leaf-content .tm-wb-section{gap:8px;margin:0}
.workspace-leaf-content .tm-wb-hero-title{display:flex;align-items:baseline;gap:8px!important;flex-wrap:wrap;font-size:var(--font-ui-medium)!important;font-weight:600!important}
.workspace-leaf-content .tm-wb-hero-title .tm-section-controls{margin-left:auto;display:flex;align-items:center;gap:6px}
.workspace-leaf-content .tm-wb-compose{display:flex;flex-direction:column!important;background:var(--background-primary-alt)!important;border:1px solid var(--background-modifier-border)!important;border-radius:12px!important;padding:12px 14px 10px!important;box-shadow:none!important;gap:6px!important}
.workspace-leaf-content .tm-wb-compose:focus-within{border-color:var(--interactive-accent)!important;box-shadow:0 0 0 3px var(--background-modifier-border-focus,transparent)!important}
.workspace-leaf-content .tm-wb-compose .tm-input-field,.workspace-leaf-content .tm-chat-input{background:transparent!important;border:none!important;box-shadow:none!important;color:var(--text-normal)!important;min-height:44px!important;max-height:160px!important;padding:8px 10px!important}
.workspace-leaf-content .tm-wb-compose-foot{margin-top:0!important;padding-top:4px!important;border-top:none!important;display:flex;align-items:center;gap:8px;flex-wrap:nowrap}
.workspace-leaf-content button{font-family:inherit}
.workspace-leaf-content .tm-toolbar-nav-btn,.workspace-leaf-content .tm-btn-ghost,.workspace-leaf-content .tm-toolbar-btn,.workspace-leaf-content .tm-card-action-btn,.workspace-leaf-content .tm-btn-mini,.workspace-leaf-content .tm-chat-msg-btn,.workspace-leaf-content .tm-chat-clear-btn{background:transparent!important;border:none!important;border-radius:8px!important;box-shadow:none!important;color:var(--text-muted)!important;padding:6px 10px!important;transition:background-color .12s ease,color .12s ease}
.workspace-leaf-content .tm-toolbar-nav-btn:hover,.workspace-leaf-content .tm-btn-ghost:hover,.workspace-leaf-content .tm-toolbar-btn:hover,.workspace-leaf-content .tm-card-action-btn:hover,.workspace-leaf-content .tm-btn-mini:hover,.workspace-leaf-content .tm-chat-msg-btn:hover,.workspace-leaf-content .tm-chat-clear-btn:hover{background:var(--background-modifier-hover)!important;color:var(--text-normal)!important}
.workspace-leaf-content .tm-btn-secondary,.workspace-leaf-content .tm-btn-polish,.workspace-leaf-content .tm-btn-open,.workspace-leaf-content .tm-btn-dismiss{background:var(--background-primary)!important;border:1px solid var(--background-modifier-border)!important;border-radius:8px!important;box-shadow:none!important;color:var(--text-normal)!important;padding:6px 12px!important;transition:background-color .12s ease}
.workspace-leaf-content .tm-btn-secondary:hover,.workspace-leaf-content .tm-btn-polish:hover{background:var(--background-modifier-hover)!important;border-color:var(--background-modifier-border-hover,var(--background-modifier-border))!important}
.workspace-leaf-content .tm-submit-btn,.workspace-leaf-content .tm-btn-primary,.workspace-leaf-content .tm-btn-init-workspace,.workspace-leaf-content .mod-cta,.workspace-leaf-content .tm-sidebar-capture-primary{background:var(--interactive-accent)!important;border:none!important;border-radius:8px!important;color:var(--text-on-accent)!important;font-weight:600!important;box-shadow:none!important;padding:8px 16px!important;transition:background-color .12s ease}
.workspace-leaf-content .tm-submit-btn:hover,.workspace-leaf-content .tm-btn-primary:hover,.workspace-leaf-content .mod-cta:hover,.workspace-leaf-content .tm-sidebar-capture-primary:hover{background:var(--interactive-accent-hover)!important;color:var(--text-on-accent)!important}
.workspace-leaf-content .tm-tab-bar{background:transparent!important;border-bottom:1px solid var(--background-modifier-border)!important;padding:0 8px!important;gap:2px!important}
.workspace-leaf-content .tm-tab-btn{background:transparent!important;border:none!important;border-radius:6px!important;color:var(--text-muted)!important;padding:8px 10px!important;font-weight:500!important;transition:background-color .12s ease,color .12s ease}
.workspace-leaf-content .tm-tab-btn:hover{background:var(--background-modifier-hover)!important;color:var(--text-normal)!important}
.workspace-leaf-content .tm-tab-btn.tm-tab-active,.workspace-leaf-content .tm-tab-btn[aria-selected=true]{background:transparent!important;color:var(--text-normal)!important;font-weight:600!important}
.workspace-leaf-content .tm-tab-btn.tm-tab-active::after{content:'';position:absolute;left:50%;bottom:0;translate:-50% 0;width:calc(100% - 16px);height:2px;border-radius:1px;background:var(--interactive-accent)}
.workspace-leaf-content .tm-wb-card,.workspace-leaf-content .tm-card,.workspace-leaf-content .tm-memory-card{background:var(--background-primary)!important;border:1px solid var(--background-modifier-border)!important;border-radius:10px!important;padding:12px 14px!important;margin:0 0 8px!important;box-shadow:var(--shadow-xs,none)!important;display:block!important;transition:background-color .12s ease,border-color .12s ease,box-shadow .12s ease}
.workspace-leaf-content .tm-wb-card:hover,.workspace-leaf-content .tm-card:hover,.workspace-leaf-content .tm-memory-card:hover{background:var(--background-primary)!important;border-color:var(--background-modifier-border-hover,var(--background-modifier-border))!important;box-shadow:var(--shadow-s,none)!important}
.workspace-leaf-content .tm-card-header.tm-card-meta{display:flex;align-items:center;justify-content:space-between;gap:8px!important;min-height:22px!important;margin:0 0 4px!important;padding:0!important}
.workspace-leaf-content .tm-card-time,.workspace-leaf-content .tm-day-count{font-size:var(--font-ui-smaller)!important;color:var(--text-faint);flex-shrink:0}
.workspace-leaf-content .tm-card-actions{margin-left:auto!important;opacity:0;transition:opacity .12s ease;display:flex;gap:2px}
.workspace-leaf-content .tm-card:hover .tm-card-actions{opacity:1}
.workspace-leaf-content .tm-card-body{font-size:var(--font-ui-small)!important;line-height:var(--line-height-normal,1.5)!important;color:var(--text-normal)}
.workspace-leaf-content .tm-day-group{display:flex;flex-direction:column;gap:0!important;margin:0 0 18px!important;background:transparent!important;border:0!important;padding:0!important}
.workspace-leaf-content .tm-day-label{font-size:var(--font-ui-medium)!important;font-weight:600!important}
.workspace-leaf-content button.tm-feed-layout-btn{border:1px solid var(--background-modifier-border)!important;background:var(--background-primary)!important;border-radius:8px!important;color:var(--text-muted)!important;padding:4px 10px!important;transition:background-color .12s ease,color .12s ease}
.workspace-leaf-content button.tm-feed-layout-btn:hover{background:var(--background-modifier-hover)!important;color:var(--text-normal)!important}
.workspace-leaf-content button.tm-feed-layout-btn[data-active=true]{background:var(--nav-item-background-active,var(--background-modifier-hover))!important;color:var(--text-normal)!important;font-weight:600!important}
.workspace-leaf-content .tm-sidebar-header-min{min-height:0!important;padding:2px 8px!important;border-bottom:none!important}
.workspace-leaf-content .tm-chat-input-area{flex-direction:column!important;gap:6px!important}
.workspace-leaf-content .tm-chat-input-foot{display:flex!important;align-items:center;gap:8px}
.workspace-leaf-content .tm-chat-input-foot .tm-footer-left{margin-right:auto!important;display:flex!important;align-items:center;gap:8px!important;min-width:0}
.workspace-leaf-content .tm-chat-input-foot .tm-footer-right{margin-left:auto!important;display:flex!important;align-items:center;gap:6px!important;flex-shrink:0}
.workspace-leaf-content .tm-footer-status{width:18px!important;height:18px!important;border-radius:50%!important;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.workspace-leaf-content .tm-footer-status .tm-status-dot{width:7px!important;height:7px!important}
.workspace-leaf-content .tm-chat-input-foot .tm-header-model{margin-left:0!important}
.workspace-leaf-content .tm-chat-input-foot .tm-header-model-select{max-width:110px!important;height:24px!important;font-size:var(--font-ui-smaller)!important}
.workspace-leaf-content .tm-sidebar-action-btn{background:transparent!important;border:none!important;border-radius:8px!important;color:var(--text-muted)!important;padding:8px 12px!important;transition:background-color .12s ease}
.workspace-leaf-content .tm-sidebar-action-btn:hover{background:var(--background-modifier-hover)!important;color:var(--text-normal)!important}
.workspace-leaf-content .tm-chat-message.tm-chat-user{background:var(--interactive-accent)!important;color:var(--text-on-accent)!important;border-radius:12px!important;border:none!important}
.workspace-leaf-content .tm-chat-message.tm-chat-ai{background:var(--background-primary)!important;border:1px solid var(--background-modifier-border)!important;border-radius:12px!important;box-shadow:none!important}
.workspace-leaf-content .tm-chat-context-bar{color:var(--text-muted)!important;padding:2px 0!important;gap:6px!important}
.workspace-leaf-content .tm-chip,.workspace-leaf-content .tm-chat-context-chip{background:var(--background-modifier-hover)!important;border:none!important;border-radius:999px!important;padding:3px 10px!important;color:var(--text-muted)!important}
.workspace-leaf-content .tm-feed-chrome{gap:6px!important;margin:8px 0 16px!important;flex-wrap:wrap}
.workspace-leaf-content .tm-chat-input{width:100%!important;min-height:56px!important;max-height:140px!important;padding:10px 12px!important;border:1px solid var(--background-modifier-border)!important;border-radius:8px!important;background:var(--background-primary)!important;color:var(--text-normal)!important;font-size:var(--font-ui-small)!important}
.workspace-leaf-content .tm-chat-input:focus{outline:none!important;border-color:var(--interactive-accent)!important;box-shadow:0 0 0 3px var(--background-modifier-border-focus,transparent)!important}
.workspace-leaf-content .tm-suggestion-actions .tm-btn-confirm,.workspace-leaf-content .tm-suggestion-actions .tm-btn-open,.workspace-leaf-content .tm-suggestion-actions .tm-btn-dismiss{height:28px!important;min-width:72px!important;padding:0 14px!important;border-radius:8px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;font-size:var(--font-ui-small)!important}
.workspace-leaf-content .tm-suggestion-actions .tm-btn-dismiss{background:transparent!important;border:none!important;color:var(--text-muted)!important;width:auto!important}
.workspace-leaf-content .tm-suggestion-actions .tm-btn-dismiss:hover{background:var(--background-modifier-hover)!important;color:var(--text-normal)!important}
.workspace-leaf-content .tm-chat-role{white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.workspace-leaf-content .tm-suggestion-card{background:var(--background-primary)!important;border:1px solid var(--background-modifier-border)!important;border-left:3px solid var(--background-modifier-border)!important;border-radius:10px!important;padding:12px 14px!important;margin:0 0 8px!important;box-shadow:none!important}
.workspace-leaf-content .tm-suggestion-card:hover{background:var(--background-modifier-hover)!important}
.workspace-leaf-content .tm-todo-item{display:flex!important;align-items:flex-start;gap:8px!important;padding:8px 10px!important;border-radius:8px!important;transition:background-color .12s ease}
.workspace-leaf-content .tm-todo-item:hover{background:var(--background-modifier-hover)!important}
.workspace-leaf-content .tm-todo-item.tm-completed{opacity:.55!important}
.workspace-leaf-content .tm-history-item{display:flex!important;align-items:center;gap:8px!important;padding:8px 10px!important;border-radius:8px!important;transition:background-color .12s ease}
.workspace-leaf-content .tm-history-item:hover{background:var(--background-modifier-hover)!important}
.workspace-leaf-content .tm-empty-state{padding:28px 16px!important;text-align:center!important;color:var(--text-muted)!important}
.workspace-leaf-content .tm-empty-title{font-size:var(--font-ui-medium)!important;font-weight:600!important;color:var(--text-normal)!important;margin-bottom:4px}
.workspace-leaf-content .tm-empty-hint{font-size:var(--font-ui-smaller)!important;color:var(--text-faint)!important;max-width:32ch;margin:0 auto}
.workspace-leaf-content .tm-chat-role,.workspace-leaf-content .tm-task-progress-inline span,.workspace-leaf-content .tm-suggestion-summary,.workspace-leaf-content .tm-empty-title,.workspace-leaf-content .tm-empty-hint{white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.workspace-leaf-content .tm-task-progress-inline{display:flex!important;align-items:center!important;gap:8px!important;width:100%!important;min-width:0!important}
.workspace-leaf-content .tm-header-model{min-width:0!important;max-width:100%!important;overflow:hidden!important;flex:0 1 auto!important}
.workspace-leaf-content .tm-header-model-select{max-width:96px!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}
.workspace-leaf-content .tm-footer-left{min-width:0!important;overflow:hidden!important;flex:1 1 auto!important}
.workspace-leaf-content .tm-footer-right{flex-shrink:0!important;gap:6px!important}
.workspace-leaf-content,.workspace-leaf-content *{writing-mode:horizontal-tb!important;text-orientation:mixed!important}
.workspace-leaf-content .tm-chat-role,.workspace-leaf-content .tm-task-progress-inline span,.workspace-leaf-content .tm-suggestion-summary,.workspace-leaf-content .tm-empty-title,.workspace-leaf-content .tm-empty-hint,.workspace-leaf-content .tm-tab-label,.workspace-leaf-content .tm-day-label{white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;writing-mode:horizontal-tb!important;transform:none!important}
.workspace-leaf-content .tm-header-model-select{width:96px!important;min-width:96px!important;max-width:96px!important;font-family:var(--font-interface)!important;font-size:var(--font-ui-smaller)!important;line-height:1.2!important;height:24px!important;padding:0 2px!important;box-sizing:border-box!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;background:transparent!important;border:none!important;color:var(--text-muted)!important}
.workspace-leaf-content .tm-header-model-static{width:72px!important;min-width:72px!important;max-width:72px!important;font-family:var(--font-interface)!important;font-size:var(--font-ui-smaller)!important;line-height:1.2!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;display:inline-block!important}
.workspace-leaf-content .tm-header-model{display:flex!important;align-items:center!important;gap:4px!important;min-width:0!important;max-width:200px!important;overflow:hidden!important;flex:0 1 auto!important}
.workspace-leaf-content .tm-footer-left{display:flex!important;align-items:center!important;gap:8px!important;min-width:0!important;overflow:hidden!important;flex:1 1 auto!important;margin-right:auto!important}
.workspace-leaf-content .tm-footer-right{display:flex!important;align-items:center!important;gap:6px!important;flex-shrink:0!important;margin-left:auto!important}
.workspace-leaf-content .tm-chat-input-foot{display:flex!important;align-items:center!important;gap:8px!important;width:100%!important;min-height:32px!important}
.workspace-leaf-content .tm-chat-input-foot button{flex-shrink:0!important}
.tm-loading-spinner,.tm-loading-spinner-sm{display:inline-block!important;width:14px!important;height:14px!important;flex-shrink:0!important;border-radius:50%!important;border:2px solid var(--background-modifier-border)!important;border-top-color:var(--interactive-accent)!important;animation:tm-spin .7s linear infinite!important}
.tm-loading-spinner *,.tm-loading-spinner-sm *{animation:none!important;transform:none!important}
.workspace-leaf-content .tm-chat-input-area{display:flex!important;flex-direction:column!important;gap:6px!important}
.workspace-leaf-content .tm-chat-input-foot{display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:space-between!important;gap:8px!important;width:100%!important;min-height:32px!important;flex-wrap:nowrap!important}
.workspace-leaf-content .tm-footer-left{display:flex!important;flex-direction:row!important;align-items:center!important;gap:8px!important;min-width:0!important;overflow:hidden!important;flex:1 1 auto!important}
.workspace-leaf-content .tm-footer-right{display:flex!important;flex-direction:row!important;align-items:center!important;gap:6px!important;flex:0 0 auto!important;flex-shrink:0!important}
.workspace-leaf-content .tm-header-model{display:flex!important;flex-direction:row!important;align-items:center!important;gap:4px!important;min-width:0!important;max-width:180px!important;overflow:hidden!important;flex:0 1 auto!important}
.workspace-leaf-content .tm-header-model-model{width:96px!important;min-width:96px!important;max-width:96px!important}
.workspace-leaf-content .tm-header-model-select{box-sizing:border-box!important;font-family:var(--font-interface)!important;font-size:var(--font-ui-smaller)!important;line-height:1.2!important;height:24px!important;padding:0 2px!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;background:transparent!important;border:none!important;color:var(--text-muted)!important}
.workspace-leaf-content .tm-suggestion-summary{color:var(--text-normal)!important;font-size:var(--font-ui-smaller)!important;font-weight:600!important}
.workspace-leaf-content .tm-suggestion-count-badge{background:var(--interactive-accent)!important;color:var(--text-on-accent)!important;border-radius:999px!important;padding:2px 8px!important;font-size:var(--font-ui-smaller)!important;font-weight:600!important}
.workspace-leaf-content .tm-suggestion-actions .tm-btn-open,.workspace-leaf-content .tm-suggestion-actions .tm-btn-dismiss{height:28px!important;min-width:72px!important;padding:0 14px!important;border-radius:8px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;font-size:var(--font-ui-small)!important;background:var(--background-primary)!important;border:1px solid var(--background-modifier-border)!important;color:var(--text-normal)!important;font-weight:550!important}
.workspace-leaf-content .tm-suggestion-actions .tm-btn-open:hover,.workspace-leaf-content .tm-suggestion-actions .tm-btn-dismiss:hover{background:var(--background-modifier-hover)!important;border-color:var(--background-modifier-border-hover,var(--background-modifier-border))!important}
.workspace-leaf-content .tm-header-model-model{width:120px!important;min-width:120px!important;max-width:120px!important}
.workspace-leaf-content .tm-header-model-select{height:auto!important;min-height:24px!important;line-height:1.3!important;padding:2px 4px!important}
.workspace-leaf-content .tm-header-model-select option{height:auto!important;min-height:24px!important;line-height:1.3!important;padding:4px 8px!important;font-size:var(--font-ui-small)!important}
.workspace-leaf-content .tm-task-progress-inline{display:flex!important;align-items:center!important;gap:8px!important;width:100%!important;min-width:0!important;flex-direction:row!important}
.workspace-leaf-content .tm-task-progress-inline span{white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;flex:1 1 auto!important;min-width:0!important;color:var(--text-muted)!important;font-size:var(--font-ui-smaller)!important}
.tm-task-progress-inline{display:flex!important;align-items:center!important;gap:8px!important;position:relative!important;padding-left:22px!important;flex-direction:row!important}
.tm-task-progress-inline::before{content:''!important;position:absolute!important;left:0!important;top:50%!important;translate:0 -50%!important;width:12px!important;height:12px!important;border-radius:50%!important;border:2px solid var(--background-modifier-border)!important;border-top-color:var(--interactive-accent)!important;animation:tm-spin .7s linear infinite!important;flex-shrink:0!important}
.tm-task-progress-inline > *{animation:none!important;transform:none!important;writing-mode:horizontal-tb!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.workspace-leaf-content[data-type="topmind-stream-workbench"] .tm-stream-workbench,.workspace-leaf-content[data-type="topmind-memory-browse"] .tm-memory-browse,.workspace-leaf-content[data-type="topmind-sidebar-dock"] .tm-sidebar-dock{background:var(--background-secondary)!important;background-image:linear-gradient(180deg,color-mix(in srgb,var(--color-blue,var(--interactive-accent)) 6%,var(--background-secondary)) 0%,color-mix(in srgb,var(--color-cyan,var(--color-blue,var(--interactive-accent))) 4%,var(--background-primary-alt)) 48%,var(--background-primary) 100%)!important;background-attachment:fixed!important}
.workspace-leaf-content[data-type="topmind-stream-workbench"] .tm-page,.workspace-leaf-content[data-type="topmind-stream-workbench"] .tm-wb-shell,.workspace-leaf-content[data-type="topmind-memory-browse"] .tm-page{background:transparent!important}

.workspace-leaf-content[data-type="topmind-stream-workbench"] .view-header,.workspace-leaf-content[data-type="topmind-memory-browse"] .view-header,.workspace-leaf-content[data-type="topmind-sidebar-dock"] .view-header{display:none!important}
.workspace-leaf-content[data-type="topmind-stream-workbench"] .tm-toolbar,.workspace-leaf-content[data-type="topmind-memory-browse"] .tm-page>.tm-section-header:first-child,.workspace-leaf-content[data-type="topmind-sidebar-dock"] .tm-sidebar-header,.workspace-leaf-content[data-type="topmind-sidebar-dock"] .tm-tab-bar{min-height:var(--tm-hit)!important;background:var(--tm-bg-chrome)!important;border-bottom:1px solid var(--tm-line)!important}.workspace-leaf-content[data-type="topmind-stream-workbench"] .tm-toolbar,.workspace-leaf-content[data-type="topmind-memory-browse"] .tm-page>.tm-section-header:first-child,.workspace-leaf-content[data-type="topmind-sidebar-dock"] .tm-sidebar-header,.workspace-leaf-content[data-type="topmind-sidebar-dock"] .tm-tab-bar{position:sticky!important;z-index:2!important}.workspace-leaf-content[data-type="topmind-stream-workbench"] .tm-toolbar,.workspace-leaf-content[data-type="topmind-memory-browse"] .tm-page>.tm-section-header:first-child{top:0!important}.workspace-leaf-content[data-type="topmind-sidebar-dock"] .tm-sidebar-header{top:0!important;z-index:3!important}.workspace-leaf-content[data-type="topmind-sidebar-dock"] .tm-tab-bar{top:var(--tm-hit)!important}
.workspace-leaf-content[data-type="topmind-stream-workbench"] .view-content,.workspace-leaf-content[data-type="topmind-memory-browse"] .view-content,.workspace-leaf-content[data-type="topmind-sidebar-dock"] .view-content{padding:0!important;margin:0!important}.workspace-leaf-content[data-type="topmind-stream-workbench"] .tm-page,.workspace-leaf-content[data-type="topmind-stream-workbench"] .tm-wb-shell,.workspace-leaf-content[data-type="topmind-memory-browse"] .tm-page{padding-top:0!important}.workspace-leaf-content[data-type="topmind-stream-workbench"] .tm-toolbar,.workspace-leaf-content[data-type="topmind-memory-browse"] .tm-page>.tm-section-header:first-child,.workspace-leaf-content[data-type="topmind-sidebar-dock"] .tm-sidebar-header,.workspace-leaf-content[data-type="topmind-sidebar-dock"] .tm-tab-bar{margin-top:0!important;padding-top:var(--tm-gap-xs)!important}
`;
