---
feature_ids: [F127]
related_features: [F062, F032, F050]
topics: [cat-management, provider-profile, hub, alias, routing, dynamic-config]
doc_kind: spec
created: 2026-03-17
community_issue: "#109"
---

# F127: 猫猫管理重构 — 账户配置与猫猫实例分离，支持动态创建猫 + 自定义别名 @ 路由

> **Status**: done | **Completed**: 2026-04-29 | **Owner**: 金渐层 + Maine Coon | **Priority**: P1

## Why

> team experience（社区 issue #109）：
> "想加一只新猫（比如用 API key 接入的 GLM-5）或者给猫改个 @ 别名，都得手动改配置文件重启。"

当前猫猫管理是静态 `cat-config.json` 一锅端模式：provider/model/认证/别名/@路由/角色全部写死在一个 JSON 里。用户想加一只新猫或给猫改个 @ 别名，都得手动改配置文件重启。

痛点清单：
1. **账户配置和猫猫定义耦合**：provider/model 写在猫的定义里，但认证配置在另一个系统（provider-profiles），两者没有关联
2. **不能动态创建猫**：想加一只用 API key 接入的猫，得手动改 JSON + 重启
3. **@ 别名硬编码**：`mentionPatterns` 写死在配置里，不能从 UI 改
4. **API key 接入的猫没有正确的 @ 名称**：用 API key 接入 `glm-5` 模型，@ 路由应该能自动或手动配成 `@glm-5`，而不是只能沿用预设品种名
5. **Hub 只读**：猫猫总览只能看 Provider/Model/Token 限制，不能编辑

## What

### 两层分离架构

#### 第一层：账户配置（Provider Accounts）

管理认证凭据，和具体哪只猫无关：

| authType | 配置项 | 示例 |
|---------|--------|------|
| `oauth` — Claude | 订阅类型 | Max Plan |
| `api_key` — Claude | apiKey + baseUrl + 可选 modelOverride | `<your-api-key>` + `https://api.anthropic.com` |
| `oauth` — Codex | 订阅类型 | ChatGPT Pro |
| `api_key` — Codex | apiKey + baseUrl | `sk-...` + `https://api.openai.com` |
| `oauth` — Gemini | CLI 内部 auth | — |
| `api_key` — 自定义 | apiKey + baseUrl + provider hint | 兼容 OpenAI 协议的任意端点 |

账号类型由 `authType: 'oauth' | 'api_key'` 唯一决定（F171 移除了冗余的 `builtin` 标记）。这层是 F062（done）的泛化扩展。

#### 第二层：猫猫实例管理（Cat Instances）

每只猫是一个可独立配置的实例：

```
猫猫实例 = {
  catId: 唯一标识,
  displayName: 显示名,
  nickname: 昵称,
  aliases: ['@别名1', '@别名2'],     // 用户可自定义，@ 路由基于此
  accountRef: 指向哪个账户配置,       // 引用第一层
  model: 模型名（OAuth 需要选；API key 可从端点自动获取或手动指定）,
  breed: 品种归属（可选，用于分组展示）,
  roleDescription: 角色描述,
  personality: 性格描述,
  contextBudget: { ... }
}
```

#### 举例

```
账户配置:
  ├── "claude-max"     → Claude OAuth 订阅
  ├── "openai-pro"     → Codex OAuth 订阅
  ├── "my-anthropic"   → Anthropic API Key (<your-key>)
  └── "my-glm"         → 自定义 API Key (https://api.zhipu.ai, sk-yyy)

猫猫实例:
  ├── 布偶1 → accountRef: "claude-max",    model: "claude-opus-4-6",   aliases: ["@opus", "@Ragdoll"]
  ├── 布偶2 → accountRef: "my-anthropic",  model: (由 API 决定),        aliases: ["@布偶2", "@Ragdoll二号"]
  ├── 缅因1 → accountRef: "openai-pro",    model: "gpt-5.3-codex",     aliases: ["@codex", "@Maine Coon"]
  └── 智谱猫 → accountRef: "my-glm",       model: "glm-5",             aliases: ["@glm-5", "@智谱"]
```

用户在对话里 `@glm-5` 就能路由到智谱猫。

### Phase A: 账户配置泛化（Provider Accounts CRUD）

扩展 F062 的 provider-profiles 系统，从 Anthropic-only 扩展到通用账户管理：
- 支持 Claude/Codex/Gemini 的 OAuth + API Key 多种类型
- Hub 账户管理 Tab 重构（从Ragdoll专用 → 通用账户管理）
- 账户 CRUD API

### Phase B: 猫猫实例管理（Cat Instance CRUD）

