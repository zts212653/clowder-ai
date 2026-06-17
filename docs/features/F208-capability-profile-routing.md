---
feature_ids: [F208]
related_features: [F154, F078, F200, F192, F203, F209]
topics: [routing, capability-profile, dynamic-routing, eval, open-source]
doc_kind: spec
created: 2026-05-20
---

# F208: Capability Profile Routing — 能力画像档案 + 认知路由

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1

## Why

从 longform-002（《从 Role Agent 到能力画像》）Ch.0 主线衍生。文章核心命题：
AI-native 团队不该按岗位组织，该按**能力画像 × 任务画像动态匹配**。但文章只讲
**理念**没有**落地物**——operator追问"没有画像，未来如何动态路由？"

当前路由的真实状态：F154 已做"人工偏好层"（operator手动设 `preferredCats` /
`/focus` 选猫），但**猫自己传球时**的依据只有 L0 roster 的一行话（"Maine Coon：代码
审查专家"）——太粗。传球判断（"这个 500 行需求给 46 一小时推完，还是给Maine Coon+47
慢慢拆？"）需要知道每只猫的强项、盲点、协作反模式、历史表现，roster 一行话给不了。

operator directive：**不通过算法路由**——"让你们自己判断、自己传球"。所以本 feature
做的不是"任务来了算法决定谁做"的调度器，是一份**会成长的队友能力画像档案**，让
猫传球时有可靠判断依据。四猫（46/47/Maine Coon/Siamese）+ operator 各给一版，47 整合，三猫 R1
review 收敛。

**operator directive（2026-05-20）：不做 MVP 版本，做最终版本。** 本 spec 写完整终态
（Phase A-E），分阶段实施，但每个 Phase 都是朝终态走的真实切片——close 条件是
Phase A-E 全达成 + 完整愿景，禁止"Phase A 能用就 close"（见 KD-7）。

## Architecture Cell

```markdown
Architecture cell: identity-session（候选主 cell）
Map delta: update required — 待 Design Gate 确认是否需 new cell
Why: F208 把 agent identity 从静态 roster 一行话（cat-config.json）扩展为「能力画像
档案 + 认知路由」子系统。画像档案是 identity-session cell 的能力维度深化；但「认知
路由」（猫读画像自主判断传球）可能溢出为新的协作子系统。**F209 owns entity registry /
retrieval anchor truth source；F032 / identity-session owns roster truth**。F208
cat-dossier 消费 F209 `entity_id` 作猫/人标识键（不另造 namespace），详见 AC-A5
（dual of F209 AC-B6, transferred 2026-05-23）。
Design Gate 拍定主 cell 与 map delta。
```

## 核心原则：不做算法路由

算法路由会同时违反两条家规：
- **KD-8（给数据不给结论）**：算法把 task 分类后查表决定谁做 = 系统替猫做 intent
  判断。档案 + 猫自主判断 = 给数据（画像）不给结论（谁做由猫定）。
- **内容判断去中心化**（longform-002 Ch.0 骨架）：算法路由 = 中心 dispatcher =
  打回 Boss-Agent 架构。档案是统一基础设施，判断去中心化。

> 动态路由 = 当前持球猫基于画像 + 任务 + 证据做出的判断，不是算法替猫派单。

## What

架构 = 3 × 3 × 3：三层渐进披露 × 三源合成 × 三态演化。

**三层渐进披露**：L0 指针（每次在场，提示去读）/ L1 详细画像（按需加载，一句话
画像 + 6 字段）/ L2 证据层（trajectory / review 记录 / operator 观察，drill down）。
L0 **不进 native system prompt**（动态画像会 stale hardcode，Maine Coon R1 P2）。

**三源合成（分域）**：愿景/taste/体验域 → operator 体感最高；技术/协作/盲点域 →
peer 评价 + eval/trajectory 最高；自我反思优先级最低。

**三态演化**：baseline（landy + 四猫画像，开源初始版）/ accumulated（其他团队
fork 后按领域累积）/ evolving（eval 回流持续刷新）。

**L1 画像 6 字段 schema**：① 原生峰值 ② 被低估能力 ③ 坏直觉 ④ 召唤反信号
⑤ 互补&反模式 ⑥ 翻车熔断信号。

### Phase A: 能力画像档案本体

`docs/team/cat-dossier.md` —— 完整档案结构：
- L1 每只猫一句话画像 + 6 字段（四猫整合表回填，见 longform-002 thread 2026-05-20）
- 每条总结带 **provenance**（来源 + 证据链接 + 日期）
- L0 指针进 root md / session hook（"队友画像档案存在 + 复杂传球时该读"）
- 画像带时间戳，可演化

