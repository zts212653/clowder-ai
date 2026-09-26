# F247 Workspace Agent 双向唤醒接入 — 实施计划（2026-09-20）

任务 `0001789905354421-000238-3994be29` · 实现：谱谱（zcode）· review 把关：小星星（astra，未 review 不得宣称完成/合入）· 方案来源：砚砚（cat-to5aedfl）交接的实现契约 + 官方文档三份（trigger-runs / authentication / plugins-mcp-server，2026-09-20 抓取）。

基线：worktree `clowder-ai-wt-f247-wa`，分支 `feat/f247-workspace-agent`，基于 **upstream main `9bca5ae2f`**（非共享 main `a198187d0`，后者有未推 doc commits + 未跟踪 review notes）。**PR 归属口径（点点 2026-09-21 核实）**：分支推 **fork `08mamba24/clowder-ai`**，PR 跨仓开向正典 **`zts212653/clowder-ai` base `main`**——家里既有流程（#1493/#1494 同路径；fork main 与 upstream main 已分叉，直接对 fork 开 PR 会产出 1868 files 垃圾 diff）。

## 官方契约要点（已核实）

- `POST https://api.chatgpt.com/v1/workspace_agents/{id}/trigger`，`id` 形如 `agtch_XXX`；Bearer Workspace Agent access token（admin 门控签发，scope 仅限 Workspace Agents API，无公开 refresh 流 → Settings 需提供续权/换 token 入口）。
- body：`input`（必填）+ `conversation_key`（调用方定义的稳定会话标识，跨 trigger 续同一会话）。
- `Idempotency-Key` header 支持重试去重（同 key 返回原 accepted 结果）。
- 202 → `{conversation_url}`；**最终答复不可经 API 读取**。beta header `OpenAI-Beta: workspace_agent_runs=v1` 可得 `agent_trigger_run_id`（`apirun_XXX`），仅轮询 telemetry。
- 错误：401（token 坏）/ 403（权限不足）/ 404（trigger 不存在）/ 409（agent/channel 不可运行）。
- 反向：Workspace Agent 内配 Clowder Remote MCP（streamable HTTPS），调 `cat_cafe_post_message(replyTo=sourceMessageId)` —— 复用既有 F264 回程 + CloudReturnGrantStore，**run completed 不替代 exact MCP 回程**。

## 9 点实现契约 → 文件映射

| # | 契约 | 落点 |
|---|---|---|
| 1 | Trigger API 主路径 + `conversation_key=clowder:{workspaceId}:{threadId}` + 202/conversation_url + beta run id 仅 telemetry | `workspace-agent/conversation-key.ts`（纯函数）+ `workspace-agent/workspace-agent-trigger-adapter.ts` |
| 2 | 反向走 MCP post_message(replyTo)，run completed ≠ 回程 | 不新做：复用 grant store + `cloud-assistant-return-ingest`；adapter 不消费 run 状态作为回程 |
| 3 | 任意 ChatGPT 历史会话不可冒充 API 可寻址对象；Personal Chrome 保留 personal-plan fallback | bridge transport 决策顺序：workspace-agent（已配置且 enabled）→ host（personal-chrome）→ legacy pinchtab；workspace-agent 路径**不读不写 chat-URL binding**（conversation continuity 由 conversation_key 服务端维护） |
| 4 | 新增独立 `IWorkspaceAgentTriggerAdapter`；复用 CloudReturnGrantStore / buildDeltaPayload / exact-source callback / durable receipt | 新 adapter 模块；bridge 注入新 dep；receipt 持久化走既有 outbound receipt 管道 |
| 5 | cloudCatBindings legacy string → versioned provider binding；conversation_url owner-only；receipt 增 workspace-agent/providerRunId，不冒用 hostMessageId | **读取契约**（round-2 对齐）：`cloud-cat-bindings-v1.ts` normalize/validate 纯函数，bridge 与 owner-only cloud-bindings API 投影统一形态；**无产品级 versioned 写入**（workspace-agent 续会在 provider 侧，不写 chat-URL binding）；Redis restart / provider-aware owner-only conversation_url 可恢复入口的完整验收仍在未完项③；receipt 扩展 transport=`'workspace-agent'` + `providerRunId?`，不进 conversation_url |
| 6 | token 仅服务端托管；Idempotency-Key 绑定 exact dispatch；防环字段 bridgeEventId/origin/sourceMessageId/causationId | token 经 server-side provider 注入（env/设置存储，API 响应只回 presence bit）；Idempotency-Key = dispatchInvocationId（与 exact source 绑定）；delta payload JSON 增 `origin:"clowder-outbound"` + `bridgeEventId`（=dispatchInvocationId）+ `causationId`（=source 的 invocation 链引用），回程 ingest 依此抑制环 |
| 7 | Settings 卡：trigger id、授权/续权、disable、test；token 不回前端 | `workspace-agent-plugin-routes.ts`（owner-only，循 personal-chrome-plugin-routes 模式）+ web 卡片 |
| 8 | Personal Chrome 主路径基线不动；Workspace Agent 优先级须显式新 decision | F247 spec 增 KD-24：workspace-agent transport 仅在显式配置（trigger id + token + enabled）时接管出站，未配置时行为与现状逐字节等价 |
| 9 | 测试覆盖清单 | 见下「测试矩阵」 |

