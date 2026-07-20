# Review Request: PR / Issue tracking 游标与唤醒语义修复

Review-Target-ID: `fix-1053-1153-issue-tracking`
Branch: `fix/1053-1153-issue-tracking`
Implementation SHA: `84a65eab79a1bef6bc6941186001508b5047526f`
Review target: branch HEAD at intake（implementation 的 docs-only child；精确 SHA 由 A2A handoff 提供）
Base: `origin/main@b0dc94603ecfd233d735c542bf040b63686f5160`
Reviewer: `@Fable`

## What

- #1053：新注册 PR tracker 的 review comment / decision cursor 固定从 0 开始；删除注册阶段三类历史 feedback 预取，只保留当前 CI boundary。
- #1153：显式 issue tracking 投递所有非 echo 评论，不再因 `OWNER` / `MEMBER` 身份静默；`authorAssociation` 仍保留给 community projection。
- issue 消息路由后等待 `ConnectorInvokeTrigger` 的即时接纳结果；只有 `dispatched` / `enqueued` 更新 `lastNotifiedAt`，`full` / reject / 缺失 trigger 结构化报错。
- 新增 bug diagnosis capsule 与旧实现必红、修复后转绿的回归测试。

## Why

PR 注册边界把“GitHub 当前最大 ID”误当成“系统已处理边界”，导致注册前 feedback 永久被 `id > cursor` 排除。Issue tracking 则把社区状态投影用的仓库角色策略误用于用户显式订阅，并在 fire-and-forget wake 产生结果前就把状态写成已通知；实际事故评论是 `OWNER`，因此被稳定静默。

## Original Requirements（必填）

> “看看这两个问题都是什么原因的；然后基于最新的main分支 按照标准流程开worktree fix下了；然后fable来review完提pr的”

- 来源：当前协作 thread `thread_mrripygpb2of0n7s`，消息 `0001784449895067-004167-c96db10c`；问题细节见 `docs/bug-report/issue-tracking-delivery-cursors/bug-report.md`、GitHub #1053 / #1153。
- 请对照上述要求和两条 issue 的用户可见故障判断实现是否真正恢复 feedback / owner wake 语义。

## Tradeoff

- #1053 只把 **PR** review cursors 改为 0。Issue 注册仍用当前最大 comment ID：这是后续 operator 已确认的范围决策（thread `thread_mr0474j595fpndoz`，消息 `0001782815860343-000074-ba73392d` / `0001782815909663-000081-73a7b1cd`），避免成熟 issue 首次注册时历史讨论洪泛。
- trigger 返回 `full` / reject 时，connector message 已经持久化到 thread。实现推进 routed cursor 以避免下一轮重复发消息，但不更新 `lastNotifiedAt`，并 fail loud；没有新造一条 feature-specific retry queue。
- 未运行独立 fresh-context 预扫：当前 author session 不满足“未参与开发”的前提，也不把形式自审冒充新鲜上下文。Fable 对目标 SHA 的正式 review 是独立视角且仍是唯一放行来源。

## Architecture Ownership（必填）

Architecture cell: `community-ops` + `dispatch`
Map delta: `none`
Why: 只修正既有 activity-signal 双游标、显式 tracking 过滤边界与 `ConnectorInvokeTrigger` outcome 消费；没有新增 Store / Queue / Router / Adapter / Dispatcher / Binding，也未改变 canonical owner 或 extension point。

请 reviewer 检查：

- `Map delta: none` 是否与实际 diff 一致；
- delivery cursor 表达“已路由 / echo 已处理”、`lastNotifiedAt` 表达“wake 已接受”的分离是否在 open / closed issue 路径都成立；
- 是否误把 community `decideDelivery()` 从投影状态机中删除（预期仅从显式 issue notification path 移除）；
- 是否存在越过 `ConnectorInvokeTrigger`、新造并行 queue 或破坏 cursor 单调性的路径。

## Open Questions

### 技术 OQ（给 reviewer）

1. PR review cursor=0、CI boundary 保持现值的 helper 是否精确覆盖 inline / conversation / review decision，而不会重复 CI 状态？
2. 实际事故中的 `OWNER` 评论现在是否必然进入 work item、route 和 trigger，echo 仍能被抑制且不伪造通知时间？
3. `dispatched` / `enqueued` / `full` / reject / missing-trigger 五类结果的 cursor、`lastNotifiedAt`、日志语义是否一致？特别检查 closed issue 最终批次。
4. message 已持久化但 wake 未接受时推进 routed cursor 的去重取舍，是否符合现有 dispatch ownership，还是已有可复用的无重复 wake-retry 机制被遗漏？

