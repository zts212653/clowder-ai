---
feature_ids: [F265]
related_features: [F126, F137, F139, F174, F202]
topics: [wechat, macos, ocr, screencapturekit, vision, limb, privacy, ui-automation, scheduler, watch]
doc_kind: spec
created: 2026-07-16
description: "让猫在用户明确授权后读取 Mac 微信当前页或指定联系人最近消息，并可一次性等待指定联系人来信后回到原 thread 提醒；不破解数据库、不发送消息。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-19T05:30:00Z
---

# F265: WeChat Local Reader — 指定会话读取与一次性来信 Watch

> **Status**: in-progress | **Owner**: 小太阳·Maine Coon (@codex-sol) | **Priority**: P1

## Why

operator每天需要把个人微信消息手工复制给猫，既打断工作流，也让“猫能在真实生活里帮忙”停在聊天窗口之外。目标不是导出微信数据库，而是让operator只在 Clowder AI 里说出对象和意图，猫就能在明确授权下读取当前页、读取指定联系人最近消息，或一次性等待指定联系人来信后回来提醒。

operator experience：

> “我需要我们的猫爪爪能够看到我的wechat信息！！！！不然我天天给你们copy wechat消息！！！太难受了”

纠偏原话：

> “你这个没用 这个获取不到内容的。。 获取不了内容那就太难受了”

终态补充原话：

> “如果我想让你看吴浪 和 xxx的最新30条消息 你能看得到吗？我得出去点点点？”

> “当然肯定同意啊……我要是喊你 等收到xxx消息找我，你能做吗？”

这两条把“免复制”进一步收紧为两个不可省略的旅程：**按名字拉取最近消息时不要求用户手工切换/滚屏**，以及**注册一次性等待后不要求用户持续盯微信**。

## Current State / 现状基线

- 本机 `/Applications/WeChat.app` 为 macOS WeChat `4.1.11`（build `269108`）。
- `huohuoer/wechat-cli@0.2.4` 在本机无法解密 `session.db`；`~/.wechat-cli/all_keys.json` 没有可用密钥。其当前 README 明示只支持 macOS WeChat `<= 4.1.8.100`，`new-messages` 是用 `~/.wechat-cli/last_check.json` 保存游标的增量 DB polling，不是 push/event subscription，因此既不适配本机 4.1.11，也不能作为本功能的监听真相源。
- 已逐条审计 Codex sessions `019f4853-9fd5-7d72-8441-05bfe2f9406b` 与 `019f4b98-ef8d-7753-90ca-4703c91ec2cd`：前者尝试以 dyld interpose 捕获 `CCKeyDerivationPBKDF` 派生 key，合成 smoke 当时因未生成 capture file 失败；后者只继续检查临时脚本/语法，后来确认 `/tmp` 探针已被清理。两份记录均没有真实微信 key 捕获、DB 解密、正文读取或后台按联系人读取成功，因此只作为**已排除密钥路径的历史证据**，不计入 Phase C 验收。
- WeChat 主窗口的 macOS Accessibility 树只暴露 `AXWindow + AXGroup + 3 AXButton`，不暴露聊天文本。
- 只读 spike 已证明 `ScreenCaptureKit` 可在内存中捕获当前微信主窗口，`Vision` OCR 能从聊天正文区域读出实际聊天句子；一次实测读取 12 个正文候选块。spike 未保存截图，也未点击或控制微信。
- 对 `BiboyQG/WeChat-MCP@v0.2.0` 的源码审计显示，其“按联系人拉消息”依赖 `session_item_* / search_list / Messages` 等 AX 节点与合成键鼠；本机已授予 Accessibility 后仍不存在这些节点，因此不能直接复用其实现。
- 本机 `CGEventPostToPid` 后台搜索探针保持原前台 app 不变，但 WeChat 搜索界面没有任何可检测变化。主动导航不能承诺“后台无闪切”，必须显式把 WeChat 暂时前置、逐步验证 UI 状态并在结束后恢复现场。
- F137 的 iLink Bot 只能收发operator与 Bot 的会话，不覆盖任意好友/群聊正文；它不是本需求的数据源。

