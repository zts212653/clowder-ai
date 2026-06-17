---
feature_ids: [F153]
related_features: [F130, F008, F150, F212]
topics: [observability, telemetry, metrics, health-check, infrastructure]
doc_kind: spec
created: 2026-04-09
community_issue: "zts212653/clowder-ai#388"
---

# F153: Observability Infrastructure — 运行时可观测基础设施

> **Status**: in-progress | **Owner**: Community + Ragdoll | **Priority**: P2

## Why

Cat Cafe 当前缺乏系统性运行时可观测能力：异常难定位、超时难检测、猫猫是否在工作没有可靠信号。F130 解决了日志落盘，但 metrics/tracing/health 这一层还是空白。社区贡献者提交了 clowder-ai#393 实现 Phase 1 基础设施。

operator experience（2026-04-09）："这是可观测性基础设施 PR，核心是在 packages/api 里接入 OTel SDK，补 telemetry redaction、metrics allowlist、Prometheus/OTLP、/ready 健康检查，以及 cli-spawn 参数脱敏。"

## What

### Phase A: OTel SDK + Metrics + Health Check（社区 PR intake）

从 clowder-ai#393 intake 以下模块：

1. **TelemetryRedactor** — 四级字段分类脱敏
   - Class A（凭证 → `[REDACTED]`）
   - Class B（业务正文 → hash + length）
   - Class C（系统标识符 → HMAC-SHA256）
   - Class D（安全数值 → passthrough）
2. **MetricAttributeAllowlist** — bounded cardinality，防止高基数标签爆炸
3. **OTel SDK init** — NodeSDK for traces/metrics/logs，Prometheus scrape + optional OTLP push
4. **5 个 instruments** — `invocation.duration`, `llm.call.duration`, `agent.liveness`, `invocation.active`, `token.usage`
5. **`/ready` 端点** — Redis ping probe，返回 `ready`/`degraded`
6. **cli-spawn 参数脱敏** — debug 日志不再打 prompt 明文

### Phase B: OTel 全链路追踪（社区 PR intake）✅

从 clowder-ai#450 intake 以下模块：

1. **parentSpan 全链路穿透** — invocationSpan → AgentServiceOptions → 6 providers → CliSpawnOptions → spawnCli
2. **`cat_cafe.cli_session` child span** — CLI 子进程生命周期追踪（4 路状态：timeout/error/signal/ok）
3. **`cat_cafe.llm_call` retrospective span** — 从 done-event 的 `durationApiMs` 反推 startTime（仅 Claude 等有计时数据的 provider）
4. **`tool_use` span events** — 通过 `addEvent()` 记录工具调用（点标记，非零时长 span）
5. **28 个结构测试** — source-level 验证 span 创建、线程化、属性、脱敏安全

### Phase C: Inline @mention observability（社区 PR intake）✅

从 clowder-ai#489 intake 以下模块：

1. **8+1 A2A counters** — `inline_action.checked/detected/shadow_miss/feedback_written/feedback_write_failed/hint_emitted/hint_emit_failed/routed_set_skip` + `line_start.detected`
2. **Shadow detection** — strict/relaxed 双层启发式，区分 `strict hit / shadow miss / narrative mention`
3. **Data minimization** — shadow miss 只保留 `contextHash + contextLength`，不写 raw text
4. **主链路接入** — `route-serial` 在 feedback 持久化、hint 发射、routedSet overlap 处补 metrics
5. **18 个回归测试** — narrative 过滤、same-line dual mention、routedSet skip、strict/shadow coexistence

### Phase D: Runtime 调试 exporter + 启动语义对齐（社区 PR intake）

从 clowder-ai#512 intake 以下模块：

1. **`TELEMETRY_DEBUG` 调试通道** — 用 `ConsoleSpanExporter` 输出 UNREDACTED spans，供本地维护者排查 tracing
2. **default-deny guardrail** — 仅 `NODE_ENV=development|test` 默认允许；其他/未设置环境必须显式 `TELEMETRY_DEBUG_FORCE=true`
3. **Hub 锁定** — `TELEMETRY_DEBUG` / `TELEMETRY_DEBUG_FORCE` 不出现在 Hub，不允许 runtime 编辑
4. **启动链语义对齐** — Unix / Windows API 子进程显式注入 `NODE_ENV`，让 guardrail 和真实启动模式一致
5. **guardrail 回归测试** — `telemetry-debug.test.js` 覆盖 env 组合 + exporter ordering
6. **启动链回归测试** — `start-dev-profile-isolation.test.mjs` / `start-dev-script.test.js` 覆盖 Unix / Windows 的 `NODE_ENV` 注入

### Phase E: Hub 嵌入式可观测 + Snapshot Store ✅

方案 B：API 代理 + 自建轻量前端，零外部依赖（不引入 Grafana/Tempo/Sentry）。

**安全约束（Design Gate Maine Coon review 2026-04-21）：**
- LocalTraceExporter 必须放在 RedactingSpanProcessor **之后**（redacted fan-out），Hub 只看脱敏后数据
- Exporter 投影为 redacted DTO 再入 store，不存 SDK span 对象；维护者看 raw 走 TELEMETRY_DEBUG console 通道
- 按 raw ID 查询时，先 HMAC 查询参数再 match store，不存 raw ID
- 所有 `/api/telemetry/*` 端点走 Hub session/cookie 鉴权（session-auth.ts），不走 `/ready` 公开模式
- Ring buffer 双阈值淘汰（maxSpans + maxAgeMs），内存 only，首版不上 SQLite
- Metrics 直读进程内 Prometheus registry，不 self-fetch localhost:9464

**设计边界：F153 = descriptive observability plane, not normative eval system。**
Phase E 只回答"发生了什么"（traces、metrics、健康状态），不做质量判断或打分。

**实现总结**（L1+L2+L3）：
1. **LocalTraceStore** — 内存 ring buffer（10K span，24h TTL）存储脱敏后的 TraceSpanDTO
2. **LocalTraceExporter** — OTel SpanExporter，将 ReadableSpan 投影为 DTO 写入 ring buffer
3. **MetricsSnapshotStore** — 30s 采样 Prometheus 指标，保留时序趋势（720 snapshot cap，6h TTL）
4. **Telemetry API 路由** — `/api/telemetry/traces`、`/traces/stats`、`/metrics`、`/metrics/history`、`/health`
5. **HubTraceTree** — 前端树形 trace 可视化（`buildForest` 按 `parentSpanId` 组装父子关系）
6. **burn-rate 告警** — SLO-based alerting（error rate / p95 latency / active invocations），WebSocket 推送
7. **产品级 instruments** — `invocation.completed`、`thread.duration`、`session.rounds`、`cat.invocation.count`、`cat.response.duration`

> **Review P1/P2 修复**（PR #546 review）：
> - P1: `findP95Latency` histogram bucket 语义错误（cumulative count ≠ seconds）→ 只用 `quantile="0.95"`
> - P1: `LocalTraceStore.query()` 改为 newest-first 遍历
> - P2: `/api/telemetry/health` 聚合 `/ready` 探针 + error rate → unified health verdict
> - P2: `task.*` instruments 重命名为 `invocation.completed` / `thread.duration`（匹配实际语义）

### Phase F: Trace 持久化 — 指针关联方案 ✅