- CatRegistry 支持运行时增删改（保留 cat-config.json 作为 seed/fallback）
- 猫猫实例 CRUD API（POST/PATCH/DELETE `/api/cats`）
- 猫猫实例与账户配置的引用关系（accountRef）
- 动态创建的猫可以正常被 @ 调用、正常响应

### Phase C: 动态别名 @ 路由

- mention-parser 从动态 registry 读 aliases（替代静态 config）
- a2a-mentions 同步改动
- @ 自动补全基于猫猫实例的 aliases 字段
- API key 接入的猫默认别名包含实际模型名

### Phase D: Hub 猫猫管理 UI

- 猫猫总览从只读变为可管理（CRUD）
- 新建猫：选账户 → 选/输入模型 → 配别名/昵称 → 选品种（可选）→ 配角色描述
- 编辑猫：修改别名、昵称、角色描述、切换账户
- @ 路由基于用户配置的 aliases，不再硬编码

## Acceptance Criteria

### Phase A（账户配置泛化）
- [x] AC-A1: Hub 里可以创建新的账户配置（至少 Claude OAuth/API Key + Codex OAuth/API Key）
- [x] AC-A2: 账户配置支持自定义 API Key + baseUrl（兼容 OpenAI 协议端点）
- [x] AC-A3: 现有 F062 Ragdoll profile 无缝迁移到新账户系统

### Phase B（猫猫实例管理）
- [x] AC-B1: Hub 里可以创建新的猫猫实例，绑定到某个账户配置
- [x] AC-B2: CatRegistry 支持运行时增删改猫猫实例
- [x] AC-B3: 动态创建的猫可以正常被 @ 调用、正常响应 — close-gate 覆盖新会话动态猫响应 + resumed session registry-change reinjection（`invoke-single-cat.test.js` / `system-prompt-builder.test.js`）
- [x] AC-B4: 现有预设猫（opus/codex/gemini 等）作为 seed 数据保留，不受影响

### Phase C（动态别名 @ 路由）
- [x] AC-C1: 猫猫实例支持自定义别名，@ 路由基于别名工作
- [x] AC-C2: API key 接入的猫，默认别名包含实际模型名 — Hub 新建 API key 猫在用户未显式填写别名时默认派生 `@{model}`（例如 `@gpt-5.4-mini`）
- [x] AC-C3: @ 自动补全候选列表基于动态 registry

### Phase D（Hub 管理 UI）
- [x] AC-D1: Hub 猫猫总览支持新建/编辑/删除猫猫实例
- [x] AC-D2: 猫猫编辑支持修改别名、昵称、角色描述、切换账户

## Dependencies

- **Evolved from**: F062（Ragdoll账号配置中枢 — Anthropic-only provider profile）
- **Related**: F032（Agent Plugin Architecture — CatId 松绑 + CatRegistry 基础）
- **Related**: F050（External Agent Onboarding — A2A/CLI 接入契约）
- **Related**: F105（金渐层接入 — opencode provider 注册模式参考）

## 涉及的架构变化

| 组件 | 当前 | 目标 |
|------|------|------|
| `cat-template.json` | 品种模板（进 git） | 只读 seed，首次启动 bootstrap 创建空 catalog |
| `.cat-cafe/cat-catalog.json` | — | 运行时猫实例状态（breeds + roster），支持 CRUD |
| `.cat-cafe/accounts.json` | — | 运行时账户元数据（authType/clientId/models） |
| `CatRegistry` | 启动时一次性加载 | 支持运行时增删改 |
| `provider-profiles` | Anthropic-only | 已被 `accounts.json` + `credentials.json` 取代（F136/clowder-ai#340） |
| `mention-parser.ts` | 从静态 config 读 patterns | 从动态 registry 读 aliases |
| `a2a-mentions.ts` | 同上 | 同上 |
| Hub 猫猫总览 | 只读展示 | 可管理（CRUD） |
| `GET /api/cats` | 返回静态 registry | 返回动态 registry |

## 涉及文件

- `cat-template.json` — 品种模板（只读 seed，不参与运行时写入）
- `packages/shared/src/types/cat.ts` — CatConfig 类型增加 `accountRef`、`aliases`
- `packages/shared/src/registry/CatRegistry.ts` — 支持运行时 mutation
- `packages/api/src/config/cat-config-loader.ts` — 合并 seed + 动态配置
- `packages/api/src/infrastructure/connectors/mention-parser.ts` — 从动态 aliases 读取
- `packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts` — 同上
- `packages/api/src/routes/cats.ts` — 增加 POST/PATCH/DELETE 端点
- `packages/web/src/components/config-viewer-tabs.tsx` — 重构为可编辑
- `packages/web/src/hooks/useCatData.ts` — 支持 mutation
- `packages/api/src/config/provider-profiles.ts` — 被账户管理引用

