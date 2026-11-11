---
topics: [dsh, acp, turn-steer]
doc_kind: plan
created: 2026-11-11
tips_exempt: "沿用现有聊天＋菜单的发送策略和已读提示；本单补齐 DSH provider 接线，现有引导当前回复指南仍适用。"
---

# Issue #1947：DSH 同轮输入接入

状态：实现、作者自检、实际成员 UI 与冷重启验收完成；PR #1950 已 Ready。Kimi 已批准 b70ae9da；云端三项 P2 已修复，待新 HEAD 云端复审、CI 与 zts 批准后合入 next。PR 创建不等于完成托付。

## 托付、依据与范围

- 原授权：`thread_owned_d5b52fcb85a34e07e84cb632ca833feab7efc76b#0001794390195431-000015-ccae82c0`。
- Issue 及讨论：<https://github.com/zts212653/clowder-ai/issues/1947>。
- 前期真实实验与失败样本：<https://gist.github.com/whutzefengxie-ops/420de07ab94be4e73924036a8de73eb5/d9a1b2a521c589cafe48aaaf3085e0ecaf182733>。
- 目标：实际聊天中选择“引导当前回复”，让运行中的 DSH 在同一原生 turn 采用补充输入；原生提交后才显示已读，并持久保留受理/消费事实。
- 作者 sol；共同方案与桥实现：鲸鲸。最终独立审查须为非作者并覆盖 exact HEAD。
- 工位：`G:\AIwork\clowder-ai\worktrees\fix-issue1947-dsh-turn-steer`；分支 `fix/issue1947-dsh-turn-steer`。
- 基线为最新 `upstream/next@970ae0265397cb313ddc6084cff1215027e9d02c`。
- 按用户要求，以 merge 提交 `b18f4cd5c57dc39f784bae7ec03b0f616e8dfe53` 继承 PR #1928 的 `f6e566e7867e49033c9037db1d2029a5f78a50b4`，没有修改主工位或在线 runtime。
- 审查前同步 PR #1928 最新 `894b7a6f3ce36c60383da82ba7a5e9fa7aba2ca4`，其唯一新增提交只是合入 next `1fb70210bb6fba10f6f1cd5b02366fb827e29221`；本工位 merge 为 `243146e662a82a1124f836edaa52513fb55f8716`，无冲突。

## 根因及共同讨论

1. 固定安装的 DSH Desktop 0.2.2-rc.1 有公开 Agent.steer，前期真实实验已证明它能在当前 turn 的步骤边界采用输入。
2. 官方 ACP 的 session/prompt 拒绝并发请求，没有暴露 steer；因此不能靠再发一个 prompt 实现同轮输入。
3. Host 的通用 ACP 路径也没有注册活动输入 dispatcher，freshness/read/inspect 为 unsupported。
4. RegisteredSession 已向内层透传 activeRunDispatch，并代理 freshness；应接到实际 ACP service，不重复注册。
5. 既有 Queue 的 force-steer 入口是取消后重开合同，本单不改变该合同。

双方在编码前进行了三轮讨论：
- 鲸鲸独立核对：`message:0001794390246447-000019-bdb700ee`。
- 第二轮：`message:0001794391108610-000030-115e57c5`；sol 收敛：`message:0001794391231213-000031-0593611b`。
- 鲸鲸确认：`message:0001794391599780-000036-dbb36ecc`；sol 执行确认：`message:0001794391649588-000037-1848966b`。

一致结论：保留官方 ACP，以一次启动 overlay 的 disable + insert 重新托管，显式协商私有 turn 扩展；由原生事件提供 turn/read/end，接现有 Queue/History。整体替换 SDK 会扩大范围；等待上游发布不能交付当前场景；直接覆盖插件 name 无效，必须 disable 原 id 后插入桥。握手与桥仅限已核验的 Desktop 版本和完整 provider/model 路由，不扩展旧 npm/native scoped 账号路径。

## 最小实现与取舍

