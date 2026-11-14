---
doc_kind: architecture
feature_ids: [F332]
created: 2026-11-11
updated: 2026-11-11
owner: codex-astra
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/memory/remember-entry.md"
mcp_admission_claims:
  - {ref: "file:docs/architecture/memory/remember-entry.md", toolName: cat_cafe_remember, resourceFamily: memory, boundaryKind: resource-entry, decision: accepted}
---

# remember 的入口绑定

人类授权原件：`[thread-id]#private-source-id`。
`cat_cafe_remember`接一次1–4项请求，逐项转给现有领域提交路由，返回原提案/结果/拒绝原因与groupId。
分组用现有消息的`meta.memoryGroup`保存引用；决定和正文仍归原审批、存储及去重。
它不是读取、批准或遗忘入口，不授权新的writer，也不引入批次协调或效果证明。

此绑定落实人类已点名的统一入口；不表示实现已review、合入或验收。
当前范围见474接续文档，
本包验证见薄入口证据。
旧八工具须W4读取恢复与真实完整替代均通过后才撤，本包保留它们。
