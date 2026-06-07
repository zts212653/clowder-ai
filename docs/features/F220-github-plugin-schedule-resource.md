---
feature_ids: [F220]
related_features: [F202, F139, F140, F141, F133]
topics: [plugin, schedule, github, refactor]
doc_kind: spec
created: 2026-06-02
---

# F220: GitHub Plugin Schedule Resource — 定时任务插件化重构

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

## Why

当前 GitHub 相关的系统级定时任务（cicd-check / review-feedback / conflict-check / repo-scan，以及 Phase D 的 issue-tracking）全部**硬编码**在 `index.ts` 启动时注册，与插件框架（F202）完全脱钩。插件 disable 了这些 poller 照跑；GitHub 配置走 connector-hub → `.env`，不走插件 config store；`PluginResourceDef` 类型定义里预留了 `schedule` 资源类型但从未实现（manifest parser 直接跳过、capabilities schema 不支持、activator 无 switch case）。

铲屎官原话：

> "github相关的定时任务都是硬编码的；定时任务好像也不支持脚本的？github插件配置当前是保存到env的，而不是按照我们统一的插件的配置来管理和保存的"
>
> "触发的逻辑我理解应该是按照定时任务按照正常的定时任务的流程和逻辑执行然后来触发的"

## What

### Phase A: Schedule 成为插件一等资源

让 `schedule` 资源类型在插件框架中全链路可用：

1. **manifest parser**：`parsePluginManifest` 从 deferred 列表移除 `schedule`，正式解析。schema 校验：`type: schedule` + `name` + `factoryId`（白名单引用，不支持任意脚本加载）
2. **capabilities schema**：扩展 `CapabilityEntry.type` 支持 `'schedule'`，CLI config 生成忽略 schedule 条目（不影响 MCP/skill 配置）
3. **PluginResourceActivator**：实现 `activateSchedule` / `deactivateSchedule`，通过 `ScheduleFactoryRegistry` 查找 factoryId → 创建 TaskSpec → `TaskRunnerV2.register()` / `.unregister()`
4. **ScheduleFactoryRegistry**：白名单注册表，每个 factory 声明 `factoryId` + `createTaskSpec(deps)` 工厂函数。deps 注入：taskStore / router / invokeTrigger / redis / log 等
5. **post-start 注册**：修复 `TaskRunnerV2.register()` 在 `start()` 之后调用时不自动 schedule timer 的问题，或新增 `registerAndSchedule()` 方法
6. **rehydrate**：启动时从 capabilities.json rehydrate enabled schedule resources，在 `taskRunnerV2.start()` 前注册

### Phase B: GitHub 升级为真正的插件

将 GitHub 从伪插件迁移为标准 plugin.yaml 插件：

1. **创建 `plugins/github/plugin.yaml`**：声明 config fields（GITHUB_TOKEN 可选 / GITHUB_SETUP_NOISE_BOT_LOGINS / GITHUB_MCP_PAT）+ GitHub schedule resources（引用 factoryId）
2. **创建 `github-schedule-factories.ts`**：将 `index.ts` 中 GitHub TaskSpec 的构造逻辑搬入，注册到 ScheduleFactoryRegistry
3. **config 兼容**：service 内部读取 plugin config store，缺失时按字段 fallback 到当前进程 env；但不把 plugin config 全局同步进 `process.env`。当前基于 `gh` 的 poller 在启动 `gh` 子进程时只传入显式解析到的非空 token；token 解析顺序为 plugin `GITHUB_TOKEN` → `process.env.GITHUB_TOKEN` → `process.env.GH_TOKEN`，传给子进程时统一写入 `GITHUB_TOKEN` 并移除 `GH_TOKEN`。token 缺失或空值时移除 `GITHUB_TOKEN/GH_TOKEN`，让 `gh` 使用自身登录态。无需迁移脚本
4. **移除硬编码**：删除 `index.ts` 中 GitHub task 的硬编码注册代码
5. **前端对接**：`GithubConfigPanel` 对接 `PluginConfigPanel` 或保留定制面板但通过插件 API 读写配置
6. **移除 connector-hub 定义**：从 `connector-hub.ts` 的 PLATFORMS 数组中移除 GitHub 平台

