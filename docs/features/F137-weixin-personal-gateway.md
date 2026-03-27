---
feature_ids: [F137]
related_features: [F088, F132]
topics: [gateway, connector, weixin, wechat, personal-im, ilink-bot, chat-platform]
doc_kind: spec
created: 2026-07-19
---

# F137: WeChat Personal Gateway — 微信个人号 iLink Bot 接入

> **Status**: done | **Completed**: 2026-03-25 | **Owner**: 金渐层 | **Priority**: P1
>
> **分工**：金渐层（@opencode）实现 → Maine Coon（@codex）review → Ragdoll（@opus）愿景守护
> 实现过程中不 @ Ragdoll，保持 owner 上下文干净。每个 Phase PR merge 后触发愿景守护。

## Why

F088 + F132 覆盖了**企业级 IM**（飞书、Telegram、钉钉、企业微信），但team lead的个人微信——12 亿用户量级的国民级 IM——一直无法接入。2026 年 7 月，腾讯微信正式开放 **iLink Bot 协议**（灰度中），允许个人微信号直接与 AI Bot 交互（扫码登录、长轮询收消息、HTTP 发消息），无需企业资质、无需公网 URL、无需 XML/AES 加解密。

team experience：*"那我们是不是可以学习 @tencent-weixin/openclaw-weixin 这个的实现模式！把我们的猫猫接入微信！！？"*

team experience：*"你也得复用那些基础设施，就不要自己做一套"*

team experience：*"如果这个有配置需要配置，有配置哈，我们也在得在那边能够显示我们的这个配置才可以"*（指 IM Hub 配置向导）

team lead确认已被灰度到 ClawBot（iLink Bot）功能。

**为什么独立于 F132**：F132 是**企业微信**（WeCom），走 WebSocket SDK / HTTP callback + AES/XML；F137 是**个人微信**，走 iLink Bot HTTP 长轮询，协议、认证、能力完全不同。两者平行但互不依赖。

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
      ↕            ↕            ↕            ↕            ↕
 FeishuAdapter  TelegramAd.  DingTalkAd.  WeixinAdapter  (F132 WeCom)
 (F088 已有)    (F088 已有)   (F132 done)  ← 本 Feature
```

新增 `WeixinAdapter` 实现 `IOutboundAdapter`，通过 duck typing 自动发现能力。连接方式为 **HTTP 长轮询**（类似 Telegram），无需 webhook、无需公网 URL。

### iLink Bot 协议要点

| 维度 | 说明 |
|------|------|
| **认证** | 扫码登录 → 获取 `bot_token`，无需企业资质 |
| **入站** | `POST /ilink/bot/getupdates`（35s 长轮询），JSON 格式 |
| **出站** | `POST /ilink/bot/sendmessage`，需要 `context_token`（从入站消息获取） |
| **会话** | `context_token` 是 per-(account, user) 的，必须缓存 |
| **断线** | `errcode -14` = session 过期，需重新扫码登录 |
| **媒体** | CDN 上传/下载，AES-128-ECB 加密，PKCS7 padding |
| **输入状态** | `POST /ilink/bot/sendtyping`（需 `typing_ticket`） |
| **消息限制** | 单条 2000 字符，超长需分块发送 |
| **Auth Header** | `AuthorizationType: ilink_bot_token` + `Authorization: Bearer <token>` + `X-WECHAT-UIN: <random>` |

### Phase A: 文本双向 — 扫码登录 + 收发文本消息 ✅

**连接方式**：HTTP 长轮询（`getupdates`，35s timeout）。

**认证流程**：
1. `GET /ilink/bot/get_bot_qrcode?bot_type=3` → 获取 QR code URL
2. 用户用微信扫码
3. `GET /ilink/bot/get_qrcode_status?qrcode=...` → 轮询状态 → 获取 `bot_token`
4. 持久化 `bot_token` 到 Redis

**入站** (`parseEvent`):
- `getupdates` 长轮询解析
- 文本消息类型处理
- `get_updates_buf` 游标持久化（Redis）
- 消息类型映射到 `ConnectorRouter` 标准格式

**出站** (`sendReply`):
- `sendmessage` + `context_token` 缓存（per user）
- 2000 字符限制 + 自动分块
- `message_state: 2 (FINISH)` 固定值

**Bootstrap**：
- `connector-gateway-bootstrap.ts` 条件注册（`WEIXIN_BOT_TOKEN` env var）
- 启动轮询循环

**Connector 注册**：
- `packages/shared/src/types/connector.ts` 新增 `'weixin'` ConnectorDefinition
- 绿色主题（微信品牌色 `#07C160`）