## What

### Architecture Ownership

Architecture cell: `plugin` + `callback-auth`
Map delta: extend
Why: 屏幕捕获与 UI 导航仍是 F126/F202 concrete plugin Limb 的本机设备能力；Phase C 复用 callback-auth 已验证的 invocation principal，并只扩展可信 owner user-message provenance 到本地 Limb 调用。一次性等待复用既有 scheduler dynamic task 生命周期，不新建 connector、传输协议、transport cell 或第二套队列。

### Phase A: 本机内存 OCR 与可信结果契约

新增 macOS 原生只读 reader：从 WeChat 当前选中的主窗口抓取像素，在进入 OCR 前硬裁剪会话正文区域，并返回有边界、有置信度、可弃权的结构化候选块。未知布局、权限缺失和低置信度必须 typed fail-closed；截图不落文件。

### Phase B: F126 Limb 接入与显式授权

把 reader 作为 `wechat-visible-reader-mac` Limb plugin 接入现有 F126/F202 能力面。插件默认未启用；启用后仍需operator在本地 Hub 短时 arm，猫才可通过 `limb_list_available → limb_list_tools → limb_invoke_tool` 按需读取当前选中会话。Phase B 的 `read_visible_conversation` 不会自动切会话、滚屏、扫描全部未读或发送消息；Phase C/D 使用独立高权限命令与授权契约。

### Phase C: 指定联系人导航与最近消息读取

在同一 Limb 下新增高权限命令 `read_conversation_recent`。调用必须来自当前 owner thread 的用户触发 invocation，并显式确认“会暂时前置/操控微信、可能清除目标会话未读标记”。Limb 保存原前台 app、原会话与原可见消息 hash 锚点，只允许执行“打开搜索 → 输入联系人 → OCR 精确选择 → 验证会话 header → 在正文区域有界滚动 → 恢复原会话/滚动锚点/前台 app”这一条 allowlist；禁止聚焦输入框、按 Return 发送、点击链接或执行任意其他微信操作。

### Phase D: 指定联系人一次性来信 Watch

在同一 Limb 下新增 `watch_contact_once` / `cancel_contact_watch` / `get_contact_watch`。注册动作本身是 owner 对未来目标会话验证读取的持久、可撤销授权：最多 24 小时，绑定 `userId + threadId + authorizingInvocationId + authorizingMessageId + targetCatId + contactLocator`，只存联系人定位信息、baseline hash 与生命周期元数据，不存消息正文。执行面复用 scheduler dynamic interval task：默认每 30 秒在 native 进程内检查 sidebar 的**目标联系人**提示；命中后才前置微信、验证精确 header 与 post-baseline 最新 inbound 单元，随后以幂等消息唤醒原 thread 并立即结束 watch。

## User Journey

### Journey A: 不复制，直接让猫看当前微信会话

- **Scope unit**: message
- **Actor**: operator + 当前 thread 的猫
- **Entry**: operator已显式启用 WeChat Visible Reader、在本地 Hub 短时授权读取，并在 Mac 微信中选中目标会话。
- **Flow**:
  1. operator在 Plugin Hub 将读取能力 arm 10 分钟，并在目标 Clowder AI thread 里说“看一下微信”或同义指令。
  2. 猫发现 `wechat-visible-reader-mac` Limb，读取其 schema 后调用只读命令；授权过期时只收到 `authorization_required`，不会截屏。
  3. 系统只截取当前微信主窗口的会话区域，在内存中 OCR，并返回结构化正文候选、置信度和来源信息。
  4. 猫对低置信度或说话者不明的内容明确标注不确定，不把旧历史误当成operator当前指令。
- **Success evidence**: `limb_invoke_tool` 在本机 WeChat 4.1.11 返回当前会话真实文本；无截图文件产生；operator无需复制粘贴即可让猫理解当前页。

### Journey B: 按名字读取最近 30 条，不出去点点点

