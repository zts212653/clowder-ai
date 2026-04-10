---
feature_ids: [F088]
doc_kind: reference
created: 2026-03-10
---

# F088 架构归一设计 — Known Issues 解决方案

> 此文件从 `F088-multi-platform-chat-gateway.md` 拆出，保留 ISSUE-1/2 的详细解决方案和架构设计讨论。
> 设计讨论纪要见 *(internal reference removed)*

## ISSUE-1: Connector 消息不走统一管道 — ✅ RESOLVED

### 问题

ConnectorRouter 收到飞书消息后在 ThreadStore 创建 thread，但用 `defaultUserId: 'default-user'`，导致铲屎官在前端看不到 connector thread。同时 binding 纯内存（重启即丢），IM 侧无法管理 thread。

### 解决方案（Phase A + B + C）

**Phase A (PR #344 + #346)** — 前端可见 + Redis 持久化：
- `ConnectorMessageFormatter` — 平台无关 `MessageEnvelope { header, subtitle, body, footer }`
- `FeishuAdapter.sendFormattedReply()` — 渲染为飞书交互卡片
- `DEFAULT_OWNER_USER_ID` — connector threads 用真实 userId 创建，前端自然可见
- `RedisConnectorThreadBindingStore` — Lua 原子 bind + 防御性 getByThread 自愈

**Phase B (PR #349)** — IM 命令集：
- `/new /threads /use /where` 命令 + activeThread + deep link

**Phase C (PR #353)** — 架构归一：
- 命令消息入管道 — `storeCommandExchange()` 把 inbound + outbound 成对写入 messageStore + WebSocket 广播
- 跨平台 `/threads /use` — `threadStore.list(userId)` 全局查询
- `system-command` connector 定义注册

### 三层架构（设计共识）

> 核心结论：**统一的是 Cat Café thread/message core，不是 GitHub transport**。GitHub 也是 connector。

1. **Principal Link**: `connector + externalSenderId → internalUserId`（解决"IM 用户是谁"）
2. **Session Binding**: `connector + externalChatId → activeThreadId` + recent threads（解决"当前指向哪个 thread"）
3. **Command Layer**: 平台无关的 `/new /threads /use /where /link`（解决"IM 侧如何管理 thread"）

否决：不做自动按话题分 thread；不把 IM 事件绕回 GitHub transport

## ISSUE-2: Cloudflare Access 与 Tunnel ingress 路径冲突

**现象**：`cafe.clowder-ai.com` 配了 Cloudflare Access 保护，webhook 请求被 302 到登录页。创建 path-scoped bypass Application 后，请求不再 302 但被路由到了前端（3001）而非 API（3002）。

**临时方案**：飞书 webhook URL 使用 `api.clowder-ai.com`（无 Access 保护的备用子域名），webhook 安全性靠应用层 verification token。

**长期方案**：排查 `cafe.clowder-ai.com` 的 Access bypass + tunnel ingress 共存问题，统一为单域名。