### Phase B: 传球加载 + 非阻塞提醒

- 传球时**像 skill 按需加载**目标猫 L1 画像（不常驻，用完即走）
- session/handoff 文案非阻塞提醒"复杂/不确定传球，先读队友画像"——**不检测"猫
  有没有读"**（检测 = 过度工程，Maine Coon R1 P2），简单传球不打扰

### Phase C: 前端 settings 成员画像页

复用 F154 member overview 入口。Console 前端走 console-dev 4 gate。
- 展示：每只猫能力画像卡（L1 6 字段可展开）+ 路由规则 + provenance
- read-only 起步 + operator"添加观察"轻量入口（观察进 pending/provenance，不直接
  覆盖总结层）；交互走 Design Gate（OQ-6）
- **前端是 must-have**：没有可见层 operator 无法贡献体感 = 三源断一源

### Phase D: L2 证据层自动累积

接 F200 TaskTrajectory + consumption signal，自动累积**事实层**。**总结层不能
纯算法生成**（否则滑回算法路由）——总结仍是 peer/operator 读事实后的判断，带 provenance。

### Phase E: eval 回流蒸馏 + 开源 baseline

- eval → 反馈 → 画像自主进化：trajectory/eval 累积事实层；peer/operator **事件触发**
  蒸馏总结层（feat close / review 完成时，不用 cron）
- 开源 baseline 打包：**空模板 + Cat Café 示例档案**（示例标 demo，不作别人团队
  默认画像——别人的猫不是我们的猫）

## Acceptance Criteria

### Phase A（能力画像档案本体）
- [ ] AC-A1: `docs/team/cat-dossier.md` 存在，含 L1 schema（一句话画像 + 6 字段）
- [ ] AC-A2: 四猫（46/47/Maine Coon/Siamese）画像全部回填，每条总结带 provenance（来源+证据+日期）
- [ ] AC-A3: L0 指针进 root md / session hook，猫每次在场能看到"该读画像"提示
- [ ] AC-A4: 画像条目带时间戳，schema 支持演化（同一能力可有多条不同日期的总结）
- [ ] AC-A5: `cat-dossier` **消费 F209 `entity_id`** 作猫/人标识键，不创建平行 cat ID / person ID namespace。**Dual of F209 AC-B6**（F209 spec 2026-05-23 transferred this AC to F208；详见 F209 KD-7 / KD-12）。F032 / identity-session 仍是 roster truth，F209 `entity_id` 仅作 retrieval anchor 镜像；F208 dossier 是 capability 画像层，引用 entity_id 不反写。

### Phase B（传球加载 + 非阻塞提醒）
- [ ] AC-B1: 猫传球时可按需加载目标猫 L1 画像（像 skill，不常驻）
- [ ] AC-B2: session/handoff 文案含非阻塞提醒，不检测"猫有没有读画像"，简单传球不打扰

### Phase C（前端 settings 成员画像页）
- [ ] AC-C1: settings 成员页展示每只猫能力画像卡（L1 6 字段可展开）+ 路由规则
- [ ] AC-C2: 每条画像总结显示 provenance（来源 + 日期）
- [ ] AC-C3: read-only 展示 + operator"添加观察"入口（观察进 pending/provenance，不直接覆盖）
- [ ] AC-C4: 走 console-dev 4 gate（Product / Design-System / Implementation / Verification）

### Phase D（L2 证据层自动累积）
- [ ] AC-D1: L2 事实层自动从 F200 TaskTrajectory + consumption signal 累积
- [ ] AC-D2: 总结层保持 peer/operator 判断生成（带 provenance），不被算法分数替代

### Phase E（eval 回流 + 开源 baseline）
- [ ] AC-E1: 画像总结层蒸馏由事件触发（feat close / review 完成），非 cron
- [ ] AC-E2: 开源 baseline 打包 = 空模板 + Cat Café 示例档案（示例标 demo）

## Dependencies

- **Related**: F154（Cat Routing Personalization — 人工偏好层；F208 是认知路由层，独立通道，画像不自动改 `preferredCats`）
- **Related**: F078（Smart Routing — 机械路由链基础设施）
- **Related**: F200（Memory Recall Eval — Phase D 自动累积的数据源；in-progress，v1 不阻塞于其完成）
- **Related**: F192（Socio-Technical Harness Eval — Phase E eval 框架；in-progress，v1 不阻塞）
- **Related**: F203（Native System Prompt L0 — 若日后速查卡进 L0 的注入通道；v1 不进 L0）
- **Related**: F209（Evidence Recall Optimization — F209 owns 实体身份层（`entity_id`/alias/provenance 真相源）；F208 cat-dossier 是能力画像层，**消费 F209 `entity_id` 作猫/人标识键，不另造 ID namespace**，见 F209 AC-B6 / KD-7）