### Phase C: PR Tracking 增强

1. **instructions 参数**：`register_pr_tracking` 新增 `instructions?: string` 参数，存入 `automationState.trackingInstructions`
2. **触发消息拼接**：review-feedback / cicd-check 触发时，将 trackingInstructions 拼接到触发消息，让猫按用户意图执行
3. **unregister_tracking**：新增 MCP 工具，按 subjectKey 注销 tracking 任务
4. **安全边界**：GitHub comment/issue body 按"不可信外部内容"包装；用户 instructions 是任务偏好，不覆盖系统/家规/A2A 规则

### Phase D: Issue Tracking

1. **扩展 TaskKind**：新增 `issue_tracking` kind，subjectKey 格式 `issue:{owner/repo}#{num}`
2. **issue comment poller**：新增 GitHub 插件 schedule factory `github.issue-tracking`，扫描 `issue_tracking` tasks，轮询 issue comments
3. **MCP 工具**：`register_issue_tracking(repo, issue, instructions?)` / `unregister_tracking`
4. **面板 UI**：Schedule 面板过滤/展示 issue_tracking 类型任务
5. **注销机制**：讨论结束后手动注销，或设 auto-close 条件（issue closed → 自动注销）

## Acceptance Criteria

### Phase A（Schedule 资源框架）✅
- [x] AC-A1: `parsePluginManifest` 正确解析 `type: schedule` 资源，schema 校验 `factoryId` 字段
- [x] AC-A2: `capabilities.json` 支持 `type: 'schedule'` 条目，CLI config 生成忽略 schedule 条目
- [x] AC-A3: `PluginResourceActivator.activateSchedule()` 通过 ScheduleFactoryRegistry 创建 TaskSpec 并注册到 TaskRunnerV2
- [x] AC-A4: `deactivateSchedule()` 正确 unregister TaskSpec + 清理 capability entry
- [x] AC-A5: 运行时 enable 插件后 schedule 任务自动开始执行（post-start register）
- [x] AC-A6: 启动时 rehydrate enabled schedule resources 正确恢复调度
- [x] AC-A7: 单元测试覆盖 activate/deactivate/rehydrate/post-start 场景

### Phase B（GitHub 插件化）✅
- [x] AC-B1: `plugins/github/plugin.yaml` 包含 config 声明 + GitHub schedule resources
- [x] AC-B2: GitHub config 通过 plugin-config-store 读写，不再走 connector-hub → `.env`
- [x] AC-B3: `index.ts` 中无 GitHub task 硬编码注册代码
- [x] AC-B4: 禁用 GitHub 插件后 GitHub poller 停止执行；启用后恢复
- [x] AC-B5: connector-hub PLATFORMS 中无 GitHub 平台定义
- [x] AC-B6: 前端配置面板正确读写 GitHub 插件配置
- [x] AC-B7: 已有 pr_tracking 任务在迁移后继续正常工作（向后兼容）

### Phase C（PR Tracking 增强）
- [ ] AC-C1: `register_pr_tracking` 支持 `instructions` 参数，正确存入 automationState
- [ ] AC-C2: 触发消息包含 trackingInstructions 上下文
- [ ] AC-C3: `unregister_tracking` MCP 工具可按 subjectKey 注销
- [ ] AC-C4: 外部 GitHub 内容（comments/body）标记为不可信，不注入系统指令

### Phase D（Issue Tracking）
- [ ] AC-D1: TaskStore 支持 `issue_tracking` kind，无 TTL 保护
- [ ] AC-D2: issue comment poller 正确轮询并路由到对应 thread
- [ ] AC-D3: `register_issue_tracking` / `unregister_tracking` MCP 工具可用
- [ ] AC-D4: issue closed 时自动注销 tracking 任务

