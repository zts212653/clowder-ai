---
feature_ids: [F141]
related_features: [F140, F133, F139]
topics: [github, webhook, repo-inbox, issue-discovery, pr-discovery, opensource]
doc_kind: spec
created: 2026-03-26
---

# F141: GitHub Repo Inbox — 仓库事件自动发现

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

## 三层架构定位

```
① F141 发现层 (Repo Inbox) → "仓库里来了新东西"（本 Feature）
② 认领层 (Triage)           → "谁来跟？"（register_pr_tracking）
③ F140 追踪层 (PR Signals)  → "这个 PR 现在怎么样了？"（F139 轮询）
```

**产品域命名**：GitHub Automation > GitHub Repo Inbox > F141

## Why

team experience（2026-03-26 thread `F140 讨论`）：

> "你看之前的猫猫是如何知道什么时候要挂PR，什么时候要挂CICD的...有的应该是你们主动注册关注哪个 PR 或者 issue 但是有的又是怎么样的？被通知吗？还是都是要主动注册？"

Maine Coon分析（GPT-5.4）：

> "基本靠team lead/maintainer 人肉发现，再把球传给我们...当前最大缺口不是 tracked PR 的后续信号，而是我们根本不知道仓库里来了一个新的外部 PR / Issue"

**现状 Gap**：
- F133/F140 解决的是"已注册 PR 后续发生了什么"（追踪层）
- 但 maintainer 最痛的是"有个新东西出现了，系统完全没感知"（发现层）
- 社区 contributor 不用 Cat Café，不会调 `register_pr_tracking`
- 新 PR / 新 Issue 全靠team lead人肉当 webhook

## What

### Phase A: GitHub Webhook Adapter + Repo Inbox 投递 ✅

**1. GitHubRepoWebhookHandler**（实现 `ConnectorWebhookHandler` 接口）
- 复用现有 `POST /api/connectors/:connectorId/webhook` 通用端点
- handler id = connector source id = **`github-repo-event`**（KD-12：三处统一）
- 校验：`X-Hub-Signature-256` HMAC-SHA256（**基于 raw body + timingSafeEqual**，KD-11）
- `X-GitHub-Event` header 过滤：只处理 `pull_request`（opened/ready_for_review）和 `issues`（opened）
- **repo allowlist**：`GITHUB_REPO_ALLOWLIST` 环境变量过滤非授权仓库
- `X-GitHub-Delivery` id 去重：**Redis SET NX EX + claim/confirm/rollback**（KD-13）
- 事件归一化为 `RepoInboxSignal`

**2. 覆盖的 GitHub 事件**
- `pull_request.opened` — 新 PR 出现
- `issues.opened` — 新 Issue 出现
- `pull_request.ready_for_review` — draft → ready

**3. 投递路径**
```
GitHub webhook POST → /api/connectors/github-repo-event/webhook
  → raw body 提取（Fastify rawBody 配置）
  → HMAC-SHA256 签名校验（raw body + timingSafeEqual）
  → repo allowlist 检查
  → Redis delivery id claim（SET NX EX）
  → 归一化 RepoInboxSignal
  → ConnectorThreadBindingStore 查 per-repo inbox thread（无则创建）
  → deliverConnectorMessage()（mention GITHUB_REPO_INBOX_CAT_ID）
  → invokeTrigger.trigger()（唤醒猫执行 triage，KD-17）
  → Redis delivery id confirm
  → 猫收到通知 → 主人翁五问 triage → 认领 → register_pr_tracking → F140
```

**4. ConnectorSource 注册**
- `github-repo-event`：仓库事件 connector（GitHub 品牌色 #24292e）
- `sender`: `{ id: String(sender.id), name: sender.login }`（GitHub actor）
- `meta` 最小集：`repoFullName, subjectType(pr|issue), number, action, deliveryId, authorAssociation`
- `url`: GitHub PR/Issue 页面链接

**5. Thread 绑定**
- **per-repo 专用 "Repo Inbox" thread**（KD-14）
- 复用 `ConnectorThreadBindingStore`：`connectorId=github-repo-event`, `externalChatId=owner/repo`
- 首次事件自动创建 thread，标题 `Repo Inbox · {owner/repo}`
- thread owner = 真实 maintainer userId（不造 system thread）

**6. Cat Mention**
- Phase A：`GITHUB_REPO_INBOX_CAT_ID` 环境变量指定收件猫（KD-16）
- 单点收件，triage 后在 thread 内 handoff

