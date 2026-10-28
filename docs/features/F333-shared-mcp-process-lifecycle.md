---
feature_ids: [F333]
related_features: [F043, F145, F149, F153, F161, F174, F178, F202, F213, F249, F254, F286, F292, F300, F306, F325]
related_decisions: [ADR-039, ADR-044]
topics: [mcp, process-lifecycle, host-capacity, invocation-context, streamable-http, resource-reclamation]
doc_kind: spec
created: 2026-10-25
updated: 2026-10-28
description: "让多只猫并行工作时复用 MCP 的重复运行开销，保留每次调用的身份、权限、工作区和故障隔离，并用完整资源账证明收益。"
description_source: model
description_author: codex-astra
description_updated_at: 2026-10-26T04:44:27Z
tips_exempt: "2026-10-28 验收：本切面撤除 MCP 外层代理并迁移受管旧配置，仍使用现有聊天、工具与配置入口，没有新增需要用户学习的操作；线上撤层已验，OpenCode 暂缓与 Phase B 全量目标不计已交付。"
---

# F333: Shared MCP Process Lifecycle｜多猫共用 MCP 运行资源

> **Status**: in-progress | **Owner**: 小星星·Maine Coon (@codex-astra, gpt-6-astra；整体与验收)；实现：Sol6.1；审核：Sonnet | **Priority**: P1
>
> **立项授权**：You 于 2026-10-25 PDT（10-26 UTC）要求：「怎么样？你看看？Siamese说的有什么有道理的？然后你直接立项一下？」来源 `[thread-id]#private-source-id`。
>
>
> **交付约束（2026-10-25 PDT / 10-26 UTC）**：You 在 `#private-source-id` 要求少 Phase、先查复用，并明确「别一个 phase 一堆 PR，每个都是半成品，一个 PR 得是一个完整的东西」。据此收为两个 Phase；原盘点与试点移入第一笔完整交付的内部工作，不丢弃任何原验收要求。

## 当前撤除交付范围（operator 948；Phase A 已部署并验收）

**拆除 MCP 外面的保护代理层**，不是聚合该层或改名保留：

- `guardMcpConfig` 及全部 provider/ACP/OpenCode 消费接点不再把 command 或 URL 改写为
  `node secret-mcp-proxy.js`。自家共享 HTTP 由原生 header/私有配置/RPC 带本轮身份；第三方
  stdio/HTTP 直接连接原 server。每宿主该层代理进程为零，不新造常驻桥或通用代理平台。
- 保留不常驻进程的 git pre-push、`gh`、`curl` 外发检查。自家结果可复用 API 现有脱敏；
  不为补全旧代理的逐条检查能力再拖延撤除。第三方 MCP 外发不再逐条检查，代价已在源线程说明。
  工具权限、callback 身份/撤销仍属于原执行契约，不能将外部 MCP 配置当作回调授权。
- 一个 PR 交齐 Claude/Codex/AGY/Kimi/DSH 的当前使用路径、原工具名称/schema、原生会话续聊、
  旧轮隔离、旧同名 stdio 配置兼容、取消/回收与必要回滚。仅证明已撤代理存在的测试和启动参数一并删除。
- **资源验收撤掉 25%**：线上真实负载拆前、拆后各测进程数与内存，记录加载版本、活动负载和
  实际正常调用；工具能用且该层代理不再生成。原固定百分比及三臂确认政策只留历史，不能继续作阻塞。
- 原 Sol6.1 工位/线程/Task 继续，Sonnet 审最终实现，Astra 验收；不另起项目，不再向 operator 询问方向。
  第三方保护代理撤除在本 PR；第三方 backend 是否共享仍属 B，不混同。

授权原文已回读：`[thread-id]#private-source-id`。
此前 operator 702 明确允许自行删减冗余关卡；Opus 949 向 You 说明上述具体范围和第三方逐条检查取消的代价。
原作者执行通知：`[thread-id]#private-source-id`。
本节覆盖此前 935 的六合一、952 的第三方代理保留和所有历史 25% 要求；历史测量原件不删、不改判。

### Codex 旧项目配置的迁移处置（Astra，2026-10-27）

