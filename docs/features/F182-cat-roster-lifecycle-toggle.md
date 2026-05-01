---
feature_ids: [F182]
related_features: [F127, F032, F167, F086]
topics: [cat-management, roster, lifecycle, toggle, mention-routing, mcp-tools, hub-ux]
doc_kind: spec
created: 2026-04-30
---

# F182: Cat Roster Lifecycle Toggle — 成员启停的全链路降级反馈

> **Status**: spec | **Owner**: Ragdoll（Ragdoll/Opus 4.7） | **Reviewer**: Ragdoll（@opus 4.6）+ Maine Coon（@codex/Maine Coon） | **Priority**: P1

## Why

**team lead 2026-04-30 原话**（thread `thread_molhvy2v84woqas9`）：

> "咱 成员协助总览里面能停止 使用某些猫猫吗？或者说支持配置一个 enable disable 其实这还涉及到就是动态注入队友？比如 disable 的时候提示词或者说 harness 给你们注入队友就要不注入这些队友 避免你们调用，然后调用比如发 mcp at 他们也应该报错？这个报错就是告诉你们这个队友 disable 了换一个？"

### 现状盘点（F127 done 后的真实交付水位）

F127（done 2026-04-29）覆盖了**猫猫实例 CRUD + 别名路由**。下面四件事已经做了一半：

| 层 | 现状 | 文件证据 |
|---|---|---|
| ① UI toggle 开关 | ✅ 已有 — Hub `HubMemberOverviewCard` 的"已启用 / 未启用" badge 是个真按钮，点一下走 `onToggleAvailability` → 写入 `cat.roster.available` | `packages/web/src/components/HubMemberOverviewCard.tsx:60-73, 254-266` |
| ② 队友名册注入抑制 | ✅ 已有 — `buildTeammateRoster` 用 `isCatAvailable(id)` 过滤 disabled 猫，注入到 system prompt 的 roster 里看不到这只猫 | `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts:392` |
| ③ A2A 路由层过滤 | ✅ 已有 — `analyzeA2AMentions` / `AgentRouter.isRoutableCat` 都在路由前 `isCatAvailable` 跳过 | `packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts:92`, `AgentRouter.ts:275, 415` |
| ④ 调用 disabled 猫的反馈 | ❌ **当前是静默 skip** — 调用方完全不知道为什么对方没接，分不清"对方在思考"还是"对方根本没收到" | — |

也就是说，**disable 一只猫之后路由确实把她屏蔽了，但没有一个声音告诉调用方"她被屏蔽了"**。这对team lead、对猫、对用户都是黑箱。team lead的核心诉求 #③ 命中的就是这层缺口。

### 为什么单 issue 挂不上 F127

F127 已经 close（done），ledger 不该 reopen。这是 F127 完成度水位之上的**新增 lifecycle 层能力**——把"静默屏蔽"升级为"显式可观测降级反馈"，并把同一套契约推到所有 MCP 调度入口。涉及 4 个层、9 个 MCP 工具，规模超过 issue 范畴。

## What

### 一句话

把 roster `available` 字段从"路由静默 skip 的开关"升级为"全链路结构化降级契约"——所有调度入口（system prompt、A2A、MCP 写工具、Hub）在遇到 disabled 猫时返回一致的、可观测的、带 alternatives 提示的反馈。

### Phase A: 结构化错误契约 + Resolver 闸门

**新增公共类型 + Resolver 单点闸**——所有 MCP 写工具 + 前端 @ 入口共享一套：

```ts
// packages/shared/src/types/cat-routing.ts
export type CatRoutingError =
  | { kind: 'cat_not_found'; mention: string; alternatives: CatAlternative[] }
  | { kind: 'cat_disabled'; catId: CatId; displayName: string; alternatives: CatAlternative[] };
// NOTE: cat_no_quota 不在 F182 范围（KD-5），reviewer matcher 的"没猫粮"暂保留独立语义

export interface CatAlternative {
  readonly catId: CatId;
  readonly mention: string;
  readonly displayName: string;
  readonly family: string; // 同族优先排前面
}
```

