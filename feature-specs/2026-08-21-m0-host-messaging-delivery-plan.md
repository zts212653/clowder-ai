# M0 Host Messaging 交付计划

**功能：** F288 — `docs/features/F288-plugin-messaging-domain.md`

**目标：** 交付一套可审查、默认休眠的 Host 实现，覆盖 M0 的七条 messaging wire row；它消费已经发布的契约，并始终由 K-1 作为消息、账本、游标和快照的唯一真相源。

**本 PR 验收标准：** 交付默认休眠的 Host 实现：精确 pin beta 版本；使用 contract 自带验证；接通七条 Host route；完成 Memory/Redis 持久游标恢复与 stdio Host delivery；通过 repository gate；并由独立 reviewer 覆盖 authored delta。它实现 F288 AC-A4 的 Host 侧前置条件，但不完成 AC-A4，也不授权 activation。

**架构单元：** `plugin`

**架构图变更：** 无

**不改架构图的原因：** 本工作只扩展现有 plugin 单元已经拥有的 Host Broker、受监督 stdio runtime 和 `createMessagingDomain(...)` 接缝；不会新增 registry、状态机、process manager 或 transport 单元。

**架构：** Broker 负责验证并授权 contract-native frame，再把有状态行为交给已经吸收进 core 的 K-1 `MessagingDomain`。外部 runtime 通过现有受监督 stdio transport 承载带 correlation 的 Host request。生产 composition 只负责构造这些接缝，不开放激活入口，也不启动任何插件包。

**技术栈：** TypeScript、Node.js test runner、Redis/Lua、stdio 上的 JSON-RPC、pnpm、`@clowder-ai/plugin-contract@0.1.0-beta.11`、`@clowder-ai/plugin-sdk@0.1.0-beta.7`

**前端验证：** 不需要。本 slice 不新增 UI，也不新增用户可见的激活入口。

---

## 完成线

Host PR 的完成谓词只有三项：默认休眠的 Host 实现完整；一个精确、基于 upstream 的 Host SHA 通过 repository gate；独立 review 已覆盖 authored delta 且没有未关闭的 P1/P2。满足本谓词后，该 Host SHA 才能进入任务 8 的独立后续验收；任务 8 的结果不属于本 PR merge gate。

本次交付**不会**激活生产插件、修改 runtime config、发布 package、移动 registry tag、复制一份本地 fixture matrix，或直接关闭 M0-D。

## 最终对外形状

- Contract 和 SDK 继续作为唯一 wire/type 真相源；core 只保留 Host 内部 alias 和 adapter，不保留公开 contract mirror。
- Broker 精确开放：`messaging.send`、`messaging.appendElements`、`messaging.subscribe`、`messaging.read`、`messaging.ack`、`messaging.snapshot` 和 `host.messaging.deliver`。
- K-1 负责授权、消息变更、幂等结算、持久事件游标、stale recovery 和 snapshot 真相。
- Broker 负责 frame admission、dispatch intent、call correlation 和 transport settlement。
- `messaging.read`/`messaging.snapshot` 在推进 delivered/page entitlement 之前，必须先证明完整 compact JSON-RPC result 不超过 beta.11 的 1 MiB assembler budget。
- stdio supervisor 负责进程生命周期和带 correlation 的 Host request delivery；它不能伪造 domain receipt。
- 生产 composition 默认休眠：允许构造，不允许自动激活或启动插件包。

## 有状态对象清单

### 1. Subscription 与 snapshot view

**生命周期 owner：** `MessagingService` 与 `CursorStore`。

| 当前状态 | 事件 | 下一状态 | 必须行为 |
|---|---|---|---|
| live | `read` | live | 只推进 delivered watermark |
| live | stale cursor | stale | 用 `STALE_CURSOR` 拒绝普通 read |
| stale | `snapshot` | snapshot-active | 持久化稳定 fence 与第一页 entitlement |
| snapshot-active | 合法 next-page token | snapshot-active/final-ready | token 只消费一次，且只签发下一个 entitlement |
| snapshot-active/final-ready | 无 token 重试 | 不变 | 重放最后一次已提交的完整 page result，不再次消费 entitlement |
| snapshot-active | replay/tamper/wrong offset | 不变 | fail closed，cursor 零移动 |
| final-ready | final ack | live | 原子地把 ack 推进到冻结的 resume sequence |
| 任意状态 | handle/subscription revoke | revoked | 拒绝 read、page 和 ack |

