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
- Host source-backed 检查 64/64：实际发送、延迟附件发布、队列、旧回执升级、专用 Redis CAS、精确归档准入与空缓存离线安装。
- Web 受影响 98/98；共用身份适配的最终增量另跑页面/隔离/可见性检查。API/Web noEmit 类型检查通过。
- 插件 178/178：首次及候选自动验证、旧订阅过期恢复、重复订阅、启动恢复、失败重试、创建结果未知、停用排空，以及验证中再次调度。SDK module runtime 23/23；workspace version links 2/2。
- 真实生产接线的隔离浏览器：InvocationQueue → addressed delivery → 系统回执推送；SDK send → SendService → broadcastIngress/connector_message → Socket.IO → useSocket → Zustand → ThreadChatSurface。正文接替、成员/插件失败终态及刷新无旧占位均验证，无状态轮询。外部 ChatGPT 与 history/provider hooks 为 fixture，不能冒充真实 Work。
- 新插件归档中的 87 个运行、资源与 manifest 文件和重建输出逐字节一致，随包 manifest 与插件声明一致。最终 SHA256 见同目录 archive-sha256.txt 及 Host bundled definition。

## 自检取舍

风险：behavior=回复与自动工作流；data=新增持久字段与 CAS；security=原实例/源消息归属；contract=可选 SDK 字段；irreversible=无。

Architecture cells：现有 messaging、dispatch、bubble-pipeline、thread-chat-surface、plugin runtime。Map delta：无 owner 转移，没有新 Store/Queue/Router 或 Host Dot 分支；自动验证模块属于现有 Dot runtime。当前 checkout 没有可执行 architecture-map 检查器，按实际改动核对边界。

Redis 用自有 UNIX socket 子进程验证，不读继承的 REDIS_URL、不连接保留端口、不清库，保存测试数据与日志。范围明确，未重复运行会建立额外 TCP Redis 的整套 gate。

Tips：沿用现有目标回复与插件安装操作，无新增用户入口；自动验证减少原手动步骤，失败恢复在状态行内，沿用 F202 既有 tips_exempt。capability-tips 检查通过。

根目录无媒体工件；截图与打包证据保留验收目录。未重建运行 Host 的 API dist/Web .next，未更新运行配置、安装插件、重启或旋转现有凭据。

独立复审及 operator 加载后真实 Work/普通 @dot/重试体验、fork soak 仍为后续验收。本文件不代替这些结果。
