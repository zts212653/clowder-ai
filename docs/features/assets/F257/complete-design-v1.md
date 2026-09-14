---
feature: F257
title: F257 Harness Ledger — 完整方案 v1（从 operator 模型往下推；proposal，待逐节确认）
status: CONFIRMED（operator 2026-09-02 07:37）— 实施以本文 §14/§15 为准；把关人 Fable，实现 sol（不满意可换 kimi/ds）
depends_on: terminal-contract-v1.md（TC-1~20）
author: 宪宪(cat-8zfu14fb) 2026-09-02
---

> operator 2026-09-02："方案我现在怀疑你们都没怎么想清楚……想把方案完整搞清楚了再去改。"
> **定位（operator 07:17）**：这套是基于规则段做 auto-harness 基建的**穿刺**。规则段只是第一种 Unit；设计必须保持 Unit/Objective 通用，跑通并按谱系管理后，其它组件与已有评估域（eval:a2a 等）都纳入同一体系。
> 本文只做一件事：把 terminal-contract 的条款展开成**能直接照着实现、也能直接照着验收**的完整方案，并把现有组件逐个定性为 **删 / 降级 / 保留**。每节末尾的 ☐ 由 operator 勾选；有一节不对就改这一节，不重来。

## 1. 一个周期的完整走查（用 D1 / identity-truth 的真实数字）

| 步 | 发生什么 | 谁 | 数据 |
|---|---|---|---|
| 1 | tracing 持续入池。D1 属于 Objective `identity-truth`，该 Objective 的当前周期起点 = 上次评估周期终点 = **2026-08-24 15:54** | 系统（路由终态缝） | 线性池；无分组 |
| 2 | 每条 trace 落盘后 + 每小时兜底，checker 按 CycleRecord 的**当前有效策略**算三路水位：owner 线性池周期内累计 **1436/N**、周期内高置信反例 **0/M**、距周期起点 **9 天/D**——**任一路满足即触发**；N/D 由上轮结论按 TC-3 确定性调整，M 本轮固定为 3 | 系统 | 只读池 |
| 3 | 满足即**开启本周期评估**：写一条周期记录 `{objective, version:v1, cycleStart:08-24 15:54, cycleEnd:now, evalStatus:requested}`；**不复制任何 trace** | 系统 | 一条小记录（<1 KB） |
| 4 | 向**该 Objective 专属的系统评估 thread**（每个 Objective 一个，如 `thread_eval_f257_identity-truth`；系统按需 ensure）投一条 assignment：**评估目标（Objective statement，和现有其它 eval 域一样先声明目标）**、版本、时间窗、指标列表（每个指标的评估方式/规则）、**周期内反例清单（高置信度，先读）**、以及"按窗读池"的工具说明。**评估猫不指定**：由该 thread 的默认成员执行；不合理时 operator 在 thread 侧改成员 | 系统 | 消息 ≤ 32 KB（反例给引用不给正文；正文按需用工具读） |
| 5 | 评估猫按窗读 owner 全量池（高置信反例优先，其余按需翻，`observed/absent/disabled` 只作为 episode 属性），对每个指标给结论，**调工具回写**：`submit_cycle_evaluation{objective, cycleId, metrics:[{id, conclusion, evidenceRefs}], counterexampleRootCauses:{eventCount,rootCauseCount}, overall}` → 周期记录 `evalStatus:written` | 评估猫 | 回写即真相 |
| 6 | 回写成功 → **系统自动**向同一 thread 再投一条 governance assignment：附上第 5 步结论 **+ 该 Objective 历史周期的结论与决策摘要（governance 要看历史，eval 不看）**，要求三选一 **keep / rollback / evolve** + 理由 → 评估猫回写 `submit_cycle_governance{decision, reason, v2Draft?}` | 系统 → 评估猫 | 同一 thread，同一猫 |
| 7a | decision = keep → 代码按 TC-3 上调 N（满足连续 cadence-only keep 条件时也上调 D），把 before/after/依据写入 CycleRecord；周期收束，**下一周期起点 = 本周期终点**；回到步 1 | 系统 | — |
| 7b | decision = rollback / evolve → 代码按 TC-3 下调 N/D 并生成**提案卡**：动作列表可对该 Objective 的成员 hook 做 enable/disable/modify(content + condition params)/add，整卡只能全批或 reject；卡按 §5.1 展示指标、变化、结论、逐动作 diff；按钮三选一：**approve / skip（可附理由）/ reject（必须附理由）** | 系统 → operator | 卡 |
| 8 | **approve** → 执行（rollback = 把 current version 指针切回上一版，没有别的动作；evolve = 激活 v2 草案）→ 进入下一周期。**skip**（评估可能有偏但暂无纠正办法 / 数据不够）→ 不执行，进入下一周期，理由存档供下次参考。**reject** → 不进入下一周期：拒绝理由作为约束追加进 assignment，**对同一窗口重新评估**（见 §1.1）。**周期起点始终刷新** = 本周期终点（否则累计触发会立即再触发）；skip 的影响不在起点，而在下次评估的取数范围（见 §1.1） | operator → 系统 | override 版本链 |
| 9 | v2 周期与 v1 完全同流程；**评估目标绑定 v2，本周期触发与 UI 统计只看 v2 原生时间窗，不做跨版本对比**；若 v2 来自手动切版，切换前尚未消费的 v3 数据可按 §1.2 作为来源明确的补充证据读取，但不冒充 v2 数据；**governance 阶段以本周期结论为依据判断 keep/rollback/evolve**——同一 Objective 始终在同一系统 thread，历史周期的评估结论天然在上下文里、高相关，可参考，但"与上一版比较"**不是**闭环条件 | — | — |

