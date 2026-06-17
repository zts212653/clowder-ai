---
feature_ids: [F086]
related_features: [F079, F055, F037, F038, F040, F042, F043, F046, F070]
related_decisions: [012]
topics: [collaboration, routing, mcp, multi-mention, orchestration, meta-cognition, knowledge-engineering, reflection]
doc_kind: done
created: 2026-03-08
completed: 2026-03-09
---

# F086 Cat Orchestration — 猫猫自主协作 + 元认知系统

> **Status**: done | **Owner**: 三猫

## Why

### 核心痛点（operator采访 2026-03-08 20:25-20:36）

1. **协作链路脆弱**：A2A 经常断线，猫猫间协作不流畅，断了就需要operator手动重新调度
2. **猫猫缺少元思考**：不是能力问题，是意识问题 — 猫猫不会主动想"这个我应该拉其他猫讨论"
3. **缺少元反思**：做完一个 feat 没有系统性地问"学到了什么？"，反思结果也没有沉淀到能影响未来行为的地方
4. **知识孤岛**：只有Ragdoll有 MEMORY.md，其他猫没有跨 session 记忆

operator experience：
> "其实你们经常 a2a 断线，很多时候都是我在强调和要求你们是不是这里能够找其他猫猫讨论。"
> "你们有的时候缺少这样的元思考。不是说没能力吧？"
> "我还认为我们缺少元反思逻辑。做完一个 feat 学习到了什么？沉淀呢？元认知提升呢？反思呢？"

### 知识工程体系现状（已建成 vs 缺失）

我们已有一个完整的知识工程栈（F038-F046 + F070）：

| Feature | 解决了什么 | 状态 |
|---------|-----------|------|
| F040 | 知识**在哪里** — 三层记忆（热 BACKLOG / 温 Feature 聚合 / 冷 docs） | done |
| F038 | 知识**怎么发现** — Skills 分类 + 按需发现 | in-progress |
| F042 | 知识**怎么路由** — 三层信息架构（CLAUDE.md → Skills → refs） | done |
| F043 | 知识**怎么查询** — MCP 归一化（feat_index, search_messages） | done |
| F046 | 知识**怎么守护** — 愿景守护 / 反漂移协议 | done |
| F070 | 知识**怎么移植** — Portable Governance（外部项目引导） | done |

**F086 要补的缺口**：

| 缺口 | 问题 |
|------|------|
| 猫猫**主动协作** | 不知道什么时候该拉人，工具也不够流畅 |
| **元反思循环** | 做完事不会系统性反思"学到了什么" |
| **知识沉淀** | 反思结果没有变成可复用的知识影响未来行为 |
| **跨猫可检索沉淀** | 只有Ragdoll有 MEMORY.md，其他猫缺少可检索的共享真相源 |

## What — 三个 Milestone

> **设计决策**：不一锅炖，不绑成一次交付。三段独立可验收。（codex + gpt52 共识 2026-03-08）

### M1 编排运行时 — 多重 @ + 回流路由

**目标**：最小闭环的多猫协作工具。

#### MCP 工具设计

```typescript
// cat_cafe_multi_mention
{
  targets: CatId[];           // ≤3（首版硬限制）
  question: string;           // 问题/请求内容
  callbackTo: CatId;          // 必填，回流目标
  context?: string;           // 附加上下文
  idempotencyKey?: string;    // 幂等键，防重复触发
  timeoutMinutes?: number;    // 默认 8，范围 3~20
  searchEvidenceRefs?: string[];  // M2 触发时的搜索证据
  overrideReason?: string;    // 跳过 searchEvidenceRefs 时必填
}
```

**审计 envelope**（统一记录，排查断链用）：
- `initiator` / `callbackTo` / `idempotencyKey`
- `triggerType`（哪个触发器触发的：high-impact / cross-domain / uncertain / info-gap）
- `searchEvidenceRefs[]`（先搜了什么）
- `overrideReason?`（为什么跳过搜索）

**首版约束**（codex 安全建议）：
- `targets.length <= 3`（硬限制，后续按需放宽）
- `parallel only`（sequential 延后）
- `callbackTo` 必填
- 被召唤猫禁止二次扩散（@ mention 被忽略）
- 调用频率限制 + 幂等键 + 超时回收
- **超时默认 8 分钟**，允许 3~20 分钟覆盖（超时立即进 partial/timeout，回流已有结果）

#### 回流状态机

```
pending → running → partial | done | timeout | failed
```

