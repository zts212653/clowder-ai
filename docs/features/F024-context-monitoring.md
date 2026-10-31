---
feature_ids: [F024]
related_features: []
topics: [context, monitoring]
doc_kind: note
created: 2026-02-26
tips_exempt: "2026-09-28 F324 A/B: bounded self-session reads, exact continuations, and corrected permission wording repair the existing cat-side MCP surface; they add no user-invokable action."
---

# F024: 中途消息注入 + Context 存活监控 + 自动交接

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26

## Why
- operator 2026-02-13

## What
- **F24**: 三个子能力全部完成：(1) 中途消息注入 [x]：4e85883 ChatInputActionButton 改为 hasActiveInvocation 时同时展示 Stop + Send 按钮。(2) Context 存活监控 [x]：fcf949d SessionChainPanel + ContextHealthBar。(3) 自动交接触发 [x]：3772cd9 SessionSealer + per-cat seal thresholds + hook 注入。

### 2026-09-27 Session Chain 读侧修复（F324 Phase A）

MCP 的 session list 使用现有 session chain 的 `limit/offset` 页；原始 transcript 以真实 `eventNo` 续页，单条超大事件以同一 eventNo 的 `charOffset` 读取完整 JSON。chat 视图携带源 eventNo，handoff 过大时指向 exact invocation；invocation detail 按 eventNo 续页，digest 按字符续读。原 session 文件和授权检查不变，省略无续读能力时必须显式说明。回归：`session-chain-route.test.js`、`f98-route-inject.test.js` 与 `session-chain-tools.test.js` 的 F324 用例。

MCP caller 的 `catId` 只允许省略或显式写当前认证猫；它不是 peer session 选择器。其他猫的 raw session 即使位于 owner 可见 thread 也继续返回 403，合法取证使用共享 thread 消息或已有 owner-approved evidence。工具 schema/description 必须直说这条边界，不再把“任意注册 catId”写成可用能力。

Architecture cell: `identity-session`; Map delta: none. Why: session 文件、原 reader 和 thread access policy 保留 authority。Canonical source: `packages/api/src/domains/cats/services/session/TranscriptReader.ts#readEvents` 与 `packages/api/src/routes/session-transcript.ts#sessionTranscriptRoutes`。Consumer evidence: `rg -n "readEvents\\(|readEventsHandoff|formatEventsChat|handleReadSessionEvents" packages/api/src packages/mcp-server/src`。Claim guard: “有界返回可由真实 eventNo/charOffset 读回且不越权” → `f98-route-inject.test.js` 的 F324 raw/chat/handoff/invocation/digest 用例，及 `session-chain-tools.test.js` 的 MCP 页界。

## Acceptance Criteria
- [x] AC-A1: 本文档已补齐模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

## Key Decisions
- 历史记录未单列关键决策

## Dependencies
- **Related**: 无
- 无显式依赖声明

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
