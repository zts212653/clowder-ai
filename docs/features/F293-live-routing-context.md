---
feature_ids: [F293]
related_features: [F051, F083, F127, F153, F154, F167, F192, F203, F208, F216, F254]
topics: [routing, availability, quota, provider-health, capability-profile, l0, freshness]
doc_kind: spec
created: 2026-08-08
description: "在传球决策与发送边界组合能力、条件偏好和新鲜可用性，使猫避开饿趴或不可达的队友，并随恢复重新纳入候选。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-09T04:49:41Z
---

# F293 — Live Routing Context

> **Status**: spec / Architecture Design Gate | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

> **Kickoff reviewer**: Ragdoll (@fable5)，一次 consolidated verdict

## Why

operator同时遇到了两种表面不同、实质同源的传球失败：

- Ragdoll临时没有额度时，持球猫仍可能照旧找他 review，而没有改找 Kimi / GLM；
- Terra 与 GPT-5.4 的价格关系、能力判断已经变化，团队仍可能按旧认知默认找 GPT-5.4。

这不是单纯的“猫粮看板”问题，也不是再写一条偏好提示就能解决。我们缺的是一个在**实际路由决策时**组合慢知识、条件偏好与实时供给，并在**真正发送前**重新确认的共享上下文。

operator明确要求：

1. 一个 feature 收住现实供给和长期路由更新，不拆成临时 MVP 与未来大架构；
2. MVP 若不在终态架构上就不要绕路；
3. Sol 背后的私人/公司 ChatGPT 账号来源对猫不可感知，因此 F293 **不建模、不猜测、不展示**本次调用究竟用了哪份猫粮。

## Current State

- [F051](F051-real-quota-dashboard.md) 已定义真实额度池与独立 pool 不合并，但它主要是展示面，不在每次传球的必经决策路径上。
- [F208](F208-capability-profile-routing.md) 提供较慢变化的能力知识，并坚持“给数据，不替猫做判断”；当前 dossier 里的部分价格/模型信息已经会随时间过期。
- [F154](F154-cat-routing-personalization.md) 的 `preferredCats` / default 是静态偏好，不能表达“本周一恢复”“provider 暂时不可达”等带时间语义的条件。
- [F203](F203-native-system-prompt-l0.md) 会在 invocation 开始时编译 L0 队友名册，但目前没有把稀疏的临时状态异常投影进去。
- 当前 dispatch 能执行传球，却没有一个专门 owner 在发送副作用边界组合 capability、operator policy 与 live availability。
- [F254](F254-side-effect-freshness-gate.md) 已证明：只在 agent 开始思考时给快照不够，长 turn 中状态可能变化；真正有副作用前必须 recheck，且前置证据子系统缺失时不能卡死副作用。
- 底层使用私人还是公司账号，不是猫能可靠观测的事实。把它写成 `ExecutionSlot` 或展示字段只会制造 phantom precision。

## Value Statement

当一只猫准备找队友时，他能看到“谁适合、谁此刻可用、哪些偏好仍有效、信息有多新鲜”，并在真正发送前阻止物理上不可达的目标；临时异常过期后不会永久饿死一只已经恢复的猫，长期经济性变化也只需更新一个权威来源。

## What

F293 新增一个 `routing-context` 组合单元和贯穿同一终态架构的五段交付：

1. 定义 availability signal、versioned routing preference、explainable snapshot 与 preflight contract；
2. 提供 owner-authorized 的临时状态入口，并把稀疏异常投影进 invocation 决策路径；
3. 接入 quota / provider health / dispatch failure 等可观测来源，建立不误报恢复的状态机；
4. 把长期经济性偏好收敛到单一权威来源，清理旧 L0 / dossier / config 的重复权威；
5. 在实际 @ / dispatch 边界重新解析并用端到端 journey 验证，不另建临时旁路。

## Architecture Ownership

**Architecture cell**: `routing-context`（new）

**Map delta**: required

**Why**: 现有 `dispatch` cell 负责交付/排队，`identity-session` cell 负责身份与 session；都不该变成 capability、供给状态和 operator policy 的杂物箱。F293 新增 `routing-context`，只负责决策时的组合、解释与 preflight；dispatch 仍执行发送，身份仍来自 identity-session。

## Terminal Architecture

### 1. Truth ownership, not one giant truth table

F293 是组合层，不复制所有事实。每类事实只有一个 owner：

