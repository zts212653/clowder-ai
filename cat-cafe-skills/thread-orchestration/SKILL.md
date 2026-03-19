---
name: thread-orchestration
description: >
  大任务的主动拆解与多 thread 并行编排。
  Use when: 任务涉及 2+ 个独立可交付子任务，需要不同猫参与、不同 thread 并行推进。
  Not for: 单一任务（直接做）、已有 thread 之间的被动协调（用 cross-thread-sync）、单 session 内 subagent 并行（CLI 内置能力）。
  Output: 子 thread 创建 + 选猫 + 各 thread 交付 + 主 thread 汇聚报告。
triggers:
  - "拆任务"
  - "分 thread"
  - "并行推进"
  - "开多个 thread"
  - "thread orchestration"
  - "任务分解"
---

# Thread Orchestration — 多 Thread 并行编排

**核心理念**：一个 thread 对应一个独立可交付的工作单元。主 thread 是指挥部，子 thread 是战场。

## 何时触发

```
任务可以拆成多个独立子任务？
  → 子任务之间有代码依赖？ → 串行（先完成依赖项）
  → 子任务独立？ → 本 skill：开 thread 并行推进
只有一个任务？ → 不需要本 skill，直接做
```

## 五步流程

### Step 1: 拆解 — 识别独立可交付单元

**判定标准**：两个子任务能否由不同猫在不同 worktree 里同时做？能 → 独立。

拆解时明确每个子任务的：
- **Scope**: 改哪些文件/模块
- **交付物**: 代码 + 测试 + 文档（具体到文件）
- **验收条件**: 怎么算完（测试绿 / lint 过 / review 通过）

### Step 2: 建 Thread — 每个子任务一个 thread

```
→ cat_cafe_create_thread(
    title: "简洁描述任务目标",
    preferredCats: ["执行猫", "review猫"]
  )
```

**命名规则**：`[优先级/批次] 动词 + 对象`
- 例："P1 功能完善：Web UI + Semantic Scholar + API 降级"
- 例："P2 工程质量：CI/CD + Linting"

### Step 3: 选猫 — 按任务性质匹配能力

| 任务性质 | 适合的猫 | 理由 |
|---------|---------|------|
| 代码实现 | 架构猫（自己）或快速编码猫 | 产出代码 |
| 代码 Review | 缅因猫系（审查专长） | 跨家族 review |
| UI/体验/文案 | 暹罗猫系（审美专长） | 设计视角 |
| 架构决策 | 布偶猫 Opus 4.5 / 缅因猫 GPT | 深度思考 |
| 确定性执行 | 狸花猫 | 零信任验证 |

**铁律**：同一子任务的实现和 review 不能是同一只猫（no self-review）。

在 thread 里发任务描述 + 分工提议。**必须包含主 thread ID**，这是子 thread 识别归属的唯一可靠来源：

```
→ cat_cafe_cross_post_message(
    threadId: "<sub_thread_id>",
    content: "## 主 Thread\nID: <main_thread_id>\n标题: <main_thread_title>\n\n## 任务描述\n...\n## 分工提议\n...\n\n⚠️ 完成后请回报主 thread，不要回报其他 thread\n@codex 请确认"
  )
```

**铁律**：每个子 thread 的**第一条消息**必须包含 `## 主 Thread` header，后续猫进入子 thread 时可据此定位汇报目标。

### Step 4: 并行执行 — Worktree 隔离

**每个 thread 的代码改动应使用独立 worktree**，避免文件冲突。

thread 内的执行遵循已有 skill：
- 写代码 → `tdd`
- 完成后自检 → `quality-gate`
- 请 review → `request-review` + `cross-cat-handoff`（五件套）
- 收到反馈 → `receive-review`

**加速手段**：thread 内可用 CLI 内置的 subagent 并行模式加速实现，但 review 必须由其他猫完成。

### Step 5: 汇聚 — 确认门禁 + 串行推进

**铁律：子 thread 达到里程碑时，必须立刻通知主 thread 并等待确认。**

#### 5a: 待 commit — 通知主 thread 等确认

子 thread 完成开发 + 自检后，**不要直接 commit**，而是：

