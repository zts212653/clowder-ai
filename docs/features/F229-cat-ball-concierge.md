---
feature_ids: [F229]
related_features: [F155, F020, F092, F111, F128, F226, F227, F102, F099]
topics: [concierge, desktop-pet, pet-skin, routing, small-model, voice, memory, ux, community]
doc_kind: spec
created: 2026-06-09
community_issue: "clowder-ai#841"
---

# F229: 猫猫球 — 前台猫常驻入口（Cat Ball Concierge）

> **Status**: in-progress | **Owner**: Ragdoll (Fable-5) | **Priority**: P1
>
> **立项 signoff**：operator 2026-06-09（msg 0001781064063516-000541）："我判定是新立项 你可以把我想要的想想看 写好operator的愿景 然后立项吧？新的 feat"

## Why

Cat Café 三个多月迭代 200+ feature，"一句话的事"和"一个 feature 的事"走的是同一条重链路（开 thread → @ 猫 → 等回复）。operator experience拼出的六个痛点：

1. **功能发现**："Cat Café 更新太快，功能太多，用户不知道有什么功能"
2. **求助**："使用猫咖遇到的困难可能也会找猫猫球"
3. **金鱼的记忆**："诶 我们之前讨论的xxx到底在哪里来着？"——operator是全家唯一没有 recall 工具的成员：猫有记忆三入口 + teleport，用户只能手翻 thread 列表
4. **分诊/调查**："这个猫猫球可能帮忙发送到哪个 thread 或者自己调查"
5. **语音**："甚至得支持语音输入输出"
6. **陪伴**：桌宠形态、"类似原神的派蒙"——常驻、有生命感的家庭向导

**一句话愿景**：猫猫球 = 家里的前台猫。Thread 是工作间，猫猫球是前台——你不知道找谁、不想走进工作间、只想喊一嗓子的时候，找它。它把"从想法到触达"的距离缩短到一句话，并把猫吃了半年红利的记忆系统第一次开放给operator本人。

社区输入：clowder-ai#841（arthas4ever）独立提出了同坐标系的"悬浮球 Interactive Assistant"——入口形态一致，但其方案重心（OpenCLI 页面操作演示）被重定为远期 Phase；真正的灵魂是功能发现 + 前台分诊（operator 2026-06-09 收敛）。

## Current State / 现状基线

- **记忆入口不对称（实测）**：live runtime 1076 个 thread 仅 162 个有 threadMemory（15%，Maine Coon 2026-06-09 只读实测）；猫侧有 `search_evidence`/`graph_resolve`/`list_recent` + teleport，**用户侧零入口**——"金鱼的记忆"是系统欠的，不是operator记性差
- **功能发现断层**：F155 guide engine done（9 个 YAML 场景 + `cat_cafe_get_available_guides`），但设计上是猫按上下文触发，**无用户常驻入口**；release notes / feature docs 无对话式查询面
- **语音积木齐但没串成 loop**：F020 STT done（输入框 + F20c 全局热键）、F092 VoiceSession done、F111 流式 TTS done——无"按住说话→答→自动播"的对话式闭环
- **常驻 surface 容器有借力点**：F226 AppShell 级 surface host（Phase A done）
- **社区需求悬置**：#841 标 `needs-maintainer-decision` 等方向，原标签 `feature:F155` 已不准确（F155 closed）

## What

### 核心概念（operator 2026-06-09 拍板方向）

**1. 前台猫 = 岗位，不是一只新猫。** 三层解耦（"和现在 profile 那样解耦的可以配置"）：

```
形象层：默认家养像素猫桌宠——【Ragdoll/Maine Coon/Bengal/Siamese】四选一，v1 默认Ragdoll（KD-14）；
        毛线球降为备选皮肤/过渡形态；开源用户可换自家猫
人设层：前台猫自己的名字与性格（用户感知的"这是谁"）
值班层：背后真正干活的模型，按任务分层路由（可配置）
```

**2. 复合猫路由**（operator："小模型发现自己干不了 → 喊大喵"）：

