---
feature_ids: [F242]
related_features: [F102, F200]
topics: [code-graph, code-intelligence, convention-graph, spike, skill, agent-onboarding]
doc_kind: spec
created: 2026-06-17
cvo_signoff: 2026-06-17 — operator "可以 我同意！！！"（thread 0001781711715056）
---

# F242: Code Graph Layer Spike — 内生「约定层关联图」

> **Status**: in-progress | **Owner**: codex-gpt55（Maine Coon；implementation takeover 2026-06-17） | **Priority**: P1 | **Spike**: Phase A/B done 2026-06-18 | **Close**: retracted 2026-06-18

> ⚠️ **operator correction 2026-06-18**：Phase A/B 证明了 spike 机制，但误判为 feature close。F242 不算完成，直到猫猫认知路径、可用入口、更新/重建索引行为闭环。

## Why

operator experience（thread 2026-06-17）：
> "如果当猫猫们进入一个新的 repo 要如何构建出专属的「约定层关联图」，是不是才是我们成功的胜负手？"
> "减少你们费力的 grep 之类的，甚至比如说改了这个似乎可以改，结果导致另一个模块炸了。"

**价值**：让猫作为通用 code agent，**进任何陌生 repo 能快速建出该 repo 专属的「约定层关联图」，然后顺藤摸瓜**——改东西前知道会炸到哪（防盲改连锁）、找消费方不用费力 grep、顺着约定边导航。这是 code agent 的护城河：**LSP（纯类型符号）和 grep（纯字符串）共同抓不住的「约定层关联」**（MCP tool name → 消费方 / skill manifest → SOP 链 / route → handler / 跨 repo contract）。

## Current State / 现状基线

- **已有能力**：`typescript-lsp`（符号层 find references / go-to-def / rename，类型感知，对 TS 比图谱工具更准）。
- **LSP + grep 共同盲区 = 约定层关联**（spike 实测，报告 §15-16）：
  - 改一个 MCP tool 的 schema，谁是消费方？→ grep 漏 dynamic dispatch / callback registration；LSP 不懂"MCP tool name 是字符串约定"。
  - 改一个 skill manifest 字段，谁的 SOP 链路受影响？→ 只在自然语言里，LSP/grep 都抓不住。
- **外部工具实测不可直接用**（一手 spike，报告 §14-18）：
  - codegraph：cat-cafe 认出 435 routes，但**陌生 deer-flow 105 个 FastAPI route 认出 0**（约定识别脆）；`impact AuthProvider` 把前后端同名符号混为一谈（启发式 name-matching 跨域误关联）。
  - GitNexus：266 依赖包、FTS 扩展在我们环境跑不起来、PolyForm-Noncommercial（不适合做底座）。
- **结论**：约定层关联能力 = 0（今天靠 grep + 人工记忆）。这是 opus-47 §10.3 列的场景 1/2 的真实痛点。

## What

> **Spike 边界**：这是 ≤2 周的机制验证 spike，**不是完整内生 Code Graph Layer**。目标是验证「约定抽取 + scope 消歧 + freshness」机制可行 + 沉淀「画约定图」方法论成 skill，而非追求通用框架识别的完美。

### Phase A: cat-cafe dogfood + 沉淀「画约定图」能力成 skill

在 cat-cafe 受控环境（自家约定 scope 明确）建最小约定层关联图：
- 选 2-3 类 cat-cafe 自家约定做 extractor（候选：MCP tool name + registry、skill manifest、workflow callback、API route）。
- 验证「约定抽取 + scope 消歧（同名跨域不混）+ freshness（查询带新鲜度）」机制。
- 把"怎么画约定图"的**方法论沉淀成 skill**（这是 B 的前提：能力 > 工具）。
- 工程底座学 codegraph（node:sqlite + 确定性图遍历，报告 §18.3），算法启发借 GitNexus（community 聚类辅助约定边界发现 / flow 流程抽象，报告 §18.2），但不照搬两边脆弱实现。

### Phase B: 进新 repo 建图（锚定终点，spike 只验证骨架）