作者在原线程 `#private-source-id` 提供真实反例：项目旧 stdio 表与
原生 HTTP 配置深合并，保留的 `command` 使原生启动拒绝；null、空字段与 profile 覆盖均未解决。
Astra 独立回读当前 `.codex/config.toml`：SHA-256 为
`a56cd8fe4dec7de4e715ca912d857d2afb820f241d576d0d1b365e1dfe34d1bf`，六组自家项均指向本仓
`packages/mcp-server/dist/{collab,memory,signals,limb,audio,finance}.js`，另有三个第三方项，文件不在 Git 跟踪树。
[F213 当前生命周期说明](F213-stale-mcp-config-cleanup.md)和现行 `CliConfigPaths` /
`reconcileMcpRuntimeConfig` 均确认：Codex 静态 writer 已退休，受管入口由每轮配置注入负责。

**处置**：同一撤除 PR 沿 canonical 配置 owner 迁移能证明安装归属的六项，Host 保留六个原名字并注入
HTTP。不以“脱离 Host 的原生 CLI 必须继续默认自动加载六组”为本次阻塞条件；保留可用的显式 stdio
接法和原条目回退。这个范围判断由 Astra 承担，依据当前受管使用契约和已退休 writer；不是 operator 对独立
CLI 的单独新指令，也不声称已证明所有私人 CLI 都无人使用。

迁移只匹配名称与真实受管入口，保留第三方、同名非自家项及其他用户字段，不写账户配置；原六项包括
现存 env 的回退内容必须保留。六组服务本身未退休，不加入全局 deprecated 名单。配置迁移与 HTTP
接线一起交付；feature/Alpha 不因读取共享目录而提前改现役文件，沿已有配置发布 owner 边界在正常部署
切换时执行并回读验证。验收覆盖已有深合并反例变绿、同原生会话续接、第三方保留与显式 stdio 回退。

已路由原作者：`[thread-id]#private-source-id`。

## Why

猫多起来时，重复启动的 MCP 服务挤占正常工作需要的内存与进程资源。You 应能让多只猫同时查资料、写代码和协作，不必为重复服务手动清场；减少资源占用也不能使工具缺失、身份串号或把一个故障扩散给全家。

原委托要求先判断价值与归属、提出做法并找队友 review。Astra 的 v2 经 Sol 6.1 独立复审通过；Argon 随后补充现行 member gateway、路径上下文和入口合并视角。立项采纳成立的证据，保留需要实测的未知。

## Current State / 立项时的现状基线（历史，当前范围以上节为准）

源码核验基线：`4f325b16e122ecf23be1d14e3fa15540efa347c7`，2026-10-25 PDT。源码存在不代表当前 runtime 已加载；本轮没有运行并发资源基线或操作生产服务。

| 证据 | 已核实事实 | 适用边界 |
|---|---|---|
| 原提案的 10-22 快照 | 作者估算自家 MCP 123 个 / 10.7G，第三方 221 个 / 6.3G，浏览器类 34 个 / 1.4G，总计 378 个 / 18.4G | 原始分类脚本未入仓，尚未复现；不能用不同口径 RSS 直接比较，也不能据此证明 123 个都属于活跃会话 |
| `packages/mcp-server/src/member-gateway.ts`、`packages/api/src/routes/member-mcp.ts` | 已有 `/api/member-mcp/mcp`、无持久 session 的 JSON 响应、逐请求 invocation 验证、按能力选择 families、ALS 上下文和请求收尾 `server.close()` | 现行路由服务 ACP/iCode，resolver 读取 ACP whitelist；尚不是所有载体的通用接入或跨工位授权证明 |
| `git log --diff-filter=A -- packages/mcp-server/src/member-gateway.ts` | 文件由 `ca015e05c2`（#6009，2026-10-23 PDT）合入 | 是 10-22 方案评审之后的新基线；必须复用，不能继续按“家里只有 remote-spike”设计 |
| `tools/invocation-auth.ts`、`tools/evidence-tools.ts`、`tools/signals-tools.ts` | 已有 scoped API/cat/user/thread 与 `resolveInvocationEnv`；部分旧 env 读取已迁移 | scope 缺字段仍可回退 ambient env；没有 roots/dataDir/workspace/profile 的完整请求投影，shared 模式不能依赖这些默认值 |
| `utils/path-validator.ts#getDefaultConfig`、`co-creator-presentation.ts#readCurrentPresentation` | 路径/data-root/desktop mode 和展示 API 地址仍读取进程环境 | 请求上下文盘点要覆盖本地只读工具、图片发布、展示与缓存，不能只修 callback token |
| `mcp-launch-contract.ts`、`provider-mcp-config.ts`、`agy-native-mcp-config.ts` | 有六个自家 split 入口；实际为解析后启用的 server 集合分别生成启动配置，AGY Native 也走此链 | 不是所有猫无条件启动六个。HTTP→serverUrl 映射不证明动态凭证刷新/原 turn 绑定已支持 |
| `secret-mcp-config.ts#guardMcpConfig` 与 provider 配置末端 | 现行配置还会装饰秘密外发保护代理 | census 必须计入代理和实际子进程树；复用/合并不得绕过现有秘密保护 |
| F254 warm host pool、F149/F161 ACP pool | 已有宿主复用、lease、凭证文件与回收经验 | Codex 每 host 一个活跃调用；不能把共享宿主直接等同于跨猫共享 MCP |

