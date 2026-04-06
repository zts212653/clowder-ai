---
feature_ids: [F151]
related_features: [F088, F132, F137, F143, F146]
topics: [connector, channel, xiaoyi, huawei, a2a, websocket]
doc_kind: spec
status: spec
created: 2026-04-01
---

# F151: XiaoYi Channel Gateway — 小艺渠道接入

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1
>
> 在小艺开放平台创建 OpenClaw 模式智能体，由 Cat Cafe 通过 WebSocket 对接华为 HAG，
> 用户在华为手机上通过小艺 APP 即可与猫猫对话。
>
> Cat Cafe 不是 OpenClaw 实例 — 它是对接小艺 OpenClaw 模式协议的 connector adapter。

## Why

Cat Cafe 已通过 F088/F132/F137 接入飞书、Telegram、DingTalk、WeCom、WeChat 五个渠道。
华为小艺是 HarmonyOS 设备的原生 AI 助手，覆盖手机/平板/手表/车机。
接入小艺渠道意味着 Cat Cafe 的猫猫可以在**所有华为设备上**被用户直接使用。

小艺开放平台提供两种第三方智能体接入模式：
- **多Agents模式**（原 A2A 模式）：必须绑定华为 LLM（DeepSeek/盘古）作为编排中间层
- **OpenClaw模式**：通过 WebSocket 直连华为 HAG 服务器，无 LLM 中间层

选择对接 OpenClaw 模式的理由：
1. 直连华为 HAG，无 LLM 中间层 → 低延迟、完全可控
2. 协议已知 — 华为开发者文档 + `@ynhcj/xiaoyi` npm 参考实现
3. Cat Cafe 直接作为 WebSocket 客户端连接 HAG，用户无需额外部署

**trade-off**：OpenClaw 模式不支持快捷指令、端侧插件、账号绑定、卡片等平台侧高级功能。
MVP 聚焦文本对话链路，这些高级功能不在本 feature 范围内。

## What

### 架构

```
用户 → 小艺 APP → 华为 HAG Server ←──WebSocket──→ XiaoYiAdapter (Cat Cafe)
                  (wss://hag.cloud.huawei.com        │
                   /openclaw/v1/ws/link)              ├→ Connector Gateway
                                                      │   ├→ Principal Link
                                                      │   ├→ Session Binding
                                                      │   └→ Command Layer
                                                      └→ Agent Router → Cat Agents
```

连接方向：**Cat Cafe 主动连接华为 HAG**（类似 DingTalk Stream 模式）。

### 核心 ID

| ID | 来源 | 生命周期 | 用途 |
|----|------|---------|------|
| `params.sessionId` | 华为 HAG 下发 | 跨 app 重启稳定 | 对话标识 → 映射到 Cat Cafe thread |
| `msg.sessionId`（顶层） | 华为 HAG 下发 | **每次开 app 刷新** | **不用！** 不稳定，已知坑（office-claw P1-1） |
| `params.id`（taskId） | 华为 HAG 下发 | 每条消息一个 | 回复路由 — 出站消息必须带对应 taskId |
| `agentId` | 用户在小艺平台配置 | 永久 | 标识智能体 + 用于认证 + externalChatId 命名空间 |

### 协议栈

| 层 | 技术 |
|----|------|
| 传输 | WebSocket (wss)：主 `wss://hag.cloud.huawei.com/openclaw/v1/ws/link`，备 `wss://116.63.174.231/openclaw/v1/ws/link` |
| 认证 | HMAC-SHA256: `signature = Base64(HMAC-SHA256(SK, timestamp_string))` — 注意：输入只有 timestamp，无 ak 前缀 |
| 消息 | A2A JSON-RPC 2.0，出站需两层信封（见下文） |
| 投递 | 非流式 — 每只猫完成后 `artifact-update(text, lastChunk=true)` 一次性推送，首只 `append=false`，后续 `append=true` 累积。首次触发前发 `reasoningText` 思考气泡。close frame `status-update(completed, final=true)` 关闭 task |
| 保活 | 双机制：应用层 `{ msgType: "heartbeat", agentId }` 每 20s + WebSocket ping 每 30s（pong 超时 90s） |
| HA | 双服务器 active-active + 入站去重 (key: `sessionId+taskId`)，出站 session affinity（记录入站来源服务器，回包走同一通道） |
| 备链路 TLS | 备 IP `116.63.174.231` — IP 直连无域名 SNI，使用 `rejectUnauthorized: false`（与 `@ynhcj/xiaoyi` 参考实现一致） |

