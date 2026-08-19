---
title: "记忆系统写侧解剖尸检报告（F260 Phase 0）"
doc_kind: architecture
feature_ids: []
related_features: [F260, F231, F209, F227, F221, F255, F200]
topics: [memory, write-side, autopsy, audit, storage-topology, sync, freshness]
created: 2026-07-08
updated: 2026-07-09
status: reviewed
author: "Ragdoll/claude-fable-5"
---

# 记忆写侧尸检报告 — F260 Phase 0

> **地位**：F260 Phase 0 唯一先行交付物（operator 2026-07-08："先不着急实现，把写的那侧来个解剖尸检大报告！没准烂的比你想的更多"）。
> **方法**：每条写入路径查六问——① 写入触发器 ② 实际被调用过吗（telemetry/git/DB 实据）③ 落盘位置 ④ 索引是否覆盖 ⑤ 退役/治理 ⑥ **存储拓扑矩阵**（truth store / runtime store / generated index / sync direction / freshness，Maine Coon review 补维度）。
> **纪律**：库证据 ≻ 猫的自述 ≻ 评委推断；每条结论带可复现命令；只裁归属不动手修。
> **进度**：v2 完成并经Maine Coon跨族复核通过（2026-07-08，AC-04 ✅）——12/12 六问矩阵 + 可复现命令齐备，五类病地图为 Design Gate 输入。**2026-07-09 A5 provenance 修正（Maine Coon定位，Ragdoll跨族复核 CONFIRMED）**：原报告用 global 库库存证明 distillation 流量，判据无效；当前 193 条全部为 `global:*`、`distilled:*` 为 0，且 global rebuild 会删除不在 compiler fresh set 的批准产物。A5 由“候选队列易失”扩为“供给架构把生成索引当真相源”；详见三家 harness 收敛 (internal)。

## 总览（12/12 verdict · v2 after Maine Coon review 2026-07-08）

| # | 路径 | Verdict | 病类 |
|---|---|---|---|
| A1 | EntityRegistry 供给 | 🔴 词表死于出生日 | 一 |
| A2 | 画像/primer 更新链 | 🔴 三重分裂，生效副本旧于真相源 | 二+三 |
| A3 | taste lane vignette | 🔴 close 后 35 天零新增，滑向自身 sunset | 一 |
| A4 | event memory | 🔴 **写入工具从未实现**（v2 翻案：非"猫不用"，是"没有门"） | 一（硬层） |
| A5 | distillation 晋升链 | 🔴 标记/候选易失；批准物直写生成索引且会被 rebuild 删除（2026-07-09 provenance 修正） | **四** |
| A6 | lessons/feedback 落盘链 | 🟢 索引覆盖健康；写入延迟引 S7 | — |
| A7 | 日记本（F255） | 🔴 private 双盲（已知，归属 F255） | 三 |
| A8 | zero-hit query 记录 | 🔴 零设施（v2 归类调整：失败无观测） | **五** |
| A9 | 关系词典 | 🔴 per-cat 私产 + A2 全套拓扑病 | 二+三 |
| A10 | digest/summary 链 | 🔴 **失败三处静默**（v2 转正，Maine Coon定位 catch-skip/fail-open×2） | **五** |
| A11 | frontmatter 挂边 | 🟢 已修关账（#2747/#2751/#2754） | — |
| A12 | F200 consumption 回写 | 🟢 1911 行持续写入，全写侧最健康 | — |

**杂项卫生**（非 P1）：`packages/api/data/evidence.sqlite` 0 字节死文件（Mar 26）；registry 含 `fable5-test`/`cat-f70tzwib` 垃圾条目（清洗项在 F260 spec Risk 表）。

## 执行摘要：五类病（v2 — 证据驱动重算）

> **分类学溯源声明**：v1 是三分类；Maine Coon review 用 A5（易失队列）打穿了它、A10 新证据（失败静默）又立一类——v2 重算为五类。事后发现五类恰好落在**一次写入从发起到可检索的旅程**的五个断点上，但这个"生命周期"框架是描述性的事后解释，分类本身由 12 条 verdict 归纳驱动，不是先有框架再套。