| 状态 | 含义 |
|------|------|
| `pending` | multi_mention 已发出，等待 targets 响应 |
| `running` | 至少一只猫已开始回答 |
| `partial` | 部分猫已回答，部分超时/失败 |
| `done` | 所有 targets 都已回答 |
| `timeout` | 超时未全部响应，已有回答回流给发起者 |
| `failed` | 全部失败（如所有猫不可达） |

**部分失败策略**：已收到的回答照常回流，未收到的标注"超时/不可达"。不阻塞发起者。

**回流载荷**：首版发原文（每只猫的完整回答），不做摘要。

#### 交互流程

```
operator @opus "帮我设计一下这个功能"
    ↓
Ragdoll思考后，需要收集意见
    ↓
调 cat_cafe_multi_mention({
  targets: ['codex', 'gemini', 'gpt52'],
  question: "这个 API 设计你们怎么看？",
  callbackTo: 'opus'
})
    ↓
三只猫各自收到消息（在 thread 里，天然透明）
  ├── codex 回答 → 自动路由回 opus
  ├── gemini 回答 → 自动路由回 opus
  └── gpt52 回答 → 自动路由回 opus
    ↓
Ragdoll收到三份回答，综合后给operator
```

#### 安全模型

| 层面 | 规则 |
|------|------|
| CLI @ | 保留 ≤2 限制（防提示词注入） |
| MCP multi_mention | **≤3 targets**（首版硬限制） |
| 被 @ 猫 | **禁止** 再 @ 其他猫（防级联广播） |
| 白名单 | 仅已注册 catId，不接受任意字符串 |
| 回流 | 自动路由回 callbackTo，不经过operator |

#### 后端改动

1. 新增 MCP tool handler `cat_cafe_multi_mention`
2. routing 层：`callbackTo: CatId` 回流标记 + 状态机
3. 防扩散：被召唤猫的 @ mention 被忽略
4. system prompt 注入："你正在回答 {发起者} 的问题，回答后会自动路由回去"
5. 可观测性：状态机变迁日志 + 超时/失败报告

### M2 元思考触发 — 先搜后问、先想后拉

**目标**：把"什么时候该拉人"从口号变成**可触发、可记录、可验证**的行为规则。

> **设计决策**：不写抽象的"要有元认知"，写成硬触发器 + 默认动作。（gpt52 建议 2026-03-08）

#### 五个触发器

| 触发器 | 场景 | 默认动作 |
|--------|------|---------|
| **A: 高影响决策** | 架构选型、API 契约、跨模块改动 | 先搜现有决策（docs/decisions/） → 再决定是否 multi_mention |
| **B: 跨领域问题** | 涉及前端/安全/性能/UX 等非自身专长 | 先搜对应领域文档 → 再 @ 对应领域的猫 |
| **C: 高不确定性** | 方案不确定、多种选择难以取舍 | 先搜历史讨论 → 再拉猫获取多视角 |
| **D: 信息不足** | 发现自己对上下文了解不够 | **先 search（messages/docs/evidence）→ 再问人** |
| **E: 新领域侦查** | 要写新代码/MCP/集成时，先摸清现有体系 | **先从 feats/README 顺藤摸瓜 → 读相关 spec/discussion → 再动手** |

#### 硬检查 + 软引导（gpt52 建议：别变流程主义）

**硬检查**（触发 multi_mention 时强制）：
- 必须携带 `searchEvidenceRefs[]`（至少 1 条搜索证据）
- 除非填 `overrideReason`（显式声明为什么跳过搜索）
- 这是唯一的强制点，不对普通工作加负担

**软引导**（Skills/提示词层面）：
- 四个触发器场景写入 Skills，作为猫猫自检参考
- 不是每次做事都要"填表"，只在触发 multi_mention 时才检查

#### 实现方式

- 更新协作类 Skills / shared-rules：加入触发器表
- feat-lifecycle Design Gate 加入"是否先搜了现状"检查
- multi_mention MCP 工具层面：缺少 `searchEvidenceRefs` 且无 `overrideReason` → 拒绝调用

### M3 反思沉淀 — 反思胶囊 + 文档关系网

**目标**：轻量反思 + 知识沉淀，让经验回到行为里。

> **设计决策**：不回到 hindsight（token 黑洞），不上向量库（首版），不做自动长摘要。（三方共识 2026-03-08）

#### 反思胶囊 Schema

> 固定字段，不自由发挥（gpt52 建议）

