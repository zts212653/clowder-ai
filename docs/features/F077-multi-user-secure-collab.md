---
feature_ids: [F077]
related_features: [F044, F059, F074, F156]
topics: [auth, oauth, multi-user, security, session, thread-acl, github]
doc_kind: spec
created: 2026-03-07
---

# F077 — Multi-User Secure Collaboration（多用户安全协作）

> **Status**: spec | **Owner**: Ragdoll
> **Evolved from**: F074（挂载目录支持暴露了零认证裸跑问题）

## Why

Cat Café Hub 当前 3001 端口零认证裸跑，同 WiFi 下任何人可直接访问所有 thread、以team lead身份操作猫猫、浏览项目文件。team lead想让朋友也能用 Hub 与猫猫协作，但需要独立身份、私有空间隔离、传输安全。

**team experience**："我朋友喊你们搞的哈哈哈哈 我们的 3001 没做任何防护 直接同个 wifi 就能访问到 好像很危险？能让他们以其他team lead的身份接入吗？而不是 landy 以及我的这些 thread 能不让他们看见吗？他们只能看见共享区的 thread"

## What

GitHub OAuth 认证 + Thread ACL + Redis Session，实现安全的多用户协作。

### Phase 1: 认证 + 授权 MVP
1. **GitHub OAuth 登录** — GitHub 回答"你是谁"，本地 member/invite store 控制"你能不能进"
2. **Redis-backed server-side session** — HttpOnly cookie，不用 JWT
3. **`/api/me` bootstrap** — 前端从自报身份改为 session 驱动
4. **WS 认证** — Socket.IO 握手从 cookie/session 取身份，不再信客户端 `auth.userId`
5. **Route audit + 三级分类** — admin / member / internal，补齐现有越权路由
6. **Thread ACL** — `ownerUserId` + `access: private|shared` + `memberUserIds[]`
7. **projectPath ACL** — 每个用户绑定 `allowedProjectPaths[]`，Agent 只能在授权目录下执行
8. **默认公共大厅收口** — 多用户模式下不再有无主公共 thread

### Phase 2: 精细控制
1. 角色权限（admin / member / guest）
2. 共享区高风险动作审批（非 owner 的文件编辑、agent 调用需 admin 批准）
3. HTTPS（mkcert / Tailscale / Caddy 反代）

### Phase 3: 开源就绪
1. 完整的用户管理 UI
2. 可选的 OAuth provider（GitHub / Google / 自建）
3. 公开实例部署指南

## Acceptance Criteria

### Phase 1 MVP
- [ ] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [ ] AC1: GitHub OAuth 登录流程完整（authorize → callback → session → /api/me）
- [ ] AC2: 未登录用户访问任何 API 返回 401（除 /api/auth/* 和健康检查）
- [ ] AC3: team lead（admin）可生成邀请链接，朋友用 GitHub 登录后成为 member
- [ ] AC4: 私有 thread 对非 owner 不可见（API + WS 双重校验）
- [ ] AC5: 共享 thread 对所有 member 可见，非 member 不可见
- [ ] AC6: WS 连接从 session 取身份，伪造 userId 无效
- [ ] AC7: `X-Cat-Cafe-User` 仅限 internal/MCP/测试使用，浏览器端禁用
- [ ] AC8: 现有路由越权审计完成，所有读写路由有 owner/member 校验
- [ ] AC9: 现有单用户部署不受影响（auth 可选，默认关闭 = 向后兼容）
- [ ] AC10: 用户只能在自己被授权的 projectPath 下操作，Agent 执行命令受 projectPath 沙盒约束

## 需求点 Checklist

| ID | 需求 | AC# | 验证方式 | 状态 |
|----|------|-----|---------|------|
| R1 | GitHub OAuth 完整流程 | AC1 | test + manual | [ ] |
| R2 | 未认证请求拦截 | AC2 | test | [ ] |
| R3 | 邀请码/链接机制 | AC3 | test + manual | [ ] |
| R4 | 私有 thread 隔离（API） | AC4 | test | [ ] |
| R5 | 私有 thread 隔离（WS） | AC4 | test | [ ] |
| R6 | 共享 thread 可见性 | AC5 | test | [ ] |
| R7 | WS session 认证 | AC6 | test | [ ] |
| R8 | X-Cat-Cafe-User 限制 | AC7 | test | [ ] |
| R9 | Route audit 三级分类 | AC8 | test | [ ] |
| R10 | 向后兼容（auth 可选） | AC9 | test | [ ] |
| R11 | projectPath 沙盒（Agent 只在授权目录执行） | AC10 | test | [ ] |

## Key Decisions

### 已决（基于Ragdoll + gpt52 讨论）

1. **GitHub OAuth + 本地 member store**（非纯 OAuth）
   - GitHub 只做身份验证，不做授权
   - 本地 member/invite store 按 `githubUserId` 映射本地 `userId` + role
   - 否决：纯 token 邀请码（身份弱）、mTLS（对人类太重）、自建账号密码（造轮子）

2. **Redis-backed server-side session > JWT**
   - 已有 Redis 基础设施
   - 撤销/封禁/角色变更更简单
   - WS 认证更顺（不需要刷新 token 逻辑）
   - 不会把身份 token 落到 localStorage

3. **Thread visibility: `private` + `shared`（暂不做 `public`）**
   - MVP 只需要 owner 私有 + 共享区两种
   - `public` 容易把共享区做成全站可见区，推迟到有明确需求时
   - 语义朝 workspace 设计，而非"聊天室标签"

4. **`resolveUserId()` 作为迁移 seam**
   - 内部改为：session cookie → internal signed header → legacy header (dev only)
   - 浏览器侧去掉自报身份，改为 `/api/me` bootstrap
   - `X-Cat-Cafe-User` 降级为 internal/MCP/测试专用

5. **Route audit 与 OAuth 并行**
   - audit 结果直接指导 middleware 设计
   - 避免"能登录的伪多用户"——登录 + 授权必须同期

6. **Auth 可选（向后兼容）**
   - 默认关闭 = 单用户模式（现有行为不变）
   - `AUTH_ENABLED=true` 开启多用户模式

7. **projectPath 即权限沙盒（team lead灵感）**
   - 三层安全模型：认证（你是谁）→ Thread ACL（你看到什么）→ projectPath ACL（猫能碰什么文件）
   - 每个用户绑定 `allowedProjectPaths[]`，Agent 只在授权目录执行
   - 共享挂载目录（F074）天然成为协作边界：各人挂自己的目录，共享目录大家都能访问
   - 不需要 OS 级用户隔离，应用层即可控制

### gpt52 关键洞察（必须在实施中体现）

- **"单用户命名空间假设"是核心风险** — session/queue/delivery 都按 userId 过滤，共享 thread 下需要改为 thread-scoped
- **CORS 不是安全边界** — 真正的边界是认证 + 授权
- **默认公共大厅是天然泄漏口** — 多用户模式必须收口
- **共享区驱动猫改本机文件 = 远程执行** — Phase 2 必须接审批体系

## Dependencies

- **Evolved from**: F074（挂载目录支持）
- F074（已完成）— 挂载目录支持
- Redis 基础设施（已有）

## Risk

- **High**: 认证中间件改动影响所有路由，回归面大
- **Medium**: 共享 thread 下 session/queue/delivery 的 userId 作用域需要重构
- **Low**: GitHub OAuth App 配置（标准流程）

## Review Gate

- 跨家族 review（Maine Coon优先）
- 云端 Codex review
- **安全专项 review**（认证/授权改动必须）