## Risk

| 风险 | 缓解 |
|------|------|
| CatRegistry 运行时 mutation 破坏现有静态加载契约 | seed 数据保证最低可用；mutation API 做 CAS 保护 |
| 动态 alias 冲突（两只猫同 alias） | Registry 注册时唯一性校验 + 冲突报错 |
| F062 provider-profiles 迁移兼容性 | Phase A 设计 migration path，保证现有配置无损 |
| Hub UI 大范围重构 | 分 Phase 渐进，每 Phase 可独立验收 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 两层分离：账户配置 × 猫猫实例 | 认证凭据和猫猫身份是正交关注点，解耦后可独立扩展 | 2026-03-17 |
| KD-2 | 持久化用文件（`.cat-cafe/cat-catalog.json`），不用 Redis | 社区 PR #130 选择了文件方案。原因：开源用户不一定有 Redis；文件方案零外部依赖。**代价**：引入了"两个 JSON 文件存同类数据"的双真相源风险。已通过 PR #632 的 deep merge 缓解（catalog 只是 delta overlay，不再整体替换 config） | 2026-03-21 |
| KD-3 | config loader 做字段级 deep merge | catalog 是 overlay 而非替代品。`cat-config.json` 新增字段不会被 catalog 吞掉。解决了头像/颜色丢失的根因 | 2026-03-21 |
| KD-4 | `owner` → `coCreator` 术语统一 | F127 intake 引入了 `owner` 概念（指team lead），但 `owner` 在 CS 领域是过载术语（repo owner, worklist owner），改为 `coCreator` 对齐愿景（共创者） | 2026-03-21 |

## 遗留项（未来可能需要调整）

| # | 遗留项 | 影响 | 触发点 | 建议处理 |
|---|--------|------|--------|----------|
| R-1 | **持久化层用文件而非 Redis** — 双 JSON 文件的复杂度已通过 deep merge 缓解，但仍比单一 Redis 存储多一层。社区 PR 选文件是合理的（零外部依赖），但如果未来需要多节点/分布式部署，文件方案不够 | 低（单节点够用） | 多节点部署需求 | 可在未来版本将 catalog 迁移到 Redis，接口层已解耦 |
| R-2 | ~~**resumed session 下动态猫 roster 可能过时**~~ — ✅ 已修复。CatRegistry 维护 revision；同一 user/cat/thread 的 resume 会话若 registry revision 变化，会重新注入 static identity 刷新 roster，同时保留普通 resume 跳过注入 | ~~中~~ done | — | — |
| R-3 | ~~**AC-B3 / AC-C2 未端到端验证**~~ — ✅ 已补齐。AC-C2 覆盖 API key 新建默认模型别名；AC-B3 覆盖动态猫新会话响应和 resume registry-change reinjection | ~~低~~ done | — | — |
| R-4 | **猫猫模板机制未做** — 社区 issue 里提到的"预设品种→一键创建变体"能力，当前 Hub 只有完全手动填表 | 低（非 MVP 范围） | 用户量增长后 onboarding 体验优化 | 未来 Feature |
| R-5 | **社区 issue #109 仍 OPEN** — 应同步更新状态 | 低 | 和开源同步时 | 发 comment 说明进度 + 关闭或标为 phase 2 |
| R-6 | ~~**Hub 编辑器滚动时右上角 X 按钮跟着滚**~~ — ✅ 已修复（PR #665 初版 + PR #714 二修）。3 个 modal 统一改为 flex-col 布局，header/footer 固定，仅 content 滚动 | ~~中~~ done | — | — |
| R-7 | **API key 账号需手动逐个填支持的 model 列表** — 应该自动探测或提供预设列表 | 中（UX 痛点） | 添加 API key 账号时 | 自动探测 endpoint 支持的 model（`/v1/models`）或提供常用 model 预设 |
| R-8 | **切换认证方式（订阅↔API key）没有一键切换** — 要一只猫一只猫改 provider profile binding | 高（UX 痛点） | team lead想批量切换认证方式时 | 加"一键切换所有猫的 provider profile"功能 |
| R-9 | **nuoda.vip 代理 model name 格式混淆** — API 代理用 `claude-opus-4-6`（Anthropic 原生），但 opencode CLI 需要 `anthropic/claude-opus-4-6`（provider/model 格式），Hub 不知道该用哪个 | 中（配置困惑） | 用第三方 API 代理时 | Hub 编辑器应按 client 类型自动处理 model name 格式 |
| R-10 | **本地反代 `anthropic-proxy.mjs` 的 upstream 配置未初始化** — `start-dev.sh` 启动的反代（端口 9877）依赖 `.cat-cafe/proxy-upstreams.json` 配置上游，但 F127 intake 后 runtime 里该文件不存在。API key profile 创建应自动注册 upstream 到反代 | 中（反代功能不可用） | 配置 API key profile 用本地反代时 | profile 创建/更新时自动写 `proxy-upstreams.json` |
| R-11 | ~~**Hub 缺少结构化、provider-aware 的 `cli.effort` 编辑**~~ — ✅ 已修复（PR #882）。Hub 已提供结构化 effort 字段；Claude=`low/medium/high/max`，Codex=`low/medium/high/xhigh`；保存写 `variant.cli.effort`；只对新 invocation 生效，不强切旧 session；开源跟踪 issue: [clowder-ai#315](https://github.com/zts212653/clowder-ai/issues/315) | ~~高（易错 + UX 差）~~ done | — | — |
| R-12 | ~~**跨项目 homedir legacy 账号污染 runtime 账号配置**~~ — ✅ 已修复（PR #1457）。启动迁移与 installer import 现在只导入项目显式引用的 homedir legacy account；引用源覆盖 `accountRef`、legacy `providerProfileId`、catalog `accounts` keys、credential refs，并保留 installer 内置账号 | ~~中（账号配置 UI 出现 Agent Teams / Local 等外部项目垃圾项）~~ done | — | — |

