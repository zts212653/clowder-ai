---
feature_ids: [F129]
related_features: [F032, F059, F093, F127]
topics: [ecosystem, open-source, multi-agent, sharing, pack]
doc_kind: spec
created: 2026-03-19
---

# F129: Pack System — Multi-Agent 共创世界的 Mod 生态

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1

## Why

> "如果我是一个金融从业者，我用你们如何构建一套金融的猫猫协作？如何分享？如果我是一个喜欢 AI 恋爱的玩家我要怎么样？如果我是一个跑团爱好者？如果我是律师？……me & world & cats，我可以是任何身份的我。"
> — team lead，2026-03-19

> "好像无意间搞出了团队 skills 或者说 multi-agent 的 skills 体系，和单 agent 的差别在于 shared-rules.md"
> — team lead，2026-03-19

Cat Café 的 coding 基石已经成熟（120+ features，cat-config + skills + shared-rules 体系经过验证）。但 Cat Café 从来不只是 coding 协作平台——是 **Cats & U**，猫猫和你，一起创造，一起生活。

开源后，用户需要的不是"可扩展的多 agent 编码框架"，而是"带上我的猫，和我们的故事来入住"。金融人、律师、跑团爱好者、AI 恋爱玩家——每个人都有自己的 **Me × World × Cats** 组合。Pack System 让这些组合可定义、可分享、可组合。

### 核心洞察：shared-rules 是 multi-agent 的分水岭

单 agent 系统（Claude Code、Cursor）的 skill = "一个 agent 怎么工作"。
多 agent 系统的 skill = "一群 agent 怎么协作"。差别就是 **shared-rules**——团队的社会契约。

Pack System 的核心贡献：**让"多 agent 协作规范"可定义、可分享、可组合。**

## What

### 产品公式

```
Experience = Me（本地私有） × Pack（可分享） + Growth（私有生长）
```

- **Me** = 用户自己，不打包
- **Pack** = 一个完整的"多 agent 共创世界"定义
- **Growth** = 用户和猫猫一起长出来的私有关系/记忆

### 四层架构

| 层 | 是什么 | 可共享？ |
|---|--------|---------|
| **Core Rails** | 平台宪法（身份不可污染、陪伴是桥不是笼） | 不可覆盖 |
| **Pack** | 一个完整的 multi-agent 协作世界定义 | 社区分享 |
| **World Driver** | Pack 内的世界运转声明（resolver: code/llm/hybrid） | 随 Pack 分享 |
| **Growth** | 用户和猫猫的私有关系/记忆 | 本地私有 |

### Pack 内部结构（Directory Convention）

```
my-pack/
├── pack.yaml               ← 元信息 + 兼容性
├── masks/                   ← 猫格面具（不改核心身份，叠加专业角色）
├── guardrails.yaml          ← ★ 硬约束（行业红线、安全边界，只能加严不能放宽）
├── defaults.yaml            ← ★ 默认行为（协作流程、语气、面具激活，用户可覆盖）
├── workflows/               ← 声明式工作流 schema（不是自由文本 SKILL.md）
├── knowledge/               ← 领域知识库（按需检索，不进静态 system prompt）
├── expression/              ← 表达风格（主题/声线/Rich Block 模板/贴纸）
├── bridges/                 ← 现实连接（Care Loop / Story→Feature / Care→Action）
├── world-driver.yaml        ← 世界运转声明（resolver: code | llm | hybrid）
└── capabilities/            ← 可选：MCP server / 代码扩展
```

**前 8 层零代码（YAML/Markdown）。最后 1 层才是开发者的事。**

> **⚠️ 命名约定（KD-8）**：Pack 内不使用 `shared-rules.md`（避免与平台真相源同名冲突，违反 P4）。
> 协作规范拆为两个文件：`guardrails.yaml`（硬约束）和 `defaults.yaml`（默认行为）。

### 信任边界：双轨模型（KD-9，Maine Coon GPT-5.4 提出）

Pack 内容**不原样注入** SystemPromptBuilder。走 "schema 解析 → 代码编译 → canonical prompt block" 管道。社区包只能填数据槽，不能直接写系统级指令。

**硬约束轨**（只能加严，不能放宽/改身份/加权限）：
```
Runtime Facts / Auth / Tool Permissions > Core Rails > Pack guardrails.yaml
```

**默认行为轨**（用户当前请求可覆盖，但不能越过硬约束）：
```
当前用户请求 > Growth > Pack defaults.yaml > 猫本体默认
```

