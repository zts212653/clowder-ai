---
name: thread-orchestration
description: >
  大任务的主动拆解与多 thread 并行编排。
  Use when: 任务涉及 2+ 个独立可交付子任务，需要不同猫参与、不同 thread 并行推进。
  Not for: 单一任务（直接做）、已有 thread 之间的被动协调（用 cross-thread-sync）、单 session 内 subagent 并行（CLI 内置能力）、发现跨 scope 问题但已有归属 thread（用 cross_post_message，不要新建 thread）。
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
发现跨 scope 的问题/信息？
  → 先 list_threads keyword=<关键词> 查有没有已有 thread
  → 有已有 thread → 不要新建！用 cross_post_message 投递（cross-thread-sync skill）
  → 没有已有 thread + 需要独立追踪 → 本 skill：propose_thread

任务可以拆成多个独立子任务？
  → 子任务之间有代码依赖？ → 串行（先完成依赖项）
  → 子任务独立？ → 本 skill：开 thread 并行推进
只有一个任务？ → 不需要本 skill，直接做
```

> **F128/F193 环**（KD-E4）：`propose_thread`（新建）和 `cross_post_message`（投递）是一个环。
> 默认走投递（`cross_post_message`），只有确认没有已有 thread 时才走新建（`propose_thread`）。
> 新建 thread 的阈值高于投递——新建会增加operator的认知负担。

## 五步流程

### Step 1: 拆解 — 识别独立可交付单元

**判定标准**：两个子任务能否由不同猫在不同 worktree 里同时做？能 → 独立。

拆解时明确每个子任务的：
- **Scope**: 改哪些文件/模块
- **交付物**: 代码 + 测试 + 文档（具体到文件）
- **验收条件**: 怎么算完（测试绿 / lint 过 / review 通过）

### Step 2: 提议 Thread — 每个子任务一个提议（用户审批后才创建）

**重要：cat 不直接创建 thread。** 调用 `cat_cafe_propose_thread` 创建一个**提议卡片**，等用户在 source thread 里点"批准"，后端才真正创建 thread。

```
→ cat_cafe_propose_thread(
    title: "简洁描述任务目标",
    reason: "为什么这个子任务值得自己一个 thread（必填）",
    preferredCats: ["执行猫", "review猫"],
    projectPath: "/abs/path/to/repo",  // 当前 thread 是 default/未分类/eval/lobby 且子任务要做 repo 实现时必填
    reportingMode: "final-only"  // 可选回报契约: none/final-only(默认)/state-transitions/blocking-ack，见下表
  )
```

**返回值**：`{ proposalId, status: "pending" }` —— **不是 threadId**。Thread 还未存在，不要尝试 `cross_post` 到一个尚未批准的 proposal。

**命名规则**：`[优先级/批次] 动词 + 对象`
- 例："P1 功能完善：Web UI + Semantic Scholar + API 降级"
- 例："P2 工程质量：CI/CD + Linting"

**提议后**：继续主 thread 的工作，等用户批准。批准后用户会在新 thread 里出现，此时再 cross_post 给被分配的猫。

#### projectPath — 项目归属

不传 `projectPath` = 继承当前/parent thread 的项目。若当前 thread 本身是 `default` / 未分类 / eval / lobby，而子 thread 要做 repo 或实现工作，必须显式传绝对路径；只有纯 eval/meta/无需项目归属的 thread 才可留空并进入未分类。

#### reportingMode — 回报契约分型（F128 Phase Y → Phase AA）

决定子 thread 是否/如何回报主 thread。**不传 = `final-only`（做完把结果带回来）**。

> **Phase AA 更新（2026-06-07）**：默认从 `none` 改为 `final-only`。大多数 propose 是"开一个子 thread 做事，做完把结果带回来"。选择模式前先问自己：**这个子 thread 做完后，源 thread 是否需要结果回来？**

| Mode | 语义 | 何时用 |
|------|------|--------|
| `final-only`（**默认**） | 子 thread 自治，**完成时**回报一次 summary | Feature work fork / 大多数情况——要最终结果、不要过程噪音 |
| `none`（autonomous，显式 opt-in） | 球权完全释放，子 thread 自治；主 thread 不背回执责任。遇 operator 决策 / 阻塞 / 不可逆 / 跨 feature 冲突仍按家规主动 cross_post | Repo Inbox / PR triage / 分发——踢出去就让下游自闭环 |
| `state-transitions` | 每个 phase boundary（阶段完成 / 重要决策 / 状态切换）回报 | Bug 调查 / Research——主 thread 要跟过程 |
| `blocking-ack` | 子 thread **遇阻塞点**（at each blocker，非每步）才等主 thread ack 再继续；持球在**子 thread**（被阻塞方）自己 `hold_ball` + 发 `[BLOCKING]`，主 thread 不背 polling | 等 review / 等 operator / blocking handoff |

**场景化选择指南**（AC-AA2）：
- 做完后源 thread 需要结果回来？→ **`final-only`**（默认，不用填）
- 交给下游自治闭环，源 thread 不需要回来？→ **`none`**（显式写 `reportingMode: 'none'`）
- 需要阶段性状态推送？→ **`state-transitions`**
- 遇阻塞必须等源 thread ack？→ **`blocking-ack`**

**约束**：
- mode 是 thread contract，创建后**不可动态切换**（要换就 propose 新 thread）。
- `none` ≠ 禁止上报——关键事件永远按家规 cross_post。**即使 `none` 下主动上报也必须携带 `targetCats` 或行首 `@sourceHandle`**，避免消息存了但没人醒。
- `#ideate`（并行 wake-all）与 reportingMode **正交**：`#ideate` 只决定并行 vs 串行接龙；report-back owner 由 reportingMode 决定。`#ideate + none` 不指定汇总 owner；`#ideate + final-only/state-transitions` 才指定第一棒为汇总 owner。
- 下面 Step 5「汇聚」铁律默认针对需回报的 mode（`final-only` / `state-transitions` / `blocking-ack`）；`none` 模式下子 thread 自闭环，不走 Step 5 强制回报。
- **回报时路由必须包含 routing credentials**：server 会自动注入 `threadId` + `targetCats`/`@sourceHandle` 到首条消息 header（AC-AA6），照着发即可。