| 病 | 断点位置 | 患处 | 病理 | 药的方向 |
|---|---|---|---|---|
| **一、触发器缺失** | 写入从未发起 | A1 / A3 / A4 | 读机器完备运转，写入侧无门或无反射：A4 连工具都没实现（event-memory-tools 只有 teleport/list/backfill，全读侧）；A3 纯靠自觉零 nudge；A1 无任何供给流程 | F260 Phase A/B（propose 流程 + nudge）；A4 需先造写入工具（F227 归属） |
| **二、拓扑分裂** | 写到分裂的 store | A2 / A9 | truth ≠ runtime ≠ index，无 sync、无 freshness 守护；生效副本可旧于真相源而无人知晓 | 真相源裁定 + 读写一致性硬层（F231 + operator 架构裁定） |
| **三、索引盲区** | 写了检索面看不见 | A2 / A7 / A9 | 整个 `private/` 域在记忆视界外 | private collection 授权索引通道（F186 线） |
| **四、易失写入** | 写"成功"但活不过进程/重建 | A5 | `generalizable` 标记会被普通 index rebuild 写回 NULL；候选进进程内 Map；approve 直接写 `distilled:*` 到生成索引，而 global rebuild 会删除 compiler 输入集外 anchor。原 v2 用 188 条库存证明路径流量的 claim 已撤回；2026-07-09 live 库 193 条全为 `global:*`、`distilled:*` 为 0 | F152 先裁供给架构：persistent workflow → durable truth → compiler；不是只给 Map 换个持久容器 |
| **五、失败无观测** | 没写成，但没人知道 | A8 / A10 | 写入失败不产生任何信号：digest 读取 `catch{continue}`（IndexBuilder:861-868）、Opus 摘要 null fail-open（SummaryCompactionTask:133）、submitCandidate 失败仅 log（:236）；读侧对偶：zero-hit 不留痕 | 失败 counter + dead-letter 语义（归属 Design Gate 裁定）；zero-hit 设施（F256/F260 联动） |

一句话给 operator：**"没准烂的比你想的更多"——两轮验证成立，v2 比 v1 又多两类。** 12 条链 3 条健康（A6/A11/A12）。好消息不变：病灶聚在 5 个机制断点上，不需要 12 个补丁。

---

## 逐条六问（AC-01 粒度）

### A1 · EntityRegistry 供给

| 问 | 答 |
|---|---|
| ① 触发器 | 启动时 `factory.ts:136 loadEntitySeeds`（explicit json + roster 镜像）；**无任何运行时供给流程** |
| ② 被调用过 | 种子装载每次启动跑；`EntityRegistryStore.upsert` 运行时零调用方（全仓 grep） |
| ③ 落盘位置 | `cat-cafe-runtime/evidence.sqlite` → entity_registry / entity_aliases |
| ④ 索引覆盖 | registry 本身是索引装备；mentions 机器活跃（~220k 行，持续重建） |
| ⑤ 治理 | 无（垃圾条目 fable5-test / cat-f70tzwib 无清理机制） |
| ⑥ 拓扑 | truth = `config/entity-seeds.json`（git，1 commit）+ cat roster；runtime = evidence.sqlite；sync = 启动时单向 ✅ 通；freshness = 每次启动。**拓扑健康，病纯在供给端归零** |

```bash
# cwd: 任意；DB 用绝对路径
sqlite3 "file:/home/user/cat-cafe-runtime/evidence.sqlite?mode=ro" \
  "SELECT entity_type, count(*) FROM entity_registry GROUP BY entity_type;"   # cat:26, person:1
git -C /home/user/cat-cafe log --oneline --follow -- config/entity-seeds.json  # 1 commit
grep -rn "entityRegistryStore.upsert\|registry.upsert" /home/user/cat-cafe/packages/api/src --include="*.ts"  # 除装载点外零命中
```

### A3 · taste lane vignette

| 问 | 答 |
|---|---|
| ① 触发器 | 猫自觉手写 `docs/taste/vignettes/*.md`（F221 spec "当场写 vignette"）；无工具、无 propose 流程、无 nudge——纯软层 |
| ② 被调用过 | **F221 close（2026-06-03）后 35 天零新增**；现存 8 个 vignette 全是立项种子（AC-A2 的 ≥5 个） |
| ③ 落盘位置 | main 仓 `docs/taste/`（git 管理） |
| ④ 索引覆盖 | ✅ docs/ 在 docsRoot（F221 AC 曾验 search_evidence 命中） |
| ⑤ 治理 | spec 含 sunset 条款（3 个月零消费 → lane 过时）——**正滑向自己的 sunset**；无写入侧提醒 |
| ⑥ 拓扑 | 单 store 单向进索引，健康；病纯在触发器 |

