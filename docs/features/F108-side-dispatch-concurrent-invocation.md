---
feature_ids: [F108]
related_features: [F086, F039, F048, F052]
topics: [runtime, invocation, concurrency, orchestration]
doc_kind: spec
created: 2026-03-12
---

# F108: Side-Dispatch — 同一 Thread 多猫并发执行

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1 | **Completed**: 2026-03-28

## Why

team lead作为 CVO，需要在**任何时刻**向**任何猫**派活，且**不打断**正在工作的猫。

当前架构的限制：InvocationTracker 对每个 thread 持有单一执行锁——当Ragdoll在 thread 里修 bug 时，team lead无法同时派Maine Coon在同一 thread 里做架构反思。只能开新 thread（信息孤岛）或等当前猫完成（阻塞 CVO）。

team experience（2026-03-12）：

> "赶紧开 worktree 修了他 记住只有Ragdoll去修这个问题！@opus"
> "@gpt52 你Maine Coon反思你为什么给Ragdoll过了？你回答我这个不要碰代码"

> "这样的情况我会需要一直和不同的你们交流 甚至我可能就是给Maine Coon一直发悄悄话避免影响你的修复。我会想要 1. 让你修复问题 2. 并发让Maine Coon反思为什么他做的不好 然后如何从架构上改进"

**核心诉求**：同一 feat、同一 thread，team lead并发派不同的猫干相关但不同的事——一边修 bug 一边反思，互不干扰，结果都在同一 thread 可见。

## What

### Phase A: 运行时并发基座 ✅

**核心改动**：InvocationTracker 从 per-thread 单锁改为 per-thread-per-cat 多槽。

1. **Invocation 多槽模型**：一个 thread 可以有多个并发 invocation，按 `catId` 隔离
2. **Side-Dispatch 路由**：当 thread 已有活跃 invocation 时，新消息根据 `targetCat` 路由到旁路执行，不 abort 主执行流
3. **消息可见性**：旁路执行的消息在同一 thread 可见（所有参与者看到完整对话）
4. **安全约束**：
   - 同一 catId 在同一 thread 不能有多个并发 invocation（保留原有单锁语义，只是粒度从 thread 细化到 thread+cat）
   - 文件锁/worktree 冲突检测（两只猫不能同时改同一个文件）

### Phase B: 双模发送 UX（team lead 2026-03-12 定义）

team lead发消息有两种模式：

#### 模式 A：悄悄话（Whisper） — 锁头按钮

```
交互流：
1. team lead点击输入框旁的 🔒 锁头按钮 → 进入悄悄话模式
2. 出现猫选择器（⚠️ 不能选当前正在执行的猫）
3. 选择目标猫 → 输入消息 → 发送
4. 目标猫开始旁路执行（不打断当前执行猫）
5. 当前执行猫看不到这条消息（whisper 可见性）
```

- 与 steer 的区别：**steer 会 abort 当前执行猫，锁头不会**
- 猫选择器**灰掉当前正在执行的猫**（强制不能选）
- 复用现有 `visibility='whisper' + whisperTo` 消息可见性模型

#### 模式 B：广播（默认） — 不点锁头直接发

```
交互流：
1. team lead直接在输入框打字 → 发送
2. 消息对所有猫可见（广播）
3. 当前正在执行的猫**不被打断**，下一次拉起 CLI 时收到这条广播
4. 如果消息里 @ 了特定猫，那只猫开始旁路执行
```

- 与现在的区别：现在发消息会 abort 当前执行猫；F108 后**广播不打断，只排队**
- 当前执行猫完成后自动拉起下一次执行时，才处理排队的广播

#### 共通 UX

- **Thread 执行状态指示**：显示当前 thread 有哪些猫在活跃执行（头像 + 状态）
- **Stop 按钮**：并发时每只猫独立 Stop（不再整 thread 清零）
- **输入框状态**：只有目标猫正在执行时才显示 Queue/Force；给空闲猫发消息直接发送

## Acceptance Criteria

### Phase A（运行时并发基座）✅
- [x] AC-A1: 同一 thread 中，两只不同的猫可以有并发 invocation，互不 abort
- [x] AC-A2: 旁路 invocation 的消息在 thread 中对所有参与者可见
- [x] AC-A3: 同一 catId 在同一 thread 仍保持单锁语义（不能自己和自己并发）
- [x] AC-A4: InvocationRecord 存储结构支持 per-thread 多条并发记录
- [x] AC-A5: 现有 multi_mention 等编排工具继续正常工作（向后兼容）

### Phase B（双模发送 UX）✅
- [x] AC-B1: 锁头按钮 → 猫选择器 → 悄悄话发送，不打断当前执行猫
- [x] AC-B2: 猫选择器灰掉当前正在执行的猫（强制不能选）
- [x] AC-B3: 广播消息（不点锁头）不打断当前执行猫，排队到下次拉起
- [x] AC-B4: 广播消息中 @ 特定猫，该猫开始旁路执行
- [x] AC-B5: Thread 执行状态指示（头像 + 活跃状态）
- [x] AC-B6: Stop 按钮精确到每只猫（不再整 thread 清零）
- [x] AC-B7: 输入框状态：给空闲猫发消息直接发送，不显示 Queue/Force