### Phase B: 输入状态 + 媒体收发

**输入状态**：
- `POST /ilink/bot/getconfig` 获取 `typing_ticket`
- `POST /ilink/bot/sendtyping` 显示"对方正在输入中"
- 在 agent 处理期间持续发送 typing（interval timer）

**媒体收发**：
- `sendMedia`: `getuploadurl` → CDN 上传（AES-128-ECB 加密）
- 入站图片: CDN 下载 → AES-128-ECB 解密
- 实现 `sendMedia?(externalChatId, payload)` 接口

### 富媒体能力调研（2026-07-25）

> team lead提问：*"个人微信能接入和飞书那样超级多的富文本包括文件的传输 音频 图片等等吗？"*

**~~结论（已过时）：收入方向支持图片/文件/语音；发出方向目前只能纯文本。~~**

**更正（2026-03-25）**：iLink `sendmessage` API 支持图片/文件/语音/视频出站（CDN 上传 + `image_item`/`file_item`/`voice_item`）。已实现：图片发送、文件发送、语音发送。详见下方能力矩阵。

#### iLink 协议消息类型（`ILinkMessageItem.type`）

| type 值 | 名称 | 入站（微信→Cat Cafe） | 出站（Cat Cafe→微信） |
|---------|------|:-----:|:-----:|
| 1 | TEXT | 已实现 | 已实现 |
| 2 | IMAGE | 已实现（CDN 下载 + AES 解密） | 已实现（CDN 上传 + `image_item`） |
| 3 | VOICE | 已实现（`voice_item.text` 语音转文字） | 已实现（CDN 上传 + `voice_item`） |
| 4 | FILE | 已实现（CDN 下载 + AES 解密） | 已实现（CDN 上传 + `file_item`） |
| 5 | VIDEO | 协议有定义（`video_item`），代码未实现 | 协议支持，代码未实现 |

#### 出站限制的技术根因

`/ilink/bot/sendmessage` API 的 `item_list` 仅支持 `text_item`（`type=1`）。`WeixinAdapter.sendMessageApi()`（第 642 行）构造的请求体：

```json
{
  "msg": {
    "item_list": [{ "type": 1, "text_item": { "text": "..." } }],
    "message_type": 2,
    "message_state": 2
  }
}
```

**~~之前结论有误~~**：iLink `sendmessage` API **支持发送图片/文件/语音/视频**——通过 `item_list` 中的 `image_item`/`file_item`/`voice_item`/`video_item`。需要先调 `getuploadurl` 获取 CDN 上传地址，用 AES-128-ECB 加密后上传，拿到 `filekey` + `encrypt_query_param` + `aes_key` 后放入 item。官方 `@tencent-weixin/openclaw-weixin@2.0.1` 的 `send-media.ts` + `cdn/upload.ts` 有完整实现。

> 纠正来源：2026-03-25 Ragdoll核实 openclaw v2.0.1 源码 `sendImageMessageWeixin` / `uploadFileToWeixin` 确认。

#### iLink 富媒体能力矩阵

| 能力 | iLink 协议 | Cat Cafe 实现 | 状态 |
|------|:-:|:-:|:-:|
| 文字收/发 | ✅ | ✅ | Phase A 已完成 |
| 图片收 | ✅ CDN URL | ✅ CDN 下载 + AES 解密 | Phase B 完成 |
| 图片发 | ✅ CDN 上传 + `image_item` | ✅ `sendMedia()` 已实现 | Phase B 完成 |
| 语音收 | ✅ CDN | ⚠️ 语音转文字已实现，CDN 下载未接入 | Phase B 部分 |
| 语音发 | ✅ CDN 上传 | ✅ `sendMedia(audio)` 已实现 | Phase B 完成 |
| 文件收 | ✅ CDN | ✅ CDN 下载 + AES 解密 | Phase B 完成 |
| 文件发 | ✅ CDN 上传 | ✅ `sendMedia(file)` 已实现 | Phase B 完成 |
| 视频收 | ✅ 协议定义 | ❌ 完全没做 | 低优先级 |
| 视频发 | ✅ CDN 上传 | ❌ | 低优先级 |
| 交互卡片 | ❌ 协议不支持 | — | 微信本身限制 |
| 消息编辑 | ❌ 协议不支持 | — | 微信本身限制 |
| 群聊 | ⚠️ `group_id` 字段存在但灰度未开放 | — | 等腾讯 |

