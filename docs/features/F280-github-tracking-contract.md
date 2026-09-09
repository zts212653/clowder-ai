---
feature_ids: [F280]
related_features: [F140, F168, F1392]
topics: [github, pr-tracking, issue-tracking, notifications, wait-contract]
doc_kind: spec
created: 2026-09-02
updated: 2026-09-09
tips_exempt:
  reason: Contract truth correction only — atomic re-registration and local issue recovery are documented without changing the public registration surface.
---

# GitHub Tracking — 用户契约（#1392 / #1394 唯一真相源）

> **本文档是验收唯一标尺。** 任何"收敛出来的 AC 列表"不得取代本文档；
> 要取代，必须 operator 本人签字并直接改本文档。
>
> 这条规矩的由来：#1392 曾被一份猫自己收敛的 `AC-1..AC-7` 当成验收标准，
> 7 条全绿、292/292 测试通过、合入 develop_base——而 issue 正文写明默认开启的
> 行内评论通知**从未生效**，operator 的追踪照样被 `expiresAt` 静默断掉。
> **能全绿又全错的验收标准，等于没有验收标准。**

---

## 1. 这个能力是什么（一句话）

> 拉取 PR / issue 新增的评论和 review → 按内容封装成通知 → 按账户名过滤掉不该发的
> → 投递到注册它的那个 thread。

没有别的。任何超出这句话的机制，都必须能回答"它服务于这句话的哪个字"。

---

## User Journey

**Scope unit**：一只猫追踪一个 PR 或 issue，直到它被真正的外部回应叫醒。

1. 猫提了 PR，调 `register_pr_tracking("owner/repo", 1394)` —— **两个参数，没有第三个**。
   服务端认出它就是 PR 作者，于是把 bot 回合也一起武装上。
2. 猫在 PR 上写 `@chatgpt-codex-connector review`，然后**放手去做别的事**。
   这条是它自己写的，不会叫醒它自己；但系统记住了"这一轮开着"。
3. bot 回来了 —— 顶层评论、formal review、代码行内评论，任意一种都会把猫叫醒，
   **通知里带正文**（标记为 `[UNTRUSTED EXTERNAL CONTENT]`），不再是一句 "comment #21"。
   这一轮随之闭合。
4. bot **没**回来 —— 半小时后猫收到"这轮没回来"，而不是无限期地以为自己还在等。
   报过一次就不再重复。
5. maintainer 对同一个 PR 也调一次 `register_pr_tracking`。他不是作者，
   所以默认**收不到**别人和 bot 的来回，也**收不到第三方的闲聊**，
   但**一定收得到 PR 作者写的真回应**和任何人提交的 formal review 决定。
   不想要某一类就 `exclude` 掉它。
6. 全程没人重新注册、没人填过期时间。追踪一直活着，直到 PR merged / closed 或显式取消。

**坏掉时用户看到什么**：静默。这是本特性存在的原因，也是为什么 §4 每一条场景
都必须写出"坏掉时的表现"——写不出来的条目不许进那张表。

---

## 2. 用户契约

### 2.1 注册

```
register_pr_tracking(repoFullName, prNumber)
register_issue_tracking(repoFullName, issueNumber)
```

**两个必填参数，没有第三个必填参数。** 可选：

| 参数 | 适用 | 作用 |
|---|---|---|
| `nextStep` | PR + issue | 纯展示文本，提醒自己收到回应后要做什么。永不被解析 |
| `exclude` | **仅 PR** | 关掉一个默认开启的事件（按**事件名**，不是 predicate 名） |
| `include` | **仅 PR** | 打开一个**默认关闭**的事件（同一张 §2.2 事件名词表）。只能打开默认关闭项——`head_changed` 永远默认关，`bot_interaction` 对非作者默认关。**不能**用它绕过角色受众过滤去订阅别的坐标轴 |

`register_issue_tracking` 只有 `nextStep`：issue 的两个面（评论 / 关闭）都默认开，
没有可调项——见 §2.3。

重复注册的安装是一个 store 原子操作：以读取到的完整 tracking task revision 为前提，
同时提交新的 thread / owner 路由、managed-work binding 与 wait 状态。若期间 collector 已经
推进状态或安装 `waitOutcome.delivery=pending`，整笔注册返回冲突，**任何路由字段都不得先行
改变**；否则旧 outcome 的重放会被投到新注册者的 thread。活跃 wait 的判断也必须来自这份
被原子替换的当前 revision，不能沿用拉取 GitHub baseline 之前读到的旧 task。

**调用方永远不接触**：GitHub 游标名、predicate 类型、`when`、`expiresAt`、
`autoRenew`、受众白名单（`authorLogins`）。这些是服务端内部实现。

> **为什么**：让调用方在 `pr_review_result_available` 和 `pr_review_decision_changed`
> 之间选，就是在要求它猜对 GitHub 内部游标——猜错的表现是**静默不通知**，
> 而不是报错。这正是 #1392 要消灭的病。

### 2.2 默认订阅集（PR）

| 事件名 | 默认 | 含义 |
|---|:--:|---|
| `review_decision` | ✅ | 真正的 `APPROVED` / `CHANGES_REQUESTED` / `DISMISSED`。**属于 PR 状态**，通知所有 tracker（仍过滤提交者自己）；但 **bot 提交的 formal review 对非作者仍按角色静音**。普通 `COMMENTED` **不是** decision，它的正文与 inline finding 走评论受众规则 |
| `conversation_comment` | ✅ | PR 顶层评论 |
| `inline_comment` | ✅ | 代码行内 review 评论 |
| `bot_interaction` | 按角色 | 一个 bot 交互回合（见 §2.4b）。作者默认 ✅，非作者默认 ❌ |
| `ci_terminal` | ✅ | CI 通过 / 失败。**至少一条当前 HEAD 的 check/status 才构成证据**；空 rollup 永远是 pending，不把 `0 blockers` 当成通过 |
| `conflict` | ✅ | PR 变为冲突 |
| `base_behind` | ✅ | 同一个 HEAD 从已追上变为落后，证明 base 分支有新提交（**仅通知**，见 §7） |
| `head_changed` | ❌ | 作者推了新 commit。#1392：**只对 maintainer 视角有用**，需 `include` |

