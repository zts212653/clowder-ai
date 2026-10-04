---
feature_ids: [F323]
related_features: [F048, F167, F233, F254, F280, F298, F300, F310, F318, F322]
topics: [runtime, restart, maintenance, activation, wait, recovery, audit]
doc_kind: spec
created: 2026-09-27
description: "让用户看清哪些任务在等版本生效、哪些仍在工作，在页面协调停启，并在目标版本就绪后自动接回原线程的验收责任。"
description_source: human
description_author: codex-astra
description_updated_at: 2026-09-27T02:50:26Z
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/features/F323-runtime-restart-coordination.md"
design_gate_claim_contracts: [docs/design-gate-claims/f323-deployment-waits.json]
mcp_admission_claims:
  - ref: "file:docs/features/F323-runtime-restart-coordination.md"
    toolName: cat_cafe_register_deployment_wait
    resourceFamily: task-custody
    boundaryKind: resource-entry
    decision: accepted
---

# F323: Runtime Restart Coordination｜等待登记、优雅重启与自动回访

> **Status**: in-progress；Phase A 实现已合入 #4853（`3f39bc101b55`），runtime 尚未加载；真实合入等待登记（AC-A11）、Alpha/运行验收与后续 Phase 未完成 | **Owner**: 本 thread 指挥责任猫 Astra（@codex-astra, gpt-6-astra）与 Opus55（@opus55, claude-opus-5-5） | **Priority**: P1
>
> **operator kickoff**: `[thread-id]#private-source-id`（2026-09-26 PT / 2026-09-27 UTC）：“我们正式立项一下？”；最大痛点是“不知道有多少猫工作干完了要重启”，数小时后重启完需要自动唤醒当时等待的猫。
> **Original scope**: 同 thread 的 `private-source-id`（通知工作猫、重启后续办）、`private-source-id`（同位置三态按钮）、`private-source-id`（自然收尾、意外中断、主动直接 stop）、`private-source-id`（重启来源审计、异构消息通道）。

Architecture cell: `ball-custody`, `dispatch`, `runtime-deployment`

Boundary: Task 条件等待归 ball-custody；准入/投递/执行归 dispatch；既有 F300 / ADR-039 停启与部署事实归 runtime-deployment；用户入口消费现有 Hub 工作状态。

Map delta: `runtime-deployment` 启动历史、API/Web readiness 与部署版本证明随 Phase A #4853 实现；等待仍扩展原 Task，准入仍归 dispatch。三态网页控制与维护停启属于后续 Phase，未新增日常 runtime 的部署授权。

## Why

You 要能在多猫并行工作时决定何时更新日常服务，并放心忘掉每条“重启后喊我”。正在工作与已经做完、等待版本生效的猫是两群人：后者可能早已离开“正在发生”列表，数小时后仍需要回到原 thread 验收或续办。现在用户既要判断谁可以停，又要记住哪些猫等过重启，重启后逐个敲门；已生效但无人接回的工作还可能继续显示 blocked。

终态体验包括：持久等待登记与可见数量、目标版本真实就绪后的自动通知、页面内三态停启、被维护暂停的工作可控恢复、直接中断后的诚实找回及操作审计。优先交付等待登记与自动回访，完整 Feature 不以只有重启按钮作为完成。

## Current State / 现状基线

- `package.json` 已有 `runtime:restart`；`scripts/runtime-worktree.sh` 按 ADR-039 核验进程归属、冻结单次版本并走统一启动路径。F300 WP1 的 `scripts/lib/daemon-stop-operation.mjs` 已拥有停启操作与复验契约，不能另写一套停止/重启状态真相。
- F048 的 `StartupReconciler` 及后续 durable Queue / child lifecycle 能处理重启中断与合格队列恢复；它们不等于“登记某改动加载后，回指定 thread 验收”的产品闭环。
- F233 已区分条件满足即完成与条件满足后回到 owner；F280 的显式等待、F167 的责任/回执、F310 的开发 Task 应复用，不能另造影子任务或按聊天关键词永久派工。
- 盘点确认 #4802、#4803、#4806、#4807 的合入提交不在上述日常版本祖先链；对应 F317 / 启动性能 / native guard 现场仍有待激活事项。一个 thread 同时有待激活子项与继续开发不矛盾，不能整条标成“工作完成”。
- F022 #4770 与 F306 #4739 已在日常版本中，但现存验收 Task 仍写旧版本、保持 blocked；只能判“版本条件已满足，需原 owner 核实后续”，不能冒称验收完成或猜测猫实际是否看过。
- 09-08 调研确认 Claude 默认 print carrier 与 Codex app-server 的同轮通知能力不同；后续 F318 已独立立项。F323 在实施时重新读实际 carrier 能力与回执，不把历史能力快照写死成按猫品种分支。

