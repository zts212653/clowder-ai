---
feature_ids: [F160]
related_features: [F100, F093, F101, F129]
topics: [gamification, engagement, identity]
doc_kind: spec
created: 2026-04-10
---

# F160: Cat Journey (猫猫足迹) — Activity Footprint Visualization

> **Status**: Phase A-C complete, Phase D 6/7, Phase E 3/7 | **Owner**: Ragdoll | **Priority**: P1
>
> **Naming pivot (ADR-023):** Renamed from "Cat Growth RPG". XP→足迹点,
> Level→历练, Achievement→珍贵瞬间, Radar→特质画像. See ADR-023 for rationale.

## Why

Clowder AI 的猫猫已经有持久身份、记忆和协作记录，但这些协作足迹对用户是不可见的。用户无法感知自己的猫团队在积累、在协作、在留下印记。

Cat Journey 系统把猫猫的真实协作数据"结晶"成可见、可感、可分享的足迹轨迹。这不是模拟数据，而是从真实 session events、task tracking、PR review 中自动结算的量化投影。

**重要区分**：Cat Journey 是活动投影/观测层（温度计），不是能力涌现层（体温）。
真正的 Agent 成长（知识涌现、记忆沉淀）属于 F102/F152 的职责。

核心价值：
- **留存**：用户舍不得丢弃有丰富足迹的猫团队
- **传播**：可分享的足迹卡和珍贵瞬间天然驱动社交传播
- **差异化**：没有任何 AI 平台把 agent 协作足迹做成可见的存档

## What

### Phase A: Attribute System + Cat Profile Card

**六维属性体系**：

| 维度 | 数据源 | Phase A 状态 | 说明 |
|------|--------|-------------|------|
| 架构力 | 讨论消息 (discussion) | ✅ 活跃 | 设计与系统思考 |
| 审查力 | Review 拦截率、bug 发现数 | ⏳ Phase B | 需 invocation intent tracking |
| 审美力 | Rich block 创建 (rich_block_create) | ✅ 活跃 | 视觉与体验 |
| 执行力 | tool_use / task_complete / session_seal | ✅ 活跃 | 落地交付 |
| 协作力 | 跨猫 @mention 协作 (mention_collab) | ✅ 活跃 | 团队配合 |
| 洞察力 | evidence search / reflect (evidence_cite) | ✅ 活跃 | 自驱与发现 |

> **Phase A scope note**: 审查力 (review) 维度在 Phase A 中定义但未激活。
> 根因：当前 A2A / multi-mention 系统的 `InvocationRecord` 不携带 invocation intent
> 元数据，无法在 route 层面区分「猫做 review」和「猫做 discussion」。
> `review_given` / `bug_caught` XP 源已在 GrowthService 中定义，待 Phase B
> 添加 invocation intent tracking 后激活。

**经验值结算引擎**：
- 每个 task / 讨论闭环 / 工具调用后自动结算
- 数据源：session events、task 状态变更、rich block 创建、evidence 检索
- 经验值公式透明可审计

**猫猫名片（Profile Card）**：
- 头像 + 等级 + 六维雷达图
- 当前称号
- 高光时刻 Top 3（链接到真实 session）
- 可导出为图片用于社交分享

**Hub UI**：
- 猫猫详情页增加"成长"Tab
- 团队总览页（冒险者公会风格）

### Phase B: Skill Tree + Title System

**技能树**：
- 属性达到特定等级解锁称号
- 审查力 Lv.5 -> "Eagle Eye"
- 架构力 Lv.4 + 协作力 Lv.3 -> "Chief Architect"
- 洞察力 Lv.4 + 连续拦截 3 次未遂事故 -> "Prophet"

**羁绊系统**：
- 两只猫频繁协作产生"羁绊值"
- 羁绊等级可见，高等级解锁组合名称
- 展示在各自名片和团队总览中

### Phase C: Achievement System + Co-Creator Growth

**铲屎官成长档案**：
- 铲屎官也是团队成员，协作行为应可见于成长系统
- XP 来源映射：发消息→collaboration、拍板方向→architecture、触发 review→review、纠偏反馈→insight
- 在成长总览页与猫猫并列展示，共用六维体系和称号路径
- 实现要点：callback 触发点追加 `awardXp('co-creator', source)`，`getProfile` 对 co-creator 走独立配置路径

