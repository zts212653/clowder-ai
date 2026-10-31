---
feature_ids: [F217]
related_features: [F073, F083, F177, F192]
topics: [merge-gate, ci, governance, gate-integrity, meta-guard, rulesets]
doc_kind: spec
created: 2026-05-30
---

# F217: Merge Gate Integrity — 检查覆盖 + 强制力 + 元守护

> **Status**: done（2026-06-02 闭环 — self-hosted 撤除 merged + Rulesets 不配 KD-10；私有仓治理 = main-green + 本地 gate + 跨猫 review 家规）| **Owner**: Ragdoll/Ragdoll (Opus-4.8) | **Priority**: P1

## 🎯 最终结论（2026-06-02 operator拍板 — 推翻 self-hosted CI）

**五轮收敛的终点**：私有仓**砍掉 self-hosted CI + 不配 Rulesets**，强制力靠 `main-green 纪律 + 本地 gate/hook + 跨猫 review 家规`；只有**开源仓**才用 GitHub-hosted CI。

operator cost-benefit 一刀：**猫违规概率 < 1%**（全自己猫，本地都跑 `pnpm gate`）。self-hosted CI 为防这 < 1% 违规，代价 = 每 PR 慢 ~19min + 烤 Mac（M4 Max 12 P-core 满载发热）+ 重复跑一遍本地已过的 gate——**不值得**。

更关键：self-hosted CI required **根本没治这次事故的真根（A2 已知红遮新红）**——main 一红 required CI 卡所有 PR，operator又被迫豁免，回老路。治 A2 的是 **main-green invariant（纪律，KD-7）**，与 CI 无关。

| | 强制力 | 为什么 |
|---|---|---|
| **私有仓 cat-cafe** | main-green 纪律 + 本地 gate/hook + **跨猫 review 家规**（KD-9）| 全自己猫 < 1% 违规；"不是一只猫说了算"靠家规文化（review 必须跨个体）而非 Rulesets——require-PR 会撞 shared-state 家规死锁（KD-10）|
| **开源仓 clowder-ai** | GitHub-hosted CI（已有 ubuntu-latest）| public 免费无限 + 外部贡献者本地 hook 不可信——**这才真需要 CI** |

**保留 / 砍掉**：
- ✅ 保留 **main-green invariant（KD-7）** — 治 A2 的核心，纪律不靠 CI
- ✅ 保留 **本地 gate + pre-push hook**（自己猫 merge 前跑全量 = operator说的"合入前跑"）
- ✅ **跨猫 review 家规（KD-9）** — A1 靠家规文化（已有"review 必须跨个体"），**不配 Rulesets require reviews**（KD-10：require-PR 撞 shared-state 死锁 + bypass 不干净 + < 1% 不值，三猫 ⊗ Maine Coon收敛）
- ❌ 砍 **self-hosted CI required（KD-2/3）+ runner** — 慢+热+重复，< 1% 违规不值
- ❌ 回滚 **PR #2057 的 self-hosted ci.yml + Typecheck job + gate-ci-parity** — 私有仓不跑 CI 则无意义（tsc 已在本地 gate Step 4 覆盖）

**残余风险（诚实记，operator接受）**：跨猫 review 是家规文化（非服务端强制），猫理论上能 self-merge 绕过（< 1% 概率）。但全自己猫 + main-green 让漏网红在下个 PR rebase 时暴露——这点风险换"不破坏 docs 零延迟 + shared-state 直接 push main 工作流"，值（同砍 self-hosted CI 的 cost-benefit）。**价值 OQ**：未来若"服务端强制 review" > "main 直接共享状态"，是新 operator 取舍（要改 shared-state 工作流），不是 F217 尾巴。

### 价值 OQ 人话版：服务端强制 review vs 共享状态实时同步（留给未来重新权衡）

> 2026-06-02 operator要求"诚实保留"——它不是 F217 尾巴（F217 已闭环），是留个钩子：家大了 / 猫多了 / 信任度变了想重新权衡时，有这笔账在，不用从头想。