## 切片划分

- **Slice 1（本提交）**：纯核心 + 类型地基 —— conversation-key、IWorkspaceAgentTriggerAdapter + HTTP 实现（typed 401/403/404/409、Idempotency-Key、token 永不进错误/日志）、cloud-cat-bindings-v1 读取归一纯函数（round-2 对齐：versioned **读**契约，写入口经 astra R2 裁定移除）、shared receipt 扩展（transport + providerRunId + validator）、全部单测。
- **Slice 2**：bridge 接线（transport 决策 + 出站 delta 增防环字段 + Idempotency-Key=exact sourceMessageId）+ 绑定读取归一接入 bridge 与 owner API（无 versioned 写入口）+ invoke-single-cat receipt 投影带 providerRunId。
- **Slice 3**：Settings owner-only 路由（status/config/test/disable，token redaction）+ web 卡片。
- **Slice 4**：F247 spec KD-24 + revision_history v37；集成测试（replay、Redis restart、exact callback、loop suppression、页面关闭 dogfood 记录为 live gate 待办）。

## 测试矩阵（契约 #9）

1. conversation_key schema：格式稳定、threadId/workspaceId 边界字符拒绝、同 thread 稳定、跨 thread 不碰撞。
2. adapter：202 解析（conversation_url + beta run id 可选）、401/403/404/409 typed error、网络错误不冒充 202、Idempotency-Key 头存在且等于入参、**token 不出现在任何错误序列化/日志字段**（redaction）。
3. binding 迁移：legacy string → `{v:1,provider:'personal-chrome-host'}`；versioned 直通；未知 provider/畸形 v 拒绝（fail closed）。
4. receipt：transport='workspace-agent' + providerRunId 通过 validator；hostMessageId 在 workspace-agent receipt 上被 validator 拒绝（不冒用）。
5. （Slice 2+）replay：同 Idempotency-Key 二次 dispatch 复用结果；Redis restart 行为；loop suppression：带 origin/bridgeEventId 的回声不触发二次出站。

## Review 轮次记录（astra round 1 → REQUEST_CHANGES 修正）

- R1(P1) 已修：配置状态机改为 absent/enabled/disabled/invalid 四态；env-only disable 落持久化墓碑（重启后仍 off）；坏/损坏配置不复活 env，投影暴露 invalidConfig 可恢复错误。
- R3(P2) 已修：workspaceId 约束共享 `isWorkspaceAgentConversationKeySegment`（routes + config save/parse 同源）；保存前拒绝，无效持久化值归入 invalid 态。
- R2(P2) 已修：投机 writer `updateCloudCatBindingEntry` 移除（无产品调用入口 = 认知脚手架）；绑定层收敛为读取契约——bridge 与 threads.ts cloud-bindings owner API 均经 normalize 投影，web 端非字符串值守卫为 invalid。
- R4(P3) 已修：v37 缩进回 revision_history，措辞改实指。
- **落点纠正（未完项②的正确入口）**：Workspace Agent 的 Remote MCP 回程走 `routes/callbacks.ts` 的 agent-key / exact-source grant 分支（约 :1511）；`cloud-assistant-return-ingest.ts` 只是浏览器 observer 回程。环抑制必须覆盖前者，在 callback/outbound admission 边界证明「同一回程不再次触发原方向」，保留合法主动新消息与跨猫交接；不凭模型自报 origin 扩权。
- probe 记录（非 blocking，实现防环时定契约）：同 source 重试时 Idempotency-Key 稳定而 bridgeEventId 随 invocation 变——稳定事件身份需明确；envelope 极端 shrink 会丢 origin/bridgeEventId/causation 字段——降级语义需写死（fields 为 best-effort telemetry，缺失时回退 exact-source durable idempotency）。

