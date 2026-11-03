---
feature_ids: [F032, F127, F143, F161, F241]
topics: [acceptance, windows, macos, intranet, agent-client]
doc_kind: acceptance-matrix
created: 2026-10-30
status: in-progress
---

# 平台、网络与发行物验收矩阵

矩阵基线为 `6d8d4915bcd84edfeb42edf76466cf6318cecdbd`。这是支持承诺及证据缺口清单，不是本分支已发布或全部通过的声明。源码测试、浏览器夹具、真实客户端、最终安装包分别记录；相同场景不因改变标签重复制造模型会话。

## 既有承诺的证据

- 本基线 README.md 的安装章节声明 Windows EXE 和 macOS DMG；不是仅 Windows 项目。
- `.github/workflows/build-mac-dmg.yml` 声明 arm64、x64 两个发行目标，因此 macOS 外网不能凭本机不可用改为 N/A。
- `.github/workflows/build-windows-desktop.yml` 产生安装 EXE 与 portable ZIP，两种发行形态都须检查数据根与升级/回退；CPU 目标以 `desktop/scripts/build-desktop.ps1` 的最终产物 manifest 为准。
- Windows 内网历史目标来自 `G:/AIwork/clowder-ai/worktrees/feat-intranet-windows-codeagent/docs/ops/intranet-windows-packaging.md`。该指南把历史包、源码、Release 标签分开，并明确不能用历史通过代替新 HEAD。它仅证明已有 Windows x64 内网路线，不推出 macOS 企业 CodeAgent 发行物。
- 用户确认本机没有 CodeAgent，授权简单 mock。本地接入契约可以用该替身验收；企业认证、内网 CA/组件源、真实工具/模型能力和 macOS 支持仍不由 mock 证明。

## 环境与判定

| 环境 ID | OS/CPU、网络、发行物 | 必须执行的验收 | 当前证据与缺口 |
|---|---|---|---|
| WIN-PUBLIC | Windows x64，外网，EXE / ZIP | E01–E04 适用旅程；真实 native 与 ACP 绑定；首装/升级/回退；Q 样本 | 本机 win32 的源代码、真实浏览器及隔离 Redis 部分通过。没有本分支最终包、真实模型 Q 结果；整项 NOT_RUN |
| WIN-INTRANET | Windows x64，无公网出口，企业发行物 | E01/E04；CodeAgent E03；CA/代理/认证/组件源及端口/数据边界 | 本机 CodeAgent mock 的进程/协议契约已通过，未证明当前主机无公网出口或企业认证。真实企业发行物 NOT_RUN；本地 mock 结果单列 |
| MAC-ARM-PUBLIC | macOS arm64，外网，DMG | E01–E04 适用旅程；GUI 环境发现、原生状态根；Q 样本 | 已有发行目标，required；用户 2026-10-30 确认暂无 Mac，环境缺失 BLOCKED，不计 N/A |
| MAC-X64-PUBLIC | macOS x64，外网，DMG | 同上，须使用 x64 安装包/客户端；不以 arm64 转译或静态测试代替 | 已有发行目标，required；用户确认暂无 Mac，环境缺失 BLOCKED |
| MAC-ARM-INTRANET | macOS arm64，无公网出口，已承诺的企业绑定 | Host E01/E04、离线组件/CA/代理；企业已承诺的客户端执行 E02/E03 | 用户确认暂无 Mac，Host 实机检查 BLOCKED；尚无已核验企业 macOS CodeAgent 发布物，不新增该绑定承诺。CodeAgent 为候选、未声明支持 |
| MAC-X64-INTRANET | macOS x64，无公网出口，已承诺的企业绑定 | 同上，核对 x64 企业组件实际存在 | 与 arm64 分开记录。用户确认暂无 Mac，Host 实机检查 BLOCKED；CodeAgent 为候选、未声明支持 |

本矩阵不替代逐客户端 C14：Claude、Codex、Google/AGY、Kimi、Pi、DSH、OpenCode、CatAgent、A2A、通用 ACP/iCode 保留其原生或 ACP 实际载体。每个已承诺的 `(OS, CPU, 网络, client, carrier, version)` 形成一条结果；名称相似、命令包含某字符串或同为 ACP 都不能合并为同一个通过项。