## Dependencies

- **Evolved from**: F086（多猫并行编排——F086 解决了猫发起的并行，F108 解决team lead发起的并行）
- **Related**: F039（消息排队——需要适配多槽模型）
- **Related**: F048（Restart Recovery——InvocationRecord 结构变更需要迁移）
- **Related**: F052（跨线程身份隔离——同 thread 多 cat 的身份隔离复用）

## Risk

| 风险 | 缓解 |
|------|------|
| InvocationTracker 改动影响所有消息处理链路 | Phase A 仅改锁粒度，不改接口；充分的集成测试 |
| 两只猫并发改同一个文件造成冲突 | worktree 隔离 + 文件锁检测（Phase A 约束 4） |
| 消息顺序混乱（两只猫交叉回复） | 消息带 invocationId 标记，前端按 cat 分组或按时间排列 |
| 向后兼容——现有 multi_mention / steer 行为变化 | Phase A AC-A5 强制向后兼容测试 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 锁粒度从 per-thread 改为 per-thread-per-cat（不是完全无锁） | 保留同一猫的串行语义，避免自己和自己竞争 | 2026-03-12 |

## UX Fidelity Gap（功能闭环 vs UX 闭环）

> **功能闭环**：Phase A+B 运行时能力全部交付（AC-A1~A5, AC-B1~B7 ✅）。
> **UX 闭环**：前端实现与设计稿 `F108-side-dispatch-phase-b-ux.pen` 逐 Scene 对齐。

### Scene-by-Scene 对照

| Scene | 设计稿内容 | 实现状态 | Gap |
|-------|-----------|---------|-----|
| Scene 1: Whisper Mode | 锁头 toggle → 猫选择 chips，默认不选 | ✅ ALIGNED | PR #837 修复默认选中问题 |
| Scene 2: Cat Selector | **下拉列表**：头像 + 全名 + radio + 状态徽章 | ✅ ALIGNED | PR #846 v2: @ mention 风格浮动弹窗（头像 + formatCatName 唯一标识 + 职责 + 执行中徽章） |
| Scene 3: Execution Bar | "执行中" + 猫色点 + 名称 + 计时 | ✅ ALIGNED | PR #837 修复 hydration |
| Scene 4: Per-Cat Stop | × 按钮 + "全部停止" | ✅ ALIGNED | — |
| Scene 5A: Idle Input | 橙色发送按钮 | ✅ ALIGNED | — |
| Scene 5B: Busy Input | 紫色排队按钮 | ✅ ALIGNED | — |
| Scene 5C: Force Send | 黄色 "⚡ 强制" 标签按钮 | ⚠️ MINOR | 实现为小红色闪电图标，无黄色背景无文字标签 |

### 待决策

- ~~Scene 2 下拉选择器~~：✅ 已实现（PR #842）
- ~~Scene 5C 强制按钮~~：team lead已接受现状（"小闪电可以用 原本的 这个无所谓 原本也挺好"）

## Review Gate

- Phase A: 跨家族 review（架构级改动），Maine Coon review 运行时安全性

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "让你修复问题，并发让Maine Coon反思" — 同一 thread 同时派两只猫干不同的事 | AC-A1 | integration test: 两猫并发 invocation 互不 abort | [x] |
| R2 | "给Maine Coon一直发悄悄话避免影响你的修复" — 锁头 → 选猫 → 悄悄话 | AC-B1, AC-B2 | test: 锁头模式发消息不打断当前猫 + 不能选执行中的猫 | [x] |
| R3 | 相关但不同的任务在同一 feat/thread 里，结果都可见 | AC-A2 | test: 旁路消息在 thread 中可见 | [x] |
| R4 | 涉及 A2A 并发调整，安全性需要强评估 | AC-A5 | 向后兼容测试 + Maine Coon安全 review | [x] |
| R5 | 不点锁头直接发 = 广播，不打断执行猫，下次拉起时收到 | AC-B3, AC-B4 | test: 广播排队 + @ 路由旁路执行 | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（Phase B 适用）

## team lead用例示例

```
场景 1：悄悄话模式（锁头）
  Ragdoll正在修 bug...
  team lead → 点 🔒 锁头 → 猫选择器出现（Ragdoll灰掉不能选）
  team lead → 选Maine Coon → "你反思一下为什么 review 放过了"
  ✅ Maine Coon开始旁路执行（反思）
  ✅ Ragdoll不被打断，也看不到这条消息
  ✅ team lead可以继续用锁头和Maine Coon对话

场景 2：广播模式（不点锁头）
  Ragdoll正在修 bug...
  team lead → 直接输入 "大家注意，这个 API 的 breaking change 影响范围可能更大"
  ✅ Ragdoll不被打断，下次拉起 CLI 时收到这条广播
  ✅ 如果消息里写了 @gpt52，Maine Coon立即开始旁路执行

场景 3：给空闲猫发消息
  没有猫在执行...
  team lead → 直接发消息（不需要锁头）→ 按正常流程路由
  ✅ 和现在行为一样，向后兼容
```