### 消息格式

入站（小艺→我们）— A2A JSON-RPC 请求：
```json
{
  "jsonrpc": "2.0",
  "method": "message/stream",
  "id": "msg-id",
  "params": {
    "id": "task-id",
    "sessionId": "user-session",
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "你好" }]
    }
  }
}
```

出站（我们→小艺）— **两层信封**：

Layer 1（WebSocket 帧）：
```json
{
  "msgType": "agent_response",
  "agentId": "your-agent-id",
  "sessionId": "user-session",
  "taskId": "task-id",
  "msgDetail": "<stringified-json-rpc>"
}
```

Layer 2（msgDetail 内，序列化为字符串）— artifact-update 示例：
```json
{
  "jsonrpc": "2.0",
  "id": "msg_1714600000000",
  "result": {
    "taskId": "task-id",
    "kind": "artifact-update",
    "append": false,
    "lastChunk": true,
    "final": false,
    "artifact": {
      "artifactId": "cat-ragdoll-1714600000000",
      "parts": [{ "kind": "text", "text": "你好！" }]
    }
  }
}
```

Layer 2 — status-update 示例：
```json
{
  "jsonrpc": "2.0",
  "id": "msg_1714600000001",
  "result": {
    "taskId": "task-id",
    "kind": "status-update",
    "final": false,
    "status": {
      "state": "working"
    }
  }
}
```

其它 msgType：`clawd_bot_init`（连接后立即发）、`heartbeat`（每 20s）

**核心协议语义**（来自华为官方文档）：
- `append`：`false` = 替换整个 artifact 内容（默认），`true` = 追加 delta
- `lastChunk`：标记一次流式输出结束（默认 `true`）。**一个 task 允许若干次流式输出**，每次以 `lastChunk: true` 结束
- `final`：断开 task 通道（默认 `false`）。**设为 `true` 后云侧不能再推送**，task 结束必须设为 `true`
- `artifactId`：每个 artifact 的唯一 ID。不同 `artifactId` = 不同 artifact

**关键设计依据**：协议明确支持一个 task 内多次流式输出（各自 `lastChunk=true`），最终由一个 `final=true` 关闭 task。

**非流式投递模型**（2026-04-06 真机验证确认）：

HAG app 对 artifact 的 `append` 和同一 artifactId 多次更新的处理存在多个问题（详见 D13-D15），
**放弃 per-artifact 流式推送**，改为每只猫完成后一次性投递完整文本。

**投递序列**：
1. `status-update(working)` — 设 task 状态（不带 message！D8）
2. `artifact-update(reasoningText, '', lastChunk: true)` — 思考气泡（空字符串→app 显示三点动画），立即反馈用户（D16）
3. 猫处理中 → `status-update(working)` 每 20s keepalive
4. 猫完成 → `artifact-update(text, 完整回复, append: false, lastChunk: true)` — 首只猫
5. 下一只猫完成 → `artifact-update(text, \n\n---\n\n+完整回复, append: true, lastChunk: true)` — 追加
6. `onDeliveryBatchDone(chainDone=true)` → `status-update(completed, final: true)` — **close frame**

**铁律：artifact-update 永不携带 `final: true`。`final` 仅通过 close frame 发出。**

**多猫投递**（append 累积模型）：
```
用户发消息 → HAG 下发 message/stream (taskId=T1)
Cat Cafe 路由给猫 A + 猫 B:

立即响应:
  → status-update(working)
  → artifact-update(reasoningText, '', lastChunk=true)  ← 思考气泡（三点动画）

猫 A 完成:
  → artifact-update(text, "猫A回复", append=false, lastChunk=true)
      ↑ 首只猫: append=false

猫 B 完成:
  → artifact-update(text, "\n\n---\n\n猫B回复", append=true, lastChunk=true)
      ↑ 后续猫: append=true 追加到猫 A 后面

onDeliveryBatchDone(chainDone=true):
  → status-update(completed, final=true) ← close frame
```

