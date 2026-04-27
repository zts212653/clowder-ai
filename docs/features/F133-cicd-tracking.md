---
feature_ids: [F133]
related_features: []
topics: [github, ci-cd, connector, opensource]
doc_kind: spec
created: 2026-03-23
---

# F133: GitHub CI/CD Tracking — 已注册 PR 的 CI/CD 执行结果自动追踪

> **Status**: done | **Owner**: 金渐层 | **Priority**: P2 | **Completed**: 2026-03-25

## Why

team experience（2026-03-23 thread `ci/cd github tracking`）：

> "你看看我们现在 GitHub 的 Tracking，它能 Tracking CI/CD 的执行结果吗？"
> "这个 ci cd tracking 应该也和现在的 github 一样消息投递到我们的 channel 或者叫消息管道"
> "我们的 ci cd 基本只有月初有额度...clowder-ai 都得看 ci cd 过，发版本更是，这个 sop 流程也得好好思考"

核心场景：开源仓库 `clowder-ai` 有免费 GitHub Actions 额度，CI/CD 绿灯是发版的前提条件。自有仓库 `cat-cafe` 月初有额度时同理。当前 PR Tracking 系统只追踪 Review 通知（IMAP 邮件轮询），CI/CD 结果完全盲区——猫猫提交 PR 后不知道 CI 是否通过，需要手动去 GitHub 页面看。

## What

### 核心设计决策：消息管道复用

**KD-1: CI/CD 通知完全复用现有 Review 消息管道**，保持一致的投递体验。

现有 Review 路径：
```
IMAP 邮件 → GithubReviewMailParser → ReviewRouter.route()
  → PrTrackingStore 查注册 → threadId + catId
  → messageStore.append({ connector: 'github-review' })
  → socketManager.broadcastToRoom()  ← WebSocket 实时推到前端
  → ConnectorInvokeTrigger.trigger() ← 唤醒猫处理
```

CI/CD 路径——复用同一投递管道，独立路由器，只换数据源：
```
GitHub API 轮询 → CiCdCheckPoller (新)
  → CiCdRouter (新，独立于 ReviewRouter)
  → deliverConnectorMessage() (共享 helper)
    → messageStore.append({ connector: 'github-ci' })
    → socketManager.broadcastToRoom()
  → CI 失败 → ConnectorInvokeTrigger.trigger(priority: 'urgent')
  → CI 成功 → 不 trigger
```

复用点：
1. **ConnectorSource 协议** — 只换 `connector: 'github-ci'`，前端 ConnectorBubble 已按类型渲染不同图标
2. **投递管道** — messageStore → socket broadcast → ConnectorInvokeTrigger，抽共享 `deliverConnectorMessage()` helper
3. **注册入口** — 猫猫还是 `register_pr_tracking`，轮询只查已注册 PR
4. **只新增**：`CiCdCheckPoller` 类 + `CiCdRouter` 类 + `github-ci-bootstrap.ts`

**KD-2: 数据源选择 GitHub API 轮询（PR 级 rollup），而非 IMAP 邮件或 raw Checks API**

| | 邮件（Review 现状） | Raw Checks API | PR 级 rollup（✅ 选定） |
|---|---|---|---|
| 延迟 | 2min IMAP poll | 30s-1min | 30s-1min |
| 配置依赖 | IMAP 邮箱 + 代理 | `gh` CLI | `gh` CLI |
| 覆盖范围 | N/A | 只覆盖 Checks，**漏 commit statuses** | Checks + commit statuses 全覆盖 |
| API 成本 | N/A | 每 PR 多次（suites + runs） | **1 次 `gh pr view` 拿全** |
| 开源友好 | 差 | 好 | 好 |

**Design Gate 决策（Maine Coon 2026-03-23）**：不用 `check-suites` 或 `check-runs` 做主轮询入口。GitHub 的 CI 有两套体系（Checks API + commit statuses），raw Checks API 只覆盖前者，会漏掉仍走旧式 `commit status` 的 CI 提供方。

主轮询入口：`gh pr view <pr> -R <repo> --json headRefOid,state,mergedAt,statusCheckRollup`
- 一次请求同时拿到 `headSha`、PR 生命周期状态、聚合 CI 结果
- 需要发通知时再补一跳 `gh pr checks --required --json name,bucket,link,workflow,description` 拉失败详情
- `required` 为空时 fallback 到 all checks（未配 branch protection 的仓库）

**KD-3: 只 track 已注册 PR，零噪音**