**不变量：**

- INV-H1：Page token 是有状态、单次使用的 entitlement，不是可编辑的 base64 offset；丢响应恢复依赖持久化的结果重放，不依赖 token 二次消费。
- INV-H2：在冻结视图遍历完成之前，ack 不得推进。
- INV-H3：Snapshot identity、cursor state 与最后一次 page result 的重建材料在重启后仍然存在，并保持 Memory/Redis 行为一致；冻结 items 必须与游标元数据分离、按页读取。
- INV-H4：已撤销 token 或跨 subscription token 必须零副作用。

**对抗测试：** 篡改 offset、重放 token、伪造 final ack、跨 subscription token、Redis 重启/重新加载，以及最后一页 crash window。

### 2. Broker call settlement

**生命周期 owner：** 现有 Host Broker control plane；产品结算 owner 为 K-1。

| 当前状态 | 事件 | 下一状态 | 必须行为 |
|---|---|---|---|
| admitted | 未授权 method/grant | rejected | 不调用 domain |
| admitted | dispatch 已持久化 | in-flight | 只通过已注册 handler 调用 K-1 |
| in-flight | canonical K-1 receipt | settled | 原样返回该 receipt，不建立第二套产品 ledger |
| in-flight | transport 结果不明确 | recovering | redispatch 前先查询 canonical domain settlement |
| settled | retry | settled | 返回 canonical result，永不重复结算 |

**不变量：**

- INV-H5：只有 beta.11 中标记 ready 的 row 可以 dispatch。
- INV-H6：Frame identity 和 effective grant 由 Host 绑定，永不相信 plugin 自报。
- INV-H7：Broker settlement 不能取代或抢跑 K-1 的幂等真相。
- INV-H8：畸形、拒绝、过期和跨实例调用必须零副作用。

**对抗测试：** grant 被拒绝、closed input 畸形、deadline expiry、跨实例 handle、重复 idempotency key/operation ID，以及 ambiguous effect 后恢复。

### 3. Stdio Host delivery request

**生命周期 owner：** `ExternalPluginSupervisor` 与 `StdioBrokerTransport`。

| 当前状态 | 事件 | 下一状态 | 必须行为 |
|---|---|---|---|
| running | Host delivery request | pending | 分配 correlation ID 并写入一条 JSON-RPC frame |
| pending | 匹配结果 | running | 精确 resolve 一个 waiter |
| pending | method/ID 不匹配或结果畸形 | unchanged/rejected | 不得结算其他 waiter |
| pending | process close/drain | failed | 使用 method-specific 稳定错误拒绝 |
| not running | delivery request | rejected | fail closed，绝不自动启动 |

**不变量：**

- INV-H9：Correlation 必须同时绑定 method 与 request ID。
- INV-H10：Delivery failure 使用 `DELIVERY_REJECTED`，不能借用 heartbeat 语义。
- INV-H11：非法 plugin 输出不能击穿 Host，也不能结算另一个 call。
- INV-H12：没有明确激活授权时，composition 必须保持休眠。

**对抗测试：** 错误 correlation ID、method 不匹配、畸形 frame、存在 pending delivery 时进程退出、drain race，以及 stopped 状态下请求 delivery。

## 工作与交付任务

### 任务 1：保留 RED 证据并 pin 已发布边界 — 已完成

**文件：**

- 修改：`packages/api/package.json`
- 修改：`pnpm-lock.yaml`
- 测试：`packages/api/test/plugin-messaging-source-admission.test.js`

1. 记录旧 package 对 Unicode scalar、unsafe integer、历史值和 not-ready row 的失败见证。
2. 精确 pin contract beta.11 和 SDK beta.7，并核对 lockfile integrity。
3. 运行 source-admission test 与 API build，预期 GREEN。
4. RED 证据与 package admission 分开提交。

