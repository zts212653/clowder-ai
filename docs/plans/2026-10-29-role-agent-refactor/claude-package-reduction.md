---
feature_ids: [F161, F241]
topics: [claude, packaging, external-runtime]
doc_kind: implementation-plan
created: 2026-10-30
---

# Claude 主包减重（PR #1748）

来源：用户要求在当前 PR 实施主包不再捆绑 Claude 大型程序。沿用既有工位与所有数据保护规则，不切换生产、不强制迁移 ACP。

PR #1748 的目标为上游 `develop`（2026-10-30 用户更正，已远端回读），不是 `main`；原始源码基线仍按总账保留。

1. SDK 调用显式使用外部 Claude：在既有准入端口捕获程序路径、版本及文件摘要，启动前核对；缺少程序或文件变化时在发送前报错。构造服务不发现或加载 Claude，其他客户端不受影响。
2. 冻结发行导出保留 SDK JavaScript 库，仅排除其平台原生包，包括根/私有嵌套及 Windows/macOS 布局。其他 optional/native 依赖保留。归档入口拒绝残留原生包，旧缓存不能绕过。
3. 先运行失败用例，再实现并运行 SDK、冻结导出、归档与类型检查。使用真实 SDK 无模型协议夹具验证外部程序调用及缺失处理；记录真实依赖文件和同条件压缩前后大小。
4. 更新 PR 和实施记录，提交并推送当前分支。Windows 安装包能否完整构建以实际结果记录；没有 Mac，不能宣称 macOS 实机/DMG 验收通过。

Architecture cell：identity-session / transport；Map delta：沿用原 captureInvocationOptions、SDK carrier 和 frozen-runtime-export，无新增 owner、数据库、下载器或生命周期。

验证入口：`node --test desktop/claude-runtime-packaging.test.mjs`；API 使用既有 with-test-home.mjs 与 SDK 测试命令。格式命令为 `pnpm biome format --write <本次文件>`，终态执行定向 Biome 与 API tsc。完整 34 项验收仍单独记账，本切片不替代整体验收。

## 已执行的代码与验证

`claude-sdk-runtime.ts` 复用原 CLI 发现和 Windows npm shim 解析，执行无模型的 `--version` 并捕获规范化入口和 SHA-256。正式调用在原 captureInvocationOptions 保存快照，发送前核对原文件；直接 SDK 调用也必须解析外部程序。SDK 的 Node 参数只接受 node/bun/deno，因此 JS 入口通过选定系统 Node 的目录构造子进程 PATH，不启动 Electron。模型发现共用同一解析和启动参数。构造服务和未使用 Claude 的 API 启动不探测客户端。

`frozen-runtime-export.mjs` 在原 materialize 边界按真实包名排除 Claude SDK 平台原生包，保留 JavaScript SDK 和其他 native/optional 依赖；共享和独立依赖布局及嵌套副本均覆盖。`create-runtime-archive.mjs` 在压缩前拒绝旧部署残留。没有全局 --no-optional、依赖锁重写、隐式下载或第二套 launcher。

| 已执行范围 | 证据与边界 |
| --- | --- |
| 可信 RED | claude-packaging-red.log：两种导出仍带原生包，旧缓存可归档；claude-external-red.log：SDK 未采用提供的程序路径 |
| 打包/导出/归档回归 | claude-packaging-final.log：14 PASS，无失败/跳过 |
| SDK/账号/权限/设置/压缩回归 | claude-sdk-regression.log：57 PASS、1 既有 SKIP；不将跳过计为通过 |
| 受影响调用/追加/停止/MCP | claude-sdk-affected-owner.log：50 PASS，无失败/跳过 |
| 真实 SDK 的独立程序协议 | claude-sdk-wire-closed.log：4 PASS。复制的真实 SDK 无 exe/node/native 包，验证调用、历史 API 读取不存在会话、模型发现、缺失提示和同路径文件更换拒绝。程序是协议夹具，不是实际模型 |
| 本机真实 Claude 2.1.312 | claude-real-external-receipt.json：SDK 0.3.285、真实产品 carrier、外部原生程序、本地合成提供方；10 项检查通过，含 UUID 已读、追加、工具结果、旧调用拒绝及同一 session 续接。未改写 SDK 提供的程序路径，没有真实模型请求 |
| 类型与格式 | API tsc 通过；26 文件 Biome 无错误，14 条已有 warning；diff --check 通过 |

原始日志在本工位 artifacts/role-agent-refactor-20261029-gpt-sol。扩大回归还保留一次缺 tsx loader 的 runner 失败，以及 Windows tmux 场景缺少无扩展名 tee 的失败；修正 runner 后，实际受影响集合 50 PASS，未为 tmux 改产品、降低 guard 或新增 skip。归档最初在 tar 异步 filter 中抛错，已改为生成前预检。SDK 协议测试首次用 .cjs 被 SDK 当原生文件，改用它支持的 .js；Windows 清理等待改为异步 rm，确保子进程结束后再回收普通夹具。这些失败见证均保留。