> **为什么它必须默认关，而不是"默认开 + 自过滤兜住"。**
> HEAD 变化是一个**合成事件**：它由前后两个 sha 的比较产生，GitHub 没有在这条事实上
> 附带"是谁推的"。轮询批次里也没有这个身份。所以受众过滤对它**无法生效**——
> 它既没有 `author` 也没有 `self`，任何"作者不会被自己吵醒"的说法都是空头承诺。
> 想给它加自过滤就得为每轮轮询额外拉一次 commit 作者，代价与收益不成比例。
> 默认关掉，让明确想要它的 maintainer 自己 `include`，是这条事实唯一诚实的处理。

`base_behind` 的唯一真相源是 GitHub compare API 对当前 `baseRefOid...headRefOid`
返回的 `behind_by`：大于 0 写入 true，等于 0 写入 false。`mergeStateStatus` 只表示
合并就绪度，不能兼任祖先关系：`DIRTY` 可能仍然落后，`BLOCKED` / `UNSTABLE`
也可能已经追上。compare 不可用时本轮采集失败并重试，不得从该枚举猜测。
通知还要求前后是**同一个 HEAD**：换入一个本来就基于旧 base 的新 HEAD，会把它的
`isBehind: true` 写进下一轮基线，但不能渲染成“base branch advanced”。

**默认监听全部两侧都同意的事件**；`include` 用来打开**对当前角色默认关闭**的事件，
`exclude` 用来关掉不想要的。两者传入未知名字 → **报错**，不静默忽略。

**「默认关闭」是相对角色的，不是一个固定的单项清单：**

| 角色 | `include` 能打开的 |
|---|---|
| PR 作者 | `head_changed`（对所有角色都默认关，见上） |
| 非作者 | `head_changed` **和** `bot_interaction`（后者对非作者才默认关，见 §2.4b / A27） |

formal review 的 GitHub `id` 只标识记录，**不标识记录版本**。管理员 dismiss 已存在的
`APPROVED` / `CHANGES_REQUESTED` 时，GitHub 在原 ID 上把 state 改成 `DISMISSED`；因此
decision cursor 只能发现新记录，不能发现撤销。注册时还要冻结仍可被 dismiss 的 verdict
状态，轮询读取完整 review 集并与这份持久快照比较。旧任务首次没有快照时只基线化，
不得把部署前的 dismissal 当成新通知回放；已知 verdict 的原地 dismissal 则是新的
`review_decision`，拥有独立的 durable event identity。GitHub 在这份原地变更的记录上仍保留
原 verdict 的 `submittedAt`，所以 dismissal 修订以轮询**检测到状态变化的时刻**作为事件时间，
不能借旧提交时间把撤销倒写进历史。若该修订写不进 event log，既不投递、也不终态，下一轮
继续重试。Community projection 按 durable append order 重放；补偿写入可能晚到，因此
`lastExternalActivityAt` 与 projection `updatedAt` 都保持时间单调，不被旧事件倒拨。

review verdict 状态**不能以 collector 在 admission 时重建的整张 map 覆盖**。同一任务的两个
poll 可能重叠并倒序完成：较新的 poll 已删除被 dismiss 的 verdict 后，较旧的静默 poll 若再
写回旧快照，会让下一轮把同一次 dismissal 通知第二遍。普通 poll 只携带逐 review ID 的
`expectedState → nextState`，在 lifecycle CAS 与 source-cursor commit 两个写入口都对**当时最新**
的持久状态条件应用；旧任务的首次完整快照也只在该字段仍缺席时初始化。游标保持单调，但不
因此取得覆盖较新 verdict 状态的权限。条件更新还必须返回本次真正应用的 transition receipt；
原地 dismissal 只有出现在 receipt 中，才有权越过数字 review frontier 参与匹配。两个 poll
都从同一旧快照读到 dismissal 时，后执行者的 transition 被拒绝，其事件也必须同时失效，不能
借 `inPlaceReviewDismissal` 标记再次通知下一代。

> 这里曾写成"默认关闭的那一个（`head_changed`）"。那句话只在作者视角下成立，
> 和 A27「非作者 `include: ["bot_interaction"]` ⇒ bot 回合恢复通知」直接冲突。
> 生产语义是 `bot_interaction` 的默认值为 `'author'`（作者与角色未知时开、非作者关），
> 而 `include` 按名字加，不看角色——所以对非作者它确实能打开这一项。

> 本地 reviewer 曾要求删掉 `include`、并把 `head_changed` 默认打开，理由是"让调用方
> opt-in 意味着他得先知道自己漏了什么"。那个理由对**默认集本身**成立，本契约也照办了
> （六项默认全开、角色决定第七项）。但它推不到 `head_changed`：这一项默认关不是因为
> 怕吵，而是因为**它带不了身份**（见上）。把它默认打开，等于让每个作者被自己的每次
> 推送叫醒，且没有任何过滤能挡住。
>
> **已定（2026-09-07 review）：`head_changed` 保持默认关闭，想要的人用 `include` 显式打开。**
> 合成事件没有操作者身份，无法可靠自过滤——这是事实约束，不是口味分歧，所以不再挂"待定"。

### 2.3 默认订阅集（issue）

issue 有两个面：**评论**与**关闭**。没有 `include` / `exclude`。

| 面 | 默认 | 含义 |
|---|:--:|---|
| `issue_comment` | ✅ | 任何非自己的评论都通知 |
| closed | ✅ | 投递一条终态通知，然后**终止追踪** |

终态通知只能携带已经成功进入 event log / projection 的评论。若同轮评论只持久化了一部分，
整批终态投递暂缓、任务保持 active；下一轮从未推进的 delivery cursor 重试，全部成功后再把
最后评论与 closed 合成一条终态通知。不能用“GitHub 已返回”冒充“本地已持久化”。

**reopen 不在范围内**（operator 2026-09-07）。issue 被重开是罕见事件，
用**重新注册**解决即可——为它让整条监听永久挂着，代价远大于收益。

> 这里曾被改成"closed 也不终止，以便观察 reopen"。那是把一个没人要的需求
> 写进了标尺：#1392 的 Exit conditions 只规定 PR merged / PR closed / 显式
> unregister，**对 issue 终止本就沉默**，而实现一直是终止。改标尺去迁就
> 一个罕见场景，只会让实现凭空多出一条待修的偏差。

### 2.4 过滤规则

**两段，顺序固定：先自过滤，再角色受众过滤。所有角色都要走完两段。**

曾经这一节只写「只过滤自己」，紧接着 §2.4b 又规定非作者只收 PR 作者的评论——
同一份契约里两条互斥的规则，实现照哪条都能自称合规。

