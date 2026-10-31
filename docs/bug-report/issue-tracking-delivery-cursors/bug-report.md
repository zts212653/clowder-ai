---
feature_ids: [F168, F202]
topics: [github, issue-tracking, pr-tracking, dispatch, cursor]
doc_kind: bug-report
created: 2026-07-19
updated: 2026-07-19
tips_exempt:
  reason: Correctness fixes for existing PR/Issue tracking; no new user action or discoverable capability.
---

# PR / Issue tracking cursor 与唤醒语义修复

## Bug 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | #1053：首次注册 PR tracking 会永久跳过注册前已出现的 review/comment。#1153：issue tracking 可推进 cursor 与 `lastNotifiedAt`，但 owner 猫没有收到 invocation。 |
| **2. 证据** | PR 注册边界并发读取三类历史 feedback 并以最大 GitHub ID 初始化 review cursors；issue delivery 用 `authorAssociation` 静默过滤 OWNER/MEMBER，且在异步 trigger 结果返回前提交 cursor/通知时间。 |
| **3. 根因** | PR 把“首次消费边界”误实现为“注册时 GitHub 最新值”；issue 把社区投影用的仓库角色策略误用于显式订阅通知，并把“消息已路由”错误等同于“唤醒已接受”。 |
| **4. 诊断策略** | 沿注册路由 → cursor seed → poll filter，以及 issue collection → route → `ConnectorInvokeTrigger` → automation state 两条调用链核对；用注入式 CI fetcher 与 trigger outcome 固定复现。 |
| **5. 超时策略** | 不依赖真实 GitHub、生产 Redis 或运行实例；在隔离 worktree 用编译后 TaskSpec、内存 TaskStore/EventLog 与确定性 trigger stub 验证。 |
| **6. 预警策略** | PR review cursor 的初始值与 issue 历史 cursor 分开测试；`lastNotifiedAt` 只能在 trigger 返回 `dispatched`/`enqueued` 后更新，`full`/异常必须结构化报错。 |
| **7. 用户可见交互修正** | 新注册 PR 可收到注册前 feedback；显式 issue tracking 会投递 OWNER/MEMBER 的非 echo 评论；未接受唤醒时状态不再伪称已通知。 |
| **8. 验收** | 三类 PR feedback fetch 被移除且 review cursors=0、CI 边界保留；OWNER/MEMBER/echo、`dispatched`/`enqueued`/`full`/reject 均有回归覆盖。 |

## 报告来源

- Reporter：co-creator，当前协作 thread `thread_mrripygpb2of0n7s`，原始要求消息 `0001784449895067-004167-c96db10c`。
- GitHub：#1053 与 #1153。
- #1053 的范围决策来自历史 thread `thread_mr0474j595fpndoz`：PR review cursor 从 0 开始并移除三类 feedback 预取；成熟 issue tracking 的历史 cursor 语义保持不变。

## 稳定复现

1. 在 PR 已有 comment/review 后首次注册 tracking；旧实现将这些 ID 写入初始 cursor，随后 poll 的 `id > cursor` 永远排除它们。
2. 对已显式注册的 issue 产生 OWNER/MEMBER 评论；旧实现先写入 community event，再按仓库角色静默过滤，因无 work item 而不路由、不唤醒。
3. 对普通 issue 评论让 invocation queue 返回 `full` 或让 trigger reject；旧实现已在 fire-and-forget trigger 前提交 cursor 与 `lastNotifiedAt`，状态显示通知成功。

## 根因与修复

- PR：新增单一初始化边界 helper。review comment/decision cursors 固定为 0，仅查询并保留当前 CI 边界；issue 注册继续使用 `fetchLatestIssueCommentCursor()`，避免成熟 issue 的历史评论洪泛。
- Issue：显式 tracking 只过滤真正的 self-echo，不再用 OWNER/MEMBER 角色静默通知；`authorAssociation` 仍写入 community event，供投影状态机使用。
- Wake：等待 `ConnectorInvokeTrigger.trigger()` 的即时接纳结果。`dispatched`/`enqueued` 才更新 `lastNotifiedAt`；`full`、异常或缺失 trigger 会输出包含 task/subject/thread/cat/outcome 的结构化错误，同时推进已路由消息的 cursor 以避免重复消息。

## 验证

- 红测：旧实现下 8 项预期回归失败，分别覆盖 PR 初始化、OWNER/MEMBER、echo 时间戳与 trigger outcome。
- 绿测：API build、287 项相关回归测试及公开 API 全量测试通过（16,650 tests；16,622 pass、0 fail、28 skip）；最终跨个体 review 证据记录在同分支 review request。