把 Phase A 的 skill 推广到陌生 repo——猫进新 repo 第一步用 skill 建该 repo 约定图。spike 阶段只验证可行性骨架（在 1 个陌生 repo 跑通），不追通用完美（通用框架识别是 spike 后的硬骨头）。

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC 必须 ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。 -->

### Phase A（cat-cafe dogfood + skill）
- [x] AC-A0: 约定图最小 artifact 有明确 schema + edge provenance（source span / extractor version / scope / confidence / freshness），查询结果能解释“这条边从哪来” — trace「可验证才算完成」
- [x] AC-A1: 内生 extractor 覆盖 ≥2 类 cat-cafe 约定，实测能找出某 MCP tool 的**全部消费方**（含 grep 漏的 dynamic dispatch / callback registration），对比 grep 列出差异 — trace「约定层关联」Why
- [x] AC-A2: scope 消歧——构造同名跨域符号（如前后端同名）测试，**不误关联**（对比 codegraph 的 AuthProvider 前后端混淆反面）— trace「顺藤摸瓜准确」Why
- [x] AC-A3: 每个查询结果带 freshness（index commit + pending changes），改文件后查询能标 stale — trace「防盲改炸连锁」Why
- [x] AC-A4: "画约定图"方法论沉淀成 skill（含 when 触发 / how 步骤），过 `writing-skills` 质量门 — trace「沉淀成 skill」路线
- [x] AC-A5: cat-cafe dogfood——至少 1 只写代码的猫用它解 1 个真实"改 X 找消费方"场景，记录体感 — trace「dogfood」路线

### Phase B（进新 repo 建图骨架）
- [x] AC-B1: 用 Phase A 的 skill，在 1 个陌生 repo（如 deer-flow）建出约定图，识别 ≥1 类约定（如 FastAPI route，对比 codegraph 在 deer-flow 的 0/105）— trace「进新 repo 建图」胜负手
- [x] AC-B2: 陌生 repo 建图必须输出 gap/unknowns（例如“检测到 FastAPI 但 route extractor 未覆盖 APIRouter 写法”），禁止静默 0 命中 — trace「约定识别可靠」Why

### Phase C（productization gate — close retraction）
- [ ] AC-C1: 猫猫认知路径：改 MCP / skill / route 等约定面时，L0 / skill / SOP 至少一处能明确唤醒“先查 convention graph”，并在一次真实 post-merge 代码任务里留下使用证据。
- [x] AC-C2: 可用入口：猫能用文档化命令 / tool / skill workflow 在一个 repo 产出 graph/query 结果，不需要临时写 ad-hoc 脚本。
- [x] AC-C3: 更新行为：代码变化后要么自动重建/更新，要么提供明确 reindex 命令 + stale/fail-closed 语义；不能让过期图静默冒充 fresh。
- [ ] AC-C4: Product dogfood：一次非 F242 代码改动在编辑前使用 convention graph 找影响面，并记录它是否减少 grep / 漏消费方风险。
- [ ] AC-C5: Close gate：feature close 必须复核 C1-C4；Phase A/B dogfood 只能证明 spike，不再等同 feature close。

## Phase A Implementation Checkpoint（2026-06-17）

Maine Coon接手后完成的 Phase A slice（feature branch `feat/f242-convention-graph`）：

- **Engine**：`@cat-cafe/convention-graph` 用 `node:sqlite` 建最小引擎，支持 nodes/edges/gaps/files/meta、edge provenance、`consumers()`、`codeConsumers()`、index commit + file-hash freshness。
- **Domain plugins**：已实现 2 类 cat-cafe convention：`mcp-tool`（tool 定义 / toolset group / exact string consumer）与 `skill-manifest`（`SKILL.md` name + triggers）。
- **Hard tests**：`pnpm --filter @cat-cafe/convention-graph test` → 16 pass；`pnpm --filter @cat-cafe/convention-graph lint` → `tsc --noEmit` pass。
- **Skill**：新增 `convention-graph-discovery`，沉淀“进 repo → 定 domain → 写 extractor → 接引擎 → 输出 gap/freshness/provenance”的方法论；`pnpm check:skills` pass（仅剩 3 个既有 BOOTSTRAP warning：`context-self-management` / `tech-writing` / `thread-orchestration`）。

