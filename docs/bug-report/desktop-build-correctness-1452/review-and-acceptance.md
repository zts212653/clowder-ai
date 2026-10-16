---
doc_kind: note
created: 2026-10-01
topics: [desktop, build, node, architecture, acceptance]
tips_exempt: Correctness guards on the existing desktop build pipeline, without a separate user-invocable capability.
---

# #1452 构建正确性：实现与真实安装产物证据

本页保留 R1 历史证据。astra R1 找到两项坏样本假绿，当前交付与更严格的原生闭包校验见 [R2 修复与复验](review-r2.md)；R1 好样本通过不能替代该修复。

## 来源与范围

Accepted source：`thread_muobvw9ekjosyqrp#0001790786232368-000584-9be83991`；operator 授权锚 `thread_muoam919d5s6xe4l#0001790785661741-000557-65576650`。参考 [whutzefengxie-ops 的 #1452](https://github.com/zts212653/clowder-ai/pull/1452)，当前 gh 复核 OPEN、非 bot 作者、exact HEAD `a7558e0453070429651206ef773763cd415ad245`；按 [#1459 maintainer 方向](https://github.com/zts212653/clowder-ai/issues/1459#issuecomment-5658770842) 接手窄切片。保留社区贡献来源，不宣称从零发现。

当前认证 `mindfn`，provider 权限 pull/push/triage=true、maintain/admin=false，按 contributor 处理；外部作者不匹配。原 PR 仅 advisory_read_only，没有改外部作者分支或自行合入。内部 thread 是接手相关来源（related），没有证据把它认作外部 PR 的创建 origin。

五问结论：①解决 Windows shim 启动、猜 Node 版本、混架构产物的问题，原宽 PR 混有未决运行时数据设计；②保持既有独立 Node 后端与固定端口契约；③只 adopt 明确获授权的 A1/A2/A4/A5；④采用 reimplement 两个独立 worktree，避免合入未决内容；⑤sol 实现/回归/文档，astra 非作者 review，operator 体验和 fork soak，maintainer 决定上游 merge。

基点 `fork/develop_base@33084dc889722c17de4bc852f762818e076d8242`；public main RED 基点 `b1fe2966fa0a97d1e3cd2e174ed59fd1477b4fc4`。代码提交 `617444df88b5515632d9dfaf29da85b9c33e3cb7`、`bd893e02b021a7de6ff261350d3ade7c98904a1f`、`28a77d2d46e2da11663fbe0f9a7e166975431453`、安装包 build commit `50d2be18146f1c3705444399fff45080794b5880`；其后提交只补本报告与证据。

Redis pin/static manifest 无 last-shipped provenance，未进入实现；Redis 归属/数据目录/恢复/升级降级/退出预算/动态端口/routes-manifest 改写均排除。loopback 是另外一个分支，未混进本安装包。

## Changed-path closure

| 路径 | 修改与验证 |
|---|---|
| `packages/web/package.json`、`scripts/run-preserving-signal-exit.*` | Web build 直接用当前 Node 执行实际 Next JS 入口，避开 `.cmd` 和 shell；路径含空格、`&`、引号、百分号等参数保持字面值，退出状态/信号覆盖。Windows job 加入同一测试。 |
| `desktop/scripts/lib/build-node.mjs`、`verify-build-node.mjs` | 检测实际 Node version/ABI/platform/arch，解析不了 engines 或缺 runtime 则拒绝；精确缓存匹配、失败不猜版本。包内 Node 只解析部署目录下模块，SQLite 内存库、vec、node-pty native binding、sharp PNG 实际加载。 |
| `desktop/scripts/build-desktop.ps1` | 安装/部署前预检；缓存/下载 runtime 与部署 native 验证；portable staging 压缩前再验证。macOS 无 PowerShell/Windows 实机，实际 Windows 包尚未验证。 |
| `desktop/scripts/build-mac.sh` | 默认当前原生架构，foreign-arch 在 install 前拒绝；skip-node 不能绕过缓存校验；签名后 installed-layout Node/native 验证成功才生成 DMG。 |
| `desktop/afterPack.js`、`lib/mac-bundle-arch.mjs` | 在真实消费 hook 中保留相对 symlink，扫描实际 `.app` 的 Mach-O 字节及 lipo 架构，拒绝坏/越界/缺关键文件；foreign-platform 可选 prebuild 独立分类，darwin/mas 目标仍严格校验。 |
| `build-correctness.test.mjs`、`windows-smoke.yml`、`desktop/README.md` | 失败路径、字节/标签不符、跨架构、portable link、hung runtime 覆盖；文档与根 engines 对齐。 |

## Quality gate 与 RED → GREEN

- public main 原入口配同一回归测试，在本 worktree `.acceptance/public-main` 复现 **5 FAIL / 10 PASS**：[日志](evidence/public-main-red.txt)。五个 RED 是 Web 原脚本、三条 mac 预检、原 afterPack 缺产物未拒绝；fixture 中候选 helper 的 PASS 不能算成 main 已实现 helper。最终本分支 **17 PASS / 0 FAIL**：[日志](evidence/targeted-green.txt)。
- 同 worktree 清除继承 `NODE_ENV` / npm production 选项后 `pnpm install --frozen-lockfile`、`pnpm run build` 均成功，Web/API/MCP/shared 全部构建：[完整日志](evidence/full-build-green.txt)。只有既有 ESLint warning。targeted Node tests 不需要 Redis/运行实例配置。
- changed JS/JSON 的 `node_modules/.bin/biome check --diagnostic-level=error`、`bash -n desktop/scripts/build-mac.sh`、`git diff --check`、services ASCII checker 均通过；目录 checker exit 0，既有超阈值 warning。未声称运行完整 `pnpm gate`。
- 本 checkout 没有 `check:architecture-ownership` 命令，尝试失败作为 warning；人工核对 F113/ServiceManager 和 F179 包装边界，Map delta=none，不新增 Store/Queue/Router/owner。现有 map 无专门 desktop 构建 cell，留作 reviewer focus。
- fallback 扫描提示 build-node +6、test +3。逐项核对：测试字符串 `|| unknown` 与 ESM `default:` 是词法误报；实现中的 OR 是拒绝谓词，switch 默认仅为精确版本比较（省略 comparator 表示等号）。没有未知 Node 时猜版本、重试加载或降级接受的恢复层；严格守卫就是本次终态。
- 公共 checkout 继承的 inbound home-brand hook 拒绝已有 `Clowder AI` 文字。核对公共/fork 原文后使用命令级 hooks override 提交，未改 hook/runtime 配置；staged Biome/diff 检查独立执行，无共享状态文件改动。

复跑测试：`node --test scripts/run-preserving-signal-exit.test.mjs desktop/scripts/build-correctness.test.mjs`。完整构建前置：`env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION pnpm install --frozen-lockfile`，再同环境执行 `pnpm run build`。

## 实际 bundle 与安装包

同 worktree 最初运行完整 deploy/下载/Redis 编译，Electron 下载出现 TLS 失败：[首轮日志](evidence/first-deploy-package-attempt.txt)。安装同版本 Electron 后恢复 canonical pipeline；构建过程暴露并修正了真实产物问题：

1. 原 `fs.cpSync` 把 `.bin` 相对链接改成绝对 build-host 链接，实际 app 扫描 RED：[证据](evidence/artifact-symlink-red.txt)。改用 verbatimSymlinks，并用移动源目录的测试证明目的地仍可用。
2. 全文件 Mach-O 扫描找到 bare-* 的可选 iOS simulator prebuild，不能按 macOS 加载面误判；补显式 iOS/Android 分类与测试，实际 darwin/mas 字节仍必须匹配：[RED](evidence/ios-prebuild-red.txt)。
3. 刚打包的 Node 执行两次超过原 15s 探测预算，随后同包执行 52–97ms。即使改到签名后仍超时：[RED](evidence/signed-node-timeout-red.txt)。平台首次执行系统原因未确证；采用 macOS artifact 有界 120s 预算（独立 Node 探测保持 15s），不重试/不跳验证。最终首次探测 12442ms，hung executable 测试证明仍超时拒绝。

最终 canonical 命令：`env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION bash desktop/scripts/build-mac.sh --skip-web --skip-deploy --skip-node --skip-redis --arch arm64`，exit 0：[打包日志](evidence/mac-package-green.txt)。复用的 Web/deploy/Node/Redis 都是在本 worktree 生成，native 与版本缓存重新校验。afterPack 验证 **40 个 Mach-O**，签名通过，包内 Node/native smoke 通过，随后生成 771.85MB DMG。

R1 产物现保留为 `dist/ClowderAI-0.10.1-arm64-r1-942bc1a4.dmg`；SHA-256 **`942bc1a4305e9f104f8e7bd333ec4fdda629c11b095afefe4b30f414239f7324`**。OS **macOS 26.6.2 arm64**；build commit **`50d2be18146f1c3705444399fff45080794b5880`**；实际包内 Node **v24.15.0 / native ABI 137 / darwin arm64**。

安装包再经过 `hdiutil verify`，只读挂载后重新执行 `codesign --verify --deep`、实际40个 Mach-O扫描、包内 Node/SQLite/vec/pty/sharp smoke；全部成功，挂载已正常 detach。挂载镜像的首次 Node 探测实际 **17156ms**，直接证明原15s预算不足。没有启动整套 app、访问运行端口或持久化数据。[只读安装镜像证据](evidence/dmg-readonly-green.txt)、[产物身份](evidence/artifact-identity.json)；复跑 harness 在本 worktree `.acceptance/verify-dmg.mjs`。

实际包内版本：better-sqlite3 **12.11.1**、sqlite-vec **0.1.9**、node-pty **1.2.0-beta.12**、sharp **0.34.5**；现有 deploy 流程重新解析依赖，未声称版本等同源码初次 install 的锁定解析，也没有擅自修改这条独立策略。Redis 实际 `7.4.1` 是现有 mac 构建配置，只记录事实，不当 last-shipped provenance 或新增 pin 方案。

## 风险与未完成验收

五轴：行为=构建错误提前拒绝/只构建原生架构；数据=内存 SQLite、无生产存储；安全=不引入 shell，包内越界 link 拒绝；契约=engines 与现有包装链校验收紧；不可逆=无。技术重点：Windows真实 cmd/PowerShell消费链、native loader与可选prebuild分类、120s artifact预算、installer与portable两种载体。价值 OQ 无。

待 astra 非作者独立 review。Windows x64 实机/CI、mac x64 runner、operator 实际体验、fork soak、完整已安装旅程尚未通过；不报告 DONE 或 #1519 首启整体通过。依据 astra 集成报告 `29eceafc1575bac579ef7758de595c1e83b2d6fd` §4/§5，未来旅程必须把 PID/可执行路径/build identity 对上同一个 SHA 的安装包，不能用源码 devserver 替代。loopback 切片独立可审，不构造整个 #1452 先合入才可审 #1519 的依赖。模型覆写/幂等/completedAt 留在 #1519 原责任链。
