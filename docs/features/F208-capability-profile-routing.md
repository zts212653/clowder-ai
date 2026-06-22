---
feature_ids: [F208]
related_features: [F154, F078, F200, F192, F203, F209]
topics: [routing, capability-profile, dynamic-routing, eval, open-source]
doc_kind: spec
created: 2026-05-20
tips_exempt: "Internal infrastructure (cat dossier distillation pipeline) — no user-visible capability surface"
---

# F208: Capability Profile Routing — 能力画像档案 + 认知路由

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1

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
retrieval anchor truth source**。**F032 边界已由 KD-13 调整（operator signoff 2026-06-19）：
cat-config 退回纯身份配置，能力描述权归 F208 dossier；`teamStrengths`/`caution` 标
legacy-fallback**。F208 cat-dossier 消费 F209 `entity_id` 作猫/人标识键（不另造
namespace），详见 AC-A5（dual of F209 AC-B6, transferred 2026-05-23）。
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

### Phase C: 前端 settings 猫猫画像独立页

settings 独立 section（与成员管理平级，不复用 F154 member overview 入口——KD-11）。Console 前端走 console-dev 4 gate。
- 展示：每只猫能力画像卡（L1 6 字段可展开）+ 路由规则 + provenance
- read-only 起步 + operator"添加观察"轻量入口（观察进 pending/provenance，不直接
  覆盖总结层）；交互走 Design Gate（OQ-6）
- **前端是 must-have**：没有可见层 operator 无法贡献体感 = 三源断一源

### Phase D: L2 证据层 + operator 观察入口

直接接通已有数据源（memory search / thread events / review 记录），不等 F200
完全成熟再动（operator directive 2026-06-20："直接接通"）。两条线并行：
- **operator 观察入口**：画像页"添加观察"按钮，operator 写一句话 + provenance，存到
  dossier pending 层（不直接覆盖总结层）
- **L2 事实层展示**：画像卡片下接"最近证据"，从 memory search 拉该猫相关的
  review/传球/trajectory 事件。F200 TaskTrajectory + consumption signal 是
  增强数据源，不是前置依赖
- **总结层仍由 peer/operator 判断**——不纯算法生成（KD-3）

### Phase E: eval 回流蒸馏 + 开源 baseline

- **蒸馏通道**：新建 `DossierDistillationProposal` 概念（KD-16），不复用 F231
  `propose_profile_update`（语义/路径/审批粒度全不同）。proposal 契约见 KD-17
- **触发点**：feat phase close + review complete（事件触发，不用 cron）。在
  feat-lifecycle / review-complete 流程中加 distillation checkpoint
- **审批流**：proposal → Hub pending → operator approve/reject → 持球猫 apply draft
  到 `cat-dossier.md` → git commit + push（KD-18，v1 不自动 commit main）
- **安全锁**：`baseHash` 防 stale write（dossier 是共享文件多猫并行）；`sourceId`
  幂等（同事件不重复蒸馏）；`evidenceRefs` 空 = 创建失败（fail-closed，FM-2）
- **开源 baseline 打包**：**空模板 + Cat Café 示例档案**（示例标 demo，不作别人
  团队默认画像——别人的猫不是我们的猫）+ cold-start routing section（OQ-7 缓解）

## Acceptance Criteria

### Phase A（能力画像档案本体）✅
- [x] AC-A1: `docs/team/cat-dossier.md` 存在，含 L1 schema（一句话画像 + 6 字段）
- [x] AC-A2: 四猫（46/47/Maine Coon/Siamese）画像全部回填，每条总结带 provenance（来源+证据+日期）
- [x] AC-A3: L0 指针进 root md / session hook，猫每次在场能看到"该读画像"提示
- [x] AC-A4: 画像条目带时间戳，schema 支持演化（同一能力可有多条不同日期的总结）
- [x] AC-A5: `cat-dossier` **消费 F209 `entity_id`** 作猫/人标识键，不创建平行 cat ID / person ID namespace。**Dual of F209 AC-B6**（F209 spec 2026-05-23 transferred this AC to F208；详见 F209 KD-7 / KD-12）。F032 / identity-session 仍是 roster truth，F209 `entity_id` 仅作 retrieval anchor 镜像；F208 dossier 是 capability 画像层，引用 entity_id 不反写。

### Phase B（传球加载 + 非阻塞提醒） ✅
- [x] AC-B1: 猫传球时可按需加载目标猫 L1 画像（像 skill，不常驻）
- [x] AC-B2: session/handoff 文案含非阻塞提醒，不检测"猫有没有读画像"，简单传球不打扰