### 1.1 skip 的取数规则（operator 06:32 修正，替代原"跳过不改起点"）

- 周期**始终**按 `新起点 = 本周期终点` 刷新，不因 skip 停住。
- 评估拉数据时**逆序回看**前序周期状态：若前一个周期是 skip（含 insufficient_evidence），把它的时间窗一并纳入；连续 k 个 skip → 本次评估窗口 = 本周期 + 前 k 个 skip 周期（如连续 3 次 skip，第 4 次综合前 3 个周期的 tracing）。遇到第一个非 skip 周期即停止回看。
- assignment 因此携带 `windows:[{start,end}...]`（≥1 段）与各 skip 周期存档的理由。
- reject 重评估：同一 `windows`，assignment 追加 `rejectReasons:[...]`，评估后**必须重新产生一张新的提案卡**；因此终态只有 approve / skip 两种，不设计数上限（operator 06:42）。
- 活性检测（TC-16）：状态处于 governance、预期有提案卡、该 Objective thread 无成员在运行且无挂起外部条件、却没有卡 → 系统发一条提醒消息要求产卡；按天节流，避免环境异常时刷屏。

未回写分支（步 5 或 6 超过 T=30 分钟没有回写）：系统投**一条**"你还没回写"的系统 message 重触发；再超过 T 仍无 → 周期记录 `evalStatus:stalled` + 告警到本 thread，**不再重试**，等人处理。

☑ 走查正确（07:37）

### 1.2 手动切换当前版本（operator 2026-09-07）

- 入口在生命线中**已选历史版本**的版本内容区，按钮「切换为当前版本」。它不是编辑内容，也不创建版本；确认文案只说「切换后，将以该版本开启新周期并继续评估。」
- 只允许 `evalStatus=idle`。按钮显示状态只是第一层，服务端在同一 Objective 串行锁内重新读取 current CycleRecord；`requested / retriggered / written / stalled` 一律 409，防止切版覆盖正在进行的评估或治理。
- 直接创建内容版本也必须经过同一周期边界：新版本成为 active 时同步归档旧 tracing 周期并建立绑定新版本的新周期，不能保留一条会让 active 指针与 CycleRecord 版本漂移的旁路。旧式 `POST /api/prompt-hooks/:hookId/override {action:'rollback'}` 与独立「回滚至基线」按钮退出公开入口；回到 v1 统一选择 v1 版本卡上的「切换为当前版本」。
- 切换时以同一个逻辑 `switchAt` 收束两条轴：① override active 指针切到目标历史版本；② 当前 tracing 周期写 `termination:{kind:'manual-version-switch', fromVersion, toVersion, at, by, reason}` 并 append-only 归档；③ 建立 `cycleStart=switchAt`、新 Objective version snapshot 的 idle 周期。override 的审计事件按实际写入时间记录，允许比逻辑切换坐标晚数毫秒。CycleRecord 归档与 current 替换使用 Redis CAS；active 指针写入失败或 CAS 竞争失败时执行补偿，不能留下「版本已换、周期未换」的稳定状态。
- 新周期的**原生窗**从 `switchAt` 开始：Console 周期计数、明细和 N/M/D 触发都只读原生窗。被终止周期尚未进入 evaluation 的数据不丢，作为带 `manual-version-switch` provenance 的补充窗随新周期保存；只有新周期原生窗触发后，它才进入 assignment 的可读证据范围。
- evaluator 判断的目标仍是新 active 版本，不做「v2 比 v3 好多少」的跨版本对比；补充窗中的 episode 保留其真实 v3 / source cycle 来源。governance 再结合同一 Objective thread 的历史结论决定 keep / rollback / evolve。
- 版本号全局单调、父链按创建时 active 版本：v3 后切回 v2，再演进产生 v4 且 `parentVersion=2`。被终止的 v3 周期在 governance 面显示停止/切换事实；正常 governance 动作显示精确边「演进 S13：v2 → v3」。
- 正式 template Hook 的编辑走同一周期边界：弹窗默认 active 版本，可下拉选择历史版本作为编辑基底；「产生并应用新版本」一步创建全局单调的新版本并直接激活。active=v2、base=v1 时得到 v4(parent=v1)，activation 只记 v2→v4，不伪造 v1 激活；旧周期写「当前版本 v2 → v4（基于 v1）」。M1/M2/N2 等补充投影只展示格式说明/示例，不进入评估与回放。

