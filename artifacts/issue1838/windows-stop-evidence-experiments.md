# #1838 Windows 停止证据实验结论（宪宪，2026-11-04）

基线：upstream/next@a7c32a4fc327817d63b333a4cd3ed7ed8728ee3d
工位：G:/AIwork/clowder-ai/worktrees/fix-issue1838-restart-recovery
实验目录：G:/AIwork/clowder-ai/artifacts/issue1838-probe（隔离，已收尾）

## 源码核验（全部命中方案表格）

| 断言 | 证据 |
| --- | --- |
| Windows defaultSpawn 直接 nodeSpawn，不经 supervisor | cli-spawn.ts:1338-1368 |
| DirectAgentCarrierSession Windows 分支同样直接 spawn | DirectAgentCarrierSession.ts:64-70 |
| supervisor 在 Windows **完全不建 manifest** | cli-supervisor.ts:79 `if (!IS_WINDOWS)` |
| owner-reaper 在 Windows 直接 return | cli-process-owner-reaper.ts:118 |
| 空 PID 短路发生在 win32 判定**之前** → Windows 得到 complete 空表 | cli-process-ownership.ts:355/402 |
| 退出观察只在内存 Map | CliExecutionObservation.ts:8 |
| startup 依赖 listLive().complete 决定是否收敛 | index.ts:7676-7693 |
| 准入拒绝 | invoke-single-cat.ts:3019 prior_provider_teardown_unconfirmed |
| PowerShell/CIM 是项目既有方式 | service-lifecycle.ts:305,444 |

## 原生实验（真实 Windows 进程，WMI 启动以脱离本 shell 的 Job Object）

1. **CIM 身份可用**：`Get-CimInstance Win32_Process` 返回 ProcessId / ParentProcessId / CreationDate。
   CreationDate 精度到 100ns（示例 ticks `639294048572096570`，`2026-11-04T16:00:57.2096570+08:00`）。
   → 足以做「PID + 出生时间」身份核验，满足 Win32_Process 文档要求的 PID 重用规避。

2. **孤儿真实存在（决定性）**：WMI 启动 parent(41680)→child(55308)，仅 `Stop-Process 41680`（不带 /T）。
   结果：41680 DEAD，**55308 ALIVE**，且 CIM 中 `ParentProcessId` 仍指向已死的 41680（陈旧 PPID）。
   → **根进程消失绝不等于整树停止**；这正是方案禁止「按根 PID 缺失判停止」的实证依据。

3. **可枚举已死父进程的后代**：root(34244, 已杀) 的子进程 51220 仍可通过
   `Get-CimInstance -Filter "ParentProcessId = 34244"` 查到，且确实 ALIVE。
   → 恢复期仍能按 PPID 链发现遗留后代，但必须叠加 CreationDate 才能排除 PID 重用。

4. 前两次对照（bash job 内启动）父子同死，是本 shell Job Object 的 kill-on-close 假象，
   不能作为 Windows 语义证据；已用 WMI 启动法排除。该假象本身说明：**必须用真实脱离场景取证**。

## 对实现的约束（据此定案）

- verified-stopped 必须同时满足：CIM 查询成功 + 根身份缺失或 CreationDate 不匹配 + 其 PPID 子树内无可归属存活后代。
- 「后代有存活」→ alive（可精确停止后复核）；CIM 失败/身份不可比 → unknown（保留阻塞，不假解锁）。
- PID 重用只能导致**假 alive**（更保守），绝不能导致假 stopped。
- 测试收尾禁止按 node 通杀，必须按记录的确切 PID 精确收尾。

## 测试进程清单与收尾

实验期间创建的进程均已按精确 PID 收尾：
- 36872/40860、59768/16596、62000/41640、19980/52448/28536、41680、34244：已随对照组退出或已 Stop-Process。
- 51220（唯一遗留孤儿，CommandLine 指向 issue1838-probe/child.js）：按精确 PID 停止，复核 ESRCH。
最终复核：`Win32_Process` 中 `CommandLine -like '*issue1838-probe*'` 的 node 进程数为 0。