> **Status**: merged | **Owner**: Ragdoll
> **Provenance**: zts212653/clowder-ai#592
> **Implementation PR**: zts212653/clowder-ai#579 (merged 2026-04-28, commit `8cc6f9a1`)
> **Cat-cafe intake**: zts212653/cat-cafe#1449 (commit `254c6e2fa`)
> **Trigger**: 重启后 trace 数据全丢（LocalTraceStore 纯内存）
> **Discussion**: 2026-04-22，三猫讨论（Ragdoll + Sonnet + GPT-5.4）
>
> **Scope note**: AC-F1..F7 全部 ✅。AC-F8（tool_use spans 持久化）声明 deferred — 当前 MCP tool span 是零时长点标记，待 Phase J 真实执行边界落地后再升级持久化策略（Phase J Slice J-B AC-J7/J8 直接覆盖 AC-F8 unblock）。Phase F header 状态过期至 2026-05-22 由本次 doc-sync 修正（clowder-ai#753 / cat-cafe#1839）。

#### 问题

`LocalTraceStore` 是纯内存 ring buffer，进程重启后所有 span 数据丢失。用户在 Hub Traces tab 看到空白，无法回溯重启前的调用链路。

#### 被否决的方案

| 方案 | 否决理由 |
|------|----------|
| SQLite 独立存储 | 引入新持久化层，与 Redis 已有数据冗余 |
| 完整 span JSON 写入 InvocationRecord | InvocationRecord TTL=0 永久保存，span 数据（3-10 KB/次）会线性膨胀 Redis 内存；所有 `HGETALL` 读路径变重 |
| 从 Redis thread 数据重建 | InvocationRecord 不含 traceId/spanId/parentSpanId，无法重建 OTel 层次关系 |

#### 选定方案：指针关联 + 消息数据合成

**核心洞察**：Redis 消息存储（`RedisMessageStore`）已经持久化了丰富的执行数据：

| 已有字段 | 可映射的 span 信息 |
|----------|-------------------|
| `metadata.usage.durationMs` / `durationApiMs` | span duration |
| `metadata.usage.inputTokens/outputTokens/cacheReadTokens` | span attributes (token 计数) |
| `toolEvents[].timestamp` + `label` | tool event 时间和名称 |
| `message.timestamp` | span endTime（⚠️ 非 startTime，见下方精度说明） |
| `extra.stream.invocationId` | invocation 关联 |

> **startTime 精度说明**（Maine Coon review）：assistant message 的 `timestamp` 是终态落盘时打的，接近 span **end** 而非 start。合成 span 时应使用 `startTime = timestamp - durationMs`（invocation/cli_session）或 `timestamp - durationApiMs`（llm_call）。只有 user message 的 `timestamp` 可直接作为 `cat_cafe.route` span 的 startTime。

**只需补 OTel 身份指针**（~100 bytes/消息），不需要存完整 span 快照：

```typescript
// Message.extra.tracing — 新增字段
interface TracingPointers {
  traceId: string;        // 32-char hex, OTel trace ID
  spanId: string;         // 16-char hex, 该消息对应的 span
  parentSpanId?: string;  // 父 span ID（建立层次关系）
}
```

重启时从 Redis 消息数据合成 `TraceSpanDTO`：
- OTel ID 从 `extra.tracing` 取
- timing 从 `metadata.usage` 取
- 工具事件从 `toolEvents` 取
- token 计数从 `metadata.usage` 取

#### 前置条件（P1 阻塞）

**相关性键不统一**（GPT-5.4 发现，Maine Coon review 修正键名）：

| span 类型 | 是否带 invocationId | 问题 |
|-----------|-------------------|------|
| `cat_cafe.route`（根） | ❌ 没带 | Phase E 新增的根 span，需一并统一 |
| `cat_cafe.invocation`（子） | ❌ 没带 | 按 invocationId 查询查不到 |
| `cat_cafe.cli_session`（子） | ✅ 带了 | 但用的是 inner registry ID，非 outer InvocationRecord.id |
| `cat_cafe.llm_call`（子） | ❌ 没带 | 同上 |

**修复**：所有四类 span 统一携带 **`invocationId`**（值 = outer `InvocationRecord.id`）。

> ⚠️ **不引入新键名**：键名必须继续使用 `invocationId`（而非 `recordInvocationId`），因为：
> 1. `TelemetryRedactor` 只识别 `invocationId` 为 Class C（HMAC pseudonymize）
> 2. `LocalTraceStore` 查询过滤按 `attributes.invocationId` 匹配
> 3. `/api/telemetry/traces?invocationId=` 端点依赖此键名
>
> 改名会同时破坏脱敏和查询。

#### Span 层级变更

Phase E 实现引入了 `cat_cafe.route` 根 span（`AgentRouter` 创建），`cat_cafe.invocation` 现在是它的子 span。持久化需要覆盖四类 span：

| span | 指针写入位置 | startTime 来源 |
|------|-------------|---------------|
| `cat_cafe.route` | user message `extra.tracing` | user message `timestamp`（直接用） |
| `cat_cafe.invocation` | assistant message `extra.tracing` | `timestamp - durationMs` |
| `cat_cafe.cli_session` | 同上（共用 assistant message） | `timestamp - durationMs` |
| `cat_cafe.llm_call` | 同上 | `timestamp - durationApiMs` |

> **tool_use spans 暂不持久化**：当前 MCP 工具 span 是零时长点标记，等 Phase J 真实执行边界落地后再升级持久化策略（KD-25 → Phase J KD-39 Slice J-B）。

#### extra.tracing 前置改造

`StoredMessage.extra` 当前不含 `tracing` 字段，需要：

1. **类型扩展**：`MessageStore.ts` 的 `extra` 类型加入 `tracing?: TracingPointers`
2. **Parser 保留**：`redis-message-parsers.ts` round-trip 时保留 `tracing` 字段
3. **Merge 语义**：`RedisMessageStore.updateExtra()` 当前是整块覆盖（不是 merge），写入 `tracing` 时必须先读再合并，或改为 `HSET` 字段级更新

#### 实施步骤

1. **P1 修复**：统一 `invocationId`（root/cli/llm/route 四类 span 都带，值 = outer InvocationRecord.id）
2. **写入指针**：invocation 创建 span 时，将 `{ traceId, spanId, parentSpanId }` 写入对应 Message 的 `extra.tracing`
3. **hydrate 逻辑**：`LocalTraceStore.hydrate(dtos)` 方法，启动时从最近消息合成 span 回填 buffer
4. **启动流程**：`initTelemetry` 后扫描最近 24h 消息（按 `msg:timeline` sorted set 范围查询），提取有 `extra.tracing` 的消息，合成 DTO 调用 `hydrate()`

#### 写入时机

放在 **outer invocation 的 terminal status transition**（`routes/messages.ts` 中 status 变 `succeeded`/`failed` 的 `update()` 调用处），不是 exporter hook，也不是 inner `invokeSingleCat` finally：

- exporter `onEnd` 时不知道所有 span 是否都结束了
- inner finally 是 per-cat 的，多猫并发写同一个 record 会互相踩
- outer terminal transition 是唯一确定"该 invocation 所有工作都完成"的时刻

### Phase G: Prompt X-Ray + Cross-route A2A Trace Propagation

> **Status**: merged | **Owner**: Ragdoll
> **Provenance**: 社区 PR clowder-ai#619（Closes clowder-ai#583），原提案为独立 F181，经维护者判定归入 F153 Phase G（2026-05-08）。
> **Implementation**: clowder-ai#619 intake (AC-G1..G8 + G9 LocalTraceStore TTL, merged 2026-05-08); Phase G-Followup native L0 closure (AC-G10 / KD-44, merged 2026-06-09 via clowder-ai#851 closing the KD-42 gap — `PromptCapture` now persists `nativeSystemPrompt` for F203 native-L0 providers + Hub X-Ray Inspector System tab shows Native L0 zone above message-system pack appendix).