**第一段 · 自过滤（所有角色一律）**

- 作者 = 本 tracking 拥有者的 GitHub 登录名 → 不通知
- 比较**大小写不敏感**（GitHub 登录名本身不区分大小写）
- 过滤依据是**身份**，不是内容。任何"这条评论看起来很关键"的正文判断
  **不得**绕过自过滤
- **自过滤只挡投递，不挡观察**：自己的触发评论仍然进归一化流去开回合（见 §4b）

**第二段 · 角色受众过滤（角色默认见 §2.4b）**

- **bot 是否投递取决于角色，不是无条件通知。** 对 PR 作者，`bot_interaction` 默认 ON——
  codex review bot 的评论正是他在等的，把它当噪音过滤掉等于关掉这个功能；
  对非作者默认 OFF，因为那一轮来回不是冲他的
- 非作者的普通评论面**只收 PR 作者本人**的评论
- 角色拿不到（PR 作者登录名、或我们自己的身份，任一不可解析）⇒ **按 ON 处理**（A26：
  静音一条真信号比多一条噪音严重得多）
- 持久化的显式 `authorLogins` allowlist **替换**这一段的角色默认，**不与它叠加**。
  叠加是静默失声方向：非作者 tracker 一旦 allowlist 了某个维护者，角色分支会把这个
  非作者全部丢掉，结果一条都收不到——比放宽更重

### 2.4b 角色默认：注册者是不是 PR 作者

同一个 PR，作者和 maintainer 想要的东西不一样。所以**服务端按角色定默认**，
调用方不需要多传参数：

| 注册者 | `bot_interaction` | `conversation_comment` / `inline_comment` | 理由 |
|---|:--:|:--:|---|
| **PR 作者** | ON | 所有非自己的人 | bot review 正是他在等的；任何人的回应他都要 |
| **非作者**（maintainer / reviewer） | OFF | **仅 PR 作者本人** | 他在等的是「我提的意见，作者回了没有」 |

> **非作者的评论面按作者过滤，这是规范要求，不是可选降噪。**
> 只关掉 `bot_interaction` 是不够的：那样 maintainer 仍会收到**第三方**的每一条评论
> （其他 maintainer、路人、CI 机器人的独立留言），而他真正在等的只有作者 A 的回复。
> 曾经的实现只做了 `bot_interaction: 'author'`，普通评论仍是「所有非自己」——
> 代码注释写着 "a maintainer only wants the author's own replies"，实现里没有这条过滤。
> **这条必须有独立测试：非作者注册 + 第三方评论 → 不通知。**

`bot_interaction` 是**一个概念**，不是两条规则——「作者触发 bot」和「bot 回应」
本来就是同一个交互回合的两半：

```
bot_interaction = { @ 了已知 bot 账号的评论 }  ∪  { 已知 bot 发的评论 / review }
```

判定依据是 **mention 解析 + 我们维护的已知 bot 身份记录**（`KNOWN_BOTS = { login, triggerHandles }`，
见下方 blockquote），**不是正文关键词匹配**。这里必须是完整身份记录而不是登录名清单：
曾经有一个 `KNOWN_BOT_LOGINS`（只取 `login` 的投影）——拿它去匹配 mention 正是让
`@codex review` 永远开不出回合的那个历史缺陷。它已经没有任何消费者，**同时删除**：
把一份 login-only 清单摆在这里，就是给下一个人重犯同一个错的现成材料。`@` 是 GitHub 的一等结构，bot 账号是我们维护的身份数据；
「这条评论看起来像触发词」那种猜测**禁止**（见 §2.4 与 §8.3）。

它仍属于 §2.2 那一个 `include` / `exclude` 词表，**不引入第二个坐标轴**。
非作者默认静音这一轮来回——**这是角色默认，不是他必须先去打开的开关**；
但想看的非作者仍可用 `include: ["bot_interaction"]` 显式打开（A27）。
原文写成「不是他要自己去打开的开关」，读起来像"打不开"，与 A27 冲突：
准确的说法是**不需要**他打开，而不是**不能**打开。

> **「谁应答」和「@谁召唤」是两个字符串，混为一谈会让整个能力静默死掉。**
> 你写 `@codex review`，而回答你的账号叫 `chatgpt-codex-connector[bot]`。所以一条已知 bot
> 是一条**身份记录**（`KNOWN_BOTS = { login, triggerHandles }`），不是一个登录名。
> 曾经只用应答登录名去匹配 mention——真实触发评论一条也匹配不上，A28/A29 在测试里全绿、
> 在生产里从不触发，因为测试里也写的是应答登录名。**测试的现实必须来自上游（我们自己的
> `pr-template.md` 写死了 `@codex review`），不能来自实现。**
>
> 同一张身份表上有两个不同的判断，不要合并：
> - **提到**（mention）→ 决定事件叫不叫 `bot_interaction`，让非作者能静音这轮来回
> - **召唤**（命令式 `@handle review`）→ 才开回合。"回头问下 @codex" 提到了但没许诺，
>   当成回合会在 30 分钟后凭空报一条"没回来"

**回合什么时候开**：只有一个来源——**归一化流里、游标之后、由 tracking owner 本人
发出的召唤评论**。不看 MCP 调用、不看 registration verifier、不看 `EYES` reaction。

- `EYES` 是**瞬态 reaction**，两次轮询之间可能整个错过；**召唤评论本身才是稳定事实**。
  它可以作为展示信息，但**不得**成为正确性门槛
- **别人的召唤不得给我建回合**。否则我会收到一条自己从没发起过的"这轮没回来"
- 注册那一刻**不做同步探测**：没有任何一条 pending 标记来自 MCP 侧。
  刚发完召唤就结束本轮的猫，等下一个轮询周期即可——**少等一个周期，
  远好过引入一条只有 MCP 路径才走得到、因而永远测不到生产行为的分支**

**回合只记四个字段**：`{ 触发评论 id, 已知 bot 身份, 时间, headSha }`。

没有 `grantInvocationId`——归属已经由"**是不是 owner 自己发的**"这一个判断回答了，
再叠一个 invocation 维度只会制造两个真相源。

**`headSha` 仍然必填，不管回合是谁开的。** 曾经注册路径写了、轮询路径没写，
而消费者把"缺失"读成"当前"——**可选字段 + 宽容默认 = 静默回归**。

