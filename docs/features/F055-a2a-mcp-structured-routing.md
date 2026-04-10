---
feature_ids: [F055]
related_features: [F050, F046, F042]
topics: [a2a, mcp, routing, targetCats, structured-output]
doc_kind: spec
created: 2026-03-04
---

# F055: A2A MCP Structured Routing（结构化路由 + targetCats）

> **Status**: spec | **Owner**: Ragdoll (Opus 4.6)
> **Created**: 2026-03-04

## Why

猫猫们在 CLI 文本里写 `@队友` 的格式经常出错（行中 @、忘记换行、冒号后紧跟 @），导致 A2A 路由失败，team lead变成人工转发站。

**根因**：CLI 纯文本输出是自由格式，@ mention 靠文本解析是软约束，模型生成惯性导致格式不遵守。

**team experience**：
> "你们真的很不喜欢好好 at"
> "现在有个问题就是很容易不自己 at 自己的队友导致 a2a 链条断掉"
> "之前一直要用 cli @ 其他猫是因为 codex 和 gemini 是 http callback 导致你们行为不统一...但是我们后续统一了 mcp 了，那其实我们直接不允许 cli at，一定是调用 mcp"
> "主回复的 callback 里加 targetCats 字段，让它是一个动作"

## What

将 A2A 路由信号从「CLI 文本解析 @mention」迁移到「结构化 MCP 字段」，消除格式依赖。

### 核心改动

1. **Callback schema 加 `targetCats` 字段**
   - `post-message` callback response 新增可选字段 `targetCats: CatId[]`
   - 空数组或不传 = 纯回复不路由
   - 多猫用数组：`targetCats: ["codex", "gemini"]`

2. **路由优先级**
   ```
   第一层：targetCats 结构化字段（MCP 声明，最可靠）
   第二层：行首 @ 文本解析（过渡期 fallback，最终可移除）
   ```
   - Phase 1: 双通道并存，取并集
   - Phase 2: 文本 @ 解析降级为 fallback（仅在 targetCats 为空时启用）
   - Phase 3: 移除文本解析（待观察稳定后）

3. **A2A 提示词更新**
   - 不再教"行首写 @猫名"
   - 改为教"在回调中声明 targetCats 字段"
   - 对 Claude 猫：通过 MCP 工具 schema 强制结构化
   - 对 Codex/Gemini：HTTP callback JSON schema 同样强制

4. **可见性规则（不变）**
   - `targetCats` 只是路由信号（谁下一个回复），不是访问控制
   - 消息可见性由 thread participation + mode 决定
   - debug 模式：thread 所有历史消息可见
   - play 模式：只看到 session chain 上下文

### 不做的事

- 不改消息存储结构
- 不改 thread participation 逻辑
- 不做 7B 意图识别（成本高、CJK 准确率不够、双通道已够兜底）

### 相关改进（#417）

- 协议明确区分：inline `@xx` = semantic only，line-start `@xx` = actionable handoff
- `callback-tools.ts` post_message 描述已统一为"行首 @猫名"，避免误导
- `detectInlineActionMentions()` 补上 write-side feedback，句中 action-like @ 不再静默丢弃

---

## Acceptance Criteria

- [ ] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [ ] AC-1: `post-message` callback schema 支持 `targetCats?: CatId[]`
- [ ] AC-2: `targetCats` 非空时直接路由，不再依赖文本解析
- [ ] AC-3: `targetCats` 为空时 fallback 到行首 @ 文本解析（Phase 1 兼容）
- [ ] AC-4: A2A 提示词更新，教猫猫用结构化字段
- [ ] AC-5: Claude / Codex / Gemini 三条路径行为一致
- [ ] AC-6: 消息可见性不变（debug=全量, play=chain scope）
- [ ] AC-7: 现有 A2A 回归测试不红（兼容旧文本 @ 模式）

---

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "主回复的 callback 里加 targetCats 字段，让它是一个动作" | AC-1, AC-2 | test: callback + routing | [ ] |
| R2 | "不允许 cli at 一定是调用 mcp" | AC-4, AC-5 | test: prompt content + callback integration | [ ] |
| R3 | "at 猫A 但猫BCD也应该能收到...debug 下看见 play 下不看见" | AC-6 | test: thread visibility by mode | [ ] |
| R4 | "list 字段" — 支持多猫 | AC-1 | test: targetCats with multiple cats | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（若适用）

---

## Key Decisions

| # | 决策 | 理由 |
|---|------|------|
| D1 | targetCats 是路由信号，不是可见性控制 | team lead确认 debug/play 可见性逻辑不变 |
| D2 | 双通道取并集（Phase 1），逐步移除文本解析 | 平滑过渡，不破坏现有流程 |
| D3 | 不做 7B 意图识别 | CJK 准确率不够 + 结构化字段已解决根因 |
| D4 | targetCats 放在 callback response，不是独立 MCP 调用 | team lead确认"一个动作"体验更好 |

---

## Dependencies

- **Evolved from** F050: callback 协议定义
- **Blocked by**: 无

---

## Risk

| 风险 | 缓解 |
|------|------|
| Claude CLI `-p` 模式下 function calling 不稳定 | Phase 1 保留文本 fallback |
| 旧版 runtime 猫猫不支持新字段 | 字段可选，向后兼容 |
| 提示词更新后猫猫仍用旧方式 | 双通道并存，不丢路由 |

---

## Review Gate

- [ ] 本地 review: 跨家族 reviewer
- [ ] 云端 review: PR comment 触发

---