## 2. 状态：每个 Objective 只有一条"当前周期记录"

```
CycleRecord {
  objectiveId, version,                 // version = override 版本链当前激活版本
  cycleStart, cycleEnd?,                // cycleEnd 在触发时写；周期收束后作为下一周期的 cycleStart
  evalStatus: idle|requested|retriggered|written|stalled,
  evaluation?: { metrics:[{id,conclusion,evidenceRefs}], overall, writtenAt, by },
  governance?: { decision: keep|rollback|evolve, reason, writtenAt },
  approval?:   { cardId, state: pending|approved|skipped|rejected, reason?, rejectCount, at },
  triggerPolicy, triggerPolicyChange?,   // 当前有效 N/M/D + 本轮确定性调整审计
  objectiveLifecycle,                   // active|dormant|retired；零 trace 是故障，不是 dormant
  versionContentRef,                    // 起始版本的内容指针 = overlay 版本（天然存在，不复制内容）
  windows,                              // 本次评估实际取数窗口（含回看的 skip 周期）
  carryoverWindows?,                    // 手动切版遗留的未消费补充证据；不参与新周期触发统计
  termination?: { kind:'manual-version-switch', segmentId, fromVersion, toVersion, at, by, reason },
  closedAt?
}
```
- 历史周期 append-only 存档（生命线按 version+cycle 展示）。
- **删除**：snapshot 内嵌 corpus、pending/claim/commit 三段 Lua、Unit job、**cursor receipt / evidence digest（tracing 不可变且只增，不需要防漂移回执——operator 06:32）**、drain fence、sweep 状态机（见 §6）。
- 保留：tracing 池、反例标记、override 版本链、Console 路由。

☑ 状态足够且不多余（operator 07:17："粗略看没啥问题"）

## 3. 触发检查（checker）

- 触发点：每条 trace 落盘后（已有终态缝回调）+ 每小时 cron 兜底（覆盖"7 天"这一路）。
- 三路 anyOf 口径：`累计 = owner 线性池中 terminalAt ∈ [cycleStart, now) 的全部 episode 数`，不得按段或 `observed/absent` 过滤；`反例 = 同窗内归属该 Objective、且 source∈{structured-rule,mcp-marker} 的 counterexample 去重 incidentKey 数`；`cadence = now − cycleStart ≥ D 且累计 ≥ 1`。
- 幂等/并发：**同一 Objective 严格串行**（`evalStatus ∈ {requested, retriggered}` 时不重复开启；CAS 写周期记录）；**不同 Objective 各自 thread、各自周期，可并发互不冲突**。
- 评估进行中新到的 trace/反例**不丢**：它们落在下一周期（cycleEnd 之后）；新周期可能很快满足数量阈值，但仍需经过从 `cycleStart` 起算的**最短采集评估时间**（默认 2 小时，可按 Objective 配置），避免用过短采集窗口进入评估。
- 三个阈值与最小间隔均为**每 Objective 可配**；registry 提供出厂下限，CycleRecord 保存当前有效策略。N/D 由已完成周期的 decision 确定性调整，M 本轮固定；"200 / 3 / 7 天 / 2 小时"是出厂值，不是每轮重置值。
- **首周期起点**：该 Objective 从未评估过时——池中已有 tracing → 取最早有效 trace 的时间；池中没有（如上游新装）→ 服务启动检查到缺首周期起点时写入当前时间。

☑ 触发口径正确（07:37）

## 4. 评估 assignment 与回写工具

