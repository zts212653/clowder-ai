---
feature_ids: [F159]
related_features: [F143, F149, F153]
topics: [provider, agent-runtime, api-path, architecture, security, community]
doc_kind: spec
created: 2026-04-11
community_issue: "zts212653/clowder-ai#434"
---

# F159: CatAgent Native Provider — Opt-in API Path

> **Status**: in-progress | **Owner**: 社区 (bouillipx) + Ragdoll + Maine Coon | **Priority**: P1

## Why

社区在 `clowder-ai#397` 中提交了一个 CatAgent 薄运行时 spike，试图用 Anthropic API 直连方式提供一条 opt-in agent path。maintainer review 已经确认这条 PR 不能直接合入：原实现同时混杂了架构层级漂移、account-binding 绕过、workspace 边界不严、以及 ADR-001 未闭环等问题。

但 `clowder-ai#434` RFC 也证明了另一个事实：如果把这件事重新表述为 **F143 宿主抽象下的 native provider**，而不是“平台再造一套独立 runtime”，那么它就不再是错误方向，而是一个值得单独立项、逐步收敛的产品能力。

因此 F159 的目标不是“重启 #397”，而是把这条社区方向收敛成一个**受约束的 first-party provider feature**：CLI 仍是默认主路径，CatAgent 只作为 opt-in API path 存在，并且必须先满足宿主层安全边界和治理约束。

## What

### Phase A: RFC 收敛 + ADR 边界

把 `clowder-ai#434` 从“讨论概念”收敛成可以进入实现的正式提案：

1. 明确定位：CatAgent 是 **F143 下的 native provider**，不是独立 runtime
2. 明确与 F143 / F149 / F050 的边界
3. 修订 ADR-001，定义 opt-in API path 的允许边界、成本模型、权限约束
4. 在真相源中分配正式 feature 编号并与社区 issue 双向链接

### Phase B: Host Integration + Security Baseline

先把宿主层必须兜住的硬边界补齐，再谈 provider 能力：

1. **Account-binding fail-closed**：凭据解析必须走现有绑定链路，不允许扫描任意 API key
2. **Symlink-safe workspace boundary**：文件边界复用共享 helper，不允许 provider 各写一套词法校验
3. **Injection prevention**：工具参数和命令拼接必须在 host/provider integration layer 做强约束
4. **Audit terminal state**：provider 的 `done/error/usage` 信号必须稳定进入现有审计链

### Phase C: Minimal Native Provider

在 Phase B 全绿后，才允许交付最小可用的 CatAgent provider：

1. 以 opt-in 方式注册到 provider registry，不改变默认路由
2. 支持单轮文本任务、session 标识、abort、done metadata
3. 不开放 write/exec/跨线程副作用工具
4. 保持 northbound 接口不变，仍通过宿主层 façade 对上提供能力

### Phase D: Read-Only Tools + Compaction Follow-up

只有当最小 provider 稳定后，才考虑扩展 provider 内部能力：

1. read-only tool surface（前提是宿主层权限边界已复用）
2. context compaction / microcompact 是否保留，由实测结果决定
3. provider 内部 loop/tools/compact 只作为实现细节存在，不得反向污染 Cat Cafe 控制面

### Phase E: SSE Streaming + Fail-Closed Turn Handling

在 Phase D 的 agentic loop 基础上，把 CatAgent 的 API 调用从整轮 JSON 响应升级为逐事件 SSE streaming：

1. 文本 token 按 chunk 实时产出到上游 `type: 'text'` 事件
2. `tool_use` block 按 block index 收集、重建完整 assistant content，再进入下一轮工具执行
3. usage 从 `message_start` / `message_delta` 提取，done 事件携带累计 token usage
4. stream EOF / missing `message_stop` / unclosed content block / orphan `tool_use` 全部走 **strict streaming fail-closed**
5. 不引入 `@anthropic-ai/sdk`，继续保持 raw `fetch` + 本地 parser 的 provider-owned 实现边界

## Acceptance Criteria

### Phase A（RFC 收敛 + ADR 边界）
- [ ] AC-A1: `clowder-ai#434` 标题/正文完成定位修正，统一使用 “native provider / opt-in API path” 口径
- [ ] AC-A2: ADR-001 修订草案落盘，明确 CLI 仍是默认主路径，API path 仅为 opt-in
- [ ] AC-A3: F143 / F149 / F050 边界写入 spec/RFC，不再混成“另一套 runtime”
- [ ] AC-A4: 正式 feature 编号分配完成，cat-cafe 真相源与社区 issue 双向链接

### Phase B（Host Integration + Security Baseline）
- [ ] AC-B1: CatAgent 凭据解析复用现有 account-binding 链路（`resolveBoundAccountRefForCat -> resolveForClient`），不存在任意 key 扫描 fallback
- [ ] AC-B2: workspace 边界复用共享安全 helper，symlink 场景有回归测试
- [ ] AC-B3: 工具参数注入防护在 host/provider integration layer 落地，有针对性测试
- [ ] AC-B4: provider 的 `done/error/usage` 终态审计在现有链路中可验证

