---
feature_ids: [F189]
related_features: [F161, F156, F178]
topics: [runtime, trust-boundary, carrier, context]
doc_kind: spec
created: 2026-05-06
---

# F189: Operation Context Unification — 操作上下文单点化

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P2

## Why

GBrain teardown 教训：同一个操作走 HTTP / MCP / CLI / A2A 时，权限、localOnly、callbackAuth、thread/invocation context 由各 route 自己拼，没有统一的 `OperationContext` builder。

现状：`req.query`、`session.context`、`invocationMeta`、`callbackAuth` 各自拿一部分上下文，调用链深了每一层都要"凑"出完整上下文。F186 MCP dimension parity bug 就是这个问题的具体表现——MCP schema 和 HTTP query params 不同步，因为它们各自独立拼参数。

核心问题：多载体不统一 → parity bug + trust boundary 不一致 + 每次加新参数都要 HTTP/MCP 两边改。

## What

### Phase A: OperationContext Schema + Builder

定义统一的 `OperationContext` 接口：caller identity / thread / invocation / permissions / carrier type / trust level。

在 HTTP middleware + MCP handler + A2A dispatcher 的入口各写一个 builder，构造同一个 `OperationContext` 对象，后续中间件和 domain 层只消费这个对象。

### Phase B: 各域消费迁移

逐步把分散的 `req.query.xxx` / `session.context.yyy` / `invocationMeta.zzz` 替换为 `ctx.operationContext.xxx`。

## Acceptance Criteria

### Phase A（Schema + Builder）
- [ ] AC-A1: `OperationContext` 接口定义（caller / thread / invocation / permissions / carrier / trustLevel）
- [ ] AC-A2: HTTP middleware 入口构造 `OperationContext`
- [ ] AC-A3: MCP handler 入口构造 `OperationContext`
- [ ] AC-A4: A2A dispatcher 入口构造 `OperationContext`
- [ ] AC-A5: 任何 carrier 构造的 `OperationContext` 通过同一组 trust boundary 校验

### Phase B（消费迁移）
- [ ] AC-B1: evidence search 使用 `OperationContext` 而非直接读 req/session
- [ ] AC-B2: MCP tool handler 使用 `OperationContext` 而非直接拼 URL params
- [ ] AC-B3: 新增 API 参数时只需改 `OperationContext` schema，各 carrier builder 自动传播

## Deferred / Non-goals

以下明确暂不做，附触发条件：

| 项 | 理由 | 触发条件（何时重新考虑） |
|----|------|------------------------|
| Phase A 迁移所有消费方 | Phase A 只建 schema/builder/trust guard，不改调用方 | Phase B 专门做消费迁移 |
| 与 F161 ACP Carrier Generalization 合并实施 | 两者互补但独立可推进（OQ-2 未定） | Design Gate 重新评估决定合并时 |
| 破坏性 route rewrite（一次性全量替换旧写法） | 渐进迁移更安全，lint rule 逐步禁旧写法 | 旧写法 route 降到 ≤5 个时考虑一刀切 |
| CLI carrier 纳入 OperationContext builder | 本地 invoke-single-cat 场景（OQ-1 未定） | 本地调用出现 trust boundary 不一致 bug 时 |

## Dependencies

- **Related**: F161（ACP Carrier Generalization — 载体抽象层，互补）
- **Related**: F156（Security Hardening — trust boundary 加固）
- **Related**: F178（Persistent MCP Agent-Key Auth — MCP 权限模型）

## Risk

| 风险 | 缓解 |
|------|------|
| 迁移范围大，改动面广 | Phase A 只建 builder + schema，不改消费方；Phase B 逐模块迁移 |
| 向后兼容：旧 route 还在直接读 req | 过渡期两种方式共存，lint rule 逐步禁旧写法 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不塞进 F188 Library Stewardship | 横跨 HTTP/MCP/CLI/A2A 全载体，是运行时基础设施问题，不是图书馆问题 | 2026-05-06 |
| KD-2 | 现在立项但不急于实施，等下次触发 | 触发条件：再出 MCP/HTTP parity bug、或新能力需统一 caller identity | 2026-05-06 |
