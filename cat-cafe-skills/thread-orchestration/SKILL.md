---
name: thread-orchestration
description: >
  大任务的主动拆解、动态角色分配与多 thread 并行编排。
  Use when: 任务涉及 2+ 个独立可交付子任务，或需组织指挥、执行、运行后验收之间的交付与通讯。
  Not for: 单一任务（直接做）、已有 thread 之间的被动协调（用 cross-thread-sync）、单 session 内 subagent 并行（CLI 内置能力）、发现跨 scope 问题但已有归属 thread（用 cross_post_message，不要新建 thread）。
  Output: 角色与依赖计划、获批子 thread 派发、横向交付与最终回流。
  GOTCHA: projectPath 是子 thread 的工作区/真相源归属，不是外部目标仓；社区 PR review 目标可以是 clowder-ai，但工作区仍可能应继承 cat-cafe。
tips_exempt: "2026-09-28：星系协作契约只调整既有编排方法，不新增用户操作或 runtime 权限。"
triggers:
  - "拆任务"
  - "分 thread"
  - "并行推进"
  - "开多个 thread"
  - "thread orchestration"
  - "任务分解"
---

# Thread Orchestration — 多 Thread 并行编排

**核心理念**：thread 承载工作现场，猫按本次任务承担角色。指挥、执行、验收不绑定猫名、家族或模型档位；责任归属与通讯路径分别明确。

组织三种现场、跨执行现场依赖或小团队排班时，先读 [星系协作契约](refs/constellation-collaboration.md)。这是本 skill 的角色与通讯约定；发送、授权核验、审查与处置仍走对应 skill，不新增球权账本。

## 何时触发

```
发现跨 scope 的问题/信息？
  → 先 list_threads keyword=<关键词> 查有没有已有 thread
  → 有已有 thread → 不要新建！用 cross_post_message 投递（cross-thread-sync skill）
  → 没有已有 thread + 需要独立追踪 → 本 skill：propose_thread

任务可以拆成多个独立子任务？
  → 有依赖？ → 独立部分并行；共享写入面单写，消费点等确切接口产物
  → 子任务独立？ → 本 skill：开 thread 并行推进
只有一个任务？ → 不需要本 skill，直接做
```

> **F128/F193 环**（KD-E4）：`propose_thread`（新建）和 `cross_post_message`（投递）是一个环。
> 默认走投递（`cross_post_message`），只有确认没有已有 thread 时才走新建（`propose_thread`）。
> 新建 thread 的阈值高于投递——新建会增加operator的认知负担。

## 五步流程

### Step 1: 拆解 — 识别独立可交付单元

**判定标准**：各自有可判断的交付物，且能划清写入面与消费依赖；能在不同 worktree 编辑不是充分条件。有共享接线时只串行该写入面，其余独立部分可并行。

拆解时明确每个子任务的：
- **Scope**: 改哪些文件/模块
- **交付物**: 代码 + 测试 + 文档（具体到文件）
- **验收条件**: 用户实得与证据；区分代码交付、已加载运行版本和真实旅程通过
- **角色与依赖**: 当前执行责任猫、共享写入面、直接依赖方、可先做的部分、必须停下的消费点
- **完成边界**: 整项委派何时结束、结果回哪里；分片 PR 合入不自动结束整项责任

### Step 2: 提议 Thread — 每个子任务一个提议（用户审批后才创建）

**重要：cat 不直接创建 thread。** 调用 `cat_cafe_propose_thread` 创建一个**提议卡片**，等用户在 source thread 里点"批准"，后端才真正创建 thread。

```
→ cat_cafe_propose_thread(
    title: "简洁描述任务目标",
    reason: "为什么这个子任务值得自己一个 thread（必填）",
    preferredCats: ["<实际起跑猫 catId>"], // 多猫可能形成接龙；review 候选不当作必跑名单
    projectPath: "/abs/path/to/repo",  // 子 thread 的工作区/真相源归属；不是外部目标仓
    reportingMode: "final-only"  // 可选回报契约: none/final-only(默认)/state-transitions/blocking-ack，见下表
  )
```

**返回值**：`{ proposalId, status: "pending" }` —— **不是 threadId**。Thread 还未存在，不要尝试 `cross_post` 到一个尚未批准的 proposal。

