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
维护者的 [P2 审查](https://github.com/zts212653/clowder-ai/pull/1775#issuecomment-6573334253)
指出，不能按昵称的字面值或缺少新来源标记推断历史用户意图。本轮据此撤去按值停用旧昵称及
`nicknameSource` 标记方案。模板默认字面值改成 `co-creator`，仍需维护者审查这一默认值调整。

- 新安装的模板和 runtime catalog 都预填 `nickname: "co-creator"`；初始化 owner 的说明也使用 `co-creator`。
- 已有昵称保持其当前行为，包括历史上等于旧模板值的昵称；修改其他资料不会覆盖它。
- “设置 → 你”和聊天资料编辑器都显示实际昵称，允许修改、清空，并解释“名称”用于个人资料、
  “称呼”用于猫收到的对话署名与回复。
- 称呼字段未编辑时不提交该字段；编辑后提交去除首尾空白的值，清空提交 `null`。
  服务端删除清空后的字段，重载仍回到 `co-creator`；原有的无昵称 catalog 不重新继承模板昵称。
- 保存后使用服务端返回的配置刷新 Web 显示；API、上下文与 MCP 保持现有共享解析规则。
  稳定身份、@ 路由与已存储消息正文不变。

| 配置 / 操作 | 结果 |
| --- | --- |
| 新安装，尚未编辑称呼 | 预填并使用 co-creator |
| 旧 catalog 没有 nickname | 继续使用 co-creator，不注入模板字段 |
| 已有任意昵称（含旧模板同名值） | 继续使用已有值，并在编辑器中显示 |
| 将已有昵称改成 co-creator | 保存及重载后使用 co-creator |
| 设置自定义昵称 | 保存及重载后使用自定义昵称 |
| 清空称呼 | 保存及重载后使用 co-creator |
| 只改名称、头像或其他资料 | 保持当前昵称 |

## 升级兼容边界

历史数据不足以区分“旧模板预填值”和“用户手工选择的同名值”。本轮不进行猜测式迁移，
也不以新来源标记为条件停用历史配置。已有安装希望去掉旧称呼时，可以通过可见的称呼字段
改为 `co-creator` 或清空。本 PR 不宣称已经自动恢复所有旧版本升级前的上下文署名；
如需无交互迁移，仍须可验证的版本或迁移状态，不能仅靠昵称值作判断。

## 验证

隔离工作树 `cat-cafe-co-creator-nickname`，基于
`next@74b5bfd4d59c3722c76140d9df36e332b72a0acd`。只使用临时 catalog 和测试数据；
未修改运行实例配置或部署本补丁。

- 本轮 RED：API 观察到模板缺少预填、历史值被停用；Web 两个入口观察到已有昵称被隐藏。
- API 源码昵称 / 展示回归：9/9。
- 已构建配置路由与 catalog 初始化回归：50/50。
- Web 两个资料入口：5/5。
- MCP invocation / agent-key 展示刷新：2/2，包括已有同名昵称仍生效。
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

最初候选为 #1744，后按贡献约定迁移至 next 上的 #1775。旧版删除模板昵称、对历史同名值
要求再确认的策略已被本轮取代；此前的审查与 CI 不能替代对修订后 HEAD 的独立审查。
本地证据在 `.cat-cafe/evidence/issue1713/`，包括本轮 RED、构建与浏览器结果。
