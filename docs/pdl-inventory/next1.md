# next1 — upstream/next 合并与能力审计

后续：T01 / T02 / T05 / T06 / T21 已随设计 `250a225` 完成绑定，见 [next2.md](next2.md)。T03 / T04 / T07–T17 已随 `44f2299` 处理（T10 由复制层完成）；T18 保留真实 API 缺项，见 [next3.md](next3.md)。下表保留 next1 当时的审计结果。

基底 `4020d9c659`；正在应用 squash `27815e491a`。只修改本 worktree。未暂存、未提交、未继续 cherry-pick、未推送；未启停服务，未改 `.env`。

## 分层与看得见的变化

- 引擎 / 组件 / 主题：未修改 `public/pdl`，对设计 `1195015` 的 65 个文件逐字节核对：差异 0、额外 0、缺失 0、mock/proto/local 0。
- 应用：保持 push → held snapshot → VM 投影。统一使用 next 的 socket hub，保留房间确认、重连补读、服务端流重放，以及仍在流式生成的离屏文本缓存；完成通知由 user-room lifecycle 负责，不再重复发一次。
- 应用：作品保留 next 的显式有界分页（初始一页；继续最多四页 / 24 个新作品）、权限与会话隔离、隐藏暂停；需要来源的 generation 仍使重现 / 重连进行一次完整读取。空来源引用稳定，父组件重绘不会再发布一份假变化。
- 应用：非 Git worktree 的 Git 页呈现空数据，既不发 Git 请求，也不一直显示 loading。
- 应用：成员删除、会话策略、Codex 共用设置携带后端版本；保存复用 next 的 `saveMemberRecord` / `saveMemberExtras`（成员先提交，再提交附加设置；丢失回执时核对原写入，保留未完成草稿）。DSH 只认后端认可的 runtime 和原样的 prepare 回执，不再通过命令里出现 dsh/deepseek 猜身份。
- 应用：固定 ID 的单连接插件配置沿用 next 的对象覆盖与权限校验，不再当作可增删的客户端数组；保留既有通用配置表单。
- 应用：没有消息坐标的已归属 HTML 作品，用 `/api/works/command` 按固定版本读正文，再进入现有 HTML 作品框；打开 / 重试共用同一动作。
- 平台 / 后端：PNG 仍捕获引擎导出 frame；同时保留 next 的离屏 lazy 图片转 eager 和完成等待，共用同一导出期限。桌面启动就绪与手动更新两边的行为及测试同时保留。
- 构建：合并 package scripts、重新生成 vendor stylesheet 清单；保留独立星球 frame 的 Markdown 依赖和 `color-utils`。next 把普通 `.ts` 测试改为 node 环境，PDL 的 DOM 测试独立保持 jsdom；测试宿主提供同一个 HubSocket 上下文。

## 24 个 UU 文件的处理

工作区冲突标记为 0。索引仍有 24 个 UU，等待 lang `git add`；这是未暂存状态，不是尚有冲突文本。

