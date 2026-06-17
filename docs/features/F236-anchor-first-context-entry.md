---
feature_ids: [F236]
related_features: [F148, F209, F192]
topics: [context-engineering, token-budget, mcp, harness]
doc_kind: spec
created: 2026-06-15
---

# F236: Anchor-First Context 入口 — 返回侧 token 减负

> **Status**: spec | **Owner**: Ragdoll (Ragdoll opus-48) | **Priority**: P1 | **Created**: 2026-06-15 | **Companion ADR**: ADR-203

## Why

每只猫每天烧的 context token，很大一块来自**实时调 MCP 工具的全文返回**——`get_thread_context` 默认就回 100 条、最多 200 条完整 message body，单次可塞爆上下文窗口，猫还没开始思考就耗掉一大半预算。这与 F148 在消息侧治理的痛点**同源**，只是发生在"当下→context"（猫实时调工具）而非"过去→context"（冷启动注入历史）。

**价值一句话**：让猫调工具时默认拿到"指针 + 预览"，全文按需第二跳取——把单次工具返回的 token 占用砍下来，且**不丢信息**（无损 anchor，不是有损截断）。

> **更大的图景（2026-06-15 发现）**：MCP 协作工具是**可控的起点**，但 cc 内置 Read/Grep（读文件/搜代码）才是 agent 工作流 token **大头**——经查证 cc PostToolUse hook 能治（Phase C）。本 feat 不止治小头，更要治大头，且做到 **rtk 做不到的**（rtk 只 hook Bash，放弃了 Read/Grep）。

## Current State / 现状基线（research 实测，2026-06-15）

- 记忆系统三入口（`search_evidence`/`graph_resolve`/`list_recent`）+ `read_file_slice` 已是 anchor-first 标杆（snippet 截 200 + drilldown hint + bounded reader 120/400 行）。
- F148（done）已治理"过去→context"：消息注入分层 + 历史 tool payload scrub（AC-A5）。
- **缺口（本 feat）**：实时协作读工具全 dump——`get_thread_context`（`callbacks.ts:1975`，default 100/max 200 full body）、`get_pending_mentions`（`callbacks.ts:1645`，每条 inline 全文）、`list_tasks`（`callback-task-routes.ts:239`，why 达 1000 字）；且 `get_message` drill 终点**也回 full content**（Maine Coon抽查），不改则 dump 只推迟到第二跳。
- **🔑 大头修正（2026-06-15 查证，更正初稿误判）**：cc 内置 Read/Grep/Glob 才是 token 大头。初稿误判"runtime 锁定看不到"——查 cc 官方 hook 文档推翻：**PostToolUse hook + `updatedToolOutput` 官方显示可 replace 内置工具返回**（⚠️ caveat：replacement 须匹配原 output shape，不对会被忽略；**C0 实测 shape+replace 后才升级为事实**——Maine Coon钉）。rtk 没解决是它只用 PreToolUse（46 处）零 PostToolUse，**不是平台限制**。家里 F230 已证 PostToolUse 可**观测** Read `tool_response`（可观测≠可替换，C0 补证替换）。→ Phase C（spike-gated）。

## What

把"anchor-first + 最内层封顶"落到**完全可控的 MCP 协作读工具**，与 F148（消息侧）形成完整版图。第一刀落在 callback route 的 projection helper（payload 组装处），不是 MCP wrapper（否则 HTTP/agent-key/UI 等调用方会绕过）。

### V1 scope（本期）
- `get_thread_context` / `get_pending_mentions` / `list_tasks` 默认返回 anchorized preview
- `get_message` drill 终点加 bounded 模式（`mode=preview|full` / `maxChars`）
- preview 字段：`id / threadId / timestamp / speaker / preview / contentLength / truncated / drillDown`
- pending mentions 特殊：长 mention 用 head+tail actionable excerpt + `requiresDrill=true`（不丢传球指令语义）

### Non-goals（V1 不做，防跑偏 — Maine Coon收窄）
- ❌ runtime transform 层（codex/agy tool_result）—— 二期，跨 runtime 兼容性项目
- ❌ outputSchema 迁移（`server.tool` → `registerTool`）—— Phase B 架构升级
- ❌ subagent 返回 schema 硬约束 —— subprocess 架构不可达，硬层另设计
- ⏳ cc 内置工具返回（Read/Grep/Glob）—— **移出 Non-goals**：PostToolUse 路径技术可行，升级为 Phase C（spike-gated，见下）
- ❌ opencode 内置工具返回 —— transformer 不发 tool_result，仍 runtime 锁定（cc ≠ opencode）

## Acceptance Criteria

> AC↔Why 同源 + 非作者可复核

### Phase A: 协作读工具 anchor 化
- [ ] AC-A1: `get_thread_context` 默认返回 preview（非 full body），长 thread 单次返回 token 对比基线降 ≥60%（telemetry 复核）
- [ ] AC-A2: 每条 preview 含 `id/threadId/timestamp/speaker/preview/contentLength/truncated/drillDown` 字段
- [ ] AC-A3: `get_pending_mentions` 长 mention 用 head+tail excerpt + `requiresDrill=true`，传球指令关键信息不丢（fixture 验证）
- [ ] AC-A4: `list_tasks` 的 why 字段 preview 化（默认精简，全文按需）
- [ ] AC-A5: 截断逻辑在 callback route projection helper（最内层），非 MCP wrapper（代码 review 复核）