### 任务 2：接通六条 plugin→Host messaging route — 已完成

**文件：**

- 新建：`packages/api/src/domains/plugin/host-broker/messaging-handler.ts`
- 修改：`packages/api/src/domains/plugin/host-broker/control-plane.ts`
- 修改：`packages/api/src/domains/plugin/host-broker/types.ts`
- 修改：`packages/api/src/domains/plugin/host-broker/index.ts`
- 测试：`packages/api/test/plugin-host-broker-messaging.test.js`

1. 为 send/append/subscribe/read/ack/snapshot 先写授权失败、closed-input、canonical settlement 和 recovery RED 测试。
2. 每个 contract method 只注册一个窄 handler adapter。
3. Domain settlement 保持权威，不新增 Broker 产品 ledger。
4. 运行 focused Broker suite，要求全部 vector GREEN。

### 任务 3：让 snapshot paging 可跨重启并且 fail closed — 已完成

**文件：**

- 新建：`packages/api/src/domains/messaging/snapshot-tokens.ts`
- 新建：`packages/api/src/domains/messaging/stores/memory-cursor.ts`
- 修改：`packages/api/src/domains/messaging/event-stream.ts`
- 修改：`packages/api/src/domains/messaging/stores/ports.ts`
- 修改：`packages/api/src/domains/messaging/stores/redis-cursor.ts`
- 修改：`packages/api/src/domains/messaging/stores/redis-keys.ts`
- 测试：`packages/api/test/plugin-messaging-snapshot*.test.js`

1. 先写 page-token tamper、replay、伪造 final ack 和 Redis parity 的 RED 测试。
2. 游标只持久化冻结 view 元数据；items 放入独立的 page-addressable 存储，读取路径不得反序列化完整 view。
3. 在 1 MiB encoded-result budget 内选择最大非空前缀，再原子消费 page entitlement；越界 item 返回 `SNAPSHOT_UNAVAILABLE/OVERSIZED_ITEM`。
4. 持久化最后一次 page 的起止 offset 与 successor token，使无 token 重试能重放完全相同的中间页或最终页。
5. 只在完整遍历后允许 final ack；ack/revoke 必须回收冻结 item 存储。
6. 运行 Memory 与隔离 Redis suite，要求行为一致。

### 任务 4：通过现有 stdio 接通 `host.messaging.deliver` — 已完成

**文件：**

- 修改：`packages/api/src/domains/plugin/external-runtime/stdio-broker-transport.ts`
- 修改：`packages/api/src/domains/plugin/external-runtime/supervisor.ts`
- 修改：`packages/api/src/domains/plugin/external-runtime/types.ts`
- 测试：`packages/api/test/plugin-host-messaging-deliver-stdio.test.js`

1. 先写 correlation、畸形结果、pending-close rejection 和 stopped execution 的 RED 测试。
2. 复用受监督 transport 的 pending-request 机制。
3. 新增 method-specific `DELIVERY_REJECTED` closure 语义。
4. 对所有入站 request 在 Broker/domain dispatch 前执行 `deadlineUnixMs` 门禁；过期调用返回公开 `DEADLINE_EXPIRED` 且保持现有 authority。
5. 运行 external-runtime 和 delivery suite，要求 GREEN。

### 任务 5：接入默认休眠的 composition — 已完成

**文件：**

- 修改：`packages/api/src/domains/plugin/runtime-composition.ts`
- 修改：`packages/api/src/index.ts`
- 测试：`packages/api/test/plugin-runtime-composition*.test.js`

1. 要求共享 `messageStore`，并接受现有 Redis 依赖。
2. 构造 `MessagingDomain` 并注册七条 handler。
3. 暴露内部 messaging 接缝，不新增 activation route，也不启动插件包。
4. 断言构造过程零副作用。

### 任务 6：产出一个 upstream-clean 的精确 Host SHA — 已完成