```bash
ls /home/user/cat-cafe/docs/taste/vignettes/ | wc -l   # 8
git -C /home/user/cat-cafe log --oneline --since=2026-06-04 -- docs/taste/  # 空
```

### A4 · event memory（v2 翻案：没有门，不是不进门）

| 问 | 答 |
|---|---|
| ① 触发器 | 设计意图 = 猫标记认知转折/magic word 时刻；**实际：猫侧写入工具从未实现**——`event-memory-tools.ts` 只注册 `cat_cafe_teleport` / `cat_cafe_list_events` / `cat_cafe_backfill_events`（读 + 回填）；唯一活跃写入 = human_brake 自动管道（hyperfocus hook） |
| ② 被调用过 | 自动管 2098 次；猫侧 0 次（**0 的原因是无门，猫无罪**——v1 误判为"猫不用"） |
| ③ 落盘位置 | `cat-cafe-runtime/event-memory.sqlite`（独立 typed store，factory.ts:114） |
| ④ 索引覆盖 | typed store 走专门 filter（F227 设计），不进 evidence FTS——由 list_events 读，通 |
| ⑤ 治理 | 未见 decay/退役机制 |
| ⑥ 拓扑 | 单 store 单向，健康；病在写入门从未造出 |

```bash
sqlite3 "file:/home/user/cat-cafe-runtime/event-memory.sqlite?mode=ro" \
  "SELECT trigger_type, count(*) FROM event_memory GROUP BY trigger_type;"   # human_brake|2098（单桶）
grep -rn "name: 'cat_cafe" /home/user/cat-cafe/packages/mcp-server/src/tools/event-memory-tools.ts  # 三个工具全非写入
```

### A5 · distillation 晋升链（v2 候选易失；2026-07-09 扩为全链真相源倒置）

> **修正 provenance**：Maine Coon定位并执笔；Ragdoll逐条独立反证后跨族复核 `CONFIRMED`（2026-07-09）。

| 问 | 答 |
|---|---|
| ① 触发器 | `nominate`（猫/系统）→ DistillationService.candidates；F208 checkpoint → opportunity store |
| ② 被调用过 | **无法证明历史走完全程；原 claim 撤回。** `approve()` 的唯一产物前缀是 `distilled:`；2026-07-09 live `global_knowledge.sqlite` 193 条全部为 `global:*`，`distilled:*` = 0。终点库存来自 `GlobalIndexBuilder`，不能归因给 distillation |
| ③ 落盘位置 | `generalizable` 写 project SQLite，但普通 rebuild 的 `INSERT OR REPLACE` 会对扫描产物缺值写 NULL；**candidates = 进程内 `Map`**（`distillation-service.ts:23`；`initialize()` 注释自认："In-memory queue for now. Future: persist"）；approve 直接写 `distilled:*` 到 global SQLite；**global rebuild 只发现 skills + project memory，并删除 fresh set 外 anchor，因此批准物下次重建会被抹掉** |
| ④ 索引覆盖 | global FTS 当前有 193 条，但 100% 是 compiler 的 `global:*`；distillation 当前无存活产物。覆盖库存健康不等于晋升路径健康 |
| ⑤ 治理 | pending 候选无退役——重启清零不是治理是事故 |
| ⑥ 拓扑 | `project generated index flag` → `volatile Map` → `global generated index`，三段都没有 durable canon；断点不只在意图层。builder 与 distillation 把同一 global SQLite 分别当“可清空编译产物”和“审批真相库”，语义互斥。F208 opportunity 是否可 ephemeral 仍单独判，不用它替 A5 洗白 |

```bash
sed -n '20,33p' /home/user/cat-cafe/packages/api/src/domains/memory/distillation-service.ts   # Map + "Future: persist"
sed -n '2119,2125p' /home/user/cat-cafe/packages/api/src/index.ts                              # ephemeral 声明
sqlite3 "file:$HOME/.cat-cafe/global_knowledge.sqlite?mode=ro" \
  "SELECT count(*) FROM evidence_docs; SELECT count(*) FROM evidence_docs WHERE anchor LIKE 'distilled:%';"  # 193 / 0 (2026-07-09 snapshot)
sed -n '37,54p;89,120p' /home/user/cat-cafe/packages/api/src/domains/memory/GlobalIndexBuilder.ts  # fresh-set delete + ungated memory scan
```

