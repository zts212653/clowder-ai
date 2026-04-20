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

**Feature vs Tech Debt**：铲屎官能感知变化 → Feature；只有开发者知道 → Tech Debt。不确定先记 TD。

**追溯链架构**：`ROADMAP.md`（热层）→ `docs/features/Fxxx.md`（温层，唯一入口）→ feature-discussions/research/plans（冷层）

**演化关系**：`Evolved from`（功能演进）/ `Blocked by`（硬依赖）/ `Related`（松耦合）

## 立项 (Kickoff)

**触发**：铲屎官说"新功能"/"立项"、讨论收敛确认要做。**不触发**：还在探索 → `collaborative-thinking` Mode A；小修补 → TD。

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

   轻量 Feature（≤1 Phase）可省略 Timeline/Review Gate/Links/Key Decisions，但 Frontmatter + Status 行 + Why + What + AC + Dependencies 必须保留。

   并在 spec 中补一节：`## 需求点 Checklist`（模板见 `cat-cafe-skills/refs/requirements-checklist-template.md`）

3. **更新 ROADMAP.md**：末尾加 `| F042 | 名称 | spec | Owner | {source} | [F042](features/...) |`
   - Source 列：`internal`（内部立项）或 `community [#xx](url)`（社区 issue 立项，附链接）

4. **关联文档**：Links 章节列出相关 research/discussion；更新这些文档的 `feature_ids: [F042]`

5. **Commit**：`docs(F042): kickoff {名称} [{猫猫签名}]`，body 含 What/Why

6. **创建毛线球任务**（F160 Phase C）：立项 commit 后，调用 `cat_cafe_create_task` 为当前 thread 创建跟踪任务：
   - title: `完成 F{NNN}: {Feature 名称}`
   - why: 从 spec Why 节摘 1 句核心痛点
   - 不要为 trivial feature（≤1 file 改动、无 Phase 拆分）创建任务

   **Gotcha**: 只在有 threadId 的会话中创建。铲屎官在非 thread 环境立项（如 BACKLOG 批量整理）时跳过此步。

**检查**：聚合文件创建 ✓ frontmatter 完整 ✓ BACKLOG 索引 ✓ 关联文档双向链接 ✓ 已 commit ✓ 毛线球任务创建 ✓

## 讨论 (Discussion)

**两种模式**：

- **采访式（默认）**：铲屎官口述 → 一次一问澄清（"为什么要？现在怎么做？做完后怎么用？"）→ 排优先级 → 记开放问题。**Anti-anchor**：先让铲屎官表达完，再分析。

- **开放讨论**：多猫协作。结构：背景 + 我的分析（仅供参考，**先自己想再看**）+ 开放问题（按角色分组）+ 我的倾向（透明推理链）。明确标"这是讨论不是任务"，保护观点独立性。

**讨论结束必须做**：
1. 落盘到 *(internal reference removed)*（含铲屎官原话、决策过程、优先级排序）
2. ROADMAP.md 该 Feature 行 ref 讨论文档链接
3. Commit：`docs: {topic} discussion + backlog update [{猫猫签名}]`

## Design Gate (设计确认) 🔴

**Discussion → writing-plans 之间的必经关卡。UX 没确认，不准开 worktree。**

按功能类型分流确认：

| 类型 | 判断标准 | 确认人 | 方式 |
|------|---------|--------|------|
| **前端 UI/UX** | 用户能看到的改动 | **铲屎官** | wireframe → 铲屎官 OK 后继续 |
| **纯后端** | API/数据模型/内部逻辑 | **其他猫猫** | `collaborative-thinking` 讨论达成共识 |
| **架构级** | 跨模块、新基础设施 | **猫猫讨论 → 铲屎官拍板** | 先出方案再上报 |
| **Trivial** | ≤5 行、纯重构、文档 | 跳过 | 跳过 Design Gate，按 SOP 例外路径判断 |

