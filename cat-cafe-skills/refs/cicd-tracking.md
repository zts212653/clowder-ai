# CI/CD Tracking 参考

> 返回 → opensource-ops SKILL.md
> 事实采集：F133；等待契约：F280。

## 模型

CI poller 始终采集 `headSha / aggregate bucket / fingerprint`，但采集不等于唤醒。只有 active wait 明确包含 `pr_ci_terminal`，且 CI 相对注册 baseline 进入终态，才消费该 generation 并投递 compact delta。

```text
GitHub checks
  → collector state (always)
  → compare with server-captured baseline
  → pr_ci_terminal matched?
       no  → state-only
       yes → one compact wake + generation consumed
```

不再存在“CI fail 总唤醒”“review/merge intent”或按 repo 类型猜职责。

## 等 CI 的注册方式

```text
cat_cafe_register_pr_tracking(
  repoFullName="<owner>/repo",
  prNumber=<N>,
  when=[
    { kind: "pr_ci_terminal" },
    { kind: "pr_became_conflicting" }
  ],
  nextStep="Re-check checks and mergeability, then continue merge-gate.",
  expiresAt=<future unix ms>
)
```

服务端在注册时读取 live CI baseline：

- 当时 pending → 后续 pass/fail 可匹配；
- 当时已经 pass/fail → 历史终态被 baseline 吸收，不补发；直接查 `gh pr checks` 并继续；
- 新 HEAD 需要新的责任判断；若也想被 HEAD 变化叫醒，显式加入 `pr_head_changed`。

## Bucket 与去重

collector fingerprint 为 `headSha:aggregateBucket`：

| 观察 | collector | wait |
|---|---|---|
| 同 HEAD + 同 bucket | 幂等 | 不匹配 |
| pending → pass/fail | 更新 | `pr_ci_terminal` 匹配 |
| fail → pass | 更新 | 若 generation 尚 active，可匹配 |
| 新 HEAD | 重建当前事实 | 只有声明 `pr_head_changed` 才唤醒 |
| pending | 更新 | 不唤醒 |

一个 generation 最多一次 outcome。重复轮询、scheduler 竞速和重启 recovery 使用同一 outcome/message id。

## Billing / spending 红灯

GitHub Actions job 同时满足：

- `runner_id=0`
- `steps=[]`
- annotation 指向 billing/payment/spending

则归类 `external_infrastructure`。它不是代码失败，也不满足 `pr_ci_terminal`；记录状态后继续等待可执行 CI 或由 maintainer 主动处理账户条件。

## 收到唤醒

- pass：重新查询 exact HEAD、checks、mergeability，再继续 merge-gate。
- fail：打开失败 check/log，本地复现并修复；push 后按新的 baseline/责任显式注册下一次等待。
- conflicting：先 rebase/解决冲突；不要把 conflict 当 CI failure。
- merged/closed：subject terminal，tracker 自动终止。

## 无 Actions / 无额度

这是条件门禁，不是假造绿灯。没有可执行 CI 时，记录 `external_infrastructure` 或无 checks 的真实状态，依赖本地 gate 与已有 review 证据继续；不要让 tracker 无限等一个不会来的终态。
