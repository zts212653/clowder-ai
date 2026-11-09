# F202：统一参与者回复与自动验证

接受来源：thread_mvgmbqy65mk8bnox / `0001794198667078-000400-c9191878`。本次沿原 F202 Task 继续，不改变 ownership，不宣告迁移整体完成。

## 用户结果

成员和插件使用共同的等待、正文接替、完成与失败展示规则；插件仍由自己的执行后端投递，不制造成员 invocation。Dot 收到订阅后自动完成读取原消息与校验码回复验证；正常状态区只保留状态及适用的凭据轮换、断开和取消更新，失败才提供重试。生成结果的复制沿用既有通用组件。

## 权威与边界

- Host 复用现有 plugin delivery 系统回执作为目标回复载体，新增 revision、真实 deliveryId、源消息、目标、状态与结果消息引用。专用 CAS 更新；普通 extra 更新不能覆盖回复状态。成员仍读取原有 response lifecycle，两者通过同一展示投影和 frame 输出。
- SDK `messaging.send` 增加可选 `response: { deliveryId, status }`，必须同时给出原 `replyTo`。Host 以实际调用实例、线程、源消息和唯一 dispatch ref 验证归属；客户端不能声明其他实例身份。
- 投递接收、可见内容、执行完成分别记录。队列在投递结算后释放；第一段内容只移除等待占位，不替多段回复插件宣布完成。Dot 的完整文字回复显式报告 completed。失败、取消、中断使用同一终态展示。
- 终态不能被晚到接收回执或旧 revision 降级。结果引用与状态持久化，刷新不靠组件挂载时间决定是否等待。旧回执只作 transport fact；首次明确结果按原归属原位升级。即时与延迟附件发布走同一结算入口，重复发送可补结算，不重复广播正文。
- 插件本地桥接停止不证明远程任务被取消，不伪造 interrupted/completed；执行后端有明确结果才报告终态。未知投递不自动重发。
- Dot 仍自行管理凭据、订阅和验证状态，Host 没有增加 Dot 凭据或测试业务接口。

## 自动验证与恢复

订阅落盘后异步安排验证。插件存储保存任务、nonce、线程与事件，实际 fingerprint 来自安装实例、attempt、token 和回调绑定内容；同一回调续订与候选成功转正不会另造验证任务。具体在途写入仍受原授权和绑定版本约束。

状态查询只读。启动时恢复未完成验证；停止会中止并等待已准入后台工作。失败重试复用原 nonce、线程、源消息和事件，通知失败有界重试。候选验证只发往候选回调，成功前保留正式连接。取消、撤销、替换候选后迟到工作不得转正。

通用 webhook 没有“远端已收到 HTTP 响应”回调，因此只承诺订阅处理返回后异步执行；延时不冒充送达证明。线程创建缺少幂等创建接口：先保存创建意图；若中断导致创建结果未知，停止自动新建并提供明确修复。主人显式重试该窗口可能新建一次测试对话，不能承诺绝无孤立测试对话。

## 实物与验证

证据目录：`.cat-cafe-runtime/acceptance/f202-target-response/`，仅隔离数据。

- 观察 RED：旧 Host SDK send 拒绝 response 字段；旧插件订阅后不会自动开始验证。
- Host source-backed 检查 65/65：实际发送、延迟附件发布、队列、旧回执升级、专用 Redis CAS、精确归档准入与空缓存离线安装。
- Web 受影响 101/101；共用身份适配的最终增量另跑页面/隔离/可见性检查。API/Web noEmit 类型检查通过。
- 插件 188/188：首次及候选自动验证、旧订阅过期恢复、重复订阅、启动恢复、失败重试、创建结果未知、停用排空，以及验证中再次调度。SDK module runtime 23/23；workspace version links 2/2。
- 真实生产接线的隔离浏览器：InvocationQueue → addressed delivery → 系统回执推送；SDK send → SendService → broadcastIngress/connector_message → Socket.IO → useSocket → Zustand → ThreadChatSurface。正文接替、成员/插件失败终态及刷新无旧占位均验证，无状态轮询。外部 ChatGPT 与 history/provider hooks 为 fixture，不能冒充真实 Work。
- 新插件归档中的 87 个运行、资源与 manifest 文件和重建输出逐字节一致，随包 manifest 与插件声明一致。最终 SHA256 见同目录 archive-sha256.txt 及 Host bundled definition。

## 自检取舍

风险：behavior=回复与自动工作流；data=新增持久字段与 CAS；security=原实例/源消息归属；contract=可选 SDK 字段；irreversible=无。

Architecture cells：现有 messaging、dispatch、bubble-pipeline、thread-chat-surface、plugin runtime。Map delta：无 owner 转移，没有新 Store/Queue/Router 或 Host Dot 分支；自动验证模块属于现有 Dot runtime。当前 checkout 没有可执行 architecture-map 检查器，按实际改动核对边界。

Redis 用自有 UNIX socket 子进程验证，不读继承的 REDIS_URL、不连接保留端口、不清库，保存测试数据与日志。范围明确，未重复运行会建立额外 TCP Redis 的整套 gate。

Tips：沿用现有目标回复与插件安装操作，无新增用户入口；自动验证减少原手动步骤，失败恢复在状态行内，沿用 F202 既有 tips_exempt。capability-tips 检查通过。

根目录无媒体工件；截图与打包证据保留验收目录。未重建运行 Host 的 API dist/Web .next，未更新运行配置、安装插件、重启或旋转现有凭据。

独立复审及 operator 加载后真实 Work/普通 @dot/重试体验、fork soak 仍为后续验收。本文件不代替这些结果。

## alpha.34 独立复审修正

来源：Host finding `0001794202224593-000593-33288a85`、插件 finding `0001794202244306-000598-c0cafc41`，四个 P2 均有独立 RED。本轮先区分“已有记录”和“流程完成”：接受过的内容、投递的当前状态、证明的本地提交分别恢复。

- H1：真实实例/源消息归属仍在 SDK 边界核验；终态准入检查移动到 send ledger/staging/持久消息索引区分新旧之后。新请求不能重开终态，旧请求取回原回执；已接受附件迟到发布只发内容，不改终态或最终结果引用。
- H2：同一次投递只有原 carrier 拥有等待或空终态框。空 processing/result 行没有第二个框，读取该 delivery 最新状态；可见的分段正文保留。空结果对应的导航指向实际显示框，正文或附件到达后旧空帧一起消失；历史缺 carrier 时空结果也不另造头像。
- D1：读取持久 dispatch 与真正发布的 reply，核对 nonce、digest、源/线程关系和原 candidate/token/binding，复用原 recordPendingEvidence 提交读取/回复证明及转正。sent/failed 作业恢复也先补本地证明；不再把 replyMessageId 存在视作已完成转正。取消、替换、断开后的旧证明拒绝提交，不重发正文。测试 fixture 补存真实 Host 本来就保存的 replyTo，恢复检查未放宽。
- D2：candidate-verification-timeout 明确给 retry-verification，保留适用的 cancel/disconnect。重试复用 nonce/thread/source/event，不依赖状态查询触发工作。

复验：reviewer 6 条后端复现及 1 条投影复现转绿；插件自动验证 19 条包括首次/替换、启动/手动恢复、三个在途取消变体、两个超时恢复和被改写正文拒绝转正。全套插件 188/188；Host 65/65（包括空缓存离线安装）、Web 101/101；API/Web/Dot noEmit 通过。浏览器实际 Queue/SDK/Socket.IO 链增加合法空 processing 结果，验证仍只显示一个框，最终正文接替、空失败终态和刷新不复活均通过。