**社区 PR / issue 分发：** title / reason / initialMessage 中出现外部 PR/issue 时，
服务端不再自动注入 `opensource-ops` maintainer 五问、猜测作者角色或写入 PR metadata。
子 thread 的第一项工作是主动加载 `opensource-ops` skill，在 child workspace 内完成 provider
object 与 author grounding，再执行 maintainer 五问与 custody 判断。本地猫替外部作者修代码需要
显式 Strategy B 授权 provenance，不能默认派给 `preferredCats` 里的猫。

**命名规则**：`[优先级/批次] 动词 + 对象`
- 例："P1 功能完善：Web UI + Semantic Scholar + API 降级"
- 例："P2 工程质量：CI/CD + Linting"

**提议后**：继续主 thread 的工作，消费批准回执中的真实 threadId 与初始派发结果。已自动派发就不重复投递；未派发时再按 Step 3 发送完整工作包，不让用户去子 thread 重述。

#### projectPath — 项目归属

不传 `projectPath` = 继承当前/parent thread 的项目。若当前 thread 本身是 `default` / 未分类 / eval / lobby，而子 thread 要做 repo 或实现工作，必须显式传绝对路径；只有纯 eval/meta/无需项目归属的 thread 才可留空并进入未分类。

先问：**子 thread 的工作区真相源在哪？** `projectPath` 决定新 thread 的 cwd / 归属 project，不等于它要处理的外部 GitHub 仓库、PR 或 issue。例：从 cat-cafe 守门 thread 分发 `clowder-ai#NNN` 的 review / triage / intake 任务时，GitHub target 是 `clowder-ai`，但子 thread 的 projectPath 通常应继承或显式使用 `cat-cafe`，因为家里的 SOP、skills、feature docs、Direction Card 真相源都在这里。

只有当子 thread 明确要在公开仓 checkout 内执行目标仓操作（例如 conflict rebase、public-only hotfix、release target validation），才把 `projectPath` 设为 `clowder-ai`，并在 handoff 里写明原因。

#### reportingMode — 回报契约分型（F128 Phase Y → Phase AA）

决定子 thread 是否/如何回报主 thread。**不传 = `final-only`（做完把结果带回来）**。

> **Phase AA 更新（2026-06-07）**：默认从 `none` 改为 `final-only`。大多数 propose 是"开一个子 thread 做事，做完把结果带回来"。选择模式前先问自己：**这个子 thread 做完后，源 thread 是否需要结果回来？**

| Mode | 语义 | 何时用 |
|------|------|--------|
| `final-only`（**默认**） | 子 thread 自治完成整项委派后回报一次；不向主 thread 发过程汇报。直接依赖交付与真正越界的升级照常走 | Feature work fork / 社区守门分发 / 大多数情况 |
| `none`（autonomous，显式 opt-in） | 球权完全释放，子 thread 自治；主 thread 不背回执责任。遇 operator 决策 / 阻塞 / 不可逆 / 跨 feature 冲突仍按家规主动 cross_post | 明确不需要任何最终结果返回的一次性自治空间；社区守门分发不使用本模式 |
| `state-transitions` | 每个 phase boundary（阶段完成 / 重要决策 / 状态切换）回报 | Bug 调查 / Research——主 thread 要跟过程 |
| `blocking-ack` | 只在约定的阻塞点等待源现场的实质决定，责任留在被阻塞方；系统送达回执不替代决定 | 确实需要源现场决定才能继续的工作；普通 review / CI 等待不用它 |

**场景化选择指南**（AC-AA2）：
- 做完后源 thread 需要结果回来？→ **`final-only`**（默认，不用填）
- 交给下游自治闭环，源 thread 不需要回来？→ **`none`**（显式写 `reportingMode: 'none'`）
- 需要阶段性状态推送？→ **`state-transitions`**
- 遇阻塞必须等源 thread ack？→ **`blocking-ack`**