```yaml
capsule_id: "F086-M1-2026-03-08"
context: "M1 multi_mention 实现"
what_worked:
  - "回流状态机设计清晰，部分失败策略好用"
what_failed:
  - "首版没做 sequential，有用户场景需要"
trigger_missed:
  - "实现前没先搜 F055 的 targetCats 设计，重复造了轮子"
doc_links:
  - "docs/features/F055-a2a-mcp-structured-routing.md"
  - "docs/decisions/ADR-xxx.md"
rule_update_target:
  - "shared-rules.md: 加入'实现前先搜现有路由设计'"
  - "feat-lifecycle SKILL: Design Gate 加搜索检查"
```

#### 反思胶囊落点

- 命名：`YYYY-MM-DD-{topic}-capsule.md`
- Feature 文件只保留索引链接，不把反思正文塞回 spec（避免越滚越大）

#### 反思触发点

在 feat-lifecycle completion 的 Step 0（愿景对照）之后、Step 1（AC 打勾）之前，加入反思胶囊环节。

#### 知识图谱方向（docs/frontmatter 当图来用）

operator experience：
> "你们的知识体系完全还是可以使用我们现在的 docs 来建立，但是是否有些东西可以丢到一个轻量专门的向量库？但有个条件就是他得用处得比你们直接搜名字更快更有用。"
> "我们或许这里要存也是维护文档的 link，构建文档网络。标题、摘要，有点像 Obsidian 建立起来的图谱。甚至你们现在每个文档都有 metadata 的，其实天然就是一张网络了。"

**实现路径**：
1. 先做 `title + summary + frontmatter edges + backlinks` 的文档关系索引
2. 搜索默认仍是名字/BM25/metadata grep
3. **构建时机**：按需构建 + 本地缓存（最轻）；CI 仅做一致性检查（frontmatter/schema/link），暂不做全量重建
4. 向量库只有在实测"比直接搜名字更快更准"时再引入

#### 跨猫共享知识（降级方案）

> **设计决策**：首版不做"每只猫都有完整长期记忆"，先解决"大家能查到同一份真相源"。（gpt52 建议 2026-03-08）

- 共享的是**可检索的结构化沉淀**（反思胶囊 + 文档链接网络）
- 不是"每只猫都有 MEMORY.md"
- 先解决"大家能查到同一份真相源"，再谈个体长期记忆

#### ⚠️ Hindsight (cat_cafe_reflect) 已废弃

operator明确表示 (2026-03-08)：hindsight 反思功能**废弃**——大量 token 消耗但效果不好。
当前猫猫实际常用的是搜索类工具（search_evidence, session_search, read_session_events）。

**教训**：元反思不能走"自动生成大段反思摘要"的路（token 黑洞）。

#### 活生生的反面教材（Ragdoll自省 2026-03-08）

operator指出：Ragdoll在采访时没有先搜索了解知识体系现状就开始提问——这恰好是 F086 要解决的"元思考缺失"的活例子。

> "你自己回顾你刚刚采访的错误，你并没有先搜、先了解、高效的理解我们，然后再问再想。"

## Acceptance Criteria

- [x] AC-A1: M1/M2/M3 的完整验收条目见下方分组（本条为模板编号锚点）

### M1 编排运行时
- [x] MCP 工具 `cat_cafe_multi_mention` 可被猫猫调用
- [x] `targets <= 3` 硬限制
- [x] `parallel only`（首版）
- [x] `callbackTo` 必填
- [x] 回流状态机：pending → running → partial | done | timeout | failed
- [x] 部分失败策略：已收到回答照常回流，未收到标注超时
- [x] 回流载荷：原文（首版不做摘要）
- [x] 防扩散：被 @ 猫不能再 @ 其他猫（isActiveTarget + 409 guard）
- [x] 幂等键 + 超时回收
- [x] CLI @ 限制 ≤2 保持不变（unchanged）
- [x] 超时默认 8m（3~20m 可配），超时立即回流已有结果
- [x] 审计 envelope：initiator/callbackTo/idempotencyKey/triggerType/searchEvidenceRefs/overrideReason
- [x] 可观测性：状态机变迁日志 + 审计字段（structured log in route handler）
- [x] 上线验收指标：
  - 回流成功率 ≥ 90%（done/(done+failed) 在首 20 次调用内）
  - 超时率 ≤ 20%（timeout/total）
  - 二次扩散拦截 = 0 漏网（anti-cascade guard 409 全覆盖）
  - 平均回流延迟 ≤ timeout × 1.1（不超过设定超时的 110%）