最终 alpha.34 随包 87 个运行/资源/manifest 文件（连两份 README 共 89）逐字节一致；SHA256 `05734f5b8f9a443fb7963e6de85304e288cc57d25a436a1482aa109020ef2685`。SDK 仍为 candidate.12。运行实例与凭据保持未操作，真实 Work 与 soak 的未完成状态不变。

## alpha.35 连接状态默认展示

来源：`0001794205636142-000822-814b83ed`，operator 要求去掉“Dot 连接”的常驻刷新按钮，默认明确显示待连接。

Git 核验：Host 通用 OperationRowsRenderer 的固定列表刷新按钮已存在于 `43816128ab4`（2026-10-20，F202 C1），本次不是新增此约束；问题是把返回 rows 的操作列表和只读连接状态混在同一套控件中。

插件用现有 render=polling 声明自动观察，不增加 Dot 名称分支或新契约字段。未配置/尚无入口的状态投影明确返回“待连接”；未运行与真实故障继续显示真实状态，查询仍不创建授权/配对/验证。Host 对 polling rows 在正常状态不显示刷新控件；读取失败或有界观察暂停时提供“重新检查”；确认声明、其他显式列表按钮、proposal 放弃和 row 操作保持原边界。加载期间只显示读取中，不伪造待连接。

验证：原行为 RED（固定按钮、无默认状态）→GREEN；Web 受影响 94/94（含确认取消/确认、操作后刷新、观察期限与恢复）、插件全套188/188、Web/Dot 类型检查通过。默认行也直接通过通用 operation rows 校验（移除无动作行上的 undefined actions，保持 JSON 传输语义）。隔离浏览器使用真实 PluginManagerOperationField/ActionRenderer、真实插件投影和模拟传输，确认进页自动读取、仅“待连接”、无按钮，以及错误后重试恢复；截图 status-default-waiting.png，回执 status-default-browser-receipt.json。未操作运行实例。

最终包在显式构建后归档，89 个运行/资源/声明及文档文件逐字节匹配，SDK 仍 candidate.12；独立复审与实机加载仍待推进。

### alpha.35 配置失效后的状态恢复

独立复审来源 `0001794206684416-000881-65887a7a`。隐藏常驻按钮后，原有 configKey 失效路径只清空 rows、取消请求和终止观察，却没有重读；修改 callbackProxy 等共享字段会留下永久空白。已先独立重跑 reviewer 反例，polling 分支 RED；补入初读仍在途、读取已完成两条回归也均按缺少第二次读取失败。

现在自动状态在原失效处理完成后重新发起未确认的纯读取，并重开有界观察。旧请求 abort、epoch 检查及 proposal 作废顺序保留；确认型操作继续等待主人确认，不恢复常驻刷新，也不重挂整个设置区。检查本组件的其他清空状态入口：目标/声明变化、proposal 到期、放弃已有对应读取，配置失效是本次遗漏；生成 URL 等兄弟操作仍保持独立结果。

验证：受影响 Web 96/96、reviewer 反例2/2、Web noEmit、Biome/diff 检查通过。新回归覆盖配置变更时的两种读取顺序、旧请求迟到被拒绝及确认权限；隔离浏览器从真实 PluginManagerOperationField/ActionRenderer 输入配置，确认自动重读后显示待连接、无常驻按钮，错误恢复后按钮消失。回执 `status-config-browser-receipt.json`，截图 `status-config-waiting.png`。本轮只改 Host，插件 exact HEAD `f7bb6934` 沿用批准和原 alpha.35 包，未操作运行实例。Host 新提交仍需独立复审；真实 Work 与 soak 未完成。

## alpha.36 按连接状态组织恢复

接受来源 `0001794209197166-001071-d1af11cb`，前述模型 `0001794208818902-001001-f9e9614b`。Before：入口失效仍给放弃更新/断开，operator 需要理解并清理候选。After：状态区只给对应恢复步骤，新 URL 创建替换候选，正式连接保留到新验证成功；历史消息与线程不动。

复用现有 Host operation 字段、通用确认/文本复制/有界观察；不新增 Host 状态判断。插件负责真实状态与恢复，Host 保持安装/生命周期边界，operator 保留创建入口、轮换/撤销及在 Work 发送订阅消息的明确授权。只读交互稿由 astra 源码复核后回传（同线程 alpha.36 design），不等于代码批准。

| 状态 | 操作与结果 |
| --- | --- |
| 未配置/已断开 | 待连接，上方生成 URL；查询不创建授权 |
| 等待发现/等待订阅/验证中 | 无清理、手动检查或测试按钮；指出对应外部步骤 |
| 可用 | 断开连接，确认后撤销授权，保留历史 |
| 验证失败/超时且授权仍有效 | 重试验证，复用原作业、nonce/thread/event及已保存证明 |
| 消息/订阅过期、候选配对失配，URL与密钥有效 | 重新生成订阅消息，同 URL 在目标 Work 发送；恢复候选 intent/binding/proof 时精确 CAS 且不改 current |
| 入口或访问凭据失效 | 指向上方相应 URL 创建/生成；不以取消/断开充当恢复 |
| 插件未运行 | 指向插件卡片恢复运行，不提供必失败的验证重试 |

轮换作为上方 URL 区显式独立操作，沿用确认/文本结果，提示完整 URL 可能变化及需外部添加。后台 cancel 与撤销 fence 保留，但不再把它们作为正常恢复步骤。禁止用现有 begin(true) 冒充无损重连；失配恢复保留原 token/URL/discovery，清除失配候选证明，迟到旧操作继续受 candidate/token/attempt/binding 约束。已过期正式 subscription 对象也须更新配对码，不得只判断对象是否存在。验证失败作业不得盖过 runtime/入口/凭据/订阅状态。

实施顺序：先覆盖状态操作的 RED；补插件内同授权恢复与正式订阅过期分支；移位声明及更新旅程说明；完整插件回归、实际通用 rows 文本复制的隔离浏览器、显式构建与精确包离线安装；两份 exact HEAD 独立复审后交 operator 加载体验。真实 Work 和 soak 仍独立于本轮检查。Mission Hub 本轮写入返回 strict_owner_auth_required（403），保留失败事实，未创建替代 Task/接管 legacy owner；本文件与源消息记录进展。

### 实现与自检

交互稿来源 `0001794209489413-001090-b4c09e98`。正常行仅断开；等待/自动验证无清理按钮；访问凭据/入口失效明确指向 URL 区，失败作业不能遮盖这些故障。轮换移为两个 URL operation 的独立确认按钮；尚无可用入口时返回明确操作指引，不签发无效凭据。订阅消息/订阅到期和候选失配通过新的主人恢复动作返回可复制的同 URL 订阅消息。

恢复采用原 external 单记录 CAS：校验原候选、token 与 revision，清除失配候选 binding/intent/proof，保留 token、URL、discovery 及 current；begin 前后仍检查原授权身份。已接受的取消/断开可使迟到恢复失败，不能再生成新的有效 identity。statusState 对失配候选回调不强行 apply，而是展示实际失配供主人恢复。正式 subscription 对象过期时也更新配对码；生成后再次取消息复用该码。

