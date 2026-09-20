# F257 Harness Ledger 治理循环 Demo Contract

## 0. 双轴判题

- **demo_kind**：`journey_validation`
- **delivery_lane**：`internal_product_gate`
- **目标观众**：co-creator / operator
- **主 claim**：一个 version 是一个 unit；unit 内可以反复走 `tracing → eval → governance`。系统自动收集证据、形成结论并提出干预，人只在审批卡应用或拒绝；应用内容修改才创建新版本，拒绝则留在同一版本，两条路都回到下一轮。
- **观众复述句**：我能指出“哪份内容、哪个冻结窗口、哪些数据、什么指标产生了什么结论”，也能解释为什么 apply 生成 v2、reject 仍在 v1。
- **验收动作**：operator 分别走完 apply 与 reject 两条路，给出“可用 / 需要调 / 不接受”的体验裁决。
- **非目标**：完整版本树、回退后分叉、真实用户数据、长期效果证明，以及页面内未标明的生产接线。

## 1. 视觉真相与交付边界

- **交付位置**：feature worktree 的 `/showcase/f257-governance-journey`
- **visual_source_of_truth**：现有 lifecycle badge 语法、`ObjectiveEvaluationPanel`、`ApprovalDecisionCard`、`GenericApprovalRecommendation` 与 F056 semantic tokens；Demo 页的生命线只新增“version 内按轮次累积”的投影。
- **品味文件 fallback**：`creative-craft-概念演示-mksdmh.md` 在当前 worktree 不存在，因此不推断其中内容，只使用可查证的 F056 tokens 与现有产品组件。
- **dev controls**：顶部虚线容器中的 apply/reject 场景切换、上一步、下一步、重置；不冒充生产控制面。
- **truth label**：常驻“功能原型 · 演示数据 · 不连接生产”。

- [x] 页面主体来自现有产品组件，没有另造第二套 UI 语言
- [x] 开发控制与产品交互分层
- [x] 五个步骤使用 operator 能理解的人话
- [x] apply 与 reject 都有可操作、可验证的终态
- [x] 概念编排、真实底层能力与待补接线在画面中明确区分

## 2. 用户模型

```text
一个 version = 一个 unit

reject：v1 ● → [第 1 轮 tracing → eval → governance · rejected]
             → [第 2 轮 tracing → eval → governance · 当前]

apply： [v1 / 第 1 轮 tracing → eval → governance · approved]
        ⇒ [v2 ● / 第 1 轮 tracing → eval → governance · 当前]
```

规则：

1. eval 窗口一旦冻结，同一次结论始终指向同一份内容、窗口、数据、指标与 measurement。
2. governance 候选由系统自动创建，用户不会看到“启动治理”的按钮。
3. 用户只在审批卡点击 apply 或 reject；reject 必须允许填写理由。
4. 只有内容发生修改才创建下一版本；继续观察、证据不足或 reject 都留在当前版本。
5. 下一轮 eval 就是对新状态的再次验证，不增加独立用户环节。
6. 本轮只做线性 next/prev 谱系；完整树与回退分叉在体验验收后另行设计。
7. version 节点只在该 unit 开头出现一次；同一 version 的每一轮都顺排完整的 `tracing → eval → governance`，历史轮必须保留 governance 结果。

## 3. 信号路径

```text
结构化反例
→ 冻结 evaluation snapshot
→ 内容 + 时间窗 + 来源数据 + 指标规则 + measurement → verdict
→ 系统自动创建 Candidate
→ operator apply / reject（可填写理由）
→ tracing 开启下一轮
```

| 问题 | 答案 |
|---|---|
| 系统实际看见什么？ | 版本化内容引用、冻结窗口、trace source refs、MetricResult、verdict 与 Candidate |
| 哪些信息它看不见？ | operator 没有写入系统的私下判断；Demo 不读取生产数据 |
| 谁负责生成治理建议？ | governance worker；不是 operator |
| 谁决定是否改变内容？ | operator 在审批卡 apply / reject |
| 如何验证改变是否有效？ | 在改变后的版本中重新 tracing 与 eval |

## 4. 诚实边界

| 画面 / 行为 | 分类 | 当前真相 | 屏幕标注 |
|---|---|---|---|
| S13、3 个反例与固定时间窗 | 概念编排 | 确定性演示数据 | 演示数据 |
| Lifeline / Eval / Approval 组件 | 功能原型 | 复用当前产品组件 | 功能原型 |
| `setContentOverride` 生成单调递增内容版本 | 真实底层能力 | 后端 route 与 store 已支持 | 底层能力可用 |
| Candidate apply 自动调用 `setContentOverride` | 真实底层能力 | Candidate 执行器已在生产 route 调用 `setContentOverride` 应用内容修改 | 审批接线已接通 |
| reject note 写入 `Candidate.approval.note` | 真实能力 | 当前后端已持久化 | 已持久化 |
| reject note 自动进入下一轮 evaluator | 概念编排 | evaluator 输入桥尚未接通 | 需要后端触点 |

Demo 不把测试绿、组件可点或底层 primitive 存在，表述成整条生产链已接通。

## 5. 五步 Journey ledger