### Phase B: drill 终点 bounded
- [ ] AC-B1: `get_message` 支持 `mode=preview|full`（或 maxChars），默认非 full
- [ ] AC-B2: full drill 显式触发，记录 `fullDrillChars` telemetry

### Phase C: cc 原生工具 anchor 化（spike-gated — 这才是大头）
> 前置 spike（与Maine Coon一起）：实测 cc PostToolUse hook + `updatedToolOutput` 能否 replace Read/Grep/Glob 返回。**spike 不过则本 Phase 不启动**（不脑补——文档说能 ≠ 我们场景能用）。
- [x] **AC-C0b (spike) ✅ PASS**: Grep shape（正文在顶层 `.content`）shape-matched replace 实证
- [ ] AC-C0c (spike) pending: Glob shape / 多 Read `tool_use_id` 独立 / session 持久化 / **interactive carrier parity**（本 spike 是 sdk-cli ≠ carrier；Phase C 若含 interactive carrier 须单独 AC 在 carrier path 复测）
- [ ] AC-C1: Read 返回默认 anchorized（文件路径 + 总行数 + 预览 + `read_file_slice` drill 指针），全文按需 drill
- [ ] AC-C2: Grep/Glob 返回分组 anchor（命中文件 + 计数 + drill），不 inline 全部命中行
- [ ] AC-C3: PostToolUse 仅 cc；codex（transform 可改）/ agy / opencode 等价机制单独评估，不假设都有
- [ ] AC-C4: 双边 eval 对 cc 工具同样适用（Read drill 净收益 = 省 − drill 成本）

## Eval / Tracking Contract（F192 / ADR-031）

1. **Primary Users + Activation**：所有 runtime 的猫调协作读工具时；activation = 工具返回走 anchorized 路径的比例。
2. **Friction Metric（双边公式 — Maine Coon KD，不许单边报喜）**：
   - 省：`returnedChars/tool_result`（默认 inline payload 下降）
   - 成本：`anchorOpenRate`（drill 触发率）+ `fullDrillChars`（drill 取回量）+ 任务返工轮次
   - **净收益 = 省 − drill 成本**
3. **Regression Fixture**（≥1）：① 长 thread `get_thread_context` 返回 token 上限；② pending mention 关键传球指令不丢；③ `get_message` full drill 仍可取全文。
4. **Sunset Signal**：若 `anchorOpenRate` 持续 >80%（猫几乎每次都 drill）→ anchor tax 净亏，该工具回退 inline 或调 threshold。

## 软 + 硬 + eval 三层（ADR-031）

| 层 | 计划 |
|----|------|
| **软** | skill/convention：新增读类 MCP 工具默认 preview+anchor；ADR-203 立原则 |
| **硬** | route projection helper 强制 preview（最内层封顶）；regression fixture 守 token 上限；lint 检测新读类工具缺 preview（Phase B） |
| **eval** | 双边公式 telemetry（returnedChars / anchorOpenRate / fullDrillChars / 返工）；sunset signal 监控 anchor tax |

## Architecture cell
- **Architecture cell**: MCP server tools + API callback routes（返回 payload 组装）
- **Map delta**: update required（callback route 新增 projection helper 层）
- **Why**: 在已有 callback route 返回构造前插入 anchorize 投影，不新建 Store/Router/Adapter

## Dependencies
- **Evolved from**: F148（消息侧分层，本 feat 是返回侧姊妹篇）
- **Related**: F209（evidence recall）/ F192（harness eval）
- **Companion**: ADR-203（anchor-first context 入口原则）

## Key Decisions
- KD-1: 新 F 号不 reopen F148（边界不同：消息侧 vs 返回侧）— Ragdoll×Maine Coon共识
- KD-2: 第一刀落 callback route projection helper（最内层封顶）— Maine Coon sharpen
- KD-3: drill 终点（get_message）也必须 bounded，否则 dump 只推迟 — Maine Coon发现
- KD-4: V1 不碰 outputSchema 迁移 / subagent schema（subprocess 不可达）— Maine Coon收窄
- KD-5: eval 双边公式，不许单边报省 — Maine Coon anchor tax 风险
- KD-6: **cc 大头可解（C0a/C0b 已实证 PASS，2026-06-16）**——`claude -p/sdk-cli` 下 shape-matched PostToolUse replace（Read `.file.content` / Grep `.content`）+ bounded drill pass-through 实测打通；built-in replacement 须匹配原 output shape（字符串被忽略，Maine Coon caveat 实证）。rtk 只用 PreToolUse 没做到。interactive carrier parity 待 Phase C 单独验 — Ragdoll×Maine Coon双猫 spike（更正"runtime 锁定"初稿误判，吸取 Workflow-schema 脑补教训）
