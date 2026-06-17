---
feature_ids: [F105]
related_features: [F050, F061, F032, F041, F043]
topics: [opencode, golden-chinchilla, external-agent, cli-integration, oh-my-opencode, multi-agent]
doc_kind: done
created: 2026-03-11
---

# F105: opencode 接入 — 金渐层（开源多模型编码猫）

> **Status**: done | **Owner**: Ragdoll Opus 4.6
> **Created**: 2026-03-11 | **Completed**: 2026-03-12

---

## Why

Cat Cafe 已有 DARE（狸花猫，L1 CLI）和 Antigravity（Bengal，CDP 桥）两条外部 agent 接入通道。现在需要接入第三位：**opencode** — 一个开源、provider-agnostic 的 AI coding agent。

opencode 的独特价值：

1. **开源 + provider-agnostic** — MIT 协议，支持 Anthropic/OpenAI/Google/本地模型等 75+ provider
2. **Oh My OpenCode (OMOC)** — 杀手级插件生态，自带 Sisyphus 多专家编排 + Ralph Loop 自循环 + Context 智能管理
3. **多接入方式** — CLI headless (`opencode run --format json`)、HTTP API (`opencode serve`)、ACP stdio
4. **原生 MCP 支持** — opencode 内建 MCP client，与 Cat Cafe MCP 编排天然兼容
5. **强 TUI/主题生态** — 社区活跃，插件丰富

operator定性：**金渐层**（Golden Chinchilla / British Shorthair）——毛色渐变如同 opencode 的"开放渐进"理念，圆润沉稳的英短体型体现稳定可靠。

---

## What

通过 L1 CLI Adapter（复用 F050 DARE 模式），将 opencode 作为独立家族（金渐层）接入 Cat Cafe。

### 核心架构

```
Cat Cafe AgentRouter
  → OpenCodeAgentService (新 provider)
    → spawn `opencode run --format json`
      → opencode CLI (TypeScript/Bun)
        → Anthropic API (via https://chat.nuoda.vip/claudecode)
```

### 接入方式对比

| 维度 | DARE/狸花猫 (F050) | Antigravity/Bengal (F061) | opencode/金渐层 (F105) |
|------|---------------------|------------------------------|------------------------|
| 通信层 | CLI spawn + stdout NDJSON | CDP 桥 + HTTP API | CLI spawn + stdout JSON |
| 事件流 | headless envelope v1 | DOM snapshot + WebSocket | opencode JSON event stream |
| 控制面 | control-stdin | `/send` HTTP endpoint | stdin (future: HTTP API) |
| 模型 | 底层 LLM 可变 | 多模型可切换 | 所有 Claude 模型（via proxy） |
| 独有能力 | 确定性执行、审计追踪 | 图片生成、截图录屏 | **OMOC 多专家内部编排、LSP、主题生态** |
| MCP | 运行期 reload | 无 | **原生 MCP client** |

### Oh My OpenCode 定位决策

**方向 B（受控 OMOC）**：安装 Oh My OpenCode，但编排权分层——

- **OMOC Sisyphus 编排器**：仅管理金渐层自己的内部专家子 agent（Oracle/Librarian/Frontend 等），即只编排 opencode 自己的 API 调用
- **Cat Cafe CatOrchestration**：管理跨猫调度（金渐层 ↔ Ragdoll/Maine Coon/Siamese）
- **不允许 Sisyphus 编排其他 Cat Cafe 猫猫**

保留 OMOC 的：LSP 工具集成、Ralph Loop 自循环、Context 智能管理（70% 预警 / 85% 自动压缩）。

### Provider 配置

opencode 使用 Anthropic 格式 API，通过 proxy 支持所有 Claude 模型：

```jsonc
// opencode.json (金渐层专用)
{
  "model": "anthropic/claude-sonnet-4-6",  // 默认模型，可切换
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "{env:OPENCODE_API_KEY}",
        "baseURL": "https://chat.nuoda.vip/claudecode"
      }
    }
  }
}
```

### 猫猫档案

| 字段 | 值 |
|------|-----|
| 品种 ID | `golden-chinchilla` |
| 显示名 | 金渐层 |
| 昵称 | 待共创 |
| 性别 | 公猫 |
| 配色 | Primary `#C8A951` (金色) / Secondary `#F5EDDA` (奶白底) |
| 项圈 | 琥珀金色 |
| 挂件 | 🔓 开锁（open source） |
| 道具 | 终端屏幕 </> |
| 垫子 | 深翠绿 |
| 句柄 | `@opencode`, `@金渐层`, `@golden` |
| 角色 | coding, multi-agent-orchestration |
| 特长 | 开源多模型编码 agent，自带 OMOC 多专家编排 + LSP + 主题生态 |
| 注意 | OMOC Sisyphus 只编排自己的子 agent，不编排其他猫；opencode 原生 MCP 和 Cat Cafe MCP 需避免冲突 |
| Avatar | `assets/avatars/opencode.png` ✅ 已生成 |

