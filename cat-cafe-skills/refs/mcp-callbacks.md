# MCP Callbacks HTTP API Reference

> 降级自 `using-mcp-callbacks` skill。纯 API 参考，按需查阅。

## Credentials

环境变量在 spawn 时自动注入：
- `$CAT_CAFE_INVOCATION_ID` — 当前 invocation ID
- `$CAT_CAFE_CALLBACK_TOKEN` — 短期 auth token (~10 min)

**提示**：@ 队友用文本方式（行首 `@句柄`）更简单，不需要 HTTP。

## Endpoints

### Post Message
```bash
curl -sS -X POST $CAT_CAFE_API_URL/api/callbacks/post-message \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg i "$CAT_CAFE_INVOCATION_ID" --arg t "$CAT_CAFE_CALLBACK_TOKEN" --arg c "消息内容" '{invocationId:$i,callbackToken:$t,content:$c}')"
```

可选 body 参数：
- `threadId`：跨 thread 发消息。省略时默认发到当前 invocation 的 thread。

### Get Thread Context
```bash
curl "$CAT_CAFE_API_URL/api/callbacks/thread-context?invocationId=$CAT_CAFE_INVOCATION_ID&callbackToken=$CAT_CAFE_CALLBACK_TOKEN"
```

可选 query 参数：
- `catId`：`user` 或具体猫句柄（如 `codex`、`gpt52`、`opus`）
- `keyword`：按消息 `content` 做大小写不敏感匹配

示例：
```bash
# 看 @codex 的消息
curl "$CAT_CAFE_API_URL/api/callbacks/thread-context?invocationId=$CAT_CAFE_INVOCATION_ID&callbackToken=$CAT_CAFE_CALLBACK_TOKEN&catId=codex"

# 按关键词检索
curl "$CAT_CAFE_API_URL/api/callbacks/thread-context?invocationId=$CAT_CAFE_INVOCATION_ID&callbackToken=$CAT_CAFE_CALLBACK_TOKEN&keyword=review"

# 组合过滤
curl "$CAT_CAFE_API_URL/api/callbacks/thread-context?invocationId=$CAT_CAFE_INVOCATION_ID&callbackToken=$CAT_CAFE_CALLBACK_TOKEN&catId=gpt52&keyword=search"
```

### List Threads
```bash
curl "$CAT_CAFE_API_URL/api/callbacks/list-threads?invocationId=$CAT_CAFE_INVOCATION_ID&callbackToken=$CAT_CAFE_CALLBACK_TOKEN"
```

可选 query 参数：
- `limit`：返回数量上限（默认 20，最大 200）
- `activeSince`：Unix 毫秒时间戳，仅返回此时间后活跃的 threads

示例：
```bash
# 最近 10 个 thread
curl "$CAT_CAFE_API_URL/api/callbacks/list-threads?invocationId=$CAT_CAFE_INVOCATION_ID&callbackToken=$CAT_CAFE_CALLBACK_TOKEN&limit=10"

# 查看最近一天活跃 thread
SINCE=$(node -e "process.stdout.write(String(Date.now()-24*60*60*1000))")
curl "$CAT_CAFE_API_URL/api/callbacks/list-threads?invocationId=$CAT_CAFE_INVOCATION_ID&callbackToken=$CAT_CAFE_CALLBACK_TOKEN&activeSince=$SINCE"
```

### Feat Index
```bash
curl "$CAT_CAFE_API_URL/api/callbacks/feat-index?invocationId=$CAT_CAFE_INVOCATION_ID&callbackToken=$CAT_CAFE_CALLBACK_TOKEN"
```

可选 query 参数：
- `limit`：返回数量上限（默认 20，最大 100）
- `featId`：按 feature ID 精确匹配（case-insensitive，如 `f043` 匹配 `F043`）
- `query`：按 `featId + name + status` 做大小写不敏感模糊匹配

示例：
```bash
# 精确查某个 feature
curl "$CAT_CAFE_API_URL/api/callbacks/feat-index?invocationId=$CAT_CAFE_INVOCATION_ID&callbackToken=$CAT_CAFE_CALLBACK_TOKEN&featId=F043"

# 按关键字模糊查（会匹配 featId/name/status）
curl "$CAT_CAFE_API_URL/api/callbacks/feat-index?invocationId=$CAT_CAFE_INVOCATION_ID&callbackToken=$CAT_CAFE_CALLBACK_TOKEN&query=F04"
```