**F168 只读，不写。** 它单向读取同一份归一化事实来判断云端 review 是否就绪。
它失败、超时或不可用**不得**影响 tracking 的任何投递，也**不得**修改任何回合状态。
formal review 的 `COMMENTED` 只是 GitHub 运输状态，不是 clean 裁决：只有显式 `APPROVED`
或正文同时满足规范化 clean 文案与当前 commit 证据时才是 clean；带 inline finding 的 review
仍是 blocking。无开放回合的普通 `COMMENTED` 不产出 F168 裁决；若它结束了一个开放回合，
则记为 `failed_or_timeout`，绝不因带着当前 `commitId` 就放行 release readiness。
**F177 使用它自己的 coordination 状态**，不从 tracking 取出口凭据——
"thread 里存在任意 tracker"本来就不是出口，从这里借凭据只会把它变回来。

> **现状要写明，不能只写原则。** F177 Phase J 原来的凭据是注册方亲手声明的
> `pr_review_result_available`（带 `triggerCommentId`，注册路由当场验覆盖）——那确实是
> **发起方自己的动作**。#1394 把 `when` 从注册面退役后，没有任何调用方还能声明它，
> 而回合归 tracking owner、不归某一次 invocation，**替代不了同一个事实**。
> 所以 `resolveEventBackedRoutingExit` 现在**一律 fail closed**（`predicate_missing`），
> 猫改为持球而不是 clean stop。代价是一次持球；反向的代价是一次没人接的球。
> **proof validator 已封死为恒 `false`**（sol R25）。上一版把它保留成「字段校验器」
> 并自称「零容忍不变量还武装着」——那是读错了自己的代码：proof 里根本没有 invocation
> 字段，同一份 proof 传入开启它的 invocation 和一个毫不相干的后续 invocation，
> **两次都返回 true**，它不可能不这样。接受一份无法绑定的 proof 不叫武装，
> 叫给同一个洞的下一次重现预先盖章。
>
> 封死之后方向反过来：resolver 本来就一律 reject，正常路径到不了这里；将来若有任何
> 路径合成出 `bypass`，validator 返回 false，`event_wait.false_bypass_total` 触发，
> F192 按零容忍回归处理。eval 读数：`bypass_total = 0`、`false_bypass_total = 0`。
> **解封的条件不是"把字段列表加回来"**，而是 F177 拥有一份自己签发、且指名 invocation
> 的 coordination credential；到那时校验属于**那份凭据**，不属于现在这个形状。

> **自过滤只挡投递，不挡观察。** 作者自己的触发评论**仍然进归一化流**——它要开启回合，
> A28 才有东西可超时；身份过滤那一行只决定"不叫醒写它的人"。所以对作者而言
> `bot_interaction` 在通知上只意味着"bot 的回应"，在状态上意味着整个回合。

**角色怎么定**：注册时把 PR 作者登录名和我们自己的 GitHub 身份比一次（大小写不敏感），
用的是**和自过滤同一个判断**。两者任一拿不到 ⇒ 角色未知 ⇒ **按 ON 处理**：
A26 已经写明，静音一条真信号比多一条噪音严重得多。

**已知代价（不埋着）**：作者若把触发和正文写在同一条评论里
（`@bot review — 另外你说的第 3 点我改了`），这条会被非作者 tracker 整条静音，
后半句他看不到。**对策不是靠自觉**：触发 bot 是我们 skill 声明的行为，
由 skill 规定「触发评论必须单独一条」。

### 2.5 生命周期

- 注册那一刻冻结基线：**注册之前的历史一律不通知**
- 通知一次后**自动续订**，继续监听下一条。调用方永远不需要重新注册
- **没有 `expiresAt`，永不过期**
- 结束条件：PR merged / PR closed / **issue closed** → 通知并终止；或显式 `unregister_tracking`。
  issue 被 reopen 时重新注册即可（§2.3）
- PR 与 issue 的终态都不得越过反馈持久化：每个评论 / review 来源只把成功进入 durable
  history 的前缀交给 lifecycle；任一来源仍有失败尾部时，merged / closed 暂缓，下一轮
  从未推进的来源游标重试，完整后再把最后反馈与终态合并投递。
- `waitOutcome` 是该 generation 的恢复 outbox。生命周期事件必须先成功追加（重复追加按
  idempotency key 视为成功），connector 消息才能投递；追加失败时 outcome 保持 pending，
  后续观察先重试它，既不求值新事件，也不允许 N+1 覆盖 N。这样“通知已发、审计事件丢失”
  的半提交状态不可构造。所有 lifecycle event-log backend 都必须按稳定 `eventId` 幂等；若
  event log 持续不可用，系统有意停止该 outcome 的通知而不是让账本与现实分叉，且 pending
  outcome 必须保留供恢复。
- PR 的 CI、review-feedback、conflict poller 是独立可配置的 schedule；任一 poller 运行时都必须
  把 `done + waitOutcome.delivery=pending` 视为可收集，并优先重放该 outcome。恢复资格不能只挂在
  CI schedule 上，否则关掉 CI poller 会让 review / conflict 产生的终态通知债只能等进程重启。
- issue poller 遇到 `waitOutcome.delivery=pending` 时同样先构造纯本地 recovery work item，不能先读
  issue metadata / comments；已经持久化的通知债不应被 GitHub 宕机或 rate limit 阻塞。
- 投递附加元数据属于**产出它的 outcome**，与 outcome 一起持久化、一起重放。后续 CI / review /
  conflict 轮询即使恰好负责 retry，也不得把自己的 metadata 借给旧 outcome，亦不得因自己没有
  metadata 而擦除旧值。
- 每次通知投递到**注册时所在的那个 thread**

### 2.5b 重复注册不得前进游标

**对同一个 subject 再次注册时，游标只能不动或后退，绝不能前进。**

正常路径下没人需要重复注册（`autoRenew` 自动续订）；它只在**改订阅**时才发生。
但一旦发生，当前实现会用实时快照重新冻结基线：

```ts
baseline: snapshot.baseline,        // 当前最大值
...snapshot.collectorState,         // 覆盖掉旧的 collector
```

于是**旧游标到"现在"之间的一切被静默丢弃**。真实后果：猫被 #100 唤醒 →
干活期间 #101 #102 到达 → 猫重新注册 → 新基线 = #102 → **#101 #102 永远收不到**。

