---
feature_ids: [F193]
related_features: [F043, F052, F178]
topics: [mcp, cross-thread, agent-first, harness]
doc_kind: spec
created: 2026-05-07
---

# F193: Cross-Thread Communication Unification

> **Status**: done | **Owner**: Ragdoll(Opus 4.7) | **Priority**: P1 | **Completed**: 2026-05-09

## Why

team lead 2026-05-07 原话：
> "我们家的跨线程通讯这个功能 ... 让你们跨线程通讯，或者什么 有的时候想不到需要用这个 有的时候 跨线程的方式不太对 比如没at对面线程的猫猫等等 这个特性太早了和我们家harness实践脱节了。"

team lead第二轮原话（接收侧补充）：
> "你们的跨线程通讯skills的优化  是不是也要考虑这个 ... 收到这个消息的猫丝毫没有意识到自己要发消息回去不能at自己thread内的那只得at 来自其他线程的那只"

**Motivation evidence**: `/uploads/1778169018738-4cf75cfd.png` — 46 收到 47 跨线程传话后正确处理内容，但回复停在本 thread，47 thread 零回馈。证明缺**接收侧 reply hint**。

三猫审计（2026-05-07）共识：跨线程通讯不好用的根因不是 skill 写得不够细，而是**四件叠加**：

1. **F043 / F052 / F178 三契约衰减**：`post_message` 重新出现 `threadId`（F178 引入合法用例），但没保留 F043 #316 防误投禁令；`cross_post_message` schema 缺 `targetCats`，skill 文档让猫填一个不存在的参数（[callback-tools.ts:355-366](../../packages/mcp-server/src/tools/callback-tools.ts) vs [SKILL.md:87](../../cat-cafe-skills/cross-thread-sync/SKILL.md)）
2. **System prompt 缺工具**：[SystemPromptBuilder.ts:274-285](../../packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts) MCP 工具列表没有 `cat_cafe_cross_post_message`——工具不在认知面 = 不存在
3. **配置双重注册**：.mcp.json + .codex/config.toml 同时挂了 all-in-one (`cat-cafe`) 和 split 三 server，每个工具暴露至少两次
4. **接收侧无 reply hint**：F052 后端注入了 `extra.crossPost.sourceThreadId`（[callbacks.ts:712](../../packages/api/src/routes/callbacks.ts)），但 invocation context / system prompt 没把这个数据 push 给收信猫——猫不知道消息来自哪个 thread、回复要 @ 哪只猫

修复方向不是补认知脚手架，而是**砍冗余 + 让正确路径成为最低阻力路径**：恢复 F043 安全契约 + 把 `cross_post_message` 修成一等公民 + server 主动 push 接收侧数据 + split-only 配置。

## What

### Phase A: KD-1 enforcement（发送侧契约 reconcile）

恢复 F043 #316 防误投契约，对齐 F178 agent-key principal 需求，统一为 **principal-conditioned threadId semantics**。

- `crossPostMessageInputSchema` 补 `targetCats` 字段（与 `postMessageInputSchema` 对齐）
- MCP handler 层 fail-closed：invocation-token caller 调 `post_message` 传 `threadId` → reject + 提示 `use cat_cafe_cross_post_message for cross-thread delivery`
- API route 层 fail-closed：`CallbackPrincipal` × `threadId` × `targetCats` hard check（保护安全边界 + 维护 F052 溯源链路）
- `cross_post_message` 缺 `targetCats` **且** content 无行首 @ → reject (400) + 错误体附 `alternatives[]`
- 不做 silent strip——silent strip 会丢 F052 `sourceThreadId` 溯源 + 丢同名猫跨线程豁免（`isCrossThread ? undefined : senderCatId`）

### Phase B: 认知路径修复（system prompt 三处更新）

- `SystemPromptBuilder.MCP_TOOLS_SECTION` 协作工具列表补 `cat_cafe_cross_post_message`，含最小认知路径示例：`list_threads → cross_post_message(threadId, targetCats, content) → get_thread_context 验证`
- **接收侧 reply hint**（team lead motivation evidence 直击点）：检测到当前 invocation 由跨线程消息触发（`extra.crossPost.sourceThreadId` 存在）时，SystemPromptBuilder 注入一段 reply hint：
  - 来源 thread ID
  - 发送猫 catId（句柄）
  - 提示文案："回复请用 `cross_post_message(threadId=<sourceThreadId>, targetCats=[<senderCatId>])`，本 thread 内的 @ 不会路由回对方"
