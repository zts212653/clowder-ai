---
feature_ids: [F262]
related_features: [F127, F154, F224, F244]
topics: [thread-settings, cat-runtime, reasoning-effort, hub, cost-control]
doc_kind: spec
created: 2026-07-10
description: "让每个支持 effort 的猫在不同 thread 使用独立思考档位，同时保持路由与猫猫全局默认配置彼此正交。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-11T01:28:00Z
---

# F262: Per-Thread Cat Effort Overrides — 对话级猫猫思考档位

> **Status**: done | **Completed**: 2026-07-11 | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

> **operator UX signoff**: 2026-07-10 — “我同意你这个设计挺好的，你可以先feat 立项？把feat md写清楚先？”

> **编号核验**: 立项前已检查 `docs/ROADMAP.md`、`docs/features/`、Git 历史、远端分支/标签、GitHub PR/Issue 与记忆图；当前最大真实编号为 F261。唯一 `git log -S F262` 命中来自 commit `b69cd29c8` 新增的二进制 PNG 字节，非文本 Feature 占用；记忆图唯一命中为本次立项 thread。

## Why

同一只猫在不同对话里的工作性质不同：执行任务时 `xhigh` 已足够，共创建筑级方案时则可能需要 `max`。如果 effort 只能配置在猫猫实例上，operator就必须反复修改全局默认值，既会影响其他并行 thread，也无法表达“这个 thread 里的这只猫应该更深地想”这一稳定意图。

operator experience（2026-07-10）：

> “有的thread的你我希望能是max 的思考额度，有的我希望是xhigh就够了……执行任务基本xhigh就够了！但是有的和我共创具体的架构设计，我需要你的max。”

> “在首选猫里改吗？可是首选猫的逻辑是没有具体at fallback到哪里。”

> “每只猫只要能设置 effort 都能这里设置，不只是你这只sol？”

因此目标不是给 Sol 增加一个特殊开关，也不是改变首选猫路由，而是建立一个通用、持久、模型能力感知的 **thread × cat effort override**：先决定谁回复，再决定这次回复用多大的思考档位。

## Current State / 现状基线

1. F127 已提供猫猫实例级 effort 默认值；`getCliEffortOptionsForProvider(provider, model)` 是共享能力真相源：Anthropic 支持 `low/medium/high/max`，旧 OpenAI 支持到 `xhigh`，GPT-5.6 额外支持 `max/ultra`，不支持 effort 的 Provider 返回 `null`（`packages/shared/src/cli-effort.ts:3-63`）。
2. Codex 与 Claude provider 每次 invocation 都会重新组装 CLI 参数，但当前只读取猫猫实例默认值：Codex 注入 `model_reasoning_effort`，Claude 注入 `--effort`（`CodexAgentService.ts:741-754`；`ClaudeAgentService.ts:369-379`）。没有 thread 级输入。
3. Thread 三点菜单当前依次提供“设置默认猫猫 / 重命名对话 / 导出对话 / …”，没有运行时 effort 入口（`ThreadItem.tsx:287-313`）。
4. `memberSessionStrategy` 已证明 `(threadId, catId)` 持久化、owner/access guard、shared-default-thread 防串写的形状可复用；但 effort 不是 session continuation 语义，不能塞入该字段或复用其 UI 名义（`ThreadStore.ts:197-200,639-670`；`thread-member-strategy.ts:40-120`）。
5. 当前无办法做到“同一只 Sol 在执行 thread 用 xhigh、架构 thread 用 max”，也无办法在不改变 preferred cats 的前提下提前配置稍后将被 `@` 的猫。

## Design Contract / 设计契约

### 1. 两层配置，一条解析链

```text
猫猫实例 effort（F127）                 = 全局默认
thread × cat effort override（F262）    = 当前对话覆盖

实际调用：thread override > 猫猫实例默认 > Provider 默认
```

解析顺序必须保持正交：

