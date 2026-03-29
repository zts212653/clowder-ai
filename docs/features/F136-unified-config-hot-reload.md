---
feature_ids: [F136]
related_features: [F004, F088, F127, F062]
topics: [config, hot-reload, env, connector, event-bus, dynamic-config]
doc_kind: spec
created: 2026-03-23
---

# F136: Unified Config Hot Reload — 配置热更新统一管线

> **Status**: in-progress | **Owner**: 宪宪 (opus) | **Priority**: P1

## Why

> team experience（2026-03-23，F088 Phase 8 讨论中）：
>
> "connector 这个指的是？ im？ 我记得 F127 有一个烂摊子没收拾，他搞了个他自己的 Hot Reload 但是不用 cat config yaml 而是自己搞了一套。所以按照「脚手架」「喵约」理论我们是不是先梳理一下，我们有哪些配置项？我现在就能知道，我们有 ENV、Local，还有这个 cat config，这些可能都是需要有热更新的，这样子才能干掉 F127 的烂摊子，让它这些热更新都收到一块儿比较好一点。
>
> 然后就像你说的一样，各自模块订阅各自自己的热更新。但是这个我们得从全局考虑，这其实是配置的热更新。但是我们想到底有哪些配置呢？你是需要思考这一点的。"

**核心问题**：Cat Café 目前有多种配置源，各自热更新机制不统一，导致改配置后要重启才能生效，或者各子系统自己搞一套 ad-hoc 的 reload 逻辑（如 F127 的 `runtime-cat-catalog.ts`）。

## What

### 需要梳理的配置源全景

| 配置源 | 文件 / 位置 | 当前热更新能力 | 问题 |
|--------|-------------|----------------|------|
| **`.env` 环境变量** | 项目根 `.env` | `PATCH /api/config/env` 写 `.env` + 写 `process.env`，但子系统不重新初始化 | Connector gateway 启动时读一次，改了 token 不生效；其他读 `process.env` 的变量倒是立即生效 |
| **`cat-config.yaml`** | 项目根 `cat-config.yaml` | 无。F127 绕过它搞了 `runtime-cat-catalog.ts`（517 行），直接操作 `cat-catalog.json` | F127 自建了一套独立于 `cat-config.yaml` 的运行时猫猫目录，是team lead所说的「脚手架」 |
| **ConfigStore (F4)** | 内存 + Redis | `PATCH /api/config` 热更新，即时生效 | 只管运行时可变的配置子集（coCreator、budget 等），不覆盖 env 和猫猫配置 |
| **Provider Profiles (F062)** | `~/.cat-cafe/provider-profiles/` | UI 可编辑，文件写入后需重启生效 | 和猫猫实例绑定关系需要重新加载 |
| **猫猫模板** | `cat-template.json` | 启动时加载一次 | 不影响运行时 |

### 目标架构（方向性，待具体设计）

```
┌── 配置变更源 ──────────────────────────────┐
│  Hub UI / API / CLI / 文件编辑              │
└──────────────┬─────────────────────────────┘
               ▼
┌── 统一配置变更管线 ────────────────────────┐
│  写入持久化（.env / yaml / json）          │
│  ↓                                         │
│  发射 ConfigChangeEvent (event bus)        │
│  { source, keys[], timestamp }             │
└──────────────┬─────────────────────────────┘
               ▼
┌── 订阅者（各子系统自行响应）──────────────┐
│  ConnectorGateway  → restart adapters      │
│  CatCatalog        → reload cat instances  │
│  ProviderProfiles  → rebind accounts       │
│  ConfigStore       → (已有机制)            │
│  ...其他需要的模块                          │
└────────────────────────────────────────────┘
```

**核心原则**：
1. **一个管线** — 所有配置变更走同一个 event bus，不再各搞各的
2. **订阅自治** — 各子系统自己决定如何响应变更（restart / reload / ignore）
3. **收编 F127** — `runtime-cat-catalog.ts` 的热更新能力并入统一管线，干掉独立的 ad-hoc 机制
4. **渐进式** — 可以分 Phase，先做 connector 热重载（F088 直接需求），再扩展到猫猫管理

### team lead待决策

