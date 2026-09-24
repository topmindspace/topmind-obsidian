# topmind Obsidian Plugin — UI/UX 设计

> **设计北极星**：最低摩擦个人动态流 — 在 Obsidian 中随手记下、AI 默认建议、用户确认后沉淀、文件永远是你的。  
> **用户概念 ≤5**：记一下 · 动态 · 专题 · 我的情况 · 交付  
> **Obsidian-native 优先**：复用 Obsidian 原生能力，不重建编辑器/文件树/命令面板。  
> **记账**：Desktop 可选 mini-app（`memory/ledgers/`）；Obsidian **不发**记账小应用。

---

## 1. 入口架构

### 1.1 四入口设计

```text
┌──────────────────────────────────────────────────────────────┐
│  入口 1: 主区域动态 (Stream View)                               │
│  ────────────────────────────────────────────────────────    │
│  Obsidian 中央主编辑区的独立页签 (ItemView)                     │
│  承载：工具栏 + 极速输入 + 动态信息流（列表 / 单列卡片）          │
│  建议：仅 count>0 时露出计数入口条 → 打开 Dock「建议」tab        │
│  （完整确认面唯一在 Dock，不在画布堆第二套卡片列表）              │
│  工具栏：动态标题 | 任务徽章 | [侧边栏] [设置] [新笔记]           │
│  （AI 状态/模型只在：状态栏 · 侧栏状态点 · 对话切换器 · 设置）    │
├──────────────────────────────────────────────────────────────┤
│  入口 2: AI 副驾面板 (Sidebar Dock View — 标签式)              │
│  ────────────────────────────────────────────────────────    │
│  右侧 Leaf，标签页切换                                         │
│  ┌──────┬──────┬──────┬──────┐                                │
│  │ 清单 │ 建议 │ 对话 │ 历史 │  ← 4 标签（动态流的家在主区）    │
│  └──────┴──────┴──────┴──────┘                                │
│  头部：AI 状态点 | 任务徽章 | [动态] [⚙设置]                     │
│  底部：[⚡记一下] [🪄整理] [✨AI 操作菜单]                       │
│  （模型切换只在「对话」tab + 设置；不复读到头部）                 │
├──────────────────────────────────────────────────────────────┤
│  入口 3: 记一下弹窗                                            │
│  ────────────────────────────────────────────────────────    │
│  Ribbon 图标触发（快捷键需在 Settings → Hotkeys 自行配置）       │
│  零阻碍输入 → Enter 提交 → 静默写入周期本 → 关闭                │
├──────────────────────────────────────────────────────────────┤
│  入口 4: Obsidian 状态栏项 (Status Bar Item)                   │
│  ────────────────────────────────────────────────────────    │
│  空闲 = sparkles 安静图标；AI 通道运行 = spinner + 任务标签     │
│  点击 = 打开/恢复 AI 副驾面板（与 Desktop 状态栏 toggle 对齐）  │
└──────────────────────────────────────────────────────────────┘
```

> **能力单家**：动态流的家是主区 Stream View，**不进** Dock 标签（对齐 Desktop：AI 列不复读内容导航）。  
> **建议单确认面**：画布只计数开门；确认 / 忽略 / 待确认写入全在 Dock「建议」tab。

> **AI 操作单通道**：命令面板、侧栏底部按钮、开机自动整理全部经 `aiTaskManager`
> 共享串行队列（徽章 + 历史可观测每一次 AI 调用），无直跑旁路。取消为
> stop-tracking 语义：任务立即标记已取消、结果丢弃；底层 provider 调用无法
> 中断（requestUrl 无 signal 支持），UI 不暗示引擎级中断。
>
> **对话线程**：可见回答是正文；思考/推理默认折叠（`<details class="tm-chat-reasoning">`，不设 `open`）；
> Kernel `splitAssistantVisible` 把 `<think>` / 思考围栏 / 未标注 CoT 从答案拆出。
> 写回经 Kernel writeback / `precise-edit`（`edit_file`）。**无 Pi**（不依赖 `pi-agent-core`）。
> Host HTTP 可能不 token-stream；折叠 + 可见正文仍成立。**不发**记账 mini-app。

### 1.3 信息架构降噪（2026-09-23）

