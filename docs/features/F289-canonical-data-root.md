---
feature_ids: [F289]
related_features: [F127, F214, F231, F249, F260, F273]
topics: [runtime, persistence, migration, desktop, community]
doc_kind: spec
created: 2026-08-07
community_issue: "clowder-ai#1303"
description: "把用户持久数据从可重建代码投影中迁出，以一个与 cwd/worktree 无关的 canonical data root 服务源码与桌面用户。"
description_source: human
description_author: landy
description_updated_at: 2026-08-11T13:29:00Z
---

# F289: Canonical Data Root — 用户数据离开 runtime 投影

> **Status**: in-progress — production cutover paused / current one-shot migration NO-GO | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P0

## Why

用户数据的家不能由“代码从哪个目录启动”决定。当前 cwd/projectRoot fallback 让同一台机器出现多个彼此分叉的数据根：账号在一个抽屉写入、猫猫绑定从另一个抽屉读取，直接造成社区 issue #1303 的 `provider not found`；家里的 runtime 又因此承载约 16GB 不可重建数据，失去“随时可删并从 `origin/main` 重建”的投影性质。

operator的完成定义是：**“一把修完，修完就完事了，之后不要两份东西了”**。真实数据演练已证明，这个终态仍正确，但不能再等同于“普通第一次 API 启动时自动搬完全部历史数据”；社区修复、寻址收口、历史 reconciliation 与生产 cutover 必须分别取得证据。

## Current State / 现状基线

2026-08-07 实测：

| 证据 | 当前状态 |
|------|----------|
| runtime Git | `runtime/main-sync` 相对 `origin/main` 仅 behind 5 / ahead 0；持久数据均被 gitignore，不会阻塞 ff-only，却可能在重建/清理时静默丢失 |
| home data root | `~/.cat-cafe` 约 33GB |
| runtime active data | `.cat-cafe` 607MB + `data` 11GB + `evidence.sqlite` 3.7GB + `packages/api/uploads` 795MB，首轮恢复快照总字节数 17,553,233,086 |
| SQLite live state | `evidence.sqlite` 为 WAL 模式，检查时 WAL 约 201MB；只复制主文件不足以称为一致冷备 |
| global config split | `catalog-accounts.ts` 的 `resolveGlobalRoot(projectRoot)` 在未设 `CAT_CAFE_GLOBAL_CONFIG_ROOT` 时优先采用 projectRoot；调用方给出不同 projectRoot 即产生多个 `.cat-cafe` |
| other asset split | transcript/evidence/log/upload/media/TTS/audit/CLI archive 各自使用独立 env 或 cwd/repo fallback；桌面 `service-manager.js` 必须手列 8 个 env，新增资产容易漏 |
| local recovery snapshot | `~/.cat-cafe/backups/pre-data-root-unification-20260807T2050PDT/` 已复制上述四块数据；另用 SQLite online backup 生成 `evidence.sqlite.consistent`，`PRAGMA quick_check=ok` 且源/备份 `page_count=978920`。服务仍写入的 3 个 `events.live.jsonl` 证明最终 cutover 前必须停写再增量同步 |

这不是单个账号路由 bug，而是持久化拓扑没有唯一答案。

## 2026-08-11 Production Reality Check（当前权威执行边界）

> **结论：#3467 当前不得合入或触发首次启动迁移。** 统一 data root 的目标保留，但“在第一次 API 启动中自动完成全部历史归位”的交付方式暂停，等待分阶段重构与离线迁移演练。

冻结 main 后的候选曾完成 full gate、exact-HEAD CI 与 review continuity；这些证据证明代码候选满足合成 fixture 与仓库门禁，**不等于真实安装可安全 cutover**。在猫咖停止写入、未创建 target/manifest 的前提下，对真实 legacy roots 运行只读 dry-run 得到：