未注册的 PR 不轮询。猫猫通过 `register_pr_tracking` 注册 PR 时，系统开始追踪该 PR 的 CI/CD 状态。注册入口不变，复用现有 MCP tool。v1 默认 `ciTrackingEnabled: true`。

**KD-5: 独立 CiCdRouter，不塞 ReviewRouter**

不要往 `ReviewRouter` 里加 CI 逻辑。现有 `ReviewRouter` 把 review 专属的去重、内容抓取（severity extraction）、格式化混在一起，硬塞 CI 会耦死两个数据源。新建独立 `CiCdRouter`，最多抽一个共享的 `deliverConnectorMessage()` helper 复用投递逻辑（messageStore.append + socket broadcast）。

**KD-6: 独立 `github-ci-bootstrap.ts`，不复用 review bootstrap**

新建 `github-ci-bootstrap.ts`，在 `index.ts` 里和 review watcher 并排启动。不复用 `github-review-bootstrap.ts` 的名字和语义，lifecycle 和日志独立。

**KD-7: PrTrackingStore 新增 `patchCiState()` 接口，不复用 `register()`**

现有 `PrTrackingStore` 只有 `register/get/remove/listAll`，没有 patch/update。CI poller 如果拿 `register()` 回写运行态状态，会整 hash 重写并刷新 `registeredAt`，把"注册"和"运行态状态更新"混成一个操作。新增 `patchCiState(repo, pr, ciFields)` 接口，只更新 CI 相关字段。

**KD-8: 状态迁移去重，不复用 ProcessedEmailStore 的时间窗口去重**

`ProcessedEmailStore` 的 5 分钟窗口去重不适合 CI。CI 需要"状态迁移去重"：同一 SHA + 同一 conclusion 只通知一次。复用时间窗口去重会吞掉合法的 `pending → fail → success` 状态迁移。去重键：`headSha + aggregateBucket`，不要把 suite/run id 放进主去重键。

### Phase A: 核心投递管道（CI/CD → Thread 消息）

1. **CiCdCheckPoller** — 新增轮询器
   - 定时扫描 PrTrackingStore 中所有活跃注册（`ciTrackingEnabled: true`）
   - 主轮询：`gh pr view <pr> -R <repo> --json headRefOid,state,mergedAt,statusCheckRollup`
   - 一次请求拿 headSha + PR lifecycle + 聚合 CI 状态
   - 需要发通知时补一跳：`gh pr checks --required --json name,bucket,link,workflow,description`
   - `required` 为空时 fallback 到 all checks
   - 轮询间隔：固定 60s（v1）；只在 gh 失败/认证失败/网络错误时退避，业务节奏不退避
   - `pending/in_progress` → 不发消息，只驱动下一轮轮询

2. **CiCdRouter** — 新增独立路由器
   - 不塞 ReviewRouter，独立处理 CI 事件的格式化和投递
   - 共享 `deliverConnectorMessage()` helper（messageStore.append + socket broadcast）
   - CI 失败 → 投递消息 + `ConnectorInvokeTrigger.trigger()` with `priority: 'urgent'`（与 review 一致，队列内优先出队；F175 修正：不再走抢占旁路）
   - CI 成功 → 投递消息，不 trigger
   - 当前决策：CI failure 直接 `urgent`（与 review 行为一致）；CI success 仍不 trigger

3. **PrTrackingStore 扩展**
   - 新增接口：`patchCiState(repo, pr, ciFields)` — 只更新 CI 相关字段，不刷新注册态
   - 新增字段：`headSha`（PR 最新 commit SHA，poll 时以 GitHub 当前值为准覆盖更新，不只在注册时拉一次）
   - 新增字段：`lastCiFingerprint`（去重键：`headSha:aggregateBucket`）
   - 新增字段：`lastCiBucket`（最后一次通知的聚合状态，用 `gh pr checks` 的 bucket 语义：pass/fail/pending，覆盖含 pending 的全状态空间）
   - 新增字段：`lastCiNotifiedAt`（最后一次 CI 通知时间戳）
   - 新增字段：`ciTrackingEnabled`（可选开关，v1 默认 true）

4. **去重机制**（状态迁移去重，非时间窗口）
   - 去重键：`headSha + aggregateBucket`（如 `abc123:fail`）
   - 同一 SHA + 同一结论只通知一次
   - SHA 变化（新 push）→ poller 自动检测 headRefOid 变化，重置去重
   - 合法状态迁移（`pending → fail → success`）不被吞掉
   - 不复用 ProcessedEmailStore 的 5 分钟窗口机制

