---
feature_ids: [F178]
related_features: [F061, F174, F077, F086, F098]
topics: [auth, mcp, agent-key, persistent-credential, antigravity, infrastructure]
doc_kind: spec
created: 2026-04-26
---

# F178: Persistent MCP Agent-Key Auth — 跨 invocation 写权限

> **Status**: in-progress | **Owner**: Ragdoll（Ragdoll） | **Reviewer**: Maine Coon（Maine Coon） | **Priority**: P1

## Why

**F061 Bug-H 闭环**：孟加拉猫（Antigravity）作为 **持久 agent**（MCP 进程跨 invocation 存活），目前**不能在 invocation 之外主动写回 thread** —— `post_message` / `create_task` / `update_task` / `get_thread_context` 这些写工具都依赖 per-invocation callback token，token 生命期 ≪ 持久进程生命期。

**team lead 2026-04-26 原话**：
> "Bug-H persistent MCP write-path auth ... 这个 我觉得哦 一定要做 得给 孟加拉一个梦想？哈哈哈 不然他好可怜"
>
> "我们的 F174 是不是 mcp 的 auth 整改？现在整改完成了，你看看现在如果要做这个 可以做吗？"

**为什么现在做**：F174（Callback Auth Lifecycle）2026-04-26 全 Phase done，已经把 **Lifecycle 层** 基建打好（Redis-backed `InvocationRegistry`、结构化错误 reason codes、Route B 降级 framework、401 telemetry + 24h ring buffer、D2b "明厨亮灶" plug indicator）。F174 自己 spec line 377 显式说："F174 不解决 persistent 场景，但降级 framework 可能被复用" —— 现在到时候在 F174 基建上加一层 **agent-key**，让 Bengal 真的能拥有"持久身份 + 持久写权"。

**为什么不靠扩 invocation token**：扩长 invocation token 生命期等于绕过 per-invocation 隔离边界（F174 Phase A 显式锁的安全不变量）。invocation token 必须严格短生命，agent-key 是另一种独立的 credential。

## What

> **Scope 假设——Phase 拆分将在 Design Gate 后细化**。当前 Phase 划分是 strawman，等 OQ-1~OQ-5 拍板后可能合并/拆分。

### Phase A: Design Gate + 数据模型 + 安全模型设计

- 与Maine Coon（Maine Coon）+ team lead三方确认 5 个 Open Questions（OQ-1~OQ-5，见下）
- 产出 agent-key schema 设计：data model, lifecycle states, security boundaries, audit semantics
- 元审美自检（feat-lifecycle Design Gate 必问）：是"坐标变换"（agent-key 是新 first-class 概念，让 persistent vs invocation 两套语义干净分离）还是"多项式堆项"（在 callback token 上叠 long-lived 标志）？

### Phase B: CallbackPrincipal 抽象 + AgentKeyRegistry + 核心 API

- **先引入 `CallbackPrincipal`**（KD-3）：
  - `kind: 'invocation'`（现有语义不变）| `kind: 'agent_key'`（绑定 `catId × userId`，无默认 thread）
  - 升级 `requireCallbackAuth()` → `requireCallbackPrincipal()`
  - `deriveCallbackActor()` 不再假设永远有 `threadId`
  - 新增 `resolvePrincipalThread(principal, requestedThreadId, threadStore)`
- 实现 `AgentKeyRegistry`（接口对齐 F174 `InvocationRegistry` 风格）：
  - 复用 F174 已建的 Redis storage adapter 与 in-memory fallback
  - 数据模型：`agentKeyId`、`catId`、`userId`、`scope: 'user-bound'`、`secretHash`、`issuedAt`、`expiresAt`（45d）、`lastUsedAt`、`revokedAt`、`rotatedFrom?`、`graceUntil?`（≤24h）
- 核心 API：
  - `issueAgentKey(catId, userId, opts)` → `{ agentKeyId, secret }`（secret 一次性返回，server 只存 hash）
  - `verifyAgentKey(secret)` → `{ principal: CallbackPrincipal, reason } | null`
  - `revokeAgentKey(agentKeyId, reason)`
  - `rotateAgentKey(agentKeyId)` → `{ newAgentKeyId, secret }`（旧 key 进入 ≤24h grace）
  - `listAgentKeys({ catId?, userId?, includeRevoked? })`
