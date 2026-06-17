---
feature_ids: [F089]
related_features: [F063, F061]
related_decisions: [012]
topics: [terminal, tmux, workspace, xterm, pty, agent-observability]
doc_kind: spec
created: 2026-03-09
---

# F089 Hub Terminal & tmux Integration — 浏览器终端 + 猫猫可观测性

> **Status**: in-progress | **Owner**: Ragdoll

## Why

### 核心需求（operator 2026-03-08）

1. **观察猫猫操作**：agent 在 Claude CLI 里跑的子进程（Bash tool、subagent 等）operator看不到
2. **崩溃恢复**：agent 卡死时想看现场（而不是只能杀进程重来）
3. **手动接管**：agent 做到一半想人工接手继续
4. **浏览器内 terminal**：不想切 iTerm，在 Hub 里直接操作

### 第一性原理对照（P1 面向终态，不绕路）

> 终态是 tmux 管理所有 session，所以从 Day 1 底层就是 tmux。
> "先做纯 PTY 再叠 tmux" = 脚手架（Phase 1 PTY 在 Phase 3 被推翻），违反 P1。

## What

### 单源双消费架构（Maine Coon P1 审查修正）

```
                     ┌─ pipe-pane tee ─→ 机器解析（NDJSON/结构化事件）→ socket.io → 前端
tmux pane（agent 跑在这里）─┤
                     └─ node-pty attach ─→ @fastify/websocket → xterm.js（人类观看/接管）
```

**一个 agent = 一个 tmux pane。** 机器侧和人类侧消费同一个运行时的输出，不是两套进程。

旧版"双轨制"的问题：机器轨 spawn+pipe 是独立进程，人类轨 tmux pane 是另一个——operator在浏览器里看到的不是 agent 真正在干的事。

### tmux 架构

- **一个 worktree = 一个 tmux server**：`tmux -L catcafe-{worktreeId}`
- **用户 shell = tmux 里的一个 window/pane**
- **agent = tmux 里的另一个 pane**（Phase 1 先做用户 shell，Phase 2 加 agent pane）
- **观看 agent = 前端 attach 到 agent pane**（read-only）
- **接管 agent = 切换 pane 为 read-write**

### 技术栈

| 组件 | 选型 | 理由 |
|------|------|------|
| 前端 terminal | `@xterm/xterm` + addons | 业界标准，VSCode 也用 |
| terminal 传输 | `@fastify/websocket`（plain WS） | **已在 package.json，零新依赖** |
| 结构化事件 | `socket.io`（不变） | 现有基础设施 |
| 后端 PTY | `node-pty` | 跨平台，xterm.js 生态配套 |
| tmux 集成 | CLI 调用 (`execFile`) | 一次一个命令，简单可靠，就是终态 |
| 进程监控 | `pidtree` + `pidusage` | 跨平台（macOS + Linux） |

## Acceptance Criteria

- [x] AC-A1: tmux 单源双消费架构已落地并通过 Phase 1-3a 验证

### Phase 1：tmux 基础设施 + 用户 Shell（终态基座）

- [x] **Spike**：tmux CLI 调用可行性验证（2026-03-09 完成，CLI 6/6 PASS，control mode 不需要）
- [x] TmuxGateway 服务：worktree = tmux server 生命周期管理（CLI 调用）（PR #326）
- [x] `@fastify/websocket` 路由 `ws://host/api/terminal/:sessionId`（PR #326）
- [x] 用户 shell = tmux window/pane，通过 xterm.js 在浏览器操作（PR #326 + #332 lifecycle 收口）
- [x] WorkspacePanel 新增 Terminal tab — 单 shell 会话（PR #326）
- [ ] tmux window/pane 列表 UI（当前只有单 shell，列表 UI 延后到 Phase 3 与 agent pane 列表一起做）
- [x] 前端 `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-attach`（PR #326）

### Phase 2：Agent 在 tmux pane 里跑（后端 plumbing）

> 核心变化：agent（Claude CLI / Codex CLI）直接在 tmux pane 里启动，不是独立 spawn+pipe。
> 注：Phase 2 scope = 后端 runtime plumbing。前端 agent pane UI 入口移至 Phase 3（2026-03-09 愿景守护复盘，Maine Coon/GPT-5.4 指出 spec AC 与交付不符，按 P4 单一真相源原则调整分界）。

- [x] Agent invocation 在 tmux pane 里直跑 CLI 命令（`SpawnCliOverride` + `TmuxAgentSpawner`，PR #334）
- [x] FIFO-based tee pane 输出给机器侧 NDJSON 解析器（`spawnCliInTmux` FIFO pipeline，PR #334）
- [x] `remain-on-exit` 保留崩溃现场（`TmuxGateway.createAgentPane`，PR #334）
- [x] `select-pane -d` 默认 read-only（`TmuxGateway.setPaneReadOnly`，PR #334）
- [x] `AgentPaneRegistry` 内存跟踪 + `GET /api/terminal/agent-panes` 端点（PR #334）
- [x] Two-stage kill: C-c → 3s grace → kill-pane（Maine Coon P2 审查修正，PR #334）

