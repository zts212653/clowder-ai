# #1821 / #1823：上下文回执标注稿

**状态：设计提案，等待 zts 确认。此目录不改变产品实现，也不表示设计验收、代码批准或允许合入。**

鲸鲸负责视觉与交互初稿，砚砚负责字段来源核对、整合、浏览器样张与 PR 跟进。所有消息、交接内容、编号和路径均为合成样例，不包含真实会话。

## 审稿入口

- [交互稿](design-proposal.html)：下载后用浏览器打开，可切换尺寸、主题、默认/展开态和历史缺字段样例。
- [设计说明](design-notes.md)：视觉取舍、标注及实施约束。
- [数据边界](data-contract.md)：每类显示信息的现有来源，以及历史卡片不能推断的内容。
- [原问题 #1821](https://github.com/zts212653/clowder-ai/issues/1821) / [原 PR #1823](https://github.com/zts212653/clowder-ai/pull/1823)。
- [zts 的出稿边界](https://github.com/zts212653/clowder-ai/pull/1823#issuecomment-6684464391) / [最新出稿分工澄清](https://github.com/zts212653/clowder-ai/pull/1823#issuecomment-6689476983)。

## 需要确认的设计

1. 默认态是否能从一句实际摘要理解“给哪只猫、提供什么”，并在消息流里保持可见、安静和可辨认。
2. 一个详情入口是否足够明确；展开后的交接/来源与诊断是否分清主次，完整信息是否仍能找到。
3. 600px 聊天列、320/375px 窄屏、浅深主题及历史缺字段样例是否采用同一套可接受的样式。

请直接在 PR 中指出具体样张、标注编号或交互稿里的元素。布局不溢出只是排版检查，不能代替上述视觉与阅读体验确认。

## 样张矩阵

样张由 [capture-proposal.mjs](capture-proposal.mjs) 从同一份 HTML 生成；完整截图和实际测量结果放在 `screenshots/`。浏览器视口为下列宽度，卡片的实际可用宽度另记在 `measurements.json`，不把视口宽度当作卡片宽度。

| 样例 | 视口宽度 | 主题 | 状态 |
| --- | --- | --- | --- |
| 新卡、已记录接收者与交接摘录 | 600 / 375 / 320px | 浅 / 深 | 默认 / 展开 |
| 历史卡、缺少新增显示字段 | 375px | 浅 / 深 | 默认 / 展开 |
| 接收者与交接来源均未记录 | 375px | 浅 / 深 | 默认 / 展开 |

关键样张（裁出消息流语境；完整审阅页包含组件外的编号说明）：

| 样例 | 默认态 | 展开态 |
| --- | --- | --- |
| 600px 浅色 | [消息流样张](screenshots/context-modern-600-light-collapsed.png) / [带标注全页](screenshots/modern-600-light-collapsed.png) | [消息流样张](screenshots/context-modern-600-light-expanded.png) / [带标注全页](screenshots/modern-600-light-expanded.png) |
| 600px 深色 | [带标注全页](screenshots/modern-600-dark-collapsed.png) | [带标注全页](screenshots/modern-600-dark-expanded.png) |
| 375px 浅色 / 深色 | [浅色](screenshots/modern-375-light-collapsed.png) / [深色](screenshots/modern-375-dark-collapsed.png) | [浅色](screenshots/modern-375-light-expanded.png) / [深色](screenshots/modern-375-dark-expanded.png) |
| 320px 浅色 | [带标注全页](screenshots/modern-320-light-collapsed.png) | [带标注全页](screenshots/modern-320-light-expanded.png) |
| 320px 深色 | [消息流样张](screenshots/context-modern-320-dark-collapsed.png) / [带标注全页](screenshots/modern-320-dark-collapsed.png) | [消息流样张](screenshots/context-modern-320-dark-expanded.png) / [带标注全页](screenshots/modern-320-dark-expanded.png) |
| 历史卡，375px | [浅色](screenshots/legacy-375-light-collapsed.png) / [深色](screenshots/legacy-375-dark-collapsed.png) | [浅色](screenshots/legacy-375-light-expanded.png) / [深色](screenshots/legacy-375-dark-expanded.png) |
| 缺字段，375px | [浅色](screenshots/missing-375-light-collapsed.png) / [深色](screenshots/missing-375-dark-collapsed.png) | [浅色](screenshots/missing-375-light-expanded.png) / [深色](screenshots/missing-375-dark-expanded.png) |

## 整合核对

- 合成任务为“侧栏菜单窄屏可见性”，所有会话 ID 使用固定虚构字符；未把当前私有线程或真实交接消息放入图稿。
- 默认态只取已记录交接摘录的首句；展开只展示完整摘录，不宣称拥有原消息全文。
- 历史卡不拆旧文本推断接收者；交接字段在详情中原样保留，缺失覆盖不写成零。
- 来源使用既有 `selectDirectiveSources` 筛选结果；不把首个未筛选候选直接当依据。
- 20 个样张组合经过逐元素宽度检查；详情入口同时经过指针、键盘、`aria-expanded`、内容显隐和 URL 状态一致性核对。实际尺寸、HTML SHA-256 见 [measurements.json](screenshots/measurements.json)。
- 摘录、来源的结构化展示字段需要实施时补充；本稿没有改共享的 `extractBatonContext` 或上下文投喂语义。历史数据的完整保留仍是实现验收条件，不能因为样例只画了部分字段就丢掉其余记录。

复现方式（在本修复 worktree，已安装 web 开发依赖和 Playwright Chromium）：

```sh
node docs/design/issue-1821/capture-proposal.mjs
```

该脚本只加载本地合成 HTML，不连接模型、会话服务或数据存储。生成结果只说明此提案的渲染表现，不是生产组件、安装版或运行时验收。

## 后续顺序

具体样式确认后，原作者继续在本 PR 调整实现、同步 `next`，按最终实质改动验证并做非作者独立审查。原始 Issue 和 Task 持续跟踪到远端实际合入 `next`；旧版本的技术通过记录不充当新设计的批准。
