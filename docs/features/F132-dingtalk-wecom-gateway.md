---
feature_ids: [F132]
related_features: [F088, F077, F113]
topics: [gateway, connector, dingtalk, wecom, wechat-work, chat-platform, enterprise-im]
doc_kind: spec
created: 2026-03-22
---

# F132: DingTalk + WeCom Chat Gateway — 钉钉/企微接入

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1
>
> **分工**：金渐层（@opencode）实现 → Maine Coon（@codex）review → Ragdoll（@opus）愿景守护
> 实现过程中不 @ Ragdoll，保持 owner 上下文干净。每个 Phase PR merge 后触发愿景守护。

## Why

Cat Café 已通过 F088 建立了飞书和 Telegram 的双向 DM 通道，但国内企业级 IM 还有两个主力平台未覆盖：**钉钉**（阿里系，6 亿+用户）和**企业微信**（腾讯系，与微信互通）。三者合计覆盖国内企业即时通讯 90%+ 的份额。

team experience：*"我们需要接入钉钉和企业微信，必须复用我们的 channel 等等架构设计，学习飞书的接入"*

F088 已验证的三层架构（Principal Link / Session Binding / Command Layer）+ adapter-only-protocol 原则天然支持新平台扩展——新增 adapter 无需改动公共层。本 feature 的核心工作是：为钉钉和企微写 adapter，复用 F088 全部公共基础设施。

> **设计修订（2026-03-22 GPT Pro 调研后）**：企微拆成两个独立 connector（`wecom-bot` + `wecom-agent`），而非一个统一 adapter。原因见 KD-4。

## What

### 架构复用（零改动公共层）

```
┌─ F088 平台无关公共层（已有，不改）──────────────────────────┐
│  ConnectorMessageFormatter → MessageEnvelope               │
│  ConnectorCommandLayer → /new /threads /use /where         │
│  ConnectorRouter → dedup → binding → store → invoke        │
│  OutboundDeliveryHook / StreamingOutboundHook               │
│  IConnectorThreadBindingStore (Redis)                       │
└─────────────────────────────────────────────────────────────┘
      ↕            ↕            ↕             ↕            ↕
 FeishuAdapter  TelegramAd.  DingTalkAd.  WeComBotAd.  WeComAgentAd.
 (F088 已有)    (F088 已有)   (Phase A)    (Phase B)    (Phase C)
```

新 adapter 实现 `IOutboundAdapter`（基础）或 `IStreamableOutboundAdapter`（流式），通过 duck typing 自动发现能力。

### Phase A: DingTalk Adapter — 钉钉企业内部应用

**连接方式**：Stream 模式（`dingtalk-stream` 官方 SDK，无需公网 URL）。

**认证**：企业内部应用 `appKey` + `appSecret`。

**入站** (`parseEvent`):
- Stream 事件 JSON 解析
- 消息类型：text、richText、picture、audio、file
- DM-only（MVP）
- Stream 心跳 + 断线重连（参考 `largezhou/openclaw-dingtalk` 的 monitor patch）

**出站双发送策略**（参考 `DingTalk-Real-AI` + `soimy` 的 AI Card 实践）：
- `sendReply`：text / markdown（保守路径）
- `sendFormattedReply`：**AI Card 模式** — 独立的富文本发送路径
  - 创建卡片：`/v1.0/card/instances/createAndDeliver`
  - 流式更新：`/v1.0/card/streaming`（状态机 PROCESSING → INPUTING → FINISHED）
  - 300ms throttle + single-flight
- `sendMedia`：图片/音频/文件上传

**流式**：实现 `IStreamableOutboundAdapter`
- `sendPlaceholder()` → 创建 AI Card instance
- `editMessage()` → 卡片 streaming update
- 完美映射到现有 `StreamingOutboundHook`

**SDK**：`dingtalk-stream`（官方 Stream SDK）+ 自建薄 OpenAPI 封装（卡片/媒体）

### Phase A.1: DingTalk 媒体原生发送 — 补齐飞书富媒体对等

> **前置**：Phase A 已 merged（PR #674）。Phase A 的 `sendMedia()` 对 audio/file 用文本降级（`🔊 url` / `📎 file`），image 仅支持 URL。本阶段补齐原生发送。

**目标**：DingTalk 媒体发送与飞书 `sendMedia()` 功能对等。

**实现要点**：

1. **媒体上传**：`POST /v1.0/robot/messageFiles/upload`
   - FormData 上传，获取 `mediaId`
   - 复用飞书 adapter 的上传优先链模式：platform key > absPath upload > URL download+upload > text fallback

2. **语音原生发送**：msgKey `sampleAudio`
   - `msgParam`: `{ mediaId: string, duration: string }` （duration 为 ms 字符串）
   - 需先 upload 获取 `mediaId`
   - ffmpeg 转码（如需要，复用飞书的 `convertToOpus()` 基础设施）

