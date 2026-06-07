# CI/CD Tracking 参考文档

> 返回 → opensource-ops SKILL.md
>
> Feature spec → [F133-cicd-tracking.md](../../docs/features/F133-cicd-tracking.md)

## 概述

F133 实现了 GitHub CI/CD 执行结果自动追踪：注册 PR 后，系统每分钟轮询 CI 状态，
状态变化时自动投递通知到对话 thread。**CI 失败始终唤醒猫；CI 成功是否唤醒取决于
tracking 的 wake intent**（F140）：

- `intent=review`（默认，"我在等 review"）→ CI 成功只投递消息、**不唤醒**（你看 thread 就知道）。
- `intent=merge`（"我在等 CI 绿去 merge"）→ CI 成功**唤醒**（→ merge-gate）。

intent 在 `register_pr_tracking` 时声明、re-register 时翻转，是**任务意图、不是 repo 类型**
（私人仓也能 merge，开源仓也能只 review）。

## 架构

```
register_pr_tracking (MCP tool, 带 intent)
        │
        ▼
  TaskStore (Redis, kind=pr_tracking)  ◄── 注册 + intent + CI 状态存储（#320）
        │
        ▼
  CiCdCheckTaskSpec (scheduler poller, 60s)
        │  fetchPrCiStatus: gh pr view --json statusCheckRollup
        ▼
  CiCdRouter (去重 + 投递)
        │  fingerprint = headSha:aggregateBucket
        ▼
  deliverConnectorMessage()   ◄── 共享投递（connector: github-ci）
        │
        ├─ CI fail → ConnectorInvokeTrigger (urgent) → 唤醒猫（两种 intent 都唤醒）
        └─ CI pass → 始终投递消息；仅 intent=merge 时唤醒（normal → merge-gate）
```

## 通知格式

### CI 失败

```
❌ **CI 失败**

PR #42 (owner/repo)
Commit: `abc1234`

--- 失败的检查 (2) ---
❌ **build** — Process completed with exit code 1 [查看](https://...)
❌ **lint** — 3 errors found [查看](https://...)

请检查 CI 失败原因并修复。
```

### CI 成功

```
✅ **CI 通过**

PR #42 (owner/repo)
Commit: `abc1234`
```

## 状态迁移去重

去重基于 `fingerprint = headSha:aggregateBucket`。

| 场景 | 是否通知 | 理由 |
|------|---------|------|
| 同一 SHA + 同一 bucket（重复轮询） | ❌ 去重 | fingerprint 不变 |
| 同一 SHA，pending → fail | ✅ 通知 | bucket 变化 |
| 同一 SHA，fail → pass（修复后重跑） | ✅ 通知 | bucket 变化 |
| 新 push（SHA 变化），任何 bucket | ✅ 通知 | headSha 变化 = 新 fingerprint |

**注意**：`pending` 状态不通知，只更新 headSha 跟踪。

## Lifecycle 事件

| 事件 | 行为 |
|------|------|
| PR merged | 移除 tracking，停止轮询 |
| PR closed | 移除 tracking，停止轮询 |
| 新 push (headSha 变化) | 重置去重 fingerprint，继续追踪 |

## 配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 轮询间隔 | 60s | `CiCdCheckTaskSpec` 选项 `pollIntervalMs` |
| gh 超时 | 15s | `GH_TIMEOUT_MS`，防止 CLI 卡死 |
| CI tracking 开关 | `true` | `PrTrackingEntry.ciTrackingEnabled`，默认启用 |

## 前置条件

- `gh` CLI 已安装且已认证（`gh auth status` 可检查）
- 仓库为公开仓（无认证 60 req/h）或已认证（5000 req/h）
- 仓库有 GitHub Actions 或其他 CI 系统

**`gh` 不可用时**：优雅降级 — log warning，不 crash，跳过该 PR。

## 猫猫处理策略

### 收到 CI 失败通知

1. **读失败的检查名称和描述**（通知中已列出）
2. **点链接查看详情**（通知提供 checks URL）
3. **定位根因**：
   - build 失败 → 编译错误（看 log）
   - lint 失败 → 代码风格（修改后 push）
   - test 失败 → 回归 bug（本地复现 → 修复）
4. **修复后 push** → CiCdCheckTaskSpec 自动检测新 headSha，重新轮询

### 收到 CI 成功通知

- `intent=review`（默认）：**不会被唤醒**，只有 thread 里一条消息。你主动来看时确认 CI 绿即可。
- `intent=merge`：会被唤醒到 merge-gate —— 这是"CI 绿了，可以去 merge"的动作信号。
- 想让"等 CI 绿 merge"被唤醒，注册/重注册时传 `intent=merge`（见 merge-gate skill）。

## 与其他系统的关系

| 系统 | 关系 |
|------|------|
| ReviewRouter | 共享 `deliverConnectorMessage()` helper，但独立去重逻辑 |
| PrTrackingStore | 共享存储，CI 状态通过 `patchCiState()` 更新（不刷新 registeredAt） |
| ConnectorInvokeTrigger | CI 失败唤醒（urgent，github_ci_failure）；CI 成功仅 intent=merge 唤醒（normal，github_ci_pass，→ merge-gate） |
| merge-gate | 等 CI 绿去 merge 时注册 intent=merge，CI 成功才唤醒；merge 前自查 PR checks |
| opensource-ops | Outbound PR / Hotfix 提 PR 后自动追踪 CI 结果 |

## 开源仓 CI 门禁

在往 clowder-ai 提 PR（场景 C）或 Hotfix（场景 F）时——你是等 CI 绿就 merge：

1. **注册 PR tracking 时传 `intent='merge'`**（`cat_cafe_register_pr_tracking(..., intent='merge')`）
   → CI 自动追踪启动，且 CI **成功也会唤醒**你去 merge。
   （默认 `intent='review'` 下 CI-pass 静默，开源 merge-wait 用默认会漏掉"CI 绿了"的唤醒。）
2. **等 CI 结果**（条件性门禁）：
   - 仓库有 GitHub Actions → CI 全绿唤醒（normal）/ 失败唤醒（urgent）
   - CI 失败 → 修复后 push，等下一轮通知
   - 仓库无 Actions / 无额度 → 跳过 CI 等待，依赖本地测试
3. **CI 绿 + review 通过** → 可 merge

**注意**：这是"有条件门禁"，不是硬阻塞。没有 Actions 额度时不等 CI。