**shared-state（共享状态）指啥**：几个**全家公用的"公告板"文件**——`docs/ROADMAP.md`（功能路线图：现在有哪些 feature 在做）+ `cat-config.json`（猫花名册：谁是谁、什么句柄）。每只猫靠它们知道"现在在忙啥、家里有哪些猫"，不是某只猫的私货。

**shared-state 工作流 = 改公告板的规矩**：家规规定这些公告板**只能 main 直接改 + 立刻 push**（不走 PR）——因为是**实时公告板**，改了要全家秒看到最新版。走 PR（等 review + 合并）→ 别的猫看到的是过期公告板，信息对不上。`shared-state-guard`（L3 CI，见 `shared-rules.md §14`）守这条，拦 PR 改它们。

**冲突**：Rulesets require reviews 要求"**所有改动走 PR**"，但公告板"**只能直接 push main 不走 PR**"。撞一起 → 公告板**既不能 PR（guard 拦）也不能直接 push（Rulesets 拦）= 死锁**。

**取舍（这就是价值 OQ）**：
- **现选后者**（保公告板实时同步，不配 Rulesets）—— require reviews 防的是 < 1% self-merge，不值得破坏每天都在用的公告板实时同步（同砍 self-hosted CI 的 cost-benefit 尺子）。
- **未来若改选前者**（"服务端硬卡 review" > "公告板实时同步"）= 新 operator 取舍，要**重构 shared-state 工作流**（让公告板也能走 PR / 或搬到别处同步）才能腾空间上 Rulesets。

> ⬇️ 下方保留二三轮收敛的完整推演（self-hosted runner 方案）作**决策历史**——它不是错的，是"私有仓 CI 额度不够"约束下的合理解；最终被 cost-benefit（< 1% 违规不值这成本）推翻。KD-2/KD-3/KD-8 标注 [已被最终结论取代]。

## Why

2026-05-30 全量同步（cat-cafe → clowder-ai）一路撞 **6 类 pre-existing 红灯/sync-coupling**（biome 格式 / index.json stale / shared-rules 硬编码猫名 / F180 emoji status / F214 sync-coupling / dir-size 超限），全是「cat-cafe `pnpm gate` 绿、clowder-ai CI 拦」——带病代码进了 main，sync 时集中爆发。

operator experience："固定基线治标（main 在动），gate 治理治本（main 为什么脏）= 真正避免反复。"

**4 型根因**（@antig-opus Phase A 实证 + operator 2026-05-31 关键澄清）：

| 型 | 实例 | 根因 |
|----|------|------|
| **A. gate 红了也拦不住 merge** | biome/index/Maine Coon（3 类）| **双子根因**：**A1（机制）** 没设 required status check——CI/gate 红也能 merge，没人拦；**A2（归因）** main 本身有已知红时（一只猫改系统提示词让测试挂），猫和operator**区分不了"已知红"vs"自己的新红"**，operator误豁免已知红 → 新红搭便车进 main。**最大的洞** |
| B. 检查 robustness bug | F180 emoji status | isDoneStatus 不认 `✅` 前缀（已止血 PR #1968）|
| C. sync-specific 检查不在 cat-cafe gate | F214 sync-coupling | root-package-script-surface 在 sync temp gate（已止血 PR #1970）|
| D. 检查缺失 | dir-size | check:dir-size 不在 pnpm gate（已接入 PR #1972）|

> **A 类根因修正（2026-05-31 operator澄清，推翻 Phase A "纸墙没跑 gate" 假设）**：实际是猫们**跑了** `pnpm gate`、看到红了 → 但那个红是"另一只猫改系统提示词让 main 上测试挂"的**已知红** → operator一看"是提示词超了、等优化完就绿"批准合入 → **但每只猫自己的改动也红了，被已知红遮住，谁都没注意**。失效模式不是"没跑 gate"，是 **A1（gate 红没机制拦 merge）+ A2（main 带已知红时，已知红遮住新红，误豁免一起放行）**。

