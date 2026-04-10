---
id: ADR-019
title: 用户级 SessionStart/Stop Hooks 架构
status: accepted
date: 2026-03-17
participants: [铲屎官, Ragdoll/Opus, Maine Coon/GPT-5.4, 金渐层/OpenCode]
related: [F050, ADR-017]
---

# ADR-019: 用户级 SessionStart/Stop Hooks 架构

## 背景

2026-03-16~17 铲屎官集中治疗全猫行为退化问题（猜测式 debug、A2A 断链、review 盲改、共享文档不提交等）。讨论到 hook 自动化时，参考 [everything-claude-code](https://github.com/affaan-m/everything-claude-code) 的 hook 体系，提出是否引入工具级 hooks（PostToolUse auto-format、tsc check 等）。

## 决策

### 1. 工具级 hook（PreToolUse/PostToolUse）不做全猫统一

**原因**（铲屎官判断）：各 CLI 工具级 hook 支持不一致（Claude Code 完整、Gemini CLI 完整、OpenCode 用 plugin、Codex CLI 无），强行在部分猫加会导致行为不一致——出问题时无法定位是提示词还是 hook 的问题。

**结论**：行为一致性 > 自动化程度。工具级 hook 只在Ragdoll（Claude Code）做项目级守卫（evidence guard、runtime sanctuary），不承担全猫共用的纪律执行。

### 2. 生命周期 hook（SessionStart/Stop）做全猫统一

**原因**：所有 CLI 都支持 SessionStart + Stop（Claude Code、Codex CLI、Gemini CLI、OpenCode），是全猫统一的最大公约数。

**实现**：
- **真相源**：`.claude/hooks/user-level/session-start-recall.sh` + `session-stop-check.sh`
- **部署**：通过 `scripts/sync-system-prompts.ts --apply` 全量同步到 `~/`
- **位置**：用户级（`~/.claude/hooks/`），不是项目级

### 3. 用户级 vs 项目级分层

| 层 | 位置 | 生效范围 | 内容 |
|---|---|---|---|
| 用户级 | `~/.claude/hooks/` | 所有项目（出征也带着走） | SessionStart/Stop 通用纪律 |
| 项目级 | `.claude/hooks/` | 只在 cat-cafe | evidence guard、runtime sanctuary 等项目特有守卫 |

**出征场景**：猫猫去 tutorials/clowder-ai 等项目时，用户级 hooks 跟着走（检查脏文件、提醒搜上下文），项目级 hooks 不误触发。

### 4. Hook 脚本纳入 sync 管道

**铲屎官原话**："万一你下次把这个 hook 改了，难道我又要自己脑子里记着要去 hook 脚本吗？"

**结论**：hook 脚本和 AGENTS.md/GEMINI.md 一样走 `sync-system-prompts.ts` 全量同步。改了源文件，跑一次 `--apply` 就全量到位，不靠人脑记。

### 5. 全猫统一的三个守卫层

| 层 | 工具 | 全猫覆盖 |
|---|---|---|
| 提示词 | shared-rules / governance-l0 / 各猫原生 prompt | ✅ 所有 CLI |
| Git hooks | commit 前 biome check | ✅ 所有猫都走 git |
| MCP | F102 search_evidence / cat_cafe_post_message | ✅ 所有猫都接入 |

## 否决的方案

- **统一抽象层 `cat-cafe-hooks/`**：过早抽象，Codex CLI 工具级 hook 还没有，三缺一
- **PostToolUse auto-format hook**：行为不一致风险 > 自动化收益
- **PreCompact 保存状态**：我们已有 CLAUDE.md "压缩后自检"清单，自动化收益有限
- **Runtime 启动时动态改 home prompt**：ADR-017 已否决

## 后续

- 开源仓 clowder-ai 的 Outbound Sync 时带上 `.claude/hooks/user-level/` + `.claude/settings.json`
- Codex CLI 如果加了 PreToolUse/PostToolUse 支持，重新评估工具级 hook 统一方案
