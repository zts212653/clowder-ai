---
feature_ids: [F145, F159]
topics: [dsh, acp, mcp, startup-readiness, latency, provider-integration]
doc_kind: bug-report
created: 2026-09-01
status: handoff
---

# DSH ACP 首请求缺少 MCP 工具：修复交接

> 状态：**根因已由真实会话证据确认，尚未修改代码。** 这份文档供后续在
> `deepseek-harness` 与 `clowder-ai` 两个仓库实施、评审和验收；HiFP4 只是问题触发现场，
> 不是修复落点。

## 1. 结论先行

奶牛猫（`dsh` / DeepSeek Harness ACP）的慢调用包含一个确定的启动竞态：

1. Clowder AI 启动 DSH ACP 进程并写入包含三组 Cat Cafe MCP server 的 overlay。
2. DSH Loader 并行挂载根级插件；ACP transport 已可接收请求时，根级 `mcp-client`
   sibling 还没有完成初次 `connect → listTools → register`。
3. 首次模型请求因此只带 19 个内置工具、0 个 MCP 工具。
4. MCP 随后完成注册；同一会话下一次 `request/header` 已变为 139 个工具，其中
   120 个 MCP 工具。
5. 模型已经从首轮工具集出发，转而用 shell 查找 Cat Cafe CLI/MCP 调用入口，造成绕路和额外延迟。

因此，本问题不是“overlay 没生成”，也不是“MCP 永久加载失败”；准确病名是：
**ACP 首请求缺少 MCP startup-readiness barrier**。

## 2. 现场与版本

| 项目 | 现场值 |
| --- | --- |
| 发生日期 | 2026-09-01 |
| Clowder AI checkout | `/Users/yuhan/cat-cafe/cat-cafe-runtime` |
| Clowder AI revision | `c0f1e73c7`（`runtime/main-sync`，与 `origin/main` 同步） |
| DeepSeek Harness checkout | `/Users/yuhan/codespace/deepseek-harness` |
| DeepSeek Harness revision | `99f6f02`（`dsh-v0.1.0-rc.7` / `origin/master`） |
| 触发 thread | `thread_mt6w8liavro7wkr0` |
| 受影响 cat | `dsh`（`deepseek-v4-pro`） |
| 当时模型配置 | `thinking: enabled`、`reasoningEffort: max` |

诊断时两个仓库均未包含本问题修复。生成文件
`examples/acp-agent/cat-cafe-dsh-acp.cordis.yml` 是未跟踪 overlay，会被 Hub 重写，
**不得把手改该文件当作持久修复**。

## 3. 错误现象与复现证据

### 3.1 调用表现

Clowder audit log：

- invocation `ef68a9b2-8452-4a7f-b28c-d880c180d41b`
  - `cat_invoked`：audit line 129
  - 287,054 ms 后 `cat_error(user_cancel)`：audit line 132
- invocation `47913048-0753-4fa0-9584-1f19d82a2604`
  - `cat_invoked`：audit line 133
  - 57,420 ms 后 `cat_error(user_cancel)`：audit line 136

证据文件：

```text
packages/api/data/audit-logs/audit-2026-09-01.ndjson
```

两个终态都是用户取消；这证明的是“用户等待过久后取消”，不能反向解释成 provider
先失败。此前测得派发路由约 94 ms，不支持“排队十分钟”的假设。

### 3.2 首请求工具集发生状态跃迁

DSH 持久会话：

```text
/Users/yuhan/codespace/deepseek-harness/examples/acp-agent/.sessions/
  --Users-yuhan-codespace-cann-HiFP4--/
  575df4a1-ceb6-432d-b730-4c9f3894ad7a/session.jsonl.zstd
```

只读复现命令：

```bash
dsh_session='/Users/yuhan/codespace/deepseek-harness/examples/acp-agent/.sessions/--Users-yuhan-codespace-cann-HiFP4--/575df4a1-ceb6-432d-b730-4c9f3894ad7a/session.jsonl.zstd'
zstd -dc "$dsh_session" 2>/dev/null | jq -r '
  select(.type == "request/header") |
  [
    .seq,
    .time,
    (.data.header.tools | length),
    ([.data.header.tools[].name | select(startswith("mcp__"))] | length)
  ] | @tsv'
```

实测输出：

```text
9     1788262075642    19     0
1346  1788262100842    139    120
```

这组证据排除了三种误诊：

- **不是 overlay 缺失**：生成 overlay 中确实有 memory/collab/signals 三个 MCP client。
- **不是 Code Mode 误会**：基础 ACP 配置未启用 `tools.mode: code`，默认是 native tools。
- **不是 MCP 永久不可用**：第二个 header 已出现全部 120 个 MCP tool schema。

## 4. 根因调用链

### 4.1 DeepSeek Harness 侧

1. `packages/mcp/mcp-client/src/index.ts:140-179`
   - `apply()` 会等待 `connection.ready`；单个 MCP plugin 的 readiness 语义本身正确。
