---
feature_ids: [F091]
related_features: [F021, F034, F066, F086]
topics: [signal, study, learning, podcast, voice]
doc_kind: spec
created: 2026-03-10
---

# F091: Signal Study Mode — 信号学习伴侣

> **Status**: done | **Owner**: Ragdoll
> **Created**: 2026-03-10
> **Completed**: 2026-03-17

## Why

F021 Signal Hunter 完成了 RSS 抓取 + 打分 + 收件箱的基础版。但team lead最初的愿景是一个**学习伴侣系统**——发现文章后能和猫猫讨论、归档学习笔记、转成播客巩固记忆。

现状断裂点：
1. "在对话中讨论文章"是假的——猫猫不知道你在讨论哪篇，零上下文
2. 没有 Study 概念——只有文章，没有笔记/报告/播客
3. 讨论精华沉没在聊天记录里，没有归档
4. Signal Hunter 的 studies 被困在旧系统里

## What

把 Signal 从 RSS 阅读器升级为学习伴侣：
- **对话优先**的双入口触发 Study（对话中贴链接为主入口，Signal 页面"开始学习"为辅）
- **Thread-Study 关联**：开始学习时默认跳转 thread 并注入上下文，支持手动关联已有 thread
- 文章上下文自动注入猫的 system prompt
- 深度学习笔记归档（用户确认后写入）
- 播客生成（两种模式：2-3 分钟精华 + 10 分钟深度讨论，声线跟随参与猫猫）
- 多猫研究集成（复用 F086 多猫编排）
- Study 前端展示（文章详情页折叠区）
- 记忆对接（用 cat-cafe-memory session search，不走 RAG）
- "打开原文"保留外链跳转（team lead确认：给人展示来源时跳浏览器是正确行为），详情页内嵌 markdown 渲染供日常阅读

## Evolved from

- `F021` — Signal Hunter 基础版（RSS 抓取 + 收件箱，已 done）
- `F066` — Voice Pipeline Upgrade（TTS 流式合成 + 播放队列）
- `F086` — Cat Orchestration（多猫编排 + multi_mention）

## Related

- `F034` — Voice Block 语音消息（TTS provider）
- `F-Swarm-1` — 多猫深度研究群

## Acceptance Criteria

- [x] AC-A1: Study Mode 端到端主链路已完成（详细 AC 见下方条目）

