---
feature_ids: [F032]
related_features: [F32-b, F042]
topics: [agent, plugin, architecture, collaboration]
doc_kind: spec
created: 2026-02-26
updated: 2026-02-27
---

# F032: Agent Plugin Architecture（CatId 松绑 + 协作规则动态化）

> **Status**: done | **Owner**: Ragdoll (Opus 4.5) + 三猫
> **Created**: 2026-02-26
> **Last Updated**: 2026-02-27

## Why

F032 解决的是“身份/角色/协作规则”被硬编码导致的系统不可扩展问题：多分身并存后，静态 `CatId`、写死 reviewer 规则、缺少 thread 活跃度排序都会让协作链路失真。

## What

1. 技术侧松绑（CatId/AgentRegistry/catIdSchema 动态化）
2. 协作规则动态化（Roster Schema + Reviewer Matcher）
3. Thread Activity Tracking 与 system prompt 注入机制补齐

## Acceptance Criteria

### Phase A（技术侧松绑）
- [x] AC-A1: `CatId` 从硬编码枚举改为运行时动态模型。
- [x] AC-A2: `AgentRegistry` 支持按 roster/provider 动态注册服务。
- [x] AC-A3: `catIdSchema` 动态验证已落地并可拦截未知 catId。

### Phase B（协作规则动态化）
- [x] AC-B1: Team Roster Schema 与 Reviewer Matcher 已实现并投入使用。
- [ ] AC-B2: SOP/Skill 模板化在 F042 继续推进（本 feature 不再单独交付）。

### Phase C/D
- [x] AC-C1: Thread activity tracking 已落地，reviewer 可按 thread 活跃度优先。
- [x] AC-D1: System prompt 注入路径已落地并完成验收。

## Dependencies

- **Evolved from**: F32-b（CatId/AgentRegistry 技术侧松绑先导工作）
- **Blocked by**: F042（SOP/Skill 模板化收口）
- **Related**: F032（本体）/ F042（提示词与 skills 系统性优化）

## Risk

| 风险 | 缓解 |
|------|------|
| B2 迁移到 F042 后出现边界不清 | 在 F042 保留“来源于 F032 的 B3 scope”并做完成态回链 |
| 多分身 roster 演进导致 reviewer 规则漂移 | 所有规则回收到 roster + manifest，禁止硬编码猫名 |

## 实现状态总览

| Phase | 内容 | 状态 | 实现于 |
|-------|------|------|--------|
| **A** | 技术侧松绑 (CatId/AgentRegistry/catIdSchema) | ✅ 已完成 | **F32-b** (2026-02-17~21) |
| **B1-B2** | Roster Schema + Reviewer Matcher | ✅ 已完成 | F032 (d4b85bf) |
| **B3** | SOP/Skill 模板化 | ⏸️ 待完成 | → **F042** |
| **C** | Thread Activity Tracking | ✅ 已完成 | F032 (d4b85bf) |
| **D** | System Prompt 注入 | ✅ 已完成 | F032 (d4b85bf) |

> **注意**: Phase A 在写本 spec 时误以为未实现，实际已由 F32-b 完成。
> Phase B3 (SOP/Skill 动态化) 移交至 [F042](./F042-prompt-engineering-audit.md) 统一处理。

## Problem Statement

### 现状痛点

1. **身份 = 物种 = 个体**：系统把三个概念糊在一起
   - Family（物种/厂商）：Ragdoll、Maine Coon、Siamese
   - Individual（个体）：Opus 4.5, Opus 4.6, Sonnet, Codex, GPT-5.2
   - Role（职能）：Architect, Reviewer, Designer

2. **技术侧硬编码**：
   - `CatId` 类型写死 `'opus' | 'codex' | 'gemini'`
   - `z.enum` 在路由层写死
   - `AgentService` 在 index.ts 硬编码构造

3. **协作规则硬编码**（审计发现 6+ 处）：
   - SOP.md Reviewer 配对表写死"Ragdoll ↔ Maine Coon"
   - CLAUDE.md "Ragdoll找Maine Coon，Maine Coon找Ragdoll"
   - merge-approval-gate skill "没有Maine Coon放行不能合入"
   - 所有 skill 示例只覆盖Ragdoll↔Maine Coon这一对