- assignment 固定结构（≤ 32 KB）：`{objective:{id, statement /*评估目标，必填*/}, version, versionContentRef, windows:[{start,end,provenance?}] /*含回看的 skip 周期，以及触发后才附入的手动切版补充证据*/, priorSkipReasons?, rejectReasons?, metrics:[{id,label,evaluator,ruleRef}], counterexamples:[{invocationId, incidentKey, rationale?}] (引用), readPoolTool: "cat_cafe_read_cycle_traces(objective, cursor?)"}`；投递到该 Objective 专属 thread，由默认成员评估。带 provenance 的补充窗必须保留原 source cycle / source segment version，不能被当作 skip 窗，也不能改写成当前版本数据。
- 读池工具按窗分页返回 episode 摘要（段状态、input/output 截断、工具调用首尾），评估猫自行决定翻多少；**不预先分类、不等任何 sweep**。
- 回写工具 `cat_cafe_submit_cycle_evaluation`：一个指标一条结论（结论类型沿用 judgment-schema-v2：count / rate-badness / semantic-label），同时结构化回写高置信反例事件数与语义根因数，整体 overall 三态 complete / partial / insufficient_evidence。
- insufficient_evidence = "数据不够" → 等同 **skip**：进入下一周期，下次评估按 §1.1 回看纳入本窗口。

### 4.1 评估 / 治理工具面（复用优先，不重造）

| 需要 | 复用什么 | 缺什么 |
|---|---|---|
| 评估猫按窗读池 | 现有 `cat_cafe_retrieve_unit_evaluation_traces` 的分页实现（去掉 cursor receipt/digest） | 改为按 `windows[]` 取数 |
| 回写评估结论 | 现有 `cat_cafe_submit_unit_evaluation` 形状（每指标结论 + overall） | 改名/改成 cycle 维度 |
| **单元能改什么（unit action schema）** | Gate 1 registrar 里 `resolveSegmentManifest`（safetyTier / disableable / allowLocalOverride / hasBackup）+ override store 的 versions/current | 打包成一个只读工具 `describe_harness_unit(unitId)` 返回：允许动作 {enable, disable, modify, add}、当前版本、版本链、内容指针——评估猫据此写 v2 草案，不抓瞎 |
| 回写 governance 决策 + v2 草案 | 无 | 新 `cat_cafe_submit_cycle_governance{decision, reason, v2Draft?}`（只产提案，不直接改） |
| **提案卡** | **Eval Hub 现有 verdict 卡**（如 eval:a2a 的"结论 / 现在要做 / 下次看什么 / 指标说明"）+ **F276 审批机制**（approve/reject 带理由） | 加 `skip` 第三动作——**已查实 F276 决策枚举只有 pending/approved/rejected，无原生 skip**；**已定（S3 @ `46d941b7c`）：① 新 durable `HarnessGovernanceProposal`（`HGP-<hash(cycleId, cardOrdinal)>`），Approval Hub 枚举扩为 approved/skipped/rejected，`decisionMode: approve-skip-reject`**（② 弃用）；approve 后调现有 override 路由 enable/disable/activateVersion/setContent |
| 执行动作 | 现有 override HTTP 路由（enable/disable/rollback/versions） | approve 后触发 registry 重扫 + snapshot 刷新（TC-17） |
| `cat_cafe_submit_semantic_sweep` / `publish_verdict` 的 git 发布 | Semantic Sweep 生产路径已移除；历史 annotation 只审计。verdict handoff 形状可复用于卡 | — |

☐ assignment/回写契约正确（评估猫：**不指定，thread 默认成员**——operator 06:09 已决）

## 5. Console

- **Tracing**：唯一 Objective 的周期起点；两组：`周期内高置信反例 n/M`、`owner 线性池周期内累计 m/N`；第三路 `距周期起点 d/D`。显示「最短采集评估时间」，冷却边界固定为 `cycleStart + minimumIntervalMs`；数量阈值已满足但仍在采集期时显示「最早可评估时间」。不再显示等同/近似于本周期起点的「上次周期结束」，新周期 0 条是正常状态，不推断为采集故障。反例与 tracing 明细可回放，但段级查询窗总数不再作为并列触发数字。无"待分类"。
- **Eval**：**平时只显示指标目录**（每指标：名称、id、方向、含义、评估方式/规则——同 Eval Hub eval:a2a 的"指标说明"样式）；**结论只在实际评估发生时刷新**：有则显示最新 verdict 卡（结论 / 现在要做 / 下次看什么 / 证据引用），无则不显示假空态；evalStatus 可见。
- **Governance**：decision + 理由；审批卡状态；版本链 v1→v2…（谁、何时、为何）；每个改变版本的周期显示精确动作边（例如「演进 S13：v2 → v3」），手动终止周期显示「切换 S13：v3 → v2」。

