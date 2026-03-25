---
feature_ids: [F134]
related_features: [F088, F132, F077]
topics: [gateway, connector, feishu, group-chat, multi-user, chat-platform]
doc_kind: spec
created: 2026-03-24
---

# F134: Feishu Group Chat — 飞书群聊多用户支持

> **Status**: done (Phase A-D) | **Owner**: Ragdoll | **Priority**: P1 | **PR**: #697, #699, #700, #705
>
> **Related**: F088（复用公共层 + Phase 7 公共层扩展）| F132（钉钉/企微，同模式独立 Feature）

## Why

Cat Café 目前的飞书接入只支持 **1v1 私聊（DM）**，team lead希望把机器人拉进飞书群聊，让群里的人都能 @机器人提问，且猫回复时能 @发送者，区分不同用户。

team experience：
> *"如果我们的飞书的机器人加入多个群，比如不同的人 at 你，我们需要区分不同的用户，以及加入不同的群，我们可以优化一下 🤔 这样的话得区分到底哪个群聊给哪个 thread 发了信息？"*

> *"改动 1：FeishuAdapter — 解除群聊限制 + 提取用户信息。改动 2：ConnectorRouter — 携带发送者身份。改动 3：回复路由 — 群聊回复应 @发送者。改动 4：权限控制——好像可以先做1-3 然后再做4？"*

### 设计原则

F088 是**公共层架构**（ConnectorRouter / BindingStore / CommandLayer / OutboundDeliveryHook），F134 只做**飞书平台特定**的群聊改动。涉及公共层的改动（如 `ConnectorRouter.route()` 增加 senderId 参数、`ConnectorSource` 扩展 sender 字段）属于 **F088 Phase 7**，在 F134 实现过程中顺带推进，但记录在 F088。

**飞书既有设计参考**：
- `FeishuAdapter.ts` — `packages/api/src/infrastructure/connectors/adapters/FeishuAdapter.ts`
- F088 公共层架构 — `docs/features/assets/F088/architecture-unification.md`
- F088 Phase 进度 — `docs/features/F088-multi-platform-chat-gateway.md`
- F132 钉钉/企微（同模式拆分样板） — `docs/features/F132-dingtalk-wecom-gateway.md`

## What

### 当前限制

```typescript
// FeishuAdapter.ts:134 — 硬编码 p2p 过滤
if (message.chat_type !== 'p2p') return null;
```

```typescript
// ConnectorRouter.route() — 所有消息归属 defaultUserId，无 sender 身份
userId: this.opts.defaultUserId,  // line 187, 248, 268 等多处
```

```typescript
// ConnectorSource — 无 sender 字段
{ connector: 'feishu', label: '飞书', icon: '...' }  // 无法区分群里谁说的
```

### Phase A: 群聊入站 + @Bot 检测（飞书特定）

**FeishuAdapter 改动**：

1. **移除 p2p 过滤**：`parseEvent()` 不再 `return null` 群聊消息
2. **@机器人检测**：群聊消息只有 @了机器人才处理（避免机器人响应所有群消息）
   - 飞书群消息的 `content.text` 里 @机器人表现为 `@_user_1` 占位符
   - 事件 body 中 `event.message.mentions` 数组包含 `{ key: '@_user_1', id: { open_id: 'xxx' }, name: '机器人名' }` 映射
   - 需要匹配 bot 自身的 `open_id`（双策略获取：API + env，见 KD-5）
   - 匹配到后，从 text 中剥离 `@_user_1` 占位符，得到纯文本
   - **@所有人不触发**：`@_all` 的 key 为 `@_all` 而非 `@_user_N`，不匹配 bot open_id（KD-7）
3. **提取发送者信息**：从 `event.sender.sender_id` 解析 `senderId`（open_id）；通过 `GET /contact/v3/users/:open_id` 异步获取 `senderName`（内存缓存）
4. **返回 chat_type**：让 ConnectorRouter 知道这是群聊还是 DM

