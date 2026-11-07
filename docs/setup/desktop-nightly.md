---
feature_ids: [F179, F330]
topics: [desktop, installer, regression, windows, macos]
doc_kind: runbook
created: 2026-11-07
---

# 桌面安装包回归

## 用例目录

[用例目录](../../.github/desktop-acceptance/nightly-cases.json) 是冒烟和全量共用的清单。首版是待产品负责人校对的候选。按用户旅程讨论首装、首启、启动归属、升级、历史状态、原生客户端和兼容环境。确认每条用例适用的系统与架构、前置状态、操作、断言、证据和维护人。L0 只保留每轮必须验证的核心可用性。L1 是常用旅程与升级，L2 是特定集成和恢复，L3 是长尾兼容。冒烟选择 L0，全量选择所有适用等级。

- 严重 Issue 进入复盘时，记下漏检类型（缺用例、选集没命中、样本没覆盖、断言过弱、实际没运行），并决定新增、修订、升级等级，或记录已有覆盖的证据。把 Issue 号回填到用例。有可复用旧包时，使用同一断言分别验证受影响包和修复包。
- PR 改变安装或产品旅程时，在 PR 中列出受影响的用例 ID，随改动更新其步骤、断言、适用性或证据。按周从上次复盘 SHA 起扫合入记录，核对遗漏和失效样本。产品负责人决定等级，执行维护人核对证据和可重复性。
- 预期失败提前登记 `id`、`platform`、`code`、`issue`、`expires`。实际失败须匹配平台、用例和失败码，且仍在有效期。登记不会把缺测、其他失败或原始失败改成通过。

