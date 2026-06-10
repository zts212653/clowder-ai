---
feature_ids: [F229]
related_features: [F155, F020, F092, F111, F128, F226, F227, F102, F099]
topics: [concierge, desktop-pet, routing, small-model, voice, memory, ux, community]
doc_kind: spec
created: 2026-06-09
community_issue: "clowder-ai#841"
---

# F229: 猫猫球 — 前台猫常驻入口（Cat Ball Concierge）

> **Status**: spec | **Owner**: Ragdoll (Fable-5) | **Priority**: P1
>
> **立项 signoff**：team lead 2026-06-09（msg 0001781064063516-000541）："我判定是新立项 你可以把我想要的想想看 写好team lead的愿景 然后立项吧？新的 feat"

## Why

Cat Café 三个多月迭代 200+ feature，"一句话的事"和"一个 feature 的事"走的是同一条重链路（开 thread → @ 猫 → 等回复）。team experience拼出的六个痛点：

1. **功能发现**："Cat Café 更新太快，功能太多，用户不知道有什么功能"
2. **求助**："使用猫咖遇到的困难可能也会找猫猫球"
3. **金鱼的记忆**："诶 我们之前讨论的xxx到底在哪里来着？"——team lead是全家唯一没有 recall 工具的成员：猫有记忆三入口 + teleport，用户只能手翻 thread 列表
4. **分诊/调查**："这个猫猫球可能帮忙发送到哪个 thread 或者自己调查"
5. **语音**："甚至得支持语音输入输出"
6. **陪伴**：桌宠形态、"类似原神的派蒙"——常驻、有生命感的家庭向导

**一句话愿景**：猫猫球 = 家里的前台猫。Thread 是工作间，猫猫球是前台——你不知道找谁、不想走进工作间、只想喊一嗓子的时候，找它。它把"从想法到触达"的距离缩短到一句话，并把猫吃了半年红利的记忆系统第一次开放给team lead本人。

社区输入：clowder-ai#841（arthas4ever）独立提出了同坐标系的"悬浮球 Interactive Assistant"——入口形态一致，但其方案重心（OpenCLI 页面操作演示）被重定为远期 Phase；真正的灵魂是功能发现 + 前台分诊（team lead 2026-06-09 收敛）。

## Current State / 现状基线

- **记忆入口不对称（实测）**：live runtime 1076 个 thread 仅 162 个有 threadMemory（15%，Maine Coon 2026-06-09 只读实测）；猫侧有 `search_evidence`/`graph_resolve`/`list_recent` + teleport，**用户侧零入口**——"金鱼的记忆"是系统欠的，不是team lead记性差
- **功能发现断层**：F155 guide engine done（9 个 YAML 场景 + `cat_cafe_get_available_guides`），但设计上是猫按上下文触发，**无用户常驻入口**；release notes / feature docs 无对话式查询面
- **语音积木齐但没串成 loop**：F020 STT done（输入框 + F20c 全局热键）、F092 VoiceSession done、F111 流式 TTS done——无"按住说话→答→自动播"的对话式闭环
- **常驻 surface 容器有借力点**：F226 AppShell 级 surface host（Phase A done）
- **社区需求悬置**：#841 标 `needs-maintainer-decision` 等方向，原标签 `feature:F155` 已不准确（F155 closed）

## What

### 核心概念（team lead 2026-06-09 拍板方向）

**1. 前台猫 = 岗位，不是一只新猫。** 三层解耦（"和现在 profile 那样解耦的可以配置"）：

```
形象层：默认原创毛线球桌宠，可换皮肤（机器猫/加菲猫式/派蒙式/开源用户自家猫）
人设层：前台猫自己的名字与性格（用户感知的"这是谁"）
值班层：背后真正干活的模型，按任务分层路由（可配置）
```

**2. 复合猫路由**（team lead："小模型发现自己干不了 → 喊大喵"）：

```
用户一句话
  ├─ 导航/跳转/打开/快捷操作 → 本地小模型（gemma clerk，秒级）
  ├─ 干不了 → escalate 值班大猫（优先快+便宜：flash / sonnet / spark 级，可配置）
  └─ 深度工作 → 透明转接对应 thread 的猫（"这个我去喊Ragdoll"）
```

