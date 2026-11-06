# Issue #1894：A2A 排队消息的手动处理

来源：[Issue #1894](https://github.com/zts212653/clowder-ai/issues/1894)。用户授权：`thread_owned_a1c8b721f969425b825163bee73b9bad73e5aec5#0001793980673451-000008-9b223d15`。基线：`origin/next@c80bde90c30d58d5c559e89bf738c58245f340c6`。

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

## 分工与验证

- 砚砚：Issue、隔离 worktree、API/Queue 实现、整体集成；独立审鲸鲸编写的测试。
- 鲸鲸：独立核对方案，编写真实 API/Queue 回归与必要的 Web 契约测试；独立审砚砚的实现及最终提交。
- RED：从未修改基线运行新增测试，确认失败原因是 A2A 操作被类型守卫拒绝或 row 被错误重建，而不是环境/语法错误。
- GREEN：同一组回归通过，补验普通用户输入、目标增删、已投递 sibling、非中断意图、受保护载体与 no-anchor 场景；运行受影响的现有 API、Queue 和 Web 测试以及类型/格式检查。
- PR：以 `next` 为 base，正文引用 Issue、真实验证命令和交叉审查记录；本地验证与 Windows 安装版本验收分别报告。

## 仓库协作核对

通过当前 GitHub 身份 `whutzefengxie-ops` 发布 Issue；目标仓库 `zts212653/clowder-ai` 的认证权限为 push/triage，非 maintainer/admin。此工作是用户明确委托的本地 outbound 修复，采用既有 Queue 契约并重实现缺失的 A2A 控制入口；互审由不同个体承担，远端 maintainer 审查与合入遵循仓库约束。

已检查在飞 PR 的具体文件差异：#1875 对 InvocationQueue 的变更是 task-handoff read 过滤；#1867 与 #1673 对 queue route 的变更属于 teardown/cancel。未发现上述 PR 修复本 Issue 的类型准入，#1838 归口线程已收到同文件协调说明。

鲸鲸的独立核对确认了四处类型限制和 no-anchor 重建问题，认可保留同一 source 与原执行上下文的边界。实现沿用已有 InvocationQueue 模块导出复用判断，不新增模块；本次不增加 Web DTO 或修改既有界面。

## 已观察的验证结果

- 未修改基线完整 API build 通过。
- 新增真实 QueueProcessor journey 在基线返回 `409 / STEER_ENTRY_UNAVAILABLE`（RED）；修复后沿同一来源完成加载、原执行中断和单次投递 admission（GREEN）。该 fixture 的 provider 是测试替身，此证据不宣称真实模型执行或 Windows 安装版本验收。
- journey、queue-api、invocation-queue 和 queue-integration 共 114 项通过；API 类型编译、Biome error 级检查与 diff 检查通过。
- 额外 queue-independent-targets 的 6 项受当前 Windows 缺少 `redis-server`/Unix socket fixture 影响，记录为环境失败，没有改写测试或触碰用户 Redis。
- 现有 Web queue-panel-steer 整组 36/37 通过：共享连接提示用例失败，但单独运行该用例通过。该 suite 清空 toast store，却保留 `api-client` 的模块级 connection-failure latch，后一次连接错误被去重；本次没有改 Web 源码，不顺带调整连接提示逻辑。
- 鲸鲸已补齐 15 项独立 HTTP/Queue 边界测试，砚砚独立运行通过，包括真实 `/continue` 意图绑定的正向路径。
- 两份新增测试加 queue-api、invocation-queue、queue-integration 合并运行，129 项通过，零失败/跳过。
- 额外变异验证在隔离 dist 副本恢复旧类型拒绝/重建语义后出现预期失败；这用于证明检测力，不替代上面的真实基线 RED。
- 鲸鲸已独立批准核心提交 `70c5db45c12902b9270734a9a2d2672bd30a7b83`，durable 回执为本线程消息 `0001793982192791-000094-cc60ad06`。随后仅收窄 helper 名称、清理 no-anchor 守卫后不可达的 agent 类型猜测分支、补入其独立测试并澄清文档；最终提交仍需其核对该 delta。
