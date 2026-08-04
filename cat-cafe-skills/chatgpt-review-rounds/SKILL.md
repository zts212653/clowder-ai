---
name: chatgpt-review-rounds
description: >
  Operator-approved multi-cat review rounds for code authored by ChatGPT desktop Codex.
  Use when: ChatGPT has pushed a code HEAD and co-creator requires independent cat reviews,
  cross-review consensus, and a Git ledger written by one designated recorder.
  Not for: ordinary cat-authored changes, single-source risk-routed review, self-check, or cloud-only review.
  Output: one immutable consensus ledger commit per round; repeat until approved_for_merge and openFindings=0.
triggers:
  - "ChatGPT 提交代码"
  - "多猫独立检视"
  - "交叉检视"
  - "review round"
  - "共识 ledger"
---

# ChatGPT Multi-Cat Review Rounds

这条 lane 只服务于 operator 拍板的“ChatGPT 执行、Cat Café 设计与 Review”工作流。它有意使用多只猫，
是 `request-review` 默认单一风险源规则的窄例外，不能扩张成所有 PR 的固定 Review 税。

## 角色与真相源

- **Author**：ChatGPT 桌面 Codex；只改代码、测试和实现文档，不改已经封存的 round ledger。
- **Reviewers**：至少两只非作者猫；先独立检视，再交叉检视。
- **Recorder**：每轮由 co-creator 指定；是该轮唯一 Git writer，只转录共识，不擅自改实现。
- **Acceptance owner**：co-creator；在 main 合入后亲自验收。
- **代码真相源**：`reviewedCodeHead` 指向的精确 commit。
- **Review 真相源**：`review-notes/chatgpt/<change-id>/round-<NN>.md`。

## Round 状态机

```text
submitted
  → independent_review
  → cross_review
  → consensus_recording
  → fix_required → ChatGPT push new code HEAD → next round
  → approved_for_merge → ChatGPT merge main → operator_acceptance
```

### 1. 固定本轮输入

记录 branch、PR、`reviewedCodeHead`、需求/Feature Doc、ChatGPT 测试证据、reviewer 名单和 operator 指定的
recorder。代码 HEAD 在该轮内漂移时，本轮作废；先固定新 HEAD，再重新开始独立检视。

### 2. `independent_review`：隔离判断

- 每只猫只读同一个 `reviewedCodeHead`，可以读 diff、源文件和运行验证。
- 私下保留自己的 findings；在全部 reviewer 完成前不得阅读、索取或预测其他猫的意见。
- 本阶段是 Git **只读**：禁止编辑共享分支，禁止 `commit`、`push`、`rebase`、`checkout`。
- 完成时只报告 `independent_review complete @ <reviewedCodeHead>`，不提前公开 findings。

### 3. Barrier 后进入 `cross_review`

只有全部 reviewer 都完成独立检视，才同时公开各自意见并开始交叉核验：

1. 合并重复 findings，但保留各自证据来源。
2. 对每条 finding 核对文件位置、复现路径、预期行为和严重级别。
3. 被证据推翻的 finding 标为 `not_a_defect`；不能靠多数票抹掉技术分歧。
4. 技术分歧继续查证；价值或验收分歧交给 co-creator。
5. 形成唯一的 consensus finding 集与上一轮 finding 的 closure 状态。

交叉检视仍是 Git 只读；任何 reviewer 都不能抢先落盘。

### 4. `consensus_recording`：单写者封板

co-creator 指定的 recorder 使用
[`refs/chatgpt-review-round-template.md`](../refs/chatgpt-review-round-template.md) 创建该轮 ledger：

```text
review-notes/chatgpt/<change-id>/round-<NN>.md
```

ledger 必须绑定 `reviewedCodeHead`，列出 reviewer/recorder、上一轮 closure、共识 findings、`openFindings`
和 verdict。只有 recorder 可以提交并推送这个文件；**push 成功才代表本轮检视完毕**。

提交消息：

```text
review(<change-id>): record ChatGPT round <NN> consensus
```

### 5. ChatGPT 修复与下一轮

- `openFindings > 0` 时 verdict 必须是 `fix_required`。
- ChatGPT 只处理 ledger 中的共识 findings，逐条引用 Finding ID，补测试、运行验证并提交新 code HEAD。
- ChatGPT 不修改历史 ledger；下一轮由 recorder 记录哪些 finding 已 `fixed`、`reopened` 或仍 `open`。
- 新 code HEAD 必须重新经过完整的独立检视 → 交叉检视，不能只找原 finding 提出者续签。

### 6. 终态与合入

只有最新一轮同时满足下列条件，recorder 才能写 `approved_for_merge`：

- 所有历史共识 findings 已关闭；
- 本轮没有新 finding；
- `openFindings=0`；
- ledger 精确绑定本轮 `reviewedCodeHead`；
- 风险匹配的测试与 merge gate 全绿。

最终 ledger commit 只允许改该 round 文件。它不改变已审代码语义；merge-gate 用 continuityProof 证明
`reviewedCodeHead..HEAD` 仅包含 recorder ledger。出现任何代码、测试、配置或其他文档变化，approval 立即 stale，
必须从新 code HEAD 开下一轮。证据闭合后由 ChatGPT squash merge main，随后等待 co-creator 亲自验收。

## Common Mistakes

| 错误 | 后果 | 修正 |
|---|---|---|
| reviewer 边审边互看 | 锚定导致假共识 | 全员完成独立检视后再开 barrier |
| 独立阶段有人 commit/push | 审查目标漂移、身份混乱 | Review 全阶段只读，recorder 最后单写 |
| 把每只猫的原始笔记全塞进 Git | 噪音取代结论 | ledger 只保存证据化共识与 closure |
| ChatGPT 修改历史 ledger | Author 改写 Review 真相 | 历史 round immutable，下一轮记录状态变化 |
| ledger commit 之后直接宣称 exact-HEAD approval | 元数据 SHA 冒充代码 SHA | 绑定 reviewedCodeHead，并证明 ledger-only continuity |
| 只清 P1/P2，遗留共识 P3 | 不满足“所有问题关闭” | 接受的任何严重级别 finding 都必须关闭 |

## 验证

- 每轮至少两个不同 reviewer catId，且都不等于 ChatGPT author identity。
- barrier 前找不到其他 reviewer finding 内容。
- recorder 之外没有该轮 Git 写入。
- ledger 的 `reviewedCodeHead`、PR head 和 reviewer 实际读取目标一致。
- `ledgerOnlyContinuity` 证明 `reviewedCodeHead..ledger commit` 只新增本轮 ledger 文件，没有代码、测试、配置或其他文档变化。
- `approved_for_merge` 必须机械对应 `openFindings=0`。

## 下一步

- `fix_required` → ChatGPT 按 ledger 修复并提交新 code HEAD → 开下一轮。
- `approved_for_merge` → `merge-gate` → ChatGPT 合入 main → `@co-creator` 亲自验收。
