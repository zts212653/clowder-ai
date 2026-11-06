---
feature_ids: []
topics: [desktop, packaging, offline, performance]
doc_kind: implementation-plan
created: 2026-11-03
status: draft-validation
---

# Issue #1703：在 next 延续三项包体优化

## 目标、来源与基线

在保留 Next、现有功能及离线内容的前提下，只优化现行归档压缩、真实 node-pty 的已知异平台 prebuilds 和两项构建缓存。
依据：[原 Issue](https://github.com/zts212653/clowder-ai/issues/1703)、[维护者范围确认](https://github.com/zts212653/clowder-ai/issues/1703#issuecomment-6344242927)、[原 Draft PR #1722](https://github.com/zts212653/clowder-ai/pull/1722) 及本次用户指令。

2026-11-03 最新基线为 `next@1016aa7a316566893cacef84d49792a8ced0f0c8`。等待第一轮 CI 期间 #1762 合入，原 `917120d5` 上的60.47 MB已撤回当前收益口径，详见不可变 [第一轮记录](https://github.com/whutzefengxie-ops/clowder-ai/blob/e1db9ad24b1095085a82938a601d1fc18f7ae98d/docs/plans/2026-11-03-issue-1703-next-package-slimming-validation.md)。
PR #1722 保持 Draft，作者及认证账号均为 `whutzefengxie-ops`，有 push 权限，base 已为 next。第一轮独立 review 与CI只绑定旧HEAD `e1db9ad24b1095085a82938a601d1fc18f7ae98d`，不继承至新整合HEAD。
原实现来自 `550ad037b18667f3c6e20f32a1c4069dd62f850f`，公共代码提交为 `c482cbef6dcb82eae032bbb6fd5ad1b8e96ecc69`。
旧约 60 MB 是旧输入实测，当前收益从零开始测量。

## 当前消费链及已覆盖核对

1. `desktop/scripts/build-desktop.ps1` 固定干净源码身份，以锁文件安装，设置 `CAT_CAFE_DESKTOP_WEB_BUILD=1`，串行执行 `pnpm -r --workspace-concurrency=1 run build`；共同核对 API/Web build stamp，不改写已有 stamp。
2. `frozen-runtime-deploy.mjs` 复制 Git 跟踪输入和 dist 到独立 `.frozen-workspace-*`，执行 `pnpm install --prod --frozen-lockfile --config.node-linker=hoisted --ignore-scripts`，调用既有 native rebuild。
3. `exportFrozenRuntime` 消费当前锁文件、Web trace 和 workspace 模块闭包，materialize 为 `bundled/deploy/{dependencies,api,web,mcp-server}`；`stageBuiltWeb` 接入生成的 public 和 `.next`。
4. 既有 API/runtime bundle 与 startup profile 保持，随后 Electron builder 通过 `windows-builder.cjs` 构建壳。
5. 现有 `create-runtime-archive.mjs` 生成 dependencies/API/Web/MCP/Electron 五归档及长度、SHA、entry sidecar；Node 归档沿现有独立路径生成，不改格式和解包依赖。
6. Inno `[Files]` 以 `nocompression` 携带 tar.gz；生产 `extract-runtime-archive.cjs` 校验并提取，失败阻止后续动作。保留 portable/升级与诊断路径。

最新 next 的 helper 仍为 gzip 1；仅排除 webpack cache；未有 native-runtime-assets 过滤，三项均未覆盖。
Next trace、共享依赖选择、ASAR 已在现行链中，不再算新增收益。
#1762 现已将 #1748 等集成带入 next：materialize 已排除已知 Claude native 平台包，archive helper 新增旧部署 native 包拒绝。两项是既有基线行为，本片保留原样，不能把其字节减少算作本片收益。
本片相对最新 next 仍只改变三项优化，不新增 SDK 外置或角色架构；保留上游新 guard 和导出排除，新增 `claude-runtime-packaging.test.mjs` 作为回归消费，不修改它。
#1553/#1452/#1702 涉及相邻安装/构建链，不整体引入。

## 最小文件范围与复用

- `desktop/scripts/create-runtime-archive.mjs`：复用既有 tar/gzip options，只把 1 改为 9；保留格式、checksum 和解包失败语义。
- `desktop/scripts/stage-built-web.mjs`：复用 copy filter，只额外排除 `.next/cache/.tsbuildinfo` 与 `.next/cache/eslint`，保留 fetch-cache、其他 cache、public 和 PWA 文件。
- `desktop/scripts/native-runtime-assets.mjs`（原 PR 已有 19 行）：包名与路径联合核对；只在 win32-x64 过滤 `win32-arm64/linux-arm64/linux-x64/darwin-arm64/darwin-x64` 五个目录。
- `desktop/scripts/frozen-runtime-export.mjs`：复用 materialize/include，覆盖共享、hoisted、私有依赖及非共享导出；先拒绝外部链接，再过滤，保留未知平台/包及其他目标。
- 复用原 PR 三个定向测试文件；若超过 350 行，只把本片新增用例放到具名聚焦文件，不顺手重构。
- 更新旧分析入口与精简机器摘要，历史详细数据引用不可变旧 blob；新增本方案和本轮证据摘要。每个改动文件 <=350 行。

不改静态前端、SDK 分发、依赖拓扑、通用去重、原生 ABI、PDB/maps、图片/音视频、ONNX/VAD/esbuild、locale、诊断/回退资源、数据或认证格式。
Architecture cell: desktop distribution；Map delta: none；Why: 只改变既有发布内容选择与压缩，不改变 runtime authority 或状态归属。

## 执行与验证

1. **方案自查后再写实现**：核对三项仍存在、原实现归属、旁支重叠及操作成本。保存本方案提交，再运行 RED。
2. **精准 RED → GREEN**：先只迁入原三份行为检查，在 next 原实现上确认因压缩收益、foreign prebuild 和 cache 保留/排除不满足而失败；记录完整日志。再整合原实现，跑同组检查，失败原因不得是语法或缺依赖。
3. **源码检查**：从当前 package.json/CI 确认 `pnpm lint` 为递归检查（API/shared 等为 `tsc --noEmit`，Web 为 `next lint`），`pnpm check` 为 sources/installed/artifacts，全仓自动修复为 `pnpm check:fix`，本次不运行全仓修复。定向格式命令为 `pnpm exec biome check <本片七个代码/测试文件>`；需要修格式时仅这些文件用 `pnpm exec biome format --write <files>`。
4. **定向回归**：`node --test --test-concurrency=1 desktop/built-web-assets.test.mjs desktop/frozen-runtime-export.test.mjs desktop/runtime-archive-progress.test.mjs desktop/extract-runtime-archive.test.cjs desktop/verify-runtime-archives.test.mjs desktop/runtime-dependency-selection.test.mjs desktop/workspace-runtime-modules.test.mjs desktop/api-startup-read-ahead.test.mjs desktop/runtime-package-bundle.test.mjs desktop/api-bundle.test.mjs desktop/api-dependency-bundle.test.mjs`。补跑 PWA production cache policy 和相关 installer failure checks；不把 fixture recovery 当实际升级恢复。
5. **实际构建**：提交干净源码后执行 `powershell -NoProfile -ExecutionPolicy Bypass -File desktop/scripts/build-desktop.ps1 -SkipPortableZip`。保留 guard、锁文件、API/Web 身份与失败日志，记录 node/pnpm/Electron/Inno 版本和 lock SHA。
6. **同输入对照**：候选与基线共用本轮 API/Web/MCP/Electron/Node/Redis/直接资源。从本轮 frozen workspace/Web 恢复且仅恢复五类异平台 prebuilds 与两项 cache，用原 helper gzip 1 重出五归档，共用同一 Node 归档、Inno 编译器及其余内容，生成两份实际 EXE。不是 base 全量重构建，也不是正式回退包。
7. **逐文件保真**：解开/遍历六个真实归档，比较普通文件相对路径、长度、SHA-256；symlink 等非普通 entry 也核对类型和目标。只允许确认过的两类内容消失；保留内容零改写、零新增、零意外删除。核对原生目标、PDB/maps、public/PWA/ONNX/VAD/WASM/音视频和离线文档。
8. **生产解包与原生**：以实际随包 Node + 生产解包器核对完整性及失败拒绝，再做 SQLite 内存查询、sharp 编解码、node-pty/ConPTY 中文输入/连续输出/resize调用/退出/重开、SDK wrapper import。最新基线已外置 native CLI，不把包内缺少该程序视为本片删能力，也不继承第一轮CLI版本检查。只用自建 HOME/状态，不连接用户 DB 或原生历史。
9. **既有运行能力**：若本轮可安全复用既有隔离 harness，使用实际包的 ServiceManager、自有 HOME/data/端口运行 Redis/API/Web，检查路由、媒体 MIME/Range 和离线资源哈希，及时受控停止并核对端口。HTTP ready 只计组件 smoke。
10. **完整安装验收**：需要现有、可恢复的隔离 Windows VM/专机，以新程序/数据目录断公网首装；从明确受支持旧版升级合成历史；故障注入验证中断/损坏包后数据不丢、拒绝误报成功并可恢复。真实安装 UI、首启、媒体/离线首次使用分别留证。不创建快捷方式/开机项，不使用当前用户安装环境。若无可用环境，明确三项缺失，保持 Draft，不申请新权限或购买资源。
11. **自检与独立 review**：核对最终 diff、范围、收益和缺项，提交给非作者独立 reviewer，锚定 exact HEAD；作者不提交 Approval。远端 CI、工件及结论都绑定实际源码，文档 HEAD 与构建 SHA 不同则明确说明。

## 测量口径与不退化标准

逐归档和最终 EXE 报告实际字节、SHA-256、source/lock/tool 版本、输入来源；实际文件才称下载收益，不把归档估算冒充 EXE。
安装内容只报告 TAR 普通文件逻辑字节差，未安装时不声称磁盘占用减少。
每归档 elapsedMs 与完整构建 wall time 分别记录；单次/负载未控的观测不推断稳定加速。
首装、升级、首启及失败恢复单列已测/未测，旧 ready/旧包数字不继承。
成功标准：无协议/运行代码变化，无新联网依赖；目标原生/资源及所有保留文件相同；同输入 EXE 确有可核验减少；所有实际失败和安装缺项可见。

## 回退、实例与保留

源码可通过撤销本片恢复旧 gzip/filter，不改安装器、数据格式或配置，不对业务执行自动重放。
若保真或 native/资源检查失败，停止该候选，不以小包抵消回归；恢复被排除路径重打包复验。
现有用户安装、runtime、HOME、认证、角色、会话、Redis/AOF/RDB、SQLite、上传、旧回退包永久保护。
新基线所有 EXE/日志集中 `G:/AIwork/clowder-ai/artifacts/issue-1703-next-20261103/latest-next-1016aa7a/`，实例台账记录 owner、source SHA、包版本/SHA、程序/data、端口/PID/用途及保留理由。父目录仅为第一轮历史证据，不能混用；其重复程序副本因自动审批拒绝删除而登记保留至2026-11-17。
本轮默认保留候选包与一份同输入对照（只供比较，不冒称可用回退）、当前构建工位和必要证据；不清理其他任务产物。自有服务结束即停，不按通用进程名结束进程。
工位具名保留供 Draft 验收与 review；验收完后核对身份/持久数据/reparse 边界再按归属收尾。

## 实施前自查结论

**值得继续这三项**：三处差异都仍在 next，现有入口和精准检查可复用，无架构迁移或运行期常驻成本；压缩多付构建 CPU/等待，换取相同内容的较小下载，真实收益以本轮对照决定。
不预设 MB 或秒数门槛，不扩大删除清单。已查到 Hyper-V 无现有 VM；完整首装/升级/恢复目前缺环境，只能交付带缺项的 Draft，不能宣称安装验收完成。
优先复用原 PR：在最新 next 的任务分支整合旧 head，保留原历史，确认最终 diff 只含本片后，快进推送原 fork 分支并将 PR base 改 next；若远端 head 被他人更新，停止覆盖并重新对账。

本轮实测、失败与缺项见 [验证记录](2026-11-03-issue-1703-next-package-slimming-validation.md) 和 [机器摘要](evidence/2026-11-03-issue-1703-next-package-slimming.json)。本方案正文中实施前判断不代替最终验收结论。