## Risk

| 风险 | 缓解 |
|------|------|
| "档案"悄悄滑回"算法路由" | 总结层不能纯算法生成，必须 peer/operator 判断 + provenance（KD-3） |
| 动态画像塞 L0 变 stale hardcode | L0 只放指针，画像本体放 docs 按需加载（KD-4） |
| 画像变自评简历（只写优点） | 6 字段强制含 ③坏直觉 ④反信号 ⑥熔断信号；三源合成自评优先级最低 |
| scope 失控（全部 Phase 同时推进） | Phase A-E 硬边界 + 依赖链（KD-6） |
| 新猫 cold start 三源全空 → 永不被路由 | OQ-7，Phase 设计阶段解决（试用路由 / 固有特质起步） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不做算法路由，做能力画像档案 + 猫自主判断 | operator directive；算法路由违反 KD-8（给数据不给结论）+ 内容判断去中心化 | 2026-05-20 |
| KD-2 | 立新号 F208，不挂 F154 | F154 = 人工偏好层（done），F208 = 能力画像认知路由层，不同维度（关联检测确认） | 2026-05-20 |
| KD-3 | 总结层不能纯算法生成，必须 peer/operator 判断 + provenance | 算法分数 = 黑盒结论，猫读分数 = 滑回算法路由。带 provenance 才是"给数据" | 2026-05-20 |
| KD-4 | L0 不进 native system prompt，只放指针 | 动态画像会变，塞 L0 = stale hardcode（Maine Coon R1 P2） | 2026-05-20 |
| KD-5 | 三源合成分域，不是单一优先级排序 | operator 体感对愿景/taste 最准，对技术/协作行为 peer/eval 更准（Maine Coon R1 P2） | 2026-05-20 |
| KD-6 | Phase A-E 硬边界 + 依赖链 | 防"全部 Phase 同时推进失控"（46 R1 P2-1） | 2026-05-20 |
| KD-7 | 做完整终态，不做 MVP 版本 | operator directive 2026-05-20：spec 含完整 Phase A-E，close = 完整愿景达成，禁止"Phase A 能用就 close"留脚手架尾巴 | 2026-05-20 |

## Eval / Tracking Contract

| 项 | 内容 |
|----|------|
| **Primary Users** | 做路由决策的猫（传球者）。Activation Signal：传球前 Recall 画像的比例 > 0 |
| **Friction Metric** | 路由错配率（传给不合适的猫 → 返工/二次传球）；画像被读但判断没用上的比例 |
| **Regression Fixture** | ① Maine Coon+47 组队做实现 → 画像须提示协作反模式（fallback 牛角尖）② 复杂架构图任务 → 画像须路由到Maine Coon而非Siamese ③ 新画像更新必须带 provenance，缺来源 = 不合法 |
| **Sunset Signal** | 6 个月后路由错配率无下降 / 画像从未被任何传球猫读过 → 回滚为纯 roster |

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "我们应该做的是对猫猫的能力建模画像" | AC-A1, AC-A2 | cat-dossier.md 含四猫 6 字段画像 | [ ] |
| R2 | "不应该通过算法去路由，让你们自己判断、自己传球" | KD-1, AC-B1 | spec 核心原则 + 传球加载是"猫读档案判断"非算法派单 | [ ] |
| R3 | "简单的路由看一眼总结，复杂的看 eval/peer/operator评价" | AC-A1, AC-D1 | 三层渐进披露 + 三源合成落地 | [ ] |
| R4 | "在 settings 成员画像里能看到猫猫画像、路由规则……不然很难和你们一起迭代" | AC-C1, AC-C2, AC-C3 | settings 页截图 | [ ] |
| R5 | "eval → 反馈 → 自主进化 → 定制化" | AC-D1, AC-E1, AC-E2 | 自动累积 + 事件触发蒸馏 + 开源打包 | [ ] |
| R6 | "开源 baseline → 其他operator按领域累积" | AC-E2 | 空模板 + 示例档案 | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC / KD
- [x] 每个 AC 都有验证方式
- [ ] 前端需求（R4）需准备需求→证据映射表（Phase C 时做）

## Review Gate

- Phase A: 跨族 review（档案 schema + provenance 机制）
- Phase B: 跨族 review（传球加载机制 + 非阻塞边界）
- Phase C: Siamese design review（UX）+ 跨族 code review（console-dev 4 gate）
- Phase D: 跨族 review（接 F200 的 adapter contract）
- Phase E: 跨族 review + operator 确认开源 baseline 形态