## What

### Phase A: 记住谁在等，生效后自动叫回

猫在原任务中登记“哪个部署 / 什么条件满足后 / 回哪个 thread 找哪个 owner / 醒来做什么”，取得持久回执。普通体验是“这项改动上线后叫我回来验收”，版本、原来源与已有 Task 引用由可查证上下文填入；需要人工补充时只问真正不明确的信息。登记不是停机授权，也不创建已有 Task 的镜像。

**部署等待作为 F280 `UnifiedAwaitStateV1<SubjectRef, Baseline, Predicate>` 的第四类实例，嵌在原 work Task，显式 `autoRenew:false`。** subject 使用能唯一定位 installation/deployment 的 `deployment:` 引用；条件只存于 `continuation.when`，不再往 `TaskProbeSpec` 加部署种类，也不使用 `resolveMode` 表示同一续办。沿同一 generation CAS 处理登记、替代、取消与消费，复用 `WaitOutcomeV1` / `WaitContinuationCarrierV1` 的结果和投递身份；当前 outcome 仍含 GitHub 专用 subject/matched/terminal 字段，实施须作有界类型扩展，保留 PR/issue 兼容及领域字段隔离，不能强制 cast 冒充已支持部署。owner 引用原 Task 的权威责任，不另存可漂移 owner 快照。callback/MCP/Hub/store 走同源权限与 typed 终态，具体入口在实施时沿该 owner 冻结。F233 仅消费 blocked/唤醒等球权投影；旧 `http_get/redis_exists` probe 不迁移，timer 仍由 DynamicTask 执行。不建并行等待表/镜像 Task，不把 work await 塞进 PR/issue 专用 automationState；不预建通用条件 DSL。

首版部署 predicate 只收两种有界条件：① **运行版本包含固定合入 revision 且所需服务就绪**；PR 输入先经 repo/PR 真相解析并冻结 merge revision，后续不追可变 head。② **目标部署出现基线之后的新启动且就绪**；服务端保存登记时的启动身份/基线，时间用于展示和约束，不单靠 wall clock 推断。第二种只证明新启动，不能宣称 `.env`、权限或配置已经生效；猫醒来仍须验配置。配置语义探针等有真实样本再设计。Git-less 安装必须有构建来源提供的等价包含证明；没有就明确 unsupported/unknown，不用版本号大小猜祖先关系。

目标绑定 installation / deployment，Alpha ready 不能满足日常 runtime 等待。等待默认持久化 TTL=0；原回合结束、浏览器关闭或几小时过去都不失效。取消、替代、owner 改变与后续动作的权限沿既有 owner 契约处理。

在“正在发生”附近提供“等待更新 / 可以接回”的数量与可展开清单（读取原 Task/部署/投递事实的投影，不维护第二份 live 等待表或计数器）：任务、人可读原因、负责猫、等待时长、来源入口和下一步。数量按等待事项计，另可显示涉及多少 thread/猫；相同来源重复登记幂等，不按猫名字把平行工作合并。

增加“按当前候选版本预计可满足 K 项”的重启前预览。它是带候选 SHA/观察时间的预测，不是生效承诺；实际重启只消费该动作冻结的版本，再按真实 ready 事实结算。远端 main 前进、构建失败、切回旧版都可能使预测不兑现。

登记时立即核条件，启动恢复完成并建立 readiness 后主动核一次，随后由已验证接线的 F280 等待恢复/检查路径补偿，不靠每只猫开短 timer hold 轮询。注册时已经满足且原 owner 正在当前回合时，回执携带证据，让当前执行承接并记录消费；不能同时另起一只同任务的猫。其余等待沿原 owner 的 durable delivery 路径送回原 thread。

**每个等待段一次逻辑回访，传输可按同一身份重试。** 保留并扩展既有消息幂等和 dispatch 核准：冻结的满足证据、messageId、owner fence、投递/消费回执必须可恢复，不能仅写一个醒来时间。成功准入后不因 12h 冷却自动开新执行；失败/未准入仍沿同一身份恢复，后续搁置提醒不是新的业务执行授权。投递前重新核目标条件，回滚到旧版或 readiness 丢失不能继续以旧观察启动验收。找不到原目标、已取消或权限改变时保留明确处置，不悄悄换猫；业务完成仍由原 Task/回执裁定。

