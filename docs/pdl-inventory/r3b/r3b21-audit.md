# r3b21：剩余能力、后端复核与待审删除清单

以下是当前源码调用关系，**只列不删**。`AppShell.tsx:5` 只返回 `PdlAppHost`，`app/layout.tsx:80` 的 children 不再由它画；不能把磁盘上仍存在的旧 React 文件算成已迁移。运行时依赖图另见本轮 `r3b21-runtime-dependencies.json`。这里的“没有宿主调用”只描述当前导入图，不表示 CLI、插件或其它分支也没有调用。

## 1. 进度表里的部分／未接项逐项复核

类别：**A = 主题数据配置（PDL + VM，组件不动）**；**B = 疑似旧的不合理定制，先请 lang 定**；**C = 需要调整通用组件**。本轮没有确认必须补通用组件的项。B 只针对该行点名的旧交互，已接的能力不撤回。

| 区域／工具 | 类别 | 后端复核与下一落点 |
| --- | --- | --- |
| 侧栏项目整理／创建／归档 | A；旧自动归档规则为 B | `ThreadSidebar/active-workspace.ts:46` 的 archived 是按最近活动／置顶推导，不是服务端归档事实。`routes/projects.ts`、`projects-mkdir.ts`、`projects-bootstrap.ts` 已有创建／目录 owner；继续绑定，不能再记“缺创建接口”。是否要新建持久“项目归档”含义请 lang 定，不把旧自动分类存成新开关。 |
| 其它消息提议卡 | A | `routes/person-memory-decision-routes.ts`、`event-memory-correction-decision-routes.ts`、`entity-memory-proposals.ts`、`eval-repair-approval-routes.ts` 已有 producer-specific owner。剩余是逐类映射原卡片和原审批引用，不需要通用假决策端点。 |
| 作品其它格式／引用卡 | A | `routes/threads.ts:1796` 的全局 catalogue 和现有 content owner 已在；`pdl/useReviewBindings.tsx`、`useDocumentBindings.tsx` 是当前绑定。余项为 source → 原 file／media／content 数据整理，不因格式另建作品 API。Office 内容预览已明确不在范围。 |
| 云连接恢复 | A；旧连接器专属壳为 B | `routes/threads.ts:1420`／`:1463` 已有精确 cloud-bindings GET／PATCH；恢复／验证动作在原 cloud owner。尚未接的是表单、精确重试与回执，不是没有后端。dot 保持不动。 |
| 桌面运行时更新 | A（平台绑定） | 系统页已有声明，缺的是桌面 bridge 的真实状态与手动检查出口；不属于 API 后端缺项，按此前决定留给平台层。 |
| 文件浏览的输入候选 | A | 已有 `workspace/search` 与 `createFileContextAttachment`，PdlAppHost 已调用；剩余 @／# 候选给现有 chat.pop，不能另造建议列表组件。 |
| 消息正文任意选区 | A；旧浮动工具条为 B | 复制／引用／转发 writer 已在宿主，剩余是消息选区 → 原动作参数，不需要后端再存一份选择状态。旧菜单布局与快捷键不照搬。 |
| 成员详情页 | A | `/api/cats/native-runtimes`、`/api/cat-templates` 已有，悬停卡已接。成员设置的编辑／创建尚未绑定，不是缺服务接口。 |
| 首页／其它主页面 | A | 现有线程、成员、执行和作品 owners 已在；首页需要聚合这些已有数据，不能把空首页当成后端缺接口。未接的设置分别跟随所属 owner。 |
| 插件页面／空间（含 Collective） | A | 本轮新增 `/api/plugin-manager/pdl`，取当前已验包的 manifest；真实 list／生命周期 writer 已有。本轮接通 entries／ops／frames 和 page.plug。动态配置表单、安装等管理余项还未接；Collective 的当前插件包缺 pdl 声明，见下节，不伪造宿主入口。 |
| 其它独立 frame 入口 | A；旧独立界面内部不迁移 | 猫猫星球／独立文档编辑器仍按第 4 类；先由所属插件或文档 owner 给真实入口／src，不用旧 JSX 兜底。Collective 已归插件行，不在这里重复统计。 |
| exec 全文／超大记录 | A；旧专属轨迹交互为 B | `pdl/useExecutionBindings.ts` 与原 runtime-sessions owner 已在，cursor／会话分页是真实 owner 能力。待接全文范围与大记录读取，不新增前端本地索引冒充全量；旧轨迹专属展开／快捷键需要另定。 |
| works-t 其它格式 | A | 与主区全部作品复用同一 catalogue／review owner。待接格式投影和引用入口，不另建工作台作品状态。 |
| tasks 余项 | A；旧拖拽等定制为 B | taskStore 与任务 revision writer 已有。剩余字段／动作按真实 task DTO 接；旧任务面板的布局、拖动和快捷编辑不默认复刻。 |
| recall 文档来源／事件上限 | A | `useThreadRecall`、`routes/memory-recall-events.ts`／`memory-recall-page.ts` 和文档 source 已有。回复分页已接；单页事件数量与更早回复是两个维度，不因新规则擅自把 limit 提高当完整历史。 |
| replay 跨对话／逐字 | A；旧全局快捷键为 B | 现有 thread／session 读取和 story-player 已接。跨对话是取数聚合；逐字效果是否需要与其节奏规则不明确，不能按旧设计默认补，也不另存播放历史。 |
| eval 余项 | A | `routes/eval-hub.ts:93` summary、`:125` 成员 writer、`:172` trigger-now／`:213` generate-now 已有；尚未接完的是原 owner 行为。自动调度开关已明确拿掉，不是后端待补项。 |
| board 外部项目／认领回收 | A；旧专属工作流壳为 B | backlog／external-projects 和 lease owner 已有。按原声明绑定精确 item／revision／lease，不新建第二套前端自领状态机。 |
| files 剩余编辑／批注 | A | workspace 文件读写／租约、content review owner 已有；二进制与 Office 信息卡已接，不需要额外转码或新下载 owner。 |
| mem 决策／修订／开场引用 | A；开场引用为待定能力 | 五类 owner 与各 producer 的写／审批接口已有；不再统一列为“缺后端”。开场引用 shared writer 虽然存在，lang 尚未定需不需要，所以保持未接。 |
| review 文档正文／其余编辑 | A | artifact-review、content-modification、document owners 均已存在；剩余绑定不等于缺写接口。旧单独的评审编辑器壳归 v2；通用 media 已有的标注不再实现一份。 |
| clips 导入／同步失败恢复 | A；旧 modification-loader 推导为 B（已定不迁） | video-project-review 的真实同步／消息 owner 已有，现有 film binding 只在发消息时同步。继续接原回执／恢复，不能重新调用旧“按素材推导变更秒数”来实现比较。 |
| team 成员设置 | A；旧 Team 界面为 B（已定删除材料） | routing-context 读、信号与退役 writer 已接；成员服务／模板 owner 已有。新建／编辑／续期路由偏好虽有后端，入口已决定不呈现，保持原决定。 |
| evolution 探索／案例／新目标 | A；旧多阶段专用壳为 B | `capability-evolution` 既有 lifecycle／change／progress-request 与 workspace owners 已在；剩余为原声明字段／动作绑定。没有后端 writer 的推测动作不据旧画面虚构，阶段推进必须沿原条件和真实回执。 |
| signals 分页／历史／播客／研究 | A | 复查 `utils/signals-api.ts:17`／`:27` 与 `routes/signals.ts:12`：只有 limit／筛选，**没有 cursor 或 offset**，不能把最多 100 条说成分页已具备。study／podcast／notes owners 已有；播放与笔记历史是数据投影。分页需先核对原主题有没有入口，再补真实后端。按片段真实 audioUrl，不伪造整集拼接地址。 |
| ops 剩余子页／提醒预览 | A | `pdl/useOpsBindings.ts` 已用真实 telemetry／governance／brake／runtime／rescue owners，env GET／PATCH 仍有活跃宿主调用。余项继续绑定；不能删通用 env 接口。完整日志导出范围另见下节。 |
| 系统其它设置 | A | processTalk 已接；env、服务与更新分别沿现 owner。完整记录导出没有确定的数据边界；系统页面不能借这次新增后端权限擅自打包用户配置或凭据。 |