```text
@mention / preferred cats / fallback 先解析实际 catId
                         ↓
读取 (threadId, actualCatId) effort override
                         ↓
按 effective provider + model 校验后注入本次 invocation
```

preferred cats 只回答“谁来回复”，effort override 只回答“被选中的猫用多大思考档位”。显式 `@codex-sol` 必须读取 Sol 的 thread override，即使本 thread 的首选猫是另一只猫。

### 2. 能力范围

- 所有 enabled 且 `getCliEffortOptionsForProvider(provider, model) !== null` 的猫都可设置，不按品种或 Sol 身份硬编码。
- 选项直接来自共享 capability helper；前后端不得复制一份 effort 枚举矩阵。
- 不支持 effort 的 Provider 不出现在可配置列表中。
- 猫的 effective model 改变后，旧 override 若不再合法，invocation 必须 fail-closed 到继承值，绝不能把非法参数传给 CLI；持久化原值可保留，以便模型切回后恢复用户意图，但 API/UI 必须明确返回“不兼容、当前实际继承”的状态。

### 3. 持久化与 API

- 持久化单位：`(threadId, catId) -> CliEffortValue`；不存在记录表示 inherit，`null` 写入表示清除 override。
- 用户状态 TTL 必须为 0；重启、恢复 session、切换页面后仍存在。
- Store 使用显式方法，不允许 route 直接读写 Redis：
  - `updateMemberEffort(threadId, catId, effort | null)`
  - `getMemberEffort(threadId, catId, userId)`
  - `getMemberEfforts(threadId, userId)`：一次读取本 thread 的全部 raw overrides，collection GET 不做逐猫 store round-trip。
- API 使用独立 effort 契约，不扩张 session strategy，也不创建泛化的“任意 runtime settings”框架：
  - `GET /api/threads/:id/members/effort`：一次返回全部 effort-capable rows，避免前端 N+1。
  - `PATCH /api/threads/:id/members/:catId/effort`：写入显式值或 `null`。
- GET row 返回：`catId / displayName / options / override / inherited / effective / source / compatibility / isParticipant`；`source` 只表达 `thread_override | inherited`，不把派生状态重复持久化。
- Route 必须校验身份、thread access、catId、provider/model capability 与选项合法性；shared default thread 因底层值不是 per-user，不允许读写用户 override，避免跨用户泄漏。
- Redis 使用 thread detail hash 的独立 `memberEffort:<catId>` field，并通过现有 detail-field retention helper 写删：不存在 thread 时不制造 ghost hash，线程硬删除时随 detail hash 一起删除，soft-delete/restore 则保留用户意图。
- Collection 只返回当前 enabled 且 effort-capable 的猫；disabled 猫的 raw override 暂存为 dormant state，不在 UI 暴露，重新 enabled 后按当前模型重新解析。

### 4. Invocation 边界

- `invoke-single-cat` 在实际 catId 已确定后读取 override，并通过 typed `AgentServiceOptions` 字段传给 Provider；禁止塞进 `callbackEnv` 或通用字符串袋。
- Codex 与 Claude 都消费同一解析结果；Provider 仍负责最终 effective-model 校验与 CLI 参数组装。
- 每次 invoke（包括 resumed session）都会重新计算，因此设置从下一次回复生效，不需要重建 thread 或 reborn session。
- runtime 读取 override 失败时保持可用性、降级到继承值，但必须写 warning 并产出一次可见 `system_info`，不能静默假装 thread 设置已生效。
- 路由、session continuation、context window 和 effort 是四条独立轴；F262 不修改它们之间的优先级。

## What

### Phase A: Thread × Cat Effort Contract

