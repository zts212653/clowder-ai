# F202 迁移等价实施约束（2026-10-31）

状态：首轮非作者代码复审提出的生命周期与真实 consumer 集成问题已修复，等待修复候选的独立复审与 exact-HEAD 完整门禁；尚未完成共创者体验或 fork soak。

## 本轮授权与边界

共创者消息 `0001793429159213-008193-fa43b2c9`：「可以那按照这个思路重新调整下吧 好了我再去验收的」。前文 `0001793429041679-008185-a41c2a74` 明确提出 Dot 密钥轮换应归插件内部。解释以本轮原话为准，不以旧草案扩张范围。

原 Task `0001792564577431-004187-d5628b99`、owner `codex`、thread `thread_mvgmbqy65mk8bnox` 均保留。sol 已回读 Task，原 Task 仍开放；不新建重复责任。

实施基线：Host `ded225ec3e6d6d4b96d041eb61c7ea6ac9214fcd`；插件 `07b2add0cb3a0c572fd01d1a86405ad4fac67190`。两处 tracked 工作区均干净。

## 已有能力与实际缺口

已有 `/plugin/mcp → PluginExternalAccessService → 固定 handle`，不再新造一个同义调用接口。
缺口是原 `/mcp` 共享连接不再发现和调用插件；先接回这条路径，再验证插件的订阅/读原文/原处回复/原图/ask。

Host 只负责原通用身份验证、主人对共享暴露的授权、当前安装与启用状态、固定 handle 转交；不得解释 Dot 配对码、回调凭据、订阅或业务字段。
Dot 配对、订阅、内部凭据及轮换、断开/恢复归插件。**本次不开发 Host Dot 密钥轮换能力**。原 AgentKey 认证及其撤销行为沿用；相关测试仅证明迁移未破坏既有通用认证，不是新产品功能、也不是要求主人更换凭据。

## 方案继承

采用已复核 v4 的共享接线与主人授权边界，见 [共享连接方案](2026-10-30-f202-dot-shared-connection-plan.md)，精确摘要 `cb55dd929daafc3eb64989756a28357f24f9a14349427b1955f3dfb687a9f078`，独立 review `0001793371272342-005069-dedf3b0b`。该原文保留不改；其“等待允许实现”状态已由本轮授权更新，不代表代码已完成。

v4 的稳定身份和 verified reinstall 条款只是避免迁移破坏原连接的约束。不得把它做成新的密钥管理平台。保留单一通用连接目标、当前 surface、主人确认与跨请求 presentation 校验；不建设多插件聚合、OAuth 或新向导。

原共享主流程不输出 Host token，不要求再装一份 Dot 云端连接。设置页通过插件配置提供能直接使用的订阅说明、准确状态和两处来源往返反馈；原始 JSON 不充当主要操作说明。

## 开发与验证

1. 先观察真实 `/mcp` 的行为 RED，恢复共享发现/工具调用/events 承载；使用通用 fixture 名称，禁止 Host 新增 Dot 常量和 selector。
2. 实现 Host 的最窄授权接线与已有 fixed handle 对接。v4 的 pending proposal 使用第二次新 owner 请求确认，整行 Host 权威展示在响应/写状态前校验；不是延长第一次请求授权。
3. 插件通过固定 port 获取共享连接状态/绑定，自己处理配对、订阅与业务恢复；保持现有有效 attempt 和数据。凭据不得返回共享准备结果。
4. 隔离数据做真实认证路由 + packed consumer 检查，覆盖现有 Host toolset、共享调用、跨 owner 拒绝、禁用、旧连接/配对迁移、经过验证的重装、历史原图、两来源回复；确认取消/篡改/过期/多 tab 边界一并验证。
5. 完成后提交准确 Host/plugin HEAD、包路径/hash 和测试证据给 sol 非作者 review；不足处修复后再交共创者体验。

候选内当前共享回归 `remote-shared-dot.test.ts` 断言“不转发插件”，只能保留为未绑定场景，不能继续作为共享迁移完成标准。新增 `remote-shared-extension.test.ts` 针对获准实例走同一 `/mcp` 的行为；内部接线路径选为 `/api/plugin-runtime/shared/handle`，与独立安装入口分开认证但复用固定 handle。Host 端仍须另有真实认证路由/授权/调用测试；fake Host 不能代替它。

## 运行与验收边界

原 feature 工位完成所有开发，不移动运行实例源码或数据。5182/3182 可能正在被主人使用，**不原地覆盖其 API dist 或 Web .next**；使用该工位内隔离夹具重建。不得自行重启、修改运行配置、续开公网隧道、合并、宣称体验/soak 通过。

旧完整 gate 只属于 `4215128fbdf8877d257d545f6cf4acca740f8318`，不是当前 HEAD 或新实现的全绿收据。当前 alpha.3 的 98/35 项历史验证同样不能代替新共享路径测试。

交付体验时应有：匹配 Host 与插件包、可执行启动/更新步骤、猫已走过的关键操作与实际结果、主人最后验证的云端步骤。主人验收主线是准备/复制说明 → 原云端连接订阅 → 两个本地对话召唤并原处回复 → 原图 → 停启恢复；不用主人手工换密钥或折腾生产重装来替代自动化测试。真实云端证据与 fork soak 完成前不结束 F202。

## 首个 RED 收据

2026-10-31 在上述 Host 工位运行：

```sh
cd packages/mcp-server
node --import ./test/helpers/isolate-callback-outbox.mjs --import tsx --test test/remote-shared-extension.test.ts
```

