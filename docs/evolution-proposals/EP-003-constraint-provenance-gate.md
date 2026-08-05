---
feature_ids: [F100, F289]
topics: [process-evolution, constraint-provenance, dogfood, scope]
doc_kind: note
created: 2026-08-05
knowledge:
  artifact_type: proposal
  domain: development
  scope: team-shared
  trust_level: experimental
  lifecycle: draft
  knowledge_type: procedural
  provenance:
    author_type: agent
  source_refs:
    - thread:thread_ms8cnrohzvoxqqli#0001785834449354-000091-3e7add3a
    - thread:thread_ms8cnrohzvoxqqli#0001785920305804-000284-cf2eab3f
    - commit:af10c401c
---

# Evolution Proposal: Constraint Provenance Gate

## Proposal ID: EP-003

## 5-Slot Template

**Trigger:** 同一条 F289 讨论链中两次把较窄作用域的规则提升成更广产品契约：先把 Cat Café fork 的 upstream 授权限制套到个人新项目，后把 Traqen 当前的 Review publication policy 套到通用 Desktop development loop。两次均由 operator 纠正。

**Evidence:**

1. Thread message `0001785834449354-000091-3e7add3a`：operator 明确 upstream 写入限制只属于 Cat Café 项目，个人新仓库不存在 fork/upstream 关系。
2. Thread message `0001785920305804-000284-cf2eab3f`：operator 明确 Traqen 的双语 GitHub Issue policy 是可变的项目局部标准，不属于本次链路实现。
3. `b6ecf8c8f..af10c401c`：F289 从 GitHub Issue/token/publisher 核心依赖修正为 `ReviewRound -> MCP -> Desktop`，提供可复核的 artifact delta。

**Root Cause:** 方案发现阶段读取了真实仓库约束，却没有先给约束标注 owner 与作用域，导致“真实存在”被误当成“应进入产品核心”。缺失的不是更多 repository scanning，而是 constraint provenance：`product-core / project-local / pilot-fixture / operator-runtime` 四层未分开。

**Lever:** 在 `writing-plans` 的需求/约定发现之后、Stateful Object Census 之前加入一个三问式 Constraint Provenance Gate：

1. 这条约束由谁拥有，改变它需要改哪个真相源？
2. 它属于产品核心、项目局部配置、dogfood fixture，还是 operator runtime？
3. 有显式 operator 决定或至少两个独立项目证据支持把它提升到更广层级吗？

只有 `product-core` 进入通用 state/AC；`project-local` 留在 binding/adapter 或明确 out-of-scope；`pilot-fixture` 只进入验证步骤。没有 promotion evidence 时默认不向外泛化。

**Verify:** 用同一模型和 planning prompt replay 5 个 fixture：fork upstream 授权、项目 Review publication、项目语言规范、production data boundary、repo-specific test command。期望前两类局部规则不进入通用核心；production data boundary 仍正确保留为跨项目安全铁律；repo test command 只进入 dogfood verification。5/5 scope 分类正确且无安全边界降级后再考虑 accepted。

## Status

- [x] proposed
- [ ] one-cat sanity check
- [ ] operator accepted → linked commit/PR: ____
- [ ] 30-day replay check: ____
- [ ] validated / rejected / superseded

## Use Log

<!-- append-only: date | agent | outcome | notes -->
