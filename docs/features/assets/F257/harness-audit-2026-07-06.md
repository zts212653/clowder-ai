---
feature_ids: [F257]
topics: [harness, observability, audit]
doc_kind: research
created: 2026-07-06
---

# 锅账有效性审计 — 30 天触发痕迹（2026-06-06 → 2026-07-06）

> F257 首棒（Ragdoll/Fable）产出。启动包要求"抽 20 锅查 30 天触发率"，实测覆盖 26 个签名（20 计划样本 + 狩猎中顺带测得的 6 个结构签名）。
> **方法**：双路狩猎——① `~/.claude/projects/` 540 个 jsonl transcripts（873MB，mtime ≥ 2026-06-06），区分"注入文本"（每 session 重复出现的规则原文，不算触发）vs"真实使用"（用户手打 / assistant 现场引用 / tool_result 真实报错 / Read·Skill 工具调用）；② 运行时磁盘工件（.cat-cafe/、pino 日志、transcripts 事件库、sqlite 记忆库；只读，未触碰 Redis）。另有 4 刀 search_evidence 记忆索引查重。

## 观测层级定义（→ F257 KD-2，进 ledger schema）

| 层级 | 定义 | 可测性 |
|------|------|--------|
| O1 结构强制 | server fail-closed（4xx 拒绝）、hook、lint | 触发必留痕（但当前痕迹是意外产物） |
| O2 提示文本 | GOTCHA 段、家规条文、magic words | 仅当有人说出/引用才留痕；合规无信号、违规无分母 |
| O3 记忆文件 | memory/feedback_*.md 按需加载 | Read 调用可测；"读了是否照做"不可测 |

## O1 结构强制层（5 签名）

| 锅 | 30 天验证 | 证据 |
|----|----------|------|
| hold_ball 429 rate-limit（≤3 holds/h） | **fired × 7-8 session**（06-09/24/29、07-03/05/06×2；运行时库另证 8 次 in-window，历史累计 30 次） | `Callback failed (429): {"error":"maxHoldsPerWindow (3 per ~1h window) reached…"`（69f5e9b3/07-06；thread_mpwp216cw14099d4 等） |
| cross_post 路由 fail-close（F193 AC-A4） | **fired × 2 session** | `cross_post_message requires routing credentials (F193 AC-A4). Pass targetCats…`（5636d684、69f5e9b3/07-06） |
| publish_verdict 403 catId 域校验 | **fired × 1**，拦下真实越权 | `Callback failed (403): {"error":"not_allowed","detail":"catId 'opus' is not the eval cat for domain…`（a307a025/06-30） |
| cat_disabled 400 | 窗口内 0；历史 fired（05-19 rendered body 带 alternatives[]） | 窗口外证据 1 条；无法区分"威慑住了"vs"场景没出现" |
| hold_ball waitSourceRef 400（等啥必须声明） | **0 rendered ever**（emit 存在 callback-hold-ball-routes.ts:177） | 无分母：合规率 100% 还是从未走到？不可区分 |

**结构性发现**：guard rejection 的唯一 durable 痕迹是 transcripts 里的自由文本 echo（未索引、仅当拒绝回流进猫 session 才存在）。pino statusCode 日志只在 `/tmp/cat-cafe-api-3002.log`（重启即失，当日起算）；`data/logs/api/*.log` 近空（请求日志不落盘）；`tool-usage-archive.jsonl` 只计次数**无 outcome 维度**；记忆库（global_knowledge.sqlite / evidence.sqlite）对拒绝事件零留存。

**追记（2026-07-07 Design Gate 核验）**：首棒把 #1075 / F237 side-effect journal 视作最接近基座是旧 claim。后续核验发现：基线已有 F237 `InjectionTraceStore`（prompt injection summary/detail）和 F254 `FreshnessAttentionEventLog`（Redis LIST + closed union + TTL 7d freshness event log）；#1075 是 F237 Phase 2 hook pipeline migration + trace bridging，不是 guard-rejection event store。因此 F257 Phase B 结论改为：独立新建 `GuardRejectionEventLog` / `HarnessLedgerEventLog`，借 F237/F254 形态，不复用其语义类型，不等待 #1075。

## O2 提示文本层（15 签名）