完整 RPC 反例发现：即使新的订阅成功，同 URL/密钥/回调的旧 sent 作业仍会阻止新验证。因此仅在明确修复授权时在 external 保存 verificationGeneration，加入既有验证任务指纹，并随候选转正保存；普通续订/重启的旧指纹不变。旧事件不能给新 intent 记证明，修复前历史测试也不能冒充修复后可用。反例已由未启动自动验证转绿，覆盖候选完整重新订阅与正式订阅过期后的新验证、重启复用。

RED 证据：`/tmp/f202-alpha36-projection-red.log`、`/tmp/f202-alpha36-recovery-red.log`、`/tmp/f202-alpha36-repaired-subscribe.log`、`/tmp/f202-alpha36-mismatch-projection-red.log`。相关恢复检查含候选配对/回调两种失配、CAS 期间替换、提交后断开、旧校验回复迟到、正常/候选重复订阅、首次/替换超时及原入口过期后的完整 discovery/subscribe/read/reply。

隔离浏览器 `connection-recovery-browser.mts` 使用实际 Host operationFieldProjection、PluginManagerOperationField/ActionRenderer、实际插件状态与 owner action；只将网络与 Host 数据置于自有 fixture。入口失效无清理按钮，订阅失效仅重新连接，确认后消息实际写入剪贴板，状态继续到等待订阅且无常驻刷新。回执 `connection-recovery-browser-receipt.json`，截图 `connection-recovery-endpoint.png`、`connection-recovery-subscription.png`；不冒充真实 Work。自有浏览器和服务器均已关闭。

Fallback 检查使用原脚本仅适配插件根路径：生产 automatic-verification +1、connection +1、journey-projection 净0；测试中空 actions/可选 detail 的断言合计触发阈值，并非多级执行兜底。生产新增选择明确对应当前/候选授权和恢复 fence，没有 Host 分支、缓存或新的回退路由。最终安装包须显式构建后归档、逐字节比对与空缓存离线安装，再交两份 exact HEAD 复审。未安装插件、更新运行配置或重启服务。

最终自检：插件 200/200（`/tmp/f202-alpha36-release-suite.log`）、构建/类型检查通过；隔离浏览器确认与实际剪贴板复制通过；精确归档准入及空缓存离线安装1/1（`archive-alpha36-final.log`）。89个运行/资源/声明/文档文件逐字节匹配；alpha.36 SHA256 `7980c52f0a7a2d34fb9887dddfd0c6f6dd53e52bf1e816e1f889dac40ba5832b`。SDK 仍 candidate.12。插件提交 `2d5db3fea3f4b814e5db8491ef65f291f3b3e37d`，Host 增量仅本记录与随包版本/完整性引用；正式 exact-HEAD 复审、实机体验与 soak 保持待完成。

## alpha.37 恢复身份与过期邀请边界修正

复审来源 `0001794211206761-001191-49673b4f`（插件两个 P2）、`0001794211207100-001192-c3c07ee8`（随包，没有独立 Host finding）。两条 reviewer 反例在原 HEAD 独立重跑为 RED：`/tmp/f202-alpha37-reviewer-red.log`；移入原测试集后同样 RED：`/tmp/f202-alpha37-regression-red.log`。

- P2-1：删除 begin 失败分支的补偿撤销。配对身份在持久提交后可能已被其他主人请求采用，旧操作不能再认定独占并反向撤销。失败保留可重试的未完成身份，原 external 授权、订阅、候选证明与撤销检查继续决定实际访问；显式断开/重置保留原语义。新增中断首次初始化的检查，证明旧 token 已被撤销、新候选不能执行 business、未配对 identity 不能 ready，主人重试复用身份。
- P2-2：主人恢复先经 owner/installation 检查，再核对捕获 identity 的 attempt/revision 及 external 原 candidate/token/revision CAS。移除在这一主人入口调用 sameAttempt(false) 时附带的旧邀请期限要求。真正首次配置的回归明确清空 fixture legacy token，覆盖 base identity、候选配对窗口和候选订阅都过期后的完整重新订阅、读取与回复。远程过期邀请仍被拒绝，公共 subscribe/read/reply 的期限检查没有修改。

同型审视：两个问题都将“初始化/恢复的身份连续性”与“授权是否仍有效”耦合。已核 begin 全部设置入口与 repair 调用，撤销仅留在显式断开/重置；远程 sameAttempt 与候选 token/binding/event 校验不动。没有增加独占身份标记、补偿 Store 或新的 Host 分支。

最终插件提交 `c7e0c7c34898be4d3753a9985a310d50b30f75ae`。原 reviewer 2/2 GREEN（`/tmp/f202-alpha37-reviewer-green.log`）；插件全套203/203（`/tmp/f202-alpha37-release-suite.log`）、显式构建/类型检查通过。原隔离浏览器的真实投影/组件/插件动作、确认/剪贴板复制/等待状态继续通过（`connection-recovery-alpha37-browser.log`），自有实例已关闭。

alpha.37 最终包 SHA256 `11037b27a9598ea62b8e1907505b8c9f59a0a518d1f09bbdb5056412af563942`，89文件逐字节比对；精确准入与空缓存离线安装1/1（`archive-alpha37.log`）。Fallback 生产 connection 净减少3，累计阈值为既有代码总量，本轮未增加回退层。Host 增量仍仅随包/版本/摘要及本记录。独立新 HEAD 复审尚待返回；真实 Work、operator 体验与 fork soak 未完成。未安装、重启或更改运行配置/凭据。

## alpha.38 请求结束后的后台验证

故障来源 `0001794214590332-001425-e283d9be`：订阅后等待读取超时，点击重试仍失败。只读核对目标测试实例：Host health 正常，部署 revision 为 `4e2ae176`；已安装 Dot alpha.37。08:54:46 UTC 收到 events/subscribe，08:54:50 的验证通知已得到成功回执；该事件 sourceReadAt/replyMessageId 均为空。08:56:13 的 retry-verification 返回502，库存 runtimeState 变为 crashed；用户随后确认 ChatGPT 显示订阅成功、之后没有新消息。这些证据证明没有成功读取，不能单独证明云端已执行或未执行工具。

独立隔离复现使用实际 Host ModulePluginRuntime/execution worker 和真实插件 AutomaticDotVerification，数据与回调均为自有 fixture。正常 activation 后触发 owner/native 请求，延迟后台 Host 读取跨过请求结束：旧版继承已结束的 request authority，后台读取被拒绝，错误日志的远程 Promise 也被拒绝，worker 退出，下一次调用无可用模块。无请求上下文的对照成功。原 alpha.37 已安装代码仅作为只读模块导入到新建测试 worker，未修改或调用运行实例。

修复仅在插件内捕获 runtime 构造时的 activation async context，并在该上下文创建后台计时器；状态查询、主人重试的同步授权仍按原上下文检查。后台任务仍逐步检查 installation/attempt/token/candidate/binding/event，停用与取消仍终止任务；未放宽 Host caller fence，也未引入新的 Host 后台权限接口。首次订阅与主人重试均覆盖请求结束后继续执行，并复用同一事件。

