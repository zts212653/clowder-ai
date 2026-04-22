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

### Phase E: Hub 内嵌观测台（clowder-ai#544）

方案 B：API 代理 + 自建轻量前端，零外部依赖（不引入 Grafana/Tempo/Sentry）。

**安全约束（Design Gate 缅因猫 review 2026-04-21）：**
- LocalTraceExporter 必须放在 RedactingSpanProcessor **之后**（redacted fan-out），Hub 只看脱敏后数据
- Exporter 投影为 redacted DTO 再入 store，不存 SDK span 对象；维护者看 raw 走 TELEMETRY_DEBUG console 通道
- 按 raw ID 查询时，先 HMAC 查询参数再 match store，不存 raw ID
- 所有 `/api/telemetry/*` 端点走 Hub session/cookie 鉴权（session-auth.ts），不走 `/ready` 公开模式
- Ring buffer 双阈值淘汰（maxSpans + maxAgeMs），内存 only，首版不上 SQLite
- Metrics 直读进程内 Prometheus registry，不 self-fetch localhost:9464

**设计边界：F153 = descriptive observability plane, not normative eval system。**
Phase E 只回答"发生了什么"（traces、metrics、健康状态），不做质量判断或打分。记忆命中率、A2A 接力成功率等 eval 色彩的指标留给未来 phase——API/schema 预留扩展点但首版不实现。UI 命名为「观测台 / Observability」，不叫「Eval Dashboard」。

**L1: 数据层（API 侧）**
1. `LocalTraceExporter` — 自定义 SpanExporter，在 RedactingSpanProcessor 之后消费 redacted spans → 投影为 DTO → 内存 ring buffer（双阈值：maxSpans + maxAgeMs）
2. `/api/telemetry/metrics` — 直读进程内 Prometheus registry（PrometheusSerializer），返回 `text/plain` Prometheus 格式（需 session auth）
3. `/api/telemetry/traces` — 查询 LocalTraceStore，筛选条件：traceId 原样匹配、invocationId 先 HMAC 再匹配（AC-E4）、catId 走 Class D passthrough 直接匹配（需 session auth）
4. `/api/telemetry/health` — 聚合 /ready + liveness + 最近错误率（需 session auth，不暴露原始错误细节）
5. **时序快照 ring buffer**（`MetricsSnapshotStore`）
   - `setInterval`（默认 30s）调用 `PrometheusExporter.collect()` → 序列化为快照 DTO → 写入内存 ring buffer
   - 快照 DTO：`{ timestamp, metrics: Record<string, number> }`，只保留 gauge/counter 的当前值（非全量 Prometheus 文本）
   - 双阈值淘汰：maxSnapshots（默认 720 = 6h@30s）+ maxAgeMs（默认 6h）
   - 新增 API：`GET /api/telemetry/metrics/history?since=<epochMs>&limit=<n>` — 返回时序快照数组（需 session auth）
   - 前端趋势折线图的数据源；不替代 `/api/telemetry/metrics`（后者仍返回实时 Prometheus text）
6. **产品级 OTel instruments**（Phase A 的 5 个是基础设施级；这 5 个面向 task/session 产品层）
   - `cat_cafe.task.completed` Counter — 按 agent.id + status(ok/error) 计数任务完成
   - `cat_cafe.task.duration` Histogram — 从 thread 创建到 invocation 结束的秒数（thread 级耗时）
   - `cat_cafe.session.rounds` Histogram — 累计 session 轮数，每轮上报当前值
   - `cat_cafe.cat.invocation.count` Counter — 按 agent.id + trigger(default/mention/routing) 计数调用
   - `cat_cafe.cat.response.duration` Histogram — 单次 invocation 端到端响应耗时（秒）
   - 记录点：`invoke-single-cat.ts` finally block（task.completed/task.duration/cat.response.duration）、invocationId 创建后（cat.invocation.count）、session messageCount 递增时（session.rounds）
   - `trigger` 属性加入 MetricAttributeAllowlist（D2 enforcement）

**L2: 前端展示（`packages/web`）**

7. **Hub「观测台」Tab**（路由 `/hub/observability`）
   - 入口：Hub 左侧导航栏新增「观测台」图标，排在「设置」之前
   - **总览面板**（默认视图）
     - 指标卡片行：活跃 invocations、近 1h task 完成数（ok/error）、平均响应耗时、session 平均轮数
     - 趋势折线图：从 `/api/telemetry/metrics/history` 拉时序快照，展示 invocation.duration p50/p95、task.completed rate、token.usage rate
     - 猫猫选择器：按 agent.id 筛选，切换后所有卡片和图表联动
   - **Trace 浏览器**（子 Tab）
     - 表格：spanName / catId / duration / status / timestamp，支持 traceId/catId 搜索
     - 数据源：`GET /api/telemetry/traces`
     - 点击行展开 → Span 瀑布图（见 item 8）
   - **Health 面板**（子 Tab）
     - 数据源：`GET /api/telemetry/health`
     - 展示 uptime、OTel 状态、trace store 容量/最旧 span 时间
   - 数据刷新：30s 轮询（与快照采样对齐），Tab 不可见时暂停

8. **Span 瀑布图组件**（`SpanWaterfall`）
   - 输入：同 traceId 的 spans 数组（从 `/api/telemetry/traces?traceId=xxx` 获取）
   - 渲染：按 parentSpanId 构建树，水平时间条嵌套，宽度 = duration 占 trace 总时长比例
   - 每条 span bar 显示：name、duration、status badge（ok/error）
   - 点击 bar 展开属性面板：redacted attributes + events 列表
   - 空 trace 或单 span → 简化卡片视图，不画瀑布

