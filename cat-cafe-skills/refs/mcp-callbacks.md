# MCP Callbacks HTTP API Reference

> 降级自 `using-mcp-callbacks` skill。按需查阅。

## 主路径

猫猫默认使用 `cat_cafe_*` MCP 工具，不手写 Cat Café 第一方 callback HTTP。

HTTP callback route 是 MCP tool 的底层实现和维护者调试面，不是 skill 主路径。只有在工具目录缺失、agent-key / invocation credentials 故障诊断、或维护 callback server 本身时，才查 route 名称；这种场景需要在 PR / handoff 里说明为什么不能走 MCP。

## Tool Mapping

| 需求 | MCP tool | 底层 route（维护者参考） |
|------|----------|--------------------------|
| 发当前 thread 中途消息 | `cat_cafe_post_message` | `POST /api/callbacks/post-message` |
| 跨 thread 通知 | `cat_cafe_cross_post_message` | `POST /api/callbacks/post-message` with target thread fields |
| 读 thread 上下文 | `cat_cafe_get_thread_context` | `GET /api/callbacks/thread-context` |
| 查当前 thread 猫列表 | `cat_cafe_get_thread_cats` | `GET /api/callbacks/thread-cats` |
| 找 thread | `cat_cafe_list_threads` | `GET /api/callbacks/list-threads` |
| 查 feature index | `cat_cafe_feat_index` | `GET /api/callbacks/feat-index` |
| 查 pending mentions | `cat_cafe_get_pending_mentions` | `GET /api/callbacks/pending-mentions` |
| ack mentions | `cat_cafe_ack_mentions` | `POST /api/callbacks/ack-mentions` |
| 建毛线球任务 | `cat_cafe_create_task` | `POST /api/callbacks/create-task` |
| 更新任务状态 | `cat_cafe_update_task` | `POST /api/callbacks/update-task` |
| 列任务 | `cat_cafe_list_tasks` | `GET /api/callbacks/list-tasks` |
| 注册 PR tracking | `cat_cafe_register_pr_tracking` | `POST /api/callbacks/register-pr-tracking` |
| 搜证据 | `cat_cafe_search_evidence` | `GET /api/callbacks/search-evidence` |
| 写长期记忆 | `cat_cafe_retain_memory_callback` | `POST /api/callbacks/retain-memory` |
| 请求权限 | `cat_cafe_request_permission` | `POST /api/callbacks/request-permission` |
| 查权限请求状态 | `cat_cafe_check_permission_status` | `GET /api/callbacks/permission-status` |
| 创建 rich block | `cat_cafe_create_rich_block` | `POST /api/callbacks/create-rich-block` |
| 提交游戏行动 | `cat_cafe_submit_game_action` | `POST /api/callbacks/submit-game-action` |
| 更新 workflow 告示牌 | `cat_cafe_update_workflow` | `POST /api/callbacks/update-workflow-sop` |
| 开多猫 vote | `cat_cafe_start_vote` | `POST /api/callbacks/start-vote` |

## Credentials

MCP 工具会从 invocation credentials 或 agent-key sidecar 自动处理认证。不要把 `$CAT_CAFE_INVOCATION_ID` / `$CAT_CAFE_CALLBACK_TOKEN` 拼进 skill 示例里。

常见失败：

| 现象 | 处理 |
|------|------|
| invocation callback 401 | 当前 callback token 过期；用本轮可用 MCP 工具重试，或在最终回复里用行首 `@` 路由 |
| shared Antigravity MCP 缺凭证 | 传 `agentKeyCatId`，让工具选择对应猫的 sidecar key |
| 工具目录完全没有对应能力 | 按 F223 追踪 execution surface 缺口，不把 HTTP route 当主路径 |

## Notes

- 正常回复直接输出文本；只有中途进度、跨 thread 通知、任务状态等需要 callback MCP。
- Rich block 主路径是 `cat_cafe_create_rich_block`；字段仍是 `kind` / `v` / `id`。
- 维护 callback server 时请读 `packages/mcp-server/src/tools/callback-tools.ts` 和 `packages/api/src/routes/callbacks.ts`，不要从 skill 文档复制 HTTP 示例。