| 现场证据 | 结果 |
|----------|------|
| candidate | PR #3467 exact HEAD `138299ac33653acf8705e7bf7bdc5333121e4bec`；未 merge |
| planned assets / source roots | 95 项 / 9 个 roots |
| active legacy footprint | 约 80GB；含约 58GB `packages/api/data`、14GB runtime `data`、4GB evidence SQLite 与约 201MB WAL、uploads/profile/config 等 |
| planner verdict | `conflict=35`, `copied=30`, `merged=22`, `skipped=8`；exit 2，写入前 fail-closed |
| unknown legacy entries | 61 项，尚未进入 typed asset census |
| conflict domains | accounts/credentials/provider profiles、cat catalog、services、event-memory/evidence/task-outcome/world SQLite、CLI raw archive、audit NDJSON、Antigravity session state |
| production mutation | 无；未 merge、未 restart、未创建 canonical target/manifest、未移动或删除 legacy source |
| recovery state | 2026-08-07 的约 20GB 首轮快照仍在，但不覆盖本轮盘点出的约 80GB 数据面，不能充当最终 cutover 冷备 |

35 个 blocker 主要不是“任选一个最新文件”就能解决：多个 root 持有真实但互相矛盾的身份、密钥、配置、SQLite 与 append-only 历史。错误选择 authority 会造成语义数据丢失。当前 fail-closed 设计避免静默覆盖，但若在此状态 merge，首次 runtime restart 会在启动前失败并造成停机。

本轮还发现一个合成 fixture 未覆盖的实现缺口：audit policy 声明 `jsonl-union`，真实文件使用 `.ndjson`，现有 adapter 只识别 `.jsonl`，因此会把本可逐记录合并的审计历史判成 raw-history conflict。已保留精确 RED 测试证据；修复、扩展 fixture 与重新 review 属于后续重构，不得作为当前 cutover 的临时补丁绕过其余 35 个冲突。

### Superseding delivery plan

1. **暂停 #3467**：PR 保持 open 作为实现与证据载体；在新计划闭合前不 merge、不 restart、不 cutover。
2. **Phase 0 — 冻结迁移面，不冻结开发**：先交付 canonical resolver、typed asset catalog、#1303 accounts/cats compatibility 修复与 anti-drift guard。guard 令 resolver/catalog 外新增持久路径直接 CI 红；已有安装不自动搬家、不 dual-write，每类资产仍只有一个显式 active writer root。
3. **Phase 1 — 离线 reconciler**：默认只读，按 asset 展示全部来源、hash/SQLite 语义差异与建议 authority；每项冲突必须有显式 owner 决策，输出可审计 manifest，不按 mtime 猜真相。
4. **Phase 2 — 完整克隆演练**：建立覆盖全部 active roots 的 stopped-writer 冷备并验证 SQLite/WAL，再对 disposable clone 迁移、启动与恢复；只有 dry-run `0 blocker`、restore drill 成功、关键用户旅程通过才进入预迁移。
5. **Phase 3 — 按资产资格预迁移**：immutable/hash-stable 目录与可证明 append-only 的 closed segments 可在线预拷贝；SQLite、活跃日志及没有可靠 delta 协议的资产不得套用通用 rsync，必须使用 typed snapshot/delta adapter 或留到停写窗口。
6. **Phase 4 — 受保护 cutover**：由不依赖 Clowder AI runtime 的独立执行器完成停写、最终冷备、增量同步、验证、activation 与冒烟。legacy source 保持只读；删除永远是后续单独授权。只有在新 writer 尚未放行前，activation 才允许纯“切指针”回退；放行新写入后，回退必须先 reconcile 新增数据，禁止声称秒级无损回滚。
7. **消息状态机独立处置**：queue/hold/provider/message model 的运行态异常不是 F289 的迁移依赖，不与本 PR 捆绑；相关 owner 可在当前 main 上独立修复和合入。

### Migration-surface freeze contract

- “冻结迁移面”冻结的是**资产种类、路径构造入口与裁决协议**，不是宣称 legacy 字节从此静止。Phase 0 落地前，旧 roots 仍可能增长；落地后，增长必须发生在 catalog 已知的唯一 active path 上，因此 reconciliation 的规则集合封闭、数据量仍可观测。
- 冲突条数增加不自动等于纯机器成本。同一稳定 ID 的身份/密钥冲突、不可合并 SQLite 或跨 store 引用仍需语义 authority；工具只负责枚举、证明和执行已批准的规则。
- 任何继续开发的 feature 若新增 durable state，必须登记 lifecycle、canonical relative path、compatibility/migration disposition 与测试；否则 anti-drift guard 阻塞。开发不集体停，最终仅冻结生产 writers。

