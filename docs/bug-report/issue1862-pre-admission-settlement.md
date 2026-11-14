---
feature_ids: [F117]
topics: [queue, admission, a2a]
doc_kind: bug-report
created: 2026-11-06
---

# #1862 启动前拒绝的持久结算

## 范围

首版基线为公开 `next@471b56a4bbe45f331902adeb6c03ca99d19bb30c`。维护者审查修正版基于 `next@016942d367bd68c6452c7eaff6021518c7c32677`。Issue 已分配给当前贡献者账号。按 Issue 时间线、主仓和相关 fork 的 PR 及同步 diff 查重。

- [#1849](https://github.com/zts212653/clowder-ai/pull/1849) 已通过 `da8be4a68153b54f2b9f7cabc15ce2b5e287f9b0` 合入 `next`，包含 #1842 的 ACP 环境隔离、刷新重捕获和未送达重试。它解决触发器与未送达重领，本 PR 补最终拒绝的失败结算。修正版直接包含 #1849 合入后的代码。
- [mindfn #255](https://github.com/mindfn/clowder-ai/pull/255) 在 `1d2c6fbdd4cc2ea9e448b5c07f9e128c81088383` 合入 fork。其主仓移植 [#1867](https://github.com/zts212653/clowder-ai/pull/1867) 在 `0365d120c6a8e04cac87e1b07d3fda9a9cd3935b` 仍为 Draft。两者的 diff 移除 teardown 对后续准入的否决权，并回收旧进程所属 execution。未接入启动前失败事务。

## 故障路径

Queue claim 已锁定具体源行和收件目标。AgentRouter 按目标数进入串行或并行路由。路由在 `prepareInvocationExecutionBinding` 捕获执行绑定时可以拒绝，`InvocationServiceScope.admit` 对配置冲突已有一次重捕获。#1791 的环境快照冲突在此触发，也可能来自真实执行身份变化。若最终失败，当前路由只发临时错误帧，未到 `onLifecycleInvocationStarted`，因此没有 response 和 A2A return receipt。Queue 根据缺少成功证据进入失败或保留路径。此时 History 没有记录实际交付结果。

ADR-043 D9 将 claim 定义为短暂的持久预留。D10 将 canonical 结果与 Queue-only 控制唤醒分开，要求两者同一事务提交。

## 实施与验证

1. 用现有 Queue 和 AgentRouter 入口入队。只在 provider 捕获执行绑定的边界注入拒绝，验证确实进入 admission、未启动模型、History 缺少结果，并检查 caller Queue。复用已有测试 HOME。
2. 在串并行路由捕获最终绑定拒绝的位置分类。已明确的配置/身份不相容在原派发上终局。配置读取期间的变化保留既有重捕获及 Queue 恢复。未知异常保留既有错误路径。成员取消优先，按原取消路径退出。分类沿受控路由回调传递，避免以 socket 文案或模型输出做判定。
3. 按原 claim 的源行与目标结算。每条失败沿用 MessageStore 的 `delivery_failure`，从同一事务更新对应 dispatchRef，已发布输入保留原时间和 sibling ref。以原 Queue entry 加失败目标分隔此次逐目标操作的幂等键。失败文案使用固定安全诊断。
4. 精确 caller 从源行的 owner、thread 与 agent 作者校验，沿原 Queue authority 返回。持久失败、原 ref 和控制载体一次提交。载体以失败 ID 为身份，消费从同一 History 行读取结果，禁止递归回报。进程内通知负责加快 drain，恢复依据是持久 Queue。
5. 原 claim 在读回成功后只退休已结算目标。若事务提交后调用方没收到确认，已有 Queue 重建和 stale-target 对账以原 dispatchRef 为证据退休该目标。事务未生效时保留待派发目标。验证单目标、并行 sibling、普通用户消息、真实身份拒绝、暂时错误、取消，以及确认丢失后重建 Queue/worker 与 Redis 客户端。

## 作者方案自查

- 一处路由分类解决确定性拒绝与临时捕获竞态共用错误码的问题。保留现有 Queue `queued/claimed` 和 History 结算语义。
- 一个逐目标幂等键解决同一源行多个收件人分别失败时的身份冲突。
- 同事务写入现有 Queue 解决 History 成功后、唤醒入队前退出的缺口。失败文案和结果存一份，控制载体携带引用。
- 原 Queue claim 的逐目标退休解决部分成功、部分失败的恢复。恢复继续以 dispatchRef 为证据。无额外常驻进程或轮询。

## 复现记录和交付边界

- RED 在基线用真实 AgentRouter 捕获 Gemini 的合成执行身份冲突。捕获 2 次、provider 启动 0 次，socket 产出绑定错误及汇总错误。History 失败行断言为 `0 !== 1`。
- GREEN 覆盖串行和并行 A2A、非 A2A、取消、暂时冲突和 worker 替换。Redis 用例在真正的 Node 子进程内提交事务，随后在原 claim 退休前退出。新进程侧从独立 Redis 客户端重建 Queue，确认原目标退休、caller 收到含原 source/target/失败 ID 的提示且只运行一次。队列清空后再次恢复仍为空。
- 首轮独立 review 后另有五条 RED → GREEN。已公开的精确来源沿用 #1849 同步提交 `f8a9169248983d1de5c0afb26f363f63382feb1b` 的未送达判据。并行 claim 按实际目标集合区分 attempt，未送达子集恢复时不会重用已完成 sibling 的父记录。待消费的私有 failure wake 由现有短 claim、退休和私有准入收据约束，暂拒后可以重领。
- 消息事务确认丢失后，当前 worker 在退休源目标前，用已结算的 ref 重新加载已经存在的控制项。已入队成员变为无效时也沿用相同逐目标结算。旧的分组失败仍使用原幂等键读回。
- 退役目标在路由前丢失事务确认时，对账推进原 claim 后会重启同线程 drain。Queue 预解析和执行绑定共享已知的暂时注册不可用分类，原输入和待消费 wake 在 bootstrap 恢复前均保持 queued，沿原退避机制重试。
- 本修复沿用现有生命周期存储和 Queue 编码，新增两个明确的失败原因。代码回退可整组 revert，旧版仍能读取系统消息正文，但可能忽略新增的 lifecycle 原因，并缺少待消费控制载体的精确失败提示。回退保留已有失败与 source ref，避免重新派发原目标。
- 使用隔离测试 HOME、进程和 Redis。Provider 是测试替身，已装桌面及真实 DSH 会话留待部署验收。

## 维护者两条 P1

在合入最新 `next` 的未修正组合上运行审查原脚本。两条反例均预期零失败、实际一条失败。原队列行消失，留下了误发的 caller wake。

- 同一实现跨过两次准入捕获发生代次变化时，由注册会话的快照生产点报告可重试冲突。再次捕获仍核对真实 client 身份，持续不相容会结算失败。
- Queue 判断无诊断的服务缺席前，先核成员仍配置且允许派发。已存在服务、真正无效或已有终态诊断的目标保持原有分类。暂未注册的目标及待消费 caller wake 保留原行。
- 维护回归核对原 source 和 Queue ID。代次稳定和服务重新登记后，原任务各完成一次。错误 client 只产生一个 canonical 失败，caller 暂缺服务时保留同一 wake，恢复后只消费一次。
