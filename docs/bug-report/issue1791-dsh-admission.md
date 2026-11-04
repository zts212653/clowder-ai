---
feature_ids: []
topics: [DSH, ACP, execution-admission, plugin-activation, A2A]
doc_kind: bug-report
created: 2026-11-04
---

# DSH 准入失败与 A2A 补送修复

本次覆盖正常插件激活后的 ACP 准入恢复，以及已发布 A2A 来源中尚未交付目标的补送。

## 事实与边界

- [Issue #1791](https://github.com/zts212653/clowder-ai/issues/1791) 为公开问题，作者 `zts212653`；2026-11-04 核实时仍开放。
- 当前贡献账号 `whutzefengxie-ops` 有 push/triage 权限，无 maintain/admin 权限。本次提交自己的修复 PR，由维护者审查决定合入。
- 基线 `upstream/next=a7c32a4fc327817d63b333a4cd3ed7ed8728ee3d`。
- 原始诊断在安装产物 `faaa1b0` 隔离复现：构造成功 → NativePluginActions 激活 → 同服务连续三次准入失败 → 手工重建才成功；未启动 provider。此次回归在独立 checkout 重新验证，不依赖生产数据。
- [维护者说明](https://github.com/zts212653/clowder-ai/issues/1791#issuecomment-6625678137) 描述了下游修复，但不将其报告当作公共实现或本地验收证据。

本次修复这两条已证实的失败链，不改变旧导入会话、跨 API 重启停止证明或侧栏 Working，也不因本 PR 关闭整个 #1791。

## 根因和方案

`NativePluginActions.activate()` 向宿主环境写入 `CLOWDER_PLUGIN_<SHA256>_ACTION_TOKEN/PATH`。这些值供 Host 在调用边界投影插件 MCP；它们不是 provider 进程身份。`AcpServiceFactory` 却将整份继承环境冻结到长期服务，并在每次捕获前后比较。桌面先构造服务、再恢复插件，合法激活就能使服务永久过期。

1. 仅从 ACP provider 启动环境中排除 Host 生成的上述精确键形；插件 MCP 仍由当前调用的冻结配置提供。保留其余环境、账号、命令检查，已准入工作继续使用原快照。
2. 确定的 `ExecutionAdmissionConflict` 在 provider 启动前经原 `syncAgentRegistry` writer 刷新，再重新取服务捕获一次。串行、并行策略都接同一入口；失败仍上报，不增加 provider 重放。
3. `QueueProcessor` 对已发布 A2A 来源的重试，以原 InvocationRecord 的精确身份、source 归属和目标 `dispatchRefs` 为依据。没有该目标 receiver 的失败记录可重试；已有 receiver 的 sibling 不重放。

选择理由：自动重建所有插件相关进程会无谓打断复用；直接删除一致性检查则丢失真实配置变化保护。这里将 Host 连接环境与 provider 启动环境分开，并复用现有 registry writer，不新增平行配置源或重试账本。

架构归属：现有 ACP factory/pool、registry writer、routing admission 和 Queue/History；ownership map 无新增 cell。

## 验证计划

1. RED：真实 factory 构造后调用 NativePluginActions.activate，现有成员应可准入且池仍复用；串行和并行路由遇旧服务时应通过 writer 恢复；已发布 A2A 未交付目标应补送。
2. GREEN：保留原来的真实环境变化拒绝、已准入冷启动冻结和下一池更新测试；验证非冲突错误和取消不触发刷新，连续冲突至多捕获两次。
3. A2A：使用稳定幂等记录复现重试，包含已交付 sibling；确认只有未交付目标再次路由，成功后只有一个 receiver。
4. 质量检查：API 编译/类型检查、修改文件格式检查、相关 routing/ACP/Queue 回归；由非作者审查最终提交。
5. PR 合入后在隔离环境验证合入提交。真实安装版的 DSH newSession/resume → promptStream → 最终回复与三条旧交接处置须另有运行证据；代码或 fixture 通过不能代签。

## 回退与交付

改动可以整组 revert。恢复原 provider 环境比较和 admission/Queue 行为，不迁移或改写用户持久数据。

本次开发仅在独立 worktree，测试使用独立 HOME 和测试数据；不修改正在运行的桌面、角色、账号或插件配置。PR 合入与已安装运行版修复是分别验证的结果。

## 本轮验证结果

- Windows / Node 24.16.0：基线依赖构建与修复后 API TypeScript 编译通过。
- RED：stdio/httpstream 在真实 NativePluginActions 激活后均报原环境准入错误；两个路由策略均未调用 writer；已发布 A2A 来源重试只路由一次。先出现的测试目录 ACL 错误经独立 bootstrap 目录校正后才计入有效 RED。
- 核心回归 108 项通过。随后将 writer-refresh 场景加强为真实 AgentRouter → AgentRegistry.refresh → router cache 更新，再运行准入、运行中刷新、并行 A2A 失败报告共 22 项，全部通过；两批有重叠。
- 真实 DSH：从当前 factory 创建服务后激活三个合成 MCP contribution，新增六个 Host 环境字段，服务仍可准入。使用当前成员选择的 `deepseek-official / deepseek-flash`，观察到 initialize=1、newSession=1、promptStream=1，最终回复 `DSH_ADMISSION_OK`，工具调用为零。
- 真实探针使用独立 workspace、session、storage 和 attachment 目录；五份原配置/凭据/成员存档前后哈希相同。探针在关闭子进程后立即删空 bootstrap 目录时遇到 EBUSY，后续复核自有 DSH 进程为零，空目录已移除，测试历史保留。
- 真实调用证明 factory → 正常插件激活 → ACP 准入 → DSH 模型回复；没有覆盖真实插件 MCP 工具调用、桌面完整交接、原三条失败交接补送或部署升级，不据此声称已安装桌面版恢复。

回归命令（在 `packages/api` 执行；先构建依赖与 API）：

```sh
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 --test-timeout=60000 test/acp/acp-launch-environment.test.js test/queue-processor.test.js test/routing-admission-reparse.test.js test/invocation-admission-ownership.test.js test/invocation-implementation-freeze.test.js test/plugin-member-mcp-admission.test.js
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 --test-timeout=60000 test/routing-admission-reparse.test.js test/agent-router-refresh-inflight.test.js test/route-parallel-a2a-failure-report.test.js
```