### Downstream unblock contract

- F279、K-2D、#3556/#3558 及其他 feature **不得继续等待 #3467 合入，也不得把其未落地 resolver 当成 main 契约**。
- 下游应基于当前 main 完成自己的 domain/process/transport 改动；需要持久路径时保留窄注入边界或现有兼容 resolver，避免新造第二套 implicit root。
- 下游新增持久状态必须进入 typed asset catalog/guard 契约；“已解阻”不等于可以继续裸拼 cwd/projectRoot 数据路径。
- F289 后续若产出稳定的 canonical resolver，将以新的 exact-main 契约通知下游；适配属于届时的窄增量，不要求下游为本 PR 预留 merge/cutover 顺序。
- 当前 main 不含 F289；恢复当前 main 的猫咖不会触发本迁移。

## Architecture Ownership

Architecture cell: `runtime-data-root`（new）

Map delta: new cell required

Why: 现有 `memory`/`identity-session` 等 cell 各自拥有数据语义，但没有 cell 拥有跨域 canonical data root、legacy migration 与 runtime/worktree/desktop 的存储边界。

## What

### Phase A: 单一寻址契约与守护测试

- 新增共享 data-root resolver：显式 `CAT_CAFE_DATA_DIR` 优先，否则使用平台 canonical user data root；不得从 cwd、projectRoot、runtime root 或 worktree 存在性反推持久数据位置。
- 每个资产只声明 canonical data root 下的相对位置与 lifecycle scope：owner-global 状态进 root 固定子路径，project-scoped 状态进 `${CAT_CAFE_DATA_DIR}/projects/<stableProjectKey>/`；projectRoot 只可参与推导稳定 scope key，不再成为文件系统根。现有细粒度 env 作为显式兼容 override 保留，不再充当默认拓扑。
- global accounts/credentials/catalog 与 profile/memory/log/transcript/upload 等消费者统一复用 resolver。
- 新增静态/行为守护测试，阻止新增 cwd/projectRoot/repo-root 持久化 fallback。

### Phase B: 离线 reconciliation、演练与显式 activation

- 普通 API 首次启动不再承担历史数据搬迁；源码与桌面启动只消费 Phase A 已验证的 active-root/compatibility 契约。
- 离线 reconciler 具备进程锁、幂等 manifest、逐资产 dry-run、显式 authority、校验与可诊断结果；marker 只在全量验证完成后提交。
- 冲突时禁止按 mtime/“新文件赢”静默覆盖：JSON 配置按稳定 ID 语义合并；SQLite 使用一致备份/明确迁移器；目录资产仅合并无冲突路径，非同内容碰撞 fail-closed 并保留两侧证据。
- 预迁移能力按资产证明，不建立“所有文件都能在线 rsync”的全局假设。正式 activation 只在 clone rehearsal、restore proof、最终 stopped-writer delta 与关键旅程全部通过后发生。
- legacy source 在 cutover 后保持只读观察期；只有新 writer 尚未释放时允许 pointer-only rollback，物理清理与 post-write rollback 分别走独立授权/前向 reconciliation。

### Phase C: Desktop 与开发隔离

- 桌面端从手列多项资产 env 收敛为一个 `CAT_CAFE_DATA_DIR=userDataDir`；显式用户 override 仍按契约优先。
- feature worktree/alpha/test 自动注入隔离 data root，绝不读取或写入 `~/.cat-cafe` 正式数据；Redis 继续只用 6398。
- runtime 启动继续把 runtime root 当代码投影、workspace root 当 git 真相源、data root 当持久用户状态，三根轴互不代偿。

## 数据归位表

