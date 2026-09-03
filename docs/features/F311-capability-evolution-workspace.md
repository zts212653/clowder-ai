---
feature_ids: [F311]
related_features: [F100, F153, F192, F202, F208, F227, F232, F246, F266, F267, F278, F281, F284, F290, F292, F293, F298, F299, F300, F302, F307, F309, F310, F313, F314]
topics: [self-evolution, meta-rsi, capability-evolution-workspace, evolution-program, rubric, trajectory, credit-assignment, versioned-assets, per-cat-harness, workspace, federation, human-disposition-feedback, durability]
doc_kind: spec
created: 2026-08-28
description: "对任意家内或外部的受授权可变对象一句话开启受治理的进化：薄联邦控制面持有 Program 编排与 owner refs，由对象自己的 owner/Agent 在原系统写回并回传 outcome；人握价值、冻结与批准权，全程可感知，一切资产可回滚或退役。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-09-02T01:26:00-07:00
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/features/F311-capability-evolution-workspace.md"
mcp_admission_claims:
  - ref: "file:docs/features/F311-capability-evolution-workspace.md"
    toolName: cat_cafe_start_evolution_program
    resourceFamily: evolution-program
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F311-capability-evolution-workspace.md"
    toolName: cat_cafe_get_evolution_program
    resourceFamily: evolution-program
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F311-capability-evolution-workspace.md"
    toolName: cat_cafe_link_evolution_program_observation
    resourceFamily: evolution-program
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F311-capability-evolution-workspace.md"
    toolName: cat_cafe_update_evolution_program
    resourceFamily: evolution-program
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F311-capability-evolution-workspace.md"
    toolName: cat_cafe_constitute_evolution_program
    resourceFamily: evolution-program
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F311-capability-evolution-workspace.md"
    toolName: cat_cafe_open_evolution_round
    resourceFamily: evolution-program
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F311-capability-evolution-workspace.md"
    toolName: cat_cafe_record_evolution_evaluation
    resourceFamily: evolution-program
    boundaryKind: resource-entry
    decision: accepted
---

# F311: Capability Evolution Workspace（Meta-RSI 产品控制面）

> **Status**: in-progress (v5 final-vision phases; Gate 0A + Phase 1–2 landed; Phase 2 Alpha loaded-runtime accepted; Phase 3 landed (AC-31–34 met; F267 owner-contract extended additively — see Phase 3 status block); Phase 4 next) | **Product phase owner**: Maine Coon (@codex-sol, gpt-5.6-sol)（本轮 operator 指定执行） | **Architecture co-creator/reviewer**: Ragdoll (@fable5, claude-fable-5) | **Priority**: P0
>
> **operator signoff**: 2026-08-28 [thread-id] `0001787926983474`（今年双旗舰之一，与 F310 Growing 并列）。
> **v1 修订**: 2026-08-28 owner review by @codex-sol（`0001787928166311` 后续 verdict，CHANGES_REQUESTED 六 P1）——核心纠偏：**引用不是所有权**；F311 是薄联邦控制面，不私藏任何领域真相。
> **v2 修订**: 2026-08-28 operator 授权 @codex-sol 接管修复（`0001787930692641`）——补齐 decision-surface census、证据消费归属、代理 claim 隔离、ADR-045 持久性与 F309/content-owner 边界；Phase 0 仍保持暂停，等待独立方法论复核与最终愿景审核。
> **v3 修订**: 2026-08-28 平行 @codex-sol 方法论复核（exact `c12fc81446d64a074249b732c0ff854c16d84655`，advisory findings）——补齐用户显式 retention/forget opt-in、optimizer exposure 隔离与 promotion holdout、value owner + Eval 四角色分权、写回前 intervention card 与双 falsifier；Phase 0 继续暂停，等待最终愿景审核。
> **Final seal**: 2026-08-28 @fable5 对 exact `87d072fec160074131122a47063cbad6712310c5` 给出 **APPROVED**（coordination terminal `0001787932225594`）：16/16 operator 需求在位，未发现 F311 吞并 F299/F267/F281/F309/F300/source owner；Phase 0 审核暂停解除，仅 OQ-1 PM/分工待 operator 指定。
> **v4 operator correction**: 2026-08-28 `0001787933034346-000451-44d5c067`——v3 的“先造 Program 容器、再跑 Harness v1→v2”会滑成可丢弃 MVP/脚手架，方向作废。确定契约/运行闭环 bug 由真实 owner 立即修；F311 同步建设永久控制面并接回 owner truth。首个 Evolution Program 必须来自真实用户目标与不确定效用 claim，不拿这些 bug 冒充“自进化案例”，也不为证明自己另造一套。
> **v4 final seal**: 2026-08-28 @fable5 对 exact `9066fe0404742630f42742a26edf3ac1d0c1ab1b` 给出 **APPROVED**（`0001787934042009-000484-68a84358`，one-shot，无 findings）：真实 bug 原 owner 真修、F311 永久接线、E0 合格真实 Program、无大瀑布四项全部通过；v3 方法论边界零损耗。
> **Gate 0A landed**: 2026-08-28 PR #4053 合入 `main`（merge `0bdda236e6c968263369cc9d39c19dfb5efefbc8`）；canonical `capability-evolution-control` 薄 cell、Owner Matrix 与 production-only join 契约已冻结。独立架构审核对 exact `0095c9c60ba75621e7ece992c229c5c8e5dc43fb` **APPROVED**、无实质 finding（`[thread-id]#0001787939277471-000579-4e373607`）。
> **v5 operator correction**: 2026-08-30，继 `0001788142745436-000574-3459f7d0` 强调“要的是一整套能力闭环”后，operator 再次以 Magic Word **“脚手架”**拉闸：Phase 不得围绕“先选一个对象跑通”或“先修完依赖”组织，必须直接按 F311 终态产品的永久能力器官拆分。首个 E0 Program 只是整环生产验收输入；owner bug repair 是横向车道；二者都不再充当产品 Phase。
> **开放世界代理式进化愿景澄清**: 这不是 2026-09-02 临时扩出的新方向。operator 在 2026-08-28 已明确把“家里的记忆系统 / 外部托管的记忆系统 / Claude Code Harness”并列为任意对象（`0001787926057722-000244-97daafa1`），并把“外部托管”定义为 day-1 schema 约束。2026-09-02 再次钉死执行含义（`0001788337265835-000643-0a6a598a`）：对象和 Harness 不必属于 Clowder AI；获得对象 owner 明确授权后，可由该对象自己的 Developer/PM Agent 在其原仓库或原系统修改可变资产、测试、发布与回滚，F311 只编排 Program、Approval 与 refs/lineage 并接收可信 outcome receipt。F311 不搬运外部真相、不凭空扩权，也不把执行代理升级为价值裁判。
> **Phase 1 landed + Alpha accepted**: 2026-09-01 PR #4172 合入 `main`（merge `ed998da4088052a307ea6478a87cef6f86d8f215`）；非作者 @opus5 对 exact `f32e6d888179edc791cc47a9c11996a801b2cb0c` 最终 **APPROVED**，canonical `pnpm gate` PASS。Alpha loaded journey 在 thread `[thread-id]` 只输入“我们来进化 F311 Alpha 聊天入口验收”，猫经正式 MCP action 创建 `evolution-program:407070292b9ce01f374c523ef18de326`；REST、猫动作与 F307 Workbench 读取同一 Redis append-only truth。另以三个 Program 验证 pause/resume/needs_expert/withdraw/retention 审计、409 projection 恢复、terminal 不自动 TTL、active forget 原子 withdraw+retention 与四键同 TTL，以及进程重启后完整 replay。该验收运行于 Alpha（3011/3012/4111/6398），不冒充 production runtime deployment。
> **Phase 1 production acceptance repair**: 2026-09-01 operator 现场验收发现 Home 直接倾倒机器化 Program projection，缺少一等产品入口；PR #4184 以 `dfcfa666d2ed6727c02a9e4242caf7d32565417a` 合入修复，非作者 @opus5 对 authored exact HEAD `37b8a55fd64cbba7775c8ea8484cc4e8ccf96719` 最终 **APPROVED**。Post-merge Alpha 在 exact `dfcfa666d2` 上真实点通 Workspace Home → 一等“能力进化”入口 → 专属 Capability Evolution Workspace → 人话 Program 标题、阶段与下一步 → typed blocker、历史与谱系 → canonical 生命周期 surface，并对 `evolution-program:407070292b9ce01f374c523ef18de326` 执行 pause/resume，API 两次 command 均 200、sequence `1→2→3`。该修复只改 Web presentation/admission，没有触碰 Phase 2 Program owner/composition 或 Phase 3 Attribution。
>

> **富文本导览**：[F311 终态施工地图：Phase 0 → 6](assets/F311/f311-final-phases-v5.html)——以用户旅程解释每个 Phase 的永久产品器官、用户收益、完成标准与 owner 边界。原始 Clowder AI 富文本锚点：`[thread-id]#0001788145036222-000045-f449310b`。