2. `packages/examples/acp-demo/src/index.ts:113-140`
   - `acp-demo` 等待自己的 spine/persistence/query 后，在 line 137 挂载 ACP transport。
3. Cat Cafe overlay 把 MCP clients 作为 `acp-demo` 的**根级 siblings**追加在配置末尾，
   而不是 `acp-demo` 的受控子生命周期。
4. `packages/boot/app-boot/src/index.ts:774-785`
   - `boot()` 最终会等待整个 Loader tree；但 ACP transport 在 tree 完全 settle 前已经安装
     stdin JSON-RPC handler，外部 Client 可以提前完成 initialize/session/new/prompt。

断裂点不是 `mcp-client.ready` 没 await，而是：
**没有任何依赖边把 ACP 对外 readiness 与所有 required MCP siblings 的 readiness 连接起来。**

### 4.2 Clowder AI 侧

`packages/api/src/domains/cats/services/agents/providers/acp/dsh-acp-bootstrap.ts`
负责生成 sibling overlay。Clowder 在 ACP client 可用后即可创建 session 并发送 prompt，当前没有
“首个模型请求必须已包含期望 MCP namespace”的握手或 fail-fast gate。

### 4.3 独立的身份边界缺陷（不是本次 schema 缺失的根因）

`dsh-acp-bootstrap.ts:211-212` 会把 API 进程环境里的单值
`CAT_CAFE_AGENT_KEY_FILE` 复制进 DSH MCP 子进程。现场生成 overlay 因而出现：

```text
CAT_CAFE_AGENT_KEY_FILE: '/Users/yuhan/.cat-cafe/agent-keys/antigravity.secret'
```

`dsh` 已有按 invocation 刷新的 `CAT_CAFE_CREDENTIAL_FILE`，不应继承另一身份的 ambient key。
当前 MCP server 调用优先读取 credential file，所以该错误不能解释“首 header 为 0 MCP”；
但它违反身份隔离，修 Clowder 集成时必须一并删除。文档和测试不得读取或打印 key 内容。

## 5. 延迟的其他贡献项

以下因素会放大等待，但不能替代 startup race 的根因：

- `examples/acp-agent/cordis.yml:7-16` 默认 `reasoningEffort: max`。
- 原任务是跨文档、代码与平台回执的宽范围 review。
- MCP ready 后一次注入 120 个 schemas，增加模型输入与选择成本。
- 模型首轮没拿到结构化协作工具后，继续用 shell 反查 CLI。
- 用户取消后 DSH ACP 进程不再存活，下一次调用重新进入 cold-start 风险。

应把“正确性修复”和“性能优化”分开验收：先保证首请求工具集正确，再评估 reasoning effort、
任务切片和 tool-level allowlist。

## 6. 修复契约

必须建立以下可验证契约：

> 对一个声明启用 Cat Cafe MCP 的 DSH ACP process，在首个模型请求发出前，所有 required
> MCP servers 必须完成 initial tool generation；任一 required server 启动失败时，dispatch
> 必须在模型调用前失败并给出可行动诊断，不能带残缺工具集继续。

禁止以固定 `sleep(500/1000ms)` 实现。时间延迟无法证明 readiness，在慢机、冷缓存或 MCP
server tool 数变化后仍会复发。

## 7. 推荐修复拆分

### 7.1 PR A — `deepseek-ai/deepseek-harness`（根因修复）

推荐方向：让 MCP clients 进入 `dsh-acp-demo` 的受控启动生命周期，在挂载 ACP transport 前
逐个 `await` 初次 readiness。若不接受 app-level MCP config，则提供等价的 application-ready
barrier，并让 ACP `initialize` 或最迟 `session/new` 等到整个 required plugin tree 激活。

必须保持：

- `failOnStartupError: true` 的 fail-closed 语义。
- MCP tool registry 在第一条 request header 中稳定可见。
- transport disposal 顺序不破坏 session flush/persistence。
- 普通不配置 MCP 的 ACP demo 不支付额外行为变化。

### 7.2 PR B — `08mamba24/clowder-ai` origin（集成与身份修复）

1. 使用 PR A 提供的有序 MCP 配置/readiness contract，不再依赖无序 root sibling 的偶然时序。
2. 删除 `dsh-acp-bootstrap.ts:211-212` 对 ambient
   `CAT_CAFE_AGENT_KEY_FILE` 的继承；DSH invocation 只使用自己冻结路径上的
   `CAT_CAFE_CREDENTIAL_FILE`。若未来确需 persistent key，必须按 `catId` 精确解析，不能用单值环境变量。
3. 在 pool client 标记 ready 前消费 DSH readiness；失败时销毁该 process，不把残缺 client 放入池。
4. 保留 per-process credential path 在 invocation 前原子刷新、resume 重写同一路径的现有契约。
5. 修复发布后重启 DSH ACP pool；已启动进程不会自动获得新的 startup contract。

