---
feature_ids: [F151]
topics: [connector, architecture, xiaoyi, websocket]
doc_kind: decision
created: 2026-04-02
---

# ADR-014: XiaoYi Connector Gateway — 小艺渠道接入架构

> **状态**: 已决定
> **日期**: 2026-04-02
> **决策者**: 铲屎官 + Ragdoll + 缅因猫（review）
> **上下文**: F151 Design Gate review + feat-lifecycle 指导

## 背景

Cat Cafe 已通过 F088/F132/F137 接入飞书、Telegram、DingTalk、企业微信五个渠道。华为小艺是 HarmonyOS 设备的原生 AI 助手，覆盖手机/平板/手表/车机。

小艺开放平台提供两种第三方智能体接入模式：
- **多Agents模式**（原 A2A 模式）：必须绑定华为 LLM（DeepSeek/盘古）作为编排中间层
- **OpenClaw模式**：通过 WebSocket 直连华为 HAG 服务器，无 LLM 中间层

选择 OpenClaw 模式的理由：
1. 直连，无 LLM 中间层 → 低延迟、完全可控
2. 协议已知（`@ynhcj/xiaoyi` npm 包已公开源码）
3. Cat Cafe 自身充当 WebSocket 客户端连接 HAG，用户无需额外部署

**trade-off**：OpenClaw 模式不支持快捷指令、端侧插件、账号绑定、卡片等平台侧高级功能。MVP 阶段这些不是刚需；后续可通过同时支持多Agents模式补齐。

## 架构设计

```
用户 → 小艺 APP → 华为 HAG Server ←──WebSocket──→ XiaoYiAdapter (Cat Cafe)
                  (主域 + 备 IP)
                                      │
                                      ├→ Connector Gateway
                                      │   ├→ Principal Link
                                      │   ├→ Session Binding
                                      │   └→ Command Layer
                                      └→ Agent Router → Cat Agents
```

连接方向：**Cat Cafe 主动连接华为 HAG**（类似 DingTalk Stream 模式）。

### 协议栈

| 层 | 技术 |
|----|------|
| 传输 | WebSocket (wss)：主 + 备 active-active |
| 认证 | HMAC-SHA256: `signature = Base64(HMAC-SHA256(SK, timestamp_string))` — 输入只有 timestamp |
| 消息 | A2A JSON-RPC 2.0，出站需两层信封（WebSocket frame + stringified msgDetail） |
| 投递 | 非流式 — `reasoningText` 思考气泡 → 每猫完成后 `artifact-update(text)` append 累积 |
| 保活 | 双机制：应用层 `{ msgType: "heartbeat", agentId }` 每 20s + WS ping 每 30s |

### 核心 ID

| ID | 来源 | 生命周期 | 用途 |
|----|------|---------|------|
| `params.sessionId` | 华为 HAG | 跨 app 重启稳定 | 对话标识 → 映射到 Cat Cafe thread |
| `msg.sessionId`（顶层） | 华为 HAG | 每次开 app 刷新 | **不用！** 不稳定 |
| `params.id`（taskId） | 华为 HAG | 每条消息一个 | 回复路由 |
| `agentId` | 用户配置 | 永久 | 标识智能体 + 用于认证 + externalChatId 命名空间 |

### Identity Mapping

```
Principal Link:
- connectorId: 'xiaoyi'
- externalChatId: `${agentId}:${params.sessionId}`  ← 注意用 params.sessionId，不是顶层
- externalSenderId: `owner:${agentId}`  ← 所有对话归属 connector 配置者（OpenClaw 无用户级 ID）

Session Binding:
- bindingKey: (`xiaoyi`, `${agentId}:${params.sessionId}`) → threadId
- `/new` `/threads` `/use` 正常工作，都在 owner 名下
```

**关键点**：OpenClaw 协议中**没有用户级标识**（如飞书的 userId、微信的 openId）。所有消息归属给配置 connector 的那个人，P0 场景就是开发者自用。