- [x] AC-1: Signal 文章详情页有"开始学习"按钮，默认跳转 thread 并自动注入文章上下文；手动关联 thread 支持手输 ID *(scope reduced: 完整 picker deferred，当前行为满足team lead核心场景)*
- [x] AC-2: 对话中贴 Signal 文章链接时，猫猫自动识别并获取文章上下文 *(thread-article 关联后 activeSignals 自动注入 contentSnippet+note)*
- [x] AC-11: Study 折叠区展示关联的 thread 列表，点击可跳转到对应 thread 继续讨论
- [x] AC-3: 讨论中说"归档"，猫生成深度笔记（含洞见/思考/开放问题），用户确认后写入 *(MCP signal_save_notes)*
- [x] AC-4: 文章详情页 Study 折叠区展示笔记、播客、研究报告
- [x] AC-5: 播客有两种模式——精华版（2-3 分钟）和深度版（10 分钟），声线跟随参与猫猫（可 2-3 只），前端可播放 *(PodcastPlayer + segment viewer + generate API)*
- [x] AC-6: Study 模式可触发多猫研究，报告归档到 Study 目录 *(多猫研究按钮 + research=multi 上下文注入)*
- [x] AC-7: 7 个新 MCP 工具可用（start_study / save_notes / list_studies / generate_podcast / signal_update_article / signal_delete_article / signal_link_thread）
- [x] AC-8: Signal Hunter 旧 studies 迁移到新结构 *(migration.ts)*
- [x] AC-9: 有 study 的文章在列表有视觉标记 *(studyCount badge + ✎ note icon)*
- [x] AC-10: 记忆对接用 cat-cafe-memory session search（不走 RAG），猫猫讨论前能搜到相关历史 *(ActiveSignalArticle enrichment with relatedDiscussions)*
- [x] AC-12: "打开原文"保留外链跳转（team lead确认：需要给人展示来源时跳浏览器是正确行为），详情页已内嵌 markdown 渲染供日常阅读
- [~] AC-13: Signal Inbox 列表视图 UX 设计语言归一化 *(转出为 TECH-DEBT.md TD107)*
- [x] AC-14: 可删除文章（单篇 + 批量选择删除），软删除（`deletedAt` 时间戳），列表过滤隐藏
- [x] AC-15: 可给文章添加备注（自由文本，不是标签——team lead的个人笔记/提醒）
- [x] AC-16: 批量操作（多选 → 删除/标已读/归档/加标签），范围=当前页可见项
- [x] AC-17: 按来源过滤（只看特定信源，50+ 源需要快速筛选）*(signals-view.ts source 条件 + SignalInboxView 来源下拉 + API source param)*
- [x] AC-18: 文章关联——把相关文章绑成"学习集"（如"多 Agent 系列"），Study 折叠区展示同集文章 *(collection CRUD + StudyFoldArea UI + atomic sync)*
- [x] AC-19: 学习时间线——"上周学了什么"回顾视图，按时间线展示 study 成果 *(StudyTimeline component + SignalInboxView integration)*
- [x] AC-20: 删除语义——软删除（`deletedAt`），有 study/播客/thread 关联的文章不硬删，避免幽灵引用
- [x] AC-21: 备注与笔记边界——备注进搜索、不注入讨论上下文、列表显示图标 hover 预览
- [x] AC-22: Thread 关联 edge cases——已有关联默认"继续最近 thread"；重复贴同篇去重提示；并列挂载 vs 切换主文章；thread 删除后 link 标 stale 不级联删
- [x] AC-23: 讨论前 evidence pack——文章全文 + note + 最近 linked threads (max 3) + 最近 study note，"先搜后聊" *(通过 enriched ActiveSignalArticle 注入)*
- [x] AC-24: Artifact job state——播客/研究生成有 `queued/running/ready/failed` 状态，防止重复触发 + 失败可见

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "和猫猫们聊的多，聊天才能碰撞灵感"——对话入口优先，贴链接猫识别 | AC-1, AC-2, AC-11 | manual + test | [x] |
| R11 | "可以让我选择新开 thread 或者关联哪个 thread？甚至挂载进来！聊天和 Study 相辅相成" | AC-1, AC-11 | manual + test | [x] |
| R2 | 文章上下文自动注入 system prompt，猫读原文然后和team lead讲 | AC-2 | test | [x] |
| R3 | 深度学习笔记归档（用户确认后写入） | AC-3 | manual + test | [x] |
| R4 | Study 前端展示（折叠区 + 视觉标记） | AC-4, AC-9 | screenshot | [x] |
| R5 | "两种都要"——精华 2-3 分钟 + 深度 10 分钟，声线跟随参与猫，可三只 | AC-5 | manual + test | [x] |
| R6 | 多猫研究集成（复用 F086） | AC-6 | manual | [x] |
| R7 | 7 个新 MCP 工具（含管理类 parity） | AC-7 | test | [x] |
| R8 | Study 存储方案（文章同目录） | AC-3, AC-4 | test | [x] |
| R9 | Signal Hunter 迁移 | AC-8 | manual | [x] |
| R12 | "打开原文不要跳浏览器"→ team lead确认保留外链（给人 show 来源） | AC-12 | team lead确认 | [x] |
| R13 | "hunter 列表 UX 设计语言归一化" | AC-13 | screenshot | [~] 转出 TECH-DEBT.md TD107 |
| R10 | "记忆是 thread session 搜来的"——用 cat-cafe-memory，不走 RAG | AC-10 | test | [x] |
| R14 | "有的时候拉到了一堆垃圾就想干掉！"——删除文章（单篇+批量） | AC-14, AC-16 | manual | [x] |
| R15 | "添加备注"——team lead给文章加个人笔记/提醒 | AC-15 | manual | [x] |
| R16 | 批量操作（多选 → 删除/标已读/归档/加标签） | AC-16 | manual | [x] |
| R17 | 按来源过滤（50+ 信源需要快速筛选） | AC-17 | manual | [x] |
| R18 | 文章关联——相关文章绑成"学习集" | AC-18 | manual | [x] |
| R19 | 学习时间线——"上周学了什么"回顾视图 | AC-19 | screenshot | [x] |
| R20 | 删除语义——软删除，有关联资产不硬删（Maine Coon brainstorm） | AC-20 | test | [x] |
| R21 | 备注 vs 笔记边界：备注进搜索、不注入上下文、列表 hover 预览 | AC-21 | manual | [x] |
| R22 | Thread 关联 edge cases（默认继续/去重/并列挂载/stale link） | AC-22 | test | [x] |
| R23 | 讨论前 evidence pack（先搜后聊） | AC-23 | test | [x] |
| R24 | Artifact job state（播客/研究 queued→running→ready/failed） | AC-24 | test | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（开发后补充截图）

