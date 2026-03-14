---
topics: [backlog, bugs]
doc_kind: note
created: 2026-03-14
---

# Clowder AI — Bug & Issue Backlog

> 记录平台级 bug 和已知问题。Feature 请求见 [ROADMAP.md](ROADMAP.md)。

| ID | 名称 | Status | Severity | 发现日期 | Link |
|----|------|--------|----------|----------|------|
| BUG-001 | Agent session 上下文溢出死循环 | open | high | 2026-03-14 | 见下方 |

---

## BUG-001：Agent Session 上下文溢出死循环

**发现于**：Session `f8745592-98f6-4635-9e5a-399ce98a7fbc` (2026-03-14 17:47~17:57)
**项目**：EmailToolsForCoreMail-OpenHarmony（鸿蒙穿刺任务）
**涉及角色**：Opus（布偶猫）— Lead Architect

### 现象

- Opus agent 在执行"海风设计系统 Phase 1"时反复触发上下文压缩/恢复
- 每次恢复后注入大量 summary + mission context + system prompts
- 可用 token 极少，仅能执行 1-2 步就再次溢出
- 形成"西西弗斯循环"：TodoWrite → 溢出 → 恢复 → 再 TodoWrite → 溢出...
- 10 分钟内循环 6+ 次，最终只推进了 `git pull` + `git worktree add` 两步

### 根本原因（待确认）

1. **Dispatch mission context 注入体积过大** — 每次恢复都重新注入完整 mission context + 角色定义 + 队友信息
2. **恢复时 summary 累积膨胀** — "continued from previous conversation" 的 summary 本身占用大量 token
3. **长会话中 subagent 产出未被有效压缩** — 3 个 subagent 共 1.6 MB 数据

### 影响

- Agent 无法完成需要多步操作的任务（创建文件、写入内容、编译验证等）
- Token 浪费严重（反复恢复同一上下文）
- 任务中断后需人工介入续做

### 建议修复方向

1. **精简 dispatch mission context** — 恢复时只注入精简版 context（角色 + 当前任务 + todo 状态）
2. **恢复时截断历史** — 只注入最近 N 步的 todo 状态，不重复注入全部历史 summary
3. **溢出次数阈值** — 连续 N 次溢出后自动停止并通知人工，避免无限循环浪费 token
4. **任务原子化** — 大任务拆分为多个独立 session，每个 session 只做 1-2 步
