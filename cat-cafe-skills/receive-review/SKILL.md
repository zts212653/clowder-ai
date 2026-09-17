---
name: receive-review
tips_exempt: "This revision clarifies evidence-based feedback handling and optional templates within the existing review workflow; no new user-facing operation or configuration is added."
description: "处理 reviewer 反馈：Red→Green 修复 + 按 engagement mode 收口。Use when: 收到 review 结果或 P1/P2。Not for: 发 review 请求、自检。Output: 按 iterative / one-shot 契约闭环。"
triggers:
  - "review 结果"
  - "review 意见"
  - "reviewer 说"
  - "fix these"
  - "github-review-feedback"
---

> **SOP 位置**: 本 skill 是 `sop-definitions/development.yaml` stage `review` 的反馈处理执行细节。
> **上一步**: `request-review` | **下一步**: `merge-gate`

# Receive Review

处理反馈要形成有依据的判断、修复与真实闭环。历史教训是顺从照改、点修不查同类，以及把修完误当已通过审查。

## 必须做到

- 完整理解反馈，核对原始需求、相关实现与证据；接受或反驳都有依据。意见全部成立时可以全部接受，不制造分歧。
- 成立的 P1/P2 当轮解决；不成立的说明证据；尚未核清的如实保留，不能冒充已修复。真正改变愿景/范围的取舍按决策漏斗处理。
- 修复有适用的 RED → GREEN 与回归验证；已有精准失败检查可复用，纯命名/文档反馈使用对应检查，不为形式造测试。
- 同类缺陷重复出现时，审视本次改动中的同型位置与共同机制，避免逐点补锅。具体检索和记录形式可选择。
- 按本轮 feedback source 与 engagement 闭环，保留审查目标、证据、合法回执和未决项；不得自称通过未满足的合入门禁。

后文的处理顺序、表格和确认信是可选参考，可以直接使用、改造或替换；实际 source/typed 字段与授权契约仍按适用路径满足。发起 review 用 `request-review`，自己的交付自检用 `quality-gate`。

## 触发入口

| 来源 | 说明 |
|------|------|
| operator/猫猫转述 | 手动告知 review 结果 |
| `github-review-feedback` connector 通知 | F140 自动投递：review decisions（approved/changes_requested）+ inline/conversation comments |
| 云端 Codex review | 通过 ReviewRouter 投递的 email review 结果 |

收到 `github-review-feedback` 通知时，按下面的核心知识处理——不区分来源，只区分反馈类型。

### 自动触发处理（F140 Phase B）

当 `github-review-feedback` connector 唤醒你时：

1. 读取通知内容，识别 review decision 类型
2. `CHANGES_REQUESTED` → 直接进入下方 Red→Green 流程
3. `APPROVED` → 不需要 receive-review，检查是否可以走 merge-gate
4. `COMMENTED` → 判断是否需要代码修改，需要则进入 Red→Green 流程
5. 处理完成后通知operator结果（KD-13: 事后通知）

详见 `../.cat-cafe-shared-refs/pr-signals.md` Phase B 自动响应行为。

## 核心知识

### 两类反馈，处理方式不同

| 类型 | 特征 | 处理 |
|------|------|------|
| **代码级** | bug / edge case / 性能 / 命名 | Red→Green 修复流程 |
| **愿景级** | "这不是operator要的" / "缺了多项目管理" / "UI 不可用" | 回读原始需求；明确的实现偏差直接修，新的价值取舍才升级 operator |

> 先对照operator experience判断偏差。实现遗漏与设计取舍分开处理，不把“愿景级”标签当成重复索要既有授权的理由。

### Reviewer Delta Annotation（F253 AC-B2）

当 review request 附有 **Fresh-Context Findings** 节时，reviewer 在自己的 findings 中标注 delta tag，量化 cross-model review 增值：

| Tag | 含义 | 用途 |
|-----|------|------|
| `[FC:covered]` | 该 finding 已被 fresh-context 发现 | 量化 fresh-context 覆盖率 |
| `[FC:new]` | 该 finding 是 fresh-context **未发现**的新发现 | 量化正式 reviewer 增值（reviewer delta metric） |
| `[FC:N/A]` | 该 finding 不适用 delta 标注（如愿景级/架构级） | 排除非代码 finding |

**Annotation 格式**：在 finding 行末加 tag

```
P2-1: 边界条件未处理 — src/foo.ts:42 [FC:covered]
P1-1: Race condition in concurrent writes — src/bar.ts:18 [FC:new]
P3-1: 建议重新考虑整体架构方向 [FC:N/A]
```

