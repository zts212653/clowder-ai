---
feature_ids: [F257]
topics: [harness, judgment-schema, eval, five-ring]
doc_kind: spec
created: 2026-07-10
status: FROZEN-v1
---

# Judgment Schema v1 — 段 Harness 判定数据模型（FROZEN）

> **Freeze 声明**：本文件为 KD-14 P1 前置「Week 1 末 schema v1 freeze」的兑现物，2026-07-10 12:00 UTC 前生效。
> Freeze 后改动协议：字段增删 = v2 提案 + spec KD 落账；仅注释/示例修正可直接 patch。
> 对齐基线：GuardRejectionEventLog @ `613e11266`（develop_base）+ ObservedSegment 扩展字段（PR #23）+ Design Gate 收敛版 ledger schema。

## 0. 五环与对象的映射（本 schema 的骨架）

```
信号 ──────► 归因 ──────► 修补 ──────► 验证 ──────► 固化/淘汰
GuardRejectionEvent  SegmentJudgment  PatchTrial   PatchTrial     Candidate.status
InjectionTrace  ──►  + Candidate  ──► (approved) ► (outcome)  ──► closed / falsified
(既有，只引用)        (本 schema §2/§3)  (§4)         (§4.outcome)   + ledger status
```

四个对象，三个新定义（§2/§3/§4），一个只引用不重定义（§1）。

## 1. 证据源（引用既有实现，不重定义）

| 对象 | 真相源 | v1 使用的字段 |
|------|--------|--------------|
| `GuardRejectionEvent` | `packages/api/src/infrastructure/harness-eval/GuardRejectionEventLog.ts` | `kind`(六类 union，Week1 上 2) / `threadId` / `catId` / `guardId` / `timestamp` / `correlationConfidence: 'window'` |
| `ObservedSegment`（PR #23 扩展后） | `packages/shared` trace 类型 | `segmentId` / `contentHash` / `version?` / `pipelineStatus?`(fired\|skipped\|disabled\|observed) / `reasonCode?` / `disabledBy?` |
| 段身份 | 46 hook.yaml manifest | `id` / `stage` / `disableable` / `safetyTier` / `governanceTier` |

**Correlation 契约（v1 = window 档）**：`join = threadId + catId + [timestamp - W, timestamp + W]`，W 默认 120s（同一 cat 在同一 thread 同时刻仅一个 active invocation，wake 粒度足够）。`correlationConfidence: 'window'` 必须随判定证据透传；`'exact'`（invocationId 桥）为后续增强，进 schema 不进 v1 判定路径。

## 2. SegmentJudgment — 归因环输出（eval run 的原子结果）

```yaml
segmentJudgment:
  judgmentId: string            # sj-{yyyymmdd}-{seq}
  segmentId: string             # hook id（如 d21-决策树）；SOP 段用 sop/{stage} 命名空间
  segmentVersion: number|null   # 判定窗口内观测到的版本；null = 窗口内未观测到注入
  window: { startMs: int, endMs: int }   # [start, end) 与 queryWindow 语义一致
  verdict: alive | dormant | unmeasurable | observability-debt | needs-denominator | retire-candidate
  evidence:
    injectionCount: { value: int, how_counted: string }   # trace 内该段 fired 次数，命令/查询原样记录
    violationCount: { value: int, how_counted: string }   # window join 到的对应 guard 事件数
    denominatorKind: fired-count | session-count | none    # none → verdict 只能是 unmeasurable/needs-denominator
    eventRefs: string[]          # eventId 列表（抽样上限 20，超出记 count）
    correlationConfidence: window | exact
  pressure:                      # Design Gate 三级政策的 schema 落点
    observabilityDeadline: string|null   # ISO 日期；连续 2 eval 周期 unmeasurable 起算
    nextRequiredAction: upgrade-structure | operator-intentional-keep | enter-retire-queue | null
  producedBy: { domainId: eval:harness-ledger, runId: string, evalCat: string }
```

**verdict 判定规则（v1 固定）**：有注入有违规下降空间 → `alive`；有分母连续 2 周期零触发零违规 → `dormant`；无分母 → `unmeasurable`（不得判 dormant——防错杀铁律）；分母可补但未补 → `needs-denominator`；观测链路自身断 → `observability-debt`；满足三级政策第③级 → `retire-candidate`。

## 3. Candidate — T1/T3/eval 产出的待决对象（operator 审批的载体）

```yaml
candidate:
  candidateId: string           # 沿用 T1-C*/T1-F* 编号；eval 产出用 EC-*
  type: redundant-duplicate | redundant-cross-layer | conflict-audience |
        contradiction | word-collision | missing-segment | retire-candidate
  targetSegmentIds: string[]    # missing-segment 允许空数组 + proposedSegment 描述
  originKind: t1-static | t3-gap | eval-verdict | live-incident
  evidence: { anchors: string[], summary: string }   # thread msg id / 文件锚点 / judgmentId
  proposedAction:
    mechanism: override-disable | override-content | merge-segments | add-guard |
               rewrite | intentional-keep | none
    rollback: string            # 一句话回滚路径（override 类天然=清除 override）
  status: proposed → approved | rejected → executing → verifying → closed | falsified
  approval:                     # operator gate（五环第二环）——审批卡即此对象的渲染
    approvedBy: string|null     # operator id；猫不可代填（provenance 铁律）
    decidedAt: string|null
    note: string|null
```

## 4. PatchTrial — 修补 + 验证环（行为差分的实验记录）

```yaml
patchTrial:
  trialId: string               # pt-{candidateId}-{seq}
  candidateRef: string
  mechanism: override-disable | override-content | add-guard | ...   # 同 §3
  executedVia: string           # 如 HookOverrideStore.disable(d21, source=operator-approved)
  baseline:  { window: {...}, violationRate: {value: float, how_counted: string} }
  treatment: { window: {...}, violationRate: {value: float, how_counted: string} }
  minWindowDays: 5              # v1 默认；差分窗口不足不得出 outcome
  outcome: improved | no-change | regressed | inconclusive | pending
  decision: solidify | rollback | falsified | pending    # solidify = 沉淀基线（源码 PR / 安装包 issue 附证据）
  trace: { beforeHash: string, afterHash: string }        # 注入 trace 证明段真的消失/变更
```

**验证判据（v1 固定）**：`improved` 需 treatment.violationRate < baseline 且差分窗口 ≥ minWindowDays；`regressed` 立即回滚（override 清除，10 分钟内）；`no-change` = A1 公理证伪样本（文本段无行为差分）→ 支持 retire。

## 5. v1 显式不做（防 scope 蠕变）

- exact correlation（invocationId 桥）——schema 留位，判定不依赖
- audience 字段的 hook.yaml 落地（T1-S2/A3）——进 v2 提案，随第一个 conflict-audience candidate 一起议
- assertion 字段回填 46 段——渐进任务，v1 判定用 verdict 规则代偿
- 自动改 prompt 段（防自我繁殖，codex 输入采纳原样保留）

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-10 | v1 起草 + FROZEN（KD-14 P1 前置兑现）；字段与 PR #23/#24 实现实测对齐 |
