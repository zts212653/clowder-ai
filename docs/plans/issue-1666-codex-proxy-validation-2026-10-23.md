---
feature_ids: []
topics: [codex, windows, proxy, native-tool, issue-1666, pr-1670]
doc_kind: validation
created: 2026-10-23
status: partial_acceptance_no_merge
tips_exempt: 本次记录已有代理修复的验证范围，没有新增用户入口或操作。
---

# PR #1670：CI 修复与隔离真实调用验收

用户授权：修复两处 CI 失败，恢复隔离环境，补齐真实调用、续聊、重启恢复，更新 PR 正文；不合并。
本轮完成两处 CI 修复和 OAuth 路径的四轮真实调用。企业代理下的本地 custom provider
完整旅程仍未通过，不能据此关闭 Issue #1666。

## 1. 源码与 CI

- PR：[zts212653/clowder-ai#1670](https://github.com/zts212653/clowder-ai/pull/1670)。
- 运行源码：`e0f89cec44ec026640643bc44c26e419503bddc8`。
- 工位：`G:\AIwork\clowder-ai\worktrees\feat-issue-1666-codex-proxy`。
- 分支：`feat/issue-1666-codex-proxy`。本文为其后的纯文档提交，不改变运行源码。
- 代码提交 CI：20 项已结束，19 项通过，`Public test (serial bootstrap)` 按配置跳过。
  [CI](https://github.com/zts212653/clowder-ai/actions/runs/39921499912)、
  [Windows Smoke](https://github.com/zts212653/clowder-ai/actions/runs/39921499924)、
  [macOS Preview Lifecycle](https://github.com/zts212653/clowder-ai/actions/runs/39921499949)。

| 原失败 | 原因 | 本轮处理与证据 |
| --- | --- | --- |
| distributable-1：F320 capability account HOME | 测试仍期待 `CODEX_API_KEY: null`，最终完整环境已删除该键 | 断言改为键不存在，同时要求 `inheritParentEnv=false`；远端分片通过 |
| distributable-5：Unix pooled host owner env | 低层 host spawn 丢失 canonical 环境净化，显式执行 owner/token 可泄漏 | 恢复 `buildChildEnv` 净化；签名、auth、spawn 消费同一快照；远端分片通过 |

准备好的完整快照显式禁止再次继承父环境；旧的部分环境调用方保留默认继承能力。
新增回归验证执行 owner、callback、私有凭据被过滤，代理/例外保留，等效环境签名一致。
新回归先观察到 RED，再经修复转为 GREEN。

本地 API build、TypeScript 检查及针对性 8 项回归通过。独立 reviewer 对
`3df1a583..e0f89cec` 三个文件的增量给出 approve，无 P1/P2；独立执行 23 通过、1 Windows 跳过。
该结论仅针对 CI 修复增量，不是整个 PR 的正式批准。

较宽的本地 Windows 回归曾出现 126 通过、10 失败、6 跳过，涉及 POSIX 路径、mock 时序等，
不能把本地整套测试称为全绿；当前远端各 Linux 分片及 Windows smoke 已全部通过。

## 2. 隔离环境恢复

既有根目录：`G:\AIwork\clowder-ai-issue-1666-isolated`。
API 3150、Web 3151、Preview 3152、Redis 6450；均为本任务既有坐标。
原 Redis AOF/RDB 保留，不清库。生产 3003/3004/6399 未用于本次验收。

原 catalog 使用不合法的 `version: "1.0.0"`。先保留原文件，再通过项目的
`bootstrapCatCatalog()` 入口创建合法 version 2 catalog。
补齐隔离项目的 `cat-template.json`，将 API 的 `CAT_TEMPLATE_PATH` 对齐到该项目，
避免启动注册表和成员保存分别读取不同目录。未添加吞掉配置错误的产品代码。

通过正常 `/api/cats` 写入一个 `native_tool` / `app_server` 成员，CLI 命令 `codex`，
模型留空并遵循隔离原生配置。首次保存因缺模板返回 500，但 catalog 已落盘；补齐项目后重启，
复用已保存成员，没有重复创建。当前成员与账号路由回读均为 200。
本轮未重新执行 UI 的“一键检测并添加”入口，因此完整 onboarding 旅程仍需复验。

稳定版 Codex `0.163.0` 固定复制至隔离 `bin/codex.exe`：
`SHA256=2692c8c7bb2cf8b0aefe638741fc90236f4b824c59578ce84994f9de58200993`。
避免误用本机 npm 的 0.161.0 或 Desktop alpha。

`HOME/USERPROFILE/APPDATA/LOCALAPPDATA/CODEX_HOME/CODEX_SQLITE_HOME` 均指向隔离根。
仅复用登录和模型配置，未复制或链接用户 sessions、索引、SQLite。
原用户 `config.toml` 前后哈希一致；原 `auth.json` 在并行使用期间哈希变化，归因未确认，
不能宣称该认证文件字节不变。作者脚本及任务启动环境均未以原 HOME 作为写入目标。

## 3. 真实调用、续聊与恢复

本轮使用真实 OAuth / `openai` provider；配置模型 `gpt-6.1-sol`，上游自报模型仅作观测。
未使用假 provider 响应。测试工作目录为隔离 `workspace`，仅一条测试会话。

| 步骤 | 验证动作 | 结果 |
| --- | --- | --- |
| 首轮 | 发送随机验收词，只要求回复确认 | completed，返回 `FIRST_OK` 与正确原词 |
| 普通续聊 | 不重新提供原词，询问最初验收词 | completed，返回正确原词 |
| API 重启 | 停止归属已确认的 API，原目录重启，回读 4 条消息后续聊 | completed，原词正确 |
| 整套重启 | 停 Web/API，Redis `SHUTDOWN SAVE`；用同目录重启，回读 6 条消息后续聊 | completed，原词正确 |

四轮保持同一个 Clowder thread 和原生 session：

- Clowder：`thread_owned_e75c241970a0b185ed758d5040c1207cbf2d4ee9`。
- Codex：`01a167ce-a970-7c00-a409-ccfd3c11108f`，最终 session `messageCount=4`。
- 最终持久化 8 条消息，4 个 assistant response 均为 completed。

首次回复的 UI 渲染、会话入口及第二轮执行状态已通过内嵌浏览器观察。
整套重启后的页面刷新先超时，随后浏览器工具报告 Work 设置禁用本地浏览器；
重启后验证基于 API、原生 session 和真实回复，不能写成页面复验通过，也无最终截图。

## 4. 原问题尚未覆盖的边界

本机原生 custom provider 的本地网关未监听，本轮真实调用走 OAuth/openai。
这证明调用与恢复链路可用，尚不能证明企业本地网关的 504 已消除。

这台 Windows 的系统 ProxyOverride 含通配符、地址段等不支持模式。运行日志记录降级，
实现保留原网络环境，不强行把系统例外改写为 NO_PROXY。
PAC/WPAD/无法读取的系统状态、`respect_system_proxy=true` 也不能计为现场修复成功。

此前 0.163.0 的受控 CLI 路由 fixture 有默认分支 10/10 记录，源码为此前的 `33e8`，
未在本轮运行源码重新执行；它不是本地 custom provider 的真实模型成功证据。
`respect_system_proxy=true` 当时也因宿主代理不可控而未接纳为通过。

下一步验收条件：提供可用的隔离本地 provider 网关及可控企业代理场景，
从正常 UI 检测/添加开始，核对网关与代理请求计数，再走首次、续聊和重启恢复。
本任务保留该未通过项供 PR 审核，不关闭 Issue，不执行合并。

## 5. 自检与收尾回执

Architecture cell：现有 Codex provider launch / CLI environment / App Server host lifecycle。
Map delta：没有新增持久化服务；修复共享 host 的环境边界。
Why：防止恢复净化时再次继承已经删除的凭据、执行标识或代理变量。

fallback 检查净增 1：两处 `cwd ?? process.cwd()` 各自位于公开准备与低层 spawn 边界，
复用同一净化函数。旧调用可省略 cwd，因此保留该默认值；不新增并行环境派生策略。
`check:capability-tips` 通过，有既有来源警告；本 checkout 没有
`check:architecture-ownership` 命令，未伪报通过。

验收后仅对上述 ID 执行原生 `thread/archive`：先核验 rollout 的 ID、工作目录、调用内容，
备份并校验 SHA256，再回读活跃列表不含该 ID、归档列表包含该 ID。
归档前后 rollout 哈希一致，可通过 `thread/unarchive` 恢复；未删除会话或 SQLite。

作者临时 API、Web、Redis 已停止，3150/3151/3152/6450 全部释放。
隔离 HOME、Redis、catalog、rollout 备份、日志和源码工位均保留供复核。
未安装 EXE、创建快捷方式或开机启动。生产配置、业务历史和其他任务实例未作清理。

本地原始证据（不上传认证、完整私有日志）：

- `G:\AIwork\clowder-ai\artifacts\issue1666-progress-20261023\acceptance-summary.json`。
- `G:\AIwork\clowder-ai\artifacts\issue1666-progress-20261023\ci-e0f89cec.json`。
- `G:\AIwork\clowder-ai-issue-1666-isolated\acceptance-control\20261023\instances.json`。
- 同目录 `native-archive-receipt.json` 与 `verified-native-rollout-backup.jsonl`。

工位 retained：`feat-issue-1666-codex-proxy`；负责人 Codex，2026-10-29 复查，届时不自动删除。