### Phase C（前端 settings 猫猫画像独立页）✅
- [x] AC-C1: settings 独立猫猫画像 section 展示每只猫能力画像卡（model 分组 KD-15 + 路由信号可展开）
- [x] AC-C2: 每条画像总结显示 provenance（来源 + 日期 + primarySources）
- [x] AC-C3: read-only 展示 ✅ + OQ-9 badge（"擅长领域由画像驱动"）✅。operator"添加观察"按钮 UI 留 Phase D（read-only MVP，持久化也是 Phase D）
- [x] AC-C4: 走 console-dev 4 gate（Product / Design-System / Implementation / Verification）
  - **Product Gate** ✅: Settings > 猫猫画像独立 section（KD-11 分离决策 + operator signoff 2026-06-19）
  - **Design-System Gate** ✅: Token-first（CSS vars + 现有 component primitives）；3 hooks 提取（useDossierProfiles / useDossierEvidence / useDossierObservations）
  - **Implementation Gate** ✅: 580 行 / 11 visual sub-components（结构合理不拆）；4-round gpt52 local + 2-round cloud review + sonnet fallback review
  - **Verification Gate** ✅: Alpha 3012 API 返回 12 cats / 12 modelGroups / 100% coverage；Playwright 渲染完整页面（所有模型组卡片 + 路由信号 + provenance badge + 添加观察按钮）；505 test files / 4420 tests all pass

### Phase D（L2 证据层 + operator 观察入口）✅
- [x] AC-D1: 画像页"添加观察"按钮，operator 写观察 + provenance，存到 dossier pending 层
- [x] AC-D2: 画像卡片接"最近证据"区域，从 memory search 拉该猫相关 review/传球/trajectory 事件
- [x] AC-D3: 总结层保持 peer/operator 判断生成（带 provenance），不被算法分数替代

### Phase E（eval 回流蒸馏 + 开源 baseline）✅
- [x] AC-E1: `DossierDistillationProposal` schema + store（Redis TTL=0，KD-17 契约），幂等（同 sourceId 不重复创建）。**Includes state machine endpoints (enabling AC-E2/E3)**：6 REST endpoints (CRUD + state transitions)，apply 只 mark status 不 git commit（KD-18 v1）
- [x] AC-E2: 蒸馏 checkpoint 接入 feat-lifecycle close + review-complete 流程（事件触发，非 cron）
- [x] AC-E3: operator 在 Hub approve proposal 后，持球猫可 apply draft → cat-dossier.md → git commit + push（KD-18）
- [x] AC-E4: 开源 baseline 打包 = 空模板 + Cat Café 示例档案（示例标 demo）+ cold-start routing section（OQ-7 缓解）

## Dependencies