| Fact class | Canonical owner | F293 consumes as |
|---|---|---|
| 猫的稳定能力、限制与协作画像 | F208 capability dossier / runtime catalog | versioned pointer + relevant excerpt |
| 可观测 quota pool 的余量与 reset | F051 quota source | time-bounded availability signal |
| provider / runtime 健康 | F153 observations / provider evidence | time-bounded health signal |
| operator 的条件偏好（例如同价时优先 Terra） | F293 routing preference store | versioned policy with provenance |
| invocation 时的稀疏提示 | F203 compiled L0 | projection, never source of truth |
| 实际 @ / dispatch | dispatch cell | fresh preflight consumer |

旧 dossier、L0、配置或猫的私人 memory 可以保留历史上下文，但不得凌驾于更新、更明确的 canonical policy / signal。F293 不把所有内容搬进 runtime catalog，也不让任意 projection 反向成为真相源。

### 2. Domain objects

#### `RoutingAvailabilitySignal`

```ts
type RoutingAvailabilitySignal = {
  id: string;
  subjectRef:
    | { type: 'cat'; catId: string }
    | { type: 'provider'; providerId: string }
    | { type: 'quota_pool'; poolId: string };
  state: 'available' | 'scarce' | 'degraded' | 'unavailable' | 'unknown';
  reasonCode: string;
  note?: string;
  source: 'manual_cvo' | 'quota_probe' | 'provider_error' | 'health_probe';
  observedAt: string;
  validUntil?: string;
  resetAt?: string;
  evidenceRef: string;
};
```

`quota_pool` 只有在系统确实拥有稳定、可观测的 pool identity 时才能使用。无法观察“私人/公司账号”时，信号收窄到可证明的 cat/provider 层；禁止根据余额、错误或当前登录态猜账号来源。

信号事件作为用户可见、可追溯数据持久化（TTL=0）。`validUntil` / `resetAt` 只决定它何时不再是 active evidence，绝不物理删除历史。

#### `RoutingPreference`

```ts
type RoutingPreference = {
  id: string;
  condition: string;
  prefer: string[];
  over: string[];
  rationale: string;
  evidenceRefs: string[];
  version: number;
  validFrom: string;
  reviewAfter?: string;
  supersedes?: string;
};
```

它表达的是有 provenance 的条件偏好，不是永久模型排行榜。例如“当 Terra 与 GPT-5.4 成本相当且两者都可用时，优先 Terra”可以版本化更新，而不是散落在 L0、dossier 和各猫 memory 里。

#### `RoutingContextSnapshot`

snapshot 对每个候选暴露：能力 pointer、当前 availability、命中的 preference、freshness、effect（eligible / advisory / blocked）及人能读懂的 reasons。它不产出一个不可解释的总分，也不替持球猫静默改派。

#### `RoutingPreflightDecision`

真正发送前，dispatch 用同一 resolver 重新读取 active facts，产出 `allowed | warned | rejected`、reasons、observedAt 与 alternatives。invocation 开始时的 L0 只帮助思考；preflight 才约束当前副作用。若 routing-context store/resolver 不可达或超时，preflight 必须返回 `warned` + `routing_context_unavailable` 并 fail-open 保留原目标，同时记录 degradation 审计事件；它不能把 advisory 子系统反转成 dispatch SPOF，也不能伪造 `available` 或清除已有信号。

### 3. State semantics

| State | Routing effect | Expiry / recovery |
|---|---|---|
| `available` | eligible；默认状态可不进稀疏 L0 | 由更新信号取代 |
| `scarce` | advisory；默认避开，但持球猫可基于不可替代能力选择 | 到期变 `unknown` |
| `degraded` | advisory；展示故障类型和风险 | 到期变 `unknown` |
| `unavailable` | physical hard gate；禁止把发送成功寄托在已知不可达目标上 | 到期变 `unknown`，不自动变 available |
| `unknown` | 不静默排除；展示不确定性，允许低成本 probe | 成功 probe 或人工恢复后变 available |

合成规则必须确定、可表驱动测试：未过期的物理 `unavailable` 优先于 advisory；cat / provider / observable pool 的状态按实际影响范围叠加；一次 cat 级错误不能无证据放大成 provider outage。成功 probe、人工 clear 或更新的强证据才能确认恢复。

| Recovery / failure event | Result |
|---|---|
| 负面信号到期 | `unknown`；不推断恢复 |
| 人工明确恢复或低成本 probe 成功 | 只对 evidence 精确匹配的 `subjectRef` 写 `available` |
| 真实 dispatch 成功 | 等价于该次因果路径的 successful probe；只恢复可证明的 cat/provider route，不清除无关 pool，也不推断隐藏账号 |
| dispatch 失败 / queued / silent | 不算 recovery；按最窄可证明 scope 记录或保留信号 |
| store/resolver error 或 timeout | preflight `warned` + fail-open；写 degradation audit，不改变 availability truth |

