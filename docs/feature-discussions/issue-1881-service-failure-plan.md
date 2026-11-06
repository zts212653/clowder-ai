---
topics: [desktop, service-lifecycle, connection-feedback]
doc_kind: implementation-plan
created: 2026-11-06
---

# Issue #1881：后台退出感知与持续断联提示

## 原始问题与采纳边界

来源：[Issue #1881](https://github.com/zts212653/clowder-ai/issues/1881) 和[维护者首反](https://github.com/zts212653/clowder-ai/issues/1881#issuecomment-6680955291)。实现基线为 `next@43c1c3cb7e4e2ba0285c993d5cc5bd016824a663`。

维护者接纳的结果是：持续故障不能反复挤占交互区域；关闭提示应有效，恢复后应清理；自有进程意外退出应给出可理解的状态，并区分启动失败、主动退出和升级停止。

本方案提供故障通知与明确的退出重开路径，不自动重启 Redis、不自动降级内存、不全局暂停轮询。维持普通 toast、用户主动打开的通知全文、设置返回提示的原有语义，不更改通用容量与点击能力。

## 复现与证据分层

- 实际子进程：用 `ServiceManager._startProcess` 启动临时 Node 进程，分别模拟 API、Web、Redis。终止各自句柄后，原实现只写日志，owner 收到 0 次通知；期望为 1 次。三个依赖连续退出也应只报告一个故障。测试未启动真实 Redis 或连接用户数据。
- Web 状态：使用真实 `apiFetch` 和 toast store，连续请求失败时，手动关闭后仍会被下一次轮询重新创建；恢复请求成功后原提示也没有主动清理。store 测试同时覆盖用户持有通知的去重边界。
- 实际浏览器组件：渲染生产 `ToastContainer`、生产 CSS 和 `apiFetch`，只替换 HTTP 线。原代码运行相同场景，在第 60 秒观察到 **2 条**可见提示，断言 `2 !== 1`；修复后走通持续断联、关闭、恢复、再次断联、再次恢复和输入框点击输入。
- 这不是安装版三服务终止后的整体验收。普通 5000ms toast 的计时与 300ms 退出动画能够产生重叠，但本轮不能据此声称已复现报告中的“10 条锁屏堆积”。安装包 build SHA、锁屏、设置返回与打开全文等现场条件仍需单独验证。

原始命令输出保留于本工位的 `artifacts/issue1881/`，不提交本机绝对路径日志。

## 调用链与实现

### Web 提示生命周期

`apiFetch → performApiFetch → performSessionRequest → diagnosticFetch`；传输失败由 `reportApiConnectionFailure → toastStore.addToast → ToastContainer` 展示。

`api-client.ts` 用当前故障的 toast ID 表示一个提示周期。第一次 TypeError/TimeoutError 创建现有的可关闭常驻提示；同周期后续失败仅记诊断，不新增 toast。手动关闭不会解除故障周期。普通业务请求实际返回 2xx 或条件 GET 返回 304 后，仅删除该故障 toast 并解除周期，允许之后的新故障再提示。503、调用者 abort、仅 session bootstrap 或诊断上报成功均不作为业务恢复。

使用已有请求继续探测恢复，不增加计时器、探针、自动重试或对 mutating 请求的重放。故障周期仅在当前页面内存中，刷新后重新识别；它是临时连接反馈，不是用户持久化状态。

### Desktop 服务退出

`ServiceManager.startAll → _startProcess → ChildProcess.exit → onUnexpectedExit → main.js → 原生 dialog`。

`running` 仅在完整启动成功后置为 true。启动中退出继续使用现有启动错误路径。`stopAll` 在发出任何终止前撤销运行态，覆盖退出、升级、启动清理。运行期间当前自有句柄第一次退出，即使退出码为 0，也撤销运行态并向上通知；同次故障的兄弟进程退出仅写日志。成功的新一轮 `startAll` 重新启用观察。

主进程首次启动和升级后重新创建 ServiceManager 时都接入相同通知处理器。原生错误框无需 Web/API 存活，说明完全退出后重新打开以及关闭窗口可能进入托盘；只有用户选择“退出应用”才走现有受控退出。关闭对话框不会自动停止或重启服务。

`desktop/package.json` 的 `build.files` 同时登记新增运行模块，避免源码通过但安装包缺文件。

## 验证命令与判据

```powershell
node --test desktop/service-runtime-exit.test.js desktop/service-failure-handler.test.js desktop/service-startup.test.js desktop/service-shutdown.test.js
pnpm --filter @cat-cafe/web exec vitest run src/utils/__tests__/api-client-outage.test.ts src/utils/__tests__/api-client-retry.test.ts src/utils/__tests__/api-client-timeout.test.ts src/utils/__tests__/api-client-diagnostics.test.ts src/stores/__tests__/toastStore.test.ts src/components/__tests__/ToastContainer.test.tsx
pnpm --filter @cat-cafe/web exec node --test test/browser/issue1881-connection-notice.test.mjs
```

浏览器验证地址为拦截的 `https://issue1881.test`，执行目录为本 feature checkout；没有请求运行实例的 3003/3004/6399。浏览器及临时子进程由测试负责停止。

扩大验证时，`desktop/installation-write-boundary.test.js` 的 `source provider initialization preserves skill links...` 在 Windows 上比较 `../../...` 与 `..\\..\\...` 失败。用 `git archive` 导出未修改的同一 `upstream/next` 测试与四个依赖模块后，单独运行仍以相同断言失败；该基线问题不在本修复中改动。打包文件 allowlist 相关用例通过。

验收应同时满足：同一断联周期至多一条提示、关闭后不再出现、成功后清理且下一次故障可重报、保留其他用户持有通知、业务失败不重放、主动停止不误报、三个服务连续退出不打开三个框。

## 风险、责任与回退

Architecture cell：既有 Desktop 运行生命周期与 Web 传输反馈。Map delta：none；未转移 owner，未新增持久状态或协议。

行为变化为连接提示由 5 秒消失改为手动关闭或恢复清理，以及桌面依赖退出新增原生通知。数据、安全、API 契约及部署边界没有变化。取消单次修复提交可回退；不需要数据迁移。

作者负责复现、实现、验证与 PR；鲸鲸负责独立分析及方案反例；非作者完成最终内容审查；维护者决定合入。安装包现场复验属于待验证项，不能把本轮隔离组件和进程测试写成安装版通过，也不在本轮关闭 Issue。