两个核心能力：Prompt X-Ray 调试捕获 + 跨猫 A2A 调用链因果追踪。

#### Prompt X-Ray

`PromptCaptureStore` — 文件级 ring buffer（`~/.cat-cafe/prompt-captures/`），NDJSON 索引 + gzip 载荷，500 条上限，6h TTL。捕获内容：system/user/mission prompt、injection decision、token 估算（1:3.5 字符比）。

- **触发**：`capturePromptIfEnabled` 在 `invoke-single-cat` fire-and-forget 调用，`PROMPT_CAPTURE` env 控制开关（默认关），`PROMPT_CAPTURE_CATS` 可选白名单
- **API**：`/api/debug/prompt-captures/{captureId}`、`?invocationId`、`?threadId`、`/status`、`/prune` — session auth + userId resource-level auth（只返回当前用户的 captures）
- **Hub**：`HubTraceTree` 新增 X-Ray Inspector，tabs 展示 system/user/effective/meta prompt 分解
- **Known gap（2026-05-26 / F203 interaction）**：F203 将 Codex/Claude 的 L0 identity 移入 native system channel（Codex `developer_instructions` / Claude `--system-prompt-file`）后，当前 Prompt X-Ray 仍只捕获 `invoke-single-cat` 的 user/effective prompt 与可选 pack-only `systemPrompt`；因此 `PROMPT_CAPTURE=on` 会落盘，但 Hub `System` tab 可能为空，无法代表真实 native system prompt。

#### Cross-route A2A Trace Propagation

W3C TraceContext 对齐的跨猫调用因果链：

1. `CallerTraceContext`（`genai-semconv.ts`）：readonly `traceId`/`spanId`/`traceFlags`，从 route 穿透到 invocation
2. `wrapWithDispatchSpan`（`dispatch-span.ts`）：创建 `mention_dispatch` child span，返回新 `CallerTraceContext` 供被调用方重建 remote parent
3. `setTraceContext` on `IAuthInvocationBackend`（Memory + Redis 实现）：持久化 trace context 到 invocation record，best-effort（try/catch + typeof check，不阻塞 invocation hot path）
4. `AgentRouter` 接收 `callerTraceContext` option，重建 remote parent context
5. `InvocationQueue` entry 携带 `callerTraceContext`，callback A2A trigger 路径同步传播
6. Route aggregate attributes：`ROUTE_TOTAL_CATS_INVOKED`、`ROUTE_TOTAL_TOKENS`、`ROUTE_HAS_A2A_HANDOFF`

#### LocalTraceStore TTL 统一

默认 TTL 从 2h 提升到 24h，导出常量 `LOCAL_TRACE_STORE_DEFAULT_MAX_AGE_MS` 供 `local-trace-store.ts` 和 `hydrate-traces.ts` 共用。

### Phase H: 后续增强（Backlog）

- Grafana 统一看板
- ~~MCP call spans + tool execution duration spans（真实执行边界）~~ → promoted to **Phase J** (2026-05-22)
- 更广的 runtime exporter 级 tracing tests（in-memory exporter 验证父子关系）

### Phase I: Step Summary（Agent Loop 行为节奏度量）✅

> **Status**: merged | **Owner**: Ragdoll
> **Provenance**: zts212653/clowder-ai#721
> **Spec PR**: clowder-labs/clowder-ai#2 (merged 2026-05-19)
> **Implementation PR**: clowder-labs/clowder-ai#3 (merged 2026-05-19, commit `f4594cb9`)
> **Governance split PR**: clowder-labs/clowder-ai#4 (dir-exceptions extension, merged 2026-05-19, commit `d3e60d01`)
> **Discussion**: 2026-05-19，三方对齐（operator + Maine Coon/Maine Coon + Ragdoll/Ragdoll）
>
> **Provider coverage**: Claude CLI provider 已通过 `claude-ndjson-parser.ts` 在 `message_stop` 处 emit `cat_cafe.agent_loop` marker。其余 provider（Codex / Gemini / Kimi / Antigravity / OpenCode / DARE / A2A）尚未实现 marker emit，Step Summary 会显式显示 `agent_loop_count: —`（per AC-I2/I7 non-degradation rule）。后续 phase 补齐各 provider 的 stream parser hook。

#### 问题

F153 Phase A-G 已经把 span/metrics 基础设施做齐，但 Hub 没有一个 first-class 视图回答"这只猫这次工作走了几步"。Trace 树形瀑布图展示了**结构**，metrics dashboard 展示了**总量**，缺一个把两者绑到"一次猫工作"上的**行为节奏**视图。

#### 定义：步 = 一次 Agent Loop

```
Agent Loop 边界锚 = cat_cafe.agent_loop marker event（per-provider stream parser 识别）
  ├─ 1 次 LLM 决策（think，必有）
  ├─ 0~N 次 tool 调用（act，可并行）
  └─ 0~N 次 tool result 反馈（observe）

  下一次 marker → 进入下一个 loop
```

**为什么需要新引入 stream-level marker？** 现有 stream 信号都是 invocation 粒度，**不是** loop 粒度：

- `done` event 是 invocation 结束信号（ClaudeAgentService.ts:476、CodexAgentService.ts:709 都在 CLI 跑完后才 yield 一次），**per-invocation 一次**
- `cat_cafe.llm_call` span 也是 invocation 级——`msg.metadata.usage` 只在 `msg.type === 'done'` 分支里被消费（invoke-single-cat.ts:1308/1387），usage 是整个 invocation 的累计而非单次 LLM call

真正的 loop 边界必须在 **provider stream parser** 层识别（Claude CLI 的 message-level events、Codex stream chunks 等），并 emit 统一的 `cat_cafe.agent_loop` marker。**首版若某 provider 暂无可识别的 boundary signal**，该 provider 显示 `—`，记为 known limitation，**不退化成 invocation count**。

**纯回复也算 1 个 loop**（width=0）——决策点存在就是一步，否则会鼓励"摸鱼短回复"。

**业界对齐**：LangChain `AgentExecutor`、Anthropic SDK agent loop、AutoGPT step、OpenAI Assistants run step、DeepEval `StepEfficiencyMetric` 全部以 agent loop / step 为基本单位，非 LLM call、非 tool call。命名采用行为概念（`agent_loop_count`）而非实现锚（`llm_call_count`）。

#### 度量：Length × Width

```
Length (深度) = agent_loop_count     ← 主轴："步数"
Width  (宽度) = avg tools per loop   ← 辅轴："步幅"
```

两个维度合起来才能区分"高效但密集"与"啰嗦但稀疏"——长度大且宽度窄 = 疑似绕路（但**不在 Phase I 范围**，见 KD-32）。

#### 实现：数据来源映射（含新增 marker / counter）

| 度量 | 数据来源 | 新增？ |
|------|---------|--------|
| `agent_loop_count` | route 下 `cat_cafe.agent_loop` marker count（per-provider stream parser emit）；**无 marker 的 provider 显示 `—`**，不退化成 invocation count | ✅ 新 marker 类型 + per-provider parser hook |
| `tool_call_count` | **双轨**：child `cat_cafe.tool_use *` spans 计数（MCP/business）+ invocationSpan attribute `tool.basic_call_count`（basic tools，span-helpers.ts:81-96） | ❌ |
| `a2a_dispatch_count`（per-route 派生） | child `cat_cafe.mention_dispatch` spans 计数 | ❌ |
| `cat_cafe.a2a.dispatch.count`（aggregate counter） | **新增** counter，attributes 仅 `AGENT_ID`（已 allowlist）；**不带** `invocationId / threadId`（metric-allowlist.ts:8-9 禁止）；**不复用** `CALLBACK_TOOL / CALLBACK_REASON`（语义为 callback auth failure，与 dispatch 无关）；如需 `dispatch.source/status` 等专属 labels 须先扩展 allowlist | ✅ |
| `duration_ms` | `cat_cafe.route` span duration | ❌ |
| `token_total` | `cat_cafe.route` span attribute `ROUTE_TOTAL_TOKENS`（route-serial.ts:1900，不走 `token.usage` metric——无 route 维度） | ❌ |
| `error_count` | span status code aggregation | ❌ |