## 2. 历史“后端缺接口”逐项重新归类

| 项目 | 本轮结论 |
| --- | --- |
| 外观／个人背景 | 已补后端，已绑定。一个 `appearance`，一个全局背景；thread 范围与旧持久数据明确移除。不是待定项。 |
| 插件清单的 PDL | 已补已验包清单的读取／校验，未新增登记层。真实包缺声明时不会出现假入口。 |
| Collective 插件包 | 插件仓 `packages/collective-connector/plugin.yaml`，当前 `0.1.0-alpha.2` 没有 pdl。宿主已能按真实 connections owner 给声明的 src 填客户端地址（含 hostOrigin），但不能改宿主 frozen legacy manifest 的验包身份。需插件仓补正式声明并发布／安装；本轮未改插件仓、未改 dot。 |
| 完整记录 `logsExport { scope:'full' }` | r130 只给 scope=full，未定义完整记录含哪些 owner／文件与时间范围；原 `debug-invocation-export.ts:44` 明确只导出一个 invocation。**需要 lang 定范围**后可直接补后端，不再因为“不许改后端”挂起；本轮不擅自导出 .env／凭据或拿单次日志冒充完整。 |
| 录音历史 | 当前 audio 只返回正在采集／保存回执，没有已确认的持久历史 catalogue。无真实历史就不画条目。是否要新增“长期保留录音历史”（存储／保留／所属 owner）是能力决定，请 lang 定；本轮不在前端存生命周期记录。 |
| 插件 operation → 动态 options／records | 原 `spec/engine.md` E22 已标协议缺口；不是缺第二种 select／表单组件。现配置 RPC 已有，后续对齐正式插件字段协议；不加宿主猜测规则。 |
| 提示关闭、环境重启、插件重启、插件转发、语音推荐、路由偏好新建／修改／续期 | 已删声明的旧入口，不因允许改后端而恢复。部分路由偏好接口本就存在，不能再声称都没有后端。 |
| eval 自动调度／回收站彻底删除清空 | 已定拿掉，保持拿掉；不补 writer，不恢复声明。 |
| Office 正文只读预览 | lang 已定不在范围；维持真实信息卡，非后端缺项。 |
| 桌面手动检查更新 | 平台桥，非 API 缺项，保持此前收尾安排。 |

