---
feature_ids: [F042]
related_features: [F032]
topics: [prompt, system-prompt, dynamic-injection, audit, a2a, identity, multi-agent, skills, knowledge-engineering]
doc_kind: spec
created: 2026-02-27
updated: 2026-03-02
---

# F042: 提示词 & Skills 系统性优化

> **Status**: done | **Owner**: Ragdoll (Opus 4.6, leader)
> **Reviewer**: Maine Coon (GPT-5.2, 方案审阅)
> **Created**: 2026-02-27
> **Decision Date**: 2026-02-28
> **Closed Date**: 2026-03-02
> **Context Recovery**: Thread `thread_mm4dj9jp0tij0ch3`, 从 2026-02-28 16:05 team lead发言开始

## Why

F042 的目标是纠正提示词与 skills 体系的系统性退化：信息架构混杂、路由不精确、compact 后身份/A2A 协议遗忘、硬编码猫名无法适配多分身。

## What

1. 定义并落地三层信息架构（Layer 0/1/2）
2. CLAUDE/SOP 瘦身，流程细节迁移到 skills
3. 技能体系从 25 合并到 15，并引入 manifest + lint 治理
4. 引入 stage 锚点与 pinned 注入，降低 compact 退化

## Acceptance Criteria

### Phase A（三层架构）
- [x] AC-A1: 三层信息架构定稿并作为团队执行基线。
- [x] AC-A2: CLAUDE.md 与 SOP.md 按“导航 + 按需加载”重构。

### Phase B（skills 重组）
- [x] AC-B1: skills 从 25 收敛至 15，触发边界可解释。
- [x] AC-B2: 每个 skill 具备 Use when/Not for/Output 的路由约束。

### Phase C（运行时守护）
- [x] AC-C1: stage 锚点 + system prompt 注入策略落地。
- [x] AC-C2: 硬编码猫名治理与 reviewer 降级策略形成统一规则。

## Dependencies

- **Evolved from**: F032（身份/角色/协作规则松绑）
- **Blocked by**: 无（后续收口毕业到 F043/F046/F049）
- **Related**: F043（MCP 归一化）/ F046（Anti-drift）/ F049（Mission 控制）

## Risk

| 风险 | 缓解 |
|------|------|
| 过度合并 skill 导致触发漂移 | 采用“过度合并检查规则”与 reviewer 双重审查 |
| 文档与 runtime 规则再次分叉 | 以 manifest 作为单一真相源并配套 lint |

## Summary

Cat Cafe 的提示词和 Skills 体系存在系统性问题：

1. **信息架构缺乏分层** — CLAUDE.md 350行百科全书 + SOP 300行手册 + 25个 skill 混杂流程/知识/参考
2. **Skills 路由不精确** — description 是文案不是分类器，三组重叠造成选择困难，"MUST 泛滥=MUST 失效"
3. **运行时退化** — 身份丢失 + A2A 协议遗忘（compact 后注入不足）
4. **硬编码猫名** — 规则写死"Ragdoll找Maine Coon"，无法适应多分身和新猫接入

本 Feature 执行**一步到位的整体优化**，不是修修补补。

---

## 1. Problem Analysis

### 1.1 四猫独立审计发现（2026-02-28 16:05 起）

| 发现者 | 核心发现 |
|--------|---------|
| Opus 4.6 | 25 skill 中真正编码专业知识的只有 ~5 个；其余是流程清单伪装的 skill。三组重叠（思考类/并行类/验证类）造成选择困难。CLAUDE.md 禁止:引导比 = 2:1 |
| Opus 4.5 | description 不是路由规则是文案——缺边界定义和产出契约。Skills 缺评测用例和反向样本 |
| Codex | 身份 + A2A 必须 pinned 常量。提出输出前软校验（身份 lint + A2A lint） |
| GPT-5.2 | 路由信号不够分类器化。Skill 和 SOP 文本漂移。提出 skill-lint + manifest + 依赖图 |

### 1.2 共识（所有猫都同意）

1. 身份必须是硬约束常量，每回合注入，不可被 compact 压缩
2. A2A 协议注入频率不足，导致能力退化
3. 硬编码猫名必须改为角色/roster 动态引用
4. Skill description 需要模板化重写（Use when / Not for / Output）
5. 需要回归测试/评测来验证改动效果

