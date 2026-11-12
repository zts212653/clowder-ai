# Issue #1964：整理期间保持可见布局

需求与验收真相源：[维护者定稿](https://github.com/zts212653/clowder-ai/issues/1964#issuecomment-6806861869)。
当前 next 的 DESIGN.md 尚无该段；本次按具名定稿执行，不猜测未同步的设计原文。

## 根因与共同方案

旧整理模式显式关闭 v2 排序、丢弃阅读顺序与排序偏好，转为 membership 原序；同时展开预览尾项、
重置阅读高度保护，并在列表前新增工具条。F277 早期设计要求手动整理序，v2 改为缺省最近优先后，
这套切换造成长按瞬间跳变。图钉事实没有被取消。

砚砚与鲸鲸在实施前共同复核并同意：短暂 ID 布局与日常阅读快照分开；显示事实仍关联实时
SidebarSnapshotRow；只复用既有成员排序函数给移入行找位置，不新增排序器、存储或 API。
本地讨论回执：0001794451949556-000680-bc65ef3c / 0001794451949778-000681-980a600d。
方案讨论不作为独立代码审查。

- 长按捕获外层位置、完整成员、展开与可见条数；新会话等完成后出现。
- 整理条占用所有 v2 视图已有的 40px sticky view bar，保留统计行位置。
- 仅手动同组拖动画上下边插入线并提交 beforeThreadId；跨组只提交 membership 命令。
- 最近/运行优先同组拖动无写入、无插入线；4 秒提示关联来源行，短文案显示在整理条，不隐式切换模式。
- 移入落在可见区时扩大可见条数，保留原可见成员；落在隐藏尾项时仍隐藏，余数加一。
- 建组替换原目标单行；源组解散保留剩余行原位置；移出放在原组块之后。
- 完成恢复日常排序；经典壳层保留旧整理行为。无运行态配置、真实用户数据或服务端修改。

取舍：整理时分组/标签控件让位给完成入口；切换范围或定位当前会话退出整理。
事实标记可以实时更新，不承诺状态文案高度永远不变；事实不变时进入/完成必须逐行零位移。

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

实物：[浏览](../features/assets/F277/issue1964/300-recent-01-browse.png) ·
[整理](../features/assets/F277/issue1964/300-recent-02-arrange.png) ·
[手动插入线](../features/assets/F277/issue1964/300-manual-insertion.png) ·
[240px 深色提示](../features/assets/F277/issue1964/240-recent-03-recent-hint.png)。
截图均为合成数据。浏览器、Next、临时 API 和临时构建目录由夹具 finally 关闭/清理；工位保留用于审查。

验证裁量：本次只改现有侧栏表现与整理状态；完整 web 类型、受影响组件回归、数据边界守护及真实
Sidebar + writer 的保存/重进旅程覆盖该风险，不跑全仓 full gate。无桌面安装版人工验收、默认 AppShell
全旅程或 200% 缩放声明；运行中标记更新由生产 Sidebar 集成测试覆盖，不声称所有文案高度固定。

## 独立审查 R1 与修正

鲸鲸对 `5209b2e` 的具名 `changes_requested` 回执：`0001794454689782-000722-f201146b`。

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
[英文窄屏提示](../features/assets/F277/issue1964/240-recent-en-03-recent-hint.png) ·
[跨项目入组](../features/assets/F277/issue1964/300-project-cross-move.png) ·
[跨项目建组](../features/assets/F277/issue1964/300-project-cross-create.png)。临时服务与 lease 已关闭。
最终修正 HEAD 仍须鲸鲸复审、CI 及 zts 正式批准，不将作者自检当作独立审查结论。