| 噪音源 | 规则 |
|--------|------|
| AI 状态 | **单点语义、多点呈现**：状态栏任务态 · 侧栏状态点（可点测速）· 设置页完整态。工具栏**不再**复读状态/模型。 |
| 模型选择 | **唯一切换面**：对话 tab 紧凑切换器 + 设置页。工具栏/侧栏头**不展示**模型徽章。 |
| 流头部操作 | 图标优先：`[刷新] [整理] [布局] [我的情况]`；文字标签仅宽容器 + 容器查询。 |
| 侧栏底部 | **3 格**：记一下 · 整理 · AI 菜单。不再平铺 6 按钮。 |
| 布局开关 | 紧挨周期区（不是远侧工具栏），`list/card` 同源 `settings.feedLayout`。 |

### 1.2 面板可恢复性

| 场景 | 恢复方式 |
|------|----------|
| 关闭动态页签 | ⌘P → "Topmind: 打开动态" 或 侧边栏头部 动态（`waves`）按钮 |
| 关闭侧边栏 | ⌘P → "Topmind: 打开侧边栏" 或 动态工具栏 🔮 按钮 |
| 两者都关了 | Ribbon 图标 → 记一下 → ⌘P 恢复 |
| 启动时 | `autoOpenWorkbench` 设置 → 自动打开动态 + 侧边栏 |

---

## 2. 动态主表面 (Stream View)

动态页提供两种可切换布局（`settings.feedLayout`）：开关在**动态列表旁**（周期区，不是远侧工具栏）。记下输入框与卡片/列表共用 `tm-feed-column` 单列宽。**列表**为 X 式单列紧凑帖（细线分隔），**卡片式**为同一套分块的单列等宽卡片（不是多列瀑布）。分块规则与 Desktop 对齐：日/周期段若是 markdown 列表（`-` / `*` / `1.`）仍按条目拆帖；无列表标记的长散文换行是一条帖；timed 条目后续段落留在同一帖。切换布局不重拆内容。

**我的情况**：工具栏、动态列表旁按钮、命令「打开我的情况」打开记忆浏览（画像 / 周期反思 / 专题记忆分层标签）。点开条目仍落到 vault 文件。不是第六用户概念。**整理我的情况**走已有 `CMD_MEMORY_ORGANIZE` / `enqueueAiOperation("memory_organize")` 确认面，不静默写画像。

### 2.1 布局