1. Fetch `upstream/main`，把本分支全部交付提交 rebase 到最新 upstream。
2. 验证 `git rev-list --left-right --count upstream/main...HEAD` 的 behind 为 `0`，并记录最终 ahead 数量与 exact SHA。
3. 审查 `upstream/main...HEAD` 的完整 diff，证明 rebase 没有引入 branch 外 delta。
4. 运行：

   ```sh
   cd /Users/lang/workspace/github-lab/cat-cafe-m0-host-messaging
   bash scripts/pre-merge-check.sh --no-rebase
   ```

   必须使用 `--no-rebase`：仓库 gate 默认绑定 fork `origin/main`，而本次贡献目标是 upstream。步骤 1–3 会独立验证 upstream 基线。
5. 如果 gate 改变 checkout，重新运行 focused 261-case suite 与隔离 Redis snapshot suite。
6. 在质量报告中记录 exact SHA、命令、测试数量和任何只属于 baseline 的 warning。

### 任务 7：独立 review 与 upstream PR — 进行中（PR #1380 已创建，等待本轮 maintainer 复审）

1. ✅ 已把 Host authored delta 交给非作者、跨家族 reviewer。
2. ✅ Reviewer 已覆盖授权、snapshot 生命周期、Redis 原子性、stdio correlation 和休眠 composition，并给出明确 P1/P2/P3 verdict。
3. 所有 finding 按 Red→Green 修复。已审 authored delta 发生实质变化时必须重审；仅刷新 base 且用 range-diff、patch-id 或等价机械证据证明 authored patch 恒等时，不要求仪式性重审。
4. ✅ Feature branch 已 push，upstream PR #1380 已创建。
5. PR tracking 必须持续登记；如果 tracking 丢失，按当前 live baseline 重新注册。不 self-approve，也不 self-merge。
6. 持续处理 cloud 与 maintainer review，直到精确 PR head 全绿并获批。

### 任务 8：Canonical 双 SHA 联合验收 — 待执行，且与 Host PR 分开

1. 冻结 plugins merge SHA `a0b3554d5ebbe71a9043bbb63cca5bf5dcba74b5` 与最终 reviewed Host SHA。
2. 从 contract fixture catalog 选择 canonical 18 个 vector ID；不复制成 Host 本地 matrix。
3. 在隔离验收环境中，让编译后的 standalone plugin 调用真实的 dormant Host 接缝。
4. 证明成功路径与所有 fail-closed 路径，包括 crash isolation、stale recovery、ack-before-crash redelivery、retained state、deadline expiry、denied grant 和 cross-instance rejection。
5. 发布完整性报告，包含两个 SHA、package 版本与 digest、环境隔离方式、vector 结果和 non-claim。

### 任务 9：M0-D 发布就绪 — 不属于本次 Host PR

需要单独交付：

- 正式 `0.1.0` 兼容性决策；
- API Reference 与 plugin developer guide；
- package loading/running contract；
- 面向 owner 的 UI 与配置能力；
- 明确的 runtime activation authority；
- 第一方/第三方同权断言与生产 dogfood。

只有 roadmap 的完整 M0-D verdict 通过后才能关闭 M0；beta 发布、Host merge 或任一局部验收都不能单独关闭 M0。

## 验证台账

| 证据 | 要求结果 |
|---|---|
| API build | exit 0 |
| Focused Host/messaging/external-runtime suite | 全部通过，并记录最终 case 数 |
| 隔离 Redis snapshot suite | 3/3 pass |
| Read/snapshot encoded-result budget | 完整 compact JSON-RPC result ≤ 1,048,576 bytes，状态只推进到已发出的前缀 |
| Deadline 与 snapshot availability wire errors | 公开 code/message/data 精确匹配 beta.11，且零额外业务副作用 |
| `git diff --check upstream/main...HEAD` | 无输出 |
| 以 upstream 为基线的 hotfix classifier | `hotfix:false` |
| Fallback-layer audit | 已解释边界状态判别；不存在 recovery stack |
| 使用 `--no-rebase` 的完整本地 gate | exit 0 |
| 独立 authored-delta review | APPROVE，且没有未关闭的 P1/P2；base-only refresh 需有机械恒等证据 |
| 任务 8 后续联合验收（不属于 Host PR merge gate） | canonical 18 个 vector 全部通过，并覆盖 M0-D fail-closed matrix |