### Step 3: 选猫 — 按任务性质匹配能力

| 任务性质 | 适合的猫 | 理由 |
|---------|---------|------|
| 代码实现 | 架构猫（自己）或快速编码猫 | 产出代码 |
| 代码 Review | Maine Coon系（审查专长） | 跨家族 review |
| UI/体验/文案 | Siamese系（审美专长） | 设计视角 |
| 架构决策 | Ragdoll Opus 4.5 / Maine Coon GPT | 深度思考 |
| 确定性执行 | 狸花猫 | 零信任验证 |

**铁律**：同一子任务的实现和 review 不能是同一只猫（no self-review）。

用户批准 proposal 后，新 thread 出现在 sidebar。此时在新 thread 里发任务描述 + 分工提议。**必须包含主 thread ID**，这是子 thread 识别归属的唯一可靠来源：

```
→ cat_cafe_cross_post_message(
    threadId: "<sub_thread_id>",
    content: "## 主 Thread\nID: <main_thread_id>\n标题: <main_thread_title>\n\n## 任务描述\n...\n## 分工提议\n...\n@codex 请确认"
  )
```

> **回报要求按 reportingMode**：`final-only`（默认）/ `state-transitions` / `blocking-ack` 下 server enrich 会自动注入对应的 report-back 规则 + 路由凭证（threadId + @handle）进首条消息，无需手写"完成后请回报"；`none`（autonomous/opt-in）则不要写强制回报指令——下游自闭环。

**铁律**：每个子 thread 的**第一条消息**必须包含 `## 主 Thread` header（定位父 thread 用）。是否要求回报由 reportingMode 决定，不再无条件汇报。

### Step 4: 并行执行 — Worktree 隔离

**每个 thread 的代码改动应使用独立 worktree**，避免文件冲突。

thread 内的执行遵循已有 skill：
- 写代码 → `tdd`
- 完成后自检 → `quality-gate`
- 请 review → `request-review` + `cross-cat-handoff`（五件套）
- 收到反馈 → `receive-review`

**加速手段**：thread 内可用 CLI 内置的 subagent 并行模式加速实现，但 review 必须由其他猫完成。

### Step 5: 汇聚 — 确认门禁 + 串行推进（仅需回报 mode）

> **前提**：Step 5 适用于 `final-only` / `state-transitions` / `blocking-ack`。`none`（autonomous，显式 opt-in）下子 thread 自闭环——不通知、不等确认、自主 commit，跳过整个 Step 5。

**铁律（需回报 mode）：子 thread 达到里程碑时，必须立刻通知主 thread 并等待确认。**