```text
┌─────────────────────────────────────────────────────────────────────┐
│  🟢 AI 就绪  DeepSeek · deepseek-chat  ⏳整理中 ✕  侧边栏 设置 新笔记 我的情况 │  ← 工具栏 + 任务徽章
├─────────────────────────────────────────────────────────────────────┤
│  ⚡ 随手写一条…                                            [记下]  │  ← 周期本「记下」（不是「记一下」弹窗）
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ── 动态 (2026-W32) · 12 条 ───────────── [切换周期] [整理]         │
│                                                                      │
│  ── 今天 ── 3 条 ──────────────────────────────────────────────     │  ← 日分组
│                                                                      │
│  ┌───────────────────────────────────────────────────────────┐     │
│  │ 🕐 15:30  讨论了 Obsidian 插件架构设计          📋 ✏     │     │  ← 动态卡片
│  │        • 确立主区域为 Stream 核心界面                      │     │
│  │        • 标签: #插件架构 #Topmind                         │     │
│  └───────────────────────────────────────────────────────────┘     │
│                                                                      │
│  ── 昨天 ── 5 条 ─────────────────────────────────────────────      │
│                                                                      │
│  ── AI 建议 ─ 3 条 ────────────────────────────────── 打开确认 →│  ← 计数入口（非完整卡片列表）
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

完整确认面 = Dock「建议」tab（接受 / 忽略 / 待确认写入）。画布不再复读整套卡片。

### 2.2 工具栏

| 元素 | 功能 |
|------|------|
| AI 状态灯 | 🟢 就绪 / ⚪ 未配置（可点击快速测试） |
| 模型徽章 | 显示当前 AI 服务商 + 模型（可点击跳转设置） |
| 侧边栏 | `panel-right` + 文本「侧边栏」，打开/恢复 AI 副驾面板 |
| 设置 | `settings` + 文本「设置」，跳转插件设置页 |
| 新笔记 | `file-plus` + 文本「新笔记」，在 Inbox 建 Untitled |
| 我的情况 | `user` + 文本「我的情况」，打开记忆浏览（画像 + 周期反思 + 专题记忆；点开条目仍落文件） |
| 列表 / 卡片 | 动态列表旁切换：X 式单列信息流 vs 单列等宽卡片（`settings.feedLayout`，不是多列瀑布） |

默认宽度下 icon+文本必须完整显示（`.tm-toolbar-btn-labeled { width: auto }`，标签 `overflow: visible`）。仅 `@container tm-workbench (max-width: 560px)` 隐藏标签；icon-only 时保留 `aria-label` / `title`。工具栏 `overflow: visible` + 可换行，不用 `overflow: hidden` 裁字。

周期区：**刷新**（`refresh-cw`，icon-only）与 **整理**（`list-tree` + 「整理」）是不同动作、不同图标，不重复。

### 2.3 交互细节

| 元素 | 交互 |
|------|------|
| 输入栏 | 多行 textarea；`Enter` **记下**（`Shift+Enter` 换行）；提交后清空 + 刷新流 |
| 动态卡片 | 时间在卡头芯片；正文走 `prepareStreamEntryTextForDisplay`（剥 `<!-- topmind:append -->`）；增补 `#### 续` 并入同一条目；长文才折叠。无列表标记的换行散文保持一条帖；列表项才拆帖 |
| 周期切换 | 下拉选择历史周期本；保留用户选择跨刷新 |
| AI 建议卡片 | 多种类型；动作词汇与 Desktop 对齐（2026-08-30）：write 类主按钮 **确认执行** → Kernel `applySuggestion`，`open_profile` 主按钮 **打开**；write 类卡片可解析出目标文件时附 **打开** 次按钮（先查看再决定）+ 目标路径面包屑（`… / 2026 / 2026-W30.md`）；`忽略` → 移出会话。↻ 手动刷新 `force:true` 清指纹；idle 为 soft 合并（指纹 skip 不丢卡）。`memory_organize` / `topic_classify` 确认卡进建议面 |
| 整理按钮 | reconcile + 自动待办整理 + 刷新 |
| 自动刷新 | 监听 Vault 文件变更；450ms 防抖静默重载 |

### 2.4 信息密度

| 指标 | 值 |
|------|-----|
| max-width | 56rem（默认；`--tm-feed-max-width` 可调至 72rem） |
| 卡片 padding | 12px 16px |
| 卡片间距 | 8px |
| 折叠阈值 | 仅 >600 字或 >20 非空行才折叠；短卡全文展示 |
| 建议正文字号 | font-ui-small |

---

## 3. AI 副驾面板 (Sidebar Dock View — 标签式)

### 3.1 布局

```text
┌─────────────────────────────────┐
│ 🟢 AI 就绪  DeepSeek·chat  ⏳  动态 设置 │  ← 头部: 状态 + 模型 + 任务徽章 + 动态/设置（icon+文本；窄侧栏 @container 藏字）
├─────────────────────────────────┤
│ 📋│ 💡│ 🤖│ 📜│  ← 标签栏 (4 标签: 清单|建议|对话|历史；动态流在主区)
├─────────────────────────────────┤
│                                  │
│  ── 清单标签 ──                  │
│  ☐ 研究插件架构                  │
│  ☑ 写设计文档                    │
│  ☐ 测试 writeback                │
│  ☐ 更新文档                      │
│  ✓ 2 已完成                      │
│                                  │
│  ── 建议标签（唯一确认面）──      │
│  💡 建议专题: "插件开发"          │
│  📝 待办提取: 2 条新待办          │
│  🧠 写入「我的情况」              │
│                                  │
│  ── 对话标签 ──                  │
│  ┌── 你 ──────────────────┐     │
│  │ 帮我总结本周动态         │     │
│  └─────────────────────────┘     │
│  ┌── AI ──────────────────┐     │
│  │ 本周主要进展:            │     │
│  │ 1. 完成了插件架构设计    │     │
│  │ 2. 测试了 writeback     │     │
│  └─────────────────────────┘     │
│  [问点什么...           ] [发送] │
│                                  │
│  ── 任务历史标签 ──              │
│  ✅ 整理待办 — 完成 · 3.2s       │
│  ❌ 专题分类 — 失败 · API 超时   │
│  ⏳ 整理我的情况 — 执行中...     │
│  🗑️ 已取消 — 用户中止            │
│                                  │
├─────────────────────────────────┤
│ ⚡  🪄  📋  🏷️  🧠  🌊          │  ← 底部快捷操作（整理=wand-2，动态=打开主区）
└─────────────────────────────────┘
```