`hasArtifact` Set 追踪 task 是否已发过 text artifact，决定首只猫 `append=false` vs 后续猫 `append=true`。

**Close frame 契约**：
```json
{
  "taskId": "<当前 taskId>",
  "kind": "status-update",
  "final": true,
  "status": { "state": "completed" }
}
```
- 不带 `message` 字段（响应内容已在 artifact 中，不重复）
- `final: true` 断开 task 通道
- 失败场景用 `state: "failed"`

**Task 关闭机制 — 信号驱动**：
- **主机制** — `onDeliveryBatchDone(chainDone)` 信号：每次 invocation 完成 delivery 后发出。三条管线覆盖：`deliverOutboundFromWeb`（Web UI）、`ConnectorInvokeTrigger`（connector）、`QueueProcessor`（出队链）。检查 `invocationTracker.has(tid) || queueProcessor.isThreadBusy(tid)` 判断链条是否结束。`chainDone=true` → 发 close frame 关闭 task
- `STATUS_KEEPALIVE_MS = 20s` — 周期性 `status-update(working)` 防止 HAG 超时
- `TASK_TIMEOUT_MS = 120s` — 僵尸任务安全网（信号丢失时的最后兜底）

### Phase A: P0 MVP

**目标**：跑通小艺↔Cat Cafe 文本对话链路。

1. **XiaoYiAdapter** — 新增 connector adapter
   - 实现 `IStreamableOutboundAdapter`（`sendPlaceholder`/`editMessage`/`deleteMessage` 为 no-op，仅 `sendReply` 投递内容）
   - WebSocket 连接管理（connect / auth / heartbeat / reconnect）
   - 双服务器 active-active + session affinity
   - **非流式 append 累积模型**：首只猫 `append=false`，后续猫 `append=true` 追加。`reasoningText` 思考气泡立即反馈。per-session FIFO 队列 (`taskQueue`) 管理用户连续消息。`onDeliveryBatchDone(chainDone=true)` 信号触发 close frame 关闭 task
   - **协议层抽离**：`xiaoyi-protocol.ts` — 常量、类型、auth、message builders（质量门控文件大小合规）

2. **协议层**
   - `clawd_bot_init` 注册
   - `message/stream` 入站解析 → 标准 InboundMessage
   - `agent_response` 出站格式化：`status-update(working)` → `reasoningText` 思考气泡 → 猫完成后 `artifact-update(text)` 逐猫投递 → close frame `status-update(completed, final: true)` 关闭
   - `tasks/cancel`（取消当前 task）/ `clearContext`（清理 session 上下文，state=`cleared|failed|unknown`）处理

3. **Gateway 集成**
   - Principal Link: `connectorId=xiaoyi`, `externalChatId=${agentId}:${params.sessionId}`, `externalSenderId=owner:{agentId}`
   - Session Binding: `params.sessionId` → threadId（注意：必须用 `params.sessionId`，不是顶层 `msg.sessionId`，后者每次打开 app 会刷新）
   - 用户身份：所有小艺对话归属 connector 配置者（OpenClaw 无用户级标识）
   - Command Layer: `/new` `/threads` `/use` `/where` `/thread`
   - Bootstrap 注册

4. **热加载**
   - .env 中添加 `XIAOYI_AK` / `XIAOYI_SK` / `XIAOYI_AGENT_ID` 后自动检测并连接
   - 集成点：`connector-secrets-allowlist` 注册 env key → `connector-reload-subscriber` 监听变更 → `connector-gateway-bootstrap` 初始化/销毁 adapter → `connector-hub` 注册平台配置项 + 状态页

### Phase B: P1 增强（后续）

| 能力 | 说明 |
|------|------|
| 图片/文件收发 | `kind: "file"` parts 解析 + 发送 |
| ~~推理过程展示~~ | ~~`kind: "reasoningText"` 透传~~ — 已在 Phase A 用于"思考中…"即时反馈（D16） |
| Push 通知 | 异步长耗时任务完成回调 |

## Acceptance Criteria