**启动事实与离线 hold 兼容随 Phase A 一起交付。** `runtime-deployment` 持久记录每次启动身份、实际版本、started/ready 时点和退出证据；只记录当前启动时捕获的构建身份，不拿之后变化的磁盘戳改写运行版本。正常退出完成证明在必要收尾完成后写入，不能复用 shutdown 一开始就写的审计。授权停机意图与实际退出结果正交：有授权但中途被杀仍可是不完整退出；历史缺证据/首次安装显示未知，不推定 crash，更不猜某只猫。

timer 型 `hold_ball` 在停机期间到点，恢复时先核原 owner、条件、取消/替代/期限；仍有效的按同一持久唤醒身份补发并带原计划时间/延迟，真正失效的持久记录处置。不得仅因错过 fireAt 删除这份续办责任，也不把所有普通一次性日程改成无条件补跑。此项由原 scheduler/ball-custody 路径修复，是 F323 恢复兼容的阻断验收，不另建 timer 系统。

**合入现场必须自然产生等待。** Phase A 同批更新 canonical `merge-gate` Step 7.5c 及相关工具描述：保留 `main=landed` / `live=dormant` 的诚实状态，把普通待激活的验收续办登记到原 Task 并取得持久回执，不再为每次普通激活单独 @You。确无合适 Task 时，按现有授权与 F310 接责契约建立承载这次验收的 Task，不能从合入事件推导新授权或复制已有责任。紧急激活或真正新增权限/成本/产品取舍才带 Decision Packet；登记不授予停启权限。规则切换以登记能力在目标运行实例可用为前提；首次引导激活/能力未加载时明确保留现行路径，不伪造登记成功。Phase A 必须包含至少一次真实合入后猫自行登记的样例及原 owner 核实后的存量候选迁移，不只跑 fixture。本次是 spec/plan 修订，尚未修改生效中的 skill。

存量聊天扫描仅生成待核实候选；本次盘点不会自动创建等待、唤醒猫或改写其他线程的 Task。以后迁入正式等待也须回原 owner 核实，不能把历史一句“待重启”直接当自动执行授权。

### Phase B: 同位置三态按钮与协作收尾

主操作按用户点击推进：**通知大家停机 → 重启 runtime → 全面恢复**。内部另有通知中、收尾中、重启中、失败等状态，不把过程伪装成三个瞬时步骤。

第一步用同一 opId 关联两个字段不重叠的 owner：runtime-deployment 持有维护意图、授权与 stop/restart/reverify；dispatch 持有该 opId 对应的持久准入冻结 generation，并在 Queue/custody/新执行准入的原子核准边界检查。停启文件不保存准入开关或恢复清单；不能让队列靠读取文件获得一个会过期的放行判断。冻结回执核实前不显示已停稳；跨两侧的中途崩溃按同一 opId 对账，证据缺失保持冻结/未知，不自动放行。消息与回调先持久接收，普通工作排队不启动，维护控制、现场读取与收尾回执保持可用。主闸不在 `AgentRouter.routeExecution` 末端把已接纳工作抛成失败。直接用户消息、A2A worklist、调度、重试、startup 的 processNext/ActionSuccessor/managed-command/GitHub wake 及绕过 router 的模型调用均纳入 caller census；现有 scheduler global pause 的 skip 语义不能当可靠延期。

人类普通留言仍可保存，但不会仅因发送者是人就默默绕闸开新任务；取消维护后可正常继续。若设计选择提供显式临时放行，必须清楚展示影响，并撤销旧 ready 判断、把新执行纳入收尾集合；不能一边显示全部停稳、一边容许新执行产生。

受影响执行以原 thread / cat / execution 身份通知。界面区分等待接收、已读正在收尾、已保存且停稳；模型自报不构成可停证明。自然结束的回合可贡献 execution 终态证据，但托管命令、远端执行、录音或插件仍可能活着，不能只看 turn ended。现场保存包含原任务/会话/工作目录引用、下一步及尚未确定结果，不强制提交半成品；资源由原 owner 证明完成、可保留或无法安全暂停，不承诺所有进程都能热续接。自然完成且没有续办义务的工作不进入恢复名单。

