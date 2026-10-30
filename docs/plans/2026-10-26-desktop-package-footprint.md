---
feature_ids: []
topics: [desktop, packaging, offline, performance]
doc_kind: design-proposal
created: 2026-10-26
status: active
---

# 桌面包体实测、大项归因与分阶段瘦身

本候选落实 [#1703 的维护者回复](https://github.com/zts212653/clowder-ai/issues/1703#issuecomment-6344242927)：面向公共 main，独立实现提高归档压缩等级、过滤已知异平台 node-pty 文件、排除两项构建缓存。保留 Next 和现有能力，与 #1702 的内网默认策略、ACP、CodeAgent 增量分开。后续资源裁剪、静态化、合入与发布均另行决定。

## 1. 样本身份与实际收益

公共基线为 `fa1dc90fa9704691121cd90a2aa6be6422c954eb`，本次实际构建源码为 `c482cbef6dcb82eae032bbb6fd5ad1b8e96ecc69`，目标 Windows x64，Node 24.16.0、Electron 35.7.5。该提交迁入此前本地候选 `550ad037b…` 的七个代码/测试文件，保留原实现归属；六个既有文件的父版本与公共基线 Git blob 一致。后续本文与证据摘要的文档提交不改变这七个代码/测试文件，不能将旧包宣称为后来文档 HEAD 的完整重构建。

| 实际安装包 | 字节数 | 十进制 MB | SHA-256 |
|---|---:|---:|---|
| 同输入旧发布规则对照 | 722,093,247 | 722.09 | `1c0967cc7923c8058372139857ff816ac26a6e4edc138e795e43c755000d9834` |
| 三项优化公共候选 | 662,091,774 | 662.09 | `b93871ab8a4dc1e0b524bf347b118f2b10b7e08707d1240485312a930bcf91e2` |

**实际 EXE 减少 60,001,473 字节，60.00 MB / 8.3094%。** 候选是 631.42 MiB，不能把构建脚本显示的 MiB 数当作十进制 MB。

对照使用同一批已构建的 API/Web/MCP、Electron、Node、Redis 和直接资源，从同一隔离 frozen workspace 恢复异平台 node-pty 文件及两项缓存，再以 gzip 1 生成五个归档、复用相同 Node 归档和 Inno 编译器生成第二份 EXE。它隔离三项发布规则的影响，不是父提交完整重构建、正式发行或回退包。

两组真实归档逐普通文件 SHA-256 对比，只有 **14 个预期文件、16,083,187 字节内容**被移除：异平台文件 12,289,688 字节，两项缓存 3,793,499 字节。其余保留文件无新增、改写或意外删除。因此下载少 60.00 MB 不代表安装后少 60.00 MB，压缩等级不改变解压后的内容。

旧内网样本的 622.0 MB / 8.634% 不移用于本公共样本。当前 Web 多了功能演示资源等内容，不能用两份不同功能/版本的绝对包大小判断优化回退。

## 2. 安装包里的钱花在哪里

以下 MB 均为十进制。归档压缩长度直接读取文件，内容长度只统计 TAR 中普通文件；不是 NTFS 实际分配空间。六归档普通文件内容合计 **1,604,273,449 字节**，不是已执行安装后的目录总量。

| 不重叠的归档 | 下载 MB | 占候选 EXE | 内部普通文件 MB | 主要内容 |
|---|---:|---:|---:|---|
| dependencies | 252.69 | 38.17% | 806.80 | SDK、Next/SWC、API/Web/MCP 共享依赖 |
| web | 146.74 | 22.16% | 249.93 | public 资源、Next 产物及私有依赖 |
| electron | 127.91 | 19.32% | 302.83 | Chromium/Node 宿主、语言资源、壳 |
| node | 37.54 | 5.67% | 104.97 | 独立 Node 与 npm/安装解包所需文件 |
| api | 29.76 | 4.50% | 129.36 | 优化 bundle、模块、源码与映射 |
| mcp-server | 1.89 | 0.29% | 10.39 | MCP 运行内容 |
| 直接文件与安装器残差 | 65.55 | 9.90% | 不由残差反推 | docs、skills、脚本、Redis 等及安装器开销 |

六归档压缩合计 **596,540,058 字节，占 EXE 90.10%**。Inno 对这些预压缩输入使用 nocompression，仅提高全局 LZMA2 等级不会压缩它们。`app.asar` 内嵌文件内容仅约 **4.73 MB**，Electron 归档主要由 Chromium 可执行文件 201.48 MB、locales 43.60 MB 等组成，壳的应用 JS 不是最大体积来源。

## 3. 从最大项逐个判断：哪些必须保留，哪些可以处理

“独立删减计数”是读取同一个 TAR 流、只移除指定记录后用相同 Node/zlib gzip 9 计数；**不输出可运行删减包，不代表该删除安全**。五归档的 keep-all 计数均逐字节数匹配实际归档，避免将不同压缩实现的差异当作收益。Next、maps、PDB、资源等类别有包含关系，不能把下表独立边际相加；选定组合后须联合重算。

| 大项 | 原始内容 MB | 独立压缩计数减少 MB | 判断与处理条件 |
|---|---:|---:|---|
| Claude SDK Windows 原生运行包 | 243.75 | 110.43 | 最大单项，当前 SDK 路径实际依赖，不能直接删除。可讨论独立离线能力包，但会改变分发/发现/版本校验/恢复，需要产品决定 |
| Next + Windows SWC | 222.53 | 63.41 | 保留 Next 时不能凭编译完成断言可删。可先调查文件级生产追踪；去 Next 或迁静态仍是未启动的独立架构议题 |
| 所有归档的 source maps | 150.28 | 31.25 | 调试工件外置候选；需要离线符号包、同版源码/ABI/哈希和真实异常还原，不能静默取消既有运行时映射 |
| ONNX runtime | 81.63 | 见下文分组 | 现有四种 WASM/MJS 是浏览器/后端/回退矩阵，未经运行验证不删 |
| 头像与背景 | 61.29 | 不能用整组删除当预算 | 可从重复文件与保持元数据的无损压缩入手，不能通过去掉画面或降低分辨率减重 |
| Electron 非英中三种 locale | 42.08 | 11.08 | 此处指排除 en-US/zh-CN/zh-TW 后其余 52 个 pak。只有明确产品支持语言与原生回退行为后才能裁剪，当前保留 |
| Web 功能演示资源 | 35.80 | 整组 35.31 | 有真实产品消费者，完整离线版不能全删；其中一份重复视频可单独去重 |
| API src | 25.76 | 6.12 | 文件级导出收敛候选；需核动态加载、插件和本机诊断消费者，startup 通过不能证明全可删 |
| 目标 x64 PDB | 10.79 | 2.13 | 适合随独立离线调试工件交付，需二进制与 PDB 身份匹配；本 PR 保留 |
| `.next/trace` | 6.63 | 0.61 | 构建追踪收敛候选，小于其原始体积；不扩大本轮两项 cache 规则 |

source maps 的 31.25 MB 由 dependencies 18.08、API 12.69、MCP 0.48 MB 三个不同归档计数相加；与 Next/SWC、API src 或其他候选仍不能横向叠加。外置调试包会缩小主 EXE，**全部离线交付合计未必变小**。

### 3.1 Claude SDK：optionalDependency 不等于该平台可不要

`claude-sdk-query.ts` 动态导入 `@anthropic-ai/claude-agent-sdk`，当前 SDK 为 0.3.285，清单声明对应平台原生运行包。`claude-sdk-launch.ts` 提供现有启动参数，没有接入另一份可替代可执行文件的产品分发流程。平台 optionalDependency 允许跨平台安装处理，不表示 Windows 上相应功能可无条件缺少它。

本轮实际导入 query 并验证随包程序版本 2.1.285；未调用模型。若要把约 110 MB 的压缩贡献移出主包，必须提供同版、可验证、断公网可安装/发现的能力包，并测试会话恢复、进程启动与缺失/错版的可见错误。用户仍需全部离线能力时，这主要是交付拆分，不是把总内容消掉。本轮不删除 SDK，也不把 PE 重写或换用未知本机 CLI 当成无风险方案。

### 3.2 Next/SWC：先看生产文件，不急着换前端

本次 61 个 `.nft.json` 生产追踪文件没有 native SWC 或 `next/dist/build/swc` 记录。与此同时，`runtime-dependency-selection.mjs` 当前按包保留 Next、配置根、server/optional/peer 依赖闭包及私有树，所以 SWC 和完整 Next 内容仍随包。

这是文件级收敛调查的线索，**追踪不覆盖全部 CLI/config/动态消费者，零记录不证明可删**。后续若立项，应补真实启动、动态页面、图片处理、配置/重启与插件入口的正反验证，再选择允许清单。当前不删除 Next/SWC，也不启动静态前端 PoC，不延后 #1549 的维护工作。

### 3.3 “去掉独立 Node”已经有明确兼容性阻碍

独立 Node 归档约 37.54 MB 下载，不是可以直接省掉的冗余。实际实验中，随包 Node 24.16.0 的模块 ABI 为 **137**，Electron 35.7.5 的 Node 模式为 Node 22.16.0 / ABI **133**；用后者加载同一随包 better-sqlite3，实际返回 ABI 不匹配错误。

因此复用 Electron 的 Node 属于原生模块/启动与子进程的兼容项目，需重新构建和验证，不能只改 executable 路径或删除 Node。实验只运行内存查询，没有打开应用 UI 或写用户数据库。

## 4. 优先削减的明确候选：重复资源与同格式无损压缩

### 4.1 两个功能入口重复发布同一视频

`feature-demos.json` 中 `panel-vote-v1` 与 `panel-vote-voting-v1` 都指向源 `panel-vote.zh.mp4`。`feature-demos.ts` 按 demo id 生成不同发布 URL，sync 脚本于是输出两份相同文件。两份各 **10,160,715 字节**，SHA-256 均为 `37bee3133500953e4836eeb002132d1fd9c815fa9d6bb14fa61aac13647bcf4a`。

独立删除一份的校准压缩计数约减少 **10.05 MB**，是下一独立切片的优先候选。实现应保留两个 demo/tip 身份与入口，让其共享同一物理资产；同时处理既有 URL 兼容、Range/seek、Content-Type、PWA 更新/旧缓存与断公网首次使用。不能直接删第二个文件后接受旧 URL 404，也不能把全删演示视频的 35.31 MB 当作不损功能的预算。

另外两组头像字节相同：`codex_box.png` 与 `sliced-finial/codex_box.png`；`antig-opus.png` 与 `sliced-finial/antigravity_cyber.png`，冗余原始内容共约 **3.62 MB**。需要分别核对消费 URL 与视觉身份，再做资源映射去重。

全归档发现 **6,189 组相同字节，冗余内容合计 61.16 MB**。其中还有 CJS/ESM 类型声明、私有 peer 岛和多个 native fallback 路径；相同 SHA 不代表模块解析身份可互换，不能全局硬链接或删副本。本轮没有改任何资源 URL。

### 4.2 同格式 PNG 具备可复验的小切片

在独立输出目录检查 avatars/shell 下 54 个 `.png` 路径，内容共 **61,284,840 字节**。其中 `gemini.png` 与 `opus.png` 实际为 JPEG，保留原样，不按扩展名强行处理。

对其余 52 个真实 PNG，仅解压/重压 IDAT，完整保留所有非 IDAT 数据块，包括颜色、文本与可能的内容认证元数据，并核对解压后的全部过滤扫描线字节一致。只选变小输出，原始素材总计可少 **6,645,934 字节，约 6.65 MB**；全部源文件哈希未变。该数字是素材内容，不是已经重出的 EXE 收益；正式发布还需更新资源/PWA 哈希、视觉和安装包对照。

另一条 Sharp 重新编码实验中，同格式 PNG 的像素一致结果可少约 7.77 MB、WebP 的像素一致子集可少约 23.82 MB，但元数据字节有变化，且一张 WebP 的解码像素不一致。**这两项不是已通过的收益，也不能与 IDAT 结果相加；不建议批量替换。** 保持非 IDAT 数据块的方案更适合作为下一项有限实验，本 PR 不改图片。

## 5. 其他大项与交付拆分

- ONNX：去掉 asyncify/JSPI 的独立计数为原始 44.18 MB、下载约 10.36 MB；去掉全部非基础三种变体为原始 69.24 MB、下载约 16.17 MB，两者包含，不能相加。必须验证实际 VAD/ORT 后端、Web/Electron 浏览器、SIMD/线程/回退及麦克风首次离线加载后才能选择允许集。当前四种实现和两种 VAD 模型全部保留。
- docs：源树逻辑大小 68.85 MB，其中 architecture 39.13 MB、videos 11.61 MB。该数在安装器逐项排除前，不是已归属的下载大小。运行依赖的 MD/YAML、技能引用与治理资源不能整体移除；历史图文若另做资料包，要保留现有离线文档消费与引用。它与 Web 的功能演示资源不是同一目录。
- Electron：locales 裁剪需要语言支持政策；ICU、图形、视频运行库不能按文件大就删。ASAR 内应用内容约 4.73 MB，也不支持把 662 MB 归咎于壳 JS。
- node-pty：第一批已移除异平台文件，剩余约 16.10 MB，其中目标 PDB 10.79 MB。多个 ConPTY/OpenConsole 副本可能来自 prebuild/build/third_party 回退或 postinstall，需按真实加载/重建路径核定，再作后续候选，不在本轮继续扩大过滤。

## 6. 建议的处理顺序

1. 完成本 PR 的三项发布规则审查：已有同输入 EXE 减少 60.00 MB 的实证，先关闭代码与材料缺口。
2. 后续独立切片优先处理重复演示视频及重复头像，保持逻辑入口、旧 URL 和离线资源行为；先联合重算选中集合，避免重复预算。
3. 再做保持全部非 IDAT 数据的 PNG 压缩，以及 source maps/PDB 的可离线调试交付。分别报告主包与全部交付合计，不能用剥离诊断能力换收益。
4. Next/SWC 文件级闭包、API 源码、locale、ONNX 和资料包分别立项验证。体积大不自动赋予删除权限；未经证实不计入可交付收益。
5. Claude 能力分包、复用 Electron Node、静态前端是产品/架构选择。先确认支持与责任，保持内网离线和用户数据，不混入当前 PR。

## 7. 验证、证据与尚缺验收

当前构建源码通过 58 项相关测试、0 失败/跳过；RED 为四项预期行为失败，随后 GREEN。Biome 零错误，既有 3 warnings/6 infos。完整 API/Web/frozen/Electron/Inno 构建通过，仅省略 portable ZIP，PWA cache policy 2/2 通过。公共源码检查在该提交有 19 success / 1 skip，不等于实际安装通过。

实际归档用生产提取器验证通过；随包 Node 的 SQLite/sharp、两轮 ConPTY 中文/resize/重开、Claude SDK 导入/版本通过。实际 ServiceManager 在独立 HOME/数据/端口下启动真实 Redis/API/Web：5 个路由与 33 个资源 HTTP/本地哈希检查通过，memoryFallback=false，之后停止自有服务。该次 ready 观测为 101.254 秒，和压缩实验有并行负载，不能用于受控冷启动结论。

五项归档 sidecar 单次生成耗时合计为候选 316.520 秒、对照 176.687 秒，约多 139.833 秒；输入缓存/并发与 I/O 条件未控制，不当作稳定性能预算。首次构建被身份守卫拒绝，原因是本机初始 CRLF 检出改变 CSS 指纹；只将本工位相关输入恢复为相同 HEAD 字节，保留失败日志并重新完整构建，未改 CSS、stamp 或放宽校验。

原始日志、完整逐文件清单与两个 EXE 留在具名本地交付中；公开[机器可读摘要](evidence/2026-10-26-desktop-package-footprint.json)注明作者实验性质。Fork Actions 当前禁用，尝试现有 artifacts-only 工作流返回 422，未更改仓库设置或创建发行版；公开二进制下载入口仍是材料缺口。

用户确认暂无独立 Windows 测试机/VM，故断公网真实首装、受支持升级和失败恢复保持未验证；没有在当前安装上运行 EXE。真实模型、麦克风和完整 UI 不由本次源码/资源 smoke 冒充。按维护者意见，不重复未改动能力的全量付费模型旅程。

Draft PR 保留。补材料后再由维护者决定代码接受、合入和发布；#1606 继续 OPEN，静态化仍未启动。当前安装、运行实例、配置和历史不变。

源码复验命令：

```sh
node --test --test-concurrency=1 desktop/built-web-assets.test.mjs desktop/frozen-runtime-export.test.mjs desktop/runtime-archive-progress.test.mjs desktop/extract-runtime-archive.test.cjs desktop/verify-runtime-archives.test.mjs desktop/runtime-dependency-selection.test.mjs desktop/workspace-runtime-modules.test.mjs desktop/api-startup-read-ahead.test.mjs desktop/runtime-package-bundle.test.mjs desktop/api-bundle.test.mjs desktop/api-dependency-bundle.test.mjs
pnpm exec biome check desktop/scripts/create-runtime-archive.mjs desktop/scripts/stage-built-web.mjs desktop/scripts/frozen-runtime-export.mjs desktop/scripts/native-runtime-assets.mjs desktop/built-web-assets.test.mjs desktop/frozen-runtime-export.test.mjs desktop/runtime-archive-progress.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/scripts/build-desktop.ps1 -SkipPortableZip
```