### Phase A (P0 MVP)

- [ ] AC-A1: XiaoYiAdapter 通过 WebSocket 连接华为 HAG 并完成 HMAC-SHA256 认证
- [ ] AC-A2: 双服务器 HA — active-active 双连接 + 入站去重 (`sessionId+taskId`)，出站 session affinity
- [ ] AC-A3: 双机制心跳保活（应用层 20s + WS ping 30s）+ 断线指数退避重连（max 10 次）
- [ ] AC-A4: 用户在小艺 APP 发送文本，猫猫收到并回复，小艺端展示回复
- [ ] AC-A5: 非流式投递 — `reasoningText` 思考气泡即时反馈 + 每只猫完成后 `artifact-update(text)` 一次性投递（首只 `append=false`，后续 `append=true` 分隔线累积）
- [ ] AC-A6: Principal Link 正确建立 — `externalChatId=${agentId}:${params.sessionId}`, `externalSenderId=owner:{agentId}`
- [ ] AC-A7: Session Binding — `params.sessionId` 映射 thread；`/new` `/threads` `/use` `/thread` 正常工作
- [ ] AC-A8: 热加载 — `XIAOYI_AK/SK/AGENT_ID` 写入 .env 后自动连接；含 allowlist + hub + bootstrap + 状态页全链路
- [ ] AC-A9: 多猫投递完整性 — 首只猫 `append=false`，后续猫 `append=true` 追加（`---` 分隔线），close frame 仅在 `onDeliveryBatchDone(chainDone=true)` 时发出，task 不提前关闭

## Dependencies

- **Evolved from**: F088 (Multi-Platform Chat Gateway)，复用三层 connector 架构
- **Related**: F132 (DingTalk/WeCom)，DingTalk Stream 模式是最接近的参考实现
- **Related**: F143 (Hostable Agent Runtime)，统一 adapter 接口
- **External**: 华为小艺开放平台 OpenClaw 模式、HAG WebSocket 端点
- **ADR**: [ADR-014](/decisions/014-xiaoyi-connector-gateway.md) — 完整架构设计、核心 ID、双服务器 HA、流式输出

## Risk

| Risk | Mitigation |
|------|------------|
| 华为 HAG WebSocket 协议变更 | `@ynhcj/xiaoyi` 79 版本活跃迭代，可跟踪其更新 |
| OpenClaw 模式平台功能受限 | MVP 聚焦文本对话，高级功能不在本 feature 范围 |
| 无用户级标识（OpenClaw 固有限制） | 用 `owner:{agentId}` 做 senderId，所有对话归属 connector 配置者 |
| A2A 两个 sessionId 易混淆 | 强制用 `params.sessionId`（稳定），忽略顶层 `msg.sessionId`（不稳定） |
| 双服务器 active-active 复杂性 | 入站去重 `sessionId+taskId`；出站 session affinity 记录来源服务器；备 IP TLS 需显式信任华为 CA |

## Key Decisions