#### CDN 上传流程（官方 openclaw v2.0.1 参考）

```
1. getUploadUrl(mediaType, fileSize) → { upload_url, file_key_prefix }
2. AES-128-ECB 加密文件内容（PKCS7 padding）
3. HTTP PUT 到 CDN upload_url
4. 拿到 filekey + encrypt_query_param + aes_key
5. sendmessage({ msg: { item_list: [{ type: IMAGE, image_item: { media: { encrypt_query_param, aes_key } } }] } })
```

#### 纯文本辨识度方案

在无法发送富文本的限制下，通过以下手段提升消息辨识度：
- 猫名标识：`【Ragdoll🐱】` 中文方括号 + cat emoji 作为前缀
- 多猫接力时每只猫独立标识段落，分隔线 `─────────` 提升可读性
- stripMarkdown 保留结构（bullet list → `•`、heading → 文本）

### Phase C: IM Hub 配置向导 + 健壮性

**IM Hub QR 登录 UI**（team lead明确要求：*"能不能做到im hub内？我点击获取二维码 然后给我二维码 我点击扫码完成 然后挂上这个？"*）：

扩展 `HubConnectorConfigTab.tsx`（现有 265 行，已有飞书/Telegram/钉钉配置）：

1. **微信配置卡片**：在 connector config 列表中添加微信个人号条目
   - 状态显示：未配置 → 扫码中 → 已连接（绿色）→ 已过期（红色）
   - 使用现有 `packages/web/public/images/connectors/weixin.png` 图标
   - 品牌色 `#07C160`（微信绿）

2. **QR 码获取 + 展示流程**：
   - 点击"获取二维码"按钮 → `POST /api/connector/weixin/qrcode`
   - 在配置面板内展示 QR 码图片（qrUrl 直连）
   - 底部显示"请用微信扫描二维码"提示

3. **扫码状态轮询（⚠️ 铁律：必须全自动，零用户干预）**：
   - **QR 码获取成功后立即自动启动 poll**（`setInterval` / `useEffect`），用户不需要点任何额外按钮或发任何消息
   - 轮询 `GET /api/connector/weixin/qrcode-status?qrPayload=<hex>`，间隔 2~3s
   - 状态映射：`0` → 等待扫码 → `1` → 已扫码待确认 → `4` → 成功
   - 超时处理：60s 无扫码自动过期，提示重新获取
   - team experience：*"扫码之后得自动 poll！不要我还要给你发个消息才能 poll"*

4. **扫码完成 → 自动激活（零用户干预）**：
   - poll 到 `confirmed` 后自动调用 `POST /api/connector/weixin/activate`
   - 激活后卡片自动切换为"已连接"状态
   - 显示连接时间和轮询状态
   - 整条链路：点击生成二维码 → 展示 QR → 用户扫码 → 自动检测 → 自动激活 → 完成。**用户只需做两件事：①点按钮 ②扫码**

5. **已有后端 API**（Phase A 已实现，无需改动）：
   ```
   POST /api/connector/weixin/qrcode      → { qrUrl, qrPayload }
   GET  /api/connector/weixin/qrcode-status → { status }
   POST /api/connector/weixin/activate     → { ok, polling }
   GET  /api/connector/status              → { platforms: [...] }
   ```

6. **前端组件新增**：
   - `HubConfigIcons.tsx`：添加 `PLATFORM_VISUALS.weixin` 条目
   - QR 码模态/内联面板组件（复用现有 modal 模式）

**健壮性**：
- Session 过期检测（`errcode -14`）→ 自动提醒重新扫码
- 长轮询断线重连 + 指数退避
- 幂等去重（复用 F088 `InboundMessageDedup`）
- 多账号支持预留（当前 MVP 单账号）

