---
feature_ids: [F156]
related_features: [F077]
topics: [security, websocket, cswsh, origin-validation, auth]
doc_kind: spec
created: 2026-04-10
---

# F156: Security Hardening — 实时通道 + 本机信任边界加固

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P0

## Why

2026-04-10 安全审计发现：Cat Cafe Hub 的 Socket.IO 实时通道存在 Cross-Site WebSocket Hijacking (CSWSH) 风险。Maine Coon(GPT-5.4) 实测验证：从 `Origin: https://evil.example` 发起 WebSocket-only 连接到 `127.0.0.1:3004`，**连接成功**。

根因：Socket.IO v4 的 `cors` 配置仅对 HTTP long-polling 生效，**不校验 WebSocket upgrade 请求的 Origin 头**（Socket.IO 官方文档 2026-02-16 明确标注）。加上身份自报（`handshake.auth.userId`）、Room 无 ACL，攻击者可以：
- 从任何恶意网页发现并连接本机 WebSocket
- 冒充任意 userId
- 加入任意 thread/user/global room 监听所有消息
- 发送 `cancel_invocation` 干扰猫猫工作

**外部参考**：OpenClaw 2026 年初连续爆出两个同类漏洞（CVE-2026-25253 + ClawJacked），攻击链高度相似。

**team experience**："我们的 websockets 是不是有被钓鱼的风险？""先修自己家的，然后自己家验证没问题再帮他们 officeclaw 修复一下"

## What

聚焦 WebSocket 实时通道的安全加固，不涉及 F077 的多用户认证体系。修完后作为 F077 的前置基础设施。

### Phase A: 连接层加固（堵 CSWSH） ✅

1. **`allowRequest` Origin 校验** — 在 Socket.IO Server 构造时加 `allowRequest` hook，显式校验 WebSocket upgrade 请求的 `Origin` 头。不在白名单内的 Origin 直接拒绝连接
2. **禁止自报 userId** — 服务端不再从 `handshake.auth.userId` / `query.userId` 取身份。单用户模式下连接一律赋予 `default-user`，为 F077 session 认证预留接口
3. **私网 Origin 收紧** — `PRIVATE_NETWORK_ORIGIN` 正则从默认放行改为需要 `.env` 显式 `CORS_ALLOW_PRIVATE_NETWORK=true` 才启用

### Phase B: 授权层加固（堵监听/干扰） ✅

> Maine Coon(GPT-5.4) review 后重新排序：plain WS 端点比 Socket.IO room 收口更紧急（read-write PTY > 被动泄漏）

**B-1: Plain WebSocket Origin + 身份校验**
1. **terminal WS Origin gate** — `@fastify/websocket` 的 `/api/terminal/sessions/:id/ws` 和 `/api/terminal/agent-panes/:id/ws` 补 Origin 校验（复用 `isOriginAllowed`）。这两个端点完全绕过 Socket.IO `allowRequest`，恶意网页可直连 read-write PTY
2. **terminal 身份硬化** — `resolveUserId(req)` 允许 query param 自报身份，需收紧为 header-only 或服务端决定

**B-2: Socket.IO 敏感事件授权**
1. **cancelAll 授权** — `cancel_invocation` 的 `cancelAll()` 分支补 `userId` 校验，不能只看 room membership

**B-3: 全局 room 收口**
1. **Room ACL 扩展** — `workspace:global` 和 `preview:global` 在多用户模式下需认证后才能加入（带文件路径、worktreeId、preview 端口等元数据）

### Phase D: Local Trust Boundary Hardening（三猫安全审计产出）

**D-1: HTTP 身份从"自报"升级为服务端 session** (P0)
1. 浏览器侧停用 `userId query param` 作为身份源
2. 引入同源 `HttpOnly session cookie`，首次打开 Hub 自动配对
3. 逐步淘汰 `resolveUserId()` 的 query/default 回退路径，写操作统一走 session
4. 用户零配置：CLI `cat-cafe start` 自动打开浏览器并完成 session 配对

**D-2: 防 Clickjacking** (P0)
1. API 层加 `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`（@fastify/helmet 或手动 header）
2. preview-gateway 保留例外（它需要 iframe 嵌入）
3. 零用户摩擦，纯后端 header

**D-3: 前端 XSS 基线加固** (P1) ✅
1. 严格 CSP（禁 unsafe-inline JS）
2. HtmlWidgetBlock 加 DOMPurify sanitization（sandbox 隔离正确但应加防数据外泄）
3. 富文本/外部 HTML 渲染放入 sandboxed iframe（已部分实现，需审计完整性）

**D-4: Prompt Injection 降权** (P1) — 需设计讨论，暂不实现
1. 外部内容（网页、文章、外部 repo）标记为"非可信来源"
2. 由非可信来源触发的高危操作（命令执行、文件修改、外发消息）需额外确认
3. 确认 UX：人性化提示（"这条操作来自外部内容"），不堆术语
4. 研究模式 vs 执行模式分离

> **设计挑战（2026-04-10 讨论）**：Cat Cafe 的猫猫通过 MCP 接入，我们不控制推理过程。
> Prompt injection 可能在猫猫思考链内部就被执行，绕过所有工具层门禁。
> 可行路径：MCP server 端做来源追踪（session flag）+ 高危工具分级 + AuthorizationManager 拦截。
> 但"来源追踪"是新机制，需要单独设计；业界也无银弹。
> **决定**：D-3/D-5/D-6 先推，D-4 待设计方案成熟后再实施。

