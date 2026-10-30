---
feature_ids: []
related_features: [F241, F289]
topics: [pi, acp, sessions, recovery, diagnostics, issue-1704]
doc_kind: index
created: 2026-10-23
status: implementation_verified_peer_reviewed
---

# Issue #1704：内置 Pi 修复方案索引

用户已批准推荐方案并授权实施和提交 PR。实现及分层验证见 [实施报告](implementation-report.md)；下文保留已接受的方案索引，企业机现场验收仍单独记录。

## 推荐结论

保留现有内置 `clowder-pi-bridge` 入口，让 **Pi 原生 session 文件承载可恢复历史**，在桥中补齐持久化、精确 `session/load`、当前 MCP 重建和错误诊断。Host 继续保存应用消息及 session 绑定，不再增加一套历史副本。

首轮空响应同步处理：修复空 delta 阻断最终文本回填等事件转换缺陷，保留 RPC/上游真实错误，并通过真实 Host 路径验证 `empty_response`。企业机首次空响应的实际诱因仍待现场证据确认；诊断能力完善不能代替该项验收。

旧内置桥使用 `--no-session`，其已退出进程的原生上下文无法凭空恢复。应用聊天记录必须保留；不得静默替换 sessionId，也不得把开启新会话宣称为恢复成功。

## 阅读顺序

| 文档 | 回答的问题 |
| --- | --- |
| [推荐设计](recommended-design.md) | 为什么继续修内置桥；ID、存储、恢复、MCP、并发、兼容与回退契约 |
| [实施计划](implementation-plan.md) | 工作单元、实际改动位置、RED/GREEN、依赖及交付门槛 |
| [证据与验收](evidence-and-acceptance.md) | 已证实什么；哪些 PR 可复用；测试矩阵及企业机待补证据 |
| [实施报告](implementation-report.md) | W0 决定、实际实现、来源复用、RED/GREEN 和真实 Pi/LLM/MCP 结果 |

## 工位与来源

| 项目 | 值 |
| --- | --- |
| 工位 | `G:\AIwork\clowder-ai\worktrees\plan-issue-1704-pi-native` |
| 分支 | `docs/issue-1704-pi-native-plan` |
| 设计基线 | public main `c7be47576cada416721ff93230d205417f6c0895` |
| 前轮复现基线 | `74ad585dccefb884d3d9d67367c90a9b5c605442` |
| 原始问题 | [Host #1704](https://github.com/zts212653/clowder-ai/issues/1704) |
| 企业机补充 | [实际内置桥及两代 PID 的评论](https://github.com/zts212653/clowder-ai/issues/1704#issuecomment-6345264766) |
| 既有复现工位 | `G:\AIwork\clowder-ai\worktrees\analysis-issue-1704-pi`，保留原始证据，不在本轮清理 |
| 本工位隔离 | `.env` 指向 Redis 6398；未启动 Redis/API；Pi/LLM/MCP 验证使用独立状态和任务自有接口 |

本地 main checkout 未切换或重置；方案从已更新的 `upstream/main` 提交创建。上述两个 main 基线之间的变化没有涉及 Pi 桥及其冷恢复实现；本轮修复后的真实调用与旧基线复现分别记录在实施报告中。

## 已接受的取舍

1. 推荐采用内置桥原生持久化路线；独立插件桥 #104 作为对照和可借鉴实现，不作为本修复的安装前置条件。
2. 对新会话提供可验证的冷恢复；对旧 `--no-session` 历史如实说明恢复限制，保留用户显式开始新会话的选择。
3. 按两个工作流交付：原生冷恢复，以及首轮空响应的转换修复/诊断与企业现场复验。两项分别记录完成状态。

跨进程写者互斥、Pi 版本能力和 Host 不透明 ID 消费路径已完成 W0 验证；实际决定与证据见实施报告。

## 交付边界

本方案不承担 DSH #1668，不改变成员现有模型、凭据归属或 UI 布局。通用 ACP 的失败回退策略不放宽，仅识别内置 Pi 的精确绑定错误；PR 与独立复核以实际回执为准。

实施后必须达到：新会话首轮、热续聊、池回收后冷恢复、Host 重启后冷恢复、当前 MCP 调用，以及空响应/真实错误分类均有对应证据。正式合入、打包和企业机最终路径验收属于后续实施交付，不由这份计划替代。