## Acceptance Criteria

### Phase A（文本双向）
- [x] AC-A1: 扫码登录流程完整（获取 QR → 扫码 → 获取 bot_token → 持久化）
- [x] AC-A2: 微信个人号 DM 消息入站解析正确（文本消息）
- [x] AC-A3: 猫猫回复通过 WeixinAdapter 发送到微信（文本，含 context_token 缓存）
- [x] AC-A4: 长消息自动分块（>2000 字符）
- [x] AC-A5: 复用 ConnectorRouter/CommandLayer/BindingStore，公共层零改动
- [x] AC-A6: /new /threads /use /where 命令在微信内正常工作 — ConnectorCommandLayer 对所有 connector 统一处理，无 weixin 排除逻辑
- [x] AC-A7: `connector.ts` 新增 `'weixin'` ConnectorDefinition，前端 bubble 正确渲染

### Phase B（输入状态 + 媒体）
- [x] AC-B1: agent 处理期间微信显示"对方正在输入中" — PR #708 已实现 sendTyping keepalive
- [x] AC-B2: 图片发送到微信 — PR #732: `weixin-cdn.ts` AES-128-ECB + CDN upload + `sendMedia(image_item)`
- [x] AC-B3: 图片从微信接收并下载 — `downloadMediaFromCdn` + AES-128-ECB 解密 + ConnectorMediaService 集成
- [x] AC-B4: `sendMedia` 接口实现 — PR #732: `WeixinAdapter.sendMedia(chatId, { type, absPath })` 路由 image/file/audio
- [x] AC-B5: 文件发送到微信 — PR #732: `uploadMediaToCdn` + `sendmessage` with `file_item`
- [x] AC-B6: 文件从微信接收并解析 — 同 AC-B3 管线，file_item CDN media key 提取 + 解密下载

### Phase C（IM Hub + 健壮性）
- [x] AC-C1: IM Hub 配置向导可添加微信个人号（QR 展示 + 扫码流程）
- [x] AC-C2: Session 过期（errcode -14）自动检测 + 提醒重新扫码 — `ERRCODE_SESSION_EXPIRED` + `sessionExpiredCallback` 已实现
- [x] AC-C3: 长轮询断线自动重连 + 指数退避 — 3s→60s 指数退避 + consecutiveErrors 计数
- [x] AC-C4: 幂等去重（InboundMessageDedup 复用）— ConnectorRouter.route() 统一 dedup，weixin 无需额外处理
- [x] AC-C5: 现有飞书/Telegram/钉钉功能无回归 — 5660 tests pass / 0 fail (full regression clean)

### Phase C AC-C1 验证证据
- PR #713: `WeixinQrPanel.tsx` (152 行) — 全自动 QR 状态机
- 7 测试覆盖所有状态转换 (idle→fetching→waiting→scanned→confirmed→error→expired)
- 自动轮询铁律：`setInterval(2500ms)` + `setTimeout(60000ms)`，扫码后零用户干预
- Pencil 绘制 SVG 图标，无 emoji
- Maine Coon (codex) R2 放行 + 云端 Codex review 无 P1/P2

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "把我们的猫猫接入微信" | AC-A1~A7 | test + manual DM | [x] |
| R2 | "你也得复用那些基础设施，就不要自己做一套" | AC-A5, AC-C4 | code review: 公共层 diff = 0 | [x] |
| R3 | "也得接入我们的消息管线，都得是一样的" | AC-A5, AC-A6 | /new /threads /use /where 可用 | [x] |
| R4 | "如果有配置需要配置...在那边能够显示" | AC-C1 | IM Hub 配置向导可见 | [x] |
| R5 | "按照我们的开发速度，不需要一天" | Phase A 优先 | Phase A 独立可用 | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（若适用）— Phase C IM Hub AC-C1 已完成

## Dependencies

- **Evolved from**: F088（Multi-Platform Chat Gateway — 复用其三层架构和全部公共层）
- **Related**: F132（DingTalk + WeCom — 姐妹 feature，企业微信 vs 个人微信）
- **External**: 腾讯微信 iLink Bot 协议（灰度阶段，team lead已获权限）

## Risk