### 3.2 标签功能

#### 清单标签 (List)
- 展示未完成清单项（最多 20 条）
- 点击勾选 → `toggleTodoItem` → 刷新
- 显示已完成数量
- "查看全部" → 打开 `memory/todo.md`
- 空状态：带图标，视觉友好

#### 建议标签 (Suggestions)
- AI 生成的建议卡片（同主面板建议区）
- 建议数量徽章显示在顶部
- 空状态：未配置 AI / 建议关闭 / 暂无建议，均带图标
- 每张卡片有确认/忽略按钮
- 多种类型：专题建议、待办提取、记忆提升、周期反思等
- AI 操作进行中时显示内联进度提示

#### 对话标签 (Chat)
- 与 AI 对话用户笔记、待办和动态
- 上下文感知：自动注入近期动态 + 当前待办 + 用户画像
- Markdown 渲染 AI 回复
- 对话历史（会话内保持）
- 清空对话按钮
- `Enter` 发送，`Shift+Enter` 换行

#### 动态标签 (Stream)
- 最近 10 条动态条目（最新在前）
- 点击 → 跳转周期本
- 空状态提示

#### 任务历史标签 (History)
- AI 任务管理器的操作历史
- 显示活跃任务 + 排队任务 + 最近 20 条历史
- 每条显示：状态图标、标签、状态文字、摘要、耗时
- 活跃任务可取消（stop-tracking：立即标记已取消、结果丢弃；provider 调用本身不可中断）
- 清空历史按钮
- 状态颜色编码：绿色=完成、红色=失败、蓝色=运行中、灰色=已取消

### 3.3 底部快捷操作

| 按钮 | 功能 | AI 条件 | 默认模式 |
|------|------|---------|----------|
| ⚡ | 记一下弹窗 | 无需 AI | icon-only |
| 🔄 | 整理（reconcile + todo_maintain） | 无需 AI | icon-only |
| 📋 | AI 整理待办（force todo_maintain） | 需要 AI | icon-only |
| 🏷️ | 专题分类（force topic_classify · 共享队列） | 需要 AI | icon-only |
| 🧠 | 整理我的情况（force memory_organize） | 需要 AI | icon-only |
| 👁 | 显示/隐藏操作标签 | — | toggle |

AI 操作按钮仅在 AI 已配置时显示。默认显示文本标签模式（`showActionLabels = true`），用户可切换为纯图标模式。所有按钮有 `title` tooltip。

### 3.4 头部设计

| 元素 | 功能 |
|------|------|
| 状态灯 + 文字 | AI 就绪 / 未配置（可点击快速测试） |
| 模型徽章 | 当前服务商 + 模型（可点击跳转设置） |
| 🖥 动态按钮 | icon + 文本标签，打开/恢复动态页签（窄屏隐藏文本） |
| ⚙ 设置按钮 | icon + 文本标签，一键跳转插件设置页（窄屏隐藏文本） |

> **防溢出**：头部使用 `flex-wrap: nowrap` + `overflow: hidden`，窄屏（600px 以下）自动隐藏文本标签。

> **可恢复性**：侧边栏头部始终显示「打开动态」按钮，即使动态页签被关闭也能一键恢复。

---

## 4. 记一下弹窗

### 4.1 布局

```text
┌──────────────────────────────────────────┐
│  ⚡ 记一下                          [×]  │
├──────────────────────────────────────────┤
│                                           │
│  ┌──────────────────────────────────┐    │
│  │  （在此输入...）                  │    │
│  │                                    │    │
│  └──────────────────────────────────┘    │
│                                           │
│  目标: [本周动态 ▾]   标签: #...         │
│                                           │
│  ⏎ 记一下    ⇧⏎ 换行    Esc 关闭         │
│                                           │
└──────────────────────────────────────────┘
```