- 桥包装未修改的官方 ACP，提供 hello、turn/steer、turn/status 和独立私有通知；不修改 DSH 安装或 agent-loop。
- per-session 状态支持同一 ACP 进程复用多个 session。仅完整匹配本 prompt 的 user 来源消息后绑定原生 turn；不按共享 L0 前缀或任意 turn/start 绑定。
- Agent.steer 使用 deliveryId 和 role=user/source=user；accepted 仅表示进入原生 inbox。
- 原生 agent/inbox/claimed 只表示领取；user/message 提交才是已读；成功 turn/end 且已读才是完成。
- Host 通过现有 activeRunDispatch 注册一次，capabilities 为 append=true、steer=false，并提供 read/completion receipt。
- “引导当前回复”的 append 调用原生 Agent.steer，在步骤边界采用；force 抢占与运行中图片明确拒绝，不强行中断工具。
- inspect 查看原生 inbox 与 deriveMessages；进程丢失或无事实时返回 unknown，不推断未受理，不自动收费重试。
- Queue/History 继续持久保存源消息、受理及消费状态。没有新业务队列、长期影子缓存或独立恢复平台。
- 沿既有 secret patch、credentials 和启动校验分发桥；脚本按 LF 打包并校验固定 SHA-256。未知/旧版安装不声明这项能力。

作者共同自检修正了三个实际问题：多 session 状态不能共用单 prompt；完整文本匹配代替 200 字前缀；安装版本的 user/message 直接使用 data.id，content 可为单对象。原型中漏 role 导致 422 的失败证据仍保留。

## Architecture Ownership

Architecture cell: 既有 agent-provider / dispatch / thread-chat-surface。
Map delta: none。
Why: 只扩展受控 provider 与现有 activeRunDispatch；桥和 DshTurnInput 仅管理进程/活动 prompt 的瞬态关联，没有新 Store 或持久 owner。公开仓库有意不导出 check:architecture-ownership（scripts/port-drift/exported-scripts.mjs），语义归属交独立 reviewer 核对。

## 验收标准与证据

| 场景 | 结果要求 | 本轮证据 |
| --- | --- | --- |
| 普通 ACP / 未协商 | 不注册 dispatcher，原有 prompt/session 保持 | Client/Host 目标检查 |
| 当前活动输入 | 同 session/turn 受理，不取消或重开 | 桥、Host 及真实成员验收 |
| 错 invocation/turn、已结束 | 明确拒绝，不进入原生 inbox | 桥/Host 检查 |
| 同 deliveryId 重送 | 相同正文核对；不同正文拒绝 | 桥/Host 检查 |
| 已受理但未读或失败结束 | completion=false，保留原有恢复合同 | Host、Queue/History 检查 |
| 原生提交并成功结束 | 受理、已读、完成分开回读 | Host、Queue/History、真实成员验收 |
| RegisteredSession | 内层唯一注册，透传不丢失 | 包装路径检查 |
| 冷重启 | 历史保留，不自动重复原生执行 | API/Redis 冷重启后历史与 UI 回读通过 |

### 已执行检查