- `MCP_TOOLS_SECTION` 中 `post_message` 描述同步更新，写明 invocation-token / agent-key 两种 principal 下的 threadId 语义（呼应 KD-1）

### Phase C: split-only 配置（含 limb 迁移 KD-2）

按 F043 立项原意改 split-only，但**先解决 limb 迁移**——`registerFullToolset` 注册 limb 工具，split 三 server 不注册（[server-toolsets.ts:127](../../packages/mcp-server/src/server-toolsets.ts)），直接砍 all-in-one 会让 `limb_*` 全员静默掉线。

- 新增 `cat-cafe-limb` server entry point（KD-2 选 A）：导出 `registerLimbToolset` 单 server，配 `dist/limb.js`
- 改两个 harness 配置（不能漏一个）：
  - `.mcp.json` 删 `cat-cafe` (all-in-one) entry，加 `cat-cafe-limb`
  - `.codex/config.toml` 删 `[mcp_servers.cat-cafe]` block，加 `[mcp_servers.cat-cafe-limb]`
- `tool-registration.test.js` 加守护：split-only 模式下 `cat-cafe`(all-in-one) 不存在 + limb 工具集状态符合 KD-2 决议

### Phase D: 废弃工具清理

- 移除 `reflect`（自标 "Currently degraded — use search_evidence instead"）的工具注册
- 移除 `guide_resolve`（自标 "Legacy alias"）
- 删 `.mcp.json` / `.codex/config.toml` 中的 `probe-connected` / `probe-env` / `probe-off` 调试探针

## Acceptance Criteria

### Phase A（KD-1 enforcement）
- [x] AC-A1: `crossPostMessageInputSchema` 补 `targetCats` 字段并在 handler 透传 — commit `7b7ca1b64`
- [x] AC-A2: MCP handler 层 — invocation-token caller 调 `post_message` 传 `threadId` 时 reject，错误消息提示用 `cat_cafe_cross_post_message` — commit `85b94cf00` (impl) + `8fea021f1` (test hotfix LL-054)
- [x] AC-A3: API route 层 — `CallbackPrincipal × threadId × targetCats` 组合校验，按下表 4 格允许/拒绝矩阵；违反 KD-1 时 400 + alternatives — 由 Tasks 2+3 在两层 union 覆盖（API 端点不区分 post vs cross_post tool 来源，所以矩阵的 invocation-token+threadId 拒绝在 MCP handler 层 enforce；API route 层 enforce cross-post 缺 routing 凭证）。

  | Tool × Principal | `threadId` | `targetCats` / 行首 @ | 写入类型 |
  |---|---|---|---|
  | `post_message` × invocation-token | **必省**（传了→reject） | 任一可选（同 thread A2A routing） | 当前 thread write |
  | `post_message` × agent-key (F178) | **必填**（无默认 thread） | 任一可选 | target-thread write，**不是 F052 relay** |
  | `cross_post_message` × invocation-token | **必填** | **二选一必填**（缺 → reject） | F052 cross-thread relay（注入 `extra.crossPost.sourceThreadId`） |
  | `cross_post_message` × agent-key | **必填** | **二选一必填**（缺 → reject） | target-thread notification requiring routing（**不注入** sourceThreadId — 见 KD-1 边界） |
- [x] AC-A4: `cross_post_message` 缺 `targetCats` AND 无行首 @ → reject (400) + alternatives — commit `a5a04e8fe`
- [x] AC-A5: 测试覆盖 principal × threadId × targetCats 全组合矩阵；F052 sourceThreadId 注入仍正确；同名猫跨线程豁免不退化 — commit `55edbe9b4`