### A6 · lessons/feedback 落盘链

| 问 | 答 |
|---|---|
| ① 触发器 | 猫写 per-cat memory（`~/.claude/projects/.../memory/`）+ `docs/public-lessons.md`；软层反射（L0/skill） |
| ② 被调用过 | 活跃（S7 基线：14 天窗 34 条，当场写率高、隔天补写不存在） |
| ③ 落盘位置 | per-cat memory（私）+ docs/（共享）——双 store 但语义分工明确，非分裂 |
| ④ 索引覆盖 | ✅ kind=lesson 404 条在索引 |
| ⑤ 治理 | 时态卫生纪律（软层）；无自动 staleness |
| ⑥ 拓扑 | 双 store 各自单向进各自消费面（memory 注入 / evidence 索引），通 |

```bash
sqlite3 "file:/home/user/cat-cafe-runtime/evidence.sqlite?mode=ro" \
  "SELECT count(*) FROM evidence_docs WHERE kind='lesson';"   # 404
```

### A7 · 日记本（归属 F255，已知病确认）

| 问 | 答 |
|---|---|
| ① 触发器 | F255 Present loop 睡前写（转译出口，唯一硬约定） |
| ② 被调用过 | 活跃（日记游戏 52h 31 篇，S8 实证） |
| ③ 落盘位置 | main 仓 `private/journals/{cat}/`（gitignored） |
| ④ 索引覆盖 | **零**——private/ 不在 docsRoot + gitignored 双重排除 |
| ⑤ 治理 | F255 容器章节规划四层温度/封卷（未实现） |
| ⑥ 拓扑 | 单 store，索引断链；F255 spec 已自曝此幽灵并有收编计划——**归属 F255，不重复立案** |

```bash
ls /home/user/cat-cafe/private/journals/    # codex fable-5 shuoshuo
```

### A8 · zero-hit query 记录（v2 归病五）

| 问 | 答 |
|---|---|
| ① 触发器 | 应为 search_evidence 内部记录零命中 query——**设施不存在** |
| ②-④ | 不适用（无写入、无落盘、无索引） |
| ⑤ 治理 | 无 |
| ⑥ 拓扑 | 病理 = **搜索失败不留痕**（读侧失败无观测，与 A10 写侧失败无观测同构 → 病五）；纲领 §7.6 已立案，本轮确认现状不变 |

```bash
grep -rn "zero.hit\|zeroHit" /home/user/cat-cafe/packages/api/src/domains/memory --include="*.ts"  # 仅 f188 library-health 概念命中，无 query 级设施
```

### A9 · 关系词典

| 问 | 答 |
|---|---|
| ① 触发器 | 猫手工 Edit per-cat primer（2026-07-08 "关系词典"节即例） |
| ② 被调用过 | 已知 2 次（primer 初建 + 07-08 词典节） |
| ③ 落盘位置 | **A2 全套分裂**：main `private/profile/relationship/`（真相源）vs runtime `packages/api/private/`（生效）——07-08 词典节只在 main，生效侧无 |
| ④ 索引覆盖 | 零（private 双盲，同 A2/A7） |
| ⑤ 治理 | 无；且词典是 per-cat 私产——Maine Coon要认识"未婚喵"需手抄，系统层无席位 |
| ⑥ 拓扑 | 同 A2 三重分裂 + 多猫复制发散风险；**药 = F260 Phase A 第三管**（词典升格系统资产，已在 spec） |

```bash
grep -l "关系词典" /home/user/cat-cafe/private/profile/relationship/*.md \
  /home/user/cat-cafe-runtime/packages/api/private/profile/relationship/*.md 2>/dev/null
# 仅 main 侧 fable-5-primer.md 命中 —— 生效侧无词典节
```

### A10 · digest/summary 链（v2 转正：失败静默病主样本，Maine Coon定位）