> ⚠️ **descriptive only**（KD-16）：Phase I dashboard 只展示原始计数，**不计算/不展示** "efficiency"、"quality"、任何 normative score。质量判断留给未来 eval feature。

#### Live vs Restored 显示分级

`hydrate-traces.ts:6-8` 明确历史数据扁平为 `cat_cafe.invocation.restored`，**不恢复**完整 route/invocation/cli_session/llm_call 层级。所以 Phase I 必须显式区分：

| 数据来源 | agent_loop_count | tool_call_count | a2a_dispatch_count | duration_ms |
|---------|-----------------|-----------------|-------------------|-------------|
| Live span（完整层级） | 真实值 | 真实值 | 真实值 | 真实值 |
| Restored（扁平化） | **`—`** | **`—`** | **`—`** | 真实值 |

UI 必须显示 `—` 而非 `0`，否则会让"重启前的数据"看起来像"全是 0 步的快速调用"，污染判断。

#### Out of scope（延后到独立 feature）

- **Task 级步长**：需要先建 cross-invocation task 边界 primitive（task_id 不是 invocationId）
- **Step Efficiency / 质量评分**：descriptive plane 边界（KD-16），eval feature 独立做
- **MCP vs basic tool call 拆分**：依赖 Phase J 真实 tool 执行边界 span（KD-25 → KD-36..41 / Slice J-A）
- **历史 sub-count 回填**：hydrate-traces.ts 的扁平化约束，不重建完整层级

### Phase J: MCP Tool Span — 真实执行边界

> **Status**: implemented | **Owner**: Ragdoll
> **Current state (2026-06-02)**: Slice J-A 已由 clowder-ai#763/#774 intake 落地；Slice J-B 已由 clowder-ai#825 / cat-cafe#2052 intake 落地。F153 顶层仍保持 `in-progress`，因为 Phase G 尚未关闭。
> **Promoted from**: Phase H Backlog item "MCP call spans + tool execution duration spans"
> **Discussion**: 2026-05-22，Design Gate（Ragdoll + Maine Coon/codex GPT-5.5 + gpt52/GPT-5.4 + Ragdoll/Sonnet 4.6）— Sonnet 提了 "Hybrid A+C" 替代方案（transformer 内 UUID 状态机 + 栈 fallback），与 codex/gpt52 的"明确降级"立场冲突，最终采纳 codex/gpt52 的明确降级路线（KD-41），Sonnet 提案 rejected
> **Implementation PRs**:
> - Spec: clowder-ai#755 (merged 2026-05-22)
> - Slice J-A foundation (ToolSpanTracker + call site, AC-J1/J3/J4/J5/J6): clowder-ai#763 (merged 2026-05-25)
> - Slice J-A AC-J2 (wire DARE + Codex + CatAgent native tool ids): clowder-ai#774 (merged 2026-05-28)
> - Slice J-B (Persist + hydrate + provider matrix, AC-J7/J8/J9 + R6 toolName decoupling KD-43): clowder-ai#825 (merged 2026-06-02, commit `f06d0d00`)

#### 问题

`recordToolUseSpan`（`packages/api/src/infrastructure/telemetry/span-helpers.ts:101-114`）创建 span 后**立即 `end()`**，造成连锁损害：

- **零时长** — Hub Trace 树里 MCP tool 是塌缩的点标记
- **status 永远 OK** — 在 `tool_result` 返回前就设了 `SpanStatusCode.OK`，没看 `is_error`
- **阻塞 AC-F8** — `extra.tracing` 持久化零时长 span 只是占位，无实际价值
- **阻塞 AC-I5 width 真实性** — tool count 真实但 tool 维度 trace 视图全是假数据

#### 关键设计风险（多猫共识）

| 风险 | 现状证据 | 影响 |
|------|---------|------|
| AgentMessage 缺 `toolUseId` 字段 | `types.ts:115+` 只有 `toolName/toolInput`，无关联 ID | 无法 tool_use → tool_result 配对 |
| AgentMessage 缺结构化 result status | `tool_result` 无 `is_error/success/exitCode` 字段，只能从 `content` 字符串猜 | span status 真实性无保证 |
| Provider native ID 丢失 | `CatAgentService.ts:154` 有 `tool_use_id`、`dare-event-transform.ts:66` 有 `tool_call_id`，但 transformation 丢失 | 必须修复 transformer 保真 |
| 单工具串行假设不成立 | Claude/CatAgent 一个 assistant content 可多个 tool_use block | `Map<toolName>` / 栈模型在同名/乱序时错配 |
| `span-helpers.ts` 本地 `isMcpTool` 缺失 Codex `mcp:` 前缀识别 | 现认 `cat_cafe_` / `mcp__` / `signal_`，但漏 `mcp:`；而 `tool-usage/classify.ts` 已正确处理该格式 | Codex MCP tool 误判 basic |

#### 设计原则（多猫共识 → KD-36..41）

1. **必须基于 native ID 关联** — 不接受 `Map<toolName, Span>` 弱关联（KD-36）
2. **按"可能并发/乱序"设计** — per-invocation `ToolSpanTracker`，key = `toolUseId` × invocation+cat scope（KD-37）
3. **AgentMessage 扩展双字段** — `toolUseId?: string` + `toolResultStatus?: 'ok' | 'error' | 'unknown'`（KD-38）
4. **同 Phase 包含 AC-F8 unblock** — Phase J 不标 ✅ 直到 J-A + J-B 两 slice 都关闭（KD-39）
5. **复用 `tool-usage/classify.ts`** — 移除 `span-helpers.ts` 本地 `isMcpTool`（KD-40）
6. **Provider 支持矩阵文档化** — 不允许"至少 X 其他 fallback"模糊口径（KD-41）

#### 实施 slice

| Slice | 内容 | AC 覆盖 |
|-------|------|---------|
| **J-A** | Live real-duration spans — message schema 扩展、ToolSpanTracker、provider transformer 注入、orphan 兜底、test | AC-J1..J6 |
| **J-B** | Persist + hydrate — `StoredToolEvent` 扩展、`extra.tracing` 分离、hydrate 恢复真实 tool span、provider matrix 附录 | AC-J7..J9 |

> ✅ **Slice J-A + J-B 已关闭**（KD-39 防 Phase F 时 status 漂移的二次重现）

#### Out of scope

- **MCP server-side instrumentation** — client-side duration 含 network/marshaling，独立 feature
- **历史 tool span 回填** — hydrate 前的旧数据保持现状，不重建
- **Tool input/result body 写入 span attr** — 保持低敏，只存 `tool.input.keys` / `tool.result.status`，不存正文

#### Provider 支持矩阵（AC-J9）

四件套 = 真实 duration span 所需的最小信号集：

- **start**: 在 `tool_use` 事件能识别工具调用开始（`AgentMessage.toolUseId` 已注入）
- **end**: 在 `tool_result` 事件能识别工具调用结束（同 `toolUseId` 配对）
- **id**: provider 原生 ID（不是合成 UUID，可跨进程稳定）
- **status**: 来自 execution edge 的结构化 `'ok' | 'error' | 'unknown'`（非 content 字符串猜测，KD-38）