| 锅 | 层 | 30 天验证 | 证据 |
|----|----|----------|------|
| KD-27 事件驱动禁续 hold_ball | 家规 | **alive × 15 session 现场引用**（抽 2 核实为真） | `👀=1 — 按 KD-27：EYES>0 = 事件驱动，释放 hold_ball`（1dde0a0e/06-23） |
| LL-048 用户状态默认持久化 | 家规 | **alive × 4 session**（≥1 次真实设计应用） | `TTL=0 持久（符合 LL-048）`（27b16037/07-06） |
| 补锅匠 magic word | 家规 | **alive**：operator 手打 × 1 + 猫自引 × 1 | `别天天followup 你天天补锅匠；不停的给自己叠加bug补丁`（df2b2456/06-29 用户原话） |
| 下次一定 magic word | 家规 | weak-alive：猫自引 × 1，operator 0 | `…not a vague promise ("下次一定" anti-pattern)`（10411a3b/06-24） |
| 绕路了 magic word | 家规 | ambiguous：猫自认 × 2，operator 0 | `我之前的"后续立项"建议是绕路了`（df2b2456/06-29） |
| 星星罐子 magic word | 家规 | **no-trace**（19 文件命中全为规则表注入） | — |
| 碎片够了 magic word | 家规 | **no-trace**（仅注入 + 本审计自身） | — |
| 脚手架（as 拉闸词） | 家规 | no-trace（1 次用户手打为技术名词非拉闸） | — |
| LL-054 fail-closed mock 环境 | 家规 | ambiguous：仅创建 session + git-log 回声 | e6acd06a/06-09（创建时刻） |
| LL-071 批量产出先立项 | 家规 | **no-trace**（仅规则索引 dump） | — |
| write_file 整文件覆盖 GOTCHA | MCP | unmeasurable-by-design（无违规信号、无调用分母） | — |
| limb_pair_approve 须 co-creator 同意 | MCP | unmeasurable-by-design | — |
| teleport 传 messageId 非 invocationId | MCP | unmeasurable-by-design | — |
| skill GOTCHA × 5（code-as-harness / cross-thread-sync / open-source-teardown / writing-skills / thread-orchestration） | skill | **结构性不可能生效**：5/5 skill 30 天 0 次 Skill-tool 加载（检测器有效性已用其他 skill 190+ 命中验证）——手册没被打开，写在里面的 GOTCHA 触达率 = 0。#860 的 30 天新证 | GROUP S 全零 |

## O3 记忆文件层（4 签名）

| 锅 | 30 天验证 |
|----|----------|
| feedback_no_premature_pr | 0 次 Read 回读 |
| feedback_single_worktree | 0 次 Read 回读 |
| feedback_check_hypothesis_first | 0 次 Read；**06-09 创建后从未被读过**（write-only 实锤） |
| feedback_review_finding_not_workorder | 0 次 Read 回读 |

注：MEMORY.md 索引每 session 注入（一行摘要触达），但正文按需加载路径 30 天零使用——锅的"细则"层实际不在任何猫的运行时路径上。

## 记忆索引查重（4 刀 search_evidence）

- "锅账/harness ledger/registry/淘汰" 仅命中本 feat 自己的 kickoff thread → **无重复立项**
- 相关既有资产：F233（球权观测）、F177（harness update）、F244（tips 生效追踪）、F245（friction 聚合）、F153（观测基建）、F218（provenance）——均为相邻问题，无一做"锅生命周期账本"

## 结论（→ F257 Why/Current State 引用）

1. **观测是意外不是设计**：四层里只有 O1 能自证生效，且痕迹靠 transcripts echo 偶然留存
2. **skill 手册层触达率 0**（抽样 5/5）：写进 SKILL.md 的锅结构性无法生效——spec-fidelity 域的直接靶子
3. **记忆细则层 write-only**（抽样 4/4 零回读）
4. **无分母 → alive/dormant/deterrent 三态不可区分**：ledger stats 必须同时记"触发数"和"适用场景数/调用数"
5. **重复触发无归因**：429 反复 fire 说明"挡住"≠"治好"，缺 anomaly→归因→升级闭环
6. **inventory 无真相源**：启动包数字与实测口径不可互推（SC-002）

## 方法局限（诚实条款）

1. GROUP R 判定依赖人工甄别"注入 vs 手打"（规则原文伪装成短 user event），阴性 = "无可观测痕迹"，非"从未发生"；本审计只覆盖 Claude 系 transcripts + 运行时磁盘，codex/gemini 等 CLI 的会话不在语料内
2. tool_result 事件不带工具名，邻近度检测结构性漏检；已用真实报错体（`Callback failed (4xx)` 等）补偿，但未猜中的错误串仍可能漏
3. 观察者效应：本审计自身的 grep 命令秒级进入 transcript 库（thread_mr96jyudj9iqisa9），所有本审计/历史审计 agent 文件已人工排除