| 风险 | 缓解 |
|------|------|
| iLink Bot 仍在灰度，API 可能变动 | 协议层薄封装，变动只影响 adapter 内部；社区 `epiral/weixin-bot` 有完整 protocol spec 可参考 |
| `bot_token` 有效期不确定，可能频繁过期 | Session 过期检测 + IM Hub 一键重新扫码 |
| 微信对 Bot 消息频率可能有限制 | 实现发送 rate limiter + 队列化 |
| CDN 媒体 AES-128-ECB 加解密 | Node.js 原生 `crypto` 模块，参考 `epiral/weixin-bot` protocol spec |
| 灰度取消或协议大改 | Phase A 文本双向先跑通验证，低投入高价值 |

## Known Bugs

### BUG-1: 出站消息无法投递到微信（P0）

**状态**: 🟢 Fixed — PR #701 squash merge (40639bd4)

**现象**（2026-07-24 Alpha 实测，3 次复现）：
- ✅ 微信扫码登录成功 → 长轮询启动
- ✅ 微信发消息 → iLink `getupdates` 正常接收 → ConnectorRouter 路由 → 创建 thread + binding → 猫猫 invocation 创建 → 猫猫处理完成
- ❌ 猫猫回复 **从未** 到达微信端 — 微信 DM 窗口无任何新消息

**证据链**（来自 `api.2026-03-23.1.log`, PID 72430）：

| 时间 (UTC) | 事件 | 日志行 | 状态 |
|---|---|---|---|
| 04:56:00 | QR confirmed, long polling started | ~189200 | ✅ |
| 05:04:04 | 第 1 条微信消息接收 | 189711 | ✅ |
| 05:04:04 | Thread `mn45go5om80e4v98` created + binding created | 189711 | ✅ |
| 05:04:04 | Invocation `c4e8b8bd` created (opus) | 189711 | ✅ |
| 05:04:43 | Invocation `ecad1262` completed | 189916 | ✅ |
| — | **deliver() 应该被调用 → 日志中完全无出站记录** | — | ❌ |
| 05:09:14 | `/threads` 命令处理成功 | ~190100 | ✅ |
| 05:10:28 | 第 3 条微信消息 → invocation `a07197a1` | 190598 | ✅ |
| 05:10:41 | Invocation `82924130` completed | 190879 | ✅ |
| — | **再次无出站记录** | — | ❌ |

**Redis binding 已确认存在**：
```
cat-cafe:connector-binding:weixin:o9cq8008zWwzHxRSAQqEgo5Sz34g@im.wechat
  connectorId: weixin
  externalChatId: o9cq8008zWwzHxRSAQqEgo5Sz34g@im.wechat
  threadId: thread_mn45go5om80e4v98
  userId: default-user
  createdAt: 1774328644432
  hubThreadId: thread_mn45nbswl44j0aei
```

**关键发现 — 双 invocation ID**：
- 系统创建: `c4e8b8bd`（行 189711）和 `a07197a1`（行 190598）
- 完成日志: `ecad1262`（行 189916）和 `82924130`（行 190879）
- 这是**不同的 ID** — ConnectorInvokeTrigger 内部创建了自己的 invocation record

**完全无出站日志**：
- 无 `"Outbound delivery failed"` 错误
- 无 `"No context_token cached"` 警告
- 无 `"No adapter registered"` 警告
- 无 iLink `sendmessage` HTTP 请求
- `OutboundDeliveryHook.deliver()` 在 `bindings.length === 0` 时 **静默返回**（第 68 行无日志）
- `WeixinAdapter.sendReply()` 在成功时 **无日志输出**

### BUG-2: 后续轮次回复无法投递到微信（P0）

**状态**: 🟢 Fixed — PR #704 + #708 + #710 + #711 累积修复，E2E 三轮验证通过 (2026-03-24)

**现象**：team lead发第一条微信消息 → 猫猫回复 → 微信收到 ✅。发第二条 → 猫猫回复 → 微信收不到 ❌（或延迟 3-5 分钟才收到）。