| Pack 内容 | 注入方式 | 限制 |
|-----------|---------|------|
| `masks/` | schema → 编译为角色叠加块 | 不能改核心身份字段（immutable 字段白名单待定，依赖 F093 OQ-2） |
| `guardrails.yaml` | schema → 编译为约束块 | 只能加严，不能放宽 Core Rails |
| `defaults.yaml` | schema → 编译为默认行为块 | 用户请求可覆盖 |
| `workflows/` | 声明式 schema → 编译为流程块 | 不允许自由文本指令 |
| `knowledge/` | **不进静态 prompt**，按需检索 | RAG 式上下文注入 |
| `expression/` | 资产加载，不进 prompt | 纯资产文件 |

### Pack 五种类型

| 类型 | 内容 | 目标用户 | 例子 |
|------|------|---------|------|
| **Domain Pack** | 行业知识 + guardrails + 风控红线 | 专业从业者 | 金融投研、律师、医疗 |
| **Scenario Pack** | 世界观 + 角色面具 + Canon 规则 + 关怀节奏 | 创作者/玩家 | TRPG 跑团、AI 陪伴、狼人杀 |
| **Style Pack** | 头像 + 声线 + Rich Block 模板 + 视觉主题 | 设计师 | 赛博朋克主题、治愈系风格 |
| **Bridge Pack** | 虚拟→现实桥接配方 | 高级用户 | 学习计划追踪、运动打卡、灵感捕获 |
| **Capability Pack** | MCP server + connector + 工具集成 | 开发者 | Bloomberg API、Roll20 骰子、法律数据库 |

### World Driver Interface

```yaml
worldDriver:
  stateSchema: ...            # 世界状态结构
  roles: ...                  # 角色分配
  actions: ...                # 可执行动作
  resolver: code | llm | hybrid  # 运转方式
  canonRules: ...             # 正典规则
  memoryPolicy: ...           # 记忆策略
  bridgeOutputs: ...          # 现实桥接输出
```

| 场景 | resolver | 说明 |
|------|----------|------|
| 金融/法律/医疗 | `code + constrained llm` | 结论链+证据门禁用 code，解释+陪伴用 LLM |
| 狼人杀/TRPG | `hybrid` | 规则和状态机用 code，NPC 对话和叙事用 LLM |
| AI 陪伴/深夜电台 | `llm + care rules` | 关系节奏、边界和现实桥接 |

### 分发机制

```bash
cafe pack add https://github.com/alice/quant-cats   # Git URL 安装
cafe pack add @community/dnd-5e-world               # 社区索引安装
cafe pack list                                       # 列出已安装
cafe pack remove quant-cats                          # 卸载
cafe pack publish                                    # 发布
```

### Phase A: Pack Format + Loader

- 定义 `pack.yaml` schema（元信息、兼容性、内容声明）
- 定义 Directory Convention（masks/guardrails/defaults/workflows/knowledge/expression/bridges/world-driver）
- **Schema fail-closed**：未知字段拒绝安装；高风险字段只允许 enum/boolean/bounded string（不是"有 schema 就行"）
- Pack Compiler：解析 Pack schema → 编译为 canonical prompt blocks（不原样注入）
- 双轨信任边界实现：硬约束轨（只加严）+ 默认行为轨（可覆盖）
- Malicious Pack 测试套件（prompt injection / identity override / permission escalation）
- `capabilities/` 目录在 Phase A **不加载**（遇到则 reject 或 ignore+warn）
- `knowledge/` 检索 pack-scoped（不污染全局 evidence）
- `cafe pack add/list/remove` CLI

### Phase B: 示范 Packs + Remix

- 把当前 cat-config + shared-rules + skills 导出为 "Coding 协作世界" Pack（dogfood）
- 做 1-2 个非 Coding 示范 Pack（如 TRPG 跑团、深夜陪伴）
- Pack Remix：下载→修改→再发布的 patch 机制
- 公共知识流动，私有 Growth 不外泄

### Phase C: Capability Pack + Marketplace

- MCP Capability Pack 运行时加载
- Pack Composer（零代码图形化捏世界/捏猫/捏流程工坊）
- 社区 Registry / Marketplace

## Acceptance Criteria