| 文件（省略 `packages/web/`） | 处理 |
|---|---|
| `desktop/update-prompt-controller.test.js` | 同时保留 next 的启动 ready 不误展示窗口，以及手动更新可信 IPC / manager 测试。 |
| `packages/api/src/services/ImageExporter.ts` | 保留 PDL frame 导出，并接上 next 的 eager 图片等待；未恢复旧 JSX 导出协议。 |
| `eslint-plugins/no-raw-console-borders.js` | 保留 PDL 分支已删除界面的检查边界，不恢复旧组件例外表。 |
| `package.json` | 保留 next 依赖 / scripts 改动，保留不引用已删除界面测试的入口；脚本中的具名测试路径缺失 0。 |
| `src/app/layout.tsx` | 保留 PDL 无旧全局 CSS 的宿主 document，同时保留运行时 API origin、PWA retirement、build revision。 |
| `src/components/AppShell.tsx` | 只挂 PdlAppHost，不恢复旧 shell JSX。 |
| `src/components/__tests__/app-shell-export-mode.test.tsx` | 保留纯导出选区数据测试，不恢复旧 shell 渲染测试。 |
| `src/components/__tests__/f190-visual-contract.test.ts` | 删除：只断言已删旧组件的外观 / DOM / CSS。 |
| `src/components/settings/members/MemberChoicePicker.tsx` | 保留纯 MemberChoice 数据类型，删除 JSX。 |
| `src/components/settings/members/MemberRuntimeFields.tsx` | 保留纯 MemberText 类型，删除 JSX。 |
| `src/components/settings/plugin-manager/PluginAgentClientsField.tsx` | 只留 next 的 decode / validator，含固定客户端覆盖、permissionPolicy 规则；不保留旧 JSX。 |
| `src/components/shell/__tests__/mailbox-filtered-counts.test.ts` | 删除：依赖已删 unified-mailbox-state 的旧投影测试。 |
| `src/components/thread-chat/ThreadChatRuntimeProvider.tsx` | 同时保留 neededSources 门控与 next 的 HubSocket provider；只有一条页面 socket。 |
| `src/generated/vendor-stylesheets.json` | 运行既有脚本重新生成，不手选哈希；console layout 仍不加载旧样式。 |
| `src/hooks/__tests__/usePagedGlobalWorks-source-refresh.test.tsx` | 采用 next 有界分页 / material stale / 权限撤销 / owner fence 行为测试，不恢复自动耗尽游标。 |
| `src/hooks/__tests__/useSocket-reconnect-catchup.test.ts` | 采用 next 的房间确认后补读，同时保留 needed-set 约束。 |
| `src/hooks/__tests__/useSocket-thread-guard.test.ts` | 采用 next 的前台房间、离开即清 sequence / relay；workspace 全局房间改由实际消费者 retain。 |
| `src/hooks/agent-messages/background-handler.ts` | 保留 next 事件位置准入与单一完成通知，以及 PDL 离屏流缓存。 |
| `src/hooks/useActiveExecutionProjection.ts` | 保留 needed / visible 的 4s 生命周期，同时保留 next held-wait 取消 writer。 |
| `src/hooks/useGlobalArtifacts.ts` | 保留 next auth / owner fence、material invalidation；与 needed generation / 暂停对齐。 |
| `src/hooks/usePagedGlobalWorks.ts` | 保留 next 有界分页 / 续页 / cursor-error 原子状态；空状态引用稳定。 |
| `src/hooks/useSocket.ts` | 保留 next hub / 房间确认 / 流重放，叠加 needed-set 数据门控；作品 material 事件不被消息门控吞掉。 |
| `src/hooks/useThreadArtifacts.ts` | 使用 next 的共享 thread artifact store；needed 控制订阅，不在 mount 时抢读。 |
| `src/stores/activeExecutionStore.ts` | 同时保留 next waits / wait 取消，以及 PDL 对未变化 execution / unavailable 路径的引用复用。 |

next 自动合并还带入了未挂载的旧 React 叶子和测试。逐项删除清单见 [next1-deleted-ui.md](next1-deleted-ui.md)。额外删除 84 文件；用保留 app 入口 **加 `src/starry/entry.tsx`** 做静态导入 walk，恢复被删文件的虚拟源码再查：可达删除文件 0。独立 frame 的 Markdown 及其测试保留，没有删掉星球页面的实际依赖。

## 702 个已删除文件上的提交审计

两段范围 `42017e0cea..upstream/next`、`582f45773b..upstream/next` 在这 702 个路径上得到相同 28 个提交。下表只登记用户能力 / 状态 / 行为；旧 JSX 布局、surface CSS 与测试实现归 v2 或 not user-facing，不移回 console。`T*` 是下节精确的设计仓缺口，不能算已覆盖。