| 资产 | 旧位置/旧默认 | canonical 位置 | 迁移策略 |
|------|---------------|----------------|----------|
| accounts / credentials / cat catalog / user preferences / service config | `<projectRoot>/.cat-cafe/*` 或 `~/.cat-cafe/*` | `${CAT_CAFE_DATA_DIR}/*` 的 typed global paths | 解析稳定 ID；相同去重，互补合并，语义冲突 fail-closed + 报告 |
| capabilities / governance / plugin config / packs / prompt overlays | `<projectRoot>/.cat-cafe/*` | `${CAT_CAFE_DATA_DIR}/projects/<stableProjectKey>/*` | 保留 project scope；同 remote 的 worktree 共享 scope，显式开发 data root 仍整体隔离 |
| mcp-creds / generated OpenCode config / resolved config / run files | `<projectRoot>/.cat-cafe/*` | `${CAT_CAFE_DATA_DIR}/run/**` 或重建 | 不把 session secret/派生物误判为长期 truth；需要重启续存的放 run scope，其余重建 |
| audio/ASR/TTS/embedding venv 与可重建缓存 | repo-local `.cat-cafe/*-venv` 或 data cache | `${CAT_CAFE_DATA_DIR}/assets/**` 或按需重建 | 不复制重复 600MB venv 冒充用户真相；安装器负责重建 |
| evidence SQLite | `<repoRoot>/evidence.sqlite` | `${CAT_CAFE_DATA_DIR}/evidence.sqlite` | SQLite 一致性备份/校验；禁止字节级覆盖已有不同 DB |
| transcripts / logs / audit / CLI archive | `<repoRoot>/data/**` 或 cwd-relative `./data/**` | `${CAT_CAFE_DATA_DIR}/data/**` | 无冲突合并；同路径不同内容 fail-closed；最终停写增量同步 |
| uploads / connector media / TTS cache | `<repoRoot>/packages/api/uploads`、cwd-relative data | `${CAT_CAFE_DATA_DIR}/uploads`、`${CAT_CAFE_DATA_DIR}/assets/**` | 用户资产校验迁移；可重建缓存可重建，不冒充唯一数据 |
| profile / relationship / person memory | 已有 `${CAT_CAFE_DATA_DIR}/profiles/**` 等 canonical 路径 | 不变 | 复用共享 resolver，删除平行 cwd fallback |
| docs / skills / taste vignettes | `CAT_CAFE_WORKSPACE_ROOT` 的 Git 主仓 | 不变 | 不进入 data migration |
| thread / message / task / proposals | Redis 6399（正式）/6398（开发） | 不变 | 不进入文件迁移 |

## User Journey

### Primary Journey: 既有安装安全收敛且不阻塞正常启动

- **Scope unit**: workspace
- **Actor**: 源码用户
- **Entry**: 用户在既有安装上获得 Phase A resolver/compatibility 版本
- **Flow**:
  1. API 通过统一 resolver 选择每类资产的唯一 active path；既有数据不因普通启动自动搬迁。
  2. #1303 的 account create 与 cat binding 读写同一 store，legacy-only 安装仍可读。
  3. 离线 reconciler 在独立命令中生成 plan；冲突 fail-closed，不影响正常 API 启动。
  4. clone rehearsal 与受保护 cutover 通过后，activation 才把 active truth 切到 canonical root。
- **Success evidence**: #1303 route E2E + boundary guard + offline dry-run manifest + clone migrate/restore drill + protected cutover report
- **Non-goals**: 不把 F273 updater 改造成通用迁移框架；不迁移 Redis 6399；不把 Git 文档/skills 搬进 data root

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | workspace | 桌面用户 | 更新/安装新代码 → compatibility resolver 保持旧数据可读 → 账号与猫绑定读取同一 active root | desktop service-manager fixture + #1303 回归 |
| S2 | workspace | 开发猫 | 创建 feature worktree/alpha → 自动得到隔离 data root → 测试不触碰正式数据 | shell fixture + sentinel guard |
| S3 | workspace | operator | clone 演练 → 独立执行器停写 → 最终增量/activation/冒烟 → 放行新 writer | migration report + restore proof + activation/rollback boundary evidence |

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “runtime 这个仓应该只是投影” | AC-A1, AC-C3 | resolver tests + runtime tree audit | [ ] |
| R2 | “一把修完，修完就完事了，之后不要两份东西了” | AC-A2, AC-B1, AC-B5 | guard + migration E2E + post-cutover audit | [ ] |
| R3 | “社区小伙伴什么时候帮他们迁移” | AC-B1, AC-B4 | offline reconciler + clone/restore fixture；普通启动不自动搬历史数据 | [ ] |
| R4 | 原 one-shot 原子 PR 方向 | AC-C1, AC-C4 | 已由 KD-13 否决；按 resolver/guard、reconciler、cutover 分阶段 review | [x] superseded |
| R5 | worktree 开发不能误碰正式数据 | AC-C2 | sentinel integration test | [ ] |
| R6 | 本地冷备先做 | AC-B6 | backup path + SQLite quick_check + final stopped-writer delta check | [ ] |
| R7 | “现在到底啥玩意在 cat-cafe、啥玩意在 runtime” | AC-A4 | typed asset census + lifecycle scope tests | [ ] |

