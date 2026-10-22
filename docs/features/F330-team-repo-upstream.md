---
feature_ids: [F330]
related_features: [F059, F238, F251, F202]
topics: [opensource, team-repo, upstream, sync, intake, release, branch-model, org-transfer, sanitizer]
doc_kind: spec
created: 2026-10-20
description: "让开源团队仓成为共享代码的上游：家里和团队的改动双向低成本互通，公开 main 对外稳定，且不比现在的全量同步更费、更不稳。"
description_source: human
description_author: opus55
description_updated_at: 2026-10-20T10:45:00Z
tips_exempt: "Phase A/B 将既有部署显示、默认值、测试夹具、构建投影及两侧文件归属接回各自真相源，不新增用户操作入口。用户名字仍沿用已有设置；模板、构建生成与导出/回流边界属于开发维护流程，不需要新增应用内能力提示。"
---

# F330: 团队仓当上游

> **Status**: in-progress | **Owner**: Ragdoll (@opus55，指挥 Phase A/B) · 小星星 (@codex-astra，指挥 Phase C–E) | **Priority**: P1
>
> **operator kickoff**: `[thread-id]#private-source-id`——「为了跟踪你们这个你们还是新建feat md吧 来跟踪『团队仓当上游 · Roadmap』」。Phase A 子线程同轮批准。
>
> **2026-10-20 审计修订**：小星星审计（`[thread-id]#private-source-id`，5 项 P1、1 项 P2）指出，初版的安全、依赖与完成证明不成立。本版按审计修正；方向、Phase A 已批准的任务与 Sol5.6 reviewer 不变。本文件是 F330 唯一的分期与验收真相源，路线图文档只保留盘点表与清单。

## Why

团队和社区越来越多地直接在开源仓开发，但家里仍是唯一源头：每个外部 PR 合入开源仓后，都要在家里再吸收一遍；家里的改动则要靠一套越来越重的改写脚本，每两小时整仓推一次。You 要的是「让团队仓当我们的上游，家里不要这样全量同步」，同时「保证家里也高效开发，且吃到开源仓的东西」。前提是不能换成一套「更费 token、还更不稳」的流程。

You 原话：

- 「浪哥的插件合入了……我们要开始慢慢转团队仓了，让团队仓当我们的上游，我们家里不要这样全量同步东西了。不过这样的话，我们要如何保证家里也高效开发且吃到我们的开源仓的东西呢？」（`private-source-id`）
- 「如果新的这个流程消耗的 token 远大于现在这样全量同步，且还没现在稳定，那收益是什么？」（`private-source-id`）
- 「开源仓得有 dev 或者 next 之类的分支，给团队其他小伙伴开发用；我们的全量同步也应该先进 dev，然后要发版本再进 main，保证 main 稳定。」（`private-source-id`）
- 「我不喜欢比如 @you 之类的……还有没有什么东西我们内外不一样，是不友好的？」（`private-source-id`）
- 「我就怕到时候你们 runtime 跑着，在搞开源仓、启动开源仓什么的，把家里搞废了。」（`private-source-id`）

## Current State / 现状基线

2026-10-20 实测：

- **两边不是同一份代码，git 也不认识彼此的关系。** 开源仓提交由同步脚本新建，家里提交没有进入开源仓；两边的对应关系只记在开源仓 `.sync-provenance.json`。家里是浅克隆，`merge-base` 查不到结果；这不足以证明完整历史没有共同祖先，尚未在完整克隆上确认。
- **同步时会改写源码，改写有四种性质，不只是名字。** `scripts/_sanitize-rules.pl` 共 569 行，按性质至少分为：
  - **显示配置**：用户名字、角色词、品牌名等文字。
  - **构建投影**：端口默认值、文档路径、仓库地址、package.json 脚本、system-prompt hash、内置插件包等。
  - **隐私过滤**：本机路径、家里私人内容。
  - **实际行为差异**：例如第 48–65 行从公开入口删掉家里旧队列迁移（`migrateLegacyHomeQueue`）和部分路由接线（routingContext）。这是两边有意保留的不同运行行为。
  - 共享目录里含 You/you 关键词的文件有 414 个（packages 369、cat-cafe-skills 26、scripts 18、desktop 1），另有 27 个 transform 目标。414 是关键词命中数，不等于需要改造的消费者数。名字、角色词、@ 路由句柄含义也不同，不能一律换成显示名。
