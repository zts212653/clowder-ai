---
doc_kind: note
created: 2026-10-01
topics: [desktop, native, build, review, acceptance]
tips_exempt: Review-driven closure of native artifact validation, with no new user-invocable capability.
---

# #1452 构建 R2：原生加载闭包与真实 PTY

Accepted source/revision：`thread_muobvw9ekjosyqrp#0001790786232368-000584-9be83991` / `0001790786232368-000584-9be83991`，未移动。直接 review carrier：本 thread；R1 typed changes_requested：`local-review:0001790791295691-000707-8c7727f5:changes_requested`，审查 HEAD `c30d303983c1937cb74c2e33f18fd0dff2af8608`，reviewer astra / cat-xlbldqjc / gpt-6-astra。仅复审构建 subject `task:0001790787482024-000625-0e3a1084`。

## 判断与 failure-mode sweep

F1/F2 都成立：F1 实际缺 sqlite-vec 平台库的 fixture 会借到源码树 native；F2 真实 node-pty Windows 分支 require 不加载 conpty，spawn 才加载。原复现与输出保留 [R1 reviewer reproduction](evidence/r2-reviewer-red.txt)。不把 Mac require 的成功外推到 Windows。

共同不变量：验证必须消费产物的实际加载闭包，不能只检查 JS 入口位置或顶层 require 是否成功。已扫四个原生依赖、CJS/ESM 解析、SQLite extension、dlopen/OS linker、PTY worker/cleanup helper、构建缓存 probe 与三处 artifact 调用（Mac部署/签名后、Windows部署/portable staging）。没有扩展到 Redis、数据目录、监听参数、端口或首启产品设计。

## 变更

