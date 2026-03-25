---
feature_ids: [F088]
related_features: [F050, F077, F044, F132, F134]
topics: [gateway, connector, feishu, telegram, slack, discord, chat-platform]
doc_kind: spec
created: 2026-03-09
---

# F088 Multi-Platform Chat Gateway — 聊天平台接入网关

> **Status**: Phase 1-6+A+B+C+D+E+G(8A)+8 done | **Owner**: Ragdoll

## Why

Cat Café 目前只能通过 Web UI 和猫猫对话。team lead和未来用户希望在**已有的工作聊天工具**中直接与猫猫交互，不用切换窗口。

MVP 选型：**飞书**（国内企业）+ **Telegram**（海外开发者）。选型细节见 [平台选型参考](assets/F088/platform-selection.md)。

## What

在 Cat Café 现有 Connector 体系上增加双向聊天能力：

```
┌─ 平台无关公共层 ─────────────────────────────────────┐
│  ConnectorMessageFormatter → MessageEnvelope          │
│  ConnectorCommandLayer → /new /threads /use /where /thread │
│  ConnectorRouter → dedup → binding → store → invoke   │
│  OutboundDeliveryHook / StreamingOutboundHook          │
│  IConnectorThreadBindingStore (Redis)                  │
└───────────────────────────────────────────────────────┘
        ↕                    ↕                ↕
  FeishuAdapter        TelegramAdapter    SlackAdapter
  (仅平台协议)          (仅平台协议)      (仅平台协议)
```

**原则**：能沉淀到公共层的就做成公共的，adapter 只做 parseEvent / formatMessage / sendMessage。所有业务逻辑在公共层。

**核心架构（三层结构）**：
1. **Principal Link**: `connector + externalSenderId → internalUserId`
2. **Session Binding**: `connector + externalChatId → activeThreadId`
3. **Command Layer**: 平台无关的 `/new /threads /use /where /link`

## Phase 进度

