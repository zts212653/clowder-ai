---
feature_ids: [F145]
related_features: [F041, F043]
topics: [mcp, capability, bootstrap, devex]
doc_kind: spec
created: 2026-03-27
---

# F145: MCP Portable Provisioning — 声明式 MCP 期望态 + 本机解析

> **Status**: done | **Completed**: 2026-03-27 | **Owner**: Ragdoll + Maine Coon | **Priority**: P1

## Why

**team experience（2026-03-27）**：
> "我搞了一个新电脑，要把你们从 GitHub 下载回来，然后我这些 MCP 如果还要我自己一个个去挂就很奇怪了。"
> "我们现在就有个 bug，pencil MCP 写死用 antigravity 的插件，但是 vscode 其实也有插件，是一个东西。"

**根因**：F041 的 capability orchestrator 只做到"统一真相源 + 自动生成三份 CLI 配置"，但没有区分"期望态"和"本机解析态"。`capabilities.json` 混进了机器特定的绝对路径（如 pencil 的 `/home/user/mcp-server-darwin-arm64`），导致：

1. **新机器 clone 后 MCP 配置坏**：绝对路径在另一台机器上不存在
2. **Pencil 只认 Antigravity**：VS Code 用户装了同样的 Pencil 扩展也用不了
3. **Gemini 被迫做 workaround**：`mcp-config-adapters.ts` 里 `shouldSkipGeminiProjectServer('pencil')` + `delete existingMcp.pencil` 就是为了绕 stale path
4. **Skill 声明了 MCP 依赖但无法校验**：`browser-automation` 需要 `playwright`，`pencil-design` 需要 `pencil`，但 manifest 里没有这层关系，看板无法显示"skill 已挂但 backend 未就绪"

**愿景**：team lead在新电脑上 `git clone` + 一条命令，所有 MCP 自动解析、配置生成、就绪报告。不需要手动挂任何 MCP。

## What

### Phase A: Pencil Resolver + capabilities.json 去机器态 ✅

**第一刀**：用 Pencil 作为试点，把"声明式期望态 + 本机解析"的管道跑通。

1. **最小 Schema 加法**：
   - `McpServerDescriptor` 新增 `resolver?: string`
   - `command` 在 `resolver` 存在时允许为空
   - `hasUsableTransport()` 在 `resolver` 存在时不走"空 command = 不可用"的旧判断

2. **capabilities.json 清洗**：
   - Pencil 条目改为 `{ id: 'pencil', resolver: 'pencil', args: [] }`（不存绝对路径）
   - 新增 `.cat-cafe/mcp-resolved.json`（gitignored），存本机解析结果

3. **Pencil resolver 实现**：
   - 候选顺序：`PENCIL_MCP_BIN` env → `~/.antigravity/extensions/` → `~/.vscode/extensions/` → unresolved
   - `--app` 参数跟着变：Antigravity 路径 → `--app antigravity`，VS Code 路径 → `--app vscode`，env 覆盖 → 看 `PENCIL_MCP_APP` 或路径特征
   - Unresolved → 不写坏路径进 CLI 配置，标为"已声明但本机未就绪"

4. **generateCliConfigs() 改造**：
   - 先解析 resolver → 写 `mcp-resolved.json` → 再生成 CLI 配置
   - 只从 resolved state 读路径
   - 删掉 Gemini 的 `shouldSkipGeminiProjectServer('pencil')` workaround

### Phase B: Manifest requires_mcp + Bootstrap Doctor

1. **manifest.yaml 加 `requires_mcp`**：
   ```yaml
   pencil-design:
     requires_mcp: [pencil]
   browser-automation:
     requires_mcp: [playwright]
   ```
   - `check:skills` 遇到 missing/unresolved MCP 报 warning，不阻塞
   - 看板显示"skill 已挂但 backend 未就绪"

2. **Bootstrap doctor**：
   - `pnpm mcp:doctor` 输出 MCP 就绪报告
   - 输出 ready/missing/unresolved 报告
   - 不能自动安装的宿主软件（如 Antigravity / VS Code 本体），给出一条明确安装指引