> **Phase 2 landed + Alpha loaded-runtime accepted**: 2026-09-01 PR #4196 合入 `main`（merge `6a9880574fa0f4030bdb6361e6cc47dc073a595d`）；非作者 @opus5 对 authored exact HEAD `1c93c3066518099e119be07e256eba4e756ba740` 最终 **APPROVED**。
> 按风险只运行 API build、五个相关 suite（24/24）、diff check 与 staged Biome，未重复运行 full gate/review。Alpha 在 exact merge 上加载成功（Frontend/API/Redis 3011/3012/6398）；三个 canonical Program 均从真实投影返回 F192 event/quota/time 注册、weekly `nextEvaluationAt` 与 owner drilldown。
> 当前没有可用 F267 proof record，F281 episode 也为空，因此真实 Program 诚实保持 typed `insufficient`，列出 trajectory/异质 owner surface/evidence role/consumption/optimizer exposure/promotion holdout 缺口；未追加假 ref、未复制 payload、未造 mock。
> Hub visible-page receipt 因没有 matching client 未确认，故本次只声明 loaded-runtime/API acceptance，不冒充已完成可见点击验收。

Architecture cell: capability-evolution-control
Map delta: new cell landed via Gate 0A（薄控制面）——它**只拥有**：Program identity/lifecycle、Goal/claim/经济页、各领域资产的 **owner refs**、调度与阶段投影、keep/tune/rollback/sunset 编排状态。上述用户可见生命周期是 **TTL=0、跨重启恢复的 canonical Program truth**；瞬时 scheduler/cache 只能重建投影，不能决定生命周期。**不拥有**：rubric 内容、原始轨迹、verdict lifecycle、资产版本、写回结果、通用 feedback/证据消费账本。
Why: "一个被进化对象的完整进化回合"这个绑定当前无 cell 拥有；但绑定的实现是引用与编排，禁止在 F311 内私造 TraceStore/Queue/审批状态机/第二套版本系统。

F311 复用 `harness-eval`（F192 registry/trigger/verdict + F266 closure + F267 validity）。**纠正 v0 错误：`memory` 不是 trace owner**（memory 只负责索引/检索；invocation trajectory 归 F299 所在链路）。

## 硬约束（v5，负向契约优先）

1. **F299 是唯一 invocation trajectory 产品面**：F311 不拥有 TraceStore、trajectory ID、证据 manifest、第二套轨迹页面；共享锚点只用 `inv:<id>`，证据 payload 归各 source owner；invocation trajectory 的查看/解析/证据织入走 F299 与 source-owner adapter，其他外部 evidence 仍归对应 source owner。**缺能力 → 扩 F299 或改造 source owner，不在 F311 补一套**（架构归一铁律，operator `0001787928166311`："不要自己再多造已经有的那些轮子"）。
2. **版本归资产 owner**：v0 的"通用 Version DAG"改为**联邦 lineage view**——F311 只保存 `AssetVersionRef` 与因果边（哪条证据触发哪次改动、被谁复用/退役）；版本、回滚、mutation receipt 由资产 owner 持有（提示词/harness 版本 = 吴浪 R1 地基；**canonical 内容 bytes/schema/version = content owner；F309 只持协作 anchor/patch/disposition 与 owner-returned change receipt**）。哪个 owner 缺版本能力，改造那个 owner。
3. **审批不自建**：delta 卡投递走 F246 审批聚合；F311 不造审批状态机。
4. **宿主不自建**：产品面以 surface descriptor 提供给 F307 Composable Workbench（F284 为旧壳与迁移源）；F311 不存 layout。
5. **单变量归因**：一条 Program 只改一层对象；跨层改动拆成多条 Program/claim。
6. **决策信号不集中建账**：Phase 0 先做 decision-surface census——拒绝/取消/延后/撤回后的结构化 why 与有界 episode 复用 **F281**；审批 action/index 复用 **F246**；内容编辑/采纳/undo receipt 复用 **F309 + content owner**；其他采纳/复用/留存由各 source owner 持 canonical truth。F311 只注册 source ref、join key 与 named consumer。缺通用能力时改造最自然的原 owner，禁止在 F311 新建 `DecisionSignalStore` 或总 feedback schema。Agent 读取这些 owner truth 的同源 grounding/相关性策略复用 **F300**；**F300 仍为 spec-only 时只记依赖与 gate，禁止 F311 临时内建替代读取层**。
7. **证据消费与 optimizer exposure 归 eval/source owner**：frozen cohort、证据角色、查询/消费/失效、重裁输入，以及样本在 `discovery / attribution / validation` 各阶段是否暴露给 candidate/rubric 的自适应选择，属于 F192/F267 measurement bundle 或 source owner；F311 只持 certificate/cohort/result/exposure refs。没有 owner-backed consumption + exposure proof 时结果必须是 `insufficient`，禁止补一个 CEW query ledger。冻结 cohort 可用于归因、可比性与旧/新尺 × 旧/新候选的 2×2 复判，但**promotion 另需 source owner 可证明 sealed 或 time-fresh、未被 candidate/rubric selection 看过的独立 holdout**；拿不到则 `insufficient` / `incomparable`，不得把同一污染 cohort 冒充 unseen-world 证明。
8. **用户可见 Program 承诺服从 LL-048 + ADR-045**：Program identity/lifecycle、双证 refs、lineage 因果边、批准/回滚/sunset 历史在 active 与 terminal 状态都默认 `TTL=0`，跨进程/重启可恢复；**完成、关闭、毕业或 sunset 本身都不得产生 TTL**。只有用户/operator 对该 Program 做出显式 `retention/forget` opt-in 后才允许 TTL/GC，且不得由 GC 反向定义 Program 生命。F298 是持久性法源/家族 verdict 锚，不成为 F311 store；Gate 0A 已将 lifecycle ownership 归 `capability-evolution-control`，v5 plan 进一步冻结 append-only event stream 技术落点。
9. **价值所有权与 Eval 四角色分权**：Goal/claim certificate 持 `value_owner_ref`；measurement certificate 持 `observer / domain_owner / consumer / calibrator` 的 owner refs 与 `role_overlap_justification`，不搬运 domain truth。用户不懂技术域不等于失去价值裁决权，专家能校准事实/技术子 claim 但不能替代个人价值 owner；反之，仅有 value owner 也不能冒充领域校准者。只有当前 claim 缺少射程内且合格的必要角色时才进入 `needs_expert/insufficient`。代理 Program 可回传 evidence/subclaim result，永不转移原价值 verdict。
10. **归因不能直接产写回**：进入 Change Review 前必须引用一张由 F267/source owner 持有的 intervention card，至少包含 `observed_loss / competing_attributions / key_scientific_question / intervention_lever / causal_rationale / expected_delta / guardrails / replay_cohort / independent_holdout / intervention_falsifier / rubric_reopen_trigger / cost_and_rollback`。F311 只持 card ref 与 gate 状态；缺卡、缺独立 falsifier，或 holdout 无隔离证明时不得生成可批准的 writeback。
11. **不造 CEW 玩具纵切片，也不把普通 bug 包装成自进化**：所有 Phase 都直接交付终态产品会永久保留的能力，不建设 Program demo、样例 Harness、临时 adapter、影子 UI 或模拟 owner。确定契约/运行健康问题按 ADR-031 机制选择直接进入 canonical owner 的 test/guard/telemetry 修复线；F311 只登记依赖与永久 join。真实 Evolution Program 另须满足 E0：真实用户目标、明确 consumer、存在 keep/tune/sunset 决策，且效用确有不确定性。若既有 owner 能力不合适，直接改造 owner；所有 F311 新增件从第一天就是生产架构的一部分，禁止“验证 MVP 后拆掉重做”。
12. **Phase 只按终态能力器官拆，不按首个对象或依赖 bug 拆**：产品主线始终是 `建制与可见 → 开眼与取证 → 评估与归因 → 受治理写回与复验 → 多对象联邦 → 机制自身进化`。首个 E0 Program 只用于验收整条生产 journey，不定义 schema、Phase 或优先对象；dependency repair 只是一条横向 owner 车道，不能把 F311 退化成 bug 修理队，也不能成为等待全家修完的大瀑布。
13. **开放世界代理不等于归属迁移或无限授权**：Evolution Object、asset owner 与执行 Agent 均可在 Clowder AI 之外；F311 只接受 owner-authenticated、exact target/version 绑定且由 owner-backed adapter contract 明确允许的动作。获授权的外部 Agent 可以在对象的 canonical 仓库或系统内改 Skill、prompt/角色配置、`CLAUDE.md`/`AGENTS.md`、hooks、commands、MCP、subagent 编排、代码、测试、CI 与部署配置，并返回 review/deploy/rollback/outcome receipts；资产 bytes、权限、运行状态与 mutation truth 始终留在外部 owner。未授权表面、闭源模型权重/二进制或没有正式 mutation API 的对象必须返回 typed blocker，禁止手工旁路、复制进家里或用“Agent 能操作”冒充“owner 已授权”。执行权可代理，Goal/rubric 冻结、风险边界和 value verdict 不可偷偷代理。