| Provider | start | end | id | status | 真实 duration span | 备注 |
|----------|:-----:|:---:|:--:|:------:|:------------------:|------|
| **Claude CLI** | ✅ | ❓ | ⏳ | ❓ | ⏳ deferred | `claude-ndjson-parser.ts:196` 的 `tool_use` 分支当前**不抽取** `tool_use.id`（Anthropic block schema 里有，parser 未读出来），tool_result 路径也未 verified；Phase J Slice J-B follow-up wire 后才能升级矩阵（**Maine Coon R1 P2-2 fix**：之前误标 ✅，已改 deferred 与代码现状对齐） |
| **Codex** | ✅ | ✅ | ✅ `item.id`（lifecycle anchor，PR #755 R1 P2-2 verified — **不是 `tool_call_id`**） | ✅ `item.status` (`completed`/`failed`/`error`) | ✅ | AC-J2 wired in PR #774 |
| **DARE** | ✅ | ✅ | ✅ `data.tool_call_id`（event payload） | ✅ `tool.result` vs `tool.error` event | ✅ | AC-J2 wired in PR #774；`tool_call_id` 从 toolInput lift 到顶层 toolUseId（release note） |
| **CatAgent** | ✅ | ✅ | ✅ `block.id`（Anthropic native tool_use.id） | ✅ execution edge (`unknown tool` / 成功 / thrown error 三分支) | ✅ | AC-J2 wired in PR #774；status 严格从 execution edge 不从 content 猜（KD-38） |
| **Gemini CLI** | ✅ | ❓ | ❓ | ❓ | ⏳ deferred | `gemini-event-parser.ts:53` 有 `tool_use` 但 `tool_result` 字段名待 verify；Slice J-B follow-up |
| **Antigravity** | ✅ | ✅ | ❓ | ❓ | ⏳ deferred | provider 流形复杂（CDP 桥 + 多模型切换），字段名 follow-up |
| **OpenCode** | ✅ | ❓ | ❓ | ❓ | ⏳ deferred | 字段名 follow-up |
| **Kimi** | ✅ | ❌ | ❌ | ❌ | ❌ 明确降级 | `KimiAgentService.ts:319` 有 `tool_use` 但 **无 `tool_result` 事件**；明确 fallback 不开 span（KD-41） |
| **A2A** | n/a | n/a | n/a | n/a | ❌ 不适用 | A2A 不是 LLM provider 而是 cat-to-cat 路由；不参与 tool span 度量 |

**降级行为约束（KD-41 honesty）**：

- 缺 id → 不开 span（不伪造合成 UUID 撑数）
- 缺 end / status → 不开 span（不假定 `ok` 兜底）
- 任一字段缺失的 provider，事件仍透传到 `StoredToolEvent` 用于 Hub 历史展示；hydrate 跳过 span 合成

> **未来 PR 加新 provider**：必须先更新此矩阵 + provide AC-J2 wire；不允许"先 wire 后补 matrix"。

## Acceptance Criteria

### Phase B（OTel 全链路追踪）✅
- [x] AC-B1: invocationSpan 作为 parentSpan 穿透到 spawnCli（全部 6 个 provider）
- [x] AC-B2: `cat_cafe.cli_session` child span 在 spawnCli 创建，finally 块中按退出原因设 status
- [x] AC-B3: `cat_cafe.llm_call` retrospective span 从 done-event durationApiMs 创建（有计时数据时）
- [x] AC-B4: `tool_use` 通过 `addEvent()` 记录（非零时长 span 反模式）
- [x] AC-B5: span attribute keys 使用 redactor 可识别的 key（`invocationId`/`sessionId`，不用 snake_case）
- [x] AC-B6: 28/28 结构测试通过

### Phase A（OTel SDK + Metrics + Health Check）✅
- [x] AC-A1: TelemetryRedactor 四级分类正确脱敏（Class A/B/C/D 各有测试）
- [x] AC-A2: Prometheus `/metrics` 端点可用，5 个 instruments 有数据
- [x] AC-A3: `/ready` 端点返回 Redis 健康状态
- [x] AC-A4: cli-spawn debug 日志不含 prompt 明文（回归测试）
- [x] AC-A5: HMAC salt 缺失时启动阶段校验并 graceful degradation（禁用 OTel + warning log，服务继续运行）
- [x] AC-A6: Prometheus exporter 端口可通过 env 配置（不硬编码 9464）
- [x] AC-A7: `activeInvocations` 计数器在 generator early abort 时正确递减
- [x] AC-A8: yielded-error 路径（`hadError = true`）的 span 正确标记为 ERROR 并补 OTel error log
- [x] AC-A9: `agent.liveness` gauge 有实际调用点（或从 scope 移除，instruments 数量与 PR 描述一致）
- [x] AC-A10: aborted invocation（generator `.return()`）的 OTel span/log 与审计日志信号一致

### Phase C（Inline @mention observability）✅
- [x] AC-C1: line-start @mention baseline 和 inline-action 检测 counters 已接入 `route-serial`
- [x] AC-C2: shadow detection 只把 relaxed-action vocab gap 记为 miss，纯 narrative mention 不污染计数
- [x] AC-C3: routedSet overlap 单独计数，且 narrative routed mention 不得误计 skip
- [x] AC-C4: feedback 写入失败 / hint 发射失败从 silent catch 变为可观测 counter
- [x] AC-C5: shadow miss metadata 只含 hash + length，不含 raw text
- [x] AC-C6: regressions 覆盖 strict/shadow 同猫跨行、same-line dual mention、code block / blockquote 排除

### Phase E（Hub 嵌入式可观测 + Snapshot Store）✅
- [x] AC-E1: `LocalTraceStore` ring buffer 存储脱敏 TraceSpanDTO（10K cap，24h TTL）
- [x] AC-E2: `LocalTraceExporter` 在 RedactingSpanProcessor 之后运行，只看脱敏属性
- [x] AC-E3: `GET /api/telemetry/traces` 支持 traceId/invocationId(HMAC)/catId 过滤
- [x] AC-E4: trace 查询端 HMAC 原始 ID 后匹配（pseudonymized store）
- [x] AC-E5: 所有 telemetry 端点要求 session 认证
- [x] AC-E6: `HubTraceTree` 按 `parentSpanId` 构建 forest，树形瀑布图展示父子层次
- [x] AC-E7: `MetricsSnapshotStore` 30s 采样，`/metrics/history` 返回趋势数据

### Phase F（Trace 持久化 — 指针关联方案）✅
- [x] AC-F1: 四类 span（route/invocation/cli_session/llm_call）统一携带 `invocationId` attribute（值 = outer InvocationRecord.id，键名不变）
- [x] AC-F2: Message `extra.tracing` 写入 `{ traceId, spanId, parentSpanId }` 指针（route → user message，invocation/cli/llm → assistant message）
- [x] AC-F3: `LocalTraceStore.hydrate()` 从消息数据合成 TraceSpanDTO 并回填 buffer，startTime 使用 `timestamp - duration` 反推（非直接用 message.timestamp）
- [x] AC-F4: 冷启动时从最近 24h 消息自动 hydrate，Hub Traces tab 可见历史 span
- [x] AC-F5: hydrate 使用 `msg:timeline` sorted set 范围查询，不做全表扫描
- [x] AC-F6: 每条消息 tracing 指针增量 ≤ 100 bytes，不存完整 span 快照
- [x] AC-F7: `StoredMessage.extra` 类型扩展含 `tracing`，parser round-trip 保留，`updateExtra()` 使用 merge 语义
- [x] AC-F8: tool_use spans 持久化 — Phase J Slice J-B AC-J7/J8 直接接续：`StoredToolEvent` 扩展 + hydrate 合成真实 duration `cat_cafe.tool_use ...` child span（不再退化为 `invocation.restored`）