## Review 轮次记录（astra round 2 → REQUEST_CHANGES 修正）

- R1 残留(P1) 已修：`readPersisted` 去 `existsSync`，直接读取并按 fs 错误分类——仅 ENOENT=absent（允许 env 引导），EACCES/ENOTDIR 等一律 `unreadable_file` invalid 态（抑制 env + 投影可恢复错误）。测试：disable 落墓碑后 chmod 000 → 重建 store 不复活 env、投影 `invalidConfig:{reason:'unreadable_file'}`。
- R3a 残留(P2) 已修：完整 env 三元组过与 save/持久化解析**同一份**约束（TRIGGER_ID_PATTERN + segment 谓词）；违规 → `env_invalid` invalid 态（resolve null、不包装成网络未知）；部分 env 保持纯未配置。矩阵测试：colon workspaceId / NUL workspaceId / bad triggerId / partial env。
- R3b 残留(P2) 已修：单一 segment 谓词 `isWorkspaceAgentConversationKeySegment`（拒空、>256、冒号、全 C0 含 NUL、DEL、全部 Unicode 空白）；builder 的 requireSegment、full-key validator（由谓词重建，split 三段逐一验证）、Settings PUT、config save、persisted parse、env 六消费方全部走它。ASCII 0..127 + Unicode 空白 + BOM 扫描测试证明 builder-throw ⟺ guard-false ⟺ full-key-reject 三方一致。
- 更正上一轮我的反说法：旧 repro 断言的是**正确行为**，修复后应变绿（不是我说的"翻红=修好"）。

## Review 轮次记录（astra round 3 → APPROVED for corrective delta）

- R1/R3a/R3b 关闭；159/159 回归 + 独立复现 11/11（含 12,300 候选双位置扫描）。
- 边界记录（astra 答复）：unreadable 态的恢复需要**重启或完整 save**——chmod 恢复不刷新当前实例缓存（配置 load 首读即缓存）。Settings 卡呈现恢复路径时不得暗示修权限即自动重读。
- P3 已顺手修：parity 测试补 reject-side 断言（guard 拒绝的 segment，直接构造的 full-key 也必须拒绝）。

### ② 防环实现决策（本轮落地）

- **守卫位置**：invoke-single-cat 云派发块，grant 签发**之前**——源消息作者是目标云端猫本人（sourceSender.kind='cat' && id===catId）时 typed 终止 `cloud-loop-suppressed`，不签 grant、不 dispatch。
- **不变量**：同一回程不再次触发原方向（outbound→return→outbound 断环）；跨猫交接与用户正常 @ 不受影响（三态测试钉住：self-cat 抑制 / 他猫放行 / 用户放行）。
- **授权边界**：判定只看服务端 source-authority；**不消费模型自报 origin/bridgeEventId**（delta 防环字段仍是 best-effort telemetry，缺省时回退 exact-source durable idempotency）。
- receipt 语义：suppressed → status 'failed' + disposition 'not_attempted' + transport 'none'（既有映射，无新增层）。

## Step ①/③ 交付记录（round-3 后）

### ① Settings web 卡（已落地）

- `packages/web/src/components/settings/WorkspaceAgentPluginPanel.tsx`：状态徽章（已启用/未启用/需修复）、trigger id / workspaceId / token（write-only，已保管显示占位不回显）表单、授权并启用 / 保存、停用（confirm）、发送测试触发、typed 测试结果、invalidConfig 恢复指引（**明确写"仅修权限不会自动重读，需完整保存或重启"**——astra round-3 答复的边界）。挂载于 PluginsContent 的 loading / 空列表 / **非空列表**三个分支（round-4 R1 修正：初版漏了非空分支，现在有 PluginsContent 层非空目录用例保护）。
- 组件测试 4/4（disabled 态无 token 物料 / invalid 恢复指引 / PUT 保存 + token 字段 round-trip 后清空 / typed 测试失败展示）；web `tsc --noEmit` 干净。

### ③ 集成验收现状与缺项（诚实清单）

- **已做（stub 级）**：replay——同 exact source 重发携带**相同 Idempotency-Key + 相同 conversation_key**，客户端不去重（provider 拥有 replay 真相）；bridge 测试 10/10。
- **缺项（需要 owner/真环境，列给铲屎官）**：
  1. **真实 provider trigger**：需要在 ChatGPT Admin 创建 Workspace Agents scope 的 access token + 一个 trigger（agtch_…）——填进 Settings 卡即可走「发送测试触发」验收 202/conversation_url。
  2. ~~真实 Redis restart~~ **已撤回推给 owner**：round-4 证实本机 redis-server（/opt/homebrew/bin）即可起隔离实例——仓库级回归 `f247-workspace-agent-redis-restart.test.js`（随机端口 + 临时 dir + SHUTDOWN SAVE 重启，versioned 含 URL 与 legacy 绑定跨重启可读；binary 缺席时 skip）。
  3. **页面关闭 live dogfood**：owner 在真实浏览器关页后触发一轮 @gpt-pro 双向观察（Settings 自检会话 + thread 会话）。
