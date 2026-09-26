# F202 C1 — Host↔插件 接口全集与整改规格

**裁定日期**：2026-09-20　**裁定人**：operator　**效力**：覆盖 connector 专用机制的一切安排

## 0. 依赖方向（铁律，operator 原话）

> 我们不依赖 sdk 只有插件依赖 sdk；而且插件的 sdk 接口一定和我们 host 的兼容的；
> 因为我们是基于诉求和能力先定义和整改的 host 的接口；然后再去发的插件的 sdk

```
插件 ──→ SDK ──→ contract ←── Host
```
单向。**Host 永不 import SDK。**

今天的两处违反（均需整改）：
- `domains/plugin/external-runtime/stdio-broker-transport.ts:26` — Host import SDK 取传输帧
- connector 线形状只活在 SDK（`plugin-sdk/src/feature-context.ts:48`、`connector-runtime.ts:56`），contract 内 0 命中

## 1. 原则（operator 裁定）

> 我们不应该留下任何定制的专属接口和能力

IM connector 只是众多出入口之一。前台猫同样要发消息、同样要插件化。
**任何只为 connector 存在的接口都是错的**——否则每来一种出入口就定制一次。

## 2. 接口全集

### 2.1 方向 A：插件 → Host（已有，全部通用，保留）

`PluginToHostMethod`（contract.generated.d.ts:857）：
`messaging.send` / `messaging.appendElements` / `messaging.subscribe` / `messaging.read` /
`messaging.ack` / `messaging.snapshot`

`Capability`（:22）：`plugin.config.read` / `plugin.state.get` / `plugin.state.set` /
`secret.read` / `messaging.send` / `messaging.appendElements` / `onMessage` /
`message.event.subscribe` / `thread.listMetadata` / `thread.readContent` /
`memory.query|append|retrieve` / `schedule.register` / `events.publish` /
`windows.create` / `whisper.extend`

### 2.2 方向 B：Host → 插件（**完全不存在，本 PR 新建**）

contract 内**没有** `HostToPluginMethod` 类型；broker `BrokerConnection` 只有
`call(method: WireMethodName, input)`，方向是 plugin→Host（`host-broker/builtin-loopback.ts:11-18`）。

这是 operator 所说的"基础能力"：
> 我插件可以监听某个 thread 的回调消息注册 callback；
> 那我们正常成员或者 thread 这边产生消息的时候就往这个 callback 推送

### 裁定的机制（operator 2026-09-20，覆盖此前的 A/B 二选一）

> sdk 提供这个 outbound 接口；然后插件调用 host 注册声明需要订阅哪个 thread 的消息，
> 然后 thread 那边产生新消息后；发现有哪些插件有订阅；然后调用插件实现的这个 outbound 接口；
> 插件实现的这个 outbound 接口再按照自己的逻辑处理……那都是插件内部闭环的

**声明不需要新契约类型**——已存在且通用：
`MessageSubscriptionContribution { binding, filter?, action: CallbackAction }`（:189-195），
`CallbackAction = { method, params? }`（:130）。插件声明要 Host 调哪个方法，这已经是契约语言。

**投递的持久性放在 Host，不放进公共面**——复用已有机制，不新建：
`EventLogStore.append/readAfter/minSequence` + `CursorStore.get/advanceDelivered/advanceAck`
（`domains/messaging/stores/ports.ts:112,198`）。Host 驱动游标，调插件的方法，成功才推进；
插件抛错就不推进，下一轮重投。**插件作者只实现一个函数，不实现循环。**

> **为什么不是"只推一个信号、插件自己 read/ack"**（我此前的推荐，已撤回）：
> 那把同一个消费循环复制到每一个插件作者手里，N 份实现 N 种错法；
> 而循环放在 Host 只有一份。公共面反而更小——signal 方案还得额外冻一个信号方法。

### 泛化裁定（operator 2026-09-20 续）

