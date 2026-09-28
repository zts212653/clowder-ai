# MCP Callbacks HTTP API Reference

> 降级自 `using-mcp-callbacks` skill。按需查阅。

## 主路径

猫猫默认使用 `cat_cafe_*` MCP 工具，不手写 Clowder AI 第一方 callback HTTP。

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
| 注册 issue tracking | `cat_cafe_register_issue_tracking` | `POST /api/callbacks/register-issue-tracking` |
| assigned cat 接/退 community route | `cat_cafe_validate_community_route` | `POST /api/community-issues/:id/validate-route` |
| 记录 external review verdict + delivery | `cat_cafe_record_external_review_verdict` | `POST /api/callbacks/record-external-review-verdict` |
| 搜证据 | `cat_cafe_search_evidence` | `GET /api/callbacks/search-evidence` |
| 写长期记忆 | `cat_cafe_retain_memory_callback` | `POST /api/callbacks/retain-memory` |
| 创建 rich block | `cat_cafe_create_rich_block` | `POST /api/callbacks/create-rich-block` |
| 提交游戏行动 | `cat_cafe_submit_game_action` | `POST /api/callbacks/submit-game-action` |
| 更新 workflow 告示牌 | `cat_cafe_update_workflow` | `POST /api/callbacks/update-workflow-sop` |
| 开多猫 vote | `cat_cafe_start_vote` | `POST /api/callbacks/start-vote` |

## Tracking registration policy

PR/issue tracking 注册一次，匹配后默认自动续代，不需要再注册。**普通注册只给对象**：PR 是 `repoFullName + prNumber`，issue 是 `repoFullName + issueNumber`。`when`、`goal`、`nextStep` 全部可选（#1392 AC-7）。

省略 `when` 时服务端装上对象自身的状态条件**和两个评论面**，受众按角色解析：PR 作者收除自己以外的全部回复（含 bot）；有可核验依据的 maintainer/reviewer 只收 PR 作者的回复（过滤 bot 与可确定识别的纯召唤命令）；issue 收除自己以外的全部评论。身份或角色无法确定时，评论照常投递并标注「身份/角色未知」，**不静默丢弃、不扩大收件人、也不因此关闭追踪**。注册返回的 `notification` 写明实际装了什么、解析出什么角色、过滤规则是什么。

可选：

- `when`：高级精确入口，flat any-of typed predicate，每种条件最多一个。写在这里的 `pr_conversation_comment_added` / `pr_inline_comment_added` 仍然必须自带 `authorLogins`，且不会被套上角色过滤。
- `goal`：把两个评论面收窄到你点名的人，是收窄而不是前置条件。
- `nextStep`：条件满足后要做什么；只显示、不解析为 policy。省略则由服务端确定性生成。

- `expiresAt`：责任失效时间（Unix ms）。**省略则没有时间到期**；写了必须在未来，并会在注册返回中可见。

baseline 与 owner fence 均由 server 从实时真相生成，调用方不能提交。

不匹配的 GitHub 事实只推进 collector 台账；匹配时每个 generation 最多投递一次 compact delta，并默认原子地装上下一代（`autoRenew: false` 为单次等待）。merged/closed 会投递 terminal outcome 并结束追踪；expiry 投递明确的到期通知并结束追踪；owner change、user cancel 静默终止。要等待**另一个条件**时 re-register，它原子替换上一 generation。

Issue tracking 在 F280 Phase C 前仍保留自己的 comment actor policy；不要把 issue 的 `wakePolicy` 借回 PR。正常调用只传 MCP 参数，不要为了设置 policy 手写 callback HTTP。

## Credentials

MCP 工具会从 invocation credentials 或 agent-key sidecar 自动处理认证。不要把 `$CAT_CAFE_INVOCATION_ID` / `$CAT_CAFE_CALLBACK_TOKEN` 拼进 skill 示例里。

常见失败：

| 现象 | 处理 |
|------|------|
| invocation callback 401 | 当前 callback token 过期；用本轮可用 MCP 工具重试，或在最终回复里用行首 `@` 路由 |
| shared Antigravity MCP 缺凭证 | 传 `agentKeyCatId`，让工具选择对应猫的 sidecar key |
| 工具目录完全没有对应能力 | 按 F223 追踪 execution surface 缺口，不把 HTTP route 当主路径 |

`routeAcceptance=pending` 只能由真实 assigned cat 调 `cat_cafe_validate_community_route` 变更；不要把 callback token 暴露给 `curl`，也不要由 case owner 冒充目标猫直写 API。

## Notes

- 正常回复直接输出文本；只有中途进度、跨 thread 通知、任务状态等需要 callback MCP。
- Rich block 主路径是 `cat_cafe_create_rich_block`；字段仍是 `kind` / `v` / `id`。
- 维护 callback server 时请读 `packages/mcp-server/src/tools/callback-tools.ts` 和 `packages/api/src/routes/callbacks.ts`，不要从 skill 文档复制 HTTP 示例。
