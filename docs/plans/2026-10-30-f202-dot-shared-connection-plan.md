# F202 Dot 等价迁移：单共享扩展槽方案 v4（待复核）

状态：仅方案，未开始实现。作者：砚砚 / gpt-6.1-sol。
Host 基线 ded225ec3e6d6d4b96d041eb61c7ea6ac9214fcd；插件基线 07b2add0cb3a0c572fd01d1a86405ad4fac67190。
上一稿 SHA256 801c117b855e7e5afc4a6ce981448a80b585299455c924f5705401233a825a21；5.6 复核消息 0001793370194845-004997-d37173a3 为 changes_requested（2 P1、2 P2）。v2 复核消息 0001793370728865-005027-acbb204a 确认原四项已解决，并指出跨请求 proposal 生命周期 P1 与 ref 回传 P2；v3 复核消息 0001793371082189-005054-cb4f3029 确认跨请求与 ref 回传已解决，要求补 Host 响应前 presentation 完整性 P1。本稿选定整行校验执行点，不自称复核通过。

## 范围和实物依据

用户 0001792564244022-004158-6e59393a / 0001792564544995-004183-102870d5 接受固定接口、call 寻址声明、移除 Host Dot 方法分发。用户 0001793350656892-004385-2cf975af 又明确迁移优先，产品改造后置。

旧基线 b2c9952f27 的 UI、connection route、remote-shared-dot 实物表明：原主流程复用已有 `/mcp` 猫咖连接，复制订阅说明后在目标对话订阅 dot.summoned，不另装 Dot 连接、不更换 Pro 口令。旧 verifySharedPrincipal 每次验证当前 live key 后只导出稳定 owner；没有把 key generation 当作长期配对身份。

当前 452df9a832 删除共享 Dot 承载，当前测试还断言 Pro 入口不转发插件；该结构改变导致原主流程未被等价保留。当前 alpha.3 插件已经支持工具/事件发现、订阅和调用；不需要新 OAuth 才能处理原有共享业务。

本次只保留原 Host toolset 加一个业务中立 shared-extension slot，不建设多插件发布平台、任意数量 slots、新 OAuth、新账号平台或全新多步骤向导。共享入口可达与账号登录仍需真实验证，源码检查不等于云端验收。

## 用户结果

旧用户继续使用原云端连接、账号口令、有效配对和历史内容。正常 key 轮换和经过验证的同 lineage 重装不要求重新连接或换 token。新装 Dot 但已经有猫咖连接的用户在本地准备订阅说明，明确确认将这个安装连接到共享槽，然后把说明发给目标云端对话。

完全没有猫咖云端连接的部署沿原有接入流程处理，不把建设独立 OAuth 当作迁移前提。共享槽已占用时明确说明，不静默替换；多插件同时公开是后续增量。

## 单槽数据流

```text
/mcp 原有 live auth
  → Host stable principal resolver（owner + logical cloud principal）
  → 该 principal 唯一 shared-extension slot
  → current surface snapshot + binding revision + runtime generation
  → 固定 handle(request)
  → 插件自己解析工具/事件、配对和业务参数
```

既有 Host 工具保持原路径。slot 的 tools/events 来自插件，不由 Host 写 Dot 常量。外部 caller 不通过 userId、pluginId、instanceId、alias 或任意 action method 选择目标；发现映射与绑定都在 Host 内。

## 稳定身份、真相源和持久记录

| 对象 | 真相源 | 变化如何影响访问 |
|---|---|---|
| 请求凭据是否 live | 既有 Remote 与 Host 身份验证 | 旧 key 撤销后当次请求拒绝；同 owner/稳定 principal 的新 live key 可继续使用原槽 |
| 稳定 principal | Host 注册身份，ownerUserId + connection kind + 逻辑 cloud catId | 展示别名或 key 轮换不改变它；owner/逻辑 principal 真正变化不继承绑定 |
| shared-extension slot | Host 专用持久记录，按稳定 principal 唯一 | owner 确认、迁移交接、撤销和受控 rebind 是唯一写入口 |
| 工具/事件 surface | 插件固定 handle 的有界发现结果 | snapshot 与批准的 canonical digest 相符才可执行；改变须确认，不凭缓存扩权 |
| Dot 配对/订阅/业务记录 | Dot 私有持久状态 | 保持原业务生命周期，不在 Host 再造 Dot 状态机 |
| 历史消息、原图 | 既有消息/媒体与原迁移记录 | 保持持久性与可见性，卸载不删历史 |