未收尾不会因计时自动强杀。用户可继续等待、取消维护，或另行明确选择立即重启并查看未收尾项；取消维护恢复本次暂停的准入，已经登记的版本等待仍有效。

### Phase C: 页面重启、恢复与来源审计

页面调用受鉴权的窄停启动作，复用 ADR-039 与 F300 的 daemon 生命周期。执行者独立于被停进程集合；冻结目标、授权、停止、构建启动及健康复验都能在 API/Web 下线后继续。不得把通用 shell 端点暴露给前端，也不能用写入 live runtime 目录或环境变量绕过 guard。

需要补齐 canonical restart 对同一 stop operation 的 authorize→restarted→reverified 接线及可信 actor 绑定；CLI 参数中的自由文本 `authorizedBy` 不能充当鉴权。进程外执行与离线可访问入口是需求，但不预先决定必须新增常驻 daemon。先比较复用现有外部宿主/系统管理入口与新常驻控制器，形成可审阅的安全、安装与故障恢复方案。

当前启动器在停机后同步/安装/构建。隔离目录预构建可作为缩短停机候选，但不得在正在服务的 runtime 树上提前同步/构建；必须验证制品版本、搬移/激活、归属与失败恢复，并对需要改变的 ADR-039 契约单独裁定。本 spec 不承诺零停机或自动回滚。

重启进度/故障恢复入口在目标服务下线时仍可访问；状态可跨刷新恢复，失败明确停在哪一步并支持同一操作的安全重试。UI 控制入口与既有 daemon 的具体承载方式在 Design Gate/实施 census 中选择，不预建第二套 supervisor。

两类恢复分别处理：**原本登记等待版本的验收/续办猫，在条件满足后自动通知**；**此次维护暂停的普通工作，等用户点击“全面恢复”再继续**。自动回访是窄的维护放行对象，不打开其它 Queue/调度任务。恢复集合从该冻结代下的队列项、关联 opId 的中断执行，以及原 Task 中已记录的协作收尾续办义务查询得出，不另存可独立变化的恢复名单；自然结束但承诺续办的工作不能漏掉。全量恢复仅涵盖本次暂停且仍有效的工作，遵守并发额度，逐项有回执，失败可重试；不是唤醒所有历史猫或复活已取消任务。

用户直接 stop 或意外中断时，正常启动后也能从持久执行事实形成待恢复清单，不要求必须先点第一步。没有完整 checkpoint 的工作先核实现场；命令结果不明不自动重跑。已登记的版本等待照常核条件并自动回访。已有 F048/Queue 恢复路径要与维护边界和幂等回执协调，不双重派发。

审计关联提议者、批准者、实际执行主体、来源 thread/message、目标部署/版本、开始结束、受影响工作及结果。猫建议重启与用户点击授权分别留证。外部直接信号若没有身份凭据，明确来源未知；不根据在线猫或最后一句话猜归因。

## User Journey

### Primary Journey: 几小时后更新，所有等待验收的猫自动回来

- **Scope unit**: deployment + wait item + 原 task/thread/owner。
- **Actor**: You、等待版本的猫、仍在工作的猫。
- **Entry**: 猫在原任务登记等待；You 从“正在发生”附近进入等待与维护清单。
- **Flow**:
  1. A 在 thread X 完成改动，登记版本条件和验收下一步；B 在 thread Y 也登记。C/D 继续开发。
  2. 数小时后，You 能看到两项等待、对应原 thread 与负责猫；A/B 即使没有活动 invocation 也仍在清单中。
  3. You 点击通知停机，C/D 在可确认的边界保存现场；等待接收与已读/已停稳分开显示。
  4. You 点击重启；页面显示冻结版本与进度，断连期间恢复入口仍在。
  5. 目标版本实际就绪，A/B 各自动收到一次可追溯通知，回 X/Y 验收；C/D 保持暂停。
  6. You 点击全面恢复，C/D 从原任务继续；清单显示接回与待处理项，原 Task 根据真实验收结果收口。
- **Success evidence**: 隔离部署中的完整浏览器旅程、持久等待/操作/投递回执、运行版本与精确后继执行；复启/重复事件/失败注入后结果相同。
- **Non-goals**: 本次立项不重启日常 runtime、不自动认领盘点中的别猫工作；不热迁移任意进程内存，不在 F323 重写 F318 carrier，不替代 Feature 的独立 Alpha/用户验收。

