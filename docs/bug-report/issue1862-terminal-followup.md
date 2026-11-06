# #1862：prestart 失败回传与 caller 通知退休

## 原始约定与现状

- 原题：[issue #1862](https://github.com/zts212653/clowder-ai/issues/1862)。确定性启动前失败必须留下唯一 `delivery_failure`、结算精确 dispatchRef，并持久入队一次原 caller 的私有通知；临时失败保留重试。
- 本轮授权：`thread_owned_dfd9f48f6407a83c7fb2c51620e16c78c7d1b184#0001793955668365-000017-99ac3613`。与鲸鲸检查最新 next，避免重复工作；存在残余则隔离 worktree 修复并提 PR。
- 复核基线：`next@43c1c3cb7e4e2ba0285c993d5cc5bd016824a663`。
- #1871 已合入（`f8a09132d1439495fe371552827cbfade0f4d8ff`），闭合原报的执行绑定准入拒绝；#1862 已关闭。#1849 处理 ACP 环境快照触发因素，与此交付契约分属两层。

鲸鲸独立核对后发现两条可复现的残余，本补丁保留原修复，仅补齐以下路径。

## 失败路径与改动

1. A2A carrier 在 tracker 启动前因 `control_plane_unavailable`、`execution_owner_lost` 或 `prestart_timeout` 失败：原实现只写 History 失败和观察记录，没有 durable caller wake。现在同一个未结算 group 一次提交一条 canonical `delivery_failure`、N 个精确 settled dispatchRef 和一个原 caller wake；每个 ref 指向该 group 结果。原 binding rejection 仍按单目标结算，不改变 #1871 的结果粒度。
2. 原 caller 的 `a2a_failure` 私有 carrier 遇到确定性执行绑定拒绝：没有公开 messageId，旧分支跳过结算，将同一通知反复退回队列。现在先持久化 `InvocationRecord.error` 的 `a2a_failure_undeliverable:<failureId>:<reason>` 诊断，再退休该已 claim 的私有通知。诊断失败保留通知；诊断成功但退休失败可恢复重试。不新增失败链或伪造 response。

`processing` 是进程内投影，`commitClaimedProcessing` 已从持久队列退休目标、移除 claim。因此失败事务支持两种所有权证据：当前 claim 包含整个 cohort，或整个 cohort 都已退出原队列。两种验证都在内存事务 / Redis Lua 内完成；仍在队列的任一目标都阻止退休分支提交。同一 source 的其他 pending target 保留，已有 dispatchRef 不能被失败结算覆盖。group 幂等键使用排序后的完整 target set，重放不依赖数组顺序。

成功 sibling 已有 dispatchRef 时先排除；事务冲突后只在确实出现新 dispatchRef、cohort 严格缩小时重读并重试，不对其他冲突盲目重试。事务确认丢失后，可从已有 settled refs 恢复本进程内的 caller wake 投影。

终态拒绝后的路由 `done` 收尾帧不再把已提交的 admission failure 误记为 invocation 成功。取消、临时 bootstrap 不可用、可重试绑定冲突沿用既有行为。

## 范围与风险

- Architecture cell：`dispatch`、`bubble-pipeline`；Map delta：none，责任仍在现有 Queue / MessageStore。
- 行为：仅改变确定性启动前失败和不可投递通知的终态；不改变 provider 启动或正常成功路径。
- 数据：沿用既有 failure / dispatchRef / Queue carrier；无 schema 迁移、新存储或 TTL。
- 安全与契约：不新增权限或外部接口；Lua 的 claim 校验保留，新增退休目标校验。
- 不可逆性：无运行环境部署，无生产数据操作；补丁可通过回退提交撤销。
- caller 的永久绑定拒绝不承诺自动恢复通知；诊断与原 failure 保留。原有 pre-route 目标失效退休逻辑不在本次新增诊断范围。

## 验证

初始 RED：两个 prestart 用例找不到 caller wake；永久 caller 身份冲突后 wake 仍在 queued。补丁后通过：

- 147 项定向测试：本次回归、#1871 全部内存回归、MessageStore lifecycle、Queue ledger、QueueProcessor 与 zombie 恢复。
- 34 项真实 Redis 测试：本次两种 prestart 状态的原子写、多目标 group 提交后进程退出、caller 通知删除后进程退出仍有诊断、#1871 提交后进程退出恢复、生命周期事务与 Queue ledger。
- live ledger target 省略 claim 的负例拒绝；processing 后 pending sibling 保留；重复 hydrate 不重建通知。
- 独立审查新增 RED：逐目标事务只有第一目标 ref、成功 sibling 导致中止、删除通知时尚无诊断；再覆盖 target 顺序变化、并发 sibling 结算、prestart 确认丢失以及诊断 / 通知退休分别失败后的恢复。
- API TypeScript 编译通过；改动文件 Biome 无 error；`git diff --check` 通过。

核心命令（在 `packages/api`）：

```text
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 --env LOG_LEVEL=silent node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 test/issue1862-terminal-followup.test.js test/issue1862-pre-admission.test.js test/issue1862-availability.test.js test/issue1862-review-recovery.test.js test/queue-processor-zombie.test.js test/message-lifecycle-store.test.js test/queue-ledger.test.js test/queue-processor.test.js
```

支持 Unix 进程识别的环境可使用仓库隔离 Redis runner：

```text
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 --env LOG_LEVEL=silent node scripts/run-isolated-redis-tests.mjs -- node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 test/issue1862-pre-admission-redis.test.js test/message-lifecycle-redis-store.test.js test/queue-ledger-redis.test.js
```

本机 Windows 的现有 runner 因 Unix `ps` 识别失败而退出。实际 Redis 验证在临时 HOME 内启动专属随机端口 Redis，核对 Windows listener PID 与 CONFIG 数据目录后才执行，结束后仅清理本次实例；未连接 runtime Redis。临时执行器位于本工位 `.cat-cafe/tmp/run-issue1862-redis.mjs`，未扩入产品改动。

后端验收使用真实 QueueProcessor → AgentRouter 的确定性拒绝入口及 Redis；预期失败发生在 provider 启动前，因此未调用付费 provider。没有在生产线程注入故障，也不把这些测试宣称为部署验收。