### 5.1 提案卡渲染（operator 07:31：审批时必须看得到内容）

复用 Eval Hub verdict 卡骨架，固定五段：

| 段 | 内容 |
|---|---|
| ① 指标对比图 | 数值与变化**合并在同一张图**：逐指标把上周期与本周期同轴并列并标注 delta，不拆成两段；首轮或无同名指标基线时明确说明"无对比基线"，展示当前值而非画空图 |
| ③ 结论摘要 | 本周期各指标结论、governance 理由、证据引用与历史周期摘要 |
| ④ 动作与逐段差异 | 动作列表逐项渲染：`disable` 左=当前全文、右=不再注入并显示所属 Objective/剩余成员数；`modify` 展示 content/condition params 的 before/after；`add` 左=空、右=新全文并显示 stage/order；长 diff 可展开全文 |
| ⑤ 人工决策 | **approve** 原子接受整张卡全部动作，不可挑批；**skip** 保留当前版本；**reject** 必填理由并对同窗重评、生成新卡 |

渲染要求：diff 用现有 override versions 的 content 做 before，草案做 after；不在卡内复制 tracing 正文，只给引用。

☑ 三面正确（07:37）

## 6. 现有组件处置表

| 组件 | 处置 | 理由 |
|---|---|---|
| `EvaluationSnapshot.traceCorpus`（6 MB/个） | **删** | TC-4 |
| pending / claim / commit Lua、watermark 三件套 | **删**，由 CycleRecord CAS 取代 | 状态过多 |
| UnitSemanticEvaluationCoordinator + JobStore | **降级**为 §4 读池工具的分页实现；不再是门 | — |
| cursor receipt / evidence digest（防源漂移） | **删**——tracing 是我们自管的不可变只增数据，无漂移可防 | operator 06:32 |
| Semantic Sweep（批量打标）+ drain fence + volume-sweep retry | **删除生产路径**；历史 annotation 只保留审计，不参与触发、排序或治理 | TC-13 |
| trigger-now `if (!semantic)` | **删** | TC-3/13 |
| F299 recorder `sourceRefs.max(64)` | 上游止血：assignment 引用 ≤ 64 或聚合为一个 source map | 与本方案无关但必须 |
| 路由/lifeline/evaluation/override 路由 | 保留 | Gate 1 已验 |
| judgment-schema-v2（KD-22） | 保留为结论类型 | — |
| `eval-domain:eval:harness-ledger:evalCat-override` + registry `evalCat` 指定 | **删**（评估猫由每个 Objective thread 的默认成员决定） | operator 06:09 |
| 全域单一 `thread_eval_harness_ledger` | **降级**为 Hub 汇总/告警面；评估本身走每 Objective 一个 thread | operator 06:09 |

☐ 删留表——**operator 不裁决**（"代码不是我写的"）；由实现者自决并对结果负责，以 §8 falsifier 验收

## 7. 迁移现有卡死状态（一次性，operator 批准后执行，不删 tracing）

- 4 个 Objective 的 pending snapshot（6 MB×4）、81 个 open sweep job、drain state（generation 1899）、18 个 unit job：**全部作为派生状态清除**；tracing 池、反例标记、已完成 judgment 不动。
- 清除后 checker 首次运行即按 §1 从各 Objective 现有 cycleStart（= 上次 completed-window-end）重新触发。

☐ 清理方案——**operator 不裁决**；实现者自决，前提：不删 tracing/反例/已完成 judgment，只清派生状态

## 8. 验收（= terminal-contract §4 F-1~8）+ 一次真实周期走通的截图链（步 2→8）

☐ 以此为完成定义

## 9. 待 operator 拍板的开放问题

1. ~~评估猫固定为谁？~~ **已决（06:09）：不指定，每个 Objective 一个系统 thread，由其默认成员评估；不合理在 thread 侧改。**
2. ~~evolve 的 v2 内容由谁写~~ **已决（06:32）：评估猫直接给 v2 草案 → 提案卡 → 人 approve / skip / reject（reject 附理由重评估，不自动进下一周期）。**
3. ~~跳过是否等同驳回但起点不动~~ **已决（06:32，operator 自纠）：起点始终刷新；skip 只影响下次取数——逆序纳入连续 skip 周期。** 见 §1.1
4. ~~是否保留 cursor receipt~~ **已决（06:32）：不要。每周期只记：时间窗、指标、结论、起始版本内容指针。**
5. ~~首周期起点~~ **已决（06:32）：有历史 tracing 用最早有效 trace 时间；没有则服务启动时写当前时间。** 见 §3