顺序：先合 PR A，再让 PR B pin/适配。可以先提交 Clowder 的身份清理和 fail-fast 防线，
但不能把 Clowder 固定延时称为终态修复。

## 8. 防回归测试

### 8.1 DeepSeek Harness 红测

新增一个真实 Loader/stdio integration fixture：

1. fixture MCP server 的 `listTools` 人为延迟，返回一个稳定工具（例如 `ready_probe`）。
2. 启动带 MCP 配置的 `dsh-acp-demo`。
3. Client 在进程可连接后立即 `initialize → session/new → prompt`，不主动 sleep。
4. 捕获第一条 `request/header`。
5. 修复前断言失败：首 header 不含 `mcp__fixture__ready_probe`。
6. 修复后断言通过：首 header 必含该工具；模型 adapter 的首次 generate 也收到它。

再覆盖：

- MCP 初次连接失败：ACP initialize/session 在模型调用前失败。
- 两个 MCP servers 以不同完成顺序启动：首 header 同时包含两者。
- 无 MCP 配置：原有 ACP 测试不变。
- dispose during readiness：不泄漏 MCP child process 或挂起 stdin。

### 8.2 Clowder AI 回归

- overlay/bootstrap 测试断言不会输出 ambient `CAT_CAFE_AGENT_KEY_FILE`。
- DSH callback 测试证明 `CAT_CAFE_CREDENTIAL_FILE` 在首次 MCP call 时已经可读。
- cold process integration 测试断言首次业务 prompt 的 tool inventory 含期望 namespace。
- readiness 失败不会把 client 放入 pool，也不会发起模型请求。
- warm/resume session 刷新 credential 后仍可调用结构化 A2A 工具。

现有测试只覆盖 overlay 字符串生成和 credential file 单元行为，尚不能证明“第一次 DSH
模型请求实际看见 family MCP schemas”。新增测试必须闭合这一缺口。

## 9. 验收门

只有同时满足以下条件才能宣布修复完成：

- [ ] cold start 的**第一条** `request/header` 已含所有 required MCP namespaces，不接受“第二轮才出现”。
- [ ] `dsh` 首轮可以直接调用一个 Cat Cafe MCP 工具，例如只读 thread context 或结构化 A2A completion。
- [ ] MCP startup failure 在模型调用前 fail closed，诊断包含 server name 和原始 cause，但不含凭据。
- [ ] DSH overlay 不再包含另一 cat 的 agent-key path。
- [ ] DeepSeek Harness 与 Clowder AI 两侧新增测试均红→绿，并记录 exact commit SHA。
- [ ] 修复进程重启后做一次真实 cold-start acceptance；不能用修复前的 warm process 充当证据。
- [ ] 单独记录性能数据；`reasoningEffort: max` 或 120-tool schema 导致的剩余延迟不得误报为 MCP readiness 回归。

## 10. 已知限制与开放问题

1. 修复选型：`acp-demo` 内嵌 MCP clients，还是 generic application-ready barrier？推荐前者，
   因为依赖关系显式且只影响需要 MCP 的部署；最终由 DeepSeek Harness maintainer 决定。
2. 是否把 Cat Cafe family whitelist 进一步缩成 tool-level allowlist？这是性能/认知负载优化，
   不应阻塞正确性修复，但建议紧随其后测量。
3. 是否下调默认 `reasoningEffort`？需要单独的质量—延迟实验，不与 MCP bug 混在同一 verdict。
4. ACP 协议是否应公开 tool readiness/capability inventory？若提供，可让 Clowder 做更强的 provider
   preflight；当前不能靠猜测或固定 sleep。

## 11. 五件套交接

- **What**：修复 DSH ACP cold start 的首请求 MCP tool-registration race，并清除 Clowder overlay
  的跨身份 agent-key 继承。
- **Why**：真实会话证明首 header 为 `19 tools / 0 MCP`，下一 header 才是
  `139 tools / 120 MCP`；模型因此绕去 shell/CLI，结构化回传受阻并放大用户等待。
- **Tradeoff**：在 prompt 前等待真实 readiness 会增加一小段可解释的 cold-start 时间，换取工具集正确；
  fail-closed 会把过去的静默降级变成显式启动失败，这是期望行为。
- **Open Questions**：采用 app-owned MCP 生命周期还是通用 boot barrier；tool-level allowlist 与
  reasoning effort 另案评估。
- **Next Action**：先在 DeepSeek Harness 写“延迟 listTools + 首 prompt”红测并完成 PR A；随后在
  Clowder AI 完成 PR B、重启 pool，按 §9 做真实 cold-start acceptance。

## 12. 证据卫生

- 不读取、不复制、不提交任何 agent key 或 callback token 内容。
- audit 中的 `user_cancel` 是用户取消事实，不等同于 provider 自发失败。
- proposal/任务面板状态不是本 bug 的完成证据；以 request header、测试和真实 cold-start
  acceptance 为准。
- 本文落盘时未修改两个实现仓库的代码，也未创建修复 PR。

[砚砚/gpt-5.6-sol🐾]