### Argon 意见的采纳与修正

1. **采纳复用 member gateway**：沿同一 handler、canonical registry 和 callback 权威演进。是否移入独立受管 worker，由故障范围和资源测量决定；不能复制第二套 HTTP 协议栈，也不能将搬出 API 的成本视为零。
2. **采纳请求级目录/展示上下文盘点**：投影已有 Host 授权，而不是引入新的 workspace path jail；合法的跨目录工作和跨线程协作仍按原权限允许。共享进程不能把不同授权合成并集。
3. **采纳 CPU/延迟测量，暂不预做 schema cache**：每请求建 server 和注册 toolset 是真实路径，但“它已是瓶颈”尚未测到。`close()` 也不能单独证明没有泄漏。若需要缓存，只共享不含请求身份/可变权限的派生定义，键覆盖版本与策略，设置上界，并验证动态展示、撤销和禁用不会串用旧值。
4. **将六合一作为比较方案**：同一载体内合并启用的自家入口，与跨载体共享服务是两个独立维度。六个全部启用且无新增代理时，6→1 的进程理论降幅为 5/6；不是整机内存或全部 MCP 的 83%。单 shim 不作为未验证的硬约束。
5. **AGY Native 纳入首笔自家交付**：内部先用 Claude + Codex 验证最危险的原 turn 绑定，正式 Phase A 同时覆盖 AGY Native 与盘点确认正在使用 MCP 的其他载体；没有 MCP 消费的变体以证据记不适用，不能把尚未接好的活跃载体悄悄移到未来。

### 复用清单与真正需要补的接缝（operator 1202）

| 要做的事 | 现有实现 | 本项增量与复用边界 |
|---|---|---|
| HTTP MCP 服务 | `member-gateway.ts#createMemberGatewayHandler`、`routes/member-mcp.ts`，已由 `api/src/index.ts` 挂载 | 扩展已有 handler/Host 注入点，不新造 MCP router。现有 API 挂载是可比较基线；若故障域/负载证据要求独立 worker，同一实现迁入受管部署，不能交第二套协议实现 |
| 六类工具与权限过滤 | `server-toolsets.ts` 的六个 registrar、canonical registry、`ToolsetEnv.allowedToolNames` | 共用原 tool definitions、schema、callback handler 和秘密检测；不每个 family 重写服务，也不先造 schema cache |
| 调用身份与撤销 | `InvocationRegistry`、callback prehandler、`tool-execution-policy.ts`、`withInvocationCredentials` | 补 Host launch/connection 与 exact turn、workspace/data roots 的受限投影；不新增凭证数据库或复制领域授权 |
| 配置与能力开关 | `resolveProviderMcpConfigResolution`、`readInvocationMcpConfig`、`resolveServersForCat`、ACP materializer、AGY Native config | 保持单一配置解析，补 transport 投影和完整切换；不能为 Claude/Codex/AGY 各建一套 registry。ACP 的 whitelist 不可直接代替其他载体的权限来源 |
| 必需的 stdio→HTTP 桥与秘密保护 | `secret-mcp-proxy.ts#startSecretMcpProxy` 已接两端 transport；`SecretRemoteTransport` 已消费 HTTP/SSE；`guardMcpConfig` 已装配 | 优先扩展现有代理的 Host 绑定与每请求认证，不另加一层常驻 Node bridge。现有 remote headers 在构造时固定，**尚不能证明**轮转/迟到请求正确；必须在同一 PR 补齐并验证，不能把“有桥”写成“已适用” |
| 凭证文件 | `session-credential-file.ts`、`agy-native-credential-file.ts` | 复用原 owner 的文件写入/撤销；session refresh 文件与 AGY 单 turn 文件生命周期不同，不能强并成读取 latest 凭证的通用文件 |
| 进程归属、关停与部署 | `cli-process-ownership.ts`、`cli-supervisor.ts`、既有 Codex/ACP pool cleanup、deployment identity/daemon 管理 | 载体后代沿已有归属清理；共享 worker 必须属于部署，不能被某只猫的 cleanup 杀掉。`service-lifecycle.ts` 针对已声明服务脚本、插件 supervisor 针对插件 wire，均不是现成通用 MCP 池；需要的窄生命周期适配与可用接线一起交，不建设新通用 supervisor 平台 |
| 第三方权限与观测 | `NativeMcpLaunches.resolve` / plugin activation 与 grants，F153 telemetry、既有进程身份/健康工具 | 复用 package/授权/撤销及指标设施，只补本项 transport/resource 消费；进程分类与同口径内存测量仍需补，不伪称已有完整 census |