- RED：overlay 无实现时 1 fail / 1 pass；Host 活动输入缺口 5 fail / 1 pass。先确认失败来自行为缺口，再实现。
- GREEN：桥 10、Client 5、Host 9（含实际 Queue/History 回调）、overlay 2，共 26/26，标准 with-test-home 下 exit 0。
- 既有 append completion / custody / history ownership 三组共 28/28，通过隔离 HOME 验证。
- 扩展回归 178 项首轮 166 通过，12 因 Windows Temp 父目录的 PARENT_REPLACEMENT 校验受阻；未改断言或 ACL。使用校验器选定的私有 Temp 父目录，原 AcpServiceFactory 文件 13/13 通过，含全部 12 个受阻案例。保留首轮失败输出，不将首轮命令写成通过。
- 补充 secret / Desktop 发现、启动、只读和 onboarding 检查：18 项中 10 通过、8 按原测试条件跳过，exit 0。跳过项不冒充本轮验证。
- 完整 API build（shared、finance、mcp-server、tsc 与 request recorder census）通过。Windows SQLite read-window 构建按既有平台规则跳过。
- Biome 修改文件检查 exit 0；既有大文件和新增 dispatcher 认知复杂度警告保留，未为消除警告重构。
- pnpm check:capability-tips：14/14 且内容检查通过，7 项既有引用警告保留。
- git diff --check：通过。
- fallback 扫描触发提示：协议/原生事件入口的 || 是单次边界校验；session/prompt/turn 是明确拒绝条件；status 的 deriveMessages 和 inbox 分别提供已读与受理事实；Host catch 保留不确定送达责任；patch catch 分别处理未知安装、拒绝篡改与首次创建 EEXIST。没有多级执行兜底或自动重试。
- 同步最新 next/#1928 后，完整 API build、构建完成后的 54 项 turn/恢复合同检查、13 项 AcpServiceFactory 检查、Biome（14 文件，21 warnings / 3 infos，exit 0）和零模型真实 Desktop 启动探针通过。生产 turn 代码相对真实模型验收的 9ec13140 无变化；打包闭包由新基线增加为 99 项，已实际 initialize/hello/newSession/close 核对。
- 沿用既有 tip `feature-author-message-disposition`（F047）：在 ＋ 菜单中选择“引导当前回复”，没有增加新的 UI 操作。

### 实际成员与 UI 验收

隔离环境：本 feature checkout，Web http://127.0.0.1:3101、API 3102、独占 Redis 6398；所有 HOME/project/data 保留在独立 acceptance 目录。没有连接在线 Redis 6399，也没有改原生配置。使用独立无头浏览器，不接管用户 Chrome。

正式 setup/prepare/cats 路径创建真实 Desktop 普通成员，路由 deepseek-official/deepseek-flash；测试 fixture 只开放 issue1947_gate，禁止 shell、文件与委派工具。初始请求给 OLD，工具已进入后才生成随机 NEW；工具返回文本不含 NEW，从而排除提示提前泄漏。

零模型加载探针通过，只证明 initialize/hello/newSession/close，不替代功能验收。
菜单预检不调用模型，已验证“会话 → ＋ → 发送策略 → 引导当前回复”。

失败样本全部保留：首轮与第三轮为自动化 menuitem 定位错误（第三轮的替换因 shell 编码未生效，已直接修正并回读）；第二轮为 ACP 进程池复用旧测试目录及 release 标记。未提交的补充输入、提前完成的模型任务均不算 steer 成功。后续样本冻结新目录并重启隔离 API 后执行。

第四个样本走通实际入口：运行中从 ＋ 菜单保存 Thread 的 continue_current 策略，再发送补充输入。首个 runner 误断言请求必须显式带 messageDisposition，因而报红并正常释放工具；该字段由服务端保存的 Thread 策略提供，未删除或改写原失败记录。随后只读核验同一样本，没有新增模型调用：

- 原生 session 为 `863d70c0-74bd-46ac-b4b4-599d26a21fa1`，只有一个 turn/start 和一个 completed turn/end，均为 turn 1。
- 随机 NEW 在工具进入后才生成；输入在工具结束前进入 inbox，工具正常返回后提交 user/message。
- deliveryId `511f4db7-c982-4c46-81e9-b17c6eb6112e` 与 Host 源消息、目标猫和原 invocation 的稳定映射完全一致。
- 最终模型只输出 `NEW_6ec10963270bb9a66a34c1cd9a6ea745`；没有输出旧标记，没有取消或新 turn。
- History 将补充输入和初始输入挂到同一 response/invocation，补充源为 accepted/read；页面显示“补充消息”“全部已读”。
- 停止并重启独立 API 和 Redis 后，页面重新打开仍有新输出，Thread 策略仍为 continue_current；消息 ID、已读时间与原生日志完全不变，无新增原生执行。
- 两份受保护的原生源文件（credentials 与 Desktop patch）前后比对未改变。指纹与私有环境资料不发布。