- [ ] F127 的 `runtime-cat-catalog.ts`（517 行）是否需要重写为使用统一管线？还是只是接入 event bus？
- [ ] 热更新的粒度：是文件级（`.env` 变了 → 通知）还是 key 级（`TELEGRAM_BOT_TOKEN` 变了 → 通知）？
- [x] 安全边界：sensitive env vars 能否通过 Hub API 热更新？**决策（2026-03-28）：可以，但有边界 ——**
  - **UX（铲屎官拍板）**：默认值正常显示，当前值脱敏（`***`），提供输入框写新值。不是纯"只写"。
  - **字段设计（codex review）**：复用 `runtimeEditable`，不新增字段。`sensitive + runtimeEditable: true` = 可写脱敏；`sensitive` 默认 fail-closed 不可写。
  - **生效边界（codex P1）**：Phase 1.5 只给"调用时读 `process.env`"的变量开写（如 `OPENAI_API_KEY`）。启动期绑定的（webhook tokens、connector secrets）不开，等 Phase 2 event bus + connector restart。
  - **鉴权（codex P1）**：PATCH 端点写 sensitive 变量需 owner-only check + 审计日志 `ENV_SENSITIVE_WRITE` 事件。

### 已知的具体需求（从 F088 Phase 8 产生）

1. **Connector 热重载**：在 Hub 配置向导里改了 Telegram/飞书/钉钉配置后，不用重启 API 就能生效
   - 需要 ConnectorGateway `restart()` 方法：stop 旧实例 → 重新读 config → start 新实例
   - 需要 outboundHook/streamingHook 引用层（Ref pattern），restart 后所有使用者自动拿到新实例
   - Telegram long polling 的优雅退出 + 重启
   - Feishu webhook handler 的动态替换（Fastify route 不能直接替换，需要间接层）

## Dependencies

- **F004** (done): ConfigStore 热更新 — 运行时可变配置已有基座
- **F088** (done Phase 8): IM Hub 配置向导 UI — 触发了 connector 热更新需求
- **F127** (in-progress): 猫猫管理重构 — 其 `runtime-cat-catalog.ts` 是需要收编的「脚手架」
- **F062** (done): Provider Profile Hub — 账户配置层

## Risk

1. **引用替换的完整性**：outboundHook 在 invokeTrigger、queueProcessor、messages route 等多处被 wire，restart 后必须全部更新
2. **Telegram polling race condition**：旧 polling 要优雅退出，新 polling 才能启动，中间可能丢消息
3. **F127 收编范围**：如果改动 F127 的核心逻辑，可能影响已有的猫猫动态创建功能

## Phase 进度

| Phase | 内容 | 状态 |
|-------|------|------|
| **1** | 配置源全景梳理 + 统一 event bus 设计 | 📋 planned |
| **1.5** | **Sensitive Env Vars 只写热更新** — env-registry 分类 + 前端只写 UI + PATCH 端点支持 | 🚧 in-progress |
| **2** | Connector 热重载（F088 直接需求） | 📋 planned |
| **3** | F127 runtime-cat-catalog 收编 | 📋 planned |
| **4** | Provider Profiles 热重载 | 📋 planned |

## Implementation Plan (2026-03-28 Phase 1.5)

# F136 Phase 1.5 Sensitive Env Writes Implementation Plan

**Feature:** F136 — `docs/features/F136-unified-config-hot-reload.md`
**Goal:** 允许 Hub 在不暴露旧 secret 的前提下，写入少量“调用时读取 `process.env`”的 sensitive env vars，并补齐 owner-only 鉴权与专用审计。
**Acceptance Criteria:**
- `OPENAI_API_KEY`、`F102_API_KEY`、`GITHUB_MCP_PAT` 在 registry 中标记为 `sensitive: true + runtimeEditable: true`，继续以 `***` 脱敏展示。
- `CAT_CAFE_HOOK_TOKEN`、`CAT_CAFE_CALLBACK_TOKEN`、`TELEGRAM_BOT_TOKEN`、`FEISHU_APP_SECRET`、`FEISHU_VERIFICATION_TOKEN`、`DINGTALK_APP_SECRET`、`GITHUB_WEBHOOK_SECRET`、`GITHUB_REVIEW_IMAP_PASS`、`VAPID_PRIVATE_KEY` 继续保持 Hub 只读。
- `PATCH /api/config/env` 对可写 sensitive vars 仅允许 owner 写入；非 owner 返回 403；只读 sensitive vars 仍返回 “not editable”。
- sensitive 写入会追加 `ENV_SENSITIVE_WRITE` 审计事件，且日志与审计 payload 都不记录明文 value。
- Hub “环境变量”页把可写 sensitive vars 渲染为“状态标签 + 当前值脱敏 + 空输入框”，只读 sensitive vars 继续显示只读占位。
- API 测试与 Web 测试都覆盖允许写入、拒绝写入、以及前端渲染/提交行为。
**Architecture:** 不新增 `hotSwappable` / `hubEditMode`。`runtimeEditable` 继续表示“Hub 是否允许写入”，`sensitive` 继续表示“摘要是否脱敏”；二者组合语义为 `sensitive + runtimeEditable: true = 可写但不回显旧值`。Phase 1.5 只改 registry 分类、PATCH 鉴权/审计、Hub UI；connector restart、webhook token 热更、统一 event bus 订阅仍留在 Phase 2。
**Tech Stack:** Fastify, Node.js test runner, React, Vitest
**前端验证:** Yes — reviewer 需实际打开 Hub “环境变量”页，验证 masked-sensitive 可编辑行与只读 sensitive 行。

