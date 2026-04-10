---
feature_ids: [F088]
doc_kind: reference
created: 2026-03-09
---

# F088 各 Phase 详细 AC

> 此文件从 `F088-multi-platform-chat-gateway.md` 拆出，保留每个 Phase 的完整 AC 列表。
> 主文件只保留 Phase 状态摘要。

## Phase 1 (MVP) — 飞书 + Telegram DM-only ✅ PR #328

- [x] AC-1: 飞书 DM 发消息 → Cat Café 收到 → 触发猫猫回复 → 回复发回飞书 (integration test)
- [x] AC-2: Telegram DM 发消息 → Cat Café 收到 → 触发猫猫回复 → 回复发回 Telegram (integration test)
- [x] AC-3: 外部 DM 自动映射到 Cat Café thread（ConnectorThreadBinding）(7 + 6 unit tests)
- [x] AC-4: 飞书 webhook verification token 校验（fail-closed）/ Bot API auth（Telegram）(adapter tests)
- [ ] AC-5: 现有 Web UI 功能不受影响 (regression pending)
- [x] AC-6: 入站消息幂等——同一外部消息重放不触发重复 invoke（integration test）
- [x] AC-7: Outbound = final-only——agent 回复完成后一次性发送到外部平台 (wired in trigger)

## Phase 2 — 多猫身份 + 分角色展示 ✅ PR #336

- [x] AC-8: 外部消息 `@布偶` / `@缅因` → 路由到指定猫（parseMentions + ConnectorRouter, 11+9 unit tests）
- [x] AC-9: 外部回帖标明是哪只猫在说话（方案 A: 消息前缀 `[Ragdoll🐱]`，8 unit tests）
- [x] AC-10: 多猫接力时，外部看到分角色对话（ConnectorInvokeTrigger 传透 catId → OutboundDeliveryHook 前缀，3 integration tests）

## Phase 3 — 富文本卡片 ✅

- [x] AC-11: Cat Café rich block → 飞书消息卡片 JSON — feishu-card-formatter + FeishuAdapter.sendRichMessage, 8 tests
- [x] AC-12: Cat Café rich block → Telegram formatted message（HTML parse_mode）— telegram-html-formatter + TelegramAdapter.sendRichMessage, 9 tests
- [x] AC-13: OutboundDeliveryHook 自动检测 rich block 类型，选择纯文本降级 or 卡片格式, 12 tests
- [ ] AC-14: 飞书卡片支持按钮交互回调（card action callback → ConnectorRouter）— deferred to Phase 3b

## Phase A — ISSUE-1 修复 ✅ PR #344 + #346

- [x] AC-A1: ConnectorMessageFormatter 生成平台无关 MessageEnvelope, 6 tests
- [x] AC-A2: FeishuAdapter.sendFormattedReply 渲染为飞书交互卡片, 3 tests
- [x] AC-A3: DEFAULT_OWNER_USER_ID → connector threads 前端可见, 2 tests
- [x] AC-A4: OutboundDeliveryHook threadMeta — best-effort 2s timeout + late rejection guard, 3 tests
- [x] AC-A5: RedisConnectorThreadBindingStore — Lua 原子 bind + 防御性自愈, 11 tests
- [x] AC-A6: IConnectorThreadBindingStore async-compatible interface

## Phase B — IM 命令层 ✅ PR #349

- [x] AC-B1: ConnectorCommandLayer 解析 `/new /threads /use /where` 命令, 12 unit tests
- [x] AC-B2: `/new` 创建新 thread 并切换 activeThread binding
- [x] AC-B3: `/threads` 列出最近 N 个 thread (Memory + Redis)
- [x] AC-B4: `/use <id>` 切换 activeThread — prefix match + rebind
- [x] AC-B5: `/where` 显示当前绑定 thread + deep link
- [x] AC-B6: ConnectorRouter 集成 CommandLayer, 4 router tests
- [x] AC-B7: 出站回复带 deep link
- [x] AC-B8: 命令响应包含中文 UX + deep link + thread 短 ID

## Phase 4 — 消息编辑模拟流式 ✅ PR #350

- [x] AC-15: agent 开始处理时发送"思考中..."占位消息, 2 tests
- [x] AC-16: streaming 过程中定期 patch/edit 占位消息, 3 tests
- [x] AC-17: agent 完成后最终更新为完整回复, 2 tests
- [x] AC-18: 编辑频率限流（2s interval + 200 char delta）, 1 test

## Phase C — 架构归一 ✅ PR #353

- [x] AC-C1: `CommandResult` 新增 `contextThreadId` — 4 个命令均返回关联 thread ID
- [x] AC-C2: `storeCommandExchange()` — inbound + outbound 成对写入 messageStore + WebSocket 广播, 3 tests
- [x] AC-C3: 无 contextThreadId 时优雅降级, 1 test
- [x] AC-C4: `/threads` 跨平台 — threadStore.list(userId) 全局查询, 1 test
- [x] AC-C5: `/use` 跨平台 — threadStore.list(userId) prefix match, 1 test
- [x] AC-C6: `/threads` 有 binding 时返回 contextThreadId (R1 P1 fix), 2 tests
- [x] AC-C7: `system-command` connector 定义注册
- [x] AC-C8: Bootstrap deps 补齐 threadStore.list() 签名

## Phase 5-9 — 未来 Phases

### Phase 5 — 图片/文件收发
- [x] AC-19: 接收用户图片 → 下载 → 存储 → 传递给猫（contentBlocks + absPath）
- [x] AC-20: 接收用户文件 → 下载 → 本地缓存 + 文本描述传递给猫
  - ⚠️ 文件内容提取（PDF/文档解析）→ 结构化输入传递给猫：future phase
- [x] AC-21: 猫的图片回复 → Telegram 原生 InputFile / Feishu 原生 /im/v1/images 上传
- [x] AC-F1: Feishu 原生图片上传（FeishuTokenManager + /im/v1/images multipart）
- [x] AC-C1: ConnectorMediaService 定期清理超龄文件（MediaCleanupJob, 24h TTL）

### Phase 6 — 语音消息
- [x] AC-22: 接收语音 → STT → 文本消息（WhisperSttProvider）
- [x] AC-23: 文字回复 → TTS → Telegram 原生 InputFile / Feishu 原生 /im/v1/files 上传
- [x] AC-F2: Feishu 原生音频上传（FeishuTokenManager + /im/v1/files multipart）
- [x] AC-24: STT/TTS provider 可配置（ISttProvider + SttRegistry）

### Phase 7 — 群聊 + 多人
- [ ] AC-25: 群聊 @猫猫 → @mention 触发（依赖 F077）
- [ ] AC-26: 多用户权限隔离

### Phase 8 — 更多平台 + 自助接入
- [ ] AC-27: Slack adapter
- [ ] AC-28: 支持 3+ 平台
- [ ] AC-29: UI 配置连接器
- [ ] AC-30: OAuth 自助接入

### Phase 9 — 产品化
- [ ] AC-31: 多账号 / 多 workspace
- [ ] AC-32: 运维监控 + 审计日志