### 1.3 运行时观察

| # | 现象 | 根因 |
|---|------|------|
| R1 | Maine Coon compact 后自称"Ragdoll" | 压缩后只注入队友列表，缺"你是谁" |
| R2 | 猫猫不用 @ 协作 | A2A 协议只在 new session/compact 后注入 |
| R3 | 同族 reviewer 被 @ 后身份错位（把自己写成另一只猫/给出不可采信的“我跑过验证”） | 身份常量未每回合 pinned；review 请求缺少 identity 握手与证据纪律 |

---

## 2. 决策：三层信息架构

### 2.1 架构设计

```
┌─────────────────────────────────────────────┐
│  Layer 0：身份卡 + 路由表（常驻, ≤100行）      │ ← 每次对话都在
│  = 新 CLAUDE.md / AGENTS.md / GEMINI.md      │
├─────────────────────────────────────────────┤
│  Layer 1：Skills（按需加载, core≤150行/个）    │ ← 做到某步时加载
│  = 自包含的"工作单元"（流程+知识）              │
│  + refs/ 参考文件（模板/API 规格，按需读取）     │
├─────────────────────────────────────────────┤
│  Layer 2：manifest.yaml（路由单一真相源）       │ ← lint + 自动生成路由表
└─────────────────────────────────────────────┘
```

### 2.2 各层职责

| 层 | 内容 | 上限 | 加载时机 |
|----|------|------|---------|
| Layer 0 | 身份 + 价值观 + 路由表 + 协作规则 + 技术约束 | ≤100行 | 常驻 |
| Layer 1 (skill) | 核心知识 + 流程步骤 + quick ref + common mistakes | core≤150行 | 按需 |
| Layer 1 (refs/) | 模板、清单、API 规格 | 不限 | skill 引用时读取 |
| Layer 2 | 路由元数据 + 依赖图 + lint 数据 | N/A | 构建时 |

### 2.3 CLAUDE.md 重构（350行 → ~100行）

保留：
- 身份（~10行）
- 核心价值观（~15行，正面表述）
- 流程路由表（~15行，从 manifest 自动生成）
- 协作规则（~15行）
- 技术约束（~15行，Redis/worktree/LSP）
- 队友名册（~10行）

移出：
- 项目详细介绍 → 指向 VISION.md
- 技术栈详情 → 指向设计文档
- 详细协作规则（五件套等）→ 进入对应 skill
- 已知坑位 → public-lessons.md
- 12 条系统级准则 → 合并为"核心价值观" + 细节进 skill

### 2.4 SOP.md 瘦身（300行 → ~50行）

SOP 变成**导航图 + 例外路径**，不再是流程手册：

```
feat-lifecycle → writing-plans → worktree → tdd
    → quality-gate → request-review → receive-review
    → merge-gate → feat-lifecycle(完成验证)
```

每个节点 = 一个 skill。所有步骤细节从 SOP 移入对应 skill。

### 2.5 链式导航 + Stage 锚点

每个 skill 末尾有"下一步"指引，形成链式导航。

**断裂防护**（GPT-5.2 提出）：compact 后猫不知道自己在链的哪个位置。
- 把当前 stage 落到 **thread metadata**
- **SystemPromptBuilder 每回合注入** ≤3 行：身份 + 当前 stage + A2A 提示
- 同时解决 A2A 遗忘和身份丢失

---

## 3. Skill 合并方案（25 → 15）

### 3.1 新 Skill 列表

| # | 新 Skill | 合并来源 | 性质 |
|---|---------|---------|------|
| 1 | `feat-lifecycle` | feat-kickoff + feat-discussion + feat-completion | 流程 |
| 2 | `collaborative-thinking` | brainstorming + multi-cat-brainstorm + discussion-convergence | 方法论 |
| 3 | `writing-plans` | 精简 | 方法论 |
| 4 | `tdd` | test-driven-development（372→≤150行） | 方法论 |
| 5 | `debugging` | systematic-debugging（297→≤150行） | 方法论 |
| 6 | `quality-gate` | spec-compliance-check + verification-before-completion | 流程 |
| 7 | `request-review` | cat-cafe-requesting-review（模板→refs/） | 流程 |
| 8 | `receive-review` | cat-cafe-receiving-review | 方法论 |
| 9 | `merge-gate` | merge-approval-gate + requesting-cloud-review + finishing-branch | 流程 |
| 10 | `cross-cat-handoff` | 保留 | 协作 |
| 11 | `parallel-execution` | dispatching + subagent-driven + executing-plans | 方法论 |
| 12 | `deep-research` | deep-research-pipeline | 方法论 |
| 13 | `worktree` | using-git-worktrees 精简 | 工具 |
| 14 | `writing-skills` | 683→≤150行 | 元技能 |
| 15 | `pencil-design` | pencil-to-code + pencil-renderer | 工具 |