| Phase | 内容 | 状态 | PR |
|-------|------|------|-----|
| **1 (MVP)** | 飞书 + Telegram DM-only 双向对话 | ✅ | [#328](https://github.com/zts212653/cat-cafe/pull/328) |
| **2** | 多猫身份 + 分角色展示 + 外部 @路由 | ✅ | [#336](https://github.com/zts212653/cat-cafe/pull/336) |
| **3** | 富文本卡片（rich block → 飞书 card / Telegram formatted） | ✅ | — |
| **A** | ISSUE-1 修复：格式化 + DEFAULT_OWNER + Redis binding | ✅ | #344 + #346 |
| **B** | IM 命令集 `/new /threads /use /where` + deep link | ✅ | #349 |
| **4** | 消息编辑模拟流式（placeholder → edits → final） | ✅ | [#350](https://github.com/zts212653/cat-cafe/pull/350) |
| **C** | 架构归一：命令管道统一 + 跨平台 thread | ✅ | [#353](https://github.com/zts212653/cat-cafe/pull/353) |
| **D** | `/use` 模糊匹配：feat号 + title关键词 + 列表序号 | ✅ | [#355](https://github.com/zts212653/cat-cafe/pull/355) |
| **5** | 图片/文件收发（双向） | ✅ | [#362](https://github.com/zts212653/cat-cafe/pull/362) |
| **6** | 语音消息（STT/TTS） | ✅ | [#362](https://github.com/zts212653/cat-cafe/pull/362) |
| **E** | 飞书卡片身份标识：所有回复走 interactive card + 猫名头部，消除多猫气泡合并 | ✅ | [#389](https://github.com/zts212653/cat-cafe/pull/389) |
| **G (8A)** | IM Hub thread：命令隔离（控制面/对话面分离，双绑定）+ Hub thread 可见入口 | 🚧 in-progress | [#570](https://github.com/zts212653/cat-cafe/pull/570) |
| **H (8B)** | 模糊意图规则分流：无 binding / 低置信度消息走 Hub，系统卡片选择（无猫） | 📋 planned | — |
| **I (8C)** | 猫参与 triage：用户点"帮我判断"或连续无法决策时触发 triage 猫（可配置开关） | 📋 planned | — |
| **F** | iMessage 接入（OpenClaw + BlueBubbles） | 📋 planned | — |
| **7** | 群聊公共层：ConnectorRouter sender 透传 + ConnectorSource sender 扩展 | 📋 planned | — (联动 [F134](F134-feishu-group-chat.md)) |
| **8** | IM Hub 配置向导 — 平台接入引导 UI（飞书/Telegram/钉钉） | ✅ | [#680](https://github.com/zts212653/cat-cafe/pull/680) |
| **J1** | file block 全链路 + outbound 投递 + 安全防护（URL 白名单 + path traversal guard + fileName 透传） | ✅ | [#689](https://github.com/zts212653/cat-cafe/pull/689) |
| **J2** | Pandoc 文档生成服务 + MCP tool + 自动安装（init-cafe.sh / install.sh） | ✅ | [#693](https://github.com/zts212653/cat-cafe/pull/693) |
| **9** | 产品化（多账号/多workspace/运维） | 📋 planned | — |

完整 AC 列表见 [各 Phase 详细 AC](assets/F088/acceptance-criteria.md)

## Acceptance Criteria

- [x] AC-A1: Phase 1-6+A+B+C+D+E 已交付（详见 `assets/F088/acceptance-criteria.md`）

### Phase 8: IM Hub 配置向导 — 平台接入引导 UI

**team lead已确认 Screen C 设计方向（2026-03-23）。**

设计稿: [`designs/f088-im-hub-config-wizard-ux.pen`](../../designs/f088-im-hub-config-wizard-ux.pen)

**目标**: 在现有 `HubListModal` 中增加 Tab 导航，让team lead可以在 Web UI 中配置平台接入（飞书/Telegram/钉钉），无需手动编辑 `.env` 文件。

#### AC 清单

| AC | 描述 | 验收标准 |
|----|------|----------|
| AC-8-1 | HubListModal Tab 导航 | 📡 按钮打开的模态框显示两个 Tab：**系统对话中心**（现有 thread 列表，零改动）和 **平台配置**（新增向导页） |
| AC-8-2 | 平台配置卡片列表 | 配置 Tab 显示三张平台卡片（飞书/Telegram/钉钉），每张显示：平台名称、图标、当前状态（已配置 ✅ / 未配置 ⚪） |
| AC-8-3 | 卡片展开/折叠 | 点击卡片展开详情区域，包含：(1) 接入三步骤引导 + 外链（如飞书开放平台文档）(2) 配置表单字段 (3) 折叠后回到卡片列表 |
| AC-8-4 | 配置表单字段 | 飞书：`FEISHU_APP_ID` + `FEISHU_APP_SECRET` + `FEISHU_VERIFICATION_TOKEN`；Telegram：`TELEGRAM_BOT_TOKEN`；钉钉：`DINGTALK_APP_KEY` + `DINGTALK_APP_SECRET`。表单提交调用 `PATCH /api/config/env` |
| AC-8-5 | 测试连接 | ⏭️ **推迟** — 按钮显示"连接测试功能即将上线"。真正的连接测试需要 connector 热重载能力（配置保存后 gateway 才有新实例可测），依赖 [F136](F136-unified-config-hot-reload.md) Phase 2。当前 `GET /api/connector/status` 只返回配置完整性（`configured: true/false`），不做实际连通性探测 |
| AC-8-6 | 重启提示 | 修改 connector 环境变量后，显示黄色提示："配置已保存。需重启 API 服务使连接器生效。" |
| AC-8-7 | 敏感字段脱敏 | 已配置的 sensitive 字段（token/secret）显示 `••••xxxx`（尾 4 位），不回显完整值 |
| AC-8-8 | 回归安全 | 系统对话中心 Tab 功能完全不变（zero regression） |

#### 技术方案

**前端改动**：
- `HubListModal.tsx` — 增加 Tab 切换状态，现有 thread list 作为 Tab 1 内容
- 新建 `HubConnectorConfigTab.tsx` — 平台配置向导组件
- 使用项目 Tailwind 类（`text-cafe-black`、`bg-cocreator-light` 等），不使用 .pen 设计稿中的外部样式

**后端改动**：
- `connector-hub.ts` — 新增 `GET /api/connector/status` 端点
  - 读取当前环境变量，判断各平台配置完整性
  - 返回 `{ platforms: { feishu: { configured: boolean, fields: [...] }, telegram: {...}, dingtalk: {...} } }`
- 配置保存复用现有 `PATCH /api/config/env`（无需新端点）

**不在本 Phase 范围**：
- 热重载 connector gateway（接受手动重启）
- OAuth 接入流程
- 多账号/多 workspace

### Phase J: 文档生成 + 文件投递（📋 planned）

**背景**：team lead希望猫能生成 PDF/DOCX/MD 等文档并通过飞书/Telegram 发送给用户。金渐层已在飞书测试 thread 中验证过文件生成能力。飞书 API 原生支持 `file_type: pdf/doc/xls/ppt/stream`，上传限制 30MB。

**需求**：
1. 猫生成文档（PDF/DOCX/MD）→ 保存为本地临时文件
2. 通过新 RichBlock `kind: "file"` 附着在消息上
3. OutboundDeliveryHook 识别 file block → 调用 `sendMedia(type: 'file')`
4. FeishuAdapter 精确映射 `file_type`（PDF→`"pdf"` 而非 `"stream"`，获得飞书原生预览）

**现有基础**：
- `FeishuAdapter.sendMedia(type: 'file')` — 完整 4 级降级链 ✅
- `uploadToFeishu()` → `/im/v1/files` ✅
- 用户从飞书发文件给猫 → 已能接收（`case 'file':` handler）✅

**J1 已完成（PR #689）**：
- [x] 新 RichBlock `kind: "file"` 定义（shared types）
- [x] OutboundDeliveryHook 增加 file block 投递逻辑
- [x] `file_type` 精确映射（按扩展名 → pdf/doc/xls/ppt/stream）
- [x] URL 白名单安全防护（/uploads/ | /api/ | https://）
- [x] mediaPathResolver path traversal guard
- [x] fileName 透传到 Feishu upload（absPath + https:// 两条链路）
- [x] 前端 FileBlock 渲染器 + 安全 href 校验
- [x] Telegram adapter 文件发送已有（sendDocument）

**J2 技术决策（team lead 2026-03-23 确认）**：
- **生成工具：Pandoc**（`pandoc` CLI，非 JS 库）— 猫的输出天然是 Markdown，Pandoc 的 `md → pdf` 和 `md → docx` 是一等公民，无需加 npm 依赖
- **安装由我们搞定，不让用户自己装**（team lead 2026-03-23 明确要求）：启动脚本 / setup 引导自动检测并安装 pandoc（类似 ffmpeg 的处理方式）
- macOS: `brew install pandoc`；PDF 额外需要 LaTeX engine（`tectonic` 更轻量，或 `mactex-no-gui`）
- Docker / CI：Dockerfile 里 `apt-get install pandoc`
- 运行时仍做 graceful degradation 兜底：万一安装失败 → 降级为发 .md 原文件
- 与 Anthropic Claude Code 技术栈对齐

**J2 已完成（PR #693）**：
- [x] 启动脚本自动安装 pandoc（init-cafe.sh brew / install.sh apt+dnf）
- [x] PandocService: `execFile('pandoc', ...)` 封装 + 检测缓存
- [x] 降级链 graceful degradation（PDF→DOCX→MD）
- [x] MCP tool `cat_cafe_generate_document` + callback endpoint
- [x] 临时文件清理（copy 后 unlink，randomBytes 防碰撞）

**J 系列后续可选**：
- [ ] 大小限制策略（飞书 30MB 上限）— 当前无硬性需求
- [ ] LaTeX 自动安装（PDF 原生输出，当前降级为 DOCX）

## MVP Scope 硬边界

**包含**：飞书+Telegram DM-only、单 Owner、静态 token、Markdown、入站幂等去重、thread mapping、outbound final-only

**显式排除**：群聊(Phase 7)、多用户(Phase 7)、Slack/Discord(Phase 8)、OAuth(Phase 8)、多账号(Phase 9)

## 需求点 Checklist

| # | 需求点 | AC 映射 | 状态 |
|---|--------|---------|------|
| R1 | "飞书等聊天软件的Gateway能力" | AC-1, AC-2 | ✅ |
| R2 | 消息双向通（收+回） | AC-1, AC-2, AC-7 | ✅ |
| R3 | "来个海外的" — Telegram | AC-2 | ✅ |
| R4 | 不影响现有功能 | AC-5 | ⏳ |
| R5 | 入站幂等（不重复触发） | AC-6 | ✅ |

## Dependencies

- **Evolved from**: Connector 体系（GitHub Review Watcher, F050 A2A）
- **Related**: F077 多用户安全协作（群聊依赖）、F044 Channel 系统
- **External**: 飞书开放平台 App、Telegram Bot (@BotFather)

## Risk

1. **多用户安全模型**：群聊引入非 owner 用户，需权限隔离（F077 前置）
2. **平台 API 变更**：飞书/Telegram SDK 更新，需适配层
3. **消息格式损失**：rich content 转换中可能丢信息

## Known Issues

- **ISSUE-1**: Connector 消息不走统一管道 — **✅ Phase A+B+C 已解决**。详见 [架构归一设计](assets/F088/architecture-unification.md)
- **ISSUE-2**: Cloudflare Access 与 webhook 路径冲突 — 临时用 `api.clowder-ai.com`。详见 [架构归一设计](assets/F088/architecture-unification.md#issue-2-cloudflare-access-与-tunnel-ingress-路径冲突)
- **ISSUE-3**: 排队路径丢失媒体上下文 — 猫忙时，connector 图片消息排队后重放为 text-only（contentBlocks 未持久化到 messageStore）。直接调用路径正常。需改 messageStore schema + QueueProcessor 恢复链路。**愿景层高优 gap**（"共享记忆"）。
- **ISSUE-4**: Connector 媒体文件是本地缓存，非持久 artifact — MediaCleanupJob 24h TTL 后删除，历史消息中的本地 URL 会失效。原件仍在 Feishu/Telegram 平台。如需持久化，应存 platform key 而非本地 URL。

- **ISSUE-5**: 飞书多猫回复气泡合并无区分度 — 所有猫共用同一 Feishu Bot，plain text 回复被飞书 UI 合并成连续气泡，不同猫的回复视觉上混在一起。**Phase E 修复**：统一走 interactive card，每条消息独立卡片 + 猫名头部。
- **ISSUE-6**: `/thread` 命令缺失 — 用户发 `/thread <id> <msg>` 想路由消息到指定 thread，但 CommandLayer 不识别，静默 fallthrough 当普通消息投递给当前 session。**✅ PR #542 修复**。
- **ISSUE-7**: `/threads` 列表 shortId 全部显示 `[thread_m]` — `slice(0,8)` 截断后 `thread_` 前缀相同导致无区分度。**✅ PR #542 修复**。
- **ISSUE-8**: IM 命令污染对话 thread — `/threads`、`/where` 等元命令的消息存入当前对话 thread，混淆导航和对话内容。**已立项 → Phase G/H/I（三阶段）**：引入 IM Hub thread（控制面/对话面双绑定）。8A 命令隔离（纯控制命令只写 hubThreadId、不触发猫）→ 8B 模糊意图规则分流（无猫，系统卡片让用户选）→ 8C 猫参与 triage（可配置开关，兜底才喊猫）。bindingStore 增加 hubThreadId（懒创建）。**设计修正（team lead 2026-03-19）**：Hub thread **不能隐藏**，必须完全可见——team lead需要在 Web UI 看到所有命令历史，不能有黑盒。Hub thread 需要像猫猫训练营一样有专门入口（侧边栏按钮 + 列表页），不是普通 thread 混在对话列表里。**已确认设计（2026-03-20）**：(1) Thread 标记：`connectorHubState?: ConnectorHubStateV1` — 跟 `bootcampState` 同模式（team lead授权技术自决），含 `{ v: 1, connectorId, externalChatId, createdAt }`。(2) 侧边栏入口：🎓 按钮旁加 📡 Hub 按钮 → `HubListModal`（无 IM 面板，新建）。(3) Hub 列表页：按 connector 分组（飞书 Hub / Telegram Hub），显示绑定外部聊天（`lastCommandAt` 命令时间戳为 Phase G+ follow-up，8A 暂不含）。**✅ 8A merged PR #570**：命令隔离 + Hub thread 懒创建 + ConnectorHubStateV1 + 📡 侧边栏入口 + HubListModal + .strict() schema 防护。
- **ISSUE-9**: 多猫回复只有第一只猫转发到飞书 — ConnectorInvokeTrigger 在 A2A 链完成后只调一次 deliver()，传第一只猫的 catId。**✅ PR #545 + #551 修复**：per-cat outbound delivery → per-turn ordered delivery（outboundTurns[] 替代 perCatContent Map），A→B→A ping-pong 正确分发 3 条独立消息。含 richBlocks-only 支持、deliver timeout、实际 speaker catId 归属、turn boundary 检测。
- **ISSUE-10**: 飞书流式编辑完全不工作 — `sendPlaceholder` 发 `msg_type: 'text'`，但 `im.message.patch` 只支持编辑 `interactive`（卡片）消息，导致所有 `editMessage` 调用被飞书 API 拒绝（错误被 `.catch()` 静默吞掉）。Phase 4 设计时可能在 Telegram 上测的（Telegram editMessage 支持编辑任何类型），未在飞书验证。**PR #567 修复**：sendPlaceholder 改发 interactive card（`update_multi: true`），editMessage 改发 card JSON，新增 deleteMessage 清理占位卡片避免与 outbound card 重复。
- **ISSUE-13**: 飞书图片+文字消息静默丢弃 — 飞书发送 text+image 混合消息时 `msg_type` 为 `post`（富文本），`FeishuAdapter.parseEvent()` 无 `case 'post':` handler → `default: return null` → 整条消息静默丢弃（HTTP 200，无日志）。**✅ PR #637 修复**：新增 `case 'post':` handler 遍历 `content[paragraph][node]` 结构，提取 `tag:'text'`/`tag:'a'` 文本和 `tag:'img'` 图片附件，支持 zh_cn/en_us/ja_jp locale fallback。同步增加 webhook diagnostic logging 和 callback vs agent 卡片视觉区分（紫色 `📨 传话` 标识）。
- **ISSUE-14**: 飞书 post 内嵌图片下载 400 — PR #637 的 `case 'post':` handler 正确解析了 `image_key`，但 `feishuDownloadFn` 统一用 `/im/v1/messages/{msgId}/resources/{key}` 端点下载，该端点对 post 内嵌图片返回 400。post 内嵌图片需用 `/im/v1/images/{key}` 端点。**✅ PR #640 修复**：新增 `source: 'post-embedded'` 标记全链路穿透（FeishuAdapter → ConnectorRouter → ConnectorMediaService → feishuDownloadFn），按 source 分流 API 端点。
- **ISSUE-15**: Cat Café web 发消息 → 猫回复不推送到飞书 — `messages.ts` 的 immediate 路径（`router.routeExecution()`）消费完 agent 事件流后，只做 WebSocket 广播，**没有调用 `OutboundDeliveryHook.deliver()`**。**✅ PR #671 修复**：在 `messages.ts` 注入 `outboundHook` + `streamingHook`，routeExecution 消费循环中收集 turn text + richBlocks，成功时 fire-and-forget 调用 `deliverOutboundFromWeb()`；失败/取消时 `cleanupStreamingOnFailure()` 清理占位卡片。统一 `STREAM_START_TIMEOUT_MS`（5s）常量。18 个回归测试覆盖投递、流式、清理、超时对齐。

## Phase G+ Follow-up（8A 增量改进）

> 高优 1-3 已在 PR #582 合入（2026-03-20）。

### 高优 — ✅ 已完成（PR #582）
1. ~~Hub thread badge in ThreadItem~~ — HubIcon SVG badge in sidebar ThreadItem ✅
2. ~~`lastCommandAt` 命令时间戳~~ — 全栈：ThreadStore → ConnectorRouter → API → HubListModal ✅
3. ~~Manual rebinding~~ — `/unbind` 命令：解绑当前 IM→thread 绑定 ✅

### 同步修复的 Bug — ✅（PR #582）
- ISSUE-10b: Feishu 音频格式硬编码 opus → 自动检测 wav/mp3/ogg/opus ✅
- ISSUE-10c: 图片转发 media_gallery type check + base64 data URI 支持 ✅
- ISSUE-10d: 飞书流式占位卡片 — 延迟删除至 delivery 成功后（5 轮 cloud review 收敛）✅

### 低优（代码整洁预埋）
4. **`inferThreadKind()` 纯函数** — 抽取 `connectorHubState` / `bootcampState` 判断逻辑。不单独立项，在做相关逻辑时顺手抽。

## 参考文件

| 文件 | 内容 |
|------|------|
| [平台选型参考](assets/F088/platform-selection.md) | 平台对比表 + 选型决策 + 工期评估 |
| [架构归一设计](assets/F088/architecture-unification.md) | ISSUE-1/2 解决方案 + 三层架构设计 |
| [各 Phase 详细 AC](assets/F088/acceptance-criteria.md) | 完整 AC 清单（Phase 1-9） |
