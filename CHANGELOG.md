# Changelog

## 4.18.2 — AI provider controls and homepage header hover

- **设置里的服务商和模型**：新增分组「AI 服务商与模型」。服务商、模型（预设 / 默认 + 自定义模型 ID）、API Key 或 Base URL 改成 Obsidian 原生 `control` 行。1.13 宿主会画出 `control`（写回模式、步数、开关一直在），`render` 回调画出来的服务商 / 模型 / 密钥不会出现在打开的设置页上，所以 4.18.1 只剩「AI 副驾与写回策略」。首次打开即可配置：没有保存密钥、服务商偏好为空时这些行也在。已有单服务商或 `ai.manual` 的升级仍显示已保存的服务商、模型和密钥。Ollama 只填 URL，Custom 填 URL 加 Key，其余服务商填 Key，并可留空覆盖默认地址。清空文本即清除密钥。
- **主页 header 按钮 hover**：产品页藏起了重复的原生 `.view-header`，按钮挪到 `.tm-toolbar`。压过宿主 `.clickable-icon:hover` 的透明底比我们自己的 `:hover` 更具体，所以这一排没有悬停底色。悬停现在用 `--nav-item-background-hover`，并且只作用在 topmind 叶面上。顺手去掉了会改到全库按钮 / 图标的空选择器和裸 `button`、`svg` 选择器。
- `styles.css` 仍不含 `!important`。发布资产仍只有 `main.js`、`manifest.json`、`styles.css`。

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