- `build-node.mjs`：子进程只保留 OS 启动所需变量，设置限定 PATH；隔离 NODE_OPTIONS、NODE_PATH、编译缓存、动态加载搜索覆盖等注入。版本 probe 同样消费这条隔离。native smoke 的 cwd 指向产物 API，使用绝对 executable。
- `native-artifact-guard.cjs`：预载 [Node 24 同步 module hooks](https://nodejs.org/download/release/v24.15.0/docs/api/module.html#customization-hooks)；CJS、createRequire/resolve 与 ESM 的实际解析/加载 realpath 必须位于该 API/node_modules。拒绝整个 node_modules 的外部 symlink，process.dlopen 同样约束实际文件。hooks 通过 `--require` 继承到 worker/fork helper。禁止依赖 loader 捕获越界后再通过 fallback 报成功：保留 violation，最终仍拒绝。
- `native-artifact-smoke.cjs`：SQLite extension 路径显式校验后实际 load；在关闭内存 DB 前审计动态库，防止卸载后漏掉路径。随后真实 sharp PNG 与 PTY spawn，最后检查新加载的非系统 sharedObjects 仍在产物内；已存在的 Node runtime/系统库单独允许，具体原生路径输出留证。
- PTY 使用该 Node 启动只打印固定 marker 的子进程；要求 marker 与 exit 0，10s 超时只清理自己创建的 terminal。Windows 还显式加载延迟 cleanup helper `conpty_console_list.node`，实际 spawn 消费 conpty/worker。没有启动用户 CLI、服务端口或 Redis。
- `native-artifact.test.mjs`：复制真实四个包及其声明的部署依赖，在 fixture 祖先放可借用的完整 host node_modules。好产物真实 PTY成功；坏产物缺 vec 平台库、缺 sharp transitive、extension symlink越界、env注入、ESM/worker越界，以及 PTY缺件/坏二进制/合法但架构不符的 native 均拒绝。Windows 会分别破坏 conpty 与 conpty_console_list；不会只测 require。
- Windows smoke workflow：先实际 pnpm deploy，再以 `CLOWDER_REQUIRE_NATIVE_ARTIFACT_TESTS=1` 运行该套件；没有部署目录时直接失败，不能 skip成假绿。这条检查用同一 artifact function，覆盖构建脚本的部署与 portable 消费。

代码提交：`3b1cd869406467278c105ffbf10c4705aaa9f297`、`8e1702ef26be971b158adfb473f3fa9aa78eefbc`。后者只补 SQLite unload 前的校验时序，不改变任何打包 runtime/resource 文件；`desktop/package.json` 的 files/extraResources 也没有把 desktop/scripts/lib 当 runtime payload。

## RED → GREEN 与质量门禁

- 同一正式测试对 R1 原始 build-node implementation 运行三种漏检：**0 PASS / 3 FAIL**（断言预期拒绝，旧 implementation实际接受），覆盖缺 vec 平台库、sharp transitive、SQLite extension symlink：[formal RED](evidence/r2-formal-red.txt)。不是把新 helper 自己的 PASS 算作 R1 已正确。
- 修复后全部定向 **25 PASS / 0 FAIL / 0 SKIP**（macOS arm64）：[日志](evidence/r2-targeted-green.txt)。最后 SQLite 时序修改后再跑全部8项真实 native test，**8/8 PASS**：[最终native回归](evidence/r2-native-final-green.txt)。原17项 build/launch未受该3行时序修改影响。
- R1 reviewer fixture 已从假绿改为显式拒绝包外 dependency：[拒绝证据](evidence/r2-reviewer-rejected.txt)。F2 Windows lazy branch的 R1探针是源实现证据，不冒充 Windows实机。
- 改动 JS/CJS 的 Biome error-level、staged whitespace/diff、Bash syntax均通过。runtime源码与类型未改动，复用 R1 同树完整项目 build 证据，R2重新跑真实 native、真实包构建与只读镜像，不声称重跑完整 pnpm gate。
- fallback扫描：build-node -1、guard +1、smoke +2，测试 +5。测试增加的环境选择/可选dependency map/坏样本选择/预期rejection catch只是 fixture构造，不能被解释为runtime兼容降级。生产 guard 增加的是拒绝谓词和有界失败清理，未引入猜版本/借宿主/重试加载的恢复层。

复跑：`node --test scripts/run-preserving-signal-exit.test.mjs desktop/scripts/build-correctness.test.mjs desktop/scripts/native-artifact.test.mjs`。本worktree已有 `bundled/deploy/api`；干净验证机先安装/构建部署依赖，再设置 `CLOWDER_NATIVE_SMOKE_TEST_API=<实际flat API路径>` 与 `CLOWDER_REQUIRE_NATIVE_ARTIFACT_TESTS=1`，不得把无目录的 skip算成 native通过。Windows CI里的前置命令为 `pnpm --filter @cat-cafe/api --prod --config.node-linker=hoisted deploy .acceptance/native-smoke-api`。

## 当前真实安装产物

canonical build命令仍为本worktree `env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION bash desktop/scripts/build-mac.sh --skip-web --skip-deploy --skip-node --skip-redis --arch arm64`。重新校验本树缓存、签名、40个 Mach-O、包内 Node和真实PTY后生成新版DMG：[pipeline](evidence/r2-mac-package-green.txt)。

- 包：`dist/ClowderAI-0.10.1-arm64.dmg`，**809310166 bytes**。
- SHA-256：**`c642bbab6d23b92a3b447495ad059a5e4fe140cd80928f6ed060565f0d884310`**。
- Packaging cut：**`3b1cd869406467278c105ffbf10c4705aaa9f297`**；最终native validation source：**`8e1702ef26be971b158adfb473f3fa9aa78eefbc`**。后续只有 validation时序/报告修改，runtime payload没有变化；严格区分包构建 cut 与更强验证 cut。
- OS：macOS **26.6.2 arm64**；实际 Node **v24.15.0 / native ABI137 / darwin arm64**；依赖实测版本仍为 better-sqlite3 12.11.1、sqlite-vec 0.1.9、node-pty 1.2.0-beta.12、sharp 0.34.5。Redis仍仅记录原脚本7.4.1事实，不新增pin/provenance结论。
- 用最终source重新 `hdiutil verify`、只读 mount、codesign、40 Mach-O、实际 Node/native/PTY验证，全部通过，probe **34637ms**；所有记录的 better_sqlite3.node、vec0.dylib、sharp.node、pty.node、libvips-cpp.dylib 均来自这个镜像的 API/node_modules；正常detach。[镜像验证](evidence/r2-dmg-readonly-green.txt)、[身份](evidence/r2-artifact-identity.json)。harness为本树 `.acceptance/verify-dmg.mjs`。

## 复审与验收边界

五轴风险沿R1：构建失败路径收紧、内存DB/自有PTY无用户存储、安全路径/环境隔离、engines/native契约、无不可逆副作用。Architecture cell沿F113/F179既有构建边界，Map delta=none，无新Store/Router/owner；map专门desktop cell/检查命令缺失warning仍如实保留。价值OQ无。

Windows runner **尚未实际运行**：本机darwin，Limb发现没有Windows节点。已实现好产物通过与缺件/损坏/错误架构拒绝的真实Windows test lane，但没有捏造Windows结果或额外上游PR绕过先行local review。请astra复审实现与R2坏样本证据；Windows执行结果仍须在允许开PR进入CI之后闭合，不能把本Mac结果代偿Windows。

loopback-only已有独立 typed APPROVED：`local-review:0001790791322251-000709-077596e4:approved`，exact HEAD `0f4be1e6c56e488d25ba378ea9f0ece56c6ed037`，保持原分支，未并入此包/重复审。operator同包体验、fork soak、Windows安装包、#1519真实模型首句均仍未通过；不推进上游merge，也不把整个#1452制造成#1519审查依赖。final-only主thread回报契约继续保留。
