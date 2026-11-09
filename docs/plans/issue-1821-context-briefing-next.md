---
feature_ids: [F148, F296]
topics: [chat, context-briefing, readability]
doc_kind: plan
created: 2026-11-04
---

# Issue #1821：消息上下文交接卡可读性修复

> **设计状态（2026-11-04）：当前新版 UI 已被使用者明确驳回。** 下文保留为旧实现记录，不代表样式已被接受。PR #1823 已转为 Draft；先在 PR 与维护者讨论卡片定位、默认信息和视觉样式，确认后再更新实现与验证，当前不合入。

> **续接（2026-11-08）：** 新的[标注稿](../design/issue-1821/README.md)已获 zts [具体方向确认](https://github.com/zts212653/clowder-ai/pull/1823#issuecomment-6690153941)，按该稿继续真实组件实现与验证。下文旧版“四行默认态 / 二次展开”不再是现行设计；确认稿和这条维护侧实施边界优先。

来源：[Issue #1821](https://github.com/zts212653/clowder-ai/issues/1821)。
宪宪提供界面方案，砚砚根据真实数据链与浏览器复现收敛实现；非作者审查与合入仍由宪宪完成。
基线为 `upstream/next@997eccf7ca1669d647acbef1a90608bc6b7efa95`。

## 目标与根因

用户看到蓝卡文字重叠，也无法理解用途。保留 F148 的原始目标：让人知道本次给猫提供了什么上下文、略过什么、如何回源核对；遵守 F263 R10，整卡始终可见。

旧实现按窗口宽度启用三列，而聊天列可能很窄。真实组件与产品 CSS 的浏览器复现：
1280px 窗口内卡片约 612px，字段 192px，来源长字符串实际宽度 800px；320/375px 下也会溢出。
同一会话 ID 又在标题、来源与检索指针重复出现。六种字段没有阅读层次，“→你”实际指接收猫。

## 用户可见行为

- 默认显示“上下文交接”、用途说明、接收猫，以及确实记录过的近期消息/历史略过数量。
- “查看详情”显示交接记录和明确关联的依据；“收起详情”回到简明摘要。
- 二次展开“诊断详情”可读原始标题、全部字段、完整正文、检索提示与运行计数。
- 默认态不展示完整会话 ID、工具命令或技术状态码。
- 采用单列、`min-w-0` 和 `overflow-wrap:anywhere`；代码文本也换行，内容可完整读取。
- 其他用途的 briefing 卡保留自身标题、字段和正文。

## 数据链与兼容

`route-serial` / `route-parallel` 在构建 briefing 时传入当前目标 `catId` 和已有 `catConfig.displayName`。
接收者来自实际路由入参，不从发送者、provider、模型名称或标题猜测，也不依赖前端当前可见成员列表。

`format-briefing.ts` 保留既有 `title / fields / bodyMarkdown`，仅添加专用 `meta`：

- `kind: context_briefing`
- `receiverCatId / receiverDisplayName`（有事实时记录）
- `coverageSummary`（构建期覆盖数量的人类摘要）
- `coverageDetails`（原始完整统计）
- 原有 `contextSurfaceProjection`（原样复制）

`ChatMessage` 使用 `systemKind=context_briefing` 识别历史上下文卡；新卡也有 metadata 标记。
`BriefingCard` 在未类型化的 metadata 边界校验一次，内部只使用校验后的显示值。

历史持久化卡没有 `coverageMap`，不得补造覆盖数量。接收名优先展示记录的显示名，其次是记录的 ID；均未记录则显示“未记录”。
不修改或迁移历史数据。原始导航仍留在诊断详情，正常交接行将“→你”明确为接收猫。
无 baton 只说明“未记录交接来源”，不能推断由哪个用户唤起。

`cold/hot` 不等于有没有历史；`T0/T1/T2` 是证据来源等级，不等于投喂/摘要/指针。
保留原码，并说明它们用于诊断、不表示任务是否完成。

## 实现范围与验证

生产改动仅涉及 formatter、两个路由调用点、`ChatMessage` 与 `BriefingCard`。
不改变实际投喂、continuity、证据等级、路由选择、TTL、持久化生命周期或 shared schema；没有新外部依赖。

验证使用隔离工位和合成数据，不连接用户 runtime 的 Redis/SQLite：

1. API：新增 receiver/coverage metadata 的 RED → GREEN；保留旧导航与 non-routing envelope 的检查。
2. 路由集成：真实 serial/parallel 最终世代卡记录实际接收者，并维持 F296 projection 契约。
3. UI：默认摘要、旧卡/错误 metadata、无来源/无交接、展开/收起、其他 briefing 类型。
4. 浏览器：1280px 窗口内窄聊天列、历史卡、320px、375px 深色；逐元素测量溢出，确认命令二次展开可读并截图。
5. 受影响格式、类型与适用 CI；最终 exact HEAD 交非作者审查后合入 `next`。

五轴风险：行为面为展示变化；数据面无迁移；安全面不增加权限；内部 metadata 为向后兼容增量；合入已有用户授权。
回退可撤销本修复提交，旧版仍能忽略新增 metadata，不需要回滚用户数据。

## 交付边界

PR 目标为 `next`，以远端 MERGED、merge SHA 和对应分支回读为合入凭据。
此次不更新用户正在使用的安装版 runtime，不把组件样张称为安装版验收。
