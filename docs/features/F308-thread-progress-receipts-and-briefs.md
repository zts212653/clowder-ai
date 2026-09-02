---
feature_ids: [F308]
related_features: [F160, F220, F227, F232, F237]
topics: [thread-progress, receipts, read-model, observability, ux]
doc_kind: spec
created: 2026-08-31
---

# F308: Thread Progress — 可读进展回执与会话近况

> **Status**: Phase A accepted / Phase B merged / Phase C implementation complete, deployment acceptance pending | **Owner**: Ragdoll / 宪宪 | **Priority**: P1

## Why

co-creator 在长期 thread 中反复需要追问“当前谁在推进、进度怎样、之前做过什么”。现有三层分别回答 Feature 治理、thread 待办和 invocation 临时步骤，却没有一个可靠、可读、可追溯的会话进度面：

- 毛线球是未来待办，状态可能陈旧，不能冒充当前执行或历史成果；
- `ThreadExecutionBar` 只能展示当前执行，无法解释历史演进；
- PlanBoard 随 invocation 消失；
- ThreadMemory/session digest 服务上下文恢复，会滚动覆盖，不能成为用户进度真相；
- 每次读取整段聊天再让模型总结会产生非确定、昂贵且不可验证的分析投影。

本 Feature 新增一个极薄的持久语义回执账本 `ThreadProgressReceipt`，并在读取时将它与 canonical current facts 组装成不持久化的 `ThreadBrief`。会话头部和全局“近况”必须消费同一 Brief，避免两套状态互相矛盾。

## Product Contract

### 用户恢复工作五问

Receipt 只记录会改变以下至少一个答案的新事实：

1. 现在要完成什么？
2. 什么已经被证明完成或不成立？
3. 什么阻止继续，或什么阻塞已经解除？
4. 下一步是什么？
5. 下一棒由谁或什么条件负责？

关键变化必须同时满足：新事实、有 canonical evidence、持续超过当前 turn、改变五问之一。默认偏向少记；普通问答、瞬时执行、重复状态、部分测试和单个 commit 全部 abstain。

### Thread / Receipt / Brief / Task 边界

```text
ThreadProgressReceipt = 关键语义变化的不可变历史回执
ThreadBrief           = 历史回执 + 当前事实的请求时只读快照
Task                  = 未来待办
LiveInvocation        = 当前执行
PlanBoard             = 当前 invocation 的临时步骤
```

不建设跨 thread 的“关注主题”层；MVP 以一个长期 thread 对应一个主题。

## Architecture Admission（F303）

Architecture cell: `identity-session` + `collaboration` + `web-console`

Map delta: add one owner-scoped append-only receipt ledger and one read-only assembler; no ownership migration for Task, Workflow, Session, Hold, Approval, Ball Custody, ThreadMemory, or PlanBoard.

Why: new Chat/global consumers reuse canonical liveness, wait, attention, task, and prompt-adoption contracts. Preservation claims therefore require exact consumer/source evidence and behavioral guards.

Canonical sources:

- current execution: `packages/api/src/domains/cats/services/agents/invocation/getThreadLiveInvocations.ts#getThreadLiveInvocations`
- task action wording: `packages/api/src/domains/cats/services/agents/invocation/TaskProgressStore.ts`
- owned threads: `packages/api/src/domains/cats/services/stores/ports/ThreadStore.ts#ThreadStore.list`
- prompt injection: `assets/prompt-templates/l5-mcp-tools-index.md`, `assets/prompt-templates/l6-capability-wakeup.md`
- prompt consumers: `packages/api/src/domains/prompt-hooks/PipelinePromptBuilder.ts`, `scripts/compile-system-prompt-l0.mjs`

Consumer evidence commands:

```bash
rg -n "getThreadLiveInvocations|ThreadExecutionBar|RightStatusPanel|ActivityBar" packages/api/src packages/web/src
rg -n "l5-mcp-tools-index|l6-capability-wakeup|record_thread_progress" assets packages scripts
```

Claim guards:

- “Task/ThreadMemory 不影响当前状态” → assembler contract tests → red when either source changes `presentationState`;
- “native/non-native prompt parity” → L0/pipeline equivalence tests → red when the adoption trigger exists on only one path;
- “Receipt 不阻塞 final” → callback behavior test → red when a rejected write prevents final delivery;
- “全局不做 N-thread liveness 扫描” → global discovery contract test → red when the bulk route calls per-thread liveness over every owned thread.

## What

### Phase A1: Receipt Foundation

#### ThreadProgressReceiptV1

唯一新增持久记录：

```ts
interface ThreadProgressReceiptV1 {
  v: 1;
  id: string;
  ownerUserId: string;
  threadId: string;
  kind: 'decision' | 'milestone' | 'blocked' | 'resumed' | 'handoff' | 'completed';
  impactAxes: Array<'goal_or_scope' | 'verified_outcome' | 'blocker' | 'next_action' | 'ownership'>;
  actor: { kind: 'cat'; catId: string } | { kind: 'system'; producer: string };
  headline: string;
  detail?: string;
  nextStep?: string;
  provenance: Array<MessageSourceRef | TaskSourceRef | InvocationSourceRef>;
  sourceKey: string;
  occurredAt: number;
  createdAt: number;
}
```

调用方只能提交 `kind/impactAxes/headline/detail/nextStep/provenance`。owner、thread、actor、time、id、canonical source identity 和 sourceKey 全部由服务端认证上下文派生。

#### Lifecycle

Receipt 无 `pending/running/done` 状态机：

```text
candidate → semantic gate → auth/provenance gate → atomic appendIfAbsent
                                              ├─ created
                                              ├─ existing
                                              └─ rejected
```

写成功即完成；后续变化追加新 Receipt，永不更新旧 Receipt。TTL=0，Thread 归档后仍保留。物理删除跟随既有 Thread 删除政策，本 Feature 不增加清理生命周期。

#### Critical-change admission

- 每个 terminal turn 最多一条；
- `impactAxes` 至少一个；
- provenance 至少一个；
- headline/detail/nextStep 有严格长度上限；
- headline/detail/nextStep 的叙述跟随 co-creator 在当前 thread 的主要交流语言；中英混合时使用中文叙述，技术名词、代码符号、commit、ID 与标准 verdict 保留原文；不得仅因 reviewer final 或工具输出使用英文而切换整条 Receipt 的语言；
- 无条件 Task-done adapter 明确排除；Task/Review/测试/产物仅作为 provenance；
- 多项同类修复聚合为一条阶段回执；
- Receipt 写失败 fail-open：不阻塞 final，不伪造已保存。

#### Atomicity

```text
sourceKey = derive(ownerUserId, threadId, canonicalTerminalSourceIdentity, kind)
```

Store 必须以 Redis Lua/唯一键或等价机制原子 `appendIfAbsent`；禁止先查后写。first-writer-wins；重复 producer 只进入 audit/telemetry，不能修改首条 Receipt。

显式 callback 另有同一原子事务内的 terminal-turn fence：同一认证 child invocation 即使改写 `kind` 也只能产生一条 Receipt。Phase A 为控制影响面，只开放 message/task/invocation 三种可由现有 store 直接复核的 provenance；workflow/artifact 待有稳定 resolver 后再扩展，不能先接受裸路径或任意引用。

#### Runtime adoption

- MCP callback：`record_thread_progress`；
- L6 只注入一句触发反射；
- L5 只登记工具；
- 完整四道门与输入契约放在 MCP tool description；
- 关键变化 final 前多一次 callback；普通问答零额外调用；
- 不改 provider stream、Invocation 状态机、Message 正文或 A2A disposition。

### Phase A2: Single-Thread Brief & UX

#### ThreadBriefV1

`ThreadBrief` 是请求时 DTO，不新增 `ThreadBriefStore`：