### Phase D（Runtime 调试 exporter + 启动语义对齐）✅
- [x] AC-D1: `TELEMETRY_DEBUG` 通过 `ConsoleSpanExporter` 输出 spans，且 regular OTLP pipeline 仍保持 redaction
- [x] AC-D2: `shouldEnableDebugMode()` 采用 default-deny guardrail；`NODE_ENV` 未设置时默认阻止
- [x] AC-D3: `TELEMETRY_DEBUG` / `TELEMETRY_DEBUG_FORCE` 在 Hub 中隐藏且不可 runtime 编辑
- [x] AC-D4: Unix `start-dev.sh` 按 API 启动模式注入 `NODE_ENV`
- [x] AC-D5: Windows `start-windows.ps1` 通过 API Start-Job 注入同样的 `NODE_ENV` 语义
- [x] AC-D6: `telemetry-debug.test.js` + `start-dev-profile-isolation.test.mjs` + `start-dev-script.test.js` 覆盖 guardrail 与启动链回归

### Phase G（Prompt X-Ray + Cross-route A2A Trace Propagation）
- [x] AC-G1: `PromptCaptureStore` 文件级 ring buffer（500 条上限，6h TTL），NDJSON 索引 + gzip 载荷。Implemented in prompt-capture-store.ts via PR #619 intake.
- [x] AC-G2: `PROMPT_CAPTURE` env gate 默认关闭，`PROMPT_CAPTURE_CATS` 可选白名单过滤。Wired in `isPromptCaptureEnabled()` via PR #619.
- [x] AC-G3: `capturePromptIfEnabled` 在 `invoke-single-cat` fire-and-forget 调用，不阻塞 invocation hot path. Wired at invoke-single-cat.ts:1548; AC-G10 follow-up keeps the fire-and-forget invariant via async `runCapture()` wrapper inside the bridge.
- [x] AC-G4: `/api/debug/prompt-captures/*` 路由走 session auth + userId resource-level auth. Implemented in prompt-captures.ts via PR #619.
- [x] AC-G5: `CallerTraceContext` 类型（W3C TraceContext 对齐：traceId/spanId/traceFlags）定义在 `genai-semconv.ts`. Defined at genai-semconv.ts:47 via PR #619.
- [x] AC-G6: `wrapWithDispatchSpan` 创建 `mention_dispatch` child span 并返回 `CallerTraceContext`. Implemented in dispatch-span.ts via PR #619.
- [x] AC-G7: `setTraceContext` on `IAuthInvocationBackend`（Memory + Redis 实现），best-effort try/catch. Wired in IAuthInvocationBackend.ts:80, InvocationRegistry.ts:170, and RedisAuthInvocationBackend.ts:408 via PR #619.
- [x] AC-G8: Route aggregate attributes（`ROUTE_TOTAL_CATS_INVOKED`/`ROUTE_TOTAL_TOKENS`/`ROUTE_HAS_A2A_HANDOFF`）设在 route span. Wired in route-serial / route-parallel via PR #619.
- [x] AC-G9: `LocalTraceStore` 默认 TTL 从 2h 提升到 24h，导出 `LOCAL_TRACE_STORE_DEFAULT_MAX_AGE_MS` 常量. Done in PR #619 (Phase E follow-up bundled into Phase G intake).
- [x] AC-G10: Prompt X-Ray 必须覆盖 F203 native L0 channel，或在 UI/API 中明确拆分 native system prompt vs user/effective prompt，避免把空 `System` tab 误读成未捕获. Closed in Phase G-Followup (2026-06-09, KD-44): `PromptCapture` schema gained `nativeSystemPrompt` / `nativeSystemPromptSource` / `nativeSystemTokenEstimate` / `totalTokenEstimate` / `captureDiagnostics`; bridge async-fetches L0 from `compileL0ViaSubprocess` for `service.injectsL0Natively()` providers (Claude/Codex); Hub X-Ray Inspector System tab now zones Native L0 (system role) above the message-system pack appendix; resume amber banner now distinguishes message-system path from native L0; token bar and Meta tab break out native L0 vs message tokens to fix silent under-count. `l0-compiler.ts` gained in-flight Promise dedup + generation guard so capture and native injection sharing a cold cache don't double-spawn, and old compiles cannot repopulate stale L0 after `clearL0Cache()`. Test coverage: `l0-compiler.test.js` 15/15 (4 new AC-G10 dedup/invalidation tests) + `prompt-capture.test.js` 20/20 (5 new AC-G10 tests: backward compat, native capture, fail-safe diagnostic, non-native passthrough).

### Phase I（Step Summary — Agent Loop 行为节奏度量）✅
- [x] AC-I1: Hub Traces tab 暴露 "Step Summary" 子视图（per `cat_cafe.route`），展示 `agent_loop_count` / `tool_call_count` / `a2a_dispatch_count` / `duration_ms` / `token_total` / `error_count`
- [x] AC-I2: 每个 provider stream parser 在识别到一次 LLM call 边界时 emit 统一的 `cat_cafe.agent_loop` marker；`agent_loop_count` = route 下 marker 计数（Claude provider 在 `message_stop` 处 emit；其他 provider 显示 `—`，不退化为 invocation count）
- [x] AC-I3: 新增 `cat_cafe.a2a.dispatch.count` counter，在 `cat_cafe.mention_dispatch` span 创建时 increment；attributes **仅 `AGENT_ID`**，不带高基数字段；per-route `a2a_dispatch_count` 从 span 计数派生
- [x] AC-I4: Restored span 的 sub-step 计数显示 `—` 或 null marker，**不显示 0**；只 `duration_ms` 对 restored 有效
- [x] AC-I5: Step Summary 面板 **不**计算或展示 "efficiency" / "quality" / 任何 normative score——只展示 raw counts（descriptive plane，遵循 KD-16）
- [x] AC-I6: 2D Length × Width 展示——UI 同时显示 `agent_loop_count`（深度）和 `tool_call_count / agent_loop_count`（平均宽度）
- [x] AC-I7: 单元/集成测试覆盖 counter increment、restored-vs-live 区分、AC-I5 normative 字段缺位、**live provider 无 `cat_cafe.agent_loop` marker 时 `agent_loop_count` 显式显示 `—`**（不退化成 invocation count，Phase I 最关键防退化边界）

### Phase J（MCP Tool Span — 真实执行边界）

#### Slice J-A: Live real-duration spans

- [x] AC-J1: `AgentMessage` 类型扩展 — `toolUseId?: string` + `toolResultStatus?: 'ok' | 'error' | 'unknown'`；`tool_result` 也带 `toolName`
- [x] AC-J2: provider transformer 按 AC-J9 矩阵保真 native id / structured status — **Codex** (`item.id` + `item.status`)、**DARE** (`data.tool_call_id` + `tool.result` / `tool.error`)、**CatAgent** (`block.id` / execution edge) 四件套已 wired；Claude CLI / Gemini CLI / Antigravity / OpenCode deferred，Kimi / A2A 明确降级不承诺 real duration span
- [x] AC-J3: `ToolSpanTracker` per-invocation — `start(toolName, toolUseId, input)`、`end(toolUseId, status)`、`endAllOrphans(reason)`；key scope = invocation+cat 避免 provider raw id 跨 invocation 碰撞
- [x] AC-J4: finally 块兜底 end orphan span 并标记 `orphan/aborted` attribute（PR #732 mention_dispatch abort safety 模式）
- [x] AC-J5: tool span 通过 `tool-usage/classify.ts` 分类（移除 `span-helpers.ts` 本地 `isMcpTool`），同步覆盖 Codex `mcp:` 前缀
- [x] AC-J6: behavioral test (InMemorySpanExporter) 覆盖 (a) 同名双 tool 并行 (b) result 乱序到达 (c) error result → span status ERROR (d) abort orphan cleanup (e) Codex `mcp:` 分类正确