## Canonical Owner Matrix（F311 与既有 feature 的权限拆分）

| 能力 | 权威 owner | F311 只能做什么 |
|---|---|---|
| Invocation trajectory / Inspector | **F299** | 引用（`inv:<id>`）、投影、发起下钻 |
| Logs / metrics / traces | **F153** | 消费 source ref |
| Eval registry / trigger / verdict | **F192** | 注册 Program 所需 eval |
| 度量出生证、版本、`insufficient` | **F267** | 复用 validity/calibration 契约 |
| Verdict 认领/复评/关闭/SLA | **F266** | 引用 case lifecycle |
| Analysis→Approval→repair→outcome 的 delivery/acceptance command | **F313** | 引用完整 closure lineage；不接管 F245/F246/F266/source owner 的状态 |
| Magic Word 认知事件 | **F227** | 作一种上游源；不扩成通用决策账本 |
| 爪感差 signal → disposition → responsibility → receipt | **F278** | 联邦读取五态责任投影、分母、evidence refs 与 durable receipt；不建第二 inbox/duty ledger/disposition workflow |
| 人类 disposition why / episode / envelope | **F281**（业务裁决仍归 producer） | 引用 exact-subject decision/feedback receipt；不外推单条反馈 |
| 审批 action / index | **F246** | 投递/引用 action receipt；不保存审批状态 |
| 其他采纳/复用/留存信号 | **各 source owner** | 注册 source ref、join key、consumer；不集中建账 |
| Agent owner-truth grounding / same-source read | **F300** | 复用同源读取、相关性与旅程验收；不造第二状态图 |
| 猫能力画像 | **F208** | 通过 proposal/revision 链写回 |
| 实时路由上下文 | **F293** | 验证 routing consumption；不改画像 |
| Workspace/Workbench 宿主 | **F307**（F284 迁移源） | 提供 surface descriptor |
| Canonical 内容 bytes/schema/version/apply/undo | **content owner** | 只持 `AssetVersionRef` 与 owner receipt |
| 协作 anchor/annotation/patch/disposition/change receipt | **F309** | 消费协作 outcome/receipt；不反推内容版本 |
| 产出创建 provenance | **F232** | 引用创建锚点 |
| Eval cohort / 证据消费 / 重裁输入 | **F192/F267 + source owner** | 只持 certificate/cohort/result refs；无 proof 则 `insufficient` |
| Eval evidence role / optimizer exposure / promotion holdout | **F267 + source owner** | 只持 role/exposure/holdout refs 与 gate；不复制 cohort payload |
| Measurement roles / intervention card | **F267 + source owner** | 只持四角色 owner refs、overlap justification、card ref 与门状态；不拥有角色真相或 card 内容 |
| Program durable lifecycle / retention choice | **`capability-evolution-control`**（受 LL-048/ADR-045 约束；F298 仅提供法源/家族 verdict） | active/terminal 均持 canonical TTL=0 truth；只执行用户显式 retention/forget 选择，cache 只做可重建投影 |
| 外部 signal/plugin/governance/mutation | **外部 asset owner**（F202/F292/F302 提供 owner-backed adapter；F246/F266/F313 复用审批、派工与 outcome closure） | 只持 capability/permission、target/version、evidence、action 与 receipt refs；不复制外仓资产或治理状态 |

## ASR 校正表（operator 语音输入的术语规范）

| 原稿写法 | 统一为 | 依据 |
|---|---|---|
| Honey / honeycomb | **Harness** | operator 明确校正（`0001787926720065`） |
| crazy assignment | **credit assignment（归因）** | 上下文 |
| Scare / Scale / skier | **Skill** | 上下文 |
| 新鲜的 beta | **新鲜的 bit** | 白皮书 §13/§19 |
| 增值锚点 | **真值锚点（ground truth anchor）** | 白皮书 GT 分层 |
| F293 | **F293 Live Routing Context** | repo 实查 |

**Fresh bit 严格定义（v3）**：来自**该 claim 所在 GT 域**、且其证据角色与 optimizer exposure 可证明的新证据——不是"外部搜索结果"，也不只是"本 Program 本轮没读过"。搜索只在事实域构成真升级；"这个用户喜不喜欢"的 bit 只能来自该用户的真实决策流（白皮书 §19 三种联网裁判判定）。用于 promotion 的 fresh bit 还必须处在 sealed/time-fresh 独立 holdout 中，未参与 candidate/rubric 的发现、归因或选择。

## Why

三个真实的痛，全部有家内实证：

1. **教导劳动不复利**：operator的每一次纠正、采纳、无视散落在聊天流里，唯一沉淀方式是猫事后人肉写 feedback 文件。换模型、换猫，同样的品味和纠偏重新交学费。
2. **进化散落且靠人肉驱动**：rubric 实践（eval-design）、遥测（F153/F299）、事件（F227）、verdict（F192/F266/F267）、画像更新（F208）各自存在，但每一次"这里要立尺子""这里要打点"都是 operator 在现场驱动。operator 原话（`0001787926057722`）：**"现在这些都是散落的，都是我在驱动着你们做——要变成真正的猫猫自己去学习、思考、搜索，获得新鲜的 bit。"**
3. **Harness 大锅饭**：同族猫共享几乎同一套 harness，每只猫（每个模型）失败模式不同。operator 原话（`0001787926615149`）：**"每一只猫都能有最合适它的那一套 harness，而不是大家都在吃大锅饭。"**

终态承诺（operator 原话）：**"我能无负担地打开聊天页面说：我们今天来进化一个制作视频的 Skill / 一个外部托管的记忆系统 / 一个 Claude Code 的 Harness——右边 Workspace 能看到你们正在增加 rubric、增加打点，一切可视化，一切能感知到系统在进化。"**

## Current State / 现状基线

**当前 dependency-pain 与 owner repair 证据（v4）**：operator 在 `0001787933034346-000451-44d5c067` 展示的 F248/Eval Hub 卡片里，`eval:freshness` 曾显示“修复已落地”，但独立复评仍停在“等待复评”并超时升级；该缺口由 F266 owner 修复，PR #4056 已以 exact HEAD `1da990d6fbacd8e7071b4ddcfca1ba1426aa8fe2` 通过完整 `pnpm gate` 后 squash merge 为 `025eee675ef93253990d3962b3d318504acb27e2`（terminal source `0001787969475150-000791-d13ce27e`）。2026-08-30 owner 再核验确认：runtime deployment revision `7855f5e0adfb57c4bc633f512ee3e3638e64915e` 已包含该 merge，故代码已进入 **live binary**；但 stable case `eval-case-v1-fadb1e370581c53b1c60797f767540ea871d2294a17c4569b28bdacb3b2b02ae` 仍为 `closureStatus=escalated / reevalStatus=pending`，没有 trusted re-eval receipt，也没有可验证的 active invocation/carrier。F311 因而只声明 `live_code_active`，不把部署存在冒充 live acceptance。F278 曾三次 production reopen，证明“爪感差采到了”不等于“责任真的闭合”；其 owner 已于 2026-08-28 完成 Phase G production acceptance（merge `2e2f4455049f267375f8d72fbd62edd284b62fa4`，owner acceptance `0001787934303842-000491-4dd25ef6`，durable duty receipt `0001787140800835-000075-cad455f5` 44/44，独立 signer `0001787919538372-000072-fcfb3069` 处理 26 bundles / 35 signals、`signature_waiting=0`，owner closure `0001787935528248-000514-bb2dbccd`）。**F266/F278 都是 owner-backed dependency evidence，不是 Evolution Program 候选**：F311 只消费 F266 case lifecycle refs 与 F278 `unreviewed / bound_in_repair / signature_waiting / blocked / terminal` 投影、分母、evidence refs、durable receipt；不得复制第二套复评或责任闭环。

### Dependency Repair Ledger（owner 真相投影，不是待补齐清单）

本轮回看 operator 拉闸原文、Gate 0A census、owner thread 与任务真相后，确认当时带 source ref 的**真实漏水点只有 F266 与 F278 两条**。Owner Matrix 的其余行是 join 边界，不等于每个 owner 都有一只待修 bug；只有真实运行命中、能指向 canonical owner 的故障才进入本账本。

