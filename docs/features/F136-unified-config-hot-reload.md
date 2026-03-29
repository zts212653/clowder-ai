---
feature_ids: [F136]
related_features: [F004, F088, F127, F062]
topics: [config, hot-reload, env, connector, event-bus, dynamic-config]
doc_kind: spec
created: 2026-03-23
---

# F136: Unified Config Hot Reload — 配置热更新统一管线

> **Status**: done | **Owner**: @opus | **Priority**: P1 | **Completed**: 2026-03-28

## Vision

**Hub 的配置面板从「只读展示」变成「可读可写可即时生效」。** 无论是 IM connector 配置、猫猫配置、Provider Profiles 还是环境变量——用户在 Hub 里改完，不用重启，立刻生效。热更新管线是实现这个愿景的基座，不是目的本身。

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
| **Provider Profiles (F062)** | `~/.cat-cafe/provider-profiles.json` + `.secrets.local.json` | UI 可编辑，文件写入后需重启生效 | **双真相源**：元信息与 cat-config 的 provider/model 重叠，`provider-binding-compat.ts` 在补缝。Phase 4 将消除 |
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
│  { source, changedKeys[], changeSetId,     │
│    scope: file|domain|key, timestamp }     │
└──────────────┬─────────────────────────────┘
               ▼
┌── 订阅者（各子系统自行响应）──────────────┐
│  ConnectorGateway  → restart adapters      │
│  CatCatalog        → reload cat instances  │
│  AccountBinding    → rebind credentials    │
│  ConfigStore       → (已有机制)            │
│  ...其他需要的模块                          │
└────────────────────────────────────────────┘

