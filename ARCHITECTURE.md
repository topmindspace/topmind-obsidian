# Topmind Obsidian 架构

版本以 [`manifest.json`](manifest.json) 为准。产品行为见 [DESIGN.md](DESIGN.md)，内容与写入契约以主仓 [PROJECT-MODEL](https://github.com/topmindspace/topmind/blob/main/PROJECT-MODEL.md) 和 [TOOLS](https://github.com/topmindspace/topmind/blob/main/TOOLS.md) 为准。本文件只描述当前实现与边界，不复写整套产品规约。

## 分层与职责

```text
Obsidian Views / Commands / Settings
  ├─ ChatController ─ chat-agent ─ workspace-agent-tools
  └─ AiTaskManager ─ KernelService ─ operation-provider
                       ↓
        bridge / provider / editor-context
                       ↓
   Kernel：内容模型、待办、记忆、建议、写闸、共享工具契约
                       ↓
       Vault Markdown + topmind.yaml + .topmind 状态
```

| 文件 | 责任 |
|---|---|
| `src/main.ts` | 插件生命周期、命令、视图注册、启动任务 |
| `src/services/kernel-service.ts` | 宿主门面、配置与 Provider 缓存、数据刷新和通知 |
| `src/services/chat-session.ts` | ChatController：发送/重试、暂停/放弃、持久化与运行归属 |
| `src/services/chat-agent.ts` | 上下文消费、工具循环、目标协议、进度和结果 |
| `src/services/kernel-workspace-ops.ts` | 与视图无关的文件、动态、精确编辑适配 |
| `src/services/workspace-agent-tools.ts` | Obsidian 工具执行器；不再维护第二套参数说明 |
| `src/services/editor-context.ts` | 当前对象、选区、磁盘窗口及打开编辑器冲突检查 |
| `src/services/ai-task-manager.ts` | 后台操作串行队列、状态与取消控制 |
| `src/services/operation-provider.ts` | 把取消状态传递给生成调用，并阻止迟到结果被消费 |
| `src/bridge/ai-provider.ts` | Obsidian `requestUrl` 传输、协议转换、超时和错误脱敏 |
| `src/bridge/vault-bridge.ts` | Vault 路径与修改事件 |
| `src/services/skill-resources.ts` | 随包资源发现与按需加载 |
| `src/views/` | 渲染及交互，不拥有另一套 Agent 或写入规则 |

## 与 Desktop 共享什么

共享业务约束和可移植协议，宿主集成各自维护。

| Kernel 真源 | 两端用途 |
|---|---|
| `lib/agent-tool-catalog.mjs` | 工具名称、双语说明、JSON schema、读写分类、旧参数兼容；按宿主能力生成工具指南 |
| `lib/agent-policy.mjs` | 步数范围、默认预算、写回模式说明 |
| `lib/agent-goal-protocol.mjs` | 工作区目标、完成判定、续跑决策与回执语义 |
| `lib/agent-task-contract.mjs` | 文章身份、权限、澄清与累计执行守卫 |
| `lib/agent-context-policy.mjs` | CJK估算、真实窗口预算、同稿历史、工具结果限窗 |
| `lib/agent-tool-policy.mjs` | 通用文件工具的语义记忆围栏，含路径别名和自定义记忆目录 |
| `lib/workspace-state.mjs` | 有边界的原子 JSON 状态读写；损坏数据报错并保留 |
| `lib/pending-writes.mjs` | 工作区隔离的待确认队列、冲突检测与确认执行 |
| 内容、待办、记忆与 writeback 引擎 | 同一内容格式、精确编辑与真实落盘证据 |

Desktop 的静态纯模块由主仓 `npm run sync:agent-contract` 生成，校验命令是 `npm run check:agent-contract`。Obsidian 的 `lib/` 是 Kernel 构建快照，只通过 `npm run ensure-engine` 更新，禁止手改副本。

有意不同：Obsidian 使用原生 Markdown 编辑器、文件树、链接与设置 API；Desktop 使用 Electron IPC、自己的编辑器及 Pi Agent 运行时。Obsidian 的网络通过 `requestUrl`，不直接复用 Desktop Provider、React、窗口管理或完整 coding session。Obsidian **不发**记账 mini-app，也没有 Desktop ops journal 面板；恢复依赖 Kernel 已有备份和高影响回执。

## 当前对象与上下文

发送时固定主区域对象，而非把输入框所在侧栏当成当前笔记。快照含路径、选区和行号；本轮切换其他页签不会把“这篇”改指向新文件。重试和继续沿用原对象。

`buildFocusContext` 只读库内真实文件，提供 bounded 行号窗口、内容 hash、最近的 `topic.md` 与未保存标记；不推断缺失正文。选区最多 4000 字符、磁盘窗口最多 60 行/6000 字符、专题首页最多 1800 字符。未保存缓冲区不持久化到聊天记录。

上下文按意图准备：纯寒暄不读取笔记；单篇任务先提供目标窗口、所选技能和可关闭的少量活跃画像，同稿最多两轮近期对话。工作区动态、待办与反思仅在相应任务时预取，完整记忆和参考由工具按需加载。窗口采用模型元数据与用户上限的较小值，未知容量按32K；系统、工具和回复均预留预算。每一步压缩增长的工具轨迹，任务和真实回执独立保留。

执行写入前重新检查所有打开的 Markdown 编辑器，包含已失焦对象；文件、源/目标路径、目录后代以及待确认操作都会检查。发现磁盘与编辑器缓冲区不同则拒绝并提示先保存。该检查不提供跨进程文件锁；精确编辑保留 `expectedHash` 和匹配阶梯，整文件保存仍需谨慎处理外部并发修改。

## Agent 与工具

生产路径仍是 `generate → 单个 JSON 工具调用 → 工具结果 → generate`。schema 与工具指南已共享，但目前未切成原生 tool-call 消息协议，不能声称等同于 Desktop 的完整 Pi 运行时。

工具范围由共享目录生成：闲聊不提供工具，查询回合只提供读取工具，执行层再次拦截越权调用；任务回合开放宿主支持的行动。未知工具、单工具异常返回可见错误结果，不冒充成功。旧 `capture`、待办 `id`、旧 `save_note.relativePath` 等输入经共享 normalizer 兼容。

Obsidian 不宣称支持渲染网页脚本、任意 shell 或全部 Desktop 工具。`list_recent_memories` 目前为活跃画像窗口；`list_recent_stream` 提供动态文件发现。参数和描述只公布实际支持的能力。

设置中的本轮调用上限默认为32、范围3–80；单篇文章另限16，工作区累计另限48。重试/续跑不能重置预算；预算耗尽或无进展时显示未完成。完成依据真实工具结果与路径回执，不凭一句 `[DONE]` 假定工作已完成。聊天记忆提案进入建议卡片，确认前明确 `wroteFiles:false`；尚未提供全部正式记忆工具的直接授权传递，详见整改记录。

### Provider

支持配置中的 OpenAI / Anthropic / Gemini 兼容传输。首次打开即可配置服务商、模型与 API Key；不依赖已有密钥才显示控件。Desktop 导入由用户点击选择单个文件，不扫描用户主目录。

输出预算按操作匹配 Desktop `OP_LIMITS`；超时按操作区分（chat 480s）。不接受 system role 的兼容模型进行 system 自愈，折进首条 user。超时、错误和取消不是成功结果；凭证回显在错误展示前脱敏。

后台取消在调用前后检查代际和取消标记，阻止迟到的模型结果进入写入/建议合并。`requestUrl` 底层连接和已经开始的同步 Kernel 操作不能保证即时中断；不承诺回滚此前完成的修改。

## 会话、建议与待确认操作

| 文件 | 内容与生命周期 |
|---|---|
| `.topmind/chat-session.json` | version 1：完整消息、目标台账、运行 id/状态与对象；工具完成后保存 checkpoint；模型压缩不裁剪持久历史 |
| `.topmind/chat-history.json` / `chat-goal.json` | 只在新会话状态不存在时导入；保留旧文件，不继续双写 |
| `.topmind/chat-proposals.json` | 聊天生成的记忆建议；重载恢复，确认/忽略后移除，不因刷新模型建议而丢失 |
| `.topmind/pending-writes.json` | Kernel 共享操作队列；兼容旧 `{items}` 格式，区分 write/delete/archive |

ChatController 的 run id 隔离关闭视图后的迟到回复。关闭活动会话会保存暂停状态；重新打开恢复原目标与对象，新运行启动后旧结果不能覆盖新会话或复活已清空记录。磁盘损坏或首写失败明确显示错误并阻止继续覆盖，不能把“读取失败”伪装成空历史。

确认操作先执行实际 Kernel 操作，成功后移出队列；失败保留供重试。已有普通文件的 hash 变化会阻止过期确认；确认删除执行删除，不走保存空正文。队列无模块级工作区缓存，跨工作区不会串项。原子替换保护单次文件写入完整性，**不等于多进程事务锁或严格一次执行**；当前 checkpoint 也不是完整原生工具消息日志。

## 内容写入与 Obsidian 通知

耐久内容由 Kernel `writeback-engine` 写入：

- 内容新建/编辑按既有分级策略直接落盘；confirm 模式的删除/归档进入待确认。
- 通用文件工具不得直接重写 profile、todo 和其他语义记忆；记账数据保留既有例外。
- 真实路径围栏处理符号链接与尚不存在的父目录；移动先确认目标落盘，再移除源文。
- 锁定覆盖及高影响生命周期操作使用既有快照/回执；普通更新不额外造一套归档。
- 成功后触发 Vault 修改通知，让 Obsidian 缓存与视图刷新。

这是优先 Vault API 指南的 intentional divergence：插件是桌面专用（Node fs/path/crypto），内容写入复用 Kernel 的 writeback 和恢复语义；不能再平行维护一套 Vault API 写闸。只读与导航仍尽量用宿主 API。

## 视图、样式与设置

动态在主区域，侧栏承载 Chat / Suggestions / Todos / History，我的情况是记忆浏览。动态卡片在超过 600 字符或 20 行时折叠；显示内容经清理，不暴露内部追加标记。复制由用户点击触发 `navigator.clipboard.writeText`。

设置用原生 `getSettingDefinitions()`；服务商、模型、Key / URL 使用 `control`，不藏在失效的 render 回调里。中英 locale 同键；命令不绑定默认全局快捷键。样式仅由插件根 `styles.css` 加载，源码不注入 style，样式不含 `!important`。

## 构建与验收

```sh
npm ci
npm run ensure-engine   # 显式更新 Kernel 快照
npm run typecheck
npm run lint
npm run build          # 仅用 vendored lib，可复现
npm run build:verify   # 不同目录三次构建，对比安装资产 SHA-256
npm test
npm run pack
npm run pack:verify
```

`ensure-engine` 来源为显式 `TOPMIND_SRC`、姊妹 `../topmind` 或 CI `.topmind-src`；没有有效来源时使用已有 vendored 快照。`build` 不隐式从用户其他目录拉取内容。依赖由 lockfile 固定；构建统一模块的 strict-mode 设置，CI 和发布在不同目录重复构建并逐字节核对三个安装资产。`build:verify` 清除 `TOPMIND_SRC`，验证提交内的快照。核心插件资产为 `main.js`、`manifest.json`、`styles.css`，ZIP 同时附带模板目录。技能资源显式运行 `npm run sync:skills` 更新。

行为回归重点：`chat-session`、`agent-capabilities`、`editor-context`、`kernel-service-behavior`、`operation-provider`、`precise-edit`；社区约束由 `obsidian-guideline-compliance` 守护。真实宿主测试和模拟 Provider 测试必须区分，不能用单测替代真实模型效果或全部受支持 Obsidian 版本验收。

## Pi 演进决策

[前次审查与 Pi 实验](docs/OBSIDIAN-AUDIT-2026-10-25.md) 是历史证据；[本轮整改](docs/OBSIDIAN-REFACTOR-2026-10-25.md) 记录新的交付。首选继续评估 Pi Agent Core，通过小型传输/事件适配接入现有共享契约与 ChatController；无需整体引入 coding CLI 的文件系统、认证和资源发现。

迁移完成条件是实际宿主的原生工具消息、服务商协议、取消、长会话压缩、暂停恢复和写闸等价测试全部通过。安装一个框架包不构成这些能力已完成。当前保留兼容循环，但不再给它复制第二份工具 schema 和权限规则。

## 写作集成

写作资源经显式 `sync:skills` 更新，内置独立发布的验证快照；`render_article` 复用共享排版器，写入仍走Kernel。源稿与图片hash防止过期交付，iframe禁止脚本。执行代码随插件正常发行，不进行远程代码热更新。

动态工具栏的新笔记由 Kernel 创建，不绕过写回契约。Kernel 写盘后，`openCreatedMarkdownNote` 等待 Obsidian Vault 的 `create` 索引事件，再用新的主区域 leaf `openFile` 并 `revealLeaf`；索引未到达时显示“已创建但尚未显示”的提示，不虚报已打开，也不让工作台页签被替换。

交互入口与布局见 [DESIGN.md](DESIGN.md)；两端的上下文层次、权限、预算、澄清及验证边界统一见 [文章任务执行说明](https://github.com/topmindspace/topmind/blob/main/docs/ARTICLE-TASK-EXECUTION-2026-10-27.md)。