**位置**：在现有 `mention-parser.ts` / `AgentRouter.isRoutableCat` 之上加一层 `resolveCatTarget(mentionOrId): { ok: CatId } | { error: CatRoutingError }`，作为所有 MCP 写工具和 A2A 调度的统一闸。

**Resolver 必须覆盖 5 个入口（KD-4，Maine Coon P1-1 反馈）**——不止"消息体 @ parser"：

| 入口 | 字段 | 当前现状 |
|---|---|---|
| 文本 @ | 消息 content body 里的 `@xxx` | a2a-mentions.ts 已 skip，但需改为返回结构化 errors |
| `post_message.targetCats` | 结构化数组 | callbacks.ts:613 只做 `catRegistry.has()`，**未校验 available** ⚠️ |
| `cross_post_message.targetCats` | 同上 | 同上 ⚠️ |
| `multi_mention.targets/callbackTo` | targets 数组 + callback 字段 | 仅做 catRegistry.has，未校验 available ⚠️ |
| `start_vote.voters` | 投票 voters 数组 | 同上 ⚠️ |
| `register_scheduled_task.params.targetCatId` | 单字段 | 同上 ⚠️ |

**关键**：disabled 在文本 @ parser 被过滤但**结构化目标字段直进 enqueueA2ATargets** = disable 不是闸，只是提示词/UI 层过滤。Maine Coon review 锚点：[callback-tools.ts:214](packages/mcp-server/src/tools/callback-tools.ts) + [callbacks.ts:613](packages/api/src/routes/callbacks.ts)。

**4.6 实现纠正（必读）**：

1. **Resolver 不能直接复用 `isCatAvailable`** — `cat-config-loader.ts:911` 的实现是 `entry?.available !== false`，**不在 roster 的猫 = available**（backward compat）。Resolver 的 `cat_not_found` 路径必须先查 roster 区分两种情况：(a) 不在 roster → `cat_not_found`；(b) 在 roster 但 `available: false` → `cat_disabled`。两步判断不能合一。

2. **a2a-mentions.ts:92 vs AgentRouter.ts:415 改法不同** — `a2a-mentions.ts:92` 的 skip 在 **pattern building 阶段**（disabled 猫的 mentionPatterns 根本不进 entries 数组），改造时需要先让所有猫的 pattern 都参与匹配，再在命中后调 resolver 检查可用性，命中 disabled 时生成 warning。`AgentRouter.ts:415` 的 skip 是 **match-time skip**（已经匹配到了），改造更直接。两个 skip 点不能用同一套 patch。

3. **Resolver 必须是纯函数 30-40 行** — 4.6 警告"如果 >50 行说明抽象膨胀"。alternatives 排序 + dedupe + family/lead 优先用纯比较函数实现，不引入 class/service。

### Phase B: Roster 不可见性守护（防回归）

**OQ-3 team lead拍板（2026-04-30）：方案 C — 完全不出现**。原话：

> "别出现啊！直接别再系统提示词里出现做不到吗？！人家都 disable 好像不需要提到吧？"

也就是说——Maine Coon（独立区段）和 4.6（行内标注）都想多了，team lead选**最简方案**：disabled 猫从 system prompt **完全消失**，不需要任何标注或替代提示。

**当前行为已经满足**：`buildTeammateRoster` 的 line 392 已经用 `isCatAvailable(id)` 过滤掉 disabled 猫。Phase B 不改 prompt 注入逻辑。

**Phase B 降级为守护测试**（防止未来重构回归）：
- 测试覆盖 disabled 猫**不出现在** buildTeammateRoster 输出
- 测试覆盖 disabled 猫**不出现在** system prompt 任何区段（pattern grep）
- 兜底依靠 Phase C 的 MCP 错误反馈 + alternatives——猫如果（凭旧记忆）误 @ disabled 猫，会拿到结构化错误 + natural language message 引导换人

### Phase C: MCP 写工具接入降级反馈（修订清单）

> **Maine Coon P1-2 反馈**：之前清单里 `update_task` / `register_pr_tracking` 是错的——`update_task` 没 assignee 字段，`register_pr_tracking.catId` deprecated 被服务端忽略。

