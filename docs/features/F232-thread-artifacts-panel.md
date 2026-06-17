---
feature_ids: [F232]
related_features: [F148, F063, F095, F131]
topics: [artifacts, thread, workspace, ui]
doc_kind: spec
created: 2026-06-11
---

# F232: Thread Artifacts Panel — Thread 产物视图

> **Status**: in-progress（Phase A 全部 merged；**Phase B foundation merged PR #2285 + grouping merged PR #2288 + cat filter merged PR #2290**（AC-B1 ✅）；视觉待 alpha）| **Owner**: Ragdoll Opus-4.8 | **Priority**: P1

## Why

operator experience（2026-06-11）：

> "我经常遇到我想要看 **这个 thread 的某个产物**！但是忘记名字是啥了！在我们的 workspace 里搜半天 or 这时候只能喊猫来…… 这个能力好像 codex app claude app 之类都有的"

一个 thread 跑下来会产出一堆东西——图、文档、代码改动、PR、语音——但它们**散在消息流、`/uploads/`、git、PR 各处，没有一张按 thread 聚合的清单**。operator想回看某个产物时，只能翻聊天记录、在 workspace 里搜半天、或者喊猫帮找，全靠记名字。

**价值**：让operator不用记名字、不用搜半天、不用喊猫——点开一个 thread 就能浏览 / 筛选 / 搜索 / **点击直接看到产物内容**。这是 Claude/ChatGPT 的 artifacts 面板的"thread 级"加强版（他们只管"对话里生成的可编辑文档"，我们产物类型更多：代码、PR、设计稿、语音都算）。

**🎯 核心愿景澄清（2026-06-12 operator dogfood 后明确）**：产物系统的灵魂是「**点一下就看到内容**」，不是「列一张清单告诉你有这些产物」。operator experience——"我想打开 backlog 我能点击打开 …… 现在这个只是我能看到有这个，但是我点击看不了他的内容"。即：**产物列表只是入口，点击产物按类型直接打开/查看内容才是价值落点**——docs/md 看正文、图看图、代码看 diff、语音播放、PR 打开。这也是operator想"和 workspace 整合"的真正本质：**复用 workspace「点文件看内容」的能力**（`FileContentRenderer` / `WorkspaceTree`），不是 UI 摆哪里的问题。mockup 每个产物项本就设计了类型化 action（打开/下载/查看 diff/播放）；Phase A 首版实现简化成"列表 + 外部 url 打开"，把这个核心丢了——是 Phase A.1 必补的灵魂缺口。

## Current State / 现状基线

产物数据 **~80% 已存在但散落、无聚合视图**（2026-06-11 双 Explore agent 调研结论）：

| 产物类型 | 现在存哪 | 可查询性 |
|---------|---------|---------|
| 图 / 文件 / 代码 diff / 语音（rich blocks） | `msg:{id}.extra.rich.blocks[]`（Redis Hash，可按 `msg:thread:{threadId}` 捞消息后遍历提取） | ⚠️ 需遍历消息，无 kind 索引 |
| 生成的 PDF/DOCX、AI 图 | `/uploads/` 文件系统 + rich file/media_gallery block | ⚠️ 通过 rich block 间接 |
| 改动的代码文件 + PR | session digest `filesTouched` + task store（`pr_tracking`，支持 threadId 过滤） | ✅ PR 可查；文件可推导 |

- **已有地基**：`packages/api/src/domains/cats/services/agents/routing/artifact-tracking.ts`（F148）已经会追踪 PR / 文件 / 文档 / plan 并去重排序——但只**喂猫做冷启动 context**（`MAX_ARTIFACTS = 5`），不暴露 API、不含 rich blocks、不聚合成 thread 视图。
- **缺口**：① 一个"按 threadId 聚合所有产物"的查询 / API ② 一个 UI 面板入口。grep 确认**无任何** `list_thread_artifacts` / thread 产物面板入口（数据层 ~80% 现成，查询层 ~5%，UI 层 0%）。

## What

### Phase A: Thread 内产物视图（MVP）

点开任意 thread → 右侧「产物」面板，自动列出该 thread 产生的所有产物，按类型筛选 / 搜索，**点击产物按类型直接查看内容**（不只跳回原消息）。