### 覆盖检查

- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求不适用；桌面行为由启动 fixture 验证

## Acceptance Criteria

### Phase A（单一寻址契约）

- [ ] AC-A1: 生产默认 data root 只由显式 `CAT_CAFE_DATA_DIR` 或平台 user-data 默认值决定；targeted test 证明改变 cwd/projectRoot/runtime/worktree 不改变路径。
- [ ] AC-A2: accounts、credentials、cat catalog、user/service/plugin/capability/governance/pack config、evidence、transcripts、logs、audit、CLI archive、uploads、connector media、TTS 与既有 profile/person stores 全部复用 canonical resolver 或显式兼容 override；源码扫描守卫不存在 repo/cwd/projectRoot 持久化 root fallback。
- [ ] AC-A4: owner-global / project-scoped / runtime-ephemeral / rebuildable-cache / Git-truth 五类资产有 typed census；project-scoped path 使用稳定 project key，同 repo 多 worktree 不产生多份正式 truth，显式开发 data root 则完整隔离。
- [ ] AC-A3: `runtime-data-root` ownership cell 登记 canonical contract、migration owner 与主要代码锚点，ownership generator 检查通过。

### Phase B（离线 reconciliation 与受保护 cutover）

- [ ] AC-B1: 离线命令默认 dry-run；真实/fixture legacy roots 均只生成 typed inventory、冲突与 authority manifest，不影响普通 API 启动。
- [ ] AC-B2: reconciler 并发只允许一个 writer；中途失败不写 activation marker，下次可恢复；manifest 带 schema version、source provenance、authority 与 asset verdict。
- [ ] AC-B3: JSON/NDJSON、目录、SQLite、append-only 与 unknown entry fixture 全覆盖；不同内容不按 mtime 静默覆盖，每类预迁移资格有独立证明。
- [ ] AC-B4: disposable clone 完成 migrate → start → critical journeys → restore；源数据 hash/SQLite integrity 与恢复结果可审计。
- [ ] AC-B5: 受保护 cutover 由 runtime 外独立执行器完成；writer freeze、最终 delta、activation、pre-write smoke 与 writer release 是显式 gate。writer release 前可回退 activation，之后回退必须 reconcile 新写入。
- [ ] AC-B6: 覆盖全部 active roots 的 stopped-writer 冷备可恢复；SQLite consistent backup `quick_check/integrity_check=ok`；legacy source 保持只读，删除需独立授权。

### Phase C（桌面与开发隔离）

- [ ] AC-C1: desktop `service-manager.js` 仅需设置 `CAT_CAFE_DATA_DIR=userDataDir` 即覆盖默认资产路径；#1303 新建账号后绑定猫猫的回归测试通过。
- [ ] AC-C2: feature worktree、alpha 与 test 默认获得独立临时 data root；sentinel 证明不会读写 `~/.cat-cafe`，Redis 端口保持 6398。
- [ ] AC-C3: runtime/workspace/data 三轴测试证明代码投影、Git 真相源、持久状态互不 fallback。
- [ ] AC-C4: resolver/guard、offline reconciler、activation/cutover 分别以风险匹配的 PR 交付；每个切片有 exact-HEAD gate/review，任一切片不得借 continuity 越过新的数据风险面。

## Dependencies

- **Evolved from**: F231（已验证 profile 真相不能依赖 cwd/worktree）
- **Related**: F127（账号/猫实例配置语义）、F214（根目录卫生）、F249（project-scoped capabilities）、F260（per-user 持久真相）、F273（桌面代码分发；不是 blocker）
- **Blocked by**: 生产 cutover 被真实数据 authority reconciliation、完整冷备/恢复演练与分阶段方案阻塞；F273、F279、K-2D、消息状态机及其他 feature 不被 F289 阻塞，可基于当前 main 独立推进

## Risk