Host binding record v1 的冻结内容：

- `ownerUserId`、`principal { kind, logicalId }`：来自 Host 身份事实，不来自插件 JSON。
- `instanceId` 与 `lineage`：记录受信 admission origin、稳定 package identity、owner approval/migration provenance。pluginId 或同名 alias 单独不足以证明 lineage。
- `admittedPackageDigest`、`approvedSurfaceDigest`：批准的当前包与工具/事件 surface；完整 descriptors 只按必要性留作 owner 确认/审计，不另存业务正文。
- `revision`、`state`（active / needs-confirmation / revoked）、`authorizedBy`（owner-confirmation ref 或已验证 migration receipt ref）、`updatedAt`。
- 不保存 raw key、agentKeyId、Host token 或代理收到的认证 header。无数据 TTL；runtime unavailable 是当前事实派生，不永久撤销该槽。

## 主人批准与通用 SDK port

建议新增的固定类型 port 是 `host.external.shared`，只供当前安装自己的 owner settings 操作使用，不在 manifest 指定方法名或可变 runtime selector。它是本方案拟定契约，当前 SDK 尚不存在：

```ts
interface PluginSharedExtensionPort {
  status(): Promise<SharedConnectionView>;
  prepare(input: { confirmationActionId: string }): Promise<SharedBindingProposalView>;
  bind(proposalRef: string): Promise<SharedConnectionView>;
  unbind(expectedBindingRevision: number): Promise<SharedConnectionView>;
}
```

- Host port 从自己捕获的 owner-operation context/会话与当前安装解析 owner、实例和逻辑 principal，不相信插件传一个 kind/confirmed/userId 对象。匿名外部 handle、后台 delivery 和普通读取不能绑定或撤销。
- prepare 产生 Host 持久的、有界、无 secret 待确认对象，TTL 为 5 分钟。它不是第一份 owner-operation capability 的延长，也不是 Hub/F276 提案或新 Task。第一次 action 返回后 signal/assertCurrent/request authority 正常失效，待确认对象仍可在 TTL 内供第二次请求核验。
- proposal 持久字段固定为：opaque proposalRef、ownerUserId、stable principal、Host 捕获的 sessionBindingId、operationKey、已声明的 confirmationActionId、精确 instance/lineage/package/surface digest、runtime generation、expected slot revision、issuedAt/expiresAt、state（pending/committed/cancelled）、canonicalPresentation 与 presentationReady（初始 false）。producer requestId 只作审计，不是第二次请求的 authority 或相等条件。
- prepare(input.confirmationActionId) 只接受本次 Host 捕获的 operation 中已声明、带 confirm 的 row action id；Host 从实际 manifest 校验，不接受 action method 或任意执行目标。该参数是现有 Console 行操作坐标，和固定 deliver/handle 的运行时 selector 无关。Host 输出不可改 scope 的摘要与确认文案。
- 主人看完具体范围后，Console 发起一份全新的 row action HTTP 请求。Host 重新取得真实本地 owner session、CSRF、confirmed:true 与当前 operation context；不复用第一请求的 signal/assertCurrent/requestId，也不接受插件提交一个自称 owner/session/confirmed 的对象。
- bind(proposalRef) 必须验证新请求的 owner、stable principal、sessionBindingId、operationKey 和 confirmationActionId 与持久 proposal 相符；再复查 presentationReady、TTL/state、精确实例/lineage/包/surface/runtime 与 slot revision。第一请求已结束是正常条件，不导致 bind 失败；期间任一权限事实已变则拒绝并重新 prepare。
- bind 通过一次 Host CAS 同时提交 slot 与该 proposal 的 committed 结果，或使用同等可恢复的单 owner 事务记录；不能先消费 proposal 后丢失 slot 写入。两个 tab 竞争时至多一个提交成功。幂等重试只有在新请求仍有当前 authority、proposal 的原提交结果仍等于当前 slot 时返回该结果；不得借已消费 ref 产生新授权。
- pending 对象只用于一次确认，不能单凭 ref 调用插件；没有新 owner context 的 ref 不能授权。过期或取消后拒绝，原审批审计与用户绑定按原持久规则保留。刷新/重启造成 sessionBindingId 变化时，未提交 proposal 需重新准备；已经 active 的长期 binding 不因浏览器会话变化丢失。
- 多 tab 可持有各自精确的 proposalRef，任何旧行都只指向原对象。新 prepare 不偷偷替换旧 ref 的内容；从不实现「绑定当前最新 proposal」。同一 session/同一 basis 的重复 prepare 可复用未过期 proposal；basis 改变则生成新 ref，旧 ref 不能通过 bind 当前性检查。
- 已有等价 active binding 时 prepare/bind 不反复要求批准，也不修改 Dot 配对。slot 被其它实例占用时返回 occupied，不替换或公开其它插件；替换不是本次迁移的默认路径。
- unbind 同样要求真实本地主人确认和精确 revision；state=revoked 持久化。新 key 不会复活 owner 已明确撤销的槽。
- 现有 PluginOwnerOperationContext 与 operation route 已有 Host 捕获的 confirmed、session 与 activation fencing。实现应复用当前请求的它们，并单独核对持久 proposal/surface 绑定，不新造一个包可自签的确认来源。