### 4.2 交互

- 打开即聚焦输入框；零阻碍
- `Enter` 提交 → `KernelService.capture(text, { target, tags })` → writeback-engine → 关闭
- `Esc` 关闭弹窗（不保存）
- `Shift+Enter` 换行
- 自动检测单独 URL 输入，自动切换目标为 Inbox
- 目标选择：本周动态（默认）/ Inbox
- 标签解析：`#标签` 自动提取为 frontmatter tags
- 提交后：Notice 提示写入路径；若动态页签打开则刷新

---

## 5. 设置面板 (Plugin Setting Tab)

### 5.1 布局

```text
┌──────────────────────────────────────────────────────────┐
│  ⚙️ Topmind Stream 插件配置                               │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  📂 工作区与契约                                          │
│  ──────────────────────────────────────────────────────  │
│  模板                [Stream ▾]                          │
│  [初始化工作区]  ← 选择模板后点击创建三平面结构          │
│                                                           │
│  🌊 动态                                           │
│  ──────────────────────────────────────────────────────  │
│  启动时自动打开      [☑]  (同时打开动态 + 侧边栏)        │
│  时间轴排序          [最新在前 ▾]                        │
│  自动标签解析        [☑]                                  │
│  界面语言            [自动 ▾]                             │
│                                                           │
│  🤖 AI 副驾与写回策略                                    │
│  ──────────────────────────────────────────────────────  │
│  AI 状态             ✓ 已配置 — AI 功能可用              │
│  [从 Desktop 导入]  ← 一键导入已配置密钥                  │
│  默认服务商          [自动 ▾]                              │
│  模型                [服务商默认 ▾] [自定义 ID] [↻]       │
│                                                           │
│  ── 国际服务商 ───────────────────────────────────────  │
│  OpenAI     [BaseURL] [API Key]  ✓ ★  ↗                  │
│  Anthropic  [BaseURL] [API Key]     ↗                    │
│  Google…    [BaseURL] [API Key]     ↗                    │
│  xAI/Grok · Groq · Mistral · OpenRouter  …                │
│  ── 国内服务商 ───────────────────────────────────────  │
│  DeepSeek · Moonshot · Zhipu · MiniMax · Qwen · …         │
│  ── 本地 / 兼容 ──────────────────────────────────────  │
│  Ollama     [http://127.0.0.1:11434/v1]                   │
│  Custom     [BaseURL] [API Key]                           │
│                                                           │
│  [测试连接]  ← 验证 AI 连通性                            │
│  写回模式            [删除/归档前问我 ▾]                  │
│  自动准备 AI 建议    [☑]                                  │
│  自动整理待办        [☐] (省 Token)                      │
│                                                           │
│  🛡️ 安全与归档                                           │
│  ──────────────────────────────────────────────────────  │
│  备份保留份数        [3]                                  │
│  回执保留份数        [50]                                 │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

### 5.2 AI 模型选择

- **模型选择始终可见**：只要配置了任意一个 AI 服务商，模型选择下拉框就会显示
- **双源模型目录**：已配置密钥/端点时刷新走官方 list-models（OpenAI 兼容 `GET {base}/models`、Google `GET /v1beta/models`、Ollama 同形）；Anthropic 与未配置浏览走 [models.dev](https://models.dev) 社区目录；两者皆失败则保留精选默认。刷新强制绕过 TTL，失败不会把空列表或默认列表写成「已同步」。
- **自定义模型输入**：在下拉框旁提供文本输入框，可直接输入任意模型 ID
- **auto 模式**：服务商偏好留空时，自动选择第一个已配置的服务商，模型选择仍可用
- **模型徽章**：侧边栏头部 + 动态工具栏实时显示当前 AI 服务商 + 模型

遵循用户概念 ≤5 原则，不暴露技术术语：

| 技术词 | UI 白话 |
|--------|---------|
| writeback_mode: auto | 自动保存 |
| writeback_mode: confirm | 删除/归档前问我（分级：内容直接落，仅删/归档待确认） |
| protection: locked | 内容可编辑（任务级首写快照）；可恢复删/归档允许；永久删仅用户 |
| autoSuggest（= Desktop `autoPrepareSuggestions`） | 自动准备 AI 建议 |
| autoMaintainTodos | 自动整理待办 |
| BACKUP_KEEP | 备份保留份数 |
| RECEIPT_KEEP | 回执保留份数 |

### 5.3 快速进入设置

三种方式快速进入插件设置：
1. **侧边栏头部 ⚙ 按钮** — 一键跳转
2. **动态工具栏 ⚙ 按钮** — 一键跳转
3. **Obsidian Settings → Community plugins → Topmind Stream** — 传统方式

---

## 6. 命令面板集成

注册 Obsidian 命令（出现在 ⌘P 命令面板中）：

| 命令 | 快捷键 | 说明 |
|------|--------|------|
| Topmind: 记一下 | (用户自配) | 打开记一下弹窗 |
| Topmind: 打开动态 | — | 打开动态页签 |
| Topmind: 打开侧边栏 | — | 打开 AI 副驾面板 |
| Topmind: 整理本周 | — | 触发 reconcileStreamPeriod |
| Topmind: 刷新 AI 建议 | — | 重新生成建议 |
| Topmind: AI 整理待办 | — | 手动触发 todo_maintain |
| Topmind: 专题分类 | — | 手动触发 topic_classify（共享队列） |
| Topmind: 整理我的情况 | — | 手动触发 memory_organize |
| Topmind: 打开我的情况 | — | 打开记忆浏览页（列表/卡片；点开条目落到契约解析的画像/周期/专题文件） |
| Topmind: 打开 Inbox | — | 打开 Inbox 目录 |

> **快捷键策略**：不设默认快捷键，用户在 Settings → Hotkeys 自行配置（符合 Obsidian 插件规范）。

---

## 7. Ribbon 图标

左侧 Ribbon 栏添加 `pencil` 图标，点击打开「记一下」弹窗（动态页签图标仍为 `waves`）。

---

## 8. AI 对话设计

### 8.1 上下文构建

AI 对话自动注入以下上下文（无需用户手动选择）：

| 上下文来源 | 限制 | 说明 |
|------------|------|------|
| 近期动态条目 | 最近 20 条 | 当前周期本中的条目 |
| 当前待办 | 未完成的前 10 条 | `memory/todo.md` |
| 用户画像 | 前 3000 字符 | `memory/profile.md` |
| 对话历史 | 最近 10 轮 | 保持对话连贯性 |

对话可经 Kernel 多步工具环（`workspace_overview` / `search` / `list_*` / `read_file` / `save_file` / `edit_file` / `capture` / `add_todo` / `toggle_todo`）持续工作直到目标完成（默认 32 步，步数用尽 auto-continue×2）；**文本类可写**（engine `lib/text-note.mjs` 单源白名单，.md/.txt/.json/.yaml/.csv/代码/配置，二进制除外）；与 Desktop 同一匹配与写闸契约：匹配阶梯 + postEditWindow + **soft expectedHash**（hash 过期但 unique-span 仍匹配则放行）。写回跟随 `topmind.yaml`（**分级 confirm**：内容新建/更新/编辑直接落盘且工具层 `confirmed:true`，仅删除/归档待确认；locked 可编辑，任务级首写快照；契约未读到时**不**用默认值覆盖 yaml）。Agent 写成功后 `notifyFilesChanged` 主动 `vault.trigger("modify")`，视图即时刷新。指令语言：`en*` → 英文，否则中文。

### 8.2 对话交互

- 输入框：多行 textarea，`Enter` 发送，`Shift+Enter` 换行
- AI 回复：Markdown 渲染（支持列表、代码块、加粗等）；可见正文只含结论
- 思考过程：`<think>` / 思考围栏 / 未标注 CoT 折进默认折叠的「思考过程」
- 思考状态：显示"思考中..."动画（生成中）
- 清空对话：✕ 按钮清空全部历史
- 错误处理：失败时显示错误消息（不中断对话）

### 8.3 System Prompt

System prompt 跟随 UI locale：

- **中文模式**（zh-CN）：使用中文 system prompt，AI 回复中文
- **英文模式**（en-US）：使用英文 system prompt，AI 回复英文
- locale 由 `settings.localeOverride` 控制，留空时跟随 Obsidian 语言

```text
你是嵌入在 topmind Obsidian 插件中的 AI 助手。
你帮助用户反思笔记、规划任务、整理思路。
回答简洁实用，引用用户的真实数据时要有针对性。