**注意**：
- 标注是 lightweight annotation，不增加 review 流程摩擦
- Review request 无 Fresh-Context Findings 节时（未触发 fresh-context），不标注
- Delta 数据自然累积在 review 记录中，Phase C `eval:qc` 聚合分析
- 标注不影响 finding 的 severity 判定或处理流程

### 回应靠判断与证据

先核实反馈，再说明实际处置。正常礼貌不影响技术判断；赞同、反对或措辞本身都不能证明 review 有效。

### Push Back 标准

当以下情况时**必须** push back，用技术论证，不是防御性反应：

- 建议会破坏现有功能
- Reviewer 缺少完整上下文
- 违反 YAGNI（过度设计）
- 与架构决策/operator要求冲突
- 建议会让实现**更偏离**operator原始需求

如果你 push back 了但你错了：陈述事实然后继续，不要长篇道歉。

### Fallback 层数检测（F177 Phase D）🔴

Review 代码时，自动执行 `node scripts/check-fallback-layers.mjs` 检测 fallback 模式增长。
同一文件新增 ≥3 层 fallback → 触发坐标系自检（三问）：
1. 这个 fix 是在修坐标系，还是在给错误坐标系打补丁？
2. 能否用坐标变换（换一个问题分解方式）消除这些 fallback 层？
3. 每一层 fallback 为什么不能去掉？

review 报告中必须包含 fallback 层数分析结果。

核验后没有分歧是合法结果。需要指出的是有依据的问题，不能为了表示独立制造争论。

## 可选参考：处理顺序

```
WHEN 收到 review 反馈:

1. READ  — 完整读完，不要边读边反应。**R2+ 时额外动作**：回看上轮 finding 列表，标注每个 finding 的 failure-mode 类型，用于 AUDIT 步骤的同型判别
2. CLASSIFY — 区分愿景级 vs 代码级；按 P1/P2/P3 分优先级
3. CLARIFY — 补查不清楚的问题；只暂停依赖该疑点的修改，独立明确项可以推进
4. VERIFY — reviewer 说的问题真的存在吗？（见下方三个判断方面）
5. AUDIT — failure-mode sweep（见下方 §16e 判别）
6. FIX — 通过验证的问题 + audit 发现的同类问题 Red→Green 修复
7. CLOSE — 按 engagement mode 收口：iterative 回原 source；one-shot 用测试闭环，必要时转日常 reviewer
```

### VERIFY：判断需要覆盖的三个方面

核验应覆盖需求一致性、真实失败机制和用户路径。下面是一种组织方式，不要求逐项填表或采用固定顺序：

1. **Spec Gate** — 这条意见和现有 AC/需求冲突吗？
   - 冲突 → pushback，附 AC 原文
   - 不冲突 → 进下一道
2. **Mechanism Gate** — reviewer 说"这不行"的证据是什么？
   - 有失败用例 / 可复核的静态失败路径 / 真实平台限制 → 继续核实
   - 只是"不优雅"/"理论上不安全"但拿不出失败路径 → 当假设处理，pushback 要求证据
3. **Feature Gate** — 按建议改完后，核心用户路径还活着吗？
   - 改完跑一遍最关键的用户路径（不是只跑测试）
   - 功能死了 → 回滚，review 建议作废，不管它理论上多优雅

**证据边界**：实测可以反驳具体假设，但“没有复现”不能单独否定可证明的静态失败路径。按问题本身的证据裁决，不按 reviewer 的来源默认接受或驳回。

**修复顺序**：P1（blocking）→ P2（必须修）→ P3（讨论后当场修或放下，不记 BACKLOG）

**澄清原则**：不清楚的前提先查证；依赖它的修改暂停，相互独立且已核实的工作继续。

### AUDIT — Failure-Mode Sweep（shared-rules §16e）

VERIFY 完所有 findings 之后、动手修之前，做一次 failure-mode 判别：

**判别问**：这些通过验证的 P1/P2 里，有没有 ≥2 个属于**同一类 failure mode**？（边界遗漏、null 不安全、错误处理不一致、状态转换缺路径、类型假设不安全……）

- **有** → 做 failure-mode audit 再修：
  1. **抽象**：一句话说清它们违反了什么不变量
  2. **扫描**：带着这个不变量 grep 本 PR diff 里所有同类位置（sibling call sites、同性质边界群）
  3. **防护**：能否加类型/封装/测试让它不可能再违反
  4. **自报告**：audit 结果写进修复确认信，让 reviewer 不用下轮再 grep 同型