**接口变更**：

```typescript
export interface FeishuInboundMessage {
  chatId: string;
  text: string;
  messageId: string;
  senderId: string;
  senderName?: string;       // 新增：发送者显示名
  chatType?: 'p2p' | 'group'; // 新增：会话类型
  attachments?: FeishuAttachment[];
}
```

### Phase B: 公共层 Sender 身份透传（F088 Phase 7 联动）

> 此 Phase 的改动属于 F088 公共层，但在 F134 开发中一起推进。

1. **ConnectorRouter.route() 签名扩展**：
   ```typescript
   async route(
     connectorId, externalChatId, text, externalMessageId, attachments?,
     sender?: { id: string; name?: string },  // 新增
   )
   ```

2. **ConnectorSource 扩展**：
   ```typescript
   export interface ConnectorSource {
     // ... existing fields
     readonly sender?: {
       readonly id: string;
       readonly name?: string;
     };
   }
   ```

3. **messageStore 写入时携带 sender**：在 Cat Café Web UI 中展示"来自群聊的 某某人"

4. **thread 创建标题**：群聊自动创建 thread 时，标题应为 `飞书群聊 {群名/群ID}` 而非 `飞书 DM`

### Phase C: 群聊回复 @发送者（飞书特定）

猫回复时，在群聊场景下应 @发送者，让对方知道这是回复给自己的。

1. **OutboundDeliveryHook 扩展**：传递消息的原始 sender 信息到 adapter
2. **FeishuAdapter.sendReply / sendRichMessage 增强**：
   - 群聊回复时，文本前缀加 `<at user_id="xxx">名字</at>`（飞书 @-mention 语法）
   - DM 回复不变（不需要 @）
3. **ConnectorMessageFormatter 感知 sender**：格式化 envelope 时可包含 replyTo 信息

### Phase D: 权限控制

> team lead场景：演示时别人拉人进群，担心 token 被刷爆、thread 被乱切。需要控制谁能做什么。

**三层权限模型**（team lead 2026-03-25 确认）：

1. **群白名单（第一层）**：哪些群允许 bot 响应
   - 未授权群的 @bot 消息静默忽略或回复权限提示
   - 管理命令 `/allow-group`、`/deny-group`（仅team lead可用）
   - 存储：Redis 或 env 配置

2. **@bot 对话全开放（第二层 — 不做限制）**：群里所有人都能 @bot 对话
   - team lead确认不需要用户级白名单

3. **/command 只限管理员（第三层）**：`/threads`、`/new`、`/use` 等管理命令只有team lead能用
   - 防止群里其他人随意 `/new` 创建 thread 或 `/use` 切换 thread
   - 管理员身份：匹配team lead的飞书 open_id（env 配置 `FEISHU_ADMIN_OPEN_IDS`）
   - 非管理员发 /command → 回复"只有管理员可以使用此命令"

## Acceptance Criteria

### Phase A（群聊入站 + @Bot 检测） ✅
- [x] AC-A1: 飞书群聊消息在 @机器人时正确解析入站（text + image + post）
- [x] AC-A2: 群聊消息未 @机器人时静默忽略（不处理、不报错）
- [x] AC-A3: @机器人占位符（`@_user_1`）从 text 中正确剥离
- [x] AC-A4: senderId 和 senderName 正确提取并传递
- [x] AC-A5: DM 消息行为不变（无回归）
- [x] AC-A6: `@所有人`（@_all）不触发 bot 响应，仅明确 @bot 才处理

### Phase B（公共层 Sender 身份透传） ✅
- [x] AC-B1: ConnectorRouter.route() 接受可选 sender 参数
- [x] AC-B2: ConnectorSource 携带 sender 信息存入 messageStore
- [x] AC-B3: Cat Café Web UI 展示 sender 信息（"来自飞书群聊的 You"）
- [x] AC-B4: 群聊自动创建 thread 标题为 `飞书群聊` 而非 `飞书 DM`
- [x] AC-B5: 现有 DM / Telegram / 钉钉消息路由不受影响（sender 可选，不传 = 不展示）

