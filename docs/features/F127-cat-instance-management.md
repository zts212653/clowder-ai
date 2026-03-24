---
feature_ids: [F127]
related_features: [F062, F032, F050]
topics: [cat-management, provider-profile, hub, alias, routing, dynamic-config]
doc_kind: spec
created: 2026-03-17
community_issue: "#109"
---

# F127: 猫猫管理重构 — 账户配置与猫猫实例分离，支持动态创建猫 + 自定义别名 @ 路由

> **Status**: in-progress (intake + fix done, AC 部分验收) | **Owner**: 金渐层 + Maine Coon | **Priority**: P1

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
- [x] AC-A1: Hub 里可以创建新的账户配置（至少 Claude OAuth/API Key + Codex OAuth/API Key）
- [x] AC-A2: 账户配置支持自定义 API Key + baseUrl（兼容 OpenAI 协议端点）
- [x] AC-A3: 现有 F062 Ragdoll profile 无缝迁移到新账户系统

### Phase B（猫猫实例管理）
- [x] AC-B1: Hub 里可以创建新的猫猫实例，绑定到某个账户配置
- [x] AC-B2: CatRegistry 支持运行时增删改猫猫实例
- [ ] AC-B3: 动态创建的猫可以正常被 @ 调用、正常响应 — **未验证：动态创建的猫需要重启 CLI 才能被 @ 调用**
- [x] AC-B4: 现有预设猫（opus/codex/gemini 等）作为 seed 数据保留，不受影响

### Phase C（动态别名 @ 路由）
- [x] AC-C1: 猫猫实例支持自定义别名，@ 路由基于别名工作
- [ ] AC-C2: API key 接入的猫，默认别名包含实际模型名 — **未验证：无 API key 猫的端到端测试**
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
| KD-2 | 持久化用文件（`.cat-cafe/cat-catalog.json`），不用 Redis | 社区 PR #130 选择了文件方案。原因：开源用户不一定有 Redis；文件方案零外部依赖。**代价**：引入了"两个 JSON 文件存同类数据"的双真相源风险。已通过 PR #632 的 deep merge 缓解（catalog 只是 delta overlay，不再整体替换 config） | 2026-03-21 |
| KD-3 | config loader 做字段级 deep merge | catalog 是 overlay 而非替代品。`cat-config.json` 新增字段不会被 catalog 吞掉。解决了头像/颜色丢失的根因 | 2026-03-21 |
| KD-4 | `owner` → `coCreator` 术语统一 | F127 intake 引入了 `owner` 概念（指team lead），但 `owner` 在 CS 领域是过载术语（repo owner, worklist owner），改为 `coCreator` 对齐愿景（共创者） | 2026-03-21 |

## 遗留项（未来可能需要调整）

| # | 遗留项 | 影响 | 触发点 | 建议处理 |
|---|--------|------|--------|----------|
| R-1 | **持久化层用文件而非 Redis** — 双 JSON 文件的复杂度已通过 deep merge 缓解，但仍比单一 Redis 存储多一层。社区 PR 选文件是合理的（零外部依赖），但如果未来需要多节点/分布式部署，文件方案不够 | 低（单节点够用） | 多节点部署需求 | 可在未来版本将 catalog 迁移到 Redis，接口层已解耦 |
| R-2 | **动态创建猫仍需重启 CLI** — CatRegistry 运行时 mutation 只更新 API 进程内存 + catalog 文件，CLI 子进程不会热重载新猫 | 中（社区愿景是免重启） | 用户真的要通过 Hub 动态加猫时 | 需要 CLI hot-reload 或 IPC 通知机制，scope 较大，建议独立 Feature |
| R-3 | **AC-B3 / AC-C2 未端到端验证** — 动态创建猫的 @ 路由和 API key 猫的默认别名，缺少端到端测试 | 低（代码路径存在，但没有集成测试覆盖） | 有人真的通过 Hub 创建 API key 猫时 | 补集成测试 |
| R-4 | **猫猫模板机制未做** — 社区 issue 里提到的"预设品种→一键创建变体"能力，当前 Hub 只有完全手动填表 | 低（非 MVP 范围） | 用户量增长后 onboarding 体验优化 | 未来 Feature |
| R-5 | **社区 issue #109 仍 OPEN** — 应同步更新状态 | 低 | 和开源同步时 | 发 comment 说明进度 + 关闭或标为 phase 2 |
| R-6 | ~~**Hub 编辑器滚动时右上角 X 按钮跟着滚**~~ — ✅ 已修复（PR #665）。3 个 modal 统一改为 flex-col 布局，header/footer 固定，仅 content 滚动 | ~~中~~ done | — | — |
| R-7 | **API key 账号需手动逐个填支持的 model 列表** — 应该自动探测或提供预设列表 | 中（UX 痛点） | 添加 API key 账号时 | 自动探测 endpoint 支持的 model（`/v1/models`）或提供常用 model 预设 |
| R-8 | **切换认证方式（订阅↔API key）没有一键切换** — 要一只猫一只猫改 provider profile binding | 高（UX 痛点） | team lead想批量切换认证方式时 | 加"一键切换所有猫的 provider profile"功能 |
| R-9 | **nuoda.vip 代理 model name 格式混淆** — API 代理用 `claude-opus-4-6`（Anthropic 原生），但 opencode CLI 需要 `anthropic/claude-opus-4-6`（provider/model 格式），Hub 不知道该用哪个 | 中（配置困惑） | 用第三方 API 代理时 | Hub 编辑器应按 client 类型自动处理 model name 格式 |
| R-10 | **本地反代 `anthropic-proxy.mjs` 的 upstream 配置未初始化** — `start-dev.sh` 启动的反代（端口 9877）依赖 `.cat-cafe/proxy-upstreams.json` 配置上游，但 F127 intake 后 runtime 里该文件不存在。API key profile 创建应自动注册 upstream 到反代 | 中（反代功能不可用） | 配置 API key profile 用本地反代时 | profile 创建/更新时自动写 `proxy-upstreams.json` |

## Review Gate

- Phase A~D: 每 Phase 独立 review + merge
- 前端 UI: Design Gate 必须team lead确认