- **Related**: F154（Cat Routing Personalization — 人工偏好层；F208 是认知路由层，独立通道，画像不自动改 `preferredCats`）
- **Related**: F078（Smart Routing — 机械路由链基础设施）
- **Related**: F200（Memory Recall Eval — Phase D 自动累积的数据源；in-progress，v1 不阻塞于其完成）
- **Related**: F192（Socio-Technical Harness Eval — Phase E eval 框架；in-progress，v1 不阻塞）
- **Related**: F203（Native System Prompt L0 — 若日后速查卡进 L0 的注入通道；v1 不进 L0）
- **Boundary**: F032（Agent Plugin Architecture — roster truth owner；KD-13 边界调整：cat-config 退回纯身份配置，`teamStrengths`/`caution` 标 legacy-fallback，能力描述权归 F208。operator signoff 2026-06-19）
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
| KD-8 | 能力画像唯一真相源 = dossier；cat-config `teamStrengths`/`caution` 降级为 legacy-fallback | 漂移发现：**两源一派生**——cat-config 和 dossier 独立描述能力（两源），L0 roster 从 cat-config 编译派生（一条链）。L0 不一致是 config/dossier 不一致的投影，不是第三个独立源。根因：运行配置字段（`teamStrengths`/`caution`）承载了能力判断 prose，语义边界错位；叠加 config=breed 粒度 vs dossier=cat 粒度的结构错配。dossier 更深更真实带 provenance，定为唯一能力画像源。operator signoff 2026-06-19（48 R1 纠正根因表述）| 2026-06-19 |
| KD-9 | fallback 链兼容社区——有 dossier 读 dossier，没有读 cat-config | 社区operator没有 dossier，用 `teamStrengths` 写"产品经理"式角色定位——这是他们唯一入口，删了他们没法描述猫。设计：`dossier?.oneLiner ?? config.teamStrengths ?? config.roleDescription`。不替社区判断"怎么定义你的猫"（KD-1 精神延伸）。**注：内置猫 dossier 缺失/parse fail 不静默 fallback——应 fail check 或显式 telemetry，防漂移被掩盖**（Maine Coon R1 P2）| 2026-06-19 |
| KD-10 | dossier 加结构化层（per-cat YAML block / JSON）| Phase B（传球加载）、Phase C（前端展示）、Phase E（开源打包）的共同前置。纯 Markdown 表格 parse 不住，前端和 compile-l0 都需要 machine-readable 数据 | 2026-06-19 |
| KD-11 | 前端两页分离——成员管理（配置）vs 猫猫画像（展示 + operator 观察入口）| 画像用途是"看"（传球判据 + operator 迭代体感），不是"管"。跟配置（model/开关/排序）混在一起 UX 错位。画像页是独立 settings section | 2026-06-19 |
| KD-12 | **所有 teammate roster / identity prompt projection** 从 dossier 结构化层派生 | 消费方不只有 compile-l0 `buildRosterRow`（line 243），还有 runtime `SystemPromptBuilder`（line 422 同样从 `teamStrengths` 拼 roster）。两条链必须同时切源，否则 L0 和 runtime prompt 说不同的话。fallback 链同 KD-9（Maine Coon R1 P1）| 2026-06-19 |
| KD-13 | F032 边界调整——cat-config 退回纯身份配置，能力描述权归 F208 | operator signoff 2026-06-19。cat-config 仍管 catId/model/开关/排序/硬限制（如"禁止写代码"）；`teamStrengths`/`caution` 标 legacy-fallback，**永久保留当社区兜底，永不删字段**（删了 KD-9 就破）。F032 feat doc 需同步更新 | 2026-06-19 |
| KD-14 | fallback 走 per-field 渐进，不被 `status:draft` 文件级门控 | 实现者容易顺手写 `if (dossier.status === 'stable') 用dossier else 用config`——这会导致 draft 期间全员 fallback 回 config，切源等于没生效。正确：**忽略文件级 status，按 per-field 有没有值渐进**。某猫某字段有值就用 dossier，没值就 fallback config（48 R1 blocking）| 2026-06-19 |
| KD-15 | **画像描述的是 model 认知能力，catId 是索引便利而非概念单位** | 我们家大多 catId:model = 1:1（唯一例外 opus = @opus + @antig-opus 共享 claude-opus-4-6），但社区场景是 **many catIds → one model**（一个团队 5 只猫都用 claude-sonnet-4，每只不同 persona）。画像描述的是 model 的认知特质（擅长什么/容易踩什么坑/什么场景该召唤），不是 catId 的。三层身份模型：模板层（per-model 认知模式）/ 塑造层（per-runtime 工具环境）/ 身份层（per-cat persona）——F208 画像 = 模板层。operator directive 2026-06-20 | 2026-06-20 |
| KD-16 | **蒸馏不复用 F231 `propose_profile_update`——新建 `DossierDistillationProposal`** | F231 `propose_profile_update` 语义 = 关系 primer（写 `private/profile/relationship/{catId}-primer.md`）；F208 蒸馏语义 = 能力画像总结层更新（写 `docs/team/cat-dossier.md`）。目标路径不同、审批粒度不同（F231 是整个 primer，F208 是 per-field per-cat）、消费方不同。复用 = 语义污染。新概念：`DossierDistillationProposal`，走 Hub approval 但独立类型。Maine Coon（GPT-5.5）R1 硬修正 | 2026-06-21 |
| KD-17 | **蒸馏 proposal 契约 schema** | `sourceEvent`（触发事件类型）/ `sourceId`（幂等键，防重复蒸馏）/ `targetCatId` / `targetFields`（被更新的画像字段）/ `evidenceRefs`（关联证据锚点，空 = 创建失败 fail-closed）/ `beforeSnapshot` + `afterDraft`（operator 审批时可看 diff）/ `rationale`（蒸馏理由）/ `status`（pending→approved/rejected→applied）/ `baseHash`（cat-dossier.md 当前 hash，防 stale write 覆盖并行修改）。Maine Coon设计 + 46 确认 | 2026-06-21 |
| KD-18 | **v1 蒸馏不自动 commit main——operator approve 后由持球猫 apply + commit + push** | 自动写 main 的 dossier 文件风险过高（并行猫 + merge conflict + 无 review gate）。v1：proposal 进 Hub pending → operator approve → 下次持球猫读 approved proposal → apply to dossier → git commit + push。和现有 profile-update 审批流一致（Hub approval），只是写入目标不同 | 2026-06-21 |

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
| R4 | "在 settings 成员画像里能看到猫猫画像、路由规则……不然很难和你们一起迭代" | AC-C1, AC-C2, AC-C3 | settings 页截图 | [x] |
| R5 | "eval → 反馈 → 自主进化 → 定制化" | AC-D1, AC-E1, AC-E2 | 自动累积 + 事件触发蒸馏 + 开源打包 | [ ] |
| R6 | "开源 baseline → 其他operator按领域累积" | AC-E2 | 空模板 + 示例档案 | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC / KD
- [x] 每个 AC 都有验证方式
- [x] 前端需求（R4）需求→证据映射表：Playwright 截图 `f208-ac-c4-dossier-overview.png` 覆盖模型分组+路由信号+provenance 展示

## Review Gate

- Phase A: 跨族 review（档案 schema + provenance 机制）
- Phase B: 跨族 review（传球加载机制 + 非阻塞边界）
- Phase C: Siamese design review（UX）+ 跨族 code review（console-dev 4 gate）
- Phase D: 跨族 review（接 F200 的 adapter contract）
- Phase E: 跨族 review + operator 确认开源 baseline 形态