**根因（多层）**：
1. **iLink `context_token` 单次消费**（PR #704）：第一次 `sendmessage` + `FINISH` 后 token 作废，后续用同一 token 被静默丢弃
2. **分块发送触发 iLink 单次消费约束**（PR #710）：即使不同 token，每个 token 只投递第一个 `sendmessage` 调用，分块（多次调用）的后续块被丢弃
3. **`sendmessage` 请求体缺少官方必要字段**（PR #711）：我们的请求体比官方 `@tencent-weixin/openclaw-weixin@2.0.1` 少了 `client_id`、`message_type`、`from_user_id` 三个字段

**修复时间线**：
| PR | Commit | 修复内容 |
|----|--------|---------|
| #704 | 50b62edb | Token 消费追踪 + debounce 3s 聚合多猫回复 + 跨 token 隔离 |
| #708 | a0a07250 | sendTyping keepalive（typing_ticket → 5s heartbeat）— 排除了 typing 缺失假设 |
| #710 | 8f1e7fe9 | 禁用分块，单条 sendmessage 发送全部内容 — 排除了 chunking 假设，收敛到协议字段 |
| #711 | 61f6baf4 | 对齐官方 sendmessage body（补 `client_id/message_type/from_user_id`）+ 200+非 JSON/空 body 硬失败 + raw response 调试日志 |

**E2E 验证证据（2026-03-24，runtime PID 55412）**：

| 轮次 | 收到消息 (UTC) | 发出回复 (UTC) | tokenHash | iLink 返回 | 微信收到 |
|------|---------------|---------------|-----------|-----------|---------|
| 第 1 轮 | 22:30:46 | 22:31:01 | C3xsSh9V | 200 OK | ✅（延迟 ~3min，iLink 服务端投递延迟） |
| 第 2 轮 | 22:37:40 | 22:37:54 | KN/0/AOm | 200 OK | ✅ 立即收到 |
| 第 3 轮 | 22:39:04 | 22:39:20 | lomEmTvf | 200 OK | ✅ 立即收到 |

**已知 Debt（DEBT-1）**：triple-token rotation during async flush — 当 tokenA 正在异步 flush 时，tokenB 的 sendReply 在 `await flushReply()` 处等待，此时 tokenC 到达并建桶。B 恢复后发现桶的 token 不匹配，当前行为是 `resolve()` 静默跳过（B 内容不发出）。触发条件极端（3 个 token 在一次 flush 的网络时间内连续轮换），日常不会命中，但属于协议正确性 debt。修复方向：pending 按 `(chatId, token)` 双 key 分桶，或引入 per-chatId 发送队列。

### BUG-4：A→B→C 接力链只送达 A，B/C 静默丢失

**现象**：team lead在微信端发消息触发 A→B→C 猫猫接力链时，只收到 A 的回复，B 和 C 的回复静默丢失。iLink API 均返回 200 OK。

**根因**：`context_token` 单次消费（iLink 协议约束）+ 3s debounce 阻塞 deliver loop。A 的 `flushReply()` 消费 token 后删除，B/C 的 `sendReply()` 到达时已无 token，静默跳过（`WeixinAdapter.ts:519-524`）。

**代码证据**：`ConnectorInvokeTrigger.ts:475` 逐 turn `await deliver()`，但 `sendReply` 的 Promise 在 `flushReply` 完成后（3s）才 resolve。Turn A flush 后 `contextTokens.delete(chatId)` → Turn B 到达 → `!currentToken && !pendingReplies` → silent return。

**修复**：`ConnectorInvokeTrigger` 检测到 WeChat binding 且 `nonEmptyTurns > 1` 时，合并所有 turn 内容（带猫名前缀）为单次 `deliver()` 调用。非 WeChat 连接器保持原有逐 turn 投递逻辑。richBlocks 渲染为纯文本嵌入合并内容（避免 adapter fallback 重复追加）。混合 connector 绑定（如 weixin+feishu）回退到逐 turn 投递。

**验证**：4 条新增测试覆盖合并路径 + richBlocks 保留 + 混合 connector 回归 + 非 WeChat 回归。42/42 全绿。PR #717 merged（2026-03-25，commit 2be35f8a）。

