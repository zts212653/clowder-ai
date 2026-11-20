---
feature_ids: []
topics: [issue-1703, packaging, windows, continuity]
doc_kind: implementation-plan
created: 2026-11-09
status: in-progress
---

# Issue #1703：无损包体优化续作

用户于本线程明确授权砚砚与鲸鲸共同接续工作：规范工位位置，在功能不受影响的前提下继续尝试安装包瘦身。授权原文为 `message:0001794211637989-000179-9f2cfb17`。

原交接材料：`G:/AIwork/clowder-ai/artifacts/issue-1703-next-20261103/2026-11-09-issue-1703-pr-1722-handoff.md`。旧证据保持原位、原内容，不作为新基线的验收结果。

## 工位迁移

以下两个工位从 `G:/AIwork/clowder-ai/` 迁至其 `worktrees/` 下同名目录：

| 工位 | 保全的原提交 | 文件及链接条目 | 普通文件逻辑字节 |
|---|---|---:|---:|
| cat-cafe-package-slimming-phase1 | 550ad037b18667f3c6e20f32a1c4069dd62f850f | 392621 | 12713548949 |
| cat-cafe-public-package-slimming | 224da1e1d81afaa43ad0b09a1f6900f9a4533c40 | 407201 | 13704341200 |

使用 `git worktree move`，移动前后 HEAD、Git 状态及全部普通文件长度/mtime、链接目标清单一致；未删除或重建原构建产物。随后把 9157 个指向旧工位内部的绝对 junction 重定位，并更新开发依赖的 virtualStoreDir。两个工位 Git 状态仍为空，Web sharp 依赖均可从新路径解析。

旧 smoke 布局共有六个指向已不存在历史 deploy 目录的链接，迁移后仍指向对应历史位置；没有创建假的载荷或删除持久数据。

迁移回执在 `G:/AIwork/clowder-ai/artifacts/issue-1703-next-20261109/`：`worktree-migration.json`、两份 before 清单、`worktree-link-repairs.json`。原日志中的旧绝对路径保留为历史来源。

## 当前源码与分工

续作复用 `worktrees/issue-1703-next-slimming-20261103` 和原任务分支，保留原 PR #1722 历史；已整合 `upstream/next@2a653d3e6a026f290286d804b2a1335f2a74bdb0`。

当前 next 在四个生产入口上仍未覆盖原 PR 的三项规则：gzip 9、Windows x64 node-pty 的五种已知异平台 prebuilds 过滤、两项精确构建 cache 排除。不存在把已落 SDK 减重重新计入的问题。

砚砚负责迁移、源码集成、实包及消费链验证；鲸鲸独立核对当前覆盖、候选资源消费者与方案风险，并对最终实质改动另作非作者审查。调查回执写入本轮 artifacts，消息不替代交付文件。

## 验证顺序

1. 当前 next 集成后的 58 项相关 Desktop 检查已通过，原测试与生产规则保持连续；记录为 `latest-next-targeted.log`。
2. 冻结新 source/base/lock/tool 身份，完整重建 API/Web/frozen/Electron/Inno。保留 clean-input、tsc、stamp、归档完整性门禁，不用 diagnostic skip 冒充发行包。
3. 以同一批新编译产物恢复旧发布规则，生成控制/候选实际 EXE；逐归档核对成员、长度、SHA、类型和链接。旧 52.33 MB 不继承到本轮。
4. 使用候选实际解包内容验证 SQLite、sharp、ConPTY、本地资源和状态持久化；测试只在任务程序、HOME、数据目录与端口内进行。
5. 真正断公网首装、明确受支持升级、载荷替换失败恢复及完整媒体/麦克风离线分别验收。没有对应证据就明确保留缺项，继续 Draft。

进一步资源优化先评估同格式无损 PNG：保持源资产、URL/MIME、尺寸、透明像素和元数据；逐像素及真实消费路径一致才接受。它独立于原 #1722，不以有损 Q85、删除文档、语音/ONNX 能力外置或静态前端迁移换包体。

可逆实现与验证已获授权；不自动合并、Release、生产部署、关闭 Issue，不断开承载现有用户工作的整机网络，不改用户认证与原生历史。

## 回退

源码可回到原 PR HEAD `ba0d7d2be53c2ac7580d6e67d23f45c03e3b1634` 或撤销新增窄切片后重新构建。任何必要内容缺失、像素/元数据不符或消费失败均拒绝该候选；控制包只作测量，不冒充已验收回退包。

保留原候选、原对照、用户指定回退包、全部用户状态和本轮构建工位。程序保留期不授权删除数据。