## AC-B3 验收矩阵（E2E 验证清单）

| # | 场景 | 预期 | 状态 |
|---|------|------|------|
| V-1 | 新会话：Hub 创建动态猫后，新对话中 @ 该猫 | API 路由成功，猫正常响应 | ✅ `invoke-single-cat.test.js` 覆盖 runtime-created cat 新会话响应；`system-prompt-builder.test.js` 覆盖新 roster |
| V-2 | resume 会话（无 reinjection）：已有 session 中 @ 新动态猫 | 需确认 roster 是否包含新猫 | ✅ CatRegistry revision 变化触发 static identity reinjection；测试确认保留同一 CLI sessionId 且刷新 roster |
| V-3 | resume + forceReinjection（压缩触发）：压缩后 @ 新动态猫 | reinjection 刷新 roster，路由成功 | ⬜ 待验证 |
| V-4 | API 路由链（connector/A2A）：外部消息 @ 动态猫 | catRegistry 实时生效，路由成功 | ⬜ 待验证 |

> **F127 close 前提**：V-1 + V-2 已覆盖。V-3/V-4 仍属于增强验证，不阻塞 close。

## Close Gate Report

| AC | 处置 | Evidence |
|----|------|----------|
| AC-A1 | ✅ met | PR #626/#631 建立 Hub 账户配置 CRUD；F127 status 已在 #1464 后置为 done |
| AC-A2 | ✅ met | 账户层支持 API Key + baseUrl；R-12 修复未改变显式项目账户导入 |
| AC-A3 | ✅ met | provider-profile 迁移已由 F127 intake / F136 路径吸收，legacy `providerProfileId` 仍被 R-12 allowlist 识别 |
| AC-B1 | ✅ met | Hub 猫猫实例 CRUD 已随 Phase B/D 落地 |
| AC-B2 | ✅ met | CatRegistry 支持 runtime mutation；#1464 增加 registry revision |
| AC-B3 | ✅ met | #1464 覆盖 runtime-created cat 新会话响应 + resume registry-change reinjection |
| AC-B4 | ✅ met | seed/preconfigured cats 继续保留；运行时 catalog 是 overlay，不修改 `cat-config.json` |
| AC-C1 | ✅ met | mention parser / A2A alias routing 从动态 registry 读取 aliases |
| AC-C2 | ✅ met | #1464：Hub 新建 API key 猫且别名为空时从模型名派生默认 alias |
| AC-C3 | ✅ met | 自动补全基于动态 registry 候选 |
| AC-D1 | ✅ met | Hub 猫猫总览支持新建/编辑/删除猫猫实例 |
| AC-D2 | ✅ met | Hub 编辑器支持别名、昵称、角色描述、账户绑定等配置 |
| R-12 | ✅ met | #1457：homedir legacy account import 只保留项目显式引用账号，阻断 runtime account pollution |

**Close review**:
- `gpt52` close-gate review：确认 AC-C2 / V-1 / V-2 补齐，放行 PR #1464。
- `opus` 愿景守护：确认原始痛点与当前状态匹配，放行 F127 close。

## Review Gate

- Phase A~D: 每 Phase 独立 review + merge
- 前端 UI: Design Gate 必须team lead确认