**A 类（消息路由 — 软降级 best-effort）**：

| 工具 | 入口字段 | 行为 |
|---|---|---|
| `cat_cafe_post_message` | 消息体 @ + `targetCats` | 在线目标继续发，disabled 目标返回 `routing_warnings`；**结构化 targetCats 全不可路由 → `isError: true` + `routed: []`**（KD-4，避免 final-routing guard 误判"已传球"） |
| `cat_cafe_cross_post_message` | 同上 | 同上 |
| `cat_cafe_create_rich_block` | mentions 字段 | 同上 |

**4.6 强化（KD-7）**：A 类响应必须同时返回 **natural language `message` 字段**，让 LLM 不必依赖 metadata 解析。模板：

```json
{
  "ok": true,
  "routing_warnings": [{ "kind": "cat_disabled", "mention": "@codex", "alternatives": ["@gpt52", "@spark"] }],
  "message": "消息已送达 @opus, @gemini。⚠️ @codex 已停用，如需Maine Coon协助请改 @gpt52 或 @spark"
}
```

LLM 读 `message` 就够了——结构化 warnings 是给 UI/telemetry 的。

**A' 类（multi_mention — 契约式硬失败）**（OQ-1 拍板，Maine Coon反馈）：

| 工具 | 入口字段 | 行为 |
|---|---|---|
| `cat_cafe_multi_mention` | `targets` / `callbackTo` | request/response 契约，**hard fail**——disabled targets 直接 400 `cat_disabled` + alternatives，调用猫必须重发；不引入 `skipped` 状态膨胀 orchestrator |

**B 类（assignee/owner 是猫 — 契约式 400）**：

| 工具 | 入口字段 | 行为 |
|---|---|---|
| `cat_cafe_create_task` | `ownerCatId` | 400 `cat_disabled` + alternatives |
| `cat_cafe_start_vote` | `voters[]` | 400（任一 voter disabled） |
| `cat_cafe_register_scheduled_task` | `params.targetCatId` | 400 `cat_disabled` + alternatives |

**剔除（之前清单错）**：
- `cat_cafe_update_task` — 当前 schema 没 assignee 字段（[callback-tools.ts:471](packages/mcp-server/src/tools/callback-tools.ts)）
- `cat_cafe_register_pr_tracking.catId` — deprecated 字段服务端已忽略（[callbacks.ts:1269](packages/api/src/routes/callbacks.ts)）。PR tracking 涉及的"调用猫自身被 disable 但旧 invocation 还活着"是另一个问题，留独立 issue

**P2（Maine Coon补充）— MCP wrapper 错误前缀**：MCP 协议把 400 包装成 `Callback failed (400): <body>` 文本，LLM 解析不稳定。要求 mcp-server 对 `CatRoutingError` 生成**固定人类可读前缀** + JSON 双轨：

```
Cat routing failed [kind=cat_disabled] target=@gemini25 disabled.
Alternatives: @gemini, @opus-45.
{"kind":"cat_disabled","catId":"gemini25","alternatives":[...]}
```

### Phase D: Hub Toggle UX + Side-Effect Awareness

> **OQ-2 拍板（Maine Coon反馈）**：进 F182，但做 server-side impact preview endpoint，不在 useCatData 拼三套查询。

- 新增 `GET /api/cats/:catId/disable-impact` 端点 — server 端聚合该猫的进行中引用：
  - `tasks`：assignee 是该猫的开放 task（直接扫 task store）
  - `scheduledTasks`：owner 是该猫的活跃 schedule（直接扫 schedule meta）
  - PR tracking 不在 caller-replaceable scope，不聚合
- **首版不增索引**，扫描当前存储够用（量小）；响应 shape 统一，不强迁移底层模型
- Hub UI toggle disable 前先 GET 该端点，弹轻量确认："禁用 X 后，以下进行中引用会变为待重指派：[N 个 task / M 个 schedule]，是否继续？"
- 确认后 disable，引用不强迁移，**只标 "owner 已停用，等待重指派"**（AC-D2）