## 10. operator 已决记录

| 时间 | 决定 | 落到 |
|---|---|---|
| 09-02 06:09 | 评估 thread 每个 Objective 一个，跨 Objective 可并发，同 Objective 无并发 | §1 步4、§3、§6 |
| 09-02 06:09 | 评估猫不指定，用 thread 默认成员 | §1 步4、§4、§9 Q1 |
| 09-02 06:09 | assignment 除指标外必须声明评估目标（同其它 eval 域） | §1 步4、§4 |
| 09-02 06:09 | 评估不做跨版本对比；governance 以本周期结论判断回退，历史结论作同 thread 上下文可参考 | §1 步9、TC-11 |
| 09-02 06:32 | evolve：评估猫直接给 v2 草案；提案卡三选一 approve/skip/reject；reject 附理由重评估不进下一周期 | §1 步7b/8、§1.1、TC-9 |
| 09-02 06:32 | 周期起点始终刷新；skip 通过逆序回看纳入取数窗口（连续 k 次 skip 合并 k+1 个窗口） | §1.1、§2、§4、TC-10 |
| 09-02 06:32 | 不需要 cursor receipt/digest；周期只记时间窗+指标+结论+起始版本内容指针 | §2、§6、TC-14 |
| 09-02 06:32 | 首周期起点：最早有效 trace，否则服务启动写当前时间 | §3、TC-15 |
| 09-02 06:32 | 目标重申：auto 进化，人只在提案审批处判断；规则段按日常对话自动 sunset/合并/调内容 | §11 |
| 09-02 06:42 | reject → 重评估必产新卡，终态只有 approve/skip；governance 阶段无卡 → 按天提醒 | §1.1、TC-9、TC-16 |
| 09-02 06:42 | 合并/sunset/新增全部是 overlay + 目录扫描的运行时动作，无 base 级层 | §11、§12 |
| 09-02 06:42 | 加载三步（扫描→按版本→构建）为既定方案；L0 编译器是否保留待定 | §12、§13 |
| 09-02 07:17 | 触发是任一满足；阈值与最小评估间隔按 Objective 可配；进行中新增数据落下一周期不丢 | §1 步2、§3、TC-3 |
| 09-02 07:17 | governance 要看历史，eval 不看；rollback 只是切 current version 指针 | §1 步6/8 |
| 09-02 07:17 | 需要单元动作 schema 工具；提案卡复用现有 Eval Hub verdict 卡 + 审批机制 | §4.1 |
| 09-02 07:17 | Eval 面平时只列指标，结论只在实际评估时刷新 | §5 |
| 09-02 07:17 | §2 通过；§4/§6/§7 operator 不裁决，实现者负责 + falsifier 验收 | §2/§4/§6/§7、冻结条件 |
| 09-02 07:17 | 定位：这是基于规则段的 auto-harness 基建**穿刺**；跑通并按谱系管理后，其它组件与既有评估都要纳入同一体系 | §0 |
| 09-02 07:31 | §12 通过；§13 走合一（删独立 L0 编译器，L1–L7 迁为普通段） | §12、§13、§6 |
| 09-02 07:31 | 提案卡必须展示内容变更（逐段 diff）；渲染规格入 §5.1 | §5.1 |
| 09-07 08:17–08:55 | Console 投影最短评估间隔与上次周期结束；手动历史版本切换只在 tracing 可用，切换会终止旧周期并从目标版本开新周期；新周期 UI/触发只计切换后原生窗，未消费旧数据以带版本来源的补充证据供下一次 eval 读取；governance 显示精确版本边 | §1.2、§2–§5、TC-20 |
| 09-08 10:18–11:09 | 去掉重复的「上次周期结束」，冷却语义改为从本周期起点计算的「最短采集评估时间」；新周期零数据不是采集故障；所有正式 template 段允许 operator 版本化编辑，从任意历史版本编辑时直接产生并应用新分支版本；M1/M2/N2 等补充投影只展示格式说明/示例，不出现评估回放入口 | §1.2、§5、TC-18/20 |

## 11. 我自己的判断（不附和）：这个流程能否闭环

主环（采→触发→评估→回写→governance→提案→下一周期）**能闭环**，而且比现有实现简单得多。我认为还有两处不闭，需要你拍板：

**缺口 A（已由 operator 06:42 关闭）**：reject → 重评估 → **必须产新卡** → 终态只能是 approve/skip；活性靠 TC-16 的"governance 阶段无卡"检测 + 按天提醒。我原提的计数上限撤回。

