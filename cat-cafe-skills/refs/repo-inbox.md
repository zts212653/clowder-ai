# F141: Repo Inbox — 通知格式 + 首反 SOP

> 返回 → opensource-ops SKILL.md
> Feature spec → [F141](../../docs/features/F141-github-repo-inbox.md)

## Repo Inbox 是什么

GitHub 仓库事件（新 PR、新 Issue、draft→ready）通过 webhook 自动投递到 maintainer inbox thread 的通知。猫猫收到通知后，按本文的首反 SOP 处理。

**硬规则：Repo Inbox 通知不是 FYI。**

- `Repo Inbox (reconciliation)` 和 webhook 实时通知同等处理；reconciliation 是漏网补偿，不是低优先级日志。
- 收到通知后必须打开 GitHub 原对象做首反，不能只看标题 / 摘要。
- 没有“自动处理”字段也要做 Read → Ground → Gate → Route → Record。
- 守门 thread 的职责是判断和路由；是否深度 review / merge / intake 由首反 verdict 和接球 owner 决定。
- GitHub `#NNN` issue / PR 锚点优先于 Fxxx / 技术域归类；先匹配已有 issue / PR / owner，再判断是否需要新 thread。

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

必须确认：

- body / labels / comments / authorAssociation
- 是否已有 maintainer / 猫猫实质回复
- 是否有 linked issue / linked PR，或正文里显式提到 `#NNN`（如 follow-up / found while validating）
- 作者是否表示会自提 PR
- 作者是否是活跃 contributor / collaborator，或历史上常见“先 issue 后 PR”
- PR diff 是否包含伪 Fxxx 锚点（进入 Scene B 时必查）

#### Step 1.1: Anchor Precedence — 先匹配 GitHub 编号

如果当前对象的标题 / body / comments 里出现 `#NNN`：

1. 先打开每个 referenced issue / PR，记录 state、作者、labels、comments、是否已有 maintainer 回复。
2. 如果 referenced PR 仍 open 或刚进入 review / merge-gate，它通常是优先 owner；follow-up bug 的下一步是 review / merge-gate 该 PR，不是让下游重新实现。
3. 如果 referenced issue 是总单、当前 issue 是子问题，当前 issue 归到总单 / 相关 PR 链路下，避免另投 broad feature thread。
4. 只有 GitHub 编号链路没有 owner、没有 active PR、也没有可接的 thread 时，才用 Fxxx / 技术域寻找 owner 或 propose 新 thread。

**排序规则**：active PR / accepted issue owner > existing issue/PR thread > narrow new thread > broad feature thread > CVO 决策。Fxxx 是归档 / 背景锚点，不自动等于执行 owner。

**动作规则**：active PR 存在时，Direction Card / handoff 的 next action 写
`review-existing-pr` / `merge-gate`；不要写 `fix`、`implement`、`take over`。只有 PR 方向
错误、质量退回、或作者放弃时，才把 issue 转成我们自修。

#### Step 1.2: Author Intent Gate — 高概率自提 PR 先问

如果 issue 信息充分、值得接纳，但作者是活跃贡献者 / collaborator，或历史上经常“提 issue 后
自己提 PR”：

1. 不要立刻 propose / cross-post 给内部工程 thread 修。
2. 先在 issue 里公开追问作者意图：是否计划自提 PR；如果不打算修，我们可以接手。
3. Direction Card：`路由 = external-wait`，`路由依据 = author-intent`，`下一步 = ask-author-pr-intent`，Owner 保持守门 thread 或明确指定 intake owner。
4. 等作者回复或短 SLA 到期后再分流：作者自提 PR → `review-existing-pr` / `merge-gate`；作者不修 / 超时 / 高危 bug → 内部 `fix`。

**SLA 建议**：普通 bug 24-48h；高危/阻塞安装/数据丢失不等待，直接内部 fix，同时欢迎作者后续 review / PR。

作者意图追问模板：

```markdown
Thanks for the clear report. This looks valid and we are triaging it as a bug.

Do you plan to send a PR for this one? If yes, we can wait and review your PR.
If not, we can pick it up from our side.

{猫猫签名}
```

### Step 2: Ground — 基础合法性