SharedConnectionView 仅含 state、当前公共 `/mcp` endpoint、展示 principal、slot revision、范围摘要或下一步原因；绝不含 Host 凭据。缺 public base/未启用/无可用 shared principal/slot 占用/需确认分别明确返回，不用成功布尔值掩盖。

## ref 从展示到确认的唯一传递路径（选定既有 rows/action input）

采用 reviewer 的第一种方案，不依赖 module settings 跨请求闭包、不把 ref 暗存到插件私有状态，不增设 latest-proposal 读取捷径。

Host 的 prepare 返回 proposal view 与对应行的 scope/确认文案；插件在当前 operation 的 `render:'rows'` 结果中展示它，行 action 只引用该 operation 已声明的确认动作：

```json
{
  "render": "rows",
  "data": {
    "rows": [{
      "key": "<opaque proposalRef>",
      "label": "连接到现有猫咖云端连接",
      "detail": "<Host 提供的精确安装与工具/事件范围摘要>",
      "actions": [{
        "action": "bind-shared",
        "confirm": "<Host 提供的本次范围确认文案>",
        "input": { "proposalRef": "<同一个 opaque proposalRef>" }
      }]
    }]
  }
}
```

`bind-shared` 是示意的 manifest 本地行 action id，不是新增 Host Dot 分支。manifest rowActions 声明该 id、confirm 与插件内部 handler；Host 校验返回的 action 确实被声明，且与 prepare 中冻结的 confirmationActionId 一致。带 Host proposalRef 的摘要/确认内容必须与该 ref 的 Host view 一致，不能用另一行摘要或插件私造的范围替换。

### Host 响应前的 presentation 校验（唯一选定方案）

采用整行精确校验，不依赖插件遵守文案约定、不把验证推迟到 bind，也不建设另一套确认 UI。