## Acceptance Criteria

### Phase A（Pencil Resolver + 去机器态）✅
- [x] AC-A1: `capabilities.json` 中 pencil 条目不含机器特定绝对路径
- [x] AC-A2: Pencil resolver 按 env → Antigravity → VS Code → unresolved 顺序解析
- [x] AC-A3: 解析结果存入 `.cat-cafe/mcp-resolved.json`（gitignored）
- [x] AC-A4: Unresolved 时不写坏路径进 CLI 配置（`.mcp.json` / `.codex/config.toml` / `.gemini/settings.json`）
- [x] AC-A5: Gemini 的 `shouldSkipGeminiProjectServer('pencil')` workaround 删除
- [x] AC-A6: 现有 capability board 测试全绿 + 新增 resolver 回归测试
- [x] AC-A7: `hasUsableTransport()` 对 resolver-backed MCP 不误判为 disabled

### Phase B（Manifest requires_mcp + Doctor）✅
- [x] AC-B1: `manifest.yaml` 支持 `requires_mcp` 字段
- [x] AC-B2: `check:skills` 对 missing/unresolved MCP 报 warning
- [x] AC-B3: 看板能显示 skill 的 MCP 依赖就绪状态
- [x] AC-B4: `pnpm mcp:doctor` 输出 ready/missing/unresolved 报告
- [x] AC-B5: 新机器 clone + `pnpm install && pnpm mcp:doctor` 后，报告准确反映本机 MCP 状态

## Dependencies

- **Evolved from**: F041（能力看板 + 配置编排器）
- **Related**: F043（MCP 归一化）
- **Related**: F113（Multi-Platform One-Click Deploy — 一键部署也需要 MCP 自动解析）

## Risk

| 风险 | 缓解 |
|------|------|
| Schema 改动影响现有 capabilities.json 消费者 | resolver 是 optional 字段，现有逻辑不受影响；migration 一次性清洗 |
| Pencil 扩展路径在不同 OS/架构上不同 | 先只做 macOS ARM64（当前唯一 target），其他平台留 env override |
| mcp-resolved.json 和 capabilities.json 不同步 | generateCliConfigs() 每次都先 resolve 再生成，不缓存旧结果 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不做通用 resolver 框架，先用 pencil 单 case 跑通管道 | 防止过度设计；pencil 是当前唯一真实痛点 | 2026-03-27 |
| KD-2 | resolver 加在 McpServerDescriptor 上，不做 discriminated union | 最小侵入；discriminated union 会影响所有 mcpServer.command 消费者 | 2026-03-27 |
| KD-3 | env override（PENCIL_MCP_BIN）优先级最高 | 显式覆盖本来就是拿来打破自动决策的 | 2026-03-27 |
| KD-4 | browser-automation 的非 Playwright 路径不依赖本 feature | agent-browser/playwriter/pinchtab 不是标准 MCP，各自按需接入 | 2026-03-27 |
| KD-5 | Doctor 入口命名为 `pnpm mcp:doctor`，不使用 `pnpm doctor` | `pnpm doctor` 与 pnpm 内建命令冲突，必须选一个不会误触 builtin 的真实入口 | 2026-03-27 |

## Review Gate

- Phase A: Maine Coon review（Maine Coon参与了架构讨论，由他验收实现）
- Phase B: 跨家族 review

## 需求点 Checklist

| # | 需求点 | AC | Phase | 来源 |
|---|--------|-----|-------|------|
| R1 | capabilities.json 不存机器特定路径 | AC-A1 | A | team experience |
| R2 | Pencil 支持 Antigravity + VS Code 双宿主 | AC-A2 | A | team experience |
| R3 | 新机器 clone 后 MCP 自动解析 | AC-A3,A4,B5 | A+B | team lead愿景 |
| R4 | Skill 能声明 MCP 依赖 | AC-B1,B2,B3 | B | Maine Coon提议 |
| R5 | 一条命令看全局 MCP 就绪状态 | AC-B4,B5 | B | team lead愿景 |