- **没有**（全是独立、不同类的点问题）→ 跳过 audit，直接进 FIX

**R2+ 额外检查**：如果本轮的 finding 和上轮是**同型**——不管数量多少，**强制 audit**。同型第二次出现 = author 上轮没泛化，这次必须补上。

**反复同型 finding（F229 PR-A1 教训）**：同一状态对象连续多轮出现问题时，停下重查共同机制、修复是否落地与状态契约。次数是调查信号，不是 plan 缺边的证明；确实发现生命周期或不变量缺失时，回 `writing-plans` 的 Stateful Object Gate 补清契约，以合适的图、表或精确描述表达，避免继续逐边打补丁。

> **为什么在 FIX 之前**：先 audit 再修 = 一次修完所有同类；先修再 audit = 改了一个又发现三个，反复 rebase。

## 修复与验证

- 先看已有检查能否准确复现已核实的问题：有则运行并保存 RED；没有且存在行为/回归风险，则先补回归测试。命名、文档等反馈按实际影响使用类型、引用或文档检查。
- 修复后复验同一信号与受影响路径，按一组实际改动安排回归；targeted 无法覆盖合流影响时才 full，不为每条 finding 重跑整个套件。
- 无法稳定自动化复现时，提供可复核的手工步骤、结果和限制，不跳过验证结论。
- issue、PR finding 或现有任务已经能追溯时直接复用。需要独立分派、跨会话恢复或单独终态时才用 `cat_cafe_create_task` 新建任务，完成后更新为 `done`。P3 当场修或放下，不新增跟踪债务。

## 修复后确认（按 engagement mode）

**修复完成 ≠ 自动可以合入；但闭环也不等于必须召回同一只猫。** 先读取原 review packet 的
`Engagement`：普通 `iterative` review 回本轮可验证的 feedback source；稀缺判断席位的
`one_shot_calibration` / `final_seal` 按一次性契约退出，作者用 Red→Green + 风险匹配 gate 消费普通 finding，
仍需独立确认时**转日常 reviewer**。只有新的架构/决策判断、无法机械验收的原 finding，或 operator 明确要求，才复入原稀缺 reviewer。

对需要复入的本地 `iterative` review，权威来源是 **direct review carrier**（直接承载 review 请求的 thread），
不是任务祖先 thread，也不是第一次误投 verdict 的落点。若二者冲突，停止沿错路级联并回 direct review carrier。

### 本地 reviewer 复入载体（terminal 之后的新工作）

只有 mode 判定确实需要复入时，P1/P2 修复产生的新 exact HEAD 才是一轮新的 review work。发送前重新加载 `request-review`，并严格消费其中唯一的 direct-carrier、ordinary durable A2A、accepted-source anchor 与 verdict-field 契约；本 skill 只保留守卫锚点：**普通 durable A2A** 必须携带 typed `localReviewVerdict` 与 `reviewedHeadSha`，其余字段和状态机不在这里复制。exact-HEAD 变化本身不能越过稀缺席位的 one-shot 退出条件。

| Feedback source | 修复后动作 |
|-----------------|------------|
| 本地 `iterative` reviewer | 在 direct review carrier 向 `@reviewer` 发送普通 durable 修复确认请求；等 reviewer 明确放行当前 SHA |
| 稀缺 `one_shot_calibration` / `final_seal` reviewer | 作者修复 + 测试/gate；仍需独立确认则转日常 reviewer，不因普通 finding 或 SHA 变化召回原猫 |
| cloud / GitHub review | 在 GitHub 回复或标注修复证据，push 新 SHA 后**只重新触发 cloud review**，等 PR tracking / review feedback；不要 @ 本地旧 reviewer |
| CI / PR check | 修复后 rerun/check gate；若只是外部 check gate，不需要本地 reviewer 续签 |
| operator / 愿景级 feedback | 回读原始需求；需要价值取舍时带 Decision Packet 给operator |

```
❌ 错误：cloud P2 修复 → @ 本地旧 reviewer 续签 → 等 cloud → 再 @ 本地 reviewer
✅ 正确：cloud P2 修复 → re-trigger cloud review → 等 PR truth source；local peer 只在非 cloud 行为 delta / scope 扩大时介入
```

可选确认信格式（已有载体足够时直接更新，不另造文档）：