### 4. Read path and effect boundary

```text
canonical sources
  capability · routing preference · quota · provider health
                         │
                         ▼
                routing-context resolver
                    │             │
            sparse L0 projection  │
            (invocation cognition)│
                                  ▼
                       dispatch preflight recheck
                         allowed / warned / rejected
```

状态“写到某处”不算完成。至少两个消费点必须存在：

1. invocation 编译时，把非默认状态、过期时间和来源的新鲜度作为稀疏异常注入队友名册；
2. 实际 @ / dispatch 的副作用边界重新解析，避免长 turn 使用过期快照。

Hub 看板是 operator surface，不是唯一 read path。

## User Journey

### Primary Journey — 临时标记供给状态，下一次传球立即生效

**Scope unit**: 当前 workspace 的 routing context + 一次具体 handoff；不是底层账号。

**Actors**: You（标记/恢复），持球猫（判断），dispatch（preflight）。

**Entry**: Hub 中与猫粮/队友状态相邻的入口；精确位置须过 Experience Design Gate。

1. You 将Ragdoll标为 `scarce`、原因“额度低”、恢复时间“周一”；或将 Anthropic provider 标为 `unavailable` 15 分钟。
2. UI 立即显示影响范围、状态来源和到期语义；不会要求 You 说明私人/公司账号。
3. 下一次 invocation 的队友名册只增加这条异常，不塞入完整 dashboard。
4. 持球猫看到 Kimi / GLM 等 eligible alternatives，结合能力自行决定；`scarce` 可以被有理由覆盖，`unavailable` 不能假装能送达。
5. 真正发送前，dispatch 重新读取状态。若期间 provider 已挂，发送被拒并返回 alternatives；若只是 scarce，则给 warning，不静默改派。
6. 到期后旧负面状态变 `unknown`。系统通过低成本 probe 或 You 明确恢复确认 `available`，不会永久绕开已恢复的猫。

**Success evidence**: operator UI 截图、编译 L0 snapshot、dispatch trace、表驱动 resolver 测试和端到端 handoff 记录。

### Supporting Journeys

| ID | Journey | Expected outcome |
|---|---|---|
| S1 | provider 自动探测到故障 | 只有 provider 级证据才影响该 provider 下所有猫；短 validity 后回 unknown |
| S2 | “Terra 同价更聪明”偏好更新 | 改一条 versioned preference，下一次 resolver 生效，旧文案不再有权覆盖 |
| S3 | 长 turn 中状态变化 | L0 仍可用于思考，但发送前 preflight 看到新状态并阻止 stale action |
| S4 | Sol 底层账号来源不可见 | route context 只显示可证明的 cat/provider/pool 状态，绝不猜私人或公司猫粮 |

## Non-goals

- 不做自动“最佳猫”总分、全自动调度器或静默改派；判断权留给持球猫。
- 不合并 F051 中彼此独立的 quota pools，也不伪造统一剩余额度。
- 不做多账号 execution placement，不展示本次 invocation 由私人还是公司账号供给。
- 不因临时 quota / provider failure 改写 F208 的稳定 capability dossier。
- 不接受只有 dashboard、没有 L0/上下文消费和 dispatch preflight 的实现。
- 不把“所有可选机制都补齐”当交付清单；健康信号走 observations，确定契约走 tests/guards。

## Acceptance Criteria

### Phase A — Domain Contract & Ownership

- [ ] AC-A1: `RoutingAvailabilitySignal`、`RoutingPreference`、snapshot 与 preflight decision 有正式 schema；state × scope × freshness 合成规则有 table-driven tests。
- [ ] AC-A2: signal 历史 TTL=0；active window 到期只令状态变 `unknown`，不删除记录、不自动恢复 `available`。
- [ ] AC-A3: resolver 支持 cat / provider / 可观测 quota pool 三种 scope；没有稳定 pool identity 时 fail closed 到可证明范围，绝不推断私人/公司账号。
- [ ] AC-A4: resolver 输出 explainable reasons、freshness 和 effect，不输出 opaque score，不静默挑选目标。
- [ ] AC-A5: 新增 `routing-context` architecture cell 与 map edge；dispatch、identity-session、F208/F051/F153 的 ownership 保持清晰。
- [ ] AC-A6: store/resolver read error 与 timeout 有表驱动测试：preflight 只能 `warned` fail-open、保留原目标并写 degradation audit，不得 `rejected`、伪造 available 或改写 signal。