### Phase B（认知路径修复）
- [x] AC-B1: `SystemPromptBuilder.MCP_TOOLS_SECTION` 协作工具列表新增 `cat_cafe_cross_post_message` 并附最小认知路径示例 — commit `85a714d03`
- [x] AC-B2: 收到 `extra.crossPost.sourceThreadId` 触发的 invocation，SystemPromptBuilder 自动注入 reply hint。**数据源必须 structured**——按 trigger message id 从 `StoredMessage.extra.crossPost.sourceThreadId` + `StoredMessage.catId` 直接 hydrate，**不得从 prompt 文本解析**。Trigger message id 来源：worklist 路径 `a2aTriggerMessageId` / queue 路径 backfill。typed 字段 `crossThreadReplyHint: { sourceThreadId, senderCatId }` 传给 `buildInvocationContext`。— commits `1d1547376` (typed field + render) + `198bae30b` (worklist hydrate via hydrateCrossThreadReplyHint helper).
- [x] AC-B3: `post_message` 描述更新为 principal-conditioned 语义说明 — commit `85a714d03` (`异步消息（agent-key 才传 threadId）`)
- [x] AC-B4: 测试覆盖 worklist + queue 两条路径 + agent-key boundary — commit `f45bc264e` (4 boundary tests via hydrateCrossThreadReplyHint helper). Queue path covered by Task 3 wiring (callback-a2a-trigger backfills triggerMessageId into worklist; route-serial reads downstream).

### Phase C（split-only 配置 + limb 迁移）
- [x] AC-C1: 新增 `cat-cafe-limb` server entry point（`packages/mcp-server/src/limb.ts` + `dist/limb.js` build artifact）— commit pending PR
- [x] AC-C2 / AC-C3: `.mcp.json` + `.codex/config.toml` migration — **two-track**：
  - **Hub 自动流程（primary）**：`capability-orchestrator.ts` 是 source of truth；`CAT_CAFE_SPLIT_SERVER_IDS` 加入 `cat-cafe-limb`；`buildCatCafeSplitMcpDescriptors` 生成 `dist/limb.js`；`bootstrapCapabilities` 不再添加 all-in-one；`ensureCatCafeMainServer` 语义翻转——splits 存在时 **移除** legacy `cat-cafe` + **补齐** `cat-cafe-limb`（覆盖 3-split→4-split 自动迁移）。每次 `GET /api/capabilities` 由 [`generateCliConfigs`](../../packages/api/src/routes/capabilities.ts) idempotent merge-write 把项目根 `.mcp.json` / `.codex/config.toml` 重写到 4-split + limb 拓扑——Hub 一开 user-local CLI configs 自动迁移 — commit pending PR
  - **手工 diff（fallback）**：`.mcp.json` + `.codex/config.toml` 在 `.gitignore`（user-local，PR 不能 commit user-local diff），但 [Phase C migration guide](assets/F193/F193-phase-C-migration.md) 提供手工 diff 给"不走 Hub flow / 立即修本地 harness"的兜底路径
- [x] AC-C4: `tool-registration.test.js` 守护 `createLimbServer` 只注册 limb tool surface（4 项：`limb_list_available` / `limb_invoke` / `limb_pair_list` / `limb_pair_approve`）— commit pending PR

### Phase D（废弃工具清理）
- [x] AC-D1: 移除 `reflect` 工具注册（含 server-toolsets / tools/index）+ 同步清理 `SystemPromptBuilder.MCP_TOOLS_SECTION` 中 `cat_cafe_reflect: 反思性合成` 这行 + `tool-registration.test.js` 守护 + 删除 `reflect-tools.ts` + `reflect-tools.test.js` + skill 文档无残留 — commit pending PR
- [x] AC-D2: 移除 `guide_resolve` legacy alias + 同步清理 SystemPromptBuilder（确认无引用）+ tool-registration test 守护 + 删除 `handleGuideResolve` handler — commit pending PR
- [x] AC-D3: `.mcp.json` / `.codex/config.toml` 中 `probe-connected` / `probe-env` / `probe-off` — gitignored user-local config，走 [Phase C migration guide](assets/F193/F193-phase-C-migration.md) probe-* 清理段（同 Phase C two-track 模式）— commit pending PR

## 需求点 Checklist

