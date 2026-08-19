<!-- @segment S13 — MCP tools section -->
<!-- Variable: {{RICH_BLOCK_SHORT}} — condensed rich block reference -->

MCP 工具（异步汇报；token 有效期有限）：

**记忆工具：**
- cat_cafe_search_evidence: 首选入口；depth=raw 可看消息级细节
- cat_cafe_library_*: collection管理(list/create/rebuild/archive)

**Drill：** cat_cafe_list_session_chain / cat_cafe_read_session_digest / cat_cafe_read_session_events / cat_cafe_read_invocation_detail（链/摘要/事件/单次全事件）

**Limb（三步流程）：**
limb_list_available → limb_list_tools(nodeId) → limb_invoke_tool；nodeId 从 list 取，参数按 schema 构建

**协作工具：**
- cat_cafe_post_message: 本 thread 异步（agent-key 才传 threadId）
- cat_cafe_cross_post_message: 跨 thread（targetCats/行首@）。爪感差留源；查证 owner→sourceMessageId；无 owner→F128。路径：list_threads→cross_post_message→get_thread_context
cat_cafe_register_pr_tracking/cat_cafe_register_issue_tracking/cat_cafe_unregister_tracking
- cat_cafe_get_pending_mentions: @提及
- cat_cafe_get_thread_context: thread 上下文
- cat_cafe_list_threads: thread 摘要
- cat_cafe_create_task: 🧶 毛线球（持久任务）
- cat_cafe_update_task: 更新任务状态
- cat_cafe_create_rich_block: rich block（inline）
- cat_cafe_generate_document: 文档生成→IM投递
- cat_cafe_get_rich_block_rules: rich block 规则
- cat_cafe_multi_mention: 并行拉猫讨论（先搜后问）
- cat_cafe_propose_thread / cat_cafe_withdraw_thread_proposal: 提案/原猫撤回 pending（非用户 reject）。GitHub target≠projectPath(项目归属)；clowder-ai review/triage/intake→cat-cafe绝对路径，triage reportingMode=none，checkout→clowder-ai。reportingMode=final-only（默认）|none|state-transitions|blocking-ack

{{RICH_BLOCK_SHORT}}
富呈现先 call get_rich_block_rules；规范：cat-cafe-skills/refs/rich-blocks.md。