**7. Skill/SOP 更新**
- `opensource-ops` SKILL.md：maintainer 收到 Repo Inbox 通知后的 triage 流程
- `refs/repo-inbox.md`：新增——Repo Inbox 通知格式、webhook 配置指南

### Phase B: Reconciliation 补偿扫描

**1. RepoScanTaskSpec**（基于 F139 TaskSpec_P1，Phase 1a/1b 已 merged）

按 F139 已有 consumer 模式（CiCdCheckTaskSpec、ConflictCheckTaskSpec 等）构建：

| 维度 | 设计 |
|------|------|
| **profile** | `poller`（同其他 repo-watcher 任务） |
| **trigger** | `interval: 300_000`（5min，低频补偿即可） |
| **gate** | `gh api` 查 open PRs/Issues → 过滤已通知（delivery id 去重表）→ 返回 `WorkItem<RepoInboxSignal>[]` |
| **subjectKey** | `repo-{owner/repo}#{type}-{number}`（如 `repo-zts212653/clowder-ai#pr-259`） |
| **execute** | `deliverConnectorMessage()` 投递到 inbox thread（与 Phase A 共用投递路径） |
| **actor** | `role: 'repo-watcher'`, `costTier: 'cheap'` |
| **outcome** | `whenNoSignal: 'record'`（记录空闲周期，可观测） |

**去重关键**：Phase A webhook 已投递的事件通过 delivery id 去重表排除，reconciliation 只补发漏网之鱼。

## Acceptance Criteria

### Phase A（Webhook Adapter + Repo Inbox）✅
- [x] AC-A1: GitHub webhook `pull_request.opened` 事件自动投递到 maintainer inbox thread
- [x] AC-A2: GitHub webhook `issues.opened` 事件自动投递
- [x] AC-A3: GitHub webhook `pull_request.ready_for_review` 事件自动投递
- [x] AC-A4: `X-Hub-Signature-256` 签名校验通过才处理
- [x] AC-A5: `X-GitHub-Delivery` delivery id 去重
- [x] AC-A6: ConnectorSource `github-repo-event` 注册，ConnectorBubble 正确渲染
- [x] AC-A7: 投递走 deliverConnectorMessage() 统一消息管线
- [x] AC-A8: 测试覆盖：GitHubWebhookAdapter 单元测试
- [x] AC-A9: opensource-ops SKILL.md 更新 triage 流程
- [x] AC-A10: refs/repo-inbox.md 新增（含 webhook 配置指南）

### Phase B（Reconciliation）✅
- [x] AC-B1: RepoScanTaskSpec 注册为 F139 TaskSpec_P1 consumer（profile=poller, actor=repo-watcher）
- [x] AC-B2: gate 查 open PRs/Issues，过滤已通知对象，返回 typed signal
- [x] AC-B3: webhook 丢失事件后，reconciliation 补发通知（与 Phase A 共用 deliverConnectorMessage）
- [x] AC-B4: run ledger 记录每次扫描结果

## Dependencies

- **Sibling**: F140（PR Signals 追踪层——认领后进入 F140）
- **Related**: F133（CI Signals——追踪层的一部分）
- **Related**: F139（TaskSpec 框架——Phase B reconciliation 使用）— **Phase 1a/1b 已 merged，TaskSpec_P1 可用**
- **Infra**: `POST /api/connectors/:connectorId/webhook`（通用 webhook 端点——复用传输层）

## Risk

