---
feature_ids: []
topics: [issue-1703, pr-1722, packaging, windows, validation]
doc_kind: validation-report
created: 2026-11-09
status: independent-review-pending
---

# 包体瘦身续作：迁移完成，当前 next 实包减少 53.21 MB

本轮按用户原话 `message:0001794211637989-000179-9f2cfb17`，由砚砚和鲸鲸共同接续 Issue #1703 / PR #1722。两个根目录旧工位已迁入 worktrees；原三项规则在当前冻结 next 上重新构建、测量和验证。**尚未完成严格安装验收，PR 保持 Draft，本文不是合入或发布批准。**

## 工位与实际构建身份

| 用途 | 位置 / 身份 |
|---|---|
| 最初实验工位 | G:/AIwork/clowder-ai/worktrees/cat-cafe-package-slimming-phase1；原 HEAD 550ad037b 不变 |
| 公开移植旧工位 | G:/AIwork/clowder-ai/worktrees/cat-cafe-public-package-slimming；原 HEAD 224da1e1d 不变 |
| 当前交付续作 | G:/AIwork/clowder-ai/worktrees/issue-1703-next-slimming-20261103 |
| 冻结上游基线 | next@2a653d3e6a026f290286d804b2a1335f2a74bdb0 |
| 实际完整构建源码 | 5bed18bd650ff3dde6fbc5eef2122c60540e2041 |
| 本轮证据根目录 E | G:/AIwork/clowder-ai/artifacts/issue-1703-next-20261109 |
| 独立资源实验 | worktrees/issue-1703-lossless-png-20261109；不进入当前交付 |

迁移使用 git worktree move。两个工位普通文件长度/mtime、链接目标清单及 Git 状态在移动前后一致，分别保全 12,713,548,949 和 13,704,341,200 普通文件逻辑字节。随后把 9,157 个内部绝对链接重定位到新位置，两个工位 Git 状态仍为空、依赖可从新位置解析。旧测试布局六个指向已不存在历史 deploy 的链接保持对应历史状态。未删除任何产物、用户数据或原回退包。

当前三项规则的四个生产文件和三个测试，相对原 PR HEAD ba0d7d2b 内容完全一致；新的 next 产品输入单独重新验证，不继承旧工件的 CI、大小或安装结论。本文属于后续文档，不声称已装进上述 5bed18 实包。

## 同输入实际 EXE 对照

| 工件 | 实际字节 | SHA-256 |
|---|---:|---|
| 旧规则控制包 | 631,530,196 | 594ce1465165f98be927e963de470748950873020c9a5dfdef7b4c7caf4db50b |
| 三项优化候选 | 578,319,070 | 7b8e17db80c705b5c21e0209bba2b6817cc543920b527b2dc3c503c08d6e9ba7 |

**实际下载文件少 53,211,126 字节，即 53.21 MB / 8.4257%。** MB 为十进制；构建脚本显示的 551.53 MB 使用 MiB 口径，不能混用。旧轮的 52.33 MB 不计入本轮收益。

控制包复用同批实际编译的 API/Web/MCP、依赖、Electron、Node、Redis 和直接资源；仅从同轮 frozen workspace/Web 恢复五类 node-pty foreign prebuilds 和两项 cache，再使用 next 原 gzip1 helper 编译 Inno。Node 归档完全相同。控制包不是父提交全量重构建，也不是已验收回退包。

直接重读全部十二份原始 tar.gz，逐路径、类型、mode、链接目标、普通文件长度和 SHA 核对：**保留 68,864 个普通文件无新增、改写或意外删除；仅少 14 个允许文件，共 16,636,101 逻辑字节**。其中 foreign prebuilds 12,289,688；两项 cache 4,346,413。不能把下载差额写成安装后磁盘释放量或冷启动收益。

## 已验证的实际路径

- 当前集成源码的 58 项 Desktop 定向检查全部通过；具名七文件 Biome 0 错误。
- 完整 pnpm frozen install、API/Web、生产 PWA cache policy、frozen native、Electron、Inno 与完整 build manifest 通过；仅按约定省略 portable ZIP。manifest diagnosticOnly=false，API/Web stamp 均为 5bed18。
- 用生产 native 解包器解开候选归档，使用随包 Node 24.16.0 验证 SQLite 内存查询、sharp 编解码、两轮 ConPTY 中文输入/连续输出/resize 调用/退出重开、Claude SDK JS wrapper 导入。没有发模型请求；resize 调用不等于完整 shell 尺寸验收。
- 候选 ASAR 中的实际 ServiceManager 使用任务独立 HOME、数据和端口启动 Redis/API/Web，memoryFallback=false；5 路由、33 本地资源哈希、2 视频 MIME/Range/206 共 40 项检查通过。
- 任务端口 50848/50849/50850 已释放，三个自有服务 PID 均不存在；状态目录保留。未连接生产 Redis，也未使用用户现有安装或原生登录。

完整构建本次观测约 16 分 23 秒；同机另有资源实验负载，不作为稳定构建预算。启动观测也不作性能改善结论。

## 与鲸鲸共同判断的资源方案

鲸鲸独立调查确认 next 未覆盖原三项规则。其进一步链接扫描发现，旧 docs 排除候选中至少 73 项被保留文档引用，直接排除会破图；本轮不裁 docs，不以删除离线资源换体积。

另在独立工位试了仅重压 PNG IDAT 的方案。初版像素及元数据相同，但未保全真实资源中的 10 个 caBX 内容凭证和 4 个 iDOT 偏移块，已拒绝。修正版按 PNG unsafe-to-copy 规则整图保留这些文件，50 张图、全部像素/元数据/扫描行和 Host 头像投影一致，14 张内容绑定图片原字节完全相同；实际只剩 **604,205 图片逻辑字节**收益，尚非 EXE 收益。

考虑到约 0.1% 量级及额外 PNG/PWA 维护面，作者与鲸鲸均建议**不纳入当前发行**。两个实验构建已停止，无实验安装器交付；源图完整、反例和修正版代码保留。PWA revision 等未来实验事项不混入原 PR。

## 未完成与当前下一棒

1. 真正断公网的干净首装、明确受支持旧版升级、载荷替换阶段失败恢复尚未验证；没有断开整机网络，不用解包或 HTTP ready 冒充。
2. 完整 Electron UI、媒体/麦克风首次离线、真实模型/A2A/原生续接及其他平台产品验收仍缺。
3. 当前 5bed18 实包及原始日志尚未通过公开下载入口交付维护者；远端 PR 仍为 ba0d7d2b，旧 CI 不能冒充本地新源码 CI。
4. 鲸鲸正在独立复核本轮 5bed18 工件、收益和保真；本报告先记录作者实际结果，不把 PNG review 当成本包批准。

本轮不合并、不发 Release、不覆盖用户安装、不关闭 Issue。原三项规则继续作为当前交付；后续按实际 review 和安装证据推进。

## 证据入口与保留

E/worktree-migration.json、worktree-link-repairs.json；build-manifest.json、build-exit.json、latest-next-targeted.log、biome.log；comparison/comparison.json、same-input-payload-diff.json、十二份成员清单；extraction.json、native-smoke.json、runtime-smoke.json、instance-ledger.json、owned-resources-closed.json；whale-analysis.md、whale-png-review.md、whale-png-review-72b6e34.md；png-safe-build/decision.json 及四份资源保真回执。

当前候选在 E/ClowderAI-Setup-1.14.0.exe；控制包在 E/comparison/。保留候选、控制包、当前构建工位和具名诊断历史至 2026-11-17 复查；用户状态、原生历史、指定回退包及合成持久数据不因程序保留期到期而删除。
