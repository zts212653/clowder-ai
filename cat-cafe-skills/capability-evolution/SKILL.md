---
name: capability-evolution
description: "F311 能力进化入口与续办。Use when: 用户询问可进化对象，或直接给出要改善的 Agent/业务能力结果，或已有项目需要继续。Not for: 事后复盘、确定性 bug、运行健康排查；只讨论或延后启动时不建 Program。Output: 解释边界；动作型目标幂等建 Program，并在同一 invocation 提交、回读首轮准备；已有项目按真实证据与权限继续取证、改进、复验和方法回流。"
---

# Capability Evolution — 从一句话进入受治理的进化

## 为什么需要这条路由

F311 是围绕一个可变对象运行的长期 Evolution Program；`self-evolution` 是把已经发生的流程经验沉淀成规则、方法或 skill。两者不是同一件事。真实失败是猫听到“能自进化什么”后只讲了通用理念，没有认出已经上线的 F311 产品，也没有建立“具体目标 → canonical start action”的预期。

先问时间方向：用户要**从现在开始进化一个对象**，走本 skill；用户在**复盘已经发生的工作**并要沉淀教训，才走 `self-evolution`。不要因为两句话都含“进化”就按词面路由。

## 先分意图，再决定是否写入

| 用户意图 | 行为 | 副作用 |
|---|---|---|
| “你们能进化什么？”“能力进化是什么？” | 用人话解释对象、边界和下一步 | 不调用 `cat_cafe_start_evolution_program` |
| “我们来进化”但没有目标 | 只追问一个短问题：想进化哪项能力？ | 不创建 Program |
| “怎样让 X 更专业/少操心？”或明确“先讨论 / 先摸底 / 暂不启动” | 读取方法导航，完成当前可做的讨论或准备草案；需要定义效果时实际进入 `eval-design` | 问句、假设、延后或只讨论不授权创建 Program |
| “我们来进化 X”，或“让 / 请让 Agent 或业务能力达到 Y”且没有问句、延后或只讨论限定 | 解析 `targetRef`，立即调用 canonical start tool，并继续首轮正式准备 | 创建或幂等返回 durable Program；写入版本化准备 |
| “请推进现有能力项目”或 Workspace 推进按钮请求 | 读取给定 Program 与已有责任链，执行当前可做的准备或跟进 | 继续已有工作，不重复 start，不跳过审批 |

问句里同时出现“我们来进化”和“能进化什么/哪些/啥”仍是信息型，不得因为命中了半句 trigger 就创建。

**命令式业务目标已经是具体目标。** 例如“让 PM Agent 专业地推进项目，只在必要时请人介入”应直接使用 **F311 admission identity** 建制，**不追问具体实现**、prompt、skill、runtime 或 owner。具体实现未知是对象地图要调查的内容，不是用户必须先填的建制字段。只有原话确实是“怎样做”的问句、假设、显式延后或只讨论，才保持零写入。

## 信息型回答

先回答用户真正关心的范围，不让用户读内部 schema：

- 家内能力：猫的 skill、工作流、协作方式、Harness 与产品体验。
- 业务能力：一个明确的业务结果或用户旅程，例如“路演表达效果”。
- 外部能力：有 authenticated owner 与可审计 adapter 的 Agent、代码仓或系统；资产仍留在原 owner。

边界也要一并说清：F311 本身不持有或直接写模型权重；模型选型或专训可以是候选，由具备相应能力、数据和权限的原 owner 执行，不能把“提到专训”当成已可训练。确定契约的 bug 直接走 test/lint/guard；性能、耗时和稳定性走 logs/metrics/traces；没有明确 consumer 与 keep/tune/sunset 决策的问题不冒充 Evolution Program。用户还没给目标时再邀请其给目标，不重复询问已有事实。

## 只有业务原话，也要交出第一份准备