**成就分类**：

1. **个猫成就**（绑定单只猫）
   - 普通：初啼（首次完成任务）、百炼（100 任务）
   - 稀有：守门员（拦下首个 P0）
   - 史诗：打脸王（否决自己的方案）、日不落（单日 10+ 任务）
   - 传说：预言家（指出的风险 7 天内发生）、涅槃（错误后改进被采纳）

2. **团队成就**（绑定猫猫组合）
   - 普通：初次握手（首次协作）
   - 稀有：诤友（5+ 次建设性分歧）、全员集合
   - 史诗：心有灵犀（独立给出相同方案）、众猫拾柴（3+ 猫接力完成 feature）

3. **里程碑成就**（绑定猫咖实例）
   - 普通：开业大吉（首个完整 feature 生命周期）
   - 稀有：百日维新（持续运行 100 天）
   - 史诗：千锤百炼（1000 次 review 交互）
   - 传说：无人之境（无人干预完成 feature 全流程）、事故归零（30 天零 P0 回退）

4. **隐藏成就**（不提前显示，触发时惊喜弹出）
   - 夜猫子（凌晨 2-5 点完成关键任务）
   - 时间旅行者（引用 3 月前讨论佐证决策）
   - 破壁人（首次外部社区贡献者参与协作）
   - 凌晨三点半（猫猫在铲屎官离线时自主完成协作）

**展示**：
- 解锁弹窗动画 + 音效
- 成就墙：已解锁发光 / 未解锁灰色剪影 + 模糊提示
- 成就卡片可导出分享
- 解锁事件可推送到飞书/Telegram

**联动效果**：
- 部分成就解锁 Hub 中的视觉标记
- 传说成就解锁 README badge

### Phase D: Co-Creator Leadership Growth — 铲屎官独立成长系统

> 设计讨论结论来自 opus + gpt52 联合评审（2026-04-14）

**核心理念**：猫猫六维衡量 AI 执行能力，铲屎官六维衡量「人与 AI 的协作领导力」。

**铲屎官专属六维**：

| 维度 | 说明 | 数据来源 |
|---|---|---|
| 决策力 | 拍板方向的速度和质量 | 方向确认频率、执行成功率（v1 shadow score，需补 `decision_confirmed` 事件） |
| 引导力 | 给猫猫的指令清晰度 | 一次完成率、追问轮数（v1 proxy，需补 `clarification_requested` 事件） |
| 授权力 | 放手让猫猫自主完成 | 无干预 task 完成比、deep_collab 触发数 |
| 反馈力 | 纠偏和正向反馈质量 | 纠偏后改进采纳率（v1 shadow score，需补 `feedback_applied` 事件） |
| 协调力 | 知猫善任，多猫调度 | multi-mention 频率 + 成功率 + targetCats 广度 + bond 覆盖面 |
| 开拓力 | 推动边界的有效探索 | F150 工具类别广度 + 新 skill 首次使用 + feature 发起数 |

**落地策略**：
- v1 先做 4 维实分（协调力 / 授权力 / 开拓力 / 引导力-proxy），决策力 / 反馈力 做 shadow score
- 等补齐 `decision_confirmed / clarification_requested / feedback_applied` 事件后转正

**等级体系**：独立于猫猫
- 猫猫 = Operator Level，铲屎官 = Leadership Level
- 复用 `sqrt(xp/N)` 骨架但阈值更大（事件少杠杆大）
- 独立称号路径：初心铲屎官 → 团队指挥官 → 猫猫军师

**前端**：Mission Control 面板（非 RPG 角色卡）
- 顶部：Leadership Level + 称号 + 趋势
- 中部：六维雷达图（暖色系）+ 4 个 KPI（一次完成率 / 授权完成率 / 调度成功率 / 工具广度）
- 底部：「领导时刻」时间线
- 关系区：「最佳搭档」（非"羁绊"）

### Phase E: Evolution Events + Growth Timeline + Observability Integration

**进化事件**：
- 关键里程碑触发叙事事件（如"守护时刻"、"独立日"）
- 事件记录进猫猫成长史，可回溯浏览

