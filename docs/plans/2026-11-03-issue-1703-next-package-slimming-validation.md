---
feature_ids: []
topics: [desktop, packaging, offline, performance]
doc_kind: validation-report
created: 2026-11-03
status: draft-validation
---

# Issue #1703：本轮 next 的包体实测与作者自查

**本轮实际 EXE 减少 60,469,174 字节（60.47 MB / 8.1331%）。保持 Draft：真实断公网首装、受支持升级和失败恢复未完成。**
结果来自本轮输入，不继承旧“约 60 MB”。实施范围与命令见[详细方案](2026-11-03-issue-1703-next-package-slimming.md)，逐归档哈希与测量见[机器摘要](evidence/2026-11-03-issue-1703-next-package-slimming.json)。

## 源码、工位及复用方式

- 基线：远端 `next@917120d55bb5bf618a3cc49c0749d5f5172ace46`，实施前及打包后重新查询一致。
- 实际构建源码：`57a0b37a5a7a260a148abcfa5e0a3c3282dded59`；API/Web build stamp 均为该值，manifest 为 `diagnosticOnly=false`，打包输入干净。
- 后续本报告与摘要属于文档变更，不冒称该 EXE 由后续文档 HEAD 重构建；七个代码/测试文件须与此构建 SHA 一致。
- 本地分支：`task/issue-1703-next-slimming-20261103`；工位：`G:/AIwork/clowder-ai/worktrees/issue-1703-next-slimming-20261103`。
- 继续复用 [Draft PR #1722](https://github.com/zts212653/clowder-ai/pull/1722)，base 已改为 next，保留原作者 `whutzefengxie-ops` 的 `c482cbef6dcb82eae032bbb6fd5ad1b8e96ecc69` 与旧 head 历史，快进推送，没有强推。旧工位、main、runtime 和用户安装环境未开发或试装。
- Node 24.16.0 / ABI 137、pnpm 9.15.4、zlib 1.3.1-e00f703、Electron 35.7.5、Inno 7.1.0；锁文件 SHA-256 为 `d7f094037413ecdbe2045458befc39c193f71e2ef6834ba3bdeb116fa69e2eab`。

## 实物对照及可追溯性

| 本轮实际 EXE | 字节 | SHA-256 |
|---|---:|---|
| 同输入 gzip 1 + 恢复允许项的对照 | 743,498,079 | `712331430cdd142987102ba76dbc381015a6ccb5958730178a65d9a1b80344ef` |
| 三项优化候选 | 683,028,905 | `95d2020a5121762b663690541aab9ff6e67b32835a0e6c8b8151ee8db76859e6` |

对照复用本轮已经构建好的 API/Web/MCP、共享依赖、Electron、Node、Redis 和直接资源，只从本次 frozen workspace/Web 恢复被排除的五类 foreign prebuilds 与两项 cache，用同一 Node/npm tar 的 gzip 1 重出五归档，再由同一 Inno 生成第二个实际 EXE。Node 归档直接复用，SHA 相同。它不是父提交完整重构建，也不是正式回退包。

归档同批对照（字节）：

| 归档 | 对照 | 候选 |
|---|---:|---:|
| dependencies | 288,094,449 | 252,931,560 |
| API | 38,466,085 | 31,184,163 |
| Web | 165,979,503 | 159,460,059 |
| MCP | 2,442,778 | 1,937,606 |
| Electron | 138,911,277 | 127,911,538 |
| Node（完全复用） | 37,544,941 | 37,544,941 |

六归档逐记录比对：普通文件的路径/长度/SHA-256，以及记录类型、mode 和链接目标均核对。候选保留 **67,569 个普通文件**，无新增、改写或意外删除；只减少 **14 个允许文件、16,419,138 原始字节**，其中 foreign node-pty 为 12,289,688，两项 cache 为 4,129,450。所有目标 native、PDB/maps、媒体、ONNX/VAD/WASM、PWA 和未知依赖均随其余保留内容一致。
这里的 16.42 MB 是归档内普通文件逻辑长度差，不是已运行安装程序后的完整目录大小或 NTFS 实际释放空间；60.47 MB 是最终下载 EXE 的长度差。

## 验证结果及限度

| 检查 | 本轮证据 |
|---|---|
| RED → GREEN | next 原实现上四个预期失败，最小整合后 58 项相关测试全通过，零跳过 |
| 格式/行数 | 七个代码/测试文件 Biome 零错误，原有 3 warnings/6 infos；所有本轮改动文件 <350 行，无顺手格式化 |
| 构建/类型 | 完整 API/Web/frozen/Electron/Inno 构建 exit 0，只省略 portable ZIP；包含现行 tsc 构建与源码身份守卫 |
| 生产 PWA | Web postbuild 的 production cache policy 2/2 通过 |
| 安装合约 | 升级、数据边界、安装生命周期和手动启动的 32 项检查通过，只是合约/fixture 检查 |
| 生产解包 | 实际五归档经生产 native-engine 校验与解包；Node 归档用同一系统 tar bootstrap；提取器使用的本机 Node 与随包 Node SHA 相同 |
| 原生能力 | 随包 Node 验证 SQLite 内存查询、sharp 编解码、两轮 ConPTY 中文输入/连续输出/resize/退出/重开、SDK import 和随包 CLI 2.1.285；无模型请求 |
| 实际包组件运行 | 从候选 ASAR 提取的 ServiceManager 在自有 HOME/data/端口运行真实 Redis/API/Web，memoryFallback=false；5 路由、33 项资源哈希、2 项视频 MIME/Range 共40检查通过 |
| 停止回执 | API 13552、Web 54092、Redis 56548 均退出；49761/49762/49763 已释放。构建期画像 API 51804 也已退出，56855 已释放 |
| 全体 lint | `pnpm lint` 失败：两个基线未改动的 chat-background CJS 文件有7个 `no-require-imports` 错误；不声称全仓 lint 通过 |
| CI | 构建源码 SHA 尚无 check runs；旧 PR 的 CI 不继承，后续文档 HEAD 的远端检查单列 |

本机 Node、bundled Node 和解包后 Node 的 SHA-256 均为 `b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3`。完整文件清单、日志及每归档 manifest 均保存在下述本地工件中。

五项归档 helper 的单次耗时合计为 **77.776 → 144.639 秒（+66.863 秒）**；候选全链构建1172.294秒，组件 ready118.526秒。输入缓存、I/O、并发和安全扫描未受控，不推出稳定构建预算、冷安装或首启改善。生产提取观测也不等同冷安装。

## 明确失败、缺项与保护边界

首次 lint 早于 MCP dist 生成，首次 PWA 检查早于 Web 构建；后来按依赖复验，PWA通过，完整 lint 保留上述7个现有错误。对照辅助脚本首次因 Windows 分隔符判断触发 self-copy 拒绝，未修改产品；修正后复用已完成且未恢复允许项的输入副本，最终全文件比对通过。失败日志均保留。
构建根继承 Low 标签，既有脚本将产出的 Setup 调为 High；未修改原工位或现有安装 ACL。
运行中的 worktree notice 只尝试本轮 `runtime-state/project`，因该合成项目没有 Git 仓库而失败，未运行其他工位清理。

**仍未验证**：真实断公网首装、受支持版本升级、故障注入后的安装恢复、完整 Electron UI/麦克风首次离线旅程及其他平台。无现成 Hyper-V VM，也无可用 Windows Sandbox；未使用用户现有安装作首装或升级实验。
Fork permissions 查询虽返回 enabled，实际现有 artifacts-only workflow dispatch 被 GitHub 拒绝（HTTP422，Actions disabled）；未修改仓库设置、权限或购买资源。公开可下载的本轮二进制与原始日志入口仍缺，仅有本地实物及仓内摘要，不能说维护者已取得工件。
没有运行安装器，不创建快捷方式/开机项；没有真实模型调用。用户配置、认证、历史、角色、Redis/AOF/RDB、SQLite、上传及现有回退包均未改动。

## 作者自查、独立审查与交付保留

作者自查结论：**三项切片仍值得提交审查**。源码只改变既有压缩/内容过滤，下载收益有同输入实际 EXE 和全文件保真支撑；付出的是更多压缩时间。未把它扩成 SDK/前端/依赖重组，也未把包体收益冒充启动性能。风险集中在安装验收缺项和全体 lint/CI 材料缺口，因此保留 Draft，不作可合入或发布结论。
下一步交非作者对 exact HEAD 的实现、证据、范围和缺项表独立 review；作者自查不是 Approval，维护者的接受、合入及发布责任保持独立。不自动合并、Release、部署或关闭 Issue。

本轮工件目录：`G:/AIwork/clowder-ai/artifacts/issue-1703-next-20261103/`，包括候选 `ClowderAI-Setup-1.14.0-next-57a0b37a.exe`、`comparison/ClowderAI-Setup-1.14.0-Comparison-Baseline.exe`、`build-manifest.json`、逐归档/逐文件清单、原始失败与成功日志、`instance-ledger.json` 和停止回执。
保留候选及一份对照（不冒称可用回退包）、当前构建工位和待复核的已停止解包布局至2026-11-17复查；所有合成持久数据保留。多余的纯程序复制输入在保真验证后进入清理，不清理其他任务工位、安装或用户历史。
