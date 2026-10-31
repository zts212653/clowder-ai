---
title: Close Gate Report Schema
doc_kind: reference
created: 2026-04-28
feature_ids: [F177]
---

# Close Gate Report — CloseGateReport Schema

> **唯一真相源**。`feat-lifecycle` close 和 `quality-gate` 都引用此 schema。

## 目的

把 "AC 全打勾 = done" 从直觉判断升级为**结构化对账**。每个 Feature close 时必须输出一份 CloseGateReport，逐条列明 AC 的证据和处置。

## Schema

```yaml
close_gate_report:
  feature_id: F177          # Feature ID
  spec_path: docs/features/F177-harness-update.md
  head_sha: abc1234          # close 时的 HEAD commit
  report_date: 2026-04-28

  ac_matrix:
    - ac_id: AC-A1
      status: met            # met | unmet | deleted | cvo_signed_off
      evidence:
        - kind: commit       # commit | test | screenshot | pr | doc | message
          ref: "abc123"
          description: "feat-lifecycle close 命令强制输出矩阵"
        - kind: test
          ref: "test/close-gate.test.mjs"
      resolution: null       # met 时为 null

    - ac_id: AC-A2
      status: cvo_signed_off
      evidence:
        - kind: message
          ref: "0001777429046142-000045"
      resolution:
        kind: cvo_signoff    # immediate | delete | cvo_signoff
        reason: "operator认为自然语言表态足够，不需要固定 token"
        cvo_signoff:
          proposal_message_id: "0001777428xxx-000040"
          cvo_message_id: "0001777429046142-000045"
          cvo_quote: "ok ok 全部ok"
          accepted_scope: [AC-A2]

    - ac_id: AC-A3
      status: deleted
      evidence: []
      resolution:
        kind: delete
        reason: "经评估不属于 MVP scope，已从 spec 移除"
```

## Status 枚举

| Status | 含义 | 要求 |
|--------|------|------|
| `met` | AC 已实现 | evidence 至少一条（commit/test/screenshot/doc） |
| `unmet` | AC 未实现 | **必须当场处置**，见 Resolution |
| `deleted` | AC 已删除 | resolution.kind = `delete`，reason 必填 |
| `cvo_signed_off` | operator 签字降级 | resolution.kind = `cvo_signoff`，四件套必填 |

## Resolution（unmet AC 三选一）

| Kind | 含义 | 要求 |
|------|------|------|
| `immediate` | 当前 session inline 做完 | 做完后 status 改为 `met`，补 evidence |
| `delete` | 删除 AC | reason 必填，说明为什么不需要 |
| `cvo_signoff` | operator 明确表态同意降级 | 四件套：`proposal_message_id` + `cvo_message_id` + `cvo_quote` + `accepted_scope` |

**没有第四选项。** `follow-up` / `deferred` / `next phase` / `P2` / `stub` / `TD` / `后续` / `留个尾巴` / `先这样` / `下次一定` / `回头` / `以后再` / `next PR` / `will address later` / `out of scope` / `MVP 先上` 等字样只是**语义检查线索，不是自动 BLOCK**。硬门只看结构化状态：`unmet` 仍存在、`met` 缺 evidence/仍带 resolution、`deleted` 缺 delete+reason、`cvo_signed_off` 缺四件套时阻塞；完整的 delete / cvo_signoff 不因 reason 里出现这些词被误杀。

## operator Signoff 机制

operator的实际交互模式：猫提出 tradeoff + 判断 → operator自然语言表态（"ok"/"全部 ok"/"同意"）→ 猫录入。

**有效条件**：
1. 猫的 proposal 消息已明确列出 tradeoff 和 AC 范围
2. operator的表态消息可追溯（有消息 ID）
3. 单独一句"ok"但找不到前置 proposal = **不允许当降级证据**

## 愿景守护猫检查项

守护猫 close 验收时必须检查：
1. CloseGateReport 是否存在（缺矩阵 = BLOCKED）
2. 每个 unmet AC 是否已三选一处置
3. follow-up tail 线索是否暴露了未处置 AC（关键词本身不作 verdict）
4. cvo_signoff 的四件套是否完整且可追溯
5. 不允许凭自由文本"我都做了" close
6. **Contract 漂检查（KD-26 from F194 Phase Z5）**：本 PR 改了一个 contract（id 公式 / kind 语义 / fallback 策略 / etc.）后，是否同时审了**所有引用该 contract 的周边代码**没有出现"helper 用 X 公式但 reducer 用 X+kind 公式"这种漂？守护对照表不能只对照"上一次 catch 的症状"，要主动列出"contract A 改动 → contract B/C/D 是否仍兼容"的矩阵。F194 Phase Z3/Z4 守护表两次都全绿但 Bug A+B 没 catch，根因就是没做 contract 漂检查