**D-5: preview-gateway Origin 校验** (P2) ✅
1. WS upgrade 路径补 Origin 校验（复用 isOriginAllowed）
2. 现有 loopback+port 限制保留

**D-6: DNS Rebinding 防御** (P2) ✅
1. 校验 HTTP `Host` header，allowlist 从 CORS origins + API base URL 动态派生
2. 自定义 FRONTEND_URL 和 split-host 部署自动覆盖

### ~~Phase C: OfficeClaw 修复~~ → 已拆出

> **2026-04-10 team lead决定**：OfficeClaw 安全加固是"外出务工"，不属于我们家的 feat，拆为独立 feature/任务。
> 参考 F156 Phase A/B/D 的修复模式适配 OfficeClaw 协议差异。

## Acceptance Criteria

### Phase A（连接层加固）
- [x] AC-A1: `Origin: https://evil.example` 的 **WebSocket-only**（`transports: ['websocket']`）连接被服务端拒绝（集成测试 + 实测验证）。验收标准是"恶意网页不能建立 WS 连接"，不是"CORS 配对了"
- [x] AC-A2: 合法前端 Origin（localhost:3003、配置的 FRONTEND_URL）连接正常
- [x] AC-A3: 服务端不再从客户端 handshake 取 userId，所有 socket 身份由服务端决定
- [x] AC-A4: 私网 Origin 默认不放行，需显式 `CORS_ALLOW_PRIVATE_NETWORK=true`
- [x] AC-A5: 现有前端功能不受影响（消息收发、取消、room 订阅正常）
- [x] AC-A6: 有 `socket.io-client` + `transports: ['websocket']` + 恶意 Origin 被拒的集成测试（钉住核心修复）

### Phase B-1（Plain WS 安全加固）
- [x] AC-B1a: `/api/terminal/sessions/:id/ws` 和 `/api/terminal/agent-panes/:id/ws` 的 WebSocket upgrade 校验 Origin header，恶意 Origin 被拒
- [x] AC-B1b: terminal WS 身份不再从 query param 自报，收紧为 header-only 或服务端决定
- [x] AC-B1c: Socket.IO `user:` room ACL（Phase A 已实现）

### Phase B-2（Socket.IO 敏感事件授权）
- [x] AC-B2: `cancel_invocation` 的 `cancelAll` 分支在 socket 层做 thread ownership guard 后再调用

### Phase B-3（全局 room 收口）
- [x] AC-B3: `workspace:global` 和 `preview:global` 在多用户模式下需认证后才能加入（带文件路径、worktreeId、preview 端口等元数据）

### Phase D-1（HTTP 身份加固） ✅
- [x] AC-D1a: 浏览器请求通过 HttpOnly session cookie 认证，不再接受 userId query param
- [x] AC-D1b: 首次打开 Hub 自动完成 session 配对（零配置）
- [x] AC-D1c: 写操作统一走 session 校验

### Phase D-2（防 Clickjacking） ✅
- [x] AC-D2a: API 响应包含 X-Frame-Options: DENY
- [x] AC-D2b: API 响应包含 CSP frame-ancestors 'none'
- [x] AC-D2c: preview-gateway 保留 iframe 例外

### Phase D-3（前端 XSS 基线） ✅
- [x] AC-D3a: HtmlWidgetBlock 加 DOMPurify sanitization
- [x] AC-D3b: CSP 加固（script-src 'self' 'unsafe-inline' + object-src 'none'；nonce-based 为 future work）

### Phase D-4（Prompt Injection 降权）
- [ ] AC-D4a: 外部内容来源标记机制
- [ ] AC-D4b: 高危操作由非可信来源触发时需用户确认

### Phase D-5（preview-gateway Origin） ✅
- [x] AC-D5: preview-gateway WS upgrade + HTTP 校验 Origin header

### Phase D-6（DNS Rebinding） ✅
- [x] AC-D6: HTTP 请求校验 Host header，allowlist 从 CORS origins + API base URL 动态派生

### ~~Phase C（OfficeClaw）~~ → 已拆出为独立任务

## Dependencies

- **Related**: F077（多用户安全协作 — F156 是 F077 Phase 1 的前置基础设施，AC6/AC7 有重叠）
- **Related**: OpenClaw CVE-2026-25253、ClawJacked（外部同类漏洞参考）

## Risk

| 风险 | 缓解 |
|------|------|
| Origin 校验过严导致合法场景被拦 | 保留 `.env` 配置口子（CORS_ALLOW_PRIVATE_NETWORK）；回归测试覆盖现有连接场景 |
| 禁止自报 userId 影响现有前端逻辑 | 单用户模式下服务端统一赋 `default-user`，前端不需要改 userId 传递逻辑（只是服务端忽略） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 独立 hotfix，不并入 F077 | P0 漏洞不能等大 feature；hotfix 是 F077 的前置基础设施，不浪费 | 2026-04-10 |
| KD-2 | 用 `allowRequest` 而非依赖 `cors` 配置 | Socket.IO 的 cors 不管 WebSocket upgrade（官方文档明确）| 2026-04-10 |
| KD-3 | 先修自家 Hub，验证后再修 OfficeClaw | team lead拍板 | 2026-04-10 |
| KD-4 | Phase C（OfficeClaw）从 F156 拆出 | team lead："和我们家无关是外出务工的事情"，不污染自家 feat 真相源 | 2026-04-10 |