**约束**：
- mode 是出生时的 thread contract，当前不可动态修改。用户后续明确改变汇报要求时，更新工作包/计划并按新指令执行；如实保留出生字段，不为更改汇报频率重建工作或假称工具字段已改。这只调整猫的行为，不能据此保证由旧字段驱动的系统自动通知已改变。
- **`opensource-ops` 优先约束**：社区守门 thread 分发 issue / PR / review / intake 时必须显式传 `reportingMode: "final-only"`；闭环前不向父现场发过程 cross-post，闭环后只回报一次。真实升级与直接依赖交付仍按原授权处理。
- `none` ≠ 禁止上报——关键事件永远按家规 cross_post。**即使 `none` 下主动上报也必须携带 `targetCats` 或行首 `@sourceHandle`**，避免消息存了但没人醒。
- `#ideate`（并行 wake-all）与 reportingMode **正交**：`#ideate` 只决定并行 vs 串行接龙；report-back owner 由 reportingMode 决定。`#ideate + none` 不指定汇总 owner；`#ideate + final-only/state-transitions` 才指定第一棒为汇总 owner。
- Step 5 的父现场回报适用于需回报的 mode；`none` 免最终回报，依赖交付、必要升级与运行证据边界仍适用。
- **回报时路由必须包含 routing credentials**：server 会自动注入 `threadId` + `targetCats`/`@sourceHandle` 到首条消息 header（AC-AA6），照着发即可。

### Step 3: 选猫 — 按任务和当前成员分配角色

先看实际成员、相关经验、所需工具、当前可用性与用户成本偏好；有 dossier 就参考，不要求社区用户具备家里的猫名册。发送前核真实 catId/路由；过期额度信号不能当禁派，也不能据此静默改掉用户指定目标。

| 角色 | 选择依据 | 边界 |
|------|----------|------|
| 指挥/愿景守护 | 能维护整体目标、处理依赖取舍、组织运行后验收的可用成员 | 责任组可有多猫，每项待办仍须有明确当前责任猫 |
| 执行 | 对该工作最合适且可用的成员；简单确定性工作考虑成本，困难工作使用更强判断与验证 | 平时负责指挥的猫也可执行；不由模型名推定授权 |
| 独立审查 | 按风险选有相应判断能力的非作者 | 不默认找指挥，不把所有家庭绑定到某个家族 |
| 运行后验收 | 能读取真实部署版本、走原始用户旅程的成员 | 实现猫可配合复现；独立性要求与 Feature close 权限照旧 |

**铁律**：选定独立 review 后，作者不能审自己；同一 catId 换 thread、换角色或另开 subagent 不产生独立 reviewer。两猫家庭可互审不同改动；缺少合格非作者时暴露真实缺口，不自批、不凭空加猫或降低门禁。

**指挥与代码审阅分开**：子 thread 的执行猫按难度、风险和当前可用性自行选择非作者 reviewer，在子 thread 完成审阅、修复和门禁；不默认把 review 交给主 thread 的指挥猫，也不为选猫或调整 reviewer 逐次请指挥批准。已有审阅保持清楚的责任与目标连续性，替换时收口旧分派，避免重复审查。主 thread 负责产品范围、依赖取舍、整合和体验验收；只有真正超出子 thread 决策边界的冲突才上报。逐条进展都去读源码/trace再发修改意见，即使自称“抽核”，也会把执行闭环收回指挥部。来源：F317 operator `[thread-id]#private-source-id`。

获批且尚未派发时，向真实子 thread 投工作包。**必须包含主 thread ID**，并带授权源、整项交付边界、依赖/单写面和停点。通知不自动转移实现责任；按 `custody-recognition` / `cross-cat-handoff` 核已有责任或使用合法传球载体：

```
→ cat_cafe_cross_post_message(
    threadId: "<sub_thread_id>",
    targetCats: ["<实际执行猫 catId>"],
    content: "## 主 Thread\nID: <main_thread_id>\n标题: <main_thread_title>\n\n## 工作包\n授权源/已有责任：...\n目标与整项完成条件：...\nscope/共享单写面：...\n现在可做/依赖方与消费停点：...\n验证、回流与权限边界：..."
  )
```

> **回报要求按 reportingMode**：`final-only`（默认）/ `state-transitions` / `blocking-ack` 下 server enrich 会自动注入对应的 report-back 规则 + 路由凭证（threadId + @handle）进首条消息，无需手写"完成后请回报"；`none`（autonomous/opt-in）则不要写强制回报指令——下游自闭环。