**成长时间线**：
- 可视化的猫猫成长轨迹
- 支持按时间段查看属性变化趋势
- 猫猫考古：定期自动生成"自我回顾报告"

**可观测数据 → Growth 接入**：
- Token 效率：F128 UsageAggregator 已有 cacheReadTokens 数据，按 session 结算 insight XP
- 意图区分：InvocationRecord.intent 已区分 execute/ideate，ideate 应给更多 architecture XP
- 错误恢复：跨 invocation 追踪 failed → succeeded，奖励韧性 execution XP
- 调用性能：F153 OTel 落地后，invocation.duration 可驱动 fast_execution 奖励

## Acceptance Criteria

### Phase A (Attribute System + Profile Card) ✅
- [x] AC-A1: 五维属性自动结算（审查力降级至 Phase B，需 invocation intent tracking）
- [x] AC-A2: 每只猫的 Hub 详情页展示六维雷达图和等级
- [x] AC-A3: 猫猫名片可导出为 PNG 图片
- [x] AC-A4: 团队总览页展示所有猫的站位图和属性概览
- [x] AC-A5: 经验值结算逻辑透明、可审计（可查看结算明细）

### Phase B (Skill Tree + Title System + Review Activation) ✅
- [x] AC-B0: 审查力维度激活 — invocation intent tracking 落地，`review_given` / `bug_caught` 有真实调用方
- [x] AC-B1: 属性达标自动解锁称号，显示在名片和 Hub 中
- [x] AC-B2: 羁绊值从协作记录自动计算，展示在双方名片中
- [x] AC-B3: 技能树页面展示已解锁/未解锁的称号路径

### Phase C (Achievement System + Co-Creator Growth) ✅
- [x] AC-C1: 四类成就（个猫/团队/里程碑/隐藏）覆盖至少 20 个成就
- [x] AC-C2: 成就从真实数据自动触发，绑定触发 session 链接
- [x] AC-C3: 成就墙 UI 展示已解锁/未解锁状态
- [x] AC-C4: 成就卡片可导出为图片
- [x] AC-C5: 解锁事件支持 WebSocket 广播（`achievement_unlocked` 事件）
- [x] AC-C6: 铲屎官（Co-Creator）成长档案 — 从协作行为自动结算 XP，在成长总览中与猫猫并列展示
- [x] AC-C7: 工具调用 XP 分级 — native→execution(+1), mcp→insight(+3), skill→aesthetics(+3)
- [x] AC-C8: 深度协作奖励 — 3+ 猫参与 multi-mention 时所有成功响应者 + 铲屎官获 deep_collab XP(+20)

### Phase D (Co-Creator Leadership Growth) ✅ (6/7, D7 awaiting calibration)
- [x] AC-D1: 铲屎官专属六维类型定义（LeadershipDimension）+ 独立 XP 存储
- [x] AC-D2: v1 四维实分引擎 — 协调力 / 授权力 / 开拓力 / 引导力(proxy)
- [x] AC-D3: 决策力 + 反馈力 shadow score（记录但不展示，待数据校准）
- [x] AC-D4: Leadership Level 独立等级体系 + 铲屎官称号路径
- [x] AC-D5: Mission Control 前端面板 — KPI 仪表盘 + 领导时刻时间线
- [x] AC-D6: 补齐事件采集 — `decision_confirmed` / `clarification_requested` / `feedback_applied`
- [ ] AC-D7: v2 六维转正 — shadow score 校准后升级为正式维度（⏳ 等 2-3 周自然使用积累校准数据）

### Phase E (Evolution Events + Growth Timeline + Observability Integration) (3/7, E4-E7 awaiting upstream)
- [x] AC-E1: 关键里程碑触发叙事事件并记录
- [x] AC-E2: 成长时间线可视化展示
- [x] AC-E3: 猫猫自我回顾报告自动生成（月度）
- [ ] AC-E4: Token 效率奖励 — session 结算时按 cacheReadTokens/inputTokens 比率奖励 insight XP（🔌 投影器就绪，等 F128 UsageAggregator 上游数据）
- [ ] AC-E5: 调用意图区分 — ideate 意图 discussion 提升至 architecture +25（🔌 投影器就绪，等 InvocationRecord.intent 填充）
- [ ] AC-E6: 错误恢复韧性 — invocation failed → 同 thread 后续 succeeded 时奖励 execution XP（🔌 投影器就绪，等 recoveredFromFailure 元数据）
- [ ] AC-E7: 调用延迟表现 — invocation duration < P50 时额外 execution XP（🔌 投影器就绪，等 F153 OTel metrics 落地）