### Phase C（群聊回复 @发送者） ✅
- [x] AC-C1: 猫回复群聊消息时，飞书侧正确 @原始发送者
- [x] AC-C2: 猫回复 DM 消息时，不添加 @（保持原行为）
- [x] AC-C3: 多人在群里 @机器人，各自的回复正确 @各自的发送者

### Phase D（权限控制） ✅
- [x] AC-D1: 群白名单 — 未授权群的 @bot 消息静默忽略或回复权限提示
- [x] AC-D2: `/allow-group` `/deny-group` 管理命令可用（仅管理员）
- [x] AC-D3: `/threads` `/new` `/use` 等管理命令仅管理员可用，非管理员回复提示
- [x] AC-D4: 管理员身份通过 `FEISHU_ADMIN_OPEN_IDS` env 配置（首次启动 seed，持久化到 Redis）
- [x] AC-D5: @bot 对话不受限（群里所有人都能 @bot 提问）

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "飞书机器人加入多个群" | AC-A1, AC-A5 | test + manual | [x] |
| R2 | "不同的人 at 你，我们需要区分不同的用户" | AC-A4, AC-B2, AC-B3 | test + screenshot | [x] |
| R3 | "区分到底哪个群聊给哪个 thread 发了信息" | AC-B4 | test + manual | [x] |
| R4 | 群聊回复应 @发送者（team lead确认的改动 3） | AC-C1, AC-C3 | test + manual | [x] |
| R5 | 先做 1-3 再做 4（权限后做） | Phase D 暂不开工 | — | [x] |
| R6 | "@所有人的时候bot不要响应，明确@bot才响应" | AC-A6 | test | [x] |
| R7 | "群聊名字+群聊ID+发送消息的人"在 UI 展示 | AC-B3, AC-B4 | screenshot | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（若适用）— Phase B 有前端展示需求

## Dependencies

- **Evolved from**: F088（Multi-Platform Chat Gateway — 复用三层公共架构，Phase 7 联动）
- **Related**: F132（DingTalk + WeCom — 同模式拆分的兄弟 Feature，未来也需群聊）
- **Related**: F077（Multi-User Secure Collaboration — 权限隔离 Phase D 前置）

## Risk