4. **Thread 活跃度未考虑**：
   - Codex 找 reviewer 时选 `opus`（default）而非 `opus-45`（已在 thread 活跃）
   - 现有 fallback 链：mentions → last-replier (scoped to preferredCats) → first preferred → default
   - preferredCats 是候选范围，不是派发列表（#58 design fix）
   - participants 按活跃度排序（lastMessageAt desc）

### 触发事件

- 2026-02-26：team lead指出 Codex 喊 Opus 4.6 帮忙 review 而不是负责人 Opus 4.5
- 多分身共存导致规则失效：哪个Ragdoll？哪个Maine Coon？

## Design Proposal

### 核心概念模型

```
┌─────────────────────────────────────────────────────────────┐
│                      Team Roster                            │
│  (Single Source of Truth for all cats)                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ Family:     │  │ Family:     │  │ Family:     │         │
│  │ ragdoll     │  │ maine-coon  │  │ siamese     │         │
│  │             │  │             │  │             │         │
│  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │         │
│  │ │opus-45  │ │  │ │codex    │ │  │ │gemini   │ │         │
│  │ │lead:true│ │  │ │lead:true│ │  │ │lead:true│ │         │
│  │ │roles:   │ │  │ │roles:   │ │  │ │roles:   │ │         │
│  │ │architect│ │  │ │reviewer │ │  │ │designer │ │         │
│  │ │reviewer │ │  │ │security │ │  │ └─────────┘ │         │
│  │ └─────────┘ │  │ └─────────┘ │  │             │         │
│  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │         │
│  │ │opus-46  │ │  │ │gpt52    │ │  │ │gemini25 │ │         │
│  │ │lead:false│ │ │ │lead:false│ │ │ │lead:false│ │        │
│  │ │roles:   │ │  │ │roles:   │ │  │ │roles:   │ │         │
│  │ │architect│ │  │ │reviewer │ │  │ │designer │ │         │
│  │ └─────────┘ │  │ │thinker  │ │  │ └─────────┘ │         │
│  │ ┌─────────┐ │  │ └─────────┘ │  │             │         │
│  │ │sonnet   │ │  │             │  │             │         │
│  │ │lead:false│ │ │             │  │             │         │
│  │ │roles:   │ │  │             │  │             │         │
│  │ │assistant│ │  │             │  │             │         │
│  │ └─────────┘ │  │             │  │             │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Phase A：技术侧松绑 ✅ **已由 F32-b 实现**

> **实现时间**: 2026-02-17 ~ 2026-02-21
> **实现者**: Ragdoll (Opus 4.5)
> **关键 commits**: a87afb3, d25c1a1, 5759b83, dafb5da

#### A1. CatId 类型松绑 ✅

```typescript
// packages/shared/src/types/ids.ts
export type CatId = Brand<string, 'CatId'>;  // 运行时动态，不再硬编码
```

#### A2. AgentRegistry 动态注册 ✅

```typescript
// packages/api/src/index.ts (F32-b 实现)
const agentRegistry = new AgentRegistry();
for (const id of catRegistry.getAllIds()) {
  const entry = catRegistry.tryGet(id as string);
  const { provider } = entry.config;
  // switch on provider, create service...
  agentRegistry.register(id as string, service);
}
```

#### A3. catIdSchema 动态验证 ✅

```typescript
// packages/shared/src/registry/cat-id-schema.ts
export function catIdSchema() {
  return z.string().refine(
    (id) => catRegistry.has(id),
    (id) => ({ message: `Unknown cat ID: "${id}"...` }),
  );
}
```

---

**（以下为原设计文档，保留供参考）**

<details>
<summary>原设计：Phase A 代码示例</summary>

#### A1. CatId 类型松绑（原设计）

```typescript
// Before: 编译时 Brand
type CatId = Brand<string, 'CatId'> & ('opus' | 'codex' | 'gemini');

// After: 运行时动态
type CatId = Brand<string, 'CatId'>;  // 任何有效字符串
```

#### A2. AgentRegistry 替代硬编码（原设计）

```typescript
// Before: index.ts 硬编码
const services = {
  opus: new ClaudeAgentService(),
  codex: new CodexAgentService(),
  gemini: new GeminiAgentService(),
};