3. **文件原生发送**：msgKey `sampleFile`
   - `msgParam`: `{ mediaId: string, fileName: string, fileType: string }`
   - 需先 upload 获取 `mediaId`

4. **图片增强**：支持本地文件上传路径（不仅 URL）
   - 先 upload → 获取 `mediaId` → 用 `sampleImageMsg` 发送
   - 保留现有 URL 直发路径作为快速通道

**参考**：`satorijs/satori` adapters/dingtalk + `netease-youdao/LobsterAI` dingtalkGateway.ts

### Phase A.2: DingTalk 群聊支持 — 对齐飞书 F134 群聊能力

> **前置**：Phase A.1 完成后。媒体原生发送是基础，群聊也需要发送富媒体。

**目标**：DingTalk 群聊与飞书群聊（F134）功能对等，复用 IM Hub 群聊抽象。

**入站改动**：

1. **移除 DM-only 过滤**：`parseEvent()` 中 `conversationType !== '1'` → 支持群聊消息
2. **chatType 映射**：`conversationType === '1' ? 'p2p' : 'group'`（已存在，只需解锁）
3. **群聊 sender 解析**：从 webhook payload 提取 `senderStaffId` + `senderNick`

**出站改动**：

4. **群组消息发送**：`POST /v1.0/robot/orgGroupSend`
   - 参数：`{ msgKey, msgParam, robotCode, openConversationId }`
   - 与 `batchSendOTO` 并行路径，根据 `chatType` 分发
5. **AI Card 群聊投递**：`createAndDeliver` 已有 `imGroupOpenDeliverModel` 骨架（line 569-571）
6. **@sender 回复**：群聊回复前置 `@senderNick` 提及（参考飞书 `prependAtMention()`）

**IM Hub 抽象对齐**（参考 F134 飞书群聊实现）：

7. **名称解析**：
   - 用户名：DingTalk Contact API + TTL 缓存（参考飞书 `resolveSenderName()`）
   - 群名：DingTalk Chat API + TTL 缓存（参考飞书 `resolveChatName()`）
8. **connector-gateway-bootstrap 群聊路由**：复用 F134 的 group chat routing pattern
9. **ConnectorRouter 群聊线程**：复用现有线程命名 + 权限检查逻辑
10. **OutboundDeliveryHook 元数据**：复用 `replyToSender` 元数据解析

### Phase B: WeCom Bot Adapter — 企微 AI Bot（实时交互）

**连接方式**：WebSocket 长连接（`@wecom/aibot-node-sdk` 官方 SDK）。

**认证**：`botId` + `secret`。

**入站** (`parseEvent`):
- WebSocket JSON 帧解析
- 消息类型：text、image、voice、file
- DM + 群聊（Bot 天然支持两者）

**出站**：
- `sendReply`：text / markdown
- `sendFormattedReply`：模板卡片发送 + 更新
- `sendMedia`：SDK 内置媒体上传/下载

**流式**：实现 `IStreamableOutboundAdapter`
- 原生 `replyStream` 支持（真流式，非 edit 模拟）
- `sendPlaceholder()` → 开始流式回复
- `editMessage()` → 追加流式内容
- 参考 `WecomTeam/wecom-openclaw-plugin` + `YanHaidao/wecom`

**为什么 Bot 优先**：低延迟、原生流式、无需公网 URL、体验最接近飞书。

### Phase C: WeCom Agent Adapter — 企微自建应用（兜底/主动推送）

**连接方式**：HTTP callback（需公网 URL + Cloudflare 隧道）。

**认证**：`corpId` + `agentId` + `agentSecret`，出站需 `access_token` 管理（2h 有效期）。

**安全层**（参考 `toboto/openclaw-wecom-channel` 的 AES/XML 实现）：
- 回调 URL 验证：GET echostr 解密回传
- SHA1 签名校验（`msg_signature` + `timestamp` + `nonce`）
- AES-256-CBC 解密（`EncodingAESKey` → Base64 解码 → IV 取 key 前 16 字节 → PKCS7 去 padding → CorpID 校验）
- XML 解析：`fast-xml-parser`（adapter 内部转 JSON 后交公共层）

**入站** (`parseEvent`):
- AES 解密 → XML → JSON 转换
- 消息类型：text、image、voice、video、location、file

**出站**：
- `sendReply`：text / markdown（通过 `message/send` API，JSON）
- `sendFormattedReply`：Text Card / News 图文卡片
- `sendMedia`：临时素材 API（`media/upload` / `media/get`）