### Supporting Journeys

| ID | 场景 | 用户结果 | 证据 |
|---|---|---|---|
| J2 | 直接 stop / 意外中断 | 重启后看见准确的受影响事项，可恢复；已登记的版本等待仍能回访 | 没有 prepare 的隔离重启演练 |
| J3 | 条件早已满足却仍写待重启 | 显示可回访，核实后续；不再要求多重启一次 | #4770 / #4739 本轮盘点型 fixture |
| J4 | 一个 thread 有两个任务、一个猫有多个 thread | 每个实际等待都可追踪；只接回对应工作，不按 catId 粗略去重 | 多目标/多任务 fixture |
| J5 | 停机失败、权限拒绝、无可确认安全点 | 可看原因与下一步，可取消/重试；不假报通知到达或恢复成功 | 状态机与真实壳失败路径 |

## 需求点 Checklist

| ID | 来源与需求 | AC | 验证方式 | 状态 |
|---|---|---|---|---|
| R1 | 09-26：不知道多少猫在等重启，数小时后要记得他们 | A1–A3、A7–A8、A11 | 无活动 invocation、多 thread、跨重启持久清单、候选版本预览 | [ ] |
| R2 | 09-26：重启完成自动唤醒原来等着的猫 | A4–A7、C3 | 真实就绪→持久通知→原任务续办，无重复 | [ ] |
| R3 | 09-07：一个三态按钮，不去 terminal 操作 | B1–B3、C1–C2 | 真实产品壳三次点击，含离线控制面 | [ ] |
| R4 | 09-07：有猫仍 working，支持等收尾与直接停；09-27 再确认被踹/崩溃 | A9–A10、B4–B5、C4 | 异构通道/长工具/无 prepare 中断/有效 hold 迟到恢复 | [ ] |
| R5 | 09-08：知道谁在喊、谁执行，收到消息不能假报 | A9、B4、C5 | 身份审计、回执、授权后异常退出及未知来源负例 | [ ] |

## Acceptance Criteria

### Phase A（等待与自动回访）

- [ ] AC-A1: 同一猫不同 thread、同 thread 不同事项可独立登记；同源重复请求幂等并返回原等待。登记受原 owner/principal 校验；不存在无依据的 recipient 改派或 Task 镜像。
- [ ] AC-A2: 等待默认持久化 TTL=0；无 active invocation、浏览器关闭、数小时等待、API 重启都不丢失，可查询/撤回且留历史；登记回执先持久再报告成功。
- [ ] AC-A3: 真实壳同时展示仍在工作与等待版本的事项、数量和来源；混合待激活/继续开发的 thread 不被误标整体完成。既有等待条件已满足可见为待回访，不继续算未更新。
- [ ] AC-A4: 仅精确 deployment 的实际版本/启动代次/就绪条件匹配才唤醒。main 合入、Alpha ready、端口可达、重启旧版、错误实例均不能替代谓词证据；就绪与登记并发不会漏通知。
- [ ] AC-A5: 条件满足后无需人逐个 @，原 owner 在原 thread 接到带来源和下一步的通知；重复 ready、两 worker、崩溃后重投、已收到但回执丢失均用同一幂等身份收敛，不并发重复开工。
- [ ] AC-A6: 已撤回/替代/终态且无后续的等待不复活；接收目标不可用/授权改变有明确失败或待处理状态。唤醒成功不直接写业务验收完成，结果未知不重放有副作用的命令。
- [ ] AC-A7: 原 work Task 只保存一份 F280 部署 await（autoRenew:false），同一 generation CAS 覆盖登记/替代/一次性回访/失效与 owner fence；不同时登记部署 probe。MCP/Hub/store 同源鉴权和 schema，旧 probe 不迁移。立即满足不双执行；以生产构造的隔离测试证明真实登记/恢复/投递接线及既有 PR/issue/scheduler 类型兼容。
- [ ] AC-A8: 部署版本条件与新启动条件分开验证；PR 冻结 merge revision，boot 使用服务端基线且时钟回拨不造新启动。rollback/未 ready/错误实例/Git-less 无包含证明为否或未知；重启发生不能当作配置生效。候选 K 项预览与实际冻结版本、满足结果可对账。
- [ ] AC-A9: 持久启动记录在 clean exit、SIGKILL、启动中失败、授权后被杀、首次安装/旧记录缺失下保持真实归因；启动恢复后核等待，成功日志/端口监听不早于 readiness 充当唤醒证据。记录/读取失败保留未知而非放行。
- [ ] AC-A10: 有效 timer hold 离线到点后可持久补发；补发前查取消、替代、owner/授权与期限，原 fireAt 和延迟可见。覆盖创建/执行/回执各崩溃点、多 worker、未准入重试、已消费不重放；真正失效留处置，普通一次性日程语义不被整体改写。