```
用户一句话
  ├─ 导航/跳转/打开/快捷操作 → 本地小模型（gemma clerk，秒级）
  ├─ 干不了 → escalate 值班大猫（优先快+便宜：flash / sonnet / spark 级，可配置）
  └─ 深度工作 → 透明转接对应 thread 的猫（"这个我去喊Ragdoll"）
```

**3. 值班大猫复用现有 cat runtime**（operator洞察："本质如果用 cc + claude 那不就是Ragdoll？"）——前台猫不发明新 agent 物种，值班层就是现有猫体系按岗排班；新组件只有：常驻入口壳、身份配置层、小模型 clerk、escalation 协议。

**4. Harness 纪律预定**（继承 gemma 线收敛 + 家规）：小模型 MD-first 不写 JSON；anchor 用短 handle 由 wrapper 映射回真实 ID；validator fail-closed；escalation **传原始对话不传小模型总结**（KD-8 no-classifier）。

### Phase 0: Research + Design Gate

- 形态 research：派蒙/桌宠交互范式/Clippy 反面教训（打扰式主动的失败史）；身份三层配置模型设计
- 架构归属一问（ownership cell：新 surface + 路由层归属，预判 new cell required）
- UX wireframe（悬浮球态/展开态/桌宠动效层级）→ operator确认
- 走 research → spec 正规管道，技术选型（小模型 serving 方式、悬浮层实现）此阶段收敛

### Phase A: 前台开张（文字三件套 MVP）

- web 内悬浮球入口（最小动效）+ 展开对话窗，任意页面可唤起不离开当前页
- 值班大猫可配置（默认一只，走现有 cat runtime）
- **功能发现**：以 feature docs / release notes / guide catalog 为知识源回答"有什么/怎么用"
- **求助**：接 F155 guide 触发（"我演示给你看"→ 启动对应 guide flow）
- **记忆检索 + 跳转**：search_evidence + teleport 包装进对话（"之前讨论 X 在哪"→ 给链接一键跳）
- 语音**输入**直接复用 F020（输入框级，非对话 loop）

### Phase B: 总机能力

- 分诊：代用户 cross_post 到归属 thread / propose_thread 开新调查（用户确认后执行）
- 自主调查：spawn task 自己查（记忆/docs/GitHub），回对话框交带 anchor 的报告
- **承接 A3b deferred**：PendingConfirmation 跨刷新持久化 wiring（spec §1b C3——后端 store/route 已就绪，缺 (messageId, blockId, action)→confirmationId 反向索引 + mount-time 查询；gpt52 final review 降级 P3 放行，2026-06-12）

### Phase C: 语音 loop（长出嘴和耳朵）

- F020 STT + F111 流式 TTS 串成对话式闭环：按住说话 → 前台猫答 → 自动播
- 复用 F092 VoiceSession 的"设备会话与 UI thread 解耦"模型

### Phase D: 快速档入驻（复合猫生效）

- 「快速档」clerk 接管导航/跳转/快捷操作类 intent——**provider-agnostic**：本地小模型（gemma，借力 F102 provider 抽象）**或** API 快模型（flash/glm 级）均可作 clerk（吴浪部署现实主义：不是每家有 128GB Mac；本地是 opt-in 优化不是前提）
- **clerk 零工具执行权**（KD-12，Maine Coon tool-intent smoke 实测 cat-cafe#2175）：小模型只输出 MD tool-intent candidate，validator 做 handle 映射 + 确认门 + forbidden fail-closed，实际工具调用由可信 harness/值班猫执行
- **routing rules 必备**（实测：裸工具描述 9 intent 错 1——"之前讨论在哪"被错选 `graph_resolve` 偏向 feature anchor；加显式 rules 后 9/9）：讨论/在哪→search_evidence、spec/status→feat_index、已知 handle→teleport、cross_post/propose_thread→需确认、6399/runtime/truth-source→refuse_or_escalate（不问确认，带原文升级）
- escalation 协议落地（传原始对话；值班大猫优先级可配置）
- 无快速档配置自动降级全走值班大猫（Phase A-C 不依赖本 Phase）

### Phase E: 桌宠化 + 形象生态 + 操作演示（远期）

