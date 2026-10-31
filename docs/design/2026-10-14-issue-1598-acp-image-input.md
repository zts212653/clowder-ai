---
feature_ids: [F143, F161]
topics: [acp, image-input, regression, evidence]
doc_kind: report
created: 2026-10-14
tips_exempt: {reason: "修复既有图片附件发送链，没有新增产品操作入口"}
---

# Issue #1598：独立图片输入修复

> 本页保留首次拆分时的版本与证据边界。2026-10-15 的 uploadDir P2 修复、当前分支真实产品验证和取消终态缺口见 [更新报告](2026-10-15-issue-1599-validation.md)。

按 [PR #1596 的范围反馈](https://github.com/zts212653/clowder-ai/pull/1596#issuecomment-6167558453)，从统一方案中提取 [Issue #1598](https://github.com/zts212653/clowder-ai/issues/1598) 的既有图片漏接修复。基线为 upstream/main `3c9ea01082de97679b13238da56573df0a0eb9ab`；图片代码提交为 `00dc761c60ad5133175b17e18d3d27280b427394`。

## 修复范围

上传、存储和路由已经保留图片；实际断点是 `AcpAgentService` 未读取 `options.contentBlocks`，STDIO/HTTP 客户端将 prompt 写死为文本。service 现在完整读取既有平台附件并发送标准 ACP text/image blocks；STDIO collect 也接受 blocks，原字符串调用保持兼容。

所有图片在建立/加载会话之前一次读取；主请求、busy 重试、resume-empty 重试使用同一完整字节快照。任一图片不可读、无效或过限均明确报错，不发送部分图片或静默降成纯文本。图片能力必须由 initialize 显式声明；独立冻结快照及 getter 副本防止调用者修改协商结果来启用图片。

只读取平台上传目录中的 `/uploads/`，检查解码路径及 realpath 的目录包含关系，拒绝远程 URL、任意本地路径和静态 junction 越界。沿用每次五张、每张 10 MiB 上限及 PNG/JPEG/GIF/WebP 类型；读取有界，不截断。错误分类是既有 service 错误通道中的图片专用错误码。

最小依赖仅为 prompt 参数从 string 扩为 string 或 content array、读取协商的图片能力，以及附件读取/错误映射。没有带入 #1596 的初始化声明扩展、权限 dispatcher/factory 接线、Turn/Notice 原型、默认服务迁移或工具结果修复。原 factory 和权限处理保持基线行为；本 PR 不证明审批能力完整。

沿 F161 既有 ACP service/client 归属，没有新增配置入口、持久存储或 owner，Architecture Map delta=none。

## 独立分支的验证

在上述图片代码提交重新安装锁定依赖、构建和检查：

| 检查 | 实际结果 | 范围 |
|---|---|---|
| API build | exit 0；F299 14 implementers | TypeScript 编译及构建守卫 |
| 受影响检查 | 273 pass / 0 fail；37 suites | ACP 测试目录及 image-storage |
| 图片专项 | 27 pass / 0 fail，包含在 273 中 | 实际 service、STDIO/HTTP clients；合成 agent |
| Biome | 完整 8 个代码/测试变更文件通过 | Linux CI 的 LF 字节快照，不是全仓检查 |

图片专项覆盖 fresh、busy、resume-empty 的 wire 字节、顺序/MIME、纯文本兼容、STDIO collect、能力未声明/false、协商对象被修改、文件变动后的重试、第二张不可读、数量/大小限制、路径穿越和目录链接。

此次 273 分母没有纳入 `acp-bootstrap-cwd.test.js`、`acp-mcp-resolver.test.js` 或 `image-upload.test.js`。旧版本已独立复现其中 POSIX 权限/斜杠路径断言在 Windows 失败；本次没有在新基线重证这三份测试，也不声称全仓或所有 Windows 检查通过。原始日志在忽略的 `.cat-cafe/tmp/image-api-build.log`、`image-regression.log`、`image-biome.log`，不提交认证和原始会话数据。

## 历史真实样本和验收缺口

[原图片证据](https://github.com/whutzefengxie-ops/clowder-ai/blob/feat/acp-unified-client-plan-1590/docs/design/2026-10-13-issue-1590-acp-unification/image-input-evidence.md) 记录旧代码版本 `feeabe1f` 的 RED→GREEN 和固定 Claude/Codex 真实 PNG 样本。两者各一次 ACP prompt、零工具调用，均识别仅存在于合成图片像素中的随机码及形状。它们是历史证据，没有在本分支重新执行这些模型调用。

另在原 worktree 的未提交 W2 构建完成一次产品 UI 上传→实际 HTTP 入站→Redis 持久消息→现有 factory/service→固定 Claude bridge/model→答案→刷新。API/Redis 随后使用同一数据目录冷重启，回读仍保留两条消息、图片附件及 `PIC-50E1CF` 答案。该样本使用隔离测试配置、禁 hooks/工具且限制预算的 CLI relay，不代替 factory 审批验收，也不是本 PR exact HEAD 的完整 UI 验收；其错误/取消 UI 分支尚未验证。

用户明确要求暂时跳过 CodeAgentCLI/MiniMax；未发现该实际绑定并没有被解释为“不支持图片”。本 PR 不能声称这些版本、账号和模型已经恢复看图，也没有证明这些实际绑定的产品“不支持图片”提示。维护者要求的绑定实测及本分支完整产品旅程仍保留为未完成项，独立 PR 以 Draft 提交审核，不宣称 #1598 已完成产品验收。

这份修复不批准 #1590 的完整 W2/G2、生产迁移或其他 Gate。

## 独立审查及日志指纹

非作者 `/root/image_split_review` 对代码提交 `00dc761c60ad5133175b17e18d3d27280b427394` 独立窄审：无 P1/P2，支持提交 Draft；独立重跑 27/27 通过。同家族独立个体，不称跨家族审查或维护者批准。本报告是此代码提交之后的唯一变更，不改变被审代码。

| 私有原始日志 | SHA256 |
|---|---|
| image-api-build.log | `b2e1404bffe912a8657f9d2bb0d380584d26d98a2cf569c7333fa013c1673ffc` |
| image-regression.log | `543b477d476fecec8047d3d94341cf4a1e20cc4a246b8a2680a7c9483289175d` |
| image-biome.log | `ba537057b90bbe47ad625283ee11de851104598943f1dee93aeac5f3a1032036` |
| image-independent-review.log | `796b778496c20a29354248f501bbb45b5d9fa4aa63a2aefea631889f23fc8b39` |