- **live dogfood 剧本（交 owner）**：① Settings 卡填 trigger id + workspace id + token → 保存并启用 → 点「发送测试触发」→ 预期 202 + conversation_url 打开自检会话；② 任意 thread 行首 @gpt-pro 发一条 → 预期 thread 出现 sent receipt（transport=workspace-agent）→ 云端 agent 经 Remote MCP cat_cafe_post_message(replyTo=sourceMessageId) 回写 → 本地气泡出现 gpt-pro 回复；③ 云端回复文本里行首 @gpt-pro → analyzeA2AMentions 先过滤自目标，零派发零 receipt（**不是** typed cloud-loop-suppressed——该 receipt 只在显式进入 admission 的自目标派发出现，round-4 probe 已区分）；④ Settings 停用 → 再 @gpt-pro → 走 Personal Chrome/needs-binding（不静默回退）。

## Review 轮次记录（astra round 4 → REQUEST_CHANGES 修正）

- R1(P2) 已修：WorkspaceAgentPluginPanel 补挂**非空插件列表**分支（此前只有 loading/空列表）；新增 PluginsContent 层非空目录用例。
- R2(P2) 已修：save() 在显式保存时**迁入已验证的 env token**（"留空则沿用"对 env 态成立，source 翻转为 settings）；disable() 墓碑捕获活跃配置（含 env），tokenConfigured:true，重新启用无需重粘；routes 层 env 旅程回归（GET env → PUT 空token 200 → DELETE → PUT enabled:true 200）。
- R3(P2) 已修：正常 dispatch 成功 → bridge 写 versioned binding（含 conversationUrl owner-only 恢复锚，best-effort 且失败不影响已 202 的派发）；RedisThreadStore 增加 updateCloudCatBindingEntry（JSON 序列化进同一 cloudBinding: 字段，guarded Lua）；normalize 接受 JSON 字符串形态；threads.ts owner 投影透出含 URL 的对象；web CloudConversationLink provider-aware 消费（workspace-agent 条目的 URL 渲染为 bound，绝不作为 Personal Chrome route）；**隔离 Redis 重启仓库级回归通过**。
- P3 已修：live dogfood 预期区分「文本自 @（analyzeA2AMentions 过滤，零派发零 receipt）」与「显式进入 admission 的自目标（typed cloud-loop-suppressed）」。
- 撤回声明：此前"本机不能起隔离 Redis，交 owner"不成立（redis-server 二进制即可）。

## Review 轮次记录（astra round 5 → REQUEST_CHANGES 修正）

- R1(P1) 已修：**单一继承权威** `activeEnvForInheritance()`——仅当持久化文件 absent 且 env 三元组完整合法（即 env 是活跃配置）时，save()/disable() 才可迁移 env 凭据；disabled 墓碑与 invalid/unreadable 文件对 env 的抑制覆盖**继承**而不只是 dispatch。save/disable 的回退链收敛为一条（显式输入 → 文件值 → 可继承 env），多层 ||/?? 链移除。状态矩阵新增 3 用例：invalid 文件 + PUT {enabled:true} 必须 400（完整恢复）、空墓碑 save 不得从 env 补齐、墓碑重复 disable 不导入被抑制凭据。
- R2(P2) 已修：**一次派发一个配置快照**——resolver 改为 `resolveWorkspaceAgentTransportSnapshot()`（快照绑定的 adapter + triggerId + workspaceId 一次取齐），bridge 锚写入只读快照字段，不 await 后读活配置 getter。测试：in-flight 改 trigger（getter 返回 B）→ 锚仍写快照 A；快照不可变性 + disable 后新 resolve 为 null 而旧快照仍可完成。
- R3(P2) 已修：CloudConversationLink 的 bound 状态携带 provider；workspace-agent 条目隐藏「更换绑定」（只属于 Personal Chrome 流程），改提供 `#workspace-agent` 深链到 WA 设置卡（面板新增 hash reveal + scrollIntoView）。组件断言：WA 条目渲染打开/复制 + WA 设置入口，Personal Chrome 更换绑定不出现。
- R4(P2) 已修：redis-cli 从 server binary 同目录推导（再 PATH 兜底）；shutdown 失败**传播**（不再无条件 resolve）；退出等待有界（5s 超时 SIGKILL 且断言非 timeout）；无 cli 时 SIGTERM（--save 1 1 保证落盘）+ 退出码检查。真实重启回归保持通过（119ms）。
- P3 已修：GET/PATCH 共用 `projectCloudBindingsForOwner()` 单一 owner 投影；对称性测试断言同一 WA 条目在两处响应里都是对象（JSON 存储串不泄漏）。

