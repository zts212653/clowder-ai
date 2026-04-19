---
feature_ids: [F145]
related_features: [F041, F043, F149]
topics: [mcp, capability, bootstrap, devex]
doc_kind: spec
created: 2026-03-27
---

# F145: MCP Portable Provisioning — 声明式 MCP 期望态 + 本机解析

> **Status**: done | **Owner**: Ragdoll + Maine Coon | **Priority**: P1 | **Completed**: 2026-04-12

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

### Phase C: Built-in Cat Café MCP Auto-Provision for ACP ✅

**痛点**：ACP resolver (`acp-mcp-resolver.ts`) 把内置 `cat-cafe*` servers 和外部 MCP 一视同仁，全从 `.mcp.json` 读取。社区用户 clone 后没有 `.mcp.json`（gitignored），Gemini ACP 就拿不到任何 MCP server。

**改法**（Maine Coon GPT-5.4 审定边界）：

1. **共享 helper**：`resolveBuiltinCatCafeMcpServers(projectRoot, whitelist)` — 从 `packages/mcp-server/dist/` 自动生成内置 server 配置
   - `cat-cafe` → `dist/index.js`（全量 server，含 limb tools）
   - `cat-cafe-{suffix}` → `dist/{suffix}.js`
2. **ACP resolver 改造**：内置 `cat-cafe*` 走 helper，外部 server（`pencil` 等）才 fallback 到 `.mcp.json`
3. **capabilities.json bootstrap 补齐**：`cat-cafe` 主 server 加入 bootstrap/migration（当前只有 split 三件套）
4. **mcp:doctor 对齐**：确认 doctor 报告包含 `cat-cafe` 主 server 状态

### Phase E: Per-Project MCP for ACP Sessions ✅

**痛点**：社区用户用 Cat Café 开发自己的项目。不同项目目录下有不同的 `.mcp.json`（database MCP、docker MCP、figma MCP 等）。当前各猫猫对用户项目 `.mcp.json` 的支持情况：

| 猫猫 | 读用户项目 `.mcp.json` | 原因 |
|---|---|---|
| Ragdoll（Claude Code） | ✅ 原生支持 | Claude Code 运行在项目目录，自动发现 `.mcp.json` |
| Maine Coon（Codex） | ✅ 原生支持 | 同上 |
| Siamese（Gemini ACP） | ❌ 不支持 | `acp-mcp-resolver.ts` 的 `projectRoot` 硬编码为 `findMonorepoRoot()`，只读 Cat Café monorepo 的 `.mcp.json` |

**根因**：`resolveAcpMcpServers(projectRoot, whitelist)` 只走两条路：
1. 内建 cat-cafe-* → 从 `projectRoot/packages/mcp-server/dist/` 自动生成
2. 外部 server → 从 `projectRoot/.mcp.json` 读取（但只匹配 `whitelist` 里的 server）

**两个缺口**：
1. `projectRoot` 固定为 Cat Café monorepo，不是用户的项目目录
2. 即使 `projectRoot` 指向用户项目，resolver 也只读 `whitelist` 里声明的 server，不会 merge 用户项目 `.mcp.json` 里的全部 server

**改法**：
1. `resolveAcpMcpServers` 新增参数 `userProjectRoot`（用户项目目录）
2. 读 `userProjectRoot/.mcp.json` 的所有 server（不限于 whitelist）
3. Merge 策略：内建 cat-cafe-* 优先 → whitelist 外部 server 次之 → 用户项目 server 补充
4. 去重：同名 server 以前两层为准（防止用户项目覆盖内建 server）

**架构准备度**（已有 seam）：
- Pool key 已包含 `projectPath`（不同项目自动隔离）
- `newSession(cwd, mcpServers)` 已参数化
- `materializeSessionMcpServers` 已支持 per-invocation env 注入
- 缺：invoke 链路中 thread/workspace → projectRoot 的上下文传递

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

### Phase C（Built-in MCP Auto-Provision for ACP）✅
- [x] AC-C1: ACP resolver 不依赖 `.mcp.json` 获取 `cat-cafe*` servers — 从 `projectRoot` 自动生成
- [x] AC-C2: 外部 MCP（`pencil` 等）仍从 `.mcp.json` fallback 读取
- [x] AC-C3: `capabilities.json` bootstrap 包含 `cat-cafe` 主 server（含 limb tools）
- [x] AC-C4: 新机器 clone + `pnpm install` 后，Gemini ACP session 自动获得内置 MCP servers（无需手写 `.mcp.json`）
- [x] AC-C5: 现有 ACP adapter + resolver 测试全绿 + 新增 auto-provision 回归测试

### Phase E（Per-Project MCP for ACP）✅
- [x] AC-E1: `resolveAcpMcpServers` 接受 `userProjectRoot` 参数，读取用户项目目录的 `.mcp.json`
- [x] AC-E2: 用户项目 `.mcp.json` 的 server 自动 merge 到 ACP session MCP 列表
- [x] AC-E3: 同名 server 优先级：内建 cat-cafe-* > whitelist 外部 > 用户项目
- [x] AC-E4: 用户项目没有 `.mcp.json` 时不报错（graceful degrade，仅内建 + whitelist）
- [x] AC-E5: 不同 `userProjectRoot` 的 ACP session 拿到不同的 MCP server 集合

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

## Known Issues

### Phase D: ~/.claude.json stale override 遮蔽 resolver 输出（2026-04-08 发现）

**症状**：Pencil resolver 正确解析到 VS Code 0.6.39（`--app vscode`），`.mcp.json` 也正确生成，但 Claude Code session 里 pencil 工具始终不可用。Siamese（Gemini ACP）同样不可用。

**根因**：`~/.claude.json` 有两层 stale pencil 配置覆盖了 `.mcp.json`：
1. **Per-project mcpServers**（优先级最高）：指向已卸载的 `pencildev-0.6.26`（文件不存在） + `--app antigravity`
2. **Global mcpServers**：指向 `.pencil/mcp/antigravity/`（文件存在但用旧 `--app antigravity`）

Claude Code 读配置时 per-project override > `.mcp.json` > global，拿到不存在的二进制 → 启动失败 → 静默跳过。

**紧急修复（2026-04-08）**：手动清理 `~/.claude.json` 中 per-project 和 global 的 stale pencil entries。

**根因修复**：`generateCliConfigs()` 在写完 `.mcp.json` 后，对 resolver-backed servers 清理 `~/.claude.json` 中 per-project overrides，防止 stale entries 遮蔽 resolver 输出。→ Phase D (PR #1017, merged `b527aac0`)

### Phase D: generateCliConfigs() 清理 stale Claude overrides ✅

- [x] AC-D1: `generateCliConfigs()` 写完 `.mcp.json` 后，清理 `~/.claude.json` per-project mcpServers 中 resolver-backed server 的 stale entries
- [x] AC-D2: Global mcpServers 不清理（设计决策：global 优先级低于 `.mcp.json`，不遮蔽 resolver 输出，清理反而会影响其他项目）
- [x] AC-D3: 不影响非 resolver-backed servers（如用户手动配置的 xiaohongshu、jetbrains 等）
- [x] AC-D4: 清理操作有日志输出（`[F145] Cleaned ...` / `[F145] Failed ...`），不静默

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
