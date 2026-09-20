---
feature_ids: [F257]
topics: [harness, eval, seed-cases]
doc_kind: note
created: 2026-07-06
---

# F257 自举种子案例账本（灵魂条款）

> **operator 定的自举条款**：本分支开发中发生的每次偏差 → 记为本特性 eval 种子案例；验收标准含"能拦截自己开发史上的偏差类型"（AC-E2）。
> **纪律**：谁发现谁记，当天记，不美化。偏差 ≠ 耻辱柱，是免费的 regression fixture。

## Schema

```
SC-{NNN} | 日期 | 发现方式(自查/跨猫/operator/结构) | 偏差类型 | 事实经过 | 期望拦截层 | 回放判据
```

## 案例

### SC-001 | 2026-07-06 | 自查 | spec-fidelity：声明样本与执行样本静默漂移

**事实**：首棒审计计划抽样含 magic word「我能猜出来」（Ragdoll Read-Before-Reason 锅），实际下发给狩猎 agent 的签名清单写成了「碎片够了」——声明与执行分叉，全程无任何结构检测到，作者写 spec 时自查才发现。
**同类前科**：F216 立项 Why 与 AC 落地分叉（LL-069：scope 跟"自我解读"走不跟 spec 走）。
**期望拦截层**：eval:spec-fidelity——对"声明的计划 vs 执行的产物"做结构 diff；样本清单类任务应有 manifest 对照。
**回放判据**：给定"计划清单 + 执行产物"对，域 eval 能标出漂移项（本案例：计划 20 项 vs 执行清单缺「我能猜出来」多「碎片够了」）。

### SC-002 | 2026-07-06 | 自查（对照实测） | provenance：unqualified-count 数字 claim 无口径

**事实**：启动包写"MCP 层 86 工具 43 GOTCHA + 31 强命令 + 8 fail-closed；skill 层 51 个 21 GOTCHA"；实测为"30 tools 含 GOTCHA（43 处）/ ~13 hard-block / 6 fail-closed 字面；48 skill / 9 含 GOTCHA"。OQ-5 回查后确认不是单个数字错，而是四个数字四种口径混排：

| 启动包数字 | 回查口径 | 判定 |
|---|---|---|
| 86 工具 | `tools/*.ts` 下唯一工具名全集 | 干净数字，但与"含 GOTCHA 的 30 工具"维度不同 |
| 43 GOTCHA | `grep -rn GOTCHA | wc -l` 出现次数 | 干净数字，与实测一致 |
| 31 强命令 | 过滤器含 `'\|\"`，实际匹配任何含引号的行 | 脏数字，语义审查口径应以 ~13 为准 |
| 8 fail-closed | `HELD|acknowledgeHeld` 关键词出现次数，且集中在 1 文件 | 高估，实测 6 处字面为准 |
| 51 skill | `ls | wc -l` 目录条目数，含 BOOTSTRAP.md/refs 等非 skill | 高估，实测 48 为准 |

根因定性：`unqualified-count`——数字进入决策文档时未携带 `how_counted`（命令/口径/时间戳），下游不可复算、不可比较。
**同类前科**：#1080（A2A claim 无 provenance anchor）、F218（外部 claim 引用前先判信源）。
**期望拦截层**：Harness Ledger 本体（inventory extractor 生成单一真相源，数字可 re-derive）+ doc lint（任何审计数字/registry summary 数字缺 `how_counted` → 红）+ 接球侧 receive-handoff-grounding 反射扩展到数字 claim。
**回放判据**：给定"含未溯源数字的启动包"，拦截机制要求 claim 附 derivation（命令/文件锚点/时间戳）或标注 unverified；给定缺 `how_counted` 的 registry summary，CI lint 失败。

### SC-003 | 2026-07-07 | co-creator 继续触发 | spec-drift：thread 决策未及时写回唯一真相源

**事实**：2026-07-06 三猫 Design Gate 已在 thread 中收敛：砍 `probation`、修正 #1075 依赖、引入 `observabilityDeadline` / `nextRequiredAction`、定义 O2 hybrid / eval:sop 边界。但 2026-07-07 co-creator 说"继续"时，分支 spec 仍停留在首棒 commit，保留旧 schema（`active|probation|dormant|retired`）、旧 #1075 blocker 和未闭合 OQ。真实状态存在于消息流，不在 feature doc。
**同类前科**：家规"消息不是真相源"；F216/LL-069（scope 跟自我解读走不跟 spec 走）；#1080（A2A claim 无 durable anchor）。
**期望拦截层**：Design Gate closure lint——进入下一 Phase 前，Feature spec 必须反映已收敛的 OQ/KD/Risk；禁止出现已退回字段（如 `probation`）和已证伪 blocker（如 #1075 作为 Phase B 硬依赖）。
**回放判据**：给定"thread Decision Packet + stale feature spec"，lint 能标出：OQ 状态仍未闭合、旧 blocker 字符串仍存在、Design Gate 决策未落到 Key Decisions；修复后 lint 绿。

### SC-004 | 2026-07-07 | co-creator 连续两次质疑 | value-chain gap：链路环节缺失但按既有 Phase 惯性推进