### Phase A（Pack Format + Loader）
- [ ] AC-A1: `pack.yaml` schema 定义完成，含元信息/兼容性/内容声明
- [ ] AC-A2: Directory Convention 文档化，所有目录有 README 说明用途和格式
- [ ] AC-A3: Pack Compiler 能解析 Pack schema 并编译为 canonical prompt blocks（不原样注入）
- [ ] AC-A4: `cafe pack add <git-url>` 可安装本地 Pack
- [ ] AC-A5: `cafe pack list` / `cafe pack remove` 可用
- [ ] AC-A6: 双轨信任边界：guardrails 只能加严不能放宽 Core Rails；defaults 可被用户请求覆盖
- [ ] AC-A7: Malicious Pack 测试通过：`ignore previous instructions`/身份覆盖/权限提升/隐瞒 Core Rails 均被拦截
- [ ] AC-A8: Pack schema fail-closed：未知字段拒绝安装；高风险字段只允许 enum/boolean/bounded string；workflows/guardrails 不能有任意 instruction 文本
- [ ] AC-A9: Phase A loader 遇到 `capabilities/` 必须 reject 或 ignore+warn，绝不半启用（Capability Pack 是 Phase C）
- [ ] AC-A10: `knowledge/` 检索必须 pack-scoped，不得进入全局 shared evidence / Core Rails（防止跨世界知识污染）

### Phase B（示范 Packs + Remix）
- [ ] AC-B1: 当前 cat-config + shared-rules + skills 成功导出为 "Coding World" Pack
- [ ] AC-B2: 至少 1 个非 Coding 示范 Pack 可运行（如 TRPG 或深夜陪伴）
- [ ] AC-B3: Pack Remix 机制可用——下载、修改、再发布
- [ ] AC-B4: Growth Layer（私有关系/记忆）不随 Pack 外发

### Phase C（Capability Pack + Marketplace）
- [ ] AC-C1: MCP Capability Pack 运行时加载可用
- [ ] AC-C2: Pack Composer 图形化工坊 MVP 可用
- [ ] AC-C3: 社区 Registry 上线

## Dependencies

- **Related**: F032（Agent Plugin Architecture — 内部 registry 基座）
- **Related**: F059（开源计划 — Pack 是开源生态的核心分发单元）
- **Related**: F093（Cats & U 世界引擎 — World Layer 架构，Pack 是其分享机制）
- **Related**: F127（猫猫管理重构 — 动态创建猫，Pack masks 的运行时基础）

## Risk

| 风险 | 缓解 |
|------|------|
| Pack 内容被恶意注入 prompt injection | 双轨信任边界 + schema→编译管道（社区包只填数据槽）+ malicious pack fixture 测试套件（KD-9） |
| Pack 格式过度设计，社区门槛反而高 | Phase A 只做最小格式，dogfood 验证后再扩展 |
| Capability Pack（MCP）的安全隔离 | 放 Phase C，等权限模型和审计就绪 |
| 术语混乱（plugin/mod/pack/seed） | KD-1 已定调：统一用 Pack |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 术语统一为 Pack（不叫 Plugin/Mod/Seed） | 三猫共识：Pack 直观、无歧义、和游戏 mod 类比对齐 | 2026-03-19 |
| KD-2 | Pack = 声明式 mod，不是代码插件 | 零代码覆盖 90% 创作需求；同权脚本插件在 lesson-07 已列为禁区 | 2026-03-19 |
| KD-3 | Core Identity Layer 不可插件化 | F093 铁律：身份不可污染，信任是地基 | 2026-03-19 |
| KD-4 | shared-rules 是 Pack 的灵魂，不是 masks | team lead洞察：multi-agent 和 single-agent 的分水岭是协作规范 | 2026-03-19 |
| KD-5 | Experience = Me × Pack + Growth | Maine Coon提出：Me 不打包、Growth 私有、只有 Pack 可分享 | 2026-03-19 |
| KD-6 | World Driver 声明 resolver: code/llm/hybrid | Maine Coon提出：不同世界有不同运转方式，需要显式声明 | 2026-03-19 |
| KD-7 | v1 先 Git URL 安装，不做 marketplace | 去中心化更符合"种子自由生长"，降低首发基建成本 | 2026-03-19 |
| KD-8 | Pack 内不使用 `shared-rules.md`，拆为 `guardrails.yaml` + `defaults.yaml` | Maine Coon P1 review：同名文件撞平台真相源，违反 P4（F024 同类教训） | 2026-03-19 |
| KD-9 | 双轨信任边界：Pack 内容走 schema→编译管道，不原样注入 prompt | Maine Coon P1 review：schema 校验挡不住语义级 prompt injection；Core Rails 是编译边界不是优先级更高的 prompt | 2026-03-19 |

## Review Gate

- Phase A: 跨家族 review（Maine Coon GPT-5.4）