| 风险 | 缓解 |
|------|------|
| GitHub webhook 配置需要 public URL | 文档引导 ngrok / cloudflare tunnel 方案；Phase B reconciliation 作为 fallback |
| webhook 丢事件（GitHub 不保证 exactly-once） | Phase B reconciliation 补偿扫描 |
| Phase B 只投递到已有 inbox thread 的 repo | 设计边界：Phase B 是"补偿"不是"替代"。若某 repo 从未收到 webhook（Phase A 未创建 binding），Phase B 跳过并 warn log。覆盖该场景需 Phase C 扩展 |
| GitHub 不是 chat connector，语义不同 | 不硬塞 chat gateway 语义，独立 webhook handler |
| Fork 仓库的 webhook 权限 | 只配置在我们 maintain 的仓库上 |
| 多仓库事件量大 | 只转发 opened/ready_for_review 事件，其余 skip |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Webhook 做主发现入口，定时扫描只做补偿 | 零延迟、精确、省 API 额度；扫描适合已知对象状态轮询，不适合新事件发现 | 2026-03-26 |
| KD-2 | 复用通用 webhook 端点传输层，不复用 chat connector 语义 | GitHub 不是 chat connector，repo 事件需先进 inbox 再路由，与 Feishu/Telegram 绑定模型不同 | 2026-03-26 |
| KD-3 | Issue discovery 和 PR discovery 在同一个 Repo Inbox | 都是"仓库新事件"，统一发现层 | 2026-03-26 |
| KD-4 | 独立立项不合并进 F140 | F140 = 追踪层（已注册 PR 信号），F141 = 发现层（新事件感知），不同抽象层级；team lead确认分开立项 | 2026-03-26 |
| KD-5 | 投递走 deliverConnectorMessage() 统一消息管线 | 与 F133/F140 体验一致，复用基础设施 | 2026-03-26 |
| KD-6 | 主人翁五问 Gate 作为 triage 质量门禁 | team lead明确指出猫猫默认倾向接纳是大问题；fail-closed 设计对冲接纳偏向 | 2026-03-26 |
| KD-7 | Fail-closed 默认：无证据 = 不通过，unknown 不能进 WELCOME | 三猫讨论共识，防止形式主义打勾 | 2026-03-26 |
| KD-8 | Scene B Merge Gate 重排：方向(五问) 在质量之前 | 家规 P3"方向正确 > 速度"——方向错的 PR 不值得花时间审代码 | 2026-03-26 |
| KD-9 | 拒绝"方案"不否定"问题"：decline PR ≠ 否定底层问题 | 社区温度 + 问题仍挂 design anchor 追踪 | 2026-03-26 |
| KD-10 | Phase B RepoScanTaskSpec 复用 F139 已有 poller consumer 模式 | F139 Phase 1a/1b 已 merged，4 个 consumer 验证了模式；repo-watcher + cheap 与 cicd-check 一致 | 2026-03-26 |
| KD-11 | HMAC 签名校验需要 raw body：扩展 ConnectorWebhookHandler 接口加 `rawBody?: Buffer` | Maine Coon P1：GitHub 签名对原始字节流签名，parsed JSON stringify 不可靠 | 2026-03-26 |
| KD-12 | handler id / source id / registry 三处统一为 `github-repo-event` | Maine Coon P1：通用 webhook route 要求 URL connectorId = 已注册 connector，不能拆名字 | 2026-03-26 |
| KD-13 | delivery id 去重用 Redis SET NX EX + claim/confirm/rollback 语义 | Maine Coon P1：内存 Map fire-and-forget 会在投递失败时毒死 GitHub retry | 2026-03-26 |
| KD-14 | per-repo inbox thread 用 ConnectorThreadBindingStore 持久绑定 | Maine Coon P2：不能靠标题猜线程，重启后会长垃圾 thread | 2026-03-26 |
| KD-15 | transport dedup（delivery id）和 business dedup（Phase B reconciliation）分开存储和 key | Maine Coon安全审查：两个问题域，不该复用 | 2026-03-26 |
| KD-16 | Phase A cat mention 用配置 `GITHUB_REPO_INBOX_CAT_ID`，不做 actor.role 解析 | Maine Coon建议：先单点收件，triage thread 里再 handoff | 2026-03-26 |
| KD-17 | deliver 后必须 `invokeTrigger.trigger()` 触发猫执行 | Maine Coon(codex) P1：deliverConnectorMessage 只落消息+广播，不触发猫调用；不加 trigger = 通知沉没 | 2026-03-26 |
| KD-18 | `github-repo-event` 必须注册到 shared connector registry + env-registry.ts | Maine Coon(codex) P1+P2：未注册会被 404 拦；env vars 注册后运营可见 | 2026-03-26 |
| KD-19 | ConnectorBubble 前端需新增 `github-repo-event` 图标分支 | Maine Coon(codex) P2：否则显示成文本 fallback | 2026-03-26 |
| KD-20 | 首次事件并发创建 inbox thread 需加 repo 级短锁（compare-and-bind） | Maine Coon(codex) P2：防并发重复创建线程 | 2026-03-26 |

## Review Gate

- Phase A: Maine Coon (codex/gpt52) cross-family review
- Phase B: Maine Coon (codex/Spark) cross-family review — P1 pushback accepted, P2 fixed