| commit | 用户能力 / 状态 / 行为与当前落点 | status |
|---|---|---|
| `4020d9c659` | 原生云投递回执与回复核验分离，既有 `cloud-dispatch-receipt` / `deliveryView` 已使用 next 判定；精确搜索新增选定章节、原句 / 转引 / 批注及重新核验；召回改为 scoped / 分批 source 读取。现有 recall 使用服务端分页，不恢复旧全量 fan-out；结构化选区还缺 T09。 | theme or component change — T09 |
| `0e6469bc24` | 命令 / 导航改走同一 hub（已接）；审批来源事件版本刷新保持；schedule update 的真实批准 writer 已可用，但 before/after 没有声明；HTML 尾部边缘测量、证据相关性还需表达。 | theme or component change — T10、T13、T18 |
| `cf49dacce1` | 作品初始一页、显式继续、最多四页或 24 新作品，权限 / 身份变化废弃旧游标，普通 Task 活动不全扫。hook 已保留；新主题缺继续读取 / stale 刷新入口。 | theme or component change — T01 |
| `b584124518` | 会话菜单复制 Thread ID；新侧栏菜单目前只有导出 / 整理等，没有该菜单项。 | theme or component change — T02 |
| `eb8e230f5b` | 通用 ACP pool 默认 20，Gemini 3；next shared / backend / 表单默认逻辑保留，主题 placeholder 仍把所有客户端写成 3。 | theme or component change — T03 |
| `132dfa8d37` | 桌面报告服务退出、连接提示合并、不拦截底下控件；next desktop / useConnectionStatus 保留，PDL 提示使用自身组件。 | covered |
| `ddf78c6766` | 非 Git 工作目录正常看空 Git 页，不发送不适用的 Git 请求。已修 `useWorkbenchBindings` 的空 loading。 | app change — 已完成 |
| `20b8f74c73` | 隐藏作品面板暂停读取、保留已有内容 / cursor；在 needed 之外停止活动，重现先显示持有数据。 | app change — 已完成 |
| `016942d367` | 原生身份来自可信启动描述，不能凭命令参数里的字符串认 DSH；已接 backend 的 `dshSetupSupported` 与 prepare 精确回执。 | app change — 已完成 |
| `da8be4a681` | PR3 owner / 重连流恢复、队列逐目标恢复、收件箱已处理 / 撤销的 writer 保留；移除快捷删除按钮的 next 结果也不恢复；新增 watcher 提醒、Pi 失败技术信息及部分专用显示缺口。 | theme or component change — T11、T14、T17 |
| `a2e2bfb635` | DSH 实际模型、继承值及 ACP 边界；raw runtime / catalog 已保留，主题还不按来源 / 标签表达。 | theme or component change — T04 |
| `4daeb13152` | 保存失败留在保存按钮旁，当前 PDL 只有 toast，尚非等价行为。 | theme or component change — T06 |
| `24a1e9af0a` | Windows 托管 Codex 登录与能力 / 策略拒绝原因；next 后端 / 登录 owner 保留，继续使用已有 native setup / account writer。 | covered |
| `581d70bbbb` | PR diff 按 session / target 共享读取、失败可重试；新主题作品 PR 目前只有外链，不能将它误报成同一能力。 | theme or component change — T08 |
| `a7c32a4fc3` | owner nickname、等待 held ball 的来源 / 取消、记忆 matter 与封面 / 媒体原图显示、召回更精确分组。执行 / 召回真实 owner 留在宿主；待补 nickname、held ball、matter、封面声明。 | theme or component change — T05、T07、T15、T16 |
| `faaa1b000e` | 流式更新只影响变化消息、避免历史时间格式化反复执行；PDL 既有按 id 差异 / 消息缓存 / DOM 复用，不移植旧 React memo。 | covered |
| `b5896f695a` | 单接收者长名字可见；新主题使用自己的身份组件 / capsule，旧 fixed width 不是其绑定字段。 | covered |
| `025a92be57` | DSH reported provider、有限模型发现与真实模型 / effort 来源；真实 runtime-models 路由保留，显示同 T04。 | theme or component change — T04 |
| `1d247d71ec` | 各客户端的 model / effort 来源、继承与可选项；raw catalog 保留，显示同 T04。 | theme or component change — T04 |
| `0fb68bc034` | 侧栏菜单不被滚动容器裁切；PDL 由现有统一锚点弹层处理，没有旧菜单的滚动祖先。 | covered |
| `e2f64f840e` | 原快捷删除及确认偏好；后续 `da8be4a681` 已撤掉行内快捷按钮。当前统一 remove 确认与回收站恢复能力保留，不恢复撤回的旧画法 / 开关。 | covered |
| `1016aa7a31` | 插件 UI 入口、编译身份预览、写入 revision 和结果不明时核对、固定单客户端。已接删除 / 设置 revision、复用 next 保存函数 / 单客户端校验；未声明的身份 / 插件入口见 T12、T19。 | theme or component change — T06、T12、T19 |
| `917120d55b` | co-creator 默认身份 + 只有用户确认改 nickname 才提交，避免沿用旧模板昵称；后端保留，owner 对话框还没有 nickname 字段。 | theme or component change — T05 |
| `52139d85fa` | 插件归档 admission + ACP executionApproval / permissionPolicy；next shared / 后端保留，权限校验带入数据 helper；成员的 executionApproval 控件未声明。 | theme or component change — T12 |
| `2fad82a6a5` | 普通编辑不被误报为草稿恢复；保留 next durable draft signature / in-flight / consumed 逻辑，PDL 仍复用这些 hook。 | covered |
| `3821af05e4` | 大部分是旧 v2 surface / 背景透明层；队列已投递目标按真实 history receipt 表达、重复发送警示是用户行为，当前目标 chip 未表达。 | theme or component change — T11；其余 not user-facing / v2 |
| `9fd924aa39` | 被动作品 hydration 不取消来源返回；新内置背景；搜索 partial / 时间范围 notice。前者 PDL 不用旧注册器，背景 / 搜索说明需主题声明。 | theme or component change — T09、T20 |
| `0e372e5bdd` | 无消息坐标的固定 HTML 作品已用 work owner 正文打开；Collective 请求完成未回复的恢复由独立客户端负责，不能恢复已删除 React Collective 页面。 | app change — HTML 已完成；Collective 见 T19 |

