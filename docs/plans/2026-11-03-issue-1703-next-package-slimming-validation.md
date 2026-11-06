---
feature_ids: []
topics: [desktop, packaging, offline, performance]
doc_kind: validation-report
created: 2026-11-03
status: draft-validation
---

# Issue #1703：最新 next 的包体实测与作者自查

**同输入实际 EXE：624,557,030 → 572,228,119 字节，减少52,328,911字节（52.33 MB / 8.3786%）。保持Draft：真实断公网首装、受支持升级和失败恢复未完成。**
本轮基线为 `1016aa7a316566893cacef84d49792a8ced0f0c8`，实际构建源码为 `f4f32afdb73d3eda98f37705eab66db019ff13fb`。方案见[实施计划](2026-11-03-issue-1703-next-package-slimming.md)，逐归档字节/SHA见[机器摘要](evidence/2026-11-03-issue-1703-next-package-slimming.json)。

## 基线变化及实施边界

第一轮等待CI期间，#1762将 #1732/#1745/#1748 集成到 next。已重新核对并保留该基线的 Claude native 排除、归档拒绝旧部署 guard、启动画像修复及全部API/Web集成。本片相对最新next仍仅4生产文件+3测试：gzip1→9、真实node-pty的五类已知foreign prebuilds、两项构建cache排除。
不把SDK外置或其体积下降算作本片收益，不改变其发现/启动/离线前置条件，不新增架构迁移或依赖重组。