**3. 值班大猫复用现有 cat runtime**（team lead洞察："本质如果用 cc + claude 那不就是Ragdoll？"）——前台猫不发明新 agent 物种，值班层就是现有猫体系按岗排班；新组件只有：常驻入口壳、身份配置层、小模型 clerk、escalation 协议。

**4. Harness 纪律预定**（继承 gemma 线收敛 + 家规）：小模型 MD-first 不写 JSON；anchor 用短 handle 由 wrapper 映射回真实 ID；validator fail-closed；escalation **传原始对话不传小模型总结**（KD-8 no-classifier）。

### Phase 0: Research + Design Gate

- 形态 research：派蒙/桌宠交互范式/Clippy 反面教训（打扰式主动的失败史）；身份三层配置模型设计
- 架构归属一问（ownership cell：新 surface + 路由层归属，预判 new cell required）
- UX wireframe（悬浮球态/展开态/桌宠动效层级）→ team lead确认
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

### Phase C: 语音 loop（长出嘴和耳朵）

- F020 STT + F111 流式 TTS 串成对话式闭环：按住说话 → 前台猫答 → 自动播
- 复用 F092 VoiceSession 的"设备会话与 UI thread 解耦"模型

### Phase D: 小模型入驻（复合猫生效）

- gemma clerk 接管导航/跳转/快捷操作类 intent（借力 F102 provider 抽象：local-small-model / cloud-strong-model / manual-cat）
- escalation 协议落地（传原始对话；值班大猫优先级可配置）
- 无小模型环境自动降级全走大猫（Phase A-C 不依赖本 Phase）

### Phase E: 桌宠化 + 形象生态 + 操作演示（远期）

- 桌宠动效系统（呼吸/打盹/状态表情）+ 皮肤生态（开源用户自家猫形象）
- 主动冒泡（新版本发布等白名单事件，安静优先）
- OpenCLI 式页面操作演示（#841 终态收编：猫操作页面给用户看，操作前用户确认）

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "更新太快…不知道有什么功能" | AC-A2 | manual 问答验收 | [ ] |
| R2 | "使用猫咖遇到的困难也会找猫猫球" | AC-A4 | manual + guide 触发录屏 | [ ] |
| R3 | "之前讨论的xxx到底在哪里来着？"（金鱼的记忆） | AC-A3 | manual 3 query 验收 | [ ] |
| R4 | "帮忙发送到哪个 thread 或者自己调查" | AC-B1, AC-B2 | 留痕 + 报告抽查 | [ ] |
| R5 | "和 profile 那样解耦的可以配置"（形象/人设/值班） | AC-A5 | screenshot | [ ] |
| R6 | "支持语音输入输出" | AC-C1 | 录屏 + 延迟实测 | [ ] |
| R7 | "小模型发现自己干不了→喊大喵（优先 flash/sonnet/spark）" | AC-D1, AC-D2 | 延迟数字 + 代码断言 | [ ] |
| R8 | 桌宠/派蒙式常驻陪伴 | Phase E（AC 启动时补） | 录屏 | [ ] |
| R9 | #841 悬浮入口 + 页面上下文（社区） | AC-A1 | 截图/录屏 | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC（R8 远期 Phase 启动时补编号）
- [x] 每个 AC 都有验证方式
- [ ] 前端需求→证据映射表（Phase A quality-gate 时产出）

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC 必须 ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。 -->

### Phase 0（Research + Design Gate）
- [ ] AC-02: Design Gate 通过——wireframe team lead OK + 架构归属一问有答案 + 元审美自检（坐标变换 not 堆层）

### Phase A（前台开张）
- [ ] AC-A1: 任意页面悬浮球唤起对话，不离开当前页面（截图 + 15s 录屏）→ R9/Why-2
- [ ] AC-A2: 功能发现——非作者拿 3 个"最近有什么新功能/X 怎么用"问题验收，答案与 release notes/feature docs 一致 → R1/Why-1
- [ ] AC-A3: 记忆导航——3 个真实历史讨论 query 给出正确 thread/message 链接且一键跳转成功 → R3/Why-3
- [ ] AC-A4: 求助场景能触发对应 F155 guide flow（录屏一条）→ R2/Why-2
- [ ] AC-A5: 形象/人设/值班猫在设置页可配置，与 cat profile 解耦（截图）→ R5
- [ ] AC-A6: 安静默认——默认零主动文本弹出；低优先级事件只显示 badge（hover 才出文字）；用户可一键 hide/mute 整个球（录屏 + 设置截图）→ R8/调研红线

