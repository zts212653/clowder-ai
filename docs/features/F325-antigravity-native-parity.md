---
feature_ids: [F325]
tips_exempt: "Renewed 2026-10-17 after merged native finish and live identity verification: This records repair toward normal member capability parity and still-incomplete acceptance, not a newly usable public entry. The former Task-only tool/file restrictions are not the product goal; add user-facing discovery when the complete working path is delivered and verified."
related_features: [F053, F061, F143, F149, F161, F174, F178, F194, F201, F203, F210, F211, F241, F254, F261, F286, F296, F299, F306, F318, F320, F323, F324]
topics: [antigravity, acp, native-carrier, parity, migration, managed-job]
doc_kind: spec
created: 2026-09-29
description: "让暹罗与其他 AGY 猫在家里稳定对话、持续工作和恢复现场，统一原生接入、身份、安全与长任务体验，并退役旧执行载体。"
description_source: human
description_author: codex-astra
description_updated_at: 2026-09-29T06:01:16Z
---

# F325: Antigravity Native Parity｜Siamese的新猫爬架与旧接入收归

> **Status**: in-progress | **Owner**: 小星星·Maine Coon (@codex-astra, gpt-6-astra) | **Priority**: P1

**2026-10-20 验收安排更新（覆盖下文这三项的专门验收安排）**：You 在本线程 source1157（`[thread-id]#private-source-id`）说明这几天正常使用没有遇到问题，要求认证中断恢复、上下文快满时自动接续、持久后台任务随日常使用验收，不消耗Siamese或其他猫的额外 token 专门验收。三项沿平时真实任务自然观察，复用已有证据；不为凑验收安排额外模型调用、长任务/故障探针、周期核验或反复审计旧材料。日常出现具体故障再针对该现场定位、修复与必要验证。未触发的场景如实保留证据边界，不以“近期没出问题”冒称全部通过，也不继续以缺少专门验收为由要求重复演示。原 Task2347 与 Astra 的交付责任保留，本次不关闭 Feature。

**我们要的结果**：You 从家里正常入口叫出Siamese，便能对话、创作、查记忆、用工具、读改代码与测试、接 review、接住插话、停止和续接；长任务独立持久、重启可恢复，历史与身份保留，过时入口退役。以家里 Codex app-server / Claude 已落地的实际能力为参照，在相同授权与受保护目标边界下可用。普通工作不能要求人为维护 Native 专属的短工具清单或只为验收准备的空目录。任何真实上游限制须有当前证据和可用替代；本地尚未接线不能冒充不支持。

剩余问题按具体结果持有：认证过期后自动、安全且不重放副作用的自然恢复尚无阳性；原视频已有约5分49秒有声1080p成片，但截至该观察cutoff未完成原线程要求的可播放交片，质量也未由本回看签字；自动阈值handoff、后台served-model、其他平台及Phase C/S4未结算部分继续按各自原件核实。沙盘成功回合的 `toolResultsConfirmed=false` 仅作为待定位线索，不能说所有结果已确认，也不能未经定位宣布新bug。早期401、长时间沉默和审查漏检保留为历史反例；不把修复前故障推断为当前必现，不要求Siamese再演一轮已有证据的日常能力。

