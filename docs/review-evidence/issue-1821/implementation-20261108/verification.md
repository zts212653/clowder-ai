# #1821 / #1823：确认稿的真实组件验证

具体设计方向已由 zts [确认](https://github.com/zts212653/clowder-ai/pull/1823#issuecomment-6690153941)。这里展示 `ChatMessage → BriefingCard` 的实际产品组件及产品 CSS，不是独立 HTML 稿。全部消息、路径、ID 与数字均为合成数据。

当前仅说明实现自验；非作者审查、当前远端检查、正式批准和实际合入仍需完成，不表示已更新安装版 runtime。

## 实物

| 场景 | 样张 |
| --- | --- |
| 约 600px 聊天卡，浅色默认态 | [默认态](modern-1280-light-card-collapsed.png) |
| 同一卡片一次展开 | [展开态](modern-1280-light-card-expanded.png) |
| 320px 视口、深色、完整长值 | [窄屏展开](modern-320-dark-card-expanded.png) |
| 默认态行动警告 | [警告仍可见](mobile-warning-card-collapsed.png) |
| 历史卡完整内容 | [旧标题、字段和正文](mobile-legacy-card-expanded.png) |
| 无接收者、无交接、无覆盖记录 | [缺字段](mobile-missing-card-collapsed.png) |

桌面视口是 1280px，卡片实际为约 612px；窄屏使用 320/375px 视口。[24 份测量](measurements.json)对应 12 个用例的默认态与展开态，各元素和页面均无横向溢出。作者已查看桌面默认/展开、深色警告及历史卡实图；不是仅据 DOM 宽度判定视觉。

## 行为与数据

- 默认态显示实际接收者、已记录交接摘录的首句及交接时间。没有可读摘录则使用已筛选的真实来源或留缺，不把原始命令放在默认态。
- 一个详情入口读取交接/依据、覆盖、诊断、完整 ID 与命令。摘录只称摘录，不冒充原消息全文；删去自明的原始记录页脚说明。
- 新卡在构建期增加 `meta.contextDisplay`。前端在持久化边界校验一次，不从旧文本反推身份，不改共享 `extractBatonContext` 或投喂逻辑。
- 原始标题、字段、正文保留。新展示仅移去构建处可证明有结构化对应的交接/来源正文块，其他任务、记忆、锚点、参与者、候选指针及搜索提示继续可查阅。旧卡没有完整投影时保留全部原文及任意扩展字段。
- 新卡的显式行动警告和历史交接字段中的已有警告标记，在默认态可见。缺覆盖显示“未记录”，不填零。
- 非 context briefing 继续显示自己的标题、字段与展开正文；其样式与交互路径保留。

## RED / GREEN

先补行为检查再修改实现，观察到：

- API 新增两条用例因缺少展示投影而失败；原有用例通过。
- UI 两条用例因默认态没有实际摘录、行动警告不可见而失败；纠正一处测试括号笔误后，已观察到这两条真实行为失败。

修改后实测：

| 检查 | 结果 |
| --- | --- |
| `f148-briefing-card` + `f148-context-briefing` + `f296-b3b4-bootstrap-briefing-convergence` | 52/52 |
| `f296-a2-open-questions` | 5/5 |
| `chat-message-context-briefing` Vitest | 9/9 |
| `test/browser/context-briefing.test.mjs` | 12/12 |
| API build（含 shared / finance / MCP 构建） | 通过 |
| Web TypeScript `--noEmit --incremental false` | 通过 |
| 修改源码的 Biome 检查 | 退出码 0；复杂度、数组 index key 等 warning 不作为通过无警告的声明 |

API 用仓库 `with-test-home.mjs` 隔离 HOME 与测试注册数据；浏览器以 Vite 编译真实组件，通过 Playwright 拦截合成路由 `https://f322-chat-real-page.test/`，不连模型或生产数据。覆盖 600px 左右聊天列、320/375px、浅深主题、历史卡、缺字段、行动警告、长值，以及指针点击和 Enter 收起。

同步最新 `next@0e6469bc2` 后，构建最初发现新增插件契约未安装；按现有 frozen lockfile 补齐依赖后构建通过，未新增依赖声明或改锁文件。

## 风险与边界自检

Architecture cell：`identity-session`。Map delta：none；只改既有上下文回执的构建和显示，没有新增 Store、Router 或责任边界。

行为风险由实际交互和快照完整性检查覆盖；数据风险是兼容展示 metadata，原记录不迁移、不删减。未改鉴权、生产数据、外部依赖或共享上下文协议；本 PR 合入可用单次 revert 回滚，不带部署动作。

默认摘要、接收者、展示投影的降级分别对应实际的新旧持久化格式和字段缺失，不是多次重试或异常吞掉：接收猫只接受已记录名称/ID；摘要只接受实际摘录/筛选来源；无完整展示投影就显示旧原文。没有新增 catch 或从历史文本重构责任的分支。

`check-fallback-layers --base upstream/next` 对组件报告 10 个模式匹配，已逐项核对：`fields`、摘录、首句的空值只归一化为本类型空值；`isContext` 是两个明确标识的布尔判断；接收者使用已记录名或 ID；警告兼容新显式标记和旧交接标记；两处字段 label 的 `||` 是集合成员判断；接收者、覆盖各有一个“未记录”占位。这些不是串行 10 层恢复。浏览器脚本的 3 个匹配中，两处也是用例分类的布尔 OR，另一处是输出目录的显式环境变量/临时目录选择。保留新旧数据坐标的分流，不扩成通用 fallback 框架。

具体样式已接受，不复用旧实现的批准。最终独立审查仍须绑定当前真实 HEAD。
