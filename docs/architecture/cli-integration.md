---
feature_ids: []
topics: [architecture, cli, integration]
doc_kind: note
created: 2026-02-26
---

# CLI 集成架构：Claude Code / Codex / Gemini CLI

> Cat Cafe 项目如何对接三个不同厂商的 AI CLI 工具
> 作者：Ragdoll | 最后更新：2026-02-07

## 概述

Cat Cafe 需要调用三个不同厂商的 AI Agent：
- **Ragdoll** → Claude Code CLI (`claude`)
- **Maine Coon** → OpenAI Codex CLI (`codex`)
- **Siamese** → Google Gemini CLI (`gemini`)

这三个 CLI 有不同的调用方式、输出格式和 Session 管理机制。本文档记录我们的集成方案和踩过的坑。

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
│ ClaudeAgentService│ │ CodexAgentService │ │ GeminiAgentService│
│  (Ragdoll Opus)     │ │  (Maine Coon Codex)    │ │  (Siamese Gemini)   │
└─────────┬─────────┘ └─────────┬─────────┘ └─────────┬─────────┘
          │                     │                     │
          └─────────────────────┼─────────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │      spawnCli()       │
                    │  (通用子进程管理器)     │
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │   parseNDJSON()       │
                    │  (NDJSON 流解析器)     │
                    └───────────────────────┘
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