> 公共面甚至不需要理解什么是插件；它只知道有 n 个实现了 outbound 的实现；然后现在有哪些需要调用的
>
> 我们自己的前端的消息其实也是这个 outbound 的一个实现而已

**已采纳**：投递驱动只认 **sink**（outbound 的一个实现），不认"插件"。
`OutboundSinkPort.deliver(subscriberId, method, params)`，driver 内无任何按订阅者类型的分支。
测试 case 5 用一个 `ui:live-view` 形态的 sink 钉死这一点。

**证据支持这条泛化**：Host 内 `broadcastToRoom(` 有 **112 处**调用点，事件名散成
`connector_message`(31) / `intent_mode` / `task_updated` / `heartbeat`……
前端出站今天不是一个实现，是 112 个散落推送点——与本 PR 在入站上治的是同一个病，长在读的一侧。
**收敛它属于 C2（operator 已明确把前端部分划给 C2），本 PR 只保证抽象能容纳它而不需改动。**

> **push back：注册不能省，过滤不能交给订阅者。**
> operator 提议"完全 SPI 就不用注册、插件自己过滤"。**注册不是手续，是授权边界**：
> `handles.ts:99-107 resolveForSubscribe` 逐条校验 handle 存活、绑定到该实例（INV-8）、
> `scope.canSubscribe`。若 Host 把每条消息发给所有 sink 再由对方自行过滤，
> **数据已经离开 Host 了**——每个插件都将看到它从未被授权的 thread 内容，包括 whisper。
> 过滤必须在 Host 侧，因为投递之后的过滤不是过滤。
> 次要理由：全量扇出的成本，以及每个 (sink, thread) 需要独立游标才能各自重投。

**载体实现**（同一套语义，不漂移）：
- 进程内模块载体：就是一次函数调用（TS 的 SPI 形态，`22eba9a45` 已能加载插件自有模块）
- stdio 外部载体：已有连接上的反向帧

> **止损线覆盖记录**：本车道原定"新增 public method/hook 即转 C2"。operator 已裁定方向 B
> 是基础能力且必须在本 PR 内完成，该止损线在此项上被显式覆盖，不适用。

## 3. 缺口清单（要补的，共 4 项）

| # | 缺口 | 取证 |
|---|---|---|
| **G1** | Host→插件调用方向不存在 | contract 无 `HostToPluginMethod`；`BrokerConnection` 仅 plugin→Host |
| **G1b** | 订阅投递驱动不存在 | 无代码按订阅游标调插件声明的方法 |
| **G2** | `message-subscription` 无功能消费者 | 全仓仅 `plugin-manager-projection.ts:91` 一处，是 UI 投影 |
| **G3** | 无 thread 创建能力 | Capability 只有 `thread.listMetadata` / `thread.readContent` |
| **G4** | 地址签发无路径 | `issueConnectorBindingHandle` 生产调用点 0 |

G1 是底座：**connector 专用设计的 `outboundMethod` 同样依赖它，也同样没实现**——
所以选通用面不会比专用口子更慢。

## 4. 删除清单

| 层 | 删除对象 |
|---|---|
| contract | `ConnectorContribution { inboundMethod, outboundMethod }` |
| SDK | `connectors.register/deliver`、`ConnectorInboundMessage`、`ConnectorOutboundDelivery`、`requireConnectorOutboundDelivery`、`FeatureHostAdapter.deliverConnectorMessage` |
| Host | `ConnectorRouter`(664)、`ConnectorCommandLayer`、`im-connectors/` 7 provider(8,180)、`im-connector-loader` 静态 import、`OutboundDeliveryHook` 的 connector 分支 |
| Host（本 PR 自建，降层） | `ConnectorIngress.admit()` 代发层——保留其地址解析部分 |

斜杠命令 / 群白名单 / 表情 ack / skip 原因随 provider 迁往插件仓，**Host 侧不重建**。

## 5. 一般化清单（不是删，是去掉 connector 味道）