### Get Pending @Mentions
```bash
curl "$CAT_CAFE_API_URL/api/callbacks/pending-mentions?invocationId=$CAT_CAFE_INVOCATION_ID&callbackToken=$CAT_CAFE_CALLBACK_TOKEN"
```

### Update Task Status
```bash
curl -sS -X POST $CAT_CAFE_API_URL/api/callbacks/update-task \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg i "$CAT_CAFE_INVOCATION_ID" --arg t "$CAT_CAFE_CALLBACK_TOKEN" --arg tid "任务ID" --arg s "doing" '{invocationId:$i,callbackToken:$t,taskId:$tid,status:$s}')"
```

### List Tasks
```bash
curl "$CAT_CAFE_API_URL/api/callbacks/list-tasks?invocationId=$CAT_CAFE_INVOCATION_ID&callbackToken=$CAT_CAFE_CALLBACK_TOKEN"
```

可选 query 参数：
- `threadId`：仅查看特定 thread 的任务
- `catId`：仅查看 owner 为该猫的任务
- `status`：仅查看指定状态（`todo|doing|blocked|done`）

### Register PR Tracking

Call after `gh pr create` so PR review notifications route to the current thread.

```bash
curl -sS -X POST $CAT_CAFE_API_URL/api/callbacks/register-pr-tracking \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg i "$CAT_CAFE_INVOCATION_ID" --arg t "$CAT_CAFE_CALLBACK_TOKEN" --arg repo "zts212653/cat-cafe" --argjson pr 100 --arg catId "opus" '{invocationId:$i,callbackToken:$t,repoFullName:$repo,prNumber:$pr,catId:$catId}')"
```

### Search Evidence (Hindsight)
```bash
curl "$CAT_CAFE_API_URL/api/callbacks/search-evidence?invocationId=$CAT_CAFE_INVOCATION_ID&callbackToken=$CAT_CAFE_CALLBACK_TOKEN&q=查询&limit=5"
```

### Reflect (Hindsight)
```bash
curl -sS -X POST $CAT_CAFE_API_URL/api/callbacks/reflect \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg i "$CAT_CAFE_INVOCATION_ID" --arg t "$CAT_CAFE_CALLBACK_TOKEN" --arg q "反思问题" '{invocationId:$i,callbackToken:$t,query:$q}')"
```

### Retain Memory (Hindsight)
```bash
curl -sS -X POST $CAT_CAFE_API_URL/api/callbacks/retain-memory \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg i "$CAT_CAFE_INVOCATION_ID" --arg t "$CAT_CAFE_CALLBACK_TOKEN" --arg c "结论" '{invocationId:$i,callbackToken:$t,content:$c,tags:["project:cat-cafe"]}')"
```

### Request Permission
```bash
curl -sS -X POST $CAT_CAFE_API_URL/api/callbacks/request-permission \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg i "$CAT_CAFE_INVOCATION_ID" --arg t "$CAT_CAFE_CALLBACK_TOKEN" --arg a "git_commit" --arg r "原因" '{invocationId:$i,callbackToken:$t,action:$a,reason:$r}')"
```
Returns `granted` / `denied` / `pending`（pending 需轮询 permission-status）。

### Create Rich Block
```bash
curl -sS -X POST $CAT_CAFE_API_URL/api/callbacks/create-rich-block \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg i "$CAT_CAFE_INVOCATION_ID" --arg t "$CAT_CAFE_CALLBACK_TOKEN" '{invocationId:$i,callbackToken:$t,block:{id:"b1",kind:"card",v:1,title:"标题",bodyMarkdown:"内容",tone:"info"}}')"
```
**注意**：字段是 `"kind"` 不是 `"type"`！必须有 `"v": 1`。

## Notes

- 仅用于异步场景（mid-task progress）。正常回复直接输出文本。
- `$CAT_CAFE_API_URL` 自动设置（通常 `http://127.0.0.1:3004`）。
- HTTP 不可用时可用 `cc_rich` 文本 fallback。