| # | Decision | Rationale | Date |
|---|----------|-----------|------|
| 1 | 选择 OpenClaw 模式而非多Agents模式 | 无 LLM 中间层，直连低延迟 | 2026-04-01 |
| 2 | Cat Cafe 内置适配而非部署 OpenClaw 实例 | 减少用户运维负担，一跳直连 | 2026-04-01 |
| 3 | `externalSenderId` 绑定 `owner:{agentId}` | OpenClaw 无用户级标识，所有对话归属 connector 配置者 | 2026-04-01 |
| 4 | 使用 `params.sessionId` 而非顶层 `msg.sessionId` | 顶层 sessionId 每次打开 app 刷新；params 内的跨会话稳定（office-claw P1-1 实测验证） | 2026-04-01 |
| 5 | 不做多小艺 agent 接入 | 单账号单 agent，scope 聚焦 | 2026-04-01 |
| 6 | adapter 内置 task 生命周期管理 | 流式出站必须带 taskId 回包；现有 `IStreamableOutboundAdapter` 接口不携带此上下文，由 adapter 内部 FIFO 队列 + invocation 级绑定管理（缅因猫 review R4/R5） | 2026-04-01 |
| 7 | `externalChatId` 带 `agentId:` 前缀 | 隔离命名空间，确保 binding key 全局唯一（缅因猫 review） | 2026-04-01 |
| 8 | status-update 不带 message 文字 | HAG 把 status-update 的 message 渲染为持久条目（真机验证 2026-04-03），因此占位文字用 artifact-update。status-update 仅用于状态信号：`working`（保活）、`completed/failed`（close frame，见 D12）。所有 status-update 均不带 message 字段 | 2026-04-03 |
| 9 | ~~多猫 replyParts 聚合~~ → per-delivery artifact | **D9-v1 已废弃**。原以为"一个 task 只能有一个 artifact"，但华为官方文档明确："一次会话请求(final为True结束)，允许若干流式输出"。每次 `sendReply` / streaming 会话用独立 `artifactId`（adapter 不感知 catId），无需合并。删除 `replyParts` / `claimedTasks` / `activeTask` | 2026-04-05 |
| 10 | ~~invocation 级 task 绑定 (claimTask)~~ → 删除 | D9 改为 per-delivery artifact 后，不再需要 invocation 级绑定。每次 `sendReply` 调用生成新 artifactId | 2026-04-05 |
| 11 | 信号驱动 task 关闭 (onDeliveryBatchDone) | `chainDone=true` → 发 close frame `status-update(completed, final=true)` 关闭 task。三条 delivery 管线覆盖（messages.ts / ConnectorInvokeTrigger / QueueProcessor）。`TASK_TIMEOUT_MS=120s` 作为僵尸任务兜底。删除 `DEFERRED_FINAL_MS` 定时器 | 2026-04-05 |
| 12 | close frame = `status-update(completed, final=true)` 不带 message | 华为文档 "不用 completed 返回" 指不要把响应内容放在 status-update 的 message 字段里返回（内容应在 artifact 中）。`status-update(completed, final=true)` 作为纯状态信号关闭 task 通道是合规的。artifact-update 永不携带 `final=true` — 避免 adapter 需要区分 "哪个 artifact 是最后一个" | 2026-04-05 |
| 13 | ~~per-delivery artifact（多 artifactId 独立输出）~~ → append 累积 | **D9-v2 已废弃**。真机验证发现：HAG app 对 `text` 类型 artifact，无论 `artifactId` 是否不同，`append=false` 时只渲染最后一个 — 后面猫的回复覆盖前面的。协议结构上多 artifact 合法，但 app 渲染行为是"最后一个 wins"。改为 append 累积模型：首只猫 `append=false`，后续猫 `append=true`（2026-04-06 真机验证 append=true 跨 artifactId 累积有效） | 2026-04-06 |
| 14 | ~~per-artifact 流式推送（editMessage delta）~~ → 非流式 | 真机验证发现两个问题：① 同一 `artifactId` 内 `append=true` 发 delta，HAG app 显示前一个 chunk 被覆盖而非追加；② 改为 `append=false` 每次发全量文本，单猫可行但多猫场景下与 D13 的 `append=true` 累积冲突（首只猫流式用 `append=false` 会覆盖后续猫的累积内容）。放弃 intra-artifact 流式，`sendPlaceholder`/`editMessage`/`deleteMessage` 均为 no-op | 2026-04-06 |
| 15 | `status-update` 的 `message` 字段不可用于暂态提示 | 补充 D8：真机验证发现 `message` 渲染为永久气泡，即使后续发 `completed + final=true` 也不会清除。空字符串 `message: { parts: [{ kind: 'text', text: '' }] }` 同样无法清除。`status-update` 的 `message` 只适合需要永久展示的信息 | 2026-04-06 |
| 16 | `reasoningText` 作为即时反馈 | 收到用户消息后立即发 `artifact-update(reasoningText='', lastChunk=true)`。空字符串→HAG app 显示三点动画。注意协议字段形状：`{ kind: 'reasoningText', reasoningText: text }`（不是 `text` 字段），已从 `@ynhcj/xiaoyi-channel` 源码确认。`reasoningText` 在 HAG app 中渲染为独立思考气泡，回复出现后自动折叠 | 2026-04-06 |

## Review Gate

- Phase A: 缅因猫 review + 铲屎官真机验证