止血已做。本 feat 根治系统性问题——核心是 A 类双子根因：
- **A1（强制力）** → Self-hosted runner + Rulesets required check（KD-2）：gate 红机制上拦住 merge，不可绕、不可伪造、不耗 CI 额度
- **A2（归因）** → **main-green invariant（KD-7）**：main 不准带红进，谁让 main 红谁同 PR 修绿——则 gate 红 == 你引入了新红，不存在"已知红遮新红"，误豁免无从发生

## What

### Phase A: 差集审计 + A 类根因实证 ✅（@antig-opus 完成）
读完整 gate 基础设施链（ci.yml / pre-merge-check.sh / run-checks.mjs / .githooks / merge-gate SKILL）。Phase A 初判 "A 类根因 = 没设 required status check，纯文化自觉（纸墙）"；**2026-05-31 operator澄清修正为双子根因 A1（机制）+ A2（归因），见 Why 段**。CI vs gate 差集表见附录。

### Phase B: Gate 强制力 — Self-hosted Runner + GitHub Rulesets（@co-creator 配置，不可逆）

> **2026-05-31 推翻"GitHub-hosted CI required check"**：cat-cafe 是私有仓，GitHub Actions 额度 ~5 天/月（operator实测）。若 require GitHub-hosted CI status，则 25 天/月所有猫 merge 不了 → **方案本身不可行**。强制力必须挪到不耗额度、且不可伪造的地方。

**机制 = Self-hosted runner（不耗额度）+ Rulesets require 其 status（不可伪造）**：
- **Self-hosted runner**：在operator常开机器（cat-cafe-runtime 所在机器）挂 GitHub Actions self-hosted runner → CI 跑在自己机器，**不耗 GitHub 额度**（self-hosted 免费无限），但结果是 **GitHub 服务端记录的 status，猫伪造不了**（不是本地 `gh api` 打的）
- **Rulesets require** runner 跑出的 4 job status（Lint/Build/Test/Dir-size）+ **require reviews**（跨猫 review 铁律，也不耗额度，作 backstop）
- **Admin bypass DISABLED**（Rulesets 特性，从根堵 `--admin` 逃逸）
- paths-ignore 处理：skip-if-no-change（docs-only PR 不被卡死）

> **方案 C（本地 gate → `gh api` 打 commit status）已砍掉，连 fallback 都不留**（KD-8）：那个 status 是猫本地打的，一行 `gh api .../statuses/{sha} -f state=success` 就能伪造 → 塑料锁。便利的逃逸口终将成默认路径（clowder-ai `--admin` 活教训）。Self-hosted runner 是**唯一**强制力路径。

### Phase C: 检查覆盖补全 ✅（PR #2057 merged 2026-06-02）
- ✅ 补 `tsc --noEmit` CI job（Typecheck，对齐 pre-merge Step 4，堵 Next build 跳过 __tests__ 类型盲区——最关键差集）
- ⬜ sync-only 检查审计（独立项未做；F214 已接 root-debris 作模式，其余待 sync 时发现）

### Phase D: 元守护 — check:gate-ci-parity ✅（PR #2057 merged 2026-06-02）
自举守护脚本（run-checks PARALLEL_CHECKS 第 20 项）：**声明式 coverage 契约**（CI job → gate 覆盖证明 + verify fn，非脆弱的 `run:` 字符串归一），assert CI checks ⊆ gate checks。CI 加 job 没声明 → 红（强制 parity 思考）；gate 删命令 → 红。脚本自身在 PARALLEL_CHECKS 自举。让"检查漏在 gate 外"不可能再发生。

## Acceptance Criteria

### Phase A（差集审计 + 根因实证）✅
- [x] AC-A1: CI vs gate 完整差集表（见附录，@antig-opus 实证）
- [x] AC-A2: A 类根因 = 双子根因（A1 没设 required check 拦不住 merge + A2 main 带已知红时已知红遮新红、误豁免放行）。**修正 Phase A "纸墙没跑 gate" 假设**（2026-05-31 operator澄清：猫跑了 gate、红了，但归因错了）