- **Scope unit**: conversation
- **Actor**: operator + 当前 thread 的猫
- **Entry**: 插件已启用；operator在 owner thread 直接说“看 X 和 Y 最近 30 条”或同义指令，并明确接受短暂前置微信与可能清除未读的副作用。
- **Flow**:
  1. 猫按 Limb 三步流程调用 `read_conversation_recent(contact, limit<=30)`；回调服务从当前 invocation 绑定 `userId/threadId/authorizingMessageId`，并把 consent flags 与调用 provenance 写入无正文 action log。
  2. native navigator 先确认屏幕未锁定、WeChat 唯一主窗口可识别，并记录原前台 app、原会话 header、原可见消息 block hashes；任何一步无法建立恢复锚点都在 UI 操作前 fail closed。
  3. 系统暂时前置 WeChat，打开搜索并逐字符输入联系人；只点击 OCR 精确匹配且唯一的结果，不按 Return。切换后再次 OCR header；不一致立即停止并恢复现场。
  4. 系统只在正文 ROI 内有界滚动，使用 capture/block hash 拼接、保序与去重，最多返回 30 个结构化 message units；同样文字的不同气泡不因正文相同而合并。
  5. 系统恢复原会话、尽力定位原 block-hash 滚动锚点，并恢复原前台 app；任一恢复分量失败显式返回 `restore_failed`，不静默宣称无副作用。
- **Success evidence**: 用户只在 Clowder AI 里给联系人名，系统在 WeChat 4.1.11 返回该会话最近 30 条有序结构化单元，目标 header 精确一致，且原会话与前台 app 恢复。

### Journey C: 等 X 的新消息，收到后回来找我

- **Scope unit**: one-shot watch
- **Actor**: operator + 注册 watch 的猫 + scheduler
- **Entry**: 插件已启用；operator在 owner thread 明确说“等收到 X 消息找我”并选择 1 分钟到 24 小时的有效期。v1 只支持一个 1:1 联系人 watch。
- **Flow**:
  1. 猫调用 `watch_contact_once(contact, expiresInMinutes)`；同一次调用安全导航到目标会话，精确验证 header、固定联系人 locator，并以当前最新 inbound message-unit hash 建立 baseline 后恢复现场。
  2. 系统持久化最小 watch definition 并注册 30 秒 interval task；runtime restart 后重建任务，取消、到期、触发或 plugin disable 后终止。
  3. 每次 tick 只在 native 进程内把 sidebar 与目标 locator 比对；不把其他联系人名、预览或截图返回 TypeScript、日志或模型。目标当前已打开时可直接比对正文 baseline。
  4. 仅在目标提示命中后，系统按 Journey B 的 active-navigation allowlist 打开目标会话，重新验证 header，并确认出现 post-baseline 的最新 `presumed_sender=other` 单元；锁屏、最小化、歧义或低置信度只进入 degraded/retry，不触发提醒。
  5. watch 以稳定 idempotency key 向原 thread 写入一条**不含微信正文**的“X 有新消息，需读取”提示，并用该持久消息 ID 幂等唤醒注册猫；成功后状态转为 `fired`，不再轮询。
- **Success evidence**: runtime restart/sleep 后 watch 仍可恢复；真实 X 来信只产生一条提醒与一次猫唤醒；旧消息、自发消息、同名错误会话、取消/到期后消息都不会触发。
- **Honest degradation**: 这是基于窗口像素与 30 秒轮询的 best-effort watch，不是微信官方事件流。WeChat 退出、目标行长期不可见、窗口最小化、屏幕锁定、Space/layout 改变或 OCR 低置信度时可能延迟或漏报；必须在注册现场披露，不能承诺 100% 到达。

### Non-goals / 硬边界

- 自动发送、回复、转发、收藏、加好友、按 Return 或操作消息输入框。
- 解密/轮询微信数据库、提取进程内密钥、重签或降级 WeChat、关闭 SIP。
- 后台扫描/导出全部联系人与全部会话；sidebar poll 只在 native 内比较已授权目标 locator。
- 群聊 sender 精确 watch、多联系人并发 watch、超过最近 30 条历史、语义 predicate。
- 把截图、聊天正文、sidebar 其他联系人信息写入日志、scheduler state 或长期记忆。

