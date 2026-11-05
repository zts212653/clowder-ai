# #1838 停止证据方案定案（宪宪，2026-11-05）

基线：upstream/next@a7c32a4fc327817d63b333a4cd3ed7ed8728ee3d
工位：G:/AIwork/clowder-ai/worktrees/fix-issue1838-restart-recovery
前序实验：artifacts/issue1838/windows-stop-evidence-experiments.md

## 被推翻的方案（砚砚反例，已实测复现）

「登记时全表读成功 ⇒ 未来可从死 root 证明整树停止」不成立。

反例时间线（实测返回 `verified-stopped`，而 writer 仍活）：

| 时刻 | 事实 |
| --- | --- |
| t0 | root=10，**无任何后代**；登记成功 → `chainObserved=true` |
| t1 | root 才 spawn launcher20 → launcher 再 spawn writer30 |
| t2 | launcher20 与 root 同时退出 |
| t3 | 表里只剩 writer30，其 ppid 指向已死的 20 |

从 root(10) 向下走找不到 writer30（它的父是 20），而 `chainObserved=true` 又把空遍历当成完整证明 → 假解锁。
实测确认：`classifyWindowsStopEvidence([{pid:10}], new Map(), {fullTable:{30<-20}, chainComplete:true}) === 'verified-stopped'`。

**采样频率救不了这个反例**：t0 与 t1 之间无论多快采样，都可能正好落在"还没 spawn"的空窗。这不是概率问题，是可用信息不足。

另两条已实测的否定证据：
- 机器上 462 个进程中 **16 个**的 ppid 指向已死进程（系统普遍噪声），所以"全表存在断链"不能作为判据。
- 从死 root 按 ppid 递归**只能**证明仍可连通的后代；断链 writer 天然不可见。

## 定案方案：用 IPC 换取可核验的受控收尾，而不是事后探测

新增实测（决定性）：

| 停止方式 | Node 子进程能否执行 handler |
| --- | --- |
| `child.kill('SIGINT')` | 否 |
| `child.kill('SIGTERM')` | 否 |
| `process.kill(pid,'SIGINT')` | 否 |
| **`child.send({stop:true})`（IPC）** | **是** |

Windows 上信号不触发 Node handler，**只有 IPC 能可靠通知对端**。因此正确路线不是"猜旧进程死没死"，而是让持有 provider 的进程在被要求停止时**自己完成有界收尾并留下凭据**：

1. **正常停止（主路径）**：desktop 先通过 IPC 请 API 结算（关准入 → 停 provider 树 → 写终态/teardown → 关连接），有界等待；超时才强杀。收尾由既有 shutdown 复用，不复制流程。
2. **强杀兜底**：`taskkill /T /F` **不能**作为停止证明。实测反例（砚砚探针，我已独立复跑）：root→launcher→detached writer，launcher 先退出后，`taskkill root /T /F` 退出码 0、root 已死，而 **writer 仍存活**（`writerSurvivesSuccessfulTaskkillTree: true`）。taskkill 同样依赖 PPID 链，断链处即断。

### ✅ 我的「NO-SPAWN」结论已被推翻——根因是我自己的 helper bug（2026-11-05）

**我错在哪**：我观察到「投靠 Job 后 spawn 不出任何子进程」，据此推断 libuv 不支持 Job 嵌套、Job 方向不可行。这个归因是**错的**。

**真正根因**（由砚砚的单变量 A/B 定位，我独立复现）：PowerShell 把裸字面量 `0xFFFFFFFF` 推断为 `Int32 = -1`，传给 `WaitForSingleObject(UInt32)` 直接抛类型转换异常；异常落进 `finally` → 关闭 Job handle → `KILL_ON_JOB_CLOSE` **把宿主自己杀了**。宿主已死，后续 spawn 自然「没有 error、没有 exit」——那是我自己的 bug 制造的现象，不是平台限制。