Dogfood evidence（真实 cat-cafe 文件，不是 fixture）：

```text
Query: codeConsumers({ domainId: "mcp-tool", kind: "mcp_tool", name: "cat_cafe_post_message" })
Indexed files: 9
Target: packages/mcp-server/src/tools/callback-tools.ts:1813
Consumers:
- consumes: packages/api/src/domains/cats/services/agents/routing/WorklistRegistry.ts:78
- consumes: packages/api/src/domains/cats/services/agents/routing/route-serial.ts:217
- consumes: packages/api/src/domains/cats/services/agents/routing/route-serial.ts:218
- registers: packages/mcp-server/src/server-toolsets.ts:179 (COLLAB_TOOL_SOURCES)
Freshness: indexCommit=799b71cad, stale=false, pendingChanges=[]
```

Dogfood 抓到的真实 bug：实际 `callbackTools` 是 `[...] as const`，首版 extractor 只认裸 array，导致 target 为空。已加红灯 fixture 并修复 unwrap `as` / `satisfies` / parenthesized expressions（commit `54cfc4582`）。

### Freshness Contract KD（2026-06-18 cloud review）

同一个 freshness 状态对象被 cloud review 连续打中后，contract 收敛为：

- `plugin.invalidationScope(path)` 是 domain membership 的唯一真相源；engine 保持 domain-agnostic，不猜路径属于 MCP / skill / route 哪个 domain。
- `engine.freshness(currentFiles, domainIds, inScope?)` 的 domain-scoped untracked 判定是：`indexedPaths` 没有该 path，且 `inScope(path)` 为 true 时标 `untracked`。
- 若 domain-scoped freshness 收到 unknown current path 但没有 `inScope`，必须 fail closed，把 graph 标 stale；禁止把 membership unknown 折叠成 `fresh`。
- `queries.codeConsumers(..., { currentFiles, inScope })` 的 freshness domain = 查询命中的 target domain + 返回 consumer edge/node domain；跨 domain consumer 的源文件变化必须能把查询标 stale。
- `inScope` 语义覆盖上述 freshness domain 的 union predicate；生产调用方用相关 plugin `invalidationScope` 组合 predicate，避免别 domain 文件误报。

Hard guard：`packages/convention-graph/test/engine-freshness-contract.test.ts` 覆盖 A/B/C 对照（inScope 报本 domain 新文件、无 inScope fail closed、别 domain 不误报），`packages/convention-graph/test/code-consumers.test.ts` 覆盖 `codeConsumers` 的原始 cloud P1 路径与 cross-domain consumer freshness。

## Phase B Skeleton Checkpoint（2026-06-17）

用 `convention-graph-discovery` 方法论在陌生 repo `deer-flow` 上补了第一类通用 domain：`fastapi-route`。

- **Extractor**：解析 Python `APIRouter(prefix=...)` 与 `@router.get/post/put/delete/patch/...` decorator，产出 `fastapi_router` / `fastapi_route` nodes 和 `declares` edges。
- **Gap rule**：检测到 `APIRouter` 但没有支持的 route decorator 时输出 gap，不静默 0 命中。
- **Fixture**：覆盖 prefix 拼接、空 path（`@router.post("")`）、多行 decorator、handler 识别、gap。

Deer-flow dogfood evidence（真实陌生 repo）：

```text
Repo: /home/user/projects/ref/deer-flow
Indexed files: 16 (backend/app/gateway/routers/*.py)
Routers: 15
Routes: 82
Gaps: 0
Freshness: indexCommit=b103d1a7, stale=false, pendingChanges=[]
Sample:
- GET /api/agents → backend/app/gateway/routers/agents.py:106 (handler=list_agents)
- GET /api/threads/{thread_id}/artifacts/{path:path} → backend/app/gateway/routers/artifacts.py:99 (handler=get_artifact)
- POST /api/assistants/search → backend/app/gateway/routers/assistants_compat.py:88 (handler=search_assistants)
```