### Phase B（总机能力）
- [ ] AC-B1: 用户描述问题 → 前台猫给出分诊建议并经确认执行（cross_post/propose_thread 留痕可查）→ R4
- [ ] AC-B2: "自己调查"产出带 anchor 的报告回对话框（抽查 anchor 真实性）→ R4

### Phase C（语音 loop）
- [ ] AC-C1: 按住说话 → STT → 回答 → TTS 自动播全链路可用，端到端延迟实测记录（数字进 doc）→ R6

### Phase D（小模型入驻）
- [ ] AC-D1: 导航/跳转类 query 由本地小模型应答，p50 延迟实测显著低于大猫链路（两组数字对比）→ R7
- [ ] AC-D2: escalation 传原始对话不传小模型总结（测试断言，KD-8 合规）→ R7
- [ ] AC-D3: 小模型不可用时自动降级全走值班大猫（测试）→ R7

### Phase E（远期，启动时补 AC）

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
| 第三方形象版权（机器猫/加菲猫/派蒙） | 内置皮肤全原创（毛线球）；开源用户自定义形象自担，平台只提供配置位 |
| 常驻小模型资源占用（27GB 权重 + 推理内存） | 可配置开关；无小模型自动降级（AC-D3），Phase A-C 零依赖 |
| 前台猫答错"有什么功能"损害信任 | 知识源限定 release notes/feature docs/guide catalog，带 anchor 引用，答不了就转接 |
| Notification fatigue：主动冒泡无分级 → 用户关掉/无视整只球 | OQ-4 四级白名单（Tier 0-1 默认，2 逐事件 opt-in，3 默认关）+ 同类事件聚合 + 单 session 非关键气泡 ≤1 |
| Persona over utility：可爱替代不了可用 | 每个回答必须带 anchor/action；紧凑面板禁长人设独白；状态机八态全程可见（无隐藏状态） |
| Stale badge 信任流失：过期红点变成注意力债 | badge 查看即消 / 事件解决即消，禁止常驻未读 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 前台猫 = 岗位：形象/人设/值班三层解耦，不是一只固定新猫 | team lead："和现在 profile 那样解耦的可以配置"、"机器猫加菲猫…开源小伙伴自己家的猫猫" | 2026-06-09 |
| KD-2 | 值班大猫复用现有 cat runtime，不发明新 agent 物种 | team lead："本质如果用 cc + claude 那不就是Ragdoll？"——新组件只有壳/身份层/clerk/escalation | 2026-06-09 |
| KD-3 | 小模型 escalation 传原始对话，不传小模型总结 | KD-8 no-classifier 家规：给数据不给结论 | 2026-06-09 |
| KD-4 | OpenCLI 操作演示收编为远期 Phase E，非 MVP | 灵魂是功能发现+前台分诊（team lead收敛）；操作演示是终态锦上添花 | 2026-06-09 |
| KD-5 | 小模型 clerk 继承 gemma 线 harness 纪律（MD-first/短 handle/validator） | Maine Coon Phase 0 spike 实测：长 messageId 直抄全失效，短 handle 映射全通过 | 2026-06-09 |
| KD-6 | 名字/人设不出厂写死：per-deployment 用户配置；本家实例由家庭投票命名（出生仪式，Phase A 落地时） | team lead："这个应该交给社区用户？……我们家的猫猫们大家自己来投票好了" | 2026-06-09 |
| KD-7 | 值班层 provider-agnostic：值班槽指向一只已配置的 cat profile（第三方模型如 glm5.1 走现有 provider/adapter 框架接入，不为前台猫另造模型配置体系）；本家默认Siamese（gemini35 flash） | team lead："必须用户可配置吧？甚至我要是配置 glm5.1 呢？"——与 OQ-2 的"架构归一"同源：复用 cat 体系，零平行设施 | 2026-06-09 |
| KD-8 | 语音 loop 不提前：基建（入口壳/身份层/路由归一）优先，Phase C 维持原位 | team lead："暂时不用，我们得先基建？架构归一那种" | 2026-06-09 |

## Review Gate

- Phase 0: research 报告跨猫 review（reviewer 优先 @gpt52/@sonnet，成本路由）
- Phase A 起: 每 PR 跨族 review + 云端 review，UX 改动过team lead Design Gate