## team experience（2026-03-10 Design Gate）

> "和猫猫们聊的多。只有聊天才能碰撞灵感。我们现在都是你们读原文然后和我讲，我只看关键原文然后我们一人三猫甚至更多猫开始讨论。"
>
> "两种都要——精华 2-3 分钟和深度 10 分钟是面对不同的场景的。声线可以选择默认参加的猫猫，甚至可以三只猫猫。"
>
> "记忆是 thread session 搜来的，可以用！但是我还是不建议走奇怪的 RAG 等，我实践了一年了没有好用的效果。"
>
> **"你记得我们的铁律：我们是面向终态，不绕路，我不建议做绕路的特性。"**
>
> **"代码是最廉价的。我们的设计、我们的思想碰撞才是灵魂。"**
>
> "讨论的话可以让我选择新开 thread 或者关联哪个 thread？甚至把什么 thread 给挂载进来！聊天和这个是相辅相成的。"
>
> "打开原文能不能——hunter 的时候就保存了 md 的？不要让我跳转浏览器，而是直接渲染，和我们的 workspace 那个系统做的那样，能够渲染 md 文档！"
>
> "hunter 列表的 UX 设计你也要记得设计语言归一化。"
>
> "需要能让我删除文章！添加备注等等功能。有的时候拉到了一堆垃圾就想干掉！"

### Ragdoll场景补充（team lead确认前的推演）

team lead的日常使用场景推演：

1. **垃圾清理**（team lead明确要求）：50+ 信源每天拉一堆文章，质量参差不齐，需要快速删除不想看的。批量操作是必须的——一个个删太痛苦。

2. **个人备注**（team lead明确要求）：不同于标签（分类用），备注是team lead的个人提醒——"下次和Maine Coon讨论"、"这个和 F086 有关"、"等 Gemini 2.5 发了再看"。

3. **来源过滤**（推演）：50+ 信源太多，team lead会想"今天只看 Anthropic 的"或"只看论文"。现有 Tab 只有状态过滤（全部/未读/收藏），缺来源维度。

4. **学习集**（推演）：team lead常常关注一个主题的多篇文章（如"多 Agent 系列"），把它们关联起来可以看全局图景，也方便生成跨文章的播客。

5. **学习时间线**（推演）：team lead想回顾"上周学了什么"，不是按文章列表看，而是按时间线看 study 成果——哪些笔记、哪些播客、和谁讨论了什么。

## Key Decisions

| # | 决策 | 选了什么 | Why |
|---|------|---------|-----|
| 1 | 主入口 | 对话中贴链接（team lead日常场景） | "聊天才能碰撞灵感" |
| 2 | 播客模式 | 两种：精华 2-3min + 深度 10min | 不同场景不同需求 |
| 3 | 播客声线 | 跟随参与猫猫，可 2-3 只 | 自然 |
| 4 | 记忆 | cat-cafe-memory session search | "实践了一年了没有好用的 RAG" |
| 5 | 笔记归档 | 用户确认后写入 | 生成质量需人把关 |
| 6 | 存储 | 文章同目录子文件夹 | 物理聚合，ls 可见 |
| 7 | 多猫研究 | 复用 F086 + deep-research | 不造轮子 |
| 8 | Phase 策略 | **面向终态不分阶段，但 artifact 保留 job state** | **P1 面向终态不绕路**（铁律）+ Maine Coon push back |
| 9 | 设计先行 | 先画 UX，再写代码 | "代码是最廉价的，设计才是灵魂" |
| 10 | Thread-Study 关联 | 默认跳转 thread + 手动关联，聊天和 Study 相辅相成 | 满足核心场景，完整 picker 为过度设计 |
| 11 | 原文阅读 | 详情页内嵌 md 渲染 + "打开原文"保留外链跳转 | team lead确认：给人 show 来源时需要跳浏览器 |
| 12 | 列表 UX | Signal Inbox 列表 UX 归一化转出为 TD | 独立 UX pass，不阻塞学习伴侣核心 |
| 13 | 删除策略 | 软删除（`deletedAt`），不硬删有关联的文章 | 防幽灵引用，保留恢复可能（Maine Coon brainstorm） |
| 14 | 备注边界 | 备注进搜索、不注入上下文、列表 hover 预览 | 备注≠study 笔记，控制噪声（Maine Coon brainstorm） |
| 15 | MCP parity | 管理操作（删除/备注/thread 关联）必须有 MCP 工具 | 主入口是对话，不能只在 Web UI（Maine Coon push back） |
| 16 | 数据模型 | frontmatter 轻量 + sidecar 目录 meta.json 聚合索引 | 不把 frontmatter 写成垃圾场（Maine Coon brainstorm） |
| 17 | Evidence pack | 讨论前固定搜：文章全文 + note + linked threads + study note | "先搜后聊"具体化，不是玄学记忆（Maine Coon提案） |
| 18 | 实施顺序 | 模型→MCP→对话入口→UI→视图层 | 按依赖拓扑落，不按功能切片（Maine Coon建议） |
| 沿用 | F21++ 设计文档其余决策 | 见 2026-02-26 文档 | — |