- **后端**：`GET /api/threads/:threadId/artifacts` —— 聚合 rich blocks（`file` / `media_gallery` / `diff` / `audio`）+ `pr_tracking` tasks + file ledger，去重 / 按 effective order time 倒序、按 userId scoped（system thread 隔离）。返回 `{ type, name, catId, createdAt, sourceMessageId, url?, ref? }`。
- **前端交互核心（愿景落点）**：每个产物项**点击按类型打开/查看内容**——
  - docs / md / log / 文本文件 → **复用 `FileContentRenderer` 在 panel 内看正文**（operator backlog 例子）
  - 图 → 看图；代码 → 查看 diff；语音 → 播放；PR → 打开 PR
  - 辅助动作：「跳回原消息」（jump-with-load 定位生成位置）
- **UX 形态（收敛 → AC-A8 修订升级）**：~~抽屉内部用 tab 切 mode（状态/工作区/产物/转录）~~ → **operator dogfood 反馈"狗皮膏药"后拍板方向 (b)**：产物升为 workspaceMode 顶层入口（开发/记忆/调度/任务/社区/**产物**），PanelTabs 只剩 3 tab（状态/工作区/转录）。产物点击在 panel 内查看内容——与 workspace「点文件看内容」**共用同一套查看器**。
- **图标**：inline SVG（非 emoji，家规）。

> **Phase A 实现状态**：首版（PR #2247 merged）已做 **列表 + 类型筛选 + 搜索 + 跳回原消息 + 外部 url 打开**；**点击集成内容查看（尤其 docs 类，复用 FileContentRenderer）+ panel 内 tab 收敛 = Phase A.1 补强**（愿景核心，见 AC-A7/A8）。

### Phase A.2: 视频产物 panel 内播放（AC-A9 · 待做）

operator dogfood 发现（2026-06-12）：产物面板**漏了视频类型**。现状 `ThreadArtifactType = 'pr'|'image'|'audio'|'file'|'code'|'doc'` **没有 `'video'`**——视频文件被归成 `file`，命中二进制扩展名（mp4/mov/webm）→ 走「下载」分支，**不能在 panel 内播放**（图能看、音频能放，唯独视频只能下载）。与 AC-A7「点击看内容」愿景同源：视频也该点开就在 panel 内播放（`<video controls>`）。

跨层补充（独立 A.2，**不塞 A.1 收尾 PR**）：① shared `ThreadArtifactType` 加 `'video'`；② aggregator 识别视频产物（视频类 rich block / media 文件 / 视频扩展名）→ `type='video'`；③ `classifyArtifactView` 加 `video` 分支；④ `ArtifactDetailView` 加 `<video controls>` 渲染；⑤ 类型筛选 + 图标补 video。

### Phase B: 全局产物中心（未来扩展）

把聚合 scope 从"单 thread"放开到"全部"——独立页面，跨所有 thread 按名字 / 类型 / 时间 / 哪只猫做的搜产物，顺带解决"在 workspace 里搜半天"。**Phase A 的聚合管线就是 Phase B 的地基**，不重写。

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。 -->

### Phase A（Thread 内产物视图）✅ merged PR #2247（视觉待 alpha 验收）
- [x] AC-A1: `GET /api/threads/:threadId/artifacts` 返回该 thread 全部产物（rich blocks + 生成文件 + PR），按时间倒序，每项含 `type / name / catId / createdAt / sourceMessageId`。有 test 覆盖。（trace: "搜半天找不到" → 一次聚合拿全）
- [x] AC-A2: 产物可按类型筛选（图 / 文件 / 代码·PR / 语音 / 全部），各类计数与列表一致。（trace: "忘记名字" → 按类型缩小范围）
- [x] AC-A3: thread 内产物名搜索（子串匹配，不用记全名），命中实时过滤。（trace: operator experience"忘记名字是啥了"）
- [x] AC-A4: 每个产物可「跳回原消息」（`sourceMessageId` 锚点跳转），定位到生成它的对话位置。jump-with-load（planTeleport）覆盖窗口外老产物（cloud R4 修复）。（trace: "想看这个 thread 的某个产物"→ 找到还能回现场）
- [ ] AC-A5: 前端右侧抽屉面板，视觉对齐低保真设计稿（assets/F232/），图标用 inline SVG（**禁 emoji**，家规），≤3 张实现截图 + "需求→截图"映射表。**（前端面板 + inline SVG 已交付；视觉对齐验证 + 实现截图/映射表待 alpha 验收 — Maine Coon final review 已确认其余 AC + 全部 cloud finding 修复）**
  - **opus-47 愿景守护独立发现（alpha 前应补，复用现有 utility ≤30 行）**：① 时间维度缺失—`createdAt` 在 DTO 有但 UI 未渲染相对时间（mockup "刚刚/1小时前/昨天"）；② `catId` 显示原始字符串（如 "opus-47"）未复用项目昵称映射 utility（MessageNavigator/ThreadItem/SessionEventsViewer 已有）。
  - **其他 mockup-vs-实现 gap（入 Phase A.1 / 随 Phase B）**：PR 状态显示丢失（`task.status` 未透传，mockup "已合入"绿勾）、类型化 action（audio「播放」/diff「查看 diff」mockup 有，实现统一「打开」）、Phase B footer 入口未占位。
- [x] AC-A6: 聚合查询有 **Redis-backed 测试**覆盖（in-memory store 测不到索引/分页差异，LL `feedback_inmemory_store_tests_miss_redis_behavior`）。
- [x] **AC-A7（愿景核心 · Phase A.1）✅ merged PR #2259**: 点击产物**按类型直接查看内容**——docs/md/log/文本 复用 `FileContentRenderer`/`CodeViewer`/`MarkdownContent` 在 panel 内看正文（operator backlog 例子）、图看图、代码看 diff、语音播放、PR 打开。（trace: operator 2026-06-12 "我点击看不了他的内容" → 点产物就能看内容，不只列清单——这是 F232 的灵魂）。云端 5 轮 review 硬化：分类 allowlist 防二进制误判文本、uploads 跨域 fetch 带 credentials、workspace markdown basePath 解析相对引用。
- [x] **AC-A8（UX 收敛 → IA 升级 · Phase A.1 + AC-A8 修订）**: ~~右侧 panel 收敛成「一个开关 + 内部 tab」（状态/工作区/产物/transcript）~~ → **operator dogfood 后拍板方向 (b)（2026-06-13）**：产物从 PanelTabs 独立 tab（"狗皮膏药"）升为 workspaceMode 顶层入口（开发/记忆/调度/任务/社区/**产物**），PanelTabs 只剩 3 tab（状态/工作区/转录）。（trace: operator 2026-06-12 "上边儿按钮太多了" + 2026-06-13 "(b) 跟开发/记忆/调度/任务/社区平级做顶层入口"）
  - **PR #2259 交付**：✅ panel 收敛成单一开关 + 内部 tab（PanelTabs）、header 去多按钮、desktop（≥1024px）产物入口可达、close 行为修复。
  - **AC-A8 修订 ✅ merged PR #2278**：产物升为 workspaceMode 顶层入口（layers 图标 pill button）、PanelTabs 删产物 tab（4→3）、ArtifactsPanel flex 适配。云端 3 轮 review：R1 P1 Redis hydration whitelist + P2 mode reset 修、R2 P2 workspace search bar dev-only 修、R3 P2 race condition push back P3（pre-existing pattern）。+ F168 thread-preference 全 5 层端到端补齐。
  - **⬜ 小屏产物入口 → OQ 待 operator**：右侧 panel desktop-only（`hidden lg:block`），小屏走 `MobileStatusSheet` 尚未含产物入口。

### Phase A.2（视频产物 panel 内播放）✅ merged PR #2269
- [x] **AC-A9**: 视频产物点击在 panel 内播放（`<video controls>`），不再只「下载」。跨层改动：shared `ThreadArtifactType` 加 `'video'` + aggregator 识别视频源（mimeType 优先，扩展名 fallback）+ `classifyArtifactView` video 分支 + `ArtifactDetailView` video 渲染 + 类型筛选/图标补 video。7 个新测试覆盖（aggregator 4 + classify 2 + mimeType 优先级 1）。（trace: operator 2026-06-12 "忘记考虑视频之类的东西了" → 图/音/视频在 panel 内查看能力对齐 AC-A7 愿景）

### Phase B（全局产物中心）🚧 foundation merged PR #2285 + grouping merged PR #2288 + cat filter merged PR #2290（tooltip/Redis 优化待 follow-up）
- [x] AC-B1: 全局产物搜索页，跨 thread 按名字 / 类型 / 时间 / 猫聚合检索。**Foundation slice merged**：`[当前对话] [全局]` scope toggle + `GET /api/artifacts` 全局聚合 API + `useGlobalArtifacts` hook + thread badge + cross-thread teleport。**Grouping slice merged (PR #2288)**：三种分组模式（时间/对话/猫）可切换 chips + 可折叠分组 section + stable group id（P1 duplicate-label fix）+ 18 单元测试。**Cat filter + server-side query merged (PR #2290)**：`extractCatChips()` + `filterByCat()` 纯函数 + cat chip UI + `GET /api/artifacts?type=X&cat=X&q=keyword` server-side filtering + null catId→'—' sentinel 归一化（P1 fix）+ duplicate query param defense（cloud P2 fix）+ 11 web 测试 + 13 API 测试。**待 follow-up**：tooltip（OQ-B1）、Redis 索引优化（OQ-B2）。
- [x] AC-B2: 复用 Phase A 聚合管线，不重写采集层。（`GET /api/artifacts` 内部调 `aggregateThreadArtifacts()` per-thread，flatten + sort）

## Dependencies

- **Related**: F148（复用 `artifact-tracking.ts` 去重/分类逻辑 + 解除 MAX_ARTIFACTS=5）
- **Related**: F063（Hub Workspace Explorer — Claude.ai Artifacts panel 风格可借鉴；F063 是 repo 文件树视角，F232 是 thread 产物聚合视角，scope 不重叠）
- **Related**: F095（Thread Sidebar — 抽屉面板 UI 落点参考）
- **Related**: F131（Workspace Navigator — 文件导航 / 打开能力复用）

## Risk

| 风险 | 缓解 |
|------|------|
| rich blocks 无 kind 索引，大 thread 遍历消息提取慢 | Phase A 按 thread 规模评估；必要时加 Redis 反向索引 `artifacts:thread:{id}`（消息附加时写入）。OQ-2 |
| 跨 session 同一文件被多次 touch，去重规则 | 复用 `artifact-tracking.ts` 去重 + 记录首次出现/末次修改时间 |
| in-memory route 测试假绿（掩盖 Redis 索引/分页差异） | AC-A6 强制 Redis-backed 测试 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 形态 = thread 内产物视图（A）先行，全局中心（B）为未来扩展，A 是 B 的地基 | 最贴operator experience"这个 thread 的产物"+ 数据层现成最快见效 + 不返工。operator 拍板 | 2026-06-11 |
| KD-2 | 图标用 inline SVG，禁 emoji（家规 `feedback_design_to_code_fidelity`）。**html_widget 沙箱里 SVG 必须 inline，`symbol`+`use` 引用会被无 same-origin 的 sandbox iframe 挡掉只剩空槽** | 本 feat 低保真 mockup 实测教训（v2 用 symbol/use → operator侧图标全空；v3 改 inline → playwright 验证 28/28 渲染） | 2026-06-11 |
| KD-3 | 数据层复用 artifact-tracking（F148）+ rich blocks + session digest，不新建采集 | 现状 ~80% 数据已存在，缺的是聚合 + UI，避免重造 | 2026-06-11 |
| KD-4 | **产物系统核心 = "点击看内容"（复用 workspace `FileContentRenderer`），产物列表只是入口** | operator dogfood 实证"我点击看不了他的内容"——列清单 ≠ 看产物；mockup 每项本就有类型化 action（打开/下载/查看 diff/播放）；"和 workspace 整合"的本质是**复用查看器**而非 UI 摆位。Phase A 首版简化成"列表+外部 url"丢了核心 → Phase A.1 必补 | 2026-06-12 |
| KD-5 | 视频产物支持开独立 **Phase A.2**，不塞 A.1 收尾 PR | 视频是跨 shared `ThreadArtifactType` 类型层的新增（image/audio 已支持，video 缺）；A.1（PR #2259）已过两轮 review 接近收尾，塞入会让其重新变大、需重新完整 review。operator 拍板 | 2026-06-12 |
| KD-6 | 产物从 PanelTabs 独立 tab 升为 workspaceMode 顶层入口（AC-A8 修订） | operator dogfood 觉得产物做独立 panel tab 像"狗皮膏药"——位置不自然。operator 拍板 (b)：产物与开发/记忆/调度/任务/社区平级做 workspaceMode，PanelTabs 只剩 3 tab。实现上 rightPanelMode 移除 'artifacts'、workspaceMode 新增 'artifacts'、ArtifactsPanel 挂到 WorkspacePanel 条件渲染 | 2026-06-13 |

## Design Gate

- **UX（前端）**：✅ 低保真 wireframe 已出 + operator 确认（"我觉得ok了"，2026-06-11）。Architecture cell / design-in-context 截图映射 / Redis 测试契约在 `writing-plans` 前补齐。
- **Architecture cell**: 待 writing-plans 前确认（候选 threads / cats-messaging surface）；Map delta: update required（新增 artifacts 聚合 endpoint + thread 抽屉面板）。
- **Eval Contract**: 不触发（产品 feature，非 harness/skill/MCP/shared-rules）。

## Review Gate

- Phase A: 后端聚合 API + 前端面板 → 跨族 review（@gpt52 / @codex）；UX 风格 → @gemini 守门。
