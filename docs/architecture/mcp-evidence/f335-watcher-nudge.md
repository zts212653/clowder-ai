---
doc_kind: mcp-evidence
feature_ids: [F335]
related_features: [F191, F254]
topics: [watcher, thread-message, authority-boundary]
created: 2026-11-02
owner: codex61-sol
description: "守望猫递一句的已接受权限：固定工作猫收件人、原消息与 Queue、岗位鉴权和六次工具边界。"
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/mcp-evidence/f335-watcher-nudge.md"
mcp_admission_claims:
  - ref: "file:docs/architecture/mcp-evidence/f335-watcher-nudge.md"
    toolName: cat_cafe_watcher_nudge
    resourceFamily: thread-message
    boundaryKind: authority-boundary
    decision: accepted
description_source: model
description_author: codex61-sol
description_updated_at: 2026-11-02T21:40:00Z
description_generated_by: codex61-sol@gpt-6.1-sol
description_generated_at: 2026-11-02T21:40:03.321762Z
description_confirmed_by: codex61-sol
---

# 守望猫递一句：已接受岗位的固定收件边界

来源是 F335 的出手①、KD-2 / KD-5，以及本次交付一的原工作包：`[thread-id]#private-source-id`；operator 原开工来源为 `[thread-id]#private-source-id`。AC-02 的岗位工具白名单与受控出手设计由非作者 Gemini Argon 审过，回执 `[thread-id]#private-source-id`，设计 HEAD `b8e2596b0e8a8381ed818a1944c617fddda49004`。产品代码仍需独立审查。

`cat_cafe_watcher_nudge(sentence, sourceMessageId)` 实现这条已接受的受限权限。它属于既有 thread-message，不创建新资源或通信队列；只可由服务端登记的 watcher 调用，收件猫和线程从本轮已结束的 ordinary child 推导，模型不能填写。暂停、关闭、免打扰或更换值班成员后不能递话。每个工作 child 的消息按原 MessageStore 幂等键创建，用原 Queue 投下一轮。

通用 `post_message` 可以选择收件人、发起协作并携带其他 workflow carrier，不能把它整个暴露给观察岗位。单独入口的理由是这个固定收件、没有交接权的权限边界；不是按文案、provider 或 UI 增生同类工具。①的 Message 仍由原消息 owner 持有；②和回执使用交付二的通用工具与动作表。

验证入口：`watcher-callbacks.test.js`（鉴权、跨用户来源拒绝、固定 target、免打扰重试、六次预算），`watcher-consumer-native.test.js`（真实原生工具调用和续用），以及最终产品代码 review。
