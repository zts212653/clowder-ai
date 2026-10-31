---
feature_ids: [F118, F212, F325]
topics: [architecture, cli, integration]
doc_kind: note
created: 2026-02-26
tips_exempt: Automatic CLI process-ownership repair with no new user action or discoverable capability.
---

# CLI 集成架构：Claude Code / Codex / Google CLI

> Clowder AI 项目如何对接三个不同厂商的 AI CLI / adapter 工具
> 原作者：Ragdoll | Google/AGY 接线更新：2026-10-14（Astra）

## 概述

Clowder AI 需要调用三个不同厂商的 AI Agent：
- **Ragdoll** → Claude Code CLI (`claude`)
- **Maine Coon** → OpenAI Codex CLI (`codex`)
- **Google/AGY 成员** → 官方 Antigravity CLI (`agy`)，显式 Native profile、个人 OAuth、原生 agent 指令与 stream-json。身份由成员目录决定；旧 Gemini CLI / IDE 执行入口已退役。

这些载体有不同的调用方式、输出格式和会话机制。Google/AGY 当前由 `AgyNativeAgentService` 接入；普通 MCP、技能发现和宿主保护沿用共享真相源。历史错误保留作诊断，不再用旧 plain-text/SQLite 轮询兜底。下面 Claude/Codex 的旧命令示例保留其原时点，当前 app-server 细节以对应实现与 ownership cell 为准。

Native 在官方 CLI `init` 确认实际会话后才经 F296 组装正文、经 F299 记录并写入 stdin；错误会话不能先拿到正文。`/compact` 的已完成 checkpoint 进入现有 context epoch owner，不新建会话状态源。

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        AgentRouter                           │
│  (路由逻辑: @mention 解析 → 选择猫 → 调用 AgentService)        │
└───────────────┬─────────────────┬─────────────────┬─────────┘
                │                 │                 │
                ▼                 ▼                 ▼
┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
│ ClaudeAgentService│ │ CodexAgentService │ │ AgyNativeService  │
│  (Ragdoll Opus)     │ │  (Maine Coon Codex)    │ │  (Google/AGY CLI) │
└─────────┬─────────┘ └─────────┬─────────┘ └─────────┬─────────┘
          │                     │                     │
          └─────────────────────┼─────────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │      spawnCli()       │
                    │ lifecycle + liveness │
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │ cli-supervisor (Unix) │
                    │ process-group signals │
                    └───────────┬───────────┘
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
    ┌───────────────────────┐         ┌────────────────────────────┐
    │   parseNDJSON()       │         │ antigravity-cli parser     │
    │  (Claude/Codex/gemini)│         │ (`agy --print` plain text) │
    └───────────────────────┘         └────────────────────────────┘
