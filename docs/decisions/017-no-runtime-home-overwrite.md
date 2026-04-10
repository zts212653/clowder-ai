---
feature_ids: [F050]
topics: [system-prompt, governance, security]
doc_kind: adr
created: 2026-03-13
---

# ADR-017: 禁止 Runtime 覆写各猫 Home 目录配置

## Status

Accepted (2026-03-13)

## Context

F050 Phase 4（Native Prompt Sync for Codex + Gemini）讨论中，Ragdoll×Maine Coon评估了多种同步方案。其中一种是"Cat Café 调度 agent 时动态覆写各猫 `~/` 目录下的原生配置文件"。

各猫的原生配置位置：
- Codex: `~/.codex/AGENTS.md`
- Gemini: `~/.gemini/GEMINI.md`
- Claude: `CLAUDE.md`（仓库内，不受此 ADR 约束）

## Decision

**禁止** Cat Café 在运行时（dispatch/invocation 过程中）自动修改各猫 home 目录下的配置文件。

系统提示词同步只通过显式脚本：`scripts/sync-system-prompts.ts --apply`。

## Rationale

1. **侵入性**：改用户 home 目录文件影响所有使用该 agent 的场景，不只是 Cat Café
2. **竞态风险**：多个 Cat Café 实例/session 同时写同一文件可能互踩
3. **个人环境污染**：铲屎官可能在原生配置中有自定义内容，runtime 覆写会丢失
4. **可审计性**：显式脚本有 commit 记录和 `--check` drift 检测，runtime 覆写无痕

## Consequences

- 家规/身份变更后需手动跑 `scripts/sync-system-prompts.ts --apply`
- 不支持原生配置的猫（OpenCode、Antigravity）继续靠 Cat Café 动态 prompt 注入
- CI 可集成 `--check` 模式检测漂移

## Participants

- Ragdoll（提出问题 + 方案）
- Maine Coon/GPT-5.4（架构讨论 + 否决 runtime 覆写）
- 铲屎官（确认方向 + 否决 OpenCode wrapper）
