# PR Signals：外部回应追踪

> F280 GitHub Tracking Contract。F140 继续拥有 GitHub 事实采集；**是否唤醒由服务端按事件名决定，
> 调用方不再挑 predicate**。

## 一条模型

> 拉取 PR / issue 新增的评论和 review → 按内容封装成通知 → 按账户名过滤掉不该发的 →
> 投递到注册它的那个 thread。

```text
注册（repo + number）→ 冻结所有来源的 frontier
  → 归一化：所有来源产出同一形状的事件
  → 订阅过滤 / 已见过滤（每个来源一条游标）/ 身份过滤（只过滤自己，大小写不敏感）
  → 投递到注册它的 thread，并推进该来源的游标
```

注册前的历史一律不通知。**追踪永不过期**；通知一次后自动续订。
结束条件只有三个：PR merged / PR 或 issue closed / 显式 `unregister_tracking`。

## 事件词表（PR）

调用方说的是**事件名**，不是 predicate 名，更不是 GitHub 游标名。

| 事件名 | 默认 | 含义 |
|---|:--:|---|
| `review_decision` | ✅ | approve / request changes / dismiss |
| `conversation_comment` | ✅ | PR 顶层评论 |
| `inline_comment` | ✅ | 代码行内 review 评论 |
| `bot_interaction` | **按角色** | 一个 bot 交互回合；PR 作者默认开，非作者默认关 |
| `ci_terminal` | ✅ | CI 通过 / 失败 |
| `conflict` | ✅ | PR 变为冲突 |
| `base_behind` | ✅ | base 分支有新提交（仅通知） |
| `head_changed` | ❌ | 作者推了新 commit；需 `include` |

`include` / `exclude` 传入未知名字 → **报错**，不静默忽略。
Actor 类型、仓库归属、`authorAssociation` 都不是过滤依据；**bot 照常通知**——
codex review bot 的评论是 PR tracking 最重要的信号。唯一的过滤是"这是不是我自己写的"。

## 注册示例

```text
# 全部默认事件
cat_cafe_register_pr_tracking(repoFullName="owner/repo", prNumber=42)

# 不想被 CI 打扰
cat_cafe_register_pr_tracking(
  repoFullName="owner/repo", prNumber=42,
  exclude=["ci_terminal"],
  nextStep="Re-check mergeability and continue merge-gate."
)

# 非作者也想看别人和 bot 的来回
cat_cafe_register_pr_tracking(
  repoFullName="owner/repo", prNumber=42,
  include=["bot_interaction"]
)
```

**除了上面这些事件名，注册不接受任何别的参数**——没有条件表达式、没有过期时间、没有游标、
没有受众白名单。传了会被拒绝。让调用方在两个听起来都对的内部条件之间选，就是在要求它
猜对 GitHub 内部游标——猜错的表现是**静默不通知**，而不是报错。

`nextStep` 只显示，不解析；它不会变成隐藏的 mode。

## bot 交互回合

你写 `@codex review`（**召唤 handle**），回答你的是 `chatgpt-codex-connector[bot]`（**应答账号**）——
两个不同字符串，服务端用一张身份表同时记住它们。

- **召唤**（命令式 `@handle review`）开启一个回合；该 bot 的回应闭合它
- 只是**提到** bot（"回头问下 @codex"）不开回合，但仍算 bot 对话，非作者可以静音
- 回合开了却**超时没回** → 主动通知你"这轮没回来"，只报一次
- 注册时若发现你刚发的召唤评论且 connector 已 EYES 接单、尚未回答，
  服务端会把回合**绑定到本次 invocation + 当前 HEAD** 并同步开出来——
  这是 routing guard 允许你本轮 clean stop 的唯一凭据。
  别人的 invocation、别的 HEAD、别人发的召唤都不算。

## 唤醒内容


Owner 只收到命中订阅的 compact delta、命中原因和 `nextStep`，例如：

```text
GitHub wait satisfied — owner/repo#42
- HEAD a1b2c3d → e4f5a6b
Reason: head_changed
Next: Re-lock the exact HEAD and review the delta.
```

**评论正文进消息**，并标注 `[UNTRUSTED EXTERNAL CONTENT]`——通知只写 "comment #21" 而把读者真正需要的字剥掉，是 #1392 的原始症状之一。CI 原始 description、legacy caller instructions 与未匹配 delta 不进入消息；原始事实留在 GitHub/台账供 drill-down。

## 处理策略

- `head_changed`：重新锁定 exact HEAD，失效旧 verdict，再按当前 review SOP 走。
- `review_decision` / `inline_comment` / `conversation_comment`：加载 `receive-review`，逐项验证并处理。
- `bot_interaction`：bot 的回合结果按 review 处理；收到"这轮没回来"就重新触发或改走人工。
- `ci_terminal`：查真实 checks；pass 继续 merge-gate，fail 读日志并修复。
- `conflict`：在对应 worktree rebase；复杂冲突再升级。
- `base_behind`：仅通知；是否 update branch 由你决定（服务端不会替你写仓库）。
- `subject_terminal`：以 GitHub merged/closed truth 收口，不再续 tracker。

**不需要重新注册。** 通知一次后服务端自动续订，继续监听下一条。
只有**改订阅**时才重复注册；此时旧 frontier 会被保留（间隙期到达的回应不会丢），
本轮新验证出的 bot 回合会并入，不叠加第二个 tracker 或 timed hold。

### Review 来源回路

**Source-aware rule**：cloud / GitHub review 的反馈修完后，push 新 SHA 并重新触发 cloud review，
等待同一 PR truth source；不要把它投射给本地旧 reviewer。本地猫 review 的修复则回到原 reviewer，
明确记录“已 @ local reviewer 确认”。

## CI 外部基础设施

GitHub Actions job 同时满足 `runner_id=0`、`steps=[]`，且 annotation 指向 billing/payment/spending 时，归类为 `external_infrastructure`：记状态，不把“账单红灯”当代码失败，也不把已知月底额度边界升级成 operator/maintainer 的付费、修账单或关 workflow 待办。它不构成可执行 CI 终态；当 claim 已有风险匹配的本地 gate 与独立 review 证据时，结束这条不可执行的 CI 等待并继续 merge-gate，而不是无限等或反复上报。

## Issue compatibility

`register_issue_tracking` 在 F280 Phase C 前仍保留自己的 comment actor policy。不要把 issue 的 `wakePolicy` 借回 PR，也不要从 PR predicate 反推 issue 行为。