- [ ] AC-A11: canonical merge-gate 7.5c 与工具描述随登记能力交付；普通 live=dormant 验收续办有原 Task 等待回执，不再逐项催人重启，停启授权边界保留。至少一次真实合入→猫自行登记→清单可见；存量候选逐项由原 owner 核实迁入。能力未加载/登记失败不得假成功，首次引导路径明确。

### Phase B（协作收尾）

- [ ] AC-B1: 获得真实壳 Design Gate：等待项与工作项并存、三态主动作、默认/繁忙/失败/390px 状态和可追溯详情可由 You 亲自操作判断；复用 F056/F305/F322 的视觉与入口约定。
- [ ] AC-B2: 同一 opId 下部署意图/授权与 dispatch 准入冻结各归其 owner，冻结 generation 在原子准入边界核验，跨两侧崩溃可对账且缺证据不放行；直接调用、Queue、A2A、scheduler、retry/startup recovery 全覆盖。恢复集合从原 Queue/Invocation/Task 事实生成，无第二份清单；新消息/结果持久接收，收尾控制可用。
- [ ] AC-B3: 保存的现场能接回原任务/工作目录/会话与下一步；写入半途中、长命令、远端工作、托管 gate/插件/录音均有经其 owner 证明的完成/存活/中断处置，不拿一句“已准备好”当全体资源安全。
- [ ] AC-B4: 界面区分通知已保存、通道接受、正文已读与安全收尾；按实际 carrier 回执投影，未读通知、Claude 等待下一接收点、native tool 卡住均不假 ready。
- [ ] AC-B5: 等待超时不自动强杀；可取消维护并恢复本次准入，或显式选择立即重启并列明未收尾工作。两次点击、多页面同时操作与旧操作重放不启动并发停启。

### Phase C（停启、恢复与审计）

- [ ] AC-C1: 三态按钮调用既有受控 daemon lifecycle；实际操作者身份与授权可验证，冻结一个部署目标，执行者不属于被停集合，API/Web 停止后仍可完成启动/复验，不暴露任意 shell 或绕过 guard。
- [ ] AC-C2: 控制/故障恢复入口不依赖正在重启的服务；断连与刷新后可读同一操作状态。构建/启动/就绪失败不进入“可恢复”，重试保留原操作来源并核验旧进程真实终态。
- [ ] AC-C3: 已登记验收等待在满足条件后自动接回；本次维护暂停的其它工作继续冻结，直到“全面恢复”。每项恢复有明确回执，遵守原授权、owner 与并发限制，重试不重复消费。
- [ ] AC-C4: 无 prepare 的 stop/crash 后，以既有 durable execution/Queue truth 形成待恢复清单；来源或结果未知明确展示，恢复先核现场，取消/完成任务不复活，旧恢复消费者不额外重复派发。
- [ ] AC-C5: 同一操作可追溯提议者、批准者、执行者、来源、时间、目标与逐项结果；外部信号无凭据显示未知。通知/恢复/副作用回执之间的区别在详情和历史中保持。
- [ ] AC-C6: 已合入代码先在隔离 Alpha/隔离 daemon 完整演练，再在用户明确授权的日常维护窗口补真实体验验收；非作者核原诉求与两类恢复。主线代码完成不等于本 Feature 关闭。

## 指挥与执行编排

operator `private-source-id` 指定本 thread 为指挥与理论现场：Astra + Opus55 都负责驱动工作、整合验收与验收后的 vision 守护。各 Phase 使用独立执行 thread，执行池为 Sol6、Sol5.6、Kimi；runtime 重启后的真实验收另开现场。代码审阅由执行猫按风险选择非作者，在执行 thread 自治闭环，不默认逐 PR 交指挥复审。

## Dependencies