## 设计仓需要的精确改动（项目复制层未动）

下面是未覆盖项，不是“都已接好”。均使用现有组件 / 已有真实 API；新 PDL 或组件机制先由设计仓给出契约。

| 编号 | 设计仓文件 / 条目 | 要补什么 / 已有真实来源 |
|---|---|---|
| T01 | `theme/default/views-ws-items.js` 的 `WORKS_BLOCKS` / `page.works` | VM 增加 `hasMore/loadingMore/stale`，声明继续 / 重新读取入口；动作接现有 paged hook 的 `loadMore/restart`。不能再次自动耗尽游标，也不能把未读完的卡片当空列表。 |
| T02 | `theme/default/views-chat.js`，`nav.threads.rename.more.items` | 增加通用 copy，value 为行的 `@id`；文案可复用 `wsSessions.copyThreadId`。ID 已在行上，不需新 API。 |
| T03 | `theme/default/views-settings.js`，成员 advanced 的 `f-acpMax` | 默认值 / placeholder 不固定 3；绑定 runtime 的真实默认（通用 20、Gemini 3），原枚举值不变。 |
| T04 | 同文件成员 model/runtime 部分 | 给 model / effort options 使用 `{value,label,source}`，默认 / 继承显示读取 catalog 的 `defaultModelLabel/defaultModelSource/defaultEffortSource`；DSH provider 与模型不截断成裸 opaque route。raw 来源为 `/api/cats/runtime-models`、`/api/cats/native-runtimes`，不在 app 拼标签。 |
| T05 | `theme/default/views-settings.js`，`dlg.owner` | 单独 nickname 字段，VM 保留原值及用户是否实际改过；未改不提交 nickname。继续显示 raw name / aliases / color；后端 co-creator writer 已支持该字段。 |
| T06 | 同文件成员 `savebar` | 增加现有 `fieldError` / 错误位，绑定保存失败；声明 pending write 的核对状态与继续保存按钮。复用 next 保存函数的行为已接，不能只靠 toast 等价替代。 |
| T07 | `theme/default/views-ws-ops.js`，`ws.live` / `live.wait` | 为 active-execution API 的 `waits: ActiveHoldWaitProjection[]` 声明独立 kind 的等待行（勿混成 deployment wait / running），取消操作接已存在的 `cancelHoldWait`；不加轮询来源。 |
| T08 | `theme/default/views-ws-items.js` 的作品 PR 详情 / Changes 容器 | 声明真实 PR target（仓库、PR number、session、revision）、loading/error/retry / 文件 diff；复用 next 的 session-scoped PR diff 读取。当前 `work.pr` 外链不等价。 |
| T09 | `theme/default/views-cafe.js`，`cafe.search` 及消息搜索结果 / 引用区 | 增加 raw `selection`（headingPath、part、quotation/origin、context、comment）及 answerBinding / answerSelection、partial / 时间范围；显示原句、转引、批注分列，选择后由已有 `/api/evidence/answer` 核验，不能扁平拼成外层说话人的一句话。 |
| T10 | `library/blocks.js`，`frameSizeScript` | 和 next HTML 测量规则对齐：内容后缘纳入 body + documentElement 的 padding / border / margin，排除 `height:100%` viewport floor。当前只加 body marginBottom，不等价；先补原型组件检查再复制。 |
| T11 | `theme/default/views-chat.js` 的 queue 行 / 递送状态 | 声明每目标 raw delivery / read / uncertain / failed 状态，目标集合含 history delivery evidence，不只看 queued targetCats；repeat_target 的提示说明它是新消息、可能重复执行。真实 writer / receipts 已有。 |
| T12 | `theme/default/views-settings.js` 的 member advanced / clientShared、编译预览 | ACP `executionApproval` 用 raw `auto/ask_user`；单连接固定 id 不应出现增删 / 改 id；编译预览显示 raw `identityResolution`；云身份损坏的恢复入口带成员 configurationRevision。后端及 payload helper 已支持，不能恢复旧 JSX。 |
| T13 | `theme/default/views-cafe.js` 的 schedule 提议卡 | `mutation.kind:'update'` 时显示 params before / after、批准更新 / 真实 effect checkpoint；当前仅显示 operation，不足以审核具体改动。批准 / 拒绝 writer 已接。 |
| T14 | 同文件 message card / `theme/default/views-settings.js` | watcher 的全局设置 / 对话控制 / nudge 处理动作未声明；为真实 watcher raw 配置、提醒、处置状态给契约，不恢复 WatcherSettings / WatcherNudgeMessage JSX。 |
| T15 | `theme/default/views-cafe.js` 的记忆页 / 详情 | 新 matter 记忆 family、分页详情 / source / mutation 需要声明（next MemoryMatters / MemoryMatterDetail 能力）；沿用既有列表、正文、表单 / 审批组件，不复活专用 React UI。 |
| T16 | `theme/default/views-ws-items.js` 作品卡片 / 更多操作 | 真实自定义封面选择 / 撤销、cover 来源与媒体原始比例需要声明；复用现有 media / file picker，不能把 cover crop 误作为原图比例。 |
| T17 | `theme/default/views-cafe.js` 消息失败技术详情 | raw CLI diagnostics 包含 Pi；按真实 metadata.provider / diagnostics 声明可展开信息，勿只因旧条件只识别 Google/OpenAI 而丢掉 Pi。 |
| T18 | 同文件证据结果 / 技术信息 | 新 `rank`、`relevance.state` raw 字段的显示与文案；不能由 app 自己造“相关性”标签。 |
| T19 | 插件自身的 pdl entries / frames；宿主既有插件插槽 | next 的 `ui.entries` / sandbox panel 协议不能当作 pdl JSON 直接注册。插件需按已定 PDL 空间契约声明入口 / src 或 view；Collective 回复恢复仍属独立客户端。宿主不引入第二套 PluginUiEntries JSX 或插件注册机制。 |
| T20 | `theme/default/assets/bg-assets.js` / `theme.bg` | 如需收录 next 新增的三张内置背景，在设计仓声明素材和选项；项目不向 copied assets 加图。旧 surface-role CSS 仍归 v2。 |
| T21 | `theme/default/views-settings.js` 增加 `dlg.routingRedirect` | 原接收者不可用时确认改发：args 为服务端原样 `{code,error,unavailable:[{catId,displayName}],targets:[{catId,displayName}]}`。确认后用同一 idempotency key + `confirmedTargetCats` 重发，取消保留草稿；send hook 已改为 raw confirmation callback，不再依赖已删 useConfirm React UI；宿主尚未挂接这个缺失的对话框，避免打开一个空确认框。声明未补前该分支仍按 next 的未确认失败流程结束、保留草稿。 |