| Owner surface | F311 投影状态 | Canonical evidence / 下一真相条件 |
|---|---|---|
| **F278 responsibility loop** | `owner_ready_production` | merge `2e2f4455`；44/44 durable receipt；owner closure `0001787935528248-000514-bb2dbccd`。F311 可读取五态投影与 receipt，不复制 inbox/ledger/workflow。 |
| **F266 verdict closure** | `code_complete · live_code_active · live_acceptance_pending · no_active_executable_custody` | PR #4056 merge `025eee675`、full gate PASS；deployment revision `7855f5e0a` 已包含该 merge。两条实现任务 `0001787966912715-000738-77cfbed8`、`0001787934574646-000495-5589a3d7` 均为 `done`，目前没有必需的 F266 代码残留。生产 re-eval task `0001786849624181-000188-6997e901` 仍为 `doing`，projection 仍持 lease ref `594742fb-da9d-446c-a39d-fc28679ec88d:1`，但 `/api/executions/active` 无 `thread_eval_freshness` execution，thread 也没有匹配 task/lease 的持久 carrier；因此旧 lease ref 不等于 active custody。Owner acceptance task `0001786353574933-000146-1a44365c` 继续 `blocked`，其剩余范围明确为 **LIVE ACCEPTANCE ONLY**；旧 Design Gate task `0001784382099535-000749-b9d31ba6` 仍由 owner `gpt52` 保持 `blocked`。下一真相条件是 reconciler/eval cron 重新附着现有 task 并产生 executable carrier 或 typed blocker，随后完成 trusted same-case re-evaluation；较旧 F192/F200/F203 owner-thread 写入另需有界 operator 生产授权。 |
| **F299 invocation trajectory** | `owner_contract_available · no_open_bug_evidenced` | 唯一 `inv:<id>` trajectory 产品面与负向契约已在 Gate 0A 冻结；本轮没有查到 F311 专属未闭 bug。首个真实 Program 使用时按 join contract 实测，若失败再投 F299 owner。 |
| **F192 / F267 / F246 / F307 joins** | `normal_dependency · no_open_bug_evidenced` | 它们分别持 verdict trigger/validity/approval/workspace projection；本轮没有证据把这些依赖升级为 bug。是否足够服务某个 Program，只能由该 Program 的真实 claim 与 owner receipt 验证。 |
| **F300 same-source read** | `spec_only_dependency_gate` | 这是尚未具备可执行契约的能力缺口，不是假装成运行 bug；F311 不临时内建替代读取层。 |

账本更新规则：owner 的 merge、task、live acceptance、receipt 分开记；`merge ≠ live`，`related feature ≠ open bug`，`spec-only gap ≠ repair task`。单个 owner 故障只阻塞对应 join，不阻塞无关控制面建设。

## What

### 总架构：薄联邦控制面（v3 归一）

> **一句话**：F311 能看懂全局、能启动和编排，但**不私藏任何领域真相**——用稳定引用把已有能力组织起来。

```text
              用户入口："我们来进化 X"（一句话，零表单）
                              │
        ┌─────────────────────▼─────────────────────┐
        │  capability-evolution-control（薄 cell）    │
        │  拥有：Program identity/lifecycle ·         │
        │  Goal/claim/经济页 · owner refs ·           │
        │  调度与阶段投影 · keep/tune/rollback/sunset  │
        │  编排状态（canonical TTL=0，跨重启恢复）       │
        │  不拥有：rubric 内容/原始轨迹/verdict 生命周期/ │
        │  资产版本/写回结果/通用 feedback 或 query 账本  │
        └──────┬──────────┬──────────┬───────────────┘
        （以下全部为引用与编排，owner 见 Owner Matrix）
     👁 眼 refs           📏 尺 refs            ✋ 手 refs
   F299 inv:<id> 锚      rubric 版本@owner      家内: PR/merge-gate/
   F153 source ref       + fresh bit 通道       overlay@owner
   F227 事件 ref         (F281/F246/F309/各       F246 delta卡投递
   F300 同源读取          source owner 决策流、     外部: F202/F302
   （打点设计提案          事实域搜索,按GT域路由)    governance adapter
    →提给 source owner）
        └──────────┴──────┬───────┴──────────────┘
                          │
          调度器：事件 / 时间窗(1d/7d) / 轨迹配额
          （触发注册进 F192 trigger；到点评，够不够都评）
                          │
          Goal certificate: value owner ref（F311 只持 ref）
          Evaluation（F192 registry + F267 validity 契约：
          population/window/baseline/uncertainty/insufficient；
          observer/domain owner/consumer/calibrator refs + overlap reason）
          cohort/证据角色/optimizer exposure/消费与失效留在
          F192/F267 bundle 或 source owner；归因 cohort 与 promotion
          holdout 分离；F311 只持 certificate/cohort/result/exposure refs
          （无 owner-backed proof → insufficient，不补本地查询账本）
                          │
          归因四层确诊（结论可 unresolved，不强迫命中）：
          ①对象 ②尺子 ③眼睛(打点缺/bit不新鲜) ④目标过时
          →外环:起草 Goal/rubric 新版→人确认（F266 case lifecycle）
                          │
          Intervention Gate：owner-held card ref（因果假设/预期变化/
          护栏/replay+independent holdout/双 falsifier/成本与回滚）
          →缺卡或隔离证明不得 writeback
                          │
          Change Review：delta 卡经 F246 投递
          ── 人的两个裁决点：rubric 冻结权 + 写回批准权 ──
          （机制起草猫自主；value owner 与 Eval 四角色分开登记；
           当前 claim 缺必要角色→needs_expert/insufficient；代理只能
           另开 scoped claim/Program，禁止向原 claim 转移价值 verdict）
                          │
          可逆写回@owner → 新鲜轨迹复验 → keep/tune/rollback/sunset
                          │
          联邦 lineage view：AssetVersionRef + 因果边
          （版本/回滚/receipt 归资产 owner；trajectory immutable
           且引用当时资产版本 → 二次归因可对照）
                          │
          产品面：surface descriptor → F307 Workbench 渲染
          （全程可感知：Program 列表/版本时间线/delta 卡/sunset 账）

  ┄┄┄ 二阶器官环（慢环：自然攒够 K 个一阶案例才启动，不为验收造样本）┄┄┄
  立尺/开眼/归因/eval 设计能力也是 Program 对象；
  人修订 rubric 的 diff、复验对归因的延迟打分 = **监督信号**
  （复用现有治理事件，边际采集成本较低——非"免费"）；
  真正的 GT = 该器官产出的下游真实表现（延迟真值，禁即时代理）
```

### 五种被进化对象（同一 Program 契约，无特权对象；每条 Program 单对象单 claim）

| 类型 | 例子 | 备注 |
|---|---|---|
| ① 业务能力 | 视频 skill、家内或外部托管的记忆系统 | 眼/手均走 owner-backed adapter |
| ② 机制器官（二阶） | 立尺/开眼/归因能力 | 信号=一阶治理事件复用；慢环 |
| ③ 猫画像与路由 | F208 dossier / F293 消费验证 / per-cat overlay | **三层拆开各自成 Program**（单变量）；写回走 F208 proposal 链 |
| ④ Agent Harness | per-cat overlay、Claude Code 项目 Harness、OfficeAce PM Agent/Skill 栈 | 特化分层铁律：协作契约层不特化，执行层特化；对象可在家内或家外 |
| ⑤ 组织变体 | TDD/SDD 团队分支 | 版本树+适用域归 skill owner；lineage 语义采用 HC 笔记 Skill/Gene/Capsule/Lineage 分工 |

### 开放世界代理式进化：对象、执行与真相都可以留在家外

F311 的边界不是“只能进化 Clowder AI 自己”，也不是“把外部项目导入 Clowder AI 后再改”。它是一个对象无关的联邦控制面：对象 owner 暴露受限的观察、变更、验证与回滚能力；F311 编排一轮可证伪的学习；owner-bound Agent 在对象原地执行。

```text
“进化 OfficeAce 的 PM 端到端效果”
        ↓
F311：Program / claim / evidence / attribution / Approval / lineage
        ↓  exact target + approved action ref
OfficeAce Developer Agent：在 OfficeAce 原仓修改获授权资产
        ↓  test / review / deploy / rollback receipts
OfficeAce 真实任务与用户后果：fresh outcome
        ↓
F311：keep / tune / rollback / sunset；不接管 OfficeAce 真相
```

同一规则也适用于 Claude Code：能进化的是 project owner 明确开放且可版本化、可测试、可回滚的 Harness 表面，例如 instructions、Skills、hooks、commands、MCP、subagent 编排、项目代码与 CI；不能声称直接修改未开放的模型权重、闭源二进制或供应商内部行为。若一次目标同时涉及 PM Skill、Agent 角色、工具链与产品代码，围绕同一上位 Goal 建立 linked Programs，每条仍只改变一个主因，避免“大升级有效但不知道为什么”。

### Phase 0: 宪法与所有权边界（已完成）

冻结终态坐标系，不交付临时产品：`capability-evolution-control` 薄 cell、Canonical Owner Matrix、F299 唯一 invocation-trajectory 产品面、F246 唯一审批入口、F307 唯一宿主，以及 version/evidence/decision/outcome 各归原 owner 的负向契约。Gate 0A 已由 PR #4053 落地；后续 Phase 不得以“先跑起来”为由重新引入影子 store、临时 adapter、第二状态机或对象特有 schema。

### Phase 1: 建制与可见（Start & See）

交付用户从第一天就会使用、以后不会拆掉的正式入口：用户在任意聊天页说“我们来进化 X”，猫自动起草一个 durable Evolution Program。Program 持有对象身份、单 Goal/claim、经济页、双证/四角色/owner refs、生命周期与当前阶段；F307 Workbench 同时显示 Program 列表、建制进度、阻塞原因和下一步。正常路径零表单，只有价值歧义、必要角色缺失或治理边界才浮出最小确认。

