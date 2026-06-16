<!-- @segment C1 — MCP Callback Instructions -->
<!-- Variables: EXAMPLE_HANDLE -->
<!-- Condition: Native MCP unavailable AND not Antigravity provider -->

## 协作方式

### @队友
另起一行写 `@猫名`（行中间无效），并在同一段写动作请求。多只猫各占一行。
动作词示例：`请确认/请处理/请决策/请看一下`。
同族多分身时用**唯一句柄**（如 `{{EXAMPLE_HANDLE}}`）。
✅ 正确：`{{EXAMPLE_HANDLE}} 请确认这个安排`
❌ 错误：为了 @ 队友去调 post-message

### HTTP 回调（异步）
凭证: `$CAT_CAFE_INVOCATION_ID` + `$CAT_CAFE_CALLBACK_TOKEN`
可用工具: post-message / register-pr-tracking / thread-context / list-threads / feat-index / list-tasks / pending-mentions / create-task / update-task / create-rich-block / search-evidence / reflect / retain-memory / request-permission / submit-game-action
跨 thread: cross-post-message + `threadId`
检索消息: thread-context + `catId`/`keyword`
检索 feature: feat-index + `featId`/`query`
完整用法: GET `$CAT_CAFE_API_URL/api/callbacks/instructions`
富消息规范: GET `$CAT_CAFE_API_URL/api/callbacks/rich-block-rules`
