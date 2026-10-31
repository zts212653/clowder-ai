---
feature_ids: [F274]
related_features: [F203, F236, F262]
topics: [harness, kimi, native-l0, system-prompt, hooks, permission]
doc_kind: spec
tips_exempt: harness-internal L0 injection channel — no user/cat workflow surface for a capability tip
created: 2026-07-25
description: "Kimi CLI 在家里的 harness 能力差距盘点（对照 claude/codex），并把 L0 身份注入迁到 kimi-code 原生 --agent-file 系统提示词通道。"
description_source: model
description_author: 墨墨 (kimi)
description_updated_at: 2026-07-25T00:00:00Z
description_generated_by: kimi-code/k3
description_generated_at: 2026-07-25T00:00:00Z
description_confirmed_by: 墨墨 (kimi)
user_journey_exempt: harness-internal provider plumbing (L0 injection channel) — no user-perceivable surface; behavior change is cat-facing identity robustness
---

# F274: Kimi Native L0 + Harness 能力差距盘点

> **Status**: done | **Completed**: 2026-07-26（实现段 PR #3201 squash `12e085a80`；愿景守护 follow-up PR #3204 squash `3a029b9f6`） | **Owner**: 墨墨 (@kimi, kimi-code/k3) | **Priority**: P1
>
> **operator signoff**: 2026-07-25 追认立项 + 授权合入（"没关系你继续干吧…gate过了就可以合入了"）。跨族 review：gpt52（exact HEAD 无阻塞 + 跟进点已修）。GitHub Actions billing 欠费导致云端 CI 未启动，operator 已知悉豁免。

> **编号核验**: 2026-07-25 立项前检查 `docs/ROADMAP.md`、`docs/features/`、`git log -S F274 --all`；当前最大真实编号 F273，F274 无占用。

## Why

Kimi 猫的 L0（身份/家规/名册）一直走 `buildKimiPrompt` 塞进 user prompt 的 `<system_instructions>` 包裹——压缩后身份丢失风险与 F203 要解决的问题同源，但 F203 Phase C 的 `injectsL0Natively()` 只覆盖了 claude/codex/opencode。本 Feature 做两件事：

1. 盘点 kimi-code CLI（对照 claude/codex）的 harness 能力差距，逐项给出"能/怎么/值不值得"结论并留档；
2. 把最值得的一项——L0 原生系统提示词通道——落地。

## 能力差距评估矩阵（2026-07-24/25 查证 + 实证）

查证来源：kimi-code 官方文档（hooks / config-files / agents / env-vars / overrides / kimi-command 页）+ 本机 kimi-code 0.29.1 实证 probe（v2 engine、`KIMI_CODE_EXPERIMENTAL_FLAG=1`、`-p` 模式）。

| 能力 | claude/codex | kimi 改造前现状 | 结论 |
|------|-------------|----------------|------|
| L0 原生系统提示词 | `--system-prompt-file` / `-c developer_instructions`（`injectsL0Natively()` = true） | user prompt `<system_instructions>` 包裹 | ✅ **能做、值得做** → 本 Feature 落地 |
| Hooks（SessionStart/Stop 类） | sync-targets 写 `.codex/hooks.json` / `.gemini/hooks.json`（项目级） | kimi-code hooks 只认全局 `~/.kimi-code/config.toml`，官方明确"无 project-level config" | ⚠️ 能但不建议默认做：改用户全局配置 blast radius 大；如需做应为 opt-in managed block + 环境守卫 |
| Hooks（F236 anchor read mode） | PostToolUse hook 改写 Read/Grep/Glob 输出为 locator | kimi `PostToolUse` 是 **observation-only**（官方：main flow 不受返回值影响），无法改写 tool output | ❌ **不能支持**，留档；等 kimi-code 提供 output-rewrite 能力 |
| 权限模式 | claude `bypassPermissions` 显式传 | KimiAgentService 不传 `--yolo`/`--auto` | ✅ **无需改动**：`-p` 模式强制 auto permission + 静态 deny rules 生效；`--yolo/--auto` 与 `-p` 启动即互斥 |
| MCP | — | ✅ 已接 | 无差距 |
| Skills | — | ✅ `.kimi/skills` 已映射 | 无差距 |
| effort 档位 | ✅ | ✅ F262 / PR #3197 已合入 | 无差距 |

### 实证 probe 记录（kimi-code 0.29.1，均通过）

- `--agent-file` + v2 engine：agent body 进入 system role（PROBE_MARKER 可被引用）；`${base_prompt}` 正常渲染。
- `--output-format stream-json` 事件形状与 v1 一致：`role: meta`（`system.version` / `session.resume_hint`）、`role: assistant`、`tool_calls[].function` 结构不变 → `kimi-event-parser` 兼容。
- `--session <id>` resume + 重传同一 `--agent-file`：no-op rebind，正常续聊。
- **agent prompt 在 session 首 bind 冻结**：resume 时改 agent 文件内容不生效（旧 marker 仍被引用）。→ L0 更新只对新 session 生效，与 claude `--system-prompt-file` 每次重读不同，语义差异留档。
- hooks 在 `-p` + v2 下触发：`SessionStart` ✓、`UserPromptSubmit` ✓（stdout 注入 context ✓）、`PostToolUse` ✓（payload 含 `tool_output`，但 observation-only 无法改写）。

## What（本 Feature 落地范围）

`KimiAgentService` 在新 kimi-code（无 `kimi-cli` 二进制）下：

