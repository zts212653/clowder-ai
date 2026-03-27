# F141: Repo Inbox — 通知格式 + 首反 SOP

> 返回 → [opensource-ops SKILL.md](../opensource-ops/SKILL.md)
> Feature spec → [F141](../../docs/features/F141-github-repo-inbox.md)

## Repo Inbox 是什么

GitHub 仓库事件（新 PR、新 Issue、draft→ready）通过 webhook 自动投递到 maintainer inbox thread 的通知。猫猫收到通知后，按本文的首反 SOP 处理。

## 通知格式

Repo Inbox 通知通过 `deliverConnectorMessage()` 投递，ConnectorSource 为 `github-repo-event`。

通知包含：
- 事件类型（`pull_request.opened` / `issues.opened` / `pull_request.ready_for_review`）
- 仓库名
- 对象编号（PR # / Issue #）
- 标题
- 作者
- 是否首次贡献者

## 首反 SOP: Read → Ground → Gate → Route → Record

收到 Repo Inbox 通知后，**不要直接进入深度 review**。按以下顺序处理：

### Step 1: Read — 读原始对象

不只看 inbox 摘要，打开 GitHub 原对象：

```bash
# Issue
gh issue view {N} --repo {owner/repo}

# PR
gh pr view {N} --repo {owner/repo}
```

### Step 2: Ground — 基础合法性

| 检查 | 不通过处置 |
|------|---------|
| 是 spam / bot 垃圾？ | 关闭，打 `invalid` |
| Issue 信息不足？ | 打 `needs-info` + 追问模板（见 [issue-triage](./opensource-ops-issue-triage.md) Step 1.5） |
| PR 无关联 accepted issue？ | 回复请先开 issue，不进入代码 review |

**PR 关键检查**：先找 linked issue。没有 accepted issue → 回到 issue-first 流程，不进入深度 code review。

### Step 3: Gate — 主人翁五问

加载 [主人翁五问判定卡](./ownership-gate.md)，逐问填写结论 + 证据。

其中 Q2（Feature 冲突检测）直接复用 Scene A 的关联检测逻辑，不另开一套搜索。

### Step 4: Route — 按 Verdict 路由

| Verdict | 动作 |
|---------|------|
| **WELCOME** | Issue → 继续 Scene A 正常 triage（Step 3+）；PR → **注册追踪** + 继续 Scene B Merge Gate |
| **NEEDS-DISCUSSION** | 打 `needs-maintainer-decision`，48h SLA |
| **POLITELY-DECLINE** | 礼貌回复（用 [话术模板](./ownership-gate.md#话术模板)）+ 打 `wontfix` + 关闭 |

#### PR WELCOME 后：注册 F140 追踪（F141→F140 桥接）

WELCOME 的 PR **必须注册 PR tracking**，否则 F140 的追踪信号不会激活：

```
cat_cafe_register_pr_tracking(repoFullName, prNumber)
```

| 参数 | 来源 |
|------|------|
| `repoFullName` | Repo Inbox 通知 `source.meta.repoFullName` |
| `prNumber` | 通知 `source.meta.number` |

> **catId / threadId 由服务端自动解析**：API 从调用猫的 invocation record 取 `catId` 和 `threadId`，不接受 payload 覆盖。即：谁调用 `register_pr_tracking`，PR 就归谁追踪。

注册后 F139 调度框架自动激活 `conflict-check` + `review-feedback` poller，PR 进入 F140 追踪层。

**不注册 = F140 信号沉默**：冲突不会告警，review feedback 不会投递。

### Step 5: Record — 收口

- 打 `triaged` 标签（无论 verdict 是什么）
- 互链相关 issue（如有）
- 如果问题有价值但方案被 decline → 确保问题挂到正确的 design anchor

**禁止**：inbox 只做了判断但没落状态（没打 triaged = 悬空）。

## Webhook 配置指南

### 前置条件

- GitHub 仓库的 admin 权限
- 公网可达的 webhook endpoint（ngrok / cloudflare tunnel / 部署环境）

### 配置步骤

1. 进入仓库 Settings → Webhooks → Add webhook
2. Payload URL: `https://{your-domain}/api/connectors/github-repo-event/webhook`
3. Content type: `application/json`
4. Secret: 配置 webhook secret（用于 `X-Hub-Signature-256` 校验）
5. 选择事件：
   - `Pull requests`（覆盖 `pull_request.opened` + `pull_request.ready_for_review`）
   - `Issues`（覆盖 `issues.opened`）
6. 保存

### 环境变量（三个全配才启用）

| 变量 | 说明 | 示例 |
|------|------|------|
| `GITHUB_WEBHOOK_SECRET` | webhook secret（同 GitHub 配置页的 Secret） | `whsec_xxx` |
| `GITHUB_REPO_ALLOWLIST` | 逗号分隔的授权仓库列表 | `zts212653/cat-cafe,zts212653/clowder-ai` |
| `GITHUB_REPO_INBOX_CAT_ID` | 收件猫 ID（所有 inbox 通知发给这只猫） | `cat-maine-coon` |

三个变量 + Redis 全部配置后，`GitHubRepoWebhookHandler` 才注册到 webhook 路由。

### 故障恢复

webhook 不保证 exactly-once 投递。F141 Phase B 的 Reconciliation 扫描（`RepoScanTaskSpec`）作为补偿机制，低频扫描发现 webhook 漏掉的事件。