1. 增加共享 API 类型、ThreadStore 持久化方法和 Redis/Memory 实现。
2. 增加 collection GET + per-cat PATCH route，覆盖 access、shared default thread 与 capability validation。
3. 在 invocation 边界解析 `thread override > cat default > provider default`，通过 typed option 传入 Codex/Claude provider。
4. 用状态机测试覆盖 explicit mention、preferred/fallback、resume、模型切换与 stale incompatible override。
5. 更新 `identity-session` ownership map 的 `identity-agent config` 扩展点；ThreadSidebar 只是入口，不把运行时配置归入 thread-navigation 语义。

### Phase B: Hub Thread Effort Surface

1. 在 thread `⋮` 菜单中，把“思考档位”作为“设置默认猫猫”的平级项，紧跟其后。
2. 打开锚定式 popover：当前 thread 已参与的 effort-capable 猫优先展示；“其他猫猫…”支持搜索/展开全部 enabled、effort-capable cats。
3. 每行展示猫头像/名称、`继承（当前值）` 与该猫 effective provider/model 支持的选项。
4. 选择后即时持久化，并显示“从下一次回复生效”；窄屏下 popover 限高滚动并保持在 viewport 内。
5. 添加 F244 capability tip，指向 `⋮ → 思考档位` 的真实入口。

## User Journey

### Primary Journey: 给当前对话里的猫选择思考档位

- **Scope unit**: thread × cat
- **Actor**: operator
- **Entry**: ThreadSidebar 中目标对话的 `⋮` 菜单
- **Flow**:
  1. operator打开 thread `⋮` → 在“设置默认猫猫”下面看到平级入口“思考档位”。
  2. 点击“思考档位” → 面板优先列出当前参与的、支持 effort 的猫，并显示各自当前生效状态，例如 `小太阳·Maine Coon　继承（xhigh）`。
  3. operator把 Sol 改为 `max` → UI 确认已保存，并提示“从下一次回复生效”。
  4. 下一次在本 thread 显式 `@codex-sol`、通过首选猫命中 Sol、或 fallback 到 Sol 时，均使用 `max`；其他 thread 仍使用 Sol 的全局默认值。
  5. 选择“继承” → 清除本 thread override，立即显示最新猫猫实例默认值。
- **Success evidence**: Alpha 截图（菜单入口、参与猫列表、其他猫搜索、继承/显式值状态）+ 15 秒录屏 + Provider argv 回归测试。
- **Non-goals**: 不自动根据“架构/执行”等文本分类切档；不改变 preferred cats 或 @ 路由；不增加 thread 级 context window；不为不支持 effort 的 Provider 伪造选项；首版不增加 Connector `/effort` 命令。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | thread × cat | operator | “其他猫猫…”搜索尚未参与的猫 → 预设 effort → 稍后首次 `@` 即生效 | UI test + Alpha 录屏 |
| S2 | thread × cat | operator | 猫的全局 effort 改变 → thread 选择“继承”的行自动显示并使用新值 | API + UI integration test |
| S3 | invocation | 猫猫 | effective model 不支持旧 override → 不向 CLI 传非法值，现场显示当前继承值与不兼容状态 | Provider argv test + UI state test |

## UI Wireframe（operator 已确认）

```text
Thread ⋮
┌──────────────────┐
│ 设置默认猫猫      │
│ 思考档位          │  ← 平级入口，不嵌进 preferred cats
│ 重命名对话        │
│ 导出对话          │
└──────────────────┘

本对话的思考档位
┌────────────────────────────────┐
│ 当前参与的猫猫                  │
│ 🐱 小太阳·Maine Coon  继承（xhigh） ▾ │
│ 🐱 Ragdoll          max          ▾ │
│                                │
│ 其他猫猫…        搜索 / 展开    │
│ 仅影响本对话；下次回复生效      │
└────────────────────────────────┘
```

## Acceptance Criteria

<!-- 每条 AC 均 trace 回 Why 的“thread 隔离 / 全猫能力 / 路由正交 / 可验证生效”，并要求非作者可复核。 -->

### Phase A（Thread × Cat Effort Contract）