## Acceptance Criteria

### Phase A（错误契约 + Resolver 闸）
- [ ] AC-A1: `CatRoutingError` 类型 export 到 `@cat-cafe/shared`，**两种** kind（`cat_not_found` / `cat_disabled`）— `cat_no_quota` 不在范围（KD-5）
- [ ] AC-A2: `resolveCatTarget()` 单点 resolver 实现 — **纯函数 ≤40 行**（KD-8）；单元测试覆盖两种错误路径 + alternatives 排序（同族 + lead 优先 + dedupe + 稳定排序避免竞态）；`cat_not_found` 路径必须先查 roster 区分"不在 roster"和"在 roster 但 disabled"两种情况，**不能直接复用 `isCatAvailable`**（KD-9）
- [ ] AC-A3: Resolver 接入 **5 个入口**（KD-4）：文本 @ parser / `targetCats` / `multi_mention.targets+callbackTo` / `start_vote.voters` / `register_scheduled_task.params.targetCatId`。a2a-mentions.ts:92 改造（pattern building 阶段）和 AgentRouter.ts:415 改造（match-time skip）**分别处理**（KD-10）；保留向后兼容（mentions 列表不变，新增 errors 列表）

### Phase B（Prompt 降级提示）
- [ ] AC-B1: 守护测试 — disabled 猫**不出现在** `buildTeammateRoster` 输出（基于 OQ-3 拍板，team lead选方案 C 完全不出现）
- [ ] AC-B2: 守护测试 — disabled 猫的 catId / mention pattern **不出现在** `buildStaticIdentityPrompt` 任何区段（pattern grep 整个 prompt）
- [ ] AC-B3: 不改 `buildTeammateRoster` 逻辑 — 当前 line 392 `isCatAvailable` 过滤已正确，仅补测试

### Phase C（MCP 工具降级反馈）
- [ ] AC-C1: 3 个 A 类工具（post / cross / rich）软降级 — 在线 @ 继续路由 + `routing_warnings`；**结构化目标全不可路由时 `isError: true` + `routed: []`**（防 final-routing guard 误判）；响应 **必须含 natural language `message` 字段**（KD-7），单元测试覆盖文案模板
- [ ] AC-C2: 1 个 A' 类工具（`multi_mention`）+ 3 个 B 类工具（`create_task.ownerCatId` / `start_vote.voters` / `register_scheduled_task.params.targetCatId`）契约式 **400** `cat_disabled` + alternatives
- [ ] AC-C3: MCP wrapper 对 `CatRoutingError` 生成固定人类可读前缀 + JSON 双轨（KD-6），单元测试覆盖文本格式
- [ ] AC-C4: MCP 工具描述更新，让 caller LLM 知道 `routing_warnings` / 400 `cat_disabled` 含义和如何选 alternatives

### Phase D（Hub UX）
- [ ] AC-D1: 新增 `GET /api/cats/:catId/disable-impact` 端点，server-side 聚合 task / scheduledTask 引用（PR tracking 不在范围）
- [ ] AC-D2: Hub Toggle disable 前调用该端点，弹确认弹窗显示影响；确认通过后 disable 不强迁移，引用标"owner 已停用，等待重指派"
- [ ] AC-D3: Hub 上单独一行显示 disabled 成员（"已停用"灰色 badge），可一键启用

## Dependencies

- **Evolved from**: F127（猫猫管理重构 — CRUD 基建）
- **Related**: F032（CatRegistry / Roster 基础架构）
- **Related**: F167（A2A Chain Quality — KD-20 restrictions / KD-21 model surface 风格参考）
- **Related**: F086（Cat Orchestration — 元认知避免反复 @ 不在的猫）

## Risk

