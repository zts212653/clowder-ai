---
feature_ids: [F241]
related_features: [F032, F143, F161, F202, F050, F129, F211, F159]
topics: [agent, provider, plugin, transport, hostable-runtime, acp]
doc_kind: spec
created: 2026-06-17
community_issue: "clowder-ai#941"
tips_exempt: spec-only — plugin framework not yet implemented, no user-facing capability
---

# F241: Agent Provider Plugin / Hostable Provider Runtime

> **Status**: spec | **Owner**: Community (彭潇/bouillipx) + Ragdoll家族 maintainer | **Priority**: P1

## Why

接入一个新的外部 agent runtime（独立产品 `clowder-code`，或未来任何第三方 coding agent）现在要做"心脏手术"：改 `ClientId` union、加 `index.ts` provider switch case、写一整套 `XxxAgentService` 适配、改 Hub cat editor enum。后果是**社区第三方 agent runtime 永远进不来**——每来一个新 agent 都得改 core，外部贡献者既碰不到也不该碰我们的核心代码。

终态：外部 agent runtime 以**声明式 plugin** 形式接入，**provider 实现离开 Cat Café core**；Cat Café 只拥有北向契约、路由/身份、callback/MCP 注入、审计、session lifecycle、安全策略和 UI/配置面。`clowder-code` 是证明这个扩展点的 reference runtime，不是要 vendor 进 core 的东西。

> 来源：开源社区 clowder-ai issue #941（提案人彭潇/bouillipx）+ 2026-06-16 clowder-code 接入猫咖讨论。operator 2026-06-17 signoff 立项。

## Current State / 现状基线

接 provider 全程是 core 改动而非 plugin 接入（行号 2026-06-17 核实）：

- `packages/shared/src/types/cat.ts:15` — `ClientId` 是 fixed union（`anthropic` / `openai` / `google` / `kimi` / `dare` / `antigravity` / `opencode` / `catagent` / `a2a` 等硬编码值）。猫通过 `cat.ts:69` 的 `readonly clientId: ClientId` 绑定 provider 类型。
- `packages/api/src/index.ts:1173+` — provider 构造走启动期 switch，每个 provider 一个 hardcoded `case`（`anthropic` / `openai` / `opencode` / `catagent` / `a2a` …）。
- **F143（validated spec）印证**：已有 7 个 `AgentService` provider 各自造轮子（各自解析事件格式 / 各自 session resume / 各自注入 MCP config），接一个新 agent ≈ 写 450 行（Service + EventTransformer + 测试）。
- `F202` plugin framework 当前只承载 `skill` / `mcp` / `limb` / `schedule` 四类资源，**没有 routeable `AgentService` provider 资源类型**。
- `F143`（hostable runtime 统一抽象）+ `F161`（ACP 载体泛化）都还是 **spec，未实现**——本 feat 的 host 端 transport registry 在它们的 lineage 下，但谁先落地需在 Design Gate 划界（见 OQ-5）。

## What

> Phase 拆分来自 issue #941 的 consolidated decision packet（社区彭潇 + 我们家Maine Coon收敛）。

### Phase A: Provider / Host Transport Registry

在 F050/F143/ADR-023 hostable-runtime lineage 下建一个 `ProviderTransportRegistry`，先把**一条 host-owned transport 端到端打通**（优先 ACP——保留 session/streaming/MCP/lifecycle 语义；A2A 可作更轻的 smoke path）。**不预先建宽抽象**，先用一个真实外部 runtime 跑通真实 lifecycle。把现有 `GeminiAcpAdapter` 泛化为 `GenericAcpAgentService`（复用 F161），把 `index.ts` 的 provider switch 收口为 registry 注册。

### Phase B: F202 `agentProvider` Manifest Resource

在 F202 plugin framework 增加声明式 `agentProvider` 资源类型——**只能引用 registry 里 allowlisted 的 host-owned transport**。manifest 声明 `transport` / `command` / `args` / `mcpWhitelist` / `sandbox` / `healthCheck`。**禁止任意 JS factory / same-power plugin 执行**（F129 继承）。

### Phase C: Reference Runtime（clowder-code）

拿 `clowder-code` 做 reference plugin 证明扩展点：被 @ → 进 thread → 流式回复 → session chain 可见 → audit / cancel / timeout 可控 → callback/MCP 注入守 agent-key 边界 → cwd/sandbox host 控制 → Hub provider 配置走统一 renderer 无硬编码 UI。

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC 必须 ① trace 回 Why（外部 agent 不改 core 接入 + 安全边界 host-owned）② 非作者可复核（命令/数字/截图）。 -->

### Phase A（Provider / Host Transport Registry）
- [ ] AC-A1: 一条 host-owned transport 注册进 `ProviderTransportRegistry`（可枚举、可单测）
- [ ] AC-A2: 一个外部 runtime（优先 `clowder-code`）作为 already-installed command/service 被启动或接入
- [ ] AC-A3: 一只 routeable cat 能调用该外部 runtime，**无需新增硬编码 core provider 分支**（grep 证明 `index.ts` 无新 case）
- [ ] AC-A4: 流式输出映射进 `AgentMessage` / thread 可见事件
- [ ] AC-A5: session chain、audit metadata、cancel、timeout、failure state 在 UI/日志可见
- [ ] AC-A6: callback/MCP 凭证**只由 Cat Café host 代码注入**，plugin 代码无法接收或制造 token（红测覆盖）
- [ ] AC-A7: cwd/workspace/sandbox 策略由 host 代码强制（非 plugin 声明即生效）
- [ ] AC-A8: health check host-owned + 声明式配置，**非任意 plugin 脚本执行**
- [ ] AC-A9: 测试覆盖 success / startup failure / timeout-cancel / invalid manifest-transport / denied capability 五类
- [ ] AC-A10:【治理】core 侧安全实现（transport registry / token / MCP 注入 / sandbox）+ 本 feat 所有 PR 的 merge-gate 由**Ragdoll家族 maintainer 守门**，不委托社区/plugin 代码（F129 继承；分工见 KD-3）