可公开核对的精简结果：[真实验收证据](../evidence/issue1947-dsh-turn-steer.json)。原始失败、截图、原生日志与冷重启记录保留在隔离 acceptance 目录，未将模型 reasoning、凭据或用户原生状态提交到仓库。

更新基线后的 `243146e6` 另做了 API/Redis 重新启动及 Web 页面完整回读：11:06:53 UTC 验证输出、策略、源消息 accepted/read 和消息 ID 仍保留，原生日志未变化。该轮没有新增模型调用；不将它冒称新基线上的新付费 steer 实验。

## 交付与收尾

作者提交：鲸鲸 1b3cf3528846779ca45852f37c4019a3fad558f0；sol 9ec131408105212ccddc3d961a3b1aa6ad893f25。
已创建目标 next 的 PR #1950，转为 Ready 并评论请求 zts 审查；尚需当前 HEAD 云端复审、必要 CI 与 zts approve 后合入。
验收 worktree、失败样本和持久测试数据默认保留；临时服务在取证完成后停止并记录归属，不删除历史。

### 独立审查发现：fresh-session 恢复绑定（P2）

Kimi 对 6ae4047e 的独立动态探针确认：旧 session 恢复后零事件结束，Host 创建 fresh session 并正常回复，但 DshTurnInput 仍过滤旧 session，fresh turn 无 dispatcher。主路径与已完成的原生实验不受该分支影响；恢复后的同轮输入确实缺失。

- RED：在现有 Host fake seam 中重现 direct/registered × completed/error 四种情况，4/4 因缺失 fresh dispatcher 失败。
- 修复：sessionId 切换时 dispose 旧 DshTurnInput，在同一已协商进程上为 fresh session 创建新实例；不再次 probe，不增加恢复平台或重试策略。
- GREEN：Host 输入、resume retry 与原有 Queue/History 恢复合同共 46/46 通过，API tsc 通过，修改文件 Biome exit 0。
- 回归同时核对 fresh 输入的 accepted/read/completion、旧 session 迟到事件不误读、dispatcher 正确释放及协商只发生一次。
- 同根因扫描覆盖本函数全部 sessionId 赋值：其他赋值均发生在首次创建 turn 绑定之前，只有这条 retry 是绑定后的 session 切换。
- 该恢复分支使用 fake 协议边界验证，没有故意让真实供应商产生空回复或重放收费请求；前述真实样本保留其原 SHA，不声称覆盖这条新修复的真实故障注入。
- 首轮 finding 已通过普通回复送达；reviewer 的 typed MCP 回执因参数序列化失败未落库，保留缺口，不伪造为 approved。

### 云端审查：已读 observer 与 Stop（P2）

云端在 b70ae9da 指出，settle/dispose 等待 onInputRead 的持久化 promise，会让已完成或取消的 provider 清理被已读观察者阻塞。AgentClientDispatchInput 的现行合同明确规定 delivery 和 Stop 不等待该 callback；既有 AGY 输入路径也将其作为 best-effort observer。

- RED：保持已读 observer pending，分别完成/取消原生轮次，2/2 因 dispose 无法结束而失败。
- 修复：原生 user/message 到达后仍立即标记 native read；异步观察者继续执行并捕获失败，清理不再等待它。独立的 completion custody 回调保持原合同。
- GREEN：构建完成后，清理/Host/resume retry/Queue/History 共 48/48 通过；API tsc、格式检查通过。已有 source/ref/CAS 校验继续限制迟到已读写，不新建队列或重试层。
- 同型扫描未发现其他 provider/session-contract 直接 await onInputRead 的位置。原生读取、完成判定和投递协议不变；此前 b70 的真实验收保持其原 SHA。
- 另一个云端 P2 位于继承的 #1928 first-run 向导：明确拒绝后 creation intent 未释放。原 owner 已在 ed9b7438 修复，连同 0c037212 的模型编辑持久 HOME 修复一起 merge 到本分支。

### 云端反馈后的集成验证