## Dependencies

- **Related**: F100（Self-Evolution — 进化行为层提供洞察力数据源）
- **Related**: F093（Cats & U 世界引擎 — 共创世界中的角色成长可复用本系统）
- **Related**: F101（Mode v2 游戏引擎 — 游戏活动可作为经验值来源）
- **Related**: F129（Pack System — Pack 可扩展自定义成就和称号）

## Risk

| Risk | Mitigation |
|------|-----------|
| 经验值公式偏差导致属性不反映真实能力 | Phase A 先用简单线性公式 + 人工校准，迭代调整 |
| 成就触发条件过于依赖数据完整性 | 只使用已有稳定数据源，不为成就新增数据采集 |
| 游戏化元素干扰严肃工作流 | 成长系统只展示不干预，不改变任何工作流行为 |

## Open Questions

| # | Question | Status |
|---|----------|--------|
| OQ-1 | 经验值是否跨 session 持久化到 Redis 还是独立 SQLite? | **resolved** — Redis INCRBY + sorted set audit trail |
| OQ-2 | 多实例场景下成就是否全球排名? | open |
| OQ-3 | 猫猫名片的视觉风格——像素风 vs 手绘风 vs 扁平风? | open |

## Key Decisions

| # | Decision | Rationale | Date |
|---|----------|-----------|------|
| KD-1 | 数据全部从已有系统自动结算，不新增人工打标环节 | 降低使用摩擦，保证数据真实性 | 2026-04-10 |
| KD-2 | 成长系统只展示不干预工作流 | 避免游戏化污染严肃协作 | 2026-04-10 |
| KD-3 | Phase A 最小切片：属性 + 名片，先证明价值再扩展 | P1 先做终态基座，不做脚手架 | 2026-04-10 |
| KD-4 | 铲屎官六维独立于猫猫六维，不复用 TraitDimension | 衡量对象不同（领导力 vs 执行力），混在一起无意义 | 2026-04-14 |
| KD-5 | 决策力/反馈力 v1 做 shadow score，proxy 共存待 D7 校准 | 显式信号覆盖面窄，需积累数据验证 proxy 精度后再转正 | 2026-04-14 |
| KD-6 | E4-E7 投影器先行实现，数据源就位即激活 | 避免上游就绪后还要改 F160 代码 | 2026-04-15 |
| KD-7 | MemoryProjector 用语义 anchor + 模板 summary，规则硬编码不配置化 | upsert 幂等性需语义 key；推送规则是产品决策应版本化；同步 handler 不引 LLM | 2026-04-17 |

## Timeline

| Date | Event |
|------|-------|
| 2026-04-10 | Kickoff: brainstorm + spec |
| 2026-04-12 | Phase A-C complete: attribute system, titles, bonds, achievements, co-creator growth |
| 2026-04-14 | Phase D design: opus + gpt52 joint review of leadership dimensions |
| 2026-04-15 | Phase D1-D5 complete + Phase E1-E3 complete |
| 2026-04-16 | Phase D6 complete: leadership event detection (clarification/decision/feedback) |
| 2026-04-17 | MemoryProjector implemented: F160→F102 high-value event promotion bridge |

## Review Gate

- Phase A: @codex review attribute calculation logic + Hub UI
- Phase C: @gemini25 review achievement UX + visual design

## Links

| Type | Path | Description |
|------|------|-------------|
| **Feature** | `docs/features/F100-self-evolution.md` | Self-Evolution, data source for insight attribute |
| **Feature** | `docs/features/F093-cats-and-u-world-engine.md` | Cats & U, character growth synergy |
| **Feature** | `docs/features/F101-mode-v2-game-engine.md` | Game engine, XP source from game activities |