## 3. 待审删除清单（本轮不删）

| 接口／模块 | 当前还有谁调用／依据 | 建议与边界 |
| --- | --- | --- |
| 旧 `/api/config/chat-background` 的 scope／threadId／推荐 metadata 协议 | 旧 `chat-background/ChatBackgroundProvider.tsx:75` 读，后半段 PUT 写；消费者为 Picker／Layer／ThreadBackgroundSettings／useRefreshBackgroundRecommendation。PDL 已改走新完整 appearance 协议。 | 协议本轮已按明确授权替换；路径仍保留作新外观 owner，**不要删除整个路由**。旧调用者和旧兼容测试待审后一起删，不能给它们留兼容分支。 |
| `api/config/user-preferences-chat-background.ts` | 当前生产源码无调用；`test/config/chat-background-generation.test.ts:12`、`user-preferences-write-failure.test.ts:7` 仍调用旧 helper；旧 route 测试及 v1 fixtures 还在。 | 可随旧背景退休。通用写失败／原子性行为要保留新 owner 覆盖，不能按文件名把整个通用测试都删。 |
| 旧 `chat-background-metadata-lifecycle.ts`／`chat-background-file-generation.ts` | 仍被 `user-preferences-atomic-write.ts:11`／`:17` 和 `user-preferences-store.ts:16`／`:17` 引用，新 appearance 也通过这个通用 writer。 | **暂留**。需先拆清通用路径／原子写与旧背景元数据用途，再删旧部分；不能把仍在运行的 writer 一起删。 |
| shared 旧 background schema／state／metadata 导出、`UserPreferences.chatBackgrounds` | 旧背景组件和旧 API helper／fixture 仍有类型调用；同一 `shared/chat-background.ts` 还包含本轮新 appearance schema。 | 只列旧导出／旧字段，不能删整个文件。旧界面与测试审过退休后再去掉旧类型；新 owner 已不读取旧数据。 |
| `web/stores/themeStore.ts`（localStorage + 旧 OKLCH） | ThemeApplier、ThemeMenu、ThemeSettingsPanel、dev/OklchTuner、background-palette、useRefreshBackgroundRecommendation；另有 `app/dev/f322-replay-preview/ReplayPreview.tsx:6` 源码调用。PdlAppHost 不引用它。 | 列入删除清单；需同时处理旧设置／ActivityBar 和 dev 预览依赖，不能只删 store。原样 PDL 主题／计算器已替代主应用外观。 |
| `ThemeApplier.tsx`／`ThemeMenu.tsx`／`settings/ThemeSettingsPanel.tsx`／`dev/OklchTuner*` | 旧 ActivityBar、SettingsShellV2 仍互相引用；根 layout 与 PDL 图没有挂载。专属 theme／tuner 画法测试仍在。 | 旧画法与专属测试待审退休；v2 主题材料保留在其它分支。不是把旧组件重新挂入 PDL。 |
| `components/chat-background/` 的 Provider／Layer／Picker／ThreadBackgroundSettings、旧 sampling／contrast／palette／opacity／recommendation | 旧 ThreadSettingsPanel、YouSettingsPage 和同目录 hooks／测试相互调用；PDL 不用旧背景 JSX。 | 待审退休整组旧界面／只为旧算法存在的测试。不要删共享文件读写／上传能力；新上传图片是独立 owner。 |
| `THEME_CONFIG` 环境字段 | `themeStore.ts:127` 通过通用 env 接口读写；后端 `env-registry-data/part-7.ts:83` 仍登记；`test/env-registry.test.js:656`／`:695` 用它验证 shell 转义。 | 只列该旧字段及客户端同步代码待审。转义测试的真实行为仍应保留；不能直接把整组 env 测试删了。 |
| GET `/api/config/env-summary`／PATCH `/api/config/env` | **仍被 PDL `useOpsBindings.ts:239`／`:363` 调用**；旧 HubEnvFiles／HubObservability／IndexStatus 也有调用。 | **不删**，是现用通用接口；旧主题的单字段同步退休不影响该接口。 |
| 路由偏好 create／supersede／renew 接口 | `components/routing-context/routing-context-client.ts:60`／`:68` 旧命令入口还在；retire `:75` 被当前 team owner 使用；后端 routing-context 与其行为测试均存在。 | create／编辑／续期无新声明，只列旧调用链待审，不能把共用 snapshot／signals／retire 模块整块删。 |
| eval trigger-now／generate-now／成员设置接口 | `routes/eval-hub.ts:125`／`:172`／`:213` 与既有 eval owner／测试有调用；已拿掉的是自动调度开关，不是这些命令。 | **不因开关删除而删模块**；下一步按仍在声明的命令绑定。 |
| 回收站 DELETE `/api/threads/:id` 与 POST `/:id/restore` | `routes/threads.ts:1512` 是软删除，`:1584` 是恢复；PDL 消息／侧栏／trash 仍使用。 | **不删**。拿掉彻底删除／清空不等于拿掉软删除与恢复。 |
| 旧 CollectiveLaunchSurface／专属 React 连接、pairing、文档与媒体桥界面 | 仍有旧客户端壳和行为测试引用；本轮只复用非界面 canonicalClientUrl／服务选择函数，并已把选择函数从旧 hook 移到 collective-client（只有一份）。 | 旧壳列待审，客户端本身归插件 frame；真实 bridge 协议／鉴权行为不能按 JSX 名字一起删。插件仓声明未补前保留源码，宿主不挂载。 |

本轮没有删除接口、旧组件或测试文件。旧 background route 的原形状测试现在属于明确改掉的旧协议，未为了让它继续通过而加兼容；本轮用新 owner 的持久化、权限、并发目录与原始字节测试验证新契约。全仓旧测试的退休范围仍等审阅。