#### 5a: 待 commit — 通知主 thread 等确认

子 thread 完成开发 + 自检后，**不要直接 commit**，而是：

```
→ cat_cafe_cross_post_message(
    threadId: "<main_thread_id>",     ← 从首条消息的 ## 主 Thread → 路由目标 获取
    targetCats: ["<source_cat_id>"],   ← 唤醒源猫（或 content 行首 @sourceHandle）
    content: "@sourceHandle ## [子任务名] — 待确认 commit\n\n| 子项 | 状态 | 关键产出 |\n|------|------|---------|\n| ... | ✅ | 一句话 |\n\n验证：测试 X/X pass, lint 0 errors\n请确认是否 commit + push"
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
拆解 → 提议 thread → 等用户批准 → 选猫(含主 Thread ID) → 并行执行 → 待 commit 通知 → 确认 → 串行触发 → 汇总

主 thread = 指挥部（拆 + 提议 + 确认 + 收）
子 thread = 战场（做 + review；等确认仅需回报 mode）— 仅在用户批准 proposal 后存在
Proposal = 卡片（cat 提议 → 用户审核/编辑/批准 → 后端创建 thread）
第一条消息 = 必须含 ## 主 Thread（ID + 标题）
reportingMode = 回报契约（final-only 默认 / none 自闭环 / state-transitions / blocking-ack）
projectPath = 项目归属（default parent 发 repo/实现子任务时必填；不传=继承 parent）
Worktree = 隔离（不冲突）
汇报 = 按 reportingMode（none 自闭环不回报；需回报 mode 才及时 + 等确认，不让 team lead 追也不越权 commit）
```

## Common Mistakes

| 错误 | 后果 | 修法 |
|------|------|------|
| 在主 thread 里直接改代码 | 子 thread 看不到过程，审计困难 | 代码改动必须在子 thread + worktree |
| 需回报 mode 下子 thread 完成不通知主 thread | team lead 要自己查 | final-only/state-transitions 完成/阻塞时 cross-post 回主 thread；none 自闭环不适用 |
| 多 thread 在同一 worktree 改代码 | 文件冲突 | 每个 thread 用独立 worktree |
| 只拉同家族猫 | 缺少多元视角 | 按任务性质跨家族选猫 |
| 拆得太细（1 个小文件 = 1 个 thread） | 编排开销 > 收益 | 相关小任务合并到同一 thread |
| 忘记在子 thread 发任务描述 | 被拉的猫不知道干啥 | 建 thread 后立刻发 scope + 分工 |
| 子 thread 第一条消息没写主 Thread ID | 猫汇报到错误的 thread | 第一条消息必须含 `## 主 Thread` header |
| 需回报 mode 下完成直接 commit 不等确认 | team lead 失去控制权 | final-only/state-transitions 待 commit 通知主 thread 等确认；none 自主 commit |
| 把 propose 返回的 proposalId 当成 threadId 用 | cross_post 到不存在的 thread | propose 不创建 thread，只有 user 批准后才有 threadId。等批准事件再发首条消息 |
| 提议一个 proposal 后立刻假设 thread 存在 | 后续操作全失败 | 必须等用户在 proposal 卡片上点"批准"。批准前继续主 thread 工作 |

## 和其他 Skill 的区别

| Skill | 层级 | 方向 | 核心区别 |
|-------|------|------|---------|
| **thread-orchestration** | 跨 thread | 主动拆解 → 分发 → 汇聚 | 全生命周期编排；**先确认没有已有 thread 再新建** |
| CLI subagent 并行 | session 内 | subagent 并行（CLI 内置） | 不涉及 thread、不涉及其他猫 |
| `cross-thread-sync` | 跨 thread | 被动发现 → 通知 → 协调 | 响应式，不主动建 thread；**发现跨 scope 问题的默认路径** |
| `cross-cat-handoff` | 猫对猫 | 一次性交接 | 点对点，不涉及多 thread 编排 |

> **F128/F193 环决策**（KD-E4）：发现跨 scope 问题 → `list_threads` 查已有 thread → **有 → cross-thread-sync（投递）** / 没有 → thread-orchestration（新建）。默认投递，新建阈值更高。

## 下一步

- 子 thread 内写代码 → `worktree` → `tdd`
- 子 thread 完成自检 → `quality-gate`
- 子 thread 请 review → `request-review`
- 子 thread merge → `merge-gate`
- 子 thread 之间有冲突 → `cross-thread-sync`