---

## Acceptance Criteria

### Phase 0: Spike / 可行性验证 ✅ COMPLETE
- [x] AC-1: opencode CLI v1.2.24 安装，通过 felix-2 API key + nuoda.vip proxy 调用 Claude 模型成功
- [x] AC-2: `opencode run --format json` 输出 NDJSON 事件流（step_start → text → tool_use → step_finish），格式清晰可映射
- [x] AC-3: Oh My OpenCode 插件通过 `"plugin": ["oh-my-opencode"]` 配置自动安装，system prompt 增加 ~12K tokens（Sisyphus 编排器注入）

**Spike 发现**：
- opencode JSON 事件类型：`step_start` / `text` / `tool_use` / `step_finish` — 与 DARE 的 headless envelope 不同但更简洁
- 反代模式（localhost:9877）下 opencode 会挂起（SSE streaming curl 正常），疑似 opencode 启动时有非 streaming 请求被反代异常处理，Phase 1 需排查
- OMOC 插件注入约 12K tokens system prompt，包含 Sisyphus 编排器 + 专家团队定义
- API baseURL 需要加 `/v1` 后缀（opencode Anthropic SDK 调用 `{baseURL}/messages` 而非 `{baseURL}/v1/messages`）

### Phase 1: Cat Cafe L1 接入 ✅ COMPLETE
- [x] AC-4: `CatProvider` 扩展支持 `'opencode'`（shared types + Zod enum + switch case）
- [x] AC-5: `OpenCodeAgentService` 实现 `AgentService` 接口（11 tests green）
- [x] AC-6: `opencode-event-transform.ts` 完成 JSON → AgentMessage 映射（10 tests green）
- [x] AC-7: `cat-config.json` 注册金渐层（roster + breed golden-chinchilla + variant opencode-default，6 config tests green）
- [x] AC-8: AgentRouter 注册 `case 'opencode'`，cat-config-loader 解析验证通过

### Phase 2: OMOC 集成 + 高级能力 ✅ COMPLETE
- [x] AC-9: OMOC Sisyphus 编排限制在金渐层内部子 agent — 5 isolation tests: delegate-task targets are OMOC-internal (oracle/librarian/frontend-engineer), no Cat Cafe handles in events
- [x] AC-10: opencode MCP 与 Cat Cafe MCP 编排不冲突 — 5 namespace tests: no MCP env leakage, no CLI MCP flags, zero tool name overlap, config isolation by process + file boundary
- [x] AC-11: Ralph Loop + Context 管理正常工作 — 6 context tests: multi-cycle Ralph Loop yields correct sequence (1 session_init dedup), high token counts handled, auto-compact gaps handled

### Phase 3: 协作路由 ✅ COMPLETE
- [x] AC-12: 金渐层参与 @mention 协作路由 — 12 tests: all 4 mention patterns (@opencode, @金渐层, @golden, @golden-chinchilla) resolve correctly, longest-match, case-insensitive, email/partial-word rejection
- [x] AC-13: 金渐层可被其他猫 @ 并响应 — 17 tests: A2A chain opus↔opencode bidirectional, self-mention filter, CJK mention, fenced code block ignore, system prompt injection (identity + directMessageFrom), E2E routing chain mirroring real route-serial assembly (buildStaticIdentity + buildInvocationContext separately), fixture guard bound to cat-config.json truth source

---

## Risk

1. **OMOC Sisyphus vs CatOrchestration 冲突** — 双重编排可能导致任务重复或死锁，需严格隔离编排域
2. **opencode JSON 事件格式稳定性** — opencode 是活跃开源项目，事件格式可能变化
3. **Proxy API 兼容性** — `https://chat.nuoda.vip/claudecode` 需确认支持所有 Claude 模型的 API 特性（streaming、tool use 等）
4. **MCP 双注入** — opencode 自带 MCP + Cat Cafe MCP 编排可能产生工具冲突

---

## Dependencies

- **opencode**: `github.com/anomalyco/opencode`（MIT 开源）
- **Oh My OpenCode**: `github.com/code-yeongyu/oh-my-opencode`（OMOC 插件）
- **API Proxy**: `https://chat.nuoda.vip/claudecode`（Anthropic 格式，operator配置）
- **F050**: External Agent Contract v1（复用 L1 CLI Adapter 模式）
- **F061**: Bengal接入（参考 provider 扩展模式）

---
