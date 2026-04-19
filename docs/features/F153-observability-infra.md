---
feature_ids: [F153]
related_features: [F130, F008, F150]
topics: [observability, telemetry, metrics, health-check, infrastructure]
doc_kind: spec
created: 2026-04-09
community_issue: "zts212653/clowder-ai#388"
---

# F153: Observability Infrastructure — 运行时可观测基础设施

> **Status**: in-progress | **Owner**: Community + Ragdoll | **Priority**: P2

## Why

Cat Cafe 当前缺乏系统性运行时可观测能力：异常难定位、超时难检测、猫猫是否在工作没有可靠信号。F130 解决了日志落盘，但 metrics/tracing/health 这一层还是空白。社区贡献者提交了 clowder-ai#393 实现 Phase 1 基础设施。

team experience（2026-04-09）："这是可观测性基础设施 PR，核心是在 packages/api 里接入 OTel SDK，补 telemetry redaction、metrics allowlist、Prometheus/OTLP、/ready 健康检查，以及 cli-spawn 参数脱敏。"

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

### Phase E: 后续增强

- Grafana 统一看板
- burn-rate 告警规则
- MCP call spans + tool execution duration spans（真实执行边界）
- 更广的 runtime exporter 级 tracing tests（in-memory exporter 验证父子关系）

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

### Phase D（Runtime 调试 exporter + 启动语义对齐）✅
- [x] AC-D1: `TELEMETRY_DEBUG` 通过 `ConsoleSpanExporter` 输出 spans，且 regular OTLP pipeline 仍保持 redaction
- [x] AC-D2: `shouldEnableDebugMode()` 采用 default-deny guardrail；`NODE_ENV` 未设置时默认阻止
- [x] AC-D3: `TELEMETRY_DEBUG` / `TELEMETRY_DEBUG_FORCE` 在 Hub 中隐藏且不可 runtime 编辑
- [x] AC-D4: Unix `start-dev.sh` 按 API 启动模式注入 `NODE_ENV`
- [x] AC-D5: Windows `start-windows.ps1` 通过 API Start-Job 注入同样的 `NODE_ENV` 语义
- [x] AC-D6: `telemetry-debug.test.js` + `start-dev-profile-isolation.test.mjs` + `start-dev-script.test.js` 覆盖 guardrail 与启动链回归

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
| KD-2 | 分配 F153（cat-cafe F152 = Expedition Memory 已占） | team lead确认 | 2026-04-09 |
| KD-3 | AC-A5 改为 graceful degradation（缺 salt → 禁用 OTel，不崩溃）| 生产稳定性优先 | 2026-04-11 |
| KD-4 | Pane registry abort 状态不一致接受为 known limitation，不阻塞 intake | pre-existing 行为，属 F089 terminal 域 | 2026-04-13 |
| KD-5 | 4 轮 review 后放行 intake | 所有 P1 已修，核心 P2 已修，剩余 P2 non-blocking | 2026-04-13 |
| KD-6 | Phase B review: tool_use 改 addEvent + redactor-safe keys | Ragdoll+Maine Coon双猫 review 发现零时长 span 反模式 + 脱敏穿透 | 2026-04-12 |
| KD-7 | Phase B 2 轮 review 后放行 intake | P1（脱敏）+ P2（tool_use + scope）全部修完 | 2026-04-12 |
| KD-8 | clowder-ai#489 双猫重审后放行 merge + absorb | strict/shadow/narrative 三级模型成立；剩余架构偏好降为 non-blocking | 2026-04-15 |
| KD-9 | `TELEMETRY_DEBUG` 走 default-deny + 启动链显式注入 `NODE_ENV` | 只在真实 dev/test 语义下开放 raw exporter，避免 runtime/profile 脱钩 | 2026-04-18 |