- **改写产生了对外的坏文案。** 例：开源仓 `eval-hub-operator-narrative.ts` 第 113 行显示「需要 You 决定是否停用这项评估。」。设置里已有用户名字与 @ 句柄编辑器（`HubCoCreatorEditor` + `PATCH /api/config/co-creator`），是代码写死了 You，没去读设置。
- **外部贡献量。** 近 30 天开源仓合入 47 个 PR：家里同步 17 个；浪哥 17 个；另外 7 位作者 13 个。家里标题带 intake 的提交约 35 个（粗筛）。现有 intake 已有机械通道，可原样应用补丁、复用审查（小星星实测）。
- **同步运行成本。** 定时任务每两小时一轮，单轮约 15 分钟，并维护 26 项社区内容保留（其中 8 项家里已有相同字节，只是导出规则没带出去）。2026-10-20 09:15 一轮预检因开源仓 main 在运行中前进而失败；浪哥 #1487 回流涉及 2186 个路径，使旧保留清单失效。尚无「一次完整双向交付」的 token、耗时与人工介入记录。
- **同步与回流都以 main 为目标。** `scripts/daily-public-sync.mjs` 第 227 行以 `origin/main` 作为公开基线；PR base、目标新鲜度检查以及 F251 保留门禁的基线与水位，也都消费这个目标。
- **分支与对外用户。** 开源仓 `next` 停在 2026-03-23，是 main 的祖先、无独有提交，可以快进；停用原因文档里查不到。默认分支是 main，同步 PR 用 squash 合入。源码用户的 `pnpm start` 跟 origin/main；桌面版从 Releases 安装（最新 v0.13.0，2026-09-02）。公开仓 `ci.yml` 与 `windows-smoke.yml` 只对 main 触发；`release-desktop.yml` 只在发布 Release 时触发。仓库在个人账号下：3461 star、875 fork、MIT。
- **隔离运行的已有入口。** 同步脚本的公开候选验收（`scripts/sync-to-opensource.sh` 第 122–153 行）注明 `MEMORY_STORE` 只隔离 Redis，启动还会打开 SQLite 与配置、清理 CLI owner，因此会给每次启动一套新的状态目录（SQLite、配置、服务配置等）。端口约定本身不构成隔离。

## What

### Phase A: 去改写第一批（已完成，子线程 `[thread-id]`）

Sol6.1 执行，Sol5.6 review（operator 指定）。前期分片交付；2026-10-21 operator 要求剩余部分合为一个 PR 收尾，不扩范围。