我的独立复现：
```
[T]::Echo(0xFFFFFFFF)        -> THROWS「无法将值 -1 转换为 UInt32」
[T]::Echo([uint32]::MaxValue) -> 4294967295
(0xFFFFFFFF).GetType().Name   -> Int32
```

**仅修这一处后的端到端复测（产品形态 `stdio:['pipe','pipe','pipe']`）**：

| 观察 | 结果 |
| --- | --- |
| adoption | `adopted: true` |
| provider spawn（pipes 形态） | 成功，`spawn-error: (none)`，`tree.json` 生成 |
| 中间 launcher | 退出（`launcher-exit: code=0`）→ 断链 |
| 断链 detached writer | `alive: true` |
| **只杀 host 后** | `writer alive: false`（Job 回收成功） |
| 外部查询 Job | `{verdict:"absent", nativeError:2}` |

→ **Job 方向成立**，与砚砚 A/B 结论一致。我此前的「事实 1/3/4」作废，第三路线探索停止。

**教训**：我把「观测到的现象」当成了「平台语义」，没有先排除自家代码的异常路径；`finally` 里关 handle 会让 bug 表现成完全不同的故障。后续遇到「机制看起来不可行」先做单变量 A/B，再下结论。

砚砚探针在**它自己的 fixture** 上 PASS，我复跑同样 PASS。但把同一机制接到**产品 spawn 语义**上时，实测到两个阻塞事实，两者都独立复现：

**事实 1：API 一旦被 Assign 进 Job，就再也 spawn 不出任何子进程。**

用真实 Node 宿主（adopt 自身后再 spawn），四种 spawn 形态全部失败，且**无 error、无 exit、无 throw**——子进程根本不产生：

| spawn 形态 | 结果 |
| --- | --- |
| `stdio:'ignore'` | 未启动 |
| `stdio:['pipe','pipe','pipe']`（**产品真实形态**） | 未启动 |
| `detached + pipes` | 未启动 |
| `detached + ignore` | 未启动 |

并已排除「flag 调优」解释：`KILL_ON_JOB_CLOSE`、`+BREAKAWAY_OK(0x0800)`、`+SILENT_BREAKAWAY_OK(0x1000)` 三种组合**都**是 `NO-SPAWN`。原因是 Node/libuv 在 Windows 为每个子进程创建自己的 Job，而已在不可 breakaway 的 Job 中的进程无法再嵌套。

→ 「把 API 自己放进 Job」会让 API 彻底无法启动 provider，**不能作为产品方案**。

**事实 2：改让 helper 收养 provider（API 不进 Job）也不完整。**

API 保持无 Job 时可正常 spawn（`provider` 与 detached `writer` 都起来了）。helper 收养 provider pid 后关闭 Job：provider 被回收，但 **detached writer 存活**（`writer alive: true`）。
→ detached 子进程会脱离 Job 归属，断链 writer 仍不是这套机制能覆盖的。

**结论**：砚砚探针之所以 PASS，是因为它的 host 在 adopt 之后仍然 spawn 成功——那与我在**产品等价形态**下观察到的"adopt 后无法 spawn"不一致。差异点必须先定位：要么探针的 host 并未真正进入 Job（`IsProcessInJob` 只验证了 helper，没验证 host），要么存在其它环境差异。

**在定位这个矛盾之前，不应把 Job 方案写入产品代码**，也不应继续打磨 chainObserved。已提交的 3 个 commit 只包含「登记 + CIM 活体判定」的部分，尚未接入 Job；本轮新增的 `windows-job-owner.ts` 与相关测试**未接线、未提交**，等我与砚砚对齐事实后再决定去留。

### 被质疑的探针证据（砚砚 PASS，我复跑也 PASS）

砚砚探针已实测，我也独立复跑 PASS（`job-probe-run-ZPvrKz`）：