RED/GREEN：`sol-auto-worker-repro.test.mjs`（本目录 acceptance/f202-target-response），旧包日志 `/tmp/f202-alpha38-worker-old.log`，修复日志 `/tmp/f202-alpha38-worker-new.log`；插件回归新增 activation/request 生命周期检查，完整204/204通过（`/tmp/f202-alpha38-suite.log`）。显式构建与类型检查通过。alpha.38 SHA256 `14b4d67f12c21350dcb2307d93ede8b74b4c00198303fd4b788ac58a1a43fd7d`，89个运行/资源/声明/文档文件匹配，精确准入与空缓存离线安装1/1。插件提交 `9385ebb6b955fb1d5e616ba0a73fd58bf3a1713b`，Host 仅随包与记录。独立复审待返回；尚未更新运行插件、重启或更改配置/凭据。最初通知未触发成功读取的云端原因，以及修复加载后的真实 Work 往返，仍待实机确认；不能将隔离回归当作已恢复。

## alpha.39 首轮 GitHub 审查修复

提交 PR 来源为本线程 operator 消息 `0001794224103181-000003-ede85be7`。Host 为 [clowder-ai#1923](https://github.com/zts212653/clowder-ai/pull/1923)（next），插件为 [clowder-ai-plugins#209](https://github.com/zts212653/clowder-ai-plugins/pull/209)（main）。目标分支前进造成的冲突仍待处理，本轮不合并或发布。

云端三条 finding 均已独立验证：

- [P1 收件箱升级](https://github.com/zts212653/clowder-ai-plugins/pull/209#discussion_r4512415437)：新增严格 delivery.reason 使保留的 Superagent inbox 无法读取。只在持久 inbox 解码中为缺少 reason 的旧 message 补 subscription；不改全局 contract，也不接受没有 reason 的新入站。覆盖 pending/routed/failed/done，实际 coordinator inspect、主人 retry 和后续路由，并验证写回规范记录。
- [P2 快速回复](https://github.com/zts212653/clowder-ai-plugins/pull/209#discussion_r4512415447)：同线程/配对/目标成员的 ask reservation 尚未保存 messageId 时，不能把回复确认成不相关。现在抛可重放错误；Host SubscriptionDelivery 的持久游标只在全页接受后推进，保存 ask 回执并再次注册订阅后可重放。重放沿已有稳定 deliveryId 去重，无新增插件缓冲表、轮询或等待锁。
- [P2 重复取消](https://github.com/zts212653/clowder-ai-plugins/pull/209#discussion_r4512415459)：没有 pending 时返回当前状态，重复及 CAS 交错取消不再清掉恢复后的有效 endpoint，也不触发入口停止。

同型检查：本 PR 中以新 delivery contract 解码持久原始 delivery 的入口只有 Superagent inbox；其读队列、检查、重试均共用该 schema。Dot 其他按 generation 保留 current 的到期路径已有 no-op，显式撤销仍有意清除授权。本轮三种失败分别属于存量解码、未完成关联的确认、幂等终态；未放松身份与撤销边界。

RED 日志 `/tmp/f202-pr209-inbox-red.log`（旧记录4/4失败）、`/tmp/f202-pr209-dot-red.log`（快速回复被错误确认、重复取消清掉endpoint）。修复后 Superagent20/20及类型检查/构建、Dot205/205及显式构建通过；fallback检查相对9385ebb6没有模式增长。插件提交 `dacc5bf92dc0ef7c82761bbd8de30e744601fb1c`。alpha.39精确包SHA256 `2070781d7ef590712874e651462e2c96a416cef69d1c952bb74cca9131589836`，89文件匹配，归档准入/空缓存离线安装1/1。Host仅更新配套包与本记录，未操作运行实例。修复证据沿原GitHub线程回复并重触发cloud review，不召回已完成本地reviewer续签；新HEAD的远端审查尚待返回。


## alpha.40 第二轮 GitHub 审查修复

本轮承接 PR209 对 `dacc5bf9` 的两条 P2，未扩大到合并、发布或运行实例操作：

- [遗留 ask 预留阻断重放](https://github.com/zts212653/clowder-ai-plugins/pull/209#discussion_r4512777633)：只有当前运行中的同 key ask 可以暂缓游标；按 ask key 串行发送，失败或中断的空回执预留保留供原 client_message_id 幂等重试，但不再阻断无关消息。发送前和发送后报错、重启、后续有效回复均覆盖；已提交后报错的显式重试不重复发消息。同型检查额外复现了存储快照期间发送刚完成的窗口，使用发送修订计数检测跨快照变化，保留重放而不错误确认快速回复。此修订计数只判断本进程是否仍有可能提交回执，不冒充持久任务真相；未完成记录和幂等键仍持久保留。
- [正式返回入口不可用仍确认投递](https://github.com/zts212653/clowder-ai-plugins/pull/209#discussion_r4512777641)：`ready` 检查正式凭据期限、安装实例与正式入口租约，签名凭据还检查 Host 当前有效性。候选未转正时使用 previousEndpoint 核对旧正式入口，不让候选的新 URL 替代正式返回路径；legacy 兼容路径保留。到期、停止、无入口、错误实例、Host 撤销及读取期间入口失效均拒绝成功 webhook 回执；长期入口与候选隔离回归通过。

同型审计覆盖 ask 的空回执创建、写回、重放和重启恢复入口；其他 dispatch/image 预留不使用 null 记录阻断订阅页。本次两条都属于“存量记录不等于可继续执行”，但分别以实际发送窗口与正式授权/入口检查处理，不新增 Host 特例。fallback 检查相对 dacc5bf9 每文件各 +1（connection 的正式/候选入口选择；runtime 的活跃发送或快照跨版本判断），累计阈值触发已人工审视：前者选择真实正式入口，后者拒绝把旧快照当作无关回复，两者均不能删掉且未堆叠恢复策略。

RED `/tmp/f202-pr209-r2-red.log`、额外窗口 RED `/tmp/f202-pr209-r2-snapshot-red.log`；最终 Dot **219/219**、类型检查和显式构建通过。插件精确提交 `3e0e62f407ab3c4c5f14a03aed9e0f0ac1d80a5d`；alpha.40 SHA256 `e177c1f139f93aa1550d03b07aa6842d1c7c566941906ed1434ddd54ef9668e9`，89 文件匹配。精确归档准入与空缓存离线安装 **1/1** 通过（`archive-alpha40.log`）。Host 只更新随包/版本/摘要与本记录；实际 Work、合并冲突和远端新 HEAD 审查不由这些隔离检查代替。


## alpha.41 最终迁移范围收敛（2026-11-09）

operator 在本线程 `0001794229941774-000286-45879833` 指出 Host 新增规模不符合迁移预期；只读独立范围建议见 astra `0001794230190314-000300-4cb11d16`。此节取代此前阶段的 Host 外部签发、native 凭据文件刷新及通用共享授权产品方案。原提交 PR 授权仍为 `0001794224103181-000003-ede85be7`；没有合并、发布、安装或重启授权。

最终边界：

- Host 保留已被消费的插件目标准入、投递/持久回复状态、通用 webhook、隔离存储、消息/媒体以及配置展示。Dot 自管新连接的密钥、期限、订阅、验证与撤销。
- 撤出 Host keyring/外部签发与检查生产接口，native action、MCP 环境和 SDK action client 回到上游既有鉴权；不借迁移建设一套新 native 凭据刷新体系。SDK/Dot 的可选旧签名兼容类型不是本 Host 的签发接口。
- external-access 只保留旧 opaque token 的导入、读取、实例校验、转发和撤销；移除 ensure/rotate/access，普通启动与状态读取都不能生成 Host 凭据。
- shared-extension 限于已核验旧 Dot 共享 `/mcp` 的迁移承接。adopt 仅允许 official.chatgpt-dot，保留原 owner/AgentKey、实例/包/运行代、工具面摘要与迟到结果检查；移除新 proposal、prepare/bind/unbind、配置确认接线及其产品测试。工具面变化仍拒绝自动扩大旧授权。
- 旧连接、消息、图片的只读来源/权限核验、幂等导入、审计和历史 URL 保留。不能把真实旧数据兼容当成开发期 alpha 删除。
- 从当前树移除本 PR 累积的历史 alpha 包，只新增最终 alpha.41；上游原有 0.1.2 不动。旧 alpha.9 安全回归改为最小恶意 tar fixture；移除 alpha.19 的 Host 业务状态快照，通用 rows/确认校验仍覆盖，图标/归档测试对齐最终产物。

同步 upstream/next `50e5695607` 和插件 main `4051746b` 时，保留上游队列失败类型、生命周期 commit 标记、共享提及语法、配置校验和 GitHub Operations alpha.41 原发布依赖。Plugin 精确提交 `94b70ef2712865929480d8d1b1ae7857379af952`。

验证：SDK237/237及类型检查，Dot219/219，Superagent20/20；Host消息/媒体/native/共享兼容85/85，通用配置/提及/队列的定向检查及旧token 7/7，旧迁移与历史图片15/15，shared路由1/1，原生随包构建15/15；Web快照/终态/占位42/42。API及其 shared/MCP 类型在本工位隔离目录完整编译，不改运行 dist/.next。最终包89个运行/资源/声明/文档文件一致，准入与空缓存离线安装1/1。日志前缀 `/tmp/f202-scope-*`；隔离配置和记录在 `.cat-cafe-runtime/acceptance/f202-target-sync`。

alpha.41 SHA256 `9cd0fc515489a495ccb391a46ff56e8deca7644b172e5cfa1b07ad5d1e42c35d`；匹配SDK归档 SHA256 `54c212b8158d7959a93b62d36f48520f9c7c2b843b8d9c266b0675162f040e84`，锁文件固定实际归档完整性。已冻结的范围缩减与上游冲突解法仍需独立 exact-HEAD 复核；不会用前一轮 cloud 对 3e0e62f4 的结论替代。本轮未推送范围调整或操作运行实例。


## alpha.41 Host 旧共享连接的受限恢复

复审来源 `0001794233446071-000466-b9ceda55`，Host `659545192e` 的一个 P2；插件/SDK `94b70ef2` 沿用独立批准（`0001794233446207-000467-db524d1c`），包和摘要未变。

原 reviewer 两条反例已在修改前复现 RED：`/tmp/f202-scope-shared-recovery-red.log`。共同原因是删掉通用重绑定后，保留的旧共享失配状态没有受限恢复出口。现在启用后按 owner/source/同一安装实例查原完成审计，仍不重导入旧密钥或写新迁移审计；协调器向 shared adoption 传当前安装摘要。`ensure` 的精确包导入去重与已消费来源保护不变。

adoption 保留原 owner、实例、lineage 和批准工具摘要，当前安装/运行代及主人请求仍重核；恢复原工具面可从 needs-confirmation 回 active，实际扩大工具面仍持久失配并返回明确的新连接迁移指引。提交前比较原绑定快照；并发撤销/替换、请求失效、运行代变化不能被旧操作覆盖。没有恢复 prepare/bind/unbind、Host 签发或新授权产品。

已覆盖同安装更新、工具面恢复及扩大拒绝、原绑定撤销、其他 owner/实例/lineage、主人请求失效和迟到绑定/运行代/主体变化。新源码定向30/30；实际编译代码的迁移/图片/旧凭据安装集成与相关检查12/12；完整 API 在隔离输出类型编译通过。日志 `/tmp/f202-scope-recovery-{regression-red,targeted,compiled,types}.log`。另复验 reviewer 两条断言为2/2 GREEN（`/tmp/f202-scope-shared-recovery-green.log`）：第一条内存 audit mock 仅增加了新查询支持，允许省略 packageDigest 查同安装原审计，断言未改；原文件未动。另有真实 FileDotLegacyMigrationAuditStore + coordinator + journey + shared RPC 检查，不只依赖该 mock。

本轮未推送、发布、安装或重启，未改插件/SDK/归档，未将隔离检查当作新的 Work/soak 验收。新 Host exact HEAD 仍待独立复审。


## PR209 第三轮云端意见与 alpha.42

来源：[保存的前任临时租约](https://github.com/zts212653/clowder-ai-plugins/pull/209#discussion_r4513922164)、[Superagent npm 锁定](https://github.com/zts212653/clowder-ai-plugins/pull/209#discussion_r4513922169)，审查源为插件 `94b70ef2`。修复提交 `149db48d687f40c2bc1001b39afe50875ee692ca`。

- 启动时同步失效主 endpoint 及 pending.previousEndpoint 中的临时租约；expireTemporary 在同一次 external CAS 内按 generation 处理两个位置，不误伤新租约、不清凭据。重启、两类候选、取消后恢复以及旧租约结束的3条新增反例 RED→GREEN，formal 长期入口继续可用；同型审视覆盖启动、结束通知及取消恢复。 进一步用真实runner子进程复现结束回调继承已退休请求上下文；控制器在activation构造时捕获快照，结束写回回到activation，原代际及停用fence保留。新增反例RED→GREEN，最终冷装全套仍222/222。
- Superagent 不消费 SDK candidate.12 新接口，因此撤销无必要的版本提升，声明保持已发布 candidate.11，与现有 npm-shrinkwrap 精确一致。独立生产依赖闭包检查先 RED 后 GREEN；真正 npm ci 后类型检查与20/20通过，未用 workspace SDK 链接代替 npm 证明。
- Dot 两个测试文件直接使用 MCP client，补显式开发依赖1.26.0，并将其共同使用的 Zod 对齐3.25.76。干净、无公共 MCP hoist 的目录冻结安装、contract/SDK构建后 Dot222/222通过，含真实协议客户端与离线打包检查。运行源码的凭据/授权接口未增加；SDK源及版本不变。

Host CI 反馈也在原范围内处理：目标回复状态模块下沉至 messaging/target-response，纯搬移经逐字比较（仅两条相对导入）；删除合并遗留的未用导入；增量打包夹具带齐其真实运行入口。更新依赖后保持桌面桥1.7.0原有精确准入边界，没有把新版通用 manifest schema 当作扩大授权的理由。SIGINT 检查区分 Node wrapper 与 pnpm：两条都必须等清理完成，Node自身仍严格保留信号退出码；pnpm 在Linux可能已消费信号返回0，不将其误当 wrapper 退出码。

验证：Host消息/媒体/投递63/63、自有无端口Redis持久状态1/1、完整API隔离编译、使用实际新 shared/API 产物的 Web 全量类型检查、受影响组件 ESLint（0错误）、全部受跟踪文件 Biome 通过。最终实际编译产物的随包构建/闭包、显示、归档准入及桌面公开链路25/25，原SIGINT检查拆出的两条2/2。普通本地 pnpm check 已经过 source checks，但格式器会扫描本工位未跟踪的验收产物，故不声称该命令全绿；另以受跟踪文件范围核对格式，远端干净CI仍是后续真相。

alpha.42 SHA256 `7c261354961482b652d25dd34a85181b9e3891709815bd5a75fa3351e7c233bd`，89个运行/资源/声明/文档文件一致，精确归档空缓存离线安装通过。当前树仍仅新增最终归档，不保留alpha.41。日志 `/tmp/f202-pr209-r3-*`、`/tmp/f202-alpha42-*`、`/tmp/f202-ci-*`。未合并、发布、安装到运行实例或重启；新HEAD后仅回云端继续审查，不以旧本地批准替代。


## 当前 PR CI 与跨平台闭包（alpha.44）

本轮继续处理 PR1923 / PR209 的 CI 与云端意见，没有合并、发布或运行实例操作授权。

- Superagent 的早期 npm 验证不足：SDK candidate.11 的真实注册表包依赖 contract candidate.0，而旧 shrinkwrap 写成了 candidate.1，且 integrity 不符。现在由注册表重建真实嵌套依赖；声明仍使用已发布且足够的 SDK11，直接 contract 为 candidate.1。干净 pnpm 的 TS2742 已复现，fixture 使用显式返回类型后，pnpm 与独立 npm ci --include=dev 均通过类型、20项测试及构建，生产闭包检查通过。
- Host 云端 P1（discussion_r4513917964）成立：默认归档只有打包机 native sharp，其他平台的插件入口和迁移 importer 都会失败。全平台原生库试包超过既有预检预算，未交付到运行实例。最终 alpha.44 改为当前 native 后端加 sharp 已锁定的 WASM 后端，sharp 对齐仓内已有 0.34.5；不提高 Host 32MiB 压缩、64MiB 展开上限，也不新增 Host 目标平台安装分支。清空消费者中的当前 native 库后，真实离线安装、插件启停与两份独立安装的数据/图片迁移完整通过。
- Linux Dot CI 的 controller 反例实际注入 Node 假 tunnel，却被默认打包 binary 的 macOS 平台限制拦住。限制现仅约束默认资产，显式 binary 仍经文件/摘要/代际检查；默认非 macOS arm64 拒绝不变，没有扩大默认 tunnel 平台支持。
- 能力路由测试去掉重复嵌套的 writer fixture，避免清理后恢复到已删除的配置根；89/89通过。安装器断言跟随当前支持到 contract candidate.1 的范围，26/26通过；旧共享恢复的固定公开指引断言更新，manager routes 34/34通过。均未放宽生产校验。
- Web 生产夹具补齐新增的 addressed-targets GET；隔离生产 build 成功，当前真实 classic/v2 完成/退出/刷新四条浏览器旅程4/4通过，控制台及意外请求均为空。首次本地失败来自隔离编译根漏拷贝 guides，已补齐实际 YAML 资源重跑；未 mock 掉引导接口或放松断言。构建证据对应 Host 607532408c，后续只有随包与验收说明变化。

最终插件 HEAD `0c3b8457dcce0bd25330fe74707b1c17f99acd39`；干净冻结安装 Dot 222/222、89个自有发布文件逐字节一致。alpha.44 SHA256 `a39d8168901fd47091a15266571f12dcc82693f5d0cd73ae8d87043e1931ef99`，压缩22,375,382字节，展开61,803,004字节。当前树仅保留这一新增Dot版本；旧签名/native重构和通用共享授权产品仍在本次范围之外。完整API隔离编译通过，精确Host最终包预检/空缓存离线安装/入口与PNG实测通过，随包构建、闭包与显示检查19/19通过。归档检查由TS转为公共JS测试，并接入Windows smoke；远端当前HEAD CI仍是后续真相。

日志：`/tmp/f202-alpha44-*`、`/tmp/f202-superagent-pnpm-green.log`、`/tmp/f202-superagent-npm-final.log`、`/tmp/f202-capabilities-fixture-green-query.log`、`/tmp/f202-official-contract-range-green.log`、`/tmp/f202-manager-guidance-green.log`、`/tmp/f202-host-production-page-green.log`。本轮隔离证据不替代新的Work/soak；外部finding修复后回云端，不继承旧HEAD的本地批准。


## 第四轮云端反馈与剩余 CI（alpha.45）

本轮先汇总两份 PR 当前精确 HEAD 的全部失败，再按“撤销后的调用不得借用新授权”与“清理候选必须恢复正式状态”复查同类边界，未恢复已撤出的业务层。

- PR209 discussion_r4514952825 已复现：普通回复在 serial 队列等待，候选同 attempt 转正后，旧 token 仍可能借用新 current 发布文字和 completed。RPC 现在将原凭据传入所有外部操作，read 在读取后重核，reply/image/ask 在出队后及发布前重核原凭据。三个合法输入的排队回归均拒绝旧调用，换新凭据可正常发布；保留既有配对、实例、事件与 proof fence。
- PR209 discussion_r4514952836 已复现：正式 A 退订清空 B 候选后仍广告 B 的失效 URL。现在同一次 external CAS 恢复 pending.previousEndpoint；正式凭据仍保留、候选仍由 store 同步记入撤销摘要，旧 proof 不转正。
- 两条原问题在旧精确 HEAD 0c3b8457 的隔离源码上 RED，修复后 candidate-binding 18/18、干净完整 Dot 226/226、类型及构建通过。相同英文文档检查1/1通过；未声称完整 package inventory 本地通过（其他未构建插件没有 dist），当前 CI 曾在这一项只报告 Dot 英文标签。
- Host 5ba67573 的 lane6 暴露合并残留的 gpt-dot 创建/修改/删除特判，已删除；恢复通用别名冲突检查。测试按上游当前保存契约提供 expectedRevision，成员CRUD71/71、插件寻址15/15通过，Pro固定身份保护保持。
- lane1 新上游测试仍引用已删除的 DotConnectionRuntime。改用显式历史 builtin carrier 夹具，仍验证恢复意图、缺失归档拒绝和异常声明拒绝；不复活 Host Dot 业务，也不把夹具说成真实 Dot readiness。原三项3/3通过。

插件 HEAD `29ead50d3d576faa2db9bf3823229512ccbac428`；alpha.45 SHA256 `7e301c48d84fa7e2062f79e46e6e67c54d9a20c253e1ea3753370799e7950b5b`，89个自有文件一致，压缩22,375,510字节、展开61,804,886字节，原归档预算不变。完整API隔离编译通过。Host上一精确提交的Windows冻结入口实测已通过（/tmp/f202-windows-5ba.log），构建与Web生产旅程也已远端通过；这些是上一HEAD的事实，不能直接宣称新HEAD CI全绿。

本轮证据 `/tmp/f202-r4-*`、`/tmp/f202-alpha45-*`。代码与随包需回云端新HEAD复审；不继承5ba67573的无finding回执，不合并/发布/修改运行实例。

### 2026-11-09：R5 原凭据与候选入口提交边界、校验器内存恢复

- 对插件当前云端两项 P2 按同一授权不变量复查：异步读取后的快照不能替代原 RPC 凭据，最终转正不能只看 token 而忽略入口租约。退订 external CAS 核对原 caller 的 token、issuer 和当前有效性；候选读取/回复的 readiness 与最终 promotion CAS 共用入口检查。正式入口仍使用 pending.previousEndpoint，候选退出不损伤正式连接。
- 精确基线 `29ead50d` 的新隔离反例为 RED（旧退订借用新连接、临时入口退出/到期的最终提交和发布前检查）；原 CAS 快照保护的对照保持通过。修后 candidate-binding 24/24、干净完整 Dot 232/232，类型与构建通过。审核 subscribe、proof/evidence 和业务发布的同型边界，没有恢复 Host 签发或放宽旧授权。
- Host CI 的 manifest-memory 检查本地精确复现约 41 MB retained heap 增长。根因是每次新读配置都向全局 Ajv 编译新分支 schema。已验证的分支语法只允许字符串 const/enum，改为直接集合匹配；完整性/互斥性和原对象修改检查保留，8 MiB 阈值不变。contract 全套 663/663、类型通过，Host 原内存检查 2/2、契约政策/库存 23/23通过。
- 固定源码契约归档 `clowder-ai-plugin-contract-0.3.3-candidate.1-f202-2c14f0f2fda7.tgz`，SHA256 `d8793602f937e5d52cf34bf7fdd2de90f2d5c3ec7efe9f770f3cea004c069204`；文件名明确区分未发布源码构建与注册表包，更新 file 依赖、override、锁和摘要断言；未发布 npm 或伪造注册表 integrity。
- Companion 目录失败来自本分支对其无必要的 SDK/contract 构建依赖升级。恢复 main 的已发布 SDK candidate.9 / contract candidate.0，保留目录摘要。重建包的81文件和完整未压缩 tar 与 npm 已发布 alpha.37 逐字节一致；本机 gzip 压缩字节差异不冒充 Linux Machine catalog 已通过。
- 最终 Dot alpha.46，插件 `d21829674ff361aedd86e617a83dfac322ceae42`；89个自有产物与实际构建一致。SHA256 `8cec747364acbcfc7936a95f701335b7c4f457aef8db2f2789e81d9ebd2ae893`，压缩22,375,777字节、展开61,806,526字节，原32/64 MiB预算不变。上轮 alpha.45 的Windows与构建通过仅记作历史证据，不能覆盖新HEAD。
- API完整隔离编译通过。首次归档周边检查因本地 NODE_ENV=production 安装缺少开发工具 Biome 而失败，显式恢复 feature 工位开发依赖后重跑；不修改产品或测试来掩盖工具缺失。当前随包与契约增量仍待新HEAD的远端CI与云端复审，无新增fallback链、无运行实例操作。
- 最终随包/闭包/显示/离线归档 19/19 通过（`/tmp/f202-alpha46-host-final-green.log`）。重跑时同步隔离 stage 的源码 producer 与编译 producer，避免 source 模式仍选到旧 alpha.45；没有为此改变产品或断言。最终 API 编译、Biome及diff检查通过。插件两条 inline 已逐字回读确认；等待两份新提交的真实远端结果。

### 2026-11-09：R6 legacy lane 与保存的正式 tunnel

本轮先汇总新意见再核共同状态：`credential === undefined` 是 legacy 身份，并非可跳过授权；展示 endpoint 可能属于候选，并非仍在运行的正式 endpoint。前轮分别覆盖新式 credential 与 endpoint 结束，但未覆盖这两种旧入口/候选交错。

- subscribe 在开始及挑战完成后无条件执行原凭据授权；与 unsubscribe 共用 `requireCurrentCaller`，最终 external CAS 只允许原新式 token/issuer，或仍处于 legacy 的无 credential 调用。真实隔离 rpc 在首次 legacy 授权后转正同 attempt/配对码/回调的 B，旧 HEAD 继续写新 binding；修后拒绝且逐字保持 B。没有重开 owner 权限，也没有将历史 opaque 解释成新凭据。
- start-temporary 查当前展示 endpoint 与保存的正式 previousEndpoint，复用仍有效 runner 并核对 generation，不为未经验证的候选停止正式 tunnel；保留原到期时间。首次临时正式 A→长期候选 B→临时候选 C 的原反例 RED；修后取消 C 和完整验证 C 都只 start 一次。真实 Settings/RPC 流程使用 controller 隔离替身；原实际子进程/controller 生命周期检查继续覆盖 start/allowToken/stop，不冒充公网或 Work 验收。
- 同型检查覆盖所有可选 credential 分支、subscribe/unsubscribe CAS、read/reply/image/ask 和 proof/evidence，以及取消/轮换/切换对共享 runner 的影响。没有新增 Host 产品逻辑、恢复签发体系或添加 fallback 链；同一 caller CAS 约束被收拢复用。
- 插件 `4aa4e10e7e1f41ad7ac0695cb999d1303de53810`，定向43/43、干净完整Dot235/235、类型与构建通过。alpha.47 自有89文件逐字节一致；SHA256 `41fd333caa75b7cf33ed7a92b0c00d667406b433305336052479912e2dc2e208`，压缩22,375,959字节、展开61,807,562字节，预算不变。contract/SDK未新增改动，前轮contract663项与内存检查证据按原源码适用。
- GitHub 确认前一插件提交 d218 的两项CI均绿，catalog恢复已由Linux CI确认，发布步骤跳过。Host1b0348云端未发现主要问题；这些均不充当两份新HEAD的批准。两条新意见已分别回复并从远端逐字回读，仍待新HEAD的CI和复审；未合并、发布、安装或重启。
- 最终配套 Host API 隔离编译、Biome/diff通过；精确alpha.47归档/闭包/显示与空缓存离线安装19/19（`/tmp/f202-alpha47-host-acceptance.log`）。本轮未重复不受影响的Web页面或contract全套，也没有使用旧Head的远端结果冒充新Head批准。

### 2026-11-09：R7 延迟清理的提交顺序与归属

本轮把根因收拢为：副作用必须绑定原 authority，并在新一代可见前完成其前置检查。legacy connection 与 external 是两份持久记录，不能先撤销 external、再以另一份记录拒绝请求；runner 的身份是 generation，不能把停止当作“停止当前任何一个”。

- legacy unsubscribe 先CAS提交原 connection revision/attempt/revokedAt，再按捕获 candidateId/tokenId/revision/attempt 清理。新attempt在任一阶段胜出均不会被旧请求修改或撤销；没有声称跨两条记录是原子事务。新式正式凭据退订仍在单次external CAS完成。原 external-CAS 反例RED，修后原连接提交前、候选清理前两个交错窗口保持新 connection/external/URL与撤销历史不变。
- owner取消绑定开始观察的candidateId，CAS冲突重试不能清理替换候选；提交后停止携带旧generation。scoped stop只清理同步捕获的匹配runner，不推进全局epoch；因此不影响替代runner或后来正在准备的start。expiry定时器同样绑定自身generation；停用/disconnect/启动失败保留整体shutdown。Settings CAS提交前/后竞态与真实runner/controller交错反例均先RED后GREEN。
- 插件 `dcfae819d141e783f031a871b61327d2dcfe221e`：定向59/59、干净完整Dot240/240、类型与构建通过。alpha.48，89自有产物一致；SHA256 `42f80b89341701ef07848699c423a813195160182d13a02c3f652ec99f36b0f5`，压缩22,376,575/展开61,810,357字节，32/64MiB预算保持。
- Host当前CI另复现回复引用用例的router替身缺少resolveAdmissionTargets：两条whisper回复500。仅补受控成员替身接口，保留同收件人引用和扩大收件人不能引用的断言，原RED→12/12 GREEN；同型检索另外三处是队列层私语测试，不走该HTTP入口，未机械扩改。生产member-only私语校验不动。
- 两条云端意见已回复并逐字回读。前一插件4aa的完整CI已绿，不替代新提交结果。本轮仍无运行配置/实例改动、安装、重启、合并或发布。
- 最终Host API隔离完整编译、Biome/diff通过，精确alpha.48随包/闭包/显示及空缓存离线安装19/19（`/tmp/f202-alpha48-host-acceptance.log`）。等待新HEAD的远端CI/云端复审，不将4aa CI绿与5dcb云端无finding挪用于当前提交。

### 2026-11-09：R8 五项边界——投递身份、历史恢复与临时入口发布

本轮汇总Host两项与插件三项后，按同一流程重核“输入身份→副作用→持久化→历史API→页面”。普通事件的delivery幂等身份不是addressed目标结算身份；临时入口在创建、发布、结束之间也必须有一致的归属。

- subscription回流仍按原deliveryId生成幂等event，但只为reason=addressed保存目标结算deliveryId；Host不补假carrier、不放宽resolveTargetResponse。重投递规范化既有误分类记录。完整ask→家猫回流→read→reply测试保留replyTo与wake，显式投递仍completed。精确alpha.48与49归档加载真实运行时接真实Host校验函数：旧包RED（response does not belong to this delivery），新包通过；伪造订阅结算仍拒绝。证据packaged-followup-receipt.json、/tmp/f202-r8-packaged-{red2,green}.log，不冒充完整Work服务联调。
- 历史白名单同时补targetResponse/targetResponseResult的存在条件与字段投影。旧编译路由8种状态RED，修后HTTP历史56/56。浏览器使用实际Fastify messagesRoutes返回数据，接实际Socket.IO/useSocket/Zustand/ThreadChatSurface；旧路由等待态刷新RED，新路由等待、正文接替、空失败/完成/取消/中断及来源标记刷新通过。历史7读、0轮询、0pageerror；browser-history-receipt.json、history-*.png，未用直接Store转储绕过历史白名单。
- 临时启动在异步候选操作前保留controller epoch；调用及binary准备后replace前核原candidateId/token/有效期与owner fence。旧ticket不能替换新runner。新建lease发布失败仅清理本generation，复用正式runner不清理；真实controller及Settings交错覆盖两类结果。
- 轮换过期补偿改为cancelPending(candidateId)，不能清理后来候选；显式取消同样绑定候选，主人明确reset仍保留整体重建语义。旧CAS提交后暂停返回、推进时钟并生成长期B的反例RED，修后B及撤销历史逐字不变。
- end通知不再依赖generation已在endpoint入库：结束事实保存在external记录，CAS合并保持单调，revoke/reset不丢失；setTemporaryLease同一CAS拒绝已结束generation。首次发布CAS前退出、冲突重试、重启与reset后的迟到发布均拒绝，不能恢复死URL。新字段为插件内部可选状态，不扩Host/SDK契约。
- 插件 `6f595400aabaa2ef60bda5461c4f7d3062529cac`：完整干净Dot246/246，增强重投递断言的干净journey16/16，类型与构建通过。alpha.49 SHA256 `6bc8a58ba1a6c3bd46f534e5f913c129e2a1d84a65adcec3ee3eb5a8865987f6`；89自有产物一致；压缩22,377,470/展开61,815,458字节，32/64MiB预算不变。
- 五条意见均在原GitHub载体回复并逐字回读；新HEAD仍待CI/云端复审。本轮无运行实例操作、安装、重启、合并或发布。原contract/SDK未改，不重复不受影响的全套。
- 最终Host API隔离完整编译、Biome/diff通过；精确alpha.49归档/闭包/显示/空缓存离线安装19项与历史56项共75/75，最终历史夹具重跑56/56；SendService及adversarial23/23。证据/tmp/f202-alpha49-host-acceptance.log、/tmp/f202-r8-host-send-regression.log，实际页面与冻结包边界证据如上。


### R9：首条回流游标、已确认旧事件与断开前的操作

接受当前 Host b3f3f720 / 插件6f595400上的三条云端P2（Host4516301038，插件4516299007/4516299018），不改变已接受迁移范围。共同检查贯穿公开动作准入→存储快照→候选/runner副作用，以及ask→回流订阅→已确认dispatch→升级后RPC。

- 首次ask在发送wake:auto之前建立Host线程订阅，完成后再次核原凭据/attempt；订阅失败不发送。现有未保存ask回执的回流重试继续使用，不改Host订阅从当前head开始的契约。精确alpha.49冻结包接真实Host SendService/EventStreamService游标，早到成员回复被跳过为RED；alpha.50保留回复、待回执重试、读取及回复通过。
- 新dispatch保存Host交付的deliveryReason，明确addressed仍结算真实carrier。旧已确认事件在RPC授权读取时，从同attempt/thread、已保存ask父消息和实际接收成员核对旧subscription记录并持久修正，不依赖重投递；重启后直接reply与read→reply均覆盖。原source/owner/实例/凭据验证仍先执行。
- 临时启动在两层公开动作入口的第一次异步鉴权前共用一份epoch；鉴权、首次状态读取和候选CAS均核原票据。disconnect取消票据后，旧动作不得创建候选或runner。首次状态读取与最初caller鉴权暂停各有回归。
- 同型扫描还复现长期URL/轮换在首次快照后遇到disconnect仍重新创建候选，修为按原external revision提交；不借新快照越过断开。两条额外反例RED→GREEN。未改runtime配置或Host权限。
- 插件产品提交955ec6011b6f0addb2f7301f70e6404250448f38（最终HEAD deea1ee06d9cf5f2d62a54757fb823a4de69e6a8仅增强一行测试前置）：干净冻结夹具完整Dot254/254，源码关键路径49/49，类型与构建通过。alpha.50 SHA256 2cdba275dfbf17f2c35d90830011637091ccf7212c9cdf0389842403278b143c，压缩22,378,478/展开61,821,655字节，89自有产物与该提交本地构建逐字节一致；原32/64MiB预算不变。
- 证据：/tmp/f202-r9-red.log、/tmp/f202-r9-sibling-red-final.log、/tmp/f202-r9-green-final.log、/tmp/f202-r9-dot-clean-full.log；Host工位ignored acceptance中的packaged-first-ask-check.mts与packaged-first-ask-receipt.json；/tmp/f202-r9-cursor-red.log、/tmp/f202-r9-cursor-green-final.log。第一次临时打包夹具沿用旧dist已被检查拒绝，最终归档经过明确clean build后重新打包，旧临时产物未交付。
- fallback审视：本轮新增稳定交付种类、动作准入票据和原快照CAS约束，没有新重试/远端兜底链。仓内脚本默认origin/main扫描了非本轮全部上游差异，518文件触发不代表本轮新增；本轮新增单文件未达到三层fallback。
- 本轮无页面布局/交互改动，上一轮历史刷新浏览器证据继续适用。隔离真实Host类与冻结插件检查不是实际ChatGPT Work，也不替代新soak；未安装、重启、合并或发布。

- Host最终完整API隔离编译与Biome/diff通过；编译结束后重跑最终alpha.50构建/闭包/显示/精确冻结安装19/19（/tmp/f202-alpha50-host-acceptance-final.log）。首次并发编译期间的随包测试读到旧缓存已拒绝，不计通过；重跑使用最终产物。最终补强长期URL测试从无入口开始，以覆盖实际创建而非只读复用；6f595400的两条同型反例2/2 RED（/tmp/f202-r9-sibling-red-final.log），当前产品实现均GREEN。