### Phase B — Operator Surface & Decision-path Projection

- [ ] AC-B1: owner-authorized Hub 入口支持 mark / clear；非 available 状态必填 reason 与 `validUntil`/`resetAt`，并预览影响范围。
- [ ] AC-B2: compiled L0 只注入非默认稀疏异常，包含状态、时间语义与 freshness；有明确 token-budget regression guard。
- [ ] AC-B3: 猫在当前上下文可查看候选状态与来源；dashboard 不是唯一消费面。
- [ ] AC-B4: 每次实际 @ / dispatch 前重新 resolve：`unavailable` rejected，`scarce` / `degraded` / `unknown` warned，并返回有理由的 alternatives；不得静默 reroute。
- [ ] AC-B5: mark / clear / preflight API 有 workspace ownership校验、审计事件和契约测试。

### Phase C — Source Adapters & Recovery

- [ ] AC-C1: F051 adapter 保留独立 pool 语义；不跨 pool 聚合，不把不可观察账号暴露给猫。
- [ ] AC-C2: provider-wide 状态只由 provider-wide evidence 产生；429/auth/runtime error 默认落在最窄可证明 scope，避免一次失败饿死整个家族。
- [ ] AC-C3: F153 health / provider observations 可生成短 validity 信号；运行健康使用 logs/metrics/traces，不默认挂 Eval Hub。
- [ ] AC-C4: 过期负面信号转 unknown；成功 probe 或人工 clear 才确认 recovery；重复错误有 dedupe / noise control。
- [ ] AC-C5: dispatch 遭遇真实 quota/provider failure 后写入同一 signal contract，后续 route 立即可见。
- [ ] AC-C6: 真实 dispatch 成功只作为因果匹配 route/scope 的 successful probe；failed/queued/silent 不算恢复，并有“不清无关 pool、不猜隐藏账号”的负向测试。

### Phase D — Slow Routing Knowledge Freshness & Migration

- [ ] AC-D1: routing preference 有 provenance、version、`validFrom` 和可选 `reviewAfter`；覆盖“成本相当时优先 Terra 于 GPT-5.4”的当前 policy 示例。
- [ ] AC-D2: resolver 明确 fresh canonical preference 优先于旧 L0/dossier/private memory claim；旧信息只能作非权威历史上下文。
- [ ] AC-D3: 审计并移除 L0、dossier、配置中重复承担的相对价格/优先级真相；guard 确保同一 policy 只有一个 canonical owner。
- [ ] AC-D4: capability 继续引用 F208；临时 availability 不反写稳定能力画像。

### Phase E — End-to-end UAT & Closure

- [ ] AC-E1: Primary Journey 在 Hub、compiled L0、猫的路由解释和 dispatch trace 上全部有证据。
- [ ] AC-E2: adversarial matrix 覆盖：周一恢复、provider outage、expiry→unknown、真实 dispatch 成功的有界 recovery、状态在长 turn 中变化、错误 scope 放大、底层账号来源不可见，以及 routing-context store/resolver unavailable/timeout 时 warned fail-open。
- [ ] AC-E3: 所有 UI、自动 adapter 和 dispatch gate 消费同一 store + resolver；不存在另建 temp-status MVP 的旁路。
- [ ] AC-E4: 至少贡献 1 条 F244 capability tip：如何临时标记状态、为什么 expiry 不是自动恢复，以及猫从哪里看到来源。

## Requirements Mapping

| ID | Requirement | Source | Acceptance criteria |
|---|---|---|---|
| R1 | Ragdoll没粮时，传球决策能看到并改找 Kimi / GLM | operator 2026-08-08 | AC-B1, AC-B2, AC-B4, AC-C1, AC-E1 |
| R2 | 临时稀缺恢复后不能被永久绕开 | operator 2026-08-08 + failure-mode audit | AC-A2, AC-C4, AC-C6, AC-E2 |
| R3 | provider 临时不可达可手动或自动标记 | operator 2026-08-08 | AC-A1, AC-B1, AC-C2, AC-C3 |
| R4 | Terra / GPT-5.4 等长期经济性认知可单点更新 | operator 2026-08-08 | AC-D1, AC-D2, AC-D3 |
| R5 | 一个 feature 面向终态，不拆临时 MVP 与未来架构 | operator 2026-08-08 | AC-A5, AC-E3 |
| R6 | 不建模或展示 Sol 背后的私人/公司账号来源 | operator correction 2026-08-08 | AC-A3, AC-C1, AC-E2, S4 |
| R7 | 猫保留判断权，不变成算法路由器 | F208 + operator collaboration model | AC-A4, AC-B4 |

