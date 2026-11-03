---
feature_ids: [F032, F127, F143, F161, F241]
topics: [role-configuration, agent-client, implementation, acceptance]
doc_kind: implementation-plan
created: 2026-10-29
status: implementing
---

# 角色与 Agent 接入综合重构实施记录

PR 为 [#1748](https://github.com/zts212653/clowder-ai/pull/1748)，目标上游 **develop**（2026-10-30 用户更正并已远端回读）。Claude 主包减重实施及证据见 [claude-package-reduction.md](claude-package-reduction.md)；完整重构验收仍按总账单独判断。

接受的规范为 `C:/Users/Administrator/Desktop/猫猫咖啡馆/技术方案/综合重构方案-20261029` 内六份文件，哈希及全部验收条目见 [acceptance-ledger.json](acceptance-ledger.json)。以该综合方案为准：原生与 ACP 长期共存、配置为身份权威、纯投影不迁移配置库、现有 owner 承担保存/冻结/会话/权限。

目标分支 `feat/role-agent-refactor-20261029-gpt-sol`，基线 `6d8d4915bcd84edfeb42edf76466cf6318cecdbd`。本任务工位为 `G:/AIwork/clowder-ai/worktrees/role-agent-refactor-20261029-gpt-sol`；主工位和生产环境不改写。桌面 App 的 worktree 工具因聊天工作目录为 Git 外层目录而拒绝 sourceRoot，已改用仓库 `scripts/worktree-new.mjs`，先建 feature 分支再创建并登记 owner=codex/policy=merged。

## 约定范围与实施顺序

1. W0：核对最新源码、真实入口、在飞 PR 文件重叠、各客户端/载体与测试基线；保存验收总账。
2. W1：角色/执行纯投影；成员编辑权威与 dossier/名册；S1/S2/S3 保存、失败读回和各资源 CAS。
3. W2：完整冻结输入与实际消费者、L0 冻结渲染、写入通知、默认权限拒绝和实现 generation。
4. W3：现有 session record 的兼容摘要/原生片段；输入、取消和恢复的真实终态；原地身份更新须先采用再持久化。
5. W4：逐个保护 Claude、Codex、Gemini、AGY、Kimi、Pi、DSH、OpenCode、CatAgent、A2A、通用 ACP 的现有能力，接入冻结与能力投影。
6. W5：CodeAgent 单工具发现/合法声明/专属适配/网络环境；用户补充授权本机简单 mock，模拟契约证据与企业真实能力分开。
7. W6：26 项 C、4 条 E、4 组 Q 及性能检查；当前原生/ACP 的纵向切片通过后补全其余存量回归。
8. W7：按绑定启用、最终发行物和回退演练；无开放 P1/P2，数据与权限底线保留，环境有收尾回执。

分步提交不改变完成定义。总账中 NOT_RUN/BLOCKED/FAIL 不计通过；不会用一个局部绿灯宣称完整实施完成。

当前状态：实现已推进到配置纯投影、条件保存、调用冻结和取消终态的局部切片；ACP 命令、启动审计和 Windows shell 固定（`871990137cdd5da27c10d15b64a64d19fe0e5a10`）及普通部署插件 MCP 激活冻结（`f7c628e836625d6ebadd76b5ead9988ebe6ac705`）均已获独立审查通过。CodeAgent mock 已补正式声明/注册/适配调用链，详见 [本机模拟说明](codeagent-mock.md)。W2/W3 仍有持久兼容引用、恢复和逐客户端采用工作；34 条 C/E/Q 全量验收尚未完成，macOS、企业真实 CodeAgent、最终安装包和真实模型质量没有通过证据。以下“已核对的现状”是初始基线，实际变更及局部证据按后续阶段记录和总账查看。

已独立通过的取消底线提交 `eb0f9383e4269002f98cd3b68ab289f01ad8942c`：事件归属核验保留 Host 私有 turn 身份；同一用户/线程/成员的旧执行停止未确认时阻止普通新任务，定向 99 PASS、独立复核 19 PASS。最新静态消息前缀提交 `022526e2b16915c0b474dfd183b771eb89fca68a` 修正内容/坐标和不确定交付证据，独立 23 PASS；它不能替代持久兼容绑定。后续仍必须完成 W2 的安全持久引用和完整启动输入版本，以及 W3 的稳定兼容结构/原生片段/采用后落盘；然后逐客户端推进 W4。此处的通过只对应局部提交，不覆盖这些剩余依赖。

## 已核对的现状

### W3 Host 执行边界持久化（W3 尚未完成）

在原 SessionRecord 新增 `hostExecutionBoundary`，由既有 SessionChainStore 持有写一次/比较的原子入口。字段仅包含 Host 选定的客户端、载体、实现 key/进程内 generation、账号引用和规范化工作区/项目根；不保存账号对象、secret 哈希、env、callback token 或私有指令。此 generation 跨 Host 重启即变化，默认换片段，不能冒充稳定实现版本、完整 CompatKey 或原生采用证据。实际 HOME/原生状态根、权限/MCP/指令兼容与 credential revision 仍须继续接入。

普通调用在既有会话独占权和旧执行停止检查后比较结构；变化或未知旧绑定进入既有封存、授权上下文重建和新逻辑节点流程，旧原生 ID/历史保留。无法重建上下文、封存/持久化失败或最后一次 provider 入口比较失败均不发送任务。明确导入但无法核验绑定时原位失败，不能替用户换历史。AGY 原生绑定验证未改变。

有效 RED 为 `execution-boundary-red.log`；首批修正后 13 PASS，6 个 Redis 默认跳过随后单独实测。独立审查发现 provider 入口复用冻结 generation 的 P2 后，新增 `late-execution-boundary.test.js` 先复现再修复；修复后的 `late-boundary-green.log` 为 19 PASS+6 Redis 默认 SKIP，准入捕获 generation-1、入口变为 generation-2 时 provider 调用为 0。真实 Redis `redis-execution-boundary-6b7a817d4f624e99ab185cc2701037b2/tests.log` 11 PASS、0 SKIP，覆盖反序 JSON 键、不可覆盖、并发账号引用竞争、原生 ID 不符、非活动/已被置换 owner、初读后 active 指针变化和 scoped 禁入。新调用链实际覆盖稳定续接、客户端/工作区/实现更换、头像保留、未知旧记录、明确导入拒绝、缺上下文重建、绑定及最终入口失败，以及同步 abort+reject。`execution-boundary-contracts.log` 342 PASS；`execution-boundary-owner-final.log` 188 PASS，四项 Windows AGY Native 场景用精确名称明确排除，不计通过。公开 session route 会剔除 private `hostExecutionBoundary`，`session-route-redaction-green-final.log` 43 PASS。shared build/API tsc 最终 exit 0；先前 tsc 缩窄错误日志保留，修正后才运行最终回归。

扩大回归的原失败证据保留：第一轮旧夹具未声明已知 Host 绑定、BG 每轮新对象被当成新实现，以及部分 store 替身缺新接口，出现 40 FAIL+1 cancelled，挂起 worker 经路径/父子关系/创建时间确认后仅停止该 worker。`known-host-session-fixture.js` 仅为原 owner 测试显式补其“已知既有会话”前提，真实 store 原子方法不替换；新边界/未知旧记录用例不用此 helper。BG 夹具声明同一具体实现；三条封存竞争夹具先创建其已知逻辑节点。中间夹具准备越过原错误投影的失败也保留；最终保留原行为断言通过，未在产品中新增 legacy 放行。

真实 Redis 测试台账为上述目录 `instance.json`：仅 6398/DB15，自建进程 PID 51932（MSYS 内部 PID 2356），SHUTDOWN SAVE 完成、端口释放、数据保留。六份接受规范哈希仍一致，见 `source-integrity-host-boundary.json`。新增文件均低于 350 行硬限，调用链测试 213 行触发 200 行提醒，保留完整旅程。checkpoint `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-host-execution-boundary` 在 exact HEAD `0cf338afa2c8e270501cec47e0863b66e7ff15fb` 获独立 `approved`、findings 为空；独立 route+boundary 集合 55 PASS，见 `packages/api/artifacts/role-agent-checkpoint-review/execution-boundary-0cf-final.log`。随后状态根与审计引用 follow-on exact HEAD `5d4be68b7b1f2df2a7e4211b37d4b1b0ca2a99ef` 也获独立 `approved`、findings 为空；复核确认 generic state-root guard、脱敏 boundaryRef、审计写入失败阻止 provider，独立 17 PASS，作者 `boundary-audit-final.log` 60 PASS、`boundary-audit-contracts.log` 337 PASS。两次批准仅覆盖 Host boundary checkpoint，不代表完整 W3/W4 或整体验收完成。未调用真实模型或企业 CodeAgent，Mac/最终包/Q 项未完成。
PersonaDigest follow-on exact HEAD `5b984ccd8e62d752e874c98ff7ac8e0d47cf332d` 已实现并通过 API/shared/Web tsc 与 3 项 binding 回归；shared 层保持 browser-safe，digest 只由 API server-only owner 计算。它是纯角色语义投影，明确不代表 Native InstructionDigest 或 CompatKey；因 reviewer 当前 unavailable，暂不登记为 approved。

- 正式成员入口是 MemberSettingsHost/MemberSettingsPage/useMemberEditor、MemberCreationPage；不复活旧 HubCatEditor。
- S1 已有成员 revision；S2 runtime override 已存 revision 但路由无 CAS；S3 ConfigStore 同步按键写入，正式端点无版本前置。
- 当前 ACP 缺 permission handler 的默认分支仍可允许；必须在真实 consumer 和 wire 验证拒绝语义。
- L0 和名册仍有 dossier 优先及全局重读；最终必须迁入冻结输入模式，不只新增 readonly 类型。
- 新 main 的 DSH secret guard 已存在，persona 组合必须保留其受信哈希约束。
- 在飞 #1596 与 ACP/工具链重叠；#1673/#1674 与取消链重叠；#1607 触及旧 HubCatEditor。已看具体文件，任务只在自己的分支实施必要改动，不整体移植这些 PR。

## 验收边界与环境

用户确认本机没有 CodeAgent 程序，允许简单 mock。它可证明接入合同和故障处理，不能证明企业发行物、真实认证或模型质量。用户已明确确认暂无 Mac；既有承诺的 macOS 实机/安装包项目因环境缺失 BLOCKED，保留必需项，不改成 N/A 或虚构通过。

当前没有本任务常驻交互服务。已使用的临时 Redis、Node mock、浏览器/路由夹具按各阶段实例台账收尾，数据和证据保留；后续仍使用独立 HOME/原生状态根，不访问生产 3003/3004/6399，测试 Redis 端口先核归属，禁止清空持久数据。依赖和构建产物属于本工位，用户在用环境不停止。

Architecture ownership：涉及现有配置、context、invocation/session、approval 和 client adapter。准确 cell 和依赖映射在对应工作包实改前核对；不新增数据库、队列或通用 launcher。代码先观察可信 RED，再最小 GREEN；每个提交保存检查命令、结果与仍未覆盖的边界。

## 2026-10-30 阶段记录（尚未整体验收）

已实现：

- RoleProfile / ExecutionProfile 为现有 CatConfig 的纯投影，准入 binding 深冻结；未改 JSON 持久化模型。实际消费者全面改用快照尚待 W2。
- 同一次 template/catalog 合并保留字段来源。自身 L0、队友名册及原编译预览共用配置优先与 dossier 自述块抑制；显式空性格/空团队定位不复活旧文本。模板历史兼容和显式完整配置分别验证。
- S2 override 和 S3 Codex 全局键返回独立版本，正式端点无版本 428、冲突 409；Redis GET 与 Lua 比较写处理独立 owner 竞争。S1 原有 CAS 的无版本盲写仍须强制关闭并迁移其他正式写入者，C17 未完成。
- 正式 useMemberEditor 改为分步保存/局部提交，冲突保留草稿；S1 创建/PATCH 结果不明时先读回，重新进入按原 catId 核对后再写，不能换 ID 悄悄创建另一成员。S2/S3 只补交已修改且未采用的字段，读回成功的超时不假报总体失败。
- ACP stdio / HTTP 缺审批处理器时默认拒绝；明确允许仍需显式策略或 handler，仅选择协议实际提供的允许选项。未新增审批 owner。
- 用户授权的简单 CodeAgent mock 位于 `packages/api/test/fixtures/codeagent-mock.mjs`，包含 NDJSON 握手、身份文本、固定隔离文件工具、权限、持久两轮续接、取消未知与断线。由真正 AcpClient 启动独立 Node 子进程；不是企业 CodeAgent 或模型质量证明，专属发现/合法声明/适配接线尚待 W5。
- 本轮从同一 worktree 重跑 CodeAgent mock/声明/注册测试：`artifacts/role-agent-refactor-20261029-gpt-sol/codeagent-mock-regression-current.log` 为 54 PASS、0 FAIL、0 SKIP；仍只证明 mock 协议和严格声明链，不改变企业 CodeAgent、真实 discovery/probe、Mac 或 C/E/Q 的状态。

本阶段验证集合分别记录，不相加为全量通过率：

| 验证 | 结果与范围 |
|---|---|
| API 相关 catalog / L0 / prompt / member / strategy / config 回归 | 496 项，494 PASS、2 SKIP（Redis 单独执行）；无 FAIL |
| ACP 两传输 / iCode / mock | 87 PASS；mock 中 7 项为真实子进程协议验证；缺 handler 的 stdio 两反例、HTTP 一反例先见 RED |
| Redis 持久化 CAS | 独立 owner 同 revision 竞争、GET 后 Lua 前改写，2 PASS；自建 6398 实例已 SHUTDOWN SAVE，端口释放、RDB/AOF 和日志保留 |
| 正式页面 hook / 保存恢复 / 身份来源等 Web 回归 | 6 文件 45 PASS；创建响应丢失、重进读回、PATCH 读回、不同配置不覆盖先见 4 RED |
| 实际浏览器 | `role-agent-refactor.journey.mjs` 1 PASS：生产 SettingsShell → MemberSettingsPage，编辑职责/保存/刷新读回及 Codex 全局 CAS，后端为本工位真实 Fastify 路由。浏览器路由/网络为隔离夹具，未调用原生客户端、不是最终安装包验收 |
| 类型与格式 | shared 构建、API tsc、Web tsc --noEmit 通过；目标文件 Biome 无错误，有原有及新增复杂度提示，未以批量拆函数掩盖 |

初始扩大回归的两处环境问题已明确：`audit-cc-system-prompt.test.js` 引用未公开脚本，现有 public-test-exclusions 已将其列为 source_only，正式相关集合按既有边界排除；convention graph 测试用 URL.pathname 在 Windows 得到错误盘符，改为 fileURLToPath。L0 等价测试仅规范比较边界的 CRLF/LF，不改变产品内容。旧账号必填夹具显式设为 managed_account，保留 native_tool 继承语义。

本地证据根：`artifacts/role-agent-refactor-20261029-gpt-sol/`。浏览器截图和 result.json 已回读；本机 Playwright 借用桌面随附库及已安装 Chromium 1228，适配 loader 只在该证据目录，不进入产品。mock 的所有状态根在 `packages/api/artifacts/role-agent-refactor/codeagent-mock/`，均为独立 HOME/USERPROFILE，不复用原生登录/历史。

Architecture cell 为 `identity-session`（其 identity-agent / runtime-binding 边界）；map delta 为新增代码锚点及投影/保存消费者说明，owner 不变。`cat-life-settings` 是生活/日记配置，与本任务成员设置无关，未借其名字建立新归属。

下一步顺序：完成 S1 必需版本及正式写入者迁移；完成冻结输入传到实际 L0/ACP/native consumer 与实现 generation；会话兼容、取消/回执/恢复；逐客户端保真与 CodeAgent 专属接线；固定 Q 样本、性能与平台/发行物矩阵；最终独立 review、启用和回退。macOS 与真实企业发行物仍无现场证据，不计通过。全部未覆盖项在总账保持 NOT_RUN。

## 独立审查第一轮

非作者 reviewer 审查 `2ec3bd6d30255b2b76d7fc7d3237c38f14eb8339`，结论 changes_requested，两个 P2，未申请全 Feature 终态通过。reviewer 独立验证原方案 6 文件哈希，定向 API 16/Web 11 项通过，另外实证两个恢复反例 RED；无新增工位/服务。

1. 来源元数据先看 raw catalog 的默认 variant/breed，而没有先看有效值已经被 template variant 占位，导致未编辑成员错误停用 dossier。修复按实际取值链选择来源，覆盖默认性格、breed 描述及旧 name→displayName 例外；新增普通/空性格的双 variant 反例先 RED，再 GREEN，真实继承仍为 default_variant。
2. pending PATCH 后用户改回旧 baseline，页面以 dirtyCount=0 截断核对；即使直接调 hook，旧 baseline 重基线也吞掉撤回意图。修复将待核对状态单独显示并绕过无改动短路，恢复时用 pending.form 判断提交后的编辑，保留用户撤回值。正式页面/hook 两反例先 RED 后 GREEN；实际浏览器通过响应丢失、读回失败、改回旧值、核对、再保存的真实 API 旅程。

修复后相关 API 集合 499 项=497 PASS+2 Redis SKIP；Web 六文件 47 PASS；浏览器两条旅程 PASS；mock+身份定向14 PASS。7 个新 `.test.js` 已验证进入现有 public resolver；未用未被 CI 发现的测试文件充数。mock 新记录补全子进程 PID、源码/dirty 标记、实际 adapter/fixture/Node 哈希和独立关闭状态；早期失败状态保留为 RED 证据，不补造过去的原生调用记录。

平台矩阵见 [platform-matrix.md](platform-matrix.md)，明确 Windows/macOS、CPU、内外网、已有承诺及未取得现场证据。当前修复等待同一 reviewer 复审，不自称通过。

复审回执：非作者 checkpoint_review 对 `74e0caebd503851803d923291ddce0ce3c25f8d4` 给出 `localReviewVerdict=approved`，同一 reviewSubjectRef；独立 API 19/Web 13 项及原恢复反例通过，核看恢复截图，两个 P2 闭环。未发现新 P1/P2，无新增工位/服务/源码改动。仅批准继续实施，不代表 W0–W7 终态。

## S1 写入前置条件收尾

成员 owner 和正式 PATCH/DELETE 端点拒绝无版本写入（428），旧版本返回 409。启停状态纳入成员 revision；DELETE 在核对成员版本之后才清理策略，复用原有目录锁，等待异步策略持久化期间继续持锁。修复此前 `return Promise` 提前经过 finally 释放锁的问题，未新增锁、事务或存储。

正式 SettingsContent 启停/删除和 MemberCloudIdentity 恢复操作携带成员版本；恢复动作的混合字段检查接受版本元数据。既有 API 测试客户端改为先读取当前成员版本，再提交原字段；保留新的盲写/过期写入反例，不为旧测试开放绕过入口。迁移时发现 `body`/`payload` 双入口覆盖，已修正并重跑；拒绝写入副作用测试先完成 GET 的已有目录迁移，再记录写入前字节快照。

验证：新增 5 项 owner/锁/真实 Fastify 反例先见 RED 后 GREEN；API 9 文件共 145 PASS；Web 4 文件 28 PASS；正式设置浏览器 2 PASS；API/Web 类型检查通过。账号回归中的 ACP 构造案例仅在测试进程显式使用已有 trusted-host 测试模式，避免把 runner Temp 父级 ACL 当作账号语义失败；并未验证或放松产品 Windows ACL。

证据为本工位 `artifacts/role-agent-refactor-20261029-gpt-sol/s1-*.log` 与 `browser-journey-s1.log`。无新增服务或原生客户端调用。C17 仍须与 S2/S3、并发和失败场景一并验收；当前只是 S1 局部闭环，等待独立审查。

独立审查 `d25959f95bc4a26b5fa688dddf16499ff1937ea1` 返回两个 P2。其一是旧持久草稿没有成员版本，428 未显示“重新读取并保留修改”，重开仍恢复旧 baseline；现将 428 和 409 一并进入已有恢复入口，验证重开、保留个性编辑、手动读取新版本、再次保存。其二是删除成员原本没有 S2 override，另一合法的 `none` 版本策略请求可在删除后落盘；现让 S2 PATCH/DELETE 复用同一目录锁，并在锁内重读持久成员存在性，不依赖尚未刷新的 registry。无新增事务或 owner。

两反例均先 RED；修复后 S1/S2 定向 API 22 PASS，保存恢复/actions/Codex Web 21 PASS。更早的 API 145 和浏览器 2 条为前一提交证据，不冒充这次最终源码全量重跑。reviewer 原始反例保存在独立审查证据目录，后续按修复提交复审。

复审回执：checkpoint_review 对 `b5e517d0c3c3ec909a6509ec6c14558f10d4e5a3` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-s1`；独立原始反例 GREEN、API 22/Web 21 PASS，无新 P1/P2。只批准 S1 checkpoint。

## W2 L0 冻结输入切片（W2 尚未完成）

现有 L0 编译 owner 增加 typed FrozenL0Input：成员/名册、规则模板、治理、工作流和本次嵌入的用户 capsule 捕获为私有只读文本；输入摘要和编译器版本共同进入原缓存。共享 Node-only 模块承接原脚本的捕获逻辑，CLI 和 API 复用同一实现，不复制另一份身份解析器。public 在读取私有正文前使用独立白名单。API 不导入自举 CLI；子进程的 `--frozen-input` 模式只验证/渲染 stdin JSON，不读取当下 registry/profile/rules。选择已有 stdin 管道传输私有输入，未新增 IPC 服务或私有临时输入文件；原生输出工件仍由原 owner 管理。

准入 binding 增加冻结 L0，并用现有 CatRegistry revision 拦截异步工作区解析期间的配置变化。Claude print/bg/SDK、Codex、Kimi、OpenCode、AGY Native/ACP 的实际编译调用传入该输入且要求存在；真实编译器缺快照明确失败，不退回 live。AGY 手动压缩路由在控制准入处捕获同一输入，并保留原生 binding 严格哈希/工作区/账号检查。独立 CLI 继续允许 live 诊断，stderr 标明 configurationRevision/inputDigest，不记录提示词正文。

新增 3 项冻结协议及 2 项准入反例先 RED；旧捕获器与新捕获模块在删除重复实现前已比较 owner/public 实际产物一致。实际 Codex L0 子进程 + 替身 CLI 验证被冻结的 developer instructions，随后缺快照时不启动 CLI。AGY Windows 文件权限反例又实证了根路径/目标路径分隔符不一致，现统一比较；POSIX shell 测试引用 Windows 临时路径时单引号保护，CLI 测试用 fileURLToPath，不修改真实 shell 执行或降低预期。

| 本切片验证集合 | 实际结果 |
|---|---|
| L0/准入/Codex真实编译边界/Claude bg/OpenCode/F296 | 73 项：69 PASS + 4 既有本地 OpenCode 文件缺失 SKIP，不计为通过 |
| Kimi 与 AGY ACP 配置/权限/协议 | 63 PASS；ACP 构造测试的 runner Temp 仅按既有 trusted-host 测试模式隔离，非 ACL 实机验收 |
| Claude SDK 两文件 | 22 PASS |
| 压缩控制路由与 AGY 目标 guard | 15 PASS |
| dossier 显式根脚本回归 | 5 PASS |
| owner/public/edition 渲染等价 | 10 PASS；跨 edition 安装 hook 的额外 1 项在显式 Git Bash PATH 下通过 |
| 较大 invocation/routing/member 集合 | 217 项：213 PASS、4 FAIL；四项均进入既有 AGY Native 的 Windows 进程出生身份缺口，不计绿灯 |
| AGY Native 独立压缩 | 8 FAIL，首次调用因同一进程身份缺口无法启动；日志保留 |

Windows 默认 `bash` 指向失效 WSL 磁盘，额外 edition 用例失败来源已定位；测试进程显式选已安装 Git Bash 后通过，未改系统 PATH 或修复/启动 WSL。原生 ownership 工具在 win32 返回 null，相关源码与基线无差异；F325 原始 Feature 明确 Linux/Windows 未认证，因此保留候选和现场缺口，不把 Host 的 Windows 安装承诺误当该原生载体已认证，也不删除失败或新增 skip。MCP 测试仅规范路径断言分隔符；OpenCode host 编译的捕获条件已对齐实际 consumer，原有三条自愈旅程恢复通过。

尚待 W2：各 owner 完整 revision/generation 读前读后重解析；ACP/native 启动参数、MCP 暴露、权限/沙箱、model/effort 和非 L0 上下文消费者全面使用 binding；实现 generation 与受控启用。当前 registry 变化会明确要求重试，不能据此声称已经实现规范要求的完整跨 owner 冻结。会话兼容摘要/片段、CodeAgent 专属发现及 Q/平台/发行物验收继续保持未完成。

提交前定向集合复跑 `frozen-final-targeted.log`：157 项=153 PASS+4 既有本地 OpenCode 文件缺失 SKIP，无 FAIL。shared 构建、API tsc、Web tsc --noEmit 通过；目标 25 文件 Biome 无错误、68 条复杂度/已有风格警告；新增两个 `.test.js` 已验证由现有 public resolver 选中。较大集合及 Native Windows 的失败仍独立保留，不以定向集合替代。无新增服务/真实模型调用；本切片等待独立审查。

### L0 独立审查修复

checkpoint_review 审查 `2a69d4789ee16b44c2f50a2f768e4abffd888220`，返回两个 P2，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-l0`。其独立运行的 59 项通过，另外两个实际调用反例先见 RED：摘要后台入口缺少冻结输入，外部项目的冻结捕获改变了 Host 工作流覆盖目录。

现由实际后台 owner 补齐输入：curation provider 携带解析后的成员；摘要/线程馆员将真实 userId 传到 native run；任务提取和查询资格判断在现有入口捕获；离线 watcher 把自身既有专用指令冻结，不引入普通成员身份。public native admission 独立捕获 public 白名单，捕获前不读取 owner catalog/profile/governance。保留真实编译器缺快照拒绝行为，没有恢复 live fallback。共享根解析复用原有 Host 工作区算法，移除 task projectRoot 作为覆盖来源。未增加存储、协议或 launcher。

两个 reviewer 原始反例转绿，并将后台摘要、实际任务提取、外部工作区覆盖和 public 无 owner 读取的四条旅程纳入公开发现的 `background-frozen-l0.test.js`。实际 L0 仍运行独立编译子进程，原生客户端使用替身，未调用模型。旧命令路由夹具只有无效的半个成员对象，更新为同一真实模板成员，不能以 L0 捕获失败后的降级任务冒充模型提取成功。

| 修复后集合 | 实际结果 |
|---|---|
| reviewer 原反例 + 后台四旅程 + 任务提取/正式命令路由/查询 + 冻结协议 | 40 PASS，`l0-review-caller-green.log` |
| L0 编译/等价/准入/Codex 实际编译/Claude bg | 45 PASS，`l0-review-native-regression.log` |
| curation/source labels/watcher/account | 39 项：38 PASS、1 FAIL；失败为既有 Windows `plugin_native_workspace_not_private`，在 L0 前被拦截，`l0-review-background-ts.log` |
| public native 原有完整旅程 | 13 项：6 PASS、7 FAIL，同一 Windows 私有目录门禁；新增 public 捕获/真实编译旅程通过。保留 `l0-public-capture-tests.log`，不降低门禁 |
| 更早扩大后台 TS 回归 | 37 项：26 PASS、11 FAIL；11 项均为旧 MessageStore 夹具缺少必需 MessageFrom，在 L0 前失败；无本次改动，不修改无关夹具。`l0-background-ts-tests.log` 保留 |
| 类型和格式 | shared/API/Web tsc 通过；21 个目标文件 Biome 无错误，61 warnings、2 infos（随后删除新增测试未用 import）；diff --check 无错误 |

原生/public 载体的 Windows 认证缺口仍须按矩阵处理。上述集合不相加为完整验收率。无新常驻服务、模型调用或用户状态根复用；隔离测试目录保留原始证据。当前等待同一 reviewer 复审，W2 整体仍未完成。

复审 `847aa4d571f852fb35470038b5bd1608c595114f` 独立确认原两反例及调用集合 40 PASS，但发现原 overlay P2 的显式 cwd 变体：查询资格判断已有 compiler cwd=Host 配置根，API 进程 cwd 可与它不同。新增 owner-only `compilerCwd` 捕获参数并由该入口传现有 root，普通入口仍默认原 cwd，public 不读取此参数或 owner 源。reviewer 真实 child 第三反例及实际查询入口的 Host canary 反例先 RED 后 GREEN；`l0-query-overlay-green.log` 共 9 PASS（原三反例、后台四旅程、实际查询两旅程）。未把 task 工作区作为 Host 来源；等待修复后复审。

checkpoint_review 对 `ab03ccacb5274ec9b1e6fcd48855f54088c5664f` 给出 approved，subject 仍为 checkpoint-l0；独立复跑 9 PASS，三个原反例和 public/默认/显式 cwd 边界均闭环，无新 P1/P2。只批准 L0 checkpoint，不代表完整 W2 或平台验收。

## W2 模型与 effort 消费切片（尚未完成 W2）

既有执行 binding 增加只读 executionPreferences，保存配置来源、解析后的请求 model/effort 及原生认证继承选择，不增加持久化模型或新注册中心。Host 在准入时捕获并传给实际 consumer；Claude print/bg/SDK/PTY、Codex、Kimi、ACP、CatAgent 优先消费该快照。后台摘要、查询、任务提取及 watcher 也在自身现有 owner 捕获。Git 作者与 OpenCode 模型/速度解析改用同一准入值。实际采用的 model/effort 仍只能由客户端观察报告，未将请求值复制成采用值。

ACP 的 source/model/effort 读取从租约之后移到之前；正式调用使用更早的 Host 快照，直接内部调用在自身入口捕获。两条真实 consumer 反例先 RED：租约等待期间改模型/effort或切换 configurationSource，都错误采用新值；现在实际 session/set_config_option 使用原值。Codex 最终 argv 验证显式偏好与空偏好两种情况；空 model/effort 不注入新覆盖，PTY 同样省略空参数。新偏好对象无账号密钥、token 或完整 env。

| 本切片验证 | 结果 |
|---|---|
| ACP 两反例 + Codex/PTY 最终参数 + 绑定 + 后台 | 11 PASS，`execution-preferences-final-targeted.log` |
| SDK/原生继承/watcher/query | 26 PASS，`execution-preferences-sdk-regression.log` |
| 通用 ACP / iCode / CatAgent | 131 PASS，`execution-preferences-acp-catagent.log` |
| 扩大 native / invocation / 正式命令入口 | 311 项：304 PASS、7 FAIL，`execution-preferences-native-regression.log` |
| 类型 | API tsc、Web tsc --noEmit 通过；API 构建缓存留在任务 artifacts，不修改产品 tsconfig |

7 个失败为：3 条 Claude bg 持久 owner 夹具在 Windows 无原生进程出生身份、1 条 Codex 缓存根断言硬编码 POSIX 分隔符、3 条 PTY 图像/自定义 HOME 断言硬编码 POSIX 路径。涉及进程身份和路径实现与基线无差异，未降低门禁、改期望为假成功或标为通过；也未改写无关夹具来刷绿。这里没有最终安装包、真实模型或 macOS 证据。

剩余的 thread effort/speed、全局沙箱/审批、MCP/ACP 磁盘配置、项目指令及跨 owner revision/generation 一致性仍按后续 W2 实施；当前部分测试通过不能替代 C05/C15 整条。无新增常驻服务或真实模型调用，当前切片等待独立审查。

checkpoint_review 对 `155d932501dbbba29686b24cf0c45b0e52926f2e` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-preferences`；独立 27 PASS，20 个成员的新旧 effort 解析一致，无新 P1/P2。仅批准该提交，不含下一未提交切片。

## W2 线程偏好消费切片（尚未完成 W2）

ThreadStore 的内存实现返回可变记录，工作区捕获现复制该记录，避免等待后观察到另一轮写入。线程 effort/speed 沿用已有 getter，在执行准入时读入同一 binding；实际调用不再等待后重读。读入使用既有 preflightRace 的超时/取消边界，读取失败仍保留原来的继承行为和可见诊断。未新增线程配置存储、getter、版本或通用事务。

新增三反例先 RED：原记录后写污染快照、真实 ThreadStore 准入后修改 effort/speed 导致实际 invoke 收到新值。修复后均 GREEN，且原 F262/F291 的每轮读取、继承及失败诊断四条保持通过。最终集合 `thread-execution-freeze-final.log` 为 182 项=178 PASS+4 FAIL；4 条失败仍是已记录的 AGY Native Windows 出生身份缺口，不计通过。API tsc 通过；新公开测试已确认由 resolver 选中。

本切片解决已准入后的晚读，不宣称 workspace/偏好/账号/MCP 各 owner 之间的读前读后一致性已经完成。下一步继续配置一致性重解析、MCP/ACP/native 启动计划与全局策略冻结。无新增常驻服务或真实模型调用；当前线程切片等待独立审查。

独立审查 `7fe6cdb0f0db1bd1393abd5f6c7db1a372c56e5d` 返回一个 P2：已取消准入仍创建偏好读取 Promise；既有 preflightRace 提前拒绝，未消费的原始 Promise 随后失败，默认 Node 进程退出 1。现于准入入口、workspace await 之后检查取消，避免启动已废弃读取；读取 await 之后也检查取消，不能将取消中的准入报告为 ready。不改全局 race helper，已有在途读取仍由其原处理器消费。

reviewer 独立子进程反例和公开测试的三个时点（准入前、workspace 中、偏好读中）均先 RED 后 GREEN，使用严格 unhandled-rejections 模式；子进程不再崩溃、取消不返回可用 binding。最终 `thread-cancel-green.log` 为 186 项=182 PASS+原 4 条 Windows AGY FAIL，新增取消场景与原线程/诊断场景通过。API tsc 通过，Biome 两文件无错误、20 warnings。证据仍区分真实 Node 子进程与模型调用；本次没有真实模型调用或常驻环境，等待同一 reviewer 复审。

checkpoint_review 对 `87beb72db4b11ad061314ab9e85b8db053f5a3b9` 给出 approved，subject 仍为 checkpoint-thread-preferences；原崩溃反例、三个取消和三个快照场景通过，另外以已注册成员独立验证 effort/speed 两个 getter 的严格拒绝模式取消边界。该 P2 闭环，无新 P1/P2，批准仍限本切片。

## W2 Codex 全局启动策略切片（尚未完成 W2）

现有 codex-cli 解析 owner 增加一次只读捕获，把实际使用的 sandbox、approval、OAuth transport 和 served-model observation 放入既有 binding/options。Host 准入和后台摘要捕获一次；独立内部调用在 Codex 入口、首次异步准备之前捕获。实际 consumer 只用该值，保持既有枚举解析与默认值。任务 read_only、live 和 public native 的强制限制继续优先，不允许被冻结的宽松全局设置扩大它们的权限；不增加配置项、存储或 launcher。

实际最终 argv 反例先 RED：准入为 read-only，后续全局改 workspace-write，旧调用错误采用后者。修复后 native_tool、托管 OAuth 与 read_only 三旅程通过；最后的注册成员夹具为 `codex-policy-final-targeted.log` 3 PASS，验证 sandbox/approval、传输 provider 参数及 RUST_LOG 观测开关。受影响 L0/后台/原生继承/served-model 两载体共 37 PASS，`codex-policy-green.log`；扩大 Codex/config 回归共 123 项=122 PASS+1 已登记的 POSIX 缓存根断言 FAIL，`codex-policy-regression.log`。API tsc 通过；新测试公开 resolver 可发现。

这不是所有全局配置或 ACP/MCP 启动环境已冻结的声明；各 owner 的一致性重解析、MCP/项目指令及实现 generation 仍待继续。无真实模型调用或新增常驻服务，本策略切片等待独立审查。

checkpoint_review 对 `fa1a82a14b209cf7c20fe625c73d40c3b6019221` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-codex-policy`；独立 23 PASS，包括内部调用首次等待后保留原 sandbox/approval/HTTPS/tracing，权限优先序保留，无新 P1/P2。仍只批准本切片。

## W2 ACP MCP 计划消费切片（尚未完成 W2）

AgentService 增加限定的 Host 配置捕获端口；现有 AcpAgentService 复用原 resolver，在准入时读取 capabilities、用户项目 `.mcp.json` 及验证过的插件 MCP 视图，返回独立描述符。原执行 binding 深冻结该计划，RegisteredSessionAgentService 和池的已钉住视图转发同一具体实现的捕获端口；正式 serial/parallel 入口保留原 ownerAuthProvenance 和成员 exposure scope。直接内部 ACP 调用也在池租约之前捕获，不再等待后重读。

MCP 描述符与每轮 callback 认证分开：仍在既有 session owner 获得所有权之后绑定当前轮凭据和刷新文件。配置解析失败不启动客户端池租约；捕获阶段取消沿用既有 preflightRace 并消费在途 Promise。该端口不启动模型、不改变插件 manifest 或 MCP 语义/权限 owner。

两个实际 consumer 反例先 RED：修改 capabilities 或项目 `.mcp.json`，租约之后的 session/new 收到新参数。修复后四条旅程覆盖这两种来源、正式插件 ACP 实现桥接、插件 MCP 的当前 Host 激活视图；准入后及租约中两次改写不污染原计划，普通 catalog 不能替代本次已验证的插件启动。新捕获过程中的取消以已注册成员、严格拒绝模式的独立 Node 子进程验证；成员 registry 在异步 MCP 捕获期间变化也被现有冲突门禁拦截。

| 本切片验证 | 实际结果 |
|---|---|
| 四来源冻结 + 四时点取消 + 线程偏好 + 认证轮换/空响应 | 27 PASS，`acp-mcp-freeze-credential-final.log` |
| 通用 ACP/iCode/MCP resolver/插件视图/Host 能力/池 pin | 155 项=150 PASS+5 FAIL；5 条在 Windows runner Temp 父级 ACL 处先失败，`acp-mcp-freeze-regression.log` |
| 上述 5 条纯池归属夹具的独立执行 | 既有显式 trusted-host 测试模式下 5 PASS，`acp-mcp-owned-lease-fixture.log`；未改变产品默认值，不能证明 strict ACL 实机通过 |
| invocation/L0/异步成员冲突/四来源 | 184 项=180 PASS+4 已记录的 AGY Native Windows FAIL，`acp-mcp-invocation-final.log` |
| 类型 | API tsc 与 Web tsc --noEmit 通过；新 `.test.js` 公开 resolver 选中 |

注册插件的新夹具最初缺 invocationId 而超时，已补真实调用必需字段，并用完成结果与租约门槛的 race 提前报告夹具错误；早期超时日志保留，不计通过。复杂度复核：复用现有 resolver、binding、AsyncLocalStorage 视图与凭据 owner，仅新增一项 Host 捕获端口及描述符载体；没有新存储、队列或 launcher。map delta 为 identity-session 的运行消费锚点和 mcp-surface-governance 的原投影消费说明，owner 不变。

尚待：其他原生客户端的 MCP/项目输入冻结、配置写入通知及各 owner 的读前读后一致性重解析、实现 generation、会话兼容与最终平台/工程任务验收。无真实模型调用或新增常驻服务；当前 ACP MCP 切片等待独立审查。

checkpoint_review 对 `8f852771c1e4aeca4dd6a27675c02466254325cb` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-acp-mcp`；独立 24 PASS，覆盖 strict/unknown owner、外部项目、blockedCats 暴露策略和捕获后绑定当前凭据，无新 P1/P2。批准仍限该 ACP 描述符切片，其他环境变量引用与原生客户端配置仍须继续。

## W2 Claude 原生 MCP 消费切片（尚未完成 W2）

原 native MCP resolver 分为读取现有配置计划和绑定本轮凭据两个阶段；计划继续使用原服务器格式，记录已经验证的插件服务器来源。正式准入借用同一 Host 捕获端口，Claude print、SDK、后台、PTY 和回退包装器消费该计划。插件普通环境引用在捕获时解析，回调 transport 环境在启动时绑定当前轮；不把本轮 token 放入准入计划。read_only 的准入与启动都跳过 MCP 工具发现，serial/parallel 入口传递既有工具策略，不增加策略 owner。

五条真实消费边界反例先 RED：capabilities、项目 `.mcp.json`、当前插件激活、回退包装器和 SDK 读取准入后新值；修复后 GREEN，另加后台最终 argv、PTY 驱动参数与只读对照，`native-mcp-carriers-final.log` 8 PASS。这里的“真实消费边界”使用实际 Host/carrier/resolver 配合 fake spawn/driver，不代表真实 Claude 模型或 PTY 会话验收。插件场景还验证环境引用保留旧值、callback 使用当前轮值。最初夹具缺模板、SDK 误读保留为空的 sdkOptions.mcpServers 和后台 mock 等待错误事件，均修正后重新取证；早期失败日志保留，未计行为 RED 或通过。

扩大回归 `native-mcp-regression-final.log` 为 209 项=208 PASS+1 FAIL，涵盖既有 Claude/MCP 合并、carrier fallback/health、插件视图、Kimi 原生解析与 SDK。剩余 Kimi shared HTTP 测试使用 URL.pathname 作为 Windows 程序路径，`native-mcp-path-witness.log` 确认该路径及 collab.js 不存在，fileURLToPath 后存在；未改该测试或产品默认值，仍记 FAIL。首轮回归缺公共 registry 预加载已纠正，首轮结果不计有效回归。API tsc 通过，Biome 14 文件无错误；factory 只增加转发端口，不重排原文件格式。新增公开测试受 public resolver 覆盖。

复杂度复核：复用原解析规则、原 native server 格式、原冻结 binding 和 transport 凭据绑定；仅拆出确需复用的计划/绑定两阶段，不增数据库、配置 DSL、通用 launcher 或插件权限层。map delta 仅增加现有 consumer 锚点与消费说明。其他 native MCP、完整环境/策略/项目输入、owner revision 一致性重解析及 implementation generation 仍待继续，C05/C14 整条未完成。本次无真实模型调用、新增常驻环境或持久业务数据改写；本切片等待独立审查。

最终计划显式 structuredClone 后再交给深冻结 binding，避免冻结借来的 Host 视图对象。受影响凭据/取消/L0/ACP/Claude 集合 `native-mcp-freeze-credentials-final.log` 为 38 项=35 PASS+3 FAIL：两条既有 hook 测试硬编码 `/bin/bash` 在 Windows ENOENT；一条凭据文件测试把 POSIX mode 0600 作为 Windows ACL 证明而得到 0666。未修改这些测试或降低权限要求，均不计通过；当前轮凭据轮换和冻结反例通过。这些夹具失败不能替代 Windows ACL 的真实验收。

checkpoint_review 对 `e241747ae71c202b7846c3516651014fea6aa299` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-claude-mcp`；独立 25 PASS，补验真实内置 MCP 的当前轮 HTTP 凭据、材化不修改计划、插件环境不重复展开及 strict/unknown/只读边界，无新 P1/P2。批准限该 Claude MCP 切片。

## W2 配置捕获与账号环境顺序切片（尚未完成 W2）

Kimi 的原生 HOME 依赖所选账号环境，而旧捕获端口早于账号解析。现先调用原账号冻结 owner，再把同一绑定的 accountEnv 和成员 mcpSupport 交给 provider 捕获；仍在既有成员 revision/取消门禁内。F171 原环境过滤逻辑从实际 invoke 前移到冻结 owner，后续 invoke 直接消费同一投影；模板映射与 callback 权限分离、空字符串、非法 key 和 CAT_CAFE_ 过滤均保持原规则。原 deepFreeze 供准入的最后组装复用，不重新解析账号，不新增配置存储或解析框架。

反例先 RED：provider 捕获得不到账号 HOME，捕获期间账号文件变化使后续绑定采用另一份账号配置。修复后同一账号 HOME、普通环境、成员 MCP 开关均保持准入值，实际 invoke 消费一致；过滤不修改原 account projection。`account-environment-consumer-final.log` 1 PASS；扩大 `account-environment-green-regression.log` 231 项=227 PASS+4 原 AGY Native Windows 出生身份 FAIL；API tsc 通过。这里只把既有账号环境连接到捕获端口，Kimi 原生配置计划、全局 ambient env、各 owner revision 一致性与重解析仍待继续；无真实模型调用或新增常驻环境，等待独立审查。

checkpoint_review 对 `6c34051ee463c9dfc7b8e1cb7c1aa0bd2579378d` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-account-environment`；独立 44 PASS，补验 native_tool 不读取应用账号库，以及缺有效凭据的托管账号在 provider discovery 前失败，无新 P1/P2。批准限该账号环境顺序切片。

## W2 Kimi 原生 MCP 消费切片（尚未完成 W2）

Kimi 复用现有 native MCP resolver 和项目配置借用 owner，在准入时捕获允许服务器、成员 MCP 开关、原生 HOME、Git 项目根及拒绝层路径。实际 native 读取、secret hooks、MCP 文件和最终 spawn 都使用同一 HOME。既有显式关闭 Host 注入模式仍不借用项目文件；关闭成员 MCP 则仍覆盖并拒绝所有原生层，不能被随后成员配置变更绕过。未创建第二 HOME、认证库、launcher 或通用版本框架。

Kimi 无法完全关闭原生自动发现，因此启动前仍读取下层配置以补充拒绝项：未知/新增原生工具只能被禁用，不能加入允许集合或替换已准入参数；使用计划副本，不污染冻结对象。Git 根变化时在写入项目文件前明确拒绝。原文件备份、独占锁、改动冲突保留和凭据清理沿用既有 owner。此处的负向收口读取不作为可变配置的允许回退。

五个原反例 `kimi-mcp-red-consumer.log` 先 RED：capabilities/项目参数晚读、MCP off 晚读、原生层变化伴随允许参数晚读、显式关闭注入时 HOME 未钉住。最终新增实际 invoke 与 Git 根变化两场景，`kimi-mcp-consumer-final.log` 7 PASS，验证最终 MCP 文件/进程环境和租约恢复，仍使用 fake spawn 而非模型。首轮对原生层变化的临时拒绝断言未作为最终方案；最终使用既有“未知工具拒绝”规则，既保持冻结允许项，也允许任务继续。

扩大回归发现并修复三个真实凭据回归：原 resolver 对内置 split 入口的环境绑定不能只依赖最后一个安装路径校验器。现由原 isManagedCatCafeSplit/本机 fallback 解析分支记录入口来源，启动时按原规则绑定当前轮凭据；外部同名服务器不因名字获得该权限。Kimi 凭据文件材化仍去除 inline token，并保留 caller-owned 文件。`kimi-mcp-callback-green.log` 25 PASS（实际原生 MCP 握手与凭据恢复、七条 Kimi、八条 Claude）；API tsc 通过，7 文件 Biome 无错误，公开 resolver 选中新测试。

最终 `kimi-mcp-regression-final.log` 189 项=186 PASS+3 FAIL：一条既有 Kimi shared HTTP 测试的 Windows URL.pathname 问题；一条 hook 测试的 POSIX mode 断言；一条旧 hook 测试期待拒绝本地 ReadFile/WriteFile，而基线 F333 native-secret-policy 仅约束识别出的外发 shell 操作。`kimi-secret-policy-witness.log` 和基线 diff 确认策略/该测试均未由本任务修改，不把旧预期改成通过，也不恢复已经移除的策略。复杂度复核与 map delta 均限现有 native/MCP/凭据 owner；无新服务或真实模型调用。其他 native MCP、完整 env/策略、跨 owner 一致性重解析、generation、会话兼容与整体验收仍待继续；本切片等待独立审查。

独立审查 `a1fae7d67d33c7be0d868bf7b06c7c2af7dba06d` 发现 P2：普通对象的 `__proto__` 赋值丢掉原生 MCP 拒绝项。最初 0.34 loader 会过滤该名称，不能证明真实后果；reviewer 进一步获取方案所引的 Kimi 2.2 提交 `472192c34c1efad89a369870eff0da0b708ce9bb`，直接执行其 `packages/agent-core-v2/src/app/mcpConfig/configLoader.ts`，证明该名称被保留，缺拒绝时 enabled 非 false；同版连接 owner 据 enabled 判定是否启用，P2 因而成立。源文件、loader 映射与独立反例保留在 reviewer artifacts，未将不同版本的结果混为一谈，也未启动模型。

现仅在原拒绝函数以 Object.defineProperty 创建可枚举自有项，恢复原 map 对特殊名称的语义；捕获与启动补拒绝两处共用。两条公开反例分别覆盖准入前已有及准入后新增名称，`kimi-mcp-prototype-red.log` 先 RED；修复后 `kimi-mcp-prototype-green.log` 51 项=50 PASS+原 Windows URL.pathname FAIL，API tsc 通过，未改变 MCP 策略或验证门槛。修复等待同一 reviewer 以原 2.2 实际消费者复审。

checkpoint_review 对 `30ebd15fd8d2fd49069f289536d54650a866949d` 复审确认上述 2.2 effective 拒绝反例 GREEN；另返回 P2：嵌套 cwd 的可选 `.mcp.json` 被无条件纳入 strict 拒绝层，损坏 JSON 阻断准入，原基线与实际 2.2 均会忽略该非原生发现层。现恢复原 `mcpSupport === false` 纳入条件，未新建宽松解析或绕过权限。两条公开反例分别在准入前损坏、准入后变损坏，先 RED，修复后冻结允许项仍保持原值，原生 HOME/根目录拒绝继续生效。`kimi-mcp-nested-green.log` 53 项=52 PASS+原 Windows URL.pathname FAIL，API tsc 通过；等待同一 reviewer 对新提交复审，无真实模型调用。

checkpoint_review 对 `5b7d3297d7819bab827fa85a1b2f88c0f53e64d7` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-kimi-mcp`；两条 P2 均闭环，独立 14 PASS，涵盖真实 2.2 loader、基线、准入后变化、实际 Kimi 调用和 Claude 共用 materializer。批准限该 Kimi 切片，无未关闭 finding、真实模型调用或遗留测试租约。

## W2 OpenCode Host MCP 消费切片（尚未完成 W2）

OpenCode 的 MCP 运行配置继续由原 Host writer 生成，不强行搬进 AgentService。现从 writer 提取可复用的无落盘 MCP 捕获阶段，保留原 capabilities/Pencil/项目 opencode.json 合并规则和原格式；准入在同一插件激活与成员 exposure scope 下捕获独立计划及 MCP 二进制入口。原 binding 深冻结该计划，后续 writer 只消费其副本，模型、认证、L0/额外指令和 guard 仍由原 owner 材化。直接内部 writer 调用仍在自己的入口捕获；不增 provider 接口、存储、launcher、版本总线或配置 DSL。

三个实际 Host→writer→OpenCode launch 反例先 RED：capabilities/项目 opencode.json 晚读、插件读取普通 catalog 参数。首次夹具虚构 PID 被真实 Host liveness 判断为死进程，产生迟到 mock 输出错误；修正为无 OS PID 的内存 fixture 并断言返回文本，再在未修改的 HEAD 源码上重新执行，`opencode-mcp-red-verified.log` 为 3 FAIL，均在实际参数断言失败、没有异步夹具错误。任务源代码补丁曾临时保存在本任务 artifacts，并原样恢复；首个 CRLF 补丁检查失败未修改源码，相关日志不当作基线证据。新计划的参数和普通环境、MCP 路径均保持准入值，材化不修改原计划；最终四场景均实际消费模拟输出，未调用模型。

扩大回归 `opencode-mcp-regression-final.log` 为 212 项=208 PASS+原有 4 SKIP（公开 checkout 无本地 OpenCode 配置，未新增 skip）。两处旧夹具已最小修正：default-workspace 成员补合法 relationshipKey，使真实路由/默认工作区旅程继续进入 provider；路径断言规范化分隔符以验证 Windows 路径。未降低角色身份检查或产品路径要求，`opencode-mcp-portable-fixtures.log` 74 PASS；原失败结果保留。Host 调用扩大集合 `opencode-mcp-invocation-final.log` 184 项=180 PASS+原 4 AGY Native Windows 出生身份 FAIL。API tsc 通过，6 文件 Biome 无错误；旧文件只归一化换行，逻辑 diff 仍是上述两处夹具修改。

复杂度复核：无新增全局事务或配置框架，两个实际调用方共用一次 MCP 解析，原 Host 仍拥有 OpenCode 启动配置。map delta 仅增加现有 consumer 锚点与说明。此切片不宣称已冻结所有原生自动发现/外部规则、完整 env/策略/账号读取一致性和 implementation generation，也不等于完整 W2/W4、工程任务质量或最终发行物验收。无新增常驻环境或真实模型调用；当前 OpenCode 切片等待独立审查。

checkpoint_review 对 `0df53ed32d973f7698b161f9c7b110eaadd7c666` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-opencode-mcp`。独立 77 PASS，涵盖 Host 实际消费、直接 writer、材化不修改计划、激活范围、取消和成员变更；无未关闭 finding。批准限该 OpenCode 切片。

## W2 Codex MCP 输入消费切片（尚未完成 W2）

沿用原 Codex MCP 解析规则，准入捕获 capabilities、成员/插件激活视图、Pencil、命令/参数/工作目录、普通环境与 HTTP Bearer 引用。实际消费者渲染 Codex 原生 TOML，保留禁用形状、内置 split、名称转义、Bearer 变量和 workspace 规则。一次性 env wrapper 仍在每次 launch 创建；冻结 wrapper 文件会在第一轮自清理后失效，因此只冻结输入，当前轮凭据由原 binder 材化。直接内部调用在首次异步准备前捕获；只读、plugin_native 和 live 路径保留各自边界，不引入普通 MCP 捕获。原 Codex 全局策略捕获顺序不变。

`codex-mcp-red.log` 三个反例先 RED，最终实际 exec_json launch 参数保持 capabilities/HTTP Bearer/插件准入值。插件场景额外启动真实 MCP 子进程并调用工具：同一冻结计划连续两轮，各自创建新 wrapper，保持普通环境且读取各自当前凭据；计划本体不变。`codex-mcp-consumer-final.log` 为 33 PASS，包含上述消费者、策略、实时启动/生命周期/MCP、配置覆盖和项目兼容；API tsc 通过，6 文件 Biome 无错误，未调用真实模型。

扩大回归 `codex-mcp-regression.log` 为 171 项=153 PASS+18 FAIL。为核实来源，将本次四个已修改源码的精确补丁保存在任务 artifacts，暂时反向应用并编译未修改的 HEAD，重跑对应三个旧测试文件；`codex-mcp-platform-baseline.log` 为 127 项=109 PASS+相同 18 FAIL。它们来自 Windows 连接池关闭后的直连、public 原生私有 workspace 检查和 POSIX cache 路径断言。随后原样恢复补丁并重新编译，再完成上述 33 PASS；不把基线失败当通过，也未为测试放开产品隔离检查。

复杂度复核：保留原解析与材化 owner，只把有两个真实调用方的捕获逻辑移到同目录模块；原大类减少代码，新增模块小于 200 行，无 launcher、配置总线、认证库或通用适配 DSL。map delta 只补现有消费边界。完整 env/原生自动发现、一致性重解析、写入通知、实现 generation 和会话兼容仍待继续，W2/C05/C15 仍未整体验收。此 Codex 切片等待独立审查。

独立审查 `656d611ae96d0d7ec39900e6e12a4fe14d4e2f16` 返回 P2：routeSerial 准入漏传 liveCompanion，导致 Live 错误捕获普通 MCP。公开路由反例 `codex-live-admission-red.log` 为 2 RED，首成员报 execution_binding_unavailable。现仅补与实际 invoke 相同的首成员条件，不给后续成员传播 Live 标志。最初夹具修完该点后又触发原 Host shared MCP 读取；为隔离新增捕获回归，最终夹具将首成员设 mcpSupport=false，第二普通成员保持 true，分别证明 Live 能进入真实路由消费者、普通成员仍校验缺失配置。原 shared 读取未由此修改，仍纳入后续 W2 输入清单；两条不同失败不混为同一修复。

`codex-live-admission-green-isolated.log` 38 PASS，含实际 routeSerial 两场景、Codex 冻结/真实 MCP、策略、Live 启动/生命周期/MCP 和存量 live carriers。API tsc、两文件 Biome 通过，无真实模型或新增服务。此 P2 修复等待同一 reviewer 独立复核。

checkpoint_review 对 `136528bcb27dc52c547f5fe52e766eed08d2ae35` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-codex-mcp`。Live 准入 P2 闭环，独立 7 PASS，包含首成员/普通后续成员、两轮真实 MCP wrapper/凭据、特殊名称、禁用 HTTP 与 Pencil；无未关闭 finding。只批准 Codex 切片。

## W2 Host shared MCP 上下文消费切片（尚未完成 W2）

将原 prepareSharedMcpLaunch 移到准入的同一成员/插件 scope，捕获 transport 及原 SharedInvocationContext；不新增解析规则或启动器。Host invocation 注册与 callback 凭据材化消费同一深冻结对象，不在准入后读取部署、数据目录、工作目录、允许目录或成员工具范围。原 cloud-only、成员 MCP off、read-only 排除条件保持；原请求认证/撤销校验不变。快照缺失明确拒绝，不回落到磁盘/当前环境。

`shared-mcp-freeze-red.log` 两条真实 Host 消费反例先 RED：准入后修改普通配置时注册了后来的部署/目录/范围；配置变损坏时消费者抛错。修复后两条均通过，实际 registry.create 和 provider callback 使用准入值。`shared-mcp-freeze-green.log` 联合 45 PASS，覆盖全部已迁移 ACP/native MCP、L0、线程偏好、账号环境及 Live 路由；API tsc 通过，相关 8 文件 Biome 无错误。五个原先只测局部准入的夹具补必需 apiUrl，最初 Invalid URL 失败保留在 green-first 日志，不给产品加测试专用 fallback。

扩大 `shared-mcp-freeze-regression.log` 314 项=309 PASS+4 原 AGY Native Windows birth-identity FAIL+1 原 Redis SKIP，覆盖实际串并行路由、元数据、invoke 及共享 MCP 认证/撤销/载体/ACP/工作目录/成员 owner。已存在的 AGY 出生身份检查不放宽，不把 skip 计通过。

复杂度复核：只将一次既有读取提前并保存到已有 binding，准入函数/原 shared owner 继续各司其职；没有 revision bus、会话库或通用 launcher。跨 owner revision/generation 重解析、所有配置写入通知、原生自动发现及完整 env/实现生命周期仍未完成。无模型调用或新增常驻环境；此 Host shared 切片等待独立审查。

checkpoint_review 对 `8f3e191c303e18283604c4d5f960a331b87de3af` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-shared-mcp`。独立 12 PASS，覆盖跳过路径、并发工作目录隔离、真实 registry 防修改、取消及快照实际消费；无未关闭 finding。批准限此 Host shared 切片。

## W2 capabilities 写入通知切片（尚未完成 W2）

审计 API 内 capabilities.json 的合法写入：HTTP 安装/删除/开关、插件静态资源、初始化/迁移、挂载规则、项目 MCP sync/drift 和 skill sync 均委托原异步 writer；新成员同步继承委托原同步 writer。governance cleanup 明确保护该文件，没有将诊断或派生 CLI 文件当作真相源写入。

独立审查指出，作者最初 scripts 搜索只筛 mjs/ts/cjs，遗漏 `scripts/sync-skills.sh:292` 的直接写方：它合并 skillsSync 后直接 writeFileSync(capFile)，并不经过中央 API writer。已回读原文确认，该跨进程/离线写入仍未补通知，不能声称“全部合法写方已覆盖”。当前尚未建立依赖 capabilities 事件的 revision/cache 订阅者，不为此新建 IPC 或假装能向另一个进程的 EventEmitter 发通知；后续一致性核验与缓存切换必须覆盖此写方或明确收口其离线边界。health/doctor 读取与此真实写方分别记录。

现在两个原子 writer 仅在 rename 成功后向既有 configEventBus 发 capabilities domain 事件，changedKeys 为规范化项目根，沿用 changeSetId/timestamp；不带正文、env 或密钥。同步/异步共用一个短通知函数，避免两个真实写入点漂移。事件不冒充 env file-scope，避免触发 VAPID 等无关键的重载；不增加新 bus、watcher、revision 数据库或缓存切换。

`capabilities-notification-red.log` 三个真实写入反例先 RED：普通异步、成员同步继承、实际项目 sync 均无通知。修复后在通知回调中直接读取已提交文件，确认对应状态已落盘；读取、无变化继承和实际写失败没有新通知，事件不泄露夹具 secret。最终 `capabilities-notification-final.log` 109 PASS，覆盖上述三旅程、原 event bus、写锁、正式 MCP HTTP 写入、挂载、项目 drift/sync 及 shared 快照；API tsc、3 文件 Biome 无错误。

扩大首次集合 `capabilities-notification-green.log` 165 项=154 PASS+11 FAIL，均在 capabilities 读路由。将仅本次两个源码文件的补丁保存在 artifacts 并暂时反向应用，编译未改 HEAD 后单独复跑该文件，`capabilities-notification-route-baseline.log` 89 项=78 PASS+相同 11 FAIL；包含 config_missing、挂载健康与读时发现/路径重写的旧预期，未在本任务中逐一诊断或放宽。随后恢复原补丁并重新编译，完成上述 109 PASS。基线源码差异/原日志保留，不把旧失败计通过。

复杂度复核：实现增加的是一个既有事件 source、两个提交点和共用短通知，没有将无关的账号/成员写入合并成事务。其他配置族的写入通知仍须按真实 owner 审计；跨 owner 读前读后核验、重解析、generation 和会话语义继续未完成。无模型或常驻服务调用；当前通知切片等待独立审查。

checkpoint_review 对 `52ad776284536bd8eaa93d847e271d478d51c604` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-capability-notification`。独立 19 PASS，含原子 rename 失败、相对根规范化、每次提交唯一 ID、观察者异常隔离及实际账号/成员/VAPID 订阅者隔离；最终提交仅修正文档审计范围，产品未变。跨进程脚本缺口继续保留，不将此批准当作所有写方或完整 W2 验收。

## W2 实现 generation 准入切片（尚未完成 W2）

现有实现 registry 的注册 entry 增加进程内 generation token；现有 AgentRegistry 同目录维护具体服务对象的弱引用 token，InvocationServiceScope 给调用视图继承原服务 token，避免每次 pin 都冒充实现替换。RegisteredSessionAgentService 将原注册/服务 fence 提取为两个真实调用方共用的检查，暴露捕获的 key/generation，并在正式准入读取前后验证同一绑定。注册或实际服务在异步捕获期间变化时，准入返回可重试 409，不等到模型启动后才发现。binding 保存自有冻结投影；不存回调 token、账号 secret、原始 env 或模型能力断言。

该 token 表示本进程的实现/服务代次，不是 CLI 版本或持久兼容键；不能拿它证明跨重启 resume。原生 key 使用显式 clientId 和已声明的 carrier，缺声明保持 unknown，不从命令/模型/类名猜测。已有原生/ACP 租约、注册式启动 fence、禁用/升级释放和高级操作路径保持原语义；不会据此宣称已解决升级后旧片段继续执行或完整 C15。会话兼容键、版本证明与生命周期仍归后续 W3/W4。

`implementation-freeze-red.log` 三条正式准入反例先 RED：捕获期间实际服务 revision 变化、实现注册替换均未被准入发现，原生 pin 也没有身份投影。修复后注册/服务变化明确 409，下一次新视图捕获新 generation；同一原生服务的不同 pin 保持同代次，实际替换获得新代次。`implementation-freeze-consumers-final.log` 105 PASS，覆盖注册/插件生命周期、高级能力与旧启动 fence、真实 ACP provider、L0、线程偏好及已迁入的所有 MCP 消费路径；API tsc 通过，8 文件 Biome 无错误。

`implementation-freeze-invocation-final.log` 289 项=285 PASS+原 AGY Native Windows birth-identity 4 FAIL。首轮 `implementation-freeze-green.log` 65 项=60 PASS+原 strict ACP Windows bootstrap ACL 5 FAIL，错误在 factory 准备目录时即因父目录其他 SID 的 Modify 权限而出现，bootstrap 实现未改。单独进程设置仓库已有 trusted-host 模式后的 `implementation-freeze-pool-process-only.log` 5 PASS，仅证明原 pool pin/reset/replacement/release 路径，不认证 strict ACL，不改变用户/生产设置，也不新增 skip。

复杂度复核：一份弱引用 token 表、原 registry entry 的 token 和原校验函数共用，无新服务/版本总线/launcher/持久模型。此 token 尚未接入原生片段兼容或持久审计，不把绑定投影当作完整接线。所有 owner 的一致性重解析、其他通知、完整 env 和会话语义仍继续未完成；无真实模型或常驻环境，此 generation 切片等待独立审查。

checkpoint_review 对 `236dc8756b1ed17a02a54e18e21a7fc122df58a0` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-implementation-generation`。独立 56 PASS，含注册/实际服务变化、pin 稳定性及原启动 fence/插件生命周期/释放；无未关闭 finding。只批准该进程内准入切片，不证明持久兼容或跨重启 resume。

## W2 账号与启动策略读后核验切片（尚未完成 W2）

异步 provider/MCP 捕获后，使用原 freezeExecutionAccountBinding 再读取同一账号/执行投影；实际消费值变化时返回可重试 409，防止准入期间合法账号写入或 S3 全局策略修改被遗漏。不另建 revision/hash 框架，也不记录 raw profile/secret 到审计或兼容键。原 runtime resolver 排除的额度元数据仍不成为新的执行输入。已完成 binding 后的正常修改仍不污染活动调用；源码只增原 owner 的读后比较。

新 `account-currentness-red.log` 为 3 项=2 RED+1 初始控制项 PASS，两个 RED 分别经正式 writeCatalogAccount 和 configStore.set 修改账号 HOME/Codex sandbox，原准入均未拒绝。控制项最初 quota 夹具不符合既有 schema；第二次读取真实触发严格校验后，首次 green 为 51 PASS+此夹具 FAIL。现按既有 schema 补 source/items/status，不改产品验证，`account-currentness-green-final.log` 52 PASS，包含合法元数据控制项和所有已迁入的冻结消费者。

旧环境一致性正例将写入时机从 capture 内移到 binding 已完成之后，继续验证 discovery 与真实 invoke 使用相同旧 HOME；准入期间变化由新增负例明确覆盖，并非删除该时窗的断言。`account-currentness-native-final.log` 17 PASS，涵盖实际原生消费者、账号绑定、事件订阅与正式保存诊断；`account-currentness-invocation-final.log` 289 项=285 PASS+原 AGY Native Windows birth-identity 4 FAIL。API tsc、3 文件 Biome 无错误，无真实模型或新增服务。

复杂度复核：复用同一已有解析 owner，新增 13 行内联比较，不增加存储、环境配置项、watcher、启动器或认证路径。当前变化仅明确拒绝不一致准入，尚未自动重新解析；MCP/工作区/全局输入的全 owner 读前读后版本协议、持续变化冲突处理、通知完整性及会话兼容仍未完成。不能以该保护或局部通过替代完整 W2/C15；此账号 currentness 切片等待独立审查。

checkpoint_review 对 `cd81df15458fa51a00835ffdf018d42007b0b40d` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-account-currentness`。独立 73 PASS，含实际来源双读、凭据轮换、删除/损坏/孤立凭据拒绝、元数据控制、原生继承与冻结后变化；无未关闭 finding。自动 reparse、其他 owner 和完整 W2 仍未完成。

## W2 后续成员出队服务刷新切片（尚未完成 W2）

原 AgentRouter.refreshFromRegistry 会替换 services/unavailableServices 对象，已取得策略依赖的串行路由仍持有旧对象。第一个成员运行期间更新实现后，后续尚未准入成员会继续用旧服务，或者拿不到最新不可用原因。现仅原地更新 Router 自有两张表，保留同步发布；已 pin 的 invocation 仍持有原服务引用，后续成员在自己的出队边界读取当前表。没有新缓存 owner、轮询或发布协议。

`router-refresh-inflight-red.log` 两条实际 AgentRouter→保留的 getStrategyDeps→routeSerial 旅程先 RED：暂停第一成员、更新 registry/router，再恢复执行，第二成员仍调用旧服务。修复后，第一成员跨刷新继续旧输出，第二成员使用新服务，或明确展示新的不可用原因；新第一服务没有接管活动调用。

首轮 `router-refresh-inflight-green.log` 250 项=249 PASS+1 FAIL。失败为旧 non-native-L0 断言只匹配 `## 协作\n`；`router-collab-newline-witness.log` 实际消费者见证 LF=false、CRLF=true、章节为 `## 协作`，证明确有完整章节，只是 Windows 模板换行。删除临时诊断，仅该断言规范化 CRLF，其他身份/A2A/决策树断言不变，产品提示词不变。最终 `router-refresh-inflight-green-final.log` 250 PASS，无新增 skip，含实际刷新旅程、完整 Router/提及解析/正式策略依赖、权限接线、串并行策略、元数据和 generation；API tsc 通过，三个相关文件 Biome 无错误，旧夹具逻辑 diff 仅一行。

复杂度复核：原类 6 增 4 删，维护既有表的对象身份；不改变当前 turn 的绑定、不重新发送消息、不新建运行实例。此修复不证明 catalog 与 service 发布的全部中间状态已消除，服务/成员 client 身份匹配与全 owner 一致性重解析仍须继续；无真实模型调用，此 Router 切片等待独立审查。

checkpoint_review 对 `da57a4c999b567da651ccf104203c1d268267c2b` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-router-refresh`。独立 135 PASS，含留存/浅复制 deps、后续成员替换/不可用/恢复、旧诊断清除与活动调用原绑定；CRLF 断言修改保留原行为检查。无未关闭 finding，仍不证明完整发布一致性或自动 reparse。

## W2 Codex/ACP 构建 client 身份切片（尚未完成 W2）

先覆盖 Codex 原生与现有 ACP 两条纵向链：Codex 由具体实现显式声明原 clientId；ACP factory 在异步准备前捕获构建输入的 clientId，随原内部配置传给服务，不从 providerName/model/command 猜测。implementationSnapshot 增加该可选来源字段；注册包装器保留子实现的来源及 generation，外层仍保留自己的注册 key。正式准入在工作目录、账号和 provider discovery 前核对成员与已准备服务的 clientId，不一致明确 409。没有新增插件声明字段或可执行能力，没有把 CodeAgent/iCode 识别混进命令子串。

这证明的是 Host 的构建来源对应关系，不是远端 CLI 自认证、模型能力或实际模型身份；clientId 仍采用现有 schema，不另建身份命名系统。只覆盖已接线的 Codex/ACP；其他原生客户端和没有本地 Host service 的协议 provider 仍分别保留未知/原边界，不宣称全平台或全部客户端已验收。实际二进制/adapter 专属能力及版本仍须按 W4/W5 的证据验证。

`client-identity-red.log` 四条实际 Codex/ACP/注册包装器反例先 RED：错配未拒绝，显示标签对照没有构建身份投影。修复后错配在 discovery 前拒绝，普通显示标签含 codex/icode/codeagent 也不改变实际声明来源；`client-identity-green.log` 联合 80 PASS，含正式准入、已迁入 MCP、L0、线程/账号/currentness、策略及真实 ACP provider/高级操作。`client-identity-library-regression.log` 50 PASS，覆盖插件激活/禁用/替换、库选择、路由及原生偏好；最终 API tsc 通过，9 文件 Biome 无错误。

真实 production ACP factory 的原租约夹具构建 clientId=acp，但 Host policy 场景仍声明 OpenAI，新的更早身份拒绝使旧 policy 断言没有进入目标阶段。现仅给两个正式 Host 场景声明匹配/故意错配的成员来源；新增 factory→准入负例验证 factory 接线，未删除错配约束。最初把 native_tool/fixture model 设置扩到纯 pool 测试，暴露 Fake client 不提供 model 配置选项，`client-identity-pool-diagnostic.log` 证实原因；随后缩回正式 Host 场景，纯 pool 原夹具和完整断言保留，并补错误诊断。

`client-identity-factory-process-only-final.log` 6 PASS，含原 pin/reset/replacement/release/policy refusal 与新增真实 factory 身份拒绝。该单独进程沿用此前既有 trusted-host 模式，仅验证流程，不认证父目录 strict Windows ACL，不改用户/生产设置、不新增 skip。首轮构建的常量作用域错误已由 TypeScript 抓出并改至真实 factory 入口；最终日志为 `client-identity-tsc-final.log`，没有在构建失败后运行依赖测试。

复杂度复核：产品改动复用既有 snapshot/registry，增加一项类型化来源和两个实现的声明/传递，不新增注册系统、认证库、launcher 或通用客户端 DSL。不据此宣称成员/服务全发布原子性、自动 reparse、其余客户端迁移或会话兼容已完成；无真实模型或新增常驻环境。

checkpoint_review 对 `0700400b913e1a6b1b9a96ec4aa13c88a839f987` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-client-identity`。独立 46 PASS，覆盖更早拒绝、legacy unknown、注册包装器子 generation 和真实 factory 租约；factory 检查仅用进程内既有 trusted-host 模式，不认证 strict ACL。无未关闭 finding，批准只限 Codex/ACP 构建来源切片。

## W2 配置冲突的有界准入重解析切片（尚未完成 W2）

正式串行/并行路由只对 Host 自有 ExecutionAdmissionConflict 在模型调用前重新准入一次。第一次失败先释放原 pin，再从当前 Router 表解析服务、取得新 pin、完整重做原捕获；成功后实际 invoke 消费新服务与新 binding。第二次仍变化则输出 execution_binding_conflict。普通带 409 的错误、取消、释放失败与 provider 执行错误均不重试；模型发送在该 helper 之外。原 prepareInvocationExecutionBinding 仍是单次捕获，两个正式路由是它的生产调用方。

`admission-reparse-red-final.log` 的串并行实际 Host 反例 12 项=4 PASS+8 FAIL；第一次修复后 12 PASS。增加公开冲突码断言后 `admission-reparse-conflict-red.log` 再现 2 FAIL，修复路由错误投影后最终 `admission-reparse-routing-final.log` 274 PASS。覆盖一次变更后消费最新 sandbox、连续变更不启动 CLI、服务替换后只调用新实现、移除后的最新不可用原因、非自有 409 不重试及取消；原生 CLI 是进程内 fake，没有真实模型调用。新增四条 pin 所有权检查证明失败视图各释放一次、成功视图在 scope 收尾释放，取消后不再解析/获取新租约。

`admission-reparse-invocation-final.log` 207 项=203 PASS+原 AGY Native Windows birth-identity 4 FAIL，保持原平台限制，不放宽所有权检查。最终 API tsc 通过，8 个变更源/测试文件 Biome 无错误；构建成功后才运行依赖 dist 的验证。无新增常驻服务、安装、用户认证或历史改动。

复杂度复核：复用原 InvocationServiceScope 和 Router 表，仅增加一个有明确 owner 的冲突类型与一次重解析；不新建队列、重试框架、版本总线或 launcher。此处只处理已检测出的冲突，其他 owner 输入的一致性检测、完整服务构建 provenance、所有写方通知与持久会话兼容仍待继续；不能作为完整 W2/C15 通过证据。

checkpoint_review 对 `34743bf52d9fd5abaeccbca10b76bfa364100647` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-admission-reparse`。独立 21 PASS，验证释放完成前不解析、释放异常/取消不重试、实际新 service/binding 配对，以及 provider 阶段同类错误不重发；无未关闭 finding。批准仅限该提交，不包括后续切片或完整 W2。

## W2 ACP 成员 MCP 开关消费修复（尚未完成 W2）

Host 原来传了准入成员的 mcpSupport，但 ACP 捕获函数忽略它，使用构建服务时的旧值。补三条真实 Host→ACP session/new 反例：当前关闭而构建开启、当前开启而构建关闭、当前缺省开启而构建关闭；准入后再次翻转成员并等待租约，验证实际创建会话仍用本轮冻结计划。`acp-member-mcp-red-consumer.log` 7 项=4 PASS+3 FAIL，实际工具数量与有效开关相反。前两轮夹具因误用 registry API 失败，不当作行为 RED；最终日志以真实消费者断言为准。

正式准入把既有“非 false 即开启”解析为 boolean；ACP 优先用该值捕获，直接内部调用未提供该字段时保持构建默认。原解析、项目补充与冻结后消费路径不变，没有增加运行时开关或再次读 registry。`acp-member-mcp-green.log` 78 PASS，含 MCP resolver、直接 resume、模型偏好、client 身份和串并行有界重解析；API tsc 通过，3 文件 Biome 无错误。扩大消费者 `acp-member-mcp-consumers.log` 123 项=122 PASS+1 原 Windows bootstrap 父目录 PARENT_REPLACEMENT 拒绝；单独进程沿用既有 trusted-host 模式重跑原注册文件 `acp-member-mcp-registration-process-only.log` 7 PASS，不认证 strict ACL，不改用户/生产模式。

复杂度复核：产品只增加有效 boolean 的传递/消费，未重构原 factory 或增加配置框架。构建 whitelist/启动参数、全部 owner 一致性及持久会话仍待后续，不把这个开关修复描述为完整发布原子性。没有真实模型或新增常驻服务。

checkpoint_review 对 `93f0754491ac937a6c2c3c50e35de75d996d0191` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-acp-mcp-switch`。独立 37 PASS，含开关/默认、等待后的冻结、内部构建默认与关闭时跳过损坏来源；无未关闭 finding。批准不包含 whitelist/启动输入一致性或完整 W2。

## W2 线程工作区与偏好读后核验切片（尚未完成 W2）

准入复用同一个局部 captureThread 读取路径，在异步 provider/MCP 捕获前后解析工作区与本成员 effort/speed。只比较实际工作区坐标及本轮偏好/读取状态；其他成员偏好、标题等非执行字段不进入此比较。发现变化抛已有自有冲突，正式路由沿已审查的一次重解析路径使用最新输入；成功冻结后仍沿用原绑定。最后的成员 revision 核验保留在新增异步读取之后，防止该等待窗口绕过原检查。

`thread-currentness-red.log` 4 项=1 PASS+3 FAIL，真实 ThreadStore 的工作区/effort/speed 合法写入没有被发现；其他成员写入是对照。修复后 `thread-currentness-consumers-passed.log` 40 PASS，另加实际串/并行 Host→Codex fake CLI 四条旅程，验证新工作区 cwd、新 effort argv 且只发送一次。speed 当前性/下一次读回及冻结后消费分别由准入与原 invocation 检查覆盖。最初把“原生 auto auth + gpt-5.3”当作 Fast 适用夹具导致两条预期失败；既有 Fast 契约仅允许适用 OAuth/模型组合，移除不成立的 Fast argv 场景，保留当前性断言与原能力限制，不为测试开启 Fast。

`thread-currentness-routing-final.log` 120 PASS，含完整策略、元数据、真实刷新、调用 preflight 和 L0；最终 API tsc 与 3 文件 Biome 无错误。没有真实模型、常驻服务或数据修改。复杂度复核：原准入函数共用局部读取、增加一个执行投影比较；无新存储、revision bus、watcher 或启动器。该切片不等于线程所有状态/MCP源/启动配置的一致性协议，全部 W2 与会话语义仍未完成。

checkpoint_review 对 `b808d0232ebb77cce599ee462fe88876155ad384` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-thread-currentness`。独立 45 PASS，含当前性、实际 cwd/effort、读取状态变化、元数据控制、第二轮读取取消和成员 revision fence；无未关闭 finding，不证明线程原子快照或完整 W2。

## W2 ACP 构建账号来源核验切片（尚未完成 W2）

实际 factory 已将账号 HOME/env/凭据固化到 pool 启动配置；单纯在 Host 内前后两次读取当前账号，不能发现两次均为新值、实际旧池仍是旧值的错配。现由原 factory 在构建时复制私有账号来源及其成员选择输入，在 captureInvocationOptions 前后沿原 resolveAcpAccount 核验；变化时发出已有自有准入冲突，等待刷新/重新准备。该核验只处于准入，已冻结 invocation 仍消费原计划和原 pool，不在模型执行阶段重读账号。没有将私有 profile/secret 写入审计或兼容键。

测试同时发现通用 clientId=acp 的显式 accountRef 原来在 Host 冻结层被忽略：该层只解析 builtin client。补齐该明确分支，复用原 resolveByAccountRef 和验证逻辑；未绑定原生来源仍保持原继承，不扩展其他无关 client。`acp-account-source-red.log` 的两个正常对照因 accountEnv 缺失失败，三个旧池错配未拒绝；修复 Host 分支后 `acp-account-source-red-after-host.log` 对照通过，HOME/普通 env/凭据三条仍 RED，独立证明 factory 来源缺口。最终 `acp-account-source-green.log` 23 PASS，含真实 factory→Host 准入、新服务与新启动配置匹配、额度元数据不误判、冻结后实际 ACP 会话保持旧绑定，以及原租约/工厂/环境用例。消费者 `acp-account-source-consumers.log` 70 PASS，含解析、成员投影、账号冻结、MCP、偏好、协议 provider 和正式路由。

最终 API tsc、3 文件 Biome 无错误。factory 集合使用隔离测试进程的既有 trusted-host 模式，未认证 strict Windows ACL、未改生产配置；真实 factory/pool 消费者配的是内存协议客户端，没有启动外部进程或调用真实模型。池/视图由测试所有者受控释放，私有夹具数据保留在任务 artifacts。

复杂度复核：复用既有 resolver、capture hook、冲突和 pool owner，无新账号库、factory 服务、通知总线或重试系统。该保护针对构建时账号来源；成员选择/ACP 原始命令与 whitelist、父环境/CA 及所有配置 owner 的发布一致性仍须继续，不把它当作完整启动计划冻结或 W2/C05/C15 通过。

checkpoint_review 对 `48471628a1357a429ee7665aa8f46a9d686b37dc` 给出 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-acp-account-source`。独立 91 PASS，含真实 factory、捕获期间变化、元数据控制、严格凭据和冻结后原绑定；无未关闭 finding。factory 仅用私有进程既有 trusted-host，不认证 strict ACL，批准限此账号来源边界。

## W0/Q01 固定样本准备（未完成质量验收）

按 eval-design 方法对 claim 与判断分工做了复核，具体范围见 [quality-samples.md](quality-samples.md)。新增一个离线脚本，准备三个全新目录的小型工程任务并独立校验实际行为/文件范围，报告记录脚本与候选哈希；公开测试不包含独立答案。最初作者三条测试/十二个判定符合预期，重复准备拒绝覆盖；Biome 无错误。独立 reviewer 对 eaa7d268 返回四个 P2：view false、金额精度、执行后范围/哈希、文档包装器 cwd。补三个真实误放候选先三 RED，再补行为、执行前后快照和真实入口，最终四测试通过；另将报告写入候选目录的问题先 RED 再于命令边界拒绝。完整日志/旧 reviewer 见证失败的说明见 quality-samples.md，同一 reviewer 待复核。没有运行真实模型或候选，Q01 保持 NOT_RUN；Q02–Q04 与性能基线继续准备。

## W2 ACP 成员改选账号的准入匹配（尚未完成 W2）

上一切片只验证原构建账号本体当前性；成员在新调用前改选另一个账号、或取消显式账号改回原生默认时，原账号本身仍未变化。`acp-account-selection-red.log` 的两个真实 factory→Host 反例均未拒绝。现仅在已有 capture port 增加冻结 accountRef，Host 总是提供该属性，包括明确 undefined；factory 将其与构建来源核对。缺属性的直接内部调用仍沿原来源验证，属性存在但 undefined 不回落旧账号。ACP hook 与既有统一输入类型对齐，未增加外部配置字段或存储。

修复后 `acp-account-selection-green.log` 18 PASS，覆盖原五条账号来源、两条新选择、新 factory 实际 env/原生无账号读回及原生命周期；`acp-account-selection-consumers.log` 70 PASS。API tsc 与 5 文件 Biome 无错误。factory 仍仅在隔离进程使用原 trusted-host 测试模式，未验证 strict ACL；客户端为内存协议替身，无真实模型/外部服务。复杂度复核：一个现有冻结投影字段与一次明确选择比较，沿原冲突/有界重解析路径，不新增账号系统或重试器。原始命令、whitelist、父环境/CA、全 owner 一致性和 W2 继续未完成；此选择来源切片等待独立审查。

独立 reviewer 对 `ef688b96161ab1d32e164de3d156cb1ff60b19a5` 返回 P2：原始显式 ref 无法区分隐式应用默认与原生无绑定；两个值都是 undefined 时，旧应用账号 pool 可穿过新 native 选择。另证实 factory 原先用 !config.accountRef 判断空，空白字符串与 Host trim 语义不同，native 会误取应用默认 HOME。这是原 resolver 不一致在本护栏中的未闭环变体，不称为本次新引入回归。

现 capture port 的 accountRef 明确承载实际解析的 runtime account.id，包括隐式默认；present undefined 表示本轮 native/unbound，与旧构建 account.id 比较。factory 复用原 usesNativeToolConfiguration 统一空白语义，不另写 trim 规则。新增两条真实 factory→Host 反例 `acp-native-selection-red.log` 先 RED，修复后 `acp-native-selection-green.log` 20 PASS，保留原七条选择/账号与租约用例，验证隐式默认的原绑定、切换拒绝和新 factory 不再带应用 HOME；消费者 `acp-native-selection-consumers.log` 70 PASS。API tsc、4 文件 Biome 无错误；无真实模型/外部进程，仍不认证 strict ACL。此 P2 修复等待独立复核，不扩大到完整 W2。

量尺准备的另一独立回执：checkpoint_review 对 `db76cade55c431228657bbba0efaa5d03d71a770` 返回 approved，原四 P2 和报告位置问题闭环，独立 8 PASS；subject 保持 checkpoint-quality-samples。该批准仅限量尺，Q01 及真实候选继续 NOT_RUN，详见 quality-samples.md。

checkpoint_review 对 `1f1453ee56de361f2681ae373e0e76d7a561a400` 返回 approved，原账号选择 P2 闭环，独立 34 PASS，含两个原 RED、直接调用空值语义、Registered 转发、冻结后旧 turn 与租约。批准限此边界；原始启动配置、父环境和完整 W2 继续待验。

## W2 目录 ACP 启动配置来源核验（尚未完成 W2）

目录 ACP 工厂调用方将原 getAcpConfig accessor 传给既有 factory，factory 在首次异步准备前复制成员与 ACP 配置，并在原 capture hook 前后核验原始 ACP 来源。目录配置参数变更、删除或损坏返回已有自有准入冲突；不会把新绑定配到旧 pool。已冻结绑定和后续 AcpClient 构造保留原输入。这个 accessor 只在准入读取，不进入 L0 子进程、实际模型发送或持久审计。插件声明继续依赖原实现注册/生命周期 fence，直接 legacy 工厂调用未提供该 accessor 的来源不据此取得目录一致性证明。

`acp-catalog-source-red.log` 五项=2 PASS+3 FAIL，使用真实 getAcpConfig 和独立模板，修改启动参数、移除 ACP、损坏来源均未拒绝。修复后 `acp-catalog-source-green.log` 27 PASS，含上述三条、新 factory 实际 AcpClient 构造 args、新旧绑定对照、账号来源/选择及原租约/工厂；`acp-catalog-source-consumers.log` 62 PASS，含客户端库生命周期/能力、插件选择与 MCP/执行偏好。没有启动原生 CLI/真实模型，构造参数证据不代替进程或发行物验收；全部池由测试释放，夹具数据保留。

最终 API tsc、三个相关文件 Biome 无错误。首次格式检查报 index.ts 的 CRLF；仅规范为 LF，Git 逻辑差异仍为目录 factory 调用点的一行。factory 集合仍使用隔离进程的既有 trusted-host 模式，不认证 strict ACL。复杂度复核：复用原 factory 与来源解析函数，在现有私有输入增加一个读取端口，共用原前后 fence；没有新注册/启动框架、存储、watcher 或 revision bus。成员整体发布、MCP 来源、父环境/CA、其他客户端完整输入及 W2 仍待继续；此目录来源切片等待独立审查。

checkpoint_review 对 `145bb8cd4ac1851d78afca033dc9f63d93abffe8` 返回 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-acp-catalog-source`。独立 24 PASS，含真实 catalog overlay、变更/删除/损坏、捕获期间变化、私有副本及 legacy 无 getter 兼容；无未关闭 finding。批准仍限目录来源，不代表成员整体发布、全部 MCP/父环境或完整 W2。

## W2 正式 MCP 文件版本核验（尚未完成 W2）

原 readInvocationMcpConfig 继续按既有规则每次读取/解析全局和项目 capabilities.json；在本轮捕获 scope 中只记录实际读到的文件版本，重复读取版本不同时记为变化。Host 包住原 provider/共享 MCP 捕获，在后续线程读取及账号/实现核验之后、L0 同步捕获之前验证这些来源仍为原版本；变化抛既有自有冲突并沿一次重解析路径处理。版本集合为私有临时数据，不带配置正文进入审计或子进程，不在实际发送阶段再次查询。

`mcp-currentness-red.log` 四项=1 PASS+3 FAIL：实际 ACP 捕获期间写全局/项目配置，以及最后线程读取窗口写配置，均未发现变化。相同字节重写是对照。修复后 `mcp-currentness-green.log` 66 PASS，含各已迁入 native/ACP 的实际 MCP 消费、冻结后变化、线程/currentness 和原路由重解析；`mcp-currentness-consumers.log` 178 PASS，涵盖原 workspace/共享授权、适配格式、完整策略与调用 preflight。新增串/并行 Host→ACP 内存协议 session 旅程，`mcp-currentness-routing-complete.log` 6 PASS，确认冲突后捕获两次、实际 session/new 一次且新 args 被消费，turn 关闭/lease release 各一次；没有真实模型或原生 CLI。

追加路由夹具时的语法错误和继承默认 effort 导致的 thought_level 失败留在较早 routing 日志；修正测试作用域，并显式声明本场景委托原生默认 effort，没有放宽产品配置校验。最后夹具补齐真实 lease 接口及线程活动接口，消除无关清理失败。最终 API tsc 通过、3 文件 Biome 无错误。

复杂度复核：仅复用原 MCP 文件 owner 记录本轮版本及最终读取核验；没有缓存配置对象、跨调用缓存切换、watcher、存储或通用配置总线。scripts/sync-skills.sh 的跨进程通知缺口继续保留，不能以本次字节核验声称全部合法写方已通知。该核验只覆盖经此正式 reader 读取的文件；原生 HOME/.mcp.json 等专属来源、插件激活代次、父环境/CA、成员整体发布与持久审计仍须分别完成，W2/C05/C15 尚未整体验收。此 MCP 文件切片等待独立审查。

checkpoint_review 对 `4456f3882acaeda8f7ee8fe60aa3e7cf7022c19a` 返回 approved，subject 为 `task:01a1881e-1a7b-78d0-9a62-ff99b0ab7a01/checkpoint-mcp-currentness`。独立 28 PASS，含最后等待窗口、实际路由重解析、缺文件出现/消失、重复读取后恢复旧字节、并发隔离及普通诊断；无未关闭 finding。批准仅限正式 reader 来源版本，不含其他 MCP/激活/父环境或完整 W2。另已复核六份 accepted source 文件哈希均未变，记录 source-integrity-4456f388.json；全部 34 个 C/E/Q 整体验收条目仍保持 NOT_RUN。

## W2 客户端 MCP 文件版本核验（尚未完成 W2）

将既有准入 scope 的版本记录接到 ACP、Claude、Kimi 的项目 .mcp.json、OpenCode 的 opencode.json、Kimi 原生 HOME/项目补拒绝层，以及这几条路径原先直接读取的 capabilities.json。同步读取保留原文件错误，异步 Kimi reader 上报实际解析字节；原 optional/best-effort/strict 规则不变。原先不存在的可选层也记录缺失状态，避免准入等待中创建文件而使用旧计划。最终核验与冲突处理继续复用已审查路径；冻结后 consumer 不重读这些允许计划。

`client-mcp-currentness-red.log` 九条真实 Host→client capture 反例均 FAIL，覆盖四客户端项目文件变化/出现及 Kimi HOME 变化；修复后 `client-mcp-currentness-green.log` 9 PASS，并核对下一准入实际描述符、OpenCode command 和 Kimi 新原生入口的拒绝值。`client-mcp-currentness-regression.log` 152 PASS，覆盖原 resolver、各原生/ACP 冻结、workspace、共享授权及格式适配。`client-mcp-currentness-tsc-verified.log` 确认 API 构建 exit 0 后才运行测试；7 文件 Biome 无错误，既有测试风格警告未扩散修改。测试不启动模型或常驻环境，独立夹具数据保留。

复杂度复核：只在既有实际文件读取点记录版本，不新增配置对象缓存、watcher、launcher、存储或跨进程总线；未改变 Kimi 后续原生层只能补拒绝的限制。该证据不覆盖全部客户端原生配置、插件激活代次、父环境/CA、成员整体发布、持久审计或完整 W2/C05/C15；等待独立审查。

checkpoint_review 对 `be51e64613ce84a7b3ffee0e287e1ffcd0eb56f1` 返回 approved，subject 为 checkpoint-client-mcp-currentness，独立 34 PASS，覆盖实际读取字节、缺失/出现/消失、scope 隔离、原错误语义及冻结后消费，无未关闭 finding。批准仅限该 SHA；下一激活切片和完整 W2 不在本回执范围。

## W2 本地插件 MCP 激活准入核验（尚未完成 W2）

NativeMcpLaunches 的既有 memberView 保留原激活对象集合和各入口可用性，提供只供准入检查的 isCurrent。Host 在最后异步读取之后核验该视图；新增、移除、刷新激活及动作代次失效均走已有自有冲突/一次重解析。已失效但未再变化的入口仍按原规则拒绝，不把稳定拒绝变成无限冲突。检查回调不进入 FrozenExecutionBinding、编译输入、持久审计或发送参数。

真实 NativeMcpLaunches/NativePluginActions→Host→ACP 捕获的 `plugin-mcp-currentness-red-valid.log` 6 项=2 对照 PASS+4 FAIL，原先刷新/禁用/启用/动作代次变化均未拒绝；首轮夹具用错 ACP 名称的日志不算有效 RED。修复后 `plugin-mcp-currentness-green.log` 49 PASS，含六条新检查、原插件发现/隔离与已审查文件版本；下一准入实际采用新 args 或移除失效入口。`plugin-mcp-currentness-consumers.log` 52 PASS，覆盖真实 carrier 的原 native launch/Alpha 激活、多个原生消费者与串并行重解析。API tsc exit 0 后才测试；4 文件 Biome 无错误。无真实模型或新增常驻环境，作者新夹具保留，既有测试沿原夹具生命周期结束。

复杂度复核及 map delta：复用插件激活 owner 到 invocation/MCP 消费者的既有边，只新增私有视图校验能力和最终检查；没有代次总线、watcher 或存储。此处覆盖会返回本地激活视图的隔离 Host；persistCapabilities 常规发布路径仍不返回该视图，不能以本次证明全部插件激活或 inventory/package 的外部静默变更。成员整体发布、父环境/CA、全部写入通知和完整 W2/C05/C15 仍未闭环；等待独立审查。

checkpoint_review 对 `d886018ea4f2320f4fca4a553686cde181c93da4` 返回 approved，subject 为 checkpoint-plugin-mcp-currentness。独立 31 PASS，覆盖空视图新增、移除/替换、actions generation、稳定拒绝、并发 Host 隔离及回调不进入 binding；无未关闭 finding。批准仅限本地 memberView，不含常规发布或完整 W2。

## W0 Q02 审查样本准备（尚未执行真实 Q02）

固定两份已知实质缺陷与一份健康对照，保留 before/after，任务明确边界；评估者保存答案/校准测试，只复制单个候选子目录。实际可复现对照及范围说明见 quality-review-samples/README.md；`review-samples-calibration.log` 四条 PASS。manifest 固定九份材料与校准程序 SHA256，新增文件的 LF 属性防止 Windows checkout 改变被评分字节，不调整全仓换行策略。量尺准备不计入真实客户端两轮盲审或质量成功率，无真实模型/服务调用。此样本等待独立审查；Q03/Q04、真实质量基线、性能与平台验收继续未完成。

提交 4c91c388 后用 core.autocrlf=true checkout-index 将材料/校准程序检出到独立作者 artifacts，`review-samples-windows-checkout.log` 4 PASS，验证真实 Windows 过滤后字节与行为；没有用本机未检出文件冒充跨换行校验。

checkpoint_review 对 `4c91c38852737620d90ac941b0d955d6b8e2c5aa` 返回 approved，subject 为 checkpoint-review-samples，独立 9 PASS；包括正式命令、独立临时 index 的 Windows 换行过滤、实际 Copy-Item 三文件/哈希边界，以及 C 追加 514 组 ASCII 输入等价检查。无未关闭 finding，批准仅限 Q02 量尺，真实候选仍 NOT_RUN。

## W2 已发布成员目录来源核验（尚未完成 W2）

启动注册及原 reconcileCatRegistry 共用 registerCatalogSnapshot，为各已发布目录对象附私有 WeakMap 来源检查。检查从原 owner/原模板解析路径重读非持久迁移投影，与已发布的全部实际成员投影比较；Host 在首次捕获前及最后异步读取后核验。目录已提交、registry 尚未发布时，不再只靠未变化的内存 revision 放行旧角色/队友资料，而是沿既有冲突/一次重解析处理。语义相同的格式变化不冲突；已冻结 binding 继续原值。程序注册的非目录对象沿其既有 owner，不据此宣称也获得目录来源证明。

`catalog-publication-red-valid.log` 6 项=2 对照 PASS+4 FAIL，覆盖调用前、捕获期间、队友配置提交及冻结后下一次调用；均由真实 withRuntimeCatMutationLock/updateRuntimeCat 提交，registry revision 没有更新。首轮夹具缺 displayName 不算行为 RED。修复后加入启动注册与重复 ID 投影失败保留原 registry，`catalog-publication-regression-final.log` 共 176 PASS，含新八条及原目录/订阅、身份/投影、MCP 来源、串并行重解析。第一次扩大运行给本应自行准备 registry 的旧身份测试额外全局 preload，造成重复注册；去掉不适用 preload 后通过，未改该测试或产品校验。

自检发现首次实现把 toAllCatConfigs 放在 reset 后，会在重复 catId 投影失败时清空旧 registry；有效 `catalog-publication-projection-red-valid.log` 先复现丢失，现恢复原先先完整校验、再发布的顺序。更早 duplicate 夹具被既有迁移处理而非命中投影错误，不算此 RED。最终 API tsc 与 4 文件 Biome 无错误，旧警告未扩散清理；无模型或常驻服务，新夹具数据保留。

复杂度复核及 map delta：目录 owner→已有 registry→invocation 的原边增加来源证明，WeakMap 只附短期校验，不提供身份数据/编辑接口/持久状态。两个实际发布点共用同一个注册函数，无新身份库、revision 总线、队列或 launcher。全部策略/env/CA、常规插件激活、合法写入通知、持久审计和完整 W2/C05/C15 仍未完成；性能 20 次对照仍需总验收，不把本切片测试耗时当性能结论。等待独立审查。

checkpoint_review 对 `1ef2f234401e51cdc8cc7697dbc5a8af33948983` 返回 approved，subject 为 checkpoint-catalog-publication。独立 42 PASS，确认失败发布保留旧 registry/额外成员、两个来源隔离、legacy 非持久读取不改字节、最后等待期间真实 locked writer 变更被拒绝及原身份/串并行重解析；无未关闭 finding。批准仅限此切片，完整 W2 与性能验收继续未完成。此轮四个切片均已独立批准，全部 34 个 C/E/Q 整体验收状态保持 NOT_RUN。

## W3 取消终态与迭代器清理纵向切片（尚未完成 W3）

现有 ACP 的公共冻结消费端已经确定，本切片沿同一纵向路径修正既有取消错误，不启用新绑定，也不宣称 W2/W4 已全部完成。Bridge 原先收到 abort 即退出并清除 active，ACP adapter 也在 abort 后合成 cancelled/提前 cleanup、忽略异步 iterator.return。现在取消立即关闭补充输入，但继续等待 provider 终态，抑制取消后的普通输出；ACP 终态及 active 清除等待原源迭代器 finally/租约清理完成。缺少 done 的 EOF 明确失败，不再伪装完成；清理异常不由 cancelled 掩盖。

`cancel-quiescence-red.log` 五条行为反例均 FAIL，覆盖取消受理/失败/异常但原 turn 仍活跃、普通与取消 turn 的延迟清理。修复后五条通过；追加 unsupported 与清理失败保护时，`cancel-quiescence-expanded.log` 发现包装器对已失败 generator 再次 return 会清除 active。现区分尚未开始消费的 generator，仅它需要包装器自行清理；已消费的 active 只由源 finally 在成功清理后清除。无新增状态对象或取消框架。

`cancel-quiescence-contracts-closure.log` 最终 195 PASS，覆盖新七条、Bridge/input receipt/插件注册生命周期、实际工厂→ACP 子进程双轮/续接/取消与原生/bridge 路由取消诊断。API tsc exit 0 后测试，七个源码/测试文件 Biome 无错误。整个集合只在测试子进程使用既有 trusted-host bootstrap 模式，不认证 strict Windows 父 ACL；无真实模型或生产调用。

旧夹具同步了真实语义：主动提供 provider 停止事件、先释放执行 gate 再等待取消终态；EOF 断言改为明确缺失终态失败。第一次全组因旧插件假 release 不发停止事件而等待，确认父子 PID/准确测试文件后仅停止本次 worker 48800（父 48516），日志和其临时文件保留；未停止用户或其他任务进程。原 built-in 取消基线还以 OpenAI 成员配通用 ACP，诊断 `cancel-quiescence-baseline-diagnosis.log` 明确 execution_client_changed；夹具现注册实际 ACP 配置并恢复原内存 registry，没有放宽产品检查。完整重新运行已结束，无新增常驻实例。

复杂度复核及 map delta：复用 session bridge/provider 的既有事件和 iterator 所有权，删除把 abort 当终态的分支，等待既有清理；不增加数据库、后台恢复器或重试系统。更新 identity-session cell 的原依赖边。该片段不把标准取消 ACK 解释为原生已停止证明；AcpAgentService/pool 的 unknown/隔离、release 失败/Host 重启、compatibility/片段与审计仍待整体完成。原 SocketManager 取消广播仍提前发 done，现有路由诊断仍有两个广播；下一步应在 transport/lifecycle owner 区分取消请求与终态。C12 整体继续 NOT_RUN，等待本切片独立审查。

checkpoint_review 对 `cbb5124c2d48f888ebfb02127081c8f27ba9de25` 返回 changes_requested，独立 12 项=9 PASS+3 FAIL，两个 P2：源 finally 经 next 抛错后，对已关闭源 return 的空成功仍会清 active；未启动时并发 return/next 改写 consumed，会永久 busy。前者还以真实 AGY AcpAgentService 包装和未释放租约复现。作者补两条真实分支，`cancel-quiescence-review-red.log` 9 项=7 PASS+2 FAIL。

修复仅记录 return 进入时是否未消费，并记录源 next 是否成功返回；失败 next 后的空 return 不再被当作清理证明。`cancel-quiescence-review-green.log` 9 PASS，`cancel-quiescence-review-contracts.log` 197 PASS，作者回放 reviewer 私有五条（含真实 AGY 包装）`cancel-quiescence-reviewer-replay.log` 5 PASS。最终 API tsc exit 0、两文件 Biome 无错误；等待独立复核，未将作者回放计为独立批准。没有新服务/模型调用。

独立复核 85ce6a218 的首次派发因模型容量失败，未产生源码裁决；批准状态仍为待复核，不将基础设施错误解释为通过或代码拒绝。

## W3 取消请求广播与前端消费（尚未完成 W3）

buildCancelMessages 原先收到本地取消即发无原生停止证据的 done/isFinal，且空目标会编造 opus。`cancel-request-broadcast-red.log` 三项=1 对照 PASS+2 FAIL。现复用原 status 消息向明确目标报告“正在停止，等待执行状态确认”，不发布终态或编造默认成员；实际 done 留给原 execution/lifecycle owner。Socket/REST 原有用户归属、操作来源去重、scope、处理中 reservation 与 auto-resume 防护保持原逻辑，没有新增取消状态源或协议字段。

`cancel-request-broadcast-regression.log` 35 PASS，含纯边界、真实 Socket.IO 请求、队列 cancel-all/单成员隔离及实际工厂→ACP 子进程→原生/Bridge 两条路由。取消请求 status 先到，最终只有一个路由 done，持久生命周期 canceled，activeLeaseCount 为 0。此前诊断基线的“两次 done”断言改为该真实合同；空批次旧测试原来依赖默认目标，已按明确无目标不广播更新，未改产品 identity guard。

`cancel-request-state-web-final.log` 19 PASS，包括新两条真实 Zustand store 的当前/后台 consumer 检查、既有并发取消与停止按钮：请求到来保留执行槽位/loading，真实 done 后才清理。API tsc、Web tsc 均 exit 0，六文件 Biome 无错误。首次 Web 包装器无法直接 spawn Windows pnpm shim，保留 ENOENT 日志；改由本机已安装 Vitest package 的实际 Node 入口执行，无依赖安装。既有组件测试的 React act 警告保留，没有修改组件行为。

复杂度复核及 map delta：transport→现有消息消费者只投影请求，lifecycle 继续是终态 owner；函数更短，不新增 store、重试器、消息类型或状态 DSL，更新 transport cell。前端只补回归，没有增加产品状态。此处仍不证明 native 进程已停止、取消断线/未知执行已恢复、release 失败或重启已安全、最终安装物验收通过，C12/W3 继续未完成。等待与取消清理切片一起独立复核。

checkpoint_review 对 `91d5c02b9e7c1e9365a4d2236b302ae43a4097b8` 返回 changes_requested：原两个 iterator P2 均独立 GREEN，但新增一条恢复 P2。真实 Fastify→queueRoutes 的完整权威来源均确认旧执行已消失、返回 reconciled:true 并释放 slot，此时共享函数只发 status，没有 producer 再发 done，聊天槽位不收敛。独立 37 PASS+1 FAIL，原反例和日志保留。

作者采用该实际路由反例，新增“完整已消失”与“来源不完整且不能落盘失败”两个对照；`cancel-recovery-terminal-red.log` 2 项=1 PASS+1 FAIL。修复不新增广播模式参数：由既有恢复 owner 在本身已经有证据的三个位置直接发终态。完整来源确认 gone 后为已知 parent 发 done；terminateExact.complete 且子终态写入后按精确 parent/child 发 cancelled done；控制失败的修复已落盘后按精确身份发带 control_plane_unavailable 等原因的失败 done。普通 tracker 取消、lock-only、未经 native 确认的孤儿记录和混合 force-reset 仍只发请求，不由名字推断停止。

`cancel-recovery-regression.log` 161 PASS，含新恢复对照、F295 的多来源/精确进程/替代执行保护、全部 queue API、真实 Socket/ACP 及 cancel-auto-resume；追加 owned done 的 parent/child/errorCode 断言后 `cancel-recovery-owner-final.log` 40 PASS。作者回放 reviewer 原恢复反例 `cancel-recovery-reviewer-replay.log` 1 PASS，未冒充独立批准。之前 queue API 扩查的 86 项中 3 条旧普通请求 done 断言已迁到 status 且明确禁止 done，最终全过；不恢复这些错误的终态断言。API tsc exit 0、四文件 Biome 无错误。

复杂度复核：三个既有 owner 的少量明确投影，保留其原控制流与前置证明；无广播开关、通用状态机、新存储或重试层。force-reset/lock-only 等未知 native 状态未被改成虚假成功，完整 C12 的恢复/阻止新 turn 仍需继续验证。独立复核待重发至修复 SHA。

## W3 恢复终态的现有前端消费（尚未完成 W3）

checkpoint_review 对 f000d5dd4565f608d58d35c91d95beb1cccdd5b2 返回 changes_requested，原三条取消 finding 已关闭，新发现两个 P2：真实恢复失败 done 到后台后误报绿色完成；一个 child 终态清除仍有 sibling 的线程 loading。独立 57 PASS 加两个 Web 失败，实际 Fastify/Record/Turn/Message store 产生的消息保存在 reviewer artifacts。

作者在真实 Zustand 消费者补当前/后台三个分支，cancel-recovery-web-red.log 为 2 PASS+3 FAIL。现有后台清理只在移除精确槽位后剩余为零时清 loading；当前及后台 done 消费保留非 cancelled 的 errorCode 为失败，复用原状态、任务进度与通知，不新增消息正文或错误行。仍保留既有 idle 收尾会清 badges 的行为；单执行失败通过 error toast 呈现，有 sibling 时保留 error badge。cancel-recovery-web-green.log 共 131 PASS，覆盖当前/后台、并发、loading、named message 的原路径。作者回放独立真实 API 事件的三条私有用例，旧执行及 sibling 两条 PASS；solo 用例仍期望清理后保留 error badge，实际 undefined，已将既有清理合同提交 reviewer 判断，未将该回放称为全绿或独立批准。

复杂度复核：仅修现有投影和槽位收尾，无新 store、协议、失败重试、状态框架或追加错误正文。完整 C12、原生停止证明及恢复未知状态仍未闭环；另一真实 Node mock 反例已复现异步进程退休未完成即发布终态，独立在下一切片处理。

最终 Web tsc exit 0、四文件 Biome 无错误；早一次 tsc 发现 Boolean 抹去错误码的类型收窄，已改用明确的 failure 值，未用类型断言掩盖可空消息。独立复核仍待回执。

checkpoint_review 对 43376b8bc22d81ef663aa0bcf418ff5e64f6c205 返回 approved，原取消清理及恢复三条 P2 和两个 Web P2 全部关闭；独立 34 PASS，保留真实 f000 API 事件回放与当前消费者对照。reviewer 确认 solo idle 清 badge 的既有合同可接受，并更新 witness 核对明确 error toast、禁止 success；sibling 保留 loading/error 状态，旧 parent/同 parent 新 child 均受保护。批准只限该 SHA 的取消/恢复片段。

## W3 单飞 ACP 物理退休等待（尚未完成 W3）

实际 AcpClient→Node CodeAgent mock→原 pool→AcpAgentService→AcpSessionProvider→Bridge 的反例 cancel-native-stop-red.log 1 FAIL：本地取消使协议流结束，pool 只排队 close，真实 PID 仍活着时 Host 已发 done。现有 AcpLease.release 返回原 retirement barrier，重复/过代 release 也等待该 barrier；实际 service finally await release。没有新关闭器、timer、重试或状态存储。

API tsc exit 0 后运行。cancel-native-stop-regression.log 65 PASS，覆盖 pool、generation handoff、HTTPstream、原 retirement 和 iterator；新真实进程成功与失败对照各一条。追加并发 release 也不能提前返回，cancel-native-stop-final.log 2 PASS；关闭失败保留 session_contract_failed 和 busy，禁止将其改写为 cancelled 或启动第二 native turn。首轮扩大运行 55 PASS+10 既有 Windows Temp ACL PARENT_REPLACEMENT 失败；沿项目已有测试进程内 trusted-host 模式复跑通过，不认证 strict ACL、不修改产品策略。新测试不使用网络/认证/持久业务历史，仅隔离 mock HOME，逐实例记录源码/程序/夹具哈希、PID、目录及关闭状态；数据保留。

三文件 Biome 无错误，九条原有警告不扩散清理。复杂度复核仅复用既有 barrier 与 finally 的所有权；支持 multiplexing 的未知会话、Host 取消超时与路由提前收尾、重启及完整 C12 尚未完成。该物理退休片段待独立审查。

取消/Bridge 全部 18 个合同文件追加验证 cancel-native-stop-contracts.log 为 197 PASS。七份本切片 mock 实例台账均为 closed-data-retained/running:false，按 native-cancel-stop 精确命令行回读无运行 Node；核验快照见 cancel-native-stop-instances.json，没有删除任何 HOME 或历史。

checkpoint_review 对 096223f30379b97db4a3bd4ad4c53eb33696ebf0 返回 approved，独立 57 PASS，包括重复/过代 release 同一成功或失败屏障、同步计数、不同 key 不相互阻塞。两个独立 mock PID 均已退出，独立台账保留；批准仅限单飞物理退休等待。

## W3 Host 路由等待 adapter 取消清理（尚未完成 W3）

将同一真实 mock 旅程接至实际 routeSerial/routeParallel→SocketManager→MessageStore 后，cancel-routing-quiescence-red.log 四条全部 FAIL：Host 的一秒 abandoned iterator 超时和并行 merge 的 abort 合成 done，仍绕过已修复的下层停止 fence。这个反例证明必须修改上层消费者，不能只用 Bridge 单独测试认定全链路结束。

现有 AgentService 增加私有 cancellationMode:drain，表示 adapter 自己处理 AbortSignal 并拥有清理，不是平台支持认证。ACP、Bridge 和 Registered 的固定 invocation view 声明该模式；invokeSingleCat 对此等待原 iterator，发 provider done 前先完成原清理，清理错误不再静默当成功。并行 route 对这些 child 等待原流，不经 merge 的 abort 合成终态；未迁入的 legacy child 继续使用原快捷退出，公共及单成员 signal 均保留作用。无按客户端名称/命令猜分支，无新关闭器、线程、计时器、存储或状态 DSL。

API tsc exit 0 后，四条实际串/并行、直连/Bridge 为 cancel-routing-quiescence-green.log 4 PASS；加入并行 drain ACP+健康 legacy sibling 的两条对照后，19 个合同文件 cancel-routing-quiescence-contracts.log 203 PASS。明确超出原一秒超时仍保持 native PID 活着但不发该 cat done；健康 sibling 在等待期间能完成，实际停止后该 cat 只发一次 done、已有消息 lifecycle 为 canceled，身份对应原 child。外围 legacy timeout/retry、并发取消隔离、stream merge、双 ID 及 A2A 回归 cancel-routing-quiescence-regression.log 46 PASS；七文件 Biome 无错误，43 条既有警告/两提示未扩散修改。

测试只使用隔离 mock HOME，无端口/网络/真实凭据或模型；实例台账与状态数据保留。复杂度复核仅加一个明确的内部取消所有权声明和两个现有消费点，不把普通 legacy service 全部改成无限等待，不增加泛化取消框架。本片段证明成功受控停止的路由顺序；关闭失败/未知与重启恢复、多路复用以及完整 C12/W3 仍待闭环。独立审查待派发。

checkpoint_review 对 fcfc6b8d874890d5b8b642582889e959da00dd88 返回 changes_requested，独立 1 PASS+2 FAIL：parallel 消费者提前 return 仍未等源 finally；独立 per-cat signal 遮蔽 batch abort，使 drain 源继续工作。两条均接受，未用另一项关闭失败边界替代。

现有 parallel route 为每个 child 保存本次局部 AbortController，将 batch/per-cat/该局部信号合入同一实际执行信号，准入、执行及终态判断共用；merge 在消费者退出时取消自己所拥有的 child 并等待 return。该所有权通过一个内部 controller 端口传入，legacy 仍沿原 close 快捷路径。多个受控清理用 allSettled 完整等待后再上报失败，避免一个失败绕过另一个清理；stream-merge-owned-return.test.js 两条 PASS。无新持久状态或独立恢复器。

作者采用原三条反例并补 pending next 对照，cancel-routing-review-green.log 八条 PASS（五条作者用例及三条私有回放）；原取消/timeout/双ID/A2A 的 cancel-routing-review-regression.log 46 PASS。另用真实 Node mock 发现 direct ACP 提前 return 未取消 active prompt，cancel-native-consumer-return-red.log 1 FAIL。最初只在 invokeTurn finally 取消仍有同样失败，扩大运行 78 PASS+1 FAIL；原因是内层 promptStream 的 finally 已先移除活动请求，外层取消太晚。现在在原 busy-retry wrapper 的被中断 yield 边界先调用既有取消函数，再 return 内层流；自然结束和 busy backoff 不走这个分支，已有 finally 保留兜底。

最终 API tsc exit 0 后，cancel-routing-review-final.log 91 PASS，含实际 mock 取消/失败/直接 return 三条、原适配器、原/新路由所有权和 merger；20 个合同文件 cancel-routing-review-contracts-final.log 208 PASS。新增用例 Biome 无警告，原源码警告未扩散清理。mock 台账进一步记录实际加载的 dist 模块哈希，区分开发期间 HEAD 基线与未提交构建字节，未把 HEAD 字段单独当作运行源码证明。

额外真实失败 witness cancel-routing-failure-red.log 两条 FAIL 明确保留：close 拒绝且 native 仍 alive 时，serial/parallel Bridge route 仍投影 canceled（串行丢失失败码、并行带 session_contract_failed）。对应 wire-evidence.json、实例台账及隔离 HOME 保留，finally 已受控停止作者进程。此项未知/关闭失败恢复、多路复用和完整 C12 仍未完成，不能据本次成功停止与退出修复升级整体验收。待复核修复 SHA。

checkpoint_review 对 0c7bd2f86ce4231513301b519ea0a66802af86ba 返回 approved，原两个 P2 闭环，独立 44 PASS。包含正常 done 后消费者 break 保持 succeeded、批/单成员隔离、pending next 的退出清理及真实 direct ACP return。三个独立 mock PID 均已退出，HOME 保留；批准不包含关闭失败 unknown。

关闭失败的下一条事实核验已加入真实 InMemoryTurnExecutionStore：cancel-routing-failure-records-red.log 两条有效 FAIL。native-route-failure-records/owned native state OPqcZC（serial）和 gUZOwB（parallel）的 wire-evidence.json 显示 nativeAliveAtTerminal=true，response/execution 均 canceled、providerTeardownAt 却已写入，activeChildren=0。两实例均在 finally 受控关闭并保留数据。不能仅修改错误码或 toast；必须贯通停止未确认的实际事实，保持原 child/R 与同一资源准入阻断，待原恢复 owner 精确确认后收敛。

独立 advisory 已确认最小边界（不是实现批准）：原 Turn/Message/queue owner 保持权威；保留原 native owner 的句柄及精确归属，池移除 entry 和 closed 标志不能代替 OS exit；recovery 核对同 parent/child/资源，先证实 gone 或受控停止再持久化/解阻；启动恢复不能直接把未知 running interrupt 后复用原生会话。源码追踪进一步确认 cli-process-ownership 的进程快照在 Windows 返回 null，ACP 只在非 Windows 使用既有 Unix supervisor；跨平台恢复不能套用未经证明的 Unix 完整性。这与 W2 尚未完成的持久引用/绑定来源和 W3 兼容片段相关，下一实施需同时补真实 owner 依据，禁止新建取消数据库或用无界空 Promise 暂存未知状态。当前没有提交这部分未经验证的恢复实现。

## W3 启动恢复保留未确认停止的执行（尚未完成 W3）

真实 InMemoryTurnExecutionStore→TurnExecutionStartupReconciler 的 unknown-restart-red.log 两条 FAIL，覆盖 startedAt=0/50：tracked provider 已启动、没有 providerTeardownAt，单凭 Host restart 会把 child interrupted 并进入 response settlement。现在内存/Redis 原 interruptRunningBefore 共用既有三字段的纯判断，保留该 running child；未发出、旧无 tracking 字段、已证实 teardown 以及本来已终态的处理保持原流程。拿到精确停止证明写入原 providerTeardownAt 后，同一 child 再次恢复可以收尾，不需新字段或取消数据库。

API tsc exit 0 后，unknown-restart-green.log 27 PASS，包含新三条及原内存/启动恢复/历史记录检查。Redis 分支使用真实 RedisTurnExecutionStore 和正式 codec 读取合法 hash，验证未知记录不会调用 terminal Lua 或移除 running index；该分支是受控读取边界测试，不是实际 Redis 服务、跨进程或最终发行物验收。四文件 Biome 无错误，两条既有复杂度警告保留，无服务/端口/原生进程或业务数据操作。

复杂度复核：只复用现有 owner 字段、两个存储实现共用一项判断；无新状态库、watcher、恢复器或定时器。缺证明时旧 tracked 执行会继续阻止恢复收尾，这是本切片的明确行为；受控停止/精确 OS owner 证据的后续接线尚未完成。它不能修复已经被旧取消路径误写的 terminal 历史，也不能代替仍开放的 live close 失败两个反例。完整 C12/W3 仍未验收，等待独立审查。

checkpoint_review 对 32911e9fa34e708238d32b01de229617208c9968 返回 approved，独立 29 PASS，含 started/teardown 的 0 时间值、protected IDs、同 parent/member 两个 child 只按精确证明分别收尾以及重复恢复。批准仅限启动保护；无实际 Redis、原生停止证明或完整 C12 认证。

## W3 ACP error 与真实 exit 区分（尚未完成 W3）

acp-close-proof-red.log 为 1 PASS+1 FAIL：真实 AcpClient 配受控 ChildProcess，在初始化后先收到 error、随后 close，原 error handler 已把 exited=true，close 跳过 SIGTERM 并成功返回；从未收到 exit。关闭期间发生 error 的对照正确报告未确认。现在 error 只把 client 标为 closed/不可复用，exited 仍只由真实 exit 设置；确实没有 spawn 到 PID 的启动失败无需信号。两个既有字段的两行修改，不增加 shutdown 框架、重试、字段或状态 owner。

API tsc exit 0 后，acp-close-proof-green.log 13 PASS，含新三条、原 retirement 及真实 mock 取消/失败/direct return；acp-close-proof-regression.log 55 PASS，含原 ACP client、Windows spawn 和 AGY ACP 协议/权限。两文件 Biome 无错误，原九条 warning/五条 info 未扩散清理。受控 ChildProcess 用例不创建 OS 进程；真实 mock 用例沿原逐实例台账关闭、隔离数据保留。此处证明 error 不冒充载体 exit，不证明 Pi native 子树、Windows 跨进程恢复或上层 close failure 的正确持久化；两个 live failure RED 与完整 C12 仍待继续。等待独立审查。

checkpoint_review 对 d695edeeda86e5d5178f039f19bc19af1374b8ec 返回 approved，独立 60 PASS，包括同一 close Promise、重复信号及自然退出。批准仍仅限 error/exit 边界。

## W3 live 停止未确认贯通现有执行与队列（尚未完成 W3）

2026-10-30 00:03 UTC 核验。真实 Node mock 的前述 serial/parallel 两条 RED 表明 provider 未退出却已经写入 canceled/providerTeardownAt。现有 AgentMessage 只增加负向事实 providerTeardown:unconfirmed；Bridge 保留清理失败，invokeSingleCat 保留原 running child、会话锁和资源配置，不伪造 providerTeardownAt；现有串/并行路由传递该事实，不合成 done。QueueProcessor 在既有 owner 内保留 parent/R、processing reservation 和完成 hooks，不能由本地 abort 抹去该事实并提前解锁。没有新状态库、关闭器或无界等待 Promise。

cancel-unconfirmed-lifecycle.test.js 以实际工厂/ACP 子进程/Bridge/串并行/Socket/MessageStore/TurnExecutionStore 验证四种组合；停止失败时 PID 仍存活、R 为 processing、child 为 running 且无 teardown，第二任务标记未进入原生 session 文件。cancel-unconfirmed-queue.test.js 另以实际 QueueProcessor 消费者验证单成员/整批取消；RED 两条 parent canceled，修复后仍 running、R processing、队列占用保留且不执行完成 hook。两个消费者测试使用受控路由，不冒充真实 native→Queue 单一完整旅程。

API tsc exit 0 后，cancel-unconfirmed-final.log 为 6 PASS；queue-regression.log 的完整文件名 cancel-unconfirmed-queue-regression.log 为 226 PASS，cancel-unconfirmed-owner-regression.log 为 24 PASS。Bridge/invoker/routes 修改后的合同集 cancel-unconfirmed-lifecycle-contracts.log 为 212 PASS，运行早于 Queue 修改，未重复声称为最终全组。八文件 Biome 无错误，114 条 warning/4 条 info 未扩散治理；Queue finally 的 guard 使格式化 diff 变大，忽略空白后 Queue 仅 30 增/1 删语义行。

复杂度复核保留现有记录、队列槽和锁作为权威；未抽新管理器。16 份作者 native-unconfirmed-lifecycle 台账均 closed-data-retained/running:false，准确命令行回读无存活进程，汇总 cancel-unconfirmed-instances.json；HOME 和日志保留。首次新增测试两条还误把 R 的现有 processing 枚举期望为 running，已纠正夹具，未将该失败冒充产品缺陷。

当前仅闭环 live 负向事实传播；manual/reaper 等其他 terminal writer、成功受控停止后的精确恢复、native owner 持久依据、多路复用和完整 C12/W3 仍未完成。两组新测试覆盖生产者/消费者，不能替代实际 Redis、跨进程、macOS、真实 CodeAgent 或最终安装物验收。全部 34 个完整验收项仍 NOT_RUN。待独立审查本切片。

checkpoint_review 对 5a0e5ec46d2e518c71b9c6d71fedb2a34b61fe97 返回 changes_requested，独立 3 PASS+7 FAIL，归为三条 P2：prepare 的 live 并非 provider 已接受，明确 start 拒绝误标 unknown；batch abort 吞掉另一个已经 committed completed 的 sibling done；serial consumer return 清理失败被 finally 安全网 done 覆盖。作者已将其采用为永久回归：明确拒绝维持普通失败、start 抛错维持接受未知；Queue 在取消后继续 drain 终态/control、抑制普通输出；serial 逃逸异常保留原失败，不补成功外观。teardown-review-replay.log 对独立原反例回放 10 PASS，仍待原 reviewer 复核。

## W3 停止证明约束现有终态写入与恢复（尚未完成 W3）

2026-10-30 00:10 UTC。继续检查真实 writer，teardown-owner-red.log 为 2 PASS+7 FAIL：内存 owner 四种 terminal status 都可抹去 tracked/started/no-teardown 的 child；完整但为空的 OS 快照提前释放；真实受控 stop 未记录 proof；终态写入失败仍发 done。修复在原 memory transitionTerminal 和 Redis 原 Lua 终态写入中复用三字段判断，未证明停止就拒绝新 running→terminal。Redis 校验发生在原子 Lua 内，避免 JS 预读后 provider 才启动的竞态。已有 terminal 历史仍可读取/幂等 replay，未发出及 legacy 不因新约束改写。

精确 terminateExact 成功后以同一时刻原子提交 canceled+providerTeardownAt；持久化失败返回 503，不释放锁、不发 done。空 snapshot 不再替代 tracked child 的停止证明。原 reaper 已有精确 exit 观测和同步 owner fence，将该 exit 时刻写入原字段；没有新增恢复器或 owner。移除只使用一次且吞掉持久化错误的 tracker-less helper，逻辑回到原取消 owner。

API tsc exit 0；最终 teardown-owner-regression.log 共 389 PASS+1 Redis reaper SKIP，覆盖全部 Bridge 合同、四种真实 Node mock、串并行取消/return、Queue/zombie、恢复、原 Turn store、真实内存 reaper。首次扩大集合 94 PASS+1 FAIL+1 SKIP，仅旧 scheduler 夹具未期望新增 proof 字段，已对齐同 endedAt 的精确 proof 后最终全组通过。15 文件 Biome 无错误，105 warning/2 info 保留，不扩散治理。

真实 Windows Redis 另独占 6398/DB15：teardown-owner-redis-red.log 为 1 PASS+5 FAIL；修复后 teardown-owner-redis-green.log 为 6 PASS，无 skip，包含四种状态、零时间值、正式 codec/跨 store 读取及预读→Lua 间实际标记 provider started 的交错。使用本任务已有 Windows Redis runner 改测试列表，不调用通用清空 helper、不删除 key、不连接生产6399。两次各自的 redis-teardown-*/instance.json 登记 PID/程序哈希/目录；均 SHUTDOWN SAVE、stopped-data-retained、portReleased:true。最终回归中的 reaper Redis SKIP 是独立未接线用例，不能用另六条通过假称该 skip 已跑。

复杂度复核：约束落在两个原 writer 和原恢复 owner，共享已有 provider 字段，不加数据库、线程、watcher、timer 或错误重试；Queue 继续 drain 是取消控制流修正。原生 owner 句柄/PID birth 与资源绑定的持久引用、真正未知情况下的精确恢复/重新准入、多路复用、Windows/macOS/内外网/最终安装物仍未认证。源六文档哈希全未变，见 source-integrity-teardown-owner.json；全 34 项仍 NOT_RUN，不将本切片当作完整 C12 或 W3 完成。待独立审查。

checkpoint_review 对 533741c694da64133538f3fa98bb49ccec0ae937 返回 changes_requested：原三条 P2 已闭环，独立 92 PASS+1 Redis reaper SKIP；新增真实 owner service 反例 1 FAIL。错误在于把原 terminateExact.complete 当停止证明，但原 complete 仅表示信号步骤无失败。首个无效 createdAt=0 manifest 夹具已由 reviewer 纠正，不算行为证据；有效反例保留在其 teardown-signal-proof-533741.log/result.json。

## W3 信号确认与已知进程停止证明分开（尚未完成 W3）

2026-10-30 00:18 UTC。原 CliExecutionOwnerTermination 增加 stopped 事实，complete 仍保持控制面步骤完整的原义。原 owner 发信号后重新读取既有 manifest 和进程快照，按原出生身份检查 supervisor 和已登记 native root；原 manifest 消失仍保留本次开始时的身份，新出现同 scope child 也必须核验。缺原身份、不完整快照、仍有已知进程时 stopped=false。原恢复 owner 继续使用既有三次有界重试，只有 complete && stopped 才提交原 canceled+providerTeardownAt 并释放/发 done。没有新停止器、定时器、存储或原生会话重放。

实际 Fastify→真实 owner service→原 TurnExecutionStore 的永久 cancel-signal-proof.test.js 覆盖 live、gone、PID reused、晚退出、快照未知、manifest 可恢复移位、同 scope sibling、supervisor 已无但已知 root 仍活着。最后一条额外先见 signal-stop-root-red.log 1 FAIL，已将 root 纳入同一证明。控制进程表/kill 边界，不创建 OS 进程；所有 manifest/结果保留在 api/artifacts/role-agent-refactor/signal-proof。ack-only 服务缺 stopped 的对照明确拒绝假终态。

同型扫描在 HTTP-stream client 复现 stdio 已修的 error→exited 缺陷；httpstream-close-proof-red.log 为 2 PASS+1 FAIL。HTTP 亦只在真实 exit 设置 exited，error 仅置 closed，确实无 PID 的 spawn 失败不发信号。两行生产修复，受控 ChildProcess 三条新测试不使用网络/OS进程；未把该替身当原生树停止证明。

API 最终 tsc exit 0。signal-stop-proof-final.log 共 100 PASS+2 既有平台 SKIP，含八条真实 owner/REST、ack-only、原 F295/权限隔离、两传输 error/exit、HTTP client/pool-retirement 与取消恢复。首次全组 99 PASS+1 FAIL+2 SKIP：旧 manifest parsing and socket cleanup paths fail closed 用例在 Windows 调用基线明确禁止的 Unix socket 构造；基线 6d8 源及该旧用例已核对一致。未修改或放宽 Windows 禁用，最终仅通过 test-skip-pattern 明确排除该一个 POSIX 用例，排除项不能计通过。一次 name-pattern 过滤未命中该完整测试名，仍保留失败日志，未声称通过。

复杂度/fallback 复核：前一提交自动扫描净+3，实际 production 只多一个 serial catch，作用是重新抛出原清理异常而非 finally 覆盖为 done；queue 原吞错 helper 的 catch 被取消 owner 内持久化失败处理替代，净0；其余两项为测试清理 catch。本次沿原进程 owner 核验已有身份，未新增 catch/fallback 链。停止证明只覆盖已登记身份，不能替代未知子树、Windows birth 接线、跨 Host 持久资源绑定及完整 C12。34 全项仍 NOT_RUN。待原 reviewer 对修复 SHA 复核。

checkpoint_review 对 6add2c8e8276324cc0a3abb20e9e4b889a0168e2 仍返回 changes_requested，独立 44 PASS+3 FAIL；三个失败是同一个 P2 的低层 root/sibling 和实际 REST 变体。原 signal ACK 及前三条 P2、HTTP/stdio 对照均通过。最后一次 OS await 内才发布的身份没有被所查询 PID 覆盖，旧 child 及 parent 不得因此终结；真实新 child 仍 running 的证据保留在 reviewer teardown-signal-proof-late-6add2c8.json。

现在原 owner 在最后 await 后同步读取正式 manifest，当前同 scope 的每份记录必须已出现在 OS 观测前的集合且内容相同，否则 stopped=false，沿原有界重试。比较使用解析后的正式对象 isDeepStrictEqual；不引入 manifest revision、哈希协议、锁、恢复器或额外轮询。原 manifest 移位仍保留先前捕获的出生身份；异 scope 的新增 manifest 不阻塞该执行。

cli-execution-late-stop-proof.test.js 采用独立真实文件 I/O 反例，并补无关 scope 对照：late-stop-proof-red.log 为 1 PASS+2 FAIL。修复后 late-stop-proof-final.log 共 104 PASS+2 原平台 SKIP，同一个未改动的 POSIX-only socket 用例仍在 Windows 明确排除、不计通过；新增 REST late-sibling 实际写入第二份 child record/manifest，确认旧/新 child 及 parent 都保持 running、无 teardown/done/解锁。API tsc exit 0，两文件 Biome 无错误；控制进程表和信号边界不造 OS 进程，工件继续保留。

此复核只建立最后一次观测与当时已登记身份的一致性，不宣称跨进程原子锁、未知子树、缺失 Windows birth 或重启资源准入均已完成。完整 C12/W3 仍未完成、34 项仍 NOT_RUN，待修复 SHA 独立复核。

checkpoint_review 对 341e3da42d6b0ca8370239fa5383563a41bd5de9 返回 approved，独立 29 PASS、0 FAIL、0 SKIP：最后 await 内 root/sibling 文件 I/O、REST 新 child、原 signal ACK、9 种 stop、异 scope/ack-only 与 HTTP/stdio 对照全部通过；原五条相关 P2 已闭环。旧 SHA 的失败证据保留，独立最终日志为 api/artifacts/role-agent-checkpoint-review/teardown-stop-final-341e3da.log。批准仍只限当前切片，不代表完整 C12、未知树、Windows birth 和持久资源重新准入验收。

## W2 ACP 基础进程环境冻结（尚未完成 W2）

2026-10-30 00:31 UTC。实际 factory→AcpClient/HTTP-stream→spawn 边界的 acp-launch-environment-red.log 两条 FAIL：准入后更改宿主 marker，实际冷启动仍读取新值。现在在原 factory 使用既有 buildChildEnv 处理账号覆盖、剥离生命周期变量和 bootstrap cwd，保留私有基础环境快照；capture 前后核验其来源，变化要求重新解析。两个原 client 复制并消费该快照，不再次继承宿主环境；bootstrap 校验也使用同一快照。

连接池仍沿原 spawn signature/retirement owner 管理。完整环境含继承凭据，未把明文环境塞进 signature；仅加入用进程内随机密钥计算的 HMAC 指纹。密钥和环境都只在当前 Host 私有内存，不写日志/兼容摘要/数据库；这只是进程池身份，不能当持久 session compatKey。环境键先排序，避免字段顺序造成重建；既有 buildChildEnv 剥离的 invocation 生命周期输入不参与新池身份。不新增 launch 服务、配置项、环境数据库或通用框架。

API tsc exit 0 后，acp-launch-environment-green.log 43 PASS，含原工厂/bootstrap、账号来源/改选、目录配置、pool generation 和 error/exit。最终 acp-launch-environment-regression.log 344 PASS、无 skip，包含完整 Bridge 合同、两传输、iCode、进程池和实际 CodeAgent Node mock。新两条还覆盖捕获 await 期间变化拒绝、准入后冷启动保留旧值、下一合法 factory 用新池/新值，以及被剥离的生命周期 nonce 不触发无变化重建。实际 spawn 观察使用受控 ChildProcess，不冒充真实系统环境验收。

五文件 Biome 无错误，16 warning/5 info 未扩散治理。24 份 native-unconfirmed-lifecycle 作者实例全部 closed-data-retained/running:false，汇总 acp-launch-environment-native-instances.json；全组内其他 mock 沿原逐实例台账关闭，不产生真实模型/认证调用。数据保留，未启动常驻服务。

复杂度复核：两 client 只加同一可选内部环境输入；factory 复用现有构造核验/池 owner，单个准备函数在捕获与读后核验复用。仍未冻结具体 bare command/Windows shim/macOS binDir 选择及客户端特定启动增量，未处理 CA 文件内容版本、发现/探测统一计划、持久引用或全部 owner 激活通知，因此不能据此认证 C05/C13/C23、W2 或平台发行物。完整 34 项继续 NOT_RUN；待独立复核。

checkpoint_review 对 a55db0e62a8f9fdb0250c91ed2ba7868236ebbde 返回 approved，独立 26 PASS、无失败/跳过，包含显式账号覆盖、HOME、AGY inheritParentEnv:false/凭据隔离、两传输实际受控 spawn 和 nonce 不重建。批准仅基础环境；命令/shim 和完整 C23 尚未认证。

## W2 ACP 选定程序与 Windows shim 冻结（尚未完成 W2）

基础环境修复后继续检查程序选择。私有直接 client 反例显示 prepared PATH=A 而实际选择宿主 PATH=B；大小写归一后仍有效 FAIL。接至实际 factory 时发现 bootstrap 审计提前填充的共享缓存会偶然保留 A，但下一 factory 仍错误沿用 A：acp-factory-command-red.log 两条 FAIL。再通过现有合法 invalidateCliCommand 操作清理共享缓存，实际 factory 的已准入调用又切到 B，acp-factory-command-cache-red.log 两条 FAIL。不能以共享缓存偶然命中代替绑定。

现有 factory 在准备阶段选定 command/argv/shell，保存只读 preparedSpawn；两 client 复制并消费，不在冷启动重算路径或再次处理 Windows 参数。每个新 factory 沿已有 CLI resolver 重新解析；Windows 原 spawn helper 的可选 refresh 只为该调用更新 shim/Node 查找缓存，默认消费者语义不变。池签名使用实际选定程序、参数与 shell，bootstrap 验证也看同一计划；既有 Unix supervisor 仍在实际启动时添加自己的运行期归属。没有新通用 launcher、持久状态或插件脚本执行入口。

2026-10-30 本机补跑命令冻结、shell、启动审计、环境/MCP 冻结、iCode、模型身份、注册可用性、池签名、恢复重试和 factory 回归：`artifacts/role-agent-refactor-20261029-gpt-sol/acp-local-adapter-regression.log` 共 57 PASS、0 FAIL、0 SKIP。该结果只增加 Windows 隔离回归证据，仍不证明同一路径的可执行文件内容/版本、正式 discovery/probe、CA 内容、企业 CodeAgent 或 C23/W2 完整验收。

API tsc exit 0。acp-frozen-command-green.log 45 PASS+6 原平台专属 SKIP，含工厂、基础环境、原 Windows spawn/解析/转义与签名；acp-frozen-shim-green.log 两条 PASS 使用原 spawn 边界（Node builtin 受控），Windows 中文/空格目录下旧调用保留 entry-A，原 shim 更新且 A/B 同时存在后新 factory 使用 entry-B，含双引号、&、^、| 的参数保持原值，不再重复转换。acp-frozen-command-regression.log 362 PASS、无失败/跳过，含完整 Bridge、账号来源/改选、stdio/HTTP、iCode、进程池和真实 CodeAgent Node mock。

七文件 Biome 无错误，19 warning/8 info 未扩散治理。28 份 native-unconfirmed-lifecycle 实例均 closed-data-retained/running:false，汇总 acp-frozen-command-native-instances.json。新程序/脚本候选只是受控占位文件，未执行 native agent；Windows helper 的只读系统 Node 查找不是认证/模型调用。所有原生测试数据和命令证据保留。

复杂度复核：只在现有工厂/两 client/Windows helper 传递一个内部计划，复用既有缓存失效和池退休；原插件严格数据声明没有新增 prepared 字段。没有冻结/复制整套客户端发行目录；同路径可执行文件或 JS 内容版本、发现/探测共用计划、CA 文件更新、持久引用和实际 macOS/内网/安装物仍待完成。因此不认证完整 C05/C13/C23 或 W2，34 项仍 NOT_RUN。待独立复核。

作者 fallback 复核将两 client 的 command/args 分别回退收敛为一次整体 preparedSpawn 选择：内部类型已经保证完整计划，不允许按字段混合旧/新来源。最终 API tsc exit 0 后，acp-frozen-command-final.log 71 PASS、无 skip，包含两传输原 client、Windows 原 spawn、两新命令/两新 shim/基础环境。362 全组运行早于这个等价的整体选择收敛，未把旧结果伪装成该机械变化后的重跑；最终 client 实际消费由 71 条覆盖。每 client 一个兼容旧内部调用的回退不可移除，未新增失败重试或替代客户端。

checkpoint_review 对 18cf7c4b6bf5bb94fb68ea27f9bacf17ee2f290d 返回 changes_requested，独立原定向 12 PASS+2 原平台 SKIP，新四条 FAIL 对应两个 P2（各 stdio/HTTP）：初始 bootstrap 审计在刷新前读旧 shim 并固定旧 isolation，随后新计划却选 entry B；cmd fallback 的 shell:true 让真实 Node spawn 归一化阶段重新读当前 ComSpec。独立数据及原 SHA 失败日志保留，未改写为修复结果。

现在在同一 factory 先刷新并选定计划，再将它显式传给原 verifyAcpBootstrap。该 helper 默认仍用原 base，初始审计和默认 cold guard 都消费同一 chosen command/args；原目录安全、严格 root 及冷启动检查未放宽。cmd fallback 在 factory 解析为显式 shell 字符串，preparedSpawn 的类型也只接受已选定的 string，不保留 true 给 Node 晚读。没有新增启动器或降级策略。

采用独立原反例为永久 acp-command-startup-audit.test.js 和 acp-frozen-shell.test.js，acp-audit-shell-red.log 四条有效 FAIL。API tsc exit 0 后 acp-audit-shell-green.log 17 PASS；acp-audit-shell-policy.log 77 PASS+5 原平台 SKIP，覆盖原 Pi/AGY/Windows cwd、volume root、冷启动复核及新四条；acp-audit-shell-regression.log 366 PASS、无失败/跳过，覆盖此前整个合同/账号/两传输/iCode/进程池/Node mock 集合和新例。shell 见证只在 ChildProcess.prototype.spawn 的 OS 边界截获，保留真实 Node 参数归一化，没有执行 native Agent；原进程对象在 fixture 内关闭。

五文件 Biome 无错误，11 warning/6 info 未扩散治理。32 份 native-unconfirmed-lifecycle 台账全部 closed-data-retained/running:false，见 acp-audit-shell-native-instances.json；六份原方案哈希仍完全相同，见 source-integrity-acp-audit-shell.json。未连接生产 Redis、未使用真实认证/模型；测试和诊断目录保留。复杂度复核仍仅三处原生产文件，选择提前、原 helper 显式消费、隐式 shell 转显式，不新增 fallback 链。上述其余版本/CA/持久引用/平台缺口及 34 个 NOT_RUN 保持，待修复 SHA 独立复核。

## W2 普通部署插件 MCP 激活冻结（尚未完成 W2）

普通部署原先 `resolveMemberMcpView()` 直接返回 undefined，读取已持久化 MCP 描述符时没有接上现有激活 owner 的代次检查，且 ACP 冻结值仍可能是稳定环境引用。复用 `NativeMcpLaunches.memberView()`，让所有有资源 owner 的 Host 都核验本地激活；仅隔离部署提供 localCapabilityRoot 来补未发布策略，普通部署保留持久配置对启用、blockedCats 和显式 override 的权威。没有新增 revision、存储、配置项或通用启动器。

真实 runtime composition → 正式 prepareInvocationExecutionBinding → ACP capture 的六个用例，分别覆盖普通/隔离部署、无变更、准入期间只改变 action generation、真实 configRefresh。校正测试对 ACP env 数组及 Host 生命周期稳定 token 的理解后，`persisted-plugin-currentness-red-owner.log` 为 3 PASS/3 FAIL；普通部署三个反例均成立，隔离部署三个对照通过。冻结后禁用仍保留旧值，下一调用不再取得已禁用工具；重新启用取得本 Host 的实际激活值。稳定 token 不被误当作 generation 指标。

`persisted-plugin-currentness-tsc.log` API tsc 退出 0；`persisted-plugin-currentness-green.log` 49 PASS；`persisted-plugin-currentness-regression.log` 237 PASS，无失败或跳过，包含全部现有 session-contract、客户端 MCP 当前性、持久根和生产 composition 激活回归。Biome 三文件退出 0。没有调用模型、启动 MCP 程序、访问原生历史或 Redis；测试临时 composition 由原有 fixture shutdown 收尾。独立审查待回执，不据此宣称 W2/C05/C15/C20 全量通过。
checkpoint_review 对 f7c628e836625d6ebadd76b5ead9988ebe6ac705 给出 approved，独立 31 PASS、无失败或跳过。补充真实普通 composition → 原 memberView → 原 native resolver 的 canonical blockedCats/禁用、显式 override（active/空 view）、foreign plugin 与 healthy、external MCP 对照。原代次/并发 scope/准入漂移组通过。typed 回执的初始 subject 沿用旧值，审查者已单独更正为 checkpoint-persisted-plugin-mcp-currentness；无重跑、无改变 SHA 或结论。日志 packages/api/artifacts/role-agent-checkpoint-review/persisted-plugin-currentness-f7c628e.log；dist 已释放。只批准本切片。

## W3 会话事件归属核验（尚未完成 W3）

在真实 AgentSessionBridgeService 事件消费边界，迟到事件只需碰巧拥有当前 deliveryId 就能消耗当前 read callback；异会话 native_bound 还会错误投影为当前 session_init。session-event-identity-red.log 为 1 PASS/4 FAIL，分别复现 Host session、invocation、已知 native turn 不匹配和外部 session 元数据污染。

现在在 observe、绑定及投影之前比较事件 sessionId、turn invocationId，并在双方已有 native turn 时比较该 ID；session 级事件明确携带 nativeTurnRef 时也适用。忽略不属于当前调用的事件，不认领其回执、不终结本轮、不投影其内容。缺少原生 turn ID 时仍使用已有 Host session/invocation 权威，不编造原生证明。没有持久状态、额外缓存或后台清理器；同一 consumer 加十行。

API tsc 退出 0。首次完整合同回归为 222 PASS/4 FAIL，新增五条已通过；四条既有取消用例的“停止后下一轮”仍发送旧 invocationId=inv 的假 done。将该后继夹具明确标为它请求的 next（只改原测试三行），保留取消等待断言和所有旧实际行为。session-event-identity-green.log 为 351 PASS，无失败/跳过，包含全部 session-contract 及原 append 发送/已读/未知/回读核对/HTTP/完成/重入边界。Biome 三文件无错误，三条原复杂度/受控 finally throw 警告。生产 Bridge 314 行，未拆出一次性函数。

独立审查待回执。该检查不替代实际客户端/父子工具持久回读、未知输入重启恢复、兼容键与身份采用；C11/C24 全项仍未完成。真实 Node mock 只跑既有用例，沿原台账等待关闭并保留数据，没有调用模型或企业认证。
checkpoint_review 对 9e215d214aee33c7d42c547ad611fd3ed5be659a 返回 changes_requested：独立 51 PASS/2 FAIL，同一 P2 是 start 返回的 turn.invocationId 替换了 Host 比较基准。新增永久反例，session-event-host-authority-red.log 为 5 PASS/2 FAIL；补充客户端修改传入 invocation 对象的对照，private-authority-red 为 1 PASS/1 FAIL。修复保留 start 前已复制到私有 live.turn 的 Host invocationId，只接纳返回的原生 turn 信息，不从已传给 provider 的对象重新取 Host 身份。两条返回旧 ID 的永久反例中补入合法当前 status，允许“忽略旧帧后继续等待当前帧”的正确实现推进；独立原失败见证原文件未修改。

## W3 已知未停止的旧执行阻止新准入（尚未完成 W3）

此前虽保留了 provider 已启动/停止未确认的规范 child，重新走普通串/并行入口仍会调用 provider；prior-stop-admission-red.log 为 5 PASS/3 FAIL，包含两条实际路由反例和规范 owner 读取失败仍发任务。现于既有会话独占权取得后、provider 启动前调用现有 listRunningByUser，按当前 thread/cat 排除本次 child，复用 hasUnconfirmedProviderTeardown。存在未确认旧执行则以可操作的中文原因失败；当前新 child 未标 providerStarted、原 child 和历史保留。读取失败也不发任务；既有 owner 写入实际停止证明后再准入，不新增锁、数据库、租约或自动重投。

八条路由检查覆盖零时间戳、普通串/并行、停止证明解除限制，以及其他用户/线程/成员、未启动和已停止对照。这个边界只使用当前规范记录，不是持久绑定注册表；尚不能证明跨线程同一 native 状态根资源隔离、PID birth 重建或真实 Host 重启后的控制能力。C12/C16 不据此全过。

API tsc 退出 0。prior-stop-and-host-authority-green.log 为 385 PASS，无失败或跳过，涵盖全部 session-contract、1398 输入回执/未知核对/HTTP/完成链、取消 Queue/sibling/受控恢复、终态写入、晚到停止证明及真实 Node CodeAgent mock；此集合在将 Host 身份来源进一步改为私有 live.turn 之前完成。最终同一私有来源修正后再 tsc 退出 0，prior-stop-and-host-authority-final.log 为 74 PASS（Bridge/dispatcher/真实 ACP provider、八个归属用例与八个准入用例），无失败或跳过；没有把修正前 385 项冒充最终全量重跑。Biome 无错误，原巨函数和受控清理等 warning 未扩散为额外治理。source-integrity-prior-stop.json 六份接受方案哈希完全一致。两项均等待修复 SHA 的独立复核。
独立审查 1a780d4f54027ee9746879796bc5baad826fae4a 分别裁决：session-event-identity approved（原 P2 及可变请求对象变体闭环）；prior-provider-admission changes_requested。共用集合 59 PASS/1 FAIL，失败属于新增准入读取的取消时序，未叠计成两组通过。旧记录保护、精确停止证明后放行及其他作用域均通过。

该 P2 在真实 routeSerial → 会话 custody → 新读取边界复现：custody await 返回时 signal 已取消，原代码仍先创建读取 Promise；preflightRace 随即拒绝，读取稍后的异常成为未处理拒绝。永久 prior-admission-cancel.test.js 和独立 Node helper 以 --unhandled-rejections=strict 验证；prior-stop-admission-cancel-red.log 为 1 PASS/1 FAIL，真实子进程 exit 1。只在创建这次读取前增加 signal.throwIfAborted，不改全局 helper。取消发生在已开始读取中仍由原 race 处理。API tsc exit 0，prior-stop-admission-cancel-green.log 99 PASS，无失败/跳过，包含两条真实严格子进程、原八条准入、所有归属反例以及相关取消/恢复/Bridge/dispatcher/ACP 回归。子进程均已退出，未启动真实 Agent、模型、Redis 或交互服务。该单行修复等待新 SHA 独立回执。

checkpoint_review 对 eb0f9383e4269002f98cd3b68ab289f01ad8942c 给出 approved，独立精确路径集合 19 PASS/0 FAIL/0 SKIP。原独立 strict 子进程现在 exit 0/read 0，永久取消前/读取中两个 strict worker 为 read 0/read 1 且退出 0；原八个准入控制和事件归属回归通过。原 P2 已闭环，见 packages/api/artifacts/role-agent-checkpoint-review/prior-admission-eb0f938-final.log。无 Agent、模型、Redis 或常驻服务实例遗留，dist 已释放；批准只限本次准入切片。用户最新确认暂无 Mac 已同步平台矩阵，必需组合暂 BLOCKED；其他实现继续。
## W3 静态身份前缀按实际正文与片段复用（尚未完成 W3）

在进入持久兼容结构前，现有普通消息前缀还有两个错误来源：全局 registry revision 与实际正文不对应，而且在发送前就记为已注入。正式 invokeSingleCat → provider 边界复现头像变化导致无谓补发、正文变化但 revision 不变时漏发、失败后错记采用、未知旧原生 ID 首轮漏发；改正“重复 register”夹具为真实 reload 后，static-identity-content-red-valid.log 为 1 PASS/4 FAIL。另有 static-identity-segment-red.log 证实不同原生片段错误共用缓存；static-identity-compression-red-valid.log 在声明真实调用方 capacity snapshot 合同后，准确复现压缩后第三轮失败、第四轮不再补发的问题。最初未声明 capacity 的压缩夹具在第三轮失败，不当作该第四轮反例。

沿用原私有 Map，只保存已成功处理的实际 params.systemPrompt 正文 SHA 与原生坐标，不存正文。普通载体比较实际 native session ID；bg 沿已有逻辑 record/chainKey，不用每轮 daemon shortId 作上下文边界。session_init 经既有绑定 owner 接受后才更新待记坐标，typed done、无 error/取消且清理流程成功走完后才记缓存；原生认证续接的固定正文不记成身份投递。压缩或冷连续性判定先使旧缓存失去可信度，失败后仍须补发。未知旧坐标在既有一般任务路径补当前消息前缀，不宣称原地更新系统身份。

本改动没有持久化这个 SHA，没有把它叫作 PersonaDigest、实际 Native InstructionDigest 或 CompatKey，没有复用它作进程池键，也没有放宽 AGY 原生绑定。W2 安全持久引用、W3 稳定兼容结构/新片段、系统级身份采用后落盘和强任务档准入仍必须继续实现；本切片不能充作 C07/C10 全量通过。

生产修改限原 invocation owner：替换一个原 Map 值、按正文/片段判断、将记账移至成功终态，并在现有 session_init 分支记实际坐标；代码总体保持同一函数，没有新服务、配置、数据库、会话管理器或重投框架。测试新增八项（184 行），包括真实 routeSerial 两轮消费，未只验证哈希对象。五个旧“warm”夹具先走一次真实成功的静态前缀投递，再保留原“不重复注入/压缩后补发/staging/动态路由内容”断言。旧 effort/speed 测试改验每次调用的实际选值及所有读取的 owner 范围，允许准入前后核对，不再把单次读取次数当外部行为。旧迁移夹具真实保存新路径并验证首次准入冲突无 provider、一次重解析后仅调用一次，保留单次迁移断言。

API tsc 最终退出 0（最初一次缺 createHash import 的类型错误已纠正，未用失败构建跑断言）。static-identity-content-final-green.log 八项 PASS；static-identity-content-contracts.log 为 252 PASS，含全部 session-contract、bg chain、resume health 和 timeout；static-identity-request-audit.log 为 15 PASS，涵盖实际准备字节、投递回执、保密字段和持久失败阻止发送。Biome 三文件无错误，33 条既有复杂度/测试控制等 warning，未扩大治理改动。

扩大前的 static-identity-content-first-green.log 实际是 170 PASS/22 FAIL（文件名不代表通过），失败为 14 个当前 Windows AGY Native 进程出生身份/其后无 effect 文件的问题，及上述 8 个旧夹具假设。相关 F325 支持限制仍保留 FAIL，不以消息前缀替代认证或关闭原生 guard。移出十项 Native-auth 文件、明确排除四项相同 Windows Native guard 场景后的普通 owner 集合第一次为 179 PASS/1 FAIL；最后一个旧迁移夹具反映真实写回后需重解析，修正后独立目标一项 PASS。static-identity-content-owner-final.log 最终普通 owner 集合 181 PASS/0 FAIL；四项已明确排除而不进入 Node 结果分母，不计通过。十项 Native-auth 的失败证据单独保留；两个触发 birth guard 的原生 owner 文件相对 6d8 基线未改动（Git diff 为空）。原失败见证均保留。完整 Native/macOS/最终包与 Q 仍未完成，独立审查待回执。

checkpoint_review 对 c4d5f2dbaf63623caa4946c0ac0b307efb869382 返回 changes_requested，独立 15 PASS/3 FAIL，两条 P2：A 成功后 B 失败/取消，回退 A 却继续用旧 A 缓存（两个变体）；session_init 报 B 但原绑定 owner 读取失败未接受，仍借旧 resume A 为 B 正文记缓存。BG daemon/逻辑片段及清理异常的独立对照通过。原独立失败文件、日志保留，未重写为绿灯。

采用三条原反例为 static-identity-evidence.test.js（167 行），只调整 imports，未删改输入/核心断言；static-identity-evidence-red.log 三条 FAIL。生产只四处原行修改：开始交付前缀前清除旧证据；待提交坐标从已知 warm 值开始，一旦出现 session_init 就先置未知，只有原 binding owner 接受才重设；成功时使用这个待提交值，不重新取旧 resume/logical ID 代证。无 session_init 的既有 warm 路径保留自身已知坐标，原 auth continuation 仍不记成身份正文；没有改 session store 的既有 best-effort 行为或放宽 Native 绑定。

API tsc 退出 0，static-identity-evidence-green.log 26 PASS（十一条身份证据及十五条请求审计），static-identity-evidence-owner.log 22 PASS（原 warm/staging/压缩/名册/路由/迁移用例），static-identity-evidence-contracts.log 252 PASS（原全部 session-contract、BG chain、resume health、timeout）。均无失败或跳过。181 项普通 owner 是该补丁前的完整结果，未把它冒充修复后全量重跑；同一已知 Windows Native 限制仍保留，不重复制造相关调用。两文件 Biome 无错误，24 条既有 warning。单文件生产逻辑净减少一行；修复后独立回执待补。所有模型/企业能力/平台/持久兼容缺口保持不变。

checkpoint_review 对 022526e2b16915c0b474dfd183b771eb89fca68a 给出 approved，独立 23 PASS/0 FAIL/0 SKIP。原三反例、公开十一条身份证据、BG 稳定/已 sealed 新片段、typed done 后 source 清理失败与精确恢复，以及 warm 无 session_init/cold 无已知坐标对照均通过。证据为 packages/api/artifacts/role-agent-checkpoint-review/static-prefix-022526e-final.log（21 PASS）和 static-prefix-no-init-022526e.log（2 PASS），不重复计数。两条 P2 闭环，旧失败日志保留；仅内存服务/store，无 Agent、模型、Redis 或常驻服务遗留，dist 已释放。此批准严格限定普通前缀缓存，不扩大为持久兼容或强身份验收。