// After: AgentRegistry 动态注册
const registry = new AgentRegistry();
for (const config of catConfigs) {
  const service = AgentServiceFactory.create(config);
  registry.register(config.id, service);
}
```

#### A3. z.enum 动态化

```typescript
// Before: 编译时枚举
z.enum(['opus', 'codex', 'gemini'])

// After: 运行时从配置读取
z.string().refine(id => catRegistry.has(id), 'Invalid catId')
```

### Phase B：协作规则动态化（新增 scope）

#### B1. Team Roster Schema

在 `cat-config.json` 中扩展：

```json
{
  "version": 2,
  "breeds": [...],
  "roster": {
    "opus-45": {
      "family": "ragdoll",
      "roles": ["architect", "peer-reviewer"],
      "lead": true,
      "available": true,
      "evaluation": "主架构师，深度思考能力强，但很贵！没猫粮时别找他"
    },
    "opus-46": {
      "family": "ragdoll",
      "roles": ["architect"],
      "lead": false,
      "available": true,
      "evaluation": "4.5 的新版本，快但有时不够稳"
    },
    "codex": {
      "family": "maine-coon",
      "roles": ["peer-reviewer", "security"],
      "lead": true,
      "available": true,
      "evaluation": "代码审查专家，安全意识强，反应快"
    },
    "gpt52": {
      "family": "maine-coon",
      "roles": ["peer-reviewer", "thinker"],
      "lead": false,
      "available": true,
      "evaluation": "深度思考型，但思考太慢"
    }
  },
  "reviewPolicy": {
    "requireDifferentFamily": true,
    "preferActiveInThread": true,
    "preferLead": true,
    "excludeUnavailable": true
  }
}
```

**Roster 字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `family` | string | 物种/厂商（ragdoll, maine-coon, siamese） |
| `roles` | string[] | 职能角色（architect, peer-reviewer, designer, thinker...） |
| `lead` | boolean | 是否是该 family 的负责人 |
| `available` | boolean | **是否有猫粮**！false = 不要找他 |
| `evaluation` | string | team lead对这只猫的评价（注入到队友介绍） |

#### B2. Reviewer 匹配规则

```typescript
interface ReviewerMatchOptions {
  author: CatId;
  threadId: string;
  requireDifferentFamily?: boolean;  // default: true
  preferActiveInThread?: boolean;    // default: true
  preferLead?: boolean;              // default: true
  excludeUnavailable?: boolean;      // default: true — 没猫粮的不要找！
}

async function resolveReviewer(options: ReviewerMatchOptions): Promise<CatId> {
  const roster = getRoster();
  const authorEntry = roster[options.author];

  // 0. 过滤掉没猫粮的猫（team lead 40 美刀的教训！）
  // 1. 找所有具有 peer-reviewer 角色的猫
  const candidates = Object.entries(roster)
    .filter(([id, entry]) =>
      id !== options.author &&
      entry.roles.includes('peer-reviewer') &&
      (options.excludeUnavailable !== false ? entry.available !== false : true) &&
      (!options.requireDifferentFamily || entry.family !== authorEntry.family)
    );

  // 2. 按 thread 活跃度排序（如果启用）
  if (options.preferActiveInThread) {
    const activity = await getThreadActivity(options.threadId);
    candidates.sort((a, b) =>
      (activity[b[0]] ?? 0) - (activity[a[0]] ?? 0)
    );
  }

  // 3. 优先选 lead（如果启用）
  if (options.preferLead) {
    const leadCandidate = candidates.find(([_, entry]) => entry.lead);
    if (leadCandidate) return leadCandidate[0] as CatId;
  }

  // 4. 降级：如果不同 family 没有可用的 reviewer，允许同 family 非自己的 lead
  if (candidates.length === 0) {
    const sameFamilyFallback = Object.entries(roster)
      .filter(([id, entry]) =>
        id !== options.author &&
        entry.family === authorEntry.family &&
        entry.lead &&
        (options.excludeUnavailable !== false ? entry.available !== false : true)
      );
    if (sameFamilyFallback.length > 0) {
      console.warn(`[resolveReviewer] Degraded to same-family lead: ${sameFamilyFallback[0][0]}`);
      return sameFamilyFallback[0][0] as CatId;
    }
  }

  return candidates[0]?.[0] as CatId ?? getDefaultCatId();
}
```

**降级规则（team lead确认）**：
- 优先不同 family 的 reviewer
- 如果不同 family 都没猫粮或不可用，允许降级到同 family 的 lead（非自己）
- 降级时必须 log 警告，让team lead知道

#### B3. SOP/Skill 规则模板化

**Before (SOP.md)**:
```markdown
| Author | Reviewer |
|--------|----------|
| Ragdoll (Opus) | Maine Coon (Codex) |
| Maine Coon (Codex) | Ragdoll (Opus) |
```

**After (SOP.md)**:
```markdown
## Reviewer 配对规则