## Acceptance Criteria

### Phase A（本机内存 OCR 与可信结果契约）

- [x] AC-A1: reader 仅使用 `ScreenCaptureKit` 内存图像 + `Vision` OCR；一次成功调用前后不产生截图文件。
- [x] AC-A2: 会话列表、系统状态区和输入框在 OCR 前由固定 layout profile 硬裁掉；回归 fixture 中放在左栏的敏感字符串绝不出现在结果。
- [x] AC-A3: 成功结果返回 `capture_id`、WeChat 版本/layout，以及逐单元 `block_type/bbox/ocr_confidence/layout_confidence/is_partial/presumed_sender/block_hash`；完整文本单元带 `text`，可识别的图片/语音/红包/引用等带 `block_type=non_textual + indicator`，不可靠说话者使用 `unknown`。
- [x] AC-A4: ROI 边界上的半截文本不返回正文，只返回 `partial_text_omitted` 占位；结果有 blocks/字符双重上限和 `truncated` 标记；不新增持久 delta/cursor 状态。
- [x] AC-A5: 失败只返回稳定错误码：`permission_denied`、`wechat_not_running`、`no_active_conversation`、`layout_not_recognized`、`ocr_low_confidence`、`capture_failed`；未知布局不返回正文。
- [x] AC-A6: 可复现的 100+ 条中文长对话 fixture 在目标尺寸/layout 下字符准确率不低于 90%；低于阈值则阻止 ship 并重议路径，而不是调低置信度门槛。

### Phase B（F126 Limb 接入与显式授权）

- [x] AC-B1: 插件默认未启用；显式启用后注册唯一节点 `wechat-visible-reader-mac`，能力级别为 `leased`，停用后节点不可发现。
- [x] AC-B2: 本地 owner-only Hub action 创建内存态授权窗口（默认 10 分钟、最大 30 分钟）；未 arm/过期时调用在捕获前返回 `authorization_required`，手动撤销、插件停用或 runtime 重启都立即清空授权。
- [ ] AC-B3: 猫在授权窗口内按三步 Limb 流程可在本机 WeChat 4.1.11 读到当前选中会话的真实正文；typed failure 在调用现场可见。
- [x] AC-B4: `read_visible_conversation` 静态与行为测试证明没有 UI 点击/键盘注入、数据库读取、SIP 修改、发送路径或原始正文日志；Limb action log 只保留调用元数据。Phase C/D 的 UI allowlist 必须隔离在 navigator module，不能扩大本命令权限。
- [x] AC-B5: Plugin Hub 在 arm 前明确披露：不保存截图，但提取出的文字会进入调用猫的模型上下文与 Clowder AI invocation trace；界面显示剩余授权时间并可立即撤销。
- [x] AC-B6: 非 macOS 环境或系统能力不满足时 fail closed，不注册一个“看似在线但永远读不到”的节点。
- [ ] AC-B7: operator按 Journey A 实测，无需复制粘贴即可让猫复述当前页含义；任何低置信度或半截文本都被标注或弃权。

### Phase C（指定联系人导航与最近消息读取）