**流式**：**不实现** `IStreamableOutboundAdapter`（classic callback 无 edit 语义）
- 仅实现 `IOutboundAdapter`，走 final-only 发送
- 长回复做字节数限制 + 分块发送
- StreamingOutboundHook 通过 duck typing 自动跳过此 adapter

**定位**：Phase B 的兜底补充——主动推送、媒体补发、兼容老企业接入方式。

### Phase D: Bootstrap + 富文本映射 + 文档

**Bootstrap**：
- `connector-gateway-bootstrap.ts` 动态注册三个 adapter（有 env var 才启用）
- 环境变量：
  - 钉钉：`DINGTALK_APP_KEY`、`DINGTALK_APP_SECRET`
  - 企微 Bot：`WECOM_BOT_ID`、`WECOM_BOT_SECRET`
  - 企微 Agent：`WECOM_CORP_ID`、`WECOM_AGENT_ID`、`WECOM_AGENT_SECRET`、`WECOM_TOKEN`、`WECOM_ENCODING_AES_KEY`

**富文本映射**：

| Envelope 字段 | 飞书 | 钉钉 | 企微 Bot | 企微 Agent |
|--------------|------|------|---------|-----------|
| header | Card header | AI Card title | 模板卡片 header | TextCard title |
| body | Card body (md) | AI Card markdown | 流式文本 | description |
| footer | URL button | Card URL | — | TextCard URL |
| media | Image element | Picture msg | SDK 上传 | 临时素材 API |
| streaming | edit card | card streaming | replyStream | ❌ final-only |

## Acceptance Criteria

### Phase A（DingTalk Adapter — DM 基础）
- [x] AC-A1: 钉钉企业内部应用 DM 消息入站解析正确（text + richText）
- [x] AC-A2: 猫猫回复通过 DingTalkAdapter 发送到钉钉（text + markdown）
- [x] AC-A3: AI Card 正确渲染猫名 header + 正文 + deep link
- [x] AC-A4: AI Card 流式（create → streaming update → finish，300ms throttle）
- [x] AC-A5: 图片/音频双向收发
- [x] AC-A6: 复用 ConnectorRouter/CommandLayer/BindingStore，公共层零改动
- [x] AC-A7: Stream 连接断线自动重连 + 幂等去重

### Phase A.1（DingTalk 媒体原生发送）✅ PR #720 merged
- [x] AC-A1.1: 语音通过 `sampleAudio` msgKey 原生发送（不再文本降级）
- [x] AC-A1.2: 文件通过 `sampleFile` msgKey 原生发送（不再文本降级）
- [x] AC-A1.3: 图片支持本地文件上传路径（不仅 URL 直发）
- [x] AC-A1.4: 媒体上传通过 `/v1.0/robot/messageFiles/upload` API
- [x] AC-A1.5: 上传优先链与飞书一致：platform key > absPath upload > URL download+upload > text fallback
- [x] AC-A1.6: 公共层零改动

### Phase A.2（DingTalk 群聊支持）✅ PR #723 merged
- [x] AC-A2.1: 群聊消息入站解析正确（移除 DM-only 过滤）
- [x] AC-A2.2: 群组消息通过 `orgGroupSend` API 发送
- [x] AC-A2.3: AI Card 在群聊中正确投递（`imGroupOpenDeliverModel`）
- [x] AC-A2.4: 群聊回复带 @sender 提及
- [x] AC-A2.5: 用户名/群名解析 + TTL 缓存
- [x] AC-A2.6: 复用 IM Hub 群聊抽象（bootstrap routing + ConnectorRouter + OutboundDeliveryHook）
- [x] AC-A2.7: 公共层零改动

### Phase B（WeCom Bot Adapter）
- [ ] AC-B1: 企微 Bot WebSocket 连接 + 心跳 + 重连
- [ ] AC-B2: Bot DM 消息入站解析正确（text + image + voice）
- [ ] AC-B3: 猫猫回复通过 `replyStream` 流式发送（真流式）
- [ ] AC-B4: 模板卡片发送 + 更新
- [ ] AC-B5: 图片/语音双向收发（SDK 内置）
- [ ] AC-B6: 复用 ConnectorRouter/CommandLayer/BindingStore，公共层零改动

### Phase C（WeCom Agent Adapter）
- [ ] AC-C1: 回调 URL 验证（echostr challenge + AES 解密）通过
- [ ] AC-C2: SHA1 签名校验 + AES-256-CBC 消息解密正确
- [ ] AC-C3: XML → JSON 转换正确（`fast-xml-parser`）
- [ ] AC-C4: 猫猫回复通过 `message/send` API 发送（text + markdown + 图文卡片）
- [ ] AC-C5: 图片/语音通过临时素材 API 收发
- [ ] AC-C6: final-only 模式（无 streaming），长回复分块发送
- [ ] AC-C7: 公共层零改动

