# #1838 停止证据方案定案（宪宪，2026-11-05）

基线：upstream/next@a7c32a4fc327817d63b333a4cd3ed7ed8728ee3d
工位：G:/AIwork/clowder-ai/worktrees/fix-issue1838-restart-recovery
前序实验：artifacts/issue1838/windows-stop-evidence-experiments.md

## 定案：API 级 Win32 Job 持有整棵树，重启时用同 session 的 OpenJobObject 判停

1. API `main()` 最前（任何子进程之前），helper 在 API 尚未进 Job 时 spawn，自身留在 Job 外。它创建随机名 `Local\ClowderApiJob-<uuid>`，配置 `KILL_ON_JOB_CLOSE`、不设任何 BREAKAWAY；**先**原子落 owner 记录（含 sessionId），**再** Assign API；Assign 后自证 host 在 Job 内、helper 在 Job 外，才打印 READY。顺序的理由：API 成为成员后 helper 任何退出都会连带杀 API，所以可失败的步骤都放在 Assign 之前。
2. helper 持有唯一 handle 直到 API 退出。API 无论怎么死，handle 关闭，内核按归属回收全部成员，不依赖 PPID 链，断链 writer 也会被回收。
3. provider 准入：`markProviderStarted` 之前原子写 execution→job link（jobName + 完整执行身份 `executionId/invocationId/threadId/catId/userId`）。link 写失败则本轮在 provider 启动前失败。
4. 重启：对除本进程外的每条 owner 记录，从同 session 查询 `OpenJobObject`。只有 `ERROR_FILE_NOT_FOUND(2)` **且** session 与记录一致才判 absent。`Local\` 名按 session 解析，别的 session 查一个活 Job 同样得到 2，所以 session 不一致、present、其它错误码、查询失败一律 unknown，执行保持保护。
5. absent → 对每条与账本身份一致、仍 running 且 started-unconfirmed 的执行写 `recordProviderTeardown`（时间取实际核验时间）。之后由既有 `TurnExecutionStartupReconciler` 转 interrupted/process_restart 并结算 response，callback auth 随终态投影，`StartupReconciler` 收父 invocation。全部结算后才删 link 与 owner 记录；中途失败则证据保留，下次启动重试。

### 实测证据（本工位，Windows 11，产品 stdio 形态）

| 用例 | 结果 |
| --- | --- |
| root→launcher→detached writer，launcher 先退出，只杀 host | writer 被回收；查询 present/2 → absent/nativeError 2 |
| 只 adopt、无其它工作的宿主 | 自然 exit 0。单变量对照：不 unref 两条 stdio 管道，45s 仍不退出 |
| 双宿主 + 私有持久 Redis（随机端口、独立密码与目录）+ Redis 重启 | A 存活时 B 不放行（`job_present`）；修复前恢复路径：执行仍 running/blocked（RED）；修复后：released → interrupted/process_restart，running 列表为空，A 的证据清除（GREEN）；重复恢复无变化 |

命令：`test/windows-job-owner.test.js`、`test/windows-job-stop-recovery.test.js`（可移植）、`test/windows-job-restart-recovery.test.js`（需 PATH 中有 `redis-server`）。

### 边界

- 归属范围是 API 及其后代。不经该树创建的进程（如 WMI `Win32_Process.Create`）不在 Job 内，不被声称。
- Windows 上 API 异常退出现在也会回收其全部后代（含本地服务、managed runner worker），与 desktop 正常停止时 `taskkill /T /F` 的结果一致。
- adoption 失败（如 PowerShell 被策略禁用）时不拒绝 provider：行为回到修复前（崩溃后执行保持保护、需人工核验），并在启动日志明确告警。
- 运行中的单个 Stop 不从 API 级 Job 推断 provider 子树已空：Job 只在 API 死后才给出结论。
- 本轮测试覆盖的是 child、response-pending 与终态；callback auth 投影、父 invocation 收尾、Stop/侧栏入口和安装布局仍待真实整机验证。

## 被推翻的方案

### A. 事后从死 root 按 PPID 重建（chainObserved / CIM 走树）

反例时间线（实测返回 `verified-stopped`，而 writer 仍活）：

| 时刻 | 事实 |
| --- | --- |
| t0 | root=10，无任何后代；登记成功 → `chainObserved=true` |
| t1 | root 才 spawn launcher20 → launcher 再 spawn writer30 |
| t2 | launcher20 与 root 同时退出 |
| t3 | 表里只剩 writer30，其 ppid 指向已死的 20 |

从 root(10) 向下走找不到 writer30，空遍历被当成完整证明 → 假解锁。采样频率救不了：t0 与 t1 之间无论多快都可能落在空窗。另实测：机器上 462 个进程中 16 个的 ppid 指向已死进程，"存在断链"不能作判据。该模块（`windows-cli-child-owner.ts`）已从产品中删除。

### B. `taskkill /T /F` 作为停止证明

root→launcher→detached writer，launcher 先退出后，`taskkill root /T /F` 退出码 0、root 已死，而 writer 仍存活。taskkill 同样依赖 PPID 链。

### C. 我曾得出的「API 进 Job 后无法 spawn」：根因是我自己的 helper bug

我观察到"投靠 Job 后 spawn 不出任何子进程"，据此推断 libuv 不支持 Job 嵌套。这个归因是错的。砚砚的单变量 A/B 定位、我独立复现：PowerShell 把裸字面量 `0xFFFFFFFF` 推断为 `Int32 = -1`，传给 `WaitForSingleObject(UInt32)` 抛转换异常 → 落进 `finally` 关闭 Job handle → `KILL_ON_JOB_CLOSE` 杀掉宿主自己。宿主已死，自然"没有 error、没有 exit"。

```
[T]::Echo(0xFFFFFFFF)        -> THROWS「无法将值 -1 转换为 UInt32」
[T]::Echo([uint32]::MaxValue) -> 4294967295
(0xFFFFFFFF).GetType().Name   -> Int32
```

同期另两条推论也不成立：先让 provider 跑 2500ms 再 Assign 的实验只说明 Job 不追溯收养已出生的后代，不能推出 detached 逃逸；空 Job 关最后一个 handle 后查不到名字，也不能推出正确赋予成员的 `KILL_ON_JOB_CLOSE` 会漏掉活 writer。教训：先排除自家代码的异常路径再下"平台不支持"的结论；`finally` 里关 handle 会让 bug 表现成完全不同的故障。

## 其它实测事实

Windows 上 `child.kill('SIGINT'|'SIGTERM')` 与 `process.kill(pid,'SIGINT')` 都不会触发 Node 子进程的 handler，只有 IPC（`child.send`）能可靠通知对端。spec 第 3 节"正常桌面停止先结算"应走 IPC。

## 已收尾的测试进程

本轮探针与测试均按精确 PID 收尾，收尾后复核匹配数为 0；私有 Redis 实例均已停止，用户的 6399 实例未被触碰。