由此收敛的新增工作只有三类：**可信上下文投影、现有配置/代理接入同一网关、该路径的资源回收与实测**。第三方再补各自必要的会话与激活接点；并非为每个组件建设一套底座。

## What

### Phase A: 自家共享可用与撤除全部 MCP 外层保护代理（一笔完整交付）

**交付结果**：家里现役载体调用自己已启用的自家 MCP，完整使用路径改用已验证的共享运行资源；正常工具、并发和权限保留，恢复/停止可用，闲置资源可回收，并有真实净收益证据。主验收至少包括 Claude、Codex、AGY Native；ACP/iCode、Gemini、Kimi、OpenCode 按现役 census 中实际消费路径逐项覆盖。OpenCode 本轮实际验收依 operator 1788 暂缓，适用范围见下方处置；其余载体要求不变。

以下是原实现的工作分解；当前撤除 PR 沿上节 operator 948 收口，原要求保留代理/固定资源百分比的部分已失效：

1. **先解决会推翻路线的未知**：保存可重跑 census，区分部署/版本/载体/family/权限域/活跃与闲置，计入秘密保护代理；比较按需挂载、合并入口、跨载体共享。原型前固定负载及净资源、p95、成功率、恢复、soak 数值门槛，不归档敏感 argv/env。
2. **在同一分支做有界验证**：用一个高重复 family 验 Claude+Codex 的 exact turn 与认证接缝，复用现有 gateway/保护代理。失败就在未合入分支内换路；不能合入一个默认关着、要等下一 PR 才能用的框架。单 family 试验是技术证据，不是 Phase A 交付终点。
3. **交齐实际使用路径**：把通过的接法覆盖所有已启用自家 families 和现役载体，补 Host 上下文、只读/目录/展示与缓存隔离、轮转/撤销、迟到调用和秘密保护。桥接需求落在既有代理的窄扩展，不叠新的代理进程；无法适配的现役载体是显式缺口，不自动放到下一期。
4. **同 PR 完成生命周期与切换**：部署身份、受管启动/ready/健康/停止、取消/crash/恢复、回收与 rollback 一起成立。runtime/alpha/worktree 分开；若聚合入口，连 qualified names、server instructions、能力开关和缓存恢复一起迁移，F286 单 runtime/profile 不双暴露。
5. **按结果验收**：真实载体正常调用与反例、长期稳定区间、多 family 对照和完整资源账通过后才合入；合入后继续消费 Alpha 与获准部署的实际版本证据。这些后验事实回同一交付，不再拆成一串“验收 PR”。

**独立性**：即使 Phase B 尚未开始，A 的自家 MCP 也应完整可用并产生可测收益；不依赖第三方改造来补齐自身鉴权、回收或回滚。

### Phase B: 第三方 MCP 减重与全量验收（一笔完整实现 PR）

