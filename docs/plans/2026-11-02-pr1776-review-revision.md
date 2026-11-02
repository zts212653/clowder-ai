---
feature_ids: []
topics: [plugins, acp, permissions, runtime-interaction]
doc_kind: plan
created: 2026-11-02
status: implemented-awaiting-review
---

# PR #1776 评审修订实施契约

依据：[mindfn 的三项 P2](https://github.com/zts212653/clowder-ai/pull/1776#issuecomment-6572823673) 及 YukinaXSer 对 `cddfc25179c6eda69fd98f64ba1c6540c28ca3dd` 的 REQUEST_CHANGES。用户本轮授权分析、修复、回归并更新同一 PR，目标仍为 next，禁止合并。

用户已明确默认行为：保留现有 auto，需要时选择 ask user；复用 Host 成员执行设置和既有消息确认生命周期，不为固定插件再设授权开关。

Architecture cells：plugin（包与生命周期）、agent-runtime（执行边界）、runtime-interaction（确认与回复）。不新增授权表、交互存储、消息通道或客户端专用身份。旧包版本/摘要、连接原文、实例/角色 ID 和历史不迁移、不覆盖。

## A. 发行来源与能力解耦

- 删除 bundled 的 builtin/ACP 特殊准入 helper。bundled 分支只负责已注册发布身份及确切字节；stdio、声明资源、ACP 声明等由所有归档入口共用能力校验。
- 校验存在的 ACP 声明；无声明意味着没有这项能力，不把合法静态资源包错误要求为 ACP。无效声明和不支持的 runtime 在各来源一致拒绝。
- 保留已有 Host 模块、静态资源、声明注册、stdio 外部运行和停止/恢复能力。执行承载按已校验 manifest 选择，不按发行来源赋权；不通过删除 builtin 字段破坏 Dot 等现有能力。
- 构建同样使用能力校验，声明和执行文件进入真实归档。旧 Dot 产物字节不变；不重打已发布版本。
- 验证同字节 bundled/local 的 stdio、ACP、静态资源正例与无效声明、摘要/身份、路径/链接、不支持 runtime 负例。失败更新保留旧实例/配置。

## B. ACP 权限交互

- Host 成员级统一 auto/ask user 设置；原生 ACP、固定插件和客户端目录共用。默认 auto；仅在现有成员配置入口增加必要的选择，不另建插件授权入口。
- 不再给固定客户端注入缺省 deny，未指定策略的各接入形态统一沿用 auto。按 zts 的复审要求保留显式声明/已保存 deny/auto_allow 语义及 owner 自动允许确认边界；Host ask user 在已有允许范围内增加确认，不能覆盖拒绝。连接原文不重写，root-only 审计例外仍禁止权限或其他非 root 字段变更。
- 每次调用将 handler 绑定到精确 provider session、thread、invocation 和用户；auto 只选择客户端实际提供的 allow 选项，ask user 通过 RuntimeInteractionPort 发布已有 approval 卡片并等待用户回复。
- 回复仅可选择原请求的有效选项。取消、过期、调用结束或连接丢失不能误放行；清理 handler 和待决交互，禁止串到下一成员/调用。保留 iCode/AGY 已有更严格的执行约束。
- 使用既有 RuntimeInteractionService、消息投递、用户响应路由和持久化语义；不新增表或旁路确认 API。

## C. Transport 一致性

- stdio/HTTP streaming 共用默认权限决策和 session handler 语义。明确 reject 必须在两种 transport 都拒绝；无 reject 选项则取消，不能改选 allow。
- 矩阵覆盖 auto、ask user（同意/拒绝）、明确拒绝、无选项、异常、取消与过期。先保留现有反例 RED，再实现 GREEN。

## 执行与证据

顺序：共同权限决策反例 → 所有来源能力准入/构建 → Host 策略与 Runtime Interaction 接线 → 成员设置 → 完整旅程回归 → 文档/PR 回应。

作者验证必须包含真实编译 client（无进程/无网络）的两 transport 矩阵、真实 Manager 安装/更新/重试、真实 RuntimeInteractionService/消息发布与用户响应回到 ACP 请求。协议 fixture 的边界仍明确，不冒充企业 CodeAgent/RelayAgent 模型验收。

本轮不修改系统盘/祖先 ACL，不操作运行实例或原生客户端历史。CI、回归结果绑定最终新 HEAD；旧绿灯和旧 local approve 仅作历史记录。更新 PR 后请求维护者复审，不自行解除 REQUEST_CHANGES 或合并。

## 验证回填

实现与失败处置见[本轮验证记录](../review/2026-11-02-bundled-acp-admission-validation.md)。原有显式策略按 zts 的复审保留；没有 strip/重写 connection。默认 auto 只统一未设置策略的情况。当前实现已完成作者回归，等待维护者对最终 HEAD 复审，不视为已批准合入。