`ConnectorBindingAddress { connectorId, externalChatId }`（contract :455）承载的是
**唤醒授权**——已认证外部入站里"人的 @"有效，而插件自己的声音无效（F288 v0 冻结的安全属性）。
这是安全属性，不是 IM 属性：前台猫转述访客的话需要同一个东西。
应泛化为通用的"已认证外部入站地址"。**beta 期改名是免费的，正式版后就不是**——
这正是 operator 引用的插件仓 issue 所警告的。

## 6. 执行顺序（operator 裁定的路线）

> 搞清楚后；然后开始干；然后删代码；然后等插件仓那边基于调整后的 sdk 把相关的插件改造完成，
> 然后发布后；我们就可以验收了

1. 本规格（搞清楚）——本文件
2. Host 侧补 G1–G4 + 一般化（干）
3. Host 侧删除清单（删代码）
4. plugins 仓按整改后的 Host 接口重发 SDK，改造 7 个包
5. 验收：插件可独立安装 / 卸载 / 使用，且 Host 内无任何 connector 专属代码

## 7. operator 裁定补遗（2026-09-20，D1/D2/D3 全部闭合）

### 7.1 Host→插件是一个机制，不是 outbound 专属

> outbound 机制这个可以泛化一下；如果其他的插件也涉及到 host 主动调用插件的应该也是这个思路的

**已落地**：`domains/plugin/host-invocation.ts` 的 `HostInvocationPort.invoke(targetId, method, params)`
是**唯一**的 Host→插件方向；订阅投递只是它的第一个消费者，没有特权。
schedule 触发、webhook 到达、以及将来任何 Host 要主动调包的理由，都是同一个调用换一个已声明的方法名。
**方法名永远来自插件自己的声明（`CallbackAction.method`），Host 不发明方法名。**

### 7.2 历史数据（原 D1）：迁移脚本 + 统一的插件配置目录

> 单独写个迁移脚本迁移下就好……主要是配置文件……让用户重新操作下也行反正也不复杂
> 插件加载后我们可以在 .cat-cafe 下开个插件配置目录；然后插件的运行时配置其实都是写那里的

**裁定**：插件运行时配置统一落在 `.cat-cafe/` 下的插件配置目录；写一个迁移脚本把
`.cat-cafe/im-connector-config/<id>.json`（`FEISHU_APP_ID/SECRET`、`WEIXIN_BOT_TOKEN` 与扫码状态机）
搬过去。**用户重新操作是可接受的退路，因此迁移不阻塞删除。**

### 7.3 斜杠命令（原 D2）：归 SDK，不在 7 个包里各写一遍

> slash 命令完全可以归属到我们的 sdk 中，因为这些命令其实对应的是某个 api 操作；
> 然后这些操作不会触发实际的 agent 操作……插件自己先判断下是不是 slash 命令；
> 是的话不丢给 send 接口；走 slash 命令接口……
> 比如我们 slash 的切换 thread 的那个；其实也就是重新注册 inbound 和 outbound 的回调的

**裁定**：14 个命令（`/where /new /threads /use /thread /commands /cats /status /history
/unbind /allow-group /deny-group /focus /ask`）对应的是 **Host 的 API 操作**，不触发 agent。
插件侧先判定是否 slash → 不走 `send` → 走 SDK 的命令面 → 调 Host API → 记录到按来源固定的系统 thread。
`/use` 一类切换 thread 的命令 = **重新注册 inbound/outbound 回调**。
**Host 侧不重建命令层；SDK 提供一份，7 个包复用。**

### 7.4 `connector_message`（原 D3）：不保留专用事件，用已声明的 identity 渲染

operator 问它具体是什么：`ConnectorRouter.ts:32-47` 广播
`{threadId, message:{id, type:'connector', content, source:{connector,label,icon,sender}, timestamp}}`
——本质就是**一个带身份的消息气泡**。

> 我理解就和我们的 host 的成员甚至其实已经是一样了；插件注册的时候提供自己的 icon 还有背景颜色
> 这些；然后我们消息气泡渲染的时候直接用就好了的

