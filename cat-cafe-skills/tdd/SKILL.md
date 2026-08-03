---
name: tdd
description: >
  Red-Green-Refactor for changes with behavior or regression risk.
  Use when: adding observable behavior, fixing a bug, or changing logic not already covered by a precise executable check.
  Not for: pure docs/research, deterministic generated-artifact refreshes, or mechanical changes already covered by an existing checker.
  Output: observed RED (new test or existing failing check) → minimal GREEN → refactor under protection.
triggers:
  - "写代码"
  - "test first"
  - "TDD"
  - "红绿重构"
---

# TDD（测试驱动开发）

行为变化先看到一个可信的失败信号，再写最少实现把它变绿。**RED 是证据状态，不是必须新建测试文件。**

## 风险入口

| 改动 | 怎么走 |
|---|---|
| 新增用户可见 / runtime 行为 | 先写能失败的行为测试，再实现 |
| 修 bug，现有测试没有复现 | 先补回归测试，确认按正确原因失败 |
| 现有精确检查已经红 | 这就是现成 RED；直接修到该检查绿，不重复造测试 |
| 确定性生成物过期 | generator / sync check 的失败就是 RED；重生成后复跑，不另写“测试生成物存在”的测试 |
| 纯文档、调研、无行为的机械改动 | 不触发本 skill；跑与改动面匹配的校验 |

判断标准不是“有没有写代码”，而是“是否引入或修复了可观察行为，且现有检查能否准确保护它”。拿不准是否有行为风险时，按有风险处理。

## RED 来源

RED 可以来自两处：

1. **新测试**：现有检查没有表达目标行为。先写测试，亲眼确认它以预期原因失败。
2. **现有检查**：CI、typecheck、schema/index freshness、generator drift 等已经准确指出目标差异。保存命令与失败输出；它已经完成了 RED 的工作。

禁止为了仪式感叠加第二个等价 RED。尤其是 checked-in index、代码生成结果、格式化快照等确定性派生物：精准 checker 红 → 重生成 → 同一 checker 绿，就是完整闭环。

## Red-Green-Refactor

```text
RED      观察可信失败信号
  ↓
GREEN    写最少实现，让同一信号通过；相关检查也保持绿
  ↓
REFACTOR 消除重复、改善命名，不新增行为；复跑同一保护集
```

- RED 立即通过：目标行为已经存在，或检查没覆盖目标；先纠正测试/判断。
- RED 是语法错误、环境错误：修到它能准确表达行为失败再继续。
- GREEN 让别的检查变红：停下修复回归，不扩 scope。
- REFACTOR 后变红：回退这次重构，重新收敛。

## Bug Fix 模式

未知根因、跨层或非确定性 bug 先加载 `debugging`，用[诊断胶囊](../refs/bug-diagnosis-capsule.md)定位；确定根因后再选择 RED：

- 没有现成复现 → 新增失败回归测试；
- 已有精确失败检查 → 直接把它当 RED；
- 确定性 `main` 红且修复可逆、无行为变化 → 走 Harness Diet fix-forward，不为找 owner 或新建测试排队。

安全、鉴权、生产数据、外部契约与不可逆面即使已有 RED，也不因此降级其他门禁；RED 只回答测试入口，不回答授权与合入风险。

## 正反灰例

- 正例：API 对空 token 返回 200，现有测试没覆盖 → 先补失败回归测试。
- 正例：`pnpm check:sop-definitions` 报 checked-in 生成文件 stale → 该失败就是 RED，运行 generator 后复验。
- 反例：给纯 discussion 改措辞 → 不写单测，跑 docs/format 校验。
- 反例：index generator 已精准报 drift，却另造一个同义单测 → 删除重复测试。
- 灰例：机械 rename 有完整 typecheck 覆盖 → typecheck 红可作 RED；若还改变对外名字/契约，则升级为行为测试 + 契约风险车道。

## Common Mistakes

| 错误 | 后果 | 修正 |
|---|---|---|
| 先实现，再补从未失败过的测试 | 无法证明测试能抓回归 | 回到可观察 RED |
| 把“测试文件”当 TDD 目标 | 给确定性生成物制造冗余测试 | 复用现有精确检查 |
| 因为已有 RED 就跳过安全/授权边界 | 测试证据被误当风险许可证 | 风险路由独立判断 |
| 小修也强造新 RED | 仪式成本高于信息增益 | 无行为或现有 checker 已覆盖就不新增 |
| RED 只是环境/拼写错误仍继续 | 失败信号不可信 | 修到按预期原因失败 |

## 和其他 skill 的区别

- `debugging`：先定位未知根因；TDD 在方向确定后保护行为变化。
- `quality-gate`：按风险汇总交付证据；TDD 只负责实现循环中的行为保护。

## 下一步

实现完成后，按风险选择 targeted 自检或 `quality-gate`；不要因使用了 TDD 自动触发其余所有车道。