### Phase 3：Agent 可观测 UI + Takeover + 进程监控

- [x] **tmux pane 列表 UI**（含用户 shell + agent pane，AgentPaneList 组件，Phase 3a）
- [x] **前端 agent pane attach/watch UI**（AgentPaneViewer + WS endpoint `/api/terminal/agent-panes/:paneId/ws`，Phase 3a）
- [x] **agent 侧 `worktreeId` 改用 canonical id**（`resolveWorktreeIdByPath()` 替代 `basename()`，Phase 3a）
- [ ] `select-pane -e` 切换 watch → takeover
- [ ] takeover 时暂停机器轨 NDJSON 解析（防干扰）
- [ ] `pidtree` + `pidusage` 进程树监控
- [ ] 前端 ProcessTree 组件

### Phase 4（远期）：stdin pipe + stream-json 双向通信

> CLI spawn（Claude Code CLI / Codex CLI / Gemini CLI）就是我们的终态 agent 入口。
> stdin pipe 是 takeover 的程序化升级：从"人工接管敲命令"到"程序化发指令"。

- [ ] 打开 `stdio[0]` 为 pipe
- [ ] `--input-format stream-json` / `--output-format stream-json`
- [ ] 程序化交互（Hub UI 直接给 CLI 发结构化指令）

## Key Decisions

1. **单源双消费**：agent 在 tmux pane 里跑，`pipe-pane` tee 给机器解析，前端 attach 同一 pane 观看（Maine Coon P1 审查修正，取代旧版"双轨制"）
2. **从 Day 1 底层就是 tmux**：不走"先纯 PTY 再叠 tmux"的绕路（P1 面向终态不绕路）
3. **workspace 级 tmux server**：一个 worktree = 一个 tmux server，不是 per-invocation
4. **plain WebSocket**：terminal 字节流用 `@fastify/websocket`，结构化事件继续用 socket.io。**⚠️ `@fastify/websocket` 全局注册会抢占 HTTP upgrade 事件，导致 Socket.IO WebSocket 握手 404（polling 不受影响）。修复：`onRequest` hook 对 `/socket.io/` 路径 `reply.hijack()`，让 Socket.IO 自行处理。**
5. **macOS 优先**：进程监控用 pidtree/pidusage（跨平台），不用 Linux cgroup
6. **tmux CLI 调用就是终态**：不需要 control mode (-CC)，Spike 2026-03-09 验证
7. **tmux agent spawner opt-in**：`CAT_CAFE_TMUX_AGENT=1` 才启用。Phase 2 PR #334 无条件创建 `TmuxGateway`，导致所有有 `workingDirectory` 的 agent 调用走 tmux pane——runtime 没配 tmux 时 CLI 直接 exit 1，猫猫全部静默失败。修复后默认关闭，Phase 3 完成 + tmux 环境就绪后再开启。

## Dependencies

- **Evolved from**: F063（Workspace Explorer 提供了文件/tab 基础，Terminal 是自然延伸）
- **Related**: F061（CDP Bridge 的子进程管理、crash recovery 经验可复用）

## Risk

| 风险 | 缓解 |
|------|------|
| node-pty macOS 需要编译原生模块 | 确认 Xcode CLI tools |
| agent spawn 迁移到 tmux pane | Phase 2 渐进式——Phase 1 先做用户 shell，验证基础设施 |
| terminal 安全 | 本地环境风险低；WS 路由加 session token 校验 |
| pipe-pane tee 性能 | 机器解析只需要 NDJSON 行，丢弃 ANSI 不影响 |

## Review Gate

- Phase 1 完成后请 codex review（后端 + 安全）
- 前端 terminal UX 请 gemini 审美把关

## 需求点 Checklist

| # | 需求点 | 来源 | 状态 |
|---|--------|------|------|
| 1 | 浏览器内打开 terminal（单 shell） | operator 2026-03-08 | done (Phase 1, PR #326 + #332) |
| 1b | 浏览器内 tmux pane 列表 UI | operator 2026-03-08 | done (Phase 3a, AgentPaneList) |
| 2 | 观察 agent 操作（后端 plumbing） | operator 2026-03-08 | done (Phase 2, PR #334) |
| 2b | 观察 agent 操作（前端 UI 入口） | operator 2026-03-08 | done (Phase 3a, AgentPaneViewer) |
| 3 | 崩溃现场保留 | operator 2026-03-08 | done (Phase 2, remain-on-exit) |
| 4 | 手动接管 agent | operator 2026-03-08 | pending (Phase 3) |
| 5 | 进程树可视化 | operator 2026-03-08 | pending (Phase 3) |