**交付结果**：在 A 已可用的设施上，把盘点确认可共享的第三方 MCP 完整接通；必须隔离的浏览器/桌面/账户状态保留必要实例，空闲资源按原 owner 回收。正常工具功能、插件启停与撤权保持可用，并完成全量资源账。

- 在编码前固定本批真实服务清单、状态/权限边界、可共享与必须隔离的理由，不先建“万能第三方池”等另一笔 PR 接入。
- 复用 A 的 transport 与资源管理接点、现有 plugin package/grants/activation/revoke 和配置投影；第三方不各自再建设一套身份、配置或 supervisor。某项会话状态确需专用适配时，与该服务的实际接入和验证同交。
- 清单中的服务必须经过真实调用、停用/换包/撤权、崩溃/恢复和闲置回收；旧 schema/连接不得继续执行。Pencil/浏览器是否共享由证据决定，不能一刀切合并会话。
- 与 A 同口径复测原提案“约 380→几十、净省 10G 以上”的全量目标，列实际结果与差额。A 不动第三方/浏览器约 255 个估算进程时不能冒充全量完成；若目标须调整，保留理由交回 You。

### PR 边界与退出条件

默认 **两个 Phase、两笔完整实现 PR**。完整的意思是：有真实使用入口、所需权限与生命周期、完整切换/回滚和验收证据，合入这笔就能独立使用；不是按模块文件凑成一个大 diff。

- 不按“先加类型 / 再建服务 / 再接鉴权 / 再接载体 / 最后补测试”拆 PR；这些是同一条使用路径的内部步骤。
- 不把 census、单 family spike 或默认关闭的基础框架登记为独立产品交付，不为 PR 数量或流程进度替代完成。
- 若实际复杂度证明需要拆分，先在原工作说明为什么、每笔独立可用的结果与回滚边界，再修订计划；不能静默让一个 Phase 膨胀成多笔半成品 PR，也不能为凑两笔把不可审查的风险硬塞在一起。
- 路线被身份、兼容或收益证据否决时，在原分支内重判方案并报告具体缺口，不以降低鉴权/可用性或删掉现役载体换绿。

### 全程保持的契约

- **身份与权限**：F174/F178 验证 principal；可信 Host launch/connection owner 固定 deployment、workspace/data roots、profile、工具权限上界和 exact turn 关联。客户端参数不能创建/覆盖 binding；有效权限取授权上界与当前领域权限的交集。共享模式缺上下文即拒绝，不借宿主 env、默认猫、全家 agent-key map 或最新一轮凭证补齐。
- **撤销与迟到**：请求内身份不变；排队或异步等待后，受保护读取/效果仍在原领域边界复核当前授权。旧 A 不能被归到新 B；已提交效果不盲重放。`MCP-Session-Id` 只是关联信息，不是授权。
- **凭证与传输**：secret 不进入 argv/env、模型参数、URL 或原始日志；0600 文件不是同 Unix 用户猫之间的 OS 沙箱。复用 handler 时保持宿主的 loopback、Origin 与请求边界；MCP 外层秘密检查按 operator 948 撤除，原 callback 鉴权不变。
- **资源寿命**：stateless server/transport 随 request 释放；若实测要求 stateful，session-owned 对象随 session 释放，请求结束只释放 request-owned 对象。支持的 GET/DELETE/恢复请求逐次鉴权，结果、通知与 replay 只能到原 owner。
- **回收与连续性**：断线不等于取消；空闲 session/replay/cache/timer 有保留/数量/bytes 上界，合法活跃调用遵循原领域期限，warm cap 不得拒绝正常活跃需求。用户任务、消息、历史不因连接清理设置 TTL。崩溃/重启不能复活旧授权；结果不明的写操作报告 unknown 或消费原领域幂等契约。
- **可用性**：保持正常工具、合法并发和原领域权限；MCP 外层秘密检查按 operator 948 撤除，不以重新造同类检查阻塞资源交付。

## User Journey

### Primary Journey: 多只猫同时工作，工具照常可用

- **Scope unit**: workspace（含同一部署下多个 thread/载体及隔离开发工位）
- **Actor**: You 与参与任务的猫
- **Entry**: 沿原聊天、协作与开发入口派发任务。
- **Flow**:
  1. You 让多只猫并行查资料、修改代码；每只猫继续看到自己获准使用的工具。
  2. 猫在原线程/工作区调用工具、恢复对话或被停止；身份、权限和结果归属正确，其他猫继续工作。
  3. 工作结束后闲置运行资源被回收，再次开工可恢复；You 不用手工清进程，也不丢线程和任务。
