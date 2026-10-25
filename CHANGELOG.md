# Changelog

## 4.20.1 — Focus, capture, and clearer results

- 显式统一构建 strict-mode 配置，修复安装产物的字节差异；CI 与发布增加不同目录三次构建的 SHA-256 校验。
- 修复侧栏状态点未发起连接测试；使用原生按钮，提供忙碌、成功、失败和重试反馈，扩大点击区域。
- 键盘标签导航保持焦点，补齐 tab/tabpanel 关联；后台聊天进度不刷新其他标签，结束时不抢走编辑器焦点。清单草稿跨标签保留，录入后回到输入框。
- 捕获表单补齐真实标签、空白校验和抓取期间的重复提交保护；尊重手动目的地，关闭后不消费迟到结果，失败保留草稿。润色不覆盖等待期间的新输入。
- 结果页不再把读取路径计成写入次数；展示工具完成、待确认和引用路径，隐藏空的证据段。
- 长对话保留阅读位置，提供回到最新；待办支持筛选、分批加载、已完成展开恢复及更大点击区域；修复迟到建议覆盖其他标签和切回一直加载的问题。
- 移除影响原生侧栏的全局样式；简化聊天提示，重写中英上手说明与常见问题。验收与限制见 [体验检查](docs/UX-REVIEW-2026-10-25.md)。

### 共享契约与耐久会话

- 工具名称、双语说明、schema、读写分类与预算策略收敛到 Kernel，Desktop/Obsidian 按宿主能力使用；兼容旧参数，删除重复声明与旧记忆围栏实现。
- 抽出 ChatController 与 chat-agent，统一历史/目标/运行记录，保存工具 checkpoint；关闭暂停、重试沿原对象，迟到结果不能覆盖新会话。旧历史保留，损坏状态报错并阻止覆盖。
- 待确认队列统一为 Kernel 原子状态：真实执行删除、冲突检测、失败保留重试；删除卡片明确后果，确认前检查未保存编辑。
- 查询回合从执行层限制只读；写入前检查所有打开编辑器；后台取消阻止迟到生成进入后续写入或建议。
- 修复 scoped glob 的绝对路径漏匹配，统一待办 idOrText、批量录入、截止日和幂等完成语义；聊天记忆提案持久化，刷新与重载不丢失。
- 重写架构与交互文档，修正“同时编辑无冲突”“自动确认全部建议”等过度承诺。生产运行时仍为兼容 JSON 工具循环，Pi Core 迁移条件见 [整改记录](docs/OBSIDIAN-REFACTOR-2026-10-25.md)。

### 上下文与可靠行动

- 每轮固定当前笔记、选区与动态对象；回复显示本轮对象，重试和恢复沿用原目标。未保存缓冲区保护、上下文窗口和专题证据接入。
- 修复新侧栏未展开、全部完成待办无法清理、来源跳转遗漏年份、模型配置缓存与请求计时器等问题；新增直接待办录入。
- 补齐待办更新/截止日/删除、动态追加等工具；聊天记忆提案生成可确认建议卡片，确认前不会声称写入完成。
- 独立发行包内嵌 8 个工作区技能与共享参考，按需加载；新增 `npm run sync:skills` 显式更新资源快照。
- 建议请求合并并发，失败可见且保留卡片；后台任务正确标记错误，隔离旧代际结果；Provider 错误中的凭证回显脱敏。
- 文件移动核验目标写入成功再移除源文，检查真实路径与父目录；同名交付快照拒绝覆盖。
- 完整审查、Pi Core 1.4.0 宿主实验和后续迁移条件见 [审查报告](docs/OBSIDIAN-AUDIT-2026-10-25.md)。生产运行时尚未切换到 Pi。

## 4.18.4 — Vault walk fence

- 代理的文件遍历不再跟随指向库外的符号链接，也不进入 `.app` / `.framework` 和 `node_modules` 等依赖目录。`list_files`、`list_topics`、`list_topic_files` 和概览计数会跳过这些目录；路径解析到库外（包括中间经过越界链接）时，`stat_path` 和搜索停在库内。排除规则仍是 Obsidian `.obsidian/app.json` 的 `userIgnoreFilters`。

## 4.18.3 — Sidebar status tip

- 侧栏底部状态点的 tooltip 只保留当前状态（快速测试或去配置），不再附加过期的 `build 2026-09-28b`。

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