```
→ cat_cafe_cross_post_message(
    threadId: "<main_thread_id>",     ← 从第一条消息的 ## 主 Thread 获取
    content: "## [子任务名] — 待确认 commit\n\n| 子项 | 状态 | 关键产出 |\n|------|------|---------|\n| ... | ✅ | 一句话 |\n\n验证：测试 X/X pass, lint 0 errors\n请确认是否 commit + push"
  )
```

**等主 thread 确认后再 commit。** 主 thread 可能会要求修改后再 commit。

#### 5b: 确认后 — 串行触发

如果有串行依赖（B 依赖 A），主 thread 确认 A commit 后：
1. A commit + push（或 merge 到 main）
2. 主 thread 通知 B 的子 thread："A 已合入，可以开始"
3. B 从 main 拉取 A 的改动后开工

```
A 完成 → 通知主 thread → 确认 commit → A merge
                                         ↓
                              主 thread 通知 B → B 拉 main → B 开工
```

#### 5c: 全部完成 — 汇总报告

所有子 thread 完成后，主 thread 汇总：

```markdown
## 编排汇总

| 子 Thread | 任务 | 状态 | PR |
|-----------|------|------|----|
| thread-xxx | ... | ✅ merged | #xx |
| thread-yyy | ... | ✅ merged | #yy |

下一步：[无 / 集成测试 / 部署]
```

**不要让 team lead 自己去子 thread 查进度。**

## 依赖管理

| 场景 | 处理 |
|------|------|
| 子任务完全独立 | 并行，各自 worktree |
| B 依赖 A 的产出 | A 先做，A merge 到 main 后 B 从 main 拉 |
| A 和 B 改同一文件 | 不要并行！串行处理，或重新拆分 scope |
| 多个 thread 都要改共享状态 | 走 `cross-thread-sync` 的 Claim 协议 |

## Quick Reference

```
拆解 → 建 thread → 选猫(含主 Thread ID) → 并行执行 → 待 commit 通知 → 确认 → 串行触发 → 汇总

主 thread = 指挥部（拆 + 确认 + 收）
子 thread = 战场（做 + review + 等确认）
第一条消息 = 必须含 ## 主 Thread（ID + 标题）
Worktree = 隔离（不冲突）
汇报 = 及时 + 等确认（不让 team lead 追，也不越权 commit）
```

## Common Mistakes

| 错误 | 后果 | 修法 |
|------|------|------|
| 在主 thread 里直接改代码 | 子 thread 看不到过程，审计困难 | 代码改动必须在子 thread + worktree |
| 子 thread 完成不通知主 thread | team lead 要自己查 | 完成/阻塞时立刻 cross-post 回主 thread |
| 多 thread 在同一 worktree 改代码 | 文件冲突 | 每个 thread 用独立 worktree |
| 只拉同家族猫 | 缺少多元视角 | 按任务性质跨家族选猫 |
| 拆得太细（1 个小文件 = 1 个 thread） | 编排开销 > 收益 | 相关小任务合并到同一 thread |
| 忘记在子 thread 发任务描述 | 被拉的猫不知道干啥 | 建 thread 后立刻发 scope + 分工 |
| 子 thread 第一条消息没写主 Thread ID | 猫汇报到错误的 thread | 第一条消息必须含 `## 主 Thread` header |
| 子 thread 完成直接 commit 不等确认 | team lead 失去控制权 | 待 commit 时通知主 thread 等确认 |

## 和其他 Skill 的区别

| Skill | 层级 | 方向 | 核心区别 |
|-------|------|------|---------|
| **thread-orchestration** | 跨 thread | 主动拆解 → 分发 → 汇聚 | 全生命周期编排 |
| CLI subagent 并行 | session 内 | subagent 并行（CLI 内置） | 不涉及 thread、不涉及其他猫 |
| `cross-thread-sync` | 跨 thread | 被动发现 → 通知 → 协调 | 响应式，不主动建 thread |
| `cross-cat-handoff` | 猫对猫 | 一次性交接 | 点对点，不涉及多 thread 编排 |

## 下一步

- 子 thread 内写代码 → `worktree` → `tdd`
- 子 thread 完成自检 → `quality-gate`
- 子 thread 请 review → `request-review`
- 子 thread merge → `merge-gate`
- 子 thread 之间有冲突 → `cross-thread-sync`