- [x] AC-C1: `read_conversation_recent` 只接受 `1..30`；调用绑定当前 callback auth 的 `userId/threadId/catId/invocationId` 与对应 `userMessageId`，并要求显式 `acknowledgeUiNavigation=true`、`acknowledgeMayMarkRead=true`。缺少 owner-originated user-message provenance 或任一确认时，在任何 UI 事件前返回 `authorization_required`。
- [x] AC-C2: navigator 仅允许在已验证的 WeChat 搜索 layout 中输入联系人文本、点击 OCR 唯一精确结果、在正文 ROI 滚动和按同一路径恢复原会话；禁止 Return、消息输入区、链接、菜单外操作与任意坐标点击。错误目标、同名歧义和 header mismatch 均 fail closed。
- [x] AC-C3: 最近消息采集有页数/滚动次数/时间/单元数四重硬上限；逐 capture/block provenance 可重建顺序并消除跨屏重叠，但正文相同的两个真实气泡不能被误去重；返回最多 30 个 `VisibleMessageUnit` 与 `truncated`/warnings。
- [x] AC-C4: UI 操作前记录原前台 app、原会话 header 与原可见 block-hash 锚点；结束时恢复原会话、原滚动锚点与前台 app。恢复任何分量失败返回 typed `restore_failed` + 分量状态，且仍执行剩余 best-effort restore。
- [x] AC-C5: active navigation 只在屏幕解锁、唯一主窗口和已知 layout 下执行，并明确显示“会短暂前置微信，打开目标会话可能清除未读”。WeChat 最小化、多主窗口或无法建立恢复锚点时拒绝，而不是猜。
- [ ] AC-C6: WeChat 4.1.11 真实机 smoke 验证至少两个 1:1 联系人的精确选择、最近 30 条顺序/拼接、错误联系人拒绝和 scene restore；100+ sidebar/contact-search fixture 与 30 条三屏 fixture 的联系人/header 识别率和正文字符准确率均不低于 90%。

### Phase D（一次性来信 Watch）

- [ ] AC-D1: `watch_contact_once` 只允许 owner-originated current invocation 注册，显式 TTL 为 `1 minute..24 hours`；注册时持久化 `watchId/userId/threadId/targetCatId/authorizingInvocationId/authorizingMessageId/contactLocator/baselineInboundHash/expiresAt/status`，正文恒不落盘。v1 每个 user 只允许一个 active 1:1 watch。
- [ ] AC-D2: watch lifecycle 为 `registering → active → verifying → firing → fired`，并可从非终态进入 `cancelled | expired | degraded`；runtime restart 恢复 `active/verifying/firing`，cancel、expiry、fire 或 plugin disable 在下一次捕获前终止任务。取消与到期不删除 lifecycle tombstone，但清除未来读取授权。
- [ ] AC-D3: 30 秒 interval poll 只把目标联系人 locator 送入 native；其他 sidebar OCR 文字、预览与像素不得离开 native 进程。只有目标 locator hint 或目标当前已打开时才做正文验证；系统通知若未来接入只能是可选加速 hint，不能成为消息真相源。
- [ ] AC-D4: fire 必须同时满足 exact target header、post-baseline 新 block、`presumedSender=other` 与布局/OCR门槛；重复旧文本、自发消息、同名联系人、partial/non-textual unknown 或低置信度不得触发。hint 不是 fire。
- [ ] AC-D5: firing 使用 `wechat-watch:<watchId>:fire` 稳定 idempotency key 写入一条 metadata-only thread message；scheduler delivery 返回的同一 message ID 用作 cat invocation idempotency source。crash/restart 在每个边界重放都只产生一个可见提醒与一个 invocation。
- [ ] AC-D6: Hub/API/猫均可查询 active watch、剩余时间、最近 typed health 与 cancel；锁屏、WeChat 退出/最小化、目标行不可见或 layout 漂移必须显示 degraded/lastError，不能把“仍在尝试”显示成“保证监听中”。
- [ ] AC-D7: 真实机 UAT 使用一条新 inbound 微信消息验证 end-to-end：注册 baseline → sleep/restart 恢复 → target hint → active verify → 原 thread 提醒/猫唤醒 → 自动终止；另验证 cancel/expiry/plugin disable 后不再捕获或触发。

## Dependencies

- **Evolved from**: F126（复用 Limb Registry、lease、动态发现和调用审计）
- **Related**: F139（复用 dynamic interval task、run ledger、幂等 thread delivery 与 restart hydration）
- **Related**: F137（同属个人微信入口，但 F137 iLink Bot 不覆盖任意本机会话）
- **Related**: F202（复用 plugin manifest、显式激活与资源生命周期）

## Risk