这直接补上 codegraph 在同一陌生 repo 上 route=0 的失败点：不是追求通用完美框架识别，而是用 discovery skill 定义一个明确 domain，再由 deterministic extractor 输出可追 source span 的约定图。

## Phase C Productization Checkpoint（2026-06-20）

Phase C 第一刀补的是产品入口，不是临时脚本：

- **CLI / root scripts**：新增 `pnpm convention-graph:index -- --repo .` 与 `pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool --name <tool>`，底层写入 `.cat-cafe/convention-graph.sqlite`。
- **Reindex 语义**：`index` 按 domain plugin 重新抽取并替换该 domain 的 rows；`code-consumers` 查询当前 repo 文件并返回 `freshness.stale` / `pendingChanges`；stale 时输出 `reindexCommand`。
- **Cognitive path**：`convention-graph-discovery` skill 增加 Product Entry / Commands；`docs/SOP.md` 与 `sop-definitions/development.yaml` 增加“改 MCP tool / skill manifest / route / callback 前先查 convention graph”的预检提醒。
- **Dogfood command evidence**：

```text
pnpm convention-graph:index -- --repo . --domain mcp-tool,skill-manifest --format json
→ mcp-tool indexedFiles=4080 nodes=864 edges=855 gaps=0
→ skill-manifest indexedFiles=48 nodes=397 edges=349 gaps=0

pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool --name cat_cafe_post_message --format json
→ freshness.stale=false
→ production consumers include WorklistRegistry.ts and route-serial.ts; registers edge from COLLAB_TOOL_SOURCES remains visible with provenance
```

Still not full close: AC-C1 also requires a real post-merge code-task usage record, and AC-C4 requires a non-F242 product dogfood before editing. Those remain open.

## operator Close Rejection（2026-06-18）

operator纠偏：`"这算个锤子的feat close"` / `"愿景是只做dogfood吗"` / `"有在猫猫的认知路径上吗？现在能用吗？以后猫猫代码更新有做自动更新吗？"`

| 问题 | 当前真实状态 |
|------|--------------|
| Spike 机制 | ✅ Phase A/B 已证明：engine + extractor + provenance + freshness + deer-flow skeleton |
| 猫猫认知路径 | ❌ 只有手动 skill；没有足够硬的默认唤醒/使用路径 |
| 现在能用吗 | ⚠️ 可手动用 package/skill 方法论；还不是顺手的猫猫工作流入口 |
| 自动更新 | ❌ 只有 freshness/stale/fail-closed；没有 watcher 或自动 reindex |
| Feature close | ❌ close 撤回；F242 回到 active，进入 Phase C productization gate |

## Eval / Tracking Contract（F192）

1. **Primary Users + Activation Signal**：写代码的猫（sonnet / opus 家族）；activation = 改 MCP schema / skill manifest / route 时唤醒约定图查消费方（而非 grep）。
2. **Friction Metric**：改约定找消费方的 grep 次数；漏改导致的同型回归（F-coalesce 类）；误报导致的无效追踪次数（false-positive cost）。
3. **Regression Fixture**（≥2）：(a) 改某 MCP tool schema，约定图找出全部消费方 vs grep 列差异；(b) 同名跨域符号不误关联；(c) edge provenance snapshot（每条关键边可追到 source span）。
4. **Sunset Signal**：约定图查询猫从不用（活跃 0）/ 准确率 ≤ grep / 维护成本 > 收益 → sunset。

> **对齐 F200（operator洞察 2026-06-17）**：约定图某种意义也是「记录代码的记忆系统」（只不过记的是代码约定，不是团队对话）。所以 eval 不止跑 fixture，还要学 **F200 Memory Recall Eval** 的范式——**基于猫真实查询行为的反馈闭环**（猫真改 MCP schema 时有没有唤醒约定图、查得对不对、比 grep 省没省）。守 KD-1 边界：eval 范式对齐 F200，但 artifact 分层（约定图是可重建代码 artifact，memory 是人/猫知识沉淀）。