```ts
interface ThreadBriefV1 {
  v: 1;
  thread: { id: string; title: string };
  contextHeading: { label: '会话' | '目标'; text: string };
  availability: 'ok' | 'partial' | 'unavailable';
  presentationState: 'needs_user' | 'running' | 'waiting_external' | 'idle' | 'unknown';
  currentExecutions: CurrentExecution[];
  attention: AttentionItem[];
  waits: WaitItem[];
  recentProgress: ThreadProgressReceiptSummary[];
  lastProgressAt: number | null;
  nextStep: string | null;
  openWorkTaskCount: number;
  hasHistory: boolean;
  generatedAt: number;
}
```

字段唯一来源：

| 字段 | 唯一来源 |
|---|---|
| 普通会话 | `Thread.title`，标签“会话” |
| Feature 目标 | 已验证 `Workflow.resumeCapsule.goal` |
| 当前执行 | canonical `getThreadLiveInvocations(threadId, userId)` |
| 当前动作 | 同 owner/thread/cat 且 child invocation 精确匹配的 TaskProgress |
| 需要用户 | 当前开放 typed handoff / owner-scoped Approval |
| 等待外部 | 同 owner/thread、enabled、active 的 typed Hold |
| 最近进展/下一步 | Receipt ledger；下一步只认最新 Receipt 明确提供的值 |
| 待办数量 | 开放 work Task 数量，仅展示入口 |

Fail-closed：liveness 成功且 `active=[]` 才能显示无人执行；查询失败显示暂时无法确认；degraded 显示状态确认中；Task owner、参与猫、陈旧 doing、ThreadMemory、Session digest、blocked Task、lastActiveAt 都不得推断当前状态。

#### API

```text
GET /api/threads/:threadId/brief
GET /api/threads/:threadId/progress?cursor=...
```

Receipt 创建后只广播 `thread_brief_invalidated { threadId }`，客户端重新读取 canonical Brief。

#### Chat UX

- 新进度组件替换 `ThreadExecutionBar`，不重复占高；
- 收起态 36–40px，保留 actor 与 needs-user；
- 桌面摘要态 72–88px；移动默认收起；
- 完整进展进入现有 Contextual Workspace；
- dock 后 Chat 剩余宽度 ≥640px 才并排，否则 overlay；移动全屏；
- overlay 拦截底层点击、focus trap、Escape/关闭按钮，关闭恢复 Chat width 与 scroll；
- needs-user 只高亮，不强制展开；不随滚动自动开合；
- 时间线按今天/昨天/更早，首屏三条、每页 20 条；
- 默认 DOM 不显示 raw catId、invocation ID、SHA、F 编号、commit、tool、verified/attested；
- “查看依据”必须经过 owner-scoped typed provenance resolver。

### Phase B: Global Recent（Phase A 验收后）

Phase B 已在 Phase A 真实验收后由 operator 授权推进，保持冻结边界：

```text
GET /api/threads/briefs?scope=recent&limit=50&cursor=...
```

- `current[]`：open attention / confirmed-or-degraded live / active typed hold，不受 recent limit 截断；
- `recent[]`：排除 current，仅 `lastProgressAt != null`，按 `lastProgressAt DESC, threadId ASC` 游标分页；
- stale Task、参与猫、lastActiveAt、ThreadMemory、Session digest 不能使 thread 入选；
- bulk route 禁止 `list all threads → N 次 liveness`。Phase B 开始前必须确定 owner-scoped current discovery seam；若缺索引，只新增查询索引/port，不新增业务状态。

### Phase C: Runtime Details Read Model

“运行详情”不再以 active invocation 为空时整页消失。它是当前运行与诊断的按需视图，不写入 Receipt，也不成为第二套状态机。

| 区域 | 默认展示 | 唯一真相源 |
|---|---|---|
| 当前回合 | 执行猫、阶段、已运行时间、最近活动、停止/强制重置 | canonical LiveInvocation + app-server lifecycle |
| 本轮计划 | 仅精确关联当前 child invocation 的 PlanBoard；无关联时明确“本轮没有可用计划” | PlanBoard / TaskProgress exact invocation match |
| 上一次运行 | 终态、耗时、结束时间、结果入口；当前空闲时作为主空态 | InvocationRecord + Session chain |
| 使用量 | 按猫 token/费用（存在才显示），不猜缺失值 | InvocationRecord.usageByCat |
| 运行环境 | runtime/provider/model、Session、worktree/工作目录 | Runtime profile + Session record + authorized workspace metadata |
| 产物与证据 | 本轮文件、artifact、相关消息入口 | transcript/session artifact typed resolver |
| 技术诊断 | Invocation/Session ID、原始生命周期与日志入口，默认折叠 | owner-scoped diagnostic APIs |

