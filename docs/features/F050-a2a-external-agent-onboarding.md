---
feature_ids: [F050]
related_features: [F002, F005, F027, F032, F041, F043, F061, F105, F126, F135]
topics: [a2a, external-agent, cli-integration, interoperability, dare, system-prompt, governance]
doc_kind: spec
created: 2026-03-02
updated: 2026-03-13
---

# F050: External Agent Onboarding（A2A/CLI 接入契约）

> **Status**: in-progress | **Owner**: 三猫（Phase 1 leader: Ragdoll Opus 4.6）
> **Created**: 2026-03-02

## Why

我们已经有成熟的三猫协作内核，但“接入外部 agent”的边界还不清晰，导致讨论里反复出现三个关键问题：

1. Cat Cafe 若要对接 A2A，到底要改什么？
2. 被接入 agent 需要满足哪些硬条件？
3. “任何支持 A2A 的 agent 都能接入吗？”

这次要把答案写成可执行的协议契约，不再靠口头约定。

## What

定义并落地外部 Agent 接入契约（EAC v1），把接入路径拆成 L1 CLI Adapter 与 L2 A2A Protocol Adapter 两条通道，先完成 DARE 的 L1 生产可用接入，再推进 L2 协议适配。

---

## As-Is（当前事实）

### 1) 我们现有 A2A 是“内部协作链路”，不是“外部 A2A 协议适配”

- 我们已有：`@mention -> worklist -> handoff` 的内部协作流（F002/F005/F027）
- 我们还没有：A2A 协议客户端/服务端适配层（`/.well-known/agent.json`, `tasks/send` 这一套）

结论：**内部 A2A 可用，但外部 A2A 接入仍缺 adapter 层。**

### 2) 我们已具备三猫统一动态 MCP 注入能力

- F041/F043 之后，MCP 配置可由能力编排器统一生成到 Claude/Codex/Gemini 各自配置
- 这解决的是“工具能力注入”问题，不等于“外部 agent 接入”已完成

结论：**MCP 动态注入是强基础设施，但不是外部 agent 兼容层本身。**

### 3) 我们的 AgentService 接口是通用的，但 provider 入口仍受限

- `AgentService.invoke(prompt, options)` 已抽象好
- 启动注册仍是固定 provider 分支（anthropic/openai/google）
- `cat-config` provider 枚举也仍是三值约束

结论：**内核接口可扩，但入口治理与 provider schema 还需要放开。**

---

## Key Decision

采用双通道接入模型，避免把“CLI 接入”和“A2A 协议接入”混成一类：

1. **L1: CLI Adapter 通道**
   - 目标：接入“可流式输出的外部 CLI agent”
   - 典型对象：优化后的 DARE CLI、opencode CLI、未来其它 agent CLI
2. **L2: A2A Protocol Adapter 通道**
   - 目标：接入“暴露 A2A 协议端点的远程 agent”
   - 典型对象：任何具备 AgentCard + tasks/send(+Subscribe) 能力的 A2A agent

两条通道最终都收敛到统一 `AgentService` 语义。

---

## 接入契约（External Agent Contract v1）

### A. Invocation Contract（必须）

- `invoke(prompt, options)` 可异步产出消息流
- 支持 cancellation（AbortSignal 等价语义）
- 支持工作目录与最小环境变量透传

### B. Stream Contract（必须）

- 必须提供机器可解析流（JSONL/NDJSON/SSE 至少一种）
- 至少可映射为：`session_init | text | error | done`
- 若有工具调用事件，需能映射为 `tool_use/tool_result`（可选但强烈建议）

### C. Session Contract（建议→必须）

- 最小要求：单次会话可追踪 `sessionId/threadId`
- 完整要求：跨轮 resume 能力（否则上下文成本过高）

### D. Capability Contract（必须）

- 可接受 Cat Cafe 的 MCP 编排结果（静态配置或运行期 reload）
- 若不支持运行期动态注入，需提供明确降级路径

### E. Collaboration Contract（L2 必须）

- A2A 模式需实现：
  - `GET /.well-known/agent.json`
  - `POST tasks/send`（最小）
  - `POST tasks/sendSubscribe`（建议）
  - `tasks/get`, `tasks/cancel`（建议）
- 认证与超时策略必须可配置

### F. Safety Contract（必须）

- 外部执行器命令白名单 + 参数边界
- token/权限最小化（callback token、MCP env、审批动作）
- 可审计（调用链可追踪）

### G. Avatar Sync Contract（必须）