**缺口 B（我判断错了，operator 06:42 纠正）**："合并 A 到 B" = 禁用 A + 修改 B（把 A 的内容补进 B）；"sunset" = 禁用；"新增" = 往 hooks 目录放一个新段，加载时**直接扫描**即可见。全部是运行时 overlay/目录动作，**不存在 base 级 PR 这一层**。前提是加载机制按 §12 三步走；现状差一项：approve 后要触发 registry 重扫（见 §12）。

其余我认为成立的点：v2 差了下一周期 governance 会 rollback（自纠）；连续 skip 合并窗口让"数据不够"自然收敛；不需要 receipt 是对的——我们自管的池只增不改，digest 校验是防外部漂移的多余层。

## 12. 加载机制（operator 早期方案，06:42 重申）与现状对照

```
加载 hooks  → 直接扫描目录加载（满足 新增 / 启禁用）
hooks       → 按版本号加载（满足 overlay / 修改内容）
            → 构建 session / turn 提示词
```

| 步 | 现状 | 结论 |
|---|---|---|
| 扫描加载 | `HookRegistry` 已用 `readdirSync(hooksDir)` 扫 `assets/prompt-hooks/`（46 段目录） | ✓ 已满足 |
| 按版本加载 | `HookOverrideStore` epochVersion + `refreshOverrideSnapshot` | ✓ 已满足 |
| 运行中新增段可见 | registry 在启动时缓存（`PipelinePromptBuilder` 第 64 行），仅有一个重置入口（第 72 行） | ✗ 需补：**evolve 提案 approve 后触发 registry 重扫 + snapshot 刷新**，否则新段要等重启 |
| 构建 session/turn | pipeline 猫走 `PipelinePromptBuilder`；native 猫（Claude×3 carrier、Codex）走**另一条路** `compile-system-prompt-l0.mjs` | ✗ 两条路——**§13 合一即解此行**（operator 06:47 确认同一问题）；合一后提供商差异只剩投递载体（消息前缀 vs 写文件给 `--system-prompt-file`/`developer_instructions`），内容来源唯一 |

☑ §12 对（operator 07:31）

## 13. 系统提示词编译器（L0 compiler）是否合理、是否有必要——我的判断

**功能上必要**：Claude/Codex 这类 native 提供商需要一份系统提示词文件（`--system-prompt-file` / `developer_instructions`），不能靠消息前缀注入 session-init 段。

**作为一条独立编译路径不合理**，且是本线三起事故的共同根源：
- 第二套源：`assets/system-prompts/system-prompt-l0.md` 模板 + `l1-parallel-world.md`… 七个模板文件，与 `assets/prompt-hooks/` 的段目录是**两份真相**——L1–L7 不能 overlay、不能 sunset、不受 §12 的扫描/版本机制管；
- 第二套 ID：L1–L7 vs 段目录 ID（S/D…）→ tracing 段投影混乱（8/19 S-vs-L 事故）；
- 独立 manifest 侧车（同 render pass 产 manifest、stdout 传输）→ 8/25–8/28 的 manifest 拒绝 55 次、stdout 污染、L0 编译错启动失败三起事故。

**提议**：native 提供商的 session-init 提示词 = **同一条 hook pipeline 的 session 阶段输出写入文件**；L1–L7 降为 hooks 目录里的普通段（从此可 overlay、可 sunset、走同一套 tracing）；删除 `compile-system-prompt-l0.mjs` / `l0-compiler.ts` / `native-l0-trace.ts` 及其 manifest 协议。这样 §12 三步对所有提供商只有一条路，tracing 只有一个 ID 空间。

合一后 native 猫与 pipeline 猫的 session-init 段集合完全相同（今天 L1–L7 与 S 系列是两套内容），tracing 段投影随之统一；提供商只保留"写文件投递"这一处差异。

☑ **已决（operator 07:31）：合并成一条路。** 实施含义：删 `compile-system-prompt-l0.mjs` / `l0-compiler.ts` / `native-l0-trace.ts` 与 manifest 协议；L1–L7 迁为 `assets/prompt-hooks/` 普通段；native 提供商由同一 pipeline 的 session 阶段输出写文件投递

## 14. 实施切片（先删后建；**一条分支、每片一个 commit、最后一个 PR → `develop_base`**——operator 07:4x：只能整体做完后体验验收，PR 不要拆碎）