运行详情空态：显示“当前没有猫在执行”，并保留上一次运行摘要、最新关键进展、明确下一步及“查看毛线球”入口；不能只返回空白。内部 ID、原始日志和 token 明细只在用户主动展开“技术诊断”后进入 DOM。

Phase C 不改写 Phase B：运行详情通过不持久化的 `ThreadRuntimeBrief` 读取 canonical live、TaskProgress、SessionChain、ThreadMetadata 与 Receipt。实际 runtime/provider/model 和原始日志没有稳定的 per-invocation 真相源，暂不展示。

## User Journey

- **Scope unit**: 一个由当前用户创建的普通 Thread。
- **Primary actor**: co-creator。
- **Entry**: 从 Thread Sidebar 打开长期会话；Phase B 后也可从 Activity Bar“近况”进入。
- **Flow**:
  1. 会话头部立即读取 `ThreadBrief`，用 40px/84px 状态回答当前执行、最近进展、下一步与是否需要用户；
  2. 用户点击“查看完整进展”，在 Contextual Workspace 中读取 Receipt 时间线；
  3. 用户从 Receipt 的 typed provenance 跳回相关消息、毛线球或产物；
  4. 用户收起进度条继续聊天，偏好与 scroll position 保持；
  5. 新 turn 形成关键变化时，猫在 final 前写一条 Receipt，UI 收到 invalidation 后重读 Brief；
  6. 普通问答或瞬时执行不写 Receipt，不打扰进度面。
- **Success evidence**: 同一关键事实由单条 Receipt 持久化，并在会话卡、时间线和新 Session 读取中一致；当前执行只来自 canonical liveness。
- **Failure/recovery**: Receipt 写入失败不阻塞 final；Brief source 读取失败显示 partial/unknown；overlay 可 Escape/关闭并恢复原 Chat。
- **Non-goals**: 旧聊天 AI 回填、跨 thread 主题聚合、日/周复盘、system/shared thread。

## Acceptance Criteria

### Phase A1（Receipt Foundation）

- [x] AC-A1: `ThreadProgressReceiptV1` 是唯一新增持久记录；owner-scoped、TTL=0、append-only。
- [x] AC-A2: callback 只接受语义字段；身份、thread、actor、time、id 和 sourceKey 由服务端派生。
- [x] AC-A3: Phase A typed provenance 只允许 message/task/invocation 三种封闭类型，跨用户与任意 URL/裸路径拒绝。
- [x] AC-A4: `appendIfAbsent` 原子 first-writer-wins；顺序与并发重复均只产生一条 Receipt，重复 producer 不修改事件。
- [x] AC-A5: 关键变化必须通过新事实/evidence/稳定性/恢复五问门槛；每 terminal turn 最多一条。
- [x] AC-A6: 普通问答、读文件、部分测试、单 commit、重复状态与无新结论 tool call abstain。
- [x] AC-A7: 不存在无条件 Task-done adapter；Task done 只可作为 provenance。
- [x] AC-A8: callback 失败不阻塞 final；不得宣称 Receipt 已保存。
- [x] AC-A9: L5/L6、MCP tool description、native L0 与 non-native pipeline 对 adoption 规则保持一致。
- [x] AC-A10: Receipt 分页稳定，Thread 归档后仍可读。

### Phase A2（Single-Thread Closed Loop）

