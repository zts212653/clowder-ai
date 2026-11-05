---
feature_ids: [F326, F309]
doc_kind: reference
topics: [video, works, delivery, feedback]
updated: 2026-10-20
created: 2026-10-20
---

# 视频交片与原意见回报

家里八支已有片子曾靠 QuickTime/Finder 看片、聊天手写时间点。交片现在走共同的作品入口，让人直接在片上标一刻、一段或全片；作品和意见不靠文件名认亲。工程放哪、用不用脚本或 Remotion 都不影响登记。

## 保存和发卡是两次动作

1. 用 `cat_cafe_work` 的 `inspect-source`，传已登记 Workspace 的 `{worktreeId,path}`，取回实际 `source`（含 `expectedSourceRevision`）及媒体时钟。不要猜 digest、传任意主机绝对路径，或要求人先把文件搬到主仓。
2. 首次交片用 `create`，传稳定 `operationId`、`title`、`changeSummary` 和刚核的 `source`。续交用 `submit`，传**同一个** `contentRef`、刚读取的 `expectedOwnerRevision` 及新文件 `source`。原作品改名或换编码不另建身份，仅换清晰度不冒充一次创作迭代；两件作品即使同主题也不合并（例如家里两支独立的记忆篇）。
3. 保存回执给 `{contentRef,ownerRevision}`。用 `publish-reference` 发布这个确切 `reference`，工具把交片卡附到当前消息；同时写清这一版改了什么、哪处请他看、什么还没做好。无需手拼 URL 或 rich block；只保存不会自动发卡，也不会抢开全局工作区。

`cat_cafe_work` 的最小输入形状：

```json
{"command":{"action":"inspect-source","locator":{"worktreeId":"实际登记的工位ID","path":"release/实际成片.mp4"}}}
```

之后按实际工具 schema 传 `create`／`submit`／`publish-reference`，不要复制示例中的占位值。发现已有作品用 `list`，按固定版本读用 `read` 的 `reference`；重启或换会话也用 owner 保留的作品，不从旧消息 block 反查一份新身份。跨线程或换作者仍需原精确授权，引用不是读写权。

## 原意见到同一件作品的下一版

从收到的原修改请求/意见卡读其 read continuation；媒体审阅用 `cat_cafe_read_artifact_review` 读当前原账，保留 `reviewId`、原 `sourceRound`、原意见 ID、当前 review/Task/ledger revision 和请求存在时的 `requestId`。普通交片不要求先造 Task；原意见的 Task 和请求也不能另造来替换。

完成后在**同一次** `cat_cafe_work submit` 附可选 `reviewResponse`：原账坐标、逐条 `annotationId/disposition/explanation`，能定位才附 `resultAnchor`。位置用**新版 inspect-source 的时钟**，不是把旧版秒数照抄；无法定位就省略，让人仍可查看原位置。原意见可在第 1 版、提交基线是第 3 版、结果是第 4 版；review round 不是作品版本号。

读工具的分页结果时，按回执复用不变命令、`nextCursor` 和 `snapshot`，拼全 `json` 后再解析。保存返回 `version_saved` 而注释待恢复时，只重试**完全相同**的命令和 `operationId`；不要再交一次新版。发送卡未确认则重发原固定引用，不重交字节。版本冲突先读真实 head，再决定如何处理原改动。

猫的 `addressed` 只是改动说明，不代 You 接受。等待人选「已改／还不对」，重开后读原账继续；`resolve-review-submission` 是人的显式恢复出口，不是猫的发布后门。

如果当前环境没暴露 `cat_cafe_work`，核已加载 runtime/工具版本并如实报告“尚未登记进 Works”；不声称旧的裸 MP4 链接已经完成作品交付。共同类型和权限细节以 `docs/architecture/f309-living-work-entry-contract.md` 与当前工具 schema 为准。