- **Evolved from**: F048（中断与队列恢复）。F323 是新的跨 thread 维护用户旅程，不重开 F048 的旧存储 phase。
- **Related**: F300 / ADR-039 拥有停启与实际部署身份；F233/F280/F167 拥有条件等待、责任与投递；F310 持有原开发 Task；F298 提供承诺持久性约束。
- **Related**: F254/F318/F296 的通知与 carrier 能力；F323 消费当前能力，不以全量 Claude carrier 迁移为全部交付的前置条件。
- **Related**: F322 正在整理日常主屏，入口设计需协调原壳 owner，不能竞争写相同文件。Phase A 功能可先按已确认入口交付，完整三态体验仍需本 Feature 验收。

## Risk

| 风险 | 缓解 |
|---|---|
| 旧 blocked / dormant 文字被当作当前事实 | typed 条件、实际部署证据与原来源；迁入前核实；版本满足不等于验收完成 |
| 自动回访绕过暂停或误叫所有猫 | 已登记等待与维护暂停分开，精确 owner/subject/授权；前者窄放行，后者手动全面恢复 |
| 停启、业务任务与等待出现三份真相 | 停启沿 F300，等待沿 ball-custody，业务沿 Task，F323 只定义协调与用户交付，新增对象先做 owner census |
| 关闭 runtime 时控制器也死亡、重复停启 | 独立执行边界 + 既有同代独占操作；隔离故障演练，不用生产杀服试错 |
| 未知命令结果被恢复机制重放 | 恢复现场核验与幂等回执；未知明确待处理，不宣称任意进程无损恢复 |

## Tips Contribution（F244）

实施时贡献两条有实际入口的 tip：①“这项更新生效后，自动叫回原来的猫”；②“在工作清单里通知收尾、重启和恢复”。只在功能真实可用后注册，指向本 spec / 正式引导，不提前把待实现入口推荐给用户。

## Key Decisions

| # | 决策 | 来源 |
|---|---|---|
| KD-1 | 等待登记与自动回访是核心交付，优先于停机按钮 | operator 09-26 最大痛点 |
| KD-2 | 三态主操作手动推进；验收等待自动回访，维护暂停工作手动全面恢复 | operator 09-07 三态 + 09-26 自动唤醒，两类对象分别承接 |
| KD-3 | 沿现有停启/等待/任务 owner 扩展，不自建 supervisor 或影子任务 | 现行 F300/F280/F310 与单一真相源 |
| KD-4 | 正常收尾与直接中断都支持；无法确认的结果保持未知 | operator 09-07 三种实际用法 |
| KD-5 | 原 work Task 内使用 F280 typed deployment await；撤回上一轮 Task probe 提案，保留旧 probe 行为 | Opus55 `private-source-id` 自我纠正，经 Astra 核源码接受 |
| KD-6 | 启动事实、有效 hold 离线补发与合入后的等待登记入口随 A 交付；B 的准入冻结归 dispatch，与 deployment 共用 opId 而不共写状态 | 同上；现有 merge-gate 7.5c、F280 outcome 与 Queue/custody 接线核验 |
| KD-7 | 每个事实一个 owner；复用等待语义，不强行统一业务 Task、scheduler 执行、部署与准入生命周期；三类 thread 分工 | operator `private-source-id` + 本轮计划审核 |

## Review Gate

Phase A 实现已于 2026-09-30 通过 [#4853](https://github.com/zts212653/clowder-ai/pull/4853) 合入 main（`3f39bc101b5580191246ec0f17ceac65298d7874`）。Astra R3 守原实现，Sol 5.6 守后续手机界面差异，Opus55 守策略合流及最后两条回归测试/精确输入映射；各来源的参与和范围披露保留。

[最终 E1–E5 证据](https://github.com/zts212653/clowder-ai/pull/4853#issuecomment-5918264917) 使用 operator `[thread-id]#private-source-id` 授权的手动完整检查车道：五项 canonical stage receipt、49/49 native S3 浏览器、guards/lint、完整产物检查的剩余定向修复验证均通过。原 canonical whole-run failed 保持原样；主机压力只获本次准入豁免，不声称主机健康或 whole-run PASS。

运行事实：合后 `/health` 返回 deploymentRevision `78c9389604bcb4641c695e05e971c884c01afbf4`，未包含本次 merge；`live=dormant`。当前实例未暴露部署等待登记工具，`registration=unavailable`，不得冒称取得原 Task/generation 回执。独立手机图修改 Task 已 done/satisfied，未要求重复视觉签字。AC-A11、真实壳 Design Gate、Alpha/运行验收与 Phase A 终验仍未完成；原指挥 Task 及 owner 不变。