**裁定成立，而且插件侧已经是这么写的**：7 个包各声明 `identity` ×2
（`IdentityContribution { displayName, icon?, color? }` 已在已发布契约内）。
因此 `connector_message` 不需要作为专用事件保留——插件消息与成员消息同构，身份来自 identity 声明。

### 7.5 这批插件不碰前端 UI（已核实）

7 个 connector 包的 contribution 声明总计：`connector` ×14、`identity` ×14、`webhook` ×4，
**`ui` ×0**。因此 C1 不涉及任何插件改前端 UI 的情形。

## 8. G5（2026-09-20 实现中发现，承重）：猫的回复不在订阅者可见的事件流里

**症状**：按裁定的 outbound 设计，插件订阅 thread 后应收到该 thread 的新消息。
但今天订阅者**只看得见插件自己发的消息**，看不见猫的回复——**出站因此走不通**。

**取证**：往 messaging 事件日志写入的调用点全仓只有两处，且都属于插件消息域自身：

| 写入点 | 谁触发 |
|---|---|
| `domains/messaging/send-service.ts:215` | 插件 `messaging.send` |
| `domains/messaging/append-output.ts:207` | 插件 `messaging.appendElements` |

而猫的回复走 `messageStore.append`，调用点散在 cats 域：
`agents/routing/route-serial.ts`、`route-parallel.ts`、`agents/invocation/invoke-single-cat.ts`、
`PersistedQueueDelivery.ts`、`StartupReconciler.ts`、`agents/providers/CodexAgentService.ts`、
`duty-briefing/briefing-delivery.ts`……**没有任何一处产生 `message.publish` 事件。**

**这就是为什么今天出站得靠 `OutboundDeliveryHook` 被调用链直接调用**——它不是设计选择，
是因为猫的消息从来没有进过统一的发布流。

**修法（与本文件第 1 条原则一致）**：所有作者的消息必须进**同一条 admission**。
不逐个改散落的调用点——那是 N 份实现 N 种错法；
`IMessageStore.append` 是唯一的汇聚点，在装配处用一个发布装饰器包住它，
一处接入、全部作者收敛。这同时是 operator "前端也只是 outbound 的一个实现" 的前提：
前端将来接进订阅面时，看到的必须是同一条流。

**次序**：G5 必须早于删除 `OutboundDeliveryHook` 的 connector 分支——
否则猫的回复会在两条路都断的窗口里静默消失。

## 9. ~~接口全集里最后一个未定的洞~~ —— **已取消**（operator 2026-09-21 裁定）

原文主张：插件要为第一次出现的外部会话取得地址，只能给已发布的 `PluginToHostMethod` 加一项。
**operator 否掉了这个前提，而且是对的：**

> 插件如果当前没注册和绑定到任何 thread；那就是基于插件的标识 id 的一个固定线程啊；
> 这个是插件或者 sdk 自己就能闭环的不需要在 host 这边考虑吧

**为什么闭合**（一手核过）：

| 插件需要的 | 已有的东西 |
|---|---|
| 建 thread | `POST /api/threads` —— **已经是 HTTP API** |
| 列 thread | `GET /api/threads` |
| 记"哪个群对应哪个 thread" | `plugin.state.get/set` —— **已有 capability** |
| 没绑定时的落点 | 按插件标识固定的 thread，Host 在**激活时**签发 handle 即可 |

`/new` = `threadStore.create` + `bindingStore.bind`；`/use` = `bindingStore.bind`。
其中 `bindingStore` 是 Host 的 connector binding store——**但插件根本不需要它**，
映射放自己的 plugin state 里就行。**因此不新增任何 `PluginToHostMethod`。**

### 9.1 由此产生的后果：`ConnectorIngress` 被取代，但有一半必须留下

