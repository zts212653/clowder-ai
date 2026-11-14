---
feature_ids: []
topics: [superagent, plugins, authorization, ongoing-work]
doc_kind: technical-feasibility
created: 2026-11-04
status: isolated-contract-probe
source_message: 0001793721364288-000625-f53c1c95
host_commit: 0fb68bc03455507836a0a35a706985a1ccc66058
---

# 个人会话首版：现有契约能接到哪里

首版范围已由枫哥选定：本人明确选定的会话，跨会话跟进任务。这里验证正式实现之前最可能改变方案的接口组合，不代表可安装插件或真实成员验收。

结论：**同一次激活期间，现有消息订阅可以驱动已授权的协调成员，并用现有回执避免重复唤醒。重启后自动继续、完整工作执行和顶部入口仍需要正式实现。** 不能只把几个已有 API 接上就声称 Superagent 已成立。

## 固定版本与实际产物

| 对象 | 本次核对的版本 / 产物 | 结论 |
| --- | --- | --- |
| Host | `0fb68bc03455507836a0a35a706985a1ccc66058`；本工位在其上只有体验稿和探针等变更 | 已有模块级 memberSessions、消息订阅、Task 数据端口 |
| Host 自用 SDK | 锁文件实际安装的 `@clowder-ai/plugin-sdk@0.3.0-beta.2-candidate.1` | `dist/module-host.d.ts` 未声明 memberSessions / ownerChat；不能用它的类型冒充新插件已兼容 |
| 插件源码候选 | 插件仓 `3f74afd18362a6b10a78a2f17e9a0281dbbcceb2` | SDK 标记 `.10`，contract 标记 `0.3.3-candidate.0`；源码存在不等于安装产物已可用 |
| 已发布 SDK 候选 | 从 npm 官方 registry 下载 `.10` tgz，核对 SHA-512 与 registry integrity 一致，再读取包内 `.d.ts` | 包内确有可选 memberSessions / ownerChat；新插件可单独固定该 SDK，无须为了类型跟随升级 Host 自用 SDK |
| Host contract | `packages/api/vendor/clowder-ai-plugin-contract-0.3.2-candidate.0-f333-20a1e1094c63.tgz` | 插件声明和最终 tgz 仍要接受该 Host 的实际 manifest/运行时校验；新版 SDK 不证明整个新版 contract 被 Host 接受 |

下载来源：`https://registry.npmjs.org/@clowder-ai/plugin-sdk/-/plugin-sdk-0.3.0-beta.2-candidate.10.tgz`。本地归档：`artifacts/superagent-contract-probe/plugin-sdk-0.3.0-beta.2-candidate.10.tgz`，仅保留在本任务工位，不纳入 Git。

- SHA-256：`cb69100fa0e3ece4c72193dd9709164ae39930c6993f516056be3e7f49ef3284`
- registry integrity：`sha512-VAW/6zYJ4IAW16HEdS9l8c4m890vpTN9Y6PTIoz45Xj/inJXUiHYnZlnrGfdi464wPvArT4VKHl/KlOqs8bdig==`

这里只检查发布物的声明与完整性，没有安装它的依赖、运行其代码或修改当前项目锁文件。

## 已跑通的组合与限制

探针：[`superagent-personal-scope.contract-probe.test.ts`](../../../packages/api/test/superagent-personal-scope.contract-probe.test.ts)。采用真实 Host 模块和内存存储，Queue 接收端为测试替身，没有 provider 调用。

1. **选定会话 → 已授权协调成员。** 组合 MessagingService、SubscriptionDelivery、模块调用边界、插件订阅 Host 和 MemberSessionHost。未订阅会话与插件自身消息不会进入 action。投递 action 没有新的 owner-operation；它仅消费事先明确建立的成员授权。
2. **丢失投递回执 → 同一执行。** 在成员已入队后、订阅 ACK 前注入失败。重放保持相同 deliveryId / executionId，Queue 只接收一次成员唤醒。停用订阅后不再收到新事件。
3. **重启 → 可读记录，不自动续权。** 重新创建 Host 与 activation 后，原线程/授权记录仍可读取；执行被 `member_session_activation_changed` 拒绝。后台 prepare 也被拒绝。明确的新 owner 操作才能沿原线程续授下一代授权。
4. **canonical Work 数据 → 不等于执行。** Task 端口拒绝把观察到的人类消息直接冒充插件自己的准入来源。使用当前安装自己发表的判断消息，可以幂等创建 canonical Work，admission 中的 sourceRef 指向该插件消息；原人类来源仍需明确关联。这个操作不会派发成员。

