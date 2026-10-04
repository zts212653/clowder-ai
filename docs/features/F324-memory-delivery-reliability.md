---
feature_ids: [F324]
related_features: [F038, F148, F167, F188, F203, F209, F227, F231, F236, F237, F254, F260, F263, F276, F286, F287, F296, F316, F321, F323]
topics: [memory, context, retrieval, delivery, reliability, command]
doc_kind: spec
created: 2026-09-27
description: "让猫以可控的上下文成本取得可信、完整可续读的记忆，减少旧消息回放、检索绕路与启动时的重复负担。"
description_source: human
description_author: codex-astra
description_updated_at: 2026-09-27T12:29:12Z
tips_exempt: "Remediates existing memory delivery and startup behavior; introduces no new user action or discoverable capability."
---

# F324: Memory Delivery Reliability｜记忆交付可靠性与上下文成本收口

> **Status**: in-progress（A/B 原 Task 已 satisfied；C 实收与仓内防复发已合入并完成 Alpha 切片，共享文件恢复待权限裁定，D 未启动） | **Owner**: Astra（@codex-astra, gpt-6-astra）与 Opus55（@opus55, claude-opus-5-5），本指挥 thread 全体猫共同负责驱动与愿景守护 | **Priority**: P1

## Why

You 要猫拿到当前任务需要的可靠记忆，不要反复读取旧正文、被巨大工具返回挤满上下文，
或为了弄懂工具边界不断试错；同时明确要求按第一性原理审查，避免制造冲突规则和过度归一。

operator 授权：`[thread-id]#private-source-id`，同意两猫收敛后立项、
建立 Phase 执行 thread 和 runtime 重启后验收 Phase；当时执行猫为 Sol6、Sol5.6、Kimi，指挥为 Astra 与 Opus55。
09-30 operator 在 `private-source-id` 引用批注改派 C 给 Sol6.1，review 可选 Sonnet/Sol5.6；本次选 Sol5.6。
Opus55 审阅：`private-source-id`；Astra 边界核验：`private-source-id`。

**本 feature 不拥有合同文本。** 它只拥有问题清单、Phase 分工、依赖、跨载体交付证据与愿景验收。
修复必须回到下表的原合同和代码 owner；若原合同有缺口，由该 owner 修订原文，F324 只链接。
不新增中央记忆库、曝光账本、通用游标服务、审批流或上下文轮次去重状态机。

## Current State / 现状基线

本轮源码基线 `00cca7ddf62fe64a070224042c4259d72c81cdf1`；运行态测量不以该 SHA 冒充部署证明。