`domains/messaging/connector-ingress.ts`（commit `6b4a361b5`）是在"Host 替插件做准入"的
旧假设下写的：它建 thread、建 binding、签 handle、再代插件调 `send`。
按本节裁定，**建 thread / 建 binding / 代发这三件事全部归插件**，所以这部分是死代码，
且其文件名就违反"host 里不留 connector 代码"。装配引用数已验证为 **0**。

**但不能整个删掉，因为有一半不是寻址问题而是授权问题**：
插件用 `thread_handle` 以自己的声音说话时，其文本**永远不产生唤醒**（F288 v0 冻结的安全属性）。
飞书里人 @猫 要能唤醒，靠的是 `connector_binding` 这个**已认证外部入站**地址种类。
这半边今天仍然没有任何生产调用点去签发。

**收口方式**：把"签发已认证外部入站 handle"移到**激活时**由 Host 完成
（Host 权限、Host 动作、无新插件可调能力），然后删掉 `connector-ingress.ts` 的其余部分。
**次序**：先补签发、再删——否则删完之后 IM 里 @ 猫不再唤醒任何猫。

## 10. 回声抑制默认反转（2026-09-20，跨线 review 促成）

**背景**：端到端串通时发现，转发包既往 thread 送消息又订阅同一 thread，
不加过滤就会把自己送进去的消息再发回外部平台——用户一句 "hi" 在真实群里变成无限对话。

**我的第一版修法是 fail-open，已撤回。** 原方案让包声明 `filter: {excludeOwnMessages:true}`，
即 echo 为默认、安全靠 7 个包各记一次。Plugins 线一手核出致命处，证据我已复核：

| 核查项 | 事实 |
|---|---|
| `filter` 类型 | `Readonly<Record<string, unknown>>` —— 无类型口袋 |
| schema 约束 | `{"type":"object","additionalProperties":true}` |
| `filter` 是否必填 | 否（`required: ['type','id','binding','action']`） |
| `excludeOwnMessages` 在契约中 | **零命中**，纯魔法字符串 |

所以拼错一个字母、写成字符串 `"true"`、或干脆不写，**三种都通过全部校验然后循环**。

**裁定（采纳 Plugins 线建议）**：**默认排除自身消息**；要回声的订阅者显式
`filter: { includeOwnMessages: true }` opt-in。

**为什么这比"类型化那个键"更根本**：反转之后，那三种错误**全部降级为静默**而不是刷屏——
无类型口袋不再是危险来源。更重要的是，它**直接取消了"7 个包都必须声明"这条要求本身**：
没有要求要记，就没有要求会漏。

> 这与本车道在 G5 上用的是同一条原则：**一个靠 N 个地方各记一次才成立的安全性，不是安全性。**
> 我在 G5 上讲了这条，却在回声上自己违反了；由跨线 review 纠正。

**证据**：`f202-c1-end-to-end-journey.test.js` 共 7 例，其中
case 2「什么都不声明也不会收到自己的消息」、
case 4「显式 opt-in 确实能拿回回声」（证明抑制是默认而非写死）、
case 5 三例「拼错 / 字符串 / 显式 false 全部降级为静默」。

## 11. 更正：「Host 有这条 HTTP 路由」≠「插件能调它」（2026-09-21，跨线 review 纠正）

§9 里我写过「建 thread = `POST /api/threads`，已存在 ✅」。**这条是错的，撤回。**

插件只能走 broker 的 `PluginToHostMethod`，够不到 Host 的 HTTP 路由。一手复核：

```
PluginToHostMethod  = messaging.send | appendElements | subscribe | read | ack | snapshot
thread.* capability = thread.listMetadata, thread.readContent        ← 只读，无创建类
plugin-sdk 的 thread 面 = 零命中
```

所以 operator 5 步流程里的第 2 步（取 thread）与第 3 步（建系统 thread），
**用今天已发布的契约 + SDK 执行不了**。

### 11.1 但这两步的存在前提被前提本身推翻了

它们存在，是因为插件必须自己 bootstrap 自己的 thread。而 operator 给的前提是