- 新猫接入时，头像文件**必须同步到 `packages/web/public/avatars/`**
- 源文件放 `assets/avatars/`，public 目录是运行时服务路径，缺文件 = 聊天界面无头像
- 每个 variant 如有独立 avatar 字段，对应文件也必须同步
- 接入 checklist 中必须包含"头像文件已复制到 web/public"验收项

### H. System Prompt Configuration Map（必须）

Cat Café 通过 `SystemPromptBuilder` 动态注入身份和家规到 prompt 文本中，但各 agent **也有自己的原生系统提示词配置**。更新家规/身份时，**两层都要同步**。

| Agent | 原生配置路径 | 格式 | 说明 |
|-------|-------------|------|------|
| Claude (Ragdoll) | 仓库根 `CLAUDE.md` | Markdown | 自动注入 system prompt，改完即生效 |
| Codex (Maine Coon) | `~/.codex/AGENTS.md` + App Personalization | Markdown | CLI 和 App 都读；截图里的 Custom instructions |
| Gemini (Siamese) | `~/.gemini/GEMINI.md` | Markdown | 项目级可用 `.gemini/GEMINI.md` |
| OpenCode (金渐层) | `~/.config/opencode/opencode.json` | JSON | 系统提示词走 OMOC plugin；底层 Claude Code 运行时共享 `~/.claude/` 配置和 skills（见下方说明） |
| Antigravity (孟加拉猫) | CDP bridge / prompt 注入 | — | 无独立配置文件，纯靠 Cat Café 动态注入 |

**变更 SOP**：
1. 改了 Codex/Gemini 原生配置相关内容 → 编辑 `assets/system-prompts/` 分片文件（Codex/Gemini 原生配置的仓库内真相源）
2. 跑 `npx tsx scripts/sync-system-prompts.ts --check` 检测 drift
3. 跑 `npx tsx scripts/sync-system-prompts.ts --apply` 写入 `~/.codex/AGENTS.md` + `~/.gemini/GEMINI.md`
4. Commit 分片变更

**OpenCode 配置共享说明**：OpenCode 底层使用 Claude Code 运行时（`claude-opus-4-6`），因此天然共享 `~/.claude/` 下的配置和 skills。这意味着：
- `~/.claude/skills/` 中的 Cat Café symlink skills 金渐层可直接加载
- `~/.claude/projects/` 中的项目级配置也会生效
- 无需为金渐层单独维护 skills 同步链

**决策**：禁止 runtime 自动覆写 `~/` 配置 → [ADR-017](../decisions/017-no-runtime-home-overwrite.md)

---

## 结论问题逐条回答

### Q1: Cat Cafe 要接入 A2A 需要做什么？

最小变更集（按优先级）：

1. 增加 `A2AAgentService`（L2 adapter）
2. 把 provider schema 从三值改为“内置 + 扩展 provider”
3. 增加外部 agent 配置模型（endpoint/auth/capabilities）
4. 建立统一事件映射层（CLI 流与 A2A 流统一成 AgentMessage）
5. 加入接入验收测试（协议契约测试 + 回归测试）

### Q2: 被接入 agent 有什么要求？

满足上述 `External Agent Contract v1` 的 A/B/D/F 是硬门槛；C/E 视接入级别（L1/L2）决定。

### Q3: 任何支持 A2A 的 agent 都能接入吗？

**不能直接“零改造”接入。**

原因：

1. A2A 标准只保证“协议互通”，不保证“协作语义互通”
2. 我们还需要会话策略、MCP 编排、权限与审计的一致性
3. 仍需通过 `A2AAgentService` 做语义映射与治理接入

结论：**理论上可接，工程上必须过契约门禁。**

---

## 实施计划（Phase 分拆）

### Phase 1: DARE L1 CLI 接入（当前 — 2026-03-04 起）

**目标**：Cat Café 能通过 CLI adapter 驱动 DARE agent 完成单轮任务。

**改造清单**：

1. **provider schema 扩展**（P1 阻塞）
   - `CatProvider` 从 `'anthropic' | 'openai' | 'google'` 扩展为支持 `'dare'`
   - 文件：`packages/shared/src/types/cat.ts:12`
   - 联动：`cat-config-loader.ts:57` 的 zod enum、`index.ts:168-180` 的 switch 分支

2. **DareAgentService 实现**（P1 阻塞）
   - 实现 `AgentService` 接口（`invoke(prompt, options) → AsyncIterable<AgentMessage>`）
   - 参考现有：`CodexAgentService.ts`（最接近的 CLI spawn 模式）
   - 位置：`packages/api/src/domains/cats/services/agents/providers/DareAgentService.ts`

3. **spawnCli stdin 支持**（P1 阻塞）
   - 当前 `cli-spawn.ts:75` 设 `stdin: 'ignore'`，无法写入 control 命令
   - 改为可选 `stdin: 'pipe'`，支持 DARE `--control-stdin` 通道