| 检查 | 不通过处置 |
|------|---------|
| 是 spam / bot 垃圾？ | 关闭，打 `invalid` |
| Issue 信息不足？ | 打 `needs-info` + 追问模板（见 issue-triage Step 1.5） |
| PR 无关联 accepted issue？ | 回复请先开 issue，不进入代码 review |

**PR 关键检查**：先找 linked issue。没有 accepted issue → 回到 issue-first 流程，不进入深度 code review。

### Step 3: Gate — 主人翁五问

加载 [主人翁五问判定卡](./ownership-gate.md)，逐问填写结论 + 证据。

其中 Q2（Feature 冲突检测）直接复用 Scene A 的关联检测逻辑，不另开一套搜索。

### Step 4: Route — 按 Verdict 路由

| Verdict | 动作 |
|---------|------|
| **WELCOME** | Issue → 继续 Scene A 正常 triage（Step 3+）并确定 owner；PR → 继续 Scene B Merge Gate，确定由当前 thread 处理还是交给下游 thread，并由 owner 注册 PR tracking |
| **NEEDS-DISCUSSION** | 打 `needs-maintainer-decision`，48h SLA |
| **POLITELY-DECLINE** | 礼貌回复（用 [话术模板](./ownership-gate.md#话术模板)）+ 打 `wontfix` + 关闭 |

#### Community Guard 路由规则

守门 thread 要交付的是 **Direction Card + owner 路由**，不是把所有事都自己扛住。

| 场景 | 守门动作 | 后续 owner |
|------|----------|------------|
| 明确 bug issue，无现有 PR | 标 `bug` / `triaged`，发 Direction Card（下一步=`fix`）；需要修复则 propose/cross-post 到工程 thread | 接球 thread 负责实现修复 |
| 明确 bug issue，**已有社区 PR 在修** | 标 `bug` / `triaged`，发 Direction Card（下一步=`review-existing-pr`）；cross-post **必须写明"review PR #xxx，不是重新实现"** | 接球 thread 负责 review 该 PR，不重写 |
| 明确 bug issue，作者高概率自提 PR | 标 `bug` / `triaged`，公开问作者是否自提 PR；Direction Card 下一步=`ask-author-pr-intent` | 当前守门 thread 等作者意图，或指定 intake owner |
| bug 明确是 `#NNN` issue / PR follow-up | 先打开 referenced issue / PR；若 PR active，路由为 review / merge-gate；若无 PR/owner，propose 窄 thread | PR owner / reviewer thread，或新建 issue/PR thread |
| bug 信息不足 | 标 `needs-info` / `triaged`，追问信息；当前 thread 可等待作者回复 | 当前 thread，或指定接球 thread |
| 新 feature / enhancement | 跑主人翁五问 + 关联检测；无现成锚点则 `needs-maintainer-decision` | You 或指定设计 thread |
| 已有 feature 子任务 | cross-post 到对应平行 thread，附证据和期望动作 | 目标 thread |
| PR 有 accepted issue 且方向清楚 | 进入 Inbound PR Gate；可拉 reviewer 猫评估 | PR owner thread |
| PR 无 accepted issue | 请作者先开/补 issue，不做深度 code review | 当前 thread 等 issue 首反 |
| obvious spam / 商业引流 | `invalid` + `triaged` + close | 当前 thread 收口 |

**Consult freely, decide carefully.**

- 守门猫可以自主邀请本 thread 或平行 thread 的猫评估；consult 不等于授权 merge / close / roadmap。
- 只有新 roadmap、公开承诺、支持矩阵、敏感社区关系、第三方 PR merge、跨猫冲突收不住时才升级铲屎官。
- 如果只是“社区方案有价值，但我们有更优雅方案”，默认先让猫猫做 maintainer reframing，不直接 @co-creator。

**谁接球，谁负责等待。**

- 已经 cross-post / propose-thread 分发后，外部作者 / CI / GitHub bot / review 的 hold 或事件驱动由接球 thread 负责。
- 守门 thread 只记录 `target thread / owner / next action / report-back`，不要继续替下游 hold。
- 只有当守门 thread 明确保留 owner 时，才由守门 thread 自己 `hold_ball` 或转事件驱动。

#### Direction Card（F168 台账联动）

每个 verdict 确定后，**必须发 Direction Card** 到 Inbox thread（模板见 [direction-card-template.md](./direction-card-template.md)）：
- 发 Direction Card（`cat_cafe_create_rich_block`）
- 更新台账：`PATCH /api/community-issues/:id`（directionCard + state）
- 非 bugfix：`multi_mention` 第二只猫独立评估
- 两猫卡片都到了 → 汇总 → 标记是否需要铲屎官拍板

#### PR WELCOME 后：注册 F140 追踪（F141→F140 桥接）

WELCOME 的 PR **必须有 owner 注册 PR tracking**，否则 F140 的追踪信号不会激活：

```
cat_cafe_register_pr_tracking(repoFullName, prNumber)
```

| 参数 | 来源 |
|------|------|
| `repoFullName` | Repo Inbox 通知 `source.meta.repoFullName` |
| `prNumber` | 通知 `source.meta.number` |

> **catId / threadId 由服务端自动解析**：API 从调用猫的 invocation record 取 `catId` 和 `threadId`，不接受 payload 覆盖。即：谁调用 `register_pr_tracking`，PR 就归谁追踪。

注册后 F139 调度框架自动激活 `conflict-check` + `review-feedback` poller，PR 进入 F140 追踪层。

如果守门 thread 把 PR 或 issue 交给下游 thread，Direction Card / handoff 必须写清：

- 接球 thread 负责注册 PR tracking
- 接球 thread 负责后续 CI / review feedback / conflict 的 hold 或事件驱动
- 完成后用 `cat_cafe_cross_post_message` 回报守门 thread

**cross-post 语义精度（#796 教训）**：cross-post 消息的内容必须和 Direction Card 的"下一步"字段一致。

- 下一步=`review-existing-pr` → cross-post 必须明确写 **"请 review PR #xxx，不是重新实现"**，附 PR 链接。禁止只写根因分析和修复方向——接球猫会理解为"要我修"
- 下一步=`fix` → cross-post 写清问题描述、复现路径和期望修复范围
- 下一步=`ask-info` → cross-post 写清需要追问什么、回复后谁接手

**不注册 = F140 信号沉默**：冲突不会告警，review feedback 不会投递。

### Step 5: Record — 收口

- 打 `triaged` 标签（无论 verdict 是什么）
- 互链相关 issue（如有）
- 如果问题有价值但方案被 decline → 确保问题挂到正确的 design anchor

**禁止**：inbox 只做了判断但没落状态（没打 triaged = 悬空）。

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 只看通知标题，回复“无明确指令不操作” | 首反缺失，社区 issue/PR 无人负责 | 通知本身就是首反任务；必须打开 GitHub 原对象 |
| 把 reconciliation 当普通日志 | 漏网补偿继续漏 | reconciliation 和 webhook 通知同等处理 |
| 看见 eval / scheduler / UI 关键词就直接投 Fxxx thread，跳过 `#NNN` 关联 PR | follow-up bug 被派错 owner，已有 PR review 链断裂 | 先打开 body/comment 里的 `#NNN`；active PR / issue owner 优先于 broad feature thread |
| 社区 PR 已经在修 issue，handoff 却写“请修复” | 下游猫重做实现，社区作者贡献被绕过 | active linked PR 的下一步是 review / merge-gate；只有 PR 不可用才自修 |
| 活跃 contributor 刚提 issue，就立刻内部派工 | 抢掉作者自提 PR 的空间，后续重复实现 | 先问作者是否打算 PR；Direction Card 走 `external-wait` + `ask-author-pr-intent` |
| WELCOME 后只给 verdict，不给 owner / route | 球权掉地上 | Direction Card 必填 route、owner、next action、report-back |
| 分发给下游 thread 后继续在守门 thread hold | 双 owner、重复轮询、死锁 | 谁接球谁 hold；守门 thread 只保留路由记录 |
| PR 还没 accepted issue 就深度 code review | 方向错也浪费 reviewer | 先 issue-first；无 accepted issue 不进代码 review |
| 有更优雅方案就立刻 @co-creator | CVO 变回人肉路由 | 猫猫先 maintainer reframing；只有硬决策才升级 |
| 明显 spam 仍开 thread 讨论 | 浪费协作带宽 | `invalid` + `triaged` + close |

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
