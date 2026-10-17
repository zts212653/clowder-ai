# Windows 重启后旧 child 一直显示执行中

## 原因与修复

Windows 上，`readUnixProcessSnapshot` 及同步版本原先在检查明确的空 PID 集合之前返回 `null`。即使没有任何 owner manifest，`createCliExecutionOwnerService().listLive()` 也返回 `complete: false`，启动流程因 owner 快照不完整而跳过 `TurnExecutionStartupReconciler`。

旧 child 因而继续处于 `running`。侧栏的 `active-execution-service` 直接枚举这些 running children，将它们计入 working 与最早执行时间；任务完成提示所查询的父 InvocationRecord 却可能已经终态，所以会同时出现“任务已完成”与旧执行起点。

修复仅调整两个快照读取函数的判断顺序：明确空 PID 集合返回完整空 Map，之后才判断 Windows 是否不支持实际进程查询。有有效 manifest 或未指定 PID 范围时，Windows 仍返回未知，不新增强制清理规则。现有启动收口会把早于或等于本进程启动时间、且无已确认 live owner 保护的旧 child 标为 `interrupted/process_restart`；不是标为成功，也不删除执行记录。

Architecture cell: dispatch / process ownership.

Map delta: none — 继续使用 owner service 与既有 startup terminal writer。

Why: 明确的空查询集合已经可确认，不应降级为平台进程读取未知。

Canonical source: `packages/api/src/utils/cli-process-ownership.ts#readUnixProcessSnapshot` 及同步版本。

Consumer evidence: `rg -n 'readUnixProcessSnapshot' packages/api/src`；consumer 包括 CLI owner service、reaper 与 owned process tree。侧栏通过 owner service 与 TurnExecution store 的现有 composition 消费终态。

Claim guard: Windows 非空 PID / 有 manifest 仍未知 → `Windows snapshots...`、`Windows owner discovery...`；把非空查询当作完整空结果时测试失败。

Tips exemption: 修正既有重启恢复及状态呈现，不增加新的用户能力或操作入口。

## 验证

- RED：新增三个 Windows 回归均失败。分别观察到空 PID 快照为 null、无 manifest 的 owner 快照不完整、重启后的旧 child 保持 running。
- GREEN：三个回归均通过；组件组合测试使用临时 owner 目录与 InMemoryTurnExecutionStore，验证旧 child 为 `process_restart`，当前进程启动时间之后的 child 保持 running，running 查询不再含旧 child。没有在用户 Redis 上运行实验。
- 定向检查：35 项，33 通过、2 项按原有 Windows 条件跳过、0 失败；覆盖 owner identity、manifest 读取失败、重启收口及真实 sidebar presence composition。
- API 完整构建通过（Windows 使用 Git Bash script shell）；修复后的 API TypeScript 编译、三文件 Biome 检查与 `git diff --check` 通过。capability tips checker 通过，存在未修改文档的 anchor 警告。
- 扩大到 ownership/reaper/process-tree/startup/sidebar 五文件：44 项，33 通过、9 跳过、2 失败。失败为 `manifest parsing and socket cleanup paths fail closed` 与 `startup reaper quarantines malformed manifests without signalling by guess`；将隔离 worktree 的编译产物换成未修改 `origin/main` 版本后，两项同样失败，随后恢复候选编译产物。这是已有 Windows/Unix 测试兼容问题；本 PR 未修改、跳过或弱化这两项原测试，不宣称全套通过。

定向命令：

```powershell
node --test --test-name-pattern='Windows|owner|PID|group signalling|Linux|TurnExecutionStartupReconciler|F297' packages/api/test/cli-process-ownership.test.js packages/api/test/turn-execution-startup-reconciler.test.js packages/api/test/f297-sidebar-presence-source.test.js
```

## 运行态验收边界

代码尚未在运行实例激活。需经 review、合入/运行态激活授权后，由 operator 在空闲窗口重启；再核对旧 child 的 durable 终态、running 索引与侧栏投影。此处未重启 API、修改用户 Redis 或写入运行配置，也不把隔离组件测试表述为线上已恢复。