## Review 轮次记录（astra round 6 → APPROVED for corrective delta）

- R1-R4 + P3 全部关闭放行；191/191 独立回归 + 72 格状态迁移矩阵 + 快照双窗口探针。
- N1(P3) 已修：卡片加稳定 `id="workspace-agent"`；reveal effect 依赖 `[state]`——初始 hash 等卡片真实挂载后才定位（deferred GET 用例：state 到达前 scrollCalls=0、到达后 ≥1）。
- N2(P3) 已修：shutdown 改经测试自有连接 `sendCommand(new Command('shutdown',['save']))` 原生命令（EVAL 禁 SHUTDOWN）——连接关闭型拒绝=已发出，其余传播；去掉 quit-先于-shutdown；重启段断言 `exitCode===0`；after 走同一清理（client shutdown → 有界等待 → 才 SIGKILL）。cli 依赖整体移除。
- reviewer 失误记录在案：其首次快照探针 stub 安装晚于 adapter 构造，导致一次带虚拟 token 的真实外呼（401）；已声明并修正重跑。实现侧无需动作，但快照 adapter 构造时机与 stub 顺序的教训记入本 plan。
- 状态：本地 review 链（6 轮）关闭；N1/N2 已修（f35f50cb8）。
- **push/PR 阻断实证（2026-09-21）**：本会话 gh 未登录、https 无凭据（credential helper 注入后仍 fatal: could not read Username）、SSH 无密钥（publickey denied）。推分支/开 PR 需要带 gh 凭据的会话或 owner 动作。
- **PR 已开（2026-09-21，点点执行）**：https://github.com/zts212653/clowder-ai/pull/1516 —— base 正典 main ← head fork:feat/f247-workspace-agent @ 0330b6e4a，32 files / +3682 −26，mergeable=true；她独立复跑定向测试 101/101（含隔离 Redis 重启）；PR 事件跟踪已登记（owner=点点，过期 10-05）。
- **SHA 披露（不 rewrite）**：`0330b6e4a` 是 astra APPROVED（`f35f50cb8`）之后追加的 docs commit（plan 3 行，非 review report 载体）。按 merge-gate 披露原则如实记录，交由 merge 时 reviewer 复核；不做历史改写（会作废 approval）。
- 剩余清单：① ~~push + 开 PR~~ 已完成 → 剩 PR review/merge（事件驱动，跟踪在点点名下）；② owner 环境验收：真实 provider 202/去重、页面关闭 live dogfood（剧本见上）；③ 任务卡同步（谱谱会话 callback 凭据持续 0/3，欠账明示）。

### Failure-Mode Sweep（本轮）

| pattern | scanned | fixed | N/A |
|---|---|---|---|
| 「存在性检查把 fs 错误折叠成 absent」 | 本模块 readPersisted；顺带扫 `workspace-agent-config.ts` 内其余 existsSync 使用（已无）；`acp-credential-file.ts`/`personal-chrome` 安装链的 exists 检查属安装域（写路径+显式错误传播），未发现同型折叠 | readPersisted | 其余扫描点无此形态 |
| 「同一输入在每个入口点校验规则不同」 | segment/triggerId 的全部消费方：builder、full-key validator、routes PUT、config save、persisted parse、env（6 处）+ ASCII 扫描取证 | 六消费方收敛到单一谓词 + 单一 TRIGGER_ID_PATTERN | — |
| 「claim 与实物不符（docs/commit 措辞超前）」 | v37/Slice 2 措辞（writer 已移除仍写"versioned 读写"）、我方交棒说明（翻红说法反了） | 两处已改实指；本表即防再犯 | — |

## 边界与不做

- 不改 Personal Chrome Host 现有行为/测试；不动 legacy pinchtab opt-in。
- trigger input 复用 `buildDeltaPayload`（含固定 return contract），不改其 2000-char 契约。
- token 永不：进前端响应、进 thread context、进 delta payload、进 receipt、进日志。