- 与 F174 `verify()` 走同一个结构化错误 reason 集（新增 `agent_key_*` reason codes）

### Phase C: MCP write tools 接入 agent-key auth path（allowlist MVP）

- **Phase C1 只放 4 个工具**（KD-8 allowlist MVP）：`post_message` / `cross_post_message` / `get_thread_context` / `list_threads`
  - **thread-targeted tools**（`post_message` / `cross_post_message` / `get_thread_context`）必须显式 `threadId`，省略 → 400 报错，不猜"当前 thread"。`list_threads` 是 user-scoped discovery，不需要 `threadId`
  - 当 callback token 缺失/过期时，fallback 到 agent-key auth path（不影响现有 invocation token 主路径）
  - 透传 agent-key 到 `/api/callbacks/*` 端点，server 端 preHandler 通过 `CallbackPrincipal` 双路径分流
- **Phase C2**（后续）：按 auth shape 三分类逐个审增更多工具（`create_rich_block` / `create_task` 等）
- Bengal 持久 MCP secret 注入：capability orchestrator 写 `0600` sidecar secret file（不放 `mcp_config.json`），MCP server 启动时读文件取 secret；共享 Antigravity MCP 运行时用 `CAT_CAFE_AGENT_KEY_FILES` 暴露 per-variant 文件映射，工具调用用 `agentKeyCatId` 选择 `antigravity` / `antig-opus` 对应 key
- 复用 F174 Route B 降级 framework：agent-key 失败时按 reason code 降级提示
- `CAT_CAFE_READONLY=true` 总闸保留不动——F178 只开放 callback writeback allowlist，不解锁 file/shell mutators

### Phase D: Hub UI（agent-key inventory / audit）+ 复用 F174 telemetry

- Hub 设置面板加 "Agent Keys" 页（KD-5：管理面板，不是审批入口）：
  - 列出 per-cat 的 agent-key（catId / userId / issuedAt / expiresAt / lastUsedAt / status）
  - "Rotate key" / "Revoke key" 操作 + 撤销原因
  - 到期前通知（45d TTL，到期前 1 周 D2b badge 提示）
- Redis-backed registry migration hygiene：
  - sidecar reconcile 重启时不得无界签发新 key；上线 Redis backend 前必须实现按 `catId × userId × scope` 的 upsert/replace，或在 issue 前 revoke existing active key
  - 覆盖测试：连续 API restart / reconcile 不产生不可管理的 orphan active keys
- audit log：所有 agent-key 写操作记录到 evidence/observability 通道
- 复用 F174 24h ring buffer + plug indicator：agent-key 失败率挂同一个 indicator（颜色/状态语义扩展）
- 现场可感知性：thread 内 agent-key 写操作标识 "by agent-key (out-of-invocation)"

## Acceptance Criteria

### Phase A（Design Gate）✅ done 2026-04-26
- [x] AC-A1: OQ-1~OQ-5 resolved，OQ-6 显式 deferred（Design discussion §5）
- [x] AC-A3: threat model 含 7 威胁面（discussion §4.3）+ Maine Coon补充 redaction gap / READONLY 总闸 / rotation overlap（§8.6）
- [x] AC-A4: 元审美自检通过 — first-class agent-key = 坐标变换，真正变换点 = CallbackPrincipal 抽象（discussion §2 + §8.2）

### Phase B（CallbackPrincipal + Registry + API）✅ done 2026-04-26
- [x] AC-B1: `CallbackPrincipal` 抽象落地（`kind: 'invocation' | 'agent_key'`），现有 invocation 路径语义不变
- [x] AC-B2: `AgentKeyRegistry` + `IAgentKeyBackend` interface + `MemoryAgentKeyBackend`（Redis persistence = Task 6，non-blocking for Phase C）
- [x] AC-B3: issuance / verification / revocation / rotation / list API + 单元测试覆盖核心路径（secret 一次性返回，server 只存 hash）
- [x] AC-B4: 结构化错误 reason codes 扩展（`agent_key_expired` / `agent_key_revoked` / `agent_key_scope_mismatch` 等），与 F174 reason 集对齐