真实运行数据根 `C:/Users/Administrator/AppData/Local/Temp/ca-H9wssJ` 为本任务独立创建，不复用本机 Claude HOME。两条原生进程在 spawn 回执中退出 code=0，测试 HTTP 端口关闭，数据和台账保留；PID 后续复用不作为仍运行的证据，也不结束其他进程。台账为 claude-real-external-instance.json。

## 真实 Claude 组件体积

`claude-size-8iwVM4/measurement.json` 记录同一 SDK 0.3.285、同一布局、gzip level 1 的前后清单与逐文件 SHA-256。通过新的 materialize 实际导出，移除 243,751,648 bytes（其中 claude.exe 243,751,072 bytes）；压缩组件从 120,156,778 bytes 降至 1,757,785 bytes，减少 118,398,993 bytes，约 112.91 MiB。保留 JavaScript SDK。此数是 Claude 组件差值，不能冒充最终 EXE/DMG 的净减量；其他依赖与首次单独准备 Claude 的占用没有在该比较中消失。

仍须完成 Windows 最终安装物构建与核查、macOS 实机/DMG、内网离线环境及全量 34 项 C/E/Q。本切片的独立审查结果见文末；本机合成提供方不代表真实质量或企业验收。

## 独立审查后的响应性修复

非作者 claude_package_review 对 `6eb09adb7e318a562220806a383699e0f544e214` 独立验证打包 12 PASS、协议 4 PASS、SDK/MCP 43 PASS，发现一个 P2：同步版本探测会阻塞共享 API；600ms 延迟夹具令 25ms 心跳延迟至约801ms。原反例保留于 artifacts/claude-package-peer-review/nonblocking-runtime-probe.mjs 和 nonblocking-runtime-red.log。

已改为异步 execFile 和流式异步 SHA-256，原 captureInvocationOptions、模型发现及启动准备等待同一快照；传递现有 AbortSignal，可取消版本探测与文件读取，没有增加轮询或缓存。原反例转绿，capture 结束前心跳已执行；永久用例同时覆盖慢启动期间的事件循环和取消。API tsc 通过，`claude-runtime-async-regression.log` 为 123 项：122 PASS、1 既有 SKIP、无失败；包括全部本切片 SDK/调用链/配置冻结测试。

异步版本又用真实 CLI 2.1.312 和本地合成提供方复验同一十项，全部通过（`claude-real-external-async.log`），新数据根为 `C:/Users/Administrator/AppData/Local/Temp/ca-OcBUum`，两条原生进程 code=0、测试端口关闭，数据保留。独立的 SDK JavaScript 副本还实际读取了前次原生会话：8 条消息可读，没有 native 平台包（`claude-library-history.log`）。同一 reviewer 随后针对修复 SHA 复审，没有沿用旧提交的批准。

发布构建在原工位因历史未跟踪测试证据被 clean-check 拒绝，证据保留。已按原 managed worktree 入口创建 `build/pr1748-claude-gpt-sol` 独立构建工位，owner=codex、ttl=7天；仅在那里构建，不清理或覆盖原记录，不使用 -AllowDirtyInputs 绕过发布检查。

## 构建验证的项目隔离

干净工位的两次完整构建均在原90秒启动分析门禁超时，未生成安装器。日志显示大量程序读取及 worktree 通知扫描；`git -C <profile>/instance/project rev-parse --show-toplevel` 实际返回外层构建工位。这个新安装项目原本不应继承作者的 Git 仓库。

用同一冻结产物、同一90秒门禁，仅通过既有 profileRoot 参数放在 Git 之外，启动分析通过，生成1581个程序文件的便携预读清单。新集成反例在合成API启动中实际检查 Git：原默认目录令它继承父仓库并失败。修复只将默认 profileRoot 放到系统临时目录，显式覆盖参数保持；不更改产品工作区或启动时限。修复后分析/取消/资源/打包集合15 PASS，Biome无错误、1条已有复杂度warning。

`9c6d4ff71` 获同一非作者 reviewer approved，原响应性 P2 闭环，无开放 finding（独立5项协议/取消、33项SDK回归，64MiB散列期间171次心跳且可取消）。`a2ed4ead8` 将 PR CI 目标扩展至 main/develop；此提交本身没有修改 push 与发布规则。后续合并 develop 后的实际 CI 结果如下，不再使用当时尚无 checks 的状态。

## develop 集成后的最终记录（2026-10-30）

PR 远端 base 为 `develop`，不是只修改文档。为使上游审阅基于真实目标分支，`e184a34aca09004923ee95977165dcafc0d154cd` 合并了 upstream/develop `f27e6b0f40b119f43b68312b0dcb28ecf12b2121`，没有 rebase 或强推。两个手工冲突保留了双方需求：`.gitattributes` 保留两组 LF 规则，runtime-catalog-probe 同时保留外部 Claude 与上游 ACP 会话配置应用。上游自带的 push/develop CI 规则也随合并保留。

独立复审发现 develop 新增的 SDK entrypoint 测试未声明外部程序前提：无 Claude 的 CI 中四项失败。`7004b1ddcea387abfa7680dcf6cbb204524c869a` 只在两个 prepare 调用中接入既有测试 runtime，保留模型、续接、身份、凭证隔离和非法标签的原断言；无程序环境的原反例现为4 PASS。该提交没有发行程序差异。同一非作者 reviewer 对该 exact SHA 给出 approved，本切片没有开放 finding。此为本地独立审查，不代表 GitHub 整份 PR 已获批准。