| 风险 | 缓解 |
|------|------|
| WeChat 更新后布局漂移，OCR 读到错误区域 | 版本化 layout profile + fixture + 未识别即 fail closed |
| 聊天内容进入外部模型/provider | 插件默认关闭；本地 owner-only 短时 arm；界面明确披露并可撤销；不额外复制到日志/长期记忆 |
| OCR 把时间、昵称或旧历史误判为当前指令 | 返回结构化候选、bbox/置信度/partial/sender unknown；猫不得把结果当 user message envelope |
| 图片/语音/红包被静默跳过，造成“全文已读”错觉 | 可识别的非文本单元返回显式 indicator；未覆盖类型给结果级 warning，不宣称当前页完整 |
| 左侧会话列表泄露联系人元数据 | OCR 前像素级裁剪，fixture 放置 canary 守护 |
| 输出过长挤占猫上下文 | blocks/字符硬上限 + truncated；不自动滚屏或读取历史 |
| 自动导航误点消息输入区或错误联系人 | UI allowlist module + 每步 layout/header 双验证 + 禁止 Return/任意坐标 + 错误即恢复现场并 fail closed |
| 导航改变未读状态、前台 app 或用户滚动位置 | 注册/调用前明确披露；scene transaction 记录 conversation/block anchors/frontmost app；逐分量恢复与 `restore_failed` |
| 长驻 watch 扫到无关联系人隐私 | TypeScript 只传目标 locator；sidebar OCR 与比较留在 native 进程，非目标文字不得出进程/日志/模型 |
| watch 因锁屏/最小化/目标不可见而漏报 | 注册现场明确 best-effort；持久化 typed health/lastError；degraded 可见、可取消，不伪称 100% 监听 |
| watch crash 边界重复提醒或漏唤醒 | lifecycle CAS + 稳定 delivery idempotency key + 持久 message ID 驱动幂等 cat trigger；restart recovery 对抗测试 |
| UI automation 触发 WeChat 风控 | 真实账号 pre-ship smoke 只走最小 allowlist；出现警告、登录异常或风控信号立即 kill active-navigation/watch，保留 passive read |

## Eval / Tracking Contract

- **Primary users + activation**: Journey A 的短时 arm + `read_visible_conversation`；Journey B 的 owner-originated `read_conversation_recent`；Journey C 的 owner-originated `watch_contact_once`。三者分别计 activation，不用“插件启用”代替真实使用。
- **Friction metric**: 当前页/指定联系人读取成功率、各 typed error、scene restore 分量成功率、watch active→fire/cancel/expire/degraded 分布、提醒延迟、operator仍需复制或出去点点点的次数；不采集正文或非目标 sidebar 信息。Phase A/B 已由 owner-only arm status 输出 20 次滚动成功率与 typed-error 计数，低于 80% 时只给出 layout pause signal，不静默降阈值。
- **Regression fixtures**: 左栏 canary 不泄露；unknown layout/低置信/partial 必须弃权；100+ 条中文正文与 100+ sidebar/contact-search fixture ≥90%；Phase C 前补 1×/2× DPR、light/dark 与亮度漂移 layout matrix；Phase D sender attribution 覆盖窄/标准/宽窗口，并结合气泡侧别/颜色，不能只依赖固定 midpoint；30 条三屏拼接保序；导航 allowlist；scene restore；watch restart/sleep/cancel/expiry/race/idempotency；native smoke 不产生图片文件。
- **Sunset signal**: passive read 连续 20 次成功率低于 80% 暂停对应 layout；指定联系人读取目标选择或 restore 低于 95%、正文准确率低于 90%，或出现任何发送/风控信号时立即 kill Phase C/D；watch 真实 UAT 漏报/误报无法在披露范围内接受时停用 watch。若官方/AX/稳定本地数据入口通过同一隐私与正确性 AC，则替换像素路径。

### 软 + 硬 + eval