1. shared.prepare 在 Host proposal store 持久化 canonicalPresentation：**完整 row**（key、label、detail、actions 顺序、action id、label/confirm/input 及其全部字段）与该 ref 的 owner/session/operation/instance/包/surface basis。文案由 Host 从自己的批准范围生成；不直接采用插件提交的「只读」「只有某权限」之类摘要。proposal 同时记录被保留为共享确认用途的行 action id，presentationReady 初始为 false。
2. 唯一执行点是 `InstalledPluginOperations.runAction` 的 Host 响应边界：`rowsChecked(declaredOperation, operationResult(rawResult))` 成功之后、`transitionOperationState`、`configureOperationTargets`、`writeOperationState` 与最终 HTTP response **之前**，调用 Host 内部 `validateSharedProposalPresentation`。该校验器不属于插件 port，依赖 Host proposal store 和本次实际 owner/session/operation/instance，不依赖包传来的身份。
3. 对该 operation 已登记的共享确认 action 或任何引用 Host proposalRef 的 row，必须取得相符的 pending proposal，并比较整行与 canonicalPresentation 精确相等；不做 trim、子串、语义等价、字段补全或接受额外字段的宽松匹配。两个 ref 必须满足 row.key == action.input.proposalRef == record.proposalRef。action id 必须等于冻结的 confirmationActionId。不能只以「input 带 ref」判定待校验行：共享确认 action 缺 ref/改 key 也必须被拒绝。
4. 当前 action 新产生待展示 proposal 时，其响应必须提供相应 canonical row；改为 text/status、只给一个编号、删掉真实 scope 或造另一行都不能标记 presentationReady。非共享的普通 rows 仍只走原有契约校验，不把这条逻辑变成 Dot 专用渲染分支。
5. 任一不符返回有界 502 `invalid_shared_confirmation_presentation`，整份 operation 结果拒绝：不发送 rows、不保存该结果或推进操作状态、不配置 target、不调用 bind，也不将 proposal 标记 ready。异步校验后再执行 assertCurrent，避免校验期间包/会话/运行状态变化。
6. 只有整份结果与所有待确认行一致、当前性检查通过，Host 才以 proposal revision CAS 将对应记录 presentationReady 标记为 true，并发出原 canonical 内容。此标记只证明 Host 验证了可展示响应，不声称用户已经看见；真正授权仍由下一份 confirmed owner request 决定。响应若因网络未送达也不产生权限，必须仍有第二请求才可 bind。
7. bind 除原有检查外必须看到 presentationReady=true，且 canonicalPresentation 对应的 basis 仍等于当前 proposal/surface/包/slot。插件不能调用 prepare 后跳过已校验展示，直接用一条自行编造的确认请求授权。已展示行在另一个 tab 出现仍只对那个精确 ref 有效。
8. request state/reset 后重显保留内容必须经过同一 Host presentation gate，或重新读取 canonical row；不得从旧 operation receipt、配置投影或缓存旁路返回未校验行。当前 rows renderer 不恢复旧 rows 的保护继续保留；实现时清点所有返回 rows 的 Host 路径，以同一 gate 覆盖，不另建第二 writer。

例如篡改 detail、替换 confirm、删 ref、把 input 换成另一个 ref、变更 row.key/action id/label、给 canonical row 追加额外 action，都会在响应前被拒绝；不会先让人看到错误确认再在 bind 检查编号。只有准确的 Host view 可以进入 Console 既有确认组件和后续行 input 回传。

实际代码已核：

1. `OperationRowsRenderer.runRowAction` 捕获具体 rowAction，先 confirmAction，再调用 `rowActionRequest(..., rowAction.input)`。
2. `ActionRendererState.rowActionRequest` 把该行 input 原样序列化为第二请求 JSON body；不是把整个上次 result.data 自动注入。
3. Host `InstalledPluginOperations` 将 body 合入 `params.input`，module settings handler 从本次 `params.input.proposalRef` 读 ref，并调用固定 `host.external.shared.bind(ref)`。不从 operationState、闭包或插件持久状态查当前 ref。
4. 新请求的 confirmed marker 与 session/activation fence 由 Host operation route 重新建立；Host port 再按上一节核所有持久 proposal 条件。

取消确认不发请求；切换实例/operation 后按现有 epoch 丢弃旧响应；多 tab 中确认旧行最多对它自己的 proposal 生效，不会授权另一 tab 后生成的范围。若行过期/范围变了，明确提示重新准备并展示新行，不暗中自动重试 bind。

## Key 轮换、重装和 surface 变更

### Key 轮换

每个请求仍验证当前 live key，撤销的旧 key 必须拒绝。相同 owner + 稳定 logical principal 的新 live key 命中原 binding，不重新授权、不改 Dot attempt，不要求新连接或新 token。逻辑 principal 被整体撤销或槽被 unbind 与单把 key 的轮换不同，前者不能被新 key 自动恢复。

### 经过验证的同 lineage 重装

普通新 instance 不自动继承权限，但已验证的迁移 rebind 是明确例外：migration adapter 验证同 owner、稳定 principal、精确旧 slot revision、旧/新安装对应关系、受信 origin/package lineage、现有迁移完成回执及 surface 等价后，在 owner 安装事务下原子 CAS rebind 到新 instance。保留原 logical binding、配对和有效凭据，无需用户新连接。

catalog lineage 来自 Host 的受信 catalog/admission 身份，不能用插件自报 catalog 字符串。local archive 只对原 owner 已批准的同一精确归档 digest 或另有 owner 审阅的 admission 证明自动承接；同名 pluginId、不同字节的新归档不能自行证明 lineage。跨 origin/owner、找不到精确旧绑定、surface 不等价、迁移状态分歧均停在 needs-confirmation，不扩大权限。