1. Author 的代码必须由另一只猫 review（不得自审）
2. 优先选择**不同 family** 且具有 `peer-reviewer` 角色的猫
3. 同 thread 活跃的猫优先
4. 同 family 有多个分身时，优先选 `lead: true` 的

当前配对（自动生成，来源 cat-config.json）:
<!-- AUTO-GENERATED: reviewer-pairing-table -->
```

**Before (skill)**:
```markdown
**Core principle:** 没有Maine Coon明确放行，不能合入 main。
```

**After (skill)**:
```markdown
**Core principle:** 没有 peer-reviewer 角色的非同 family 猫明确放行，不能合入 main。
```

### Phase C：Thread 活跃度支持

#### C1. ThreadStore 扩展

```typescript
interface ThreadParticipantActivity {
  catId: CatId;
  lastMessageAt: number;
  messageCount: number;
}

interface IThreadStore {
  // 新增
  getParticipantsWithActivity(threadId: string): Promise<ThreadParticipantActivity[]>;
}
```

#### C2. AgentRouter fallback 链改进

```typescript
// Before
const participants = await this.threadStore.getParticipants(threadId);
if (participants.length > 0) return participants;

// After
const participantsWithActivity = await this.threadStore.getParticipantsWithActivity(threadId);
if (participantsWithActivity.length > 0) {
  // 按 lastMessageAt 降序
  participantsWithActivity.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  return participantsWithActivity.map(p => p.catId);
}
```

### Phase D：提示词动态注入

#### D1. 队友介绍动态化（已实现 ✅）

`buildTeammateRoster()` 已从 cat-config.json 动态读取。

#### D2. 当前 Reviewers 动态注入（新增）

在每只猫的 system prompt 顶部注入：

```markdown
## 你当前的 Reviewers

根据 cat-config.json 和 thread 活跃度，你当前可以找以下猫 review：
- @codex（Maine Coon，lead，在此 thread 活跃）
- @gpt52（Maine Coon GPT-5.2）

