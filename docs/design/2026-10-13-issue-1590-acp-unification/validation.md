---
feature_ids: [F143, F161]
topics: [acp, acceptance, differential-testing, rollback]
doc_kind: plan
created: 2026-10-13
---

# 验证计划与迁移门禁

本节定义完整实现的执行合同。后续修复/原型的实际阶段证据见[执行回执](execution-evidence.md)和[原型Go/No-Go](prototype-gates.md)，G0–G5仍未完成整体运行验收。测试覆盖、固定raw fixture与真人环境证据分层报告，不互相代替。

## 证据层

| 层 | 能证明什么 | 不能证明什么 |
|---|---|---|
| L0 源码/纯 parser characterization | 字段、分支、接口及确证漏接 | 真实模型/安装/身份/恢复成功 |
| L1 协议 fake backend/故障注入 | 两端 mapping、状态机、race、超时/幂等与拒绝 | 实际供应商版本接受了这些方法 |
| L2 固定版本真实 bridge + native runtime | wire、实际执行物、原生回执、成功失败工具、静止/恢复 | 用户 UI 和历史已消费、所有环境都可用 |
| L3 真实产品实例与浏览器差分旅程 | 平台调用→bridge→模型→工具→持久/UI/重放 | 未覆盖 provider/version/OS 的支持承诺 |

真实场景使用授权账号和独立工作目录，开发 Redis 6398 或专属隔离实例、API 3102/Web 5102 或无冲突 offset；禁止用生产 3003/3004 和 6399 冒充本 worktree 的验收。避免输出凭证和完整 HOME 内容。

## 差分方法

1. 冻结 binary/bridge/schema/SDK hash、依赖 lock、成员/账号引用、执行节点、HOME/profile、cwd、模型/强度/MCP/政策/L0、既有 baseline capability。
2. 每条场景先原生后 ACP，使用独立会话、相同测试任务和同版本后端，不双发同一个有副作用的 invocation。
3. 使用临时文件/只读工具/有界写入工具制造确定性结果。模型回答文字可以不同，比较结果内容、原生 ID/作用域、权限、终态和可见因果，不能要求 LLM 输出逐字一致。
4. 同时记录 native event → ACP wire → AgentMessage/semantic event → 原始引用/持久轨迹 → live UI → refresh/replay 的映射；一个层缺失就不通过。
5. 把标准/扩展、可用条件、unknown 与证据级别写回逐 binding 结果表。修复后更新 hash 并重跑受影响场景。

record 模板：`caseId, bindingFingerprint, baselineHead, targetHead, native/bridge/schema versions, requested/effective config, result, evidenceLevel, sanitized wireRef, nativeReceiptRef, persistedRef, UIRef, observedAt`。不将 native ID/session token 的公开性混淆；对外报告脱敏，内部 evidence 保存访问控制。

## 场景矩阵