**事实**：启动包链路是 信号→归因→**修补**→验证→淘汰 五环，但 spec 把修补环压缩进 eval verdict 一个词，Phase A 排成"130 口全量 registry 导入"的账本工程。co-creator 连问两次「你们这些改动对我们之前遇到的问题有什么帮助/改了好像也没有用」才暴露：按原顺序做完 A-E，operator 的真实痛点（opus 高成本犯错、锅补了没用、skill 越多越无效）一个都不会好转。猫的第一反应是解释机制（体检报告类比）而不是核对价值链完整性——第二次质疑后才对照启动包发现环缺失。
**同类前科**：LL-067（review finding 不是工单，先追问用户价值）；F216/LL-069（scope 跟自我解读走不跟 spec 走）；#1018（规则丰富但不在关键路径上）。
**期望拦截层**：kickoff/Design Gate 的 Vision Guardian 反射——对照启动包逐环节 trace"该环在哪个 Phase 由什么承载"，缺环 → 红；AC↔Why 同源自检扩展为 AC↔链路环节全覆盖检查；operator 质疑 ≥2 次同一方向 = 强制停下做 gap 对照（而非继续解释）。
**回放判据**：给定"N 环链路启动包 + Phase 拆分草稿"，检查器能标出无 Phase 承载的环（本案例：修补环）；给定连续两条同方向 operator 质疑消息，猫的下一动作是事实对照而非机制辩护。

### SC-005 | 2026-07-08 | co-creator 第三/四轮质疑 | capability-inventory gap：设计修复方案前未盘点既有基建

**事实**：Phase A-①（skill 零加载修复）设计时隐含假设"skill 加载无埋点，验证要靠 transcripts 离线挖"。co-creator 追问改动范围与既有 eval 改动的关系后，三路代码盘点发现：`SkillLoadEventLog` 已存在（route-serial.ts:1500 检测真实 Skill tool_use，F188 AS-4）且已有消费者（eval:capability-wakeup 域）；eval 控制面 8 域全套机制在跑。真实 gap 是版本绑定/留存/资产维度三个缺口，不是"从零建 tracing"。同时"双实锤各修各的"因缺全局能力地图被 operator 正确地读成 hotfix——两个实锤实际共享同一个信号层地基。
**同类前科**：「我能猜出来」家族病的体系级变体（用审计结论跳过基建盘点）；SC-002（数字无口径 → 本例是方案无复用面清单）；LL-067（先追问价值/事实再动手）。
**期望拦截层**：Design Gate 增加**复用面盘点强制环节**——新建任何 store / eval 域 / 采集管道前，spec 必须附"既有同类能力清单 + 逐个不复用理由"；缺清单 → gate 红。
**回放判据**：给定"新建 GuardRejectionEventLog 的 Phase 草稿（无复用面清单）"，检查器能要求列出既有 event log（F254/F237/SkillLoad/ToolEvent）及逐个不复用理由；给定"operator 连续质疑改动范围/复用边界"，猫的下一动作是代码盘点而非重述方案。

### SC-006 | 2026-07-09 | operator 人肉发现 ×2 + codex 补充 | O1 缺位：关键状态变化无结构通知（同日三样本聚合）

**事实**（三个同日独立样本，同一失效形状）：
1. **thread 软删无感知**：F257 工作 thread 7/7 被软删（同名误删），三猫在"已删除"thread 里连续工作 2 天零感知（消息层不受软删影响），直到 operator 问"为什么列表看不到"才发现。已修复（restore + 改名防复发），根因与改进项见 issue #1131。
2. **托管命令死亡球悬空**：PR3 merge-gate 的 `pnpm gate` 托管进程死亡且完成唤醒丢失，持球 invocation 未被唤醒，push+开 PR 悬空 20+ 分钟，直到 operator 问"怎么停了"才被主线补位接管。
3. **gate-guard 拦截无落盘**（codex 补充）：gate-guard 预检拦截陈旧隔离 Redis（6138/6778）事件无结构化落盘——拦截发生过但无账可查。
**同类前科**：公理 A2（建了≠用了）；gap-analysis G3（4xx 零落盘）；本案与 SC-003 的元关系——本条目自身差点复发 SC-003（案例在 thread 消息里宣称"已记入素材"但未落盘，被 operator 抓包后才写入本文件）。
**期望拦截层**：**基础功能自诊断 unit**（段试验品之后的第二个 harness unit，operator 已预定方向）。判定规则候选：① thread registry 状态 vs 消息层活跃度对账（deleted 但 7d 内有 A2A 活动 → 告警）；② 托管命令终态必达（进程终止必须产生 wake 或 dead-letter 记录，不允许静默消失）；③ guard 拦截事件落盘（GuardRejectionEventLog 扩面天然覆盖）。
**回放判据**：给定"托管命令进程被 kill"，系统产生 dead-letter 通知而非静默；给定"活跃 A2A thread 被软删"，参与猫收到结构通知或删除被要求二次确认；给定"gate-guard 拦截"，事件可按窗口查询。

<!-- 新案例追加在此行上方 -->
