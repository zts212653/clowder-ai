---
topics: [co-creator, nickname, upgrade-compatibility, issue-1713]
doc_kind: bug-report
created: 2026-10-30
tips_exempt: 称呼字段直接显示在已有个人资料编辑器中，并内联说明留空行为；不另加随机提示。
---

# #1713 默认称呼与显式昵称

来源：[Issue #1713](https://github.com/zts212653/clowder-ai/issues/1713)。
用户要求默认去除“大当家”（此前实际没有使用），保留后续手动修改。

## 行为与兼容边界

旧模板预填了 nickname，后续版本开始在上下文中使用它，字段存在并不能证明用户选择。
新模板不再预填；共享显示规则把缺少选择记录的旧“大当家”保留为待确认原值，默认显示
`co-creator`，角色使用 `operator`。编辑其他资料不会激活该原值。

新版“设置 → 你”和聊天个人资料编辑器均增加可选“称呼”字段，留空恢复默认。手动提交称呼时记录
`nicknameSource: "user"`，允许主动选择“大当家”；保存、清空及重载遵循同一规则。
配置响应保留原值与来源，Web、API 历史/导航和 MCP 展示使用同一共享解析。
稳定身份、@ 标签和已存消息内容不变。

| 配置历史 | 显示结果 |
| --- | --- |
| 没有 nickname | co-creator |
| 历史“大当家”，没有来源记录 | co-creator；原值保留，编辑器提示可重新设置 |
| 已有其他自定义昵称 | 保持原昵称 |
| 用户通过编辑器主动选择“大当家” | 大当家，来源记录随配置持久化 |
| 用户清空称呼 | co-creator，重载仍保持 |

历史数据无法区分“旧模板带入的大当家”和“曾手工填写了相同值的大当家”。本补丁不宣称能
还原这段意图，也不删除原值；**没有来源记录的同名历史选择需要重新确认一次**。这是候选
PR 的显式兼容取舍，需要维护者审查，不能把新增来源标记冒充历史来源证据。

## 验证

隔离工作树：`cat-cafe-co-creator-nickname`，基线 `4ef8e7404a0f17a5750fdaba974f229647300281`。
测试只使用临时 catalog；未修改正在运行的用户配置或重启 Host。

- RED：新增 API 回归先观察到 4 项行为失败；Web 回归先观察到缺少称呼输入框。
- API 源码回归：`node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import tsx --test test/co-creator-nickname.test.ts test/co-creator-presentation.test.ts`，9/9。
- 已构建 API 编辑路由：同 wrapper 下 `node --test test/config-co-creator-route.test.js`，6/6。
- Web：`pnpm exec vitest run src/components/__tests__/hub-co-creator-editor.test.tsx src/components/settings/__tests__/you-profile-save.test.tsx`，5/5；新版入口新增测试先因缺少字段失败，再转绿。
- MCP：`node --import tsx --test test/co-creator-presentation.test.ts`，2/2，覆盖 invocation 与 agent-key 展示刷新。
- shared、API、MCP 构建及 Web TypeScript 通过；修改文件 Biome 无错误，保留既有警告。
- `pnpm check:capability-tips` 通过，既有 10 条无关 anchor/path 警告保留。
- `pnpm check:architecture-ownership` 在此仓库不存在（exit 254），不记作通过。
- fallback 扫描触发两处数量提示：测试中的四个 `??` 是清空后的预期值；编辑器中的两个
  `?? ''` 分别初始化/重新打开表单，`trim() || null` 把清空编码为 API 的明确删除操作。
  它们是显示值和写入值的边界转换，不是失败后叠加的数据源，不合并成隐藏语义的兜底层。
- hotfix 检查识别 `fix` 提交并以 exit 2 要求非作者审查；按该要求交独立 reviewer，不自合并。

## 浏览器验证及其范围

在本工作树 `http://localhost:3155`，用真实 `HubCoCreatorEditor`、共享显示 hook、实际
Fastify 配置路由与临时 catalog 走通：打开旧配置 → 不改称呼保存 → 设置“小明” → 重载 →
清空 → 重载 → 主动设置“大当家” → 重载 → 手机宽度清空。每步同时核对 API 历史署名
`getSenderName(null)`。全部请求 200，无页面异常；桌面和手机下字段可编辑、保存可达。

独立审查发现 V2 的“设置 → 你”实际使用 `YouProfileCard`，首版漏掉此入口，已当轮补齐。
在同一隔离服务器 `/you` 对真实资料卡验证设置“小明”、清空、主动选择“大当家”，每步
重载并核对显示及历史署名。桌面与 390px 手机宽度的截图已检查，字段和保存按钮正常可用。

这是实际编辑器/资料卡与路由的隔离浏览器验证，不是整套 Hub 的安装升级验收。
入口接线另核对 `SettingsContent → YouSettingsPage → YouProfileCard`、经典成员页与
`ThreadChatSurface → HubCoCreatorEditor`。浏览器脚本在编辑器配置填入后操作输入框。

本地证据位于工作树 `.cat-cafe/evidence/issue1713/`（日志、浏览器结果、截图）。
托管预览 `origin=launchd`；Hub 投递结果 `unconfirmed/no_matching_client`，不宣称用户已看见。
当前运行实例仍需安装维护者合入后的版本，不能把隔离验证写成生产已生效。

风险：行为与持久化兼容为主要风险；沿用现有配置写入权限与审计，API 增加可选字段，
无身份/路由迁移、无历史消息改写。Architecture cell 为现有 config / co-creator presentation；
Map delta: none，无新增存储、队列或路由系统。