- [x] AC-A1: Redis 与 Memory ThreadStore 均能持久化、批量读取、单猫读取和清除 `(threadId, catId)` effort override，TTL=0；不同 thread/cat 互不串值，不制造 ghost thread hash；soft-delete/restore 保留、hard-delete 清除。
- [x] AC-A2: Collection GET 一次返回全部 effort-capable cats 的 `options/override/inherited/effective/source/compatibility`；PATCH 仅接受 capability helper 判定合法的值或 `null`，并覆盖 401/403/404/400。
- [x] AC-A3: shared default thread 的用户 override 读写被拒绝，测试证明一个用户无法影响另一个用户。
- [x] AC-A4: invocation 优先级严格为 `thread override > cat default > provider default`，且 explicit mention、preferred cats 与 fallback 三种路由结果都按实际 catId 取值。
- [x] AC-A5: Codex 与 Claude argv 测试证明 thread override 到达 `model_reasoning_effort` / `--effort`；清除 override 后恢复继承值。
- [x] AC-A6: resumed session 下一次 invoke 会读取最新 override，无需 reborn；测试同时证明 F224 session strategy 行为不变。
- [x] AC-A7: effective model 不支持持久化 override 时 fail-closed 到合法继承值，API 返回 incompatibility，任何 Provider argv 都不出现非法 effort；store 读取失败同样降级到继承值并给出可见诊断。
- [x] AC-A8: `identity-session` ownership map 增加 thread-scoped cat runtime config 扩展点和 canonical anchors，不把该能力归入 routing 或 thread-navigation owner。

### Phase B（Hub Thread Effort Surface）

- [x] AC-B1: Thread `⋮` 菜单中“思考档位”与“设置默认猫猫”平级且紧邻；菜单 action test 锁住标签、顺序和键盘可访问性。
- [x] AC-B2: 面板优先展示当前参与的 effort-capable cats，并可通过“其他猫猫…”搜索/展开尚未参与的 enabled cats；不支持 effort 的猫不出现。
- [x] AC-B3: 每行选项来自共享 provider/model capability，展示 `继承（effective value）`；GPT-5.6、旧 OpenAI、Anthropic 与 unsupported provider 都有 UI 回归测试。
- [x] AC-B4: 写入成功、失败回滚、清除继承、stale incompatible 四种状态有即时反馈；文案明确“仅影响本对话；下次回复生效”。
- [x] AC-B5: popover 在窄宽度下保持 viewport 内并内部滚动，不遮断删除等现有菜单操作；复用现有 Cafe design tokens。
- [x] AC-B6: Alpha 按 Primary Journey 完成 3 张主截图与需求→证据表，证明 thread 隔离、非首选猫显式 @、全猫 capability 三项愿景均可用；约 15 秒录屏证物由 operator 在真实使用功能后明确豁免（message `0001783774509117-000005-21d95175`：“不需要录屏那些 我已经用上了！ （人肉确认”）。
- [x] AC-B7: F244 新增一条真实可投放 tip，复用现有 `thinking / concierge_open` context 与 `open_concierge_draft` action，正文明确 `⋮ → 思考档位`，sourceRef 指向本 spec 的 User Journey；不为 F262 扩张 F244 context/action 协议。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “有的 thread 要 max，有的 xhigh 就够了” | AC-A1, AC-A4, AC-B4, AC-B6 | Store/API tests + Alpha 双 thread 验收 | [x] |
| R2 | “首选猫是没有具体 @ 时的 fallback”，effort 不应绑进首选猫 | AC-A4, AC-B1, AC-B6 | routing matrix test + 菜单截图 | [x] |
| R3 | “每只猫只要能设置 effort 都能这里设置，不只是 Sol” | AC-A2, AC-A5, AC-B2, AC-B3 | provider matrix tests + 面板截图 | [x] |
| R4 | 执行任务保留 xhigh、架构共创可手动 max，且不影响其他 thread | AC-A1, AC-A4, AC-B4, AC-B6 | 两 thread argv evidence | [x] |
| R5 | 入口在 thread 三点菜单，参与猫优先并能搜索其他猫 | AC-B1, AC-B2, AC-B5 | component test + Alpha 截图与 operator 实用确认 | [x] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC。
- [x] 每个 AC 都有自动化测试、截图或录屏验证方式。
- [x] 前端需求已定义需求→证据映射表要求。