| 风险 | 缓解 |
|---|---|
| MCP 工具加 warning 后 LLM 解析行为变化（特别是 Codex/GPT 系列） | warning 只是 metadata，不阻断；先在 Claude 系列验证，再推 Codex |
| Resolver 单点变热路径瓶颈 | resolver 是纯内存查 `isCatAvailable` + alternatives 排序，无 IO；性能基准测试覆盖 |
| disabled 猫的进行中 task/PR 强制迁移 = 丢工作 | 选择"标记 + 等重指派"而非强迁移，AC-D2 显式约束 |
| 两猫同 alias 但一只 disabled — alternatives 排序歧义 | resolver 内部 dedupe，alternatives 按 family 同/跨 + lead 标签排 |

## Key Decisions

> Maine Coon + 4.6 双 review 拍板（2026-04-30）。

| # | 决策 | 理由 |
|---|---|---|
| KD-1 | `available: false` 是 disable 的唯一真相源，不引入新字段 | 现有 `roster.available` 已贯通 UI/prompt/A2A 三层，避免双真相源 |
| KD-2 | 错误路径三档 — A 软降级 + warning / A' 结构化全失败 isError / B/A' 契约式 400 | 域语义决定：消息路由 = 尽力投递（4.6："邮递员不会因为一个收件人不在就退回所有信"）；任务指派 = 契约式绑定（不能把工作分给不存在的人）；一刀切要么牺牲 delivery 要么牺牲 correctness |
| KD-3 | 改 buildTeammateRoster 必跑 SystemPromptBuilder 守护测试 | CLAUDE.md Ragdoll专属规则：`node --test test/system-prompt-builder.test.js` |
| KD-4 | Resolver 必须覆盖 5 个入口（不止文本 @） | Maine Coon P1-1：`post_message.targetCats` 等结构化字段当前只校验 `catRegistry.has()`，disabled 直进 enqueueA2ATargets；不修等于 disable 只是 UI 装饰 |
| KD-5 | `cat_not_found` / `cat_disabled` 两种 kind，不新增 `cat_no_quota` | 4.6 OQ-4：reviewer matcher 是自动选择逻辑（从候选池排除），CatRoutingError 是指名路由逻辑（指定了 @X 但她不可用），两种失败模式不该混；reviewer matcher 现有"没猫粮"保留独立路径 |
| KD-6 | MCP wrapper 对 `CatRoutingError` 输出固定人类可读前缀 + JSON 双轨 | Maine Coon P2：MCP 协议把 400 包装成 `Callback failed (400): <body>` 文本，LLM 解析不稳定；前缀格式 `Cat routing failed [kind=...] target=@x ...` 让 LLM 即使 JSON 解析失败也能识别 |
| KD-7 | A 类响应增加 natural language `message` 字段 | 4.6 OQ-1 强化：metadata-only warning 不可靠激发 LLM 反应；message 是给 LLM 的人话，warnings/structured 是给 UI/telemetry 的；模板见 Phase C |
| KD-8 | Resolver 必须是纯函数（30-40 行硬上限），不引入 class/service | 4.6 retraction 回应：resolver 抽象的价值在 alternatives 排序 + 类型安全，超过 50 行说明抽象膨胀；alternatives 排序用纯比较函数 |
| KD-9 | Resolver 的 `cat_not_found` 路径不能直接复用 `isCatAvailable` | 4.6 实现纠正：`isCatAvailable` 当前 `entry?.available !== false`——不在 roster 的猫返回 true（backward compat）；resolver 必须先查 roster 区分"不在"（cat_not_found）和"在但 disabled"（cat_disabled） |
| KD-10 | a2a-mentions.ts:92 改造和 AgentRouter:415 改造分别处理 | 4.6 实现纠正：92 行 skip 在 pattern building 阶段（disabled 的 patterns 根本不进 entries），需要先让全部 pattern 参与匹配再调 resolver；415 行 skip 是 match-time skip，改造直接；不能用同一套 patch |
| KD-11 | disabled 猫从 system prompt 完全消失，不加任何标注 / 替代提示 / 区段 | team lead OQ-3 拍板（2026-04-30）："已 disable = 不需要提到"。当前 buildTeammateRoster:392 的过滤行为已满足；Phase B 仅加守护测试防回归；猫如凭旧记忆误 @ 由 Phase C 的 MCP 错误反馈兜底 |

## 涉及文件

