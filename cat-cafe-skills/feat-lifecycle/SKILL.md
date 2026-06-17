---
name: feat-lifecycle
description: >
  Feature 立项、讨论、完成的全生命周期管理。
  Use when: 开个新功能、new feature、F0xx、立项、feature 完成、验收通过、讨论新功能需求。
  Not for: 代码实现、review、merge（那些有专门的 skill）。
  Output: Feature 聚合文件 + BACKLOG 索引 + 真相源同步。
triggers:
  - "开个新功能"
  - "new feature"
  - "F0xx"
  - "立项"
  - "feature 完成"
  - "F0xx done"
  - "验收通过"
  - "讨论新功能需求"
argument-hint: "[阶段: kickoff|discussion|completion] [F0xx 或主题]"
---

# Feature Lifecycle

管理 Feature 从诞生到收尾：立项建追溯链、讨论沉淀决策、完成闭环同步。

## 核心知识

**Feature vs Tech Debt**：operator能感知变化 → Feature；只有开发者知道 → Tech Debt。不确定先记 TD。

**追溯链架构**：`ROADMAP.md`（热层）→ `docs/features/Fxxx.md`（温层，唯一入口）→ feature-discussions/research/plans（冷层）

**演化关系**：`Evolved from`（功能演进）/ `Blocked by`（硬依赖）/ `Related`（松耦合）

## 立项 (Kickoff)

**触发**：operator说"新功能"/"立项"、讨论收敛确认要做。**不触发**：还在探索 → `collaborative-thinking` Mode A；小修补 → TD。

### 开工前 Recall（F102 记忆系统）🔴

**加载本 skill 后、动手前**，先用记忆系统搜一下相关上下文：

```
search_evidence("{feature关键词}")        # 找相关 feature / ADR
search_evidence("{topic}", scope="all")  # 找历史讨论 + thread
```

**为什么**：防止重复造轮子、重蹈覆辙。记忆系统索引了 400+ docs + 所有 thread 摘要。

### Step 0: 关联检测（内部 + 社区 issue 都必须做）🔴

**分配 F 编号前，先跑关联检测**，防止重复立项或把子任务误立为独立 feature：