1. `injectsL0Natively()` 返回 true → 路由层改传 pack-only `systemPrompt`；
2. 复用 F203 `compileL0ViaSubprocess` 编译 per-cat L0，写成临时 agent 定义文件（frontmatter `name: cat-cafe-l0-<catId>` + body `${base_prompt}` + L0 + pack-only systemPrompt），以 `--agent-file` 传入，并强制 `KIMI_CODE_EXPERIMENTAL_FLAG=1` 选 v2 engine；
3. fail-closed：L0 编译失败 → error + done，不 spawn（对齐 Codex `developer_instructions` 语义），且不泄漏 temp 目录；
4. user cliConfigArgs 剥离 `--agent-file` / `--agent`（对齐 Claude `RESERVED_SYSTEM_PROMPT_FLAGS` / Codex `RESERVED_SYSTEM_CONFIG_KEYS`）；
5. legacy `kimi-cli` 路径完全不变（`<system_instructions>` 包裹）；
6. F237 compiled-preview 路由（`prompt-injection-preview.ts`）：kimi 的 native 判定从硬编码 clientId 列表改为与 service 共享的机器探测（`isKimiNativeL0ChannelAvailable()`），否则 preview 会继续给 kimi 展示旧的非 native S-segment 视图（gpt52 PR #3201 review 跟进点）。

agent `name` 必须 per-cat 稳定：kimi-code 在 session 首 bind 绑定 agent，resume 换名报 "already bound"。

## Non-goals（留档原因）

- **F236 anchor read mode 移植**：kimi `PostToolUse` observation-only，机制上不可改写 tool output。等 CLI 能力。
- **kimi hooks writer（sync-targets 第四 target）**：只能写全局 config.toml，需operator决策是否接受 opt-in 全局 managed block；不在本 Feature。
- **非 legacy 下 `--add-dir` 图片目录授权**：现仅 legacy 传 `--add-dir`，新 CLI 的图片输入只靠本地路径提示。另起小修。
- **非 legacy 下 tempMcpConfig 创建但不传参（dead write）**：新 CLI 的 MCP 实际走项目 `.kimi/mcp.json`（0.29.1 实证读取 legacy 路径，未文档化）。另起小修。
- **readKimiContextUsedTokens 只认 legacy `~/.kimi/sessions` 布局**：新 CLI session 在 `~/.kimi-code/sessions`，context usage enrichment 对新 CLI 静默失效。另查另修。

## Acceptance Criteria

- [x] Red: 新增 6 个测试先行失败（native 通道 / fail-closed / reserved args / legacy 不变 / injectsL0Natively 两态）
- [x] Green: kimi-agent-service 29 + provider-raw-internal-archive/profiles-kimi 10 全绿（main 复跑 38/38）
- [x] 实证：真实 KimiAgentService.invoke() → 真实 L0 编译 → `--agent-file` + v2 → 真实 CLI 回合（text + session_init + done）；kimi-code 0.29.1 probes 见上
- [x] `pnpm gate` 通过（`4cb02eaf5`、rebase 后 `b1ec3689f` 两次全绿）
- [x] 跨族 review 通过：gpt52（缅因族）exact HEAD 无阻塞 + 跟进点（preview 硬编码）已修
- [x] 愿景守护 follow-up（Terra BLOCKED P1）：resume L0 新鲜度机制——fingerprint 比对，stale/unverifiable → fresh session + 显式事件（PR #3204，6 条回归测试 + 三轮 P2 修复）
- [x] 愿景守护终审 APPROVE（Terra，exact HEAD `42e2c9e45`，2026-07-26）

## 愿景守护记录（2026-07-25，Terra @codex-terra）

**BLOCKED（P1）**：kimi-code 首 bind 冻结 agent prompt（本档实证），而实现无条件传 `--session` resume → 存量会话静默沿用旧 L0，F203 的 L0 freshness 约束（dependency-signature 失效即重编译生效）被架空；且漂移不可见。**P2**：doc 标 done 但 AC 未回填（本次回填）。

**修复设计**（feat/kimi-l0-resume-freshness）：每次 native 调用编译 L0 后算 sha256 指纹；resume 前与首 bind 时记录于 `<KIMI_SHARE_DIR>/cat-cafe-l0-session-fingerprints.json` 的指纹比对——一致才传 `--session`；stale / unverifiable（含 F274 前的老会话）→ fresh session 重新首 bind + `system_info: l0_resume_fresh_start` 显式事件（上下文连续性损失明面化）；fresh 时 pack 用 `resumeFallbackSystemPrompt ?? systemPrompt`（F198 语义）。指纹只覆盖编译后 L0，不覆盖 pack（pack 本就是每次调用可变内容）。不选 fail-closed error：模板每次迭代打挂全部存量会话成人工干预，比 fresh-start 的上下文成本更差。

## Risk

- **v2 engine 是 experimental**：`KIMI_CODE_EXPERIMENTAL_FLAG=1` 整引擎切换。缓解：stream-json 形状已实证兼容；测试覆盖 parser 主路径；CLI 升级若改行为会以 CLI error 形式响亮失败。
- **版本门槛**：`--agent-file` 需较新 kimi-code（0.29 实证）。旧版本 CLI 会以 unknown flag 报错——响亮失败，可接受。

## Key Decisions

- **KD-1**: 选 `--agent-file` 而非 `~/.kimi-code/SYSTEM.md`——后者是全局用户级文件，影响交互式 session；`--agent-file` 是 per-invocation 显式意图且优先级最高。
- **KD-2**: agent body 以 `${base_prompt}` 开头——保留 CLI 内建 prompt 骨架（环境/AGENTS.md/skills 注入），L0 只做加法。
- **KD-3**: fail-closed 对齐 Codex——缺 L0 的猫不如一次响亮失败的调用。
- **KD-4**: agent `name` per-cat 稳定（`cat-cafe-l0-<catId>`）——resume 的 already-bound 约束。
