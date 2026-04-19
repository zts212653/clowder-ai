---
feature_ids: [F158]
related_features: [F050, F061, F127, F149]
topics: [provider, cli, community]
doc_kind: spec
created: 2026-04-10
---

# F158: Kimi CLI First-Class Cat

> **Status**: done | **Owner**: 社区 (ZephaniaCN) + Ragdoll | **Priority**: P2

## Why

Kimi (Moonshot AI) 是国内主流 AI 提供商之一。社区贡献者 ZephaniaCN 提交了完整的 Kimi CLI 集成 PR（clowder-ai#361），将 Kimi 作为第五个 first-class CLI cat 接入 Cat Cafe 运行时，补齐了国产大模型的 CLI 支持。

## What

### Phase A: CLI Runtime Integration

将 `kimi-cli` 接入 Cat Cafe 运行时，实现与 Claude/Codex/Gemini 同等级别的 first-class 支持：

- **KimiAgentService**：基于 `kimi-cli` 的 NDJSON 流式解析，支持 session init/resume、thinking block 解析、image-aware sessions
- **Account Resolver**：kimi 作为 builtin client，支持 OAuth 和 API Key 两种认证方式
- **MCP 注入**：Kimi MCP config（`.kimi/mcp.json`）支持 + callback env 注入
- **Governance**：governance bootstrap/preflight/pack 扩展支持 kimi
- **Quota**：kimi quota 端点、summary 集成、local session 探测

### Phase B: Hub UI Integration

Hub 全链路支持 kimi 成员管理：

- 成员创建向导（add-member-wizard）支持选择 kimi client
- Cat Editor 支持 kimi 协议和 MCP 配置
- 配额面板、能力面板、技能面板展示 kimi 状态
- 头像（`/avatars/kimi.png`）和品种标识（梵花猫 / Turkish Van）

### Phase C: Cross-Platform Support

- Windows installer 和 auth 支持
- 环境检查（bootcamp env-check）kimi 路径探测
- Runtime worktree 脚本 kimi 兼容

## Acceptance Criteria

### Phase A（CLI Runtime Integration）
- [x] AC-A1: KimiAgentService 实现 NDJSON 流式解析，text/tool_use/thinking 事件正确转换
- [x] AC-A2: Session init 和 resume 正常工作（含 symlink worktree 场景）
- [x] AC-A3: MCP callback env 注入和 `.kimi/mcp.json` 配置生成
- [x] AC-A4: Account resolver 正确解析 kimi builtin 和 API key 账号
- [x] AC-A5: Governance bootstrap/preflight/pack 包含 kimi 规则
- [x] AC-A6: Quota API 和 usage aggregator 支持 kimi

### Phase B（Hub UI Integration）
- [x] AC-B1: 成员创建向导可选择 kimi 作为 client
- [x] AC-B2: Cat Editor 正确显示 kimi 的协议和模型选项
- [x] AC-B3: 配额面板展示 kimi 配额状态
- [x] AC-B4: kimi 头像和品种标识正确显示

### Phase C（Cross-Platform Support）
- [x] AC-C1: Windows installer 支持 kimi CLI 安装
- [x] AC-C2: bootcamp env-check 检测 kimi CLI 路径

## Dependencies

- **Related**: F050（External Agent Onboarding — Kimi 走 F050 的 L1 CLI adapter 路径接入）
- **Related**: F061（Antigravity Bengal Cat — 同属"外部 CLI → first-class cat"的接入模式）
- **Related**: F127（Cat Instance Management — 动态猫实例注册，Kimi 是新增实例的实际用例）
- **Related**: F149（ACP Runtime Operations — 扩展性边界）

## Risk

| 风险 | 缓解 |
|------|------|
| kimi CLI 未安装时 agent service 测试全 skip | CI 加 stub binary + test:public 排除 |
| 社区 PR 基于 accounts refactor (clowder-ai#340) 之前的代码，字段名过时 | maintainer commit 统一对齐 provider→clientId |
| SystemPromptBuilder size 超限 | 阈值 +100 适配新 cat roster |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 品种定为"梵花猫"(Turkish Van)，breedId='moonshot' | 社区贡献者选择，team lead未反对 | 2026-04-04 |
| KD-2 | 尚未分配个性化昵称（如Ragdoll/Maine Coon/Siamese） | 等team lead拍板 | 2026-04-10 |
| KD-3 | 先在 clowder-ai 合入社区 PR，再 intake 回 cat-cafe | Maine Coon建议，team lead同意 | 2026-04-10 |