#### Slice J-B: Persist + hydrate

- [x] AC-J7: `StoredToolEvent` 扩展 — `toolUseId`、`status`、`tracing { traceId, spanId, parentSpanId }`、`startTimeMs`、`endTimeMs`；不混用 message-level `extra.tracing`。Producer side：`ToolSpanTracker.getContext(toolUseId)` peek 接口 + `AgentMessage.toolTracing` 富化字段 + `invoke-single-cat` enrich 流程 + `toStoredToolEvent` 复制 5 个新字段。
- [x] AC-J8: hydrate 从 `toolEvents[]` 恢复 `cat_cafe.tool_use ...` real-duration child span（不退化成 `invocation.restored`）。`synthesizeToolSpansFromEvents` 按 `toolUseId` 配对 tool_use/tool_result，用 startTimeMs/endTimeMs 算 duration，按 status 设 OTel span status code。缺字段的事件 honest 跳过（KD-41）。
- [x] AC-J9: provider 支持矩阵附录 — F153 spec 已加表格列每个 provider 的 (start, end, id, status) 四件套支持情况（见 Phase J 章节 "Provider 支持矩阵" 子节）。**Codex / DARE / CatAgent** 四件套就位（AC-J2 wired in PR #774）；**Claude CLI / Gemini CLI / Antigravity / OpenCode** ⏳ deferred（parser 字段未 verify / wire — 见矩阵脚注）；**Kimi** 明确降级（无 `tool_result` 事件）；**A2A** n/a（非 LLM provider）。

## Dependencies

- **Related**: F130（API 日志治理 — 同属可观测性，F130 管 logging，F153 管 metrics/tracing）
- **Related**: F008（Token 预算 + 可观测性 — token 层面的可观测性）
- **Related**: F150（工具使用统计 — 应用层统计看板）

## Risk