### Phase B（Gate 强制力 = Self-hosted Runner + Rulesets）
- [ ] AC-B0: operator常开机器安装 self-hosted runner（一次性 ~15min）+ 配 auto-start（崩溃/开机自重启）+ 验证 runner online 能跑 ci.yml 4 job
- [ ] AC-B1: GitHub Rulesets 配置 main require 4 status checks（self-hosted runner 产出）+ require reviews + admin bypass DISABLED（@co-creator GitHub Settings）
- [ ] AC-B2: paths-ignore skip-if-no-change 验证（docs-only PR 能 merge）
- [ ] AC-B3: 验证 CI 红时 merge 被拦（不可绕）+ 伪造 `gh api` 打 status **无法**绕过（status 来源是 runner 非本地）
- [ ] AC-B4: main-green invariant 纪律确立——main 红即 P0（修绿前暂停其他 merge）；语义冲突兜底验证（PR-A merge 后 PR-B 若 logical conflict，下一次 gate rebase 能 catch）

### Phase C（检查覆盖）✅（PR #2057）
- [x] AC-C1: tsc --noEmit CI job（Typecheck）补入 ci.yml（PR #2057）；"设 required" 待 Phase B Rulesets
- [ ] AC-C2: 审计 sync-only 检查未接 cat-cafe gate（独立项未做；F214 已接 root-debris 作模式）

### Phase D（元守护）✅（PR #2057）
- [x] AC-D1: check:gate-ci-parity 脚本（CI ⊆ gate assert + 自举，声明式契约）
- [x] AC-D2: 守护脚本进 PARALLEL_CHECKS（19→20）；"CI required" 待 Phase B Rulesets

## Dependencies
- **Related**: F073（sop-auto-guardian）/ F083（design-gate-sop）/ F177（hotfix 治理）/ F192（eval contract 门禁，本 feat 受其约束 — OQ-3）

## Risk

