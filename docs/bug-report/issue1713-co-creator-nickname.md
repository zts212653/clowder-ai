---
topics: [co-creator, nickname, upgrade-compatibility, issue-1713]
doc_kind: bug-report
created: 2026-10-30
tips_exempt: 称呼直接显示在两个现有资料编辑入口中，并内联说明与名称的区别及留空行为。
---

# #1713 预填 co-creator，称呼可编辑

来源：[Issue #1713](https://github.com/zts212653/clowder-ai/issues/1713)，候选修复
[PR #1775](https://github.com/zts212653/clowder-ai/pull/1775)，目标分支 `next`。

## 当前范围（2026-11-02 修订）

用户明确要求：保留预填，初始称呼为 `co-creator`，允许后续手动修改。
维护者在 [18:23 正式请求修改](https://github.com/zts212653/clowder-ai/pull/1775#pullrequestreview-5735096177)
中明确了旧安装的验收：来源不明的旧模板同名值，在用户明确选择前不能用于界面称呼、
历史/导航上下文与 MCP。该一次重确认的兼容取舍已获维护侧确认。

- 新安装的模板和 runtime catalog 预填 `nickname: "co-creator"`，初始化 owner 说明使用 `co-creator`。
- 缺少明确选择记录的历史“大当家”保留原始字段，但不作为默认显示或上下文署名。
  这是针对有争议原值的兼容政策，不是认定其历史来源。
- 其他已有自定义昵称保持生效。用户主动设置任何昵称（含同名“大当家”）后，
  写入 `nicknameSource: "user"`，保存与重载保持生效；清空时记录明确清空并恢复默认。
- 只有 PATCH 实际携带合法昵称或明确清空操作才写入选择记录；修改其他资料、
  或调用方仅传来源标记，不会激活旧值。
- 两个资料编辑器用共享规则初始化输入框，并提示旧原值未启用、可重新选择。
  未编辑称呼时不提交该字段。名称与称呼的用途、留空行为均有内联说明。
- Web、API 历史/导航署名及 MCP 由同一共享解析控制。稳定身份、@ 路由和存储消息正文不迁移。

| 配置 / 操作 | 结果 |
| --- | --- |
| 新安装 | 预填并使用 co-creator |
| 旧 catalog 没有 nickname | co-creator，不重新继承模板值 |
| 历史“大当家”，没有选择记录 | co-creator；原值保留，编辑器提示可重新选择 |
| 已有其他自定义昵称 | 保持原昵称 |
| 明确手动选择“大当家” | 保存、重载后生效 |
| 只编辑名称 / 头像，或只传来源标记 | 不确认旧昵称 |
| 明确清空称呼，包含仍使用旧模板的安装 | co-creator，重载不带回旧值 |

## 升级兼容边界

历史数据无法区分模板带入与过去手动选择了同名值。本轮不宣称还原历史意图，
保留原值供恢复，但要求这类同名历史选择重新确认一次。新来源标记只记录本版之后的
明确操作。`80386a798` 中“所有已有昵称立即生效”的候选范围已被本次最终验收取代。

## 验证

隔离工作树 `cat-cafe-co-creator-nickname`，基于
`next@74b5bfd4d59c3722c76140d9df36e332b72a0acd`。只使用临时 catalog 和测试数据；
未修改运行实例配置或部署本补丁。

- 本轮 RED：通过真实 `loadResolvedCatConfig → getCoCreatorConfig → getMessageSpeakerName`
  复现旧值直接进入上下文署名（实际大当家、预期 co-creator）。API 4 项失败，两个 Web 入口各 1 项失败；修复后转绿。
- API 源码昵称 / 展示回归：9/9。
- 已构建配置路由与 catalog 初始化回归：50/50。
- Web 两个资料入口：5/5。
- MCP invocation / agent-key 展示刷新：2/2，包括旧同名值未确认时不生效、明确选择后生效。
- shared、MCP、API 构建及 Web 类型检查通过。
- 隔离浏览器在两个实际编辑组件与 Fastify 配置路由间走通预填、修改、清空、重载及旧值编辑；
  桌面与 390px 手机视口均已查看，18 次请求全部 200，无页面异常。验证使用临时 catalog，
  并非整套 Hub 安装升级验收。
- 修改文件 Biome 检查无错误；既有警告保留。`check:capability-tips` 通过。

源码回归命令（packages/api）：
`node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import tsx --test test/co-creator-nickname.test.ts test/co-creator-presentation.test.ts`。
已构建回归使用同 wrapper 执行 `node --test test/config-co-creator-route.test.js test/cat-catalog-store.test.js`。
Web 使用 `pnpm exec vitest run` 执行两个资料编辑器的测试文件；MCP 使用隔离 callback outbox wrapper。

已知验证限制：既有 `co-creator-presentation.test.ts` 的三个 URL.pathname 用例存在 Windows
路径兼容问题，本轮未在 Windows 执行；不能用 macOS 的通过结果覆盖该限制。

Architecture cell：现有 config / co-creator presentation。Map delta: none。
未新增存储、路由、队列或鉴权边界。PR 仍须非作者独立审查；测试通过不替代批准与合入。

## 来源与历史

最初候选为 #1744，后按贡献约定迁移至 next 上的 #1775。本轮保留新模板预填 co-creator，并补齐维护侧最终确认的旧值重确认策略；此前的审查与 CI 不能替代对修订后 HEAD 的独立审查。
本地证据在 `.cat-cafe/evidence/issue1713/`，包括本轮 RED、构建与浏览器结果。
