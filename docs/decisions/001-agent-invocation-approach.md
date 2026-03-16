---
feature_ids: []
topics: [agent, invocation, approach]
doc_kind: decision
created: 2026-02-26
---

# ADR-001: Agent 调用方式选择

## 状态
已更新（2026-02-06 修订）

## 日期
2026-02-04（初始）/ 2026-02-06（修订）

## 背景

Cat Café 需要程序化调用三只 AI 猫猫（Claude/Codex/Gemini），并保留它们的完整 agent 能力（文件操作、命令执行、MCP 工具使用）。

经过三猫研究团队的调研，我们评估了四种可能的方案。

## 决策

~~**我们选择方案 C：使用官方 Agent SDK**~~ → **已修订为方案 B：CLI 子进程模式 + MCP 回传**

具体技术选型（2026-02-06 修订）：
- **Ragdoll (Claude)**：`claude` CLI (`--output-format stream-json`)
- **Maine Coon (Codex)**：`codex` CLI (`exec --json`)
- **Siamese (Gemini)**：`gemini` CLI / Antigravity IDE（双 adapter）

> 修订原因：SDK 只能使用 API key 付费，无法使用 Max/Plus/Pro 订阅额度。详见 `docs/phases/phase-2.5-cli-migration.md`

## 方案对比

| 方案 | 描述 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| A: 纯 API | 直接调用 Chat API | 简单 | 失去 agent 能力 | ❌ 不满足需求 |
| **B: 子进程** | spawn CLI 作为子进程 | **完整能力、用订阅额度** | 启动开销、解析复杂 | ✅ 采用（修订） |
| ~~C: SDK~~ | 使用官方 Agent SDK | 低延迟、流式响应 | **只能用 API key 付费** | ❌ 弃用 |
| D: 外部进程 | 独立进程 + MCP 协调 | 松耦合 | 同步复杂 | ⚠️ 特殊场景 |

## 理由（修订后）

1. **使用订阅额度**：CLI 模式可使用 Max/Plus/Pro 订阅，无需 API key 付费
2. **完整 Agent 能力**：CLI 保留所有 agent 功能（文件操作、命令执行、MCP 工具）
3. **NDJSON 流式响应**：各 CLI 均支持 JSON 流式输出，可实时解析
4. **MCP 回传**：通过 HTTP callback，猫猫可主动发言和获取上下文
5. **统一抽象**：`spawnCli()` + `CliTransformer` 统一三猫差异

## 已知风险（修订后）

1. **CLI 启动开销**：每次 spawn ~500ms-2s，可考虑进程池优化
2. **NDJSON 格式变化**：CLI 升级可能改变输出格式，需版本锁定 + 容错解析
3. **Antigravity 回传**：MCP callback 可能无响应，需 gemini-cli fallback
4. **Session 内存存储**：重启丢失，Phase 3 迁移 Redis

## 缓解措施（修订后）

1. 为每个 CLI 编写独立的 `AgentService` 类 + `CliTransformer`，隔离差异
2. 使用统一的 `AgentMessage` 接口，屏蔽 CLI 输出差异
3. `spawnCli()` 工具封装超时、abort、僵尸进程防护
4. Gemini 双 adapter：`gemini-cli` (headless) 和 `antigravity` (IDE) 互为 fallback

## 否决理由（P0.5 回填）

- **备选方案 A**：继续采用官方 Agent SDK（原 ADR 初稿方向）
  - 不选原因：SDK 路径绑定 API key 计费，无法复用 Max/Plus/Pro 订阅额度，长期成本不可接受。
- **备选方案 B**：三猫统一改成纯 API 模式
  - 不选原因：纯 API 丢失 CLI 侧 agent 能力（文件操作、命令执行、MCP 工具链），与 Cat Café 协作目标冲突。
- **备选方案 C**：外部独立进程编排（仅保留 D 方案）
  - 不选原因：进程同步、会话对齐和回传链路复杂度过高，不符合当期交付节奏。

**不做边界**：本轮不引入进程池和统一守护进程优化，启动性能优化留到后续独立议题。

## 参考

- 研究报告：`research-report/` 目录下的三份报告
- OpenClaw 项目：https://github.com/openclaw/openclaw
- MCP SDK 文档：https://modelcontextprotocol.io/

## 参与者

- Ragdoll（Claude Opus 4.5）
- Maine Coon（GPT Codex）
- Siamese（Gemini 3 Pro）
- 铲屎官

---

## 修订记录

| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-02-04 | 初始决策：选择方案 C (SDK) | 完整 agent 能力 + 低延迟 |
| 2026-02-06 | 修订为方案 B (CLI 子进程) | SDK 只能用 API key，无法用订阅额度；Gemini API 模式无文件操作能力 |