> 因为是固定的 thread 所以有固定的基于插件名的系统 id

**固定 + 由插件标识推导 ⇒ Host 在激活时即可算出、确保存在、并把地址交给插件。**
插件侧因此塌成"拿着激活时给的地址直接发"，第 2、3 步从流程里消失。

**代价：零新增 `PluginToHostMethod`、零新 capability、零 README 披露。**
且它与 §9.1 结尾那件"激活时签发已认证外部入站 handle"**是同一个动作**——
确保身份 thread 存在 + 签发带转述人类授权的地址，一次做完，不是两套机制。

### 11.2 仍然缺面的那一块（升 operator）

`/new` 这类**显式创建任意 thread** 的命令，固定地址覆盖不了。
支持它需要新增一个创建类方法 + capability，并会触发 plugins 仓的同意面披露闸。
**这是往已发布公共面加东西，按 operator 自己定的规矩不自决；在他裁定前 plugins 侧不动 SDK 面。**

### 11.3 次序（不可换）

激活时地址签发 → plugins 侧切到 `message-subscription` → **然后才删** `ConnectorRouter` 等。
否则删完之后 IM 里 @ 猫不再唤醒任何猫。

## 12. 完整方案审计（operator 要求，2026-09-21）——接口面本身有系统性缺陷

operator 的判断：

> 我提的都不是什么新鲜的；都是基于已有的思路；而且是我没看代码的情况下都能发现的；
> 如果你们之前有疑问；那我理解你们开放给 sdk 的接口是不是就是有问题的

**成立。** 通读之后三条系统性缺陷：

### 12.1 我说"契约里没有 Host→插件方向"——**错的，已撤回**

我只读了 `PluginToHostMethod`（6 项），那只是子集。真实的 broker 命名空间
`WIRE_METHOD_NAMES` 有 16 项，其中**四项就是 Host→插件**：

```
host.messaging.deliver      host.grants.changed
host.lifecycle.drain        host.lifecycle.ping
```

而且 `host.messaging.deliver` **已发布、已定形状、stdio 传输层已实现**：

```
M0CDeliverInput  = { deliveryId, threadHandle: ThreadHandleAddress, envelope: MessageEnvelope }
M0CDeliverResult = { deliveryId }
Host 侧: stdio-broker-transport.ts:44 已声明调用；control-plane.ts:376 已读其 grant
```

**这正是订阅投递需要的形状。** 所以出站**不需要新增任何公共面**——用它即可。

### 12.2 同一件事有三份实现

| 实现 | 出处 |
|---|---|
| `host.messaging.deliver` | **已发布契约 + stdio 已实现**（标准） |
| `ConnectorContribution.outboundMethod` | 连接器专属，Host 从未消费 |
| `HostInvocationPort`（我造的） | 本车道新增，**重复发明了标准方法** |

后两个都该让位给第一个。这是 operator 所说"不是新鲜的、都基于已有思路"的直接印证：
**我们反复在已有机制旁边另造一个，因为没有人通读过整张方法表。**

### 12.3 17 个能力可声明，其中 7 个根本调不到

`Capability` 有 17 项，但既无 wire 方法、也无 `FeatureContext` 字段的有 **7 项**：

```
thread.listMetadata   thread.readContent
memory.query          memory.append        memory.retrieve
whisper.extend        （events.publish 有 wire 方法，但无作者面）
```

**声明得出来、授得了权、永远调不到。** 这解释了为什么"插件要取 thread"会卡住——
能力清单与可调用面**从未对齐过**，缺口不是一个方法，是两张表没对过账。

### 12.4 由此修正本车道的做法

1. 出站改用 `host.messaging.deliver`，**撤掉自造的 `HostInvocationPort` 形状**
2. `ConnectorContribution` 的 inbound/outbound 仍然作废（结论不变，理由更强：标准方法早就有）
3. 能力表 ↔ 可调用面的对账缺口单独记录，**不在 C1 内扩面**，但必须让下一位不要再各造一个