```

**核心设计决策：CLI 子进程而非 SDK**

我们选择 CLI 子进程模式而非直接调用 SDK，原因是：

1. **订阅复用**：用户已有 Claude Max / ChatGPT Plus / Gemini Advanced 订阅，不想再付 API 费用
2. **功能完整**：CLI 已实现 MCP、工具调用、文件操作等复杂功能
3. **隔离安全**：子进程天然隔离，崩溃不影响主进程
4. **更新解耦**：CLI 更新不需要重新部署后端

---

## 通用基础设施

### 1. NDJSON 流解析器 (`ndjson-parser.ts`)

Claude、Codex 和 legacy `gemini-cli` 支持 NDJSON（Newline-Delimited JSON）流式输出，每行一个 JSON 对象。默认的 `antigravity-cli` 不走这里：`agy --print` 只在 stdout 输出 plain text，使用 `antigravity-cli-event-parser.ts` 分类 timeout、missing-model、fresh-conversation warning 和最终文本。

```typescript
// 核心实现
export async function* parseNDJSON(stream: Readable): AsyncGenerator<unknown> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      yield { __parseError: true, line: trimmed, error: 'Failed to parse JSON line' };
    }
  }
}
```

**关键点：**
- 使用 `readline` 逐行处理，内存友好
- 空行静默跳过
- JSON 解析失败不抛出，而是 yield 一个特殊的 `ParseError` 对象

### 2. CLI 进程管理器 (`cli-spawn.ts`)

封装子进程生命周期管理：

```typescript
export async function* spawnCli(options: CliSpawnOptions): AsyncGenerator<unknown> {
  const child = spawnSupervisor(options);

  // valid stdout activity resets the response timer;
  // ProcessLivenessProbe independently samples PID/CPU.

  for await (const event of parseNDJSON(child.stdout)) {
    resetTimeout();
    yield event;
  }
}
```

**处理的问题：**

| 问题 | 解决方案 |
|------|----------|
| 进程超时 | 默认 `CLI_TIMEOUT_MS=0`，不自动终止；显式正数配置才 opt in response timeout 与 bounded extension |
| Stall 处理 | `alive_but_silent` / `suspected_stall` 只告警；不自动发信号，由用户 Cancel 决定是否终止 |
| 有界返回 | 终止提交后停止等待新 stdout；等 child exit 或最终 SIGKILL attempt，再给 100ms stdio drain，不依赖 wrapper 永远正确 close |
| 活性检测 | CPU/PID 每 60s sample；warning queue 每 ≤1s drain，避免 threshold 后再拖两个 sample interval |
| Unix 进程组 | `cli-supervisor` 原样转发 SIGINT；SIGTERM 进入 supervisor 自有 SIGTERM→SIGKILL orphan cleanup |
| 僵尸进程 | `process.on('exit')` 钩子强制清理 |
| 用户取消 | `AbortSignal` 是默认唯一终止入口；取消后才进入既有有界清理链 |
| 错误上报 | timeout 固定为 `cli_response_timeout` / `cli_stall_timeout`；kill 后 exit 只放 `terminalContext.postKill*`，不覆盖 timeout cause |

**长驻 carrier 也必须走同一 ownership seam（2026-08-13）**：

| Carrier | 生命周期归属 |
|---------|------------|
| Claude / Codex `exec` / Gemini / AGY headless / Kimi / OpenCode | `spawnCli` → `cli-supervisor` |
| Codex app-server（stdio 与 pooled Unix socket） | `cli-supervisor` 持有 host 整棵进程树 |
| ACP stdio / HTTP stream | `cli-supervisor` 持有 pool process 整棵进程树 |
| Claude `--bg` daemon | job manifest 持有 daemon short id + allowlisted native stop context；dispatcher 正常退出不代表 job 结束 |
| Codex tmux carrier | tmux pane 是 owner；关闭时 kill pane |
| Antigravity Desktop callback adapter | 外部 GUI 会话，不把整个用户 App 当作 invocation 子树回收 |

Unix 清理不能只依赖一个 PGID：Codex 的 `code-mode-host` 等子孙可以自行创建新进程组。每个 supervisor
在 provider root 执行前先原子写入 `${CAT_CAFE_DATA_DIR}/cli-process-owners/<ownerId>.json`，再把随机
`CAT_CAFE_PROCESS_OWNER_ID` 注入 root 环境；正常 fork / exec / 重父化 / 新 PGID 会继承这个 owner token。
因此默认 1 秒循环只检查原 API parent 是否存活，不做全量 `ps`；SIGINT、TERM、leader exit 等生命周期边缘
才扫描 token 投影，先 TERM，超时后重新扫描并只 KILL 当前仍匹配的 owner 进程。安全的完整 PGID 才走组信号，
混合 PGID 退回逐 PID；整树归零即撤销 escalation 并删除 manifest。

supervisor 自身遭 `SIGKILL` 时无法执行清理，所以 owner manifest 是 crash recovery 真相源。API 在开始监听前
读取 manifests，以 supervisor PID + `lstart` 栅栏跳过活 owner，只回收死亡 owner 的 token 子树；扫描失败或
无法证明归零时保留 manifest 下次重试。Codex socket 目录也记录在同一 manifest 中，且仅在 matching processes
归零后删除。这个 reaper 不按 `codex` / `claude` 等命令名匹配，禁止退化为 `pkill -f`。

Claude `--bg` 是 dispatcher-first 生命周期，不能把短命的 `claude --bg` dispatcher 套进 leader-exit
supervisor：dispatcher 成功退出时 worker 才刚开始工作。carrier 在 dispatch 前写
`${CAT_CAFE_DATA_DIR}/claude-bg-job-owners/<ownerId>.json` 的 `pending` 记录；记录只持严格 allowlist 的
native stop context（当前为归一化绝对路径 `CLAUDE_CONFIG_DIR`），不持 credential，也不向 shared daemon
注入 process-owner token。拿到严格校验的 8 位 short id 后原子激活。正常 abort/timeout 与 API startup
recovery 都在该 context 下执行 exact `claude stop <shortId>`；只有 stop exit 0 或 daemon 的 native
job-terminal state 才退休 active manifest。这里 UI turn completion 与 job lifecycle 严格分离：daemon
`done` / `error` / `failed` / `stopped` 可证明 job 已终止；`blocked` 表示 daemon 仍在等待，transcript
`turn_duration` 也只表示当前一轮完成，二者都继续保留 manifest。stop 失败、namespace 不可证或只有 pending
记录时同样保留 manifest、零 process signal；无 manifest 的其他 Claude job 和 shared daemon 始终不受影响。

**重要教训：stderr 是诊断证据，不是续命信号**

```typescript
// reconnect/debug chatter 曾让真正卡死的 CLI 永远重置 timeout。
// 现在只缓存 stderr；有效 stdout + PID/CPU probe 共同判断活性。
child.stderr?.on('data', (chunk) => {
  stderrBuffer += chunk.toString();
});
```

### 3. 统一消息类型 (`types.ts`)

三个 CLI 的原始事件格式不同，但转换后统一为 `AgentMessage`：

```typescript
type AgentMessage =
  | { type: 'session_init'; catId: CatId; sessionId: string; timestamp: number }
  | { type: 'text'; catId: CatId; content: string; timestamp: number; metadata?: MessageMetadata }
  | { type: 'tool_use'; catId: CatId; toolName: string; toolInput: Record<string, unknown>; timestamp: number }
  | { type: 'error'; catId: CatId; error: string; timestamp: number; metadata?: MessageMetadata }
  | { type: 'done'; catId: CatId; timestamp: number; metadata?: MessageMetadata }
  // ... 更多类型