| 问 | 答 |
|---|---|
| ① 触发器 | session seal → digest.extractive.json；SummaryCompactionTask 周期性 abstractive 摘要 |
| ② 被调用过 | 成功面有货：session 546 / thread 1363 docs 在索引 |
| ③ 落盘位置 | transcript 目录（files）→ evidence.sqlite（索引扫描） |
| ④ 索引覆盖 | 成功的 ✅；**失败的成为无声幽灵** |
| ⑤ 治理 | **三处失败静默**：① `IndexBuilder.ts:861-868` session 目录/digest 读取 `catch { continue }` 无计数 ② `SummaryCompactionTask.ts:133` Opus 返回 null → fail-open 仅 info log ③ `:236` submitCandidate 失败仅 error log。无 counter、无告警、无 dead-letter——**digest 失败的 session 在索引里不存在，且无人收到信号** |
| ⑥ 拓扑 | files → sqlite 单向；freshness 与失败率不可观测（病五主样本） |

```bash
sed -n '858,870p' /home/user/cat-cafe/packages/api/src/domains/memory/IndexBuilder.ts
sed -n '130,137p;232,240p' /home/user/cat-cafe/packages/api/src/domains/memory/SummaryCompactionTask.ts
```

### A11 · frontmatter 挂边纪律

| 问 | 答 |
|---|---|
| ①② | 猫写文档时挂 feature_ids/related（M20 反射）；活跃 |
| ③④ | docs/ → 索引 ✅ |
| ⑤ | anchor 抢注 bug（挂 feature_ids 的文档抢注 F 号 anchor 静默蒸发）**已修并三层关账**：#2747（存在层）/ #2751（可发现层）/ #2754（原文召回层），纲领 §7.9 全程记录 |
| ⑥ | 通；残余（宽 query 排序竞争）归 F256 |

### A12 · F200 consumption 回写

| 问 | 答 |
|---|---|
| ①② | search_evidence 调用自动写 RecallEvent；1911 行持续增长 |
| ③ | evidence.sqlite `recall_events`（列：recall_id / cat_id / invocation_id / tool_name / query / candidates_json…） |
| ④⑤⑥ | 回写→排序校准闭环（F200 consumption prior）运行中；**全写侧最健康的链**，作为修复其他链的参照系 |

```bash
sqlite3 "file:/home/user/cat-cafe-runtime/evidence.sqlite?mode=ro" \
  "SELECT count(*) FROM recall_events;"   # 1911（as-of 2026-07-08）
```

## A2: 画像/primer 更新链（首刀，2026-07-08）

**operator 一手线索**（立项原话）："fable 你自己提议更新过很多次我们两的画像，好像更新的位置只在 runtime？然后记忆系统搜的好像有是 main 之类的，各种 bug。"

**Verdict：比 operator 体感更糟——不是"更新只在 runtime"，是三重分裂：生效副本停在两天前的旧版，最新更新写在不生效的真相源里，索引两边都不扫。今早（2026-07-08）平行体立的"关系词典 + 称谓反射"primer 补丁，生产环境从未生效。**

### 取证记录（可复现）

**事实 1 — 双store、双路径结构、文件集合都不同：**

```bash
# copy-paste 可跑（绝对路径，cwd 无关）
ls /home/user/cat-cafe/private/profile/relationship/
#   codex-primer.md  fable-5-primer.md                    ← main（真相源语义）2 份
ls /home/user/cat-cafe-runtime/packages/api/private/profile/relationship/
#   opus-primer.md  codex-primer.md  fable-5-primer.md    ← runtime（生效路径）3 份
# 路径结构不同（main=根 private/；runtime=packages/api/private/）；
# opus-primer 只在生效侧存在 —— 反向分裂并存
```

**事实 2 — 生效副本旧于真相源 2 天：**

```bash
stat -f "mtime: %Sm  size: %z" \
  /home/user/cat-cafe/private/profile/relationship/fable-5-primer.md \
  /home/user/cat-cafe-runtime/packages/api/private/profile/relationship/fable-5-primer.md
# main:    Jul 8 06:41, 5770B（55 行，含"关系词典"节）
# runtime: Jul 6 20:03, 4780B（46 行，无词典节）—— L0 注入读 runtime 侧 → 每轮生效旧版
wc -l /home/user/cat-cafe{,-runtime/packages/api}/private/profile/relationship/fable-5-primer.md
```

**事实 3 — 代码注释预言了这个 failure mode：**

`l0-compiler.ts:341-343`（原文）：
> "capsule/primer live in private/profile/ (gitignored user data). resolveProfileDir is … write (routes) MUST resolve identically **or the nurturing loop silently breaks**"