- **软**: 三个 tool 描述分别写清当前页/前台导航/一次性 best-effort watch；明确闪切、可能清未读、文字进入模型上下文和 watch 不保证 100%。
- **硬**: 默认关闭、owner-originated invocation provenance、TTL/watch lifecycle、leased capability、native target-only boundary、UI allowlist、header 双验证、scene restore、typed fail-closed、幂等 fire、无正文持久化。
- **eval**: layout/sidebar/contact-search fixtures + 30 条三屏准确率与 restore gate + live inbound watch UAT + typed lifecycle/latency telemetry。

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 作为新 F265 concrete Limb，而不是修改 F137 connector | F137 没有任意个人会话正文；F126 已是本机感官的正确执行面 | 2026-07-16 |
| KD-2 | 保留 passive current-visible capability；另加高权限 active-navigation capability | operator确认 current-visible 仍要求“出去点点点”，不足以完成指定联系人最近消息旅程；分 capability 防止被动读暗中升权 | 2026-07-17 |
| KD-3 | 插件启用只代表安装能力；真实读取还需本地 owner-only 短时 arm | 微信正文是敏感第三方内容；10 分钟窗口保留连续使用体验，过期/重启自动失效 | 2026-07-16 |
| KD-4 | 结构化 OCR candidate，不投影成 `MessageEnvelope` | 像素识别有歧义；旧历史不能冒充当前用户消息 | 2026-07-16 |
| KD-5 | 单次 capture 保持 stateless；一次性 watch 只持久化 locator/baseline/lifecycle，不持久化正文 | current read 无需状态；watch 必须跨 restart，但最小状态足以去重与撤销 | 2026-07-17 |
| KD-6 | 用户在 owner thread 的直接指令是 active read/watch 的授权事件；server 绑定 callback 与 invocation/user-message provenance | 满足“我喊你就做”而不要求 Hub 再点一次，同时让授权来源、对象、时限和执行猫可审计；非 owner-originated invocation 拒绝注册 | 2026-07-17 |
| KD-7 | 主动导航只允许“暂时前置 WeChat + 搜索/精确点击/header 验证/正文滚动/恢复现场” | 本机后台定向 CGEvent 探针无效；承诺无闪切会造假。逐步可验证的前台事务比后台盲点更安全 | 2026-07-17 |
| KD-8 | watch 的采集/验证归 Limb，持久轮询/恢复/投递归 scheduler dynamic task | 一个是设备 sensor/actuator，一个是 durable lifecycle；复用现有 extension points，不把本机 UI-OCR 塞进 connector，也不造第二套队列 | 2026-07-17 |
| KD-9 | v1 watch 用 target-only sidebar OCR 作为 30 秒 hint，目标会话 active OCR 作为 truth；系统通知仅未来可选加速 | Apple public notification API 面向本 app 的通知，仓库也没有稳定的跨 app WeChat notification ingress；hint 不能冒充正文真相源 | 2026-07-17 |
| KD-10 | v1 只支持一个 1:1 one-shot watch，最长 24h；群聊、多 watch、语义 predicate 延后 | sender attribution、同名与并发状态会显著放大误报面；先把错误上限锁为一次 | 2026-07-17 |
| KD-11 | 任何发送路径、DB key 提取/重签/降级和全会话后台扫描继续硬排除 | 用户授权的是只读指定对象与一次性等待，不是代发或破解微信 | 2026-07-17 |

## Tips Contribution（F244）

- Phase A/B 已新增一条能力提示：启用后，在微信选中目标会话，对猫说“看一下微信”。Phase C/D 交付时扩为三个可发现示例：“看一下当前微信”“看 X 最近 30 条”“24 小时内等 X 来信后找我”；提示链接到本 feature doc/plugin truth source。

## Implementation Evidence（branch，待 merge + 标准 Limb UAT）