### Straight-Line Check

**Finish line:** 铲屎官能在 Hub 里编辑 `OPENAI_API_KEY` / `F102_API_KEY` / `GITHUB_MCP_PAT`，前端只显示脱敏状态，后端只允许 owner 写入并留下专用审计。

**Not building in Phase 1.5:**
- Connector / webhook secrets 的运行中重载
- `runtimeEditable` 之外的新元数据字段（如 `hubEditMode` / `activationMode`）
- 尚未进入 env-registry 的 provider keys（例如 `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`）

**Terminal schema:**
- `EnvDefinition` 类型保持不变
- `GET /api/config/env-summary` 响应结构保持不变
- `PATCH /api/config/env` 请求/响应结构保持不变
- 新增专用审计事件类型 `ENV_SENSITIVE_WRITE`

### Task 1: Registry whitelist + helper 语义收口

**Files:**
- Modify: `packages/api/src/config/env-registry.ts`
- Modify: `packages/api/test/env-registry.test.js`

**Step 1: Write the failing test**
- 在 `packages/api/test/env-registry.test.js` 增加断言：
  - `OPENAI_API_KEY`、`F102_API_KEY`、`GITHUB_MCP_PAT` 为 `sensitive === true` 且 `runtimeEditable === true`
  - `FEISHU_APP_SECRET`、`CAT_CAFE_HOOK_TOKEN`、`GITHUB_REVIEW_IMAP_PASS` 仍不可写
  - `isEditableEnvVarName('OPENAI_API_KEY') === true`
  - `isEditableEnvVarName('FEISHU_APP_SECRET') === false`

**Step 2: Run test to verify it fails**

Run:
```bash
cd packages/api
pnpm run build
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/env-registry.test.js
```

Expected: 新增的 sensitive whitelist 断言失败。

**Step 3: Write minimal implementation**
- 在 `packages/api/src/config/env-registry.ts` 给 `OPENAI_API_KEY`、`F102_API_KEY`、`GITHUB_MCP_PAT` 增加 `runtimeEditable: true`
- 将 `isEditableEnvVar()` 改为 fail-closed 语义：
  - `sensitive === true` 时仅 `runtimeEditable === true` 才允许写
  - 非 sensitive 变量仍保持 `runtimeEditable !== false`
- 在 `EnvDefinition.runtimeEditable` 注释旁补一句组合语义说明，防止后续把 sensitive 默认放开

**Step 4: Run test to verify it passes**

Run:
```bash
cd packages/api
pnpm run build
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/env-registry.test.js
```

Expected: registry 语义相关断言全部通过。

**Step 5: Commit**

```bash
git add packages/api/src/config/env-registry.ts packages/api/test/env-registry.test.js
git commit -m "feat: allow selected sensitive env vars in hub"
```

### Task 2: `PATCH /api/config/env` owner-only gate + 专用审计

**Files:**
- Modify: `packages/api/src/routes/config.ts`
- Modify: `packages/api/src/domains/cats/services/orchestration/EventAuditLog.ts`
- Modify: `packages/api/test/env-registry.test.js`

**Step 1: Write the failing test**
- 在 `PATCH /api/config/env (route)` 测试块新增用例：
  - owner 可写 `OPENAI_API_KEY`，`.env` 与 `process.env` 都更新
  - 非 owner 写 `OPENAI_API_KEY` 返回 `403`
  - owner 写 `FEISHU_APP_SECRET` 仍返回 `400` / `not editable`
  - sensitive 更新会写入 `ENV_SENSITIVE_WRITE`，且事件 data 只有 `keys` / `operator` / `target`，不含 value

**Step 2: Run test to verify it fails**

Run:
```bash
cd packages/api
pnpm run build
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/env-registry.test.js
```

Expected: owner-only gate 与新审计事件相关用例失败。

**Step 3: Write minimal implementation**
- 在 `config.ts` 中把更新项分成 sensitive / non-sensitive 两类
- 若存在 sensitive 更新，则校验 `operator === (process.env.DEFAULT_OWNER_USER_ID ?? 'default-user')`
- 非 owner 返回 `403`，错误文案明确为 owner-only
- 追加 `AuditEventTypes.ENV_SENSITIVE_WRITE`
- 保留原有 `CONFIG_UPDATED` 事件，但 sensitive 专用事件不得包含旧值或新值

