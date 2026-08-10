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
description_updated_at: 2026-08-08T03:58:18Z
---

# F289: Canonical Data Root — 用户数据离开 runtime 投影

> **Status**: in-progress | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P0

## Why

用户数据的家不能由“代码从哪个目录启动”决定。当前 cwd/projectRoot fallback 让同一台机器出现多个彼此分叉的数据根：账号在一个抽屉写入、猫猫绑定从另一个抽屉读取，直接造成社区 issue #1303 的 `provider not found`；家里的 runtime 又因此承载约 16GB 不可重建数据，失去“随时可删并从 `origin/main` 重建”的投影性质。

operator的完成定义是：**“一把修完，修完就完事了，之后不要两份东西了”**；社区源码用户和桌面用户升级后都应在第一次 API 启动时无感迁移，不要求手改 env，也不依赖尚未合入的桌面 updater。

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

### Phase B: 版本化启动迁移与社区升级

- API 在任何持久 store 打开或写入前执行 versioned migration；同一份代码同时覆盖源码启动与桌面启动。
- migration 具备进程锁、幂等 manifest、逐资产 dry-run plan、校验、失败回滚与可诊断结果；marker 只在全量验证完成后提交。
- 冲突时禁止按 mtime/“新文件赢”静默覆盖：JSON 配置按稳定 ID 语义合并；SQLite 使用一致备份/明确迁移器；目录资产仅合并无冲突路径，非同内容碰撞 fail-closed 并保留两侧证据。
- startup migration 不依赖 F273。F273 只影响桌面代码如何到达用户；源码用户的 `pnpm start` 与桌面用户更新后的 API 第一次启动走同一迁移入口。
- 本地 cutover 在停写窗口内完成最终增量同步、验证与 legacy active-root 退役；冷备保留为恢复资产，不参与运行时寻址。

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

### Primary Journey: 源码用户升级后无感归位

- **Scope unit**: workspace
- **Actor**: 源码用户
- **Entry**: 用户在既有安装上运行 `pnpm start` 并获得含 F289 的版本
- **Flow**:
  1. API 启动先发现 legacy roots 并生成迁移 plan。
  2. 无冲突数据自动迁到 canonical root；有冲突则启动 fail-closed，清楚展示资产、两侧路径与恢复动作，不伪装成功。
  3. 验证通过后 API 正常启动，原有账号、密钥、猫名册、记忆、上传和日志仍可用。
  4. 后续启动读取 versioned manifest，不重复迁移，也不再读取旧 root。
- **Success evidence**: fresh temp-home 端到端 fixture + legacy source tree → 首启迁移 → 二次启动 no-op → API route 回归
- **Non-goals**: 不把 F273 updater 改造成通用迁移框架；不迁移 Redis 6399；不把 Git 文档/skills 搬进 data root

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | workspace | 桌面用户 | 更新/安装新代码 → API 首启迁移 → 账号与猫绑定读取同一 userData root | desktop service-manager fixture + #1303 回归 |
| S2 | workspace | 开发猫 | 创建 feature worktree/alpha → 自动得到隔离 data root → 测试不触碰正式数据 | shell fixture + sentinel guard |
| S3 | workspace | operator | 停写窗口 → 最终增量同步与验证 → runtime 只剩可重建投影 | migration report + legacy root absence/retirement check |

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “runtime 这个仓应该只是投影” | AC-A1, AC-C3 | resolver tests + runtime tree audit | [ ] |
| R2 | “一把修完，修完就完事了，之后不要两份东西了” | AC-A2, AC-B1, AC-B5 | guard + migration E2E + post-cutover audit | [ ] |
| R3 | “社区小伙伴什么时候帮他们迁移” | AC-B1, AC-B4 | source/desktop first-start fixtures | [ ] |
| R4 | “代码 + 启动迁移 + 桌面 env + 守护测试，一个原子 PR” | AC-C1, AC-C4 | PR diff + gate | [ ] |
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

### Phase B（安全启动迁移）

- [ ] AC-B1: temp-home E2E 证明 legacy-only 安装首启迁移成功、所有目标资产可读、二次启动严格 no-op，且迁移在 store open/write 前完成。
- [ ] AC-B2: 并发启动只允许一个迁移 writer；中途失败不写完成 marker，下次可恢复；marker/manifest 带 schema version、source provenance、asset verdict 与校验信息。
- [ ] AC-B3: JSON 互补/相同/冲突、目录相同/冲突、SQLite 目标缺失/相同/不同等 fixture 全覆盖；不同内容不按 mtime 静默覆盖。
- [ ] AC-B4: 源码 `pnpm start` 与桌面 API 启动消费同一 migration entrypoint；F273 合入与否不改变迁移正确性。
- [ ] AC-B5: migration 完成后任何 runtime read/write 都不再触达 legacy root；本地 cutover 后 runtime 活跃用户数据归零，备份目录不被 resolver 扫描。
- [ ] AC-B6: 本地恢复快照可读；正式 cutover 前停写增量校验无差异，SQLite consistent backup `quick_check=ok`。

### Phase C（桌面与开发隔离）

- [ ] AC-C1: desktop `service-manager.js` 仅需设置 `CAT_CAFE_DATA_DIR=userDataDir` 即覆盖默认资产路径；#1303 新建账号后绑定猫猫的回归测试通过。
- [ ] AC-C2: feature worktree、alpha 与 test 默认获得独立临时 data root；sentinel 证明不会读写 `~/.cat-cafe`，Redis 端口保持 6398。
- [ ] AC-C3: runtime/workspace/data 三轴测试证明代码投影、Git 真相源、持久状态互不 fallback。
- [ ] AC-C4: 以上代码、启动迁移、桌面 env、隔离与守护测试位于一个原子 PR；full gate 与非作者数据迁移 review 通过。

## Dependencies

- **Evolved from**: F231（已验证 profile 真相不能依赖 cwd/worktree）
- **Related**: F127（账号/猫实例配置语义）、F214（根目录卫生）、F249（project-scoped capabilities）、F260（per-user 持久真相）、F273（桌面代码分发；不是 blocker）
- **Blocked by**: 无；F273 可独立先后合入

## Risk

| 风险 | 缓解 |
|------|------|
| 活跃 SQLite/WAL 或 append-only 文件被非一致复制 | SQLite online backup + final stopped-writer delta + quick/integrity check |
| home 与 runtime 都已有不同 truth，自动覆盖造成丢数据 | 逐资产 typed merge；不同内容 fail-closed；保留 source provenance 与恢复快照 |
| migration 在 store 已写新 root 后才运行，形成第三份状态 | bootstrap preflight 必须先于任何持久 store open/write，integration test 锁顺序 |
| 多进程同时首启 | filesystem lock + crash-safe manifest commit + idempotent retry |
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

## Tips Contribution（F244）

`tips_exempt: migration is automatic and introduces no new user action; failures must surface as actionable startup diagnostics rather than tips.`

## Review Gate

- 数据迁移/持久化风险命中 full gate；选择一位非作者 reviewer 覆盖 exact HEAD 的 resolver、migration、冲突与 rollback 行为。
- 本地正式 cutover 是生产数据操作，代码 review 通过后单独取得 operator 执行时点授权，不与 PR merge 混同。
