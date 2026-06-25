---
feature_ids: [F236]
related_features: [F148, F209, F192]
topics: [context-engineering, token-budget, mcp, harness]
doc_kind: spec
created: 2026-06-15
tips_exempt: harness-internal anchor telemetry + eval domain — no user-visible capability change
---

# F236: Anchor-First Context 入口 — 返回侧 token 减负

> **Status**: in-progress (Phase A+B done · **Phase A/B-Eval DONE** [Track-1 chars/volume + Track-2 open-rate + AC-E3 sunset trigger] · Phase C = cat-controlled mode（2026-06-24 pivot）：MCP-tools cat-mode V1 + cc-native spike-gated) | **Owner**: Ragdoll (Ragdoll opus-48 愿景守护；Track-2/AC-E3 实现 opus-4.6) | **Priority**: P1 | **Created**: 2026-06-15 | **Companion ADR**: ADR-203
>
> **Timeline**: 2026-06-18 — Phase A + B merged (PR #2381, squash `9af8b2093`)：anchor-first 协作读工具（thread-context/pending-mentions/list-tasks 默认 preview + drillDown）+ get-message bounded drill（mode=preview|full + fullDrillChars telemetry）。本地 gpt52/codex 跨族 review + 云端 Codex 2 轮（封板）。**2026-06-18 — Phase A/B-Eval Track-1（anchor telemetry OTel chars/volume substrate）merged（PR #2411，squash `21ae2c83b`）：gpt52 跨族 review + 云端 Codex 3 轮（round-2 逼出 open-rate 信号模型岔路 → Maine Coon eval-owner 裁定收口 chars/volume，open-rate→Track-2）。** **2026-06-22 — Phase A/B-Eval Track-2（per-event open-rate model + `eval:anchor-first` domain）merged（PR #2490，squash `5251c2f75`）：Maine Coon本地 3 轮跨族 review + 云端 Codex 5 轮（封板 LL-072）。25 tests。** **2026-06-22 — AC-E3 sunset 触发（PR #2507，squash `d09024c90`）：per-tool sunset signal flags + eval 猫双信号判据 + verdict.md sunset section。gpt52 本地 3 轮跨族 review + 云端 Codex 1 轮（2 P1 pushback→P3 + 1 P2 fixed）。10 tests。**

## Why

每只猫每天烧的 context token，很大一块来自**实时调 MCP 工具的全文返回**——`get_thread_context` 默认就回 100 条、最多 200 条完整 message body，单次可塞爆上下文窗口，猫还没开始思考就耗掉一大半预算。这与 F148 在消息侧治理的痛点**同源**，只是发生在"当下→context"（猫实时调工具）而非"过去→context"（冷启动注入历史）。

**价值一句话**：让猫调工具时默认拿到"指针 + 预览"，全文按需第二跳取——把单次工具返回的 token 占用砍下来。**⚠️ 措辞校准（Maine Coon P2）**："原文可 drill" ≠ "认知无损"——preview 会改变猫的注意力和判断（见下"信息完整性风险"段）。比 rtk 的**有损截断**好（原文还在、可取回），但**不能宣称"不丢信息"**。

> **更大的图景（2026-06-15 发现）**：MCP 协作工具是**可控的起点**，但 cc 内置 Read/Grep（读文件/搜代码）才是 agent 工作流 token **大头**——经查证 cc PostToolUse hook 能治（Phase C）。本 feat 不止治小头，更要治大头，且做到 **rtk 做不到的**（rtk 只 hook Bash，放弃了 Read/Grep）。

## Current State / 现状基线（research 实测，2026-06-15）

- 记忆系统三入口（`search_evidence`/`graph_resolve`/`list_recent`）+ `read_file_slice` 已是 anchor-first 标杆（snippet 截 200 + drilldown hint + bounded reader 120/400 行）。
- F148（done）已治理"过去→context"：消息注入分层 + 历史 tool payload scrub（AC-A5）。
- **缺口（本 feat）**：实时协作读工具全 dump——`get_thread_context`（`callbacks.ts:1975`，default 100/max 200 full body）、`get_pending_mentions`（`callbacks.ts:1645`，每条 inline 全文）、`list_tasks`（`callback-task-routes.ts:239`，why 达 1000 字）；且 `get_message` drill 终点**也回 full content**（Maine Coon抽查），不改则 dump 只推迟到第二跳。
- **🔑 大头修正（2026-06-15 查证，更正初稿误判）**：cc 内置 Read/Grep/Glob 才是 token 大头。初稿误判"runtime 锁定看不到"——查 cc 官方 hook 文档推翻：**PostToolUse hook + `updatedToolOutput` 官方显示可 replace 内置工具返回**（⚠️ caveat：replacement 须匹配原 output shape，不对会被忽略；**C0 实测 shape+replace 后才升级为事实**——Maine Coon钉）。rtk 没解决是它只用 PreToolUse（46 处）零 PostToolUse，**不是平台限制**。家里 F230 已证 PostToolUse 可**观测** Read `tool_response`（可观测≠可替换，C0 补证替换）。→ Phase C（spike-gated）。

## What

两段式 scope：**V1 先治完全可控的 MCP 协作读工具**（小头、立样板、最内层封顶），**Phase C 治 cc 原生 Read/Grep 大头**（spike PASS 后正式纳入——这是 agent token 真大头、rtk 放弃的）。与 F148（消息侧）形成完整版图。MCP 侧第一刀落在 callback route 的 projection helper（payload 组装处），不是 MCP wrapper（否则 HTTP/agent-key/UI 等调用方会绕过）。

### V1 scope（本期）
- `get_thread_context` / `get_pending_mentions` / `list_tasks` 默认返回 anchorized preview
- `get_message` drill 终点加 bounded 模式（`mode=preview|full` / `maxChars`）
- preview 字段：`id / threadId / timestamp / speaker / preview / contentLength / truncated / drillDown`
- pending mentions 特殊：长 mention 用 head+tail actionable excerpt + `requiresDrill=true`（不丢传球指令语义）

### Phase C scope（cc 原生工具大头 — spike PASS 后正式纳入）
spike（2026-06-16，C0a Read / C0b Grep ✅ 实证）证明 cc PostToolUse hook 能 anchor 化内置 Read/Grep——agent token 大头、rtk 放弃的那块。Phase C 把 anchor-first 从 MCP 工具扩到 cc 原生工具：
- **Read**：全文/大输出 → anchorized preview（路径 + 总行数 + 预览 + slice drill 指针）；bounded `Read(offset,limit)` pass-through 返回真实 slice（不丢原文）
- **Grep/Glob**：分组 anchor（命中文件 + 计数 + drill 指针），不 inline 全部命中行
- **实现位置**：cc 项目级 PostToolUse hook，保 `tool_response` shape、只替 content 字段（Read 在 `.file.content`，Grep 在顶层 `.content`——per-tool 分支）
- **仅 cc runtime**；codex/agy/opencode 见 AC-C3；interactive carrier parity 见 AC-C0c

### Non-goals（V1 不做，防跑偏 — Maine Coon收窄）
- ❌ runtime transform 层（codex/agy tool_result）—— 二期，跨 runtime 兼容性项目
- ❌ outputSchema 迁移（`server.tool` → `registerTool`）—— Phase B 架构升级
- ❌ subagent 返回 schema 硬约束 —— subprocess 架构不可达，硬层另设计
- ⏳ cc 内置工具返回（Read/Grep/Glob）—— **移出 Non-goals**：PostToolUse 路径技术可行，升级为 Phase C（spike-gated，见下）
- ❌ opencode 内置工具返回 —— transformer 不发 tool_result，仍 runtime 锁定（cc ≠ opencode）

## Acceptance Criteria

> AC↔Why 同源 + 非作者可复核

### Phase A: 协作读工具 anchor 化 ✅ DONE (PR #2381, squash 9af8b2093, 2026-06-18)
- [x] AC-A1: `get_thread_context` 默认返回 preview（非 full body），长 thread 单次返回 token 对比基线降 ≥60%（content-reduction 代理测试 ≥60% + returnedChars telemetry emit 就绪；生产 telemetry 复核归 eval 层 F192）
- [x] AC-A2: 每条 preview 含 `id/threadId/timestamp/speaker/preview/contentLength/truncated/drillDown` 字段（speaker 走 sender-display 不泄漏 internal id；keyword 命中走 match-snippet 不变瞎子）
- [x] AC-A3: `get_pending_mentions` 长 mention 用 head+tail excerpt + `requiresDrill=true`，传球指令关键信息不丢（fixture 验证）
- [x] AC-A4: `list_tasks` 的 why 字段 preview 化（默认精简，taskId drill 取全文）
- [x] AC-A5: 截断逻辑在 callback route projection helper（最内层），非 MCP wrapper（本地+remote review 复核确认）

### Phase B: drill 终点 bounded ✅ DONE (PR #2381, squash 9af8b2093, 2026-06-18)
- [x] AC-B1: `get_message` 支持 `mode=preview|full`，默认 preview（截断 + drillDown 指针，agent-key caller 注入 agentKeyCatId 一跳）
- [x] AC-B2: full drill 显式触发，记录 `fullDrillChars` telemetry（含 context neighbors + contentBlocks 全量）

### Phase A/B-Eval: anchor-first sunset 监控闭环 ✅ DONE（Track-1 ✅ + Track-2 ✅ + AC-E3 ✅）

> **eval 叫啥 / 为什么是 phase 不是独立 feat**：这是 F236 的 **Phase A/B-Eval**——Phase A/B 的**配套监控闭环**（紧耦合 F236 telemetry + sunset 回退决策），不是独立能力（不像 F245 那样单独立项）。实现**接 F192 harness eval system**（telemetry pipeline + verdict engine）；**本节是 eval 设计真相源，F192 md 只放一行 link 过来**（不让 F192 md 膨胀）。
>
> **为什么先于 Phase C（排期）**：Phase A/B 已 merged 上线，但**只 emit telemetry、没闭环**——"何时 sunset 回退 / anchor 是否真净益"现在只能靠operator提醒或挂 cron 盲看两天 = **假闭环**（ADR-031 eval 层欠债）。先还这个债，再扩大头 Phase C。**Phase C 不硬依赖本 phase**（它另有 AC-C5 blindness gate 自带 eval），但本 phase 的 verdict 为 Phase C 扩展提供数据依据。

- [x] AC-E1（"省" telemetry substrate）✅ **Track-1 MERGED（PR #2411）**：`returnedChars`/`fullDrillChars` 落 OTel metrics（`cat_cafe.anchor.{returned,full_drill}.{count,chars}`，per-tool）= 可查询 chars/request-volume substrate。⚠️ **范围已按Maine Coon 2026-06-19 裁定收窄**：`anchorOpenRate` + 任务返工轮次**不在 AC-E1**——它们是跨请求相关性，移到 AC-E2 的可 join 事件模型（见下 + Track-2 交接块）。`*.count` 仅 volume，非 open-rate 分子/分母。
- [x] AC-E2（verdict 自动判定）✅ **Track-2 MERGED（PR #2490，squash `5251c2f75`，2026-06-22）**：per-event preview↔drill correlation model（in-memory ring buffer, 24h retention）+ joinable event records（correlation key = itemId/sourceTool）+ timeline-interleaved rollup algorithm（per-tool openRateByItem, charsSaved, drillChars, netBenefit, orphanDrills）。4 emit sites wired（pending-mentions, thread-context, get-message, list-tasks）。25 unit tests GREEN（Maine Coon 3 轮本地 + 云端 5 轮封板，11 findings 全修 + 5 回歸測試）。
- [x] AC-E3（sunset 触发 + Phase C 数据依据）✅ **DONE（PR #2507，squash `d09024c90`，2026-06-22）**：attribution 加 per-tool `sunsetSignals`（anchorTax/highOpenRate/netNegative）+ root-level `sunsetAssessment` 摘要；severity 升级到 `high` + proposedAction 标记为 `fix` 当 anchorTax 触发（Signal 1 only — blindness 不可由 generator 确认，eval cat 交叉验证后升级）；low-sample tools (previewedItems < 10) skip findings entirely（publish-policy correctness）；verdict.md 渲染 Sunset Signal Assessment 区段。eval 猫指令增强双信号准则（Signal ① anchor tax + Signal ② blindness cross-ref eval:task-outcome）+ verdict mapping（both→delete_sunset / single→fix / neither→keep_observe）。10 测试 GREEN（gpt52 本地 3 轮跨族 review + 云端 Codex 1 轮）。
  - 🔍 **愿景守護 opus-48（2026-06-22）— APPROVE（merge 正确）+ 记 1 latent issue（non-blocking）**：核过 ① 低样本 gate 真修（`previewedItems<10` → `continue` 跳出 findings[] → `noFindingRecord{reason:low_sample}`，不再被 publish-policy 误当 actionable regular_pr，gpt52 R3 APPROVE 站得住）；② eval 猫 verdict mapping 双信号 spec-faithful（cost-only 不会误 delete_sunset）。**Latent issue（待 follow-up）**：generator 把 `anchorTax`（=highOpenRate&&netNegative，纯成本信号①）的 per-tool `proposedAction` 直接标 `'sunset'`（`eval-anchor-first-live-verdict.ts:229`），但 generator **测不到 blindness 信号②**，按 spec 该工具 single-signal 应是 `fix`——bundle 数据（proposedAction='sunset'）与 verdict mapping（single→fix）自相矛盾，可能误导 eval 猫。**修法**：把 anchorTax-without-blindness 的 proposedAction 对齐成 `'fix'` 或显式 `'sunset-candidate'`。**✅ RESOLVED by PR #2508**：proposedAction 对齐为 `'fix'`，primaryLayer 对齐为 `'anchor_tax'`，eval-cat 指令文案同步修正。**cloud P1#1 实为真 latent issue（非纯"设计解释差异"）；46 的 P3 降级 outcome 可接受（非最终判定 bug、不阻塞 merge）但 framing 过宽。** 另：46 降级时引用的"愿景守护已裁决"对此条不成立（opus-47 那轮 VG 是 F208 AC-E3 撞名；我此前只裁过 netNegative→fix / low-sample→keep_observe）。
- [x] AC-E4（接入 F192 不膨胀）✅ **Track-2 DONE**：`eval:anchor-first` domain registered on Y-lite（YAML + sourceRefsKind `anchor-telemetry-snapshot` + VerdictSourceRefs 7th branch + zod schema + generator adapter + live-verdict writer + provider wired in index.ts）。F192 md 仅需加一行 link。

#### Design Notes（2026-06-18 Ragdoll opus-48 session #4 调查 — 落库防 context 死亡）

> 调查方法：Explore subagent 读 callbacks/telemetry/harness-eval 全链路（current line 已核，F233/F243 未碰 telemetry/eval 文件）。

1. **Emission audit（现状 = 半成品确认）**：F236 anchor telemetry 当前仅 4 处、全是 `app.log.info` 到 stdout、零持久化（24h 丢）：
   - `pending-mentions` → `callbacks.ts:1657`（`returnedChars`）
   - `thread-context` → `callbacks.ts:2011`（`returnedChars`）
   - `list-tasks` → `callback-task-routes.ts:255`（`returnedChars`）
   - `get-message` full-drill → `callbacks.ts:2156`（`fullDrillChars`，条件 `isFullDrill`）
2. **⚠️ Scope 修正（调查才发现，改写 AC-E1 范围）**：`anchorOpenRate`（信号①核心：drill/preview 相关率）与**任务返工轮次**（信号②变瞎子）**当前根本没 emit**。故 AC-E1 不只是"持久化已有 emission"，**前置子任务 = 先补 emit 这两个缺失信号**（anchorOpenRate 须关联 preview-event 与后续 drill-event；rework 须关联任务结果）。这才是本 phase 复杂度 3~4.5/5 的真来源。
3. **Sink DECIDED（§4 自决：可逆 + 无外部用户影响 + 无新外部依赖 + 与现有 pattern 一致）**：**in-memory per-tool 聚合，复用 `callback-auth-telemetry.ts` 范式**（24h per-hour buckets，按 tool/catId 聚合，可选并行 emit OTel counter）。
   - 依据：F192 现有 3 个 telemetry store **全是 in-memory ring buffer**（`local-trace-store` 24h / `metrics-snapshot-store` 6h / `callback-auth-telemetry` 24h）→ 架构一致选择就是 in-memory，**不引入新 Redis durable store**。
   - 否决：`metrics-snapshot-store`（6h 保留期 < daily cron 窗口，盲区太大）；新 Redis durable store（与 F192 pattern 不一致 + over-engineer，eval 信号 lose-on-restart 可接受，非 LL-048 用户态）。
   - 这也右调了 handoff 的"sink 影响 broad infra 须先咨询"顾虑：一致选择恰恰是**不加新 infra**，故 sink 不再是须升级的岔路。
4. **Verdict 机制 = eval-cat-in-loop（非 auto-generator）**：AC-E2 走 F192 既有范式——注册 eval domain（带 `evalCat`），cron 唤醒 eval 猫读聚合 telemetry → 产 `VerdictHandoffPacket`（schema `verdict-handoff.ts:7`，`verdict` 枚举 `delete_sunset|build|fix|keep_observe`）。**不写确定性净收益计算函数**（与 handoff instinct 一致）。
5. **✅ RESOLVED 设计岔路（2026-06-18 session #4 — Maine Coon gpt52 架构裁定 + Ragdoll spot-check 实证）**：原问 F236 自立 eval domain vs blindness fold 进 `eval:task-outcome`。**裁定 = hybrid，但收紧为「phenomenon-owned, not feature-owned」**：
   - **anchor-tax①** → 自立 **phenomenon 名** eval domain（slug `eval:anchor-first`，对齐现有 `eval:a2a/memory/sop` 控制面命名 + 覆盖 Phase C 扩展；**不叫** `eval:f236-anchor`——那是 feature-owned，违 F192 哲学）；`handoffTargetResolver.featureId` 指 F236。须 bump `VerdictHandoffPacket` domainId 枚举 + 新 sourceAdapter（**impl 前置 gate：先 grep domainId 枚举消费方再改 contract**）。
   - **blindness②** → **reference-read `eval:task-outcome` 的 verdict/episode 趋势**，F236 **不写入** task-outcome（它是 blindness 的 canonical owner）。
   - **依据（Maine Coon ref + Ragdoll实证）**：F192 粒度哲学 = 一现象/控制面一 domain（`eval:memory` 跨 F200+F188 @F192:764；`eval:task-outcome` 测 L3 交付现象 @F192:310；F245 钉「不抢 canonical signal ownership」@design-gate:27）；`eval:task-outcome` 现有 episode signal enum 仅 A1 world-truth / A2 permission-cancel / proxy（**实证** `task-outcome-episode.ts:28+`），**无 anchor 槽** → 直 ingest = Phase-G schema 扩展（不在本 phase scope），故 reference-read 是最小路径。
   - **修我自报错**：我把「associate」和「直接 ingest」混了——task-outcome 接不进 anchor 信号，blindness 只能引用读取不能写入。
   - **实现序**：AC-E1（sink + 补 emit `anchorOpenRate`/返工）fork-invariant **先建** → AC-E2 verdict（anchor-tax 自持 + blindness 引用 task-outcome）→ AC-E4 注册 phenomenon domain（带 enum-consumer grep gate）。
6. **🔗 CROSS-FEATURE 协调 → F245（`eval:friction`）= 近同构姊妹 feature，平行 opus-48 owner（2026-06-18 recall 发现 + 双向协调完成）**：F245 也在 F192 下新增 phenomenon eval domain + rollup aggregator + bump 同一对枚举（OQ-4「2 enum 扩展」= domainId + sourceAdapter）。cross-post F245 thread `[thread-id]` 协调，**平行我 ack 如下**：
   - **✅ 无 rebase**：F245 实现一行没 land、枚举未动 → 两 feature 都没 finalize 枚举，**一起定共享基建再各自 land**（不是谁先谁后）。
   - **✅ sink substrate CONFIRMED = OTel metrics（item 3 的 in-memory store 选择正式废弃）**：平行我 + F245 KD-1 双确认——**emit OTel metrics 当 canonical source + 复用 `harness-eval/telemetry-adapter.ts`（已存在）**，不建第二个 store。这是 KD-1/KD-4 精神（read-only，canonical source 在别处不自建）。
   - **✅ 共享 vs 独立划定**：**共享** = N-day cadence registry 扩展（现只 daily|weekly）+ `RollupEvalDomain` 骨架（rollup trigger + Top-N + Verdict Handoff 同套）+ registration pattern；**独立** = 各自 source adapter + feature 逻辑（F245 4 通道采集 / F236 token telemetry）。
   - **✅ registration pattern RESOLVED = Y-lite（Maine Coon owner 裁定 2026-06-18）**：domainId / sourceAdapter / sourceRefsKind 从中心硬 TS enum → **受限字符串**（`eval:[a-z0-9-]+`），消费方（publish/trigger/Hub）校验 against `docs/harness-feedback/eval-domains/*.yaml`，缺注册 → `domain_not_registered`；adapter/generator 仍**代码显式 wiring**，缺 → 501/scheduled skip（**runtime fail-closed**，不让 eval 猫撞未知 publish path）。**不是全插件化**（YAML 不能自声明可执行 adapter）。现有 5 domain 降为 fixtures/regression、不再是扩展上限。→ **每加 phenomenon domain = 加 YAML，不改中心 contract**（根治碰撞）。
   - **✅ rollup（Maine Coon 裁定）**：**不抽 `RollupEvalDomain` 大基类**（太早）。仅 bless 三块最小共享层：cadence/window contract（window+Top-N+tokenBudget）+ publish/generator boundary（`sourceRefs.kind → generator → bundle → VHP`）+ 小工具（Top-N/tail-fold / token-budget renderer / cluster-id helper）。各域 own 自己 source adapter；两域落完重复 >2 处再抽。
   - **✅ N-day cadence（Maine Coon 裁定）**：新 canonical 字段 `cadence:{kind:daily|weekly|every_n_days, days, timezone, anchorHourUtc}`（兼容旧 `frequency`），跟 registration pattern 一起落，shared gate 判 due。
   - **✅ Track-1 = MERGED（PR #2411，squash `21ae2c83b`，2026-06-18）**：anchor telemetry emit as OTel——新增 `routes/anchor-telemetry.ts` recorder（镜像 callback-auth-telemetry）+ 4 instruments `cat_cafe.anchor.{returned,full_drill}.{count,chars}` + `anchor.tool` allowlist；4 emit 点 additive；R1 empty-drill guard。**按Maine Coon eval-owner 裁定收口为 chars + request/response volume substrate**（`*.count` = volume，**非** open-rate 分子/分母；open-rate→Track-2，见 item 5）。质量门：cloud 3 轮（round-2 逼出信号模型岔路 + R1 empty-drill；round-3 clean）+ gpt52 跨族 review+续签 + pure-rebase 自决合入。⚠️ limitation：OTel emit 测法是 in-memory mirror（仓库无 exporter-readout harness），end-to-end OTel 验证留 Track-2 eval-adapter 集成。
   - **✅ shared Y-lite infra LANDED（2026-06-21）— Track-2 UNBLOCKED**：F245 PR #2476（`0822a68b4`）已 merge，domainId 去中心 enum→受约束 string + registry/YAML + fail-closed（一手核 main 确认）。**Track-2（AC-E2 open-rate 事件模型 + AC-E4 注册 `eval:anchor-first`）现可直接做**——加 YAML+wiring 不改中心 contract。**完整可执行交接见下方「🎯 Track-2 实施交接」块**（operator 2026-06-21：实现交 46，opus-48 保留记忆做愿景守护）。**禁硬 enum +1**（去中心了，本就不该再碰）。
   - **✅ 信号模型岔路 RESOLVED（2026-06-19 Maine Coon eval owner 裁定，cloud round-2 逼出 → Ragdoll halt 升层）**：cloud 2 个 P2（drill 未归因回源 tool / returned 按 payload vs drill 按 item 单位错配）真实，根因 = F236 open-rate 本质是**跨 endpoint / 跨请求 / per-item 的 drill↔preview 相关性**，Track-1 低基数聚合计数器（`anchor.tool` + count/chars，无 messageId/sourceTool/previewEventId join key）**一聚合就不可恢复** → open-rate **不能无损 defer**，但 Track-1 也不该现在扛高基数事件模型。**裁定 (iii)：Track-1 只 ship chars / request-volume substrate，open-rate 采集从 Track-2 才开始。**
     - **Track-1 scope（PR #2411 reshape）**：保留 `anchor.returned.chars` / `anchor.full_drill.chars`（省信号）；`*.count` **只解释为 request/response volume，非 open-rate 分子/分母**；保留 R1 empty-drill 修复（没 serve 内容不记）；**不穿 sourceTool/itemCount、不改 drillDown pointer contract**（那是 Track-2 设计面）；删掉代码注释/测试文案/本 doc 里所有"raw counts later compute open-rate / drill-preview split honest"表述。
     - **🆕 Track-2 AC（AC-E2 前置，Maine Coon req-6）**：per-tool open-rate / sunset verdict 需要 **preview-event ↔ drill-event 可 join 的事件模型**（correlation key = messageId/taskId/sourceTool/previewEventId）；**高基数 id 不能做 metric label**，须走 event/log/trace/adapter-consumable source record。Track-1 的 chars/volume metrics 是 substrate，不是 sunset verdict 的完整输入。
   - **架构一致**：F236（anchor-tax read-only + blindness reference-read task-outcome）与 F245（read-only 不抢 canonical ownership）**同 KD 家族**——不重复 deliberate。

#### 🎯 Track-2 实施交接（2026-06-21，给接手猫 e.g. opus-4.6 — self-sufficient，读本节即可起步，不需 opus-48 在场重述）

> **owner 分工（operator 2026-06-21）**：opus-48 保留完整记忆做 **F236 愿景守护**；**Track-2 实现可交 46**。本块把上面 Design Notes 的散点结论收成一份可执行交接，防 session handoff 失忆。

**✅ 前置已全部就绪**：
- **Track-1（"省"信号 substrate）MERGED**（PR #2411）：OTel metrics `cat_cafe.anchor.{returned,full_drill}.{count,chars}`（per-tool，`anchor.tool` label）via `packages/api/src/routes/anchor-telemetry.ts` recorder + `infrastructure/telemetry/instruments.ts`。**`*.count` 只是 request/response volume，不是 open-rate 分子/分母。**

**Track-2 = 两块（AC-E2 + AC-E4）**：
- **AC-E2 — open-rate verdict（核心难点）**：sunset 信号①(anchor tax) 本质是**跨请求/跨 endpoint/per-item 的 preview↔drill 相关性**（preview tool 返回 drillDown 指针 → cat 经 `get-message`(full) 或 `list-tasks`(taskId) drill；要 join "哪个 preview 的哪条 item 被 drill"）。**Track-1 聚合 metrics 算不出（无 join key）**。Track-2 须建**可 join 事件模型**：emit per-event 带 correlation key（messageId/taskId/sourceTool/previewEventId）走 **event/log/trace/adapter source record**（🔴 **高基数 id 禁做 metric label**——Maine Coon硬约束）。eval cat rollup 时 join 算 open-rate。
  - 信号②(变瞎子=任务正确性/返工率)：**reference-read `eval:task-outcome` 的 verdict/episode 趋势，F236 不写入**（task-outcome 是 blindness canonical owner；其 episode signal enum 无 anchor 槽，直 ingest = Phase-G 扩展、不在 scope）。
  - verdict 机制 = **eval-cat-in-loop**（注册 domain 带 evalCat → cron 唤醒 eval 猫读聚合 → 产 `VerdictHandoffPacket`，verdict ∈ `delete_sunset|build|fix|keep_observe`）；**不写确定性净收益计算函数**。🔴 Maine Coon KD：**不许单边报省**——必须双边净收益（省 − drill 成本）+ sunset 双信号。
- **AC-E4 — 注册 `eval:anchor-first` domain（走 Y-lite，非 enum）**：加 `docs/harness-feedback/eval-domains/eval-anchor-first.yaml`（domainId=`eval:anchor-first` phenomenon 名、sourceAdapter、sourceRefsKind、cadence、evalCat、`handoffTargetResolver.featureId=F236`）+ 代码显式 wire adapter/generator（缺→501 fail-closed）。**不改中心 enum。** 镜像 `eval:friction` 的 fan-out——3 个易漏点（F245 PR1b 实测）：① `mcp-server/.../publish-verdict-tool.ts` 独立 zod schema ② `eval-cat-invocation.ts` 的 `PUBLISH_VERDICT_INSTRUCTIONS_BY_DOMAIN` map ③ `assertNoNewlineInBulletFields` guard。

**关键文件指针**：Y-lite 注册 → `infrastructure/harness-eval/domain/eval-domain-registry.ts` + `verdict-handoff.ts`(string domainId) + `publish-verdict/publish-verdict.ts`(registry sourceRefsKind) + `eval-domains/*.yaml`；参考 domain → `eval:friction`（最近同型实现）；Track-1 substrate → 上方「前置」。

**SOP**：research→plan→worktree(Redis 6398)→TDD(先红后绿)→quality-gate→跨族 review→merge-gate。判断密度高，清醒满 context 做。**接手猫起步前先 recall + 读本节 + 读 `eval:friction` 实现**，再开 worktree。

### Phase C: cc 原生工具 anchor 化（spike-gated — 这才是大头）
> 前置 spike（与Maine Coon一起）：实测 cc PostToolUse hook + `updatedToolOutput` 能否 replace Read/Grep/Glob 返回。**spike 不过则本 Phase 不启动**（不脑补——文档说能 ≠ 我们场景能用）。
- [x] **AC-C0b (spike) ✅ PASS**: Grep shape（正文在顶层 `.content`）shape-matched replace 实证
- [ ] AC-C0c (spike) pending: Glob shape / 多 Read `tool_use_id` 独立 / session 持久化 / **interactive carrier parity**（本 spike 是 sdk-cli ≠ carrier；Phase C 若含 interactive carrier 须单独 AC 在 carrier path 复测）
- [ ] AC-C1: Read 返回默认 anchorized（文件路径 + 总行数 + 预览 + `read_file_slice` drill 指针），全文按需 drill
- [ ] AC-C2: Grep/Glob 返回分组 anchor（命中文件 + 计数 + drill），不 inline 全部命中行
- [ ] AC-C3: PostToolUse 仅 cc；**codex/agy 两条候选路**（spike-gated，operator 2026-06-17）：
    - **浅路（学 rtk）**：注入 shell 命令重写 hook（codex/agy 有 PreToolUse/shell hook，rtk 已证）——广但只压 shell 命令，碰不到内置工具 output
    - **深路（output anchor）**：需 codex/agy 有 cc PostToolUse 等价机制、能改**它们模型侧**的 tool_result
    - ⚠️ **核心未知（深路必验）**：我们的 transform 层改的是 **cat-cafe 侧存储/展示**（≠ codex/agy 模型 context，省不到它们 token，且那侧 F148 已覆盖）——深路要省 codex/agy 模型 token，**必须它们自己有 output hook**，不是我们 transform 能代劳。（修正：前文"transform 可改"指 cat-cafe 侧，非模型侧）
    - opencode：transformer 不发 tool_result，锁定
- [~] AC-C0d (spike) 文档+家里实测查证（2026-06-17，**Maine Coon P1 改判 + operator纠正 agy 分形态**）：能力真相 **cc（实测 PASS）>> codex（限 shell）> agy-IDE/Bengal（observe-only）；agy-CLI/Siamese（待查）**——下方逐条
    - **codex**（`.codex/hooks.json` PostToolUse，`decision:block`+`reason` 替换 tool result）：覆盖 Bash/apply_patch/MCP，**不覆盖 file-read 工具** → 深路对 codex 限 shell（读文件 hook 不生效）
    - **agy 分两形态**（operator 2026-06-17 纠正，我之前笼统混了 — F210/F061 实测证）：
        - **Bengal（Antigravity IDE / Language Server，@antig-opus）= observe-only，深路不成立** ✅：SDK README PostToolCallHook 归 inspect/read-only + 家里 **F061 AC-2cR4 实测**（@antig-opus 2026-04-21/23）`view_file`/`grep_search`/`list_dir` 全 **LS 内部 DONE 自闭环、不走 Cat Café Bridge writeback**，carrier 插不进去。这个站得住
        - **Siamese（Antigravity CLI / `agy --print`，@gemini gemini25）= hook 能力待单独查**：F210 证Siamese走 `antigravity-cli` adapter；CLI 形态的 hook（`~/.gemini/config/hooks.json`）能不能改 output 与 IDE **可能不同**——我之前 WebSearch 没区分 CLI/IDE 就笼统说"agy observe-only"，又一次"没区分清楚就下结论"。留 Phase C 实测
        - **纠正前文"最接近 cc"**：observe≠transform + 漏 recall F061 + 没分 CLI/IDE 形态
    - **修正**：spike A 从"rtk 用 rules.md"误推"agy 没 hook"——官方文档推翻（agy 有 PostToolCallHook，rtk 只是没用它）。又一次旁证脑补被查证纠偏
    - **实测（nonce probe）留 Phase C**：cc 已证 PostToolUse output replace 范式真实（核心打底）+ codex/agy hook/config 已查到；codex 实测烧贵配额（Maine Coon额度），spike 阶段 cost>边际价值，Phase C 实现期实测确认
    - 来源：codex `developers.openai.com/codex/hooks` / agy **官方 SDK README（PostToolCallHook read-only）+ 家里 F061 AC-2cR4 实测**（`antigravity.google/docs/hooks` 返空，Maine Coon改用 SDK README 核验）（checked 2026-06-17）
- [ ] AC-C4: 双边 eval 对 cc 工具同样适用（Read drill 净收益 = 省 − drill 成本）
- [ ] **AC-C5（控制机制 = cat-controlled mode — 2026-06-24 pivot，详见下方 pivot 块）**: 不再"系统猜何时 anchor"，而是**猫显式选 mode（anchor / full）**、系统零任务分类。anchor mode 内护栏：locator-not-synopsis（硬不变量）+ 全文一跳逃生（证完才默认开）。默认 fail-open。eval = 反馈/调默认、**非 gate**。**AC-C1/C2 的"默认 anchorized"改为"猫选 anchor mode 时 anchorized"。**

#### 🔄 设计 pivot（2026-06-24）：cat-controlled mode（Maine Coon failure-mode 审计 + operator cold-start 纠偏）

经三轮收敛，AC-C5 从"系统猜何时 anchor"翻转为"猫显式选 mode"。**完整推演链（防失忆 — session handoff 也不丢）**：
1. **v1（弃）任务分类**：debug/review → 默认全文。→ operator否：判断任务类型 = task 意图分类器 = 补锅 if-else + 违 **KD-8「不用分类器替猫判断 intent」**。
2. **v2（弃为主控、降 fallback）大小阈值**：按输出大小 + 猫是否 bound 决定 anchor。→ **Maine Coon failure-mode 审计 3 P1**：① preview 必须 **locator 不是 synopsis**（synopsis = 隐藏分类器、偷走重要性判断）；② 全文逃生通路（大文件全文一跳 / Grep 扩上下文 / interactive parity）**证完才许默认开**（否则 drill 拿不回 / anchor-on-anchor 死循环）；③ **eval 是刹车校准不是气囊**——变瞎子是事后信号，前置边界必须 fail-open。
3. **v3（采纳）cat-controlled mode**：→ **operator cold-start 纠偏**：fail-open canary **没人用 → 没数据 → 永远放不开 → 死在摇篮**。正解 = 把"猫是任务 oracle"贯彻到底——**让猫显式选 mode、系统不猜**；猫嫌噪音自己开 anchor（adoption + 数据双解），review 时自留全量（**判断权归猫，KD-3**）。

**采纳设计**：
- **主控 = 猫显式选 anchor / full mode，系统零任务分类 / 零意图猜测。**
- **我们自己的工具（MCP 协作工具：thread-context / pending-mentions / list-tasks / get-message）**：mode 作参数，**完整铺开（V1，现在做，不 timid）**。
- **cc 原生 Read/Grep**：签名改不了 + PostToolUse 调用后才触发 → 猫设 **session 级 mode**、hook 读状态决定 anchor/放行。**spike-gated**（operator 2026-06-24 批：先证"猫能 signal mode 给 hook"）。
- **anchor mode 内护栏（Maine Coon audit，still holds）**：preview = 机械 **locator 不是 synopsis**（路径+总行数+省略行数+命中行号/文件数+可复制 drill 指针；升为**可测硬不变量** = ADR-031 硬层）；**全文一跳逃生**；Grep drill = 扩文件上下文、不回更大 blob。
- **默认（猫没选时）= fail-open 给全文**；多信号阈值（字节/行数 + grep fan-out + 压缩比，非单 magic number）仅作"猫没选时的智能默认"、**非 gate**。
- **eval（Phase A/B-Eval）角色**：观察 mode 使用 + 给猫反馈 + 调默认，**非 enforce 闸门**（刹车≠气囊）。

**Open（待 spike / 设计）**：① cc 原生"猫 signal mode → hook 读"可行性（**spike 进行中**）；② 默认 mode 值 + mode 表达 ergonomics（session / per-turn / per-call）；③ anchor mode 内是否需 size 下限护栏（防猫 anchor 小文件还变瞎）。

**Supersedes**：AC-C5 v1"debug/review 默认全文"（task 分类）+ 下方「防瞎子设计」的"任务感知"条 — 均弃；fail-open / locator / 逃生 / 多信号阈值并入本设计。

## Eval / Tracking Contract（F192 / ADR-031）

> **本节 = eval spec（要测什么）；实现闭环见上「Phase A/B-Eval」节**（telemetry 聚合 → verdict → sunset 触发，接 F192）。现状：Phase A/B 已 emit telemetry，verdict/触发闭环待 Phase A/B-Eval 还债——别把"emit 了 telemetry"当成"有 eval 闭环"。

1. **Primary Users + Activation**：所有 runtime 的猫调协作读工具时；activation = 工具返回走 anchorized 路径的比例。
2. **Friction Metric（双边公式 — Maine Coon KD，不许单边报喜）**：
   - 省：`returnedChars/tool_result`（默认 inline payload 下降）
   - 成本：`anchorOpenRate`（drill 触发率）+ `fullDrillChars`（drill 取回量）+ 任务返工轮次
   - **净收益 = 省 − drill 成本**
3. **Regression Fixture**（≥1）：① 长 thread `get_thread_context` 返回 token 上限；② pending mention 关键传球指令不丢；③ `get_message` full drill 仍可取全文。
4. **Sunset Signal（两类，缺一不可）**：① **anchor tax** —— `anchorOpenRate` 持续 >80%（猫几乎每次都 drill）→ 净亏，回退 inline；② **变瞎子（更隐蔽，token 账看不到）** —— 任务正确性 / 返工率下降：anchor 后猫漏信息、误判、返工变多 → preview 偷走了判断所需信息，立即回退该工具 anchor。**只测 token（①）测不出变瞎子（②），必须同时测任务结果。**

## ⚠️ 信息完整性风险（"变瞎子"）—— 比 anchor tax 更深（operator 2026-06-17）

**核心**：anchor tax 是"猫知道要 drill、多花 token"（可逆、token 账可见）；**变瞎子是"猫看 preview 以为够了、不知道自己漏了、基于残缺信息误判"**（不可逆、token 账**不**可见）。后者更严重——我们之前只防前者。

**Failure modes**：
1. **虚假完整感**：preview 给 head+tail，关键逻辑在中间，猫以为读懂不 drill → 误判
2. **重要性判断被偷走**：猫 drill 哪段依赖 preview 给的线索；preview 没点出"这里关键"，猫就不 drill——把"什么重要"从猫挪给了**不懂当前任务**的截断逻辑
3. **cc 自读代码最危险**：review/debug 靠 Read 全文，preview 化 → 基于残缺代码判断、引入 bug（省 token 换判断质量 = 本末倒置）

**防瞎子设计（硬约束）**：
- **诚实标注省略**：preview 必须明示"省了 N 行 / 这是 head+tail / 中间有 X"，绝不制造"看全了"假象
- **drill 极低成本**：一跳拿到，否则猫懒得 drill 就瞎
- **保守默认**：只 anchor 超大输出，宁可少省不误伤
- **任务感知（难点，待设计）**：debug/review 默认给全文、浏览可 anchor——hook 不知任务，对"读代码"类默认保守
- **eval 必测判断质量**：见 Sunset Signal ②，不只测 token

> Maine Coon有粮后 review 此段（failure-mode 审计强）。**这是 F236「该不该实现 / 怎么实现才不伤判断」的关键闸门，比技术 spike 更重要。**

## 软 + 硬 + eval 三层（ADR-031）

| 层 | 计划 |
|----|------|
| **软** | skill/convention：新增读类 MCP 工具默认 preview+anchor；ADR-203 立原则 |
| **硬** | route projection helper 强制 preview（最内层封顶）；regression fixture 守 token 上限；lint 检测新读类工具缺 preview（Phase B） |
| **eval** | 双边 telemetry（returnedChars / anchorOpenRate / fullDrillChars / 返工）+ **blindness signal（任务正确性 / 返工率，测变瞎子）**；sunset **双信号**监控 anchor tax ① + 变瞎子 ② |

## Architecture cell
- **Architecture cell**: MCP server tools + API callback routes（返回 payload 组装）
- **Map delta**: update required（callback route 新增 projection helper 层）
- **Why**: 在已有 callback route 返回构造前插入 anchorize 投影，不新建 Store/Router/Adapter

## Dependencies
- **Evolved from**: F148（消息侧分层，本 feat 是返回侧姊妹篇）
- **Related**: F209（evidence recall）/ F192（harness eval — Phase A/B-Eval 闭环接 F192 telemetry pipeline + verdict engine；**F236 此 doc 为 eval 设计真相源，F192 md 只放一行 link 回本节**，不让 F192 膨胀）
- **Companion**: ADR-203（anchor-first context 入口原则）

## Key Decisions
- KD-1: 新 F 号不 reopen F148（边界不同：消息侧 vs 返回侧）— Ragdoll×Maine Coon共识
- KD-2: 第一刀落 callback route projection helper（最内层封顶）— Maine Coon sharpen
- KD-3: drill 终点（get_message）也必须 bounded，否则 dump 只推迟 — Maine Coon发现
- KD-4: V1 不碰 outputSchema 迁移 / subagent schema（subprocess 不可达）— Maine Coon收窄
- KD-5: eval 双边公式，不许单边报省 — Maine Coon anchor tax 风险
- KD-6: **cc 大头可解（C0a/C0b 已实证 PASS，2026-06-16）**——`claude -p/sdk-cli` 下 shape-matched PostToolUse replace（Read `.file.content` / Grep `.content`）+ bounded drill pass-through 实测打通；built-in replacement 须匹配原 output shape（字符串被忽略，Maine Coon caveat 实证）。rtk 只用 PreToolUse 没做到。interactive carrier parity 待 Phase C 单独验 — Ragdoll×Maine Coon双猫 spike（更正"runtime 锁定"初稿误判，吸取 Workflow-schema 脑补教训）