4. **DARE 事件映射层**（P2）
   - DARE headless envelope → Cat Café `AgentMessage` 的转换
   - DARE envelope 格式（`client-headless-event-envelope.v1`）：
     ```json
     { “schema_version”: “...”, “ts”: float, “session_id”: “...”,
       “run_id”: “...”, “seq”: int, “event”: “...”, “data”: any }
     ```
   - 需映射的事件：`session.start → session_init`、`text → text`、`error → error`、`done → done`

5. **cat-config 注册 DARE 猫**（P2）
   - 在 `cat-config.json` 中可配一只 DARE 猫
   - 需要字段：`provider: “dare”`、`model`、`darePath`（CLI 路径）

### Phase 2: 接入验收 + 回归测试

- 契约测试套件（headless envelope 解析、control-stdin 交互、session 生命周期）
- 与现有三猫回归测试共跑，确保接入不破坏内部协作

### Phase 3（future）: A2A L2 协议适配

- `A2AAgentService` 实现
- `/.well-known/agent.json` + `tasks/send` / `tasks/sendSubscribe`
- 远程 agent 接入

---

## 测试策略

### 环境准备

DARE 支持 OpenRouter adapter，可用免费/低成本模型测试，不需要 OpenAI key。

**环境变量**（team lead已在 `~/.zshrc` 中配置）：

```bash
export OPENROUTER_API_KEY=”sk-or-v1-...”  # OpenRouter API key
```