**前置检查（F086 M2）**：
开 Design Gate 前，先做触发器 E "新领域侦查"：
1. 读 `docs/features/README.md` 找相关 Feature
2. 读相关 Feature spec 的 Key Decisions / Open Questions
3. 搜 *(internal reference removed)* 看有没有前人讨论过类似问题
4. 把发现记录到 Design Gate 讨论里（避免重复造轮子）

详见 `shared-rules.md` §13 元思考触发器。先搜现状，再开讨论。

**在地设计检查 (Design in Context) 🔴**：
凡是改动或往已有页面/组件添加新 UI 元素，必须逐项过 `cat-cafe-skills/refs/design-in-context-checklist.md`。禁止在真空中凭想象画已有页面的布局。

**流程**：
1. 判断功能类型 → 选择确认路径
2. 前端：画 wireframe（Pencil / 文字版 ASCII）→ 发铲屎官 → 等 OK
3. 后端：`collaborative-thinking` → 拉相关猫讨论 API 契约/数据模型
4. 架构：猫猫讨论 → 结论给铲屎官 → 铲屎官拍板
5. 确认产出归档 *(internal reference removed)*

**元审美自检**（Design Gate 必问，F163 教训 + F167 Round 4 canon 化）🔴

这个方案是**坐标变换**（改变问题结构，让复杂度消失）还是**多项式堆项**（在现有结构上叠补丁/层数/脚手架）？
后者 → 先读 [Meta-Aesthetics canon](../../docs/canon/meta-aesthetics.md)（数学美学 / 第一性原理 / 拒绝脚手架），尝试找到更简的分解方式。删掉它不影响安全/可验证性/权限边界，才是多余。
审计未通过 → 回到 Kickoff 或重新设计。

## Phase 碰头（大 Feature 专属，3+ Phase）🔴

大 scope feature **每个 Phase merge 后**，主动和铲屎官碰头（不是问"要不要继续"，是确认方向）：

1. **成果展示**：这个 Phase 做了什么（截图 / 关键改动 / demo）
2. **愿景进度**：离最终愿景还差什么（哪些 AC ✅，哪些还没）
3. **下个 Phase 方向**：下一步计划 + 有没有发现新问题
4. **方向确认**："方向对吗？有没有要调整的？"

小 Feature（1-2 Phase）跳过碰头，直接做到底。

## 完成 (Completion)

**触发**：AC 全部打勾 + PR 合入 + 云端 review 通过。**不触发**：只是 Phase 完成 / 只是 review 过了。

**⚠️ Phase 级进度由 `merge-gate` Step 7.5 实时同步**：每次 PR merge 后，merge-gate 负责更新 Phase ✅、AC 打勾、Timeline 记录。Completion 阶段不需要补这些——它们应该已经是最新的。如果发现 Phase 状态落后于实际 commit，说明之前 merge 时漏了 Step 7.5。

**🔴 交付物核实铁律（LL-029）**：spec checkbox 是记录工具，不是真相源。声称"完成"或"未完成"前，**必须**核实实际 commit/PR 状态（`git log --grep` + `gh pr list`）。只读 .md 就下结论 = 睁眼说瞎话。

**Step 0: 愿景对照（必须先做，不可跳过）🔴**

AC 全打勾 ≠ 完成（F041 教训：12 项 AC ✅ 但 UI 不可用）。先读原始 Discussion/Interview，自问三个问题：① 铲屎官最初要解决的核心问题？② 交付物解决了吗？③ 铲屎官用这个功能体验如何？

**愿景守护证物对照表（F114 Gate — 缺表 = BLOCKED）**：

守护猫必须输出以下格式的对照表，否则 **BLOCKED，不放行**：

```markdown
| 铲屎官原话（逐字引用） | 当前实际状态（截图/代码/命令输出） | 匹配？ |
|----------------------|-------------------------------|--------|
| "把旧 mode 删掉"      | [截图: mode 入口已无旧选项]       | ✅     |
| "狼人杀加到 mode 里"   | [截图: mode 入口有狼人杀]         | ✅     |
```

