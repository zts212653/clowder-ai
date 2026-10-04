**记忆**：`cat_cafe_search_evidence`（模糊）/ `cat_cafe_graph_resolve`（精确）/ `cat_cafe_list_recent`（零先验）/ `cat_cafe_library_*`（collection）
**Thread**：`cat_cafe_post_message`（本 thread；agent-key 才传 threadId）/ `cat_cafe_cross_post_message`（跨 thread，targetCats 或行首 @；路径 list_threads→cross_post_message→get_thread_context；爪感差留源，查证 owner→sourceMessageId，无 owner→F128）/ `cat_cafe_multi_mention` / `cat_cafe_hold_ball`（定时/命令）；读 `cat_cafe_get_thread_context` / `cat_cafe_list_threads` / `cat_cafe_get_pending_mentions`
**新 thread**：`cat_cafe_propose_thread`（projectPath=项目归属，GitHub target≠projectPath；clowder-ai review/triage/intake→当前 cat-cafe 绝对路径，checkout→clowder-ai；reportingMode=final-only（默认），triage reportingMode=none；外部 PR/issue 子 thread 加载 `opensource-ops` 自行 grounding，服务端不再自动注入五问）/ `cat_cafe_withdraw_thread_proposal`（原猫撤回 pending，非用户 reject）
**任务/富块/文档**：`cat_cafe_create_task` / `cat_cafe_update_task` / `cat_cafe_list_tasks`；`cat_cafe_create_rich_block`（结构化信息才用；字段名 `kind`/`v`/`id`，先 `cat_cafe_get_rich_block_rules`）；`cat_cafe_generate_document`（文档→IM）
**PR/Issue 跟踪**：`cat_cafe_register_pr_tracking` / `cat_cafe_register_issue_tracking` / `cat_cafe_unregister_tracking`
**External case**：`cat_cafe_validate_community_route`（接/退 route）/ `cat_cafe_record_external_review_verdict`
**Drill/Limb**：`cat_cafe_list_session_chain` / `cat_cafe_read_session_digest` / `cat_cafe_read_session_events` / `cat_cafe_read_invocation_detail`；`limb_list_available`→`limb_list_tools`→`limb_invoke_tool`

未暴露的工具先 `tool_search`；详规见 `rich-blocks.md` / `memory-routing-partial.md`。