获取方式：[OpenRouter](https://openrouter.ai/) 注册后在 Keys 页面创建。

**DARE 运行依赖**：

- Python ≥ 3.12
- 安装：`pip install -e .`（在 DARE 仓库目录）
- DARE 仓库位置：`/tmp/cat-cafe-reviews/Deterministic-Agent-Runtime-Engine`

### 三层验证

| 层级 | 命令 | 验证点 | 需要 API key |
|------|------|--------|-------------|
| 1. doctor | `python -m client --adapter openrouter --api-key dummy --output json doctor` | DARE 能启动、配置正确 | 否 |
| 2. headless run | `python -m client --adapter openrouter --model zhipu/glm-4.7 --api-key $OPENROUTER_API_KEY run --task “say hello” --auto-approve --headless` | 端到端推理 + JSON 事件流 | 是 |
| 3. Cat Café 集成 | DareAgentService 通过 spawnCli 驱动 DARE | 完整接入链路 | 是 |

### DARE 协议参考

**Headless 事件 envelope**（`client/render/headless.py`）：
- schema: `client-headless-event-envelope.v1`
- 字段：`schema_version, ts, session_id, run_id, seq, event, data`

**Control-stdin 协议**（`client/render/control.py`）：
- 请求 schema: `client-control-stdin.v1`
- 字段：`schema_version, id, action, params`
- 可用 action：`actions:list, status:get, approvals:list/poll/grant/deny/revoke, mcp:list/reload/show-tool, skills:list`

---

## DARE / Opencode 兼容性判断（2026-03-04 更新）

### DARE（issue #135 修复后）

已有能力（已验证）：

- `run/script` 支持 `--headless` + `--control-stdin`（PR #145 合入后）
- `script --headless` 审批超时已补（P1 已修）
- 运行期 MCP 管理（`mcp:list/reload/show-tool`）
- 运行期 Skills 查询（`skills:list`）
- OpenRouter adapter 原生支持（env: `OPENROUTER_API_KEY`）
- 结构化 JSON 事件流（headless envelope v1）

剩余 gap（对 Cat Cafe 侧）：

1. **我们的 provider 入口仍是三值**（Phase 1 解决）
2. **缺 DareAgentService 实现**（Phase 1 解决）
3. **spawnCli stdin 不可写**（Phase 1 解决）
4. **事件映射层未实现**（Phase 1 解决）

### opencode CLI

当前结论：**可作为 L1 候选，但仍需按 EAC v1 跑一轮兼容基线测试后定级。**

我们不再接受”只凭功能印象接入”。

---

## Compatibility Levels（验收分级）

| Level | 定义 | 是否可上线 |
|---|---|---|
| L0 | 无机器流/无会话/无治理 | 否 |
| L1 | CLI adapter 可稳定调用 + 基础治理 | 可灰度 |
| L2 | A2A adapter 可用 + 协议闭环 | 可上线 |
| L3 | A2A + MCP 动态注入 + 审批/审计全链闭环 | 推荐默认 |

---

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

### Phase 1: DARE L1 CLI 接入
- [x] 外部 agent 接入契约（EAC v1）文档定稿
- [x] provider schema 从三值扩展为支持 `dare`
- [x] `DareAgentService` 实现 `AgentService` 接口
- [x] DARE headless envelope → AgentMessage 事件映射（15 tests）
- [x] cat-config.json 可注册 DARE 猫
- [x] Cat Café 集成验证通过（smoke test: 真实 DARE CLI 调用）

### Phase 1b: stdin 控制面（延期）
- [ ] spawnCli 支持 stdin pipe（DARE control-stdin）— Phase 1 使用 `--auto-approve` 不需要 stdin

### Phase 2: 接入验收
- [x] DARE CLI 兼容性测试套件完成（含 session/event/auth；`resume` 用例因 DARE #184 暂以 `test.skip` 标注）
- [x] 与现有三猫回归测试共跑通过
- [x] DARE 通过 L1 验收

### Phase 4: Native Prompt Sync for Codex + Gemini（2026-03-13 起）

**背景**：F105（金渐层接入）过程中发现系统提示词存在动态层（SystemPromptBuilder）与静态层（各猫 `~/` 原生配置）不同步问题。team lead直接 CLI 裸跑 opencode 时完全无身份/家规意识（回复"大猫猫你好"），而 Codex 因team lead手动在 `~/.codex/AGENTS.md` 写了身份所以裸跑也正常。

**愿景**：
1. Codex/Gemini 原生配置有**仓库内真相源**（`assets/system-prompts/`），不再在各猫 `~/` 中各自为政
2. team lead改了原生配置相关内容后，跑一条命令就能同步到 Codex + Gemini 的 `~/` 配置，**不会漏改 `~/`**
3. 不支持原生配置的猫（OpenCode、Antigravity）继续靠 Cat Café 动态注入，**不假装有配置**
4. 禁止 runtime 自动覆写 `~/` 配置（ADR 记录）

**本 Phase 不覆盖**：Cat Café 运行时动态注入层（`SystemPromptBuilder` 的 `GOVERNANCE_L0_DIGEST` 等常量）仍维持现状。将动态层也收拢到分片源是 Phase 5 候选方向（见 Open Questions）。

**方案**（Ragdoll × Maine Coon讨论收敛）：
- 真相源：`assets/system-prompts/` 语义分片（`governance-l0.md`、`collab-rules.md`、`cats/{catId}.md`）
- 渲染器：`scripts/sync-system-prompts.ts` — 按 provider 差异拼装为各猫目标格式
- 同步：`--apply`（写入 `~/` 对应位置）+ `--check`（drift 检查，CI 可跑）
- 不做：runtime 动态改 `~/`、OpenCode wrapper（team lead否决，非真实使用场景）

**否决记录**：
- ❌ 调度时动态覆写各猫 home 配置 — 侵入性强、易竞态、污染个人环境
- ❌ OpenCode wrapper（`scripts/opencode-cat-cafe-run`）— team lead否决，裸跑场景是测试触发非日常使用

- [x] AC-P4-1: `assets/system-prompts/` 语义分片结构建立（governance-l0 + collab-rules + 各猫身份）
- [x] AC-P4-2: `scripts/sync-system-prompts.ts --check` 能检测 Codex/Gemini `~/` 配置 drift
- [x] AC-P4-3: `scripts/sync-system-prompts.ts --apply` 能渲染并写入 `~/.codex/AGENTS.md` + `~/.gemini/GEMINI.md`
- [x] AC-P4-4: ADR 记录"禁止 runtime 覆写 `~/` 配置"决策 → [ADR-017](../decisions/017-no-runtime-home-overwrite.md)
- [x] AC-P4-5: F050 §H 配置地图与实际同步脚本一致
- [ ] AC-P4-6: 愿景守护 — 改了 governance-l0 后跑 `--check` 能发现 Codex/Gemini 未同步（merge 后由守护猫验证）

### Phase 3: A2A L2 Protocol Adapter
- [x] `A2AAgentService` 设计稿 + 接口定义完成（PR #519）
- [ ] opencode CLI 兼容性测试清单完成
- [ ] 至少 1 个 A2A agent 通过 L2 验收

---

## Risk

1. 把“协议互通”误判成“能力等价互通”会造成后续返工
2. 未定义事件语义映射会让接入后的 debug 成本非常高
3. 未做接入验收分级会让质量门禁失效

---

## Dependencies

- **DARE 仓库**：`github.com/zts212653/Deterministic-Agent-Runtime-Engine`（issue #135 已基本完成）
- **OpenRouter API key**：team lead已在 `~/.zshrc` 配置 `OPENROUTER_API_KEY`
- **Evolved from**: F032（Agent Plugin Architecture）、F041/F043（MCP 统一管理）