### Phase C（Minimal Native Provider）
- [ ] AC-C1: provider 以 opt-in 方式注册，不改变现有默认 provider 选择语义
- [ ] AC-C2: 单轮文本任务可端到端执行，并正确产出 `session_init/text/error/done`
- [ ] AC-C3: abort / timeout / error 情况下无悬挂 session 或缺失终态
- [ ] AC-C4: v1 不开放 write/exec/跨线程副作用工具

### Phase D（Read-Only Tools + Compaction Follow-up）
- [ ] AC-D1: read-only tools 只有在宿主层权限边界复用完成后才开放
- [ ] AC-D2: compact/microcompact 若保留，必须证明不会破坏身份约束和审计链

### Phase E（SSE Streaming + Fail-Closed Turn Handling）
- [x] AC-E1: text tokens 按 chunk 产出到上游（每个 `text_delta` → 一个 `type: 'text'` AgentMessage）
- [x] AC-E2: `tool_use` blocks 按 index 收集后执行；完整 assistant content（text + tool_use）按顺序写回消息历史
- [x] AC-E3: usage 从 stream events 提取（input 来自 `message_start`，output 来自 `message_delta` 快照），最终 `done` 携带累计 usage
- [x] AC-E4: stream error / disconnect / missing `message_stop` / unclosed block → `error + done`；第一轮错误保留 zero-usage 契约；orphan `tool_use` 发 failed `tool_result`
- [x] AC-E5: strict streaming fail-closed —— 不做 non-streaming fallback；任意 stream error 直接终止并产出终态

## 需求点 Checklist

| ID | 需求点（社区原话/转述） | AC 编号 | 验证方式 | 状态 |
|----|-------------------------|---------|----------|------|
| R1 | “继续探索 CatAgent，但不要回到 #397 的实现形态” | AC-A1, AC-A3 | RFC/Spec 对照检查 | [ ] |
| R2 | “给这个方向一个正式 feature 编号” | AC-A4 | spec + BACKLOG + issue 链接 | [ ] |
| R3 | “API path 只作为 opt-in，不改变默认主路径” | AC-A2, AC-C1 | ADR + 配置验证 | [ ] |
| R4 | “安全三项是硬 gate，不是 backlog” | AC-B1, AC-B2, AC-B3 | 测试 + review 记录 | [ ] |
| R5 | “如果要做，就按 provider 能力逐步推进” | AC-C2, AC-C4, AC-D1, AC-E1, AC-E4 | phased implementation review | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（若适用）

## Dependencies

- **Evolved from**: F143（native provider 的宿主契约来自 F143）
- **Related**: F149（runtime ops 经验输入，但 CatAgent 不复用 ACP carrier 模型）
- **Related**: F153（provider usage / audit / observability 能力复用）

## Risk

| 风险 | 缓解 |
|------|------|
| 再次把 provider 做成“平台内第二套 runtime” | Phase A 先收敛定位，title/body/spec 全部统一口径 |
| provider 自己重写安全边界，导致宿主层失血 | 安全三项全部上提到 host/provider integration layer |
| API path 模糊化后冲击 CLI 默认路线 | ADR-001 明确 opt-in only，默认路径不变 |
| 一次性把 loop/tools/compact 全塞进首版实现 | 强制分 Phase，先最小 provider，再扩 read-only tools |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 以 “CatAgent Native Provider” 立项，不再使用 “Thin Runtime” 作为正式 feature 名称 | 避免架构层级误导 | 2026-04-11 |
| KD-2 | API path 为 opt-in only，CLI 仍是默认主路径 | 维持 ADR-001 主决策稳定性 | 2026-04-11 |
| KD-3 | account-binding / workspace boundary / injection prevention 全部视为 host/provider integration layer 的硬边界 | 安全边界不能下沉成 provider 自行约定 | 2026-04-11 |
| KD-4 | `feat/catagent` 分支只作为 spike 参考，不作为可直接 merge 的实现分支 | #397 已被定性为 architecture-blocked spike | 2026-04-11 |
| KD-5 | 为该方向分配正式 feature 编号 F159 | 这是独立、用户可感知的新 provider 能力，不是 F143/F149/F050 的纯子任务 | 2026-04-11 |
| KD-6 | Phase E 采用 strict streaming fail-closed，不保留 conditional non-streaming fallback | 当前 provider path 更需要清晰审计边界与确定性终态，而不是条件重试复杂度 | 2026-04-24 |

## Review Gate

- Phase A: Ragdoll + Maine Coon架构 review → team lead拍板
- Phase B-E: 跨 family review
