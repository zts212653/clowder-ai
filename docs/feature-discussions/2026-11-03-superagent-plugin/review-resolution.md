---
feature_ids: []
topics: [superagent, plugins, review]
doc_kind: review-resolution
created: 2026-11-04
status: awaiting-rereview
---

# 失败回流的审查修正

原审查：墨墨在 `message:0001793731201819-000850-fa08461b` 批准 Host `ba94bc9aae9e88a81061e755f33f7cf306330581`；在 `message:0001793731201878-000851-d7e607c9` 对插件 `ef70be8b326798478eeaee321c5f75ba4a69f999` 提出 changes_requested。两项均已回读服务端 typed localReviewFact；原批准不表示修正后的插件已获准。

问题成立：Host 生命周期通知携带哈希 ID，线程响应保留原始 invocation ID，插件错误假设二者相等，导致空正文失败无法回到原 Work。原单测将两种 ID 设为相同，掩盖了契约差异。

修正位于插件 `195aa1ba65a6e78b5828e41f08970bd6c47591fc`：接收已发布的终态消息，以消息 ID 在同一 Work 线程中精确读取所属执行成员的响应；失败、取消、中断生成持久 host-failure report，使用响应的原始 invocation ID 幂等。普通执行状态通知只作不带正文的生命周期信号，不再与响应 ID 比较，也不复制 Host 的哈希算法。Host 既有终态发布路径包含空正文响应，可靠订阅负责重放。

## RED / GREEN

- 插件回归使用“原始 UUID 响应 + 哈希通知 + 不同消息 ID 的另一 Work”，先观察 `todo != blocked`，修正后通过。重复终态/通知只在原会话反馈一次，另一 Work 不变，暂停时仍回流。
- 新增 Host 组合场景使用真实 TGZ Manager、Redis、线程投影、终态发布器、SubscriptionDelivery 和 LifecycleDelivery；没有脚本冒充 Host 的 ID 关联方式，也没有调用付费模型。
- 旧候选 9 实跑失败：`artifacts/superagent-installed-8763bbd08f5c40c0bb8351ddacfaac09/`，断点为受影响 Work 仍是 todo。
- 新候选 10 实跑通过：`artifacts/superagent-installed-91b1a63f5a4f4240b7c2ab1ac7b813a3/installed-host-probe.json`。观察到失败反馈回原会话一次、正确 Work blocked、另一 Work 不变、重放不重复；随后原有重启、跨会话反馈、结果及人类接受场景全部通过。
- 插件 15 项检查、typecheck、build/pack 均通过。完整成功路径的原生模型证据沿用前轮；本次没有为刷新绿色状态重跑相同付费场景。

Host 新增内容仅为上述组合检查及此记录，`packages/api/src` / `packages/web/src` 相对已获准的 ba94bc9aa 没有变化。其批准可按 continuity 复用；新增测试仍供同一 reviewer 核查。

同型检索只剩将响应原始 ID 用作内部 report 幂等键，不再存在通知 ID 与响应 ID 的直接相等比较。此次没有新增 fallback 层。默认 fallback 诊断错误扫描 Host 相对 origin/main 的大范围历史，已停止该诊断；未称其通过，本次差异已单独核对。

当前包：`installed-candidate-10/clowder-ai-superagent-0.1.0-alpha.1.tgz`，SHA-256 `866c27199c0d12e9bc720a6247df0c6284dd4d45e0d5a140809867f3e9384069`。候选 9 仅保留作问题复现与原成功路径证据，不再作为当前交付包。独立复审、macOS 与合并后验收仍待完成；未部署当前 runtime。既有 SQLite 隔离事故的边界不变，见 [implementation-verification.md](implementation-verification.md)。