- **Success evidence**: 匹配负载的前后资源账、真实载体调用回执、撤销/恢复/隔离检查与 soak 记录；后端资源功能无需新增 UI 原型。
- **Non-goals**: 重构整套 agent kernel、修改第三方模型、重开冻结的 F323 开发线、以限制正常并发代替资源治理。

## Acceptance Criteria

### Phase A（自家 MCP 完整可用）
- [x] AC-A1: 可重跑 census 覆盖自家、第三方、浏览器、保护代理及 AGY Native 等实际载体；分类互斥、未知明确，同口径复采。
- [x] AC-A2: 原四种方案的成本、权限与历史数值门槛保留可追溯记录；当前资源判据依 operator 948 改为线上拆前/拆后实测，25% 不再有效。
- [x] AC-A3: Claude + Codex 真实 initialize/list/call/resume 完成，证明原 turn 绑定与 secret 不进 argv/env/archive；未支持路径明确记录，不能算通过。
- [x] AC-A4: callback、本地文件/图片、discovery、展示及派生缓存均消费正确的请求上下文；跨猫/线程/工作区、缺失字段、受限 profile、排队后撤销和迟到请求的反例不能扩大权限。
- [x] AC-A5: 取消/断线/crash/reconnect 保持其他合法请求与用户数据；不重复执行结果不明的写操作；soak 后内存/句柄/连接/timer 回到预定稳定区间。
- [x] AC-A7: 自家所有启用 family 与现役 MCP 载体逐项有真实使用证据，至少覆盖 Claude、Codex、AGY Native；其他实际消费路径逐项核验，不适用有依据；工作区、部署、权限域不混用。撤代理后五类载体已实际验证，DSH 启动回归经 #6244 合入后真实复验；OpenCode 依 operator 暂缓未验，不计通过。
- [x] AC-A8: 受管启动/ready/假活恢复/停止有明确 owner 和故障范围；原子切换/回滚覆盖客户端工具引用、能力开关与旧配置，单 runtime/profile 无双面。

### Phase B（第三方与全量）
- [ ] AC-B1: 本批第三方清单逐项真实可用，并证明状态/授权适合共享或给出保留隔离的证据；实际停用、回收和恢复成立，插件 activation/grant/revoke 在迁移后仍生效。
- [ ] AC-B2: 同口径全量对比报告覆盖“约 380→几十、净省 10G”目标、实际结果与差额；完整功能和长期资源稳定性经独立检查。目标变更须保留 You 决定，不能拿自家交付代替。

**原 AC 迁移**：原 A1/A2 保留；原 B1–B4 → A3–A6；原 C1–C3 → A7–A9；原 D1/D2 → B1/B2。迁移时全部保持未验收，未降低要求；当前勾选依据如下，获准的本轮例外另列。

### Phase A 原实现验收依据（历史；新撤除候选须验其变化）

| AC | 可回读证据与判断 |
|---|---|
| A5 | 原实现真实代理取消/crash/恢复与连续 20 分钟 soak；满足原增长/句柄门槛，不声称后一次运行落在额外的窄 RSS 峰谷区间。Alpha API 重启前后会话保留，回合结束后 backend/proxy 消失 |
| A6 | **待新实现实测**：旧 48.8%、Alpha 29.6%、完整配置约 21% 与 v3 三次原件保留原判定；operator 948 已撤销 25% 门槛。新判据是线上真实进程/内存下降与保护代理归零 |
| A7 | 五类原生载体各四轮 PASS、同一 conversation ID；六 family 真实注册工具调用见作者集成检查。OpenCode 仅依 operator 1788 暂缓，仍未验；Cloud/dot 沿既有 HTTP，未宣称新增云端会话实测 |
| A8 | 五载体 shared→stdio 切换通过；同名工具与保护代理保持，受管 Alpha 停止已核验。两种模式均停用 Codex warm pool，stdio 不是恢复 warm pool 的回滚 |
| A9 | **开放**：Alpha 已验，生产已加载 eacafbd7；当前 29 个活动宿主对应 492 代理、七个终态完整回收。生产同负载净收益仍未证，不能沿用“未部署”状态或用 Alpha 百分比外推 |