| 观察 | 结果 |
| --- | --- |
| helper 是否在自身管理的 Job 外 | `helperOutsideJob=true`（用 `IsProcessInJob` 自证） |
| launcher 是否先于 host 退出（制造断链） | `launcherExitedBeforeHost=true` |
| writer 在 host 退出前是否存活 | `writerAliveBeforeHostExit=true` |
| 杀 host 后 writer | `writerAliveAfterHostExit=false`（断链也一并回收） |
| 外部查询 Job | `present, activeProcesses=2` → 杀后 `absent, nativeError=2` |

机制（砚砚探针所验证的）：helper 在 API 尚未进 Job 前 spawn → `CreateJobObject` 随机具名 + `KILL_ON_JOB_CLOSE` + 禁 breakaway → `AssignProcessToJobObject(API)` → 成功且持久 owner 落盘后才允许 provider 准入。helper 自身在 Job 外持有 handle 并等待 API 退出；API 死后 Job 关闭，**内核按归属回收全部后代，不依赖 PPID 链**，断链 writer 也死。重启侧用 `OpenJobObject` 精确查询同名 Job：明确 `ERROR_FILE_NOT_FOUND`（无成员/已关闭）才可判定停止；权限或查询失败一律 `unknown`。

**事实 3：Job 对象在最后一个 handle 关闭的瞬间就不存在了。**

实测：`CreateJobObject` 建名 → 关闭唯一 handle → 立刻 `OpenJobObject` 同名得到 `err=2 (ERROR_FILE_NOT_FOUND)`。
→ 「job 不存在」**不能**区分三种情况：(a) 拥有者已死、树已被回收；(b) 拥有者还活着但 helper 已退出、handle 丢失；(c) 从未成功建立。JOBS 语义里，只要 helper 不再持 handle，查询就永远返回 2——**包括旧 provider 仍在跑的情况**。

配合事实 1 得到的完整解释：我第一次跑 `verify-host-membership.mjs` 时，adoption 报 `adopted:true`，但外部进程查询该 job 得到 `JOB_OPEN_FAIL 2`。说明那次 helper 早已退出、handle 已关，**Job 实际不存在**——`adopted:true` 只代表 helper 打印过 READY 并且落盘了记录，不代表 Job 仍在。这正是「用一个会消失的 handle 去证明停止」的根本弱点。

**事实 4（待与砚砚对齐的差异）**：他的探针之所以 PASS，是因为他的 host 在被 Assign 后**仍然 spawn 成功**；而我在**产品等价形态**（Node 进 Job 后再 spawn）下四种形态全部 spawn 不出（事实 1）。这两个观察不可能同时为真，除非他的 host 事实上没有进入 Job。最可疑处：探针只对 **helper** 做了 `IsProcessInJob` 自证，**从未验证 host 自身**；若 Assign 对 host 未生效（或 host 早已因其它原因重开），探针就会得到「能 spawn + 事后 writer 被回收」的组合——而那个组合在产品形态下不成立。

边界：**不在** API 运行时用 Job 终止整棵树（那会连 API 一起杀）；运行中的 Stop 仍走既有单 provider 归属路径。WMI `Win32_Process.Create` 产生的进程不继承 Job，因此这是"API 及后代"的归属，不宣称全局 containment。
3. **无凭据的旧账本**：保持 `unknown`，继续阻止第二 writer，并在原 entrypoint 可见可操作（精确 invocationId + 需人工核验的原因）。

关键：**登记不再试图证明"未来会停"**。`chainObserved` 这类由采样推出的字段删除，避免把不可证事实写进凭据。

## 实施边界

- 不新增原生依赖（项目无 koffi/JobObject），不建全量进程监控。
- 旧记录的 `verified-stopped` 判定收紧：只有"已收到该执行的确切收尾/强杀回执"才允许解锁。
- `unknown` 一律不解锁、不假解锁；PID 复用只能导致更保守。
- 不手动补 teardown 伪装重启 GREEN；测试必须经真实产品接线消费凭据。

## 已收尾的测试进程

见 windows-stop-evidence-experiments.md；本轮新增探针均按精确 PID 收尾，收尾后复核 `CommandLine` 匹配数为 0。