### M2 元思考触发
- [x] 5 个触发器写入 Skills/shared-rules（高影响决策/跨领域/高不确定/信息不足/新领域侦查）
- [x] 每个触发器有默认动作（先搜 → 再决定是否拉猫）
- [x] 触发器 E "新领域侦查"：写新代码前先从 feats 顺藤摸瓜，摸清现有体系
- [x] multi_mention 调用时硬检查：缺少 searchEvidenceRefs 且无 overrideReason → 拒绝调用
- [x] 普通工作不加负担（硬检查只在触发 multi_mention 时）
- [x] feat-lifecycle Design Gate 加入"是否先搜了现状"检查
- [x] 不滥用：不是每个问题都拉全体

### M3 反思沉淀
- [x] 反思胶囊 schema 定义（6 固定字段，不允许自由散文）
- [x] feat-lifecycle completion 中触发反思胶囊
- [x] 反思结果有明确 `rule_update_target`（回写到哪个文件）
- [x] 文档关系索引（title + summary + frontmatter edges + backlinks）
- [x] 索引按需构建 + 本地缓存，CI 仅做一致性检查
- [x] 跨猫可检索：所有猫能查到同一份结构化沉淀

### 非目标（首版明确不做）
- ❌ 向量库（除非实测证明比 BM25 更好）
- ❌ 自动长摘要（hindsight 路线已废弃）
- ❌ 无限扩散 swarm（targets 上限 3）
- ❌ sequential 模式（延后）
- ❌ 每只猫都有完整长期记忆

## Key Decisions

1. **三段拆分不绑定**：M1/M2/M3 独立可验收，不一锅炖（codex + gpt52 共识）
2. **首版硬限制 targets ≤ 3**：防扩散优先于灵活性（codex 安全建议）
3. **回流发原文不发摘要**：先保真，再考虑压缩（两方共识）
4. **元思考是硬触发器不是口号**：可触发、可记录、可验证（gpt52 建议），含侦查阶段（operator补充）
5. **反思胶囊 6 固定字段**：不自由发挥，强制结构化（gpt52 建议）
6. **先 BM25 + frontmatter 图谱，不预设向量库**（operator + 两方共识）
7. **共享记忆降级**：先"可检索的共享沉淀"，不做"每猫完整 MEMORY"（gpt52 建议）
8. **F086 ≠ F037**：F086 是确定性编排+回流，F037 是自主 swarm 探索，并列不吞并（codex 判定）
9. **F079 Gap 4 与 F086 M1 不混做**：cat_cafe_start_vote 是投票扩展，multi_mention 是编排运行时，先跑通 M1 再决定 Gap 4 接入方式（gpt52 R3 建议）

## M1 Integration Design（侦查结果 2026-03-08）

> operator指示："写 MCP 时需要考虑现有 MCP 体系，从 feat 顺藤摸瓜。"

### MCP 体系集成点

| 现有组件 | 路径 | F086 如何集成 |
|---------|------|--------------|
| **collab server** | `packages/mcp-server/src/collab.ts` | `multi_mention` 注册到 collab toolset（必加载） |
| **callback bridge** | `packages/mcp-server/src/tools/callback-tools.ts` | 新增 handler，走 `callbackPost('/api/callbacks/multi-mention', ...)` |
| **callback auth** | `packages/api/src/routes/callback-auth-schema.ts` | 复用 `invocationId + callbackToken` 验证 |
| **callback routes** | `packages/api/src/routes/callbacks.ts` | 新增 `/api/callbacks/multi-mention` 端点 |
| **WorklistRegistry** | `packages/api/src/.../routing/WorklistRegistry.ts` | M1 不复用 worklist（parallel 独立调度），但需防冲突 |
| **F055 targetCats** | `callback-a2a-trigger.ts` | 被 @ 猫的回答通过 targetCats 路由回 callbackTo |
| **a2a-mentions** | `packages/api/src/.../routing/a2a-mentions.ts` | 被 @ 猫禁止二次扩散：响应中 @ mention 被忽略 |
| **SystemPromptBuilder** | `packages/api/src/.../context/SystemPromptBuilder.ts` | 注入 "你正在回答 {initiator} 的问题" 上下文 |
| **vote-intercept** | `packages/api/src/.../routing/vote-intercept.ts` | 参考模式：MCP 发起 → routing 拦截 → 状态追踪 → 结果聚合 |

### MCP 工具注册模式（遵循现有模式）

```
1. callback-tools.ts: 定义 inputSchema (zod) + handler (callbackPost)
2. server-toolsets.ts: 注册到 collab toolset
3. callbacks.ts: 后端路由 + auth 验证
4. 新增: multi-mention-orchestrator.ts (状态机 + 超时 + 回流聚合)
```