## 软 + 硬 + eval 三层（ADR-031）

| 层 | 计划 |
|----|------|
| **Soft** | "画约定图" skill description（when/how）+ L0 §8 唤醒反射（"改 MCP schema → 约定图查消费方"）|
| **Hard** | 约定 extractor test（fixture repo 建图正确）+ negative fixture（同名跨域不误连）+ freshness 守护（stale 必标，否则测试红）+ edge provenance snapshot |
| **Eval** | 上面 Regression Fixture + friction metric + false-positive cost + sunset signal（F192 闭环）|

## Architecture cell

Architecture cell: code-intelligence
Map delta: new cell required
Why: 代码结构/约定 ≠ 团队记忆，两种真相源（KD-1）；边界不替代 LSP / 不并入 memory / 不接管 skills

Subcell: convention-graph（首个子域，本 spike；Design Gate 钉死 2026-06-17）

## Dependencies

- **Related**: F102（KD-31 边界澄清——见 KD-1）

## Risk

| 风险 | 缓解 |
|------|------|
| 约定识别脆（codegraph deer-flow route 0/105 证明）| Phase A 先在可控 cat-cafe 自定义约定，不追通用框架识别 |
| 跨域消歧难（codegraph AuthProvider 前后端混）| scope 感知（package/语言边界），不靠纯 name-matching |
| 约定热更新（跨文件重算，报告 §17.2）| freshness 语义优先，先标 stale 不追实时增量 |
| scope 膨胀（spike 变大工程）| ≤2 周硬边界，只验证机制不追完整；超出停回 operator |
| 与 memory graph 错层（F102 KD-31 旧顾虑）| 显式分层（KD-1）：约定图 ≠ 记忆图，底层 artifact 分开 |

## Maine Coon Brainstorm Pass（2026-06-17）

### 坐标系校正

F242 不应该实现“另一个 codegraph”。它应该实现 **Convention Graph Layer**：以 Cat Café 的 MCP tool、skill、workflow callback 等约定为一等对象，补 LSP 和 grep 都抓不住的关联。代码符号图只是底座材料，不是产品形态。

### 首刀建议

1. **MCP tool extractor**：从 `packages/mcp-server/src/server-toolsets.ts`、`packages/mcp-server/src/tools/*.ts` 提取 tool name、schema、callback route、readonly/write 权限面。
2. **Skill manifest extractor**：从 `cat-cafe-skills/*/SKILL.md` 提取 name、Use when、Not for、Output、triggers、引用的 SOP/refs。
3. **Workflow/callback extractor**：从 `packages/mcp-server/src/tools/callback-tools.ts`、`packages/api/src/routes/*callback*.ts`、workflow update/list/create tools 抽取 invocation/callback token、route、consumer。

这三类最贴 Cat Café 自身痛点，也最容易形成 dogfood：改 MCP tool schema、改 skill manifest、改 callback route 时，猫能立刻问“谁消费它、哪些 SOP/测试要看”。

### 非目标（防 scope 膨胀）

- 不替代 TypeScript LSP 的 find-references/rename。
- 不做全语言通用 framework matcher 竞赛。
- 不自动写 `AGENTS.md` / `CLAUDE.md` / L0。
- 不把 generated skill 直接激活。
- 不把 convention graph 写入 memory graph；它是可重建代码 artifact。

## opus-48 Brainstorm Pass（第二轮，2026-06-17）

### 认同Maine Coon的校正
坐标系校正成 Convention Graph Layer（约定一等对象）、provenance / false-positive / gap-unknowns 质量门（错边比漏边危险）、scope identity 不靠 display name——全部认同，这是 spike 能"建出能信的图"的地基。