## Dependencies

- **Evolved from**: F140（GitHub PR Signals — 重构其定时任务生命周期）
- **Evolved from**: F141（GitHub Repo Inbox — 重构 repo-scan 注册方式）
- **Evolved from**: F133（CI/CD Tracking — 重构 CI check 注册方式）
- **Related**: F202（Plugin Framework — 扩展 schedule 资源类型）
- **Related**: F139（Unified Schedule Abstraction — 接入 TaskRunnerV2）

## Risk

| 风险 | 缓解 |
|------|------|
| Phase B config 迁移可能导致已有 GitHub 配置丢失 | plugin config store 优先，缺失时按字段读取旧 env；`gh` 子进程只接收显式解析到的非空 token，零迁移代码 |
| post-start register 可能引入竞态条件 | TaskRunnerV2 内部加锁保护 post-start 场景 |
| 移除 connector-hub GitHub 定义可能影响其他 connector 功能 | connector-hub 仅移除 GitHub 条目，其他 platform 不受影响 |
| GitHub API rate limit 在 issue tracking 增加轮询目标后更紧 | 全局 poller 模式维持，不按 thread 起独立 poller |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 保持全局 poller + 按 thread 路由模式 | F139/F140/F141 既有架构；per-thread poller 浪费 API rate limit | 2026-06-02 |
| KD-2 | TaskStore 和 DynamicTaskStore 不合并 | TaskStore 是 subject 真相源，DynamicTaskStore 是定时器定义；职责不同 | 2026-06-02 |
| KD-3 | schedule resource 用白名单 factoryId，不支持任意脚本加载 | F202 明确 non-goal；安全边界 | 2026-06-02 |
| KD-4 | GitHub 系统级 poller 用 factory 引用，不封装成 TaskTemplate | 系统级 poller 不是 per-user 的，和 template per-thread 语义不匹配 | 2026-06-02 |
| KD-5 | Issue tracking 新增 `issue_tracking` TaskStore kind | 不复用 `work`（避免 TTL/清理策略误伤），和 `pr_tracking` 保持一致性 | 2026-06-02 |
| KD-6 | Config 读取使用 plugin store 优先、进程 env fallback；禁止全局 sync plugin config 到 `process.env` | 避免 GitHub token 污染 API 进程及猫猫 CLI 子进程；`gh` 子进程只在有显式非空 token 时接收局部 env，否则使用自身登录态 | 2026-06-02 |
| KD-7 | 全局 poller 保持现状（Phase B 只迁移注册路径，不改运行逻辑） | 全局 poller 是任务本身的实现，不属于插件化重构范围；插件禁用 → 注销任务即可 | 2026-06-02 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-02 | 立项，缅因猫 review 对齐方案 |
| 2026-06-03 | Phase A + B implemented, cross-cat review pass (PR #846) |

## Review Gate

- Phase A: 跨猫 review（缅因猫 review 框架实现）
- Phase B: 跨猫 review + 铲屎官验收（涉及配置迁移和前端变更）
- Phase C: 跨猫 review
- Phase D: 跨猫 review + 铲屎官验收（新增用户可见功能）

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Feature** | `docs/features/F202-plugin-framework.md` | 插件框架（扩展 schedule 资源） |
| **Feature** | `docs/features/F139-unified-schedule-abstraction.md` | 统一调度抽象（接入 TaskRunnerV2） |
| **Feature** | `docs/features/F140-github-pr-automation.md` | GitHub PR Signals（重构来源） |
| **Feature** | `docs/features/F141-github-repo-inbox.md` | GitHub Repo Inbox（重构来源） |
| **Feature** | `docs/features/F133-cicd-tracking.md` | CI/CD Tracking（重构来源） |