## Dependencies

- **Evolved from**: F021 (done) — Signal 基础设施
- **Related**: F034 (done) — TTS provider
- **Related**: F066 (done) — 语音管线

## Risk

- R5 播客 10 分钟深度版 TTS 合成耗时/成本需评估
- R4 前端改动范围较大（文章详情页 + 列表页）
- 现有 PATCH 端点只支持 `status/tags/summary`，需扩展共享 schema + API + MCP（Maine Coon发现）
- 删除/迁移操作与 `filePath` 耦合（`article-query-service.ts` 静默跳过缺失文件），需确保一致性
- Thread 关联 many-to-many 模型复杂度（当前是硬编码 `/thread/default?signal=...`）

## Review Gate

- [x] Design Gate: UX 确认（team lead 2026-03-10）
- [x] 本地猫 review（codex R1+R2，2026-03-10）
- [x] 云端 review（PR #348 R1+R2，2026-03-10）
- [x] 愿景守护 close review（gpt52 2026-03-10：第二次守护后team lead拍板缩 scope，AC-13 转出 TECH-DEBT.md TD107）

## Phase 5: 播客真正可用（2026-03-11） ✅

> **Status**: done | **Owner**: Ragdoll

team lead决策（2026-03-11 17:19）：
- **脚本生成**：用 Opus 4.5 或 4.6（ClaudeAgentService），复用文章 study thread 上下文
- **去重**：同 article+mode 新脚本覆盖旧 artifact
- **TTS**：接现有猫猫声线（F066 VoiceBlockSynthesizer）

team lead决策（2026-03-11 19:51）：
- **Thread session reuse 开 Phase 6 做**：Phase 5 scope = LLM 生成 + 去重 + TTS 播放
- Phase 5 当前用 context injection（读已有笔记+thread ID 注入 prompt）
- Phase 6 实现真正的 session reuse：往已有 study thread 发消息，走现有消息管道（和 GitHub 通知一样），不需要深耦合 cat routing

### Phase 5 AC
- [x] AC-P5-1: 播客脚本由 LLM 生成（精华版 5-8 段，深度版 15-25 段）
- [x] AC-P5-2: 同 article+mode 生成新播客时，覆盖旧 artifact（幂等，失败不丢旧版本）
- [x] AC-P5-3: 生成后自动 TTS 合成音频，前端可播放（apiFetch → blob URL）

### Phase 6: Thread Session Reuse ✅
- [x] AC-P6-1: 有已有 study thread 时，通过消息管道往 thread 发消息触发生成（复用该 thread 的猫实例）
- [x] AC-P6-2: 无 study thread 时，启动新 thread 再发消息

## Phase 7: 播客质量修复（2026-03-12） ✅

> **Status**: done | **Owner**: Ragdoll

team lead报告 4 个问题（thread_mmn3fsvdfvgqsf9i 23:40/23:52）：
- 精华版内容太简略（每段只有 30-50 字）
- 时长硬编码 2-3 分钟（应根据文章长度 3-10 分钟）
- 音频无法下载分享
- 缺少连续播放

### Phase 7 AC
- [x] AC-P7-1: 精华版 prompt 增强（每段 80-200 字，禁止空洞套话）
- [x] AC-P7-2: 动态时长 `estimateDuration` 根据文章长度分档（3/5/8/10 分钟）
- [x] AC-P7-3: TTS per-segment safety（try/catch + truncate >4800 chars）
- [x] AC-P7-4: PodcastPlayer 全部播放 + 每段下载按钮

## Phase 8: 播客上下文注入修复（2026-03-12） ✅

> **Status**: done | **Owner**: Ragdoll