| 风险 | 缓解 |
|------|------|
| 飞书群消息量大，机器人被无关消息刷爆 | @Bot 检测 + @all 忽略（KD-7）+ Phase D 权限白名单 |
| Bot 自身 open_id 获取方式可能因飞书 API 变更 | 双策略：API 查询 + env 配置 fallback（KD-5） |
| ConnectorSource 扩展 sender 可能影响前端渲染 | sender 字段可选，前端 graceful fallback |
| 公共层改动（Phase B）影响其他 adapter | sender 参数可选，不传 = 不影响；跨 family review Maine Coon |
| 新增飞书权限（contact/chat）需team lead手动配置 | 文档中列出具体权限名，提醒team lead在开发者后台添加 |
| 发送者姓名 API 调用频率限制 | 内存 Map 缓存，同一 open_id 只调一次（KD-6） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 飞书群聊从 F088 拆出为独立 Feature F134 | F088 已有 19 个 ISSUE 太重；F132 已验证拆分模式可行；公共层改动记 F088 Phase 7 | 2026-03-24 |
| KD-2 | 先做 Phase A-C，Phase D 权限控制后做 | team lead确认："好像可以先做 1-3 然后再做 4" | 2026-03-24 |
| KD-3 | 群消息必须 @机器人才处理 | 飞书会推送所有群消息给订阅的 bot，不过滤会导致垃圾消息涌入 | 2026-03-24 |
| KD-4 | 公共层 sender 扩展属于 F088 Phase 7，在 F134 开发中联动推进 | 保持 F088 作为公共层唯一真相源，避免平台特定 Feature 改动公共层接口后忘记更新 F088 | 2026-03-24 |
| KD-5 | Bot open_id 双策略获取 | 启动时调 `GET /open-apis/bot/v3/info` 自动获取 + `FEISHU_BOT_OPEN_ID` env 兜底。原因：open_id 是 app-scoped（同一 bot 不同 app token 看到不同 open_id，见 openclaw/openclaw#40768），env 兜底防 API 失败 | 2026-03-25 |
| KD-6 | 发送者姓名通过 Contact API 获取 + 内存缓存 | `event.sender` 只有 `sender_id`（含 open_id/user_id/union_id），无 name 字段。需调 `GET /contact/v3/users/:open_id` 获取。用 Map 缓存避免重复调用。需 `contact:user.base:readonly` 权限 | 2026-03-25 |
| KD-7 | @所有人（@_all）不触发 bot | team lead确认："我@所有人的时候，bot我觉得应该不要响应，而是要明确@bot时候才响应"。`@_all` 在 mentions 中 key 为 `@_all`，与 `@_user_N` 不同，过滤即可 | 2026-03-25 |
| KD-8 | ~~群聊中禁用 /命令~~ → 群聊支持 /命令 + 每群独立 IM Hub | 初版 KD-8 禁用了群聊 /command，team lead实测发现 `/threads` 被猫猫"扮演系统"回复。PR #699 移除限制，群聊恢复 /slash 命令支持，Hub 标题含群名（`飞书群聊 · {群名} IM Hub`）区分多群 | 2026-03-25 |
| KD-9 | `@sender` 采用 message-level 绑定（`source.sender` 写入 messageStore）而非 thread-level lastSender | 原设计的 `lastSender` 是 thread 级覆盖存储，群聊并发时后到消息会覆盖先到的 sender，导致错 @。改用 message-level：每条入站消息的 `ConnectorSource.sender` 已持久化在 messageStore，deliver 时通过 `triggerMessageId` 回溯原始消息的 sender。详见 KD-9 技术设计章节 | 2026-03-25 |
| KD-10 | Contact API + Chat API 放在 FeishuAdapter，不预抽服务 | `resolveSenderName(openId)` + `resolveChatName(chatId)` 带 TTL Map cache，直接放在 FeishuAdapter 内。只有第二个 connector 也需要时才抽 `FeishuContactService`。需权限：`contact:user.base:readonly` + `im:chat:readonly`（team lead已配） | 2026-03-25 |
| KD-11 | Connector source 队列禁止 merge | `source === 'connector'` 的消息直接禁止 merge（快速稳妥方案）。QueueEntry 新增可选 `senderMeta` 字段用于 UI 展示，但不参与 merge 判断。这避免群聊中不同 sender 的消息被合并 | 2026-03-25 |
| KD-12 | Phase D 三层权限模型 | 第一层：群白名单（`/allow-group` `/deny-group`）；第二层：@bot 对话全开放不限制；第三层：/command 管理命令仅管理员可用（`FEISHU_ADMIN_OPEN_IDS` env）。team lead场景：演示时防别人刷 token、乱切 thread | 2026-03-25 |

## Design Gate Results（2026-03-25）

### 飞书 API 事件结构发现