- 桌宠动效系统（呼吸/打盹/状态表情）+ 皮肤生态（开源用户自家猫形象）
- **PetSkinContract**：参考 `hatch-pet` 的 Codex pet atlas/QA/provenance 纪律，但 F229 不降级为纯桌宠。PetSkin 是 `conciergeState -> petState` 的纯投影；动画是增强信号，状态必须同时有非 pet 通道表达；完整 8x9 atlas defer，v0 只要求 idle/running/review/failed 四态打通（见 `docs/features/F229-petskin-contract.md`）
- **素材池已开仓**：`assets/F229/desktop-pet-sprite/`（README 含 production pipeline 五步 + Maine Coon验证的云端生图 prompt 模板）——Maine Coon raw sheet ×2 已入库（fbb0e8add）；v1 默认Ragdoll + 孟加拉/暹罗 sheet 待生成
- 主动冒泡（新版本发布等白名单事件，安静优先）
- OpenCLI 式页面操作演示（#841 终态收编：猫操作页面给用户看，操作前用户确认）

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "更新太快…不知道有什么功能" | AC-A2 | manual 问答验收 | [x] |
| R2 | "使用猫咖遇到的困难也会找猫猫球" | AC-A4 | manual + guide 触发录屏 | [x] |
| R3 | "之前讨论的xxx到底在哪里来着？"（金鱼的记忆） | AC-A3 | manual 3 query 验收 | [x] |
| R4 | "帮忙发送到哪个 thread 或者自己调查" | AC-B1, AC-B2 | 留痕 + 报告抽查 | [x] |
| R5 | "和 profile 那样解耦的可以配置"（形象/人设/值班） | AC-A5 | screenshot | [x] |
| R6 | "支持语音输入输出" | AC-C1 | 录屏 + 延迟实测 | [ ] |
| R7 | "小模型发现自己干不了→喊大喵（优先 flash/sonnet/spark）" | AC-D1, AC-D2 | 延迟数字 + 代码断言 | [ ] |
| R8 | 桌宠/派蒙式常驻陪伴 | Phase E（AC 启动时补） | 录屏 | [ ] |
| R9 | #841 悬浮入口 + 页面上下文（社区） | AC-A1 | 截图/录屏 | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC（R8 远期 Phase 启动时补编号）
- [x] 每个 AC 都有验证方式
- [ ] 前端需求→证据映射表（Phase A quality-gate 时产出）

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC 必须 ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。 -->

### Phase 0（Research + Design Gate）
- [x] AC-02: Design Gate 通过——wireframe operator OK（msg 0001781074572950"可以可以！！我觉得没问题！！"，含去/取/传话分叉 + Duty Toolset）+ 架构归属（new cell concierge-surface）+ 元审美自检（design doc §7）

### Phase A（前台开张）
- [x] AC-A1: 任意页面悬浮球唤起对话，不离开当前页面（截图 + 15s 录屏）→ R9/Why-2——证据 `assets/F229/acceptance-phase-a/ac-a1-*.png`（sonnet 验收 2026-06-12，球+toolbar+面板+拖拽）
- [x] AC-A2: 功能发现——非作者拿 3 个"最近有什么新功能/X 怎么用"问题验收，答案与 release notes/feature docs 一致 → R1/Why-1——3/3 核对通过（F225/F226/F229/F228 答案与 docs 一致），证据 `ac-a2-*.png`
- [x] AC-A3: 记忆导航——3 个真实历史讨论 query 给出正确 thread/message 链接，且**两种动作都可用**：跳过去（teleport）+ 原地看（卡内 inline 展开）→ R3/Why-3——**基础设施 ✅；KD-19 修复 merged（PR #2284）+ sonnet alpha 验收通过（2026-06-14）：Q1/Q2 gemini25 不遵从 marker → validator 全量兜底出 teleport ✅（命门：之前 0 actions，兜底后出按钮）；Q5 passage-level hit → marker path teleport+peek ✅；P1-A/B/C 全验证；alpha memory 稀疏（6 thread doc）故 Q1/Q2 无 peek，生产 passage-level 充足（production MCP 已验）**（证据 `ac-a3-*.png`）
- [x] AC-A4: 求助场景能触发对应 F155 guide flow（录屏一条）→ R2/Why-2——intent 检测 + 9 guide 列举 + handoff 卡 ✅，证据 `ac-a4-*.png`
- [x] AC-A5: 形象/人设/值班猫在设置页可配置，与 cat profile 解耦（截图）→ R5
- [x] AC-A6: 安静默认——默认零主动文本弹出；低优先级事件只显示 badge（hover 才出文字）；用户可一键 hide/mute 整个球（录屏 + 设置截图）→ R8/调研红线——alpha muted 往返全链 ✅（API+UI 双确认），证据 `ac-a6-*.png`