首次回溯示例是 [#1749](https://github.com/zts212653/clowder-ai/issues/1749)。窗口打开和 HTTP 200 都可能来自外来实例，干净首装也不会制造争抢。全量的 `WIN-PORT-PREFLIGHT` 和 `MAC-PORT-PREFLIGHT` 用实际安装包和受控监听者复测启动前的 API、Web 和同时占用，保存端口监听 PID 和启动状态。Windows 保存 Electron 页面列表，Mac 核对窗口生命周期日志和受控 Web 请求。各平台的健康实例冲突和预查后抢占由 `DESKTOP-PORT-OWNERSHIP` 验证。旧 Windows 包曾在预查后显示外来页面，修复包在同一场景拒绝就绪。见 [修复及回归入口](https://github.com/zts212653/clowder-ai/pull/1870)。

首次合入复盘从试跑源码 `b58412451` 扫到 `12514727`，范围内只有 DSH 图片路由修复。原有续聊用例只验证文本上下文，无法发现图片握手仍绑定旧路由。新增 `DESKTOP-DSH-IMAGE-ROUTE` 为 L2，覆盖视觉、文本和恢复原会话三种结果。该用例依赖专用 DSH 和模型额度，保留在全量选集。见 [合入变更与已有证据](https://github.com/zts212653/clowder-ai/pull/1896)。

第二次复盘从 `12514727` 扫到 `3569a9b6`，纳入 [#1811](https://github.com/zts212653/clowder-ai/issues/1811) 的认证边界修复。真实客户端续聊无法发现普通诊断的认证副作用，新增全量 L2 `DESKTOP-NATIVE-AUTH-DIAGNOSTIC`，从已安装 API 解析 Kimi、OpenCode 和 DSH 的生产准入入口。用现有夹具提交惰性载荷，检查拒绝变更和允许查询。真实 OAuth、取消和超时清理仍是母单中的独立授权验收。见 [合入证据](https://github.com/zts212653/clowder-ai/pull/1822)。

第三次复盘从 `3569a9b6` 扫到 `cf49dacc`，纳入 [#1907](https://github.com/zts212653/clowder-ai/pull/1907) 的可见 Works 分页变更。安装首启和持久化回读无法发现目录自动读尽、首页入口另起 reader 或部分结果失去继续入口的问题。新增全量 L1 `DESKTOP-WORKS-PAGINATION`，在实际安装版核对首批请求、已读作品展开、主动续页、零命中、隐藏恢复和首页两入口。该场景需要专用测试目录和桌面证据，缺少前置条件时保留阻塞。源码层的浏览器与实际路由证据见 [维护者合入的验证记录](../evidence/issue1864-visible-pagination/README.md)。

## 触发和证据

[Desktop Nightly](../../.github/workflows/desktop-nightly.yml) 进默认分支后，每天北京时间 00:00 选 `next` 跑双平台冒烟。手动入口可选源分支、平台和测试范围。触发端提交和被测源码提交分别保存。构建与下载按同一 run ID 和 attempt 配对。需要重跑时使用新的手动运行或重跑整个 workflow，避免混用部分重跑前的产物。

相同触发方式、分支、平台和选集共用一个并发组。手动 Windows 全量可以独立于双平台冒烟运行。桌面测试仍按测试机独占执行。

Windows 测试运行真实 EXE，全量也测试便携 ZIP。macOS 在相应架构的临时 runner 上挂载真实 DMG，安装进空闲的 Applications 路径并检查两轮启动。报告区分应用启动断言与清理结果。原生脚本的覆盖限于其实际路径，普通用户下载后的系统安全弹窗和桌面首启引导另有用例。

Windows 全量另在独立 runner 执行 `WIN-UPGRADE-STATE`，从用例记录的公开发布版创建会话和画像，再用候选 EXE 原位升级。候选安装和启动沿用历史安装标记，隔离 HOME 并省略实例根和端口的外部覆盖，核对旧样本能被正常恢复。基线的 tag、提交、资产 ID 和包哈希随用例版本保存。基线不可用或候选版本未更新时记录阻塞。发布新稳定版后，维护人核对并更新该基线。工作区、上传资源和设置的完整升级旅程仍在 `DESKTOP-UPGRADE`。

构建端上传安装包后记录同轮 SHA-256。报告把这些哈希带给协调端和 Codex 测试机。原生验证作业缺测时，已发布的包仍可独立校验并准备桌面测试，原生用例保留阻塞。构建与原生验证的哈希不一致时，报告记录 L0 新失败，并拒绝为该包准备或合并桌面执行结果。

查看 Actions 的作业摘要和对应 attempt 的 `desktop-nightly-report` artifact。JSON 保留逐例原始结果和分类，Markdown 置顶 L0 新失败、L0 未完成、已知失败。报告列出的 `desktop-evidence-*` 目录名对应各平台证据 artifact。平台未构建、无法启动 runner 或缺收据的用例会保留在报告里并标为阻塞。

待测分支或包版本解析失败时仍生成报告，保留请求的分支和选集。用例统一标为 `candidate-source-unavailable` 或 `package-version-unavailable`。后一种情况保留已经冻结的提交。协调端可以下载并汇总这份报告，测试机不下载安装包。

## Codex 桌面收据试跑

在专用桌面测试机或 VM 上执行。Windows 保持活跃、解锁并独占前台，macOS 核对辅助功能和屏幕录制权限。预置被允许的测试应用和测试账户。Windows 管理员安装与 macOS Gatekeeper 需要权限或人工操作时，保留阻塞，不改变系统安全设置。严禁指向日用安装、生产端口或个人 HOME。

1. 运行 `node .github/desktop-acceptance/nightly-desktop.mjs zts212653/clowder-ai <run-id> <platform> <新目录>`。它只下载同一运行和 attempt 的报告与候选包，使用 Actions 的平台哈希校验后写出 `desktop-plan.json`。原生验收发现安装版本或源码戳不符时，桌面端停止准备该安装包。旧报告的哈希从同轮平台证据下载。核对目标机、测试目录、端口和安装权限，由已授权的测试环境安装，先记录程序路径和安装实例身份。
2. 在 Codex 中按 `desktop-plan.json` 顺序执行该平台选中的交互用例，计划同时包含 `computer-use` 和 `manual` 场景。为每条保存具体观察和截图。缺少测试样本、授权账户或必要人工操作时，记录 `blocked` 和具体原因。
3. 收据顶层复制原报告的 `runId`、`attempt`、`source`、`catalogRevision`。逐例记录 `id`、`platform`、`status`、`code`、证据文件名 `evidence` 和安装包 `packageSha256`。合并单机试跑时，在报告指定的用例版本执行 `node .github/desktop-acceptance/nightly-evidence.mjs reconcile <证据根目录> <桌面收据JSON>`，令 `GITHUB_SHA` 为该用例版本。截图与收据同目录，校验哈希只从原报告所在的证据根读取。旧报告需要把同轮 Actions 平台证据目录下载到该根目录。

### 多平台汇总

各测试机和协调端使用同一个获准的共享证据位置，每个 run ID 和 attempt 使用独立子目录。协调端运行 `node .github/desktop-acceptance/nightly-desktop.mjs zts212653/clowder-ai <run-id|today> report <新目录>`，下载原报告和 Actions 的安装包哈希。协调端只需这些小文件。

- 协调端先准备共享运行目录。测试机等同轮 `report.json` 到位并核对运行身份，再把截图放入 `desktop-receipts/<平台>/`。写完截图后，把同目录的临时收据重命名为 `<名称>.receipt.json`。不同平台各写自己的目录，每个用例只提交一份最终收据。
- 协调端单独运行 `node .github/desktop-acceptance/nightly-evidence.mjs reconcile <共享运行目录> --until <带时区的截止时间>`，时间使用 ISO 8601，例如 `2026-11-07T04:00:00+08:00`。在报告指定的用例版本运行，令 `GITHUB_SHA` 为该版本。命令用协调端从 Actions 下载的哈希核验收据，齐备后立即出报告。到期时把仍缺收据的桌面用例标为 `desktop-receipt-deadline`，已提交的阻塞原因照常保留。
- 汇总写入 `report-with-desktop.md` 和 `report-with-desktop.json`，证据路径相对于共享运行目录。原报告保留。迟到的有效收据提交后可对同一目录重新汇总。

Codex 定时接入的验收包括一次真实手动首启、一次从 Codex 本地定时任务触发的首启和一次桌面不可用的故障演练。定时任务能否在目标机器调用 Computer Use 和拿到新候选包，需要实际运行才能确认。

设置定时任务时使用独立本地运行，指定专用测试机的仓库目录和单个平台。把准备命令的 run ID 参数设为 `today`，它只选择当天北京时间的 Desktop Nightly 定时运行。待该轮出具报告后执行上述步骤。为每个 run ID 和 attempt 保存一次桌面报告。若当天未触发、构建未出包、桌面锁定或权限不足，保留当轮原因。主动复跑使用同一流程，显式传入 run ID。

### 定时任务说明

在专用测试机新建 Codex 本地定时任务。按实测构建时长安排本地触发，给 00:00 启动的 GitHub 构建留出时间。将下列说明中的平台和证据根目录替换为测试机的值。

```text
在本机执行今天的 Clowder AI 桌面回归，只测试 <平台>。在 <证据根目录> 下按 run ID 和 attempt 保存证据，已有完整报告时复用它。

读取仓库 docs/setup/desktop-nightly.md。用 nightly-desktop.mjs 的 today 入口选择当天候选。若该运行还在构建，等待同一运行出具报告，再准备安装包。若超过本机的运行窗口，记录 run ID、最后观察到的阶段和阻塞原因。候选准备失败时保留日志，重试使用新的准备目录。

仅在获准的专用测试机和全新测试实例上安装 desktop-plan.json 中通过哈希校验的包。检查程序目录、数据目录、测试端口和桌面会话。无法确认权限、隔离或窗口时记录阻塞。

按 desktop-plan.json 中的全部交互用例顺序实际操作安装后的窗口。逐项核对测试样本、账户与权限等前置条件，满足时执行并记录可见行为、结果和截图，缺少条件时记录 blocked 和具体原因。结束时正常退出本次实例，把包哈希及运行身份写入收据，再按多平台汇总约定提交收据和截图。
```

协调端使用独立的本地定时任务。用同一天的 `today report` 入口在共享位置准备报告，再用 `reconcile --until` 等待提交至本轮截止时间。主动试跑指定同一个 run ID。可以省略 `--until` 立即按当前收据重新汇总。

首次验收时按真实手动运行、定时运行、锁屏或无可用窗口三种状态分别留证。三次均须保留可归属的报告，阻塞场景应明确指出未执行的用例。