| 风险 | 缓解 |
|------|------|
| 活跃 SQLite/WAL 或 append-only 文件被非一致复制 | SQLite online backup + final stopped-writer delta + quick/integrity check |
| home 与 runtime 都已有不同 truth，自动覆盖造成丢数据 | 逐资产 typed merge；不同内容 fail-closed；保留 source provenance 与恢复快照 |
| compatibility 阶段出现 legacy + canonical dual-write，形成第三份状态 | 每类资产只有一个 active writer root；resolver/catalog 注入 + anti-drift guard；禁止隐式 dual-write |
| 多进程同时执行 reconciler/cutover | filesystem lock + crash-safe manifest commit + idempotent retry；普通 API 启动不执行历史迁移 |
| worktree/alpha 统一后误碰正式数据 | 启动脚本自动注入隔离 root + sentinel fail-fast guard |
| 旧 per-asset env 用户升级后行为变化 | 显式细粒度 override 保持最高优先级并有 compatibility tests；仅删除隐式 cwd fallback |
| startup migration 自动删除社区唯一副本 | 先复制/验证/切换 truth，再把 legacy root 标记为 inactive；删除只在显式本地 cutover/授权边界内执行 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | canonical root 默认 `~/.cat-cafe`；桌面显式传 `userDataDir` | 数据跟用户/安装身份走，不跟代码 checkout 走 | 2026-08-07 |
| KD-2 | migration 进入 API bootstrap，不进入 F273 updater | API 启动是源码与桌面两类用户唯一共同必经路径 | 2026-08-07 |
| KD-3 | 一个原子 PR 同时交付 resolver、migration、desktop env、隔离与 guards | 拆分会制造“新代码先读新位置、旧数据尚未迁”的丢失窗口 | 2026-08-07 |
| KD-4 | 保留显式 per-asset env override，删除隐式 cwd/projectRoot fallback | 兼容真实部署定制，同时物理消灭第二个默认答案 | 2026-08-07 |
| KD-5 | 冲突 fail-closed，不按 mtime 猜 truth | 迁移涉及密钥、账号、SQLite 与用户记忆，猜错不可接受 | 2026-08-07 |
| KD-6 | 服务不停的首轮复制是 recovery snapshot，不冒充严格 cold backup | live JSONL 与 SQLite WAL 的实测变化证明需要最终停写增量窗口 | 2026-08-07 |
| KD-7 | 一个 physical data root 内保留 lifecycle scope，不把所有 `.cat-cafe` 文件拍平成全局一份 | capabilities/governance/plugin 等语义按 project 隔离；统一 root 解决选址，不抹掉 ownership | 2026-08-07 |
| KD-13 | 暂停 KD-3 的 one-shot 原子 cutover 与普通首次启动自动迁移；改为 resolver/compatibility、离线 reconciliation、clone rehearsal、受保护 cutover 分阶段交付 | 真实 stopped-writer dry-run 在 95 项资产/9 个 roots/约 80GB 数据上发现 35 个语义冲突与 61 个未知条目；仓库全绿不能替代真实 authority 决策与 restore proof | 2026-08-11 |
| KD-14 | 冻结 migration surface，不冻结全家开发：Phase 0 以 typed catalog + anti-drift guard 封闭新增资产种类和路径入口；已有安装不自动搬家、不 dual-write | 人肉 main freeze 无法持续；真正的人脑成本来自新增资产种类/路径协议，应该由 guard 阻止，而非让无关 feature 等待 | 2026-08-11 |
| KD-15 | 在线预迁移与 pointer rollback 都按资产/写入阶段证明；不把“两阶段复制”或“秒级切回”当全局能力 | SQLite/WAL、活跃 append-only 与跨 store 引用没有统一 delta；writer release 后 canonical 新写入无法靠切回旧 root 无损保留 | 2026-08-11 |

## Tips Contribution（F244）

`tips_exempt: F289 migration is an explicit operator/reconciler workflow, not a discoverability tip; diagnostics belong to the offline plan/manifest and protected cutover report.`

## Review Gate

- 数据迁移/持久化风险命中 full gate；选择一位非作者 reviewer 覆盖 exact HEAD 的 resolver、migration、冲突与 rollback 行为。
- 本地正式 cutover 是生产数据操作，代码 review 通过后单独取得 operator 执行时点授权，不与 PR merge 混同。