旧 instance 退休后立即不可执行。迁移/import 与槽 rebind 任一失败均不得发布新 active 绑定；使用已持久的 migration receipt + slot CAS 幂等重试，不靠跨文件事务的口头原子性。重试前仍拒绝执行，不能留下新旧实例都可用的窗口。

### 工具/事件 surface

canonical surface 覆盖协议 capabilities 与完整工具/事件 descriptors（名称、schema、annotations、说明等；确定排序并排除 transport cursor）。变化一律标为 needs-confirmation；包含工具/事件扩张、schema 改变或 origin/owner 改变。批准的是准确 snapshot，不用“实质变化”留给实现猜。

相同可信 lineage 更新到新包且 surface 完全相同，可在 Host 已验证包 admission 后按 revision CAS 更新 package digest，不弹一次假的扩权确认。包字节变化仍受原安装更新授权控制。surface 缩减也是可见能力变化；不能以用户重新确认代替迁移等价验收。

每次请求捕获 binding revision、精确 instance、package/surface digest、runtime generation；真正调用前再核当前性，异步返回前复核。代际变更则拒绝/丢弃迟到结果并重新发现，不做跨代缓存或授权延续。

## 单槽发现和协议承载

只执行 slot 当前实例的固定 handle。Host 原工具照旧，slot 只增加插件自己发布的 tools/events；只拒绝与 Host tool/event 重名或实例自身描述重复，不建设 N 路优先级/冲突平台。

本次只接收有界、完整的一页发现结果，不开发跨插件分页聚合：候选上限为 tools 32 / events 16、发现响应合计 512 KiB，均足够当前 Dot 的四工具一事件；nextCursor/截断结果明确拒绝，不拿不完整列表授权。最终常量由实际契约检查固定，不能放开到无限请求。

tools/call 和 events/subscribe/unsubscribe 必须在当前已批准 snapshot 中找到唯一名称，使用服务端 slot 选择实例，再把业务参数传给固定 handle。Host 不读 attempt_id/pairing_code，不持有 DOT_TOOLS 或 dot.summoned 常量。未绑定名称沿既有 MCP 错误语义处理；不会遍历其它安装尝试执行。

Public discovery 的 events 声明与 slot 能力相符。禁用立即拒绝执行，原 Host 工具不受影响；重新启用同实例只恢复仍有效的绑定。对云端需要刷新 metadata 的情况提供准确说明，不要求重装连接或更换口令。

网关/Host 在确认身份时可以使用原来的认证材料，但插件入参只含业务请求与固定上下文，剥离原 Pro key、安装 token、cookie 和认证 header。发现结果也是不可信包输出，先校验/限额后才送到云端。

## 共享 prepare 与页面呈现闭环

当前 DotConnection.begin 总会返回 external.endpoint/token，旧集成测试也断言 token；这属于必须一起修改的共享迁移 delta，不能只改文案。

1. 普通 prepare 仍幂等生成/复用 Dot attempt；插件通过 shared.prepare 取得当前绑定或待确认的精确 proposal。首次授权只沿既有确认组件完成，不新建完整多步向导。
2. 未绑定时先用既有 rows 显示 Host 提供的范围摘要与该行的 input.proposalRef。确认产生第二次 HTTP 请求，经 params.input.proposalRef 调用 shared.bind(proposalRef) 建立该安装的共享槽；空口 bind、mount 自动 bind 或后台触发均拒绝。
3. binding 已 active 且等价时直接返回人可用的订阅说明与业务状态；共享 prepare result 固定不含 external/token/credentialSecret/原始 principal 凭据。Host 投影只提供非 secret 的 shared endpoint 与 binding state。配对码属于既有受控订阅说明，不是 Host 安装 token。
4. 现有 Host 安装凭据保管与兼容请求入口保持，导入的旧 credential 仍验证有效；不再通过共享准备结果回显。独立 plugin endpoint/token 的新用户产品另行讨论，不在本次 UI 增加分支。
5. 更新 Host/插件集成测试：把原 prepare 中 external.token 断言替换成共享结果无 token、same attempt、同原 `/mcp` 的检查；另保留受控夹具内原 secret 对固定 handle 的请求与重装 rebind 检查，证明不回归兼容。
6. 配置页保留旧版准备/复制、准确状态、两处来源往返反馈与确认断开。优先复用已有 text/status/operation 原语；必要通用复制/状态显示只是恢复旧能力，不建设新引导框架。原始 JSON 不作主流程。