team lead 04:36 报告："只给人发了原文？study的内容呢？生成的内容只有原文讲的那么点东西"

根因：播客生成 prompt 只注入了原始文章内容，没有注入 study thread 讨论历史和笔记。

### Phase 8 AC
- [x] AC-P8-1: 播客生成前读取 study thread 消息历史（`getByThread`，最多 50 条）
- [x] AC-P8-2: 播客生成前读取最新 study note artifact 内容
- [x] AC-P8-3: `assembleThreadContext()` 将讨论和笔记组装为 threadContext
- [x] AC-P8-4: threadContext 在 prompt 中位于 JSON 输出格式之前（不是之后）

## Phase 9: Signal 返回导航修复 + 学习笔记可查看（2026-03-13） ✅

> **Status**: done | **Owner**: Ragdoll

team lead 01:22 报告：学习笔记只列 ID 看不了内容，Signal 返回跳默认 thread 会发错消息。

### Phase 9 AC
- [x] AC-P9-1: Signal 入口传 `?from=threadId`，返回按钮回到来源 thread
- [x] AC-P9-2: "Chat" 改为 Mission Hub 风格"返回线程"按钮（`<` 图标 + 文字）
- [x] AC-P9-3: `?from=` 参数在 Signals/Sources 子页间透传
- [x] AC-P9-4: "在对话中讨论"/"开始学习"/"多猫研究"使用关联 study thread（不再 hardcode default）
- [x] AC-P9-5: 学习笔记可点击展开查看内容（`apiFetch` + lazy load）
- [x] AC-P9-6: 新增 `GET /api/signals/articles/:id/notes/:noteId` API endpoint

## Phase 10: 文章正文提取 + 讨论创建 thread（2026-03-16） ✅

> **Status**: done | **Owner**: Ragdoll

team lead 18:58 报告两个 bug：
1. Fetch 新文章后正文只有标题，没有实际内容（WebpageFetcher 不提取正文）
2. "在对话中讨论"跳 default thread，应像播客流程一样创建专属 study thread

### Phase 10 AC
- [x] AC-P10-1: WebpageFetcher 提取文章正文（不只是标题），存入 markdown 文件
- [x] AC-P10-2: "在对话中讨论"按钮点击时创建专属 study thread（复用 `resolveStudyThread` 模式）并跳转
- [x] AC-P10-3: 新创建的 thread 自动命名为 `Study: {articleTitle}` + 链接到 article meta + 加 opus 为参与者

## Phase 11: Secondary Fetch + Backfill（2026-03-17） ✅

> **Status**: done | **Owner**: 金渐层 + Maine Coon

team lead 21:54 报告：Phase 10 只修了列表页提取，19 篇 Anthropic Engineering 文章仍然只有标题没有正文。根因：listing page 只有卡片/链接，没有文章正文——需要二次抓取每篇文章的独立 URL。

### Phase 11 AC
- [x] AC-P11-1: WebpageFetcher 二次抓取无内容文章的独立页面（`enrichWithSecondaryFetch`）
- [x] AC-P11-2: Self-href 解析修复（selector 匹配 `<a>` 自身时 `.find('a[href]')` 漏解析）
- [x] AC-P11-3: `<article>` → `<main>` fallback 内容提取（`extractArticleBody`）
- [x] AC-P11-4: Backfill API endpoint `POST /api/signals/backfill` + service 对已有空文章重新抓取
- [x] AC-P11-5: 二次抓取传递 AbortSignal 尊重 source timeout（云端 P1 修复）
- [x] AC-P11-6: backfill sourceId 路径遍历防护（regex + resolve containment，云端 P1 修复）

## UX Wireframe 设计说明

### Screen A: 文章详情 + Study 折叠区
- 两列布局：左列文章列表（320px），右列详情（fill）
- 列表项有 study 的显示绿色 badge（"2 studies"），无 study 的显示状态 badge（"inbox"）
- 详情区：Tier badge + 状态 → 标题 → 来源/时间 → 三个 action 按钮 → AI 摘要 → **Study Mode 折叠区**
- Study 折叠区（淡灰底 + 边框）：笔记卡片（参与猫 badge + 洞见预览）+ 播客卡片（播放器 + 声线标识）
- "开始学习"按钮紫色突出，"在对话中讨论"灰色次级

### Screen B: 对话中贴链接 → 上下文注入
- team lead在 thread 中贴 signal:// 链接
- 系统蓝色提示条："已识别 Signal 文章，自动注入文章上下文到猫猫 system prompt"
- 猫猫回复直接体现对文章内容的理解（不是泛泛而谈）
- 这是**主入口**——team lead日常场景是聊天碰撞灵感