```

---

## 各 CLI 对接详解

### Claude Code CLI (`claude`)

**调用方式：**
```bash
claude -p "prompt" \
  --output-format stream-json \
  --verbose \
  --model claude-opus-4-6 \
  --allowedTools Read,Edit,Glob,Grep \
  --permission-mode acceptEdits \
  [--resume <sessionId>] \
  [--mcp-config <json>] \
  [--images <path>]
```

**NDJSON 事件格式：**
```jsonc
// Session 初始化
{"type": "system", "subtype": "init", "session_id": "abc123"}

// 文本输出 (content 是数组，可能有多个 block)
{"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}]}}

// 工具调用
{"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {...}}]}}

// 成功完成 (我们跳过，自己 yield done)
{"type": "result", "subtype": "success"}

// 错误
{"type": "result", "subtype": "error", "error": "..."}
```

**特殊处理：**
- **MCP 支持**：通过 `--mcp-config` 注入我们的 MCP Server，让 Claude 能回调 Clowder AI
- **图片传递**：通过 `--images` flag 传递本地图片路径
- **Session 恢复**：通过 `--resume <sessionId>` 恢复上下文

**事件转换：**
```typescript
function transformClaudeEvent(event, catId): AgentMessage | null {
  // system/init → session_init
  if (e['type'] === 'system' && e['subtype'] === 'init') {
    return { type: 'session_init', catId, sessionId: e['session_id'], ... };
  }
  // assistant → 遍历 content blocks，提取 text 和 tool_use
  if (e['type'] === 'assistant') {
    const messages = [];
    for (const block of e.message.content) {
      if (block.type === 'text') messages.push({ type: 'text', content: block.text, ... });
      if (block.type === 'tool_use') messages.push({ type: 'tool_use', toolName: block.name, ... });
    }
    return messages;  // 可能返回多条消息
  }
  return null;  // 跳过其他事件
}
```

---

### Codex CLI (`codex`)

**调用方式：**
```bash
# 新会话
codex exec --json --sandbox workspace-write --full-auto "prompt"

# 恢复会话 (注意 resume 是子命令，不是 flag)
codex exec resume SESSION_ID "prompt" --json --sandbox workspace-write --full-auto
```

**NDJSON 事件格式：**
```jsonc
// Session 初始化
{"type": "thread.started", "thread_id": "thread_abc123"}

// 文本输出 (在 item.completed 里)
{"type": "item.completed", "item": {"type": "agent_message", "text": "..."}}

// 命令执行 (我们跳过)
{"type": "item.completed", "item": {"type": "command_execution", ...}}

// 文件修改 (我们跳过)
{"type": "item.completed", "item": {"type": "file_change", ...}}

// Turn 生命周期 (我们跳过)
{"type": "turn.started"}
{"type": "turn.completed"}
```

**特殊处理：**
- **Sandbox 模式**：`--sandbox workspace-write` 是 OS 级别沙箱，只允许写工作目录
- **无图片支持**：Codex CLI 目前不支持图片传递，我们在 prompt 里嵌入路径提示
- **Session 恢复语法不同**：是 `resume SESSION_ID` 子命令，不是 `--resume` flag

**事件转换：**
```typescript
function transformCodexEvent(event, catId): AgentMessage | null {
  // thread.started → session_init
  if (e['type'] === 'thread.started') {
    return { type: 'session_init', catId, sessionId: e['thread_id'], ... };
  }
  // item.completed + agent_message → text
  if (e['type'] === 'item.completed' && e['item']?.type === 'agent_message') {
    return { type: 'text', catId, content: e['item']['text'], ... };
  }
  return null;  // 跳过 command_execution, file_change, turn.* 等
}
```

---

### Google / AGY Native (`agy`)

`AgyNativeAgentService` 每回合启动一个受监督的官方 CLI。独立 HOME 绑定当前成员 profile；`--agent` 指向 canonical L0 compiler 生成的原生 agent，`--model` 使用已选择型号，`--input-format stream-json --output-format stream-json` 通过 stdin 传递消息，`--conversation` 只接续已有且核验一致的绑定。权限模式来自用户显式设置，Native hook 复用共享目标保护。

- `init` 先核对 agent、cwd、model、permission 与请求 session，再立即对宿主可见；`step_update` 增量转换文字和工具进度。进程清理完成后发一次终态。
- 普通工具错误保留给模型处理；未知工具在执行前拒绝。后续解释和成功回复不会被一次找不到文件或测试失败抹掉。
- `result.usage` 是会话累计值。账单与当前上下文来自唯一 model step 的 usage，缓存计入输入，thinking 不重复加到输出。
- 当前固定 CLI 1.3.5 可能保留上轮 `result.error`。只有本轮完成事件、最终文字匹配及干净退出等证据齐全，才把它识别为历史错误；新失败仍失败。
- canonical SessionChainStore 保存 Native binding。L0/模型/权限/工作区变化必须有可见边界和历史重建；部分输出或 exact resume 不能静默 fresh。
- 已验证 `/compact` 通过官方 headless 协议产生 checkpoint。沿现有 `requestNativeCompaction` / F296 epoch owner 路径接入，空回复只有明确控制请求及当前 checkpoint 证据才有效。普通空回复仍为异常。
- 图片、PDF、音频/视频等上传文件通过受约束的真实文件引用与 native `view_file` 读取；不谎称 stream-json 接受任意原生 image input block。
- 长任务经 `ManagedJobService` 与既有 `hold_ball` 暴露，独立于本轮 CLI；普通插话不会取消 job。日志、终态、取消及显式重试有持久证据。

旧 `GeminiAgentService`、IDE Bridge、plain-text 执行 parser 和 Task 专属测试工具已删除。旧历史 import/lifecycle reader、通用 ACP transport 与独立 MCP consumer 保留。迁移、版本边界和实测范围见 F325 证据 (internal)。

---

## 踩坑记录

### 1. stderr chatter 不能无限延长 invocation

**问题**：部分 CLI 会把 thinking、重连或 transport debug 写到 stderr。把任意 stderr 当活动曾让重连 chatter 不断重置 timer，真实卡死 invocation 最长拖到约 30 分钟。

**解决**：stderr 只缓存作脱敏诊断，不重置 response timer，也不调用 `probe.notifyActivity()`。长工具/思考期由 PID + CPU growth 判为 `busy-silent`，可以 bounded extension，但不能无限续命。

```typescript
child.stderr?.on('data', (chunk) => {
  stderrBuffer += chunk.toString();
});
```

### 2. CLI_TIMEOUT_MS=0 不生效

**问题**：`Number(env['CLI_TIMEOUT_MS']) || 1800000` 对 `0` 无效，因为 `0 || 1800000 = 1800000`。

**解决**：显式判断：
```typescript
const parsed = Number(raw);
if (Number.isFinite(parsed) && parsed >= 0) {
  return parsed;  // 0 也是合法值（禁用超时）
}
return FALLBACK_TIMEOUT;
```

### 3. Codex resume 语法不同

**问题**：Claude 用 `--resume sessionId`，Codex 用 `resume SESSION_ID` 作为子命令。

**解决**：分开处理：
```typescript
// Codex
const args = options?.sessionId
  ? ['exec', 'resume', options.sessionId, prompt, '--json', '--full-auto']
  : ['exec', '--json', '--sandbox', SANDBOX_MODE, '--full-auto', prompt];
```

### 4. Gemini resume 语义纠偏（F053）

**背景**：2026-02 阶段我们曾按“index/latest only”实现降级路径。

**历史结论（2026-03-03）**：Gemini CLI 0.31.0 当时已支持 UUID resume。F325 已退役该执行 consumer；当前使用上述 Native conversation binding，不复用旧载体 ID。

### 5. stderr 不能暴露给用户

**问题**：stderr 可能包含 debug 信息、API key 或内部 trace。

**解决**：raw stderr 永不进入用户消息。只有 `LOG_CLI_STDERR=1` 时才把经过共享 sanitizer 且截断后的 excerpt 写后台日志；前端只接收 whitelist reason、humanized text 与安全的 `debugRef`。

```typescript
const stderrForLog = formatCliStderrForLog(stderrBuffer);
if (stderrForLog) diagnosticLogger.error({ command, stderr: stderrForLog }, 'CLI stderr');

yield { __cliError: true, message: humanizedMessage, cliDiagnostics };
```

---

## 配置管理

模型配置的运行时来源是 `.cat-cafe/cat-catalog.json`（由 `cat-template.json` 首次启动时 bootstrap 生成）。

- `cat-template.json`（repo 根）：种子模板，仅在首次启动且 catalog 不存在时复制生成 catalog。后续不参与运行时读取
- `.cat-cafe/cat-catalog.json`：唯一运行时配置源。所有猫的增删改查都直接操作此文件
- 环境变量 `CAT_{CATID}_MODEL`（如 `CAT_OPUS_MODEL`）：可 override 运行时配置，用于调试或临时切换模型。正常使用不需要

**配置文件格式：**
```json
{
  "version": 2,
  "breeds": [
    {
      "id": "ragdoll",
      "defaultVariantId": "opus",
      "variants": [{ "id": "opus", "defaultModel": "claude-opus-4-6", ... }]
    }
  ]
}
```

---

## 测试策略

Native 单元测试通过 `spawnCliFn` / `spawnCliOverride` 输入原始事件，覆盖拒绝、工具恢复、断流、计费及绑定变化。固定官方 CLI 回环探针证明真正的工具、hooks、skills、压缩与系统指令接线；真实 OAuth、普通 Chat、用户停止和后台任务证据另记，不用 scripted provider 冒充真实模型行为。

脚本：`scripts/probes/f325-agy-native-{mcp-wire,outcome-wire,compaction-wire}.mjs`。测试入口和实测版本见 F325 证据 (internal)。

---

## 未来改进

1. **进程池**：避免每次 spawn 的 500ms-2s 启动开销
2. **CLI 版本检测**：不同版本 NDJSON 格式可能变化，需要版本锁定或适配
3. **Provider capability negotiation**：Codex stall 已支持 SIGINT-first；若其他 CLI 也提供稳定 cooperative cancel，再按 provider 显式 opt in，不扩大全局默认
4. **MCP 接线**：Native 已消费 canonical discovery 与真实 callback auth；新载体继续复用该边界。

---

## 相关文件

```
packages/api/src/
├── utils/
│   ├── cli-spawn.ts          # 通用子进程管理
│   ├── CliTerminationController.ts # 单向有界信号状态机
│   ├── cli-supervisor.ts     # Unix 进程组守护 + 原样信号转发
│   ├── cli-types.ts          # 类型定义
│   ├── cli-format.ts         # 错误格式化
│   └── ndjson-parser.ts      # NDJSON 解析
├── config/
│   ├── cat-models.ts         # 模型配置读取
│   └── cat-config-loader.ts  # JSON 配置加载
└── domains/cats/services/
    ├── ClaudeAgentService.ts # Ragdoll
    ├── CodexAgentService.ts  # Maine Coon
    └── agents/providers/agy-native/AgyNativeAgentService.ts # Google/AGY Native
```
