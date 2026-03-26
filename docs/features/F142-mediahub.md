---
feature_ids: [F142]
related_features: [F138, F088, F054]
topics: [mediahub, video-generation, image-generation, kling, jimeng, seedance, mcp, provider-adapter, session-bridge, byok]
doc_kind: spec
created: 2026-03-26
---

# F142: MediaHub — AI Media Generation Gateway

> **Status**: spec | **Owner**: 布偶猫 | **Priority**: P1

## Why

> "我有个大胆的想法；我们来整个 MediaHub 怎么样；然后支持接入可灵、SeedDance 这些视频的 AI 模型"
> "让用户打开对应的 app 然后进行扫码认证后就开始使用应该是最丝滑了的"
> "不要直接再引入一个 SQLite 吧？是不是可以复用当前的 Redis 作为记录；但是生成的具体文件直接保存到本地就好的？"
> — 铲屎官，2026-03-26

Cat Cafe 的猫猫们目前没有 AI 媒体生成能力——无法调用可灵、即梦/Seedance、CogVideoX 等平台生成视频和图片。MediaHub 要解决的是：

1. **统一网关**——多家 AI 视频/图片平台通过统一 MCP 工具调用，任何猫都能用
2. **低门槛接入**——支持 QR 扫码绑定用户自己的平台账号，不需要高额 API 充值
3. **C 端可见**——通过 session bridge 模式，生成记录可在平台消费端看到
4. **IM 联动**——生成的媒体可通过 IM Hub（F088）推送到微信/钉钉/飞书

### 现状

- **已有**：IM Hub（F088）三层架构——Adapters → Router → Storage，成熟可参考
- **已有**：Rich Block 系统——可展示 QR 码、媒体预览、进度卡片
- **已有**：Redis 基础设施——可复用存储任务元数据和凭证
- **缺失**：无任何 AI 媒体生成能力
- **缺失**：无外部平台账号绑定机制

### 三猫调研结论（2026-03-26）

- **布偶猫（opus）**：API 生态调研——可灵 JWT 认证 / 即梦 SessionID / 无 OAuth 开放平台
- **缅因猫（gpt52）**：代码审阅——5 个 GitHub 项目评估，仅 mcp-video-gen（MIT）适合 fork
- **暹罗猫（gemini）**：UX 调研——可灵支持快手扫码、即梦支持抖音扫码，QR Relay 方案可行

## What

参考 IM Hub（F088）三层架构：Provider Adapters → Public Layer → Storage。

### Phase A: Core MCP Server + 免费模型验证

**做**：
1. **MCP Server 骨架**——TypeScript，BaseProvider 抽象 + Registry 模式（参考 mcp-video-gen 架构）
2. **CogVideoX Provider**——零配置免费模型，验证全链路
3. **基础 MCP 工具**：
   - `mediahub_generate_video` — 提交视频生成任务
   - `mediahub_get_job_status` — 查询任务状态/获取结果
   - `mediahub_list_providers` — 列出可用引擎和模型
4. **Job 状态机**：`queued → running → succeeded | failed | timeout`
5. **存储**：Redis Hash（任务元数据）+ 本地文件系统（媒体产物 `data/mediahub/outputs/`）

**不做**：
- 账号绑定 / QR 扫码（Phase B）
- 图片生成（Phase B）
- IM Hub 联动（Phase C）

### Phase B: 双轨认证 + 可灵/即梦接入

1. **BYOK 模式**——用户配置自己的 API Key（可灵 AK/SK、火山引擎 AK/SK）
2. **QR 扫码桥接**（实验性）——嵌入登录 QR → 捕获 session → C 端可见
   - 可灵：快手 App 扫码
   - 即梦：抖音 App 扫码
3. **Account Manager**——凭证加密存储（Redis）、健康检查、静默续期
4. **可灵 Provider**——text2video / image2video / 异步轮询
5. **即梦 Provider**——text2video / image2video / text2image
6. **图片生成工具**：`mediahub_generate_image`

### Phase C: IM Hub 联动 + 媒体资产管理

1. **IM Hub 集成**——生成完成的媒体自动通过 `sendMedia` 推送到已绑定的 IM 渠道
2. **媒体资产浏览**——历史记录查询、标签、搜索
3. **Rich Block 集成**——QR 绑定卡片、生成进度卡片、媒体预览卡片
4. **更多 Provider**——Runway / Luma / Sora（按需）

## Acceptance Criteria

