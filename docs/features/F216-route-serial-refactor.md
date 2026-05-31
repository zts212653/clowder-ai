---
feature_ids: [F216]
topics: [architecture, refactor, routing]
doc_kind: spec
created: 2026-05-30
---

# F216: routeSerial 决策层/执行层分离重构

> **Status**: spec | **Owner**: 设计 @opus48 (F215 thread) / 执行待 fresh-thread opus-48 | **Priority**: P1 | **Source**: internal (F215 引爆点)

Architecture cell: `routing`
Map delta: routeSerial 从 2302 行单函数拆为决策层(纯函数) + 执行层(for-await yield)

## Why

routeSerial 是 Cat Cafe 的核心路由引擎——所有 A2A 串行调度、mention 路由、callback、F215 relay 都经过这个函数。当前状态：

- **2302 行单函数**，cognitive complexity 255（biome noExcessiveCognitiveComplexity 报 warning 但被豁免）
- **5 套并行路由路径**（inline mention / deferred mention / callback A2A / F215 malformed relay / executed-relay dedup）共享同一个可变 `worklist`
- **15+ 可变状态变量**（`attemptHasContentOutput`、`suppressedMalformedError`、`shouldRetryWithoutSession` 等）在同一个作用域互相影响
- 加任何路由决策都笛卡尔积式炸 edge case——F215 relay 是引爆点（r5→r6→r7 补丁引补丁，7 轮 review）

**不重构的代价**：后续每个路由相关 feature 都会重演 F215 的 7 轮 review 循环。脆弱度已 6/10。

## What

### Phase A: 执行单元化（降脆弱度）

把 routeSerial 的 for-await 循环中的每个路由决策（mention / relay / deferred / callback）抽成独立函数，各自返回"worklist 扩展清单"而非直接 mutate worklist。

**Before**: 5 处 `worklist.push(...)` 散落在 for-await 循环的不同分支里
**After**: `resolveNextCats(signal, context) → CatId[]`，for-await 循环只负责 `worklist.push(...resolved)`

### Phase B: 决策/执行分离

将路由决策逻辑提取为**纯函数**（输入：当前 signal + context + config → 输出：routing decision），可独立单测。执行层（for-await invokeSingleCat + yield）保持不变。

### Phase C: 状态机化（如需）

如果 Phase B 后状态变量仍然耦合过深，考虑显式状态机（state enum + transition table）。这是 Phase C 是否需要做的判断依据——Phase B 后如果够了就不做。

## 硬约束（F215 踩坑知识，必须遵守）

1. **F215 relay 行为零回归**——有 16 测试 + 真实 runtime 守护过的兜底链（seal→fresh→46 接力 + partial-output 诚实文案），重构不能破任何一个
2. **坐标变换不是堆补丁**——这正是 F215 栽进雷区处（r5→r6→r7 都是局部补丁，最后 sonnet 开干了 route-serial 的真接力才解决）；routeSerial 重构必须做到"一次改对坐标系"
3. **真实 runtime 验证（LL-064）**——routeSerial 比 F215 更核心，merge 前必须真 runtime + 真截图 + 刻意触发多路由场景，绝不只信单测
4. **跨族 review 强制**——5 套路由耦合最易出 edge case，必须Maine Coon族 review

## Context 卫生安排（CVO directive）

- **立项**：当前 F215 thread 的 opus-48（亲历踩坑知识最全 → spec 最准）
- **执行**：fresh thread 的 opus-48（context 干净不被 F215 污染，改 routeSerial 时心智清晰）
- **双向防污染**：F215 回归时不被 routeSerial 重构 context 干扰，反之亦然

## Risk

- **高风险**：改比 F215 更核心的路由路径
- **缓解**：Phase A 先降脆弱度（不改行为），Phase B 再分离（有 Phase A 保护），渐进式不一步到位
- **兜底**：16 个 F215 测试 + 全量 route 测试 + LL-064 真实 runtime 验证

## Dependencies

- F215 close 后开始（runtime 守护验证完）
- 不依赖其他 feature

## AC（验收标准）

### Phase A
- [ ] AC-A1: 每个路由决策点提取为独立函数
- [ ] AC-A2: worklist.push 只出现在一处（for-await 循环主体）
- [ ] AC-A3: F215 16 测试 + 全量 route 测试零回归

### Phase B
- [ ] AC-B1: 路由决策是纯函数，可独立单测（无 side effect）
- [ ] AC-B2: cognitive complexity 降到 biome 默认阈值以下（或显著下降）
- [ ] AC-B3: 真实 runtime 验证——mention / relay / callback 三路由场景各验一次

### Phase C（conditional）
- [ ] AC-C1: Phase B 后评估——如果状态变量耦合已解，标 "不需要" 跳过

## Review Gate

- Phase A/B: 跨族 review（Maine Coon族 reviewer，改核心路由路径强制）