- [x] AC-A11: `ThreadBriefAssembler` 不持久化 Brief，并按字段唯一来源组装。
- [x] AC-A12: confirmed/degraded/idle/unknown 四态 fail-closed；parent ID、旧 TaskProgress 和 task owner 都不能冒充 current action。
- [x] AC-A13: attention/wait 只消费同用户域当前开放 typed truth；历史 Receipt 与 blocked Task 不推断当前注意力。
- [x] AC-A14: Receipt 有/无时 Brief 均可读；最新 Receipt 未明确 nextStep 时显示“下一步尚未明确”。
- [x] AC-A15: 会话卡、时间线与 API 使用同一 Brief/Receipt 真相；刷新与新 Session 后仍一致。
- [x] AC-A16: 40px/84px、宽屏 dock、窄屏 overlay、移动全屏及关闭恢复行为通过浏览器测试。
- [x] AC-A17: degraded/unknown 有独立可见组件状态，不归入“正在推进”。
- [x] AC-A18: 默认 DOM 与演示画布通过人话/内部术语守卫。
- [x] AC-A19: no-Task 真实研究 turn 能写一条关键 Receipt；普通知识问答不写。
- [x] AC-A20: 使用隔离数据完成 Phase A acceptance；不接触 runtime/production data。

### Phase B（Global Recent）

- [x] AC-B1: `current[]` 只由 owner-scoped attention / canonical live candidate / active typed hold 发现，且不受 recent limit 截断。
- [x] AC-B2: `recent[]` 排除 current，只含 `lastProgressAt != null`，按时间倒序、同时间 threadId 正序稳定分页。
- [x] AC-B3: bulk route 不执行 `list all threads → N 次 liveness`；recent-only thread 使用已证明为空的 current snapshot。
- [x] AC-B4: 普通 owner thread 才可进入集合；跨用户、system/shared/deleted/special thread 均排除。
- [x] AC-B5: 全局卡与会话卡消费同一个 `ThreadBriefV1`，不新增持久 Brief 或第二套状态字段。
- [x] AC-B6: Activity Bar “近况”入口与五个分区（需要你/正在推进/状态确认中/等待外部/最近有进展）可读可导航。
- [x] AC-B7: invalidation 与轮询重读 canonical collection；读取失败清除陈旧 current，不用 task/lastActiveAt 猜状态。
- [ ] AC-B8: 使用隔离数据验证分页、owner 隔离、索引迁移和 UI；部署后再用当前用户真实 Receipt 做只读验收。

### Phase C（Runtime Details）

- [x] AC-C1: `ThreadRuntimeBriefV1` 只读组装、不持久化，不新增运行状态对象。
- [x] AC-C2: 当前执行只来自 canonical live；liveness 失败时不从 Session/Task 推断正在运行。
- [x] AC-C3: 本轮计划仅在 `TaskProgress.lastInvocationId` 精确匹配当前 turn 时展示，旧计划不冒充 current。
- [x] AC-C4: 无 active invocation 时展示最近 Session、关键进展、下一步、待办与环境锚点，不出现空白页。
- [x] AC-C5: 最近 Session 只读 owner 记录，并展示已有 usage/context health；缺失值不估算。
- [x] AC-C6: Session/CLI ID 与工作目录默认不进入 DOM，用户主动展开技术诊断后才渲染。
- [x] AC-C7: runtime brief 与单 thread Brief 使用相同 owner/普通 thread 授权边界。
- [ ] AC-C8: 部署后完成 active/idle/partial 三种真实运行态的浏览器验收。

## Tips Contribution（F244）

- [x] 新增/更新一条可执行 tip：首次出现可读会话进度时说明“展开查看关键进展；毛线球仍表示待办”。
- [x] tip sourceRef 指向 F308，并在 Phase A 用户可见 UI 落地时启用。

## Phase A Acceptance Log