**铁律**：每个子 thread 的**第一条消息**必须包含 `## 主 Thread` header（定位父 thread 用）。是否要求回报由 reportingMode 决定，不再无条件汇报。

### Step 4: 并行执行 — Worktree 隔离

**每个 thread 的代码改动应使用独立 worktree**，避免文件冲突。

thread 内的执行遵循已有 skill：
- 写代码 → `tdd`
- 完成后自检 → `quality-gate`
- 请 review → `request-review` + `cross-cat-handoff`（满足接手与审查要求，五项提示可选）
- 收到反馈 → `receive-review`

**加速手段**：thread 内可用 CLI 内置的 subagent 并行模式加速实现，但 review 必须由其他猫完成。

### Step 5: 交付 — 直接消费依赖，整项完成回流

> **前提**：Step 5 的行为按 reportingMode 分型——
> - **`final-only`（默认）**：在授权范围内自主 commit / push / review / merge，完成整项委派后回报一次。review-ready、测试绿、小片 PR 合入、普通依赖等待不唤醒指挥。横向交付与无法自行解决的越界冲突见契约；不额外设指挥确认轮次。
> - **`state-transitions`**：里程碑（阶段完成 / 重要决策）时通知主 thread，不必等确认。
> - **`blocking-ack`**：只在约定停点请求实质决定，走 5a。等猫走真实路由；等人按既有提问/审批路径；仅有界外部条件无回调时用 `hold_ball`，不拿它催人或制造 ACK 循环。
> - **`none`（autonomous）**：子 thread 自闭环，不强制回报父现场；5b 的依赖交付与5c的证据边界仍适用。

#### 5a: 待 commit — 通知主 thread 等确认（仅 `blocking-ack`）

> **`final-only` 跳过本步**——自主 commit + push，不等确认。

仅当工作包明确把 commit 列为需确认的阻塞点时，完成开发 + 自检后先发：

```
→ cat_cafe_cross_post_message(
    threadId: "<main_thread_id>",     ← 从首条消息的 ## 主 Thread → 路由目标 获取
    targetCats: ["<source_cat_id>"],   ← 唤醒源猫（或 content 行首 @sourceHandle）
    content: "@sourceHandle ## [子任务名] — 待确认 commit\n\n| 子项 | 状态 | 关键产出 |\n|------|------|---------|\n| ... | ✅ | 一句话 |\n\n验证：测试 X/X pass, lint 0 errors\n请确认是否 commit + push"
  )
```

**等主 thread 确认后再 commit。** 主 thread 可能会要求修改后再 commit。

#### 5b: 依赖就绪 — 直接通知消费方

A 按已约定的消费条件直接把确切 commit/接口/验证证据投到 B 的执行 thread（`cross-thread-sync`）；B 核验后续做，不等主 thread 转述，不等 A 的无关剩余工作全部结束。依赖若要求已合 main，review-ready 或分支绿不能解锁。

共享写入面指定一个当前 writer，其他现场提供独立模块与接线说明；独立 worktree 不能消除同一文件的语义冲突。依赖阻塞写入现有计划/Task/workflow，带条件、责任方及合法等待路径；不额外复制 Task，也不把“等 ACK”当完成条件。

#### 5c: 全部完成 — 汇总报告

执行现场完成整项委派后，以最终产物、验证、未满足项和运行版本边界回流；报告不代替 typed completion。主 thread 按原始目标核交付，再组织已授权的运行后验收：

```markdown
## 编排汇总

| 子 Thread | 任务 | 状态 | PR |
|-----------|------|------|----|
| thread-xxx | ... | ✅ merged | #xx |
| thread-yyy | ... | ✅ merged | #yy |

下一步：[无 / 集成测试 / 部署]
```

主 thread 不因每条 FYI 重查 PR、改文档再回 ACK；最终回流、用户主动查询或真正冲突时才做必要核验。执行猫收到用户或指挥的具体查询可以核事实后直接应答；这是受请求的答复，不是主动阶段汇报，也不改变之后的 `final-only`。

需要部署的能力，按 [星系协作契约](refs/constellation-collaboration.md) 区分候选、已合入、已发布、已加载、旅程通过。运行后验收可有独立 thread，也可由小团队复用现场；重启、权限与 Feature close 不因“完成回流”自动获准。