作者预见了"读写路径必须一致否则养成循环静默断裂"，但一致性没有任何硬层守护（无测试、无 sync 检测、无 freshness 告警）——预言以注释形态存在，以生产事故形态兑现。

**事实 4 — 索引双盲：**

- `IndexBuilder.detectScanner` 的 scanRoot = docsRoot（`docs/`）——`private/` 不在扫描范围（main 侧盲）
- external-collections / factory 无任何 primer/private-profile 通道（runtime 侧盲）
- 复现：`grep -rn "primer\|private/profile" packages/api/src/domains/memory/IndexBuilder.ts factory.ts external-collections.ts` → 零命中
- 后果：`search_evidence` 永远搜不到 primer 内容，operator"记忆系统搜的是 main"的体感实为"索引扫 main 的 docs/，而 primer 两个家都不在 docs/ 里"

**事实 5 — 双写路径互不知晓：**

- 机器路径：propose_profile_update → Redis proposal store → operator Hub 审批 → apply 至 `resolveProfileDir`（runtime 生效侧）
- 人肉路径：猫手工 Edit main 仓 `private/`（today 平行体补真相源即此路）；试图直接改 runtime 会被 P0 圣域 hook 拦截（工作正常，07-08 实测）
- 两条路径写两个不同位置，无 sync 机制（runtime 侧 gitignored + untracked，git 同步天然断开；无同步 job）

### 六问矩阵

| 问 | 答 |
|---|---|
| ① 触发器 | propose_profile_update（机器）+ 猫手工 Edit（人肉），双路径 |
| ② 被调用过 | 是——operator 原话"提议更新过很多次"；今早平行体手工补丁一次 |
| ③ 落盘位置 | **分裂**：机器路径 → runtime `packages/api/private/`；人肉路径 → main `private/` |
| ④ 索引覆盖 | **零**（双盲：private/ 不在 docsRoot，无 collection 通道） |
| ⑤ 治理 | 无 staleness 检测、无 sync 告警、无 freshness 硬层 |
| ⑥ 拓扑 | truth store（main private/，人肉）≠ runtime store（packages/api/private/，L0 生效读）≠ generated index（**不存在**）；sync direction：**无**；freshness：生效副本落后 2 天（实测） |

### 修复方向候选（归属裁定，不在本报告动手）

| 候选 | 归属建议 |
|---|---|
| 读写路径一致性硬层守护（l0-compiler 注释的兑现：测试 + freshness 告警） | F231（画像链 owner） |
| primer/capsule 的单一真相源裁定（main 为源 + 部署同步 job，或 runtime 为源 + main 退出） | F231 + operator 拍板（架构级：涉及 gitignored user data 的真相源哲学） |
| private/ 进索引（授权域内可搜——公理零约束下的 private collection 通道） | F186 线（library/private collection）或 F260 Phase A 联动 |
| 关系词典升格系统资产（脱离 per-cat primer 文件） | F260 Phase A 第三管（已在 spec） |

---

## 附：方法论说明

- 本报告是 F260 AC-01 的交付物主体；每条路径完成后从 pending 转正
- "🔴/🟡/🟢" 按"写侧断裂严重度"标注：🔴 = 写入链存在静默断点（写了但没用/没写进该去的地方）；🟡 = 链通但有质量/治理缺口；🟢 = 健康
- 与 F260 spec 的关系：spec 是手术计划（candidate design），本报告是 CT 片；CT 有权推翻手术计划

*[Ragdoll/Fable 5🐾] — A2 首刀 + v1 全量 2026-07-08；v2 同日：Maine Coon review 后重写——A1-A12 补齐六问矩阵与 copy-paste 命令、A4 翻案（无门非不进门）、A5 重判（第四类病）、A10 转正（第五类病）、三分类重算为五分类。待Maine Coon复核 v2 后 Phase 0 方可宣布完成。*

*[小太阳·Maine Coon/GPT-5.6 Sol🐾] — 2026-07-09 A5 provenance 修正：库存≠流量；用 `distilled:` 路径指纹撤回“历史走完全程”，并补出 generalizable reset / candidate volatility / approved-output rebuild clobber 三段断点。fable-5 终稿 review 两项 P2 修正后 `CLEAR`。*