**BUG-4b/4c 后续修复**（PR #740，2026-03-25，commit 08c663fb）：
- **BUG-4b**：`ConnectorInvokeTrigger` 合并判断 `every()` → `some()`。原逻辑要求所有绑定 connector 都是单 token 才合并，但 weixin+feishu 混合绑定时 `every()` 返回 false，导致不合并。修正为 `some()` — 只要有一个是 weixin 就合并。
- **BUG-4c**：`QueueProcessor` 完全缺失 BUG-4 合并逻辑。当 queued invocations 产出多 turn WeChat 输出时，每个 turn 独立 deliver，第一个消费 token 后后续静默丢失。新增完整合并路径（含 `getConnectorIds` 检测 + `SINGLE_TOKEN_CONNECTORS` + 猫名前缀 + 分隔线）。
- **BUG-4c P1**（云端 review 发现）：QueueProcessor merge 路径丢弃 richBlocks。修复：合并循环中用 `renderAllRichBlocksPlaintext` 将 richBlocks 渲染为纯文本后嵌入合并内容。
- **验证**：83 pass（42 ConnectorInvokeTrigger + 41 QueueProcessor）。Gate 全绿，云端 review 两轮通过。

### BUG-5：context_token "单次消费"是误判 — 实际可重复使用

**状态**: 🟢 Verified — 实验成功 (2026-03-25)

**现象**：BUG-3/BUG-4 系列修复都基于"iLink context_token 单次消费"假设，但 A→B→C 接龙链仍然失败——因为跨 invocation 的 deliver 分批到达，第一批消费 token 后后续批次无 token 可用。

**调查**：
1. 社区协议文档（[epiral/weixin-bot](https://github.com/epiral/weixin-bot)、[hao-ji-xing/openclaw-weixin](https://github.com/hao-ji-xing/openclaw-weixin)）描述"发送含图片的消息时，先发 TEXT 再发 IMAGE，分两次 sendmessage"——如果 token 单次消费，第二次调用怎么成功？
2. 协议 spec 中没有明确说 token 是单次消费的
3. BUG-3 当时分块失败的根因可能是消息格式缺字段（`client_id`/`message_type`/`from_user_id`，后续 PR #711 修复），不是 token 单次消费

**实验设计**：`flushReply()` 发送成功后，不再执行 `lastConsumedToken.set()` 和 `contextTokens.delete()`——保留 token 给后续 sendReply 调用。

**实验结果**（2026-03-25 16:41 实测）：
- Ragdoll回复 → 两条消息分别到达微信 ✅
- 金渐层 + Maine Coon回复 → 也成功到达微信 ✅
- **同一个 context_token 支持多次 sendmessage 调用！**

**修复**：将实验代码正式化——`flushReply()` 不再消费/删除 token。每只猫的回复作为独立微信消息发送。

**影响**：
- BUG-4 系列的 merge 逻辑（ConnectorInvokeTrigger + QueueProcessor 合并多 turn）不再是 WeChat 接龙的必要条件——但保留为可选的用户体验优化（合并消息 vs 多条碎片消息）
- `SINGLE_TOKEN_CONNECTORS` 常量和相关 merge 判断可以后续清理

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 独立 Feature（不合入 F132） | 个人微信 vs 企业微信：协议（iLink HTTP vs WS/callback）、认证（扫码 vs appKey）、能力完全不同 | 2026-07-19 |
| KD-2 | 直接实现 iLink 协议，不引入 `weixin-agent-sdk` | SDK 太薄（仅封装 fetch），我们需要完整控制长轮询生命周期 + ConnectorRouter 集成 | 2026-07-19 |
| KD-3 | 仅实现 `IOutboundAdapter`，不实现 `IStreamableOutboundAdapter` | iLink Bot 不支持消息编辑/流式更新，`message_state: GENERATING` 在 bot 窗口无效。用 typing 状态 + final 发送 | 2026-07-19 |
| KD-4 | adapter-only 扩展，公共层零改动 | F088/F132 已验证，duck typing 能力发现天然支持 | 2026-07-19 |
| KD-5 | Phase A 优先文本双向，媒体和 IM Hub 放后续 Phase | team lead期望快速可用（"两小时后就能用"），文本覆盖 90% 日常场景 | 2026-07-19 |

## Review Gate

- Phase A: 跨 family review（Maine Coon @codex）
- Phase B: 跨 family review（Maine Coon @codex）— AES 加解密需额外审查
- Phase C: 前端走 Design Gate（IM Hub 配置向导 UX → team lead确认）