9. **轻量图表库**
   - 选型：不引入 Chart.js / D3 等重型库；用 SVG + CSS 手写或引入 `uPlot`（~35KB gzip，零依赖）
   - 组件：`TrendLine`（时序折线）、`DurationDistribution`（延迟分布直方图）、`SparkCard`（迷你折线 + 当前值）
   - 所有图表接受 `{ timestamp, value }[]` 数组，不耦合 API 响应格式

**L3: 告警**

10. **burn-rate 阈值检查**
    - API 侧 `setInterval`（默认 60s）读取进程内 metrics：error rate、p95 latency、active invocations
    - 阈值配置：`TELEMETRY_ALERT_ERROR_RATE`（默认 0.3 = 30%）、`TELEMETRY_ALERT_P95_LATENCY_S`（默认 120）、`TELEMETRY_ALERT_ACTIVE_INVOCATIONS`（默认 50）
    - 超标时通过 SSE/WebSocket 推送 `system_notice` 事件 → 前端 SystemNoticeBar 弹出 notice（复用 F508 层）
    - notice 内容：哪个指标超标、当前值、阈值，不含 raw trace 数据
    - 连续 N 次（默认 3）超标才触发（防抖），恢复后自动消除
    - 首版不持久化告警历史，内存 only

### Phase F: 后续增强（视 Phase E 落地情况决定）

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

### Phase E（Hub 内嵌观测台）— clowder-ai#544
- [ ] AC-E1: LocalTraceExporter 在 RedactingSpanProcessor **之后** 消费 spans，投影为 redacted DTO 写入内存 ring buffer
- [ ] AC-E2: Ring buffer 双阈值淘汰（maxSpans + maxAgeMs），不存 SDK span 对象，不存 raw ID
- [ ] AC-E3: `/api/telemetry/metrics` 直读进程内 Prometheus registry，返回 `text/plain` Prometheus 格式
- [ ] AC-E4: `/api/telemetry/traces` 筛选：traceId 原样匹配，invocationId 先 HMAC 再匹配 store，catId 走 Class D passthrough 直接匹配
- [ ] AC-E5: 所有 `/api/telemetry/*` 端点走 session/cookie auth，无 session 返回 401
- [ ] AC-E6: `MetricsSnapshotStore` 每 30s 采样，双阈值淘汰，`/api/telemetry/metrics/history` 返回时序数组
- [ ] AC-E7: Hub「观测台」Tab 总览面板：指标卡片 + 趋势折线图 + 猫猫选择器联动筛选
- [ ] AC-E8: Trace 浏览器：表格展示 + traceId/catId 搜索 + 点击展开瀑布图
- [ ] AC-E9: `SpanWaterfall` 组件按 parentSpanId 构建树，水平时间条嵌套渲染，支持属性展开
- [ ] AC-E10: Health 面板展示 uptime、OTel 状态、trace store 容量
- [ ] AC-E11: burn-rate 阈值检查（error rate / p95 latency / active invocations），连续 3 次超标触发 SystemNoticeBar
- [ ] AC-E12: 告警通过 SSE/WebSocket 推送，恢复后自动消除
- [ ] AC-E13: 零额外进程 — 所有逻辑在现有 API + Web 进程内运行
- [ ] AC-E14: 5 个产品级 instruments 定义在 `instruments.ts`，受 MetricAttributeAllowlist Views 管控
- [ ] AC-E15: `cat_cafe.task.completed` 在 invocation finally 块中按 status(ok/error) 计数
- [ ] AC-E16: `cat_cafe.task.duration` 使用 thread.createdAt → invocation end 计算秒数
- [ ] AC-E17: `cat_cafe.session.rounds` 每轮上报累计 messageCount
- [ ] AC-E18: `cat_cafe.cat.invocation.count` 按 trigger(default/mention/routing) 区分调用来源
- [ ] AC-E19: `trigger` 属性在 metric-allowlist.ts 中注册，D2 enforcement 正常工作

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
| KD-10 | NODE_ENV 由启动模式（PROD_WEB/-Dev）决定，不由 profile 决定 | dev:direct + --profile=opensource 是开发模式，不应标 production | 2026-04-20 |
| KD-11 | Phase E 走方案 B（API 代理 + 自建前端），不引入 Grafana/Tempo/Sentry | 零外部依赖，贴合猫咖数据模型，零额外进程 | 2026-04-21 |
| KD-12 | Trace 存储用 in-process ring buffer，不引入 Tempo | 零额外进程，保留最近 N 小时即够用 | 2026-04-21 |
| KD-13 | LocalTraceExporter 放 redactor 之后，Hub 只看脱敏后数据 | 缅因猫 Design Gate：raw span 走 TELEMETRY_DEBUG console，不走 Hub | 2026-04-21 |
| KD-14 | `/api/telemetry/*` 走 session/cookie auth | 缅因猫 Design Gate：不复制 `/ready` 公开探针模式 | 2026-04-21 |
| KD-15 | 查询参数先 HMAC 再 match store | 缅因猫 Design Gate：不为查询方便存 raw ID | 2026-04-21 |
| KD-16 | F153 = descriptive observability，不做 normative eval | Phase E 只展示"发生了什么"，eval 信号留给未来 phase（eval 讨论 2026-04-19） | 2026-04-21 |
| KD-17 | 补 5 个产品级 instrument（task/session 层），不急于吸收 ActivityEventBus | Phase A 的 5 个是基础设施级；L1-L3 gap 分析显示 task 完成/耗时/轮次信号缺失 | 2026-04-21 |
