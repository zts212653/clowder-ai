---
feature_ids: [F136]
related_features: [F004, F088, F127, F062]
topics: [config, hot-reload, env, connector, event-bus, dynamic-config]
doc_kind: spec
created: 2026-03-23
---

# F136: Unified Config Hot Reload — 配置热更新统一管线

> **Status**: spec | **Owner**: 待定 | **Priority**: P1

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
- [ ] 安全边界：sensitive env vars（tokens/secrets）能否通过 Hub API 热更新？还是只能手动改 `.env` + 触发 reload？

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
| **2** | Connector 热重载（F088 直接需求） | 📋 planned |
| **3** | F127 runtime-cat-catalog 收编 | 📋 planned |
| **4** | Provider Profiles 热重载 | 📋 planned |