**Step 4: Run test to verify it passes**

Run:
```bash
cd packages/api
pnpm run build
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/env-registry.test.js
```

Expected: 路由 allow/reject/audit 行为全部通过。

**Step 5: Commit**

```bash
git add packages/api/src/routes/config.ts packages/api/src/domains/cats/services/orchestration/EventAuditLog.ts packages/api/test/env-registry.test.js
git commit -m "feat: guard sensitive env writes behind owner check"
```

### Task 3: Hub UI 改成“脱敏当前值 + 空输入框”

**Files:**
- Modify: `packages/web/src/components/HubEnvFilesTab.tsx`
- Modify: `packages/web/src/components/__tests__/hub-env-files-tab.test.tsx`

**Step 1: Write the failing test**
- 扩展前端 mock summary：
  - `OPENAI_API_KEY` 设为 `sensitive: true, runtimeEditable: true, currentValue: '***'`
  - `FEISHU_APP_SECRET` 设为 `sensitive: true, runtimeEditable: false, currentValue: '***'`
- 断言：
  - `OPENAI_API_KEY` 有输入框，但初始 draft 为空字符串
  - 页面显示 `当前: ***`
  - 页面显示 `🔑 已配置` / `⚠️ 未配置`
  - `FEISHU_APP_SECRET` 没有输入框，仍是只读占位
  - 未输入新 secret 时，PATCH payload 不包含该字段；输入后才包含

**Step 2: Run test to verify it fails**

Run:
```bash
cd packages/web
pnpm exec vitest run src/components/__tests__/hub-env-files-tab.test.tsx
```

Expected: 现有组件不会为 sensitive 变量渲染输入框，新增断言失败。

**Step 3: Write minimal implementation**
- 在 `HubEnvFilesTab.tsx` 拆出：
  - `isWritableVariable()`
  - `isWritableSensitiveVariable()`
  - `buildSensitiveStatusLabel()`
- 让 writable sensitive 行展示：
  - 左侧：`默认:` + `当前:` + 状态标签
  - 右侧：空输入框，placeholder 用“输入新值以替换...”或“输入值以配置...”
- `initialDraftValue()` 对 writable sensitive 始终返回空字符串，避免把 `***` 当作可提交值
- 保持 URL 脱敏连接串的现有空草稿逻辑不变

**Step 4: Run test to verify it passes**

Run:
```bash
cd packages/web
pnpm exec vitest run src/components/__tests__/hub-env-files-tab.test.tsx
```

Expected: Hub UI 渲染与 PATCH payload 行为全部通过。

**Step 5: Commit**

```bash
git add packages/web/src/components/HubEnvFilesTab.tsx packages/web/src/components/__tests__/hub-env-files-tab.test.tsx
git commit -m "feat: render writable sensitive env vars in hub"
```

### Task 4: End-to-end verification + review handoff

**Files:**
- Modify: `docs/features/F136-unified-config-hot-reload.md` (勾选/补充实施证据)

**Step 1: Run focused verification**

Run:
```bash
cd packages/api
pnpm run build
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/env-registry.test.js

cd ../web
pnpm exec vitest run src/components/__tests__/hub-env-files-tab.test.tsx
```

Expected: API 与 Web 聚焦测试都通过。

**Step 2: Run repo-level safety checks**

Run:
```bash
pnpm check:features
pnpm --filter @cat-cafe/api run lint
pnpm --filter @cat-cafe/web run test -- src/components/__tests__/hub-env-files-tab.test.tsx
```

Expected: 文档索引、API 类型检查、前端聚焦测试通过。

**Step 3: Manual validation**
- 以 owner 身份打开 Hub “环境变量”页
- 验证 `OPENAI_API_KEY` / `F102_API_KEY` / `GITHUB_MCP_PAT` 为 masked-sensitive 可编辑
- 验证 `FEISHU_APP_SECRET` / `TELEGRAM_BOT_TOKEN` / `CAT_CAFE_HOOK_TOKEN` 仍为只读
- 提交一次 secret 更新，确认 `.env` 变更、UI success message、审计事件类型都正确

**Step 4: Handoff**
- 请求跨家族 reviewer 重点检查：
  - 是否有任何 sensitive value 被错误写入日志/响应
  - owner-only gate 是否能被伪造 `X-Cat-Cafe-User` 绕过
  - UI 是否会把 `***` 误当真实值再次提交