先读[跨对象进化方法的业务起点](refs/evolution-method.md#从业务原话交出第一份准备)。把已知目标、候选范围、可检查的判断草案、GT 来源与采集/取证条件及当前未知带回当前阅读面。用户无需先说出“eval”或填写技术表；只把“专业、省心”换成几条形容词，或列出准备调用的 skill，不算完成判断方法。动作型输入先建 Program，再把这份准备写回 Program；只有信息型、显式零写入或缺少 invocation 写权限时才留在 Chat 草案。

公开调查、规约草案、设施建设、试采与正式证书是不同产物。条件未齐时交出有用草案并注明待校准，不能伪造基线、角色或采用事实，也不能只报告缺口。

## 具体目标的 canonical start

新对象开工或新 thread 接手时，先读[跨对象进化方法](refs/evolution-method.md)，定位对象、价值、证据与权限；已有事实直接复用，不重新盘问用户。它迁移的是判断方法，不是上一项目的目标、指标阈值、对象版本或角色授权。

1. 保留用户明确说出的目标 X。一个业务目标可有多个待调查对象，不能提前缩成“改提示词”等单一改法；canonical start 仍只绑定本次明确的 `targetRef`，不猜多个 owner 或批量创建 Program。候选地图不授予多对象写回权，实际干预沿各 owner 与受控比较契约执行。
2. 解析 canonical `targetRef`：
   - 已知对象已经有 owner ref：从 feature/skill/owner truth 读取它，使用原 `ownerFeatureId`、`ownerStateRef` 与可选 `version`，不要凭记忆猜 owner。
   - 新的自然语言能力还没有 owner ref：以 F311 admission identity 表示，使用 `{ ownerFeatureId: "F311", ownerStateRef: "capability:" + encodeURIComponent(X.trim()) }`。这只是稳定对象身份，不复制对象 payload，也不替未来 domain owner 签字；缺失角色由 Program 的 typed blocker 表达。
3. `clientMessageId` 必须使用触发这次请求的 exact `sourceMessageId`，让同一用户消息重试保持幂等。没有可验证 source message id 时不得生成随机 id；诚实说明无法绑定这次请求并请用户重试。
4. 调用 `cat_cafe_start_evolution_program({ targetRef, displayName, clientMessageId })`。`displayName` 必填：使用用户刚表达的目标 X 作为可读项目名称（1–120 字），不要从 opaque slug 翻译或猜资产名。它只是 Program 名称，不是 Goal 证书或采用事实。不要自行填写 Goal、claim、stage、lifecycle、证书或角色 payload。
5. **创建 Program 后不等待下一轮。** 在同一 invocation 使用返回的 exact Program 调用 `cat_cafe_get_evolution_program`，再按下方动作链用 `cat_cafe_begin_evolution_preparation_work` 与 `cat_cafe_submit_evolution_preparation` 交出当前证据允许的首轮四块准备。未知可以写成未知；没有 owner / 角色 / 真实基线只限制结论，不把建制或草案推回给用户。
6. 最后 exact get 回读，再用人话回报：创建/已存在、目标、实际提交的准备、当前建制状态、用户是否真的需要行动及下一步；给出返回的 F307 Workspace surface。内部 refs 与 typed blocker code 只在用户追问技术详情时展开。

## 继续现有项目：把准备推进到实际动作

用户从 Workspace 点击“请猫猫推进评估 / 跟进结果”时，会在项目的发起对话向发起猫发送一条显式请求，携带精确 `evolution-program:<id>`。这是推进已有工作的指令，不能重新 start 一个 Program，也不能只回复状态。

### 正式准备动作链

四个入口 `object_map`（可进化对象）、`success_contract`（好坏规约）、`measurement_plan`（测量与实验准备）、`baseline_diagnosis`（基线与初步诊断）可交叉推进；它们是阅读坐标，不是新的后端 phase，也不要求串行填表。

1. 调用 `cat_cafe_get_evolution_program({ programId })`，读取 `program.sequence`、四块当前修订/历史、真实活动与来源状态。list 只用于找项目，不含准备正文。
2. 确认本 invocation 正要做一项具体工作时，调用 `cat_cafe_begin_evolution_preparation_work`。带上当前 Program sequence、本块 exact current ref（尚无则 `null`）、可定位的 item 和具体 focus；返回后用新 sequence 继续。登记本身会出现在阅读面，不能先挂“进行中”再停工，也不能替另一只猫登记。
3. 实际完成当前可做的调查与方法工作。对象地图用已发布的 [准备选择字段](refs/preparation-choice.md) 保留类别、具体对象、猫建议、本轮决定、谁定、已有工作与可改边界；未知显式提交，旧稿不补默认决定。规约给观察单位、判法、反例、GT 域/裁判/付薪方；测量准备分开 GT 来源、采集和可信性；基线保留事实、未知、竞争解释与区分动作。不要把 draft 写成证书或客户事实。
4. 内容确实可交接时，调用 `cat_cafe_submit_evolution_preparation`。使用 begin 返回的最新 sequence、本块 exact current ref和所有 exact current dependency refs；每个动作使用独立、可重放的 `clientMessageId`，不能复用 start 或其他 section 的事件身份。
5. 再次 exact get，确认正文、作者、workspace、来源、revision 与状态已回读。`conflict` 先重读并基于新版本处理，禁止覆盖；若同一次 submit 在 Program 事件落盘后中断并显示 `materializing`，必须用**相同 clientMessageId 与完全相同正文**重试补写，不能换 id 冒充新修订。

begin/submit 只对当前 invocation 的 full MCP 开放。浏览器、agent-key 或没有真实接手者时，不伪造活动；仍可在 Chat 交付明确标注的探索稿，但那不等于正式准备提交。

新 Program 的首轮准备不要求四块按顺序变成“完成”。可先在同一 invocation 逐块登记、提交诚实草案并在每次动作后沿最新 sequence 继续；每块仍有独立 event identity，依赖使用当时 exact current refs。不能只创建 Program、列出计划，然后把本来可做的准备留给下一轮。

### 按真实缺口继续

首轮准备是当前产物，不是整项任务的终点。准备提交、观察/评估到来或执行回执
返回后，按[完整学习循环](refs/learning-loop.md)选择并执行已有授权内的下一动作。
沿原 Program 与原 owner 接回结果，不要求用户为了推进再说一次“继续”。
人的目标、规约冻结与价值取舍权保留；实际批准是否足够以当前原系统契约为准。

1. 用 `cat_cafe_get_evolution_program` 读取这个 Program，再核验本对话已有任务和当前持球者；继续已有工作，已交接则沿已验证的责任链协调。
2. 按真实缺口行动：需要定义/校准量尺、设计观测与独立验证、区分失败原因或形成干预方案时，进入 [eval-design](../eval-design/SKILL.md)。带去当前对象/claim、已有来源、版本与已知缺口；不要只递一个“请帮我定指标”的空问题。证书或角色缺失限制正式结论与采用，不阻止已有授权内的公开观察、资料核验和隔离候选准备。
3. 从 `eval-design` 带回可复用的测量/干预约定、证据限制及 owner 交接需求；已有正式产物只携 canonical refs。按[阶段与实际动作](refs/evolution-method.md#从当前状态选择下一步)继续原 Program，不能把方法文档、聊天描述或 fixture 合成证明，也不重新 start。
4. 执行后回报这次实际完成的动作、仍缺的条件和下一步。只有人能决定的价值取舍才提出具体待决事项；技术调查与 owner 对接由猫继续。请求送达 / invocation 启动不等于评估完成。
5. 这条请求不授予跳过 Approval、强制推进阶段或采用候选的权限；暂停与结束的项目仍遵守原生命周期边界。

## 与 eval-design 的往返

| 当前问题 | 去哪里 | 带回什么后继续 |
|---|---|---|
| 什么变化才值得要、能否可靠观测 | `eval-design` 的 E0 与指标出生证 | value/claim 边界、观测定义、校准与成本约定；未决项保持未决 |
| 分数变好却不能证明效果、原因未分清 | `eval-design` 的体检与干预证 | 竞争解释、区分实验、证伪条件、独立验收与回滚要求 |
| 已有 owner 证书/观测/评估/写回结果 | 本 skill 的阶段导航 | 当前 Program 可执行的下一动作与真实回执 |

这是按问题选择的往返，不是每轮固定加载全部 skill。单次检查、确定 bug、运行健康和既往知识总结继续走各自原车道。

## Common Mistakes

- **把产品问题路由到 `self-evolution`**：只讲成长理念，用户不知道 F311 已可用。修复：先做本 skill 的信息/动作分流。
- **信息问题也创建 Program**：用户还没选对象就产生持久状态。修复：没有具体 X 时零写入。
- **具体目标只给建议、不调用工具**：看似回答了，Workspace 没有 Program。修复：有具体 X 就走 canonical start action。
- **把命令式业务目标当咨询问句**：猫承认“这是明确能力目标”，却因没写“我们来进化”而反问用户。修复：直接“让 / 请让 Agent 或业务能力达到 Y”且无延后限定时就是动作型；用 admission identity 建制。
- **猜 owner 或让用户填大表**：破坏 owner truth 与零表单入口。修复：已知 owner 必须查证；未知对象使用 F311 admission identity，让 typed blocker 承担缺项。
- **把无关脏文件包装成人工决策**：当前动作不需要改文件却把已有 untracked / dirty 状态带给用户选择。修复：保留并绕开即可；只有它真实阻塞已授权动作时才升级。
- **start 后停在回执**：Program 出现了，但用户仍看不到第一份准备。修复：动作型新目标在同一 invocation 继续 begin / submit / exact get；缺项写进草案，不把可做工作留作口头下一步。
- **把项目经验整包迁移**：旧目标、阈值和权限被误当新对象的事实。修复：只迁移对象识别、量尺校准、证据隔离和复验方法，重新读取新对象的 owner truth。
- **有 blocker 就只报状态**：正式证据尚缺，被扩大成所有准备停工。修复：区分不可下的结论与仍可执行的授权内动作，并实际推进后者。
- **规约只有业务口号**：展示“专业、少打扰”，却没有观察单位、判断依据与反例。修复：实际使用 `eval-design`，把本次适用的测量/校准草案带回；“草案形成”不等于已获业务确认。
- **把方法写完当作对象已进化**：没有实际使用与新任务结果，便用文档、测试或写回回执宣布完成。修复：按学习循环分开生效、使用与后果；方法本身另追后续 consumer 的效用。

## 验证

- 入口描述与路由的确定性保护见 [F311 wakeup 契约测试](../../packages/api/test/harness-eval/f311-capability-evolution-wakeup.test.js)；修改时将该测试纳入定向验证。
- 信息样本：`我们来进化 嗯？ 你们能自进化什么东西？` → 首答认出 F311、解释范围与边界、零 Program 写入。
- 动作样本：`我们来进化视频生成能力` → 成功调用 `cat_cafe_start_evolution_program`，Program 出现在 Capability Evolution Workspace。
- 自然目标样本：`让 PM Agent 专业地推进项目，只在必要时请人介入` → 使用 F311 admission identity 创建唯一 Program；同一 invocation 提交并回读四块首轮准备，不追问具体是哪套 PM 实现。
- 延后样本：`让 PM Agent 更专业一点，不过先别创建项目，我们只讨论` → 交付讨论草案，零 Program 写入。
- `eval:capability-wakeup` 的 `capability-evolution-concrete-target` 规则把“具体目标但未成功 start”计为 miss；静态字符串存在不算通过。

## 下一步

Program 创建后以返回 projection 和 F307 surface 为真相，沿[跨对象进化方法](refs/evolution-method.md)选择下一步；度量、归因或干预需要设计时转 `eval-design`，完成后返回同一 Program。准备后的承接见[完整学习循环](refs/learning-loop.md)，修订方法时查[出处与证明范围](refs/method-evidence.md)。任务转为提炼既往方法时才切到 `self-evolution`；整理出方法本身不证明方法已有净效用。