### Screen C: 播客播放器（双模式）
- 精华版/深度版 pill 切换
- 播放控制：上一个 / 播放 / 下一个 + 进度条 + 时间
- "正在说话"指示器：高亮当前说话的猫，灰色显示其他猫（可 2-3 只）
- 对话稿预览：每猫用自己的颜色标注

### Screen D: Signal Inbox 列表（设计归一化）
- 标题 + 实时统计（今日/未读计数）
- 搜索栏（pill 形状，搜文章/标签/来源）
- Tab 过滤：全部 / 未读 / 已学习（绿色书本图标）/ 收藏
- 列表卡片：Tier badge + 来源 + 时间 → 标题 → 标签 pills
- 未读文章有红点指示 + 淡蓝背景
- Study badge 绿色带数字（2/1）——一目了然

### Screen E: 原文内嵌 Markdown 渲染
- "返回详情"导航 + "浏览器打开"fallback 按钮
- 文章元信息条（Tier + 来源 + 日期）
- **复用 MarkdownContent 组件**渲染完整 .md 正文
- 支持标题、段落、blockquote（紫色竖线）、代码块（深色主题 + 复制按钮）
- 猫猫标注：橙色提示条，猫猫在原文旁加批注/关联洞见

## Ragdoll×Maine Coon 头脑风暴纪要（2026-03-10）

**参与者**: Ragdoll/Ragdoll (@opus) + Maine Coon/Maine Coon (@gpt52, GPT-5.4)
**模式**: collaborative-thinking Mode B（多猫独立思考）

### Maine Coon的 2 个 Push Back（已采纳）

1. **MCP 工具数量不够**：主入口是对话，管理操作（删除/备注/thread 关联）不能只在 Web UI。4→7 个新工具。
2. **Artifact job state 必须有**：不要 Study 生命周期状态机，但播客/研究生成的 `queued/running/ready/failed` 不可省。Decision #8 已修正。

### Maine Coon补充的 5 个缺口场景（已转为 R20-R24）

1. **删除语义**（R20）：软删除 `deletedAt`，有关联资产不硬删。当前 `article-query-service.ts` 静默跳过缺失文件会留幽灵数据。
2. **备注 vs 笔记边界**（R21）：备注=team lead scratch note（进搜索、不注入上下文、列表 hover 预览）；笔记=猫猫深度分析（重量、需确认）。
3. **Thread 关联 many-to-many**（R22）：4 条 edge case——默认继续最近 thread / 重复贴去重 / 并列挂载 vs 切换 / thread 删后 stale 不级联。
4. **批量操作范围**（AC-16 更新）：当前页可见项，不做全部命中项。
5. **讨论前检索策略**（R23）：evidence pack = 文章全文 + note + linked threads (max 3) + study note。"先搜后聊"。

### Maine Coon的数据模型建议（已采纳为 Decision #16）

- **frontmatter 保持轻量**：现有 `status/tags/summary` + 新增 `note/deletedAt/studyCount/lastStudiedAt`
- **sidecar 目录 + meta.json**：`{articleId}/meta.json` 做聚合索引（threads/artifacts/collections），notes/report/audio 独立文件
- **stable id 原则**：UI 不依赖文件名推关系，`articleId` 做 anchor

### Maine Coon的实施顺序建议（已采纳为 Decision #18）

不是"分 Phase 阉割功能"，而是"同一终态按依赖拓扑落"：
1. 聚合模型 + 写接口（note/delete/thread-link/artifact-manifest）
2. 对话入口 + 内嵌阅读 + MCP parity
3. Study 折叠区 + 归档 + 播客/研究生成
4. 学习集 + 时间线（视图层，吃前面归一化好的数据）

### 共识区

- 19→24 个需求点 + 24 个 AC，覆盖更完整
- 数据模型方向：frontmatter 轻量 + sidecar meta.json
- 实施不分"阉割 Phase"，但按依赖拓扑顺序落

### 分歧区

无重大分歧。Maine Coon的 2 个 push back 都被采纳。

### 收敛检查

1. 否决理由 → ADR？有 → Decision #8 修正（否决"完全无状态"，保留 artifact job state）
2. 踩坑教训 → lessons-learned？有 → 文件存在≠任务状态，长任务必须有 job state（待写入）
3. 操作规则 → 指引文件？没有新全局规则