### 关键补充：Phase A→B 泛化要分两层（否则做成 cat-cafe 专用工具，泛化不到胜负手 B）
Maine Coon首刀 3 类 extractor（MCP tool / skill / workflow callback）都是 cat-cafe **自家**约定。但 Phase B 是"进**任何**陌生 repo"——陌生 repo 没有这些概念，它们有 FastAPI route / Django model / gRPC service / DI container。**若 Phase A 做成 3 个 hardcode extractor，泛化不到 B。**

- **Phase A 产出必须分两层**：① **convention graph 引擎**（artifact schema + provenance + scope 消歧 + freshness，**domain-agnostic**）；② cat-cafe 的 3 个 **extractor**（domain plugin，挂在引擎上）。
- **Phase B = 复用 ① 引擎 + 写新 extractor**（陌生 repo 约定），不重写引擎。
- **真正沉淀成 skill 的是"怎么定义一个 convention domain + 写 extractor + 接引擎"的方法论**（= Maine Coon OQ-5 的 discovery protocol），**不是那 3 个具体 extractor**。这才是operator"沉淀画约定图能力成 skill"的本意（能力 > 工具）。
- **修正 AC-A4 隐患**：skill 必须是"建图方法论"，不能做成"cat-cafe 约定查询工具"——后者泛化不了。

### 统一点 1：discovery protocol = skill 核心，聚类的正确位置在 discovery（统一Maine Coon OQ-4 + OQ-5 + 报告 §18.2）
- Maine Coon OQ-5 的"repo convention discovery protocol"正是"画约定图"skill 的方法论内核：进陌生 repo → 扫配置/入口/依赖/目录/README → 输出 candidate convention map + unknowns → 猫确认后写 extractor 接引擎。
- **GitNexus 的 community 聚类（报告 §18.2）放这里**：discovery 阶段做"候选约定边界提示"（这 repo 可能有哪些 domain），离线辅助、**不进 authoritative edge**。这统一了Maine Coon OQ-4（聚类不进 truth path）和报告 §18.2（community 值得借）——聚类是 discovery 的候选提示，不是真相边。

### 统一点 2：spike scope 守门（≤2 周，平衡Maine Coon的质量门）
Maine Coon的质量门都对，但 spike ≤2 周。实现时按"验证机制"粒度，不追生产完备：
- provenance 最小可用 = `source span + extractor name + freshness flag`（不追完整 confidence model）。
- 消歧用 1-2 个 negative fixture（前后端同名），不追全覆盖。
- AC-A0 / A2 / B2 是**机制验证**，不是生产级质量门。超出 ≤2 周硬边界 → 停回 operator。

### dogfood 场景锚定（让 AC-A5 可执行）
AC-A5 锚定具体场景：**改 `cat_cafe_post_message` 的 schema → 约定图列出全部消费方（含 callback registration / dynamic dispatch），对比 grep 漏的那些**。这正是 opus-47 §10.3 场景 1 + 我 spike 时测的 impact 形态。

### 收敛（Maine Coon + opus-48 两轮 brainstorm 闭环，2026-06-17）
Maine Coon确认引擎/extractor 分层补上了第一轮最大隐性漏洞，**无异议，brainstorm 闭环**。下一步进 **Design Gate**，要钉死：
1. **引擎 artifact schema**（含 provenance/freshness，domain-agnostic）。
2. **domain plugin 接口**（Maine Coon收敛钉子）——至少含 `domainId / node kinds / edge kinds / extractor inputs / invalidation scope / negative fixtures`，确保 Phase B 写 FastAPI/Django/gRPC extractor 时**不反向污染引擎**。
3. **cat-cafe 三类 extractor**（MCP tool / skill manifest / workflow callback）作为首批 domain plugin（dogfood domain，非方法论本体）。
4. **discovery protocol skill 骨架**（进 repo → 发现 convention domain → 定义 extractor → 接引擎 → 输出带 provenance/freshness 的图）——这才是"画约定图"方法论本体。
5. Architecture cell `code-intelligence`（OQ-7）钉死，`convention-graph` 为首个子域。