Phase 4 终态（2026-03-28 决策）:
┌── 唯一配置真相源 ──────────────────────────┐
│  cat-config.yaml（不进 git）               │
│    cats:    猫意图（provider/model/ref）    │
│    accounts: 账户能力（protocol/baseUrl）   │
│  cat-config.yaml.example（进 git）         │
└────────────────────────────────────────────┘
┌── 纯钥匙串（零元信息）────────────────────┐
│  ~/.cat-cafe/credentials.json              │
│    accountRef → apiKey（纯 key-value）     │
└────────────────────────────────────────────┘
```

**核心原则**：
1. **一个管线** — 所有配置变更走同一个 event bus，不再各搞各的
2. **订阅自治** — 各子系统自己决定如何响应变更（restart / reload / ignore）
3. **收编 F127** — `runtime-cat-catalog.ts` 的热更新能力并入统一管线，干掉独立的 ad-hoc 机制
4. **渐进式** — 可以分 Phase，先做 connector 热重载（F088 直接需求），再扩展到猫猫管理

### 决策记录（2026-03-27，team lead + @opus + @codex 讨论收敛）

- [x] **F127 收编方式：重写，渐进迁移（3A→3B→3C）**
  - 3A: 把 `/api/cats` 路由里的 side effect（registry reconcile）迁到统一 event bus subscriber — 终态 subscriber
  - 3B: `runtime-cat-catalog` 收敛成纯存储+校验，删掉 ad-hoc 触发路径 — 终态存储层
  - 3C: 删除 3A/3B 使旧代码变成的死代码
  - 每步产物都是终态基座，不是脚手架（team lead确认）
  - 证据：`runtime-cat-catalog.ts` 实际 527 行，路由里直接耦合 reconcile（`cats.ts:297`、`index.ts:635`）

- [x] **热更新粒度：key 级为主 + file/domain 级降级**
  - Event schema: `{ changedKeys[], changeSetId, scope: 'file' | 'domain' | 'key', timestamp }`
  - 多键原子语义：飞书等组合配置用 `changeSetId` 批量，避免单 key 变更频繁 restart
  - Debounce/coalesce：防抖动，避免连续改多 key 触发 restart 风暴
  - 降级：手动编辑 `.env` 时 watcher 无法产出 key diff → 降级到 file 级通知
  - 证据：现有 `/api/config/env` 已有 `updates[]`，天然可产出 changedKeys

- [x] **安全边界：新增专用 secrets 通道，不放开现有 endpoint**
  - 保留 `/api/config/env` 只写非敏感变量（现有安全模型不变）
  - 新增 `POST /api/config/secrets`（allowlist），只允许 connector 需要的 token（如 `TELEGRAM_BOT_TOKEN`、`FEISHU_APP_ID` 等）
  - Guard：loopback/same-origin 校验 + 审计日志只记 key 不记 value
  - 成功后发同一个 ConfigChangeEvent，走统一热更新管线
  - 前端：token 输入后 mask 显示，不回显完整值
  - 证据：现有 `env-registry.ts:857` 的 `isEditableEnvVarName` 明确拒绝 sensitive vars，`env-registry.test.js:360` 有测试锁定

### 决策记录（2026-03-28，team lead + @opus + @codex 讨论收敛 — Phase 4 真相源统一）

- [x] **推翻 A* 方案（"按领域切两个真相源"）——终态必须是单一真相源**
  - team experience："那你这他妈有问题啊 127的尾巴还是解决不掉啊 现在这两个加载的代码就开始打架了"
  - `provider-binding-compat.ts` 的校验是双真相源的症状，不是合理设计
  - A* 方案本质上在合理化两个真相源，偏离 F136 愿景

- [x] **终态：`cat-config` = 唯一配置真相源，`credentials.json` = 纯钥匙串**
  ```yaml
  # cat-config.yaml（唯一真相源，.example 进 git，实际文件不进 git）
  cats:
    opus:
      provider: anthropic
      defaultModel: claude-opus-4-6
      accountRef: claude        # → 引用 accounts 区
  accounts:
    claude:
      authType: oauth
      protocol: anthropic       # 兼容 Anthropic API 的任意服务
      models: [claude-opus-4-6, claude-sonnet-4-6]
    my-glm:
      authType: api_key
      protocol: openai          # 兼容 OpenAI API 的任意服务
      baseUrl: https://open.bigmodel.cn/api/paas/v4
  ```
  ```json
  // ~/.cat-cafe/credentials.json（纯钥匙串，不进 git）
  { "claude": "<your-anthropic-key>", "my-glm": "<your-glm-key>" }
  ```
  - `provider-profiles.json` 元信息文件退场（元信息搬入 `cat-config.accounts`）
  - `provider-profiles.secrets.local.json` 简化为 `credentials.json`（纯 key-value）
  - `provider-binding-compat.ts` 可删（不再有两边需要校验一致性）
  - `.env` 的 `*_API_KEY` deprecated（只读 legacy fallback），不再作为主写入口

- [x] **`accounts` 区（@codex 提议，team lead确认）**
  - 多猫共用同一账户只引用 `accountRef`，不重复配置 protocol/baseUrl
  - `protocol` 字段决定 API 兼容性：任意支持 Anthropic 协议的 API 都能给Ragdoll用，任意支持 OpenAI 协议的都能给Maine Coon用
  - team lead确认："可以，只要你能解决比如我任意一个 api 支持 anthropic 我都能给 claude code 用"

- [x] **凭证三入口收敛**
  - 现状：`.env`（`*_API_KEY`）、`provider-profiles.secrets.local.json`、`POST /api/config/secrets`
  - 终态：LLM 凭证统一走 `credentials.json`；Connector 凭证暂留 `.env`（单独域）
  - Hub Env 面板对 `*_API_KEY` 显示 deprecated 提示
  - 启动时检测到 legacy env key → 一次性"导入到 credentials"提示

- [x] **模板分发**
  - `cat-config.yaml.example` 进 git（有结构示例，无真实值）
  - `cat-config.yaml` 不进 git（用户本地改）
  - `~/.cat-cafe/credentials.json` 在全局目录，天然不进 git

### 硬约束补充（2026-03-28，@codex review 补项 — 4 条不补必长技术债）

- [x] **HC-1: `credentials.json` 必须是对象结构，不是纯 string**
  ```json
  {
    "claude": { "apiKey": "<your-anthropic-key>" },
    "my-glm": { "apiKey": "<your-glm-key>" },
    "my-oauth": { "accessToken": "...", "refreshToken": "...", "expiresAt": 1234567890 }
  }
  ```
  - 理由：oauth/api_key 共存，accessToken 有 TTL，未来需 refresh 机制
  - 纯 string 会导致 oauth 场景回到 ad-hoc 扩展

- [x] **HC-2: 运行时唯一写源 = `cat-catalog.json`（含 accounts 区）**
  - `cat-config.yaml.example` 只做模板（进 git），首次启动 seed 数据写入 `cat-catalog.json`
  - Hub CRUD（猫 + 账户）统一写 `cat-catalog.json` → 发 ConfigChangeEvent
  - 和 F127 现有模式一致（猫 CRUD 已写 cat-catalog），不引入 cat-config vs cat-catalog 新双源
  - `cat-config.yaml` 是可选的用户初始配置（首次启动时读一次，之后运行时以 cat-catalog 为准）

- [x] **HC-3: 迁移窗口可验证规则**
  - 触发时机：首次启动检测到旧 `provider-profiles.json` 或 `.env` 有 `*_API_KEY` → 自动迁移
  - 导入成功后：不自动清理 `.env`（用户手动确认后清理），打印一次迁移报告
  - 版本门槛：迁移窗口保留一个 minor 版本（N+1 升级为 hard warning，N+2 删 fallback）
  - 可验证：`pnpm check:legacy-credentials` 脚本检测旧路径残留

- [x] **HC-4: Phase 4d 退出条件量化**
  - 全 repo `grep -r 'process\.env\.\w*API_KEY\|process\.env\.\w*SECRET'` 业务链路零命中（test/mock 除外）
  - `pnpm check:legacy-credentials` 绿
  - 兼容导入测试全绿（旧格式 → 新格式端到端）
  - Provider 热更新回归通过（改 credentials → 猫 rebind 验证）
  - 全量 `pnpm gate` 通过

- [x] **HC-5: credentials 全局作用域 + 跨项目冲突检测 hard error**（@gpt52 review 两轮收敛）
  - `~/.cat-cafe/credentials.json` 保持全局（和现有 provider-profiles 行为一致，多项目共享账户）
  - **冲突检测（4a 阶段实施）**：启动时扫描 `known-project-roots.json` 中所有项目的 `accounts` 区，同名 accountRef 的 `protocol/baseUrl/authType` 不一致 → **hard error**（不静默复用错误凭证）
  - 同名 accountRef + 相同配置 = 正常共享（多项目共用同一 API key）
  - 不引入 project-scoped credentials（会丧失多项目共享能力）
  - `CAT_CAFE_GLOBAL_CONFIG_ROOT` 环境变量可用于需要完全隔离的场景
  - 4a/4b 在同一 worktree 连续实施、同一 PR 合入，避免半新半旧双轨

- [x] **文案统一（@gpt52 review 补项）**：用户面对一份配置域（`cat-config`），运行时落盘 `.cat-cafe/cat-catalog.json`，`cat-config.yaml.example` 只做模板不参与运行时——这两句话不矛盾，前者是用户视角，后者是实现细节

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

| Phase | 内容 | 状态 | 备注 |
|-------|------|------|------|
| **1** | 统一 event bus 设计 + ConfigChangeEvent schema | ✅ done | PR #778 merged (2026-03-27) |
| **2** | Connector 热重载 + `/api/config/secrets` | ✅ done | PR #784 merged (2026-03-27) |
| **2b** | Hub connector config UI → secrets endpoint 前端接线 | ✅ done | PR #788 merged (2026-03-27) |
| **3A** | F127 side effect 迁移到 event bus subscriber | ✅ done | PR #790 merged (2026-03-28) — CatCatalogSubscriber + emitChangeAsync |
| **3B** | `runtime-cat-catalog` 收敛为纯存储+校验 | ✅ done (no-op) | grep 确认无 ad-hoc 触发路径残留 |
| **3C** | 删除 F127 ad-hoc 热更新死代码 | ✅ done (no-op) | grep 确认无死代码 |
| **4a** | 单一真相源：`cat-config.accounts` + `credentials.json` 读写层 | ✅ done | PR #818 merged (2026-03-28) — accounts + credentials + migration + HC-5 conflict guard |
| **4b** | 统一运行时读取：所有调用链走 `cat-config + credentials`，禁直读 `*_API_KEY` | ✅ done | PR #818 merged (2026-03-28) — unified resolver + route dual-write + LlmAIProvider rewired |
| **4c** | Provider 热更新：`AccountBindingSubscriber` + rebind | ✅ done | PR #824 merged (2026-03-28) — event bus subscriber for account config changes |
| **4d** | 下线旧层：删 `provider-profiles.ts` + `provider-binding-compat.ts` + tests | ✅ done | PR #824 merged (2026-03-28) — net -2032 lines, all consumers migrated |

**MVP = Phase 1 + 2 + 2b**：✅ 已完成。Hub 配置向导改 IM 配置即时热生效，无需重启。

## Follow-up: Startup Invariant Guard — ✅ Implemented (PR #835)

**来源**：2026-03-28 runtime incident + @gpt52 审查建议 → team lead升级为"现在就做"

**实现**（PR #835, merged 2026-03-28）：
- `hasLegacyProviderProfiles()`: 三态检测（文件不存在 → false, 存在但损坏 → true, 存在但空 providers → false, 存在且有 providers → true）
- `accountStartupHook()`: legacy source present + empty accounts → hard throw `F136 LL-043`
- `index.ts`: LL-043 errors propagated alongside HC-5 (not swallowed by best-effort catch)
- `accountToView()`: non-standard builtins (dare/opencode) emit correct `client` field (fixes duplicate accounts on Hub UI)
- 3 regression tests (empty providers, corrupt file, legacy+no-accounts) + 1 client field test
- Cloud review: 3 rounds (P1 → P1 → clean)

**AC**：
1. [x] 旧 `provider-profiles.json` 存在 + 当前项目 `accounts` 缺失 → hard throw (startup blocked)
2. [x] 回归测试：覆盖 legacy source + migration 未落成 + 空 providers + 损坏文件场景
3. [x] 升级为 startup hard fail（team lead拍板："三件事情得做嘞，不能静默失败"）

## Follow-up: Hub Profile Stale + HC-5 Worktree — ✅ Implemented (PR #847)

**来源**：2026-03-29 team lead报告"新建 api key 更新不动"+ minimax baseUrl 更新报 conflict

**实现**（PR #847, merged 2026-03-29）：
- Cat Editor `profilesVersion` + `provider-profiles-changed` CustomEvent 跨组件 invalidation
- HC-5 `validateAccountWrite` + `detectAccountConflicts` 用 `isSameProject()` 排除同一 git 项目的 worktree
- 3 worktree-aware 回归测试
- Cloud review: @gpt52 审放行（无 P1/P2）

## Follow-up: Hub Sensitive Env Write — ✅ Implemented (PR #853, absorb clowder-ai PR #285)

**来源**：社区 PR clowder-ai#285 提出 Hub 可写 sensitive env（OPENAI_API_KEY / F102_API_KEY / GITHUB_MCP_PAT）。Maine Coon评估后认为有 4 个防御点值得吸收，但实现形式与我们 accounts/credentials 主线冲突，不宜原样 intake。

**实现**（PR #853, merged 2026-03-29）：
1. sensitive env `runtimeEditable: true` fail-closed whitelist — 3 env-owning secrets（OPENAI_API_KEY, GITHUB_MCP_PAT, F102_API_KEY）
2. Owner gate: `DEFAULT_OWNER_USER_ID` match required（403 otherwise）; trust anchor marked `runtimeEditable: false`
3. Frontend: password input + masked display（`***`）+ empty-draft-means-no-change
4. `ENV_SENSITIVE_WRITE` audit event（sensitive keys only, no values）
- Cloud review 2 rounds: P1 trust anchor hijack + P2 audit key filtering → fixed; P1 header spoofing → push back (existing local-first trust model)
- gpt52 审放行

**不做**：不把已迁移到 `accounts/credentials.json` 的 provider 凭证拉回 `.env` 路线。