- 集成代码切点为 528713375665b26b7cdf62af1affc762f5405205，继承 #1928 的 ed9b743826465561d63569c1247e0b3d86cd69f7；DSH 已读 observer 修复提交为 344e601dced6eaba12aca159bfebeecf71dd8248。
- #1928 的拒绝恢复只释放已确认的提交前校验拒绝（Invalid request / acp_profile_invalid）。通用 400 可能发生于创建后持久校验，408/409/503 也不能证明未提交，继续保留原请求 key；不扩大成所有 4xx 都重开。
- 完整 API build exit 0 后，桥、Client、Host、overlay、清理、resume 与 Queue/History 共 65/65 通过；Web tsc 通过；first-run 76 文件 414/414 通过。Web 首次命令因 Windows spawn pnpm ENOENT 未执行，保留输出，改由既有环境 wrapper 直接调用 Node/Vitest 后通过。
- 两个继承 Web 文件经仓库 Biome 格式化后与 ed9b7438 的规范格式逐字相等，没有语义改动。Biome 与 git diff --check 通过，既有复杂度警告不作额外重构。
- 更新后的真实 Desktop initialize/hello/newSession/close 再次通过，未调用模型。付费功能验收仍明确绑定 b70ae9da，完整精简收据见 PR 评论 6794896576；该样本的实际成员同轮输入、原生已读、模型输出及 API/Redis 冷重启均通过，不声称包含后来 pending-observer 的真实故障注入。
- Kimi 独立批准 b70ae9da、复跑 35/35 的回复锚点为 0001794396537414-000127-552823df，作者机械转录于 PR 评论 6794775727。typed MCP fact 未落库；当前云端 finding 修复由云端新 HEAD 复审承接，不借旧 peer 批准覆盖新增差异。
- 旧 b70 的 CI 为 19 success / 1 planned skip；Windows owner-birth 首次失败日志保留，仅重跑失败 job 后通过。新提交必须等待自己的 CI，不沿用旧结果。
- Web 3101、API 3102、Redis 6398 已停止，持久数据和失败样本保留；19 个临时工位文件已移至独立 acceptance 目录，逐一 SHA-256 比对一致。没有修改在线 runtime。

### 双 Desktop 的可选消歧查询（P2）

- 云端 finding 4537863356 指出两个安装均已验证时，readDesktopState 超时或解析异常会传播到整个 runtime/catalog 发现，连带影响 Codex/Claude。当前 28f8f0d5 独立探针的 timeout、无效 JSON 两项均复现失败，未启动 Harness 或调用模型。
- 原 #1928 owner 已在 a68eb85e21ede95769eedcb07e39356313f3a342 最小修复，本分支 merge 为 f79719afde9f8dd078dca4ac6c83c26d32ed0d11。生产代码仅一行：可选消歧失败按无可用进程优选处理，保留所有已验证 commands 供显式选择；必需的 resolveDshDesktopHome 查询失败仍拒绝绑定。
- 原探针 2/2 GREEN。完整 API build exit 0 后，65/65 turn/恢复回归、18/18 discovery/launch/catalog 检查通过，包含超时、无效 JSON、结构不符、Codex/Claude 保留和 HOME 拒绝语义。
- 两文件 Biome、git diff --check 通过；规范格式与 a68 内容逐字一致。fallback 检查仅新增一处可选边界 catch，累计提示包含已有校验分支，没有多级执行兜底或新重试。查询的其他调用为必需 HOME 绑定，不能一并吞错。
- 相对已验证 28f8f0d5，只有上述两个 API 文件变化，Web 目录无差异；此前 414/414 和 Web 类型证据保持原来源，不重复执行，不冒称新跑。28f8f0d5 的 CI 最终为 19 success / 1 planned skip；新 HEAD 仍须自己的 CI 和云端复审。
- 依据用户后续明确要求，在 PR 评论汇总全部有效反馈、对应最小方案及验证，请 zts 批准当前提交。本轮三项云端意见均有复现依据，采用上述最小修复，不扩大到其他异常的吞错或自动重试。实际批准前不合入，原 Task 保持 doing。
