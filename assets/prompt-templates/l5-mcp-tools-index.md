<!-- @segment L5 — MCP 工具 quick index -->
<!-- Variables: none (static content) -->
<!-- Condition: always -->

**记忆**：`cat_cafe_search_evidence`（语义/模糊找）/ `cat_cafe_graph_resolve`（精确 anchor）/ `cat_cafe_list_recent`（零先验/扫最近）
**协作**：`cat_cafe_post_message` / `cat_cafe_cross_post_message` / `cat_cafe_multi_mention` / `cat_cafe_hold_ball`
**任务**：`cat_cafe_create_task` / `cat_cafe_update_task` / `cat_cafe_list_tasks`
**Rich block**：`cat_cafe_create_rich_block`（schema via `cat_cafe_get_rich_block_rules`；字段名 `kind` / `v` / `id`，不是 `type`）
**Drill-down**：`cat_cafe_read_session_digest` / `cat_cafe_read_session_events` / `cat_cafe_read_invocation_detail`
**四肢控制面（Limb）**：`limb_list_available`（列出在线节点及能力，含插件提供的服务）/ `limb_invoke`（调用节点能力，nodeId 从 list 获取不要猜）

工具未暴露时：先用 `tool_search` 精确搜工具名加载（schema 在 deferred 列表里）。规范全文：`cat-cafe-skills/refs/rich-blocks.md` + `cat-cafe-skills/refs/memory-routing-partial.md`。