前三项中的两个生命周期情形合在同一测试内；共三个探针用例。测试不判断“这句话是不是任务”，也没有通过固定结果假装模型理解了反馈。

## 正式实现需要遵循的职责划分

**消息接入。** 插件按配置只订阅已选 threadId，撤选时退订；Host 继续负责所属用户、句柄和激活边界。消息先持久写入待处理队列并返回收妥回执，再驱动协调，不能让订阅 action 等完整模型回合。不同会话的 envelope 没有可直接当作全局语义游标的序号；插件需要为自己的持久输入分配语义游标。

**语义协调。** memberSessions 适合受控协调回合。其 router 固定使用 `plugin_native` 工具策略，成员回调限于当前插件 contribution；例如 Codex 受控启动明确禁止一般文件写入与网络。不能把这个端口当作现有猫猫完整编码能力的通用后台调用，也不能为 Superagent 放松原有受控会话规则。

**事项与执行。** 继续使用 canonical Task 作为 Work 身份。插件自己的判断消息可承载分拣结果和原文引用，现有 Task 数据端口可复用；既有 Work 的跟进应维持原 owner、thread 和 admission。实际调查、实现、测试必须接回现有 A2A / Queue 的受托工作执行路径，明确验证 Task 绑定执行资格、原授权和撤权。Task 数据写成功不作为执行准入凭据。

**持续授权与恢复。** 现有 member grant 是 activation 级授权。产品要求“用户启用后，正常重启仍继续跟进”，需要 Host 保存并核验一份可撤销的长期委托，再据此授予每次激活的受限执行权；不能把旧进程的权限句柄序列化后复活，也不能每次启动伪造 owner 点击。若暂未实现该能力，入口必须诚实显示需续授，不能显示正在跟进并将此视为交付完成。

**顶部入口。** 现有声明式 UI 只投影 `activity-bar.bottom` 活跃入口。安装后待设置也可见的顶部 Bot 行，需要基于安装清单与持久主会话的通用入口投影；不能只往活跃插件列表里塞一个 Superagent 特例。

这些是已证实的产品缺口；多人 Channel 不再是本次实现或验收的前置依赖。

## 来源定位

- 订阅与投递：`packages/api/src/domains/plugin/host-surface/plugin-messaging-subscription-host.ts`、`domains/messaging/subscription-delivery.ts`。
- 授权/恢复：`domains/plugin/member-sessions/owner-authority.ts`、`service.ts`、`host.ts`；现有 `plugin-member-host.test.ts` 明确覆盖跨激活失效。
- 执行能力：`domains/plugin/member-sessions/router.ts`、`runtime.ts`；`domains/cats/services/agents/providers/codex-plugin-native-launch.ts` 的 scoped policy。
- Task 数据：`domains/plugin/host-surface/task/plugin-task-data.ts`、`plugin-task-write-fence.ts`、`plugin-task-data-controller.ts`。
- UI 投影：`domains/plugin/declared/declared-plugin-ui.ts`。

## 复跑与未验收

在本工位 `packages/api` 执行：

```powershell
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import tsx --test test/superagent-personal-scope.contract-probe.test.ts test/plugin-member-owner-confirmation.test.ts test/plugin-member-host.test.ts test/plugin-task-data-controller.test.ts
```

既有 data-controller 测试需要先完成 API build。探针全部使用临时 HOME、内存存储和替代 Queue，没有启动 Redis 或读写在线 runtime 的用户数据。

本轮实跑结果：上述四文件共 27 项通过；`pnpm --filter @cat-cafe/api build` 通过；探针文件单独进行 TypeScript 语义/语法诊断为零，Biome error 级检查通过。API 构建提示 Windows 不支持可选的 SQLite read-window backend，构建仍成功；没有据此声称该后端已验收。初次运行 data-controller 测试时缺 API dist，完成构建后复跑通过；探针自身的初版游标/样例字段问题已更正，不将其记录成产品缺陷或产品 RED/GREEN。

未验收：独立插件 tgz 的安装与启用、真实模型分拣、多 Work 并行、跨会话语义续接、真实代码执行、结果回原处、正常重启自动恢复、classic/v2 完整 Host 集成、macOS。UX 方向仍待本线程确认；本文件没有将接口探针升级为产品验收。