### Phase D（Bootstrap + 富文本映射 + 文档）
- [ ] AC-D1: connector-gateway-bootstrap 动态注册三个 adapter（有 env var 才启用）
- [ ] AC-D2: MessageEnvelope → 各平台原生卡片映射完整
- [ ] AC-D3: Rich blocks 在所有平台正确降级
- [ ] AC-D4: IM 接入指南文档覆盖钉钉 + 企微 Bot + 企微 Agent 配置步骤
- [ ] AC-D5: 现有飞书/Telegram 功能无回归

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "接入钉钉" | AC-A1~A7 | test + manual DM | [x] |
| R2 | "接入企业微信" | AC-B1~B6, AC-C1~C7 | test + manual DM（两种模式） | [ ] |
| R3 | "必须复用我们的 channel 等等架构设计" | AC-A6, AC-A1.6, AC-A2.7, AC-B6, AC-C7 | code review: 公共层 diff = 0 | [ ] |
| R4 | "学习飞书的接入" | AC-D2~D3 | adapter 结构对照 FeishuAdapter | [ ] |
| R5 | 参考 OpenClaw 生态 | KD-1, KD-4 | 设计文档引用 + 调研综合报告 | [ ] |
| R6 | "富文本/媒体原生发送都支持完整" | AC-A1.1~A1.5 | 语音/文件/图片原生发送，不降级 | [x] |
| R7 | "群聊对接飞书 IM Hub 抽象" | AC-A2.1~A2.7 | 群聊收发 + @回复 + 名称解析 | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（若适用）— 本 feature 无前端

## Dependencies

- **Evolved from**: F088（Multi-Platform Chat Gateway — 复用其三层架构和全部公共层）
- **Related**: F077（Multi-User Secure Collaboration — 群聊阶段需要）
- **Related**: F113（Multi-Platform One-Click Deploy — 部署配置联动）
- **External**: 钉钉开放平台企业内部应用、企业微信管理后台自建应用

## Risk

| 风险 | 缓解 |
|------|------|
| `dingtalk-stream` 有丢消息历史（社区报告） | 复用 F088 `InboundMessageDedup` + reconnect 监控 + 幂等 |
| 企微 Agent 的 AES/XML 协议复杂度 | 参考 `toboto/openclaw-wecom-channel` 的 crypto.ts 实现，用 Node 原生 `crypto` |
| 企微包名分叉（`@wecom/` vs `@tencent/`） | 内部 pin 到仓库 + commit + 包版本 |
| 三个 adapter 的 Session Binding 交叉 | 每个 connector ID 独立绑定，互不干扰 |
| 企业应用审核周期 | 文档中明确前置条件 + 开发环境配置指南 |
| 五平台卡片格式差异大 | Phase D 统一映射 + duck typing 能力发现，优雅降级 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 参考 OpenClaw 社区插件架构，不引入 ChannelPlugin 接口 | OpenClaw 社区有成熟钉钉/企微插件（`largezhou`、`YanHaidao`、`toboto` 等），验证了 adapter-only 模式。我们的三层架构已足够 | 2026-03-22 |
| KD-2 | adapter-only 扩展，公共层零改动 | F088 架构验证 + duck typing 能力发现天然支持 | 2026-03-22 |
| KD-3 | ~~DM-only MVP~~ → 钉钉分三步：DM 基础(A) → 媒体原生发送(A.1) → 群聊(A.2) | team lead确认"先把富文本/媒体原生发送都支持完整，然后再完整地做群聊" | 2026-03-22→03-23 |
| KD-4 | **企微拆两个 connector**：`wecom-bot`（WebSocket + 流式）+ `wecom-agent`（HTTP callback + AES/XML） | GPT Pro 调研确认：身份、协议、流式能力完全不同，硬揉一个 adapter 会把 Principal Link 和 Session Binding 搅成毛线球。OpenClaw 生态的 `YanHaidao/wecom` 已验证 dual-mode 架构 | 2026-03-22 |
| KD-5 | 钉钉用 AI Card 做流式，不用 plain message edit | 钉钉 plain message 不支持编辑，但 AI Card 支持 create → streaming update → finish 状态机。`soimy/openclaw-channel-dingtalk` 已验证此路径 | 2026-03-22 |
| KD-6 | 钉钉群聊须对齐飞书 F134 IM Hub 抽象 | team experience"群聊你也得对接上飞书有的功能或者他们的抽象你要接入，IM Hub 里群聊怎么映射你们也要这么干" | 2026-03-23 |

## Review Gate

- Phase A: 跨 family review（Maine Coon）
- Phase B: 跨 family review（Maine Coon）
- Phase C: 跨 family review（Maine Coon）— AES/XML 安全实现需额外审查
- Phase D: 可与 Phase C 合并 review
