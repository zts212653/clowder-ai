# Issue #1964：整理期间保持可见布局

## 松手处的可见解释（2026-11-16）

[维护者复审](https://github.com/zts212653/clowder-ai/pull/1969#pullrequestreview-5914866918)已确认新壳、
240px 离屏虚拟行反例转绿，接受显式 manual、紧凑标记和稳定字重；仍要求无效拖放在源行给可见解释。
与鲸鲸按 visual-design 收敛为「源行标题内短句 + 整理条完整操作说明」：短句只盖原标题第一行，
不进入文档流，不挤图钉/时间或邻行；读屏仍只由原 full status 播报，沿用原 4 秒时限，不加 portal。
布局直接跟随 ThreadItem 的标题 span，避免普通行 mx-2、组内行 mx-0 的不同内边距导致手写定位偏移。
标题原尺寸保留，第二行不遮盖，提示消失自动恢复。recent/running-first 无写入，manual 行为不变。

验证：新增可见文本/读屏/消失检查先出现 5 项预期失败；修后相关 9 文件 129 项、Web 类型与 6 个
代码文件 Biome/边界/tips/diff 检查通过。完整 canonical Chromium 1/1、exit 0，140.6 秒测试/
146.8 秒总计，旧 258 次几何观测与 manual 插入线/HTTP 保存仍通过；新增 240px 中英文、
recent/running-first 四种长列表下方场景，三行坐标在提示出现和 4 秒消失后均一致、无归属写入。
短句实际宽度不截断，图钉命中保持可达；一行深色及两行中英文实屏均已查看，pageerror=0。
新旅程先完整显示鼠标操作双方，避免把浏览器为裁挡目标自动滚动误计为布局位移，没有产品补偿逻辑。
实物：[中文源行](assets/issue1964/240-source-row-feedback-zh.png)、
[英文源行](assets/issue1964/240-source-row-feedback-en.png)，均为隔离合成数据的 2x 截图。

合入后的 B3 回流应把维护者已接受的 manual 范围、紧凑状态/稳定字重，以及最终批准的行处短反馈，
同步到家里的设计真相源；本 PR 不单独修改公开导出的 F277 文档。

## 整理期间首次形成组壳（2026-11-16）

非作者 R5 与[维护者复审](https://github.com/zts212653/clowder-ai/pull/1969#pullrequestreview-5914745332)
找到同型缺口：新建组默认展开，显式收起后仍使用实时子行，新增未读会再次推下目标。
作者组件 12 项先失败；真实 Chromium 原生建组、收起、接收未读后，下方目标从 286px 到 318px。
共同方案沿用现有槽位：只在成功归属命令首次形成本项目组壳时，从本区成员与当前待处理事实
捕获 presence、peek 身份和更多槽。无旧 DOM 的新壳使用语义高度，不另测量；已有组加人不重捕获。
纯布局测试覆盖跨项目首次成壳和当前 decision、已有槽的生命周期；组件覆盖六类事实双向与完成恢复。
普通行的 presence 点与组头现有的单行 presence 是两种现有呈现；本修复不把组头改为点。

修后 9 文件 128 项通过，Web 类型、7 个改动代码文件 Biome、边界/tips/diff 检查通过。
canonical Chromium 1/1、exit 0、136.2 秒；原 246 次观测通过，新增 flat/project/virtual 三条原生
建组→显式收起→未读/运行出现与消失→完成旅程，共 12 次坐标检查，下方目标 top/height 保持一致，
完成后恢复真实未读预览，pageerror=0。独立复审及维护者对最终提交的正式批准仍待。

## 实时状态的布局补齐（2026-11-16）

[后续审查](https://github.com/zts212653/clowder-ai/pull/1969#pullrequestreview-5914388434)
指出外层 ID 布局仍未覆盖组头内部空间：未读预览会推下目标 32px，presence 行会推下 24px。
作者用真实 Chromium 复现 +32px；继续沿同根因发现普通/组内会话的信号折行、阅读留白到期和
时间文案变宽也会改变几何。此前文档给状态高度变化留例外不符合定稿，现已撤回该例外。

实施前与鲸鲸共同收敛为短期槽位，拒绝外盒裁切、冻结旧事实及新增计时器：

- 每份 captured group item 保存自己的 presence、peek ID 和更多槽，避免不同项目的同组分片串位。
  原 peek 变已读仍保留标题和点击目标，撤掉旧徽标；新增 attention 更新 live 总数，完成后再新增预览行。
  更多槽没有剩余时留空，不继续显示旧数量；原 presence 槽清空也保留空间。
- 普通/组内行捕获原 signal 种类、实际高度和折行；已有种类读实时事实，新增种类只在固定 pin 槽显示
  聚合角标。整理期间 presence 用固定宽状态点，未读用点标记，精确数、状态、猫与时长通过既有
  Tooltip/无障碍名称读取；不缩放字、不裁切新事实，也不挤窄标题。完成后恢复日常完整标记。
- 短存原标题字重、时间槽宽和已经显示的阅读留白；时间文案继续更新。虚拟估高和 DOM 使用同一槽位，
  不另加 observer、持久化或排序器。用户明确展开/收起仍可改变该组空间。

验证：组头、普通行、组内行的六类状态双向变化先建立 36 项组件 RED；修后受影响 9 文件 114 项
通过，含已读 peek、更多计数、草稿、split、跨项目及经典壳层回归。真实 Chromium 完整旅程通过，
新增 flat/project/virtual × 原槽有无的 246 次状态/时间变化，核对 source/target 的 top 和 height，
包含 240px 真实 split、长中文标题、unread 1→999、组合状态；页面错误为零。
截图为合成数据：[新增状态](assets/issue1964/300-arrange-live-signals.png)、
[240px 原折行槽](assets/issue1964/240-arrange-split-signals.png)。
Web 类型、变更文件 Biome、projection-boundary、capability-tips 通过；既有来源警告及下文验收局限保留。

## 维护者复核后的补齐（2026-11-16）

[维护者审查](https://github.com/zts212653/clowder-ai/pull/1969#pullrequestreview-5869392296)
及[收藏视图补充](https://github.com/zts212653/clowder-ai/pull/1969#issuecomment-6815211048)指出的缺口成立：
捕获输入只包含已展开项目和 recent/pinned，遗漏了原本收起的项目与收藏单行列表。

共同讨论后，保持日常投影不变，只在进入整理时补捕获：已显示列表复用阅读快照与预览，隐藏项目
（含归档项目）按既有排序/预览规则计算一次，展开时显示已捕获成员，新会话仍等完成后出现。
收藏按原有标题序捕获 plain 列表，实时状态和图钉更新，完成后恢复日常排序。系统会话沿用原有
不可整理入口，不新增能力。保留 plain 视图原有 create/move/remove 命令；成功结果仍更新成员归属，
布局 apply 保持单行和原序，不生成 Group 外壳、不新增工具条入口或存储。

先有 4 项行为 RED，再补出收藏建组意外出现 Group 外壳的 RED。修复后新增入口文件的 12 项通过，
覆盖 active/archived 项目展开、跨项目目标、新会话延后、收藏运行/置顶、create/move/remove、
409/500、60 条额外收藏的真实虚拟入口、置顶页取消置顶及系统页入口边界。
浏览器新增「A 长按 → 展开 B → 拖 A 到 B → 完成」和收藏原生置顶场景，最终结果以 PR 中的冻结提交验收为准。

公开材料只保留公开审查链接，移除实例内部标识。旧的两份公开提交快照仍可访问；最终树清理
不等于 GitHub 历史抹除。拟用 squash 合入，使目标 next 不带旧快照；历史残留及该处理方式请维护者确认。
不擅自 force-push，也不声称改变 SHA 就清除了 PR 引用或缓存。

7 张合成截图移至本计划下的 `assets/issue1964/`，复用仓库同步闭包守护声明的 `docs/plans/`
target-owned 归属；公开 checkout 未包含实际 source manifest，这个核验边界在 PR 明示。
F277 恢复上游原文，源侧设计修订随既有导出链进入；本 PR 不再产生单独的公开 F277 差异。

本轮合流后验收：作者首次 11 个 Vitest 文件 97 项通过，独立复审的 11 文件口径为 99 项通过；
API 构建、Web 类型与变更文件 Biome 检查通过。
canonical Chromium 旅程 1/1 通过（五种视口/视图组合及新增项目展开、收藏置顶路径，页面错误为零）。
已查看[展开收起项目](assets/issue1964/300-project-expand-during-arrange.png)和
[收藏置顶](assets/issue1964/300-favorites-pin-during-arrange.png)截图，并核对 240px 中英文提示不遮挡邻行。
新增浏览器手势最初落在图钉按钮，已改为从行主体操作；两次早期手动排序请求超时未定位稳定原因，
后续诊断与无诊断完整旅程均通过，未据此增加产品计时器逻辑。保留此限制供独立复核。

fallback 扫描触发人工检查：统计包含视图布尔条件和可选偏好的缺省值，并非串联的补救路径。
本次用独立 ID 布局表达整理生命周期；空布局、未设置成员模式与归档容器分别沿既有语义处理，
没有新增服务端 fallback、重试或额外存储。全局 feature-truth 的 F276/F310 ROADMAP 缺项为既有基线，
不记作通过；未运行全仓 gate、默认 AppShell、安装版或 200% 缩放验收。

复审另发现 plain 收藏视图会显示隐藏手动组的插入线，却不移动当前行。已先复现有线且发送
beforeThreadId 的 RED，再将 plain 同组拖放统一为无写入、无线、无提示；跨组成员命令照常保留，
手动调序仍在有分组展示的视图可用。新增三种模式回归后，4 文件 46 项通过（入口文件现为 15 项）。
该小改动复用已独立验证的浏览器 pin/project 旅程，不将其冒充新的 plain manual 原生浏览器验收。
资产同步 guard 在公开 checkout 为 skip，当前 target-owned 登记仍需源侧确认。

以下为前两轮的历史记录，不替代维护者本轮验收。

需求与验收真相源：[维护者定稿](https://github.com/zts212653/clowder-ai/issues/1964#issuecomment-6806861869)。
初版按具名定稿执行；同步 2026-11-14 的 next 后，DESIGN.md 已包含「长按整理时，列表先不动」，
以该设计入口和维护者后续审查为准，保留源文档与公开导出的对应关系。

## 根因与共同方案

旧整理模式显式关闭 v2 排序、丢弃阅读顺序与排序偏好，转为 membership 原序；同时展开预览尾项、
重置阅读高度保护，并在列表前新增工具条。F277 早期设计要求手动整理序，v2 改为缺省最近优先后，
这套切换造成长按瞬间跳变。图钉事实没有被取消。

砚砚与鲸鲸在实施前共同复核并同意：短暂 ID 布局与日常阅读快照分开；显示事实仍关联实时
SidebarSnapshotRow；只复用既有成员排序函数给移入行找位置，不新增排序器、存储或 API。
方案讨论不作为独立代码审查。

- 长按捕获外层位置、完整成员、展开与可见条数；新会话等完成后出现。
- 整理条占用所有 v2 视图已有的 40px sticky view bar，保留统计行位置。
- 仅手动同组拖动画上下边插入线并提交 beforeThreadId；跨组只提交 membership 命令。
- 最近/运行优先同组拖动无写入、无插入线；4 秒提示关联来源行，短文案显示在整理条，不隐式切换模式。
- 移入落在可见区时扩大可见条数，保留原可见成员；落在隐藏尾项时仍隐藏，余数加一。
- 建组替换原目标单行；源组解散保留剩余行原位置；移出放在原组块之后。
- 完成恢复日常排序；经典壳层保留旧整理行为。无运行态配置、真实用户数据或服务端修改。

取舍：整理时分组/标签控件让位给完成入口；切换范围或定位当前会话退出整理。
实时事实变化也保留已显示空间；只在用户显式展开、拖放和完成时按各自规则更新布局。

## 验证范围

原症状先在真实 ThreadSidebar 上建立 RED：flat/project/virtual 三态与新增会话延后共 4 项均失败。
修复后覆盖三态同序、预览、pin、事实更新、最近/运行优先无写入、手动保存重挂载；纯布局测试
覆盖移入可见/隐藏/无余数/收起分支，以及建组、移出、解散和跨组局部变化。

真实浏览器复用仓库 F277 的隔离 Next 与合成数据 API（真实分组 writer），不连接安装版或 Redis。
生产 Sidebar 挂在既有 dev 预览入口；这能证明组件及 HTTP 持久化旅程，不能冒充整套默认 AppShell 验收。
截图与结果保存在系统临时目录 cat-cafe-evidence/issue1964；实际 URL 和坐标由 result.json 记录。
日常主壳接线由未替换的 ThreadSidebar 挂载与受影响回归覆盖。

五轴风险：behavior=侧栏整理状态与拖放；data=沿用用户主动分组写入；security=无变化；
contract=无 API/schema 变化；irreversible=无部署或迁移。
Architecture cell: existing sidebar presentation. Map delta: none.
tips_exempt: 沿用现有入口，不能调序时已提供来源行操作提示。

## 作者验收记录（2026-11-12）

- 8 个 Vitest 文件、67 项通过：既有排序/阅读/预览/分组/图钉回归，以及本次布局和生产 Sidebar 行为。
- web `tsc --noEmit` 通过；12 个变更 TS/TSX/MJS/JSON 文件 Biome error 级检查通过；`git diff --check` 通过。
- `check:sidebar-projection-boundary`：8 项通过；`check:capability-tips`：14 项通过，7 个既有来源警告保留。
- fixture 前置 `pnpm install --frozen-lockfile`、API build 通过，无新增依赖。
- canonical `node scripts/run-with-node-env-test.mjs node --test test/browser/issue1964-arrange-order.test.mjs`
  通过，浏览器旅程 72.3 秒（含 Next 启动），pageerror 为零；普通/项目/真实虚拟窗口全部逐行比较三态坐标，
  240px 深色 + reduced-motion 下额外检查 scrollTop=30 与滚动到底仍能看到完成按钮。
- 原生鼠标拖放显示 2px 插入线，实际 HTTP 保存后重载保持手动顺序；跨组命令无 beforeThreadId，
  其余行顺序不变；只揭示目标组尾项，完成后保留主动揭示选择。
- 虚拟夹具采用额外 60 条会话：超过产品虚拟阈值 50，同时低于隔离 Memory ThreadStore 的 100 条容量。
  首轮 250 条样本触发夹具淘汰旧组，与产品排序无关；纠正样本后完整旅程通过。
- 最终采证未同时编辑源码。此前热更新中的 chunk 错误不计为通过，已用冻结源码重新完整运行。

实物：[浏览](assets/issue1964/300-recent-01-browse.png) ·
[整理](assets/issue1964/300-recent-02-arrange.png) ·
[手动插入线](assets/issue1964/300-manual-insertion.png) ·
[240px 深色提示](assets/issue1964/240-recent-03-recent-hint.png)。
截图均为合成数据。浏览器、Next、临时 API 和临时构建目录由夹具 finally 关闭/清理；工位保留用于审查。

验证裁量：本次只改现有侧栏表现与整理状态；完整 web 类型、受影响组件回归、数据边界守护及真实
Sidebar + writer 的保存/重进旅程覆盖该风险，不跑全仓 full gate。无桌面安装版人工验收、默认 AppShell
全旅程或 200% 缩放声明；运行中标记更新由生产 Sidebar 集成测试覆盖，不声称所有文案高度固定。

## 独立审查 R1 与修正

非作者审查对 `5209b2e` 提出修改要求；修正内容如下，不公开实例内部回执坐标。

- P1 成立：旧 delta 按全局首个组锚点插入，跨项目 move/create 会把来源显示进别的项目区。
  范围审计覆盖 move、create、remove 和源组退化：从捕获列表已有 ID（含隐藏尾项）导出本列表范围，
  只更新来源所在列表；目标成员先与该范围求交，局部不足两人时显示单行。其他列表保持原样，
  不新增第二份 rowIds 状态。move/create/跨项目源组退化 3 项先 RED 后 GREEN。
- P2 成立：原气泡遮挡组头。窄窗没有侧栏外空间，采用 reviewer 给出的固定条方案：可读短提示
  放进既有 40px sticky 条，完整文案关联来源行读屏，并由现有 AppTooltip 提供主动查看。
  未新增 tooltip 定位器或共享组件 API。240px 中文/英文实测不截断、不覆盖相邻行，三态坐标仍不变。
- P3 已处理：整理入口 live announcement；子元素间 dragleave 不清插入线；409/500 不应用 delta；
  classic 工具条、抖动与 pin 点击拦截有直接回归，v2 的 pin 仍可点击。
- [新的使用侧讨论](https://github.com/zts212653/clowder-ai/issues/1964#issuecomment-6813393654)
  提议本次拖动只改归属，并重新确认 manual 的独立需求。原维护者定稿没有被修改；保留已批准的
  manual 分支，PR 请 zts 明确范围，若维护者改变定稿再按新约定调整。不得把“定稿未改”转述为
  “没有新讨论”，也不把尚无回复当批准。

R1 修正后：8 文件 73 项 Vitest、web tsc、13 文件 Biome error 级检查通过；浏览器完整旅程 85.4秒
通过，5 场景含 240px 英文，额外覆盖真实跨项目 move/create 与保存后留在原区，pageerror=0。
[英文窄屏提示](assets/issue1964/240-recent-en-03-recent-hint.png) ·
[跨项目入组](assets/issue1964/300-project-cross-move.png) ·
[跨项目建组](assets/issue1964/300-project-cross-create.png)。临时服务与 lease 已关闭。
最终修正 HEAD 仍须鲸鲸复审、CI 及 zts 正式批准，不将作者自检当作独立审查结论。
