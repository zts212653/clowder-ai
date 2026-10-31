---
feature_ids: [F320]
tips_exempt: "The delivered account entry contains contextual official-login/token instructions and capability limits; retain discovery in the existing Settings account journey. Full real-account acceptance and project rules remain open, so do not publish their planned tips as delivered capabilities."
related_features: [F062, F136, F171, F291, F318, F319]
topics: [accounts, oauth, credentials, provider-routing, hub-settings]
doc_kind: spec
created: 2026-09-24
updated: 2026-10-29
description: "同一家厂商可以登录多个 OAuth 账号（如公司号与私人号），各自隔离；按猫家族一键换绑，或按项目自动选用对应账号。"
description_source: human
description_author: opus55
description_updated_at: 2026-09-24T09:38:50Z
---

# F320: Multi-OAuth Accounts｜同一厂商多个 OAuth 账号 + 按家族一键切换

> **Status**: in-progress | **Owner**: Ragdoll (@opus55, claude-opus-5-5) | **Priority**: P1

**Codex-first 当前责任**：Astra (@codex-astra, gpt-6-astra) 规划/协调/验收，Sol61 (@codex61-sol, gpt-6.1-sol) 执行；保留原 Feature owner 与 Phase A/B/C。

## 已修复 Issue：原生 discovery timed out 漏判（2026-10-29）

## 已修复 Issue：启动联网失败恢复与诊断（2026-10-27）

You 在 `[thread-id]#private-source-id` 要求先由 Astra 写清修法，再交 F320 小太阳实施：暂时联网失败应自动恢复，错误要保留实际后端证据并让人理解。截图调用在 `account/read` 两次失败，尚未发送 `turn/start`；引入账号前置核验的是 #5195，额外一次启动重试来自 #3097。

You 随后在同线程 `private-source-id` 明确要求派给 F320 小太阳修复。修复 Task `private-source-id` 已以结构化 action 派发 Sol61，实际执行复用当前问题线程 `[thread-id]`，Astra 协调/验收；成功消息 `private-source-id` 与落点调整原因写入问题单，旧 F320 线程保留为历史上下文。

## Codex 当前使用与验收状态（2026-10-23 UTC）

**Codex 主体已交付，日常使用与额度体验已获 You 多日真人使用认可；整项 Feature 保持 in-progress。** You 在 `[thread-id]#private-source-id` 的 F320 附注明确：「我们的codex + 额度等我用了好多天了目前体验挺好」，并要求更新 feature 文档。这是正式日常使用与额度的直接人工证据，不再把它们笼统记为「真实旅程未验」或等待旧版加载。此次认可不扩到 Claude、完整 A→B→A 或 Phase C，也没有关闭整项的授权。

剩余证据边界：上述 A 消耗仍缺逐调用归因；完整 A→B→A 的返程、具体 `remote_compaction_v2` 路径及正式账号页错误/恢复与中英文场景仍待原线归并。它们不能反过来否定已认可的 Codex 日常使用与额度体验，也不等于所有额度功能仍未验。登录/持久化已有实现、隔离检查与用户使用证据；Astra 继续优先归并正常使用记录，不为了验收强行打断用户会话、反复真实换号或新增长轮 Alpha。保留原 AC 的完整范围，不把本次认可扩成全部 AC 已满足。

**换号范围保持原约定**：人工一键换绑是已交付的 Phase B 路径，下一调用使用新号、在途调用保留启动账号；Phase C 的「按项目默认规则选用账号」是原规划，仍开放；KD-1 排除的「因限流/报错自动轮换账号」仍是非目标。You 本次提及没有自动切换，不构成开发自动换号、重定 Phase 或新增验收阻塞的指令。

**额度功能入口**：设置 → 猫猫团队 → 账户与登录 → 已登录 Codex 账号行的「额度」列。没查过时点「查额度」，已有读数时点行尾刷新图标；各时间窗口分别显示剩余量条，窄屏只显示最紧的窗口（PR #5850）。`CodexQuotaControl` 沿用该身份的查询接口，展示剩余百分比与重置时间；刷新失败保留上次读数和观测时间，未查询不代表额度为零。额度查询不是逐次现金扣费账单，A 的实际消耗仍须与调用启动快照和实际额度变化对齐。

## Claude 子工作交付状态（2026-10-23 UTC）

这项真人结果有独立来源：You 在本线 human1582（`private-source-id`）要求用猫咖保存的长效 token 在新 terminal 试用且不切 runtime；human1630（`private-source-id`，2026-10-20）随后明确「测试成功」。成功范围是该独立 terminal 旅程，不是 runtime 换绑、Claude 额度归属、全部身份验证或远程 A→B→A；也不是用 10-23 的 Codex 认可替 Claude 签字。新增多份 Claude 浏览器 OAuth 登录仍不由此记为已交付。

入口沿现有「设置 → 猫猫团队 → 账户与登录」。用户亲自在官方 CLI 执行 `claude setup-token`，将所得 token 填入 Hub 密码框；应用不代登录或生成 token。各账号的秘密分别由既有 credentials authority 保存，账号列表只保存备注及非秘密状态；可只改备注、更新 token，保存不自动换号。显式一次换绑作用于启用的本地 Claude 成员；在途调用保留旧 token/执行快照，下次调用捕获新号，历史回复与 usage 不被当前绑定改写。宿主 HOME、共享配置/会话根目录和默认登录保持。这里交付的是独立私有 token 账号，并未把原 AC-A1 的独立登录目录或真人认证状态冒充已满足。

官方文档说明一年 OAuth token 通过 `CLAUDE_CODE_OAUTH_TOKEN` 用于模型请求、本地 MCP，不支持 Remote Control/claude.ai connectors。原生 CLI 2.1.296 在 loopback 假服务上完成 A→B→A、同一实际 session/历史；settings 中竞争 token 会在调用前明确拒绝，SDK 空 settings 来源的原生写法也已独立核验。**bg_daemon 已实证不支持每派发换 token**，产品对托管 token 账号明确拒绝该 carrier，且不通过健康降级静默换 carrier。默认 print 路径适用；该子工作交付时未验 PTY 真模型回合及 SDK 真激活，后续独立 terminal 真人成功另见上文。UI 表达「Token 已保存／官方身份未验证」，不推断有效期、订阅身份或额度。