正确规则：已有活跃 wait 时**保留旧 baseline 与旧 collector**，重复注册只更新
订阅集与 `nextStep`。两个性质同时成立——首次注册冻结在"现在"（A12 历史不刷屏），
重复注册不前进（中间的不丢）。

> `headSha` / `ci.fingerprint` / `conflict.mergeState` / `base.isBehind` 是**状态比较**型
> 基线而非单调游标。保留旧值意味着间隙期发生的 HEAD 变更会补触发——**这是对的**，
> 那确实是真实发生过的事件。
>
> `headSha` 与 `base.isBehind` 共同描述同一个 PR 快照：观察未改变 HEAD 时可以保留既有
> base 事实；一旦观察把 HEAD 从 A 推进到 B，就必须同时给出 B 的 base 事实，否则旧事实
> 必须缺席。不得把 A 的 ancestry 与 B 的 HEAD 拼接，否则后续 poll 会把一次换 HEAD 误报成
> “base branch advanced”。typed facts 与 normalized events 两条基线入口共用同一条合并规则。

---

## 3. 设计：一条归一化事件流 + 一条统一过滤链

> **场景是用来验证设计覆盖的，不是用来加分支的。**
> 一条场景对应一个新分支 ⇒ 抽象错了。

### 3.1 现有设计错在哪

`when[]` 里 9 种 typed predicate，matcher 里就是 9 个 `case`。每个分支各自决定：
查哪个游标、要不要卡 `headSha`、身份怎么判。于是同一个缺陷投影出五个 bug：

| 现象 | 结构原因 |
|---|---|
| 加了 inline predicate，router 没转发 | 每个 predicate 要自己接一条事实管道 |
| inline 能匹配了，续订不推进它的游标 | 每个 predicate 要自己推进自己的游标 |
| 评论过滤了自己，review 没过滤 | 身份判断散在各调用点 |
| 有的分支卡 `headSha` 有的不卡 | 每个分支自己决定 |
| issue 侧正文判断绕过自己过滤 | 干脆是另一套管道 |

**"加一个事件类型要改 5 处、必然忘掉第 6 处"——这就是"改漏改"的结构原因。**

### 3.2 目标设计

```
拉取
  → 归一化：所有来源产出同一形状
      Event { type, id, source, author, self, botTurn? }
  → 订阅过滤   e.type ∈ subscription
  → 已见过滤   e.id > frontier[e.source]     ← 每个来源一条游标，天然互不吞噬
  → 受众过滤   audience(role, prAuthor, e)      ← 只在这一处
                 role = 注册者是不是 PR 作者（§2.4b）
                 挡掉 e.self（大小写不敏感）
                 非作者：评论面只放行 prAuthor 写的
  → 投递到注册 thread
  → 推进 frontier[e.source] + 回合状态         ← 与投递成对，不可能只做一半
```

**订阅是数据，不是代码。** 新增事件类型 = 归一化表加一行，不是 matcher 加一个 `case`。

链子里**没有**的东西同样重要：没有 `headSha` 门、没有过期、没有正文启发式。
它们不存在，所以不会有人在某个分支里"顺手"加回去。

**关于 bot（§2.4b 的精确边界）**：`bot_interaction` 只作为**订阅词表里的一个名字**
存在，判定发生在**归一化**那一步（mention 解析 + 已知 bot 身份清单），随后由**订阅过滤**
这一行统一处理。

- 受众过滤那一行**永远不认 bot**——bot 不是"噪音身份"，它是正常外部回应者。
  它只认两件事：**这是不是我自己写的**，以及**按我的角色，这个作者的话我要不要听**
- 一条属于 bot 回合的评论是**换了名字**（`type` 变成 `bot_interaction`），不是多出一条事件。
  `source` 仍是它原来的面，所以 frontier 照旧各走各的游标，也不可能一条评论通知两次
- 新增 `bot_interaction` = 归一化表加一行 + 词表加一个名字，**不是 matcher 加分支**

**回合状态是这条链子上唯一的时间**：`botTurns` 记「谁被 @ 了、被哪条评论 @ 的、什么时候」，
开 / 闭 / 超时和 frontier 在**同一次推进**里算完——所以"报了超时却没退休"结构上不可能，
也就不会像旧 classifier 那样反复播报同一轮。除此之外链子里仍然没有时间、没有 `headSha` 门、
没有正文启发式。

**但 events 不是推进这只时钟的授权。** CI / conflict 观察同样携带归一化 events，只为匹配
它们自己的订阅面；只有 review-feedback 观察可以评估 / 退休 bot 回合，因为只有这条生产链会把
超时结果同步记录进 F168。否则先到的 CI 轮询会消费回合，后到的 review 轮询便永远看不到失败。

一旦有人在受众过滤里写 `if (isBot)`，就是回到了 §3.1 那个错误坐标系。

**受众过滤是一个函数，不是两处判断。** 曾经的实现把角色差异只表达成
`bot_interaction: 'author'` 一个订阅默认，普通评论仍是"所有非自己"——
于是 maintainer 照样被第三方刷屏。角色一旦只影响订阅表就必然漏掉这种情况；
它必须进入过滤函数本身。

---

## 4. 覆盖检查表（验证设计，不驱动分支）

> 每条场景必须落在 §3.2 链子的**某一行**上。若某条需要新分支才能满足，
> 说明 §3.2 的抽象不对——**改设计，不要加分支**。
>
> 每一条都必须能在"功能坏掉时变红"。写不出失败场景的条目不许进这张表。

