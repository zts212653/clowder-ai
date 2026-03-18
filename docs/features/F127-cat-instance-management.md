---
feature_ids: [F127]
related_features: [F062, F032, F050]
topics: [cat-management, provider-profile, hub, alias, routing, dynamic-config]
doc_kind: spec
created: 2026-03-17
community_issue: "#109"
---

# F127: 猫猫管理重构 — 账户配置与猫猫实例分离，支持动态创建猫 + 自定义别名 @ 路由

> **Status**: spec | **Owner**: 待定 | **Priority**: P1

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

| 账户类型 | 配置项 | 示例 |
|---------|--------|------|
| Claude 订阅 (OAuth) | 订阅类型 | Max Plan |
| Claude API Key | apiKey + baseUrl + 可选 modelOverride | `<your-api-key>` + `https://api.anthropic.com` |
| Codex 订阅 (OAuth) | 订阅类型 | ChatGPT Pro |
| Codex API Key | apiKey + baseUrl | `sk-...` + `https://api.openai.com` |
| Gemini 订阅 | CLI 内部 auth | — |
| 自定义 API Key | apiKey + baseUrl + provider hint | 兼容 OpenAI 协议的任意端点 |

这层是 F062（done）的泛化扩展。

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
- [ ] AC-A1: Hub 里可以创建新的账户配置（至少 Claude OAuth/API Key + Codex OAuth/API Key）
- [ ] AC-A2: 账户配置支持自定义 API Key + baseUrl（兼容 OpenAI 协议端点）
- [ ] AC-A3: 现有 F062 Ragdoll profile 无缝迁移到新账户系统

### Phase B（猫猫实例管理）
- [ ] AC-B1: Hub 里可以创建新的猫猫实例，绑定到某个账户配置
- [ ] AC-B2: CatRegistry 支持运行时增删改猫猫实例
- [ ] AC-B3: 动态创建的猫可以正常被 @ 调用、正常响应
- [ ] AC-B4: 现有预设猫（opus/codex/gemini 等）作为 seed 数据保留，不受影响

### Phase C（动态别名 @ 路由）
- [ ] AC-C1: 猫猫实例支持自定义别名，@ 路由基于别名工作
- [ ] AC-C2: API key 接入的猫，默认别名包含实际模型名
- [ ] AC-C3: @ 自动补全候选列表基于动态 registry

### Phase D（Hub 管理 UI）
- [ ] AC-D1: Hub 猫猫总览支持新建/编辑/删除猫猫实例
- [ ] AC-D2: 猫猫编辑支持修改别名、昵称、角色描述、切换账户

## Dependencies

- **Evolved from**: F062（Ragdoll账号配置中枢 — Anthropic-only provider profile）
- **Related**: F032（Agent Plugin Architecture — CatId 松绑 + CatRegistry 基础）
- **Related**: F050（External Agent Onboarding — A2A/CLI 接入契约）
- **Related**: F105（金渐层接入 — opencode provider 注册模式参考）

## 涉及的架构变化

| 组件 | 当前 | 目标 |
|------|------|------|
| `cat-config.json` | 唯一真相源，静态 | 预设/seed 数据，可被运行时覆盖 |
| `CatRegistry` | 启动时一次性加载 | 支持运行时增删改 |
| `provider-profiles` | Anthropic-only | 通用账户管理 |
| `mention-parser.ts` | 从静态 config 读 patterns | 从动态 registry 读 aliases |
| `a2a-mentions.ts` | 同上 | 同上 |
| Hub 猫猫总览 | 只读展示 | 可管理（CRUD） |
| `GET /api/cats` | 返回静态 registry | 返回动态 registry |

## 涉及文件

- `cat-config.json` — 保留为 seed/fallback
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

## Review Gate

- Phase A~D: 每 Phase 独立 review + merge
- 前端 UI: Design Gate 必须team lead确认
