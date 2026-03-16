---
feature_ids: []
topics: [directory, hygiene, anti]
doc_kind: decision
created: 2026-02-26
---

# ADR-010: 目录结构防腐化机制

> 日期：2026-02-13
> 状态：**已批准** — 三方 + GPT Pro 对齐完毕，待执行
> 参与者：Ragdoll（方案设计）、Maine Coon（reviewer 视角 + 硬规则）、铲屎官（发起人）、GPT Pro（外部评审）

## 背景

2026-02-13 铲屎官发现 `packages/api/src/domains/cats/services/` 堆积 70 个 .ts 文件，6 种不同职责混在一个扁平目录里。`docs/` 也有 270 个文件，从未系统归档。

根因：增量开发无决策压力 + 无早期报警机制 + 代码规范只管文件大小不管目录大小。

## 决策

### 防腐化机制（先于重构落地）

#### A. 目录文件数双阈值 + 自动检测

- **warn: 15 个 .ts 源文件** — 触发后必须在 commit message 写"为什么不拆"
- **error: 25 个 .ts 源文件** — 必须拆，除非走例外机制
- 不计入：index.ts、*.d.ts
- 实现：`scripts/check-dir-size` + pre-commit hook + `pnpm check:dir-size`

#### B. 目录结构规范写入 CLAUDE.md / AGENTS.md

新增代码规范第 7 条 + 系统级协作准则第 11 条。

**拆目录的理由白名单**（只允许这三种理由新建子目录）：
- 职责明显不同（持久化 vs 业务编排 vs 外部 provider）
- 依赖方向不同（接口层 vs 实现层）
- 生命周期不同（实验性 / 迁移期 / 废弃期）

#### C. Review 增加架构卫生检查

大模块改动（5+ 新文件 或 新建子目录）必须检查：
- 新文件是否放在语义匹配的目录
- 有没有目录超过 warn 阈值
- 是否附带目录结构说明

#### D. 定期架构卫生检查

绑定到 Phase/Feature 完成节点，不是固定日历。

#### E. 依赖边界 lint

- ~~先上 eslint-plugin-boundaries~~ → **改用 dependency-cruiser 统一处理**（2026-02-17 决策变更）
  - 原因：项目已迁移到 Biome（替代 ESLint），仅为 boundaries 插件引入 ESLint 生态得不偿失
  - dependency-cruiser 独立工作（不依赖 ESLint），同时覆盖循环依赖检测 + 跨目录边界检查 + 依赖图可视化
  - 配置：`.dependency-cruiser.cjs`，命令：`pnpm check:deps`

#### F. 例外机制

- 例外必须显式登记（`.dir-exceptions.json`）
- 必须包含 `owner` + `expiresAt`
- 过期自动报错，不允许永久豁免

#### G. AI 结构保洁员规则

AI 新增文件时必须：
1. 检查目标目录是否已超 warn 阈值
2. 更新模块顶层 README（如果新增了新职责）
3. 若触发 warn，在 commit message 说明理由

#### H. 兼容导出控毒

- 重构后旧 index.ts 保留 re-export，过渡期 2 周
- 兼容层禁止引入新逻辑
- 新代码禁止 import 旧路径（review 检查）
- 到期后删除兼容导出

### 目录重构方案：方案 A（就地整理）

```
domains/cats/services/
├── agents/
│   ├── providers/       # ClaudeAgentService, CodexAgentService, GeminiAgentService
│   ├── routing/         # AgentRouter, route-strategies
│   └── invocation/      # invoke-single-cat, stream-merge, InvocationTracker
├── stores/
│   ├── ports/           # Store 接口 (MessageStore, ThreadStore...)
│   ├── redis/           # Redis 实现 + keys
│   └── factories/       # *StoreFactory
├── auth/                # AuthorizationManager, AuthorizationRuleStore, etc.
├── context/             # ContextAssembler, SystemPromptBuilder, McpPromptInjector, IntentParser
├── orchestration/       # ModeOrchestrator, DegradationPolicy, HindsightClient, EventAuditLog
├── modes/               # 已有，保留
├── session/             # SessionManager
├── types.ts
└── index.ts             # 兼容导出（过渡期 2 周后删）
```