5. **PR 生命周期管理**
   - PR `open` → 持续轮询（不在 success/failure 后停，否则漏 rerun 和新 push）
   - PR `merged/closed` → 自动调用 `PrTrackingStore.remove()`，停止轮询
   - TTL 7 天兜底（现有 RedisPrTrackingStore 已有），不做主生命周期
   - `gh` CLI 不可用时优雅降级（log + skip，不 crash）

6. **Bootstrap**
   - 新建 `github-ci-bootstrap.ts`，在 `index.ts` 里和 review watcher 并排启动
   - lifecycle 和日志独立，不复用 review bootstrap 的名字和语义

7. **测试矩阵**（Maine Coon R2 补充，必测场景）
   - T1: `open→fail→success` 同 SHA 去重 — fail 通知一次，success 通知一次，不重复
   - T2: `new push` 重置 fingerprint — SHA 变化后即使结论相同也重新通知
   - T3: `merged/closed` 自动 remove — PR 关闭后从 tracking store 移除，停止轮询
   - T4: `--required` 为空时 fallback 到 all checks — 未配 branch protection 的仓库不变成"永远无 CI"

### Phase B: Skill 文档 + 发版 SOP 闭环

1. **更新现有 Skill 文档**
   - `merge-gate/SKILL.md`：Step 6 等待 review 后加等 CI/CD 绿灯步骤
   - `opensource-ops/SKILL.md`：Outbound PR 和 Hotfix 流程加 CI/CD 检查门禁

2. **新增参考文档**
   - `refs/cicd-tracking.md`：CI/CD 通知格式、处理策略、配置说明

3. **发版 SOP 闭环**
   - clowder-ai Outbound PR：合入前需等 CI 通过
   - Release 发版：tag 前需确认 CI/CD 全绿
   - Hotfix：cherry-pick PR 也需 CI 验证

### Phase C（待定）: Review 也迁移到 API 轮询

未来可能将 Review 通知也从 IMAP 迁移到 GitHub API 轮询，彻底摆脱 IMAP 依赖。这需要评估 GitHub API rate limit 影响，暂列为 Open Question。

## Acceptance Criteria

### Phase A（核心投递管道）
- [x] AC-A1: 注册 PR 后，CI 失败自动投递消息到原始 thread（connector: `github-ci`）
- [x] AC-A2: CI 失败消息自动唤醒猫（ConnectorInvokeTrigger, priority: `urgent`，队列内优先出队；F175 修正：不再打断正在进行中的执行）
- [x] AC-A3: CI 成功投递消息但不唤醒猫
- [x] AC-A4: 状态迁移去重 — 同一 headSha + 同一 aggregateBucket 只通知一次
- [x] AC-A5: 合法状态迁移（pending → fail → success）不被吞掉
- [x] AC-A6: 未注册 PR 不轮询，零噪音
- [x] AC-A7: `gh` CLI 不可用时优雅降级（log + skip，不 crash）
- [x] AC-A8: PR merged/closed 自动停止轮询并 remove tracking
- [x] AC-A9: 新 push（headSha 变化）自动重置去重，继续追踪
- [x] AC-A10: PrTrackingStore.patchCiState() 不刷新 registeredAt
- [x] AC-A11: 测试覆盖：CiCdCheckPoller + CiCdRouter 单元测试（轮询、去重、投递、lifecycle）

### Phase B（Skill 文档 + SOP）
- [x] AC-B1: ~~merge-gate SKILL.md 包含等 CI 绿灯步骤~~ → **N/A**（team lead确认：只在有 Actions 额度时才有意义，暂缓。转 OQ 待 Phase C 时重新评估）
- [x] AC-B2: opensource-ops SKILL.md 的 Outbound PR / Hotfix 流程含 CI 门禁
- [x] AC-B3: refs/cicd-tracking.md 新增（通知格式、配置、处理策略）

## Dependencies

- **Evolved from**: 现有 GitHub Review Email Watcher 系统（#81 ReviewRouter / ConnectorInvokeTrigger / PrTrackingStore）
- **Related**: Issue #668（ReviewRouter fallback 清理，已完成）
- **Related**: Issue #669（本 Feature 升级自此 issue）
- **Blocked by**: 无

## Risk