Sonnet 的 typed APPROVED842（`private-source-id`）覆盖 `f1cfa15da8901ac753d8ea5813a55d66a64df7e3`，两项错号阻塞与五项补充 finding 已处理，变异复验能检出回退。合流候选 `8866c420d0baa94c07c7aab021c4dfcce3654b8c` 的作者补丁与已审版本逐字节相同；合流后 API/carrier 130/130、实际页面主线 1/1 通过，原 Web 67/67、类型/构建与原生证明沿用。[合入 evidence manifest](https://github.com/zts212653/clowder-ai/pull/5540#issuecomment-6171039782)记录 C1–C3。GitHub 无 CI checks，不称 CI 通过。

2026-10-14 子工作交付时 `main=landed:50414181f7bab944d4b337e34d8e3fcd5074ac8c`；作者未执行 runtime 重启或真实账号切换，当时观察到的 runtime checkout 为 `9e20438625509a4dea7b8e9d0f19946b836a9a4c`。这是交付时的加载快照，不作为今天仍未加载的结论。子 thread 无原 work Task，`read_development_return` 无注册，已按批准的 final-only 路由回父线归并；不创建镜像 Task 或改父 Task 来补登记。产品内换绑、真实 token 身份/额度与远程跨账号续聊仍由父线按各自证据接续，10-20 独立 terminal 成功不代签这些验收；F320 整体及 Phase C 保持开放。

## 账号页返修交付与剩余回读（2026-10-13 UTC）

实际枚举失败来自一个凭据与元数据不完整的旧 Kimi ref：catalog 能解析，但 canonical per-ref resolver 拒绝该 ref，旧默认枚举因此中断整份列表。隔离 RED→GREEN 证明修复将该 ref 单独保留为 rejected、正常默认号继续可见，凭据字节不变；真正损坏的 catalog 仍报错，修复后可恢复。默认补全与选用读取现在分别表达各自事实：补全失败不否定可信选择；成员选择读取失败、缺失或过期会撤销旧「正在用」，晚到旧读不能恢复它，换绑提交会作废更早的读。未改账号选择权威或真实绑定。

本轮沿原责任直接返修：人类 `[thread-id]#private-source-id` 要求需改代码的直接 A2A 开工；原设计方在 ROOT `[thread-id]#private-source-id` 逐行裁定账号问题回 F320、英文页面只用一种界面语言。Astra 已全文核两源。Sol61 在原线集中修复，Astra 协调验收；F322 B 保留成员/设置说明文字和布局工作，不另建账号 writer 或镜像 Task。

本轮验收范围：

- 查清默认账号枚举失败的实际原因并用隔离复现验证修复；不能只藏错误。账号选择、成员绑定、登录是否可读分别按各自权威数据表达，未知身份显示「读不到／未确认」，不把查询失败当作解绑或自动换号，也不把无依据的状态标成「正在用」。已有可信选用事实不被另一项查询错误抹掉。保留原绑定与凭据归属，不搬 HOME、复制认证或改真实账号来制造正常。
- 账号页的标题、表头、状态、提示、错误、菜单和动作，以及添加/换绑/展开等同一账号旅程，使用现有界面语言机制完整提供中英文。服务端已知错误与产品生成的默认号名也须有一致呈现；用户填写的备注、邮箱和工具固有名称保留原值，不伪造翻译或改存量数据。
- 原作者完成有意义的 RED→GREEN、受影响检查和一次页面主线，覆盖默认查询失败、未知身份、可信选用状态及中英文切换；沿原非作者审查链交一张集中修复 PR。上述作者交付已在 #5458 完成并进入正式运行版本，正式页面完整回读仍待验；已接受的短验证与真人登录验收方式保持，不以新建大套 Alpha 前置阻挡交付。该次返修未覆盖的真人项目已按后续直接证据更新到顶部，不沿用当时「全未验」的口径。

## 宿主工具与额度返修（2026-10-12 UTC）

共同根因修复 [#5431](https://github.com/zts212653/clowder-ai/pull/5431) 于 2026-10-12 07:36:08 UTC 正常 squash 合入 `1182b297d7a438683896cf50821acf370341ed9f`：托管 OAuth 不再把普通工具的 HOME 投影成账号私有 runtime-home，而沿用 API parent 宿主 HOME 与显式工具路径；私有 CODEX_HOME、共享 SQLite、强制文件认证、workspace/identity 准入与原调用快照保留，API-key/Collective/F293 隔离未改变。不搬目录、复制凭据或改变真实绑定；原 runtime-home 目录不删除。原 Sol5.6 typed APPROVED1099（`private-source-id`）覆盖 `d8401ff039` 与上述 immutable human source；合流候选 `d3e8a3e9fb`、落地提交均为八个已审文件 blob 全同。作者受影响 65/65、兼容 146/146、合流关键 9/9；独立 runtime-interaction 223/223、F293 24/24、API build 通过。GitHub 没有 CI checks，不称 CI 绿；[合入证据](https://github.com/zts212653/clowder-ai/pull/5431#issuecomment-6119800728)保留。

2026-10-12 的正式服务记录为 boot24 / revision `8f98aed76a0d25b5053f79d4b2db0af1ff898209`，包含 #5350、#5426 与 #5431；#5426 / #5431 的包含关系已由 Git ancestry 独立核实。下方 boot23 与「尚未加载」保留为上轮交付现场，不再作为当前加载阻塞。You source677 `[thread-id]#private-source-id` 最初因额度一直为 100% 怀疑仍用本机 OAuth，随后 source704 `private-source-id` 明确确认已切过去；**“实际账号没切换”的故障判断已撤回，本轮修复的是额度归属错误。** 原作者 source700 核到本轮 executionAccount 为所选托管号且 session ID 保留，旧回合仍记原账号；这不扩大为真人压缩后全链 AC 已通过。

额度缺陷已在 [#5426](https://github.com/zts212653/clowder-ai/pull/5426) 修复并于 2026-10-12 05:48:18 UTC 合入 `e07eec9c637bc7a5eeb905d80f960b021eb2a043`：原 `hub-quota-pools.ts` 将本机 aggregate `quota.codex` 复用到同厂商 OAuth 行，现托管号只展示属于自己当前有效身份的观测，沿既有按账号 API 查询；未查询或旧无 owner 观测不会冒充 100%，身份失效/变化立即撤掉旧数值和风险，延迟结果不能覆盖另一身份，在途最新成功账号列表仍能撤销过期额度。

原 Sol5.6 typed APPROVED922（`private-source-id`）覆盖 `402427dc9402c5fdc1cbed300a370d158df32e05` / accepted revision `8298f57641cb46db21cb73f0ae538dcaeb74b26f`；Sonnet canonical gh 回执932及[合入证据](https://github.com/zts212653/clowder-ai/pull/5426#issuecomment-6118534477)已核。Astra 独立比对已审、合流候选 `313b2b15` 与落地提交，12 个改动路径的 blob 全同；复用最终 Web 51/51、API 11/11 和 R3 隔离页面证据。R3 实际页面中本机 fake 100% 与托管 fake 70% 各自归属，账号列表在途期间额度先返回、随后 fake 登录失效，列表回包立即清掉托管旧数值且无 pageerror；Astra 已读 `/tmp/f320-quota-account-browser/result-r3.json` 并查看 `managed-quota-invalidated-r3.png`。GitHub 无 CI checks，不声称 CI 或真人额度已通过。

**当时工具恢复已验；其后已有真人使用结果。** 原 boot23 的加载等待已被 boot24 事实取代，作者本轮没有操作正式停启。10-14 已归并 B 上原生压缩后续聊，10-23 已取得 You 对日常 Codex 与额度的认可；当前额度入口和剩余证据边界见顶部，不再沿用本轮交付时「真实额度及压缩续聊全未验」的描述。原作者工位已实际释放，恢复归档为 `/home/user/projects/relay-station/.worktree-release-archives/cd1dcf72-dd31-417d-ad95-93d6fa34fbce`，branch/原件保留；不重开 done Task3402、不为本次恢复新造 Task 或 review。

### 修复前的定位与发布记录（历史）

以下是 #5431 之前的现场，当前工具恢复以本节顶部 boot24 证据为准。同轮纳入常用工具消费者：平行 Gate 线程 `[thread-id]` 的 Astra 经本线 source686 `private-source-id` 回流，新托管 wake 的 HOME 变为账号私有 runtime-home 后，canonical `gh` 无登录、`git push` 无可用凭据；显式原 GH 配置目录也报 token 无效。发布候选与 Task512 仍属原线程，未转移给 F320。原始发布障碍见该线程 source684 `private-source-id`，没有复制凭据或重新登录。

Astra 已核源码 `account-resolver.ts#accountToRuntimeProfile` 为托管号同时注入私有 HOME 与独立 CODEX_HOME；`CodexAgentService` 合入账号环境，`scripts/guarded-bin/gh` 原样传递 HOME。自己的本次进程亦有同样的路径选择且无 GH_CONFIG_DIR/XDG_CONFIG_HOME/令牌变量。**已确认这是显式 HOME 隔离及其工具查找后果；尚未证明原配置报错原因，也不证明模型 OAuth 选择错误。** 原约定的第三方认证不自动复制保持；不能用共享整个 HOME、复制 hosts.yml/令牌、换回模型账号或改 Keychain 冒充修复。原作者同时核清宿主命令环境应如何使用既有授权；认证确实无效时仍须用户在官方工具恢复，路径改动不能伪装凭据恢复。

原实现线接续 source689 `private-source-id`，经 human704 收窄到上述额度缺陷及独立 CLI 消费问题；额度实现/隔离验证已交付，正式加载后的真人原场景核对继续由 Astra 承接。工具环境只读调查802/803已回 Pro/平行原线，调查完成不等于恢复完成，#5426 不承担该问题已解决的声明。Task512 的发布/合入责任仍属原线程。当前未替用户切号、登录、读写既有凭据或重启服务，真人 AC 继续开放。

发布边界：Astra 的 HTTPS 推送曾以 `Device not configured` 失败；随后核实既有 SSH 认证可用，保留 `027a985fbd` / `d0005cbd38` 两笔记录、普通合流已合入的 Task512 增量后，已将 main 推送为 `6b65c17eba`。没有更改 origin URL、HOME 或复制凭据，Git 拉取/推送可以沿这一既有 SSH 路径继续。**这不证明 `gh` 登录恢复**；其 PR/API 操作仍需有效的 canonical gh 登录环境，原配置也无法认证时由用户通过官方 gh 恢复。不承诺仅加 GH_CONFIG_DIR 能恢复，不把 GitHub 认证失败转嫁成模型换号回退。

## v2 接入与待加载现场（2026-10-10 至 10-11，历史）

以下保留当时的加载等待与下一步，不是当前待办；#5350 后续已加载，当前使用认可见顶部。

新页面一个账号一行，分 OAuth 登录/API 密钥，可按厂商、备注、邮箱或猫名搜索；「本机默认登录」与「正在用」分开，登录成功不自动换号。设置位于猫猫团队、紧跟成员与运行时；成员行显示实际账号名称。全页唯一添加入口，只开放已实现的 Codex 新 OAuth 登录及 API 密钥；其他工具的本机默认行不是新增多账号能力。数量取真实数据，不抄示意稿的 17 个号；账号污染由另线处理，本轮不清真实配置。

隔离事实更正仍有效：作者 source965 `private-source-id` 披露早期测试因继承 Codex home 选择器读取既有默认登录文件，未写入或输出 token；旧 80/80 的“全隔离”用途已撤回。修正入口及自有假登录 fixture 后的严格检查已通过，不能用新绿表抹去原读取事实。正式 runtime、真实登录/换绑/额度/推理/压缩操作未在本轮执行。

## 上轮体验纠正（2026-10-10 上午，历史）

You 在 `[thread-id]#private-source-id` 确认新账号登录成功，但无法分辨当前使用账号，并明确希望继续使用 Codex App 的原登录；source055 `private-source-id` 指出四个同名「Maine Coon」下拉无意义；source060 `private-source-id` 明确正常使用应是**一个 Codex 当前账号，全体本地 Codex 猫跟随**，拒绝逐猫配置及 v2 成员表上的重复换号块。

- 本轮正常路径围绕「当前使用账号」组织；登录成功、已保存的备选账号、当前实际使用分别说明。用户当前想保留原默认登录，不能因新增「主号」而暗示或擅自切换。切换一次对全体本地 Codex 猫的后续调用生效，在途仍沿原账号；存量配置不靠 UI 改版静默迁移。
- 账号页和 v2 成员页上的逐猫/逐家族下拉堆叠不再是本轮正常入口。当前账号应直接可见，身份、备注、使用范围能读懂；工作区 UUID、目录、内部状态与低频动作不占主要信息层级。视觉与字号沿 DESIGN.md，先由原设计负责人出整屏及关键状态稿，再由原实现线接入，不由后端卡片继续自行拼接。
- 已核数据错误：账号 API 将持久账号根解析到 workspace 后，members/preview/commit 又用同一根读写成员 catalog；本机 workspace catalog 的四个旧 Codex 变体同名，正式 runtime catalog 的实际成员及绑定不同。持久账号归属与运行成员归属需要各取真实 owner，不能把前者直接当后者；不靠只补下拉标签掩盖接错数据。
- 截至这次只读核对，正式 runtime 的本地 Codex 成员仍指向内置 `codex`，Astra 当前进程的 `CODEX_HOME` 为原默认目录；新增主号没有成为运行成员绑定。这里只记录账号来源，不以目录推断 Codex App 此刻显示的具体身份。未操作真实换绑、凭据或登录。
- Astra 承接整体纠正，Sol61 修成员归属与生效信息；原 F320 设计负责人 Opus55 结合其当前 Workspace/v2 设计现场补账号页与成员页的统一表达。原 source442 的短验证、用户直接实测保持，不新开长轮 Alpha；真实账号仍由用户操作。

You 与 Opus55 先在设计现场澄清统一账号概念下 OAuth/API 的组织方式、OAuth 类型以及多厂商快速查找，并与泽丰在 clowder-ai #1466 的成员/工具改造对齐；新稿需由人类定稿后再续页面。Sol61 只继续独立的旧成员 catalog 归属修复与受影响回归，已有 UI 改动保留在工位，不丢弃或发布。原默认登录、真实账号操作边界与排除云端 gpt-pro 的作用范围保持；本次设计讨论不授予 Claude 多账号后端扩展。

独立数据修复已保存为 [Draft PR #5350](https://github.com/zts212653/clowder-ai/pull/5350)，当前 HEAD `2787dc5e0783cad0fa1d8209562d0ffbc55f7881`，产品提交 `403cbfaef98b9316f76791f26fba775b280c779e`。Astra 已核 PR 为 open/draft，范围仅三个 API 文件和成员归属回归测试，Web 无改动；作者回报隔离检查 15/15、API 类型与构建通过，未操作真实账号或正式服务。旧稿实现保留在作者工位，不进入 PR；当前不请审、不 Ready、不合入，页面定稿后由原作者沿同一 PR 接续。

## 上轮返修决定（2026-10-09 UTC，历史）

You `[thread-id]#private-source-id` 要求快速修好前端和整个用户旅程，由他亲自测试；登录只需弹出 CLI 窗口并准备好命令，用户自己按回车也可以。**本轮不再以长轮 Alpha 或全套真人旅程预验作为交到用户手里的前置。** 作者完成受影响检查和一次页面主线核对，保留必要的身份/目录隔离检查；真人登录、额度和续聊由用户从产品发起实测，问题留在原线继续修。

- #5222 已于 2026-10-08 合入 `6a0267a3c67f23447197cea64bebd8feacc6db9e`。本次是合入后用户实测暴露问题的集中返修，用一张修复 PR，不尝试续写已合入 PR，不恢复切片交付。
- 同一个添加账号入口承载厂商、登录方式和备注；Codex OAuth 接到官方终端登录，默认与新增账号在同一列表，不再并列两套同义入口。沿用现有设置组件和 API Key 路径，不另起页面改版。
- 终端准备该账号独立目录下的官方 `codex login`，可直接执行，也允许用户自己回车；官方 CLI 处理浏览器和授权。查清当前启动阻断与请求超时，避免把端口探测结果冒称为另一个真实登录，不新增端口/浏览器/终端总控。
- 登录失败或请求超时后能在原条目重试、取消或删除；操作中的提示与按钮一致，未登录时不呈现可用额度/换绑的假象。登录完成后可继续原有换绑入口，备注及账号保持持久。
- Sol61 继续实现，Astra 接完整交付；原 Sol5.6 做一次针对实际修复 delta 的独立检查，不增加第二 reviewer、全仓重测或新的验收流程。正常合入后给出确切可测版本和入口；正式 runtime 的停启仍按既有权限，不由账号按钮触发。

## 上轮交付决定（2026-10-08，历史）

You 在 `[thread-id]#private-source-id` 要求「点击新建账号」「这个账号的备注名」「和 codex cli 我按一下 codex login 的体验一样」；`#private-source-id` 确认并恢复实施。**最新 source `#private-source-id` 明确纠正：只需唤醒 terminal 执行官方 `codex login`，浏览器打开完全沿用 CLI 自己的行为，不写 Chrome 脚本，不记录/冻结 profile、PID 或窗口。** 前一版把用户对原生体验的描述翻译成自建浏览器路由保证，是 Astra 的需求翻译错误；该要求和对应验收已撤回。

**当前终点：填备注 → 猫咖唤起终端，在该账号的独立 `CODEX_HOME` 执行已安装的官方 `codex login` → CLI 自己打开浏览器 → 用户亲自授权 → 猫咖读回该账号的官方登录结果并保留备注 → 重复添加另一个账号。** 用户不用手写命令或 home 路径。猫咖只负责账号目录、终端命令和结果显示，不接管浏览器、不代理用户完成授权。

- **撤出本次产品交付的额外前置**：F320 专用自动安装/构建/发布、维护冻结、跨发布阶段事务与崩溃回滚总控；不再为验收账号迁入正式环境扩建 F300 生命周期。仅为这些流程新增的接线随实现清理；独立存在的缺陷按真实消费者判断，不能以删目录代替风险核验。
- 新账号从第一次真实登录就使用长期持久的正式账号归属与不随备注/checkout 变化的凭据目录。预览使用隔离 fixture；首次真实账号添加安排在正常更新后的持久账号页，不先制造一批必须迁移的真人验收账号。发布使用已有流程，不能由“新建账号”触发或成为它的新依赖。
- 本次恢复文档、代码、隔离验证和原审查链；没有授权猫代办真人 OAuth、读取/复制既有真实凭据、真实额度/推理/压缩实验或正式 runtime 停启。产品入口应先做到可操作，只有人必须亲自完成的官方授权再交给人；真实部分未执行就保持未验，不能把暂缺授权扩大成开发停工。
- 截至 source357，#5222 已到 `80ad70ae40d92561725d4935dcb5c03db70c01d6`、未合入；额外部署总控已撤出，但新增的 Chrome 窗口/profile 自动化仍是错误方向，必须删除。作者 source376 回报未执行真实登录或真实 OAuth，只操作过 Chrome 窗口/Profiles 菜单、本地链接与临时假账号；这些操作现已停止。真实终端登录和双账号调用旅程仍未验。

本节和下方 User Journey / AC 是最新约定；早期切片及审查段落保留来源和证据，冲突处以本节及 `#codex-final` 为准。F314 已合入的完整旅程与真实输入方法直接用于本次交付，不新增 Gate、Task、第二 reviewer 或计数熔断。

## Codex-first Design Gate（2026-10-06，历史）

- You 已在本线程选择「按当前稿进入后端实现」：原始 human source `[thread-id]#private-source-id`，Astra 已精确回读。批准对应 P1 `94d200e74817a6109ea2c1912c3862c8b56f55fd`，独立操作通过回执 `private-source-id`。
- 这次放行 Codex Phase A/B 的后端实现方向，先做 Phase A 的 P2a 工作单元；Claude、项目规则仍为后续范围，不改写整项 Feature 的 AC。
- 采用浏览器登录主旅程、换绑影响预览、身份不符时默认保留原账号；账号身份与 secrets/控制目录独立，会话/写锁/原生记忆等连续状态按已验证归属共享。第三方认证不复制，未知 home 内容不自动共享。
- 保留当前 main 的 host/lease 与 #5052，F323 仅保留 Phase A（B 已撤回）；不把单账号单进程改造设为本轮前置。跨进程刷新与外部登录争用仍有残余边界，不宣称消除。真实登录、凭据操作、普通/服务端压缩后的跨账号推理尚未执行或验收；本次 Gate 不授予这些操作。

P1 是隔离的真实 Hub 宿主体验稿，5 条浏览器旅程与 14 个单测通过，旧身份确认覆盖新登录的反例已修复并由 Astra 复验；这些是模拟交互证据，所有产品 AC 仍按真实交付逐项验收。

## Codex 剩余工作一次交付（2026-10-07，历史）

当时仍未交付真实登录/换绑及服务端压缩后的 A→B→A；这些是该轮最终交付要完成的结果。真实浏览器授权需要用户实际参与，先做成可操作入口，不擅自操作既有凭据，不把 mock 绿表算为真实通过。默认 home/keyring、F293 插件/apps 隔离、Collective 私有边界和既有账号兼容保持；完整 Alpha 健康沿原维护责任解决。此处保留当时的工作范围，后续已交付与认可的部分以上方当前状态为准。

## Codex P2a 验收（2026-10-07，历史）

Astra 接受 P2a 的限定交付，目标为 [PR #5195](https://github.com/zts212653/clowder-ai/pull/5195) / `393f93e6fd959df2c904ee22f03d9d95d909a9df`；**已通过 #5195 合入 `273e93712627c5e586a51f8fcb9d7476fad6f8f5`；原 Task 的受影响 Alpha checkout 后验完成（101入口/68恢复兼容/5原生配置/2loopback）；named Alpha 未到 HTTP ready，托管账号未启用**。正式语义批准 `private-source-id` 与安全批准 `private-source-id` 都覆盖该 HEAD 和 accepted revision `d916ad69842360cca53a0d7d9892b87d2720f2ad`。Astra 已全文核对两份 typed fact、PR/local HEAD、最终十份工件哈希与撤回 B 路径，未新增第三轮独立审查。

本单元结果成立：所选账号贯穿 F306 探测、主调用与原控制快照；API 探测/调用同根，显式模式排除 ambient 身份与路由来源；成员 CLI/RPC 不能改写账号拥有的 provider/凭据/路由/状态字段；六控制入口在首个业务 RPC 前核原生配置，失败只释放本连接；F323 B 未恢复。作者 95 项源检查、394 项兼容、native loopback 2 项及 API build 通过；独立 reviewer 分别实跑 95/2/无 wrapper 隔离1/build 与94项，并关闭当前 P1/P2。native 401 fixture 仅证明所选 key/header 构造，不证明真实登录、计费或推理。

兼容变化需随交付保留：未填 endpoint 的 API 账号现在使用所选 key 的官方 API；成员配置不能再代替账号设置 provider/routing。API key 对 owner 配置的 stdio MCP/bearer-env 可见是原有边界，不新增加固承诺。原 Task3402 已完成合入与受影响 Alpha checkout 后验，按原授权收口本单元；真实/托管账号、稳定 account ID、bootstrap/未知 policy/carrier、L4–L6 与全 Feature AC 均未通过，不据 P2a 打勾。

### 合入后返修（2026-10-07）

已合入 Alpha checkout `9b5851671630d9934b3ecf382ec5c98b1ce3db3d` 的入口95/恢复兼容81/原生配置读取4通过；原配置 fixture 当时未把完整 native DTO 交给生产 validator，正向 mock 也只检查 done，未确保业务请求成功，所以这些旧绿不能抵销真实反例。返修增加真实 DTO 校验及正向业务/no-error 断言。独立 named Alpha 整套启动另因 Redis 目录身份校验退出，未声称 HTTP ready，也未绕过检查；这与本片账号修订分开记录。

### P2a 审查历史（2026-10-06）

Architecture cell: identity-session（provider-account 子边界）。

Map delta: update required；#5195 已提交 cell 的 canonical anchors 增量，待审合入。既有 account resolver/store 与原生 host/lease owner 继续拥有各自权威，不新增 Store/Router。

Why: 所选账号的规范启动快照需要贯穿调用、能力探测、控制恢复、历史和额度读取，避免另一个读取方重选默认账号。具体 consumer census 与行为契约见已接受的后端计划。

本地语义审查核对 P2a 约定、兼容与资源归属；独立凭据安全审查核对认证 env/config 旁路和凭据泄漏。当前已交 Sol（GPT-5.6）做语义审查；[云端明确返回 review 额度耗尽](https://github.com/zts212653/clowder-ai/pull/5195#issuecomment-6017667777)，按既有替代路径交 Opus55 完整审查 PR，重点覆盖安全面，不把未发生的云端审查记为通过。L1–L3 的无凭据结果包括原生同一 thread 写锁、A→B→冷启动 A、本地历史/记忆/目标和 mock keyring；memory v2 启用时实测是七个 SQLite。官方 config writer 保留软链已有证据，其余真实 writer、沙箱/压缩协调与历史附件仍为 P2b 启用前阻塞。不得据此新增账号级队列，也不把这些结果当成真实登录或服务端压缩后的跨账号推理通过。

## Why

operator 2026-09-24 原话：

- 09:28Z（msg `private-source-id`）：「其实我们缺了个能力，就是凭证轮转……如果可以让我在前端 UI 选择操作轮转到正常账号，好像体验也会好点，就不用一直在 codex 的 app 登入退出了；同理 claude code 的公司账号也可以和个人账号这样隔离，避免每天我都在登入登出」
- 09:35Z（msg `private-source-id`）：「现在的 oauth 只能支持一个，但是按道理我们应该支持多个，然后支持比如Ragdoll一键切换成 oauth 1、2、3。这样社区小伙伴就能在白天的时候用公司账号，晚上下班的时候直接一键把全部Ragdoll、Maine Coon切换成别的账号（私人）」；同一条消息的引用批注：「会有公司的账号和自己的账号，可能需要公司的项目用公司的账号，自己的项目用自己的账号，我觉得这个可以立项」

价值：用猫咖的人往往同时有公司账号和私人账号。立项时每家厂商只能挂一个 OAuth 登录，切换就得在 Codex App / Claude Code 里退出再登录，每天来回好几次，还容易把公司项目跑在私人账号上（反过来也一样）。这个 feature 让多个账号同时登录着、相互隔离，切换只是在猫咖里点一下，并且让「这个项目用哪个账号」成为可以设定的规则，而不是靠人记着去切。

## Current State / 现状基线

以下单例与 consumer 描述保留 2026-09-24 的立项基线；已交付、已获真人认可的结果与剩余边界见顶部 Codex / Claude 当前状态，不能把旧基线当成当前仍无实现，也不能把未覆盖的范围当成已经验收。

- **OAuth 账号是写死的单例**：`packages/shared/src/types/client-routing.ts` 的 `BUILTIN_ACCOUNT_IDS` 给每个厂商家族固定分配一个 id（anthropic→`claude`、openai→`codex`、google→`gemini`、kimi→`kimi`、opencode→`opencode`）；Hub 账号页每个厂商只显示一个 OAuth 条目（operator 09:35Z 截图 `uploads/1790242529590-22b5542a.png`：Claude / Codex / Gemini / OpenCode 各一条）。
- **登录状态存在工具自己的目录里，由环境变量决定**：Codex 用 `CODEX_HOME`（默认 `~/.codex`），Claude Code 用 `CLAUDE_CONFIG_DIR`。实测（opus55，2026-09-24）：`CODEX_HOME` 指向另一个目录后可以登录另一个账号，互不影响（F319 账号对照实验，`~/.codex-probe-flagged`）；`CLAUDE_CONFIG_DIR` 指向空目录时 `claude auth status` = `loggedIn: false`，默认目录仍是 `loggedIn: true`。
- **底层管线已经有一半**：
  - 账号条目有 `envVars` 字段（F171；`AccountConfig` in `packages/shared/src/types/cat-breed.ts`），oauth 账号同样生效，在子进程环境里最后注入（`invoke-single-cat.ts` 的 `accountEnv`，`CodexAgentService.ts` 约 1958 行）。
  - Codex app-server 暖池 host 的复用签名包含启动环境（`CodexUnixWebSocketSession.ts` `prepareCodexHostLaunch` 对 env 做 sha256）→ `CODEX_HOME` 不同的猫天然落在不同的 host 上。
  - 创建/修改账号的接口接受 `envVars`（`packages/api/src/routes/accounts.ts`）。
- **还假设「只有一个 home」的读取方**（需要在 Design Gate 做完整 consumer census，此处是初步 grep）：`routes/quota.ts:1142`（额度只读 `CODEX_HOME/auth.json`）、`codex-session-context-snapshot.ts:131`（会话根目录）、`codex-image-scanner.ts:24`、`collective-codex-home.ts:11`、Claude bg carrier 的 `CLAUDE_CONFIG_DIR` 处理（`claude-bg-job-ownership.ts`）。
- **没有任何架构 cell 声明拥有账号解析**（`docs/architecture/ownership/cells/` 里没有 `accounts.json` / `account-resolver` / `accountRef` 的归属）。

## What

> 以下 Phase 划分是立项时的提案，Design Gate 可以调整。

### Phase A: 多个 OAuth 账号成为一等公民

- 同一厂商家族可以有多个 OAuth 账号，每个账号有自己的**登录目录**（Codex → `CODEX_HOME`，Claude → `CLAUDE_CONFIG_DIR`）；登录目录是账号上正式的字段，不需要用户手写 `envVars`。
- 账号页显示每个账号的登录状态（已登录 / 未登录 / 过期），并提供「登录」入口：猫咖唤起终端，在该账号的登录目录执行官方登录；用户不用手动打开终端或输入命令。
- 创建账号时即可自定义备注（展示名称），创建后可修改；与官方身份分开展示，登录或重试不覆盖用户填写的备注。
- 现有的内置 `claude` / `codex` 账号平滑迁移成「OAuth 1」，继续指向默认目录；迁移后现有行为不变。
- 额度显示等读取方按账号区分（见 Current State 列出的读取方）。

### Phase B: 按家族一键换绑

- 在一个地方把某个家族（Ragdoll / Maine Coon / …）的全部猫，或者单只猫，换绑到指定的 OAuth 账号。
- 换绑从下一次调用开始生效；正在进行的调用在原账号上跑完，不会中途换号。
- 界面上随时看得到每只猫当前用的是哪个账号（例如成员列表或回复底栏）。
- 会话连续性：**换账号后必须能续上原来的会话**，行为要和今天在同一个 `~/.codex` 里手动退出再登录一样。做法是只按账号隔离「凭证」，「会话记录」所有账号共用（见 KD-3）。

### Phase C: 按项目自动选用账号

- 给项目（projectPath / workspace）设一个默认账号：公司项目自动走公司号，私人项目自动走私人号。
- 优先级需要在 Design Gate 定清楚：项目规则 / 家族换绑 / 单猫绑定 三者冲突时听谁的（见 OQ-3）。

## User Journey

### Primary Journey: 填备注、官方登录，保留两个账号并换绑续聊
- **Scope unit**: workspace
- **Actor**: operator / 社区用户（同时有公司号和私人号）
- **Entry**: Hub 设置 → 账号
- **Flow**:
  1. 点「新建 Codex 账号」，填写备注「公司」并提交；不用手动打开终端或输入命令。
  2. 猫咖唤起终端，在这个账号的独立 `CODEX_HOME` 执行官方 `codex login`。由 CLI 自己按原生方式打开浏览器，猫咖不选择、记录或切换 Chrome profile/窗口。
  3. 用户在官方页面选择/确认账号并完成授权；回到猫咖可见「公司」已登录，官方身份与自己填写的备注分开显示。
  4. 同样添加「私人」；公司号和默认账号保持原登录，两个账号以后都能直接选择。运行时只选择对应 accountRef/登录目录，不依赖浏览器是否仍打开。
  5. 刷新页面、重启服务后，两条账号、备注和登录仍在；改备注不改变账号或凭据目录。
  6. 清楚看到 Codex 当前使用的账号及全体本地成员的跟随关系；需要时一次切换为「私人」，后续调用共同使用它，正在执行的调用仍用原账号。正常路径不要求逐猫选择。
  7. 回到同一聊天继续发消息，下一次调用使用私人号并显示实际执行账号；切回公司号还能续聊，不要求退出或重新登录。另以服务端已压缩的会话验证相同结果。
- **Success evidence**: 默认 Hub 新建动作确实唤起终端，官方命令消费所建账号目录；用户亲自授权后，两账号状态/备注持久且各自调用与额度归属正确，普通和服务端压缩后可续聊。隔离命令 fixture 只证明接线与隔离，不能代替真人授权；不再把 Chrome 窗口测试列为交付证据。
- **Non-goals**: 自动轮换（见 KD-1）；绕开厂商限制或组织策略；展示 token 明文；读取、记录、选择或操纵 Chrome profile/窗口/Cookie；代用户授权；通过账号功能安装/更新/发布猫咖或 Codex。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | workspace | operator | 项目设置里给「公司项目」绑定公司账号 → 在该项目的 thread 里 @ 猫 → 自动走公司号；换到私人项目的 thread → 自动走私人号 | 浏览器旅程 + 两个 thread 回复的账号标识 |
| S2 | message | 其他猫 | 读历史时能看到某条回复是哪个账号跑的（为排查限流、额度归属留痕） | prompt / get_thread_context 输出样例 |

## 需求点 Checklist

| # | 需求点 | 来源 | AC |
|---|--------|------|----|
| R1 | 同一厂商可以同时登录多个 OAuth 账号，互相隔离 | operator 09:35Z「oauth 只能支持一个，按道理应该支持多个」 | AC-A1, AC-A2 |
| R2 | 在前端界面里完成切换，不用去 Codex App / Claude Code 里退出登录 | operator 09:28Z | AC-A3, AC-B1 |
| R3 | 一键把整个家族（Ragdoll、Maine Coon）切到指定账号 | operator 09:35Z「一键把全部Ragdoll、Maine Coon切换」 | AC-B1, AC-B2 |
| R4 | Claude Code 公司号与个人号同样可以隔离 | operator 09:28Z | AC-A1 |
| R5 | 公司项目用公司账号、私人项目用私人账号 | operator 09:35Z 引用批注 | AC-C1 |
| R6 | 不做「被限流就自动切下一个账号」 | operator 09:35Z 引用批注「对，我们不要做这个」 | KD-1, AC-B4 |
| R7 | 创建账号时即可自定义备注，创建后可修改并持久保留 | operator 2026-10-06，`private-source-id` | AC-A5 |
| R8 | 新建后唤起终端执行官方 `codex login`，浏览器行为全部交官方 CLI；猫咖不实现 Chrome 脚本 | 原需求 `private-source-id`；最新纠正 `private-source-id` | AC-A3, AC-A6 |
| R9 | 登录一次即可长期沿用；新建账号不携带安装/发布/迁移流程 | 同上；原接续问题 `private-source-id` | AC-A7, AC-A8 |

## Acceptance Criteria

下列复合 AC 保留原范围，未勾选不代表其中每一部分都没验过。AC-A4 的 Codex 日常额度体验已获 10-23 human1130 认可；其完整 consumer census 与其他厂商范围未据此一并结算。人工换绑与 B 上压缩后续聊已有顶部所列真实证据，AC-B5 的完整 A→B→A 仍开放。本轮不重定义 AC、不新增自动轮换项。

### Phase A（多个 OAuth 账号成为一等公民）
- [ ] AC-A1: 同一厂商家族（至少 Codex 与 Claude）可以同时存在 ≥2 个 OAuth 账号，每个账号有独立的登录目录；两个账号同时保持登录，互不影响（非作者可按账号页 + `codex login status` / `claude auth status` 复核）
- [ ] AC-A2: 现有安装升级后，原内置 `codex` / `claude` 账号成为第一个 OAuth 账号，所有已绑定的猫行为不变（升级前后同一只猫的调用走同一个登录目录）
- [ ] AC-A3: 账号页新建/登录操作唤起终端，在所选账号目录执行官方 `codex login`；由 CLI 自己打开浏览器，用户亲自授权。完成后猫咖读回该账号的官方登录结果与身份，备注保持；取消/失败可在原条目重试，不能把终端已打开或 auth 文件存在当登录成功。全过程不展示或记录 token 明文
- [ ] AC-A4: 额度显示等原本只读单一 home 的读取方，按账号显示各自的数据（consumer census 列出的每一处都有归属）
- [ ] AC-A5: 创建表单在授权前支持自定义账号备注；创建、登录/重试、重载后备注仍保留，创建后可修改，账号列表和换绑选择器一致展示。备注独立于官方身份；改备注不触发换号、迁目录或改写历史执行归属
- [ ] AC-A6（本轮 Codex）: 新建后终端准备好已安装的官方 `codex login` 命令，可直接执行或由用户按回车；`CODEX_HOME` 指向本次账号的受管目录，备注不进入 shell 命令，默认账号和其他账号目录不被替换。产品没有 Chrome profile/PID/窗口捕获、持久化、置前或 URL 打开脚本。浏览器选择和授权页面由官方 CLI/系统原生流程负责，不新增猫咖保证
- [ ] AC-A7（本轮 Codex）: 同一持久账号归属下首次登录后，刷新、正常服务重启及代码 checkout 更新仍认识同一个 accountRef/备注/凭据目录，不因环境切换再次要求授权；不复制 token 或迁移默认 home。厂商主动撤销/登录过期按官方认证生命周期处理，不承诺永久免登录
- [ ] AC-A8（本轮 Codex）: 新建账号不执行安装依赖、构建、Git 更新、runtime 停启或账号跨环境搬迁；完整账号旅程不依赖 F320 专用发布/维护/回滚控制器
- [ ] AC-A9（本轮返修）: 账号页只有一套添加入口和账号列表；Codex OAuth 从该入口进入终端登录，失败/超时后原条目有可用恢复操作，未登录状态与额度/换绑动作一致；成功后可沿原入口绑定使用。source442 的用户实测接续不被长轮 Alpha 阻塞
- [ ] AC-A10（10-10 纠正）: 首屏明确区分当前使用、已登录备选和未登录账号；一次当前账号切换作用于全体本地 Codex 猫，正常路径不出现逐猫选择。成员/绑定读取与正式 runtime 同源，workspace 与 runtime 分离时也不能出现旧成员表。账号页及 v2 成员行按原设计负责人整屏/状态稿接入，字号、控件和信息层级一致

### Phase B（按家族一键换绑）
- [ ] AC-B1: 一次操作把某个家族的全部猫换绑到指定账号；下一次调用即走新账号（可从子进程环境 / host 签名 / 回复上的账号标识复核）
- [ ] AC-B2: 正在进行的调用不受换绑影响，在原账号上跑完
- [ ] AC-B3: 界面上能看出每只猫当前用的账号，回复上留有「本条由哪个账号跑」的记录
- [ ] AC-B4: 系统不会在没有人操作的情况下自己换账号（没有基于限流 / 错误的自动轮换代码路径）
- [ ] AC-B5（本轮 Codex）: 普通会话与服务端已压缩会话都能 A→B→A 继续同一会话；历史回复/usage 保留实际执行账号，当前绑定与在途账号分别显示。模拟压缩或仅能读取 JSONL 不能算真实续聊通过

### Phase C（按项目自动选用账号）
- [ ] AC-C1: 给项目设定默认账号后，该项目 thread 里的调用自动走对应账号；与家族换绑、单猫绑定冲突时，按 Design Gate 定下的优先级执行，并且界面能看出是哪条规则生效

## Dependencies

- **Evolved from**: F062（Ragdoll账号配置中枢：订阅 / 赞助 API 两通道切换；KD-1 首版只做Ragdoll）
- **Related**: F136（统一配置热更新 / 账号底座，clowder-ai#340）；F171（账号 `envVars` 注入）；F291（Codex OAuth 速度档位，按账号类型判断）；F318（Claude Agent SDK carrier 的 OAuth 登录）；F319（账号对照实验中验证了 `CODEX_HOME` 隔离）

## Risk

| 风险 | 缓解 |
|------|------|
| 换账号后原会话续不上 | KD-3：凭证按账号隔离、会话记录共用（Codex 跨账号续会话已实测通过）；残余风险见 OQ-2 |
| 公司代码跑在私人账号上（或反过来），有合规风险 | Phase C 按项目绑定 + 界面上随时可见当前账号；换绑需要明确操作 |
| 还有读取方默认只看 `~/.codex` / `~/.claude`，换号后显示或行为错乱 | Design Gate 做 code-derived consumer census（F303），每一处都要有归属 |
| 登录目录里存着凭证 | 只存路径不存 token；目录不进仓库、不上传、不在 UI 显示内容 |
| Gemini / Kimi / OpenCode 的隔离方式未知 | OQ-4；Phase A 先覆盖 Codex 与 Claude |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不做自动轮换：不会因为限流或报错自动换到下一个账号，换账号永远是人的明确操作 | 自动轮换本质是在绕开厂商对单个账号的限制；operator 09:35Z「对，我们不要做这个」 | 2026-09-24 |
| KD-3 | 只按账号隔离凭证，会话记录所有账号共用 | operator 09:4xZ 指出：今天手动退出/登录能续上会话，是因为只换了凭证、会话记录留在原地；做不到续会话，F320 就没有意义。**实测（opus55，2026-09-24 09:51Z）**：正常账号开会话并记下暗号，把这一个会话文件复制到异常账号目录的同一相对路径，用异常账号 `codex exec resume <id>` 续上，正确答出暗号，无报错；测试文件用后已删 | 2026-09-24 |
| KD-2 | 用各工具官方支持的登录目录环境变量（`CODEX_HOME` / `CLAUDE_CONFIG_DIR`）隔离账号，不复制 token、不加代理 | 用的是工具本身支持的能力，凭证始终留在工具自己的目录里 | 2026-09-24 |
| KD-4 | 新增账号采用备注→终端执行官方 `codex login`→用户授权→独立持久登录；浏览器完全归官方原生流程。撤出 F320 专用自动发布、迁移前置和 Chrome 自动化，复用正常部署 | source2335/116 接受原生体验，source357 纠正 Astra 自加的 profile 保证；原 Phase B 结果仍保留 | 2026-10-08 |
| KD-5 | 托管账号与 F306 只读统计不再写死 Codex 版本号（原为 `codex-cli 0.159.0`）。每个新版本第一次被用到时，家里在临时目录里自动跑一遍无凭据实测（托管账号：私有登录不借宿主登录、单写者锁、跨账号续聊/目标/记忆、共享 SQLite、配置写入与端点/sqlite_home 语义；只读：能读、拦写、拦本机网络），结果按版本记在 `<数据目录>/codex-native-compat/`，过了就接上，不过就只拦这一项能力并写明哪一项没过。原「启动前不让新认证开关漏进来」的意图改由环境变量白名单承担：托管 OAuth 启动和终端登录里，`CODEX_*`/`OPENAI_*` 只保留家里自己设置的字段。平台、托管策略（managed_config/requirements/CFPreferences forced）和同一原生 carrier 检查不变 | You 10-24 21:53 PDT 在终端升级到 0.164.0 后全部托管Maine Coon报 `codex_managed_version_unsupported`；他要求「terminal 升级 codex，家里不能炸，也要跟着升级」，并在 `[thread-id]` 拍板「直接修，修好请Siamese审，合入」。0.164.0 实测通过，唯一差异是 provider 多出值为 null 的 `capabilities` 字段，已按“未设置”放行 | 2026-10-24 |

## Tips Contribution（F244）

计划新增 1–2 条 tips：①「公司号和私人号可以同时登录，在账号页一键换绑」→ 指向本 feature 的账号页入口；②「项目可以绑定默认账号」（Phase C 完成后）。

## Review Gate

- Design Gate：前端 UI/UX（账号页、换绑入口、账号标识）→ operator在真实 Hub 壳里确认；后端 / 架构（账号模型、consumer census、会话连续性）→ 跨家族猫讨论后operator拍板。
- 实现 review：默认一个合格的非作者来源，覆盖该改动的行为与安全风险；不按族别加派，不因出现 auth 就自动叠第二位。只有现有来源无法覆盖的具体证据缺口才考虑增加，并先说明缺口。本次已完成的两份批准保留，合入前不另加派或机械续审。
- 纠正与归因：You `private-source-id` 明确反对无必要的双审/按族别加派。Astra 承担安排责任：把“语义/安全是两个风险面”直接等同“两位常驻 reviewer”，又保留了本页“另外做一次”的无条件条款，没有先判断一个合格来源能否覆盖。错误例是固定双路；正确例是一个来源覆盖真实风险；分界是具体覆盖缺口而不是风险标签或猫族。当前条款与计划中的双路续审指令已收口为历史，不另建审批或实验。