## 必须先红后绿的行为检查

- 原 `/mcp` 的认证/Host toolset 保持；slot 发现与调用全部来自插件固定 handle，静态 Host 无 Dot 常量。
- 当前旧 key 被 revoke 后请求失败；同 owner/稳定 principal 的新 live key通过同 slot，配对/连接不变。
- 验证过的同 lineage uninstall/reinstall 原子 rebind；原共享连接、原有效 credential、迁入配对继续工作，无新 token/连接。跨 owner/origin/任意新实例拒绝。
- 跨请求正例：prepare 的第一份 context/signal 已结束后，TTL 内用同一真实 owner/session 的新 confirmed context + 原行 ref，仍成功 bind；不能比较两次 requestId 相等。
- Owner bind/unbind：无新会话 authority、CSRF 错、未确认、插件伪造 context、TTL 过期、换 session、confirmation action 错、proposal/ref 被换、surface/包/实例/运行代际变化、slot CAS 竞争均拒绝。已提交 ref 只能在当前 authority 与原 slot 仍匹配时幂等回读，不能重发权限。
- Host presentation gate 的真实 action-route 回归：恶意夹具分别缩短/篡改 detail、替换 rowAction.confirm、ref/input/key 不一致、错误 action id、增加 action、缺 ref 或把 pending rows 改为 text，均返回 502，不产生可确认响应/状态写入/presentationReady/bind。完整 canonical row 是唯一正例，经过 Console confirm + input 回传后才能 bind。
- 保存状态、reset/配置投影、刷新、旧 receipt 等返回路径不得绕过 presentation gate；受影响路径逐项核对，而非只测试单个 equality helper。
- Console 行回传：A/B 两个 scope/ref 同时展示时，点 A 只发送 A 的 input.proposalRef；取消零请求。旧行、重排、刷新、迟到响应不能绑定 B 或「最新 proposal」。Host 真实 action route 到 module params.input 再到 shared.bind 的整链验证，不只测序列化 helper。
- 工具/事件增加、schema/description/annotation 改变 → needs-confirmation；未批准 snapshot 不能 list/call/subscribe，已存在 Host 工具不受插件抢名影响。
- 单槽 occupied、超限/分页/重复发现、运行代际变化和迟到响应有界拒绝，无 N 路路由。
- 共享 prepare/result 不含 Host token/credential，保持 attempt；已有绑定不反复确认，无需另装 Dot 云端连接。
- 原订阅、read/reply/image/ask、两处来源 nonce 往返、历史原图、停启/撤销/重装/重启分别验证；真实账号证据不能由 fixture 代替。

## 反馈处置和后续门

P1-1：区分 live key 校验与稳定绑定；精确定义 verified migration rebind，补轮换/重装原连接回归。
P1-2：固定 Host owner-confirmed port、proposal、绑定 schema、surface digest 和变化后的 needs-confirmation。
P2-1：删除多实例聚合/分页缓存平台，收窄为原 Host toolset + 一个 shared-extension slot。
P2-2：落定 Host 无 secret 投影、共享 prepare 调用与 UI 确认链，明确旧 token 输出测试的替换及兼容检查保留。
v3 P1：proposal 为 Host 持久的 5 分钟待确认对象；两次请求使用各自独立且当前的操作 authority，producer requestId 仅审计，bind 全量复核并一次提交。
v3 P2：选定现有 rows/action input 原样回传 ref，经 params.input.proposalRef 进入固定 bind；禁止闭包/私有存储/latest-proposal 捷径，并补多 tab 与取消/旧行检查。
v4 P1：Host prepare 保存整行 canonicalPresentation；Host operation 响应边界在转移/持久化/发送之前精确校验并 CAS presentationReady；不符整份 fail closed。bind 必查已验证展示，状态恢复与 rows 旁路消费同一 gate；补篡改文案/ref/action 与合法整链检查。

本稿只完成方案修订，等待原 reviewer 对精确文档 digest 复核。未改源码、未跑 gate、未重启/修改运行配置。独立方案通过后仍先交共创者审阅，按其要求确认方案后才进入实现；不把先前 OAuth 范围同意当作本稿实现许可。正式实现按 TDD、同工位 packed consumer、exact HEAD 非作者审查、真实体验、fork soak 顺序收口。

临时验收网关与 cloudflared 已到期停止，不自动续开。