### Coverage Check

- [x] 每个 R 都映射到至少一个 AC
- [x] 每个 Phase 都有可验证的完成证据
- [x] 所有用户可见行为都有对应 journey
- [x] 账号来源不可见这一纠正同时进入 architecture、journey、non-goal 与 adversarial UAT

## Dependencies

- **Evolved from**: F051（真实 quota pool）、F208（稳定 capability knowledge）、F254（side-effect freshness）。
- **Blocked by**: 无；Phase A 先确认各 provider 可观测的最窄 scope。
- **Related**: F127（成员身份）、F153（运行健康 observations）、F154（静态 preferred cats）、F203（compiled L0）、F244（capability tips）。

## Risk Register

| Risk | Consequence | Mitigation / proof |
|---|---|---|
| 过期负面状态仍被当不可用 | 已恢复的猫被静默永久绕开 | expiry→unknown + probe/manual recovery tests |
| 单猫错误被放大到 provider | 整个家族无辜饿死 | narrowest provable scope + provider-evidence tests |
| 状态只存在 dashboard | 决策时依然看不见 | sparse L0 projection + dispatch preflight UAT |
| 全量数据塞进 L0 | token 膨胀、重要规则被挤压 | exception-only projection + budget guard |
| 变成不透明算法路由 | 猫的判断权和可解释性消失 | no score / no silent reroute contract |
| 猜测私人/公司账号 | 隐私泄漏与错误精度 | account source non-goal + schema/serialization negative tests |
| 价格/能力真相多份复制 | 更新后继续滞后 | one owner per fact class + provenance + duplicate-truth guard |
| 用 TTL 删除用户状态 | 审计与恢复证据丢失 | durable event TTL=0; validity only affects projection |
| routing-context store/resolver 自身不可达 | advisory 子系统变成全家 dispatch SPOF | warned fail-open + degradation audit + timeout/error contract tests |

## Open Questions for Design Gate

1. Hub 的入口应与 F051 quota surface 合并，还是放在队友详情的 status 区？先用 Primary Journey 做 Experience Design Gate，不凭字段表猜 UI。
2. 各 provider 是否已有跨 invocation 稳定且安全的 quota-pool identity？没有则第一版仅支持 cat/provider scope，不造账号抽象。
3. 哪些 provider 有足够便宜的 recovery probe，哪些只能依赖下一次真实调用或人工 clear？
4. `RoutingPreference` 的 canonical store 应属于 runtime catalog 的 versioned policy 区，还是独立 workspace store？Phase A 以 ownership 与迁移成本做决定。
5. fail-open warned 的 timeout、circuit-breaker threshold 与 degradation event sink 具体取值是什么？“不可因 resolver 故障拒绝 dispatch”是固定契约，仅运行参数留给 Phase A Design Gate。

## Key Decisions

- **KD-1**: F293 是一个终态 feature；不另建 temp-status MVP。
- **KD-2**: 不引入 Sol 私人/公司 `ExecutionSlot`；不可感知就不建模、不展示、不猜。
- **KD-3**: 负面状态到期变 `unknown`，绝不自动 `available`。
- **KD-4**: `scarce` / `degraded` 是 advisory；已知物理 `unavailable` 是 dispatch hard gate。
- **KD-5**: L0 只投影稀疏异常；实际发送前必须基于同一 resolver 重检。
- **KD-6**: 给证据和 alternatives，不给 opaque score，不静默改派。
- **KD-7**: signal 历史 TTL=0；时间字段只控制 active projection。
- **KD-8**: 每类事实一个 canonical owner；F293 负责组合，不复制所有真相。
- **KD-9**: routing-context preflight 自身故障时 warned fail-open，并记录 degradation；advisory 子系统不得成为 dispatch SPOF。
- **KD-10**: 真实 dispatch 成功只对因果匹配且可证明的 route/scope 构成 recovery evidence，不外推账号或无关 pool。

## Review Gate

- **Kickoff spec gate: PASS** — Ragdoll完成终态边界、failure modes、账号不可感知纠正与 AC 可验证性审阅；2×P1 + 1×P2 已在 `986b7412b52bb38ad003b74ed0e34e07b72f31fa` 闭合，final verdict 无 open items（`0001786252263358-000838-6961a286`）。
- Phase A 改动 architecture ownership / contract，implementation 前必须完成独立 Design Gate。
- 后续实现按实际风险逐 phase 选择 reviewer；不因默认习惯持续消耗同一只猫的额度。
