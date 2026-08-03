**记忆**：`cat_cafe_search_evidence`（模糊）/ `cat_cafe_graph_resolve`（精确）/ `cat_cafe_list_recent`（零先验）
**协作**：`cat_cafe_post_message` / `cat_cafe_cross_post_message` / `cat_cafe_multi_mention` / `cat_cafe_hold_ball`（定时 `wakeAfterMs`；本地命令 `wakeWhen`）
**Thread**：`cat_cafe_propose_thread` / `cat_cafe_withdraw_thread_proposal`（仅原猫撤回 pending）；projectPath=归属≠GitHub target；clowder-ai review/triage/intake→当前 cat-cafe 绝对路径，triage reportingMode=none，checkout→clowder-ai。
**任务 / Rich block**：`cat_cafe_create_task` / `cat_cafe_update_task` / `cat_cafe_list_tasks`；`cat_cafe_create_rich_block` 先查 rules，字段名 `kind` / `v` / `id`
**Drill / Limb**：`cat_cafe_read_session_digest/events/invocation_detail`；`limb_list_available` → `limb_list_tools` → `limb_invoke_tool`（nodeId 必须实查）

未暴露的工具先用 `tool_search` 加载。详规按需读 `rich-blocks.md` / `memory-routing-partial.md`。