- [ ] **发送侧 enforcement**：F043 #316 防误投契约 + F178 agent-key principal 兼容（KD-1 reconcile）
- [ ] **schema-skill 一致**：`cross_post_message` 补 `targetCats`（消除 skill 文档幻觉接口）
- [ ] **认知路径**：`cross_post_message` 进入 SystemPromptBuilder MCP 工具列表
- [ ] **接收侧 reply hint**：跨线程消息触发的 invocation 自动注入回复路径数据
- [ ] **配置归一**：split-only，limb 迁移到专属 server，两个 harness 配置同步
- [ ] **废弃清理**：reflect / guide_resolve / probe-* 全部下线
- [ ] **测试守护**：principal × threadId × targetCats 矩阵 + reply hint 注入 + tool-registration

## Dependencies

- **Evolved from**: F043（MCP normalization — `post_message` / `cross_post_message` 原始契约的来源；本 feature 恢复 #316 防误投并 reconcile F178）
- **Related**: F052（cross-thread identity isolation — `sourceThreadId` 溯源链路 + 同名猫跨线程豁免，本 feature 接收侧 reply hint 直接消费 F052 后端注入数据）
- **Related**: F178（persistent MCP agent-key auth — agent-key principal 必须显式 `threadId` 的契约由本 feature 在 KD-1 中显式 reconcile）

## Architecture Cell

| 字段 | 值 |
|------|---|
| Architecture cell | `transport` + `callback-auth` |
| Map delta | **update required** |
| Why | `transport` cell：`cross_post_message` 从残废工具升级为一等公民 + 接收侧 reply hint 是新的 transport 路径数据。`callback-auth` cell：principal-conditioned threadId 是 callback 认证边界的新规则。 |

## Risk

| 风险 | 缓解 |
|------|------|
| 改 MCP handler reject 行为可能 break 现有调用模式（猫的旧习惯） | grep 历史调用模式（搜 `post_message.*threadId`）+ reject 错误消息附明确替代指引 + Phase A 单独 PR 灰度 |
| Limb 迁移破坏Ragdoll pair 协作 | tool-registration 测试守护 + KD-2 决议时若选 B（limb 暂不进默认 harness），spec 必须列明用户可见影响 + 回滚预案 |
| 两个 harness 配置改动可能漏一个 | AC-C2 + AC-C3 分开列；merge-gate 检查清单加"两个配置都改了吗" |
| 接收侧 reply hint 数据源错误（从截断 prompt 文本解析 vs structured `StoredMessage`） | AC-B2 已显式约束 — 必须按 trigger message id 从 `StoredMessage.extra.crossPost` + `StoredMessage.catId` hydrate；测试覆盖 worklist + queue 两条 a2aTriggerMessageId 路径 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | **Principal-conditioned threadId semantics**（含 cross-thread relay 边界）：见 AC-A3 4 格允许/拒绝矩阵。两层 enforcement（MCP handler + API route）。**关键边界**：F052 cross-thread relay 语义（注入 `extra.crossPost.sourceThreadId` + 同名猫跨线程豁免 + 接收侧 reply hint）**只对 invocation-token 调用 `cross_post_message` 生效**。agent-key `post_message(threadId)` 是 target-thread write 而非 relay，**不注入** sourceThreadId（[callbacks.ts:430](../../packages/api/src/routes/callbacks.ts) 当前 agent-key 路径只写 richExtra + targetCatsExtra，不带 crossPost metadata，本 spec 维持此边界）。agent-key `cross_post_message` 定义为"target-thread notification requiring routing"——必填 targetCats/行首 @，但**不**与 invocation-token relay 共享 sourceThreadId / reply hint 链路。reject 优于 silent strip：silent strip 会丢 F052 sourceThreadId 溯源 + 同名猫跨线程豁免。 | F043/F178/F052 三契约 reconcile，证据齐全。Agent-key 无 source thread 概念——把 relay 语义投射给它会引入幽灵 sourceThreadId，违反 F052 设计前提。 | 2026-05-07 |
| KD-2 | **Limb tool harness placement** — **选项 A**：新增 `cat-cafe-limb` server entry point（独立 server，按需加载）。备选 B（暂不进默认 harness）/ C（合并到 collab）已拒绝。 | 三猫审计 + review 一致选 A：A 最小破坏现有 split-only 设计意图（F043 立项原意），limb 是Ragdoll专属能力，独立 server 更符合 F041 配置编排"按猫加载"模型；B 弱化默认 harness 能力；C 把 limb 边界塞进 collab 不清晰。 | 2026-05-07 |