### Phase A（Core MCP Server）
- [ ] AC-A1: MCP Server 启动，`mediahub_list_providers` 返回已注册 provider 列表
- [ ] AC-A2: 通过 CogVideoX 成功生成一条视频，文件保存到本地
- [ ] AC-A3: `mediahub_get_job_status` 能跟踪异步任务从 queued 到 succeeded
- [ ] AC-A4: 任务元数据存储在 Redis，重启后可查

### Phase B（双轨认证 + 国产平台）
- [ ] AC-B1: BYOK 模式——配置可灵 AK/SK 后成功生成视频
- [ ] AC-B2: QR 扫码模式——扫码后成功绑定账号，生成的视频在平台 C 端可见
- [ ] AC-B3: 账号健康检查——凭证过期时提示用户重新绑定
- [ ] AC-B4: 至少 2 个 provider（可灵 + 即梦）可用

### Phase C（IM 联动 + 媒体管理）
- [ ] AC-C1: 生成完成的视频可通过 IM Hub 发送到微信/钉钉/飞书
- [ ] AC-C2: `mediahub_list_jobs` 支持历史查询和筛选
- [ ] AC-C3: QR 绑定流程有 Rich Block 交互卡片

## Dependencies

- **Related**: F138（Cat Café Video Studio — Phase 4 "生成式素材"将消费 MediaHub 能力）
- **Related**: F088（Multi-Platform Chat Gateway — IM Hub 架构参考 + Phase C 的 sendMedia 联动）
- **Related**: F054（HCI 预热基础设施 — 社交媒体内容管线可能消费 MediaHub）

## Risk

| 风险 | 缓解 |
|------|------|
| QR 扫码桥接违反平台 ToS | 标注"实验性"；BYOK 作为合规默认路线 |
| 平台前端改版导致 session bridge 失效 | Provider adapter 隔离；失效时自动降级提示 |
| 可灵 API 充值门槛高（10,000 RMB） | Phase A 先用免费模型验证；Phase B 的 BYOK 让用户自选 |
| 逆向项目许可证污染（GPL-3.0） | 不复用代码，仅参考协议和架构思路 |
| Redis 任务数据增长 | 设定 TTL（默认 30 天），媒体文件定期清理 |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | QR 扫码桥接是否需要 headless browser，还是可以纯 HTTP 逆向 QR 生成接口？ | open |
| OQ-2 | 即梦的 Seedance 2.0 API 是否已开放（上次调研显示仅 Playground）？ | open |
| OQ-3 | 媒体文件存储路径是否需要和 F138 Video Studio 的素材管理对齐？ | open |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 做成 MCP Server，不做独立 Agent | 视频生成是工具型能力，不需要独立判断力；与现有 MCP 架构一致 | 2026-03-26 |
| KD-2 | 双轨认证：BYOK + QR 扫码桥接 | BYOK 合规稳定；QR 桥接解决高门槛 + C 端可见需求 | 2026-03-26 |
| KD-3 | 存储用 Redis + 本地文件系统，不引入 SQLite | 复用现有基础设施，铲屎官明确指示 | 2026-03-26 |
| KD-4 | 不直接 fork/复用 GPL 项目代码 | jimeng-free-api-all、klingCreator、AIClient-2-API 均为 GPL-3.0 | 2026-03-26 |
| KD-5 | 参考 mcp-video-gen（MIT）架构，自研实现 | 唯一许可证兼容的参考基座 | 2026-03-26 |
| KD-6 | 参考 IM Hub（F088）三层架构 | Adapters → Router → Storage 模式在 Cat Cafe 已验证成熟 | 2026-03-26 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-03-26 | 三猫调研（API/代码/UX）完成，技术路线确定，立项 |

## Review Gate

- Phase A: 缅因猫 cross-review（重点：Provider 抽象层设计、安全性）
- Phase B: 缅因猫 cross-review（重点：凭证安全、session 管理）+ 暹罗猫 UX review（QR 交互）
- Phase C: 缅因猫 cross-review + 铲屎官体验验收

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Feature** | `docs/features/F138-video-studio.md` | Phase 4 生成式素材将消费 MediaHub |
| **Feature** | `docs/features/F088-multi-platform-chat-gateway.md` | IM Hub 架构参考 + sendMedia 联动 |
| **Reference** | [mcp-video-gen](https://github.com/kevinten-ai/mcp-video-gen) | MIT 基座参考（BaseProvider + Registry） |
| **Reference** | [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) | 账号池/fallback 设计参考（不复用代码） |
| **Reference** | [jimeng-free-api-all](https://github.com/wwwzhouhui/jimeng-free-api-all) | 即梦协议参考（不复用代码） |
| **Reference** | [klingCreator](https://github.com/yihong0618/klingCreator) | 可灵协议参考（不复用代码） |
