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