exit 1，1 test / 0 pass / 1 fail。真实 HTTP initialize 的 `result.capabilities.events` 为 `undefined`，预期获准扩展提供的 `{}`；失败位置为新测试约第 107 行（格式化会改变行号）。这是缺失共享事件承载的预期行为失败，不是构建或环境错误。尚未到达后续 tools/list、tools/call、events/list 断言。此测试使用自己的临时监听端口、假 AgentKey 与隔离 callback outbox，不访问运行实例。

该 RED 只覆盖 Remote HTTP 端；fake Host 表示获准扩展，不证明真实 Host 授权。实现方须补真实 Host owner/绑定/固定 handle 集成检查，不能只使假 Host 测试通过便交付验收。

## 实施结果（2026-10-31）

Host 已把原 `/mcp` 接回一个主人批准的单一共享插件 surface，并复用现有 fixed `handle`。Host 保存五分钟提案、权威确认行、精确安装/运行代次、包来源与工具/事件摘要；第二次 owner 请求须带回原 `proposalRef`，并在响应展示、状态提交和实际调用三处重新核验。插件不能选择 wire method、不能读取 AgentKey，也不能用自造行扩大 surface。过期且未提交的提案会在下一次准备时清理，当前 active 绑定的幂等凭据保留。

MCP 端仍先提供原 Host tools；只在当前 AgentKey 的主人有 active 绑定时合并获准插件 tools/events。Host 名称冲突、重复 descriptor、部分/游标 surface、私有方法、未批准工具/事件、跨 owner key、撤销或运行中换绑均 fail closed。共享调用完成后还会重新核对 AgentKey、安装代次与 exact binding，避免撤销中的响应泄漏。

Dot 插件只通过 Host 提供的通用 `external.shared` 固定端口查询、准备、绑定和解绑。`dot.begin` 保留插件自己的配对 attempt，但不再返回 Host token；`dot.disconnect` 先按 exact revision 撤销共享 slot，再撤销 Dot 配对。旧用户由完整性验证后的 legacy import 留下审计，插件真正 enable 后才执行同来源 shared adoption；休眠 runtime 不被迁移代码偷偷拉起。surface 变化进入 `needs-confirmation`，不会静默扩大。

冻结插件候选：

- 插件源码 HEAD：`5ee8e4d97a803a1b4efa528a3b48d24265917b12`
- 包：`@clowder-ai/chatgpt-dot@0.2.0-alpha.5`
- SHA256：`57de8a5018c176aa6560a1ac77465996bf72f1f6b4ddf557178bf4cd9bc01b40`
- 构建产物：`/private/tmp/f202-dot-alpha5.vBbrCQ/clowder-ai-chatgpt-dot-0.2.0-alpha.5.tgz`
- Host 冻结副本与该产物 `cmp` 字节一致；manifest 与插件源码投影一致。

真实体验补充（2026-11-01）：

- 隔离工位没有自己的 cloud-conversation principal 时，登录 ChatGPT 并不会建立共享连接。
- alpha.4 的 `dot.begin` 在 shared unavailable / pending 时仍先创建配对，并把订阅说明附在失败行后，造成“可以继续”的假象。
- alpha.5 改为先读取 Host shared 状态；只有 `active` 才创建配对并返回订阅说明。unavailable / pending 均不创建连接状态。
- 公共 feature checkout 没有完整的 cloud gateway bootstrap helper。隔离验收必须使用本工位自身签发的 `gpt-pro` cloud-conversation key、既有 `remote-spike` 和主人建立的临时 HTTPS tunnel；不得借用正式 Redis、正式 key 或旧 URL。
- 这条临时验收连接不改变迁移目标：正式使用仍沿用原来的一份共享 `/mcp`，不是为 Dot 新增第二套连接。

首轮非作者复审修复：

- 共享调用在 surface discovery 后、业务 dispatch 前重读 exact binding、AgentKey、安装与 runtime 代次；调用后 fence 仍保留。撤销、key 失效或安装代次变化时业务 handler 的调用计数保持为零。
- 断开保留 tombstone revision，新 prepare 的 CAS 以该真实 revision 为基础，显式的新主人确认可以再次连接。
- `needs-confirmation` 状态下经验证的同 lineage 重装会更新到新实例，但保留旧批准范围和待确认状态；不自动扩权。
- 打开 Settings 不再自动执行 `begin`；真实 alpha.4 manifest 经 Host Manager 投影后，status、prepare、reconnect、disconnect、roundtrip 和行确认同时可见。通用 rows renderer 展示 text/status `result.data`，配对说明与往返证据不再丢失。

定向验证：

- 插件全套测试 `100/100`，typecheck 通过。
- Host shared owner/route/确认行与对抗用例 `18/18`；追加提案清理与 Manager 有界错误后相关组 `41/41`。
- 真实冻结包 legacy migration/update/reinstall `6/6`，其中 packed 主旅程实际启动 runtime 并经 shared route 调用。
- Manager、catalog、icon 与 bundled carrier `43/43`；native bundled archive build/link/hash `14/14`。
- 原 `/mcp` 未绑定/已绑定远端协议 `2/2`；API build、Biome、`git diff --check` 通过。
- 首轮复审修复的 Host lifecycle/真实 manifest 投影/冻结包构建 `39/39`；reviewer 原竞态 probe `3/3`；真实 packed manifest Web DOM `22/22`。
- 相关 operations、legacy fenced adapter、C1 主链、shared route、external access 与 packed migration/runtime 旅程合计 `28/28`。该 8 MiB 冻结包旅程的冷物化与完整性校验显式使用 180 秒测试预算；生产 operation 的 60 秒默认未改。

这些证据不替代最终 Host exact HEAD 的 `pnpm gate`，也不替代共创者真实云端体验和 fork soak。最终 Host commit、完整 gate 收据及非作者 verdict 在 handoff 中记录。