### Phase B（总机能力）
- [x] AC-B1: 用户描述问题 → 前台猫给出分诊建议并经确认执行，**传话/跟去双路径**：relay（cross_post 投递 + 对方回复后回执卡）+ go（teleport 跟进），留痕可查 → R4 + operator 分叉反馈——TriagePlan state machine（proposed→confirmed→dispatched→completed/failed, retry from failed）+ atomic claimTransition（Redis Lua CAS + Memory sync CAS）+ targetCats resolver（fail-closed, registry validation）+ stripTriagePlanMarkers + CardBlock wiring；PR #2299 merged 2026-06-15
- [x] AC-B2: "自己调查"产出带 anchor 的报告回对话框（抽查 anchor 真实性）→ R4——InvestigationProgress 组件：poll job status（2s interval, terminalReachedRef stale guard）+ render report summary（ANCHOR_MARKER_RE strip）+ clickable anchor list（thread→planTeleport, github→external link, doc/feature→inline path）+ cancel with 409 race handling + confirmation restoration on mount；PR #2316 merged 2026-06-16

### Phase C（语音 loop）
- [ ] AC-C1: 按住说话 → STT → 回答 → TTS 自动播全链路可用，端到端延迟实测记录（数字进 doc）→ R6

### Phase D（小模型入驻）
- [ ] AC-D1: 导航/跳转类 query 由本地小模型应答，p50 延迟实测显著低于大猫链路（两组数字对比）→ R7
- [ ] AC-D2: escalation 传原始对话不传小模型总结（测试断言，KD-8 合规）→ R7
- [ ] AC-D3: 小模型不可用时自动降级全走值班大猫（测试）→ R7

### Phase E（桌宠化 + 形象生态）
- [x] AC-E0-1: PetSkinContract v0 — `conciergeState → petState` pure projection (4 states: idle/running/review/failed), shared types + `projectToPetState()` function, 10 unit tests
- [x] AC-E0-2: ragdoll-v1 skin — manifest (`pet.json`) + 4 individual sprite PNGs (idle/running/review/failed), three QA gates pass (readability/identity-diff/provenance)
- [x] AC-E0-3: ConciergeBall skin-aware resolution — `resolvePetSprite(ballState, skin)` with ragdoll-v1 (v0 4-state projection) + yarn-ball (legacy 8-state direct, filename override for needs-confirmation→confirm.png) backward compat, 19 web unit tests
- [x] AC-E0-4: Settings page skin display — dynamic `SKIN_DISPLAY_NAMES[skin]` + default `ragdoll-v1` in store + API validation + `FALLBACK_SPRITE_PATH`

## Dependencies

- **Evolved from**: F155（场景引导引擎——guide 后端积木已 done；#841 原挂 F155，其"常驻入口"愿景由本 feat 承接）
- **Blocked by**: 无硬阻塞（Phase D 软依赖 F102 小模型 provider 抽象收敛，Maine Coon线进行中）
- **Related**: F020/F092/F111（语音积木）、F128（propose_thread/cross_post）、F226（AppShell surface host）、F227（teleport message 级跳转）、F102（gemma clerk / MD-first harness）、F099（hub 导航）

## Risk