**降级为 refs/**：using-mcp-callbacks, using-rich-blocks, 各类模板

### 3.2 review-cycle 拆分决策（GPT-5.2 建议，已采纳）

原方案合并为 1 个 `review-cycle`（783 行压缩），GPT-5.2 指出触发时机天然不同：

| 阶段 | 触发时机 | 保留为独立 skill |
|------|---------|----------------|
| quality-gate | "我写完了" → 自检 | ✅ |
| request-review | "自检通过了" → 发出请求 | ✅ |
| receive-review | "reviewer 回复了" → 处理反馈 | ✅ |

合成一个会导致 over-trigger。触发准确性 > 数量少。

### 3.3 ⚠️ 过度合并检查规则（team lead要求）

**每合并一个 skill 时，author 必须问自己**：
> "合并后的 description 是否变成了'什么都能做'？如果一个用户说 X 和说 Y 都可能触发这个 skill，而 X 和 Y 实际需要不同的处理流程，那这个合并就是过度合并。"

**Reviewer（GPT-5.2）检查时也必须问自己同样的问题**：
> "这个合并后的 skill，在实际使用中是否会因为 description 过于宽泛而被错误触发？"

**如果答案是"是"，就拆回去。宁可多一个 skill，不要牺牲路由准确性。**

---

## 4. Skill 结构标准

### 4.1 Description 路由质量（来自知识工程研究）

```yaml
description: >
  {一句话：做什么 + 交付物}.
  Use when: {3-5 个触发场景}.
  Not for: {2-3 个排除场景，含和相似 skill 的区别}.
  Output: {产物描述}.
```

### 4.2 Body 结构（core ≤150 行）

```markdown
# {Skill Name}

## 一句话（正面表述）

## 核心知识（≤50 行）

## 流程（≤40 行，模板链接到 refs/）

## Quick Reference（决策树或表格）

## Common Mistakes（≤20 行）

## 和其他 skill 的区别（1-2 行）

## 下一步（链式导航）
```

### 4.3 manifest.yaml（路由单一真相源）

```yaml
skills:
  quality-gate:
    triggers: ["开发完了", "准备 review", "自检"]
    not_for: ["收到 review 反馈", "merge"]
    output: "Spec compliance report"
    next: ["request-review"]
    sop_step: 2
```

**lint 规则**（`pnpm check:skills` 增强）：
1. 每个 skill 必须有 triggers / not_for / output
2. `next` 指向必须存在（防孤儿）
3. 禁止硬编码猫名句柄
4. SOP step 引用与 manifest 一致

---

## 5. 三条铁律（修正版）

| # | 铁律 | 说明 |
|---|------|------|
| 1 | **Redis production Redis (sacred)** | Worktree 不碰team lead数据 |
| 2 | **同一个体不能 review 自己的代码** | 跨 family 优先但可降级到同 family 不同个体（须注明降级原因） |
| 3 | **不能冒充其他猫** | 身份是硬约束常量 |

**Reviewer 降级策略**（team lead 2026-02-28 提出）：
1. 首选：跨 family 的 peer-reviewer
2. 次选：同 family 但不同个体（codex 写 → gpt52 review）
3. 兜底：team lead review 或延迟到有猫可用

其余现有"铁律"降级为"强烈建议"。**当所有东西都是铁律时，没有东西是铁律。**

---

## 6. 实施路径

### 第一波：结构重组

1. 创建 `skills/manifest.yaml`
2. 重写 CLAUDE.md（350→~100行）
3. 瘦身 SOP.md（300→~50行）
4. 合并 skills（25→15），每个合并前执行§3.3 过度合并检查
5. 抽取参考文件到 `refs/`
6. 建立链式导航

### 第二波：质量提升

1. 每个 skill 的 description 按 §4.1 模板重写
2. 去除所有硬编码猫名
3. 添加 evals 测试用例
4. 实现 skill-lint 自动检查
5. 正面引导重写（"不要做 X" → "做 Y"）

### 第三波：运行时（依赖代码改动）

1. SystemPromptBuilder pinned 注入块（身份 + stage + A2A）
2. Thread metadata stage 字段
3. 回归测试（≥10 条对话场景）
4. **验收用例：同族 reviewer 被 @ 时必须先 identity check，否则视为无效 review**（同时禁止“未贴输出摘要”的伪验证声明）

---

## 7. Context Recovery

如果上下文压缩后丢失本文决策的记忆：

1. **读本文件**: `docs/features/F042-prompt-engineering-audit.md`
2. **原始讨论**: Thread `thread_mm4dj9jp0tij0ch3`，从 **2026-02-28 16:05** team lead发言开始

---

## 8. Graduation Map（剩余项去向）

F042 核心交付完成后，剩余的实施项按知识工程栈归属毕业到上层 Feature：

| 原 F042 项目 | 毕业去向 | 理由 |
|---|---|---|
| 硬编码猫名清理（10 files） | **M1 收尾**（Maine Coon执行） ✅ Done | 纯清理，不涉及架构决策 |
| skill-lint CI gate（`pnpm check:skills`） | **F046 Phase B (B4)** | Lint = 漂移防护 |
| Thread metadata + stage | **F043 Phase A** | 线程上下文持久化 = MCP memory 职责 |
| ≥10 条对话场景回归测试 | **F046 Phase B (B5)** | 回归测试 = 愿景守护运行时验证 |
| 同族 reviewer identity check gate | **F046 Phase B (B6)** | 流程执行守护门禁 |
| ~~`feat/f042-routing-policy-scopes` 分支~~ | ~~F049 Phase B~~ **修正：已作为 F042 交付物合入** | PR #148 (`b0cadb6a`) 2026-03-02 合入 main |

---

## 9. Deliverables Summary

### 已交付

| 交付物 | 证据 |
|--------|------|
| Skills 合并 25→15 | manifest.yaml + 15 个 SKILL.md |
| manifest.yaml 路由真相源 | `cat-cafe-skills/manifest.yaml` |
| 链式导航 15/15 | 每个 SKILL.md 有 `## 下一步` |
| refs/ 抽取 | `cat-cafe-skills/refs/` |
| Description 模板化重写 | Use when / Not for / Output 格式 |
| Identity pinned 注入 | PR #127 (`2e652d2a`) |
| Active participant hint | PR #120 (`ed21e3c7`) |
| Skill frontmatter 规范化 | PR #132 (`17053aa4`) |
| Skill mounts 稳定化 | PR #129 (`968301ea`) |
| Symlink 修复 | PR #121 (`21f4f47c`) |
| Thread-scoped routing policy | PR #148 (`b0cadb6a`) |

### 已合入 PR

| PR | Commit | 说明 | 日期 |
|----|--------|------|------|
| #114 | — | F042 首批 skill 重组 | 2026-03-01 |
| #120 | `ed21e3c7` | Active participant hint per-invocation | 2026-03-01 |
| #121 | `21f4f47c` | 20 broken symlinks → 12 new skill links | 2026-03-01 |
| #127 | `2e652d2a` | Pin identity + A2A reply target | 2026-03-01 |
| #129 | `968301ea` | Stabilize skill mounts + manifest metadata | 2026-03-01 |
| #132 | `17053aa4` | Normalize skill frontmatter + align skills API metadata | 2026-03-01 |
| #148 | `b0cadb6a` | Thread-scoped routing policy by scope | 2026-03-02 |

---

## Discussion Trace

```
BACKLOG F042（入口）
  └→ 本文件（spec + 完整决策）
      ├→ Thread thread_mm4dj9jp0tij0ch3 16:05+（第二轮四猫审计）
      ├→ F032-agent-plugin-architecture.md（技术侧）
      └→ packages/shared/src/cat-config.json（roster 事实源）
```