- ✅ 共享契约、API build、12 个 F308 API/domain tests、8 个 F308 Web component tests、L0/pipeline 两组等价测试通过。
- ✅ 永久垂直验收用例通过：MCP tool → 真实 HTTP callback 鉴权 → 隔离 Redis → Brief/read API → store 重建后读取；无 Task 研究回执与 invocation-start abstain 同时得到证明。
- ✅ 隔离 Redis 验证并发 first-writer-wins、TTL=0 与 terminal-turn 单回执 fence；未连接 runtime/production data。
- ✅ 七张 1440/1024/390 视觉画布重新渲染，40px/84px、640px dock/overlay、人话守卫校验通过。
- ✅ operator 已在本地部署完成 Phase A 手工体验验收；隔离数据 AC-A20 完成。宿主自动化 browser runtime 仍返回 available browsers `[]`，因此没有伪造自动点击截图证据。
- ⚠️ 仓库级非 F308 既有门禁：F286 bootstrap attestation 指向已不在远端历史的 SHA；full MCP/shared/Web suites 另有 1/1/5 个与 F308 无关的基线失败。F308 定向集与受影响 ChatContainer 回归集均通过。

## Phase B Acceptance Log

- ✅ Shared/API/Web production build 通过，`/recent` 已进入 Next route manifest。
- ✅ current discovery 覆盖 owner running index、owner approval 与 owner typed hold；55 个 current 在 `limit=1` 时仍完整返回。
- ✅ recent Receipt index 支持旧数据 owner-scoped lazy backfill、同时间 threadId 正序、游标分页、current 去重和跨用户隔离。
- ✅ recent-only thread 不触发 liveness read；stale task、lastActiveAt、参与猫不会使会话入选。
- ✅ 隔离 Redis E2E：两个真实 Receipt 分别进入 current/recent，同一 collection route 返回，recent 没有额外 liveness 调用。
- ✅ Web 五分区、进入会话、翻页、invalidation 重读和读取失败清除陈旧数据测试通过。
- ⏳ AC-B8 最后一项为部署后当前用户真实 Receipt 的只读验收；宿主 browser runtime 仍无可用实例，不以原型代替截图。

## Phase C Acceptance Log

- ✅ runtime assembler 验证 owner Session 过滤、usage/context health、Receipt/nextStep、ThreadMetadata 与 open work count。
- ✅ live turn 与 TaskProgress 精确匹配时展示计划；旧 invocation snapshot 被拒绝。
- ✅ liveness 失败时 availability=partial、currentExecutions=[]，但持久空态信息仍可读取。
- ✅ UI 验证 idle 不空白、current plan 可读、毛线球入口可达、内部 ID/路径按需渲染。
- ✅ Shared/API/Web production build 通过；Phase A/B/C 定向回归 API 60、Web 26、Shared 3 全绿。
- ⏳ AC-C8 等待合入部署后真实浏览器验收。

## Dependencies

- **Evolved from**: F160（毛线球 thread-level 持久任务，但不表达历史进展）
- **Related**: F220（当前执行状态与 ThreadExecutionBar）
- **Related**: F227（Event Memory 仅拥有认知转折，F308 不复用其语义）
- **Related**: F232（Thread 产物下钻入口）
- **Related**: F237（Prompt Injection 模板、Hook Pipeline 与 compiled preview）

## Risk

| 风险 | 缓解 |
|---|---|
| Receipt 变成新任务流水账 | 四道门、impactAxes、每 turn 一条、无 Task adapter、偏向 false negative |
| 猫忘记写 Receipt | L6 唤醒、tool description、prompt capture 与真实 adoption test |
| Receipt 阻塞工作结果 | callback fail-open，final 优先 |
| 并发重复或不可变事件被改写 | 原子 appendIfAbsent、first-writer-wins、重复只进 audit |
| 陈旧状态冒充当前 | canonical liveness + child-turn 精确关联 + unknown/degraded fail-closed |
| Prompt 跨 runtime 漂移 | native/pipeline equivalence、compiled preview、prompt capture、新 Session 验收 |
| UI 挤压聊天 | 40/84px + 动态 640px dock/overlay + scroll/focus recovery |
| 安全表达误导 | degraded/unknown 独立状态、typed truth、DOM 人话守卫 |
| 当前脏 main 污染实现 | 基于最新 origin/main 的独立 F308 worktree |

## Open Questions

