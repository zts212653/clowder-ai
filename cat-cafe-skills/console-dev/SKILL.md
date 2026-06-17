---
name: console-dev
description: >
  Console 前端交付范式：4 道门禁驱动的前端开发流程。Use when:
  新增前端能力、settings section 迁移、新增页面、重构布局、或 F190/Console 级前端流程需要 Product/Design/Implementation/Verification gate。
  Not for: 小样式点改、纯后端 API、纯计算逻辑、独立 Design System token 定义。
  Output: 通过 Product / Design-System / Implementation / Verification gate 的前端代码与证据。
---

# Console-Dev

Console 前端开发先定入口和状态，再写组件。这个 skill 不替代 `tdd` / `quality-gate`，它补齐前端特有的产品路径、设计 token、交互状态和视觉证明。

## Gate 1: Product Gate

先回答：用户从哪里进入？这个能力属于哪个层级？

| 层级 | 用途 | 门槛 |
|------|------|------|
| L1 Activity Bar | 每天使用的核心入口 | 极慎重，通常需要 operator 决策 |
| L2 `/settings` | 管理/配置 UI | 默认放这里 |
| L3 settings 子 tab | 只读、分析、运维子视图 | 自助选择合适分区 |
| L4 独立 route | 需要专属布局/流程的体验 | 先讨论入口理由 |

涉及状态的 UI 必须列状态矩阵：loading / empty / partial / full / error，owner / member / guest / unauthenticated，desktop / mobile。

## Gate 2: Design-System Gate

新代码 token first：颜色、边框、语义状态优先复用现有 CSS variables 和组件 primitive。旧代码迁移可以渐进，但 debt 清单只能减少，不能因为新功能扩大豁免。

## Gate 3: Implementation Gate

| 规则 | 处置 |
|------|------|
| 200 行 | 触发拆分审查 |
| 350 行 | 默认必须拆，除非结构理由写清楚 |
| 敏感值 | 展示值和提交值分离；redacted placeholder 不能回写 |
| settings migration | 写清 Source Behavior / Must Preserve Home Behavior / Decision / Proof |

拆分方向优先是视觉独立 sub-component，不是把小工具函数切碎。

## Gate 4: Verification Gate

必须给证据：

- Golden path 走通
- 至少覆盖一个非 happy path 状态
- 改共享 primitive 时抽样兄弟页面
- modal 检查 footer、滚动容器、sticky action、ESC/关闭行为
- 暗色/移动端如果会被影响，必须抽样

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 先写组件再找入口 | L1 导航膨胀，后续难回滚 | 先过 Product Gate |
| 把 source PR 整块搬进 settings | 带入 service/auth/chat 红区 | manual-port 到最小 source intent |
| 用 hardcoded 视觉值补样式 | 设计体系继续分叉 | 先查 token / primitive |
| 展示用 redacted 值进入 draft | 覆盖真实 secret | display value 和 submit payload 分层 |
| 只跑类型检查 | UI 状态、滚动、modal 回归漏检 | focused test + 浏览器 proof |

## 和其他 Skill 的区别

- `tdd`：负责测试驱动实现；`console-dev` 负责前端入口、状态和视觉门禁。
- `browser-preview`：负责打开/验证页面；`console-dev` 定义你要验证什么。
- `quality-gate`：交付前总门禁；`console-dev` 是前端子门禁。
- `pencil-design`：产出设计稿；`console-dev` 把设计稿落到运行态。

## 参考

- `refs/f190-frontend-lessons.md` — F190 Console intake 的具体案例。
- `docs/architecture/feature-placement.md` — Console 入口层级决策树。
