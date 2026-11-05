---
feature_ids: [F320]
topics: [codex, native-tool, onboarding, issue-1654]
doc_kind: bug-report
created: 2026-10-21
tips_exempt: 修复一键检测已有契约，不新增操作或用户配置项。
---

# #1654 原生 Codex 配置归属修复与验收

原始需求：[Issue #1654](https://github.com/zts212653/clowder-ai/issues/1654)、
[用户分析](https://github.com/zts212653/clowder-ai/issues/1654#issuecomment-6311863363)。
本次授权：独立 feature 分支和 worktree，从系统层修复，覆盖检测、添加、首次对话、续聊和重启；本机 Codex 配置不得修改。

## 根因与修复

`native_tool` 且没有显式 `accountRef` 的成员应由原生 CLI 决定认证和 provider。
此前聊天入口已经部分遵守这个契约，但能力目录、本地会话读取和成员准入仍会选择应用默认账号。
能力启动又把缺省账号当成 OAuth，强制 `model_provider="openai"`，因此配置归属随入口改变。
`prepareCapabilityLaunch` 属于能力与读取入口，并非普通聊天的共同前置；修复不能仅删除该处参数。

- 共享原生归属判定与运行账号解析，聊天、能力目录和本地会话读取在选应用默认账号之前分流。
- 能力启动和调用都保留 `auto`，不注入 provider、不清除原生 API 环境、不切换原生 HOME。
- 成员准入同样忽略无关应用默认账号，按原生 provider 或真实登录状态判断。
- 显式账号继续执行已有账号、身份、OAuth/provider 和 API Key 隔离检查。未新增持久化认证类型。

Architecture cell：existing provider account / invocation / onboarding boundaries。
Map delta：共享归属判定，不新增状态存储或平行启动系统。

## 自动验证

先观察到原生能力启动的 4 项 RED（错误 OAuth/provider/HOME），后转绿；
补充的真实添加路由在存在无关默认 OAuth 账号时得到 400、预期 201，再修复并转绿。

| 范围 | 结果 |
| --- | --- |
| 源码原生启动、首次/续接/重建 service、检测及账号环境 | 75/75 |
| 最终构建后的 provider 启动、模式、创建及准入 | 17/17 |
| Web 一键创建 hook 与原生角色配置 | 22/22 |
| shared、API、MCP build | 通过 |
| 全仓 `pnpm lint`（含全部包 TypeScript / Web ESLint） | 通过，既有 warning 保留 |
| 本次修改文件 Biome | 通过 |

Windows 测试辅助代码改为平台路径分隔符、大小写不敏感的 PATH 键查找，
POSIX 0700 断言只在能表达该权限的系统执行；生产认证边界未因此放宽。

全仓 `pnpm check` 初次误用不可用的 WSL Bash；使用已安装 Git Bash 后，
进入未修改的 `check-f290-product-copy.test.mjs`，因 Windows `\\` 与预期 `/` 路径不同失败；
在未修改的 main 同 SHA 上运行该测试，复现同一失败。
`check:architecture-ownership` 在当前仓库不存在，记录工具缺口，不伪造通过。
`pnpm check:artifacts` 的容量检查 2/2、MCP surface governance（198 tools、无 surface delta）通过；
随后被 F310 缺少 ROADMAP 索引阻挡，未修改 main 上同样失败。本次账号解析归属沿用
[F320](../features/F320-multi-oauth-account-switching.md)，不声称完成其整体多账号愿景。

## 真实完整旅程

源码 worktree：`worktrees/feat-issue-1654-native-config`，base `44fb36e65b3a9ea4ebb9a9a875e0605c06f80289`。
唯一作者环境：API `127.0.0.1:3112`、Web `127.0.0.1:5112`、Redis `127.0.0.1:6388`。
独立项目、HOME、原生会话和 SQLite 位于任务 artifacts，生产 `3003/3004/6399` 未接管。

1. 空成员实例从页面“一键检测”读取本机配置的隔离副本，只选择 Codex 并“一键创建 1 位伙伴”。
   读回成员为 `native_tool`、空模型、没有 `accountRef`、`app_server`。
2. custom provider 下，原生 CLI 与应用调用都返回上游 502；应用页面显示了实际错误。
   未修改用户配置或代理，也未将这次失败记作成功调用。
3. 仅将隔离 HOME 切到已有订阅登录的副本，真实首次回复 `ISSUE1654_FIRST_OK`。
4. 同一对话续聊回复最初校验词 `CEDAR1654`。
5. 隔离应用账号目录加入无关默认 OAuth 账号，重启最终构建的 API，重新加载页面。
   历史完整保留，再次真实续聊回复 `CEDAR1654`。
6. 保存独立 Redis，停止 Redis/API/Web，核对进程全退出、三个端口全部释放。
   复用同一套目录冷启动整套服务，从磁盘恢复历史；页面再次续聊回复 `CEDAR1654`。

持久化读回：同一应用 session `839af920-a7f9-4961-b7ad-191db43515d8`，
同一原生 session `01a15db9-b446-7201-8a2b-935e2bf49597`；API 重启时 4→6 条消息，
整套冷启动前的 6 个消息 ID 全部保留、续聊后共 8 条，均未另开 session。
使用本机 CLI **0.161.0**，未据此声称覆盖 Issue 报告中的 0.163.0。
本次未验证外部原生历史导入，也未改动该功能。

## 证据与边界

本地证据目录：`G:\AIwork\clowder-ai\artifacts\issue1654-native-config-20261021`。
`instances.json` 记录进程与数据归属；`continuity-proof.json` / `cold-restart-proof.json` 记录会话、
磁盘恢复和原始文件只读哈希核对。`01-detected.png` 到 `08-cold-restart-resume.png` 记录 UI；
各测试、构建和模型调用日志保存在同目录。
该目录含私有测试认证副本，不纳入 Git 或公开报告。

原始 `C:\Users\Administrator\.codex\config.toml` 与 `auth.json` 哈希均未改变。
订阅模式真实旅程通过；custom provider 的成功回复仍受本机上游 502 阻挡，不能据此关闭其真实环境验收。
没有部署、合并或关闭上游 Issue。分支与数据保留供审阅，作者临时服务在取证后受控停止。

## 独立审查与收尾

非作者 `review_issue1654` 审查提交 `84ba84b643288fbc059bbc632a2d0beed3d77483`，
回读上游问题和评论，独立执行 8/8 回归，返回本地 `approve`，无 P1/P2。
它只批准该提交的代码，不代表 custom provider 真实验收、部署批准或 Issue 关闭。
审查后的增量仅补本文证据，源代码与已审提交逐字节一致。

最终核对：作者进程残留 0，`3112/5112/6388` 无监听；生产 `3003/3004/6399`
仍为原 PID。保存了独立 Redis；没有删除配置、认证、会话、SQLite 或数据库。
worktree 由本任务作者具名保留供审阅，2026-10-28 复查；数据与用户环境持续保护。