**实现与验收进展（2026-10-14 16:40 UTC）**：[同一个 PR #5510](https://github.com/zts212653/clowder-ai/pull/5510) 已于 16:00 UTC 合入 `4fd53e548ba7fdf3d27720b08629fe1eca4a3bbf`。Sonnet 对最终 `1ee83e6f52e995e970d888a61ead2371ca52ab00` 独立复审 approved（执行线程 source1026：`private-source-id`）。正常 MCP/原生工具、共享 guard、流式/工具错误恢复、skills/媒体、当轮用量、持久 session 与发送正文前的 verified init 已接通；Native 压缩沿既有 F296 控制与 epoch owner 接线。Action Plane 单一持久 job 包含独立 worker、lease/fencing、principal 幂等/显式 retry lineage、取消/恢复、日志与 metrics/trace。旧 Gemini CLI/IDE execution、专用 Task/file grant 和 task-test 旁路已在 PR 中退役，历史 reader 保留。合入还修正共享 shell reader 把重定向当 argv 的根因，保护 Claude/Codex 与 Native 的目录判断；非作者 4099 条差分未发现 deny→allow 放松。后文旧 P1 描述是历史基线，不是新的产品限制。

**凭据控制面复审修正（source440）**：Sol6.1在71上发现security证书/identity/login/trust隐式修改仍可绕过。Astra复现4红/4阳性后，在同PR提交`c515439ea3a0d8ce10c32e52112eab4e055e590b`，按整类命令只放行经证明的只读形式，其余拒绝；原反例及相关guard合计18/18，57个本机命令名判定扫描无漏项。仅2文件变化，其他独立已测delta保持，Sol6.1 source462已typed approved、53/53独立检查通过；不替真实OAuth刷新或原线程验收签字。

**当前review路由**：You source052曾指定后续开发reviews交SiameseArgon；当前source548（`[thread-id]#private-source-id`）因正式环境仍有串行等待，直接改派小太阳Sol6.1审PR #5583。Sol6.1 source551已接exact `fb975c33f4dd2a2dfa05e10c52b3962738693325`的四文件增量。原Argon请求source535的持久队列回执已为`withdrawn`、attempt `cancelled/source_withdrawn`，当前队列无该审查，不重复唤醒。Astra继续原Task/实现，旧#5580及其他独立批准保持原审查归属；本次改派不代表新批准或正式加载。

**独立恢复判断已通过**：Argon source097（`private-source-id`）typed approved证据cut `c9a356870747b70cac8ffa17f0c001e58a3c4200`，无P1/P2，认可解除旧会话续接、只读补读准入与OAuth五秒保存超时三项具体阻塞；核过38件原件哈希及历史/成员不变。其批准不覆盖整体Feature终态。

**尚未结算的具体边界**：上述日常能力独立补证已经成立，不再用整项未关闭否定它。boot35已实看当前回复的桌面、手机与刷新呈现，其他页面旅程不据此代签；macOS桌面无逐帧记录，不能扩大无弹窗的保证。自动阈值 handoff 的 unavailable 会阻止实际动作，需原持续工作结果的策略证据/具体裁定；既有 Native 手动压缩与续接实证保留。协议只证明配置与CLI init/request选择的模型，没有独立backend served-model证明，保持`modelVerified=false`；AC-A2不提前签字。source1141提出的明确限制建议尚待operator裁定。Linux/Windows未认证。整体愿景尚未获完整放行，不以作者报告或本次部分补证关闭Feature。原#5510工位的历史记录是具名retained至2026-10-15 20:25 UTC，#5551修正工位已释放；未新查库存，不把旧到期记录当当前有效续留，也不冒称删除。

原 A–E、F261 有效需求与迁移/历史边界继续被同一 Task 承接；未以部分进度关闭 Feature，也未重启正式 runtime。

Architecture cell: `identity-session`, `transport`, `callback-auth`, `bubble-pipeline`, `action-plane`, `mcp-surface-governance`, `dispatch`

Map delta: landed in PR #5510 — AGY Native 消费现有 identity/session、callback auth、MCP surface 与 Action Plane。普通工具按共享 invocation policy 授权，不再要求 Native 专属 Task/file grant；持久 Managed Job 的 record/lease/fence 归 Action Plane，F167 Task/wake 仅承载关联与完成通知，不另立任务真相。

Why: F325 是 AGY 用户旅程的唯一交付入口，复用已有运行时、鉴权、MCP、任务与呈现 owner；不建立第四套会话/审批/任务真相源。

Canonical source: `packages/api/src/domains/cats/services/agents/providers/agy-native/`（原生 L0、精确 binding、preflight、stream-json 与媒体/skills）、`packages/api/src/domains/cats/services/agents/invocation/tool-execution-policy.ts` 与 `scripts/native-effect-segment-locations.mjs`（共享授权与命令目标分析）、`packages/api/src/domains/managed-job/ManagedJobService.ts`（唯一持久 job 服务）、`packages/api/src/routes/session-compaction-surface.ts`（既有压缩控制）、`packages/mcp-server/src/tools/callback-tools.ts`（MCP hold/status/tail/cancel 接线）。

原生 L0 沿既有 `l0-compiler.ts` 按 catId 与 callback owner 编译，由 Service 写入主 agent 原生槽；用户 prepend、resume fallback 与 F129 动态 pack 不作为该槽的替代来源。`invoke-single-cat.test.js` 的普通 Chat 路由回归覆盖无 prepend 首轮、续轮绑定及动态 pack 隔离；编译失败继续在模型启动前拒绝。

`queue-receipt.ts` 持有唯一的 provider/carrier/delivery 常量与派生类型；API `queued-message-custody.ts`、前端 `queue-message-receipt-normalizer.ts` 与 `message-disposition-presentation.ts` 消费同一列表，包含 `google / agy_stream_json`。`f254-queued-message-custody-store.test.js`、`queue-message-receipt-normalizer.test.ts` 与 `message-disposition-presentation.test.ts` 守序列化及前端读取、未知值拒绝、AGY 仍不支持精确本轮读取；`message-receipt-dock.test.tsx` 与 `issue1371-settling.test.mjs` 的 AGY fixture 守归一化后该猫回执行不消失。浏览器覆盖策略把这些输入选择到该现有旅程；这些测试不替代真实 Chat/OAuth 浏览器验收。

P1 验证期间，`scripts/pre-merge-check.sh` 从冻结的 main 与本地发布分支 tracking ref 判定同步方式：已含 main 时不重放；发布 tip 是本地 HEAD 的祖先、且尚未进入 main 时普通 merge main，保留已发布历史与合并解冲突；缺少 tracking ref、已与它分叉或发布 tip 已进入 main 时沿用 rebase。tracking ref 是本地已知发布证据，不声明远端状态实时完整。祖先/对象核验错误或 merge 冲突在后续门禁前停止，HEAD 变化后仍重启当前树的门禁。`scripts/pre-merge-check.test.mjs` 的真实 Git 回归守「发布后 main 前进」的 add/add 解冲突与两侧祖先保留；同文件守失败不重放、rebase 路径及重启顺序。

Consumer evidence: `rg -n 'AgyNativeAgentService|ManagedJobService|compact-native|agy_stream_json' packages/api/src packages/mcp-server/src packages/shared/src packages/web/src` 可复查实际 consumer。旧 `agy-native-coding-grant`、`callback-native-test-grant`、`native-task-test-*` 与 `cat_cafe_run_task_test` 已随 #5510 退役，其旧 MCP admission 记录不再作为现役工具声明。

Claim guard: `agy-native-preflight.test.js` / `agy-native-agent-service-resume.test.js` 守正文前 verified init 和精确续接；`agy-native-normal-work.test.js` / `agy-native-callback-scope.test.js` 守普通工具与 server scope；`agy-native-effect-guard.test.js` / `f306-native-effect-segment-locations-bash-oracle.test.js` 守控制面和共享 shell 坐标；`managed-job-service.test.js` 与 worker/route 故障测试守幂等、取消、恢复和唯一完成；`f296-native-compaction-route.test.js` 守压缩控制。作者最后完整 API 套件 29396 项中 5 个既有 cursor 失败，合流 main #5542 后同组转绿；Sonnet 最终完整套件 29385 项只余 3 个已证环境基线失败，无 PR-only 失败。独立证据与合入判据见 [merge receipt](https://github.com/zts212653/clowder-ai/pull/5510#issuecomment-6172582915)。F320 #5540 引入的 browser catalog 配额错误已具名交回原 owner、候选 #5548 当时尚未合入，未报绿；不归因给 F325。真实 Alpha 与获准运行激活继续独立验收。

## Why

You 应能像叫布偶和缅因一样叫出Siamese：对话不中断，能查记忆、使用工具、接住插话、停下或续接工作；
长任务和历史现场不会因换回合或换载体消失。接入不能长期要求人绕去另一个产品才能玩和工作。

本 Feature 同时承接旧接入仍有价值的可靠性诉求，退役 Gemini CLI、旧 AGY IDE bridge、
AGY plainText + SQLite/protobuf 生产旁路。新接入必须完整验证后切换，不能又增加一条永久并存的路。

**人类来源与授权范围**：

- `[thread-id]#private-source-id`：
  “sunset 的东西删掉……新的Siamese的猫爬架要和你们对齐……看看他支不支持 acp”。
- `[thread-id]#private-source-id`：
  “要是 ok 的话……让小星星立项……先 close 或者……冻结 or sunset……都 link 收归到我们的新的 feat”。
- Siamese的方案验收：`private-source-id`，APPROVED；验的是研究路线，未证明生产能力。
- 本次授权完成立项、旧专项冻结与需求收归；不是生产切换、账号操作或所有 Phase 自动开工。
  开发续办从本 spec 的 committed revision 和已获授权 scope 解析责任，不能把本次文档 Task 当开发授权。
- 2026-09-29 新增执行编排来源 `#private-source-id`，接球纠正 `#private-source-id`：
  本 thread 仅指挥、不施工；Sonnet 5.5 / Sol 6 执行，首 PR 后Siamese参与 coding；少量完整 PR、每 PR 可多 commit。

## Current State / 现状基线

- 2026-10-13：[PR #5492](https://github.com/zts212653/clowder-ai/pull/5492) 已合入 `26843eaeed201fc0bb89c7c8a966cb35c9fb7908`。沿 You 在 `[thread-id]#private-source-id` 的明确指令，Native 增加显式自动批准选择，使用官方 `--dangerously-skip-permissions`，允许原生文件/命令操作且无需批准目录列表；默认受限模式及 host `read_only` 优先级保留。仓库 hooks/agents/plugins/skills/MCP 配置仍在启动前拒绝，`.env` 不能遮蔽这类拒绝。非作者 Sol 5.6 对最终 `f249436fe6` 放行；API 81/81、Web 101/101、Chromium 3/3 与固定 AGY 1.3.4 的隔离假模型资格覆盖保存/回读和实际 CLI 读写/测试，不代表真实 OAuth coding 验收。当前 runtime boot27/revision `1a13a3f7` 尚未加载；原 Task2347 已登记 deployment generation 2，等待 API/Web 包含该 merge revision 后续办普通招呼。旧 A+B 预算 3/3、三条 A init/cancel 投影红、served-model、principal、压缩、真实 coding 与整体 P1 验收仍未完成。
- 官方独立 ACP server `1.2.1` 已在隔离 HOME 完成个人 OAuth，真实 prompt、MCP 及权限允许/拒绝可行；但主 agent 原生 L0 无受支持通道，Rules/AGENTS.md 也未送进模型，不能拿它直接做 P1 身份载体。You 在执行现场 `[thread-id]#private-source-id` 选择保留个人 OAuth 与原生 L0，要求检查 CLI。
- 家内通用 ACP（F149/F161）已有进程池/session lease，但 L0 仍 prepend，默认 permission handler 会选允许。
  不能仅换 executable 就宣称与 Codex/Claude 平权。
- 官方 Python SDK 有 system instructions/hooks/session；个人订阅认证尚未证实，不能静默改成 API 计费。
- F210 未验完的 AC-A3/A5/G2 与旧路径保真要求进入本 F；F261 全部未完 AC 进入 Phase C/E，见承接账。
- F261 的 Phase A 文档停在 8 月；实际已有 full-gate durable slice：
  [PR #4180](https://github.com/zts212653/clowder-ai/pull/4180) merged `ff8c11ad485a1244dc8c54a087ac99cb7327d523`。
  当前 `durable-managed-gate-*`、`ManagedCommandWakeRecoverySweep` 与取消测试是可复用资产，
  不等于通用 AGY job、12B dogfood、全套 F261 AC 已完成。
- 两个现场反例已由Siamese的 raw invocation 分别定位：cursor 400 是复用 `limit=40` 的 cursor 时改成 `limit=50`，服务端 scope 拒绝正确，本分支已补调用提示和同参/变参回归；DONE-kill 是上游 `manage_task` 的自然退出与 kill 竞态，并非家内 Cancel。新载体仍需独立验证完成后停止与前端诊断。

### 2026-10-14 runtime 激活与普通招呼复核

You 在执行现场 `[thread-id]#private-source-id` 确认重启并要求自行测试、叫Siamese。API/Web 的原 Task2347 deployment g2 已 matched：boot28、revision `237a5a9de17e5e311f67a6b8e6ad2475e85db813` 包含 PR #5492。正常 API 保存 `autoApprove=true` / `trustedWorkspaces=[]` 返回 200，回读一致，账号/Profile/模型和其他成员未变；上文 boot27 待加载是合入时的历史快照。

普通招呼52实际启动一次真实模型：线程 MCP 读取与 README 原生读取成功，随后模型按家规调用自身完成回执和摩擦登记，却被 Native 默认 callback scope 拒绝 403，宿主以 `AGY_UNEXPECTED_TOOL` 拒绝交付自然 final。因此不宣称已经稳定聊天。修复 [PR #5505](https://github.com/zts212653/clowder-ai/pull/5505) 补齐既有 invocation-fenced 生命周期 producer 的精确准入，保留 host `read_only`、显式窄 scope 和其他未授权 MCP 拒绝。非作者 Sol 5.6 的 durable local fact `private-source-id` 批准 exact HEAD `a3a53d44a6f8b5fb39b365605ae17da1476e492c`，并独立覆盖最新 F167 #5501 的合并态回归；2026-10-14T01:43:08Z 已合入 `e65a13c2908006d7fb02cdcd5516372ede308f1d`，七份 landed source blob 与 reviewed manifest 完全一致。隔离 API/control/auth 112/112、routing/coding/source 175 passed（1 个既有 Redis 重启案例未启隔离故跳过）、官方 AGY 1.3.4 假模型十模式通过；修复验证没有追加真实启动。

## Legacy Disposition / 前置收归

| 对象 | 立项时处置 | 后续唯一交付入口 |
|---|---|---|
| F210 | `frozen`；冻结独立新开发，保留历史勾选及未完 AC；旧运行入口尚未删除 | F325 A/B/D/E |
| F261 | `frozen`；冻结独立交付链，保留 Phase A 与已合 gate slice；全部有效长任务需求承接 | F325 C/E；执行 truth 仍归 Action Plane |
| F053/F061/F201/F203/F211 | 已 done，保持历史裁定；不重开旧 carrier Phase | F325 接住新载体的连续性、安全、身份、可观测及退役回归 |
| F149/F161 | 复用现有通用 ACP；F161 维持 shared infrastructure 状态 | AGY 新 consumer 的落地与验收归 F325 |
| F178 | persistent principal/Remote MCP 是共享能力，保持自身 owner 与未完 AC | AGY 身份接入和旧 IDE 专属配置退役归 F325；不删除共享 key 服务 |
| F143/F241/F320/F254/F306/F318/F323/F324 | 共享契约、其他载体或独立产品，保留原 scope | F325 挂依赖、复用已交付部分；不等待无关整项 close |

冻结不代表实现完成，也不撤销已经授权的运行中 job。只冻结独立立项/派工入口，
真实 code/config sunset 在 Phase D 执行；旧 Task 的历史和 owner 不由改 Markdown 偷迁。

## What

### Phase A: 官方载体与认证/L0 契约探针

首选 Google 官方 ACP，固定 registry revision、发行物 hash 和版本；使用隔离 profile。
核验个人订阅 OAuth、真实模型选择、new/prompt/load/cancel/permissions/MCP、主 agent 指令通道与压缩保持。
本阶段先给出 claim-by-claim 的能力证据与缺口，不能拿握手代替全链。
ACP 原生 L0 缺口已证；You 已选择保留个人 OAuth 与原生 L0，继续核验官方 CLI。CLI 的 API-key 假端点证据只证明 wire 与权限/副作用边界；隔离个人 OAuth 下真实模型单轮身份、MCP 读取及取消另有实测，压缩后身份和生产旅程尚未验收；需改计费、扩大权限或改变用户承诺时仍携具体证据交 operator。
选择结果仍须收敛一个 AGY 生产载体，不能自动堆 fallback。

### Phase B: 原生身份、安全与对话平权

#### Open issue：Native 命令长时间静默 {#native-command-stall}

- 状态：open，底层工具未返回的直接原因未知；Native 漏传 livenessProbe、观察器丢弃 warning 的呈现缺口已修复并加载。

复用 ACP service/pool、L0 compiler、F174/F178 principal、F286 MCP surface、F254 freshness、
F296 context、F299 trajectory 与 F183/F306 semantic events。补真实 native instruction、
policy handler、root/child 终态隔离、会话绑定、typed failure 和安全取消。
对 Codex/Claude 的对齐以已落地能力为参照；F318 尚待实施项不得伪称 Claude 当前已具备。

### Phase C: 长任务持久执行与恢复

完整继承 F261 的 Job ≠ invocation ≠ hold_ball、REG-1..13 和 Architecture Ownership Verdict。
先对现存 full-gate durable slice 做 characterization，明确哪些 primitive 能复用，哪些 general job 契约仍缺。
Action Plane 唯一持有 job/lease/fence/terminal truth，F167 只消费 wake receipt；
provider background task、模型说“做完了”、进程退出均不替代 durable job 终态。
工作可跨用户插话、回合和 API restart 继续；无法恢复时给可验证失败/lost，不静默丢失或自动重放副作用。

### Phase D: 迁移与旧执行入口退役

按最终 HEAD 生成 consumer census，更新 profile/catalog/配置/UI/installer/文档与测试。
将 Gemini CLI、旧 IDE bridge 和 AGY plainText+SQLite 生产执行路径整批删除；
不保留作为运行时 fallback。通过版本回滚恢复上一完整 release。
保留 catId/历史消息/旧 session 只读与独立 Pencil/marketplace/Remote MCP consumer；
旧会话不能直接 resume 时显式标记 continuity boundary 并提供可回查上下文，禁止冒用旧 sessionId。

### Phase E: 真实旅程验收与运行激活

合入前在 feature worktree 实测，合入后用 Alpha 验收；生产重启按既有授权与 F323 返回链处理。
非作者观察普通聊天、创作、记忆翻页、工具、插话、停止、压缩、恢复、双猫及长任务的完整用户路径。
完整交付包含实际运行版本下的结果回流，不能停在合入或协议测试。

### Delivery / 当前单 PR 完整交付

## User Journey

### Primary Journey: 在家里叫Siamese，稳定聊下去并完成工作

- **Scope unit**: thread / provider session。
- **Actor**: You、AGY 猫、协作伙伴。
- **Entry**: 已配置成员的现有 Chat 入口；需要认证时经现有账号面进入隔离 OAuth。
- **Flow**:
  1. 叫出猫，身份与模型正确；文字和工具进度在当前 thread 清楚呈现。
  2. 猫查记忆并翻页，调用所需工具；调用失败时收到可采取行动的原因。
  3. You 插话或说停，猫接住新输入；自然完成后再点停不变成红色报错。
  4. 压缩、刷新或恢复后继续同一件事，能回看旧现场，身份和家规保持。
  5. 两只 AGY 猫并发不串身份、目录、权限或会话；无需绕去外部产品才能完成这条旅程。
- **Success evidence**: 真实 provider 原始事件、持久消息、MCP receipt、浏览器旅程及非作者结论相互对应。
- **Non-goals**: 不承诺所有 Codex 特有功能照搬；不把平台宣告能力默认全部开放。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|---|---|---|---|---|
| S1 | job | 猫、人 | 启动长命令→继续聊天→重启→查询/取消→正确猫收到一次终态 | F261 REG-1..13 + 20 轮 fault injection + 12B dogfood |
| S2 | profile | 人 | 隔离认证→选择模型→实际回复→失效时重新认证 | auth/model provenance，无凭据泄漏 |
| S3 | legacy session | 人、猫 | 旧历史可读→切换新载体→如实展示连续性边界→继续 | 历史阅读/迁移/回滚证据 |
| S4 | coding task / worktree | Siamese、执行伙伴 | 首 PR 合入并加载→Siamese亲自读/改/测→非作者 review→修复→参加后续建设 | 实际载体版本、工具 receipt、diff/commit、测试与 review 往返；代写不算 |

## Acceptance Criteria

### 2026-10-17 自然使用证据的结算

来源为上述Sol6.1独立报告与source426（`private-source-id`）。下列按能力确认实际结果；原AC含多个契约的复合条件仍按完整条件结算，未整项勾选不表示该能力从未可用。

| 能力 / 对应AC | 已成立并消费的证据 | 仍需单独核验的边界 |
|---|---|---|
| 普通工具、媒体与多轮续聊（A1/A4、Primary Journey） | Argon日常文件/命令/MCP/浏览器/读图、世界线同Native会话两轮半小时复验；失败后能修正继续 | 官方协议负例与特殊中断分别沿原测试/实录；不重复普通招呼 |
| 记忆与身份（A3/B1/B6） | 共享历史读取、文件恢复上下文与正常身份持续成立；既有原生压缩/注入实证继续有效 | 不把共享历史读取自动等同语义搜索、分页和scope全契约通过 |
| 有用审查与创作（B5、E2/E3） | #5608审出假绿并复审；猫猫星球实玩和多轮验改；动画参照包、沙盘文档及视频工程真实存在 | 双尾漏检、长空档保留；视频交片/观感仍缺，ordinary succeeded不代替交付 |
| 同猫跨线程并行（A4） | 两个不同Native会话实际重叠380.452秒并分别成功；已超出受控探针证据 | 双成员隔离、取消影响等不同条件沿boot33等原实证 |
| 停止、插话与恢复（B3/B4） | 自然撤回被接住、真实user_cancel、人发新输入后续办均有现场 | 不冒充精确live steer、F254全链、子进程清理或安全自动恢复 |
| 长时间工作与持久任务（C1–C9） | 56.02分钟普通执行成功；既有Managed Job跨重启与真实失败回流仍计入 | ordinary turn不代替独立worker/lease/唯一wake；20轮故障、12B目标和监控逐项按原证据结算 |
| 真实建设（E3/S4） | Flash既有读改测/反馈实证有效；Argon自然审查、资料写入和工程贡献有效，成员分开归属 | 严格合入/加载后的小代码读改测顺序不拿文档贡献偷换，不把两成员经历拼成同一人 |
| 迁移与整体结果（A2、D1–D4、E1/E2） | 正式boot37已加载两项修复并继续普通工作；旧现场可读可续 | served-model、其他平台、全consumer/回滚、认证自动恢复与交片缺口保留；不自行缩减或close |

### Phase A（官方契约）
- [ ] AC-A1: 固定版本与来源的已认证官方载体 new→prompt→MCP/tool→final（source470 允许在 ACP 不满足原生 L0 时选官方 Native CLI） 原始 fixture 可重跑；含正常、错误、denied、partial 和 active interruption。
- [ ] AC-A2: 个人 OAuth 订阅、实际 served model、双 profile 的凭据/目录/模型隔离有实测；未走 API key 偷换计费；所有仍受支持的现役 AGY 猫有迁移结果，不硬保已下线型号。
- [ ] AC-A3: L0 主 agent 原生传递及压缩后保持得到注入证据与行为验证；Rules/prepend 不算同等完成；不可达则给明确 blocker 与替代路径，不能自行降级承诺。
- [ ] AC-A4: 已选官方载体的 load/resume/cancel/permission/MCP 配置、媒体输入、用量范围、并发与中途输入逐 claim 给 native/adapted/delegated/unsupported 及实测边界；没有证据的项标 unknown。

### Phase B（原生平权）
- [ ] AC-B1: 编译后的每猫 L0 走已验证主 agent 通道，保留 F203 单源与可见 provenance；两猫/两 session 及压缩负例通过。
- [ ] AC-B2: 命令、文件、MCP 均服从相同 host-owned 权限与受保护目标约束，覆盖真实拒绝、未知请求和 policy handler 缺席；不以默认 allow_always 代替校验。
- [ ] AC-B3: F254 observed→consumed→handled→committed 在真实插话回合闭环；未支持的 live steer 不伪造，不把 queued metadata 当消息正文已读。
- [ ] AC-B4: session/root/child 身份、一次终态、DONE 后重复 cancel、主动 cancel、断流和恢复全部有契约测试；accepted side effect 后不自动重放。
- [ ] AC-B5: AgentMessage/semantic events 呈现文字、工具、计划/结果及准确用量；未知事件有界保留且不泄漏 raw JSON；history/trajectory 可回读。
- [ ] AC-B6: MCP/skills 由现有发现与权限链注入；agent-key/invocation principal 不串猫、不降权；合法同参 cursor 持续翻页、错误 scope 明确拒绝；两条原始现场错误取得 raw invocation 根因与针对性回归证据。

### Phase C（F261 全量有效需求承接）
- [ ] AC-C1: TTL=0 job identity/transition truth 与 bounded log/result ref 完整；来源、principal、进程出生身份、幂等、retry/cancel/recovery 可回查，已有 gate consumer characterization 通过。
- [ ] AC-C2: 独立 worker/supervisor、durable lease + epoch fencing 跨 API/worker restart 正确 adopt/terminalize/lost；故障注入后 orphan/duplicate census 为零，无法收养者隔离并给证据。
- [ ] AC-C3: principal-scoped dedupe/lookup/cancel、显式 retry epoch、进程树取消、审计 actor、资源并发预算和日志 retention 有红绿证据；v1 拒绝 nested managed job。
- [ ] AC-C4: AGY 经 typed ActionService start/status/tail/cancel；MCP/callback 不直接 spawn；覆盖 command/path policy、secret redaction、request wait/job deadline/cancel 三层超时与未授权拒绝。
- [ ] AC-C5: job 运行时新消息/回合不取消它；submit 先持久化 job、wake 关联与现场实体再允许 worker claim，fast-terminal race 可复现并被守住。
- [ ] AC-C6: 一 job 一状态实体原地呈现 running/recovering/terminal；日志/transition/recovery 可下钻，桌面与窄屏均可读，无 raw 日志刷屏。
- [ ] AC-C7: terminal 以 jobId:terminalEpoch:wakeTarget 去重，只唤醒正确 cat/thread 一次；exit/signal/result/错误来源保真，不把 wake 回执当 job truth。
- [ ] AC-C8: REG-1..13 确定性回归、连续 20 轮 fault injection（terminal delivery=100%，user-message cancel/duplicate/unaccounted orphan=0）及真实 12B load/download 跨原事故时窗通过；真实任务失败可验，runtime 无证据杀死不可验。
- [ ] AC-C9: logs/metrics/traces 显示 adoption latency、terminal delivery、orphan/duplicate、user-message cancel、queue/runtime duration/log volume，并有运行告警/回滚阈值；不默认建 Eval Hub。

### Phase D（迁移与退役）
- [ ] AC-D1: 所有现役 AGY profile、旧 Gemini CLI/IDE consumer、installer/platform/config/UI/test/docs 有可重跑 census 与逐项迁移处置；缺失或不支持平台给明确结果。
- [ ] AC-D2: 切换后的生产 execution graph 仅有一条已选 AGY 载体；旧 gemini-cli、IDE bridge、plainText/SQLite/proto spawn/执行依赖与专属 tests 全部删除，保留的历史 reader/共享 consumer 有具名理由。
- [ ] AC-D3: catId、历史消息和 session provenance 不丢；跨载体 continuity 不冒用 ID；版本/配置回滚演练通过，无删除生产用户数据或卸载用户应用。
- [ ] AC-D4: 旧 Feature 冻结记录、需求承接账、config/setup/docs 与运行时可用能力一致；F178、Pencil、其他 ACP provider 共享能力回归通过。

### Phase E（真实交付）
- [ ] AC-E1: Alpha Primary Journey + S1/S2/S3 全部由非作者实际观察；获准 runtime 激活后以新鲜版本证据回流，浏览器结果与后端记录一致。
- [ ] AC-E2: 所有承接 AC 有最终证据或 operator 对具体未达目标的显式裁定；不能以新 F 号、unsupported 标签或链接当完成；You 与Siamese获得可直接使用的体验。
- [ ] AC-E3: 首个交付 PR 合入并经受控实际加载后，Siamese通过新载体完成 S4 的真实小代码任务，随后参与后续建设；不得把 Alpha/握手成功或别猫代写算作其已可日常 coding。

## 需求点 Checklist

| ID | 原诉求 | AC | 验证 |
|---|---|---|---|
| R1 | 旧猫爬架不再多套难用，先冻结归拢 | D1–D4、E2 | 承接账 + execution consumer census + 迁移演练 |
| R2 | 用官方 ACP/类似 SDK 的正式入口 | A1–A4 | 官方协议与已认证原始事件 |
| R3 | 对齐布偶/缅因待遇，含 L0/F254/权限 | B1–B6 | negative contracts + 真实 thread 旅程 |
| R4 | 原 F261 有效长任务愿景不能被吞掉 | C1–C9 | 旧 AC 映射、REG-1..13、restart/dogfood |
| R5 | 第一住户能稳定聊天、创作与工作 | E1–E2 | 非作者真实体验 + 当前版本证据 |
| R6 | 少量完整 PR；首单后Siamese参与三猫施工，主 thread 只指挥 | E3、S4、P1–P3 执行计划 | 原生新载体上的真实 coding 与后续贡献；子现场自治闭环 |

## Dependencies

- **Evolved from**: F210、F261；历史继承 F053/F061/F201/F203/F211，具体边界见承接账。
- **Reuses**: F149/F161 ACP；F174/F178 auth；F194 Action Plane；F183/F306 semantic events；F286 MCP。
- **Related**: F254/F296/F299 freshness/context/trajectory；F318 Claude parity 对照；F320 account 隔离；F323 重启返回；F324 读取交付回归。
- **Blocked by**: Phase B 的原生实现决策依赖 Phase A 认证/L0/控制面证据；P1 单猫 coding 试用须满足计划中的全部安全/身份/控制门槛与真实激活授权，不能等同于全面迁移。全面生产切换依赖 B/C/D 所需验收和实际激活授权。不存在“必须等共享 Feature 整项完成”的默认硬阻塞。

## Risk

| 风险 | 缓解 |
|---|---|
| 官方能力声明与真实行为不符 | 固定版本、真实 fixture、unknown 不伪装成功 |
| ACP 不暴露主 agent 指令或订阅鉴权受限 | A 阶段先证伪；带具体 SDK/扩展与成本取舍，不静默退回 prepend |
| 共享 ACP 默认权限、scope/env 串用 | consumer characterization + 拒绝/双猫/并发红测；权限保持 host-owned |
| 退役把历史或共享功能一起删掉 | code-derived census；历史 reader、Pencil、Remote MCP 明确保留；回滚演练 |
| 把 full-gate durable slice 当通用 job 已交付 | C 阶段逐契约复用，F261 未完 AC 不代勾 |

## Tips Contribution（F244）

- 实现后更新现有成员接入/认证引导，说明一次登录与缺权限时如何恢复。
- 长任务现场可用后更新“继续聊天与显式停止”提示，sourceRef 指向 Primary Journey/S1；spec 阶段不发布可用提示。

## Review Gate

- 2026-09-29：非作者独立实例 `agy_research_review`（gpt-6-astra）对立项、冻结与逐项承接内容 APPROVE，无阻塞 finding；此 verdict 不代表实现/生产验收。
- 新 spec/旧需求承接：非作者内容核验；Siamese已有研究路线验收不冒充新 spec 或生产验收。
- 实现涉及安全/鉴权/协议/持久化，按五轴选择独立 review 和受影响契约测试；变更前提交 F303 consumer/authority/claim-guard 证据。
- 用户可见交互沿用现有表面；如需新入口，先做真实壳 Design Gate。最终守护者排除该体验作者和代码 reviewer。