### Phase C（MCP write tools — allowlist MVP）✅ done 2026-04-26
- [x] AC-C1: Phase C1 **仅** `post_message` / `cross_post_message` / `get_thread_context` / `list_threads` 接入 agent-key fallback path（KD-8 allowlist）
- [x] AC-C2: **thread-targeted tools**（`post_message` / `cross_post_message` / `get_thread_context`）必须显式 `threadId`，省略 → 400 报错。`list_threads` 是 user-scoped discovery，不需要 `threadId`
- [x] AC-C3: server 端 preHandler 通过 `CallbackPrincipal` 双路径分流，失败原因结构化 reason code 透传给 client
- [x] AC-C4: Bengal secret 注入走 `0600` sidecar file（不放 `mcp_config.json`），capability orchestrator reconcile 链路写入；Antigravity Gemini / Claude variant 用独立 sidecar key file，避免共享 persistent MCP runtime 串 cat identity（2026-04-27 Antigravity follow-up；2026-04-28 cloud review P1 修正）
- [x] AC-C5: `CAT_CAFE_READONLY=true` 总闸保留，F178 不解锁 file/shell mutators
- [x] AC-C6: 现有 invocation token 主路径无 regression（F174 测试套件全绿）

### Phase D（UI + 审计 + telemetry）
- [ ] AC-D1: Hub 设置面板 "Agent Keys" 页：inventory / rotate / revoke / audit（管理面板，不是审批入口）
- [ ] AC-D2: audit log 落地（agent-key 每次写操作可追溯）
- [ ] AC-D3: F174 plug indicator 扩展：agent-key 失败率与 callback 401 同 indicator 共显
- [ ] AC-D4: 现场可感知性：agent-key 写入在 thread UI 标识 "by agent-key (out-of-invocation)"
- [ ] AC-D5: Redis backend 上线前完成 key orphaning guard：sidecar reconcile 重启时按 `catId × userId × scope` upsert/replace，或 issue 前 revoke existing active key，并有连续 restart/reconcile 测试

## Dependencies

- **Evolved from**: F061（Antigravity 接入 Bug-H follow-up）
- **Blocked by**: F174（Callback Auth Lifecycle，✅ done 2026-04-26 — 提供 Redis 持久化基建 / 结构化错误 / Route B framework / telemetry）
- **Related**:
  - F077（Multi-User Secure Collaboration）— agent-key 的 user binding 模型可能成为 F077 的 building block
  - F086（System Observability）— audit log + telemetry 走同一个 observability 母线
  - F098（Cross-Cat Persistent State）— Bengal 作为持久 agent 的状态管理
  - F098 / F102（记忆系统）— agent-key 让 Bengal 在 invocation 外能写回记忆

## Risk

