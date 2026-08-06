# PR Signals：事实采集与显式等待

> F280 Unified Wait Contract。F140 继续拥有 GitHub 事实采集；是否唤醒由显式 typed wait 决定。

## 一条模型

PR tracker 不是“订阅所有 GitHub 事件”，而是一次性等待点：

```text
live baseline + typed predicate + nextStep + expiresAt
  → 不匹配：只推进事实台账
  → 匹配：消费本 generation，投递一条 compact diff
  → merged/closed：终止并投递 subject terminal
  → expiry/owner change/user cancel：静默终止
```

注册前历史永远由 live baseline 吸收。comment/review cursor 只负责采集幂等，不决定猫会看到什么。

## Predicate catalog

`when` 是 1–4 个 flat any-of 条件：

| Predicate | 适用等待 |
|---|---|
| `pr_head_changed` | 等 external author push 新 HEAD |
| `pr_review_result_available` + `triggerCommentId` | 等 exact `@codex review` 的结果 |
| `pr_review_decision_changed` | 等 GitHub review decision 变化 |
| `pr_review_thread_changed` + `reviewThreadIds` | 等指定 review thread 变化 |
| `pr_ci_terminal` | 等 CI 从非终态进入 pass/fail |
| `pr_became_conflicting` | 等 PR 首次变为 conflicting |

Actor 类型、仓库归属、`authorAssociation` 都不是 predicate。Bot CI 可以满足显式 CI wait；普通人类评论也不会凭“是人”自动叫醒。

## 注册示例

```text
# 等外部作者 push
cat_cafe_register_pr_tracking(
  repoFullName="owner/repo",
  prNumber=42,
  when=[{ kind: "pr_head_changed" }],
  nextStep="Re-lock the exact HEAD and review the delta.",
  expiresAt=<future unix ms>
)

# 等 CI 到终态
cat_cafe_register_pr_tracking(
  repoFullName="owner/repo",
  prNumber=42,
  when=[{ kind: "pr_ci_terminal" }, { kind: "pr_became_conflicting" }],
  nextStep="Re-check mergeability and continue merge-gate.",
  expiresAt=<future unix ms>
)

# Codex connector 已对 exact trigger 留下 EYES 后，等该结果
cat_cafe_register_pr_tracking(
  repoFullName="owner/repo",
  prNumber=42,
  when=[{ kind: "pr_review_result_available", triggerCommentId: 123456789 }],
  nextStep="Consume the exact-HEAD cloud review verdict.",
  expiresAt=<future unix ms>
)
```

`nextStep` 只显示，不解析；它不会变成隐藏的 mode。baseline 由服务端实时读取，调用方不能提交 HEAD、cursor 或 CI bucket。

## 唤醒内容

Owner 只收到满足 predicate 的 compact delta、满足原因和 `nextStep`，例如：

```text
GitHub wait satisfied — owner/repo#42
- HEAD a1b2c3d → e4f5a6b
Reason: pr_head_changed
Next: Re-lock the exact HEAD and review the delta.
```

comment/review body、CI 原始 description、legacy caller instructions 和未匹配 delta 不进入消息；原始事实留在 GitHub/台账供 drill-down。

## 处理策略

- `pr_head_changed`：重新锁定 exact HEAD，失效旧 verdict，再按当前 review SOP 走。
- `pr_review_result_available` / review predicate：加载 `receive-review`，逐项验证并处理。
- `pr_ci_terminal`：查真实 checks；pass 继续 merge-gate，fail 读日志并修复。
- `pr_became_conflicting`：在对应 worktree rebase；复杂冲突再升级。
- `subject_terminal`：以 GitHub merged/closed truth 收口，不再续 tracker。

同一 wait generation 最多产生一次 owner wake。需要等待另一个条件时显式 re-register；新 generation 原子替换旧 generation，不叠加第二个 tracker 或 timed hold。

### Review 来源回路

**Source-aware rule**：cloud / GitHub review 的反馈修完后，push 新 SHA 并重新触发 cloud review，
等待同一 PR truth source；不要把它投射给本地旧 reviewer。本地猫 review 的修复则回到原 reviewer，
明确记录“已 @ local reviewer 确认”。

## CI 外部基础设施

GitHub Actions job 同时满足 `runner_id=0`、`steps=[]`，且 annotation 指向 billing/payment/spending 时，归类为 `external_infrastructure`：记状态，不满足 `pr_ci_terminal`，也不把“账单红灯”当代码失败。

## Issue compatibility

`register_issue_tracking` 在 F280 Phase C 前仍保留自己的 comment actor policy。不要把 issue 的 `wakePolicy` 借回 PR，也不要从 PR predicate 反推 issue 行为。
