# Changelog

## 4.18.1 — First-run AI setup and community-review fixes

- **首次打开即可配置**：没有保存密钥、服务商偏好为空时，设置页也会显示服务商、模型（预设 / 默认 + 自定义模型 ID）和凭证（API Key，Ollama 为 Base URL，Custom 为 Base URL + API Key）。已有单服务商或 `ai.manual` 的升级仍显示已保存的服务商、模型和密钥。这些控件是设置定义行，不再画进会被宿主丢掉的分组列表。
- Desktop 导入改为用户点击后选择一份文件，只读这一份，不扫描用户主目录。
- 复制按钮仍只在用户点击时 `writeText`，不读剪贴板。
- `styles.css` 不含 `!important`。叶面上的重复标题隐藏、侧栏纵向伸缩、对话输入区留在布局里，改由 `body` + 叶面选择器优先级保持。使用了优先级旗标的第三方主题仍可能盖过个别属性。
- `main.js` 保持 lockfile vendored 可复现构建：`npm run build` 且不设置 `TOPMIND_SRC`，生产构建将 esbuild 限制为单线程，连续两次构建字节相同。发布工作流仍先构建再检出实时引擎，并上传 `dist/main.js`、`dist/manifest.json`、`dist/styles.css`。GitHub Release 只附这三份文件。

## 4.18.0

- `web_search`、`capture_url` 与工具重试提示。补齐 `web-search-core` / `tool-retry-hints` 的 `.d.mts`。

## 4.17.0 — Quality, community compliance, and maintainability

### UI regression fixes (post-review)
- Hide the duplicate native `view-header` on topmind leaves (product toolbar / tab bar own the top band). Scoped to `data-type^="topmind-"` only — app chrome untouched.
- Pin the chat composer to the sidebar bottom: restore the flex height chain (`view-content` → `tm-sidebar-dock` → `tm-tab-content.tm-chat-container` → messages / input).


### Community / security
- **AI key vault backup is opt-in** (default off). Secrets no longer land in `.topmind/ai-keys-backup.json` unless you enable it under Settings → Security.
- **`styles.css` is the only CSS channel.** Removed `adoptedStyleSheets` / `host-override.ts` JS style injection.
- **Native `view-header` stays visible** (back/forward + title). Product chrome lives in `tm-*` toolbars below it.
- AI write paths resolve through `resolveInsideVault` before any `mkdir`/`write`.

### Reliability
- AI task lane: `inFlight` gate keeps the queue strictly serial after abort.
- Plugin unload resets `aiTaskManager`, pending-writes workspace, and `BACKUP_KEEP` / `RECEIPT_KEEP` env overrides.
- Memory browse cache is capped and cleared on close.
- Destructive actions (new chat / clear history / clear todos) require confirm.

### UI / UX
- Token ladder aligned with DESIGN (`hit 36/32/42`, `radius 4/10/16/999`).
- Status chips use distinct tints; card actions reveal on `:focus-within`.
- Sidebar tabs are keyboard-navigable (arrows / Home / End).
- Locale switch re-registers command names (no boot-locale freeze).
- Settings: accurate test-connection / model descriptions; template labels localized.

### Maintainability
- `plugin.test.mjs` split into focused suites + `tests/helpers.mjs`.
- Shared `view-openers.ts` / `confirm-modal.ts` remove duplicated open/confirm logic.
- HOST OVERRIDE merged (last-wins) — no self-conflicting force-win rules.
- Dead CSS selectors removed.

## 4.16.16 and earlier

See git history.