**2026-09-28 交付更新**：A 已随 [#4858](https://github.com/zts212653/clowder-ai/pull/4858) 合入
`77376ea15c53b8d1818ac6504008bb4365d1c08b`，AC-A1–A4 由非作者审查并经本 owner 核验证据，原 Task 已 satisfied。
`A delivery=PASS`；`registered development return=NOT ESTABLISHED`。本次通过原终态精读恢复，

**2026-09-28 B 交付更新**：B 已随 [#4875](https://github.com/zts212653/clowder-ai/pull/4875) 合入
`17561ae8ad94fa74bef2c551528692b1e6302ccc`，AC-B1–B3 由非作者 Sol6 对 exact HEAD 审查通过。
实体残余词、MCP self-only 权限说明与 F287 晚结算/瞬时读取失败均完成 RED→GREEN；未延长 TTL、未新增 receipt store、
未放宽 peer raw-session 权限。Alpha 在同一合入 SHA 启动，API ready、前端与 32 条最高风险回归通过；日常 runtime
以下保留 09-27 修复前基线：

- F278 登记集完整遍历 130 页：9,367 次信号、6,480 条源消息；440 条明确点名主要记忆读写工具，
  来自 400 条源消息、160 个 thread、10 个猫身份。报告不是独立故障；登记始于 07-20，补扫 lagging。
- 09-27 live `search_evidence`：`query="Sol 命名", scope=threads, mode=hybrid, limit=3, include_expansion=false`，
  返回 1,078,035 字符，其中 2,456 项实体命中及 why/provenance 占 1,073,114 字符。
  F263 AC-A5 已完成的红测覆盖 coverage；本次是 topk 实体附录未被覆盖的缺口，不立第二份预算合同。
- 当时源码内存路由复现：5 条未读、limit=2，2/2/1 三次均报 hasMore=false；第四次回放最后两条历史。
- 隔离探针：1,000 条 invocation 事件输出 319,922 字符，每条静默截到 300 字符；单行 250,000 字符
  穿透 file-slice 行数限制；EventMemoryStore 不传 limit 返回全部 250 条合成事件。
- 上级 `relay-station/CLAUDE.md` 实查 9,598 字节、六个未展开占位符及旧 merge 路由。其他启动负担
  仍为 Opus55 单载体报告，不能外推成三载体实收事实。
- `31e77d20ae` / #4836 已修 stale managed-hold guidance 阻断全文读取；仅列入 D 的版本生效复验，
  不重复实现，也不把 main 合入当作当前 runtime 已生效。

## Canonical ownership / 原合同入口

| 问题 | 真相源（不在本文件复制合同） |
|---|---|
| 搜索预算、continuation、scope、deadline | [F263](F263-memory-lifecycle-repair-and-metrics.md#acceptance-criteria)，F209 / F260 的检索与实体读侧 |
| 协作工具 anchor/full 与精确 drill | [F236](F236-anchor-first-context-entry.md)；其他 reader 继续由其原 owner 持有 |
| 未读、曝光、已处理、队列恢复 | [F254](F254-side-effect-freshness-gate.md)，其 F117 / F264 / F167 既有边界 |
| Event Memory、跨仓来源与图谱 | [F227](F227-event-memory.md)、[F188](F188-library-stewardship.md)、F209 |
| 人物写入来源和预算 | [F276](F276-people-relationship-memory.md)；执行前核对具体原条目 |
| cue 读取与消费回执 | [F287](F287-memory-cue-plane.md)、[F296](F296-continuity-aware-context-injection.md) |
| 工具注册与暴露 | F286 / `mcp-surface-governance`，`packages/mcp-server/src/server-toolsets.ts` |
| 启动规则、profile、skill 发现 | [F203](F203-native-system-prompt-l0.md)、[F231](F231-user-profile-capsule.md)、[F038](F038-skills-discovery.md)、[F237](F237-prompt-injection-visibility.md) |
| 内容覆盖与效用 / 人类可见记忆产品 | [F316](F316-memory-coverage-recall-truth.md) / [F321](F321-memory-sky-experience-loop.md)，F324 不接管 |
| 部署与重启等待 | [F323](F323-runtime-restart-coordination.md) 与既有 runtime owner；不由 F324 新建停启机制 |

Architecture cell: `memory`, `routing-context`, `mcp-surface-governance`, `ball-custody`

Map delta: none

Why: 本次是既有 owner 的修复编排与验收，不迁移写入权或另建运行时状态。各执行切片若触及 consumer / authority，
仍按 F303 在原合同提交具体 evidence；此处的 none 不替实现切片豁免审查。

## What

### Phase A: 读取真实、有界

Sol6 执行。先修百万字符搜索附录，再修未读/分页、重复队列正文及 session/file/event 等已证实无界出口。
先由源 reader 完成有界投影与真实续读，再保证曝光记录只覆盖实际交付正文；公共注册出口仅作最后防线。
不能在已记 seen 后丢正文，不能把已完成写入改报失败，也不能凭空制造 continuation。
已有的人物每轮预算、会议分页、历史注入预算保持原 owner，禁止统一重写。

### Phase B: 来源可达、契约可用、消费可结算

Sol5.6 执行。修复已有 evidence 的相关性/实体噪声、跨仓下钻、接口说明与真实校验偏差，核验搜索 deadline。
cue 过期结算回 F287 原合同。该 Phase 不开发 F316/F321 的新语义召回或产品面。
先核当前状态，历史已修项进入回归集；跨猫 403 等合法边界只改善说明和已授权的替代取证路径。
A 完成并回流本指挥 thread 后才提议启动 B，诊断与实现均不提前开始。

### Phase C: 启动负担

Sol6.1（@codex61-sol）执行、Sol5.6 独立审查，Sonnet 可备选；B 已完成并回流，原 C Task 已续接。分别测量 Claude、Codex、Gemini 的真实启动输入与已加载工具/skill，不把可发现目录当已注入正文。
保留身份、安全、私人连续性；重复家规回指 canonical。先出来源清单、精确清理 diff、跨项目影响与回滚依据。
repo 外父目录文件与全局配置按其实际权限边界处理；本次立项不默许跨项目变更或 runtime 重启。
能力不足的载体标 unknown，不以猜测补绿；不与 A 共用新抽象。

### Phase D: 重启后的组合验收与愿景回流

独立验收 thread，待 C 完成时按实际作者分配非作者：Sol5.6 可验 A/C，Sol6.1 可验 B；若某切片参与实现，另选非作者。
C 完成并回流后才提议启动 D，包括样本准备和 Alpha 旅程；真实 runtime 结论必须等目标版本经授权生效且有加载证明。
覆盖冷启动、热续、压缩恢复、长回合、精确原文与跨仓读取，比较总返回字符/估算 token、往返、重复正文和正确性。
真实重复若仍存在，回原 owner 定位，不预设新 epoch 去重机制。最终证据回本 thread，由两指挥猫独立观察并守护愿景。

## User Journey

### Primary Journey: 猫拿到够用且可信的记忆

- **Scope unit**: 一次当前任务的检索、下钻、使用与恢复全过程。
- **Actor**: You 与当前执行猫。
- **Entry**: You 提出需要旧证据的任务，或当前任务收到新消息。
- **Flow**: 猫定位来源 → 阅读有界正文并按需续读 → 依据证据完成工作 → 长回合或恢复后仍能接上原任务。
- **Success evidence**: 同题前后工具返回测量、源消息可达性、实际任务结果、跨载体真实载荷与 D 的独立报告。
- **Non-goals**: 不删长期记忆省预算，不放宽私人会话权限，不重做记忆产品 UI，不替 F316 宣称内容全覆盖。

## 需求点 Checklist

| ID | 原需求 | 验收 |
|---|---|---|
| R1 | 盘点各记忆入口，减少上下文浪费 | A1–A4 / D1–D2 |
| R2 | 结合猫猫原报与启动实际体验 | B1–B3 / C1–C2 |
| R3 | 不制造冲突规则、不过度归一 | A4 / C2 / D3 |
| R4 | 指挥、Phase 执行、重启后验收分开 | D1–D3 / Review Gate |

## Acceptance Criteria

### Phase A（引用原合同的修复验收）
- [x] AC-A1: 真实 Sol 命名查询及巨量 entityMatches fixture 遵守原 owner 声明的整包预算，保留精确来源与真实续读。
- [x] AC-A2: 5 条未读 / limit=2、空未读、并发新消息、队列已读未处理、超大正文均有可信 RED→GREEN；曝光不越过实际返回。
- [x] AC-A3: session/list/file/event 的无界及静默截断边界完成修复或已有有效保护的明确 disposition，原文仍可授权读回。
- [x] AC-A4: 最终出口负例守卫覆盖附录和附加提示，保护成功副作用回执/多模态/曝光事实，不生第二套 cursor 或 memory store。

A 验收引用 `local-review:private-source-id:approved` 与 #4858 合入 continuity；
搜索源锚点可达，派生附录明确不可分页的 disposition 由 F263 AC-A5 owner 在 `e876e17fa3` 确认，未伪造续读。

### Phase B（引用原合同的修复验收）
- [x] AC-B1: 跨仓来源、不同 reader 的 typed facts、空结果/降级/权限的已知报告逐项核当前真相并可复核结案。
- [x] AC-B2: 实体消歧、搜索 deadline/取消与 schema/说明偏差有真实或确定性回放证据，合法权限边界保持。
- [x] AC-B3: F287 的成功 drill 后晚结算、源更新/删除、权限变化与恢复路径按原 owner 修订合同验证，无 TTL 粗暴延长。

B 验收引用 `local-review:private-source-id:approved` 与 #4875 合入证据；
Alpha `alpha/main-sync` 精确加载 `17561ae8ad94fa74bef2c551528692b1e6302ccc`，`/api/ready`、3011 前端及
实体/F287 最高风险切片 32/32 通过。日常 runtime 仍 dormant，本结论不冒充 D 的 runtime-loaded 或组合旅程验收。

### Phase C（启动证据）
- [x] AC-C1: 三载体分别记录实际实收来源、版本、大小与已加载能力，明确可发现/已加载及 unknown。
- [ ] AC-C2: 已授权清理完成并证明身份/关键能力/其他项目无回归；需要 operator 的变更提供精确 diff，未授权项不假称已完成。

C1 与 hook 清理引用 启动证据 (internal)、PR #4943 / `fa57426575b2135484b17e8fe66af61969383d83` 及 Sol5.6 exact-HEAD typed approval。
Alpha 曾重生成共享 Gemini/AGY 配置；startup+GET 防复发随 #4946 / `68acf34b57a22103ad5318ff28686936ae676212` 合入，经 Sol5.6 审查及同版 scoped hash/300项回归验证。既有共享文件恢复仍待 operator，C2 暂不打勾，D 未启动；health running-revision attestation=null/unknown 如实保留。

### Phase D（真实交付）
- [ ] AC-D1: A/B/C 的合入 revision、Alpha 证据、日常 runtime 加载证明分开记录，重启授权可回查。
- [ ] AC-D2: 非作者完成冷/热/恢复/长回合的组合旅程，预算与重复降低且证据可达性、正确性不退化；#4836 在目标版本复验。
- [ ] AC-D3: 本 thread 两指挥猫完成愿景守护，全部原诉求有交付或明确 operator 签字 disposition；close 仍按既有权限门。

## Dependencies

- **Related**: 原合同表；F316/F321 保留独立目标与 authority。
- **Blocked by**: D 的 live 结论等待目标版本经授权激活；不把 F323 尚未实现的新能力设为所有修复的前置。
- 按 operator 最新指示严格 A → B → C → D 串行；前一 Phase 完成并回流后才提下一张执行 thread 卡，D 的 live 验收另需版本就绪。

## Review Gate

指挥 thread：`[thread-id]`。Astra 与 Opus55 共同负责驱动、范围、整合和最终愿景守护，
不把子 thread 的代码 review 收回指挥部。执行猫在独立 worktree 自行选择非作者 reviewer，按风险完成修复、门禁和合入。
日常推进由 Astra 承接；当前 C 执行 Sol6.1，所有代码 review（含复审/补审）由 Sol5.6 承担、Sonnet 可备选。
按 operator 最新分工不再给 Kimi、旧 Sol6、Opus/Fable 新派执行或审查；历史作者/reviewer 与原合同 owner 记录保留，最终愿景守护职责不变。
子 thread 使用 final-only；真正越出职责的取舍才上报。每个 approved child 由原 Task owner 接好 durable development return。
后续提案前按 F310 来源裁定 `private-source-id` 核实 exact Task/人类授权关系，
批准后立即登记；A 的人工恢复不作为以后省略登记的惯例，不补造 A 的历史关系。

立项内容 review：Opus55 `private-source-id` 逐条核源码后放行；确认 F263 AC-A5
覆盖缺口、撤回注册出口统一改报错的原提议，认可 #4836 转 D 复验。F263 依赖需回原 owner thread 通知。

## Key Decisions

| ID | 决定 | 来源 |
|---|---|---|
| KD-1 | 薄指挥 feature 不持合同文本；各 owner 保持单一真相源 | operator + Opus55 审阅 |
| KD-2 | 撤掉独立 epoch 去重工作项，以已有读取事实修复并在 D 测净重复 | Opus55 + Astra 收敛 |
| KD-3 | 源 reader 预算/曝光与最终出口防线分工，兜底不能制造假失败或假续读 | Astra 源码核验 |
| KD-4 | 严格 A→B→C→D 串行，仅保留 A 提案；撤回 B/C/D 提案但保留原 Task；执行与常规 review 使用 Sol6/Sol5.6/Kimi | operator `private-source-id` 及同消息引用批注 |
| KD-5 | C 改由 Sol6.1 执行、Sol5.6 审查（Sonnet 可备选）；续接同一 C Task，scope/AC/串行次序不变，替代 KD-4 的后续排班 | operator `private-source-id` 引用批注 |