**operator 896 纠偏（原线程 `#private-source-id`）**：最终目标是减少内存。
当时 25% 被保留为最低门槛；**该要求随后已被 operator 948 明确撤销**。保护代理的成本属于本交付，不能因承担
安全职责就免于优化或移给下一 Phase。原作者继续判断重复运行时的必要性、选择更轻的等价实现；
权限、工具引用和合法并发保持。三次固定确认已足够否决当前候选的稳定达标，下一轮完整测量必须
对应新的具体实现假设，不重跑同版等有利噪声。最终按完整正常使用负载的绝对内存、比率与真实功能验收。

本次保留实际可见的取舍：Codex 现有账户的原生 initialize 样本 cold 比 warm 多约 1.27 s，
六 family 隔离试验与实际回合不是相同测量，不能相加或推导整轮更快。实现/修复已合入不等于生产已生效。

### OpenCode 本轮实际验收的 operator 处置

- **proposal_message_id**：`private-source-id`（Astra 核验并询问现有账户来源）。
- **cvo_message_id**：`private-source-id`，原线程，2026-10-26 08:49 UTC。
- **cvo_quote**：「先不管opencode了 没有api」。
- **accepted_scope**：暂停 OpenCode 的 API/认证补齐和原生 initialize/list/call/resume 复验；该部分以 `cvo_signoff` 处置、保留未验事实，不再阻塞本轮其余载体的完整实现、审核、合入与验收。其余 AC 及单笔完整 PR 要求继续适用；不视为 OpenCode 已通过、永久删除支持或把该项自动转入 Phase B。

保留现有接线与失败证据；本次不修改账户、切模型或重试索取 API。Census 和完整资源账仍如实记录现存进程，不能把 OpenCode 计入真实通过载体数或外推其资源收益。待 You 明确恢复且有可用 API 时沿原 F333 补验；恢复前不再等待账户回复。最终验收和交付说明必须披露这项 operator 处置。

## 需求点 Checklist

| ID | 需求点 | AC 编号 | 验证方式 | 状态 |
|---|---|---|---|---|
| R1 | 多猫并行时减少重复进程和内存开销 | AC-A1/A2/A6/A9、AC-B2 | 同负载完整资源账与实测 | [ ] |
| R2 | 每次调用认对身份、权限、线程和工作区 | AC-A3/A4/A7 | 真实载体正常路径与越权/迟到反例；OpenCode 依 operator 暂缓未验 | [x] |
| R3 | 结束可回收、故障能恢复，其他猫能继续干活 | AC-A5/A8/A9、AC-B1 | soak、取消/crash/恢复及切换演练 | [ ] |
| R4 | 利用现有网关、核实入口合并与 AGY Native 收益 | AC-A1/A2/A3/A6/A7/A8 | 五载体Alpha与boot58线上使用已验，原生HTTP复用既有网关，保护代理层归零；不外推整机净收益 | [x] |
| R5 | 第三方受控扩面、自家交付不冒充完整目标 | AC-B1/B2 | 插件撤销/状态隔离与全量验收 | [ ] |
| R6 | 少 Phase，复用已有设施，每笔 PR 是完整可用结果 | AC-A7/A8/A9、AC-B1/B2；PR 边界段 | 从真实入口验证独立可用与整笔回滚，不依赖后续 PR 补齐同一使用路径 | [ ] |

## Dependencies

- **Evolved from**: F149/F161、F254 的宿主生命周期经验，及 #6009 引入的 member gateway；不继承这些 Feature 的未完成业务目标。
- **Blocked by**: 无必须等待整个旧 Feature 关闭的依赖。Phase A 内先取真实基线/门槛再做有界试验，完整接入后交付；B 复用 A 已可用的设施，能力缺口留在本 Feature 明确验证。
- **Related**: F174/F178（principal）、F145/F249/F213（配置）、F286/ADR-044（表面切换）、F153（观测）、F202/F292（插件授权）、F300/ADR-039（部署身份）、F306（原 gateway 注释与 effect/secret 边界）、F325（AGY Native）。

Architecture cell: `runtime-deployment`, `identity-session`, `callback-auth`, `mcp-surface-governance`；第三方阶段消费 `plugin`，指标消费 `observability`。