通过阅读[飞书官方文档](https://open.larkoffice.com/document/server-docs/im-v1/message/events/receive)及 GitHub 开源实现（openclaw/openclaw、LobsterAI 等）确认：

1. **`event.sender` 无 name 字段** — 只包含 `sender_id: { open_id, user_id, union_id }` + `sender_type` + `tenant_key`
2. **`event.message.mentions[]` 有 name** — 每个 mention 包含 `{ key: "@_user_1", id: { open_id }, name: "显示名", tenant_key }`，用于 @bot 检测
3. **群聊名不在事件体中** — 只有 `event.message.chat_id`，需调 `GET /im/v1/chats/:chat_id` 获取群名（需 `im:chat:readonly` 权限）
4. **发送者姓名** — 需调 `GET /contact/v3/users/:open_id` 获取（需 `contact:user.base:readonly` 权限），用内存 Map 缓存
5. **Bot open_id** — 用 `GET /open-apis/bot/v3/info` 启动时获取 + env `FEISHU_BOT_OPEN_ID` 兜底

### 已知陷阱

- **open_id 是 app-scoped**（openclaw/openclaw#40768）：同一 bot 在不同 app token 下 open_id 不同，必须用同一个 app 的 token 查
- **@mention 不被识别**（openclaw/openclaw#34271）：需从 mentions 数组匹配，不能靠 text 中的占位符文本
- **@all 应忽略**（openclaw/openclaw#37706）：社区最佳实践，`@_all` 的 key 为 `@_all` 而非 `@_user_N`

### 新增飞书权限需求

team lead需在飞书开发者后台添加以下权限：

| 权限 | 用途 | 阶段 |
|------|------|------|
| `contact:user.base:readonly` | 获取发送者姓名 | Phase A |
| `im:chat:readonly` | 获取群聊名称 | Phase B |

## Technical Design

### Phase A: FeishuAdapter 群聊解析

```
飞书 Webhook Event
  │
  ├─ chat_type === 'p2p' → 现有 DM 逻辑（不变）
  │
  └─ chat_type === 'group'
       │
       ├─ mentions[] 中是否有 bot open_id？
       │     ├─ 无 → return null（静默忽略）
       │     └─ 有 → 继续处理
       │
       ├─ mentions[] 中 key === '@_all'？→ 不算 @bot
       │
       ├─ 从 text 中剥离 @bot 占位符（@_user_N → 空字符串）
       │
       ├─ 提取 sender: { id: event.sender.sender_id.open_id }
       │
       ├─ 异步查询 sender name（Contact API + cache）
       │
       └─ 返回 FeishuInboundMessage { chatType: 'group', senderId, senderName?, ... }
```

**Bot open_id 初始化**（在 connector-gateway-bootstrap.ts）：

```typescript
// 启动时获取
const botInfo = await feishuClient.get('/open-apis/bot/v3/info');
const botOpenId = botInfo?.bot?.open_id ?? process.env.FEISHU_BOT_OPEN_ID;
// 传给 FeishuAdapter 构造参数
```

### Phase B: 公共层 Sender 透传

```
FeishuAdapter.parseEvent()
  → { chatId, text, messageId, senderId, senderName, chatType }
       │
       └─ connector-gateway-bootstrap.ts
            → connectorRouter.route(connectorId, chatId, text, msgId, attachments,
                 sender: { id: senderId, name: senderName },  // 新参数
                 chatType: 'group')
                   │
                   ├─ 创建 thread 时标题: chatType==='group' ? `飞书群聊 ${群名}` : '飞书 DM'
                   │
                   ├─ ConnectorSource 包含 sender 字段
                   │     { connector: 'feishu', label: '飞书群聊 · {群名}',
                   │       sender: { id: 'ou_xxx', name: 'You' } }
                   │
                   └─ messageStore.append() 携带 source.sender → Web UI 可渲染
```

### Phase C: 群聊回复 @发送者

```
猫回复 → OutboundDeliveryHook.deliver()
  │
  ├─ 从 message metadata 取 sender info
  │
  └─ FeishuAdapter.sendReply()
       │
       ├─ chatType === 'group' && sender?
       │     → 文本前缀: <at user_id="ou_xxx">You</at> + 原始回复
       │
       └─ chatType === 'p2p'
             → 不加 @，保持原行为
```

## Review Gate

- Phase A+B: 跨 family review（Maine Coon @codex），公共层改动需额外审查
- Phase C: 可与 Phase A+B 合并 review
- Phase D: 独立 review（涉及权限模型）

## KD-9 技术设计：Message-Level Sender 绑定 + 全链路 @sender

> 此章节记录 Review Round 1-2 发现的 P1 问题及最终技术方案（team lead拍板不降级 spec）。

### 问题根因

原设计使用 thread-level `lastSender`（ConnectorThreadBindingStore 中按 thread 存储最后一个 sender），存在三个致命缺陷：

1. **并发覆盖**：群聊中 A 发消息、B 紧接着发消息 → `lastSender` 被 B 覆盖 → A 的回复错误 @ 了 B
2. **时序竞态**：`trigger()` 先于 `updateLastSender()` 执行（fire-and-forget），同一轮内可能读到旧 sender
3. **脏数据残留**：Memory/Redis store 中 sender 缺失时不清旧 `lastSenderName`，出现"新 id + 旧 name"

### 核心设计：sender 随消息存储，deliver 时回溯

```
飞书群聊消息
  │
  ├─ FeishuAdapter.parseEvent()
  │     → { chatId, text, messageId, senderId, senderName?, chatType }
  │
  ├─ FeishuAdapter.resolveSenderName(openId)  ← KD-10: Contact API + TTL cache
  │
  ├─ FeishuAdapter.resolveChatName(chatId)    ← KD-10: Chat API + TTL cache
  │
  └─ connector-gateway-bootstrap.ts
       → connectorRouter.route(connectorId, chatId, text, msgId, attachments,
            sender: { id, name },   ← NEW
            chatType: 'group')      ← NEW
            │
            ├─ ConnectorSource 包含 sender 字段
            │     { connector: 'feishu',
            │       label: '飞书群聊 · {群名}',
            │       sender: { id: 'ou_xxx', name: 'You' } }
            │
            ├─ messageStore.append(source: { ...source, sender })
            │     → stored.id = "msg_abc123"  ← triggerMessageId
            │
            └─ invokeTrigger.trigger(threadId, catId, userId, text, stored.id)
                 │
                 │  ... agent 执行 ...
                 │
                 └─ outboundHook.deliver(threadId, content, catId, ..., triggerMessageId?)
                      │
                      ├─ 从 messageStore 回溯 triggerMessageId 的 source.sender
                      │     → { id: 'ou_xxx', name: 'You' }
                      │
                      └─ FeishuAdapter.sendFormattedReply(chatId, envelope, replyToSender?)
                           → 群聊: card header 加 @<at ...>You</at>
                           → DM: 不加 @（保持原行为）
```

### 改动清单（5 层 × 代码变更）

#### Layer 1: 共享类型（packages/shared）

```typescript
// packages/shared/src/types/connector.ts
export interface ConnectorSource {
  // ...existing fields
  readonly sender?: {
    readonly id: string;
    readonly name?: string;
  };
}
```

#### Layer 2: FeishuAdapter（飞书特定）

```typescript
// FeishuAdapter.ts — 扩展 parseEvent + 新增 API 方法
interface FeishuInboundMessage {
  chatId: string;
  text: string;
  messageId: string;
  senderId: string;
  senderName?: string;         // NEW
  chatType?: 'p2p' | 'group';  // NEW
  chatName?: string;            // NEW: 群名
  attachments?: FeishuAttachment[];
}

// 新增：通过 Contact API 获取用户名（带 TTL cache）
async resolveSenderName(openId: string): Promise<string | undefined>

// 新增：通过 Chat API 获取群名（带 TTL cache）
async resolveChatName(chatId: string): Promise<string | undefined>
```

**parseEvent 改动**：
- 移除 `if (message.chat_type !== 'p2p') return null` 
- 群聊消息：检查 mentions 中是否有 bot openId → @bot 检测
- 群聊消息：从 text 中剥离 @bot 占位符
- 提取 chatType + senderId
- 返回扩展的 FeishuInboundMessage

#### Layer 3: ConnectorRouter（公共层）

```typescript
// ConnectorRouter.ts — route() 签名扩展
async route(
  connectorId: string,
  externalChatId: string,
  text: string,
  externalMessageId: string,
  attachments?: Array<...>,
  sender?: { id: string; name?: string },   // NEW
  chatType?: 'p2p' | 'group',               // NEW
  chatName?: string,                          // NEW
): Promise<RouteResult>
```

**route() 内部变更**：
- Thread 创建标题：`chatType==='group' ? \`飞书群聊 · ${chatName || chatId}\` : '飞书 DM'`
- ConnectorSource 携带 sender 字段
- messageStore.append() 的 source 包含 sender → 持久化到消息存储

#### Layer 4: OutboundDeliveryHook（出站）

```typescript
// OutboundDeliveryHook.ts — deliver() 签名扩展
async deliver(
  threadId: string,
  content: string,
  catId?: CatId,
  richBlocks?: RichBlock[],
  threadMeta?: ThreadMeta,
  origin?: MessageOrigin,
  triggerMessageId?: string,  // NEW: 用于回溯原始 sender
): Promise<void>
```

**deliver() 内部变更**：
- 若 `triggerMessageId` 存在 → 从 messageStore 查询原始消息的 `source.sender`
- 若 sender 存在且 chatType==='group' → 传给 adapter 的 metadata 中包含 `replyToSender`
- adapter 的 sendFormattedReply / sendReply 据此决定是否 @ 发送者

#### Layer 5: InvocationQueue merge 感知

```typescript
// InvocationQueue.ts — 新增 senderMeta 字段
interface QueueEntry {
  // ...existing fields
  senderMeta?: { id: string; name?: string };  // NEW: connector 入站时的 sender
}
```

**merge 策略（采用Maine Coon review 的"快速稳妥"方案）**：
```typescript
// source === 'connector' 直接禁止 merge（不同群用户消息绝不合并）
// 这比精细 sender 比较更安全，避免任何跨发送者合并风险
if (
  tail &&
  tail.status === 'queued' &&
  tail.source === input.source &&
  tail.source !== 'connector' &&  // NEW: connector 消息不 merge
  tail.intent === input.intent &&
  arraysEqual(sorted(tail.targetCats), sorted(input.targetCats))
) {
  // merge
}
```

**sender 链路打通**（解决Maine Coon P1：enqueue 入参缺 sender）：
```typescript
// ConnectorInvokeTrigger.enqueueWhileActive() — 新增 sender 参数
private enqueueWhileActive(
  threadId: string,
  catId: CatId,
  userId: string,
  message: string,
  messageId: string,
  sender?: { id: string; name?: string },  // NEW
): 'full' | 'enqueued' | 'merged' {
  const result = invocationQueue.enqueue({
    threadId, userId, content: message,
    source: 'connector',
    targetCats: [catId],
    intent: 'execute',
    senderMeta: sender,  // NEW: 传入 sender 信息
  });
  // ...
}
```

上游调用 `enqueueWhileActive` 的 2 处（`trigger` 和 `handleUrgentTrigger`）sender 来源：
- `sender` 由 `ConnectorRouter.route()` 的入参向下透传给 `invokeTrigger.trigger(..., sender)`
- `trigger()` 再透传给 `enqueueWhileActive(..., sender)` 和 `handleUrgentTrigger(..., sender)`
- 最上游：bootstrap 层从 `parseEvent()` 解析出 `senderId`，通过 `resolveSenderName()` 获取 name，组装 `{ id, name }` 后传入 `route()`

#### 全链路 triggerMessageId 传递（deliver 调用点）

| 调用点 | 文件 | 如何获取 triggerMessageId |
|--------|------|--------------------------|
| ConnectorInvokeTrigger | `ConnectorInvokeTrigger.ts:244-290` | 函数参数 `messageId`（已有，即 connector 入站消息 ID） |
| QueueProcessor | `QueueProcessor.ts:735-780` | `entry.messageId`（已有） |
| messages.ts (Web UI) | `messages.ts:1345-1374` | `stored.id`（非 connector，不需要 sender） |
| callbacks.ts | `callbacks.ts:548` | `validatedReplyTo ?? autoFilledReplyTo`（回溯 parent invocation 的触发消息，非 connector 场景不需要 sender） |

**类型声明层同步**（P2，Maine Coon review 补充）：
除业务调用点外，以下类型接口也需同步扩展 `triggerMessageId` 参数：
- `messages.ts` 的 `OutboundDeliveryHookLike` 接口
- `callbacks.ts` 的 `CallbackRoutesOptions.outboundHook.deliver` 类型
- `QueueProcessor` 的 `OutboundDeliveryHookLike` 类型
- `connector-gateway-bootstrap` 注入依赖（按 messageId lookup，不做 thread 扫描）

### 不需要改的部分

1. **InvocationQueue scopeKey** — 保持 `threadId:userId`，不需要改为 `threadId:senderId`（connector 仍然用 defaultUserId）
2. **ConnectorThreadBindingStore** — `lastSender` 代码路径删除（不再读写），Redis 历史字段容忍残留不清理（后续单独做迁移）
3. **RedisConnectorThreadBindingStore** — 同上，代码接口移除 `lastSender`，不再写入

### ConnectorBubble 展示规范（Maine Coon review 确认）

群聊消息气泡展示：
- 主标签：`飞书群聊 · {chatName || chatIdSuffix}`
- 副标签：`{senderName || senderId} 说`
- **必须有 fallback**：name 缺失时回退到 id，避免 UI 空洞

### FeishuAdapter @sender 飞书语法

群聊回复时，在 card 或 text 中 @ 发送者：

```json
// Interactive Card (sendFormattedReply)
{
  "header": { "title": { "tag": "plain_text", "content": "🐱 回复 @You" } },
  "elements": [
    { "tag": "markdown", "content": "<at id=ou_xxx></at> 你好，回答如下..." }
  ]
}

// Plain Text (sendReply fallback)
{ "text": "<at user_id=\"ou_xxx\">You</at> 你好，回答如下..." }
```

### KD-10: Contact API + Chat API 方案

**放在 FeishuAdapter 内**，不预抽服务：

```typescript
class FeishuAdapter {
  private senderNameCache = new Map<string, { name: string; expiresAt: number }>();
  private chatNameCache = new Map<string, { name: string; expiresAt: number }>();
  private static CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

  async resolveSenderName(openId: string): Promise<string | undefined> {
    const cached = this.senderNameCache.get(openId);
    if (cached && cached.expiresAt > Date.now()) return cached.name;
    
    // GET /open-apis/contact/v3/users/:open_id?user_id_type=open_id
    const token = await this.tokenManager?.getTenantAccessToken();
    if (!token) return undefined;
    const res = await fetch(`https://open.feishu.cn/open-apis/contact/v3/users/${openId}?user_id_type=open_id`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    const name = data?.data?.user?.name;
    if (name) {
      this.senderNameCache.set(openId, { name, expiresAt: Date.now() + FeishuAdapter.CACHE_TTL_MS });
    }
    return name;
  }

  async resolveChatName(chatId: string): Promise<string | undefined> {
    const cached = this.chatNameCache.get(chatId);
    if (cached && cached.expiresAt > Date.now()) return cached.name;
    
    // GET /open-apis/im/v1/chats/:chat_id
    const token = await this.tokenManager?.getTenantAccessToken();
    if (!token) return undefined;
    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${chatId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    const name = data?.data?.name;
    if (name) {
      this.chatNameCache.set(chatId, { name, expiresAt: Date.now() + FeishuAdapter.CACHE_TTL_MS });
    }
    return name;
  }
}
```

**权限**：team lead已在飞书开发者后台配好 `contact:user.base:readonly` + `im:chat:readonly`。