Program canonical truth 从第一次创建起 active/terminal 均 `TTL=0`、跨重启恢复；pause/resume/needs_expert/withdraw/retention 选择可审计。UI、MCP/猫动作与 API 读取同一 truth，不允许先做一张静态卡片再重写后台。

### Phase 2: 开眼与取证（Observe & Gather）

让 Program 能在用户正常工作中持续获得新鲜 bit，而不是把用户变成标注员：

- invocation trajectory 只引用 F299 `inv:<id>`；logs/metrics/traces、paw-feel、human disposition、内容采纳/撤销与外部 evidence 都通过 Canonical Owner Matrix 的 source ref/join key 接入；
- 猫为 source owner 起草永久 instrumentation/telemetry 提案，owner 能力缺失就改 owner contract，不在 F311 私藏 payload；
- 在 F192 注册事件、时间与配额触发器；在 F267/source owner 登记 cohort、证据角色、optimizer exposure、promotion holdout 与 named consumer；
- Workbench 显示“眼睛接到了什么、缺什么、下一次何时评估”，但不复制 owner 数据或制造第二条轨迹页。

### Phase 3: 评估与归因（Measure & Understand）

把尺子真正用于判断，不把“收集到信号”误写成“能力变强”：Program 引用 F192/F267 的 measurement bundle、rubric/version、baseline、verdict 与 validity；支持执行层、Harness 层、尺子层、眼睛层四层归因，也允许 `unresolved/insufficient/incomparable`。冻结 cohort 只用于归因、可比与换尺 2×2 复判，promotion 另用未暴露的 sealed/time-fresh holdout。

若建议干预，必须先由 F267/source owner 产出带 competing attributions、causal hypothesis、expected delta、guardrails、replay/holdout、`intervention_falsifier`、`rubric_reopen_trigger`、成本与回滚的 intervention card；F311 只持 ref 与 gate 状态。Workbench 要能用人话解释“哪里可能坏了、证据够不够、为什么暂时不改”。

### Phase 4: 受治理写回、复验与代谢（Change & Learn）

把“分析”闭成真实 outcome：只有请求真实 change/adopt/continue-investment 的 intervention 才进入 F246 Approval；`observe/insufficient` 自动复查且零审批。Approval 绑定 exact target/version 后，canonical asset owner 执行 mutation/rollback 并返回 receipt；F266/F313 负责 approval-gated dispatch、复评与 outcome closure；F311 只追加 AssetVersionRef、证据→干预→批准→写回→结果的因果边，并编排 `keep / tune / rollback / sunset / no_change`。

这一协议从设计上不限定执行者必须是家里的猫：任何已接入且 owner-authenticated 的 Developer/PM Agent 都可成为 owner 的执行代理，但只能操作 owner-backed adapter contract 允许的 exact surface。Phase 4 先闭合 owner-agnostic 的授权与结果协议；Phase 5 再以真实外部对象证明跨仓、跨 runtime 也能遵守同一协议。

**第一条 E0 合格的真实 Program 在此作为整环 production acceptance journey**：它不预设对象、不定义 schema、不单独占一个 Phase。若暂时没有合格目标，Phase 1–3 的终态能力仍照常建设；不得造样本替代验收。首次完整闭环必须包含 merged+loaded 后的新鲜 outcome，且至少记录一次真实 rollback 或 sunset/no-change 决策；“有 proposal/有 merge”都不等于“已进化”。

### Phase 5: 多对象联邦与外部适配（Generalize & Federate）

证明同一套产品不是某个对象、仓库或 Agent runtime 的专用工作流：核心 Program schema 不增加对象特有字段，至少承载两个异质的家内对象类别；猫画像/F293 路由/per-cat overlay 若进入本 Phase，仍按 F208 画像、F293 消费验证、overlay 三条单变量 Program 分开。再通过 F202/F292/F302 接入一个真实外部托管对象；F307 统一展示多个 Program，业务真相仍留在各 owner。

外部 adapter 不是只读数据管，必须同时闭合四个方向：

1. **看**：只读 API/日志/trajectory/outcome refs；
2. **授权**：owner identity、owner-issued permission/capability refs、exact target/version 与 Approval origin；
3. **做**：owner-bound Developer/PM Agent 在外部 canonical repo/system 原地 mutation、test、review、deploy、rollback；
4. **证明**：把 version/change/deploy/rollback/signoff 与 fresh outcome receipts 回链到同一 Program。

任一方向缺失都只能报 typed blocker，不能靠人工复制文件、聊天口令或 F311 影子状态补洞。OfficeAce PM Agent/Skill 是定义性用户旅程之一，不是写进 schema 的特权对象。

### Phase 6: 进化机制本身（Evolve the Evolution）

把立尺、开眼、归因、eval 设计与 Program 编排本身作为同一契约下的二阶对象：它们的 rubric diff、治理修订与复验 verdict 是监督信号，真正 GT 是这些器官后来服务的一阶 Program 的下游真实表现。机制从真实循环中沉淀可版本化、可回滚、可退役的 skill/heuristic；坏器官也必须 sunset。

Phase 6 的**产品能力**必须交付，但“Meta 机制已经提高能力”的经验 claim 只有在自然积累 ≥K 条可比较案例后才能成立（K 由 F267 校准）。未达到时诚实标记“机制已接通，效用未实证”，不制造样本、不降低验收门槛。

### 横向 Owner Contract Repair Lane（不是 Phase）

任一 Phase 实测到 canonical owner contract 缺失或故障时，F311 只登记 exact join、owner、live case 与 source ref，并把修复投给对应 owner thread；没有 verified owner 才走 F128。Owner receipt 回来后恢复该 join，单个 join 故障不阻塞无关器官建设。F266/F278 是这一规则的已有证据，不是 F311 的 Program 样例，更不是产品主线。

### Release / Close Gate（不是新脚手架）

最终验收运行在正式架构上：重启后恢复 Program；真实 E0 journey 从一句话走到 fresh outcome；`observe/insufficient` 零卡；pending/rejected/superseded/target drift 零派工；外部对象可审计回滚；没有 shadow truth，也没有“演示后删除/重写”清单。只有这些生产证据齐全，F311 才可关闭。

## User Journey

### Primary Journey: 一句话开启一轮能力进化
- **Scope unit**: workspace（一个 Evolution Program）
- **Actor**: operator（价值主人）+ 猫（建制执行）
- **Entry**: 任意聊天页，说"我们来进化 X"
- **Flow**:
  1. 猫检索 X 的历史任务/纠偏/结果，**起草** Goal + rubric v0 → 人修订后**冻结**（起草权归机器，冻结权归人）。同时登记 `value_owner_ref` 与 measurement 四角色 refs：用户即使不懂技术域，仍可拥有个人价值 GT；猫/专家可担任射程内的 domain owner/calibrator，但不能替用户裁决个人价值。只有当前 claim 缺少必要且合格的角色时才进入 `needs_expert/insufficient` 并暂停该 claim 写回。
  2. 猫配套：打点设计提案（提给 source owner）+ fresh bit 通道（按 GT 域与 optimizer exposure 路由）+ promotion 独立 holdout + 写回通道确认 + 轻量经济页 → Workbench 面板可见建制过程。若存在可验证代理，只能另开 scoped claim/Program；它可回传 evidence/subclaim result，但 UI 必须并列展示且禁止转移原 claim 的价值 verdict——**建制可继续，真值不伪造**
  3. 用户正常使用 X；F281/F246/F309/各 source owner 已有决策流通过 source ref 成为信号，零新增标注动作；F311 不集中复制 decision payload
  4. 触发器到点 → 评估（F192+F267）→ 归因四层（可 unresolved）→ owner-held intervention card（因果假设/预期变化/护栏/replay+holdout/双 falsifier/成本与回滚）过门 → delta 卡经 F246 投递
  5. 用户裁决 → 可逆写回@owner → 同一 replay cohort 做归因复验、独立 sealed/time-fresh holdout 做 promotion 验证；变糟按 AssetVersionRef 交叉复判/重建 baseline 后二次归因，分别触发 `intervention_falsifier` 或 `rubric_reopen_trigger`，再回滚/重开尺子；无法隔离或复判时标 `insufficient/incomparable`，不拼接新旧分数
  6. 终态：毕业 / 放弃（经济页停止规则）/ 尺子退役（sunset 入账）/ needs_expert 挂起；终态历史仍 TTL=0，只有用户显式选择 retention/forget 才进入 GC
- **Success evidence**: Workbench Program 面板截图 + delta 卡截图 + 15s 录屏
- **Non-goals**: 绕过 Approval 的全自动写回；参数训练（须另过训练级数据契约+经济页）；全量埋点；Evolution Pack 社区流通（后续 feat）；自建轨迹页/审批状态机/版本系统/宿主/通用 decision store/query ledger（负向契约 1-10）

### External Journey: 代理外部 Agent / Harness 完成端到端进化