## Implementation Evidence（2026-07-10）

| 证据 | 当前结果 | 覆盖范围 |
|------|----------|----------|
| `pnpm gate` at `62c9e6b7e` | ✅ 基于最新 `origin/main` rebase；build / tsc / workspace tests / lint / check 全绿 | 整仓回归与治理门禁 |
| Shared resolver | ✅ 7/7 | inherit / compatible / incompatible / provider-model capability |
| Memory + isolated Redis ThreadStore | ✅ 49/49 + 38/38 | 隔离、bulk read、TTL=0、ghost guard、soft/hard delete |
| Route + invocation/provider focused suites | ✅ 4/4 + 120/120 | runtime-effective model、access/capability、每次重读、三种 Claude carrier、Codex/Claude argv |
| Hub component/action suites | ✅ 14/14 | 菜单顺序、participant-first/search、save/rollback/inherit/stale、动态窄屏边界 |
| Isolated production-profile API dogfood | ✅ `inherited max → PATCH low → persisted low → PATCH null → inherited max` | 真实 HTTP 写读清除链；临时 thread 已删除 |
| operator visual smoke + live use | ✅ 2026-07-10 Alpha smoke；2026-07-11 “不需要录屏那些 我已经用上了！ （人肉确认” | 功能已在真实使用中确认；operator 明确豁免 AC-B6 的录屏证物 |

Quality Gate 结论：实现、跨个体 review、post-merge Alpha 愿景守护与 operator 真实使用均通过；AC-B6 的录屏证物由 operator 明确豁免，Feature close。`test:redis` 全文件并发共享一个隔离 DB 的既有污染另按 harness 问题登记；F262 自身 Redis 文件在独立 DB 中 38/38 通过。

## Tips Contribution（F244）

- 已新增 `feature-thread-effort-overrides` tip，并移除 kickoff 的 `tips_exempt`。
- **Context**: 复用 F244 现有 `thinking / concierge_open`；首版不新增尚不存在的 `thread_actions` context。
- **Action**: 复用 `open_concierge_draft`，正文明确“打开对话 `⋮ → 思考档位`”；draft prompt 引导用户询问如何设置，不伪装成可直接打开 thread popover 的 action。
- **SourceRef**: 本文 `## User Journey` 与 `## Design Contract`。
- 限制为一条高价值 workflow tip，不为每个 effort 值单独造 tip。
- Phase B 合入前必须删除 `tips_exempt` 并让 `pnpm check:capability-tips` 通过真实 inventory coverage；缺 tip 即阻塞交付。

## Architecture Ownership

Architecture cell: identity-session

Subcell: `identity-agent config`

Map delta: `update required`

Why: F127 已把猫猫默认 effort 归入 identity-agent config；F262 在同一配置链新增 thread-scoped override 与 invocation canonical anchor，改变了该 cell 的扩展点，但不改变 routing、thread-navigation 或 session owner。

## Dependencies

- **Evolved from**: F127（猫猫实例 effort 默认值、共享 provider/model capability helper 与 Provider argv 注入）
- **Blocked by**: 无；现有 ThreadStore 与 invocation seam 足以承载
- **Related**: F154（复用 thread 菜单位置，但不复用 preferred cats 语义）
- **Related**: F224（复用 thread × cat persistence/access 形状，但不合并 session strategy）
- **Related**: F244（新增用户可发现 tip）

## Risk