- Native `--self-test`：正文 hard crop、侧栏/标题/输入区 canary、窗口 geometry、像素 layout marker、partial abstention、非文本 indicator、页面级低置信熔断与无图片文件写入全部通过。
- 中文准确率 fixture：在 `1158×769` 目标窗口/layout 中，120 个对话单元、1900 个汉字，Vision OCR 字符准确率 `100%`（ship floor `90%`）；侧栏/标题/输入区 canary 未泄露，fixture 运行目录无图片文件。
- WeChat 4.1.11 live smoke：匿名像素统计定位侧栏分界约 `x=0.370`、输入区分界约 `y=0.746`；修正后 `4` blocks / `20` chars，平均 confidence `0.75`，`truncated=false`，并显式返回低置信文本/纯视觉非文本可能被省略的 warning。全程只记录聚合指标，没有记录正文或截图。
- WeChat 4.1.11 operator live UAT（branch native reader）：当前可见会话返回 `12` 个 message units / `156` chars，layout confidence `0.96`、`truncated=false`；operator在 thread `[thread-id]` 目视确认“是一样的”。该验收记录于 `397e4a64f`，其父提交就是 ROI/privacy 修复 `54212f6a0`；验收所用 native reader blob `8f5d2167…` 与本轮 final review candidate 相同。读取前后 worktree clean，未产生截图或其他文件。该证据解除 OCR 真实内容可行性风险，但 AC-B3/B7 仍需 merge 后以 Plugin Hub arm + 标准 Limb 三步调用完成终态验收。
- Phase C aggregate-only live probe：final-candidate 在 WeChat 未呈现唯一、正常且可恢复的 active conversation 时返回 `no_active_conversation`，且发生在任何键鼠/UI 事件之前；未产生正文、截图或 UI 副作用。该证据只验证 AC-C5 的 fail-closed 分支，不能替代 AC-C6 的两联系人真实导航/30 条拼接/scene restore UAT。
- F265/callback/Limb focused regression 共 `73/73`、Hub 四态 component `4/4` 通过；新增 fixture 证明不同真实消息即使正文序列相同也不会仅按文本误去重，恢复读取与 anchor 定位共用同一历史方向，SIGTERM 先转 cooperative cancellation 再进入 scene restore。Limb action log 回归证明 tool result 可含正文而 action log 不复制正文；native probe 失败时 factory 不注册假在线节点；Phase A/B rolling metrics 只保留成功/typed-error 聚合，不保留 OCR 正文、hash 或截图。
- Hub Browser Preview 已打开 `/settings?s=plugins`，页面返回 `200`；最终用户旅程仍保留 AC-B3/B7，待合入后通过 alpha + 标准 Limb 三步调用验收。

## Review Gate

- Phase A/B foundation: 非作者跨个体 review，重点审 privacy boundary、crop canary、typed abstention、native runner 命令安全与“未包含 active navigation/watch”的诚实 scope。
- Phase C: 非作者跨个体 review，重点审 owner-message provenance、UI allowlist、错误目标 fail-closed、bounded stitching、scene transaction 与风控 kill switch。
- Phase D: 非作者跨个体 review，重点审持久授权、target-only native boundary、scheduler recovery、cancel/expiry、idempotent fire 与正文零持久化。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “猫爪爪能够看到我的 wechat 信息” | AC-A1, AC-A3, AC-B3 | native smoke + Limb live UAT | [ ] |
| R2 | “不然我天天给你们 copy wechat 消息” | AC-B7 | Journey A 实测 | [ ] |
| R3 | “获取不到内容那就太难受了” | AC-A5, AC-B3 | typed failure tests + real text assertion | [ ] |
| R4 | 不用关闭 SIP、解密数据库、重签/降级微信或发送消息 | AC-B4, AC-C2 | static allow/deny scan + behavior tests | [ ] |
| R5 | 授权和隐私边界可撤销、可理解 | AC-B1, AC-B2, AC-B5 | activation + arm/revoke UAT + disclosure review | [ ] |
| R6 | “看吴浪和 xxx 最新 30 条”，不用出去点点点 | AC-C1..C6 | 两联系人真机 UAT + 30 条三屏 fixture + restore evidence | [ ] |
| R7 | “等收到 xxx 消息找我” | AC-D1..D7 | durable one-shot watch lifecycle tests + real inbound UAT | [ ] |
| R8 | watch 只盯指定联系人，不扫描/泄露全部聊天 | AC-D3, AC-D4 | native target-only canary + process-boundary/log assertions | [ ] |

### 覆盖检查

- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（Plugin Hub arm；active read/watch 的副作用披露、状态、倒计时与 cancel；映射 AC-B2/B5/C5/D6）