| 风险 | 缓解 |
|------|------|
| gate 强制太严卡开发体验 | Rulesets require 现有 4 job（已 ~5min），不加 Merge Queue latency |
| **admin bypass DISABLED → runner 离线 / GitHub 故障时所有人卡死** | **Escape hatch SOP（KD-5）**：确认 runner 离线或 githubstatus 平台故障 → operator临时改 Ruleset（GitHub audit log 原生记录）+ merge 带本地 gate 绿证据 + 30min 内恢复。**不留代码后门**（后门=新 A 类洞）|
| **攻击面 B：self-hosted runner 可用性 << GitHub 托管**（机器关机/重启/runtime 崩 → runner 离线 → required check 永远 pending → 全猫卡）| ① runner 配 auto-start（launchd/systemd 开机自启 + 崩溃自重启）；② 机器关机时段（operator睡觉）本就无 merge（猫也不活跃），不构成 friction；③ runner 状态可观测，区分"离线 pending"（走 escape hatch）vs"代码红 failure"（修代码）；④ 高频触发 escape hatch = 信号，说明 runner 稳定性需加固 |
| **攻击面 A：并发语义冲突让 main 红**（机制挡不住，见 KD-7）| 软 invariant + P0 修绿兜底；低并发实测如频繁，再评估 require-up-to-date 或 Merge Queue（当前不引入，friction > 收益）|
| 元守护本身漂移 | check:gate-ci-parity 自举（守护自己也在 gate）|

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 立 feat（非 issue）| A 类设计选型需 Design Gate；系统性 + 多 Phase + 元守护新机制（operator signoff）| 2026-05-30 |
| KD-2 *(被 KD-9 取代)* | Gate 强制 = **Self-hosted runner + GitHub Rulesets**（非 Branch Protection），**admin bypass 关闭** | ① 私有仓 CI 额度 ~5 天/月，GitHub-hosted required check 不可行 → self-hosted runner 跑 CI（不耗额度 + status GitHub 服务端记录、不可伪造）；② Branch Protection 的 admin 可 bypass（`--admin` 穿墙），Rulesets 可配 admin 也不可绕；③ cat-cafe 12 猫不缺 review，无 clowder-ai 单 maintainer 约束 | 2026-05-30 立、2026-05-31 改（CI 额度 → self-hosted runner，opus-48 ⊗ antig-opus 三轮对锤）|
| KD-3 *(被 KD-9 取代)* | Required jobs = ci.yml 现有 4（Lint/Build/Test/Dir-size），Phase C 补 tsc；**self-hosted runner 跑同一份 ci.yml** | 现有 4 job 已覆盖 6 类问题大部分；不让完美成为好的敌人，先立基本墙；runner 上的 build/test/lint == 猫本地 `pnpm gate` 同一份活，无额外维护 | 2026-05-30 |
| KD-4 | paths-ignore → skip-if-no-change | docs-only PR 不触发 CI 时 required check 永不绿会卡死 | 2026-05-30 |
| KD-5 | Escape hatch = SOP（operator临时改 Ruleset + 本地 gate 证据 + 30min 恢复），**不留代码后门** | 代码后门会演化成默认（clowder-ai `--admin` 教训）；GitHub audit log 原生记录改 Ruleset | 2026-05-30 |
| KD-6 | 元守护 = check:gate-ci-parity 自举脚本（CI ⊆ gate）| 比人肉对照可靠；终态产物非脚手架；自身在 PARALLEL_CHECKS 自举 | 2026-05-30 |
| KD-7 | **main-green invariant**（公理，治 A2 归因根因）：main 不准带红进，谁让 main 红谁**同 PR 修绿**（系统提示词那种"半成品先合让 main 红、回头再修"被禁止）；main 意外红 = P0，修绿前暂停其他 merge | main 永绿 → `gate 红 == 你引入了新红`，"已知红遮新红 + 误豁免"从根消失。比 baseline-diff（缓存 main red set 区分老红新红）干净——后者是「第一性原理」警告的"堆复杂度代偿无知"，main 持续移动使缓存必失效。**精确边界**：invariant ≠ "self-hosted runner 机制保证 main 永绿"——required check 只挡**单 PR 自身**的红；**并发语义冲突**（PR-A/B 各自绿、文本可合、merge 后 logical conflict 红）机制挡不住，靠"main 红 P0 修绿 + 下个 PR rebase 后 gate catch"纪律兜底（**软 invariant**，非机制铁保证）。低并发下不配 require-up-to-date（friction > 收益）| 2026-05-31（opus-48 ⊗ antig-opus 二轮对锤 + opus-48 攻击面 A 精确化）|
| KD-8 | **方案 C（本地 gate → `gh api` 打 commit status）砍掉，不留 fallback** | status 猫本地打 = 一行 `gh api` 可伪造 = 塑料锁；两条强制路径必有一条沦为默认逃逸口（clowder-ai `--admin` 教训）。runner 挂了走 escape hatch SOP（KD-5），不靠方案 C 当中间层。Self-hosted runner 是唯一强制力路径 | 2026-05-31（opus-48 攻击面：方案 C 可伪造 → antig-opus 接受砍掉）|
| **KD-9** ⭐ | **最终决策（取代 KD-2/KD-3）：私有仓砍 self-hosted CI，强制力 = `main-green 纪律 + 本地 gate/hook + 跨猫 review 家规`；开源仓才用 GitHub-hosted CI** | operator cost-benefit 一刀：猫违规 **< 1%**（全自己猫，本地都跑 `pnpm gate`），self-hosted CI 防这 < 1% 的代价（每 PR 慢 ~19min + 烤 M4 Max 12 P-core 满载发热 + 重复跑本地已过的 gate）**不值**；且 self-hosted CI required **根本没治 A2**（main 红→卡全 PR→误豁免→回老路），治 A2 的是 main-green 纪律，与 CI 无关。"不是一只猫说了算"靠家规文化（review 必须跨个体），不靠服务端 Rulesets（见 KD-10）| 2026-06-02（operator拍板砍 self-hosted）|
| **KD-10** ⭐ | **不配 Rulesets require reviews**（推翻 KD-9 初版"配 require reviews"）：私有仓强制力止于 `main-green + 本地 gate + 跨猫 review 家规` | 三猫（opus-48 ⊗ antig-opus ⊗ Maine Coon GPT-5.5）收敛：Rulesets `Require a pull request before merging` 拦直接 push main → 撞 shared-state 家规死锁（`ROADMAP.md`/`cat-config.json` 只能 main 直接 push、shared-state-guard 又拦 PR 改它们 → 既不能 PR 也不能 push）+ 破坏 docs 零延迟。bypass 不干净（`always` bypass 绕 review = 掏空强制力；`pull_request` bypass 救不了 direct push）。为 < 1% self-merge 破坏每天用的工作流，不符合砍 self-hosted CI 的同 cost-benefit 尺子。**价值 OQ**：未来若"服务端强制 review" > "main 直接共享状态" = 新 operator 取舍（要改 shared-state 工作流），非 F217 尾巴 | 2026-06-02（Maine Coon Decision Packet，"想不清楚喊Maine Coon"触发）|