| # | 场景 | 期望 | 坏掉时的表现 |
|---|---|---|---|
| A1 | 只传 repo + number 注册 | 成功，6 类事件全部武装 | 报错要求填 `when` / `expiresAt` |
| A2 | 别人发顶层评论 | 通知 | 静默 |
| A3 | 别人发**行内 review 评论** | 通知 | 静默（#1392 的头号漏洞） |
| A4 | 别人提交 formal review | 通知 | 静默 |
| A5 | review 状态文本没变（连续两次 COMMENTED） | 仍通知 | 静默 |
| A6 | **bot** 发评论 / review | **按角色**：作者（或角色未知）通知，非作者默认静默、可 `include` 打开——见 A23 / A24 / A27 | 无条件通知或无条件静默：两者都与角色表冲突 |
| A7 | **自己**发顶层评论 | 不通知 | 自己叫醒自己 |
| A8 | **自己**发行内评论 | 不通知 | 自己叫醒自己 |
| A9 | **自己**提交 review | 不通知 | 自己叫醒自己 |
| A10 | 自己的评论正文含"关键"字样 | 仍不通知 | 正文判断绕过身份过滤 |
| A11 | 自己的登录名大小写与配置不一致 | 仍不通知 | 大小写敏感比较导致过滤失效 |
| A12 | 注册前已存在的评论 | 不通知 | 注册即刷屏历史 |
| A13 | 通知一次后，下一条新评论 | 仍通知 | 只响一次就哑了 |
| A14 | 通知一次后，**同一条**评论 | 不重复通知 | 同一条反复叫醒 |
| A15 | 作者推了新 commit 之后别人再回应 | 仍通知 | 推送后追踪静默失效 |
| A16 | 三个面同一轮到达 | 三条都不丢 | 共用一个游标互相吞掉 |
| A17 | 放着不管一周 | 仍在监听 | 到期静默断线 |
| A18 | PR merged | 通知并结束 | 永久空转 |
| A19 | `exclude: ["ci_terminal"]` | CI 不通知，其余照常 | 关一个把别的也关了 |
| A20 | `exclude: ["不存在的名字"]` | 报错 | 静默忽略 |
| A21 | 通知落在注册它的 thread | 是 | 投错 thread |
| A22 | 已在追踪的 subject 上再次注册 | 旧游标保留，间隙期的回应仍通知 | 基线跳到"现在"，间隙期静默丢失 |
| A23 | 作者注册：bot 的 review / 行内评论 | 通知 | 作者收不到他在等的 bot 结果 |
| A24 | 非作者注册：bot 的 review / 行内评论 | 不通知 | maintainer 被别人的 bot 回合刷屏 |
| A25 | 非作者注册：作者 @ 已知 bot 的触发评论 | 不通知 | 同上 |
| A26 | 非作者注册：作者写的真回应 | 通知 | **静音了真信号——比刷屏严重得多** |
| A27 | 非作者 `include: ["bot_interaction"]` | bot 回合恢复通知 | 覆盖不生效 |
| A28 | 触发 bot 后超时无回应 | 通知"这轮没回来"，且只通知一次 | 静默——点了 review 石沉大海 |
| A29 | 触发 bot 后正常回应 | 通知结果，回合闭合 | 回合永远挂着，之后误报超时 |
| A30 | **非作者**注册：第三方（既非作者也非自己）发评论 | **不通知** | maintainer 被无关的人刷屏，他等的是作者回应 |
| A31 | issue **closed** | 终态通知合并同轮命中的最后评论，然后终止 | 只终止不通知、吞掉同轮最后评论，或终止后仍空转 |
| A32 | 非作者注册：**别的 maintainer** 提交 formal review | 通知 | 静音了同行的决策 |
| A33 | 当前 HEAD 的 statuses / check-runs 都为空，跨过多个轮询周期 | 保持 pending，不通知 CI 通过 | 把空集合写成 `pass (0 blockers)` |
| A34 | issue 最后一批评论只持久化成功一部分，同时 closed | 不投递未持久化评论、不终止；下一轮重试完整后再终态通知 | 终态携带失败评论并把任务做完，永久跳过修复 |
| A35 | merge readiness 为 `DIRTY` 但 compare `behind_by > 0`；或 readiness 为 `BLOCKED` 但 `behind_by = 0` | 前者通知 behind，后者清除 behind 基线；之后再次落后仍可通知 | 用互斥 merge-readiness 枚举猜祖先关系，造成重复通知或静默漏报 |
| A36 | PR 评论 / review 只持久化成功一个来源前缀 | 只投递成功前缀（含 owner 自己的回合事实），失败尾部不推进游标并重试 | 投递与 baseline 越过 durable history；终态到达后反馈永久丢失 |
| A37 | 换入一个本来就落后 base 的新 HEAD | 记录新 HEAD 的 behind 基线，但不通知“base branch advanced” | 把作者 push 冒充成 base 推进，发出错误因果通知 |
| A38 | 当前 HEAD 上出现无 finding、无 canonical clean 正文的 bot `COMMENTED` review | 无开放回合时不产出裁决；有开放回合时记为 `failed_or_timeout` | 普通说明或失败文案被当成 clean，错误满足 required cloud review |
| A39 | outcome N 首投失败，另一个带不同 delivery metadata 的观察重投 N | 使用 N 持久化的原 metadata；本轮 metadata 不参与 | 跨 adapter 借错或擦除可信 memory cue |
| A40 | outcome N 已安装但 lifecycle event 首次追加失败，且 N+1 已续订 | 不投递 N；下一轮先补 N 的 event，再投递 N，之后才求值 N+1 | 已通知但审计事件永久丢失，N+1 覆盖唯一恢复记录 |
| A41 | 已见的 `APPROVED` / `CHANGES_REQUESTED` 在**同一 review ID**上变成 `DISMISSED` | 投递一次撤销；状态快照在 durable processing 后删除该 active verdict；重复轮询不重放 | 只看 `id > cursor`，继续把已撤销的 approval / changes-request 当成当前事实 |
| A42 | 两个 review-feedback poll 重叠，较新的 dismissal 先落盘，较旧的静默 poll 后执行 | 旧 poll 不恢复已删除 verdict；下一轮不重复合成 dismissal | 用 admission 时重建的整张 map 覆盖较新的 collector 状态 |
| A43 | 两个 review-feedback poll 都从同一旧快照读到同一个 dismissal，再依次执行 | 只有 conditional transition 真正应用的第一个 poll 通知；第二个 transition 与事件一起失效 | 状态 CAS 拒绝旧写，但 dismissal 仍无条件越过 review frontier，向下一代重复通知 |
| A44 | review 或 conflict poll 终态化后投递失败，同时 CI schedule 未注册 | 任一仍运行的 PR poller 都可重放 durable pending outcome；不依赖重启 | 恢复资格只在 CI gate，独立 schedule 配置把通知债永久留到重启 |
| A45 | 重复注册读 baseline 期间，collector 安装 pending outcome 或另一注册先激活 wait | 原子拒绝旧 revision；原 thread / owner / binding / outcome 全部保持，重试时从最新活跃 frontier 推导 | 先 upsert 路由再检查 debt，或从 pre-fetch task 判断 liveness，导致旧通知串线或吞掉间隙反馈 |
| A46 | issue outcome 已持久化待重投，但 GitHub 随后不可用 | 不读 GitHub，直接从本地 outcome 恢复投递 | durable 本地通知债被无关的 metadata/comment 请求卡住 |