首切片已合入 [PR #5796](https://github.com/zts212653/clowder-ai/pull/5796)（`9559ff9364`）：
完成 AC-A1 的分类和可重跑计数，接通首批运行时名字、句柄及界面文案消费者。
200 条 Perl 语句与 27 个 transform 目标已分类；同口径基线为 1,594 个改写文件，切片后为 1,569。
在 #5796 当时，剩余名字/角色消费者（包括进程启动时的 MCP 描述）、AC-A3 配置化和 AC-A5 规则退役/定时同步尚未完成；
该 PR 本身不代表 Phase A 或 AC-A2 完成，也未触发家里在线 runtime 重启。后续交付状态以下面的当前验收记录为准。

1. **先给改写规则分类**：把 `_sanitize-rules.pl` 与 transform 目标逐条标成「显示配置 / 构建投影 / 隐私过滤 / 实际行为差异」。只有已经被等价实现替代的规则才能删除；隐私过滤与实际行为差异默认保留，要改必须另有设计并单独确认。
2. **第一个完整小切片：用户名字与 @ 句柄。** 代码、提示词、界面文案里写死的 You / @co-creator / operator / operator，按含义分别处理：显示名读 coCreator.name / nickname；@ 路由读 coCreator.mentionPatterns；角色词按上下文决定，不机械换成名字。家里行为、公开版使用和隐私边界同时验证（见 AC-A2、AC-A4）。
3. **之后的切片**：品牌名、端口默认值、文档路径、仓库地址、默认开关改为读配置或运行档案。端口与默认开关属于运行行为，必须按 AC-A4 验证真实取值，不能只看文字。

2026-10-21 operator 补充（`[thread-id]#private-source-id`）：剩余运行时品牌、仓库地址集中、现存默认开关、等价规则退役及 `/tmp` 路径回归合为一个 PR 收尾，不再逐片开 PR。桌面安装身份与发布工件不属于 Phase A；它们可能影响已安装用户的自动更新，需要单独确认。合入后仍须等待既定定时同步通过，再在同一执行线程继续 Phase B。

**当前交付（2026-10-21）**：余项 [PR #5854](https://github.com/zts212653/clowder-ai/pull/5854) 已于 14:15:11 UTC 合入，提交 `1498fcf75c7ce5247e6d928232237d8d0a27e3ac`。Sol5.6 完整初审唯一 P1（固定历史来源误跟随部署仓库）修复后，iterative 复审批准精确 HEAD `28e286f95ce971307f1edec491da040e9704fac3`（`[thread-id]#private-source-id`）。后续公开 CI 暴露的两项遗漏由 #5873 修复；包含全部切片和修复的既定同步最终候选已通过真实验收，并于 23:37:36 UTC 合入公开 #1649，落地 tree 与被测 tree 相同。AC-A1–A5 全部成立，Phase A 收口；本线未执行在线 runtime 激活。后续 Phase B 沿原授权在本线程继续，F330 整项仍为 in-progress。

### Phase B: 去改写第二批（测试、构建、模板、两边不同的文件）

Phase A 的实际同步依赖已于 2026-10-21 23:37:36 UTC 满足。按原安排（`[thread-id]#private-source-id` 及执行交接 `private-source-id`），由 Sol6.1 在同一线程继续，Sol5.6 review；先核清剩余消费者及文件归属，再按 AC-B1–B3 实施。桌面安装身份/发行工件、公开分支切换和新调度不进入本阶段。

- 测试 fixture 化，去掉本机路径；system-prompt hash 与内置插件包改为构建时生成；家里专属 package.json 脚本拆出；L0 模板与 hooks 中的家里句子模板化。
- **两边本来就不同的文件**（CLAUDE.md、README、cat-config 等）：逐个确定真实归属（只属于家里 / 只属于公开版 / 两边各自生成），并为四种情况写下预期结果并实测：上游单边修改、上游删除、双方都修改、全新 checkout。再按结果选实现方式。**不使用 `.gitattributes merge=ours` 作为保护**：它只在双方都改动时才会被调用，上游单边修改仍会直接进入家里文件；自定义 driver 还要求本地 git 配置，只提交 `.gitattributes` 不会生效（小星星已隔离复现两例）。
- **依赖**：涉及名字的部分（测试断言、L0 模板、hash、插件包）要等 Phase A 确定名字与 @ 句柄的读取方式，否则会在同一批文件、同一份 `_sanitize-rules.pl` 与同一套验收基线上冲突。不涉及名字的部分（文件归属与四种情况实测、package.json 脚本拆分）可以先独立准备，合入与 Phase A 错开。

### Phase C: 发布层（next 汇流，main 发版）

- 内容：next 快进恢复；daily 同步的公开基线、PR base、目标新鲜度检查，以及 F251 的基线与水位，在**同一次交付里**一起改为 next；团队与社区 PR 进 next；固定候选验收后进 main 并打 tag；main 允许为紧急修复更新，修复须合回 next。
- **可以先准备的**：在隔离副本里离线验证 next 的接线（CI 触发、同步目标、F251 水位）。这不改动公开仓，也不需要等默认分支的决定。
- **必须串行的正式切换**：Phase A 合入并至少跑过一轮同步；泽丰 #1519 已处理；默认分支与发版节奏由 operator 决定（OQ-1）。
- next 在 3 月停用，是因为当时几乎没有外部贡献，多一层分支只剩手续成本（OQ-4）。这次的前提是外部贡献已经存在（近 30 天 30 个外部 PR），并且发版这一步必须做得便宜。
- 安全顺序：先让 CI 覆盖 next 并实际跑绿，再改投任何 PR；next 只快进、不 force push；切换同步目标时保持单一写入者；改仓库设置前写明改什么、怎么回退。

### Phase D: 转组织仓

与同步方式无关，单独处理，在两轮同步之间操作。处置 GitHub Pages 不跳转、旧地址不能重建同名仓库、团队成员先入组织、App 重装等问题；转后实测 gh / PR 跟踪与桌面版检查更新。清单见路线图文档。

### Phase E: 成本证据与回流方式对照

- **现在就记一次基线**：选一次真实的完整双向交付（一个外部 PR 进家里，加一个家里功能出去），记录总 token、耗时、人工介入、冲突与重试。
- **尽早在隔离副本比较候选**：机械 intake 与 git merge 在同一批真实 PR 上比较上述指标。改造成本、冲突、重试与维护成本都计入，不只看 PR 数。数据库内容与实际功能正确性另行独立验证，不以 git 合并成功代替。
- 只有选了 git merge，才需要接上两边历史；接之前先在完整克隆上确认现状。

### Phase F: 按模块把写入归属挪到团队仓

- 每迁一个模块，写明：写入归属（只在团队仓改）、家里如何取回、旧同步路径的退出条件、退出后的门禁（例如该模块 diff = 0）。先选团队已在团队仓开发的模块，例如插件宿主。
- 在本机运行团队仓代码，必须复用同步脚本已有的隔离启动入口：新的状态目录，Redis 走内存模式或 6398，SQLite、配置、日志、CLI owner 与进程生命周期全部隔离。不能只约定一个端口。
- **试点成功不等于切换完成**：完成条件见 AC-F3。

## User Journey

### Primary Journey: 团队成员的改动进家里
- **Scope unit**: workspace
- **Actor**: 团队成员（浪哥、泽丰等）与operator
- **Entry**: 团队成员在团队仓 next 开 PR
- **Flow**:
  1. 浪哥在团队仓 next 上提交改动 → review、CI 通过 → 合入 next
  2. 家里按 Phase E 选定的方式拿到这次改动，不需要猫重新改写一遍
  3. 家里下一轮同步出去时，不会把这次改动冲掉
  4. operator在家里 runtime 用上这项改动，家里原有的名字、配置、路由与数据不受影响
- **Success evidence**: 一次真实外部 PR 从合入团队仓、到家里可用、再到下一轮同步后仍保留的完整记录（提交、token、耗时、是否冲突、人工介入）
- **Non-goals**: 不把家里的私人文档、家规、记忆内容放进团队仓

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | workspace | 家里的猫 | 在家里改通用代码 → 同步进 next → 固定候选经 Linux / Windows 与实际操作验收 → 进 main 并打 tag → 源码用户 `pnpm start` 与桌面版拿到稳定版本 | next 与 main 的提交、CI 与 tag 记录 |
| S2 | workspace | 外部用户 | 在设置里填自己的名字和 @ 句柄 → 界面与提示文案显示他自己的名字，@ 他的句柄能路由到他 | 公开候选隔离启动后的页面与路由实测 |
| S3 | workspace | operator | 家里 runtime 持续运行期间，猫的开发与验证不碰家里的 runtime 目录、端口、Redis 6399、SQLite 与配置 | 隔离启动记录（状态目录、端口、进程）；Phase A 的家里配置解析对照 |

## Acceptance Criteria

<!-- 每条 AC 对应 Why 的诉求，并能由非作者复核。文字逐字一致、grep、文件计数、git 合并成功都只证明各自那一小件事，不能单独当成安全或完成的证明。 -->

### Phase A（去改写第一批）
- [x] AC-A1: 改写规则与 transform 目标逐条有分类（显示配置 / 构建投影 / 隐私过滤 / 实际行为差异）；有一个可重跑的命令，按类别输出「导出时仍会被改写的文件数」，并记录立项基线。计数用于观察进度，不以归零为目标（PR #5796；`node scripts/count-export-rewrites.mjs --json`）
- [x] AC-A2: 名字与 @ 句柄切片：显示名、角色词、@ 路由句柄按含义分别处理；公开候选产物中「需要 You 决定」类文案消失；家里 @co-creator 等句柄仍能路由到 You；公开候选中用户设置的句柄能路由到用户（实测）
- [x] AC-A3: 品牌名、端口默认值、文档路径、仓库地址、默认开关改为读配置；仓库地址在共享代码里只剩一处定义
- [x] AC-A4: 家里与公开版都没退步，每个切片四项都要有证据：① 家里生成的系统提示词与受影响文案逐字一致；② 家里配置解析出的名字、句柄、端口、路径、默认开关与改前相同；③ 受影响的操作实际跑过（例如 @ 路由、受影响的设置读取）；④ 合入前用同步脚本已有的隔离入口启动公开候选，健康检查与受影响功能通过，不等合入后的下一轮既定同步（当前每2小时）才发现问题
- [x] AC-A5: 只删除已被等价实现替代的改写规则，并逐条说明替代物；隐私过滤与实际行为差异规则保留，或有单独确认的替代设计；合入后下一轮既定同步（当前每2小时）通过

同步验收沿用现有值守，不额外触发同步或增加 writer。10-20 的每12小时观察已被 operator 恢复每2小时的决定取代（`[thread-id]#private-source-id`）；当前唯一调度为 `dyn-1792575889211-xa37qo`。

[PR #5873](https://github.com/zts212653/clowder-ai/pull/5873) 已于 21:30:46 UTC 合入 `2f62149f243957954640867a7ef3d6895831a100`；Sol5.6 最终批准精确 HEAD `47a10ecddd61f398192a0fbc62b2a296efaa316f`，无开放 P1/P2（`[thread-id]#private-source-id`）。修复保持不可变来源和全部 sanitizer/privacy 规则；精确 pin 仍为固定常量，node/delegate/git/symlink 拒绝边界保留。home/public 来源测试各 34/34、F306 各 7/7、两组直接检查各 52/52、guarded gh 13/13、sanitizer 4/4、核心 smoke 31/31，均 0 skip；不求和重叠组。三个源码路径的最小补丁已在自有临时 Git index 验证能应用到 daily 新冻结源 `53ac9a0b1f871aa086a9aa4612f830da73afb26a`，未写 daily 工位或候选。

**AC-A5 终态（2026-10-21 23:37:36 UTC）**：原唯一 daily 周期的固定源 `6772da8c3d50142cc010338722f34c444dbc41be` 包含上述六个切片的真实 Git ancestry；#5873 三个修复文件与独审 `47a10ecddd` 的 blob 逐一相同。候选 `dcec0be8465d0a1cb82341ce7347edf34ed71eca`、CI merge-ref `2870656a5624ebfb06eb0028e8e66d46851db35b` 与公开落地 `3c0a20097f19dbef736403d78ce8fbde54d68d19` 的 tree 均为 `82b9775825937d9bcba0ce39dfc9d0e82c8bfda8`。GitHub 实时回读确认 #1649 已 MERGED，Linux `39692704417`、Windows `39692704419`、macOS `39692704504` 均 success 且绑定同一候选。

原生 writer 706 秒成功，F251 为 3,856 pass / 0 block / 0 override；1,409 处置、9 个社区等价路径及 Windows workflow 保全。原生 CI 检查 consistent，7 lane 覆盖 2,676 个计划文件、9 个原始 archive digest；计划外启动隔离 55/55。F306 pin 和 archive owner adapter 两个原失败文件在最终 CI 的文件级回归均 passed。文件级原件不支持全部 subtest 零 skip，不作该声明。规则退役的逐条替代与 privacy/behavior 保留证据仍沿前文账本，旧 851/1a7 失败不覆盖。

### Phase B（去改写第二批）
- [ ] AC-B1: 测试不再依赖家里数据断言与 `/home/user 本机路径；system-prompt hash 与内置插件包由构建生成，不在同步时改写
- [ ] AC-B2: L0 模板与 hooks 中的家里句子改为模板变量，满足 AC-A4 的四项检查
- [ ] AC-B3: 两边本来就不同的每个文件都有写明的归属，并在隔离仓库实测四种情况（上游单边修改、上游删除、双方修改、全新 checkout）的结果符合预期；不以 `.gitattributes merge=ours` 作为保护

### Phase C（发布层）
- [ ] AC-C1: next 快进到 main；next 上实际跑通与 main 相同的 CI（Linux 与 Windows）
- [ ] AC-C2: daily 同步的公开基线、PR base、目标新鲜度检查与 F251 基线 / 水位在同一次交付中改为 next，并有隔离副本中的验证记录
- [ ] AC-C3: 走通一次完整旅程：团队 PR 进 next → 家里接入 → 家里下一轮同步没有冲掉它 → 固定候选经 Linux / Windows 与实际操作验收 → main 接受该候选并打 tag
- [ ] AC-C4: main 的紧急修复有路径且至少演练一次，修复合回 next；默认分支与发版节奏按 operator 决定落实，并写进 CONTRIBUTING

### Phase D（转组织仓）
- [ ] AC-D1: 仓库转入组织，转前转后 star / fork 数对照无丢失
- [ ] AC-D2: 文档站地址、团队成员组织身份、GitHub App、gh / PR 跟踪、桌面版检查更新逐项有处置与实测记录

### Phase E（成本证据与回流对照）
- [ ] AC-E1: 记录一次真实完整双向交付的基线：总 token、耗时、人工介入、冲突与重试
- [ ] AC-E2: 在隔离副本上，用同一批真实外部 PR 比较机械 intake 与 git merge 的上述指标（含改造、冲突、重试、维护成本），数据库与功能正确性独立验证；由 operator 拍板保留哪种

### Phase F（按模块挪写入归属）
- [ ] AC-F1: 每个已迁模块写明写入归属、取回方式、旧同步路径的退出条件与退出后的门禁，并实际生效
- [ ] AC-F2: 本机运行团队仓代码，全部经过已有隔离启动入口（新状态目录；Redis 内存模式或 6398；SQLite、配置、日志、CLI owner、进程生命周期隔离），有测试守住
- [ ] AC-F3: 切换完成：共享代码的每个模块都有声明的唯一写入归属；全量同步已退役，或缩到一份由 operator 确认的剩余清单；按 AC-E1 的口径，一次完整双向交付的总 token、耗时与人工介入不劣于基线，同步失败次数不高于基线

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | 「让团队仓当我们的上游，家里不要这样全量同步」 | AC-C2, AC-F1, AC-F3 | 写入归属与退出条件记录；全量同步退役或剩余清单 | [ ] |
| R2 | 「保证家里也高效开发且吃到开源仓的东西」 | AC-C3, AC-E2 | 完整旅程记录与对照数据 | [ ] |
| R3 | 「如果新流程更费 token 还没现在稳定，那收益是什么」 | AC-E1, AC-E2, AC-F3 | 总 token / 耗时 / 人工介入的基线与对照 | [ ] |
| R4 | 「开源仓得有 dev/next……发版本再进 main，保证 main 稳定」 | AC-C1–C4 | next/main 提交、CI、tag、hotfix 演练 | [ ] |
| R5 | 「不喜欢 @you……内外不一样、对外不友好的统一掉」 | AC-A1–A3, AC-B1–B3 | 公开候选实测、分类计数 | [ ] |
| R6 | 「别启动开源仓把家里搞废了」 | AC-A4, AC-F2 | 四项检查；隔离启动记录与守卫测试 | [ ] |
| R7 | 转组织后 fork 和 star 保留 | AC-D1, AC-D2 | 转前转后数字对照 | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求有足以判断实际结果的依据（公开候选以隔离启动后的实测为准）

## Dependencies

- **Evolved from**: F059（开源计划，2026-04-10 关闭；建立了家里单向导出的同步管线）
- **Related**: F238（双向边界对称，已关闭；本 Feature 逐步把其中可等价替代的显示类改写换成读配置，隐私与行为差异边界保留）
- **Related**: F251（公开仓差异保留门禁；Phase C 要改它的基线与水位，Phase E 的结论可能让保留清单退役）
- **Related**: F202（插件宿主；浪哥 #1487 已合入，是 Phase F 的首选候选模块）

## Risk

| 风险 | 缓解 |
|------|------|
| 改动把家里正在跑的 runtime 搞坏 | AC-A4 四项检查；只在隔离工位开发，开发 Redis 用 6398；验证公开候选只走已有隔离启动入口 |
| 开源仓默认 Redis 是 6399，与家里圣域相同 | 本机运行团队仓代码一律走隔离入口（AC-F2）；不改公开默认值，外部用户的数据在他们自己机器的 6399 上 |
| 为了让计数归零，删掉隐私过滤或行为差异 | AC-A1 计数不以归零为目标；AC-A5 只删有等价替代的规则 |
| 以为 `.gitattributes` 能保住两边不同的文件 | 不用它做保护；AC-B3 按归属实测四种情况 |
| next 切换后检查和水位仍指向 main | AC-C2 要求在同一次交付里一起改并验证 |
| 各阶段都打勾，家里仍是大部分代码的上游 | AC-F3 定义切换完成；试点成功不算完成 |
| 换回流方式反而更费、更不稳 | AC-E1 先记基线，AC-E2 在隔离副本提前比较，不达标保留机械 intake |
| 转组织导致文档站链接失效、跳转失效 | Phase D 清单；旧地址不建同名仓库 |
| next 再次因为「太麻烦」没运作起来（3 月的真实原因） | 发版这一步要便宜：由猫按节奏准备固定候选并附验收证据，You 只点一次头；切换后记录 next 上的外部 PR 数与发版耗时，若 next 只剩手续、没有外部贡献在用，回到只用 main |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Phase A（去改写的名字与 @ 句柄切片）先行；next 发布层先做隔离准备，正式切换在 A 之后 | Ragdoll、Siamese主张先去改写，小星星主张先补 next 发布层并保留机械 intake，分歧保留。operator 已批准 Phase A。去改写会改动现有导出规则，并非「不碰同步」 | 2026-10-20 |
| KD-2 | 回流暂保留现有机械 intake，git merge 在 Phase E 隔离对照 | 小星星实测机械 intake 已能原样应用补丁；「squash 必然导致回流冲突」有反例，已收回 | 2026-10-20 |
| KD-3 | Phase A review 交 Sol5.6 | operator 指定（`private-source-id`） | 2026-10-20 |
| KD-4 | 不改公开默认 Redis 端口，在家里本机走隔离入口 | 改公开默认值会让外部用户连不上自己的数据 | 2026-10-20 |
| KD-5 | 不用 `.gitattributes merge=ours` 保护两边不同的文件 | 上游单边修改不会触发该 driver；driver 需本地配置。小星星隔离复现 | 2026-10-20 |

## Review Gate

- Phase A/B：Sol5.6 本地 review，按 AC-A4 四项检查与 AC-A5 的逐条替代说明验收
- Phase C/D：涉及开源仓设置、同步目标与仓库归属，正式切换前取得 operator 决定
