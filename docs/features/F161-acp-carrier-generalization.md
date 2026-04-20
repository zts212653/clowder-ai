---
feature_ids: [F161]
related_features: [F149, F143, F050]
topics: [acp, carrier, generalization, runtime]
doc_kind: spec
created: 2026-04-13
---

# F161: ACP Carrier Generalization — 多载体复用同一 Runtime Policy

> **Status**: spec | **Owner**: TBD | **Priority**: P2

## Why

F149 交付了完整的 ACP runtime operations（进程池 / session lease / lifecycle / watchdog），但第一载体只有 Gemini。team experience（2026-03-31）：

> "我们要支持acp这个协议 支持Siameseacp接入 其实 codex 和claude code也支持这个协议。"

当前 `AcpProcessPool` 和 `AcpClient` 的接口没有 Gemini-specific 的硬依赖，但"没有 hard dependency ≠ 已验证可泛化"。F161 的目标是让第二个 ACP carrier 走通同一套池化/lease 模型，验证泛化性。

**Scope 来源**：从 F149 Phase D 拆出（2026-04-13 team lead拍板）。Gemini 作为第一个已有实现，有需求时再继续。

## What

### Phase A: 第二载体验证

1. 选一个非 Gemini 的 ACP carrier（Codex / Claude Code / OpenCode），映射到 F149 的 runtime policy
2. 验证 `AcpProcessPool` 的 acquire/release/eviction 不需要 provider-specific 分支
3. 文档化 provider profile 与通用 ACP runtime policy 的边界

## Acceptance Criteria

### Phase A
- [ ] AC-A1: 至少一个非 Gemini 的 ACP carrier 可映射到相同 runtime policy，而不需要重写池化/lease 模型
- [ ] AC-A2: provider-specific 配置与通用 ACP runtime policy 的边界有明文文档

## Dependencies

- **Evolved from**: F149 Phase D（scope 收窄拆出）
- **Related**: F143（protocol-agnostic kernel 抽象）
- **Related**: F050（外部 agent 接入契约）