| Case | 操作与反例 | 必须观察到的结果 |
|---|---|---|
| V01 执行环境 | 同 client 双安装/双 HOME/双账号；选择非 PATH 首项；缺 bridge | 实际执行与选择一致；missing/unknown 不记 ready；secret 不进 UI |
| V02 配置 | 改模型/强度/速度；invalid 值；served 未报；native reroute | 有效配置 readback；无静默默认；requested/effective/served 分开 |
| V03 基本会话 | 两轮文本/思考；partial/终态；网络断流/拒绝 | 完整输出且一个正确终态；既有错误分类/diagnostic 保留 |
| V04 内容类型 | 迁移前支持的图片/音频/resource；工具 image/diff；超长输出 | 类型/内容/引用保持；unsupported 明确阻断；裁剪有标记与原文 ref |
| V05 工具结果 | 同 ID 成功/失败/denied；最终 input 晚到；刷新历史 | 输入/输出/ID/状态 live 与持久/重放一致；没有空“完成了”代替结果 |
| V06 执行范围 | 并行两工具、child/main 重复 ID、两 session 相同 ID、late patch | 按 binding/turn/scope 配对；child 不写主执行；重复终态幂等 |
| V07 恢复 | 停 bridge 后新进程 load/resume；load replay；不存在 ID；恢复空流 | 原生 context 真延续；平台历史不重复；失败可见且新建不冒充恢复 |
| V08 取消 | 工具/模型运行中取消；pending permission 取消；bridge 无响应 | cancelled 回执、工具/子进程静止；未证静止 quarantine；无迟到副作用 |
| V09 身份 | 故意冲突 user/工具文本；恢复/压缩后继续；两成员不同 L0 | 原生 trusted instruction 应用来源/hash、角色优先级；身份未串 |
| V10 MCP/skills | 内置+外部 MCP、requiredTools、项目切换、credential 轮换、hooks | 真调用成功；scope 白名单正确；旧 credential 不复用；hook 可触发 |
| V11 权限 | policy allow/reject、需要审批、缺 handler、异常/超时；越界 path | 每次有合法政策/真人来源和匹配回执；无默认允许；fs/terminal 同政策 |
| V12 真人问答 | 真实问题/表单/URL、拒绝、取消、迟到、重复请求/回答 | 既有 UI 可操作；一次合法回答；超时/crash 后不再接受；无凭证泄漏 |
| V13 遥测 | 累计与 delta 混合、重复 snapshot、非 USD、缺 used/size | 不双算；unknown 不显示假准确，不启用未证自动阈值 |
| V14 压缩 | idle compact、自动压缩、失败、中途退出、summary replay | 原生 observation 与 epoch/身份一致；历史不被清空；非文本猜测 |
| V15 子 agent | child success/fail/cancel 与主 turn 多结果 | 正确父子/执行身份/状态；主 invocation 终态不被 child result 提前结清 |
| V16 Codex 精确输入 | A turn 正在结束时送 expected A；B 已开始；同 operation 重试 | 原生 fence 拒绝 stale A；不影响 B，不自动新 turn；回真实 native ID |
| V17 Claude notice | 工具间边界送 notice、输入 UUID echo、多个 result、普通 steer | 非打断模式原周期不断；queued result 关联；preempt 单独声明 |
| V18 原生控制 | goal CRUD/status/inventory、structured review、fork、错误重试 | 和现有 port 同类型/状态/UI因果；非 slash 文本冒充；fork 不二次创建 |
| V19 Realtime | 启用已支持 companion、错 thread/consumer、关闭/掉线 | 只允许 opt-in 既定 consumer、exact binding、text/v2；无额外采集 |
| V20 callbacks | bridge 内 HookCallback 与 host callback timeout/取消 | 原生 hook 实触发；policy/identity/freshness/compaction 不丢；无任意代码 |
| V21 并发/crash | 双账号双 cwd、single-flight queue、配置热更、bridge/host kill | 不串 env/session；旧池 idle retire；accepted operation 有可读终态 |
| V22 UI/持久一致 | socket 重连/刷新/历史加载、重复 raw event、未知 notification | live/replay 同语义；原文 ref 可核；未知事件不变成功/不丢关键终态 |
| V23 平台协作 | 用户首句、@两猫、跨猫交接、共享记忆、审批与 freshness | 真实执行兑现现有产品旅程；不是脚本 demo；availability 与运行一致 |
| V24 北向/barrier | native verdict前提前prompt、压缩先到、settle重复；bg UUID轮换、PTY transcript/drain、API-key/OAuth与canary fallback；capacity模型窗 | 首prompt严格在verdict→drain→一次settle之后；chain key不因UUID变化失忆，PTY因果完整，认证/计费不变，无重复副作用；window投影与used可信度分开 |

V09 同时需要原生配置 readback 与行为反例。单纯问模型“你是谁”不能证明指令优先级；V08 的本地停止显示也不能证明上游静止。