**BLOCKED 条件**（任一触发 → 不放行）：
- 守护猫输出缺少对照表 → BLOCKED
- 对照表中有未匹配项（❌）→ BLOCKED，踢回修改
- 找不到铲屎官原话（Discussion/Interview 缺失）→ BLOCKED，要求补充

**跨猫交叉验证（强制，F073 自动化）**：

自己先完成三问 + 对照表 → **自动 @ 其他猫**请求独立愿景守护（不要等铲屎官提醒，直接 @）→ 收到结论 → 对齐 → 填签收表（猫猫 / 读了哪些文档 / 三问结论 / 对照表 / 签收）→ 全部对齐后继续 Step 1。

**愿景守护猫选择（不能 hardcode！）**：
```
守护猫 ≠ 作者 且 ≠ reviewer
选法：查 cat-config.json roster → 排除作者 catId + reviewer catId → 剩余猫中选一只
```
| 作者 | Reviewer | 守护猫（示例） |
|------|----------|---------------|
| opus | codex | gpt52 或 gemini |
| codex | opus | gpt52 |
| gpt52 | codex | opus |
| 任意 | 任意 | roster 中排除前两者，优先跨 family |

守护猫负责：愿景三问 + 不满足则踢回修改 + 满足则放行 close。

前端 UI/UX 额外要求：≤3 张截图 + 15s 录屏 + "需求→截图"映射表。

**Step 0.5: 反思胶囊（F086 M3）🔴**

愿景对照 + 跨猫验证之后、AC 打勾之前，写一个反思胶囊：

1. 从 *(internal reference removed)* 复制模板
2. 填 6 个固定章节（What Worked / What Failed / Trigger Missed / Doc Links / Rule Update Target）
3. 保存到 *(internal reference removed)*
4. Feature spec 只挂链接，不把正文塞回去

**不能跳过**：每个 milestone/feature 完成都要写。没有就写"无"，不允许省略章节。

**Step 1**: AC 全部 `[x]`；未完成项先确认（完成 / 转 TD / 确认不需要）

**Step 2**: 聚合文件 → `Status: done`，加 `Completed: YYYY-MM-DD`，Timeline 加收尾记录

**Step 3**: 演化关系 — 确认 `Evolved from` 填写；考虑"往哪去"：有明确后续 → 触发 kickoff 立项

**Step 4**: 从 `docs/ROADMAP.md` **移除**该行；`docs/features/README.md` 加入"已完成"表格（聚合文件永久保留，不删）

**Step 5**: 真相源同步 — 所有关联文档 `feature_ids` 正确；Links 章节无遗漏

**Step 6**: Commit：`docs(Fxxx): mark feature as done [{猫猫签名}]`，body 含 What/Why/Evolved from

## Quick Reference

| 阶段 | 关键动作 | 文件 |
|------|---------|------|
| Kickoff | 分 ID → 聚合文件 → BACKLOG → 双向链接 | `docs/features/Fxxx.md` |
| Discussion | 采访/开放 → 落盘 → BACKLOG ref | *(internal reference removed)* |
| **Design Gate** | **分流 → 确认（UX→铲屎官/后端→猫猫/架构→两边）** | *(internal reference removed)* |
| Completion | 愿景对照 → 跨猫验证 → 更新状态 → 移出 BACKLOG | `docs/features/Fxxx.md` |

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 完成后才补聚合文件 | Kickoff 时就建 |
| AC 打勾就标 done，不读原始需求 | Step 0 愿景对照（F041 教训） |
| 自己验完就收尾 | 跨猫交叉验证是强制的 |
| 删了聚合文件 | 只从 BACKLOG 移除，聚合文件永久保留 |
| 不记录演化关系 | Completion Step 3 必须思考 |
| 讨论完不落盘 | 讨论结束写入 *(internal reference removed)* |
| 等铲屎官手动协调跨猫守护 | 自己 @ 其他猫发起守护（F073） |
| 每步停下来问铲屎官"可以继续吗？" | 全链路自驱，只在阻塞/close 时通知铲屎官 |
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