- **Scope unit**: 一个外部对象上的单 claim Program；对象代码和运行真相不迁入 Clowder AI
- **Actor**: 外部 value owner + F311 编排猫 + owner-bound Developer/PM Agent
- **Entry**: “我们来进化 OfficeAce 的 PM 端到端效果”或“我们来进化这个 Claude Code 项目 Harness”
- **Flow**:
  1. F311 解析外部 object ref、value owner、consumer 与可变层；没有 authenticated owner 或 owner-backed permission/capability ref 就停在 typed blocker
  2. 外部 adapter 提供 evidence refs 与 mutation capability；F311 按通用 Program 建制、取证、评估和归因，不复制仓库内容或外部状态
  3. 真实 change 进入 F246 Approval，批准绑定 exact repo/system、surface 与 version；owner-bound Agent 收到 ref-only action 后在原地修改并走该项目自己的测试、review、deploy 与 rollback gate
  4. 外部 owner 返回不可混淆的 version/change/deploy/rollback receipts；新鲜真实任务产生 outcome 后，F311 才编排 keep/tune/rollback/sunset
  5. 若要同时改 Skill、PM 角色、subagent 编排和产品代码，拆成共享 Goal 的 linked Programs，逐层建立因果证据
- **Success evidence**: 一条真实跨仓 journey 的 owner-authenticated action、exact target/version、PR或等价 review、deploy/rollback 与 fresh outcome receipts 全部可从 Workbench 下钻；F311 本地没有外部资产副本或影子治理状态
- **Non-goals**: 未经 owner 授权修改外仓；把执行 Agent 当 value owner；声称修改闭源模型权重/二进制；用手工复制、共享凭据或聊天确认绕过正式 adapter/Approval

## Acceptance Criteria

<!-- AC↔Why 同源；非作者可复核；度量类 AC 引 F267 契约（population/window/baseline/uncertainty/insufficient/withdrawal），不设未校准阈值。 -->

### Phase 0（宪法与所有权，已落地）
- [x] AC-01: 薄 cell + Owner Matrix + F299/decision/query/durability/role/intervention 负向契约已落 ownership map（PR #4053 / `0bdda236e`）；F311 不内建任何 owner 替代面

### Phase 1（建制与可见）
- [x] AC-11: 用户在任意聊天页说一句“我们来进化 X”，猫自动起草 durable Program；正常路径零表单，只有价值歧义/必要角色缺失/治理边界浮出最小确认；同一 canonical truth 同时供 API、猫动作与 F307 surface 使用→Why②
- [x] AC-12: Program 支持单对象单 claim、经济页、双证 refs、`value_owner_ref`、measurement 四角色 refs 与 overlap justification；代理 Program 可回传 evidence/subclaim result，但不得转移 value verdict→Why①②
- [x] AC-13: Program active/terminal 均 TTL=0；pause/resume/needs_expert/withdraw 与 exact stage/refs 跨 API/runtime 重启恢复；完成/关闭不产生 TTL，只有用户显式 retention/forget opt-in 才允许 GC，选择与执行均可审计→Why②
- [x] AC-14: F307 正式 surface 从本 Phase 起显示 Program、当前阶段、已有 refs、阻塞与下一步；没有静态 mock、fixture-only backend 或未来要删除的临时 UI→Why②

### Phase 2（开眼与取证）
- [x] AC-21: invocation trajectory 只经 F299 `inv:<id>` 引用；至少两个异质 owner-backed signal/decision surface 以 canonical ref + join key + named consumer 接入，且 F311 不保存通用 decision/evidence payload→Why①②
- [x] AC-22: 猫可为 source owner 起草 instrumentation/telemetry proposal，并在 F192 注册事件/时间/配额触发器；用户正常工作即可产信号，不增加标注任务→Why①②
- [x] AC-23: 每个用于评估的 cohort 都有 owner-backed evidence role、consumption 与 optimizer-exposure proof；promotion 使用独立 sealed/time-fresh holdout，缺 proof 返回 `insufficient`，不创建 CEW query ledger→Why②
- [x] AC-24: Workbench 能说明 Program 的眼睛已接哪些源、还缺什么、下一次评估何时发生，并可下钻 owner surface 而非复制 owner 数据→Why②

### Phase 3（评估与归因）
- [x] AC-31: Program 复用 F192/F267 measurement/rubric/baseline/verdict；执行层、Harness 层、尺子层、眼睛层四种归因均可表达，只记录实际命中，证据不足显式 `unresolved/insufficient/incomparable`→Why②
- [x] AC-32: rubric 换版必须在冻结 cohort 做旧/新尺 × 旧/新 candidate 的 2×2 复判或重建 baseline；不可比较时禁止拼接分数→Why②
- [x] AC-33: 任何可写回建议都引用 owner-held intervention card，且 `intervention_falsifier`、`rubric_reopen_trigger`、replay cohort、独立 holdout 与 rollback/cost 齐全；缺一不得进入 Change Review→Why①②
- [x] AC-34: F307 surface 用人话显示当前证据、竞争归因、置信边界与“不改”的原因，operator 不读代码也能理解→Why②

> 2026-09-02 Phase 3 状态（**AC-31–34 达成**）。上一版曾勾选后又整体退回，因为当时把"契约能表达"当成了"达成"；这一版的判据是**生产可达 + owner 侧可解析 + 反例被测试钉住**。
>
> **核心原则**：调用方只交身份。owner verdict、cohort、baseline、exposure、holdout、逐层 discrimination、尺子、干预 card 与 gate receipt 全部从 F267 解析或从 Program 自己的事件流读取；F311 不为 owner 造事实，缺什么就报什么，而且 fail closed 的方向永远是"不放行"。
>
> **本轮为达成 AC 所做的 owner 契约扩展（全部 additive/versioned，历史 artifact 与 hash 不变，free-text holdout 不作 proof）**：
>
> 1. **canonical owner refs**：certificate/result 用 owner 自己分配的 id，cohort/exposure/holdout 用 owner 已提交的 sha256 内容寻址。此前 proof 只用仓库路径寻址，跨 feature consumer 无法当身份用。
> 2. **`layer_discrimination` owner object**：只有 measurement owner 能说"这个 cohort 的证据能把哪一层与其他层区分开"——它取决于 cohort 怎么构造、里面什么在变。可选且**不进 `missingProofs`**（proof 可以 verified 而 owner 仍分不开层），缺失是 absent 而不是空集，所以 consumer 不能把沉默读成"都不区分"或"都区分"。没有它，真实 proof 结构上只能停在 `unresolved`。
> 3. **rubric 来自 certificate 的 decision procedure**：当前尺子由 owner 的 certificate 组件给出，上一轮尺子从 Program 自己的 `measurement_linked` 读。2×2 的每个 cell 改为指名 decision proof，Program 校验该 cell 确实落在它声称的坐标轴与冻结 cohort 上；baseline rebuild 同样按 proof 解析。
> 4. **`intervention_card` owner object + owner-held gate receipt**：历史 card 全是自由文本，可以描述计划，但一段话不是可解析的 falsifier / holdout / rollback，也不能当独立性证明。结构化 card 由 owner 发布并按同一套 ownership/hash/containment 校验；**gate receipt 也必须 owner 持有**——授权改动的凭据不能由发起改动的一方自己签发（这条是干预门自己拒绝 F311 自签 receipt 时暴露的）。
>
> **生产可达性（这轮补上的 Phase 1 缺口）**：此前 `create()` 只落到 `constituting`，公开面**没有任何** `certificates_linked` / `evaluation_triggered` 的 producer，所谓"真实 Program stream"的集成测试是直接往 event log 写事件。现在 `linkCertificates` 与 `triggerEvaluation` 是真实端点，且开一轮必须由 **F192 自己的 time channel dispatch 说开了才开**，receipt 取自 F192 的 dedupe key，exposure proof 取自 F267——调用方不能随意开轮次把上一轮的诊断冲掉。共享 fixture 现在全程走公开方法。
>
> **真实数据下的结果仍是 `insufficient`**：唯一已提交的 F267 record（`f267-friction-2026-07-18`）measurement decision 本身 `insufficient`、primary loss `not_estimable`、无 baseline、无结构化 card。这是数据的结论，不是契约的缺口——AC 判据是"契约能表达且生产可达且反例被挡住"，三者均有测试覆盖。

### Phase 4（受治理写回、复验与代谢）
- [ ] AC-41: 只有请求真实 change/adopt/continue-investment 的 intervention 进入 F246；`observe/insufficient` 自动复查且零审批。pending/rejected/withdrawn/superseded/target drift 均零派工，fresh Approval 必须绑定 exact target/version→Why①②
- [ ] AC-42: canonical asset owner 执行 mutation/rollback 并返回 receipt；F266/F313 负责 approval-gated dispatch 与 outcome closure；F311 只记录 refs 与因果边，不拥有 Approval、Task、lease、mutation 或 verdict truth→Why②
- [ ] AC-43: 一条 E0 合格的真实 Program 从一句话走到 merged+loaded 后的新鲜 outcome；合入的每个新增件都是终态生产架构的一部分，无 demo 删除/重写清单；首个对象不进入核心 schema→Why②
- [ ] AC-44: `keep/tune/rollback/sunset/no_change` 均可执行并回链；至少一次真实 rollback、sunset 或 no-change 完整入账，包含 AssetVersionRef、证据、裁决、receipt 与后续结果→Why①②