### 价值 OQ（给 operator，如有）

无。Issue 历史 cursor 的范围已由后续 operator 指令确定；本次不重开该价值决策。

## Next Action

请 Fable 在独立 detached sandbox 对 A2A handoff 中给出的 branch HEAD 做正式跨个体 review。每个 finding 给 P1 / P2 / P3 和明确立场；无 P1/P2 时请明确 `APPROVE` 并写覆盖的完整 SHA。通过后 author 才 push 并创建上游 PR。

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/fix-1053-1153-issue-tracking/Fable`
- Checkout: `git worktree add --detach /tmp/cat-cafe-review/fix-1053-1153-issue-tracking/Fable <review-head-sha-from-handoff>`
- Start Command: 不需要启动服务；这是 backend scheduler / cursor 修复。
- Ports: `none`。不得访问运行实例 3001 / 3002 或 Redis 6099；测试显式用隔离 Redis 6398。

### 沙盒 Bootstrap

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api run build
```

## 自检证据

### Spec 合规

- 分支从当时最新 `origin/main@b0dc94603ecf` 创建，开发、测试、文档均在同一 feature worktree 完成。
- #1053 的 PR cursor scope 与后续 operator 决策一致；issue cursor 保持成熟语义并有显式测试。
- #1153 的事故评论 `4965951215` 经 GitHub API 核实为 `OWNER`，旧 delivery policy 会精确静默它；修复后 OWNER / MEMBER 非 echo 评论均投递。
- 没有修改运行 worktree、运行配置或持久化数据；所有验证使用进程内 store / 临时 test home / Redis 6398。

### 测试结果

```bash
# 最高风险回归链（最终微调后复跑）
env REDIS_URL=redis://localhost:6398 pnpm --filter @cat-cafe/api build
node --test packages/api/test/github-comment-cursors.test.js \
  packages/api/test/f168-phase-b-dual-cursor.test.js \
  packages/api/test/f202-phase2-d.test.js
# 54 passed, 0 failed

# 相关 tracking / callback / projection 回归
node --test packages/api/test/f168-phase-b-auto-tracking.test.js \
  packages/api/test/f168-phase-b-endpoint-await-external.test.js \
  packages/api/test/f168-phase-b-awaiting-external.test.js \
  packages/api/test/f168-phase-b-dual-cursor.test.js \
  packages/api/test/f168-phase-b-review-feedback-event-log.test.js \
  packages/api/test/f168-phase-b-review-feedback-delivery.test.js \
  packages/api/test/f202-phase2-d.test.js \
  packages/api/test/github-comment-cursors.test.js \
  packages/api/test/github-schedule-factories.test.js \
  packages/api/test/review-feedback-router.test.js \
  packages/api/test/scheduler/review-feedback-spec.test.js
# 221 passed, 0 failed

pnpm check
pnpm lint
pnpm -r --if-present run build
env REDIS_URL=redis://localhost:6398 pnpm --filter @cat-cafe/api run test:public
# 16,650 tests; 16,622 pass, 0 fail, 28 skip

git diff --check
```

- `pnpm check`、`pnpm lint`、recursive build、`git diff --check` 均通过；web build 只有既有 warning。
- 根目录聚合 `pnpm test` 会命中上游 checkout 不包含的 fork-private governance pack / scripts / docs，属于基线缺失；公开 API 全量门禁已完整通过。
- fork-private `check-hotfix-pattern` / `check-fallback-layers` / `check:architecture-ownership` 脚本在 upstream main 不存在，未伪报为已运行。人工 audit 结论：新增 outcome 分支分别对应 missing trigger、exception、queue full、accepted wake，不是同类 fallback 堆叠。

### 相关文档

- Bug report: `docs/bug-report/issue-tracking-delivery-cursors/bug-report.md`
- Architecture: `docs/architecture/ownership/cells/community-ops.md`, `docs/architecture/ownership/cells/dispatch.md`
- Issue truth: GitHub #1053 / #1153；后续 scope decision 见上文 thread anchors。

[砚砚/GPT-5.6 Sol🐾]