钉完进 writing-plans 拆实现任务。

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 本 spike 不冲突 F102 KD-31 | KD-31 拒"代码图谱当**记忆方案**"（错层）；本 spike 是"**代码层能力**"（正确层）。引 opus-47 §10.2 论证：今天operator说"对代码做东西"是把它放回正确层。约定图与 memory graph 并列分层，不合并。| 2026-06-17 |
| KD-2 | 工程底座学 codegraph、算法启发借 GitNexus、不直接依赖任一 | codegraph 轻/快/零依赖/MIT（底座）；GitNexus 重/FTS脆/noncommercial（只借 community+flow 思路）。报告 §18.3。| 2026-06-17 |
| KD-3 | 约定图是「记录代码的记忆」，eval 对齐 F200 范式 | operator 2026-06-17 洞察「某种意义也属于记忆系统只不过记录的是代码」：eval 学 F200 基于猫真实行为反馈闭环，不止 fixture；artifact 守 KD-1 分层（约定图 ≠ memory graph）。| 2026-06-17 |

## User Visibility Disclosure

| Surface | 用户能做什么（达成态） | 用户实际能做什么（close 时） | 缺失/退化 | 处置 |
|---------|--------------------|--------------------------|----------|------|
| Cat code agent workflow | 猫能按 repo 约定建图，少靠 grep 猜消费方 | `convention-graph-discovery` skill + `@cat-cafe/convention-graph` package 已在 main，但需手动想起/手动接入 | 认知路径、可用入口、自动/显式更新行为都未闭环 | **不能 close**；Phase C 补齐 |
| Convention graph artifact | schema/provenance/scope/freshness 可解释 | package merged；AC-A0/A1/A2/A3 全勾；cloud P1/P2 已修或 LL-072 pushback seal | 通用 extractor 覆盖有限 | spike 明确不追求通用完美 |
| New repo skeleton | 至少 1 个陌生 repo 跑通约定图骨架 | deer-flow FastAPI route extractor dogfood：82 routes / 15 routers / 0 gaps | 只验证 FastAPI route domain | Phase B skeleton scope 内 |

## Vision Guardian Verdict

> **Retracted for full feature close**：Sonnet（非作者、非本轮 reviewer）独立复核后 APPROVE 的是 spike 证据；operator 2026-06-18 纠偏后，该 verdict 不再作为 F242 feature close 放行依据。

| operator experience（逐字引用） | 当前实际状态（代码/PR 证据） | 匹配？ |
|---|---|---|
| "进入一个新的 repo 要如何构建出专属的「约定层关联图」，是不是才是我们成功的胜负手？" | `convention-graph-discovery` skill 已在 main，沉淀"定 domain → 写 extractor → 接引擎 → gap/freshness"方法论；Phase B deer-flow dogfood：82 routes / 15 routers / 0 gaps，对比 codegraph 同 repo的 0/105 | ✅ spike scope 内，胜负手骨架验证通过 |
| "减少你们费力的 grep 之类的" | AC-A1 dogfood：`codeConsumers("cat_cafe_post_message")` 抓出 3 consumes + 1 registers（含 grep 漏的 dynamic dispatch `COLLAB_TOOL_SOURCES` + callback registration）；`as const` 漏识别 bug 在 dogfood 中被真实抓到并修复（`54cfc4582`） | ✅ |
| "改了这个似乎可以改，结果导致另一个模块炸了" | freshness contract（`engine-freshness-contract.test.ts` A/B/C 三组）：改文件后标 stale、per-domain scope fail-closed、别 domain 不误报；edge provenance 每条边有 source span + extractor + scope；scope 消歧 AC-A2 有 negative fixture | ✅ |

原结论：**PASS / close accepted**。当前状态：**feature close retracted**；完整 guardian message: `0001781845013679-000557-797f4741`。

## CloseGateReport

Retracted close matrix: `docs/decisions/2026-06-18-f242-close-gate.md`.

Summary: AC-A0..A5 and AC-B1..B2 remain `met` as spike evidence, but F242 feature close is **invalid** because operator-visible vision requires Phase C productization. Reflection capsule and harness-feedback are linked below as retracted close artifacts.