### docs 归档方案

```
docs/
├── active/              # 当前进行中
│   ├── feature-specs/
│   ├── review-notes/
│   ├── feature-discussions/
│   ├── bugs/
│   └── research/
├── internal-archive/             # 已完成/已关闭，按月归档
│   └── 2026-02/
├── decisions/           # ADR（已有，不动）
├── phases/              # Phase 设计文档（不动）
├── tasks/               # 猫猫任务表（不动）
└── README.md            # 导航入口
```

增量迁移，不做一次性大搬家。

### 执行顺序

1. **先规则门禁**：CLAUDE.md/AGENTS.md 规范 + lint 脚本 + eslint-plugin-boundaries
2. **后目录重构**：按方案 A 拆分 services/ + docs 归档
3. **再清理兼容层**：2 周过渡期后删除旧 re-export

### 不做的事

| 方案 | 不做理由 |
|------|----------|
| DDD 分层（方案 B） | 对当前规模太重，短期收益不如方案 A |
| 代码生成器/脚手架 | 3 猫团队暂不需要 |
| CODEOWNERS 文件 | 代码基本一人写，目前意义不大 |
| PR 模板 | 我们不走 GitHub PR 流程 |
| 后端测试搬到源码旁边 | .test.js 搬家是另一个大改动，不混着做 |

## 三方意见记录

### Ragdoll（方案设计者）
- 根因分析：温水煮青蛙 + 规范盲区 + 缺重构 checkpoint
- 原始方案 ABCD → 综合后扩展到 A-H
- orchestration/ 命名保留（和 ModeOrchestrator 一致）
- 例外清单放 `.dir-exceptions.json`（离代码近，方便 lint 读取）

### Maine Coon（reviewer 视角）
- **核心痛点**：不是文件多，而是"边界不清导致改动扩散不可预测"
- **硬规则要求**：(1) 拆目录理由白名单 (2) 例外 owner+expiresAt (3) 兼容导出控毒
- **依赖边界 lint 是必须的**：拆目录不拆耦合 = 假整理
- **补充**：docs 归档做增量迁移，不做一次性大搬家
- **同意**：方案 A、warn 15/error 25、JS Boundaries 先上
- **Open Question 1**：orchestration/ 还是 coordination/？→ Ragdoll判断保留 orchestration/
- **Open Question 2**：例外清单放哪？→ Ragdoll判断放 .dir-exceptions.json + decisions/ 记 ADR

### GPT Pro（外部评审）
- **新增盲点**：猫砂盆目录风险、例外机制、目录所有权、兼容层毒性控制
- **阈值建议**：warn 15 / error 25-30（三方采纳）
- **工具建议**：JS Boundaries 先上，dependency-cruiser 做 CI 终检（三方采纳）
- **目录拆分**：提供方案 A（就地整理）和方案 B（DDD），三方选 A
- **docs 归档**：active/archive 分层（三方采纳）
- **名言**："归档不是搬文件，是减少活跃目录的噪声密度"
- **AI 建议**："AI 写代码很快，结构腐化也会很快" → AI 结构保洁员规则

## 相关文档

| 文档 | 用途 |
|------|------|
| 方案初稿 (internal) | Ragdoll初始 ABCD 方案 + 影响分析 |
| 开放讨论邀请 (internal) | 给Maine Coon的讨论邀请 |
| 进展更新 (internal) | F8/F12 状态更新 + docs 膨胀 |
| GPT Pro 综合判断 (internal) | 三方意见综合 + 5 个确认项 |
| GPT Pro 评审 prompt (internal) | 发给 GPT Pro 的完整 context |
| GPT Pro 评审回复 (internal) | GPT Pro 完整回复 |

## 后果

- 重构会改变 `services/` 下所有文件的 import 路径
- 需要更新 86 个后端测试文件的 import
- 兼容导出层保证 2 周过渡期内旧路径不断裂
- 防腐化机制长期运行，预期降低目录腐化速度 80%+
