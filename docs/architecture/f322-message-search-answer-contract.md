---
doc_kind: mcp-evidence
title: F322 同源查找回答卡发布契约
feature_ids: [F322]
created: 2026-10-26
author: codex61-sol
status: accepted-boundary-implementation
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/f322-message-search-answer-contract.md"
mcp_admission_claims:
  - ref: "file:docs/architecture/f322-message-search-answer-contract.md"
    toolName: cat_cafe_prepare_message_search_answer
    resourceFamily: evidence-navigation
    boundaryKind: authority-boundary
    decision: accepted
---

# 猫选原句，随实际回答发布

接受来源：人类 `[thread-id]#private-source-id`、Opus `[thread-id]#private-source-id`，以及 Astra 单次契约裁决 `[thread-id]#private-source-id`。原裁决定义的发布与绑定边界保留。2026-11-06 依 `final-plan.md` §2.1/2.4 与 `[thread-id]#private-source-id` 续办两阶段方案：新卡消费猫选来源，专属生成式判官整层退役；不代签正式页面或整 Task168/J5 验收。

## 入口与预算

`search_evidence(resultUnit=message)` 原 GET 和 readonly 挂载保持只读；普通搜索保留 embedding/hybrid，以相关队列准入后作 relevance 或 K32 time 投影，不起生成式判官。显式写工具 `cat_cafe_prepare_message_search_answer` POST `/api/callbacks/search-evidence/answer`，新操作必须提交猫已读过的来源、当前 contentRevision、原句与选用理由。宿主核当前权限、版本、UTF-16 锚点及正文/引文/批注归属，不再搜索或判断原句是否支持结论。选择理由始终归认证猫，不能冒充系统 supported。

原 query/filter/sort 参数保留为操作摘要和历史重试兼容；新卡以猫的选材顺序为准。独立工具仍使持久写副作用可被工具策略与 readonly 挂载准确拒绝，不暗藏于 GET。原 15s、publicReply、最终准入、取消及 24k 响应边界不变；检索候选池与向量参数不因判官退役改变。

Host 从认证取得 owner、producer；agent-key 明确提供目的 thread，搜索范围 threadId 不充当发布目的地。cloud-conversation 必须使用既有 exact-source return grant，准备时核验并释放该 grant，实际 post 仍走原 grant 提交。没有新授权、预算或重试。

同 owner/producer/operationId 仍只拥有一份持久结果。新操作缺少 selections 在 claim 前明确拒绝，猫可修正同一 operationId；选材核验通过后沿原单 writer claim/complete。重试只读 searching/prepared/failed 或已绑定消息，不重新搜索或推理。省略 selections 仅能续读已存在、摘要相同的 query-only 历史操作；新选材操作重试仍带同一 selections。省略选材不会生成新卡。历史 supported 快照与摘要不重写，损坏或缺失如实不可用。

normal R 每个 invocation 只有一个已接受回答用途。记录仍在 memory SQLite、schema v72、TTL=0；完整 response 只存一份，含 source contentRevision、结构归属及 decision documentRevision。24k 预算中为固定回执预留空间，不扩大结果。

## 唯一快照与消息绑定

`MessageSearchAnswerPublication` 拥有 searchId、响应及其 digest、请求摘要、owner、producer、目的地、schema、创建时间和绑定坐标。prepared 不等于 published。原 serial/parallel completed R（包括无正文终态）、显式 post 和 agent-key post 在原提交处通过同一个 service 绑定。rich 只放 publicationRef；MessageStore 专有原子方法写入 `(messageId, blockId, publicationRef, responseDigest)`。generic append/updateExtra/provider rich/meta 不能制造它。

跨 SQLite/Redis 的中断通过实际消息原件加 Host 绑定核对；reserved 坐标而未写成功不算发布。重复 post 使用原 clientMessageId；normal R 仍使用原 lifecycle response 坐标。重启仅回填已实际 completed 的 R，pending 保留并诚实报告，不靠 buffer consumed、TTL 或 published 布尔值冒认成功。原停/失败/终态输出 fence 不变。

原启动恢复的扫描进度保存在同一记录的 `recovery_order`：NULL只表示实际Host绑定已被观察，数值只表示该记录的扫描轮次。原记录从0开始，新准备记录加入当前轮次，已尝试未完成记录推进到下一轮，避免每次重扫相同前缀或让新记录反复插队。它只影响恢复分页，不作为发布或读取证明。已预留坐标仍可恢复；绑定实际成功才退出扫描，提交后确认回写中断可按同消息修复。仍限1,000条/15秒，不新增队列、timer或搜索。V72对原V71记录仅加该元数据和索引，正文/digest/来源与绑定坐标不重写。

## 读取、转发与 UI

GET `/api/evidence/answer` 只按真实 messageId/blockId 读取，核 owner、原绑定、目的地和当前 source/revision；转发另外核原绑定消息，异步读取后再次检查。撤回不下发旧正文；正文改版不复用旧摘录；已定事实被移除或改变不保留旧标签。无关 Git commit 不使未变的逐行事实失效。损坏/缺失记录诚实不可用，不以手写 rich 降级成“已验证”。

转发显式传原 messageId/blockId/ref，经现有 post 路径重新准入新目的地，仅保存可追溯引用，不复制授权或正文。展示仍复用 `MessageDecisionSummary` 与 `MessageSearchResultRow`，最多三源及状态顺序仅是卡片投影。同次完整有界快照进入“看全部”，mount/刷新/转发不触发搜索；用户明确搜索才是新查询。动作先重读 publication 绑定，再走原 source admission、quote/composer/J5，人的 comment 不被自动填写。

实现与反例见 *(internal reference removed)* 以及同 PR 的 publication、callback、routing、Redis、MCP 与浏览器检查。memory 持结果发布记录，原 message store/response owner 持绑定；F309 媒体发布、RichBlockBuffer、UI 本地快照均不承担此权威。