| 风险 | 缓解 |
|------|------|
| effort 与 preferred cats 混为一谈，导致显式 @ 不生效 | 路由先解析 actual catId，再解析 override；独立菜单项与路由矩阵测试 |
| 前端复制 Provider 选项，未来模型能力漂移 | 前后端共用 `getCliEffortOptionsForProvider`，GET 返回同源 options |
| 猫换模型后旧值对新模型非法 | effective-model 校验 + fail-closed 继承 + compatibility 显示 + argv 负断言 |
| 面板一次请求每只猫形成 N+1 | collection GET 一次返回完整 rows |
| 所有猫平铺造成菜单过密 | 当前参与猫优先，“其他猫猫…”搜索/展开，popover 限高滚动 |
| shared default thread 按 thread+cat 存储导致跨用户串写 | 与 session strategy 同级防线：该 thread 禁止用户 override |
| 为一个字段提前造 generic runtime-settings 框架 | MVP 使用显式 effort store/route/typed option；出现第二个同构 runtime override 再评估抽象 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 独立新立 F262，不 reopen F127、不并入 F154 | thread-scoped runtime preference 是独立用户价值轴；F127/F154 均已 done 且语义不同 | 2026-07-10 |
| KD-2 | 支持所有 effort-capable cats，不做 Sol 特例 | 能力由 provider/model 决定，不由身份决定 | 2026-07-10 |
| KD-3 | `thread override > cat default > provider default`，`null` 表示 inherit | 保留稳定默认，同时允许局部精确控制 | 2026-07-10 |
| KD-4 | 先路由 actual catId，再解析 effort | 首选猫与思考档位正交；显式 @ 不被 fallback 语义吞掉 | 2026-07-10 |
| KD-5 | UI 位于 thread `⋮`，与“设置默认猫猫”平级 | 设置范围是 thread，但语义不是 preferred cats | 2026-07-10 |
| KD-6 | 当前参与猫优先 + “其他猫猫…”搜索/展开 | 兼顾可扫读密度与首次 @ 前预配置 | 2026-07-10 |
| KD-7 | 只做手动 sticky override，不做任务类型自动判档 | 避免隐藏成本、误分类和不可解释行为 | 2026-07-10 |
| KD-8 | 首版不包含 thread context-window override | 当前原始需求只要求 effort；context tuple 风险与语义独立 | 2026-07-10 |
| KD-9 | 不兼容旧值保留用户意图，但运行时 fail-closed 并显式展示 | 避免非法 CLI 参数，同时允许模型切回后恢复 | 2026-07-10 |
| KD-10 | collection GET 使用 bulk store read，API row 的 effective/source/compatibility 均为纯投影 | 避免前端 HTTP N+1、后端 Redis N+1 和派生状态漂移 | 2026-07-10 |
| KD-11 | Redis raw override 使用 `memberEffort:<catId>` sidecar field，并走现有 detail retention helpers | 保持 TTL=0、线程生命周期与 no-ghost-write 语义，不污染默认 Thread hydration | 2026-07-10 |
| KD-12 | disabled 猫的 raw override dormant 保留；collection 只列 enabled + effort-capable cats | 不丢用户意图，同时不把当前不可调用的猫暴露成可配置项 | 2026-07-10 |
| KD-13 | override 读取失败时 fail-open 到继承值，但必须 warning + 可见 `system_info` | 运行可用性优先，同时不静默违背用户明确设置 | 2026-07-10 |

## Review Gate

- Kickoff: feature truth checker + docs diff 自检。
- Backend Design Gate: ✅ Ragdoll/Ragdoll（Claude Opus 4.6）已审查 store/API/invocation 契约并关闭 OQ-1（thread message `0001783699020824-000155-deea2b39`）。
- Phase A: 跨个体 peer review，重点审查 access、effective-model fail-closed、routing orthogonality。
- Phase B: operator 在 Alpha 按 Primary Journey 验收；作者之外的愿景守护猫核对原话→截图→argv 证据。