三个 CLI 都支持 NDJSON（Newline-Delimited JSON）流式输出，每行一个 JSON 对象。

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
  const child = spawn(options.command, options.args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // ... 超时、取消、清理逻辑

  for await (const event of parseNDJSON(child.stdout)) {
    resetTimeout();  // 每次输出重置超时计时器
    yield event;
  }
}
```

**处理的问题：**

| 问题 | 解决方案 |
|------|----------|
| 进程超时 | 可配置超时 (`CLI_TIMEOUT_MS`)，默认 30 分钟，`0` 禁用 |
| 优雅终止 | 先 SIGTERM，3 秒后 SIGKILL |
| 僵尸进程 | `process.on('exit')` 钩子强制清理 |
| 用户取消 | 支持 `AbortSignal` |
| 错误上报 | CLI 退出码非零时 yield `{ __cliError: true, ... }` |

**重要教训：stderr 活跃也算"活着"**

```typescript
// Bug: Claude CLI 的 thinking/工具调用输出到 stderr，不是 stdout
// 如果只监听 stdout，会误判为"超时无响应"
child.stderr?.on('data', () => {
  resetTimeout();  // stderr 有输出也重置超时！
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
- **MCP 支持**：通过 `--mcp-config` 注入我们的 MCP Server，让 Claude 能回调 Cat Cafe
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

### Gemini CLI (`gemini`)

**双 Adapter 架构：**

| Adapter | 命令 | 场景 |
|---------|------|------|
| `gemini-cli` (默认) | `gemini -p "..." -o stream-json -y` | 全自动 headless |
| `antigravity` | `open -a Antigravity` | IDE 模式，MCP 回传 |

**gemini-cli 调用方式：**
```bash
gemini -p "prompt" -o stream-json -y [-i image.png]
```

**NDJSON 事件格式 (v0.27.2)：**
```jsonc
// Session 初始化
{"type": "init", "session_id": "abc123"}

// 文本输出
{"type": "message", "role": "assistant", "content": "..."}

// 工具调用
{"type": "tool_use", "tool_name": "Read", "parameters": {...}}

// 工具结果 (跳过)
{"type": "tool_result", ...}

// 成功 (跳过)
{"type": "result", "status": "success"}

// 错误
{"type": "result", "status": "error", "error": "..."}
```

**特殊处理：**
- **Session 恢复（F053，2026-03-03）**：在当前环境（Gemini CLI 0.31.0）支持 `gemini --resume <sessionId>`（UUID），provider 已启用 resume；prompt prepend 继续用于跨猫历史补全
- **图片支持**：通过 `-i` flag 传递
- **Antigravity fallback**：IDE 模式不输出 NDJSON，需要通过 MCP 回传

**事件转换：**
```typescript
function transformGeminiEvent(event, catId): AgentMessage | null {
  // init → session_init
  if (e['type'] === 'init') {
    return { type: 'session_init', catId, sessionId: e['session_id'], ... };
  }
  // message + assistant → text
  if (e['type'] === 'message' && e['role'] === 'assistant') {
    return { type: 'text', catId, content: e['content'], ... };
  }
  // tool_use → tool_use
  if (e['type'] === 'tool_use') {
    return { type: 'tool_use', catId, toolName: e['tool_name'], toolInput: e['parameters'], ... };
  }
  // result + error → error
  if (e['type'] === 'result' && e['status'] !== 'success') {
    return { type: 'error', catId, error: e['error'], ... };
  }
  return null;
}
```

---

## 踩坑记录

### 1. stderr 不是错误，是 thinking

**问题**：Claude CLI 的 thinking 输出和工具调用日志都走 stderr，不是 stdout。如果只监听 stdout 来判断"CLI 是否活着"，会导致误杀正在工作的进程。

**解决**：stderr 有输出时也重置超时计时器。

```typescript
child.stderr?.on('data', () => {
  resetTimeout();  // stderr 活跃 = CLI 还在工作
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

**当前结论（2026-03-03）**：Gemini CLI 0.31.0 已支持 UUID `--resume <sessionId>`，`GeminiAgentService` 已接入；prompt prepend 保留为跨猫上下文补充，不再作为 resume 的替代策略。

### 5. stderr 不能暴露给用户

**问题**：stderr 可能包含 debug 信息、API key 或内部 trace。

**解决**：stderr 只写 `console.error` 供开发调试，不 yield 给前端。错误消息用脱敏的固定文案。

```typescript
// 日志（开发用）
console.error(`[cli-spawn] ${command} stderr (debug only):\n${stderrBuffer}`);

// yield 给用户（脱敏）
yield { __cliError: true, message: `CLI 异常退出 (code: ${exitCode})` };
```

---

## 配置管理

模型配置支持三层优先级：

```
环境变量 > cat-config.json > 硬编码默认值
```

**环境变量：**
```bash
CAT_OPUS_MODEL=claude-opus-4-6
CAT_CODEX_MODEL=gpt-5.3-codex
CAT_GEMINI_MODEL=gemini-3-pro
```

**配置文件 (`cat-config.json`)：**
```json
{
  "version": 1,
  "breeds": [
    {
      "catId": "opus",
      "variants": [{ "defaultModel": "claude-opus-4-6", ... }]
    },
    ...
  ]
}
```

**读取逻辑 (`cat-models.ts`)：**
```typescript
export function getCatModel(catName: 'opus' | 'codex' | 'gemini'): string {
  // 1. 环境变量最高优先
  const envValue = process.env[MODEL_ENV_KEYS[catName]];
  if (envValue?.trim()) return envValue.trim();

  // 2. cat-config.json 次优先
  const jsonModels = loadModelsFromJson();
  if (jsonModels[catName]) return jsonModels[catName];

  // 3. 硬编码默认值
  return CAT_CONFIGS[catName].defaultModel;
}
```

---

## 测试策略

通过依赖注入 mock spawn 函数进行单元测试：

```typescript
// 测试用的 mock spawn
function mockSpawn(command, args, options) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();

  // 模拟 NDJSON 输出
  setTimeout(() => {
    child.stdout.write('{"type": "init", "session_id": "test-session"}\n');
    child.stdout.write('{"type": "message", "role": "assistant", "content": "Hello!"}\n');
    child.stdout.end();
    child.emit('exit', 0, null);
  }, 10);

  return child;
}

// 注入 mock
const service = new GeminiAgentService({ spawnFn: mockSpawn });
```

---

## 未来改进

1. **进程池**：避免每次 spawn 的 500ms-2s 启动开销
2. **CLI 版本检测**：不同版本 NDJSON 格式可能变化，需要版本锁定或适配
3. **Cancel 协议**：目前是 SIGTERM/SIGKILL 硬杀，理想情况应该有优雅取消协议
4. **MCP 双向通信**：让非 Claude 猫也能通过 MCP 回传（目前用 HTTP callback 模拟）

---

## 相关文件

```
packages/api/src/
├── utils/
│   ├── cli-spawn.ts          # 通用子进程管理
│   ├── cli-types.ts          # 类型定义
│   ├── cli-format.ts         # 错误格式化
│   └── ndjson-parser.ts      # NDJSON 解析
├── config/
│   ├── cat-models.ts         # 模型配置读取
│   └── cat-config-loader.ts  # JSON 配置加载
└── domains/cats/services/
    ├── ClaudeAgentService.ts # Ragdoll
    ├── CodexAgentService.ts  # Maine Coon
    └── GeminiAgentService.ts # Siamese
```
