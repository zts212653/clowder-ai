---
feature_ids: [F325]
tips_exempt: "PR1 is merged; native coding and its Task-bound test tool require explicit carrier selection and an operator-issued live Task grant. Native authentication, parity and migration still require actual production acceptance before capability tips advertise the entry; the accepted spec and legacy consolidation do not establish a generally available job action."
related_features: [F053, F061, F143, F149, F161, F174, F178, F194, F201, F203, F210, F211, F241, F254, F261, F286, F296, F299, F306, F318, F320, F323, F324]
topics: [antigravity, acp, native-carrier, parity, migration, managed-job]
doc_kind: spec
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/features/F325-antigravity-native-parity.md"
mcp_admission_claims:
  - ref: "file:docs/features/F325-antigravity-native-parity.md"
    toolName: cat_cafe_run_task_test
    resourceFamily: task-workflow
    boundaryKind: side-effect-boundary
    decision: accepted
created: 2026-09-29
description: "让暹罗与其他 AGY 猫在家里稳定对话、持续工作和恢复现场，统一原生接入、身份、安全与长任务体验，并退役旧执行载体。"
description_source: human
description_author: codex-astra
description_updated_at: 2026-09-29T06:01:16Z
---

# F325: Antigravity Native Parity｜Siamese的新猫爬架与旧接入收归

> **Status**: spec | **Owner**: 小星星·Maine Coon (@codex-astra, gpt-6-astra) | **Priority**: P1

Architecture cell: `identity-session`, `transport`, `callback-auth`, `bubble-pipeline`, `action-plane`, `mcp-surface-governance`, `dispatch`

Map delta: update required — P1 在现有 identity/session、callback auth、MCP surface 和 Action Plane 边界加入 AGY native consumer。TaskStore 仍是批准任务的真相源；单次测试的短寿命进程由 host-owned MCP guardian 拥有，P1 不新增持久 job 真相。P2 的通用 job/lease/fence 仍归 Action Plane。

Why: F325 是 AGY 用户旅程的唯一交付入口，复用已有运行时、鉴权、MCP、任务与呈现 owner；不建立第四套会话/审批/任务真相源。

Canonical source: `packages/api/src/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.ts`（原生 L0/会话/通知）、`agy-native-coding-grant.ts` + `invoke-single-cat.ts`（Task 来源）、`packages/api/src/domains/cats/services/agents/invocation/tool-execution-policy.ts` + `packages/api/src/routes/callback-native-test-grant.ts`（server 侧 route scope）、`packages/mcp-server/src/tools/native-task-test-tool.ts`（MCP 语义）与 `native-task-test-runner.ts` + `native-task-test-guardian.ts`（短测试进程）。

原生 L0 沿既有 `l0-compiler.ts` 按 catId 与 callback owner 编译，由 Service 写入主 agent 原生槽；用户 prepend、resume fallback 与 F129 动态 pack 不作为该槽的替代来源。`invoke-single-cat.test.js` 的普通 Chat 路由回归覆盖无 prepend 首轮、续轮绑定及动态 pack 隔离；编译失败继续在模型启动前拒绝。

`queue-receipt.ts` 持有唯一的 provider/carrier/delivery 常量与派生类型；API `queued-message-custody.ts`、前端 `queue-message-receipt-normalizer.ts` 与 `message-disposition-presentation.ts` 消费同一列表，包含 `google / agy_stream_json`。`f254-queued-message-custody-store.test.js`、`queue-message-receipt-normalizer.test.ts` 与 `message-disposition-presentation.test.ts` 守序列化及前端读取、未知值拒绝、AGY 仍不支持精确本轮读取；`message-receipt-dock.test.tsx` 与 `issue1371-settling.test.mjs` 的 AGY fixture 守归一化后该猫回执行不消失。浏览器覆盖策略把这些输入选择到该现有旅程；这些测试不替代真实 Chat/OAuth 浏览器验收。

P1 验证期间，`scripts/pre-merge-check.sh` 从冻结的 main 与本地发布分支 tracking ref 判定同步方式：已含 main 时不重放；发布 tip 是本地 HEAD 的祖先、且尚未进入 main 时普通 merge main，保留已发布历史与合并解冲突；缺少 tracking ref、已与它分叉或发布 tip 已进入 main 时沿用 rebase。tracking ref 是本地已知发布证据，不声明远端状态实时完整。祖先/对象核验错误或 merge 冲突在后续门禁前停止，HEAD 变化后仍重启当前树的门禁。`scripts/pre-merge-check.test.mjs` 的真实 Git 回归守「发布后 main 前进」的 add/add 解冲突与两侧祖先保留；同文件守失败不重放、rebase 路径及重启顺序。

Consumer evidence: `rg -n 'resolveAgyNativeCodingGrant|callbackPolicyForAgyNativeMcpTools|native-test-grant|cat_cafe_run_task_test|runSandboxedNativeTaskTest|freshnessCarrierCapability' packages/api/src packages/mcp-server/src packages/shared/src` 可复查 host、回调、MCP 与配置消费者；`scripts/lib/browser-impact-policy.json` 对新输入声明浏览器烟测，不能代替真实 Chat。

Claim guard: `agy-native-coding-grant.test.js` / `invoke-single-cat.test.js` 守 live Task、结束后降只读与错绑拒绝；`agy-native-callback-scope.test.js` / `callback-native-test-grant.test.js` 守 server 侧 route；`native-task-test-runner.test.js` / `native-task-test-guardian-startup.test.js` 守沙箱、父死清理、启动前取消和越权信号；`agy-native-mcp-config.test.js` 守 OAuth 首次登录的零字节占位与非空畸形配置拒绝；固定 CLI 的 `f325-agy-native-mcp-wire.mjs test|test-fail|test-cancel|freshness` 守脚本化模型接线；`agy-native-agent-service.test.js` / `agy-native-turn.test.js` 守通知与一次终态。`f325-agy-native-oauth-wire.mjs read|cancel` 是操作员复跑的隔离个人 OAuth 真模型证据，非自动测试。真实压缩后身份、生产 F254、Alpha 与受控加载仍是独立准入门。

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

### Delivery Batches / 三单施工

P1 把官方契约探针、安全接入与真实 coding 一起交；P2 三猫使用新载体补齐平权与持久长任务；
P3 全面迁移、删旧入口与终态验收。首单不能只交 adapter、等最后才让Siamese入住。
早期仅单猫受控试用，全成员 production cutover 仍需最终相应验收；不以一个 PR 代表全部 Phase 完成。

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

### Phase A（官方契约）
- [ ] AC-A1: 固定版本与来源的已认证 ACP new→prompt→MCP/tool→final 原始 fixture 可重跑；含正常、错误、denied、partial 和 active interruption。
- [ ] AC-A2: 个人 OAuth 订阅、实际 served model、双 profile 的凭据/目录/模型隔离有实测；未走 API key 偷换计费；所有仍受支持的现役 AGY 猫有迁移结果，不硬保已下线型号。
- [ ] AC-A3: L0 主 agent 原生传递及压缩后保持得到注入证据与行为验证；Rules/prepend 不算同等完成；不可达则给明确 blocker 与替代路径，不能自行降级承诺。
- [ ] AC-A4: ACP load/resume/cancel/permission/MCP 配置、媒体输入、用量范围、并发与中途输入逐 claim 给 native/adapted/delegated/unsupported 及实测边界；没有证据的项标 unknown。

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