### 新增
- `packages/shared/src/types/cat-routing.ts` — `CatRoutingError` + `CatAlternative` 类型
- `packages/api/src/domains/cats/services/agents/routing/cat-target-resolver.ts` — 单点 resolver（纯函数 ≤40 行，KD-8）
- `packages/api/src/routes/disable-impact.ts` — `GET /api/cats/:catId/disable-impact` endpoint（Phase D，OQ-2 服务端聚合）
- `packages/api/test/cat-target-resolver.test.js` — resolver 单元测试

### 修改
- `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts:392` — **不改注入逻辑**（KD-11 team lead拍板：disabled 不出现）；仅 Phase B 守护测试覆盖
- `packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts:92` — pattern building 阶段改造（KD-10）：先让全部 pattern 参与匹配，再 resolver 检查 → 生成 warning
- `packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts:275, 415` — match-time skip 改造（KD-10），改造路径与 a2a-mentions 不同
- `packages/api/src/routes/callbacks.ts` — 7 个 MCP 写工具 handler 接 resolver（A=3 软降级 + A'=1 硬 + B=3 硬，见 Phase C 表）
- `packages/web/src/components/HubMemberOverviewCard.tsx` — disabled 灰行 + side-effect 弹窗（调用 disable-impact endpoint）
- `packages/web/src/hooks/useCatData.ts` — 调用 `/api/cats/:catId/disable-impact`，**不在前端拼三套查询**（OQ-2 拍板）
- `packages/mcp-server/src/tools/callback-tools.ts` — wrapper 错误前缀双轨（KD-6）

### 测试
- `packages/api/test/system-prompt-builder.test.js` — 守护测试：disabled 猫不出现在 buildTeammateRoster + 不出现在 buildStaticIdentityPrompt 任何区段（pattern grep）
- `packages/api/test/connector-command-layer.test.js` — A 类工具软降级 + 结构化全失败 isError + natural language message 模板
- `packages/api/test/callbacks.test.js`（如有） — A'/B 类工具 400 错误 + alternatives + wrapper 文本前缀

## Phases / Timeline

| 日期 | 事件 |
|---|---|
| 2026-04-30 | 立项 — team lead thread `thread_molhvy2v84woqas9` 提出，Ragdoll盘点确认 4 层水位 |
| 2026-04-30 | Maine Coon（Maine Coon GPT-5.5）spec review — 提两个 P1（结构化字段缺口 / B 类清单错误）+ 拍板 4 个 OQ；spec 修订到 v2 |
| 2026-04-30 | 4.6（Ragdoll Opus）spec review — 3 处技术纠正（KD-9/10 + 命名）+ OQ-1 增强（KD-7 natural language message）+ KD-8（resolver ≤40 行）；OQ-3 与Maine Coon分歧（独立区段 vs 行内标注），转team lead拍板；spec 修订到 v3 |
| 2026-04-30 | team lead OQ-3 拍板 — 方案 C "完全不出现"（驳回Maine Coon A + 4.6 B），Phase B 降级为守护测试；KD-11 落定；spec 修订到 v4，**Design Gate 收尾，进 worktree** |
| TBD | Phase A 实施 — 错误契约 + 5-入口 resolver（types + cat-target-resolver.ts ≤40 行） |
| TBD | Phase B 实施 — 守护测试防回归（不改注入逻辑，KD-11） |
| TBD | Phase C 实施 — 7 个 MCP 工具接入（A=3 软 + A'=1 硬 + B=3 硬）+ wrapper 前缀双轨 + KD-7 message 模板 |
| TBD | Phase D 实施 — Hub UX（disabled 灰行 + 弹窗）+ disable-impact endpoint（服务端聚合，不在 useCatData 拼） |

## Review Gate

- **Spec review**：@opus 4.6 + @codex Maine Coon（2026-04-30 拉起）
- **Design Gate**：4 个 OQ 拍板后才进 worktree
- **Phase 独立 review**：A → B → C → D，每 Phase squash merge 一次
- **愿景守护**：merge 后由非作者非 reviewer 的猫做（候选：@gemini25 / @gpt52）