### 双服务器 HA

```
XiaoYiAdapter
├── WsChannel (主)   → HAG 主域名
└── WsChannel (备)   → HAG 备 IP
```

**策略**：
- **active-active 双连接**：同时连两个服务器
- **入站去重**：`Map<sessionId+taskId, seen>` — 防止同一消息双发
- **出站 session affinity**：记录入站来源服务器，回包走同一通道
- **备 IP TLS**：IP 直连无域名 SNI，使用 `rejectUnauthorized: false`（与 `@ynhcj/xiaoyi` 参考实现一致）

### 投递模型（非流式 append 累积，2026-04-06 真机验证）

```
收到消息
  ↓
status-update { state: "working", final: false }          → HAG 标记 task 进入 working
artifact-update { reasoningText: '', lastChunk: true }    → 思考气泡（三点动画）
  ↓  keepalive: status-update(working) 每 20s
猫 A 完成
  ↓
artifact-update { text: "猫A回复", append: false }        → 首只猫，替换
  ↓
猫 B 完成
  ↓
artifact-update { text: "\n\n---\n\n猫B回复", append: true }  → 追加（分隔线）
  ↓
status-update { state: "completed", final: true }         → close frame
```

**为什么不流式推送**（真机验证 2026-04-06）：
- 同一 `artifactId` 内 `append:true` 发 delta → HAG app 前一个 chunk 被覆盖（非追加）
- `append:false` 发全量文本单猫可行，但多猫场景覆盖其他猫的累积内容
- `status-update` 的 `message` 字段渲染为**永久气泡**，completed+final:true 也不清除
- 因此放弃 intra-artifact 流式，`sendPlaceholder`/`editMessage`/`deleteMessage` 均为 no-op

**多猫投递**：`hasArtifact` Set 追踪首只猫是否已发送。首只 `append=false`，后续 `append=true` + `---` 分隔线。

**即时反馈**：`reasoningText` part（`{ kind: 'reasoningText', reasoningText: '' }`）— 空字符串让 HAG 显示三点动画，回复出现后自动折叠。

**task 生命周期管理**：

```
taskQueue: Map<sessionId, TaskRecord[]>     — per-session FIFO 队列
hasArtifact: Set<taskId>                    — 追踪是否已发过 text artifact
seqCounters: Map<taskId, number>            — per-task artifactId 递增序号
```

- 入站 `message/stream` → push 到 FIFO 队列 + 启动 120s timeout
- `sendPlaceholder` → status-update(working) + reasoningText 气泡，返回 ''
- `sendReply` → 首只 append=false / 后续 append=true
- `onDeliveryBatchDone(chainDone=true)` → close frame + dequeue
- `tasks/cancel` / `clearContext` → purge 整个 session

双层 timer 防御：keepalive 20s / hard timeout 120s

## 决策

| # | Decision | Rationale | Date |
|---|----------|-----------|------|
| 1 | 对接小艺 OpenClaw 模式 | 无 LLM 中间层，直连低延迟 | 2026-04-02 |
| 2 | 用 `owner:{agentId}` 做 senderId | OpenClaw 无用户级标识，所有对话归属 connector 配置者 | 2026-04-02 |
| 3 | 用 `params.sessionId` 而非顶层 `msg.sessionId` | office-claw P1-1 实测验证：顶层 sessionId 每次打开 app 刷新 | 2026-04-02 |
| 4 | 双服务器 active-active + 去重 | 入站去重防双发，session affinity 保证响应连续性 | 2026-04-02 |
| 5 | 即时反馈用 `reasoningText` 空字符串 | ~~占位文字用 artifact-update~~ → HAG 把 `status-update` message 渲染为永久气泡。`reasoningText` 空串触发三点动画，回复后自动折叠（真机验证 2026-04-06） | 2026-04-06 |
| 6 | 不做多小艺 agent 接入 | 单账号单 agent，scope 聚焦 | 2026-04-02 |
| 7 | status-update final 跟随 state | `final: state !== 'working'`。working→false，completed/failed→true（真机验证 2026-04-03） | 2026-04-03 |
| 8 | ~~多猫 replyParts 聚合~~ → append 累积 | 首只猫 `append=false`，后续猫 `append=true` + `---` 分隔。无 debounce，信号驱动关闭（真机验证 2026-04-06） | 2026-04-06 |
| 9 | ~~FIFO + claimTask~~ → FIFO + 信号驱动关闭 | 删除 `claimedTasks`/`activeTask`/`scheduleFinal`。`onDeliveryBatchDone(chainDone=true)` 信号触发 close frame | 2026-04-06 |