## 依赖管理

| 场景 | 处理 |
|------|------|
| 子任务完全独立 | 并行，各自 worktree |
| B 依赖 A 的产出 | B 先做独立部分；消费点等 A 的确切约定产物，A 直接交 B |
| A 和 B 改同一文件 | 该写入面单写，独立模块并行；必要时重新拆分 scope |
| 多个 thread 都要改共享状态 | 走 `cross-thread-sync` 的 Claim 协议 |

## Quick Reference

```
拆解 → 提议 thread → 等用户批准 → 选猫(含主 Thread ID) → 并行执行 → 按 reportingMode 回报

主 thread = 指挥部（拆 + 提议 + 收汇总）
子 thread = 战场（做 + review + merge；final-only 自治闭环，blocking-ack 才等确认）— 仅在用户批准 proposal 后存在
Proposal = 卡片（cat 提议 → 用户审核/编辑/批准 → 后端创建 thread）
第一条消息 = 必须含 ## 主 Thread（ID + 标题）
reportingMode = 回报契约（final-only 默认=自治推进+闭环后回报一次 / none 自闭环 / state-transitions 阶段回报 / blocking-ack 阻塞等确认）
projectPath = 项目归属（default parent 发 repo/实现子任务时必填；不传=继承 parent）
Worktree = 工作树隔离；共享写入面的语义冲突仍须协调
汇报 = 按 reportingMode（final-only 自治做完回报一次；none 自闭环不回报；state-transitions 阶段回报；blocking-ack 阻塞等确认）
```

## Common Mistakes

| 错误 | 后果 | 修法 |
|------|------|------|
| 把角色当猫名，或要求每家都配齐“指挥猫” | 强猫不能执行、小团队被迫加猫/开空 thread | 角色按工作绑定；只有独立交付值得拆时建 thread |
| 指挥猫逐条复审子 thread 代码、指定或等待固定 reviewer | 指挥成为执行瓶颈，作者失去自主闭环 | 执行猫按风险选非作者 reviewer 并在原处收口；主 thread 只收整合结果、体验证据和真正的取舍 |
| 子 thread 完成不回报主 thread | team lead 要自己查 | final-only：整项委派闭环后一次最终总结；分片 PR 不冒充整项完成 |
| 多 thread 在同一 worktree 改代码 | 文件冲突 | 每个 thread 用独立 worktree |
| 为独立审查把作者换个 thread | 看似分工，仍是自审 | 用真实非作者，按当地风险规则满足独立性 |
| 拆得太细（1 个小文件 = 1 个 thread） | 编排开销 > 收益 | 相关小任务合并到同一 thread |
| 忘记在子 thread 发任务描述 | 被拉的猫不知道干啥 | 建 thread 后立刻发 scope + 分工 |
| 子 thread 第一条消息没写主 Thread ID | 猫汇报到错误的 thread | 第一条消息必须含 `## 主 Thread` header |
| 已明确约定 commit 停点却直接越过 | 越过有效工作包边界 | 只在该约定停点请求决定；不是所有 blocking-ack 都禁止自主 commit |
| 把 propose 返回的 proposalId 当成 threadId 用 | cross_post 到不存在的 thread | propose 不创建 thread，只有 user 批准后才有 threadId。等批准事件再发首条消息 |
| 提议一个 proposal 后立刻假设 thread 存在 | 后续操作全失败 | 必须等用户在 proposal 卡片上点"批准"。批准前继续主 thread 工作 |
| 把 `projectPath` 当成外部目标仓，给社区 PR review thread 填 `clowder-ai` | 子 thread 进入错误 workspace，家里 SOP/skills/feature docs 不在工作区，球路污染 | projectPath 填工作区真相源；`clowder-ai#NNN` 放在标题/正文/gh 命令里，只有明确目标仓 checkout 操作才填 clowder-ai |
| 社区守门分发选 `none`，或 final-only 给父现场发 checkpoint | 守门 thread 被过程噪音与 ACK 回音链污染 | 遵循 `opensource-ops`：显式 final-only，闭环前不向父现场报过程，闭环后一次总结；真实升级和横向依赖照常处理 |

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