| 风险 | 缓解 |
|------|------|
| GitHub API rate limit（公开仓 60/h，认证 5000/h） | 只轮询已注册 PR；`gh auth` 认证后 5000/h 足够；主查询 1 次/PR/min |
| `gh` CLI 未安装或未认证 | 启动时检测，优雅降级（log warning，不 block） |
| 开源用户无 GitHub Actions（私有仓无免费额度） | 只对有 CI 的仓库生效，无 CI = 无通知（符合预期） |
| Check suite 状态转换复杂（pending → in_progress → completed） | 只关心聚合 rollup 的 bucket（pass/fail/pending），忽略细粒度中间状态 |
| fork push 的 Checks API 有已知 caveat | 用 PR 级 rollup 而非 SHA 级 Checks API，更稳定 |
| PrTrackingStore.register() 回写 CI 状态会刷新 registeredAt | 新增 patchCiState() 接口，只更新 CI 字段 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | CI/CD 通知复用现有 Review 消息管道（messageStore → socket → trigger） | 投递体验一致；不需要新建管道；ConnectorSource 协议已支持 | 2026-03-23 |
| KD-2 | 数据源用 PR 级 rollup（`gh pr view --json statusCheckRollup`），不用 raw Checks API | 一次请求拿 headSha + lifecycle + 聚合状态；覆盖 Checks + commit statuses 两套体系；Maine Coon Design Gate 提出 | 2026-03-23 |
| KD-3 | 只 track 已注册 PR | 零噪音；复用现有 register_pr_tracking 入口 | 2026-03-23 |
| KD-4 | CI 失败唤醒猫（priority: urgent），CI 成功只投递消息 | 与 `github-review` 行为归一；失败消息通过队列内优先级排序（而非抢占旁路）优先出队（F175 修正：urgent 语义从"抢占"改为"队首优先级"） | 2026-03-24 |
| KD-5 | 独立 CiCdRouter，不塞 ReviewRouter | ReviewRouter 把 review 专属的去重/内容抓取/格式化混在一起，硬塞 CI 会耦死两个数据源；抽共享 deliverConnectorMessage() helper | 2026-03-23 |
| KD-6 | 独立 github-ci-bootstrap.ts | lifecycle 和日志独立，不复用 review bootstrap 语义 | 2026-03-23 |
| KD-7 | PrTrackingStore 新增 patchCiState()，不复用 register() | register() 会整 hash 重写并刷新 registeredAt，把注册和运行态状态更新混成一个操作 | 2026-03-23 |
| KD-8 | 状态迁移去重（headSha + aggregateBucket），不复用 ProcessedEmailStore 时间窗口 | 5min 窗口会吞掉合法的 pending → fail → success 迁移；CI 需要按状态变化去重 | 2026-03-23 |

## Design Gate 讨论归档

**参与者**: 金渐层 (@opencode) + Maine Coon (@gpt52, GPT-5.4)
**Thread**: `thread_mn2krkok6nflpavy`（ci/cd github tracking）
**日期**: 2026-03-23

**Maine Coon核心贡献**:
1. 发现 raw Checks API (`check-suites/runs`) 只覆盖 Checks，会漏 commit statuses → 改用 PR 级 `statusCheckRollup`
2. 提出 `PrTrackingStore` 缺少 patch/update 接口 → 新增 `patchCiState()`
3. 发现 `ProcessedEmailStore` 5min 窗口去重不适合 CI 状态迁移 → 改用 `headSha + aggregateBucket` 去重
4. 建议独立 `CiCdRouter` + 独立 bootstrap，不塞 ReviewRouter
5. Design Gate 建议 CI failure trigger 用 `normal`；后续经team lead确认，升级为 `urgent` 以与 review 优先级行为归一（F175 修正：urgent 语义为队列内优先出队，不再走抢占旁路）
6. 强调 headSha 必须 poll 时覆盖更新，不能只注册时拉一次
7. PR lifecycle: open 持续轮询，merged/closed 才停
8. required checks 为空时 fallback 到 all checks

**Maine Coon R2 补充**:
9. 字段命名：用 `lastCiBucket`（`gh pr checks` 的 bucket 语义 pass/fail/pending），不用 `lastCiConclusion`（覆盖含 pending 的全状态空间）
10. 必测场景矩阵：T1 同 SHA 去重、T2 new push 重置、T3 merged/closed remove、T4 required 为空 fallback

## Review Gate

- Phase A: Maine Coon review（coding 落地 + test 覆盖）
- Phase B: team lead确认 SOP 流程变更
