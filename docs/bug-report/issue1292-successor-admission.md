---
feature_ids: [F182, F293, F294]
topics: [routing, queue, successor, admission]
doc_kind: implementation-plan
created: 2026-11-03
---

# Issue 1292：当前 Queue 的 successor 与 admission 修复

来源：[Issue #1292](https://github.com/zts212653/clowder-ai/issues/1292)、
[接受决定](https://github.com/zts212653/clowder-ai/issues/1292#issuecomment-5176620388)、
[旧 PR 正式审查](https://github.com/zts212653/clowder-ai/pull/1283#pullrequestreview-4845590194)。
基线：`upstream/next@ad4e3ad4fcb3125388d39165e76ed9bd2760c1be`。
替代旧 #1283 的有效契约，不整体移植其 65 文件；旧分支和未提交现场不改动。

## 已实现与缺失

| 边界 | next 当前状态 | 本次处置 |
| --- | --- | --- |
| 显式 mention | F293 保留 catalog 身份，#1762 已要求改发确认；disabled warning 与 successor 投影仍缺失 | 恢复结构化 warning，禁用显式目标不改投 |
| 隐式目标 | preferred、历史 mention、最近回复、policy 只过滤 available，没有 successor | 复用中央解析，一跳规范化消费，不改历史记录 |
| default | runtime/env 无效时回落其他默认，空配置可能选第一个注册成员或 sentinel | 配置选中的目标无有效 successor 即 no-target |
| 系统输入 | podcast 仍请求 opus；enqueueDurable 直接持久化目标 | 首次持久化前使用相同解析，拒绝空/假身份 |
| Queue drain | 已绑定 targets 不允许换收件人，失效项已有失败结算 | 保留绑定；禁用目标失败结算，不在执行时迁移 |
| 直接 execution | routeExecution 不校验 availability | 执行只准有效的原目标，不偷偷执行 successor |
| guardian | 模块与入口已退役 | 不恢复、不新增 token/assignment 路径 |
| catalog/backfill | runtime 权威、allowlist、tombstone 与空 roster bootstrap 已实现 | 不改 seed、模板、私有配置；复跑现有所有权检查 |
| scheduler lead | ActorResolver 只读 available/roles/lead | 保持显式配置，不继承 lead、不猜 family/version |

## 当前调用链与复用点

1. 用户 send：`messages.ts → previewTargets / confirmedTargetCats → AgentRouter.resolveTargetsAndIntent / resolveExplicitTargets
   → InvocationQueue.send → resolveSendTargets → MessageStore + QueueLedger` 原子写。
2. 隐式 preview/send：`resolveImplicitTargetPreview → preferred / previous mentions /
   participants → applyThreadRoutingPolicy → configured default`。
3. 系统输入：`podcast-generator.generateScriptViaThread → enqueueDurable →
   createLedgerRows → ledgerStore.enqueue → QueueProcessor.requestDrain`。
   `PersistedQueueDelivery` 的 private input/visible notice 也汇入 createLedgerRows。
4. 执行：`QueueProcessor → resolveExplicitTargets / resolveQueuedConversationTargets
   → claim → routeExecution → routeSerial / routeParallel → service`。
5. plugin 普通对话已复用中央 conversation resolver；exact plugin recipient 已禁止改投。

中央关系读取放在现有 config/resolver；Queue 使用其已有 policy 注入边界接入同步的
pre-resolved 校验，覆盖 async、notice 与内存同步 admission。不会建立第二套路由策略。

## 契约

- `RosterEntry.successor?: string` 是唯一关系真相；schema 拒绝非字符串/多目标。
- 原成员必须注册；available 原成员保持身份。仅 disabled 原成员允许读取一个 successor。
- successor 必须不同于自身、注册且 available；不追第二跳，不用 alias/family/version 猜测。
- `__none__` 仅保留旧 default API 的兼容返回；解析为无目标，不能 admission 或执行。
- 显式 mention 返回 cat_disabled，canonical successor 是首项建议；用户确认后的新目标才可执行。
- 用户指定、whisper、message_wake、scope、action fence、wait continuation、cloud provenance、
  live session、allowConversationFallback:false 的身份约束保持 exact，不能因为 successor 扩展权限。
- 无上述身份约束的系统 conversation_input / private_input，在首次 admission 前规范化预解析目标。
- 公共历史/preferred/policy 在读取时投影 successor；不写回历史或用户成员配置。
- 已落 Queue 的 targets 是收件人与投递/claim/CAS 的权威。重放保持赢家；配置变化使其失效时
  走既有失败结算，不改 ledger target，也不把旧 target 的结果写给 successor。
- 无效配置选中目标不给无关成员兜底；可用普通历史/偏好仍遵循现有优先顺序。
- lead 不随 successor 继承，scheduler 继续只消费显式 lead 配置。

## 最小文件范围与顺序

1. 新增聚焦测试与隔离 fixture（各文件 ≤350 行），先在基线上观察真实行为失败。
2. `cat-breed.ts`、`cat-config-loader.ts`、`cat-target-resolver.ts`：增加 scalar schema、
   一跳 resolver、default 验证及 canonical alternatives。
3. `AgentRouter.ts`：接入显式/隐式解析，禁用显式 warning 与 no-target，执行前拒绝无效身份。
   既有大型文件只改有关方法；不重构周边 parser、context 或执行逻辑。
4. `message-disposition-admission.ts`、`InvocationQueue.ts`、`index.ts`：复用 policy 注入，
   新 admission 的规范化发生在任何 ledger/notice 写入前；重放不重算目标。
5. 仅当测试证明真实消费者缺口时改相应消费者；podcast 预期无需独立路由代码。
6. 作者自查后交非作者独立审查；新 PR base=next，不合并、部署或关闭 Issue。

## 验收与命令

从本 HEAD 的 package.json、CI、public resolver 核实：

- 构建依赖：`pnpm --filter '@cat-cafe/api...' build`。
  单独 API build 在全新工位缺 finance dist，因此先构建 workspace 依赖。
- 聚焦测试：在 packages/api 使用 `node scripts/with-test-home.mjs --env
  CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js
  --test --test-concurrency=1 <test files>`；REDIS_URL 指向 `redis://127.0.0.1:0`。
- 类型：`pnpm --filter @cat-cafe/api lint`、`pnpm --filter @cat-cafe/shared lint`。
- 格式：`pnpm biome check <changed files> --diagnostic-level=error`；必要时只格式化本次文件。
- `git diff --check`；新增文件不超过 350 行，既有超限文件不做无关切分。
- `.github/workflows/ci.yml` 已接受 next PR；public resolver 自动发现 `.test.js`。
  回读最终测试选择清单，证明新测试实际进入 CI，不以文件存在代替执行覆盖。

验收矩阵：available；显式禁用；唯一有效 successor；缺失/未知/禁用/self/多跳/歧义；
default/env/runtime；历史 mention、preferred、participant、policy；system private_input；
exact scope；Queue 原子持久化/重放/执行/失效结算；当前 podcast producer-to-service；
runtime catalog 所有权；显式 scheduler lead；sentinel 与假身份拒绝。
最终结果与命令日志绑定最终 HEAD，CI 和审查状态单独报告。

## 代价、回退与方案自查

只增加首次 admission 的有限 catalog 查询，不增加常驻进程、缓存、迁移或新持久状态。
无效配置会更早拒绝工作；这是禁用成员被执行或写成假收件人的直接损失防线。
既有绑定 Queue 不重路由，避免 claim、visibility、authority 与 settlement 身份不一致。

回退为撤销本 PR 提交；无数据格式迁移、无历史批量重写。successor 是可选 metadata，
旧配置仍可读取。回退不会复活 guardian，也不需要删除任何持久数据。

作者方案自查：方向符合接受决定；Queue 是现有状态权威，resolver 是唯一关系权威；
没有私有 catalog 拷贝、公开身份整包升级或模板副本；未把旧 PR 的 green/自称 approval
当成本次证据。Architecture cell: existing routing/config/Queue admission。
Map delta: none。独立审查须检查 exact 边界与 Queue 状态绑定，不能由作者自行 Approval。

## 实施与作者自查结果

未修改 public seed、backfill allowlist、成员配置、历史文档身份或 guardian 退役面。
现有 Router 增加同步 admission 校验，Queue policy 接线复用它；ledger 增加读取已有 private
receipt 的方法。唯一 successor 算法位于 config loader，所有隐式消费复用它。

真实失败观察：原 Queue 接受 opus、ghost、__none__；podcast 实际调用旧 opus 服务；
显式禁用 mention 被选中；invalid successor 回落无关默认。另有两项消费边界被复现：
已绑定 private input 在 admission 前失败时未通知 completion hook；sentinel 可借注册 alias
进入显式解析。修复均有 RED→GREEN。日志放在本任务 artifacts 中，不提交运行产物。

| 契约 | 作者验证 |
| --- | --- |
| 显式禁用 mention | HTTP 409 + 零写入；cat_disabled + canonical 建议，确认后仅执行新目标 |
| 混合 mention / 选中成员 | 可用 mention 保留；明确选中的禁用身份在写入前拒绝 |
| 隐式 default / runtime override | 唯一有效一跳 successor；override 仍保持其优先权 |
| 无效关系 | missing、unknown、self、disabled intermediate、sentinel、未注册目标均 no-target |
| 歧义 | schema 拒绝多 successor；available 原成员不被 successor 改投 |
| 历史状态 | preferred、previous mention、healthy replier、review policy 按读取时投影，原记录不改 |
| policy avoid | 旧身份和 canonical successor 的避免配置均生效；无任意成员兜底 |
| 系统预解析 | async、同步、visible-notice admission 均持久化 canonical target |
| exact 身份 | exactTargets、collective scope、A2A parent 不重定向；其余 authority 字段保留同样闸门 |
| 持久化/重放 | 首次赢家不因配置变化重算；不同请求身份仍 conflict；失败不写 notice/ledger |
| 已绑定失效行 | 不换收件人、不调用 successor；沿原行失败结算，completion hook 只通知一次 |
| podcast | 当前 producer → 真实 Queue/QueueProcessor/AgentRouter → 假服务，仅 opus-5 被调用 |
| podcast 无目标 | enqueue 前明确拒绝，无残留 Queue 行，也不等待完成 hook |
| sentinel / 假身份 | admission、直接 execution、注册 alias 三条边界均拒绝 |
| catalog / lead | runtime-owned successor、lead、launch metadata 保持权威；不继承 lead |

更新基线前作者验证：相关 56 文件 **698/698**，独立 Redis 两文件 **23/23**；
API build（含 shared/MCP 与 TypeScript）、Biome 与 diff check 通过。
更新至 #1762 后增加确认交叉回归，并以最终 HEAD 的重新验证结果为准；新增 `.test.js` 均由
public resolver 选中。Redis 测试在 CI 使用已有的 owned portless fixture，实际执行而非 skip。
所有新增文件 ≤350 行；既有大型文件仅修改上述边界，未扩成无关拆分。

旧 agent-router 测试中两条“任意 fallback”断言按已接受契约更新；同文件的协作标题断言
兼容 LF/CRLF（本机模板实际是 CRLF），没有降低静态身份内容要求。上传目录断言同样接受
Windows 分隔符。仅给实际失败的旧 HTTP router 替身补齐既有 routing_warnings 字段，
没有在生产逻辑中为不完整替身增加防御分支。

重叠已核对到文件/patch：#1762 已合入当前基线，提供 explicit confirmation、收件人冻结
和 runtime service 引用更新；本单保留其全部 11 项确认测试。#1702 增加
display alias；#1432 增加 terminal producer capability；#1157 是旧 Queue 内存幂等逻辑。
它们没有提供本次一跳 successor admission；本 PR 不搬运其未合入内容。
#1762 的确认状态不可被 successor 解释为用户已同意改发。

验证边界：上述是隔离 HTTP、真实生产类、内存/Redis ledger 的集成检查，模型服务为假服务；
不声称已通过真实模型、生产 Redis、TTS 音色或部署验收。podcast 的 TTS speaker 标签属于
音色选择，不进入 Queue/模型执行或成员 assignment，本次不重写其历史角色标签。
自建隔离 Redis 已受控停止、端口释放、合成数据及实例台账保留；无测试安装/桌面入口遗留。
工位保留用于 PR 审查。GitHub CI 和非作者审查以最终 HEAD
的远端检查、PR 正文及独立审查回执为准，不消费 #1283 的旧绿灯或同作者 approval 文本。

## 非作者首轮 finding 处置

首轮独立审查针对 c77a00aea08a1acca66dd999e07b0c386d1fddb4，提出四项 P2，均已观察 RED 后修复：

| finding | 根因与修复 | 真实回归 |
| --- | --- | --- |
| 重放 | 剩余 targets 不是原 admission；在当前配置解析前读取已有 receipt。private identity 以原 requested targets 和完整 producer envelope 比较，保持旧 receipt 字节兼容；public warning 消费已提交快照 | partial/retired/reopen/config invalid/旧形态/冻结 next fingerprint/公开 UUID warning 重放；Memory + Redis |
| mention 建议 | catalog 不保证声明 @id；优先已声明 canonical pattern，否则使用 catalog 既有 pattern，canonical successor 身份仍首项 | 用户实际按建议 token 再次解析，得到 successor |
| Steer | reconcile/target expansion 绕过首次 admission；新增目标复用 exact validator，参与者只消费已提交 target | 真实 Queue targets HTTP API 不落入 ghost / sentinel |
| 普通 scheduler | 只覆盖 privateContent；无 authority fence 的普通系统输入也应在首次 admission 解析 | createDeliverFn → PersistedQueueDelivery → Queue 的普通/私有分支一致 |

第二轮独立审查指出 mixed bound targets 的一个失效成员会拖累健康成员：首次 admission
仍整组验证，消费已绑定行时逐项结算。Queue 的 private/public/message_wake 三类真实入口均
验证健康 codex / 已在原组中的 successor 各执行一次、坏目标单独失败、行最终退休；
失败 hook 仅通知对应收件人。已绑定 conversation 直接复用 bound exact resolver，避免把
旧目标投影到同组 successor 后重复消费。

新基线 #1762 的 named provider 不可用时，公开 HTTP 必须先 409，不能直接写入旧身份或
建议目标。禁用 mention 的唯一有效 successor 只作为确认建议；confirmedTargetCats 优先于
原正文，allowConversationFallback:false 阻止系统目标在首次 admission 被解释为隐式。
这一轮新增消费了既有 immutable receipt，没有增加持久字段、缓存、迁移或第二套路由。
更新基线后的交叉回归先观察到 warning 丢失、冻结标记被改投、不可用服务消费和重放
再次校验当前配置等失败，再最小修复。public source 重放探测只构造原身份，不进行
首次 admission 校验；实际匹配仍消费存储返回的赢家与原 producer envelope。
所有 code findings 待非作者对后续精确 HEAD 复审，作者不自行 Approval。


## CI 发现的普通插件 hint 边界

F202 的 nonexact wake.catId 是首次目标选择的提示，不是已绑定收件人。有效一跳 successor
优先；hint 不可用时仍可按现有正文、历史、偏好和配置默认选择有效目标，全部无效才 no-target。
正文显式禁用 mention 先拒绝，不能借 hint 改投；exact:true 的协议收件人优先于正文，
不能追 successor。已绑定 Queue 与严格 system admission 不经过这个提示兜底。
CI 的原三项 F202 检查保持不改，新增真实 plugin delivery 和中央 resolver 交叉回归。

已有 targetless settlement 测试原用 @opus 正文制造空目标；该正文现在是明确的成员身份。
fixture 改用无 mention 的普通正文，仍原样验证 Memory/Redis 的退休故障、重启、重放与旧 claim
不能退休新目标。没有放宽这些持久化断言；该 owned Unix-socket 文件由 Linux CI 验证。


## 插件 wake 结算重试的接纳事实

独立复审复现：Queue 已接纳但 wake effect 未确认时，重试提前重算 hint，配置变化使合法
请求成为 identity conflict；退休后还可能尝试重建工作。仅在现有 plugin delivery 消费边界
回读同 source 的 durable Queue 行与 History.kind=input。核对 owner、from、thread、messageId
和 content；pending 行复用现有 adoptCommittedAdmission，只恢复缓存与普通 drain 通知。
退休 source 直接 acknowledgement，不创建新 target、策略或 claim。exact 有原 target 证据时
必须匹配；原行缩减后优先 requestedTargetCats，不把剩余 targets 当作原始快照。

这是原消息的接纳回执，不是确认本轮 hint 已被执行。已退休且没有 dispatch refs 时，现有
数据不能还原旧 hint/exact 模式；保持 Host 的同 source 首份 receipt 语义，不新增完整指纹
冲突保证。没有首次接纳事实的已发布插件消息仍走首次解析。无新增持久字段、Store、缓存、
迁移或路由系统；回退只撤销这段消费与聚焦测试。

## 维护者 review：首次解析、canonical 校验与 receipt 重放

来源：[精确 HEAD 4bf297962 的维护者审查](https://github.com/zts212653/clowder-ai/pull/1786#pullrequestreview-5743303109)。
两项 P1 分别是 system send 在异步 policy 后再次投影 successor，以及已确认 HTTP 请求在
重放核验前检查当前 availability；P2 是 no-target 返回不符合共享 schema 的空改发确认。

实施边界：原请求仅消费一次一跳关系；async policy 返回的 canonical targets 在 atomic
append callback 内只做 exact 校验，无效即零写入拒绝，不能再成为 predecessor。
已提交 source 的 explicit targets 原样交存储核验，Queue 使用原 bound targets，完整
Message envelope 和 requestedTargetCats 仍参与冲突检查；partial 不补回已消费目标，
retired 不重建执行。无 successor 返回普通 ROUTING_TARGET_UNAVAILABLE 拒绝，保留
cat_disabled 证据，Web 消费既有错误路径；不放宽确认 schema、不增加空集合确认。

复用与最小范围：InvocationQueue.send、messages 的既有 preflight/拒绝出口，以及
真实 Queue/HTTP、Memory/Redis 重开和 Web consumer 回归。无新持久字段、缓存、Store、
迁移或平行 resolver；回退撤销本轮提交即可，保留原持久数据。
验证先保存维护者反例的 RED，再同入口 GREEN，补当前确认、重放、private receipt、
plugin、podcast 与 runtime catalog 回归；最终 HEAD 进入 CI 后再交非作者复审。

非作者同型审计又复现 Bundle/Live 仍在 receipt 前消费当前目标，以及 wire schema 在
catalog 移除后提前拒绝重放；另有 Bundle refs/note、Live contentBlocks 未参与冲突比较。
修复统一为：JSON/multipart 只校验 ID 字符串形状，新接纳仍由中央 resolver 校验成员；
已有请求消费存储身份。Bundle 保留 source ACL/selection 检查并比较既有 refs-only carrier；
Live 先取已存 targetId，再让 Live receipt 与 Queue send 使用同一份完整 Message envelope。
补齐 pending/partial/retired/reopen、registry 移除与 changed envelope 回归；无新增持久状态。
工作期间 next 从 1016aa7a 合入 #1782（Windows Host media path 修复）；无本次文件重叠，
已完整保留并 rebase 到 ad4e3ad4，后续验证与复审绑定更新后的精确 HEAD。
Live 的 bound target 与原 Message mentions 分开消费：默认解析的目标不能在重放时变成
用户曾写过的 mention；原 Message envelope 保持不变，改目标仍冲突。