## Review Gate

- Phase A: 跨家族 review（Maine Coon已声明 review 责任）+ 云端 codex review
- Phase B: 跨家族 review（Maine Coon）+ 接收侧 reply hint 由Siamese做 UX 文案审视（猫看到 reply hint 会不会困惑？）
- Phase C: 跨家族 review（Maine Coon）+ tool-registration 测试守护必须通过
- Phase D: 跨家族 review（Maine Coon）

## Close Gate Report

```yaml
close_gate_report:
  feature_id: F193
  spec_path: docs/features/F193-cross-thread-comm-unification.md
  head_sha: 0697335fe
  report_date: 2026-05-09

  ac_matrix:
    - { ac_id: AC-A1, status: met, evidence: [{ kind: commit, ref: "7b7ca1b64", description: "crossPostMessageInputSchema 补 targetCats" }] }
    - { ac_id: AC-A2, status: met, evidence: [{ kind: commit, ref: "85b94cf00" }, { kind: commit, ref: "8fea021f1", description: "LL-054 hotfix" }] }
    - { ac_id: AC-A3, status: met, evidence: [{ kind: doc, ref: "F193 spec Tasks 2+3 union 覆盖", description: "API route cross-post 缺凭证 + MCP handler invocation+threadId reject 两层 enforce" }] }
    - { ac_id: AC-A4, status: met, evidence: [{ kind: commit, ref: "a5a04e8fe", description: "cross_post_message 缺 targetCats+无行首@ → 400+alternatives" }] }
    - { ac_id: AC-A5, status: met, evidence: [{ kind: commit, ref: "55edbe9b4", description: "principal × threadId × targetCats 矩阵 + sourceThreadId + 同名猫豁免测试" }] }
    - { ac_id: AC-B1, status: met, evidence: [{ kind: commit, ref: "85a714d03", description: "SystemPromptBuilder MCP 工具列表加 cross_post_message" }] }
    - { ac_id: AC-B2, status: met, evidence: [{ kind: commit, ref: "1d1547376" }, { kind: commit, ref: "198bae30b", description: "typed crossThreadReplyHint + worklist hydrate" }] }
    - { ac_id: AC-B3, status: met, evidence: [{ kind: commit, ref: "85a714d03", description: "post_message 描述 principal-conditioned 语义" }] }
    - { ac_id: AC-B4, status: met, evidence: [{ kind: commit, ref: "f45bc264e", description: "worklist+queue+agent-key boundary 4 boundary tests" }] }
    - { ac_id: AC-C1, status: met, evidence: [{ kind: pr, ref: "#1605", description: "limb.ts entry point + dist/limb.js" }] }
    - { ac_id: AC-C2-C3, status: met, evidence: [{ kind: pr, ref: "#1605", description: "two-track migration: capability-orchestrator auto + manual diff fallback" }] }
    - { ac_id: AC-C4, status: met, evidence: [{ kind: pr, ref: "#1605", description: "tool-registration.test.js createLimbServer 4 limb tools 守护" }] }
    - { ac_id: AC-D1, status: met, evidence: [{ kind: pr, ref: "#1613", description: "cat_cafe_reflect 完整下线: server-toolsets + tools/index + SystemPromptBuilder + 文件删除" }] }
    - { ac_id: AC-D2, status: met, evidence: [{ kind: pr, ref: "#1613", description: "cat_cafe_guide_resolve schema + handler 删除" }] }
    - { ac_id: AC-D3, status: met, evidence: [{ kind: pr, ref: "#1613", description: "F193-phase-C-migration.md probe-* 清理段（含 .mcp.json + .codex/config.toml .diff snippets）" }] }

  unmet: []
  follow_ups: []
  notes: |
    Narrower fix scope decisions（不在 AC 内 unmet，是显式 design choice）:
    - API 路由 /api/reflect, /api/callbacks/reflect, /api/callbacks/guide-resolve
      保留: MCP 工具下线后无调用方，但 endpoint 自身保留以避免连带破坏。
    - callback-memory-tools.ts handleCallbackReflect helper 保留:
      callback-tools.test.js 有覆盖，Maine Coon review 同意。
```