T01/T04/T07/T08/T09/T12–T19 是缺契约的能力，不能以现有文字相似就标 covered；没有编造新的 API、旧 JSX 兜底或显示文案。

## 测试断言变化

| 旧断言 | 新断言与理由 |
|---|---|
| useSendMessage 从旧 ConfirmContext 收拼好的中文 | 接受 raw routing confirmation callback，仍验证确认前只发一次、同一 idempotency key、确定目标、取消 / multipart / 第二次失败。缺对话框声明见 T21。 |
| 云回执 fixture 没有 from | 使用 next MessageFrom 的 system sender，仍按 source / invocation 严格匹配回执。 |
| DSH fixture 仅凭命令 dsh | fixture 给真实 `dshSetupSupported`；准备后的精确 launch 才能测试，手改后测试入口消失。 |
| 旧 workspace:global 自动加入 / 后台 running room 常驻 | 只自动加入已确认的前台 thread rooms，非 thread room 由实际 hub 消费者 retain；下一线程确认前不补读。 |
| 成员共享配置先写、没有配置 revision | 成员 S1 后附加配置 S2/S3；逐项 expectedRevision；失败不发布成功、client-only 不重写成员。 |
| 项目审片测试用 catId:null 作为输入发送者 | 改为唯一的 MessageFrom user sender，保留 100 行分页 / 失败不跳页断言。 |
| PNG page mock 无图片读取 | 补 eager 图片读取的页面行为，不改导出身份 / 时间预算 / 分块断言。 |
| 普通 `.ts` 一律默认 jsdom | next 普通逻辑测试在 node；PDL DOM 套件独立 jsdom。没跳过测试、没改通过阈值。 |