R3 的 V11 策略分支包括两种transport与真实factory：已有政策allow_once/allow_always/reject、需真人审批、无handler、handler抛错/超时、取消、非法/缺optionId、重复请求/回答、跨binding以及bridge未实际采用native权限配置。自动允许必须有政策来源；没有合法reject选项时按标准cancelled收敛，不能构造allow_once ID。沿native config→bridge→dispatcher→既有审批→wire回执→持久/UI核对，证据只覆盖当前绑定。

V24 的 barrier 独立集成单元定义为 [V24-C](continuity-integration.md)，不增删27项能力/24条主场景；按子例分别验收。单元/fake通过只计L1，真实恢复/压缩/crash/首prompt因果与新进程后的持久/UI必须分别补L2/L3。

## 可执行检查入口

这些脚本/测试名已在 `3add05c16` 仓库核实。新扩展测试在 W2–W5 添加；只有新测试实际落盘后才能列为已执行。

```powershell
# worktree 根目录；依赖安装不带生产配置，明确保留 devDependencies
$env:NODE_ENV = $null
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/api build
pnpm --dir packages/api test:claude-sdk
pnpm --dir packages/api test:runtime-interaction
pnpm lint
pnpm check
```

API 的脚本通过既有 with-test-home 隔离 HOME，避免裸跑带真实账号的测试。命令来源为根/`packages/api/package.json`；`pnpm check` 包含多项 contract/feature/build 检查，不能当作只有 Biome。

精确 parser/ACP 回归（API build 后，Git Bash 在 worktree 根执行）：

```bash
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh \
  node --import ./packages/api/test/helpers/setup-cat-registry.js --test \
  packages/api/test/claude-ndjson-parser.test.js \
  packages/api/test/acp/acp-client.test.js \
  packages/api/test/acp/acp-event-transformer.test.js \
  packages/api/test/acp/acp-resume-retry.test.js \
  packages/api/test/acp/acp-service-factory.test.js \
  packages/api/test/acp/acp-process-pool.test.js \
  packages/api/test/acp/acp-credential-scoping.test.js
```

Web 定向检查（根目录）：

```powershell
pnpm --dir packages/web exec node scripts/run-with-node-env-test.mjs pnpm exec vitest run src/hooks/__tests__/bubble-event-adapter.test.ts src/stores/__tests__/bubble-replay-harness.test.ts src/stores/__tests__/bubble-reducer.test.ts
pnpm --filter @cat-cafe/web build
```

format 只处理本次源码：`pnpm biome format --write <实际变更源码文件>`；不得为本任务全仓 check:fix。新增逻辑先观察有意义的 RED，再实现 GREEN；已有 fixture/定向 checker 能准确证明失败则直接消费。

合入前按影响范围跑共享构建/类型/全量受影响测试和独立审查；只有跨包合流/共享契约风险无法由 targeted 覆盖时扩大 gate。本轮普通方案文档采用链接/版本/需求覆盖检查，不把代码 full gate 当正文事实验证。

## 性能与可靠性

冻结 native 和 ACP 对照配置，每 carrier 至少 20 次 warm turn、5 次 cold init、5 次跨进程恢复，包含一个并发场景。测 bridge 开销与供应商网络延迟分开；N 小时注明探索证据，不能宣称统计 SLO 已达成。

建议首轮性能门槛（在 G0 冻结，属于方案建议而非已经测得的承诺）：ACP 相对 native 的 warm TTFT p95 增量不超过 `max(500ms, 20% native p95)`；cold init 和恢复 p95 增量不超过 `max(2s, 20% native p95)`；取消静止 deadline 初值 5s。超门槛进行桥优化或携测量结果调整，不能默认为通过。

关键正确性门槛固定：零观测到的跨账号/跨 session 误配、重复副作用、静默丢结果、假恢复、未授权允许；全部 required 场景通过。记录失效样本率、retry、live process/RSS、lease queue wait、warm hit rate；继承 F149 现有指标而不另建运营 store。