| 风险 | 缓解 |
|------|------|
| 社区 PR 有 2 个 P1（counter 泄漏 + 端口硬编码）| ✅ 已修复（4 轮 review 后全部 P1 绿灯）|
| OTel SDK 增加启动依赖和包体积 | Phase A 保持可选（env 开关），不强制 |
| Prometheus 端口与 alpha/runtime 端口冲突 | 必须走 env 配置，不允许硬编码 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 社区 PR 先不放行，P1 修完再 intake | Maine Coon review 发现 counter 泄漏 + 端口硬编码 | 2026-04-09 |
| KD-2 | 分配 F153（cat-cafe F152 = Expedition Memory 已占） | operator确认 | 2026-04-09 |
| KD-3 | AC-A5 改为 graceful degradation（缺 salt → 禁用 OTel，不崩溃）| 生产稳定性优先 | 2026-04-11 |
| KD-4 | Pane registry abort 状态不一致接受为 known limitation，不阻塞 intake | pre-existing 行为，属 F089 terminal 域 | 2026-04-13 |
| KD-5 | 4 轮 review 后放行 intake | 所有 P1 已修，核心 P2 已修，剩余 P2 non-blocking | 2026-04-13 |
| KD-6 | Phase B review: tool_use 改 addEvent + redactor-safe keys | Ragdoll+Maine Coon双猫 review 发现零时长 span 反模式 + 脱敏穿透 | 2026-04-12 |
| KD-7 | Phase B 2 轮 review 后放行 intake | P1（脱敏）+ P2（tool_use + scope）全部修完 | 2026-04-12 |
| KD-8 | clowder-ai#489 双猫重审后放行 merge + absorb | strict/shadow/narrative 三级模型成立；剩余架构偏好降为 non-blocking | 2026-04-15 |
| KD-9 | `TELEMETRY_DEBUG` 走 default-deny + 启动链显式注入 `NODE_ENV` | 只在真实 dev/test 语义下开放 raw exporter，避免 runtime/profile 脱钩 | 2026-04-18 |
| KD-10 | NODE_ENV 由启动模式（PROD_WEB/-Dev）决定，不由 profile 决定 | dev:direct + --profile=opensource 是开发模式，不应标 production | 2026-04-20 |
| KD-11 | Phase E 走方案 B（API 代理 + 自建前端），不引入 Grafana/Tempo/Sentry | 零外部依赖，贴合猫咖数据模型，零额外进程 | 2026-04-21 |
| KD-12 | Trace 存储用 in-process ring buffer，不引入 Tempo | 零额外进程，保留最近 N 小时即够用 | 2026-04-21 |
| KD-13 | LocalTraceExporter 放 redactor 之后，Hub 只看脱敏后数据 | Maine Coon Design Gate：raw span 走 TELEMETRY_DEBUG console，不走 Hub | 2026-04-21 |
| KD-14 | `/api/telemetry/*` 走 session/cookie auth | Maine Coon Design Gate：不复制 `/ready` 公开探针模式 | 2026-04-21 |
| KD-15 | 查询参数先 HMAC 再 match store | Maine Coon Design Gate：不为查询方便存 raw ID | 2026-04-21 |
| KD-16 | F153 = descriptive observability，不做 normative eval | Phase E 只展示"发生了什么"，eval 信号留给未来 phase（eval 讨论 2026-04-19） | 2026-04-21 |
| KD-17 | 补 5 个产品级 instrument（task/session 层），不急于吸收 ActivityEventBus | Phase A 的 5 个是基础设施级；L1-L3 gap 分析显示 task 完成/耗时/轮次信号缺失 | 2026-04-21 |
| KD-18 | Phase F: 否决 SQLite 独立存储 | operator认为单独一份可观测数据冗余 | 2026-04-22 |
| KD-19 | Phase F: 否决完整 span JSON 写入 InvocationRecord | GPT-5.4 + Sonnet review: Redis 内存线性膨胀 + HGETALL 读放大 + TTL 生命周期错位 | 2026-04-22 |
| KD-20 | Phase F: 选定指针关联方案 | operator洞察：消息数据已含 timing/token/tool 信息，只需补 OTel ID 指针（~100 bytes） | 2026-04-22 |
| KD-21 | Phase F 前置：统一 `invocationId`（沿用现有键名，值改为 outer record ID）| GPT-5.4 发现不统一；Maine Coon review 修正：不引入新键名 `recordInvocationId`，否则破坏 redactor Class C + trace query | 2026-04-22 |
| KD-22 | Phase F 纳入 `cat_cafe.route` 根 span | Phase E 实现引入 route 根 span，invocation 已变子 span；hydrate 必须覆盖 route 否则重启后层级断裂 | 2026-04-22 |
| KD-23 | startTime 用 `timestamp - durationMs` 反推 | assistant message timestamp 是终态落盘时间 ≈ span end；Maine Coon review 发现直接当 startTime 会偏移 | 2026-04-22 |
| KD-24 | `extra.tracing` 需要 parser + merge 前置改造 | `updateExtra()` 是整块覆盖，parser 不保留未知字段；Maine Coon review 指出需先 widen type + merge 语义 | 2026-04-22 |
| KD-25 | tool_use spans 暂不持久化（**superseded by KD-39 / Phase J Slice J-B**） | KD-6 原决策为 event；Phase E 升级为 MCP 工具 span 但仍是零时长；当时延后到 Phase H，2026-05-22 promoted to Phase J Slice J-B 直接落地 | 2026-04-22 |
| KD-26 | 社区 F181 提案归入 F153 Phase G | Prompt X-Ray + A2A trace 属可观测性基础设施范畴，不单独立 feature | 2026-05-08 |
| KD-27 | Prompt X-Ray 默认关闭，opt-in via `PROMPT_CAPTURE` env | 捕获内容含完整 prompt 明文，必须显式启用 | 2026-05-08 |
| KD-28 | capturePromptIfEnabled fire-and-forget，不阻塞 invocation hot path | 调试工具不可影响正常调用延迟 | 2026-05-08 |
| KD-29 | setTraceContext best-effort（try/catch + typeof check） | trace context 丢失 = 降级为独立 trace，不影响功能正确性 | 2026-05-08 |
| KD-30 | LocalTraceStore TTL 2h → 24h | 2h 对日常调试过短，24h 覆盖典型工作日；导出常量统一引用 | 2026-05-08 |
| KD-31 | Phase I: 步 = 一次 agent loop（边界锚 = `cat_cafe.agent_loop` stream marker，per-provider stream parser 识别 LLM call 边界并 emit） | 现有 stream 信号都是 invocation 粒度：`done` event 在 CLI 跑完后 yield 一次，`cat_cafe.llm_call` span 也走 done 路径。真正 loop 边界必须在 stream parser 里识别；无法识别的 provider 显示 `—`，不退化 | 2026-05-19 |
| KD-32 | Phase I 仍是 descriptive plane，不计算 efficiency/quality score | 继承 KD-16；步长长可能是认真验证也可能是绕路，单凭计数无法判断质量；eval 信号留给未来 feature | 2026-05-19 |
| KD-33 | Phase I 引入 `cat_cafe.agent_loop` stream marker，由各 provider stream parser 在 LLM call 边界 emit；无法识别的 provider 首版显示 `—`（不退化成 invocation count） | Maine Coon review 二轮：done event / `llm_call` span 都是 invocation 粒度，不是 loop；新 marker 是唯一 provider-agnostic 出口 | 2026-05-19 |
| KD-34 | Phase I metric counter `cat_cafe.a2a.dispatch.count` 仅带 `AGENT_ID`，不带 `invocationId/threadId`，不复用 `CALLBACK_TOOL/REASON` | metric allowlist 禁止高基数；CALLBACK_TOOL/REASON 是 callback auth failure 语义，与 dispatch 无关；如需 dispatch 专属 labels 须先扩 allowlist | 2026-05-19 |
| KD-35 | Phase I `tool_call_count` 走双轨（child `cat_cafe.tool_use *` span + invocation `tool.basic_call_count` attr）；`token_total` 走 `cat_cafe.route` span `ROUTE_TOTAL_TOKENS` attr | basic tools 设计成 attribute 计数，MCP/business 走 child span；token metrics 没 route 维度，route span 已 finally 块设置 `ROUTE_TOTAL_TOKENS` | 2026-05-19 |
| KD-36 | Phase J: tool span correlation 必须基于 native ID（方案 A），拒绝 `Map<toolName>` / 栈模型弱关联 | 两猫共识：Claude/CatAgent 一个 assistant content 可多个 tool_use block；同名工具/result 乱序会让弱关联错配；DARE/Codex/CatAgent 源协议本来就有 call id | 2026-05-22 |
| KD-37 | Phase J: per-invocation `ToolSpanTracker`，`Map<toolUseId, Span>` key = invocation+cat scope | Maine Coon finding：provider raw id 可能跨 invocation 碰撞；scoped key 避免 cross-invocation 串扰 + 内存泄漏 | 2026-05-22 |
| KD-38 | Phase J: `AgentMessage` 扩展 `toolUseId` + `toolResultStatus`，不靠 content 字符串猜 status | gpt52 + Maine Coon 共同发现：当前 `tool_result` 无结构化 status，duration 真实化但 status 仍 unreliable 等于半修 | 2026-05-22 |
| KD-39 | Phase J 同 phase 内做 AC-F8 unblock（持久化 + hydrate），不拆出去 | 两猫共识：防止 Phase F 时"live 真 / restored 假"的 status 漂移重现；Phase J 不标 ✅ 直到两 slice 闭环 | 2026-05-22 |
| KD-40 | Phase J: 移除 `span-helpers.ts` 本地 `isMcpTool`，统一走 `tool-usage/classify.ts` | Maine Coon独有 finding：本地 `isMcpTool` 当前识别 `cat_cafe_` / `mcp__` / `signal_`，**漏 Codex `mcp:` 前缀**，导致 Codex MCP tool 误判 basic；`tool-usage/classify.ts` 已正确处理 `mcp:` 格式 | 2026-05-22 |
| KD-41 | Phase J: provider 支持矩阵必须文档化，不允许"至少 X 其他 fallback"模糊口径 | gpt52 finding：模糊 AC 容易把 Phase J 做成局部真实；每个 provider 必须明确列 start/end/id/status 四件套支持，不支持的明确降级（不开 span 或标 fallback） | 2026-05-22 |
| KD-42 | Prompt X-Ray 不能把 `params.systemPrompt` 等同于真实系统提示词 | F203 将 L0 identity 移到 native system channel；runtime 证明确实会 capture user/effective prompt，但 `System` tab 可为空，F153 Phase G 需要补 native channel coverage 或 UI 明示 partial | 2026-05-26 |
| KD-43 | Phase J Slice J-B: `StoredToolEvent` 持久化 native `toolName` 数据字段，与 UI `label` 解耦；hydrate 优先用 `toolName`，label 解析仅为 legacy fallback | Maine Coon R5→R6 把"non-blocking P3 / track separately"升级为 P1：`label` 是 UI 显示文本（含 catId 前缀 + arrow + 可能本地化），把它当作 hydrate data contract 会让 label 格式或文案改动 silently degrade trace 到 `unknown` 或错的工具名。修在 J-B PR #825 内完成（3 个新 regression test 覆盖：toolName preferred / legacy label fallback / malformed last-resort） | 2026-06-02 |
| KD-44 | Phase G AC-G10 (KD-42 closure): `PromptCapture` 持久化 `nativeSystemPrompt` data field 直接拿 `compileL0ViaSubprocess` 编译后 L0，Hub UI System tab 分区显示 Native L0 / message-system pack，token 估算分桶（msg / native L0 / total）。Capture 走 fire-and-forget async runner，L0 fetch 失败只写 `captureDiagnostics`，不阻塞 invocation hot path。`l0-compiler.ts` 加 in-flight Promise dedup + generation guard，capture + native injection 并发冷启动只发一次 subprocess，且 `clearL0Cache()` 后旧 in-flight compile 不得回写 stale L0 到 cache | Maine Coon Design Gate（2026-06-03）四立场全部 actionable：(1) 不要重复编译 → 加 in-flight dedup + capture 异步取 + fail-safe diagnostic；(2) 保留 `systemPrompt` 不 rename → 加 `nativeSystemPrompt` 双字段，避免 UI 误读 non-native provider 的 system；(3) 单 System tab 分区，Native L0 上方 + pack appendix 下方，修正 resume banner 误导（injected=false 只代表 message-system path 不影响 native L0）；(4) 保留 `tokenEstimate = effectivePrompt`，新增 `nativeSystemTokenEstimate` + `totalTokenEstimate` Hub 顶部显示 total / Meta 拆开；R1 P1 follow-up（2026-06-08）补 generation guard + clear-during-inflight regression | 2026-06-09 |