| 风险 | 缓解 |
|------|------|
| 长期 credential 泄漏面 → 攻击者拿到 key 可在 45d 内写 thread | 45d TTL + rotation API（≤24h overlap）+ 实时 revocation + audit log（Phase D） |
| agent-key 滥用 → cat 自动写无关 thread / 滥发 | per-cat-per-user scope binding + agent-key 路径必须显式 `threadId` + Phase C1 只放 4 个工具（allowlist） |
| Antigravity 共享 persistent MCP runtime 串 variant 身份 → `antig-opus` 写入被归因到 `antigravity` | sidecar 同时签发 per-variant key file，`CAT_CAFE_AGENT_KEY_FILES` 只持久化文件路径映射，MCP callback tools 通过 `agentKeyCatId` 选正确 secret；一旦共享 variant map 存在，缺少 `agentKeyCatId` 或显式 variant 映射缺失/解析失败都 fail closed，不回退默认身份 |
| 持久进程复用 stale key → 撤销不及时 | revocation list 实时检查（每次 verifyAgentKey 都查），不依赖客户端 cache |
| sidecar reconcile 每次 API restart 都签新 key → Redis backend 上线后积累 orphan active keys | Phase D AC-D5：按 `catId × userId × scope` upsert/replace，或 issue 前 revoke existing active key；连续 restart/reconcile 测试覆盖 |
| Bengal 配置中暴露 secret | 客户端 `0600` sidecar file（不放 mcp_config.json），server 端只存 hash；redaction allowlist 补齐 `_KEY` / `_SECRET` 命名约定 |
| Phase C 改 callback-tools.ts 影响其他猫的 invocation token 主路径 | `CallbackPrincipal` 抽象隔离两种 principal；`CAT_CAFE_READONLY=true` 总闸保留；F174 测试套件作 regression 锚点 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F174 已 done，agent-key 在 F174 基建上加层而非另起独立 auth 体系 | 复用 Redis registry / 结构化错误 / Route B framework / telemetry，避免双套基础设施 | 2026-04-26（立项时） |
| KD-2 | agent-key 是独立 first-class 概念（不是扩长 invocation token） | invocation token 必须短生命（隔离不变量），扩长会绕过 F174 Phase A 安全边界 | 2026-04-26（立项时） |
| KD-3 | Phase B 先引入 `CallbackPrincipal`（`kind: 'invocation' \| 'agent_key'`），不把 agent-key 硬塞 `InvocationRecord` | Maine Coon提出：`request.callbackAuth` 现被当 `InvocationRecord` 用，agent-key 需要另一种 principal；否则 route 里到处 `if (agentKey)` 补丁 = 多项式堆项。Ragdoll-46 采纳 | 2026-04-26（Design Gate） |
| KD-4 | Binding scope = per-cat-per-user，route 级 thread 语义保留 | 持久 agent 价值 = 跨 thread 主动写；per-thread 等于换笼子。但 invocation-scoped route（`request_permission` / `hold_ball` / `guide_*` 等）仍绑 thread | 2026-04-26（Design Gate） |
| KD-5 | 默认全开，不做逐猫审批 | team lead拍板："默认大家都开启"。用户痛点是减少限制。Hub 做 inventory/revoke/audit 管理面板 | 2026-04-26（team lead拍板） |
| KD-6 | 服务端 Redis + hash，客户端 0600 sidecar file | Redis+hash 复用 F174 范式；客户端不放 mcp_config.json（git diff / 截图 / 复制链路泄漏面） | 2026-04-26（Design Gate） |
| KD-7 | 45d TTL + rotation API + ≤24h overlap + 实时 revocation | 90d blast radius 过大；7d grace 无必要（capability orchestrator 自动改配置） | 2026-04-26（Design Gate） |
| KD-8 | Phase C1 走 allowlist MVP（4 工具），thread-targeted tools 必须显式 `threadId`（user-scoped discovery 如 `list_threads` 不需要） | Maine Coon按 auth shape 分三类（invocation-only / user-scoped / richer writeback），deny list 语义不对——很多 route 天生 invocation-scoped 不是"高风险"。thread-targeted 省略 threadId 报错，不猜 | 2026-04-26（Design Gate） |
| KD-9 | F178 scope boundary：不解决跨 provider YOLO/sandbox 总开关 | team lead明确 Hub 权限总控（改 Claude/Codex 系统配置）是另一层 feature，F178 只管 persistent writeback agent-key | 2026-04-26（Design Gate） |
| KD-10 | Antigravity Gemini / Claude variants 共享同一个 persistent MCP runtime，但必须使用 per-variant sidecar agent-key | 云端 review 发现：callback routes 以 verified agent-key record 的 `catId` 作为 sender/viewer；共享一个 `antigravity` key 会让 `antig-opus` 的 native MCP 写回和 play-thread 视角串身份。修正为 sidecar 签发 `antigravity` / `antig-opus` 两个 key file，MCP tools 用 `agentKeyCatId` 选择当前 variant；只要 `CAT_CAFE_AGENT_KEY_FILES` 存在，遗漏 `agentKeyCatId` 或显式 variant 找不到 key 都 fail closed，禁止 fallback 到默认身份。 | 2026-04-28（PR #1446 cloud review P1） |

## Review Gate

- **Phase A（Design Gate）**：必须 @ Maine Coon（Maine Coon）+ team lead参与决策。Maine Coon review F174 时已经踩过这个领域，有上下文；team lead拍板安全/产品边界
- **Phase B / C / D**：标准跨家族 review（@ Maine Coon Maine Coon，避免和作者同家族）