交付形态：
- 从 `develop_base` 切一条 feature 分支；S0…S5 **各一个 commit**（commit message 逐条映射 TC-#），每片完成即 push。
- Fable 在分支上**逐 commit 增量 review**（§15 把关尺），并在**隔离实例**（抛弃式 Redis + 该分支 build，同 Gate 1 做法）跑该片 falsifier；不过则该片返工，不进下一片。
- 全部六片通过 → 开**唯一 PR**（描述汇总 TC-# 映射 + 六片 falsifier 结果）→ 合入 `develop_base` → 运行实例回流 → **Fable 通知 operator "可以重启验收"并等待**（operator 09-02 08:5x："不要自动重启；需要重启验收的时候和我说下，避免突然打断工作"——**猫不得自动重启运行实例，重启只由 operator 择时执行**）→ operator 重启后 Fable 在运行实例跑完整 F-1~8 → operator 体验验收。
- S0 清场脚本随第一个 commit 进分支，但**只在最终合入后、重启前对运行实例执行一次**（先 dry-run 贴 thread）；开发期间只对隔离实例执行。

| 片 | 做什么 | 删什么 | Falsifier |
|---|---|---|---|
| S0 清场 | 一次性脚本（先 dry-run 打印将清 key）清派生状态：4 个 pending snapshot、81 个 sweep job、drain state、18 个 unit job | — | Redis 只剩 tracing 池、反例标记、已完成 judgment、override 版本链 |
| S1 触发 + CycleRecord | `CycleRecord` CAS 存储；checker（每 trace 落盘后 + 每小时）：三路 anyOf、per-Objective 阈值、最小间隔、首周期起点、skip 回看 `windows[]` | snapshot corpus、claim/commit/watermark Lua、`if (!semantic)`、drain fence、volume-sweep retry | F-7 / F-2 / F-4（回看）：阈值满足 → `evalStatus=requested` 且记录 <1 KB；间隔内不重触发 |
| S2 评估投递 + 回写 | per-Objective thread ensure（默认成员=Settings 全局默认猫，可改）；assignment（目标+窗口+指标+反例引用+读池工具，≤32 KB）；`describe_harness_unit`；`submit_cycle_evaluation`；未回写 30 分钟 → 1 次重触发 → `stalled` + 告警 | UnitSemanticEvaluationCoordinator 的门语义、cursor receipt/digest、sweep 主路径 | F-1、F-3 |
| S3 governance + 提案卡 | 回写后自动 governance assignment（含历史摘要）；`submit_cycle_governance{decision,reason,v2Draft?}`；卡（§5.1，approve/skip/reject，F276 扩枚举）；approve 执行 override 路由 + registry 重扫 + snapshot 刷新；TC-16 活性提醒 | — | F-5；reject 后必出新卡 |
| S4 Console | Tracing 两组 + 三路进度 + 周期起点（并入 Fable 的 `fix/f257-tracing-two-groups`——**只 cherry-pick `88cc67154`**，勿 merge 整条分支）；Eval 指标目录 + verdict 卡；Governance 面 | "待分类"、旧三数字 | F-6 |
| S5 单一路径 | native 提供商 session-init 由同一 pipeline 输出写文件投递；L1–L7 迁为 `assets/prompt-hooks/` 普通段 | `compile-system-prompt-l0.mjs`、`l0-compiler.ts`、`native-l0-trace.ts`、manifest 协议 | F-8：native 猫与 pipeline 猫段 ID 一致；L0 启动零报错；tracing 中无 L 系列独立 ID |

顺序 S0→S1→S2→S3→S4→S5；S4 可与 S3 并行。每片 commit 目标 ≤ 600 行，超了拆 commit（不拆 PR）。全部通过后：运行实例一次真实周期走通截图链 = 完成。

## 15. 把关尺（Fable review 时逐条对照；命中任一条 = changes_requested）

1. 新增任何状态机/子状态（除 `CycleRecord.evalStatus` 五态）
2. 保留 sweep 作为任何前置或门；保留/新增 receipt、digest、防漂移校验
3. 复制 tracing 正文到任何派生存储或 assignment
4. 出现"兼容旧派生数据"分支（旧状态在 S0 清掉，不兼容）
5. 新增 fallback 层（同文件 ≥3 层触发 Maine Coon 自检）
6. 新 Lua 脚本不是在替换旧脚本
7. 单文件 >350 行；一片 PR >600 行且未拆
8. 只报测试数、不跑真实实例 falsifier 就宣称完成
9. 任何 TC-# 在 PR 描述里没有映射
10. base 不是 `develop_base` 或未走 PR

---
确认方式：在 thread 回一句"§x 对 / §y 改成…"，或直接改本文件。全部 ☐ 勾完 → 解冻，按 §6 顺序实施：先删后建，不在旧状态机上加固。