### Phase 5（多对象联邦与外部适配）
- [ ] AC-51: 同一未增加对象特有字段的核心 schema 承载至少两个异质家内对象类别，各自走完整 Program journey；F307 同屏编排、domain truth 仍归 owner→Why②
- [ ] AC-52: 一个外部托管对象通过 F202/F292/F302 owner-backed adapter 走完整 journey；owner-bound Agent 在该对象的 canonical repo/system 原地执行获授权 mutation，并返回 version/change/review/deploy/rollback 与 fresh outcome receipts；F311 只持 refs/lineage，不私建外部资产或 governance 状态→Why①②
- [ ] AC-53: 外部动作必须由 authenticated owner、owner-backed permission/capability ref 与 exact target/version 共同约束；未授权、不可变、闭源或 route unavailable 的表面返回 typed blocker 且零副作用，不能靠聊天口令、共享凭据、手工复制或本地 shadow state 旁路；执行代理不得拥有 value verdict→Why①②

### Phase 6（机制自身进化）
- [ ] AC-61: 立尺/开眼/归因/eval 设计中的至少一种成为正式器官 Program；监督信号、下游延迟 GT、owner mutation、版本/回滚/sunset 与一阶 Program lineage 可表达且复用同一契约→Why①②
- [ ] AC-62: 若自然积累 ≥K 条可比较案例，按 F267 出生证验收器官效用；若未积累够，产品面显式记“机制已接通、效用未实证”，禁止造样本或以 rubric diff 冒充 GT→Why①

### 全程 / Close Gate
- [ ] AC-X1: owner contract 故障均有 canonical feature/thread/owner/source ref 与 repair receipt；单个 join 只阻塞自身，F311 diff 无替代 Store/Queue/状态机/UI/fixture-only adapter
- [ ] AC-X2: loaded-runtime 验收同时覆盖 Program 重启恢复、真实 E0 source→outcome、observe/insufficient 零卡、无批准零派工、target drift 旧批准失效、外部回滚与 terminal retention；无 shadow truth、无“演示后删除/重写”清单

## Eval / Tracking Contract（F192 + F267）

1. **Primary Users + Activation Signal**: operator + 全体猫；activation = Program 创建事件 + delta 卡投递事件（F246 receipt）
2. **Friction Metric**: delta 卡采纳率 + 同类纠正重复率（教导复利直接度量）——**均按 F267 出生证登记**：population/window/baseline/denominator/uncertainty 显式；判停阈值在 Phase 3/4 的真实 population 上用 F267 calibration 流程定，**不预设未校准数字**（v0 的 25% 作废）
3. **Regression Fixture**: ① 缺经济页拒绝启动 ② rubric 换版后在冻结 cohort 做 2×2 复判/重建 baseline；缺复判条件时 `incomparable`，禁止 score 拼接 ③ promotion holdout 曾暴露给 candidate/rubric selection 时拒绝晋升并返回 `insufficient` ④ 触发器三模式各一 ⑤ 缺必要 eval 角色时只挂起受影响 claim；用户不懂技术域但仍保有 value verdict，代理 Program 不转移 verdict ⑥ Program 重启恢复、active/terminal TTL=0、cache 丢失不改 lifecycle；完成/关闭不产生 TTL，只有显式 retention/forget opt-in 才允许 GC ⑦ 缺 owner-backed consumption/exposure proof 返回 `insufficient`，不创建 CEW query ledger ⑧ 缺 intervention card、`intervention_falsifier` 或独立 `rubric_reopen_trigger` 时拒绝 writeback ⑨ 外部 object 缺 owner auth、owner-backed permission/capability ref、exact target/version 或 mutation/outcome receipt 时 fail closed 且零副作用；执行 Agent 不得提升自己的权限或签发 value verdict
4. **Sunset Signal**: 按 F267 withdrawal condition 登记（含 `insufficient` 出口）；CEW 整体若持续无活跃 Program 且 operator 不再发起 → 回 Design Gate 重审产品形态（窗口与判据在 Phase 4 的真实运行中校准冻结）

## 需求点 Checklist（operator 语音与现场验收逐条核对，v5 更新落点）

| # | operator 需求 | Spec 落点（v5） |
|---|---|---|
| 1 | Eval first：先设 rubric，人懂共创/人不懂猫主导 | Journey Step 1（value owner 与 Eval 四角色分权；缺必要角色才精确挂起；代理 claim 独立 Program） |
| 2 | F299 配套 trajectory/governance/打点 | **硬约束 1：F299 唯一轨迹面**；打点设计=提案给 source owner |
| 3 | 眼=可观测，尺=rubric+新鲜 bit | 架构图 refs；fresh bit 严格定义（GT 域 + optimizer exposure + promotion holdout） |
| 4 | 遥测不让用户当标注员（含猫反馈） | Journey Step 3；decision-surface census 复用 F281/F246/F309/各 source owner；paw_feel 上游源 |
| 5 | 触发：事件/1d/7d/配额 | 调度器（注册进 F192 trigger） |
| 6 | 归因分层确诊 | Phase 3 四层 + unresolved（AC-31）；写回前 intervention card 双 falsifier（AC-33） |
| 7 | 一切可视化可感知 | Phase 1 起即 surface descriptor → F307（AC-14），后续每个器官持续补投影 |
| 8 | 从"我驱动"变"猫自主" | Why②；Journey Step 1-2 |
| 9 | GT 真值锚点分层 | 继承声明；范式分层判卷；fresh bit 定义 |
| 10 | 机制自身进化、沉淀 skill、启发式学习 | Phase 6 二阶器官环（监督信号≠GT）；能力必交付，效用 claim 条件成立 |
| 11 | F293 猫协同/画像由这套驱动 | Phase 5 对象③三拆（F208 proposal 链写回；F293 消费验证；overlay 单独 Program） |
| 12 | per-cat harness 增减，不吃大锅饭 | 对象④ + 特化分层铁律 |
| 13 | 版本化一切、归因可回滚、对接 V1/V2/V3 | **联邦 lineage view**（版本归 owner；F311 持 ref+因果边）；换尺重建 baseline / incomparable；AC-32/AC-44 |
| 14 | 团队变体推荐最适版 | 对象⑤（Skill/Gene/Capsule/Lineage 语义归 HC 笔记） |
| 15 | sunset 最重要 | Phase 4 资产代谢；AC-44 |
| 16 | 一切用户可见资产可恢复、可回滚 | 硬约束 8；LL-048/ADR-045/F298；AC-13（active/terminal TTL=0 + restart recovery + 用户 opt-in 后才可 GC） |
| 17 | 不造两个月后拆掉的 MVP；真实 bug 投原 owner，F311 串现有能力 | 硬约束 11/12；横向 Owner Contract Repair Lane；AC-X1/X2；KD-15/16 |
| 18 | 不要单点自进化；按最终远景交付一整套能力闭环 | Phase 1–6 按永久器官拆分；首个 E0 Program 仅验收 Phase 4 整环，不定义产品路线 |
| 19 | 家里或外部对象都能进化；可代理 Developer/PM Agent 在原仓改获授权表面 | 开放世界代理式进化；硬约束 13；External Journey；AC-52/53；KD-17 |

## Dependencies

- **Evolved from**: F100（行为协议；其 Phase 3 未来消费本 feat 机制，不合并）
- **Blocked by**: Gate 0A 的 **ownership cell + production-only 负向契约已冻结**（PR #4053 / `0bdda236e`），故 Phase 1 可直接开工。单个 owner bug 只阻塞自己的 join；E0 合格目标只阻塞 Phase 4 的整环 production acceptance，不阻塞 Phase 1–3 终态器官建设。吴浪版本地基继续作为 Harness/Skill asset owner 能力，不是预制示范题。
- **Related**: F192/F266/F267（eval 底座三件）、F313（analysis→outcome delivery/acceptance command）、F299（唯一轨迹面）、F153、F227、F278（canonical paw-feel responsibility projection + durable receipt）、F281（human disposition why/episode）、F300（owner-backed self-sensing/read）、F208/F293、F232、F246（审批）、F298/ADR-045（持久性法源）、F307/F284（宿主）、F309（协作 anchor/patch/change receipt；canonical 内容版本归 content owner）、F290（对象⑤群体面）、F310（双旗舰；证据共用边界 OQ-4）、F202/F292/F302（外部 adapter）

## Risk