## 检查原文

```text
pnpm install --offline --frozen-lockfile
Done in 11.8s

pnpm --filter @cat-cafe/shared build
> tsc
exit 0

SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.2.sdk pnpm --filter @cat-cafe/api build
Built bounded SQLite read-window backend
F299 provider request recorder census OK (12 implementers)
exit 0

pnpm -C packages/web exec tsc --noEmit --incremental false
(no output)
exit 0
pnpm -C packages/api exec tsc --noEmit --incremental false
(no output)
exit 0

pnpm -C packages/web exec vitest run src/pdl
 Test Files  67 passed (67)
      Tests  658 passed (658)

related hook suites (socket / artifacts / active execution / routing)
 Test Files  11 passed (11)
      Tests  118 passed (118)

API related route/service suites (11 files)
ℹ tests 81
ℹ suites 8
ℹ pass 81
ℹ fail 0

node --test desktop/update-prompt-controller.test.js desktop/preload.test.js
ℹ tests 30
ℹ suites 3
ℹ pass 30
ℹ fail 0

pnpm -C packages/web exec next lint --dir src/pdl
exit 0; 0 Error lines / 56 Warning lines
info  - Need to disable some ESLint rules? Learn more here: https://nextjs.org/docs/basic-features/eslint#disabling-rules

pnpm exec biome check <44 changed/resolved source files>
Checked 44 files in 238ms. No fixes applied.
Found 366 warnings.
Found 59 infos.
exit 0

privacy-grep = 0
copied diff vs design 1195015 = 0
extra = 0
missing = 0
mock/proto/local = 0
conflict markers = 0
index UU = 24
git diff --check exit = 0
kept-entry deleted-leaf reachability = 0
```

privacy-grep 覆盖 `public/pdl`、`public/pdl-app` 与非测试 `src/pdl`。

API 命令用 `with-test-home.mjs` + `tsx` + `setup-cat-registry.js`，范围为 appearance-config、preview bridge、recent works、recall page、library pagination、context attachments、tool detail、plugin pdl、thread export、video review、routing confirmation；未连接真实数据。静态 walk 的 7 个保留入口包括 root layout 与独立星球 frame。

环境原始失败，未改项目代码去绕：

```text
ld: tapi error: malformed file
.../MacOSX27.2.sdk/usr/lib/libSystem.B.tbd:4:20: error: unknown architecture
clang: error: linker command failed with exit code 1
```

使用机器已有的 MacOSX15.2 SDK 后 API 完整 build 通过。只设置该次命令的 `SDKROOT`；无全局工具链或 `.env` 修改。依赖最初离线缺包、联网被沙箱拒绝；读取已有 pnpm 包缓存后离线安装成功。安装缓存移到临时目录，未留在待提交树中。

lint / Biome 仍有上列 warnings / infos，没有压制规则、降低阈值或添加防再犯检查。尚未做浏览器验收 / web build；本轮不启停服务。复制层缺口 T01–T21 留待设计仓声明 / 修正后复制。