本轮扩大回归确认 AGY Native 的 Windows 进程出生身份不可用，压缩/普通路由等用例失败。`docs/features/F325-antigravity-native-parity.md` 的现有边界明确 Linux/Windows 未认证；这一路径保持候选/FAIL，不扩大启用，不从 Windows Host 发行承诺推导 Native 已通过。AGY ACP 与 Native 分开；其本机协议/权限回归不能代替官方程序和真实认证验收。

## 每条正式证据的最小字段

| 字段 | 记录内容 |
|---|---|
| source / package | Git SHA、构建 manifest、安装包 SHA256、版本、发行形态 |
| binding | catId、clientId、carrier、implementation ref/generation、client/bridge 版本、实际程序路径；不记录密钥 |
| environment | OS/CPU、网络出口事实、代理/CA 来源引用、Host 与原生状态根、认证引用 |
| instance | 任务/负责人、程序/数据目录、端口、PID、用途、保留期限与收尾状态 |
| journey | E/C/Q 编号、输入、实际采用值、预期、结果 PASS/FAIL/BLOCKED/NOT_RUN/N/A、日志或画面引用 |
| continuity | Host 历史读回、原生 session ID、片段切换原因、是否发生副作用；unknown 不自动重发 |
| cleanup | 仅核验归属的作者进程已停止、端口释放、原生测试会话清单；所有认证/角色/历史/Redis/SQLite 保留 |

`N/A` 必须附不适用原因，不能用于替换缺机器、缺凭据、缺产物或用例失败。只发布通过的绑定；未通过环境不随某一个客户端的局部绿灯扩大启用。

## 当前隔离实例回执

- Redis：本任务新建 6398，两个真实 Redis CAS 用例通过；已正常 `SHUTDOWN SAVE`，端口释放，RDB/AOF、日志、实际 Windows PID 和 Redis 内部 PID 均保留于 `artifacts/role-agent-refactor-20261029-gpt-sol/redis-2b474ff89b184d0097eeabba771ddb56/instance.json`。没有访问生产 6399。
- 浏览器：生产 SettingsShell/MemberSettingsPage + 本工位真实 Fastify 路由，网络/Next router 使用现有隔离夹具。编辑职责与全局参数、刷新后读回通过；浏览器及 Fastify 已关闭。假 catalog 在 result.json 指向的独立临时根保留；无模型调用、无真实 HOME。
- CodeAgent mock：每个独立状态根记录 instance.json，实际 AcpClient 启动 Node 子进程后统一 close；断线与取消场景按未知/受控停止处理。测试始终使用独立 HOME/USERPROFILE，不读写真实原生会话。
- 不运行本任务交互服务，没有占用 3003/3004；未修改/停止用户验收环境。上述本地证据都不是最终包或 macOS 实机证据。

## Windows 当前安装候选的只读盘点（未认证实际绑定）

2026-10-30 在本机只读取 PATH shim、安装包 package.json 和文件元数据，未启动客户端、登录、模型任务或原生会话。证据 windows-command-inventory.json 与 windows-shim-inventory.json 位于本任务 artifacts；后者从实际 shim 解析 package 路径，不按产品名猜 npm 包名。

| 命令候选 | 实际 shim 所指包元数据 | 证据边界 |
|---|---|---|
| Claude | @anthropic-ai/claude-code 2.1.312 | 未证明 Host 最终选中该入口或该版本任务通过 |
| Codex npm | @openai/codex 0.161.0 | PATH 另有桌面 codex.exe，不能将两者合并为同一绑定 |
| Gemini | @google/gemini-cli 0.66.0 | 仅安装元数据 |
| Pi | @earendil-works/pi-coding-agent 1.3.0 | 不能按另一发行包或旧 API 的版本推断能力 |
| OpenCode | @opencode/cli 2.0.28 | 仅安装元数据 |

Kimi 有独立 exe；其 Windows 文件版本为 24.15.0，该信息可能属于嵌入运行时，未当作 Kimi 客户端版本。DSH 有本地仓库 shim，真实发布版本尚未由同一 launch owner 核验。PATH 未发现 CodeAgent/iCode/AGY 不代表所有 Host 配置不存在；CodeAgent 继续使用用户授权 mock。此次盘点不更新任一 E/Q 项为通过，也不代替 C23 的发现→探测→实际执行路径一致性。