以下是用户当前的上下文：
## 近期动态
- 15:30 ...
- 14:00 ...

## 当前待办
- ...

## 用户画像
...
```

---

## 9. 响应式设计

- 动态页签：最小宽度 400px；max-width **56rem**（`--tm-feed-max-width`）；卡片宽度自适应
- 侧边栏：固定窄宽度，标签内容自适应
- 弹窗：居中，最大宽度 600px
- 字体大小跟随 Obsidian CSS 变量（`--font-ui-small` / `--font-ui-smaller`），不使用硬编码 px
- 小屏适配：600px 以下输入栏纵向排列

> **文件树**：Vault 侧栏沿用 Obsidian 原生文件浏览器（collapse/expand 语义）。插件不重建第二套文件树。若未来提供自定义树，采用渐进展开（每层默认 8 条 +「更多」），与 Desktop TreeView 对齐。

---

## 10. 暗色模式

所有颜色使用 Obsidian CSS 变量，自动适配暗色模式：

```css
.tm-card {
  background: var(--background-secondary);
  color: var(--text-normal);
  border: 1px solid var(--background-modifier-border);
}
.tm-card:hover {
  background: var(--background-modifier-hover);
}
```

---

## 11. 视觉风格

- 使用 Obsidian CSS 变量（`--text-normal`, `--background-primary`, `--interactive-accent` 等）
- **单一 Design Token 面**：`styles.css` 顶部 token 块作用于全部 `tm-*` 表面（workbench · sidebar · memory · capture）
- 卡片样式：圆角 10px + 发丝描边 + 微阴影 + hover 高亮
- 输入栏：单行高度起，自适应增长
- AI 建议卡片：左侧带彩色边条（蓝=create_topic/inbox_organize/ai_summary/stream_digest，橙=stale_topic/catch_all，绿=promote_memory/open_profile）。**不用 purple**（Desktop 禁止紫作产品 AI 身份）。`promote_memory` 的 `payload.action` 为 `append_profile` / `update_profile` / `retire_profile`（不是只追加）；聊天注入画像走 Kernel `readProfileActiveBody`（历史段折叠为计数，不 dump 全文）。Inbox 超期走 `inbox_organize` 归位（移入/新建专题），不再发 `inbox_review` 归档卡。
- AI 对话：用户消息右对齐（强调色背景），AI 消息左对齐（卡片背景）
- 全中文 UI（可切英文）
- **与 Desktop 的有意差异**：主 CTA 用宿主 `--interactive-accent`（非 ink）；图标库 Lucide（非 Remix，语义映射见 Desktop DESIGN §0.0.2）；圆角 4/6/10；信息流默认宽 `56rem`（对齐 Desktop feed）

### 11.0 Design Token 与几何（唯一真源 `styles.css`）

| 令牌 | 值 | 用途 |
|------|----|------|
| `--tm-hit` / `--tm-hit-sm` / `--tm-hit-lg` / `--tm-hit-xs` | 32 / 28 / 36 / 24 px | 标准控件 / 区块栏 / 主 CTA / chip·mini |
| `--tm-icon` / `--tm-icon-lg` / `--tm-icon-xs` | 16 / 18 / 14 px | 控件图标 / 底部主操作 / 内联 |
| `--tm-radius-sm` / `--tm-radius-ctl` / `--tm-radius-card` / `--tm-radius-pill` | 4 / 6 / 10 / 999 px | mini / 控件 / 卡片 / 胶囊 |
| `--tm-type-display/title/body/label/meta` | 派生自 `--font-ui-*` | 字号阶梯（禁止硬编码 px） |
| `--tm-gap-xs/sm/md/lg` | 4 / 6 / 10 / 14 px | 间距节奏 |

**Chrome 对齐**：`.tm-toolbar` · `.tm-section-header` · `.tm-sidebar-header` · `.tm-feed-chrome` · `.tm-suggestion-refresh-bar` · `.tm-todo-open-file-bar` 共用 `min-height: var(--tm-hit)` 与 `gap: var(--tm-gap-sm)`，多层标题栏不再错位。

### 11.1 按钮系统规范（互斥角色）

| 角色 | 类名 | 用途 | 几何 |
|------|------|------|------|
| **Primary** | `tm-submit-btn` / `tm-btn-primary` / `tm-btn-init-workspace` / `tm-btn-confirm` | 提交、确认执行、初始化 — **每区仅一个** | h36（compose 内 h32）· accent 填充 |
| **Secondary** | `tm-btn-secondary` / `tm-btn-open` | 整理、全部确认、预览/拒绝、弹窗次操作 | h32（`tm-btn-sm` h28）· 描边 |
| **Ghost tool** | `tm-btn-ghost` / `tm-toolbar-btn` / `tm-sidebar-icon-btn` | 工具栏/卡片工具，**icon-first** | 方形 h32/h28 · 透明底 |
| **Labeled ghost** | `tm-toolbar-btn-labeled` / `tm-sidebar-btn-labeled` | 宽容器可选文字；侧栏头 CSS 藏字 | width:auto · 窄容器藏 label |
| **Chip / Segment** | `tm-feed-layout-btn`（外层 `tm-feed-layout-toggle`） | 列表/卡片、记忆分层筛选 | h24 · 分段控件 |
| **Mini** | `tm-btn-mini` / `tm-card-action-btn` | 卡片内联操作 | 24 / 28 方 · tooltip |

**关键原则**：
1. 工具类一律 icon + `title`/`aria-label`；文字只留给「会改变内容/状态」的命令（记下 · 确认执行 · 全部确认 · 整理）。
2. 同一 chrome 行内禁止混用多种高度；区块工具统一 `tm-btn-sm`。
3. 底部操作固定 **3 格**（记一下 · 整理 · AI 菜单），等宽 `tm-sidebar-action-label`。
4. 建议操作栏 `flex-wrap: nowrap`，避免「按钮挤成多行」。

### 11.2 图标尺寸规范

| 上下文 | 尺寸 | 令牌 |
|--------|------|------|
| 控件 / 工具栏 / 标签 / 卡片操作 | 16px | `--tm-icon` |
| 底部主操作 | 18px | `--tm-icon-lg` |
| 内联（时间戳、mini） | 14px | `--tm-icon-xs` |
| 弹窗标题 | 20px | 仅 modal title |
| 空状态装饰 | 28px / 18px | empty / chat empty |

### 11.3 加载状态规范

所有加载状态使用 CSS spinner，不使用 "..." 文本：

| 场景 | Spinner 类型 | 说明 |
|------|-------------|------|
| 主按钮（提交/确认） | `tm-btn-spinner` | accent 底上的浅色 spinner |
| 次要按钮 | `tm-btn-spinning` / `tm-btn-spinner-dark` | 按钮自旋或深色 spinner |
| 区域加载 | `tm-loading-spinner` | accent border spinner |
| 内联进度 | `tm-loading-spinner-sm` | 小尺寸 spinner |

### 11.4 字体规范

所有字体大小使用 Obsidian CSS 变量（经 `--tm-type-*` 令牌派生），**禁止**硬编码 px：

| 变量 | 用途 |
|------|------|
| `--tm-type-display` ← `--font-ui-medium * 1.35` | Hero 标题 |
| `--tm-type-title` ← `--font-ui-medium` | 区块标题、空状态标题 |
| `--tm-type-body` ← `--font-ui-small` | 卡片正文、列表正文 |
| `--tm-type-label` ← `--font-ui-small` | 按钮、标签、控件文字 |
| `--tm-type-meta` ← `--font-ui-smaller` | 时间戳、徽章、辅助 |

---

## 12. 无障碍设计

- 所有交互元素有 `aria-label` 和 `title`（tooltip）
- 键盘可达：`focus-visible` 样式 + `tabindex` + `role` 属性
- 动态卡片支持 `Enter`/`Space` 展开/折叠
- 状态灯标记 `aria-hidden`（装饰性元素）
- 尊重 `prefers-reduced-motion`：禁用动画
- icon-only 按钮必须有 `title` 属性提供 tooltip
- 防溢出：工具栏 `flex-wrap: nowrap` + `overflow: hidden`；窄屏（600px 以下）自动隐藏文本标签只显示图标
- 焦点可见性：所有交互类有 `focus-visible` 样式（2px outline + 2px offset）
