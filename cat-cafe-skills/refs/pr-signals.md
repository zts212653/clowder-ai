# PR Signals：事实采集与显式等待

> F280 Unified Wait Contract。F140 继续拥有 GitHub 事实采集；是否唤醒由显式 typed wait 决定。

## 一条模型

PR tracker 不是“订阅所有 GitHub 事件”：注册一次，由一串一次性的 generation 持续跟进（#1392 AC-1）。

**普通注册只写 `repoFullName + prNumber`。** `when`、`goal`、`nextStep` 都不必填——服务端按你在这个 PR 上的角色自己决定受众（#1392 AC-7）。

```text
live baseline + typed predicate + nextStep + expiresAt(可选) + autoRenew(默认 true)
  → 不匹配：只推进事实台账
  → 匹配：消费本 generation，投递一条 compact diff，并在同一次转移里装上下一代
         （从本次观察结束处开始，不回放、不吞事件）；autoRenew:false 则到此结束
  → merged/closed：终止并投递 subject terminal，不再续代
  → expiry：终止并投递明确的到期通知，续代不会延长截止时间
  → owner change/user cancel：静默终止
```

每条投递都会写明追踪是继续、已结束，还是「事件已投递但未能重新武装」。

注册前历史永远由 live baseline 吸收。comment/review cursor 只负责采集幂等，不决定猫会看到什么。

## 默认受众（普通入口，#1392 AC-7）

省略 `when` 时，服务端装上 PR 自己会产生的四个条件（review decision / CI 终态 / 冲突 / 新 HEAD），**并装上两个评论面**，受众由角色决定：

| 你在这个 PR 上的角色 | 判定依据 | 你会被叫醒的评论 |
|---|---|---|
| PR 作者 | 认证身份 == PR author | 除你自己以外的所有回复，**含 bot** |
| maintainer / reviewer | 认证身份 ≠ author，且有可核验依据（被请求 review / 已提交 review / 有写权限） | 只有 PR 作者的回复；bot 与可确定识别的纯召唤命令被过滤 |
| 身份或角色无法确定 | 缺 self login / 缺 author / 无可核验 reviewer 依据 | 全部评论照常投递，并标注「身份/角色未知」；**这不代表正常覆盖已建立** |

「不是作者」本身不是 reviewer 依据——那是一个缺席，把缺席当角色会让一个路人拿到 maintainer 的窄受众然后几乎什么都听不到。

注册返回里的 `notification` 写明实际装了什么条件、解析出的角色、以及每个评论面的过滤规则。issue 同理：省略 `when` 就是「除自己以外的所有评论」。

## Predicate catalog

`when` 是高级精确入口，最多每种条件各一个（flat any-of）：

| Predicate | 适用等待 |
|---|---|
| `pr_head_changed` | 等 external author push 新 HEAD |
| `pr_review_result_available` + `triggerCommentId` | 等 exact `@codex review` 的结果 |
| `pr_review_decision_changed` | 等 GitHub review decision 变化 |
| `pr_review_thread_changed` + `reviewThreadIds` | 等指定 review thread 变化 |
| `pr_ci_terminal` | 等 CI 从非终态进入 pass/fail |
| `pr_became_conflicting` | 等 PR 首次变为 conflicting |
| `pr_conversation_comment_added` + `authorLogins` | 等指定作者的 PR 顶层评论 |
| `pr_inline_comment_added` + `authorLogins` | 等指定作者的代码行内 review 评论 |

两个评论面各有独立游标，行内与顶层评论的 id 不可互相比较。在**高级 `when[]` 路径**上 `authorLogins` 仍然**必填**、注册时冻结、大小写不敏感：没有"不写就是任何人"的形式，因为那等于一个谁都没选过的开放受众。空名单同样会被拒绝——它匹配不到任何人，只会变成一个永不触发的死等待。高级路径不会被套上普通入口的角色过滤：你点名了谁，就只听谁的。

采集永远无条件：评论一律拉取，被过滤的评论照样推进游标，下一轮不重放。只有投递层决定是否叫醒。

Actor 类型、仓库归属、`authorAssociation` 都不是 predicate。Bot CI 可以满足显式 CI wait。`actorType` 只在普通入口的 maintainer 视角里用于过滤 bot，不在高级路径上生效，也不用来猜“这条回复有没有用”。

## 注册示例

```text
# 普通：跟踪这个 PR（绝大多数情况就是这一行）
cat_cafe_register_pr_tracking(repoFullName="owner/repo", prNumber=42)

# 高级：只等外部作者 push
cat_cafe_register_pr_tracking(
  repoFullName="owner/repo",
  prNumber=42,
  when=[{ kind: "pr_head_changed" }],
  nextStep="Re-lock the exact HEAD and review the delta.",
  expiresAt=<future unix ms>  # 可选；省略则没有时间到期
)

# 等 CI 到终态
cat_cafe_register_pr_tracking(
  repoFullName="owner/repo",
  prNumber=42,
  when=[{ kind: "pr_ci_terminal" }, { kind: "pr_became_conflicting" }],
  nextStep="Re-check mergeability and continue merge-gate.",
  expiresAt=<future unix ms>  # 可选；省略则没有时间到期
)

# Codex connector 已对 exact trigger 留下 EYES 后，等该结果
cat_cafe_register_pr_tracking(
  repoFullName="owner/repo",
  prNumber=42,
  when=[{ kind: "pr_review_result_available", triggerCommentId: 123456789 }],
  nextStep="Consume the exact-HEAD cloud review verdict.",
  expiresAt=<future unix ms>  # 可选；省略则没有时间到期
)
```

`nextStep` 可选、只显示、不解析；省略时服务端写一条确定性的。它不会变成隐藏的 mode。baseline 由服务端实时读取，调用方不能提交 HEAD、cursor 或 CI bucket。

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
- `pr_conversation_comment_added` / `pr_inline_comment_added`：读对应评论（行内评论带文件与行号），按 `receive-review` 回应或修改。投递里只有评论 id 与作者，正文需自己去读，不会被复制进消息。
- `subject_terminal`：以 GitHub merged/closed truth 收口，不再续 tracker。

同一 wait generation 最多产生一次 owner wake。需要等待另一个条件时显式 re-register；新 generation 原子替换旧 generation，不叠加第二个 tracker 或 timed hold。

### Review 来源回路

**Source-aware rule**：cloud / GitHub review 的反馈修完后，push 新 SHA 并重新触发 cloud review，
等待同一 PR truth source；不要把它投射给本地旧 reviewer。本地猫 review 的修复则回到原 reviewer，
明确记录“已 @ local reviewer 确认”。

## CI 外部基础设施

GitHub Actions job 同时满足 `runner_id=0`、`steps=[]`，且 annotation 指向 billing/payment/spending 时，归类为 `external_infrastructure`：记状态，不把“账单红灯”当代码失败，也不把已知月底额度边界升级成 operator/maintainer 的付费、修账单或关 workflow 待办。它不构成可执行 CI 终态；当 claim 已有风险匹配的本地 gate 与独立 review 证据时，结束这条不可执行的 CI 等待并继续 merge-gate，而不是无限等或反复上报。

## Issue compatibility

`register_issue_tracking` 在 F280 Phase C 前仍保留自己的 comment actor policy。不要把 issue 的 `wakePolicy` 借回 PR，也不要从 PR predicate 反推 issue 行为。