## 放弃的方案

| 方案 | 放弃理由 |
|------|----------|
| 依赖 `@ynhcj/xiaoyi` npm 包 | 需要适配我们的架构，不能直接复用 |
| 多Agents 模式 | 必须绑定华为 LLM，增加复杂度和延迟 |
| 直接使用 `msg.sessionId` | office-claw P1-1 实测验证：每次打开 app 刷新 |
| 备服务器 passive 切换 | session affinity 要求知道消息来源，active-active 更可靠 |

## 未实现 (Phase A)

| 功能 | 说明 | 接入点 |
|------|------|----------|
| XiaoYiAdapter 类 | `packages/api/src/infrastructure/connectors/adapters/XiaoyiAdapter.ts` | 新增 adapter |
| WebSocket 双通道 | 主+备，active-active，独立连接管理 |
| HMAC-SHA256 认证 | `x-access-key` / `x-sign` / `x-ts` / `x-agent-id` headers |
| A2A 协议处理 | message/stream 入站，agent_response 出站 | 协议层 |
| task 生命周期 | FIFO queue + onDeliveryBatchDone 信号驱动 | 出站路由 |
| 协议层抽离 | `xiaoyi-protocol.ts` — 常量、类型、auth、builders | 质量门控 |

## 给未来Ragdoll的备忘

1. **OpenClaw 协议限制**：不支持快捷指令、端侧插件、账号绑定、卡片等平台功能。P0 只做文本收发，这些都不在 scope 内。
2. **sessionId 陷阱**：协议有**两个**叫 sessionId 的字段。`params.sessionId`（params 内）稳定，`msg.sessionId`（顶层）每次打开 app 刷新。实现时必须只用 params 内的。但 `tasks/cancel` 和 `clearContext` 的 sessionId 在顶层。
3. **备 IP TLS**：备 IP `116.63.174.231` 没有域名做 SNI，用 `rejectUnauthorized: false`（与参考实现一致）。
4. **task 生命周期**：FIFO queue + `onDeliveryBatchDone` 信号驱动关闭。双层 timer：keepalive 20s / timeout 120s。
5. **即时反馈**：`reasoningText` 空字符串 → HAG 显示三点动画。字段形状 `{ kind: 'reasoningText', reasoningText: '' }`（不是 `text` 字段！从 `@ynhcj/xiaoyi-channel` 源码确认）。`status-update` 的 `message` 字段**永久残留**，不可用于暂态提示。
6. **签名算法**：`Base64(HMAC-SHA256(SK, timestamp_string))`。输入**只有 timestamp**，没有 `ak=` 前缀。以 `@ynhcj/xiaoyi` 源码为准。
7. **出站信封**：必须用两层包装 — `{ msgType: "agent_response", agentId, sessionId, taskId, msgDetail: JSON.stringify(jsonrpc) }`。裸 JSON-RPC 不行。
8. **不要做 intra-artifact 流式**：HAG app 对同一 artifactId 的 `append:true` delta 和多 text artifact 的 `append:false` 都有渲染问题（真机验证 2026-04-06）。改用 append 累积：首只猫 `append=false`，后续猫 `append=true`（跨 artifactId 追加有效）。