Map delta: none at kickoff。正式实现新增 worker/connection 责任时更新对应现有 cell；不把 F254 freshness 或 `transport` 的对话出入口扩成总包，不另建授权、配置或调度账本。F323 当前 frozen，本项只复用已经存在的部署机制。

## Risk

| 风险 | 缓解 |
|---|---|
| 共享后沿宿主 env/旧缓存串身份或权限 | Host binding + 当前 principal/领域授权；完整上下文反例，缺失字段拒绝 |
| 进程变少但 heap/协议对象随历史调用增长 | 按资源 owner 回收，容量上界与固定并发 soak |
| bridge、权限分组或保护代理抵消收益 | 完整 census/比较，先定门槛再测；不预承诺 83% 内存收益 |
| 多 family 聚合改变客户端 qualified names 或能力语义 | F286 全量 consumer 检查与原子切换，禁恢复旧全量面 |
| 把一处 worker 崩溃扩大成 API/全家工具故障 | 明确部署和故障域，比较现有 in-process 与独立受管部署成本 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| KD-1 | 独立 P1 容量/生命周期 Feature，保留既有 owner | 用户结果超出工具配置或 Codex host pool 单一修复 | 2026-10-25 |
| KD-2 | 复用现行 member gateway，先单 family 双载体 | 新基线已提供最小 HTTP 契约，首要未知是安全适配与净收益 | 2026-10-25 |
| KD-3 | 六合一是候选比较，不承诺 83% 总资源降低 | 启用集合、权限域、代理和客户端命名都影响收益与兼容 | 2026-10-25 |
| KD-4 | 资源/延迟用观测，身份与契约用确定检查 | 不为运行健康新增 Eval Hub 项目 | 2026-10-25 |
| KD-5 | 两个 Phase，默认两笔完整实现 PR；盘点/试点并入 A 内部 | operator 1202 要求完整可用的交付，不把模块接线拆成半成品链 | 2026-10-25 |
| KD-6 | 优先扩展现有秘密代理与网关，新增仅限上下文/接线/生命周期缺口 | 已有双端 transport 和 HTTP 消费；静态 header、权限域与 owner 差异仍须补证，不能只改配置假报复用完成 | 2026-10-25 |
| KD-7 | OpenCode 本轮实际验收以 operator signoff 暂缓，保持未验且不再阻塞其余交付 | operator 1788 明确无 API、先不管；其他使用路径仍须完成 | 2026-10-26 |
| KD-8 | 拆除全部 MCP 外层保护代理；保留 git pre-push/gh/curl，撤销 25% 资源门槛 | operator 948 明确要求删除冗余防线与指标；执行范围和第三方逐条检查取消已由 Opus 949 说明 | 2026-10-27 |
| KD-9 | 定向迁移 Codex 自家旧静态项，受管调用注入 HTTP；独立 CLI 保留显式 stdio 与回退 | Astra 核实原生深合并冲突与已退休 writer 后裁决；迁移和接线同 PR，保留第三方及账户配置 | 2026-10-27 |

## Review Gate

- operator 1236 指定本次实现分工：Sol6.1 写、Sonnet 审、Astra 最终把关验收。Sonnet 在执行现场给精确实现目标的独立 verdict，修复回原作者；Astra 消费整项最终结果与真实运行证据，不逐步重复审核实现。
- 默认一笔完整 Phase A 实现 PR；执行侧在风险门禁满足后正常合入，整项实现结束回流一次。Astra 继续持有 AC-A9 与整体真实验收，生产启用/重启与 Feature close 仍按各自权限处理。
- 已有设计证据：Sol 6.1 对 v2 的四项 finding 全部关闭；Argon 对新基线无阻塞性反对。两者不代签尚未运行的试点或实现。
- 立项内容复用上述独立判断并以当前源码收正适用范围，未为立项重复唤醒 reviewer；最终实现沿既有 API gateway 承载，Phase A已由Astra核实际迁移、使用及资源账；全量净资源目标保留在B，不因A验收代签。
- 实现涉及行为、secret/权限、MCP consumer 和生命周期，按当时实际 delta 选择非作者独立验证与相关 RED/GREEN；测试范围按风险，不把本页等同 merge approval。