**A3 / A6 / A17 是历史事故的直接复现，必须有独立测试。**
**A22 是"静默丢真信号"，优先级高于任何降噪诉求。**
**A26 是降噪这一刀的护栏**——降噪做过头就会砍到它。

**逐条落位（证明没有一条需要新分支）：**

| 链子上的一行 | 覆盖的场景 |
|---|---|
| 归一化（同一形状） | A2 A3 A4 A5 A41 — 三个来源走同一条路；review 新记录按 ID，已知 verdict 的 dismissal 按持久状态修订判新 |
| 归一化（回合识别：mention + 已知 bot 身份） | A23 A24 A25 A26 A29 — bot 回合是**改事件的名字**，不是加一路事件 |
| 归一化（回合状态：开 / 闭 / 超时未闭） | A28 A29 — 仅 review-feedback 观察拥有回合时钟；CI / conflict 即使携带 events 也不得消费。回合随 frontier 同批推进，报了必然同时退休 |
| 订阅过滤 | A1 A19 A20 A23 A24 A25 A27 |
| 已见过滤（per-source frontier + durable prefix + conditional verdict transition receipt） | A12 A14 A16 **A36 A42 A43** |
| 受众过滤（唯一一处，只挡投递） | A6 A7 A8 A9 A10 A11 A26 **A30 A32** — 自己写的仍进流：它要开回合、要推 frontier。角色决定"这个作者的话我要不要听" |
| 投递到注册 thread | A21 |
| 推进 frontier | A13 A14 |
| 终态门 | A18 **A31 A34 A36** — PR merged/closed 与 issue closed 只有在各反馈来源到达 durable frontier 后才终止 |
| 状态事实采集 | **A35** — compare 祖先关系独立于 merge readiness |
| 状态因果过滤 | **A37** — `base_behind` 只认同一个 HEAD 的 false→true；换 HEAD 只更新下一轮基线 |
| 注册时的基线安装（不得前进） | A22 |
| F168 裁决分类 | **A38** — `COMMENTED` 不是 verdict；显式 approval 或 canonical current-commit clean 才能放行 |
| outcome 持久化与重放 | **A39 A40 A44** — metadata 跟 outcome；lifecycle event 先于 connector delivery，旧 outcome 清账前不得求值或覆盖；每个独立 PR poller 都保留恢复资格 |
| **链子里没有的东西** | A15（无 `headSha` 门）· A17（追踪本身无期限）· A10（无正文判断）· A6（bot 不是噪音身份） |

> **A17 与 A28 不矛盾**：追踪本身没有任何过期时间（A17）。唯一的时钟长在**一个回合**上，
> 只回答"这轮回来了没有"（A28），且报完即退休。它不会终止追踪，也不会影响别的面。

---

## 5. 测试规矩（硬约束）

历史教训：`review-feedback-router.test.js` 里 `commentType:'inline'` 只出现一次，
注释 `// AC-6a drops inline`，body 写着 `inline noise`——**测试主动断言缺陷是正确行为**。
谁把功能修对，这个测试就变红，他会去改测试。照派生 AC 写的测试永远发现不了规格错误，
只能把它锁死。

1. **测试输入必须是上游真实产出。** 主流程每个接缝定义共享 fixture：上游模块断言
   "我产出这个"，下游模块用"这个"当输入。**手搓的模块输入不计入覆盖。**
   （现状：全仓 200+ 个断言消息投递的测试里，用真采集管道的为 0；用真采集管道的
   11 个测试里，断言消息投递的为 0——交集为空。）

2. **主流程测试先行，异常场景在其之上补。** 没有主流程测试的模块不算有测试。
   （现状倒过来：1670 行精巧的并发/竞争场景测试，主流程一条没有。）

3. **禁止断言"某类主流程输入被丢弃"**，除非本文档 §2.4 明写该丢。
   `inline noise` 这种命名本身就是警报。

4. **完成判定**：必须存在跨越"拉取 → 投递"的链路测试，输入是真实形状的 GitHub
   payload，断言是 MessageStore 里真的出现了消息。**没有这条，测试再绿都不算完成。**

5. **合入 develop_base 后必须在其中跑一遍 §4 的用户场景**才算 done。
   develop_base 同步上游 main 是为了验证，不是为了当代码目的地。

---

## 6. 明确不在范围内

写清楚是为了防止再次把别人的活拖进来（#1392 曾因此膨胀 +4000 行）：

| 不做 | 归属 |
|---|---|
| connector 以下的通用投递可靠性、pendingWake 重试、single-flight admission、CAS 竞争载体 | #1356 / #1398；本契约只负责 outcome→lifecycle event→connector 的顺序与 outcome 自身重放 |
| `preview → register` 两步注册 | 已废弃，注册不需要前置检查 |
| 调用方可传的受众参数 / exact audience | 已从产品面移除 |
| MCP 侧的 bot-turn 工具、回合探测、`preview` | 不存在。回合只从 GitHub 事件推导（§2.4b） |
| tracking 读取 registration verifier / `grantInvocationId` / F177 状态 | 已解除，且是双向的：tracking 不读 F177 身份，F177 也不从 tracking 取出口凭据。F177 目前**没有**可用凭据，出口恒 fail closed（§4b）；「F177 用自己的 coordination 状态」说的是它该去哪里找，不是说它已经有了 |
| 猫可选的 typed predicate | 服务端内部，不对外 |
| 自动 update-branch（写操作） | 另开 issue，见 §7 |

> **「pending 重投 ≠ 本次观察已求值」——曾被我判成"不在本 PR"，那个判断是错的。**
>
> `observe()` 一旦看到 `existingPending` 就直接 `publishPending` 返回，**不读 `input.events`**；
> 而 `ReviewFeedbackTaskSpec.execute` 紧接着无条件 `commitCursor()` ⇒ 事件被跳过而游标照样前进
> ⇒ **永久丢失**。
>
> 我当初只比对了"出错的那两行是不是本 PR 新增的"——它们确实在 `origin/main` 上逐字相同，
> 于是我判它出 scope。**该问的不是谁写了这两行，而是这条路径是不是本 PR 才走得到。**
> §2.5b 的 auto-renew 把 outcome N 与 await N+1 **原子安装**在一起，"pending N 且 N+1 已激活"
> 从罕见竞态变成**常态、长期可达**的状态——本 PR 把旧缺陷接上了主流程。
> （`publishPending` 里那段 CAS 注释正是为这个状态写的，我当时处理了它却没看见早退分支。）
>
> **对照组要 hold 住正确的东西**：让"出错的行"保持不变，回答不了"可达性有没有变"。
>
> **已修**：`notified` 现在必须带 `observationEvaluated`。pending 重投报 `false`，
> 调用方据此**不推进游标**（代价是一个轮询周期，另一侧的代价是丢一条评论）；
> ConflictRouter 的 `matchedKinds` 在未求值时**返回空**，否则上一代的冲突会为一次
> 从未求值的观察授权分支改写。回归钉的是**序列**，不是单点。