```markdown
## 修复确认请求

| # | 问题 | 状态 | Red→Green |
|---|------|------|-----------|
| P1-1 | {描述} | ✅ | {test file}: FAIL → PASS |
| P2-1 | {描述} | ✅ | {test file}: FAIL → PASS |

测试结果：pnpm test → {X} passed, 0 failed
Commit: {sha} — {message}
Fresh-Context Delta: {N} FC:covered, {M} FC:new, {K} FC:N/A <!-- 仅 review request 含 FC 节时 -->

后续：按原 Engagement 决定回原 source 或转日常 reviewer。
```

修复完成后（F160 Phase C）：
- 本轮实际创建/持有的修复任务 → `cat_cafe_update_task` 状态改为 `done`
- 按上述 Engagement 闭环；只有 `iterative` 本地 review 回 direct review carrier

**云端 finding 修复后的证据归 cloud 路径消费；若已命中 `merge-gate` 的封板条件，按既有封板出口处理。** 不能自判通过直接合入，也不能把每次 cloud 修复投射成本地旧 reviewer。

## Reviewer 验证 UX/前端改动（硬规则）

> 教训（F121 狼人杀）：reviewer 只看代码没打开浏览器，author 连续 9 轮瞎猜修都没被发现。

**涉及 UX/前端/交互的改动，reviewer 必须实际打开浏览器操作验证**，不能只看代码和测试输出。

```
验证清单：
1. 打开浏览器（Playwright/Chrome MCP）访问对应页面
2. 按 AC 或 bug 复现步骤实际操作
3. 截图/录屏作为验证证据
4. 如果和设计稿（.pen）有出入，标注差异
```

没有浏览器验证的前端 review = 走过场。

## TAKEOVER 降级（同线程同任务）

Reviewer 在 review 过程中发现 author 触发以下任一条件，可直接发起 TAKEOVER（详见 shared-rules §18）：

1. 连续 3 轮无有效证据增量；
2. 连续 2 次假绿（声明 fixed 但复验失败）；
3. 你（reviewer）被迫对同一验收点重复验证 2 次。

**触发后**：在 thread 显式宣布 TAKEOVER → 原 author 停止试错 → 你或另一只猫接手修复。接管猫不得自审，需由另一只猫 review。

## Common Mistakes

| 错误 | 正确做法 |
|------|----------|
| 边读边改，没读完 | 读完整反馈，分类后再动手 |
| 不清楚的前提直接猜着改 | 暂停依赖该前提的修改；独立、已核实的部分可以继续 |
| 没有可信失败证据就宣称修复 | 新测试或已有精准检查提供 RED，再验证 GREEN |
| 修完自判"对了"直接合入 | 按 engagement 与 active source 满足审查覆盖，机械 continuity 可复用 |
| 未核实就全盘接受或为了争论而反对 | 以证据形成判断，核实后零分歧合法 |
| 用点 patch 掩盖设计/需求偏差 | 回读原意，明确遗漏直接修；新的价值取舍才升级 operator |
| cloud 修复不核对对应来源 | 沿 cloud 路径闭环；命中封板条件则走既有终局出口 |
| 前端改动只看代码不开浏览器 | 涉及 UX 必须打开浏览器实操验证 |
| 只修 reviewer 指的那一个点（补锅匠） | 先判 failure mode 是否同类，是则 audit 本 PR diff 全扫再修 |
| 同型 finding 多轮出现仍只做点修 | 查共同机制与修复是否落地；契约缺口回 plan 层补清 |

## 和其他 skill 的区别

| Skill | 关注点 | 时机 |
|-------|--------|------|
| `quality-gate` | 自己检查自己（spec + 证据） | 提 review 之前 |
| `request-review` | 发出 review 请求 | 自检通过之后 |
| **receive-review（本 skill）** | 处理 reviewer 的反馈 | 收到 review 之后 |
| `merge-gate` | 合入前门禁 + PR + remote review | reviewer 放行之后 |

### Review 沙盒生命周期

Reviewer 在 review 期间创建的沙盒：
- **创建**：按 `request-review` 约定的路径 `/tmp/cat-cafe-review/{review-target-id}/{reviewer-handle}`
- **回收**：**不由 reviewer 负责**。merge-gate 在 merge 后统一回收（Step 8.5）。
- Reviewer 放行后**不需要**主动清理沙盒，也不需要报告沙盒路径。

> 为什么不让 reviewer 自己清理：reviewer session 在放行后结束，下次唤醒时 context 已换，
> 根本不记得自己在 /tmp 留了什么。merge-gate 是唯一确定性终态。

## 下一步

Reviewer 放行（"LGTM"/"通过"/"可以合入"）→ `merge-gate`（SOP stage `merge`）。