| # | 人话步骤 | actor | 起始状态 | 信号 / 动作 | surface | 下一状态 | 验证证据 |
|---:|---|---|---|---|---|---|---|
| 1 | 收集证据 | tracing runtime | v1 / 第 1 轮 tracing | 第 3 个结构化反例进入窗口 | Lifeline + Tracing | 可以开始评估 | 3 个 source refs；阈值不代替结论 |
| 2 | 评估出结论 | evaluation runtime | 证据达到触发条件 | 冻结 snapshot 并执行指标规则 | Eval evidence chain | verdict 可追溯 | `S13@v1`、window、source、metric、rule、measurement、verdict |
| 3 | 系统建议干预 | governance worker | verdict 已形成 | 自动创建唯一 Candidate | Lifeline + Approval card | 等待 operator 决定 | 系统自动创建；页面没有“启动治理”按钮 |
| 4A | 你审批 | operator | Candidate proposed | apply 内容修改 | Approval card | v2 已产生 | 单次决定；`setContentOverride` 真相边界清楚 |
| 4B | 你审批 | operator | Candidate proposed | reject 并填写理由 | Approval card | 内容不变 | reason 非空并留在 `Candidate.approval.note` |
| 5A | 回到下一轮 | tracing runtime | 内容已修改 | 从 v2 的第 1 轮开始收集 | Lifeline + Tracing | v2 tracing | v1 第 1 轮 `approved` 保留，随后 `⇒ v2`；v2 从 tracing 开始 |
| 5B | 回到下一轮 | tracing runtime | 内容未修改 | 从 v1 的第 2 轮继续收集 | Lifeline + Tracing | v1 tracing | v1 只出现一次；第 1 轮完整链与 `rejected` 保留，第 2 轮完整链标为当前 |

### 可判定终态

- apply：Candidate=`approved`，版本迁移=`v1 → v2`，新版本处于第 1 轮 tracing。
- reject：Candidate=`rejected`，不创建新版本，v1 进入第 2 轮 tracing；理由非空并显示下一轮 evaluator 的接线缺口。

## 6. 控场

- [x] 上一步 / 下一步
- [x] apply / reject 场景切换
- [x] 重置
- [x] reject 理由输入
- [x] 确定性固定数据与固定状态序列

## 7. 自动验收

1. 两条场景都恰好包含五步，步骤名与用户模型逐字一致。
2. 页面步骤与可见说明不出现工程事件名，也没有独立验证环节或工程恢复场景。
3. evaluation 显示 `S13@v1`、冻结窗口、snapshot、3 个 source refs、metric、rule、measurement 与 verdict。
4. Candidate 由 system 自动创建，唯一 operator 动作为 apply / reject。
5. apply 只决策一次并显示 `v1 → v2`；v2 从第 1 轮 tracing 开始。
6. reject 不创建新版本并显示“仍在 v1 / 第 2 轮”；reason 被持久化，evaluator bridge 标“需要后端触点”。
7. 页面常驻 truth label，内容审批接线标“审批接线已接通”。
8. reject 终态的 v1 节点只渲染一次，下面按顺序展开 2 个完整轮次；前一轮结果=`rejected`，当前轮=`当前`，不显示“第 N 轮”文字标签。
9. apply 终态分成 v1 / v2 两个 version unit；v1 的历史轮结果=`approved`，v2 当前轮=`当前`，不显示“第 N 轮”文字标签。

## 8. 验证记录

### 2026-08-31 本轮

- journey model + 页面交互：12/12 通过；红灯先证明旧实现的八步工程流程、独立验证环、恢复场景与无 v2 谱系不符合契约，再收敛为五步。
- 相邻 Lifeline / Eval / verdict / Approval presentation：114 条通过；另 1 条 F305 测试因当前 HEAD 本就缺少 `docs/discussions/2026-08-22-f305-ui-design-gate-closure/demo-contract.md` 而失败，与本 diff 无关，未为它补造文件。
- Web TypeScript：`tsc --noEmit` 通过。
- Biome changed-file check 与 `git diff --check`：通过；本页面无新增 F056 颜色告警。
- Production Web build：通过；静态路由 `/showcase/f257-governance-journey` 成功产出，production cache policy 2/2 通过。
- Production HTTP：`200`；SSR 载荷包含五个人话步骤与常驻 truth label，不含旧验证/恢复文案。
- 当前 invocation 未暴露 Browser skill 要求的控制通道，因此未做逐幕截图或像素检查，也未用另一套浏览器自动化替代。operator 实际体验签字仍是最终体验 Gate，不能由自动测试替代。

### 2026-09-01 多轮生命线 delta

- 红测先证明页面仍把同一 version 的下一轮压回单个 epoch；新增断言要求 v1 节点唯一、历史轮结果可见、当前轮完整顺排。
- journey model / 页面交互及相邻 lifecycle/eval/verdict 回归：112/112 通过。
- Web TypeScript、Biome changed-file check、`git diff --check`：通过；页面没有新增 F056 告警。
- Production Web build 与 production cache policy 2/2：通过；路由仍静态产出。
- Production HTTP：`200`；SSR 载荷包含“版本生命线 / 第 1 轮 / tracing / eval / governance / 当前”，不含旧验证或恢复文案。
- 当前 invocation 仍未暴露 Browser skill 要求的控制通道；apply/reject 两个终态由 React 测试逐点击验证，逐幕截图由 Opus 在 exact HEAD 上复审后交 operator。

## 9. 完成判据

代表性 operator 无需工程事件知识，即可从画面复述一个 version 内的循环、判断何时会生成 v2，并分别完成 apply / 带理由 reject；两条路都能看到明确的下一轮，且能指出哪些能力真实存在、哪些仍需后端接线。