| 风险 | 缓解 |
|------|------|
| 桌宠变 Clippy（打扰式主动的失败史） | 主动行为白名单 + 频率上限 + Design Gate 钉死"安静优先"；默认只在白名单事件冒泡 |
| 小模型幻觉导致导航错 thread | MD-first + validator fail-closed + 跳转前确认卡（继承 gemma 线 harness） |
| 六 job 全要导致 scope 膨胀 | Phase 切片各自独立可验收；3+ Phase 大 feature 走 Phase 碰头制 |
| 第三方形象版权（机器猫/加菲猫/派蒙） | 内置皮肤全自家原创（家养像素猫四只 + 毛线球，KD-14）；开源用户自定义形象自担，平台只提供配置位 |
| 常驻小模型资源占用（27GB 权重 + 推理内存） | 可配置开关；无小模型自动降级（AC-D3），Phase A-C 零依赖 |
| 前台猫答错"有什么功能"损害信任 | 知识源限定 release notes/feature docs/guide catalog，带 anchor 引用，答不了就转接 |
| Notification fatigue：主动冒泡无分级 → 用户关掉/无视整只球 | OQ-4 四级白名单（Tier 0-1 默认，2 逐事件 opt-in，3 默认关）+ 同类事件聚合 + 单 session 非关键气泡 ≤1 |
| Persona over utility：可爱替代不了可用 | 每个回答必须带 anchor/action；紧凑面板禁长人设独白；状态机八态全程可见（无隐藏状态） |
| Stale badge 信任流失：过期红点变成注意力债 | badge 查看即消 / 事件解决即消，禁止常驻未读 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 前台猫 = 岗位：形象/人设/值班三层解耦，不是一只固定新猫 | operator："和现在 profile 那样解耦的可以配置"、"机器猫加菲猫…开源小伙伴自己家的猫猫" | 2026-06-09 |
| KD-2 | 值班大猫复用现有 cat runtime，不发明新 agent 物种 | operator："本质如果用 cc + claude 那不就是Ragdoll？"——新组件只有壳/身份层/clerk/escalation | 2026-06-09 |
| KD-3 | 小模型 escalation 传原始对话，不传小模型总结 | KD-8 no-classifier 家规：给数据不给结论 | 2026-06-09 |
| KD-4 | OpenCLI 操作演示收编为远期 Phase E，非 MVP | 灵魂是功能发现+前台分诊（operator收敛）；操作演示是终态锦上添花 | 2026-06-09 |
| KD-5 | 小模型 clerk 继承 gemma 线 harness 纪律（MD-first/短 handle/validator） | Maine Coon Phase 0 spike 实测：长 messageId 直抄全失效，短 handle 映射全通过 | 2026-06-09 |
| KD-6 | 名字/人设不出厂写死：per-deployment 用户配置；本家实例由家庭投票命名（出生仪式，Phase A 落地时） | operator："这个应该交给社区用户？……我们家的猫猫们大家自己来投票好了" | 2026-06-09 |
| KD-7 | 值班层 provider-agnostic：值班槽指向一只已配置的 cat profile（第三方模型如 glm5.1 走现有 provider/adapter 框架接入，不为前台猫另造模型配置体系）；本家默认Siamese（gemini35 flash） | operator："必须用户可配置吧？甚至我要是配置 glm5.1 呢？"——与 OQ-2 的"架构归一"同源：复用 cat 体系，零平行设施 | 2026-06-09 |
| KD-8 | 语音 loop 不提前：基建（入口壳/身份层/路由归一）优先，Phase C 维持原位 | operator："暂时不用，我们得先基建？架构归一那种" | 2026-06-09 |
| KD-9 | 去/取/传话三动作分叉：记忆结果 = 跳过去(teleport) + 原地看(inline 上下文)；转接 = 传话(relay+回执) + 跟去(go)——同一结果给用户选意图，不替用户猜 | operator："有的时候是想直接过去，有的时候只是想看看曾经都说了什么"、"1.传话过去 2.直接前端得跳转过去？" | 2026-06-09 |
| KD-10 | 岗位四件裁剪：身份+人设+工具面+prompt 都按岗裁剪——Phase A 工具白名单 ≈10 个（memory 三入口/get_thread_context/teleport/cross_post/guide×2/feat_index/propose_thread），排除 shell/文件/limb 等全家桶；prompt 不带 SOP/L0 全文。裁到不需要 tool-search | operator："mcp 太多了全丢给小猫调不清楚，runtime 不支持 tool search 更恐怖" + 吴浪："得控制他暴露出来的工具" | 2026-06-09 |
| KD-11 | Phase D「小模型」重定位为「快速档」：provider-agnostic（本地 gemma 或 API flash/glm 均可作 clerk），本地权重是 opt-in 优化不是前提 | 吴浪部署现实主义："考虑其他人的使用，live model 可能合适点"——不是每家有 128GB Mac | 2026-06-09 |
| KD-12 | clerk 零工具执行权：小模型只产 MD tool-intent candidate（显式 routing rules 必备），validator 负责 handle 映射/确认门/forbidden fail-closed，真实工具调用由可信 harness/值班猫执行；危险类（6399/runtime restart/truth-source write）refuse_or_escalate——不问确认，带原始文本升级 | Maine Coon tool-intent smoke（cat-cafe#2175）：裸描述 9 错 1（graph_resolve 偏向 feature anchor），加 routing rules 9/9 通过 | 2026-06-10 |
| KD-13 | 前台猫产品状态自持：current route / recent handle map / pending confirmations / go·inline·relay 选择 / relay receipts / guide state / escalation 原文——全部存 Cat Cafe app code（store/Redis），**不依赖 carrier（Pi/OpenCode）或模型 context compaction**。PR-A2 conciergeStore（pending counts 入 store 零模型依赖）已是此原则第一个落点；PR-A3+ 的 handle map / relay receipts / escalation 原文按此实现 | Maine Coon carrier spike 收束（2026-06-10）：carrier 是可换的壳，产品状态进壳就会随 carrier 丢失 | 2026-06-10 |
| KD-14 | 默认形象修正（operator 愿景对齐）：默认 = **家养像素猫桌宠**四选一【Ragdoll/Maine Coon/Bengal/Siamese】（家里桌宠像素风格、Maine Coon绘制——自家原创，"避版权"不再构成毛线球的立身理由），v1 默认**Ragdoll**（operator 拍板）。毛线球降为备选皮肤/过渡形态——Phase A 已实现的球先走通不返工，形象升级为独立工作项（A4 同期或之后；素材先行：定位家里既有像素素材，定位不到请Maine Coon按 codex 桌宠风格绘制四猫 + 八态动画映射） | operator 2026-06-10（msg 0001781148650752）："我们不是想要一只猫猫吗…最好做成我们曾经桌宠系统里Maine Coon画的…【Ragdoll，Maine Coon，Bengal，Siamese】当 default 可选…私心我喜欢可爱的Ragdoll…现拿球走通也可以" | 2026-06-10 |
| KD-16 | 值班猫身份必须 UI 可见：气泡 header 显示"{displayName} · 值班：{值班猫名}"（或等效角标）——值班层是用户该看见的状态，不是实现细节 | operator runtime 首验（2026-06-12）："这个猫猫球到底什么猫啊！"——值班身份隐藏违反调研红线 No hidden state；KD-1 三层里值班层此前 UI 不可见 | 2026-06-12 |
| KD-17 | 值班猫输出契约统一 MD-first + 短 handle：搜索工具结果（concierge 上下文）附短标记（R1/R2…），值班猫 MD 里只引用标记（`[跳过去 R1]`/`[原地看 R1]`），**服务端 validator 解析标记 → HandleMap 查真实 anchor → ID 校验 fail-closed → 注入 CardBlock actions**。废除"值班猫直接输出 actions 数组/转抄长 ID"假设——flash 档遵循性实测不可靠（验收 0/3 输出 actions；gemma 线长 ID 直抄全失效先例）。HandleMap 从 Phase D 前移（KD-13 早已点名 "recent handle map" 属产品状态）；值班猫与 Phase D clerk 输出契约就此统一，validator 复用 | sonnet Phase A 验收 P1（2026-06-12）+ gemma 线 attempt 2 实测（短 handle 9/9）+ operator"你们最会的是 md" | 2026-06-12 |
| KD-18 | PetSkinContract：参考 `hatch-pet` 的 atlas/QA/provenance 纪律，但 PetSkin 必须是 concierge 状态机的纯投影，不是平行状态机。`conciergeState` 是唯一真值源，PetSkin 只定义 `conciergeState -> petState`；缺失状态 fallback idle；pet 永远是增强信号，不是唯一状态信号；验收有三道闸：readability / identity-diff / provenance | operator 2026-06-13："要学习人家的好处比较好…但也不必换成这个…前台猫猫不止是一个好看的桌宠" + Ragdoll cowork 收敛（投影函数 + 三道闸 + v0 四态竖切） | 2026-06-13 |
| KD-19 | AC-A3 鲁棒性不依赖值班猫 marker 遵从：sonnet×gemini25 对照实测——Claude 族遵从 marker，Gemini 族（默认值班猫）不遵从（知道协议却不执行 + 倾向自跑工具无视注入上下文）。KD-17 "值班猫用 marker→validator 解析" 假设对默认 Gemini 失效，纯 prompt 强化无效。解法两层：① 修 `ConciergeEvidenceStore.search` 透传 `scope:threads/all + mode:hybrid + depth:raw`（底层 evidence store 已支持、concierge 接口收窄没透传）——召回 thread 讨论（治 P1-C 召回偏差：AC-A3 找的是讨论记录非结论文档）+ passage messageId（治 P1-A peek）；② validator 从 HandleMap **全量兜底**呈现"相关记录"可点列表（thread→teleport/peek，复用现有 action 类型），marker 降级 bonus（遵守则正文精准高亮）。docs 类型"打开文档"是不存在的新前后端 action，降 Phase B 增强（不阻塞 AC-A3）。KD-17 marker 解析保留，新增不依赖遵从的兜底层。符合 KD-7 provider-agnostic（AC-A3 不绑高遵从度模型，靠系统兜底不靠贵模型）；否决"换默认值班猫为 Claude 族"（违反 KD-7 + flash 更省） | sonnet alpha 对照实测（2026-06-13）+ Ragdoll spec owner 拍（opus-48）；operator 否决窗口开放 | 2026-06-13 |
| KD-20 | go 路径 navigation gating：**marker 优先 + triage-go fallback**。"跟去"导航由 Phase A KD-19 inline marker button（PR #2295）实现——点击直跳，read-only 不经 confirm friction。triage-go 保留为 R-handle miss fallback（用户描述目标但无可匹配 HandleMap 记录时触发 triage confirm card）。原则：**triage-only-for-write**（relay/propose_thread/investigate 产生外部影响必须 gating；navigation read-only 不需要）。KD-9 三动作分叉精神 = 用户选择权，marker 直跳 UX 最直接；triage-go 重复造轮子违反 P1 面向终态。AC-B1 "跟去（teleport 跟进）"措辞兼容两种实现 | opus-47 愿景守护 verdict（Phase B intermediate）+ sonnet alpha 实测：marker path production 已验 + triage-go 路径 duty cat 未触发（自然降级为 marker 直达） | 2026-06-15 |

## Review Gate / 分工（operator 拍板 2026-06-09 msg 0001781074572950）

| 角色 | 谁 | 说明 |
|------|----|----|
| Phase spec/plan | Ragdoll (Fable-5) | 每 Phase 写 spec + 实施计划（writing-plans） |
| 实现 | **opus 家族（46 优先 / 47 / 48）** | operator 2026-06-11 调整（msg 0001781206855531）：sonnet 单 token 便宜但 A1/A3a 的 review 轮次成本反超——总账判断改派 opus；A3b 起生效 |
| Alpha 验收执行 | sonnet | 转岗：smoke/验收操作（A1+A2 smoke 已证明他这块又快又干净），opus 猫粮不耗在点验上 |
| Review | Maine Coon (GPT-5.5) | operator 点名（全程上下文 + 调研作者）；常规/小 PR 可降 @gpt52 |
| 愿景守护 | Ragdoll (Fable-5) | PR 合入后对照operator原始愿景（非 PR 作者非 reviewer，合规） |

- Phase A 起: 每 PR 跨族 review + remote review；UX 改动过operator Design Gate