## G0–G5 迁移门禁

| Gate | 放行要求 | 尚未通过时 |
|---|---|---|
| G0 基线冻结 | 本成员 B/R/E 全集、版本/环境、现有能力测试、性能预算与原生 fixture | 原路径；不改默认 |
| G1 确证漏接闭环 | Claude tool_result 的 ID/成功失败/child/持久/UI；#1519 intake 状态和回归明确 | 不把修复归 ACP 重构完成 |
| G2 协商/身份/安全 | 标准/扩展双端合同、真实指令、MCP、政策/交互、绑定隔离、取消/恢复 | 只在隔离 fixture/spike 中使用 |
| G3 原生增强 | exact turn、非打断 notice、typed controls、hooks、continuity、已启用实验能力 | 涉及该能力的成员不得迁移 |
| G4 差分真验收 | 对本成员所有 required cases 达到 L2/L3、性能预算、独立审查 | opt-in 验证态；如实显示未验项 |
| G5 默认切换/退役 | 逐 binding 新 invocation 切换、旧 session兼容/回滚演练、真实产品验收与明确迁移决定 | 保留旧服务；整体统一未完成 |

用户本轮接受统一方案方向，不等于已经批准生产部署、退役旧 carrier 或任何功能降级。正式默认迁移仍需具体可审查实现、证据与部署范围。

### 逐 Gate 独立审查

| Gate | 本 Gate 非作者审查必须检查 |
|---|---|
| G0 | B/R/E和版本/环境基线完整、性能/维护预算冻结，未通过删能力改变分母 |
| G1 | tool_result修复的print/SDK/child/历史/UI证据，#1519 intake版本与回归；不外推完整ACP |
| G2 | W2.S两transport默认拒绝与W3.P完整factory/政策/交互接线，真实身份/MCP/取消/恢复 |
| G3 | W4.P/W5.P分别Go、完整原生增强、该carrier V24-C子集回执、补丁维护量尺与升级演练 |
| G4 | required全矩阵L2/L3、V24-C合流、实际UI/历史/性能，无unknown充当passed |
| G5 | 本次exact实现/配置与部署范围、session兼容、active执行不热切、回滚演练和退役条件 |

每次回执包含 `gateId, binding/scope, author, independentReviewer, exactTargetHead, bridge/native/schema/patch versions, evidenceRefs, blockers, verdict, invalidationConditions`；reviewer必须不同于作者，跨家族优先。可复用同一非作者reviewer，但需要每个Gate独立判定，不复制上一Gate的批准。

各Gate只在自身证据与未结blocker均满足时passed；文档review不是任一运行Gate回执。source/bridge/native/config/policy或相关源码变化后，重新审核受影响Gate；适用的既有未变证据可明确复用，不能无理由重审所有阶段，也不能不检查变化就继承绿灯。

W4.P/W5.P作为增强实现前的独立Go/No-Go点，任一No-Go/unknown暂停整体迁移并重新评估，而不是等待G4才发现核心语义无法保持。只有二者Go仍不足以批准G3–G5。

## 回滚与旧 session

按 invocation admission 冻结 carrier，active invocation 不热切、不重发；发现回归先停止该 binding 新 ACP admission，已开始的任务正常收敛或按取消合同停止。新 invocation 可回到旧服务，告知实际路线。

若 ACP 桥与旧服务能证明同 native session 格式/ID/执行环境且验证读写兼容，才复用原 ID；否则建立显式新 session/replacement provenance，旧历史只读保留。旧原生服务不得盲读 ACP opaque ID。

切回后原始结果/审批/轨迹继续从同一 canonical store 读取，不能删除数据“清状态”。回滚包含 crash/取消/pending 交互对账、旧 credential 退休和 UI 历史可读；通过回滚并不代表 ACP 对照验收通过。