## Rejected Alternatives

| 方案 | 拒绝理由 |
|------|---------|
| **GitHub-hosted CI required check** | 私有仓额度 ~5 天/月（operator实测）→ require 后 25 天/月全猫 merge 不了。**方案不可行**，改 self-hosted runner（不耗额度）|
| **方案 C：本地 gate → `gh api` 打 commit status** | status 猫本地打 = 一行 `gh api` 可伪造 = 塑料锁（KD-8）；提高门槛 ≠ 不可绕。self-hosted runner 的 status 是服务端记录、不可伪造 |
| **Layer 0：baseline-diff（缓存 main gate red set，区分老红/新红）** | 「第一性原理」反模式——堆复杂度代偿"不知道 main 何时红"。main 持续移动（多猫并行 push）使缓存即刻过期；全局 check（biome/build/跨包 test）无法只跑 PR 子集。**正解是消灭无知：main-green invariant（KD-7）让 gate 红 == 新红，diff 复杂度归零** |
| GitHub Merge Queue | merge 前用最新 main 重跑 CI、序列化解决并发语义冲突（攻击面 A），但加 10-20min latency + 低并发不需序列化。当前用 main-green 软 invariant + P0 修绿兜底；若实测语义冲突频繁再评估引入 |
| Branch Protection Rules | admin 可 bypass（`--admin` 穿墙）；用 Rulesets 替代 |

## Review Gate
- Phase A: ✅ @antig-opus 深度实证 + 三轮对锤收敛
- Phase C+D: ✅ PR #2057 merged（@antig-opus 跨族 review APPROVE 无 P1 + 云端豁免 + gate 三件套全绿）
- Phase B（gate 强制力）: ❌ **整体作废**（KD-9 砍 self-hosted CI + KD-10 不配 Rulesets）。private 仓不需要任何服务端 gate 强制——runner 已卸载、core `ci.yml` 已删、Rulesets 不配（撞 shared-state 死锁）。**注意**：Actions 仍为 enabled，两个 PR-specific guard workflow（`pr-followup-guard` / `shared-state-guard`）仍会产生 check-run 信号；它们不是 F217 core CI，也不作为服务端 gate 强制。**无 @co-creator 待办**，治理止于 main-green + 本地 gate + 跨猫 review 家规

## Appendix: CI vs Gate 差集表（AC-A1，@antig-opus 实证）

> self-hosted runner 跑同一份 ci.yml，下表差集分析不变（runner 只换执行环境，不换检查内容）。

| CI job | 对应 gate 步骤 | 差集 |
|---|---|---|
| Lint (`pnpm check`) | Step 4 `pnpm check` | ✅ 对齐（含 18 checks）|
| Build | Step 3 `pnpm -r build` | ⚠️ CI 只 build shared+api+web，gate 全包 |
| Test (Public) | Step 5 `test:public` | ✅ 对齐 |
| Dir-size | Step 4 `check:dir-size` | ✅ 对齐（pnpm check 子集）|
| ❌ 无 | Step 2 `install --frozen-lockfile` | CI install 但不 assert lockfile drift |
| ❌ 无 | Step 3 `tsc --noEmit` | **Gate 有 CI 没有 — 类型错误漏网（Phase C 补）** |
| ❌ 无 | Step 1 rebase origin/main | CI 对 PR 已基于 main diff，语义等价 |
