---
feature_ids: [F309]
related_features: [F063, F310]
topics: [text-patch, modification-return, source-custody]
doc_kind: contract
created: 2026-09-20
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/f309-text-modification-contract.md"
mcp_admission_claims:
  - ref: "file:docs/architecture/f309-text-modification-contract.md"
    toolName: cat_cafe_read_content_modification
    resourceFamily: collaborative-content
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/architecture/f309-text-modification-contract.md"
    toolName: cat_cafe_respond_content_modification
    resourceFamily: collaborative-content
    boundaryKind: resource-entry
    decision: accepted
description: "F309 普通文本修改的具名工具契约：人类来源→具名 Task→typed text return→隔离 patch→可见 diff→独立人类接受→F063 CAS 写回。"
description_source: human
description_author: opus55
description_updated_at: 2026-09-24T12:52:25Z
---

# F309 普通文本修改入口契约

这是已接受的 Step1 §4.2–5.1 (internal) 文本 producer 的具名工具坐标：人类来源 → 真实具名 Task → typed text return → 隔离 patch → 可见 diff → 独立人类接受 → F063 CAS。
产品授权为父线程 source `private-source-id`；Opus5 对技术合同的批准基线是 `f4035c58cec4a25a0a04d99cc50fabd637bb1658`。
实施团队在这个已审范围内确定下面两个工具名；本登记不代表实现 review、合入、Alpha、产品验收或生产启用。

普通文件请求以 requestId 定位，没有媒体 round、F138 媒体 contentRef、Office provider session 或 F290 多人协作 owner。
塞入媒体工具需要伪造媒体坐标；塞入 Office 工具会把 provider 编辑权限错误套到 F063 文件上。两者保持在现有 collaborative-content family。

| 入口 | 身份边界 | 真实效果 |
|---|---|---|
| cat_cafe_read_content_modification | callback 认证猫、精确执行 thread、Task 具名 owner；正文另查 fresh F063 源权限 | 文本读取持久意图、原文快照和提案历史，只物化隔离执行副本；显式 control 页适用于媒体/文本请求，不物化或返回正文 |
| cat_cafe_respond_content_modification | 同一身份、开放 Task/revision、proposal CAS；同 operation 重放原回执 | 保存有作者的 patch/说明和隔离候选；不写原文件，不关闭 Task |

读取以精确 JSON 文本分页：保留 snapshot，依 nextCursor 拼接 json 字段再解析。Patch 使用不可变原文的 UTF-16 区间，排序、不重叠，并携带精确 expectedText。
候选保留 baseRevision、作者、operation 和 receipt。后续提案仍针对原 base，不静默重基到已变更的文件；非法 UTF-8 不解码成可写的替换字符文本。

媒体/文本请求可按精确 requestId 读取 view=control，媒体同时传原 reviewId 作额外匹配。该页独立核对持久 Task 绑定、当前具名 owner 与执行 thread，只返回请求状态、取消/拒绝事实和 Task 坐标；来源撤回后仍能知道本请求已取消或 source_unavailable，不返回 intent/sourceRef/bytes，不授予读取其他工作的权限。独立 snapshot 防止跨状态拼页；来源正文仍走原媒体/文本 owner。新媒体 outbox 行由原事务携带 requestId 并提示这一入口，旧 pending 行不回填，不改变原 carrier 或 winner。

HTTP 接受动作只允许真实 human，候选从请求 owner 读取，不消费浏览器自报 bytes 或任意 URL。
接受时重新核对 F063 worktree/path/token 和源权限；token 仅证明 worktree/过期时间，不代表用户身份。
人类接受回执与 F063 文件 applied 回执是两个事实；候选只到 result-ready。Task 原 owner 最后消费真实证据，按原条件显式关闭 Task。

人类可明确“不采用此候选”：同一request/candidate保留唯一拒绝回执，原文、候选和Task不被删除或改写，也不自动发起新修改。拒绝与接受在同一SQLite连接内定序；拒绝先成立则禁止接受该候选，已有接受决定则先核对原文件效果，不能借拒绝回滚。响应未知时保存同一候选的待核对决定，刷新只读回执，不重选候选。新候选仍需真实猫的独立返回及人类接受。

默认MCP读取包含rejections，proposals页为已拒绝项附humanRejection；两者都是有actor/time/ref的人类事实，不改猫的原proposal。拒绝会更新request读取revision及分页snapshot，禁止拼接决定前后的页面。

artifact_review_returns 为新请求增加 request_text_edit 判别，不修改旧媒体 JSON。文本 human decision、return intent 和 request journal 使用同一 SQLite connection 的事务。
MessageStore 和 TaskStore 仍是独立 owner 的可回放提交。部署前格式的 pending 媒体行必须在新代码重启后投递到同一个 queue winner。

F063 支持的应用写者在单 API 进程串行；不把 SHA 检查加 rename 宣称为对外部非协作编辑器的原子操作。
恢复时 hardlink 保持 inode 存活直到 applied 回执持久化；相同 bytes 的其他 inode 不证明本次操作，同 inode 后续改动单独显示当前漂移。
证据缺失或替换歧义保持 unknown。读取可补齐已证实效果的回执，不能重放文件写入。文件及 proof 目录的 fsync 先于 applied 回执。

定向验证：content-modification-routes.test.ts、content-modification-text.test.ts、artifact-review-delivery.test.ts、workspace-writeback.test.ts。
完整用户旅程、最终实现审查及合入后 Alpha 仍按 Phase U 计划推进。