| # | 问题 | 状态 |
|---|---|---|
| OQ-1 | 既有历史是否 AI 回填？ | ✅ 不回填；上线后开始积累 |
| OQ-2 | Phase B 是否与 Phase A 同时开发？ | ✅ 否；Phase A 真实验收后再开始 |
| OQ-3 | 是否自动把 Task done 变成 Receipt？ | ✅ 否；Task 仅作为 provenance |
| OQ-4 | 是否跨猫 Review？ | ✅ operator 明确豁免；作者完成 targeted self-check 后进入 Phase A 验收 |
| OQ-5 | 运行详情空白是否随 Phase B 一起重构？ | ✅ 否；先冻结 Phase C 信息架构，避免扩大 Phase B 影响面 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| KD-1 | 不新增用户关注主题层 | 当前一个长期 thread 基本对应一个主题，避免分析投影叠加 |
| KD-2 | Receipt 是持久语义账本，Brief 是非持久读模型 | 同时保留可追溯历史与实时 current truth |
| KD-3 | Receipt 没有状态机，写成功即完成 | 降低领域复杂度，避免第二套 Task |
| KD-4 | 关键变化按恢复五问定义 | 避免模型主观“重要”造成噪音 |
| KD-5 | 无条件 Task adapter 删除 | 当前 Task 无 milestone 语义，自动写会重演任务流水账 |
| KD-6 | callback fail-open | 进度辅助能力不能绑架真正结果交付 |
| KD-7 | Brief 字段单源 + fail-closed | 不能用陈旧任务或参与者冒充当前执行 |
| KD-8 | 视觉采用三级开合 | 聊天优先，同时保持进度可召回 |
| KD-9 | 不做历史回填 | 避免非确定总结、迁移和证据污染 |
| KD-10 | Phase A 完成后再验收，不做跨猫 Review | operator 2026-08-31 直接授权 |
| KD-11 | Phase B 以 owner-scoped current/recent 查询索引实现 | 禁止全量 thread × liveness 扫描，不新增业务状态 |
| KD-12 | 运行详情独立作为 Phase C | 空态和诊断信息源较多，不能搭 Phase B 顺手重构 |
| KD-13 | Phase C 只新增 `ThreadRuntimeBrief` 读模型 | 复用既有持久事实与实时 current，避免新的陈旧运行状态对象 |

## Timeline

| 日期 | 事件 |
|---|---|
| 2026-08-31 | operator 提出全局近期事项、会话执行与历史进展不可见痛点 |
| 2026-08-31 | 开源调研、领域/安全审计、三级开合视觉 Demo 与 1024px 响应式补充完成 |
| 2026-08-31 | operator 授权按建议落盘并推进至 Phase A 完成，跳过跨猫 Review |
| 2026-08-31 | Phase A 真实 Receipt/Brief 验收完成；operator 授权推进 Phase B，并冻结运行详情 Phase C 信息架构 |
| 2026-09-01 | Phase B 合入本地 main；Phase C 非空白运行详情与按需技术诊断实现完成 |

## Review Gate

- Phase A: operator 明确豁免跨猫 Review；作者必须完成 TDD、targeted gates、prompt parity、隔离数据测试和代码坏味道自审后，才进入 acceptance。
- Phase B: operator 已在 Phase A acceptance 后授权；保持 current discovery 索引、recent 分页和全局页面边界。

## Links

| 类型 | 路径 | 说明 |
|---|---|---|
| Visual Gate | `designs/thread-progress-gate-2026-08-31/` | 三级开合、全局近况、移动端与窄桌面原型（功能原型/演示数据） |
| Prompt | `assets/prompt-templates/l5-mcp-tools-index.md` | MCP quick index |
| Prompt | `assets/prompt-templates/l6-capability-wakeup.md` | Receipt adoption 触发反射 |

## Explicit Non-Goals

- 跨 thread 主题聚合；
- 日/周复盘；
- 历史 AI 回填；
- 进度百分比；
- Receipt 手工编辑；
- system/shared/eval/connector thread 的全局近况；
- legacy pending authorization 迁移；
- 实际 runtime/provider/model 与原始日志展示（等待稳定 per-invocation 真相源）；
- 修改生产配置或生产数据。
