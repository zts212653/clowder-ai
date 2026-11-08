# Issue #1894：A2A 排队消息的手动处理

来源：[Issue #1894](https://github.com/zts212653/clowder-ai/issues/1894)。初始复现基线：`c80bde90c30d58d5c559e89bf738c58245f340c6`；修复：[PR #1895](https://github.com/zts212653/clowder-ai/pull/1895)，目标分支 `next`。

## 结果与范围

复用队列现有“处理这条”入口，让普通 A2A `message_wake` 能加载目标，并以同一 Queue/History 消息执行合法的 guide 或 interrupt。保持现有界面、成员能力投影、原生投递和权限模型。未合入代码仅在独立 worktree、隔离测试数据中验证。

现象已由运行日志与只读 HTTP 请求验证：GET `/queue/:entryId/targets` 将 `message_wake` 当作不可操作条目返回 409，弹窗因而显示上下文不可用。POST `/targets`、POST `/continue` 与 `InvocationQueue.bindContinueCurrentIntentDurable()` 有同根限制。

## 设计

1. 在 `InvocationQueue.ts` 定义复用的消息操作资格判断：保留原 `conversation_input` 行为，只增加普通 `sourceCategory=a2a` 的 `message_wake`。沿用现有 ordinary-read 的 domain-owner 边界，并保持 exact cloud dispatch 的约束；不借本次修复开放私有输入、定时器、action successor、wait continuation 或失败控制载体。
2. GET/POST `/targets`、POST `/continue` 和意图绑定使用同一资格判断。目标实际投递仍由 History `dispatchRefs` 裁决，已投递成员幂等跳过；原生 Queue claim、reconcile、cancel 与启动流程保持不变。
3. 现存 A2A row 的目标增删和意图修改均使用原地 reconcile，完整保留 row 的 kind、owner、source identity、parent 与 A2A provenance。
4. 原 A2A row 已消失时，如果旧弹窗只涉及已投递目标，继续返回幂等跳过；需要增加新目标时返回既有不可操作冲突，不能用普通用户输入的 no-anchor fallback 重建成 `conversation_input` 并猜测丢失的执行上下文。
5. guide 是否可用仍来自原生 carrier 能力。能力不足时保留下一轮工作，绝不将 guide 偷换为 interrupt。

本判断命名为 `isQueueMessageSelectionEligible`，只服务公开消息的目标选择和 continue。既有单目标 `/steer` 与通用 `claimExactSteerEntryDurable` 保留原契约：它们操作既定目标并继续携带原 producer payload/fence，不负责新增或删除收件人；通用 claim 同时服务 owner routing recovery。本次不将消息目标选择的资格判断硬套给这些生产者控制入口。依据为 F047 的 exact interrupt 不变量与当前调用链，独立的 producer 控制策略留在原责任边界内。

该改动属于现有 dispatch cell 内的行为修复，没有新增 store、事件协议、调度器、权限或模块归属；Architecture Map 无变化。回滚为撤销该修复提交，无数据迁移。

## 验证策略

- RED：从未修改基线运行新增测试，确认失败原因是 A2A 操作被类型守卫拒绝或 row 被错误重建，而不是环境/语法错误。
- GREEN：同一组回归通过，补验普通用户输入、目标增删、已投递 sibling、非中断意图、受保护载体与 no-anchor 场景；运行受影响的现有 API、Queue 和 Web 测试以及类型/格式检查。
- API/Queue 回归覆盖真实 HTTP 入口、QueueProcessor 与意图绑定；provider 为测试替身，不作为真实模型或已安装应用的验收。

## 已观察的验证结果

- 未修改基线完整 API build 通过。
- 新增真实 QueueProcessor journey 在基线返回 `409 / STEER_ENTRY_UNAVAILABLE`（RED）；修复后沿同一来源完成加载、原执行中断和单次投递 admission（GREEN）。该 fixture 的 provider 是测试替身，此证据不宣称真实模型执行或 Windows 安装版本验收。
- journey、queue-api、invocation-queue 和 queue-integration 共 114 项通过；API 类型编译、Biome error 级检查与 diff 检查通过。
- 额外 queue-independent-targets 的 6 项受当前 Windows 缺少 `redis-server`/Unix socket fixture 影响，记录为环境失败，没有改写测试或触碰用户 Redis。
- Web queue-panel-steer 在未修改基线 `c80bde90` 的同环境复验仍为整组 36/37、连接提示单例通过，与初始修复候选一致。两者的整个 `packages/web` Git 树均为 `0d54d91bb8d2a5a86789c502c833b347ce5386c1`。该 suite 清空 toast store，却保留 `api-client` 的模块级 connection-failure latch，后一次连接错误被去重；本次没有改 Web 源码或调整连接提示逻辑。
- 15 项 HTTP/Queue 边界测试通过，包括真实 `/continue` 意图绑定的正向路径。
- 两份新增测试加 queue-api、invocation-queue、queue-integration 合并运行，129 项通过，零失败/跳过。
- 额外变异验证在隔离 dist 副本恢复旧类型拒绝/重建语义后出现预期失败；这用于证明检测力，不替代上面的真实基线 RED。

## 复验命令

在独立 checkout 中执行 `pnpm install --frozen-lockfile`，构建 shared、mcp-server 和 api 后，从 `packages/api` 运行：

```powershell
node ./scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=2 test/issue1894-a2a-steer-journey.test.js test/issue1894-a2a-steer-boundaries.test.js test/queue-api.test.js test/invocation-queue.test.js test/queue-integration.test.js
```

从 `packages/web` 运行完整 Web 套件及连接提示单例：

```powershell
node scripts/run-with-node-env-test.mjs node node_modules/vitest/vitest.mjs run src/components/__tests__/queue-panel-steer.test.ts
node scripts/run-with-node-env-test.mjs node node_modules/vitest/vitest.mjs run src/components/__tests__/queue-panel-steer.test.ts -t 'uses shared connection feedback when the single operation loses its response'
```

维护者审查与最终验证结果以 PR 的当前提交、检查与评论为准。
