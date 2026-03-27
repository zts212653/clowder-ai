# PR Signals 通知格式 + 处理策略

> F140: GitHub PR Signals — 冲突检测 + Review Feedback 全来源感知

## 三类通知

注册 PR tracking 后，你会收到三类自动通知：

| 类型 | ConnectorSource | 优先级 | 触发条件 |
|------|----------------|--------|----------|
| CI/CD 状态 | `github-ci` | fail=urgent, pass=normal | CI checks 完成（F133） |
| PR 冲突 | `github-conflict` | urgent | `mergeStateStatus` 变为 CONFLICTING（F140） |
| Review Feedback | `github-review-feedback` | changes_requested=urgent, 其余=normal | 新 comments / review decisions（F140） |

## 通知消息格式

### 冲突通知

```
⚠️ **PR 冲突**

PR #42 (owner/repo)
Commit: `abc1234`

当前分支与 base 存在冲突，需要 rebase 或手动解决。
```

### Review Feedback 通知（三分区聚合，OQ-2）

```
📋 **Review Feedback** — PR #42 (owner/repo)

--- Review Decisions ---
✅ **alice**: APPROVED — Ship it
🔄 **bob**: CHANGES_REQUESTED — Needs work

--- Inline Comments (1) ---
💬 **bob** `src/a.ts:5`: typo here

--- PR Conversation (1) ---
💬 **charlie**: great PR
```

## 处理策略

### 收到冲突通知

1. 在 worktree 中 `git fetch origin main && git rebase origin/main`
2. 自动解决简单冲突 → push → 等下一轮 CI 通知
3. 复杂冲突（无法自动 resolve）→ 通知铲屎官

### 收到 Review Feedback

1. 区分 review decision：
   - `CHANGES_REQUESTED` → 加载 `receive-review` skill，按 Red→Green 修复
   - `APPROVED` → 准备进入 merge-gate
   - `COMMENTED` → 阅读 comments，判断是否需要改动
   - `DISMISSED` → 记录，继续
2. Inline comments → 逐个定位代码位置，理解反馈后处理
3. Conversation comments → 理解讨论上下文后回应

## Phase B: 自动响应行为（KD-13: 全自动 + 事后通知）

猫被 ConnectorInvokeTrigger 唤醒后，根据通知类型自动采取行动。

### 冲突自动 resolve（AC-B1 + AC-B2）

收到 `github-conflict` 通知时：

1. **定位 worktree**：根据 PR 号查分支 → 找到对应 worktree
   ```bash
   gh pr view {N} --json headRefName --jq '.headRefName'
   ```
2. **执行 rebase**：
   ```bash
   cd <worktree-path>
   git fetch origin main
   git rebase origin/main
   ```
3. **评估结果**：
   - **rebase clean**（无冲突）→ `git push --force-with-lease` → 通知铲屎官"已自动 resolve"
   - **冲突 ≤3 个文件 + 非 binary** → 尝试手动解决 → 成功则 push + 通知
   - **复杂冲突**（>3 文件 / binary / 语义冲突）→ `git rebase --abort` → 通知铲屎官附冲突文件列表

### Review Feedback 自动处理（AC-B3）

收到 `github-review-feedback` 通知时，根据 review decision 分流：

| Decision | 行动 |
|----------|------|
| `CHANGES_REQUESTED` | 加载 `receive-review` 模式，逐项处理（Red→Green） |
| `APPROVED` | 检查 CI + 冲突状态 → 全绿则准备 merge-gate |
| `COMMENTED` | 阅读评论，需回复则回复，需修改则按 receive-review 处理 |
| `DISMISSED` | 记录，不自动行动 |

### 事后通知

所有自动行动完成后，通知铲屎官结果：
- 成功: "已自动 rebase 并 push PR #42"
- 失败: "PR #42 冲突无法自动解决，需要人工介入" + 冲突文件列表
- Review 处理完: "已按 receive-review 模式处理 PR #42 的 review 意见，@ reviewer 确认"

## 去重机制

| 信号 | 去重方式 |
|------|----------|
| 冲突 | `lastConflictFingerprint = headSha:CONFLICTING`，MERGEABLE 时清除（KD-9） |
| Review Feedback | cursor-based：comment ID / review ID 单调递增，cursor 仅在 delivery 成功后推进（KD-10） |
| CI/CD | `lastCiFingerprint = headSha:bucket`（F133） |

## 配置

PR Signals 自动随 `register_pr_tracking` 生效，无需额外配置。轮询间隔：
- 冲突检测：5 分钟
- Review Feedback：1 分钟
- CI/CD：由 F133 CiCdCheckTaskSpec 控制
