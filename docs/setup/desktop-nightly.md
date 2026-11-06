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

首次回溯示例是 [#1749](https://github.com/zts212653/clowder-ai/issues/1749)。窗口打开和 HTTP 200 都可能来自外来实例，只有干净首装的用例也不会制造争抢。把早期端口占用和预查后竞争补入 `DESKTOP-PORT-OWNERSHIP`，要求记录监听 PID、数据根和渲染器实际加载的内容。旧包曾在预查后显示外来页面，修复包在同一场景拒绝就绪。已合入的源码测试覆盖归属断言，安装包全量仍须保留这一旅程。见 [修复及回归入口](https://github.com/zts212653/clowder-ai/pull/1870)。

## 触发和证据

[Desktop Nightly](../../.github/workflows/desktop-nightly.yml) 进默认分支后，每天北京时间 00:00 选 `next` 跑双平台冒烟。手动入口可选源分支、平台和测试范围。触发端提交和被测源码提交分别保存。构建与下载按同一 run ID 和 attempt 配对。需要重跑时使用新的手动运行或重跑整个 workflow，避免混用部分重跑前的产物。

Windows 测试运行真实 EXE，全量也测试便携 ZIP。macOS 在相应架构的临时 runner 上挂载真实 DMG，安装进空闲的 Applications 路径并检查两轮启动。原生脚本的覆盖限于其实际路径，普通用户下载后的系统安全弹窗和桌面首启引导另有用例。

查看 Actions 的作业摘要和对应 attempt 的 `desktop-nightly-report` artifact。JSON 保留逐例原始结果和分类，Markdown 置顶 L0 新失败、L0 未完成、已知失败。报告列出的 `desktop-evidence-*` 目录名对应各平台证据 artifact。平台未构建、无法启动 runner 或缺收据的用例会保留在报告里并标为阻塞。

## Codex 桌面收据试跑

在专用桌面测试机或 VM 上执行。Windows 保持活跃、解锁并独占前台，macOS 核对辅助功能和屏幕录制权限。预置被允许的测试应用和测试账户。Windows 管理员安装与 macOS Gatekeeper 需要权限或人工操作时，保留阻塞，不改变系统安全设置。严禁指向日用安装、生产端口或个人 HOME。

1. 运行 `node .github/desktop-acceptance/nightly-desktop.mjs zts212653/clowder-ai <run-id> <platform> <新目录>`。它只下载同一运行和 attempt 的报告、平台证据和候选包，核对 SHA-256 后写出 `desktop-plan.json`。核对目标机、测试目录、端口和安装权限，由已授权的测试环境安装，先记录程序路径和安装实例身份。
2. 在 Codex 中打开该次运行的用例目录，按选集执行 `computer-use` 用例。为每条保存具体观察和截图。前置条件不满足时记录 `blocked` 和原因。人工用例可按相同方式补录。
3. 把报告 JSON 放入证据根目录。保持 Actions 下载的 `desktop-evidence-平台-attempt-N` 目录名。在同一位置保存桌面收据 JSON，截图和收据放在一起。收据顶层复制原报告的 `runId`、`attempt`、`source`、`catalogRevision`，逐例记录 `id`、`platform`、`status`、`code`、证据文件名 `evidence` 和安装包 `packageSha256`。
4. 在报告指定的用例版本执行 `node .github/desktop-acceptance/nightly-evidence.mjs reconcile <证据根目录> <桌面收据JSON>`。令 `GITHUB_SHA` 为该用例版本。输出 `report-with-desktop.md` 和 `report-with-desktop.json`，保留 Actions 的原始报告。二次汇总只补桌面和人工用例，原生执行结论不由 Agent 修改。

Codex 定时接入的验收包括一次真实手动首启、一次从 Codex 本地定时任务触发的首启和一次桌面不可用的故障演练。定时任务能否在目标机器调用 Computer Use 和拿到新候选包，需要实际运行才能确认。

设置定时任务时使用独立本地运行，指定专用测试机的仓库目录和单个平台。先查当天北京时间的 Desktop Nightly 定时运行，待它出具报告后执行上述步骤。为每个 run ID 和 attempt 保存一次桌面报告。若当天未触发、构建未出包、桌面锁定或权限不足，保留当轮原因。主动复跑使用同一流程，显式传入 run ID。