| 风险 | 缓解 |
|------|------|
| 控制面悄悄变成总数据库（v0 已犯） | 负向契约 1-10 + Owner Matrix 进 ownership map；review 检查点 |
| claim 越界（Meta-RSI 宏大 claim 立项、CEW 小 claim 验收） | 三 claim 分开验收；演示禁跨层偷换主语 |
| 二阶 Goodhart（器官 skill 讨好人） | GT 只用延迟真值；AC-61/62 分开“机制接通”与“效用实证”，不造样本 |
| 信号密度不足 | v1 裁决加速器；owner-backed fresh-bit fabric；needs_expert 显式挂起 |
| 埋点负资产 | consumer-first（join key/窗口/decision action 先行） |
| decision-surface census 被压成通用总账 | 首批必须来自 ≥2 个异质 owner；F311 只持 refs/consumer；缺口改原 owner |
| 同一 cohort 既选解又验解，伪造 unseen 增长 | F192/F267/source owner 记录三阶段 exposure；冻结 cohort 只做归因/可比，promotion 用 sealed/time-fresh unseen holdout；缺 proof=`insufficient` |
| 把 owner proof 已验证误读为 measurement 已可用 | Phase 2 的 `verified` 只证明 owner evidence/consumption/exposure/holdout 义务已签发，底层 `measurementDecisionStatus=insufficient` 仍是合法且非行动性结论；bundle 保持 `registered_nonoperational`、`allowedActions: []`、`keep_observe_only`，Phase 3 才单独消费 measurement usability |
| 换尺后拼接 score 伪造增长 | F192/F267 冻结 cohort + 交叉复判/重建 baseline；做不到标 `incomparable` |
| 专家篡夺价值主人或价值主人冒充领域校准者 | `value_owner_ref` 与 Eval 四角色 refs 分权；overlap justification；缺哪个角色只挂起受影响 claim |
| 代理尺反客为主 | 代理只能独立 claim/Program，可回传 evidence/subclaim result，禁止转移 value verdict |
| finding 直接产 delta，改错对象或改坏尺子 | owner-held intervention card；`intervention_falsifier` 与 `rubric_reopen_trigger` 独立；缺卡不写回 |
| Program 因 TTL/重启静默死亡 | LL-048 + ADR-045：active/terminal TTL=0、显式 retention/forget opt-in 后才可 GC、canonical restart recovery；cache 只做投影 |
| Generic GC accidentally becomes a production mutation surface | REST/MCP strict action unions expose no generic GC command; only explicit retention/forget can attach expiry, with negative contract tests. |
| Permanent Workbench list polling grows with Program count | Phase 1 polls only while the document is visible and refreshes on focus; when one workspace first reaches 100 Programs, Phase 2 must replace full scans with owner-event incremental projection before raising that limit. |
| 与吴浪版本地基平行造轮 | 硬约束 2；Phase 0 对接 |
| 为证明 CEW 先造玩具 Program，后面再拆 | 硬约束 11/12；Phase 1–6 全部交付永久器官；首个 Program 只作 Phase 4 production acceptance |
| 把首个对象或依赖修复误写成产品路线 | Phase 只按终态能力器官拆；E0 journey 与 Owner Contract Repair Lane 均横切，不拥有 Phase |
| F311 变成全家 bug 修理队 | bug 仍由 Canonical Owner Matrix 对应 owner 修；F311 只做跨 owner 编排/ref/join/投影，单 Program 单 claim |
| 把确定性 bug 包装成“自进化” | ADR-031 机制选择 + E0：契约 bug 走 test/guard，运行健康走 telemetry；只有不确定效用 + consumer + keep/tune/sunset 才建 Program |
| per-cat 特化碎裂协作契约 | 特化分层铁律 |
| 把“可调用外部 Agent”误当成“拥有外仓权限” | authenticated owner + owner-backed permission/capability ref + exact target/version；未授权/不可变表面 typed blocker、零副作用 |
| 外部执行代理同时控制目标、改动与价值裁决 | 执行权与 value verdict 分离；F246 Approval + owner receipts；独立 fresh outcome 决定 keep/tune/rollback/sunset |
| 为接外仓把代码、凭据或 governance truth 复制进 F311 | F202/F292/F302 owner-backed ref adapter；资产与凭据留在外部 owner，F311 只持 refs/lineage |
| AC 诱导编案例 | AC-31 可 unresolved；AC-62 分离能力与效用 claim；阈值走 F267 校准 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | CEW = 范式产品控制面，机制层 Meta-RSI，两层 claim 分开 | 防 claim 越界 | 2026-08-28 |
| KD-2 | 对象无关 Adapter = **引用协议**（day-1） | 五种对象；绑死任一种都重造轮子 | 2026-08-28 |
| KD-3 | v1 = 裁决加速器：建制自主，写回人批准 | 信号密度 + 圈外锚 | 2026-08-28 |
| KD-4 | 起草权归机器，冻结权归人；value owner 与领域/校准角色分权；缺必要角色只挂起受影响 claim；代理只可另开 scoped Program 且不转移 value verdict | 防 proxy gaming；建制可继续但不伪造价值 GT，也不让专家篡夺价值主人 | 2026-08-28 |
| KD-5 | **首个 Program 不预制对象**：由 E0 合格的真实用户目标触发；F266/F278 是 dependency repair，不是 Program 候选；画像在 Phase 5 仍三拆 | 单对象单 claim + 机制选择；既不造 Harness v1→v2 demo，也不把普通 bug 贴“自进化”标签 | 2026-08-28 |
| KD-6 | 版本归资产 owner；F311 持联邦 lineage view（ref+因果边） | 引用不是所有权；owner 缺能力改造 owner | 2026-08-28 |
| KD-7 | 二阶器官 Program **条件启动**（自然积累 ≥K），未达标走 disclosure 不造样本 | 防考卷污染（v0 强制验收作废） | 2026-08-28 |
| KD-8 | F311 为薄联邦控制面：六职责采用 HC 笔记语义 | 架构归一；不重写已有语义真相源 | 2026-08-28 |
| KD-9 | 用户决策先做 owner census：F281/F246/F309/各 source owner 持 truth，F300 负责同源读取，F311 只持 refs/consumer | 不造第二 feedback/decision plane | 2026-08-28 |
| KD-10 | Eval 证据消费与换尺比较归 F192/F267/source owner；F311 无 query ledger | 防考卷污染、重复消费与不可比分数拼接 | 2026-08-28 |
| KD-11 | Program canonical truth 服从 LL-048 + ADR-045：active/terminal TTL=0、跨重启恢复；完成不自动 GC，只有用户显式 retention/forget opt-in 才可设置 TTL | 用户可见生命周期不能寄存在短命 cache，也不能因系统判断“已完成”被遗忘 | 2026-08-28 |
| KD-12 | 归因 cohort 与 promotion holdout 分离；source owner 证明 optimizer exposure | 防适应性选择污染后仍 claim unseen-world 增长 | 2026-08-28 |
| KD-13 | Goal 的 value owner 与 measurement 四角色分权；代理不转移 value verdict | 专业知识与价值所有权不是同一权限 | 2026-08-28 |
| KD-14 | writeback 前必须有 owner-held intervention card 与双 falsifier | 把“发现问题”与“知道该改什么”分开 | 2026-08-28 |
| KD-15 | 依赖真修与 F311 生产建设并行：缺能力改 owner，F311 只补永久联邦控制面；真实 Program 另过 E0 | “修 bug 同时串联”比“先证明 CEW 再重做”更快；分开 bug 与不确定效用又避免概念吞并 | 2026-08-28 |
| KD-16 | Phase 按终态能力器官拆：建制与可见→开眼与取证→评估与归因→受治理写回与代谢→多对象联邦→机制自身进化；owner repair 与首个 E0 journey 均为横向车道 | 防 execution-first 把“下一步能做什么”偷换成“产品是什么”，杜绝脚手架与单点自进化叙事 | 2026-08-31 |
| KD-17 | F311 是开放世界的代理式进化控制面：外部 owner/Agent 在原仓原系统执行获授权 mutation，F311 只持 Program refs/lineage；执行权可代理，权限与 value verdict 不可偷渡 | 把 08-28“外部托管对象/Claude Code Harness”的定义性愿景补成可验收的执行契约，避免把 federation 错做成只读连接器或外仓复制器 | 2026-09-02 |

## Review Gate

- Phase 0: v4 已获 @fable5 final seal，Gate 0A 已完成；ownership 与 production-only 负向契约继续生效
- Phase 1–2: PR #4172 + production acceptance repair PR #4184 + PR #4196 已合入；AC-11–24 closed。Phase 2 已完成 Alpha loaded-runtime/API acceptance 并诚实保留 owner-evidence 缺口；Phase 3–6 继续按 v5 终态器官顺序实施。每个 Phase 的代码按 SOP 风险路由，spec/plan 变更走 co-creation docs；首个 E0 目标只在 Phase 4 production acceptance 前必须存在
- Close Gate: 必须有 loaded-runtime 全闭环证据；非作者愿景守护复核确认不存在对象特化、shadow truth 或 demo 删除清单

## Tips Contribution（F244）

- [x] Added `feature-f311-evolution-program`：说“我们来进化 X”开启 durable Evolution Program，并在 F307 Workbench 查看建制进度、typed blocker 与下一步。