合并后的 shared build/API tsc 通过；调用/模型/会话集合133 PASS、6项既有 Redis SKIP，适配器集合48 PASS，无客户端环境的 entrypoint 集合4 PASS。证据分别为 `claude-develop-integration.log`、`claude-develop-adapter-regression.log`、`claude-develop-entrypoint-no-cli-green.log`，集合不相加为全分支通过率。真实 CLI 的第三次定向运行使用产品默认持久化参数（无 persistSession 覆盖），仍为10项通过、真实模型请求0；数据根 `ca-JOy0uS` 与回执独立保留。

### Windows 构建与实际 CI

四次干净完整构建分别使用 `6eb09adb7`、`9c6d4ff71`、`35485b2a0`、`e184a34ac`，均停在原90秒 API 启动分析门禁，**没有产生本次可交付的 EXE/ZIP**。最新完整日志为 `windows-claude-develop-build.log`，冻结目录为 `bundled/deploy-20261030091749734`。7004 与 e184 之间只有测试夹具差异，不能声称曾从7004完整构建安装器。

物理隔离解决了验收项目错误继承作者 Git 根的问题，但不是全部冷启动耗时的根因：最新实例已在系统临时目录，仍发生模块读取及 worktree 扫描等待并超时。两次单独启动分析成功不能替代重新完整构建。没有放宽90秒时限、绕过 clean-check 或使用 AllowDirtyInputs。

7004 的 GitHub 结果已实际回读，完整快照为 `claude-final-ci-snapshot.json`：

| 检查 | 实际结果与后续范围 |
| --- | --- |
| Build、Public contract surfaces、Public test plan、serial-shared | SUCCESS，仅代表相应任务 |
| Windows installed layout | SUCCESS，不代表已生成/安装本次 EXE |
| macOS Preview lifecycle、Native launchd identity witness | SUCCESS；完整真实客户端、DMG 和端到端验收仍缺环境 |
| Directory Size Guard、Lint | FAILURE；ACP 目录25文件触发现有门禁；Lint 在该检查停止 |
| Web First-run Onboarding | FAILURE；member-first-entry 的失败读回/重试用例找不到真实创建控件 |
| Public distributable 1–6 / Test (Public) | FAILURE；首批失败涉及 ACP 完成事件、F296 置换、成员超时停止、Host boundary、AGY 身份和启动接线；不是完整剩余失败清单 |
| Windows | FAILURE；ACP factory throw/null 后下次重试的两项断言失败 |

运行链接：[CI](https://github.com/zts212653/clowder-ai/actions/runs/41032278424)、[Windows](https://github.com/zts212653/clowder-ai/actions/runs/41032278501)、[macOS smoke](https://github.com/zts212653/clowder-ai/actions/runs/41032278454)。失败日志 `ci-final-linux-failures.log` / `ci-final-windows-failures.log` 已保存。尚未定位的整份 PR 失败不标为基线问题、不增加 skip，也不把局部通过当成已经修复。**当前 PR 保留 Draft，不能合入或发布。**

### 收尾、方案核对与剩余边界

本次测试没有安装 EXE、创建快捷方式、绑定用户原生 HOME 或调用真实模型。三次真实外部 CLI 的6条原生进程均记录正常退出；合成 HTTP 服务关闭。四次构建启动的 API 均在失败处理后退出；单独分析的服务也已停止。按程序路径和数据根复核没有本切片遗留服务，不按 PID 数字或通用进程名判断归属。未操作生产端口和持久数据。

统一收尾台账为 `artifacts/role-agent-refactor-20261029-gpt-sol/claude-package-lifecycle-final.json`，逐项记录源码、程序/数据目录、端口、进程和保留原因。保留当前构建工位、失败对照冻结程序和压缩比较证据用于冷启动诊断，2026-11-06 复查额外程序副本；所有实例数据、原生会话和日志保留，未声称完成删除或卸载。用户原有 Claude 安装只读复用，不属于清理对象。

按原需求复核，当前实现仅在既有 SDK 准入/启动及发行导出处增加外部程序边界，模型发现复用同一解析，没有新下载器、缓存、持久库或可扩展 launcher 框架；不强制切换 ACP。移出主包不等于系统不再需要 Claude；使用者仍须准备可用的外部客户端，内网可另行提供离线运行物。本次没有用删除 SDK 库换取体积收益。

全量34项 C/E/Q、真实企业 CodeAgent、内外网和 Windows/macOS 最终安装物验收仍按原总账保留未完成。另一次只读来源校验发现桌面接受方案中的 `重构技术方案.md` 与 `评审问题闭环.md` 在 2026-10-30 已不同于原接受快照（另4份相同）；原哈希未覆盖，本任务没有写入这些源文件。证据见 `claude-package-source-integrity.json`，继续整份重构前应对齐差异；本切片依据为用户明确的 Claude 主包减重与 develop 指令。