原917120d5基线、57a0b37a实包、e1db9ad2审查的60.47MB/CI/review均为[第一轮历史](https://github.com/whutzefengxie-ops/clowder-ai/blob/e1db9ad24b1095085a82938a601d1fc18f7ae98d/docs/plans/2026-11-03-issue-1703-next-package-slimming-validation.md)，本轮没有继承收益或批准。
原作者whutzefengxie-ops，原公共实现c482cbef6dcb82eae032bbb6fd5ad1b8e96ecc69（来源550ad037b）；保留原历史与PR1722，以merge/快进继续，base=next，不强推。
本地分支 `task/issue-1703-next-slimming-20261103`，工位 `G:/AIwork/clowder-ai/worktrees/issue-1703-next-slimming-20261103`。main/runtime/用户安装环境未开发或试装。

## 工件身份和同输入方法

| 实际EXE | 字节 | SHA-256 |
|---|---:|---|
| 当前next旧发布规则对照 | 624,557,030 | `219d0b5db9f0a42869b154a65a1ba0b2247008149e08dff2eff96cdcda1646a6` |
| 三项优化候选 | 572,228,119 | `058bfea68edc71a32cb0ee9b01820695c055ecc08f6539c676c006cdecc9ff1e` |

候选为干净源码完整构建，manifest diagnosticOnly=false，API/Web stamp均绑定f4f32afd。后续文档HEAD不是另一份EXE，产品代码须与该实际构建SHA一致。
Node24.16.0/ABI137、pnpm9.15.4、zlib1.3.1-e00f703、Electron35.7.5、Inno7.1.0；锁SHA256为d7f094037413ecdbe2045458befc39c193f71e2ef6834ba3bdeb116fa69e2eab。
对照复用本轮同批API/Web/MCP/共享依赖/Electron/Node/Redis/直接资源，仅从本轮frozen workspace及Web恢复五类node-pty prebuilds和两项cache。SDK native在两组中都按基线排除，绝不恢复进基线包来放大收益。
基线直接消费1016aa7a的gzip1 archive helper快照，只有其相对import改为绝对模块URL，保留新版SDK拒绝guard；候选消费正式gzip9 helper。两组用同一Inno生成实际EXE，Node归档完全复用。不是父提交完整重构建、正式发行或可用回退包。

| 归档 | 对照字节 | 候选字节 |
|---|---:|---:|
| dependencies | 169,731,612 | 142,524,974 |
| API | 38,653,978 | 31,337,415 |
| Web | 165,139,031 | 158,838,209 |
| MCP | 2,442,793 | 1,937,646 |
| Electron | 138,911,307 | 127,911,549 |
| Node（相同SHA） | 37,544,941 | 37,544,941 |

六组原始归档逐记录type/mode/link及普通文件路径/长度/SHA-256对比，保留67,625个普通文件，无新增/改写/意外删除；仅14允许文件、16,438,428逻辑字节减少（foreign node-pty12,289,688，两项cache4,148,740）。所有目标ABI/PDB/maps、未知依赖、媒体/ONNX/VAD/WASM、PWA等随保留记录一致。
16.44MB是归档普通文件逻辑长度差，不是完整安装目录或NTFS释放空间；52.33MB是本轮实际EXE下载差。cache内容和收益随实际构建输入变化，不承诺固定MB。

## 验证结果及限度

- 在最新1016原实现上重新观察4个精准RED；整合后67项相关检查全通过，含新基线SDK打包guard/启动画像检查。没有调断言或增加skip。
- 七个代码/测试文件Biome零错误，4warnings/6infos；本片文件均<350行，不顺手格式化或重构。
- 完整API/Web/frozen/Electron/Inno构建exit0，仅省略portable ZIP；保留tsc、身份stamp和clean-input guard。PWA生产缓存策略2/2通过。
- 实际五归档通过生产native-engine完整性校验和提取，Node用同系统tar bootstrap。使用同字节Node24.16.0，运行smoke使用实际随包Node。
- SQLite内存查询、sharp编解码、两轮ConPTY中文输入/连续输出/resize调用/退出/重开通过。resize只是调用smoke，不冒称完整shell尺寸端到端验收。
- 当前SDK wrapper importQuery通过，基线规定的native平台包不存在。没有把第一轮包内CLI版本检查沿用至本轮；外部Claude程序的离线部署及真实调用未在本片重新验收，无模型请求。
- 候选ASAR中的真实ServiceManager在自有HOME/data/端口运行Redis/API/Web，memoryFallback=false；5路由+33资源哈希+2视频MIME/Range共40检查通过。API24132、Web4180、Redis30212均停止，63401/63402/63403释放，有台账与回读。
- 当前pnpm lint仍失败：两个与最新next相同的chat-background CJS文件有7个no-require-imports错误；未修这些文件、未宣称全仓lint通过。
- 实包源码f4的CI终态为18成功、1失败、1规划跳过，无待完成；Linux/macOS检查通过。Windows出现未改RedirectionGuard夹具创建失败（约30s、status=null，243/244通过），本片归档/导出检查通过。未证明纯环境抖动，不调超时或权限；原始CI快照绑定f4，不继承旧e1结果；后续文档HEAD检查另列。

归档helper单次elapsed合计69.013→116.138秒（+47.125秒），候选全链构建712.929秒，组件ready46.545秒。缓存、I/O、并发及基线运行代码已变化，既不把这些数字当稳定预算，也不把与旧轮的ready差归因于本片。归档提取/HTTPready不能代替冷安装或完整首启。

## 缺项、保护与收尾

仍缺真实断公网首装、明确受支持旧版升级、故障注入后的安装恢复、完整Electron UI/麦克风首次离线及其他平台验收。当前无现成Hyper-V VM/Sandbox；不在用户现有安装实验，不买资源/扩大权限。SDK外部运行时是当前基线前置，不由本片补签离线部署通过。
公开可下载的本轮实包/原始验收日志入口仍缺；上一轮现有artifacts-only dispatch实际HTTP422 Actions disabled，未修改仓库设置。仓内摘要不能代表维护者已取得本地实物。
没有运行安装器、创建快捷方式/开机项、绑定用户原生HOME或调用模型；用户配置/认证/历史/角色/Redis/AOF/RDB/SQLite/上传及原回退包受保护。
新旧轮自有服务已受控停止，只审计本轮PID/端口。所有合成持久数据保留。第一轮重复程序副本删除曾被自动审批以blocked by policy拒绝，未执行；按台账保留、2026-11-17复查，不冒称已清理。

本轮工件在 `G:/AIwork/clowder-ai/artifacts/issue-1703-next-20261103/latest-next-1016aa7a/`：候选ClowderAI-Setup-1.14.0-next-f4f32afd.exe、comparison下的对照EXE、build manifest、12份完整文件清单、原始日志、instance-ledger与关闭回执。父目录仅为上一轮历史。当前交付、同输入对照、当前构建与已停止解包布局具名保留供Draft审阅，2026-11-17复查；对照不是已验收回退包。

## 最终作者自查

三项优化仍值得提交：相对最新next只保留窄发布规则，真实下载减少52.33MB，保真/原生/资源组件证据支持本片没有额外删能力，代价是更多压缩时间。SDK集成由基线提供，本片收益没有重复计算它。
自查不等于Approval；新HEAD须重新交非作者独立review，旧e1批准不继承。因安装/CI/lint/公开实物缺口保持Draft，不作可合入/发布结论，不合并、Release、部署或关闭Issue。
