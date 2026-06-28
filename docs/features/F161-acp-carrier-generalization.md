---
feature_ids: [F161]
related_features: [F149, F143, F050, F105, F171]
topics: [acp, carrier, generalization, runtime, env-mapping, protocol, opencode]
doc_kind: spec
created: 2026-04-13
---

# F161: ACP Carrier Generalization — 通用 ACP 传输 + 模板环境变量映射

> **Status**: implemented (Phase A+B, intake from clowder-ai#899) | **Owner**: Ragdoll Opus-4.6 | **Priority**: P1

## Why

F149 交付了完整的 ACP runtime operations（进程池 / session lease / lifecycle / watchdog），但 ACP 传输仅 Gemini 可用——路由硬编码在 `case 'google'` 分支里，`GeminiAcpAdapter` 名字绑死 Gemini。同时 Gemini CLI 面临下线，OpenCode CLI 原生支持 ACP（`opencode acp`），团队需要让 ACP 成为通用传输协议。

核心痛点：**每加一个 ACP client 就要改 `index.ts` 路由 + `invoke-single-cat.ts` env 注入链的 if/else**。env 注入已有 5 个 protocol 分支（anthropic/openai/google/kimi/dare），每个硬编码 env var 名。

operator experience（2026-06-08）：

> "我想按照想把 acp 作为独立的 provider 开放出来"
> "clientId 还是 opencode；但是新增一个可选的协议 cli/acp"
> "对于已知的哪些 client 我们可以内置 client 支持的环境变量的 key 到我们内置的环境变量的 key 的映射"

**Scope 来源**：从 F149 Phase D 拆出（2026-04-13 operator 拍板）；2026-06-08 扩展为通用 ACP transport + OpenCode ACP 接入。

## Current State / 现状基线

| 维度 | 现状 | 证据 |
|------|------|------|
| ACP 路由 | 硬编码在 `case 'google'` 内（index.ts:1056-1100） | `getAcpConfig(id)` 只在 google 分支调用 |
| Adapter 命名 | `GeminiAcpAdapter`（Gemini 绑定） | 文件名 + class 名 |
| Env 注入 | 5 个 if/else 分支（invoke-single-cat.ts:1163-1237） | 每个 protocol 硬编码 env var 名 |
| OpenCode CLI ACP | 原生支持 `opencode acp`，Cat Cafe 未接入 | `opencode acp --help` 输出确认 |
| 通用 ACP client | 不支持 | 无 `clientId: 'acp'` 选项 |
| 底层 AcpClient/Pool | 已是 provider-agnostic | 代码审查确认无 Gemini-specific 逻辑 |

## What

### Phase A: 通用 ACP 传输 + 模板 Env 映射

**三个正交维度**：
- `clientId` = 身份（谁的 key、谁的 billing、roster 里叫啥）
- `protocol` = 传输（`cli` 默认 / `acp`）
- `acp.*` = ACP 传输配置（command、args、mcpWhitelist、pool 参数）

**改动**：

1. **Config schema**：variant 有 `acp` config section 即隐式启用 ACP transport（无需额外 `protocol` 字段）
2. **AcpAgentService**：`GeminiAcpAdapter` 重命名为 `AcpAgentService`，metadata.provider 从配置读
3. **Registry 路由**：ACP 路由从 `case 'google'` 提升到 switch 之前——任何 clientId + `protocol: 'acp'` 都走通用 ACP 路径
4. **Env 模板映射**：新建 `env-map.ts`，定义 `BUILTIN_ENV_MAPS`（已知 client 内置映射）+ `resolveEnvMap()`（`${api_key}` / `${base_url}` 模板替换）
5. **invoke-single-cat.ts**：if/else env 注入链替换为 `resolveEnvMap()` 调用
6. **通用 ACP client**：`clientId: 'acp'` 固定 `protocol: 'acp'`，用户自配 env 映射

**Env 模板映射设计**：

```typescript
// 内置标准变量
// ${api_key}   → account binding 的 apiKey
// ${base_url}  → account binding 的 baseUrl

// 已知 client/provider 内置映射
const BUILTIN_ENV_MAPS = {
  anthropic:  { ANTHROPIC_API_KEY: '${api_key}', ANTHROPIC_BASE_URL: '${base_url}' },
  openai:     { OPENAI_API_KEY: '${api_key}', OPENAI_BASE_URL: '${base_url}' },
  google:     { GEMINI_API_KEY: '${api_key}', GOOGLE_API_KEY: '${api_key}' },
  openrouter: { OPENROUTER_API_KEY: '${api_key}' },
  kimi:       { MOONSHOT_API_KEY: '${api_key}' },
};

// 解析优先级：用户自定义 > provider 内置 > clientId 内置 > 空
```

未知 client 用户在账户/成员认证处配 `XX_CLIENT_API_KEY=${api_key}` 即可。

### Phase B: OpenCode ACP 验证（spike）

1. 验证 `opencode acp` 与 Cat Cafe ACP types.ts 协议兼容性
2. 配置 OpenCode variant：`protocol: 'acp'` + `acp.command: 'opencode'`
3. 端到端验证：prompt → ACP session → response streaming

## Acceptance Criteria

<!-- 愿景硬度自检：每条 AC trace 回 Why -->

### Phase A（通用 ACP 传输 + 模板 Env 映射）
- [x] AC-A1: `GeminiAcpAdapter` 重命名为 `AcpAgentService`，所有引用更新，现有 Gemini ACP 功能不退化
- [x] AC-A2: variant 有 `acp` config section 即走通用 ACP 路径，不经过 clientId switch（隐式 protocol：有 acp section = ACP transport）
- [x] AC-A3: `env-map.ts` 实现 `BUILTIN_ENV_MAPS` + `resolveEnvMap()`，已知 client 内置映射覆盖 anthropic/openai/google/openrouter/kimi/dare
- [x] AC-A4: `invoke-single-cat.ts` 的 env 注入 if/else 链替换为 `resolveEnvMap()` 调用，行为等价（53 tests green）
- [x] AC-A5: `clientId: 'acp'` 可配置，固定 `protocol: 'acp'`，用户 envVars 中的 `${api_key}` / `${base_url}` 模板变量正确替换
- [x] AC-A6: 现有 Gemini ACP variant 加 `"protocol": "acp"` 后行为不变（向前兼容：无 protocol 字段 + 有 acp section = 隐式 ACP）

### Phase B（多 Client ACP 端到端验证）
- [x] AC-B1: ACP+Gemini 端到端验证通过（prompt→ACP session→response streaming）
- [x] AC-B2: ACP+Kimi 端到端验证通过（需 `kimi login` 管理认证；apikey 不可用于 ACP 模式）
- [x] AC-B3: ACP thinking buffer — `agent_thought_chunk` 累积后按 transition/end-of-stream flush 为 `system_info(thinking)`
- [x] AC-B4: OpenCode reasoning event → `system_info(thinking)` 映射（防御性，当前 opencode CLI 全部发 `type: 'text'`）
- [x] AC-B5: Frontend transport selector — opencode/gemini/kimi 支持 CLI/ACP(stdio) 切换
- [x] AC-B6: Kimi ACP 模式 UI 警告："kimi login required, apikey config won't work"
- [x] AC-B7: `effectiveProtocol` 从绑定账户的 client 推导，确保 ACP 子进程 credential env 正确注入

## Dependencies

- **Evolved from**: F149 Phase D（scope 收窄拆出，现扩展为完整实现）
- **Related**: F143（protocol-agnostic kernel 抽象）
- **Related**: F050（外部 agent 接入契约）
- **Related**: F105（OpenCode 金渐层接入）
- **Related**: F171（account env vars 注入机制）

## Risk

| 风险 | 缓解 |
|------|------|
| OpenCode ACP 协议与 types.ts 不兼容 | Phase B 做 spike 验证，Phase A 不依赖 OpenCode |
| env 映射重构影响现有 invocation | 保留现有测试全绿；逐步替换，不一次性删除旧路径 |
| `resolveEnvMap` 遗漏现有 env 注入的边缘 case | 逐行对照现有 if/else 链，确保每个分支都有对应映射 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | ACP 是 transport 不是 provider identity | clientId 和 protocol 正交；避免 `opencode-acp` 这种耦合设计 | 2026-06-08 |
| KD-2 | 用 `${api_key}` 模板变量替代 if/else 硬编码 | 数据驱动替代过程式，新 client 零代码接入 | 2026-06-10 |
| KD-3 | 接管 F161 而非新立 Feature | F161 spec 正是 "ACP Carrier Generalization"，避免重复立项 | 2026-06-10 |
| KD-4 | 未知 client 固定 `clientId: 'acp'`，只支持 ACP 协议 | 未知 CLI 的 event 格式无法解析，只有 ACP（标准 JSON-RPC）可通用 | 2026-06-10 |
| KD-5 | Generic ACP 不属于 builtin account family | ACP 是传输协议不是 provider identity，不应有 synthetic builtin account。移除避免 PATCH auto-rebase 写入不存在的 `accountRef:'acp'` | 2026-06-16 |
| KD-6 | ACP thinking buffer error-path flush | catch path 必须在 error event 前 flush pending thinking，否则 thought→error 场景丢用户可见内容 | 2026-06-16 |
| KD-7 | Pool spawn signature 包含 pool settings | `maxLiveProcesses`/`idleTtlMs` 变更应触发 pool 重建，否则用户编辑池设置不生效 | 2026-06-16 |
| KD-8 | mcpSupport gate 贯穿到 invoke 层 | `mcpSupport:false` 必须同时阻止 base MCP（resolver 层）和 per-project `.mcp.json` merge（invoke 层），否则外部项目 MCP 工具绕过禁用语义 | 2026-06-16 |
| KD-9 | ACP session reuse via sessionId | ACP 协议通过同一 `sessionId` 跨多次 `session/prompt` 调用维持上下文，等价于 CLI 的 `--resume`；`AcpAgentService` 检测 `options.sessionId` 存在时跳过 `newSession()` 直接复用 | 2026-06-16 |
| KD-10 | httpstream 从 UI 移除，后端保留 | httpstream 不在 ACP 官方 spec 中（目前仅 stdio），UI 暴露不成熟的传输选项增加用户困惑；后端实现 `AcpHttpStreamClient` 保留，等官方 spec 出来再开放 | 2026-06-16 |
| KD-11 | ACP context lifecycle/handoff 作为 followup | ACP event transformer 不解析 `usage`/`contextWindow` 事件，导致 `context_health` 不触发自动 seal——需要独立 feature 设计 ACP 场景的 context 感知与 handoff 机制 | 2026-06-16 |
| KD-12 | Compaction loop 根因：system+tools > usable threshold | OpenCode compaction 阈值 = `input - reserved`，当 Cat Cafe MCP 90+ 工具 schema (~90k tokens) 超过 usable(85k) 时每次响应都触发 compaction → auto-continue 循环。根治：全局 context 200k（阈值 185k > 90k）。followup：减少 MCP tool 暴露量 | 2026-06-16 |
| KD-13 | ACP scratchpad defense-in-depth | acp-event-transformer 添加 `## Goal` 模式检测 + AcpAgentService 添加 50-event circuit breaker，作为 compaction loop 的 L2/L3 防御层 | 2026-06-16 |

## Followup

| # | 主题 | 说明 | 关联 |
|---|------|------|------|
| FU-1 | ACP httpstream transport | httpstream（HTTP POST + NDJSON streaming）不在 ACP 官方 spec 中，后端 `AcpHttpStreamClient` 已实现并测试通过，等官方 spec 定案后再开放 UI 选项 | KD-10 |
| FU-2 | ACP context lifecycle & handoff | ACP event transformer 当前不解析 `usage`/`contextWindow` 事件，导致 session chain 的 `context_health` 无法触发自动 seal/handoff。需要设计 ACP 场景下的 context 用量感知机制（可能需要扩展 ACP 协议或 client 上报） | KD-11 |
| FU-3 | ACP session chain seal 策略 | `ephemeralSession` 已改为 `false`（session 持久化），但缺少基于 context 占用的自动 seal 触发——长对话可能无限增长。需要定义 ACP session 的 seal 阈值和 handoff 流程 | KD-9, KD-11 |
| FU-4 | MCP tool schema 精简 | Cat Cafe MCP 90+ 工具 schema 占 ~60-80k tokens，是 OpenCode compaction loop 的根本原因。按 session/cat 角色过滤暴露的工具集，减少固定 token 开销 | KD-12 |