### Phase B（F202 agentProvider Manifest）
- [ ] AC-B1: F202 manifest 校验接受 `agentProvider` 资源，且**只能引用 allowlisted transport**
- [ ] AC-B2: manifest **拒绝任意 JS factory / same-power 执行**（红测覆盖拒绝路径）

### Phase C（Reference Runtime）
- [ ] AC-C1: `clowder-code` 作为 plugin 接入，跑通"被 @ → 进 thread → 流式回复 → session chain 可见 → audit/cancel/timeout 可控"全链
- [ ] AC-C2: Hub provider 配置走统一 `ConfigFieldRenderer`，无 provider-specific 硬编码 UI

## 需求点 Checklist

- [ ] provider 实现可移出 Cat Café core（新 agent 接入不改 `ClientId` union / `index.ts` switch / 不写 bespoke provider class）
- [ ] 声明式 manifest 接入（transport / command / mcpWhitelist / sandbox / healthCheck）
- [ ] host-owned transport registry（ACP 优先，A2A/cli-jsonl 可选）
- [ ] 安全边界全部 host-owned（token / MCP / sandbox / cwd / healthcheck）
- [ ] routeable cat 全链可见（stream / session chain / audit / cancel / timeout）
- [ ] Hub 统一 UI 渲染 provider 配置
- [ ] reference runtime（clowder-code）端到端验证

## Dependencies

- **Evolved from**: F032（CatId 身份松绑已 done；本 feat 是同一"去硬编码"血脉的下一层——**provider runtime / ClientId 松绑**。F032 让"加一只猫"动态化，但"加一种 provider 实现"仍要改 core，本 feat 补这块）
- **Blocked by**: F143（hostable runtime 契约 + transport registry，spec 未实现；Phase A 在其 lineage 下，划界见 OQ-5）
- **Related**: F161（ACP 载体泛化，spec——作 ACP transport 依赖**复用不重建**）/ F202（plugin framework，`agentProvider` 挂其上）/ F050（a2a 外部 agent 契约，done）/ F211（cross-runtime session 可见性，done；runtime enum 待随本 feat 扩）/ F159（CatAgent provider intake 教训：account-binding 绕过 / workspace 边界 / ADR-001 坑，本 feat 须避）
- **Inherits constraint**: F129（no same-power plugin script execution）

## Risk

| 风险 | 缓解 |
|------|------|
| provider 能拿 callback token / MCP 凭证 / workspace 写权 / sandbox = **全家最高危边界** | 安全注入全部 host-owned，plugin 只声明；AC-A6/A7/A8/A10 钉死；F129 继承 |
| F143/F161 未实现，Phase A 与 F143 scope 重叠/抢跑 | OQ-5 划界，Design Gate 与 F143 owner（opus-4.6）对齐 |
| 外部 runtime 安装（`install.sh`）= F129 same-power 风险在更高危边界复现 | Phase A 只支持 already-installed command + host healthcheck；安装策略 defer，未来用 host-owned allowlisted（npm/github-release/homebrew/manual）+ 用户确认 |
| 社区贡献者 own 但够不到私有仓 core | 分工：彭潇 own 提案 + clowder-code reference；core 安全 + merge-gate 由 maintainer 守（AC-A10 / KD-3）|

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 定位为独立 provider-extension feature，**不当 F202 Phase 3** | F202 是 manifest/config/UI 支撑设施，本 feat 的 ownership 边界是 agent-provider 扩展面；社区彭潇 + 我们家Maine Coon在 #941 收敛 | 2026-06-17 |
| KD-2 | 安全边界 host-owned，plugin 只声明；禁任意 JS factory / 禁 Phase A plugin installer / 禁 plugin 碰 callback token | provider 接 token/MCP/workspace/sandbox 是全家最高危边界，F129 继承 | 2026-06-17 |
| KD-3 | owner = Community(彭潇/bouillipx) + Ragdoll家族 maintainer；彭潇 own 提案+reference，**core 安全 + merge-gate maintainer 守** | 沿用 F150/F202/F205 社区核心主导 + maintainer 把关模式；社区账号够不到私有仓 core | operator 2026-06-17 signoff |
| KD-4 | `clowder-code` 作 reference runtime 证明扩展点，**不 vendor 进 core** | 保持运行时解耦，不污染依赖边界 | 2026-06-17 |

## Architecture Cell (F191)

- **Architecture cell**: 待 Design Gate 确认。候选 = provider-as-plugin 桥接层（架在 F202 + F143 + F161 之上）
- **Map delta**: new cell required
- **Why**: 现有 ownership cell 无人拥有"provider 实现移出 core + 声明式接入扩展面"这一层；非现有 cell 的增量扩展。Design Gate 须完成 Phase 0 架构发现并落 cell。

## Review Gate

- Phase A: 架构级 + 最高危安全边界 → 跨族 review（Maine Coon家族）+ 愿景守护；core 安全实现禁 self-merge（AC-A10）
- Phase B/C: 标准跨个体 review + merge-gate