⚠️ 以下猫当前不可用（没猫粮）：
- @opus-45（Ragdoll）
```

### Phase E：验证可扩展性 — 接入 GPT-5.3-Codex-Spark

**目标**：证明架构可以无痛接入新猫

#### E1. 新猫画像

**GPT-5.3-Codex-Spark** — "反射弧短到像没长过，爪子一抬就能把代码挠完一轮迭代"⚡️🐾

| 属性 | 值 |
|------|-----|
| catId | `spark` |
| family | `maine-coon` |
| displayName | Maine Coon Spark |
| 定位 | Codex 的小号兄弟，专门为低延迟实时写码而生 |
| 特点 | 1000+ tokens/s 超快输出，轻量精准，适合精确点改 |
| 限制 | 128k context，文本-only，不会自动跑测试 |
| CLI | `codex -m gpt-5.3-codex-spark` |
| 头像 | `codex_iquid.png`（惊讶脸）或 `codex_box.png`（盒子猫） |

**使用场景**：
- UI 微调、函数级改动、快速问答
- "要快要频繁迭代"的任务
- 对标 Sonnet（轻量快速分身）

**与满血 Codex 的分工**：
- **Spark**：低延迟、快速迭代、精确点改
- **Codex**：长周期、复杂任务、重推理链路

#### E2. 接入配置

在 `cat-config.json` 的 `maine-coon` breed 下添加 variant：

```json
{
  "id": "spark",
  "catId": "spark",
  "displayName": "Maine Coon Spark",
  "variantLabel": "Spark",
  "mentionPatterns": ["@spark", "@缅因spark", "@codex-spark"],
  "provider": "openai",
  "defaultModel": "gpt-5.3-codex-spark",
  "mcpSupport": false,
  "cli": {
    "command": "codex",
    "outputFormat": "json",
    "defaultArgs": ["-m", "gpt-5.3-codex-spark"]
  },
  "personality": "极速互动型，反射弧短，适合快速迭代",
  "strengths": ["快速改码", "低延迟", "精确点改"],
  "avatar": "codex_iquid.png",
  "teamStrengths": "极速写码，适合 UI 微调和函数级改动",
  "caution": "128k context，不会自动跑测试"
}
```

在 `roster` 中添加：

```json
"spark": {
  "family": "maine-coon",
  "roles": ["rapid-coder"],
  "lead": false,
  "available": true,
  "evaluation": "快枪手，适合精确点改，不适合复杂任务"
}
```

#### E3. 验收标准

- [ ] `@spark` 能被正确路由到 Spark variant
- [ ] 队友介绍中出现 Spark 及其评价
- [ ] Spark 不会出现在 peer-reviewer 候选列表（roles 没有 peer-reviewer）
- [ ] 系统无任何硬编码需要修改即可运行

## Implementation Plan

| Phase | 内容 | 优先级 | 依赖 | 状态 |
|-------|------|--------|------|------|
| A1 | CatId 类型松绑 | P0 | - | 待开始 |
| A2 | AgentRegistry | P0 | A1 | 待开始 |
| A3 | z.enum 动态化 | P0 | A1 | 待开始 |
| B1 | Roster Schema + available 字段 | P1 | A1 | 待开始 |
| B2 | Reviewer 匹配规则 + 降级逻辑 | P1 | B1 | 待开始 |
| B3 | SOP/Skill 模板化 | P1 | B2 | 待开始 |
| C1 | ThreadStore 活跃度 | P2 | - | 待开始 |
| C2 | Fallback 链改进 | P2 | C1 | 待开始 |
| D2 | Reviewers 动态注入 | P2 | B2, C1 | 待开始 |
| **E** | **接入 Spark 验证** | P2 | A~D | 待开始 |

**执行顺序（team lead确认）**：A → B → C → D → E（顺序执行）

## Decisions（已确认）

### 1. Roster 放哪里？✅ 已决定

**选项 A：扩展 cat-config.json**

理由：和 breeds 放一起，单一配置源，不需要额外解析逻辑。

### 2. 降级规则？✅ 已决定

**允许同 family 非自己的 lead 降级**，特别是：
- Ragdoll没猫粮时，Maine Coon可以降级找同 family 的其他Ragdoll分身
- 必须 log 警告让team lead知道降级发生了

**`available` 字段**：team lead可以标记某只猫"没猫粮"，系统会自动排除。

> **教训**：2026-02 上周 SOP 写死了"Ragdoll ↔ Maine Coon"，Ragdoll没猫粮了Maine Coon还疯狂找他 review，烧了team lead 40 美刀 extra！

### 3. 迁移策略？✅ 已决定

Phase B3 做一次性批量替换 + 守护测试。

## Audit Report

### 硬编码问题清单（2026-02-26 审计）

| 文件 | 问题 | 严重度 |
|------|------|--------|
| SOP.md L193-199 | Reviewer 配对表写死三猫 | P1 |
| CLAUDE.md L15 | "Ragdoll找Maine Coon，Maine Coon找Ragdoll" | P1 |
| AGENTS.md L129 | "我的代码谁来 review？Ragdoll" | P1 |
| AGENTS.md L461 | "找Maine Coon review"（自我 review bug） | P0 |
| GEMINI.md L13 | "合入前必须经Maine Coon review" | P1 |
| merge-approval-gate | "没有Maine Coon放行不能合入" | P1 |
| requesting-cloud-review | "本地Maine Coon放行后" | P1 |
| 所有 skill 示例 | 只覆盖Ragdoll↔Maine Coon | P2 |

### 技术侧硬编码清单

| 位置 | 问题 | 严重度 |
|------|------|--------|
| shared/types.ts | CatId 类型写死 | P1 |
| routes/*.ts | z.enum 写死 | P1 |
| services/index.ts | AgentService 构造写死 | P1 |
| MENTION_ALIASES | 模块级常量 import 时求值 | P2 |