> **R34：同一条线再下一层——重投的 outcome 还决定"这条路由是什么形状"。**
>
> CI 曾用**当前 poll** 的 `merged/closed` 选 `lifecycle` 臂。于是一条未求值重投的 review outcome
> 被装成生命周期结果：投递内容是 review 评论，唤醒理由却是 `github_pr_merged`；而这次合并若恰好
> 是自己做的，self-merge 过滤会把这条唤醒**整个吞掉**——消息投递到了，人永远没被叫醒。
>
> **已修**：route 臂只由 `outcome.terminalSubjectState` 决定，当前 poll 的终态**不再作为参数存在**
> （不是在旧参数前面加判断——参数删掉了）；终态观察不丢，留给真正求值它的那一轮。同理，conflict
> 在未求值时不再声称 `urgent/github_pr_conflict`，self-merge 过滤也只作用于它能解释的 `merged` 路由。
>
> 判据收敛成一句：**每一个面向 owner 的声明，由被投递的那次观察负责，不由手里的信号负责。**
> 前后五轮都是同一形状在不同 consumer 上复发，所以这轮把决定做成共享投影 + 必填字段，
> 让"漏掉"从记忆问题变成编译错误。

> **§3.2 的"受众过滤"不是这里被移除的那个东西。** 被移除的是**调用方能传的受众参数**；
> 留下的是**服务端从"注册者是不是 PR 作者"推导出来的角色**——它不出现在任何入参里，
> 调用方也无法覆盖。两者同名不同物：一个是让调用方去猜自己需要什么（#1392 要消灭的病），
> 一个是服务端替他答对。

> **F168 cloud-review 聚合：已重新接上，不是尾巴。**
> 旧的 `external-cloud-review-classifier` 只在调用方手工注册 `pr_review_result_available` 时才
> 产出观察值。删掉那个 predicate 后 `recordCloud` 一度**零生产调用方**——配置了
> `cloudReviewPolicy=required` 的仓会永远停在 `cloud_review_required` 等一个不会来的裁决。
> 现在状态由 `CloudReviewObservation` 从**同一条归一化事实**推导（bot 身份 + 回合状态），
> 公共面不恢复任何 predicate。**"这条留给 F168 后续"是错的说法**：删掉唯一生产者的是这一刀，
> 补回来也必须是这一刀。
>
> **裁决是对一个 diff 的裁决**，所以每条事实都锚在当前 HEAD：旧 commit 上的 bot review 不是对
> 当前代码的判断；旧 HEAD 上开的回合不能在新 HEAD 上读作"还在跑"；bot 说
> "Codex could not review this pull request." 是它在报告**自己失败**，读成 clean 会让 PR 凭一次
> 没发生过的 review 被标成 ready。

---

## 7. issue 正文需要修正的两处

issue #1392 正文与本文档的差异，**以本文档为准**，并回写 issue：

1. **"Known bot accounts → skip (optional)"** → **删除**。
   bot review 是 PR tracking 最主要的信号来源，跳过 bot 等于关掉功能。
   只过滤自己。

2. **`base_behind` → auto update branch** → **拆分**。
   `base_behind` 保留为**通知**（本次交付）；自动调用 GitHub API 更新分支
   是**写操作**，风险等级不同，另开 issue，不混在通知能力里。

---

## 8. 结构性防呆

历史上的失败都是"加了一半忘了另一半"，所以这些是硬约束，不是建议：

1. **catalog lockstep**：模块加载时断言 shared 的封闭事件集与 API 校验 schema
   完全一致。加了事件忘了接线 → 启动即失败，不是运行时静默。
2. **每个可匹配面必须有自己的游标**，且续订时必须推进**自己**的游标。
   （行内评论曾可匹配却不推进游标 → 同一条反复通知。）
3. **身份过滤在事实生产处做一次**，下游不得再做第二套判断。
4. **验收只对本文档**。AC 列表、review 收敛、猫的 thread 讨论都不是标尺。

---

## 9. 规模（operator 2026-09-03 签字：行数不是闸门）

> **operator 原话**：「代码量这个不是关键；这个主要是为了避免你们做无意义的乱改的；
> 我们 issue 的预期还有问题流程都是很明确的；我们的目标是做正确的事儿 一次性做对的。」

所以本节**不再是验收闸门**。行数只是一个可复算的观察值，用来在事后回答"这一刀有没有乱改"，
而不是用来在事前批准或否决什么。真正的闸门是 §4 覆盖表和 §5 测试规矩。

**可复算命令**（数字必须由命令产出，禁止手抄）：

```bash
git diff --numstat 9f6ac2069 HEAD -- 'packages/*/src/**' | awk '{a+=$1;d+=$2} END {print a, d, a-d}'
```

### 为什么这一节被降级——三次教训，都是同一种错

1. 最早写"≤500 行"，量的是**旧 fork develop_base**（其中已含 PR #146 的约 640 行）。
   基线一换，同一份代码就"超标"。**规模上限不写基线等于没有上限。**
2. 后来改成"≤1200，相对上游 main"，报的是 gross 增删；下一刀报净增。
   **口径不写死，同样等于没有上限。**
3. 第三次：报出的净增 `510` 与命令实测 `517` 对不上——因为是在最后一次 amend 之前量的，
   之后没重量。**手抄的数字必然会和代码脱节。**

> 而最关键的一点，是这三次都没抓到的：这一刀净增比上一刀**更小**，却整个漏掉了 F177 的
> EYES 覆盖验证器，还让 A28/A29 在生产里根本不会触发（触发词 `@codex` 与应答账号
> `chatgpt-codex-connector[bot]` 不是同一个字符串）。**行数没有、也不可能接住这类错误。**
> 能接住的是 §5.1：测试输入必须来自上游真实产出——我自己写的实现不能反过来当测试的现实。