1. **扫描 BACKLOG + features/**：`grep -i "{关键词}" docs/ROADMAP.md docs/features/*.md`（或用 `search_evidence` 替代 grep）
2. **判定**：

| 判定结果 | 处置 |
|---------|------|
| 已有 Feature 的子任务/phase | **不立新号**，挂到现有 Fxxx 下，issue 加 `related: Fxxx` |
| 已有 Feature 的相关需求 | 标记 `related: Fxxx`，由 maintainer 决定合并还是独立 |
| 全新独立需求 | 继续走 Step 1 分配 F 号 |
| 太小 / 纯 enhancement | **不立项**，保留 enhancement 标签，不给 F 号 |

3. **社区 issue 额外检查**：
   - 可行性：需求的数据源/依赖是否存在？
   - 粒度：是独立 feature 还是现有 feature 的 UX polish？
   - 回溯：feature doc 必须含 `community_issue: #{issue号}` 字段

**教训（F114/F115/F116 事故）**：批量打标签 ≠ 审核通过。每个 issue 必须逐个过关联检测。

### Step 1-5: 正式立项流程

**5 步流程**：

1. **分配 ID**：`grep -E "^\| F[0-9]+" docs/ROADMAP.md | tail -1`，新 ID = 最大 + 1，三位数

2. **创建聚合文件** `docs/features/Fxxx-name.md`（kebab-case 文件名）

   **从标准模板创建**：复制 `cat-cafe-skills/refs/feature-doc-template.md` 中「模板正文」部分，替换占位符（`{NNN}`/`{Feature Name}`/`{YYYY-MM-DD}` 等）。模板包含 Dashboard parser 所需的全部硬性格式。

   轻量 Feature（≤1 Phase）可省略 Timeline/Review Gate/Links/Key Decisions，但 Frontmatter + Status 行 + Why + Current State + What + AC + Dependencies 必须保留（全新能力的 Current State 写 "N/A（无既有基线）"，不是删段）。

   并在 spec 中补一节：`## 需求点 Checklist`（模板见 `cat-cafe-skills/refs/requirements-checklist-template.md`）

3. **更新 ROADMAP.md**：末尾加 `| F042 | 名称 | spec | Owner | {source} | [F042](features/...) |`
   - Source 列：`internal`（内部立项）或 `community [#xx](url)`（社区 issue 立项，附链接）

4. **关联文档**：Links 章节列出相关 research/discussion；更新这些文档的 `feature_ids: [F042]`

5. **Commit**：`docs(F042): kickoff {名称} [{猫猫签名}]`，body 含 What/Why

6. **创建毛线球任务**（F160 Phase C）：立项 commit 后，调用 `cat_cafe_create_task` 为当前 thread 创建跟踪任务：
   - title: `完成 F{NNN}: {Feature 名称}`
   - why: 从 spec Why 节摘 1 句核心痛点
   - 不要为 trivial feature（≤1 file 改动、无 Phase 拆分）创建任务

   **Gotcha**: 只在有 threadId 的会话中创建。operator在非 thread 环境立项（如 BACKLOG 批量整理）时跳过此步。

### 立项愿景硬度自检（F216→F219 教训）🔴

> **为什么**：F216 立项 Why 写"降 complexity"，AC 却落成"修 bug + 可测性"，两者执行中悄悄分叉，直到 close 前愿景守护才发现 gap。根因是**立项时愿景表述不够硬 + 交接丢上下文**（operator 2026-06-02）。这是 LL-067（后半段被前半段工程量吃）/ LL-069（scope 跟"自我解读"走不跟 spec 走）在**立项时刻**的前置防线——审计时才抓分叉太晚，立项就钉死。

Step 2 写完 spec，Why / 现状 / AC 逐条过这道自检：

| 维度 | 硬要求 | 反模式（F216 踩过） |
|------|--------|--------------------|
| **愿景 Why** | 用**价值**语言一句话说清要解决什么 | 用"技术动作"冒充愿景（"重构 X" ❌；"X 每加功能就 7 轮 review" ✅） |
| **真实现状** | 带**实测证据**（complexity / 行数 / 复现 / hotfix 频次），不美化 | "感觉这块乱"（给数据不给感觉，`feedback_no_classifier`） |
| **完成判据 AC** | 每条能 **trace 回 Why** + **非作者可复核**（命令/数字/截图） | 重构类 AC 落成"提了可测性就算"（F216 AC-B2：complexity 没降也宣布达成） |

**两条硬规则**：
1. **AC↔Why 同源**——每条 AC 指得回 Why 的某诉求；指不回 = 删 AC 或补 Why。AC 覆盖不了 Why = 愿景虚高。
2. **Handoff 重写愿景**——从别的 thread/feat 交接立项时，**用本 feat 自己的语言重写 Why**，不继承上游模糊表述（交接丢上下文是 F216 分叉直接成因）。

承载点：现状写进模板 `## Current State / 现状基线` 段；AC↔Why 自检见模板 `## Acceptance Criteria` 段顶部 comment（均在 feature-doc-template「模板正文」内，随复制进入新 spec）。自检不过 → 回 Step 2 改 spec，不进 Step 3。

**检查**：聚合文件创建 ✓ frontmatter 完整 ✓ BACKLOG 索引 ✓ 关联文档双向链接 ✓ 愿景硬度自检 ✓ 已 commit ✓ 毛线球任务创建 ✓

### 轻量立项（非 F 号：内容生产 / 能力验证项目）

> LL-071 起源：内容生产任务（视频 / PPT / 系列产出）同样有 lifecycle，但不一定进 feat 体系（shared-rules §21）。

**适用**：批量产出消耗显著成本（token / API 抽卡）或铺设技术路线，且 operator 决定不开 F 号（挂 story / IP / 项目目录）。

**锚点形态**：项目目录里的 charter 文档，结构学 feat doc（范例：`docs/videos/cucu-pr-flow/episode-brief.md`）：

- Why（双重目的写清）/ 路线（**引 operator 原话做锚**）/ Scope / **Non-goals（防跑偏的牙齿，最重要的段）** / 预算护栏 / DoD / 分工 / operator signoff（frontmatter `cvo_signoff` 字段记日期与原话）
- charter 自声明"唯一 scope 真相源"：链上任何一棒发现产出超出 charter scope → 停，回 operator
- 被取代的外部文档（云端 brief 等）标 `superseded` + 指针，保留为历史不篡改

**与正式 feat 的区别**：无 F 号、无 BACKLOG 索引、无 Design Gate 仪式——但 scope 纪律同强度。

**选型**：改产品代码 / 对外契约 → 正式 feat；内容产出 / 能力验证 → operator 选轻量 charter 或 feat。拿不准 → 问一句，别替 operator 决定。

## 讨论 (Discussion)

**两种模式**：

- **采访式（默认）**：operator口述 → 一次一问澄清（"为什么要？现在怎么做？做完后怎么用？"）→ 排优先级 → 记开放问题。**Anti-anchor**：先让operator表达完，再分析。

- **开放讨论**：多猫协作。结构：背景 + 我的分析（仅供参考，**先自己想再看**）+ 开放问题（按角色分组）+ 我的倾向（透明推理链）。明确标"这是讨论不是任务"，保护观点独立性。

**讨论结束必须做**：
1. 落盘到 `feature-discussions/YYYY-MM-DD-{topic}/README.md`（含operator experience、决策过程、优先级排序）
2. ROADMAP.md 该 Feature 行 ref 讨论文档链接
3. Commit：`docs: {topic} discussion + backlog update [{猫猫签名}]`

## Design Gate (设计确认) 🔴

**Discussion → writing-plans 之间的必经关卡。UX 没确认，不准开 worktree。**

按功能类型分流确认：

| 类型 | 判断标准 | 确认人 | 方式 |
|------|---------|--------|------|
| **前端 UI/UX** | 用户能看到的改动 | **operator** | wireframe → operator OK 后继续 |
| **纯后端** | API/数据模型/内部逻辑 | **其他猫猫** | `collaborative-thinking` 讨论达成共识 |
| **架构级** | 跨模块、新基础设施 | **猫猫讨论 → operator拍板** | 先出方案再上报 |
| **Trivial** | ≤5 行、纯重构、文档 | 跳过 | 跳过 Design Gate，按 SOP 例外路径判断 |

**前置检查（F086 M2）**：
开 Design Gate 前，先做触发器 E "新领域侦查"：
1. 读 `docs/features/README.md` 找相关 Feature
2. 读相关 Feature spec 的 Key Decisions / Open Questions
3. 搜 `feature-discussions/` 看有没有前人讨论过类似问题
4. 把发现记录到 Design Gate 讨论里（避免重复造轮子）

详见 `shared-rules.md` §13 元思考触发器。先搜现状，再开讨论。

**架构归属一问（F191）🔴**：

每个非 trivial Feature 在 Design Gate 必须能用一句话回答：

```markdown
Architecture cell: {ownership cell id}
Map delta: none | update required | new cell required
Why: 一句话
```

- `Architecture cell` 来自 `docs/architecture/ownership/README.md`；普通增量默认引用已有 cell。
- `Map delta: none` = 本次只扩展现有边界，不改 ownership map，也不重新画架构图。
- `Map delta: update required` = 本次改变 owner / boundary / extension point / canonical anchor，先改对应 cell。
- `Map delta: new cell required` = 找不到归属；这不是回去填表，而是 Phase 0 架构发现未完成。

答不出来 → Design Gate 不放行。禁止用新 Feature 私造 `Store` / `Queue` / `Router` / `Adapter` 来绕开已有 cell。

**Eval Contract 门禁（F192）🔴**：

harness / skill / MCP / shared-rules 类 feature 的 spec **必须含 `## Eval / Tracking Contract` 节**，否则 Design Gate 不通过。

**触发条件**（判断标准：改动会改变猫猫行为模式 → 填）：
- 新增 skill / 新增 MCP tool / 新增 shared-rules section / 新增 SOP step
- 现有规则/工具的显著行为变更

**不触发**：typo / wording 微调 / 纯重构（行为不变）/ 文档补充

**4 项必填**（模板见 *(internal reference removed)*）：
1. Primary Users + Activation Signal
2. Friction Metric
3. Regression Fixture（最少 1 条，建议 2-5）
4. Sunset Signal（**空填 = 不通过，不设 reviewer 签字降级**——KD-4）

**Harness 方法论教学（F218 / ADR-031）🔴**：

凡是 harness / skill / MCP / shared-rules / SOP / L0 等会改变猫猫行为模式的 feature，Design Gate 必须写出 **软+硬+eval** 三层计划；不是每层都要很重，但漏掉任何一层都要说明理由。

| 层 | 承重 | 常见载体 |
|----|------|----------|
| Soft | 让猫在正确认知路径上想起该动作 | L0 触发句 / skill description / SOP 教学 |
| Hard | 不靠自觉也能挡住或暴露错误 | test / linter / schema / runtime guard / compile gate |
| Eval | 持续检验这条 harness 是否真的让行为变好 | F192 fixture / regression case / friction metric / sunset signal |

一句话判断：只写 Soft = 希望猫下次记得；只有 Soft + Hard = 修了但不知道会不会长期有效；Soft + Hard + Eval 才是 ADR-031 的完整 harness loop。

**在地设计检查 (Design in Context) 🔴**：
凡是改动或往已有页面/组件添加新 UI 元素，必须逐项过 `cat-cafe-skills/refs/design-in-context-checklist.md`。禁止在真空中凭想象画已有页面的布局。

**现场可感知性自检 (In-context Observability) 🔴**：

> **核心铁律**：**统计是事后审计，现场可感知性是第一入口。**

凡是涉及 **agent 状态 / runtime failure / 后台任务 / auth & degradation / diagnostics / health & status / 跨猫协作可见性** 的 feature，必须逐项过 `cat-cafe-skills/refs/in-context-observability-checklist.md`，并在 Design Gate 讨论文档里产出 `in_context_observability` 决策字段（`primary_surface` / `why_not_dashboard_only` / `deep_dive_surface` / `noise_dedup_policy`）。缺字段 = Design Gate 不放行。

类比范式：memory entity 自带状态、browser-preview 把页面端上桌——entity carries its own state, surface it where it happens。反面：Datadog/前 agent 时代的 stats dashboard，等用户主动切到 tab 才看到数字 +1。

来源：F174 callback auth lifecycle D2b 实战收敛（2026-04-25，operator experience"新时代的明厨亮灶"）。

**流程**：
1. 判断功能类型 → 选择确认路径
2. 前端：画 wireframe（Pencil / 文字版 ASCII）→ 发operator → 等 OK
3. 后端：`collaborative-thinking` → 拉相关猫讨论 API 契约/数据模型
4. 架构：猫猫讨论 → 结论给operator → **必须附 Decision Packet**（格式见 `refs/decision-matrix.md`）→ operator拍板
5. 确认产出归档 `feature-discussions/{date}-{fid}-design/`

**Design Gate OQ 升级规则**：先判断可逆性维度（见 `refs/decision-matrix.md`）——回滚成本低+不碰愿景/安全/外部契约/显著成本 → 猫猫自决，不升级 operator。需要升级时，OQ 必须用 Decision Packet 格式，不能只列"模糊问题清单"。

**元审美自检**（Design Gate 必问，F163 教训 + F167 Round 4 canon 化）🔴

这个方案是**坐标变换**（改变问题结构，让复杂度消失）还是**多项式堆项**（在现有结构上叠补丁/层数/脚手架）？
后者 → 先读 Meta-Aesthetics canon（数学美学 / 第一性原理 / 拒绝脚手架），尝试找到更简的分解方式。删掉它不影响安全/可验证性/权限边界，才是多余。
审计未通过 → 回到 Kickoff 或重新设计。

## Phase 碰头（大 Feature 专属，3+ Phase）🔴

大 scope feature **每个 Phase merge 后**，主动和operator碰头（不是问"要不要继续"，是确认方向）：

1. **成果展示**：这个 Phase 做了什么（截图 / 关键改动 / demo）
2. **愿景进度**：离最终愿景还差什么（哪些 AC ✅，哪些还没）
3. **下个 Phase 方向**：下一步计划 + 有没有发现新问题
4. **方向确认**："方向对吗？有没有要调整的？"

小 Feature（1-2 Phase）跳过碰头，直接做到底。

## 完成 (Completion)

**触发**：AC 全部打勾 + PR 合入 + remote review 通过。**不触发**：只是 Phase 完成 / 只是 review 过了。

**⚠️ Phase 级进度由 `merge-gate` Step 7.5 实时同步**：每次 PR merge 后，merge-gate 负责更新 Phase ✅、AC 打勾、Timeline 记录。Completion 阶段不需要补这些——它们应该已经是最新的。如果发现 Phase 状态落后于实际 commit，说明之前 merge 时漏了 Step 7.5。

**🔴 交付物核实铁律（LL-029）**：spec checkbox 是记录工具，不是真相源。声称"完成"或"未完成"前，**必须**核实实际 commit/PR 状态（`git log --grep` + `gh pr list`）。只读 .md 就下结论 = 睁眼说瞎话。

**Step 0: 愿景对照（必须先做，不可跳过）🔴**

AC 全打勾 ≠ 完成（F041 教训：12 项 AC ✅ 但 UI 不可用）。先读原始 Discussion/Interview，自问三个问题：① operator最初要解决的核心问题？② 交付物解决了吗？③ operator用这个功能体验如何？

**愿景守护证物对照表（F114 Gate — 缺表 = BLOCKED）**：

守护猫必须输出以下格式的对照表，否则 **BLOCKED，不放行**：

```markdown
| operator experience（逐字引用） | 当前实际状态（截图/代码/命令输出） | 匹配？ |
|----------------------|-------------------------------|--------|
| "把旧 mode 删掉"      | [截图: mode 入口已无旧选项]       | ✅     |
| "狼人杀加到 mode 里"   | [截图: mode 入口有狼人杀]         | ✅     |
```

**BLOCKED 条件**（任一触发 → 不放行）：
- 守护猫输出缺少对照表 → BLOCKED
- 对照表中有未匹配项（❌）→ BLOCKED，踢回修改
- 找不到operator experience（Discussion/Interview 缺失）→ BLOCKED，要求补充

**跨猫交叉验证（强制，F073 自动化）**：

自己先完成三问 + 对照表 → **自动 @ 其他猫**请求独立愿景守护（不要等operator提醒，直接 @）→ 收到结论 → 对齐 → 填签收表（猫猫 / 读了哪些文档 / 三问结论 / 对照表 / 签收）→ 全部对齐后继续 Step 1。

**愿景守护猫选择（不能 hardcode！）**：
```
守护猫 ≠ 作者 且 ≠ reviewer
选法：查 cat-config.json roster → 排除作者 catId + reviewer catId → 剩余猫中选一只
```
| 作者 | Reviewer | 守护猫 |
|------|----------|--------|
| 猫 A | 猫 B | roster 中排除 A 和 B，优先跨 family |

守护猫负责：愿景三问 + 不满足则踢回修改 + 满足则放行 close。

**🔴 Step 0.3.5: User Visibility Disclosure（F190 Phase C post-close 教训 2026-05-13）— 守护猫审查前置输入**

愿景三问之前，作者必须产出 **User Visibility Disclosure** 表，把"技术决策"翻译成"用户可见性"语言：

| Surface | 用户能做什么（达成态） | 用户实际能做什么（本 feat close 时） | 缺失/退化 | 处置 |
|---------|--------------------|--------------------------|----------|------|
| 例: 通知页 | 配 VAPID 公私钥 + 一键生成 + 联系信箱 | 看诊断矩阵 + 修复建议（read-only） | 完全丢失写能力 | deferred to Phase D / operator signoff: thread `...` |

- ❌ "Service Manifest deferred" → ✅ "通知页用户看到诊断矩阵，无法在 UI 配置 VAPID"
- ❌ "Phase C 4/4 ✅" → ✅ "通知页/插件页/MCP 写/Skill 管理 4 个 surface 有用户可感缺失，详见 disclosure 表"

**Inbound intake 类 feature 必须额外含**：开源 vs 本地 visual side-by-side screenshots（每个 settings section / 主要 surface 各一对），不能只看"组件 wire 了没"。

**Deliberate defer 必须 operator signoff**——operator 在 thread 里显式确认"接受这个 deferred surface 不在本 feat 内交付"才能 close；否则按"漏"处置，必须实做或开 follow-up F 号继续。

守护猫先审 Disclosure 才能做愿景三问。看到 deferred 字样直接拷问："这个 deferred 用户能感知到吗？operator signoff 在哪？"

事故来源：F190 close 时 settings/ 缺 7 个开源 components，operator 完全不知道"通知页变成诊断矩阵"——技术决策语言"deferred"没有映射到用户可见性。详见 *(internal reference removed)*。

**🔴 守护猫提的 P1 = blocker，作者不能 self-resolve（2026-04-26 教训）**

历史踩坑：F173 close 时把没完成的 AC-B2 (handler unification) 抽出去开 F177 stub spec 当作"follow-up anchor"应付守护猫的 P1，本质是把"没完成"藏进新文件后宣布闭环（debt = never，TD = never，stub = never，都是话术包装）。

**反 anti-pattern 检查**（守护猫和作者都要查，operator最终把关）：

- ❌ "deferred → 单独立项" / "follow-up 接棒" / "已记入 TD list" — 全部禁止作为闭环路径
- ❌ 新建 stub spec / TD 条目当作"已 truth-sync"凭证
- ✅ **闭环只有两条路径**：
  - **(A) 实做**：守护猫提的 P1 必须实做完成（哪怕大改动），改完重审
  - **(B) 联合签字降级**：守护猫 + operator在 thread 里**显式签字**"接受不做 / 不属于本 feat 范围 / 已重新评估"，并写明降级理由

**作者反问自己（close 前必查）**：
1. 所有 deferred AC 是哪类：(a) 真做了 (b) operator签字降级 (c) 我自己想藏起来？
2. 如果是 (c) → 不能 close，必须二选一：实做 OR 显式向operator请求降级

**守护猫反问作者**（看到 deferred / follow-up / stub anchor 字样直接拷问）：
- 这件事**需要做还是可有可无**？
- 如果需要做，**为什么不现在做**？
- 如果可有可无，**为什么留 spec/TD 占资源**？

不能给"几个选项让operator选"——这是反问式 ping，把判断推回去。作者必须先有立场再 @ operator。

前端 UI/UX 额外要求：≤3 张截图 + 15s 录屏 + "需求→截图"映射表。

**Step 0.5: 反思胶囊（F086 M3）🔴**

愿景对照 + 跨猫验证之后、AC 打勾之前，写一个反思胶囊：

1. 从 `project-reflections/README.md` 复制模板
2. 填 6 个固定章节（What Worked / What Failed / Trigger Missed / Doc Links / Rule Update Target）
3. 保存到 `project-reflections/YYYY-MM-DD-{topic}-capsule.md`
4. Feature spec 只挂链接，不把正文塞回去

**不能跳过**：每个 milestone/feature 完成都要写。没有就写"无"，不允许省略章节。

**Step 0.6: Harness Eval Checkpoint（F192 Phase A）🔴**

反思胶囊之后、Close Gate Report 之前，判断是否需要 harness-level 评估。**Checkpoint 必做**，但不一定每次都展开——大多数 feature 写 `harness_feedback: none` 即可。

**触发条件**（任一满足 → 必须展开写 harness-feedback 文档）：

| 触发 | 说明 |
|------|------|
| Harness / skill / MCP feature close | harness 自身变化必须评估 fit |
| operator 不满意 / "不是我要的" | 需要分清 vision gap / translation gap / harness misfit |
| Trace anomaly（重复 tool call、handoff 断链、长时间无 tool call） | trace 只能给 what，猫解释 why |
| 抽样（normal feature close） | 防止只看失败样本 |

**未触发时**：在 CloseGateReport 中写 `harness_feedback: none | reason: {简短理由}`。

**触发时**：

1. 在 `docs/harness-feedback/YYYY-MM-DD-Fxxx-{topic}.md` 创建 harness-feedback 文档（schema 见 `docs/harness-feedback/README.md`）
2. 使用 `evidence_refs` 指向 canonical trace/thread/session，**不复制 raw tool-call payload**
3. 如需 evidence-directed cat interview，**必须在独立 session 或独立 turn 进行**，不接在工作上下文尾巴上
4. 在 feature spec 和 CloseGateReport 中链接 harness-feedback 文档

**Step 1: Close Gate Report（F177 Phase A）🔴**

输出 **CloseGateReport**（schema 见 `cat-cafe-skills/refs/close-gate.md`）——逐条列明每个 AC 的证据和处置：

```
AC-A1 ✅ met — commit abc123 + test_xxx
AC-A2 ✅ met — screenshot_yyy + PR #1234
AC-A3 ❌ unmet → immediate（现在做完）
AC-A4 ❌ unmet → cvo_signoff(msg:0001777429xxx) — "ok 接受降级"
AC-A5 ❌ unmet → delete(why: 经评估不属于 MVP scope)
```

**unmet AC 只有三条路，没有第四选项**：
1. **immediate**：当前 session 做完，做完后改为 met + 补 evidence
2. **delete(why)**：从 AC 删除，写清为什么不需要
3. **cvo_signoff**：operator 自然语言表态同意降级，录入四件套（proposal_message_id + cvo_message_id + cvo_quote + accepted_scope）

**以下不是合法路径**：follow-up / deferred / next phase / P2 / stub / TD / 后续 / 留个尾巴 / 先这样 / 下次一定 / 回头 / 以后再 / next PR / will address later

缺 CloseGateReport = **不能 close**。自由文本"我都做了"不算。

**Step 2**: 聚合文件 → `Status: done`，加 `Completed: YYYY-MM-DD`，Timeline 加收尾记录

**Step 3**: 演化关系 — 确认 `Evolved from` 填写；考虑"往哪去"：有明确后续 → 触发 kickoff 立项

**Step 4**: 从 `docs/ROADMAP.md` **移除**该行；`docs/features/README.md` 加入"已完成"表格（聚合文件永久保留，不删）

**Step 5**: 真相源同步 — 所有关联文档 `feature_ids` 正确；Links 章节无遗漏

**Step 6**: Commit：`docs(Fxxx): mark feature as done [{猫猫签名}]`，body 含 What/Why/Evolved from

## Quick Reference

| 阶段 | 关键动作 | 文件 |
|------|---------|------|
| Kickoff | 分 ID → 聚合文件 → BACKLOG → 双向链接 | `docs/features/Fxxx.md` |
| Discussion | 采访/开放 → 落盘 → BACKLOG ref | `feature-discussions/` |
| **Design Gate** | **分流 → 确认（UX→operator/后端→猫猫/架构→两边）** | `feature-discussions/{date}-{fid}-design/` |
| Completion | 愿景对照 → 跨猫验证 → 更新状态 → 移出 BACKLOG | `docs/features/Fxxx.md` |

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 完成后才补聚合文件 | Kickoff 时就建 |
| AC 打勾就标 done，不读原始需求 | Step 0 愿景对照（F041 教训） |
| 自己验完就收尾 | 跨猫交叉验证是强制的 |
| 删了聚合文件 | 只从 BACKLOG 移除，聚合文件永久保留 |
| 不记录演化关系 | Completion Step 3 必须思考 |
| 讨论完不落盘 | 讨论结束写入 `feature-discussions/` |
| 等operator手动协调跨猫守护 | 自己 @ 其他猫发起守护（F073） |
| 每步停下来问operator"可以继续吗？" | 全链路自驱，只在阻塞/close 时通知operator |
| 只看 spec checkbox 就声称完成/未完成 | 核实 git log + PR 状态 + 实际 commit（LL-029）|
| UX 没确认就开 worktree 写代码 | 先过 Design Gate 再动手 |
| 后端 API 自己拍板不跟其他猫讨论 | 纯后端走 `collaborative-thinking` 拉猫讨论 |
| 等 feat close 才补 Phase 进度 | merge-gate Step 7.5 每次 merge 实时同步（Phase ✅ + AC + Timeline） |
| 社区 issue 批量打 feature 标签不逐个审核 | 每个 issue 必须过 Step 0 关联检测（F114/F115/F116 教训） |
| 社区 feature 只在开源仓打标签，BACKLOG 不同步 | ROADMAP.md 必须同步加 Source=community 条目 |

## 下一步

- Kickoff 后 → **Design Gate**（按类型分流确认）→ `writing-plans`
- 开发完成后 → `quality-gate` → `request-review`
- Review 通过后 → `merge-gate`（合入）→ 回来用 completion 闭环
- 讨论收敛后 → `collaborative-thinking` Mode C（沉淀 ADR/规则/教训）