### 关键设计决策（基于侦查）

1. **放 collab server 不放 memory**：multi_mention 是协作核心工具，所有猫必须可用
2. **不复用 WorklistRegistry**：worklist 是 serial route 的线程局部状态，M1 是独立的 parallel 调度，混用会冲突。但需要注意：如果 callbackTo 猫当前在 serial route 中，回流消息不能破坏 worklist
3. **复用 F055 targetCats 做回流**：被 @ 猫回答后，通过 `targetCats: [callbackTo]` 路由回发起者，不造新轮子
4. **防扩散在 SystemPromptBuilder 注入**：被 @ 猫的 system prompt 加 "不要 @ 其他猫"，同时 a2a-mentions 解析层做硬拦截（双保险）
5. **状态机独立于 route strategy**：新增 `MultiMentionOrchestrator` 管理 pending→done 生命周期，不嵌入 route-serial/parallel

### 与现有 A2A 的关系

```
现有 A2A（文本 @）:
  猫回答 → a2a-mentions 解析 → WorklistRegistry 入队 → serial route 执行
  限制: ≤2 targets，serial only，无回流保证

F086 multi_mention（MCP 工具）:
  猫调 MCP → callback → MultiMentionOrchestrator → parallel 调度 targets
  → 每只猫回答 → targetCats 路由回 callbackTo → 聚合 → 通知发起者
  限制: ≤3 targets，parallel only（首版），有状态机保证

两者并存：文本 @ 仍然工作（向后兼容），multi_mention 是结构化升级路径
```

## Dependencies

- **Evolved from**: F079（投票系统 — 猫猫协作先例）
- **Evolved from**: F042（三层信息架构 — 知识该放哪里）
- **Evolved from**: F043（MCP 归一化 — 查询和发现）
- **Evolved from**: F046（愿景守护 — 反漂移协议）
- **Evolved from**: F070（Portable Governance — 知识移植）
- **Related**: F055（A2A MCP Structured Routing — targetCats，M1 实现前先搜这个！）
- **Related**: F037（Agent Swarm — 并列关系，不互相吞并）
- **Related**: F038（Skills 发现机制）

## Risk

- M1 中风险：回流路由是 routing 核心改动，需严格测试
- M2 低风险：主要是提示词/skills 更新，但需防止形式主义
- M3 中不确定性：反思胶囊的实际使用率待验证
- 提示词膨胀：每加一层指南都增加 prompt 长度

## Review Gate

- 跨猫 review：@codex（安全边界）+ @gpt52（架构 + 元认知视角）
- 设计评审已完成首轮（2026-03-08，见 Timeline）

## Key Decision #3: shared-rules 注入机制（Post-completion Discovery）

> 发现时机：F086 feature close 后，operator在另一线程指出"猫猫们对 shared-rules 的注入方式很疑惑——只有一个 link，他们根本不知道还有这玩意"
> 参与者：operator + gpt52（方案设计）+ opus 4.6（实施简化）
> 决策方式：operator拍板 quick fix

**问题**：`governance-pack.ts:27` 和 `CLAUDE.md` 都只写了文件路径引用 `cat-cafe-skills/refs/shared-rules.md`。猫猫启动时看不到实际内容，除非主动 `Read` 该文件。F086 M2 给 shared-rules 加了第一性原理和触发器，但注入机制没变——内容更丰富了，猫还是看不到。

**讨论收敛的方案**（gpt52 + opus 4.6 共识）：
- 三层注入：L0 常驻（原则+底线）→ L1 场景切片（按 context 选择）→ L2 按需读取
- L0 最小集合：P1-P5 + W1-W3 + Rule 10(@卫生) + Rule 12(Anti-Self-TERM)
- Phase 1 quick fix: 在 `buildStaticIdentity` 注入 L0 compact digest (~150 chars)
- Phase 2 (未来): 编译 `governance-pack.json` + L1 场景切片 + 审计字段

**实施**（quick fix）：
- `SystemPromptBuilder.ts`: 新增 `GOVERNANCE_L0_DIGEST` 常量，在身份契约后注入
- 测试 size guard 从 2500 → 2700（容纳 L0 digest 增量 ~150 chars）
- `governance-pack.ts` 不变（那是 F070 外部项目注入用的）

**放弃的方案**：
1. 全文注入 shared-rules.md — token 浪费，规则噪音
2. governance-pack 手写摘要 — 破坏 P4 单一真相源
3. 向量库检索 — 过度工程，规则不适合 embedding
