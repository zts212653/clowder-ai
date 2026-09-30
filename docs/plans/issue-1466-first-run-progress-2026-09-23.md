---
feature_ids: [F171, F155, F229]
topics: [onboarding, cli-auth, desktop-installer, handoff, acceptance-review]
doc_kind: implementation-progress
created: 2026-09-23
updated: 2026-09-24
---

# Issue #1466 首启旅程：进展验收、PR 关系与后续收口计划

> 2026-09-23 验收快照基于 `d1b710b63`；文末附有作者针对 R1/R2 的后续修复记录。快照中的“本轮”仅指当时的只读验收，不代表后续修复状态。
>
> 验收基线：本地及 PR #1519 当前 HEAD `d1b710b635e516faae8b38f1552fccfc0332b19b`。主要行为测试在前一提交 `f5cdd7c2d793d6994fc74408ed89e0326007c98c` 上复跑；两者之间是 8 个文件的格式/导入排序调整，未发现改变下列结论的逻辑修改。GitHub 状态为查询时快照，后续以对应 SHA 的实际结果为准。
>
> **2026-09-24 更新**：前述“当前 HEAD”“CI 正在运行”均为 2026-09-23 历史快照。PR #1519 随后推进至 `dff40e41a6722cb87d0fdf875a6c5e3a1fb6fe73`，该 SHA 的 GitHub Lint、Build、Public test 分片、合同检查和 Windows 检查均已完成且通过。R1/R2 修复状态见第 11 节；新增录屏与 R6 状态见第 7.2 节。其余产品旅程未因此验收通过。

## 1. 本次验收结论

**整体验收不通过；认证探测这一局部改动通过定向验证，不能据此声明“文档所有内容已完成”。**

进展符合 #1466 的方向：读取 CLI 自有配置、避免重复填 key、保持 pending 门禁、恢复多客户端配置、复用 F155，都是合理的深化。当前主要问题是探测、连接测试和真实调用之间仍有契约断层，且原始产品旅程尚未全部实现。

- **已确认进展**：当前 Codex provider 的 TOML 凭证存在性探测、未选中 provider 的负例、探测响应不携带凭证、认证错误提示、部分恢复和非阻塞引导。
- **关键阻塞**：Codex 自定义 provider 被投影为 OAuth，真实调用覆盖为 OpenAI provider；连接测试错误返回仍可回显 URL 中的凭证。
- **其他实现缺口**：环境 key 用户在空账号库中无法直接继续、成员/线程创建缺幂等、F155 提示的刷新和线程归属不稳定。
- **产品缺口**：三猫动态分镜、拉起原生登录、官方安装入口、F229 身份交接、真实首次对话验收和品牌资产尚未闭环。
- **交付进展**：#1519 已解除冲突并更新远端；不能继续沿用“未推送、CONFLICTING、无 CI”的旧结论。新 HEAD 的 CI 正在验证，不能提前写成全绿。

本文件是本轮验收意见与证据台账，不是 GitHub 正式批准。先前非作者只读复核覆盖了环境 key、F155 和创建恢复问题；新增 provider/错误回显问题来自本轮调用链核验及模拟探针，不冒充已经获得独立批准。

## 2. 当前事实与版本快照

| 对象 | 当前事实 |
| --- | --- |
| 产品需求 | [Issue #1466](https://github.com/zts212653/clowder-ai/issues/1466)，OPEN |
| 首启实现 PR | [#1519](https://github.com/zts212653/clowder-ai/pull/1519)，OPEN；标题为 “feat: advance first-run onboarding and CLI auth recovery” |
| 当前关联方式 | 正文为 `Refs #1466`；GitHub `closingIssuesReferences=[]`。旧正文曾为 `Closes #1466`，不能沿用旧描述 |
| 本地/远端 HEAD | 均为 `d1b710b635e516faae8b38f1552fccfc0332b19b` |
| PR 可合并性 | `MERGEABLE`；查询时 `mergeStateStatus=BLOCKED`。无文本冲突不代表满足合入条件 |
| 当前工作分支 | `feat/onboarding-first-run` |
| 当前 worktree | `G:\AIwork\clowder-ai\worktrees\feat-onboarding-first-run` |
| 上一行为提交 | `f5cdd7c2d`：首启恢复与 Codex 原生配置识别 |
| 最新格式提交 | `d1b710b63`：修正 8 文件格式与导入排序；本轮只读 Biome 检查 8/8 文件通过 |
| 验收期间并发变更 | 上述提交、推送、PR 正文及回复更新由另一会话完成，本轮未执行这些操作 |
| 本轮落盘范围 | 仅本进展文档；不暂存、不提交 |
| 工作区额外内容 | 存在 `packages/web/.next-test-onboarding*` 和对应临时 tsconfig 等未跟踪产物；验收期间还出现评论修复草稿，均不属于本轮交付 |

CI 快照（2026-09-23 09:52:12 UTC）：

- `f5cdd7c2d` 的 [CI 35844290599](https://github.com/zts212653/clowder-ai/actions/runs/35844290599) 中，Lint 失败：8 个文件共 9 条格式/导入排序错误；Build、Public test plan、Public contract surfaces、Directory Size Guard 已成功。不能用“4 个定向文件 Biome 通过”概括全 PR。
- `d1b710b63` 的 [CI 35844833630](https://github.com/zts212653/clowder-ai/actions/runs/35844833630) 查询时 Build、Public test plan、Public contract surfaces、Directory Size Guard、Public test (serial-shared) 成功；Lint 和 6 个 distributable 分片仍在运行，serial bootstrap 为预期 skip。
- [Windows Smoke 35844833724](https://github.com/zts212653/clowder-ai/actions/runs/35844833724) 已成功；此检查不等同于本 HEAD 的桌面安装器与首启体验验收。
- 以上是两个不同 SHA 的结果；旧失败不能直接判作新 HEAD 失败，新提交也不能自动抹去尚未验证的部分。

## 3. #1466、#1452 与 #1519 的关系

### 3.1 #1466 定义用户旅程

原始 Issue 要求脚本演示使用真实产品组件，三猫有动作、自动输入、互相 @ 和讲解；随后探测用户真实客户端及登录态，每个客户端配置一位成员，进入真实主界面，交接 F229，并通过 F155 非阻塞提醒成员/密钥入口。还要求统一应用/Web/主站图标和设计 DMG 背景。

Issue 明确写道：**“#1459（桌面一键安装加固）：安装产物正确性不在本 issue 范围。”** 之前文档把新 Windows 安装器写成 #1466 原始必需范围，表述过宽，本次纠正。此前进展文档记录的 Windows 安装器交付目标可以继续作为会话层额外交付项，但应单独验收。

### 3.2 #1519 是当前首启实现

该 PR 的分支就是本次验收的 `feat/onboarding-first-run`。你基于 #1519 继续落实 #1466 是正确的，没有换错工作线。

当前 PR 正文也已诚实列出三猫分镜/F229、幂等、真实 CLI E2E、安装器仍待完成；这与“所有文档内容已完成”的说法不同。正文从 `Closes` 调整为 `Refs` 与进行中状态一致。

### 3.3 #1452 是独立桌面安装加固线

[#1452](https://github.com/zts212653/clowder-ai/pull/1452)：

- 分支 `feat/desktop-install-hardening`，HEAD `a7558e0453070429651206ef773763cd415ad245`；
- 本次查询为 OPEN、MERGEABLE，无 closing issue reference；
- 正文关联 umbrella [#1459](https://github.com/zts212653/clowder-ai/issues/1459)；
- 处理构建产物架构、Redis 归属、动态端口、只读安装目录、退出顺序和安装/运行时 smoke。

| 问题 | 归属 |
| --- | --- |
| 本机客户端探测、首启配置、演示、真实首消息和 F155 | #1466 / #1519 |
| 安装器产物正确性与桌面运行可靠性 | #1459 / #1452 |
| 用户完整安装后体验 | 两条工作线的集成验收，需分别记录源码与产物来源 |
| 是否重开首启 PR | 无此必要；维护者已要求维护现有 #1519 |

两者不是前后两个版本，也不能用一条线的测试替另一条线验收。品牌/DMG 视觉仍是 #1466 范围，不因安装加固独立而自动移出。

## 4. 对本次六项实现声明的验收

| 声明 | 结论与边界 |
| --- | --- |
| 读取用户 Codex config.toml 当前 model_provider | 通过局部验收。优先 `CODEX_HOME`，否则使用运行进程的 home/.codex；Windows 默认 home 对应用户目录 |
| 识别当前 provider 的 base_url + experimental_bearer_token | 通过存在性判断。两项都要求非空；不验证 URL 可达性、token 有效性或真实运行身份 |
| 不使用 codex login status 判断 | 首启检测实现已符合；检测函数只读文件，不启动 CLI、不联网 |
| 未选中 provider 不误报认证成功 | 针对无其他认证来源的 fixture 负例通过；不能扩大为所有多凭证组合已覆盖 |
| API 响应不会泄漏 URL 凭证或 token | **仅 available-clients 检测响应得到证明；整个首启 API 声明不成立**，见 R2 |
| 连接提示覆盖 OAuth 和 URL＋Key | 已实现；正确提示不能证明两条认证路径在真实调用时等价可用 |

“检测到凭证”只是状态输入，真正的首启成功至少还要满足：同一 provider/身份完成连接测试、成员绑定及真实调用；失败时不得假装完成。

## 5. 本轮具体发现

### R1 — P1：Codex 自定义 provider 在真实调用时被覆盖

**触发条件**：空 Clowder 账号库；Codex 原生 `config.toml` 当前 provider 配置 URL＋bearer；选择首启生成的本机身份。

证据链：

1. [client-auth.ts](../../packages/api/src/domains/cats/services/first-run-quest/client-auth.ts) 第 32、60 行起把该形态返回为 `authenticated=true, hasApiKey=false`。
2. [FirstRunQuestWizard.tsx](../../packages/web/src/components/FirstRunQuestWizard.tsx) 第 304 行把此组合当成 `detectedOAuth`。
3. [native-profile.ts](../../packages/web/src/components/first-run-quest/native-profile.ts) 第 24 行起生成 `codex` builtin、`authType=oauth`、`mode=subscription`。
4. [account-resolver.ts](../../packages/api/src/config/account-resolver.ts) 第 147 行起将空账号库的 builtin ref 解析为 OAuth，没有自定义 baseUrl。
5. [invoke-single-cat.ts](../../packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts) 第 2946 行起设置 `CODEX_AUTH_MODE=oauth`。
6. [CodexAgentService.ts](../../packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts) 第 1595、1623 行起，在没有注入 customBaseUrl 时加入 `--config model_provider="openai"`；HTTPS 回退也选择 OpenAI provider。
7. [first-run-quest.ts](../../packages/api/src/routes/first-run-quest.ts) 第 82、418 行起的连接探针仅执行 `codex exec … reply pong`，没有同样的 provider 覆盖。

**复现结果**：临时 CODEX_HOME 内放置假 provider 配置，给真实 CodexAgentService 注入模拟 spawn，捕获到 `model_provider="openai"`。没有调用真实 CLI/模型，没有使用用户密钥。

**影响**：连接测试可能成功，而第一条真实对话改走 OpenAI；没有 OpenAI OAuth 的用户可能失败，有 OAuth 的用户可能使用了另一认证/计费目标。此为确定的调用参数不一致，实际外部服务结果仍未做联网验证。

**收口要求**：区分“本机配置继承”和“显式 OAuth 账号”，让探测、连接测试和真实调用消费一致的身份语义。不能简单删除既有 OAuth provider 约束而破坏显式 OAuth 账号。需同时覆盖 exec/app-server、OAuth/custom provider、混合配置和失败路径。

### R2 — P1：连接测试错误消息仍可回显凭证

[first-run-quest.ts](../../packages/api/src/routes/first-run-quest.ts) 第 187、204、275、293 行附近直接把 CLI stdout/error 截断后放进返回消息，截断不是脱敏。

模拟 spawn 输出：

```text
Error https://u:FAKE_REVIEW_SECRET@review.invalid/?key=FAKE_REVIEW_TOKEN
```

返回的 `message` 原样保留上述假 URL 用户信息和查询参数。连接路由会直接返回该探针结果。

这是既有错误转发路径上的问题，不声称本次 TOML 解析新增了泄漏；但它足以否定“所有首启 API 不会泄漏 URL 凭证/token”的宽泛声明。实际是否出现秘密取决于 CLI 输出，本轮未发现或使用任何真实泄漏样本。

**收口要求**：错误返回使用稳定的安全文案/结构化错误码；需要诊断信息时先脱敏，再截断。用假 URL userinfo、query key/token、Authorization/bearer 等异常输出验证客户端响应与日志边界。

### R3 — P2：环境 key 用户在空账号库中仍被配置页卡住

`detectClientAuth` 对环境 key 返回 `hasApiKey=true, authenticated=true`，列表可进入 ready；但 Wizard 第 304 行排除了 `hasApiKey`，因此不会投影 native profile。空 `/api/accounts` 的 [ConfigStep.tsx](../../packages/web/src/components/first-run-quest/ConfigStep.tsx) 没有可选账号，用户仍需新建账号认证。

这不符合已认证客户端最短路径。不能只把这类用户也伪装成 OAuth：Codex OAuth 运行路径会主动剥离继承的 API key，需要明确环境认证的账号语义和运行注入策略。

### R4 — P2：创建成功但响应丢失后，恢复不能对账

[FirstRunQuestWizard.tsx](../../packages/web/src/components/FirstRunQuestWizard.tsx)：

- 第 59、85、109 行附近会重置内存中的 `createdCatsRef`；
- 第 133 行使用 `Date.now()` 生成成员 ID；
- 第 207 行起 POST `/api/threads` 没有稳定首启请求标识。

多成员创建部分成功、线程已创建但响应丢失、刷新/关闭再打开时，客户端无法找回已创建结果。可能出现重复成员/线程，或因同名 mention 冲突卡住；同一打开期间 ref 去重不能解决跨刷新或响应丢失。

**收口要求**：稳定 journey/member/thread 请求身份，服务端幂等/查询对账；验证响应丢失、部分成功、刷新及并发重试。同一请求重复执行应返回同一结果。

### R5 — P2：F155 提示缺少持久恢复与线程归属约束

[ChatContainer.tsx](../../packages/web/src/components/ChatContainer.tsx) 第 196 行将 `showOnboardingHint` 存在内存；第 524 行起用当前 `threadId` 启动 flow；第 802 行在导航后置 true，未从保存的 onboarding thread 推导启动资格。

刷新后提示可能消失；若组件保持挂载并换到其他线程，提示可能在错误线程启动。具体 UI 生命周期仍需浏览器验证。

**已存在的正确边界**：第 808 行起的真实消息完成 handler 已检查保存的 journey.threadId，不能误报为“任何线程的消息都会完成首启”。这里的问题是提示启动/恢复，和完成回调是两条路径。

### R6 — P2：认证新增测试没有接入常规 Public test 文件发现

`packages/api/test/first-run-auth.test.ts` 6 项能单独运行，但 [resolve-public-test-files.mjs](../../packages/api/scripts/resolve-public-test-files.mjs) 第 62 行仅收集 `.test.js`；[plan-public-test-shards.mjs](../../packages/api/scripts/plan-public-test-shards.mjs) 第 19 行也要求此后缀。未找到工作流对该 TS 文件的显式调用。

因此“本地 6/6 通过”不等于这 6 项会随 CI 运行。部分检测响应行为由 JS 路由测试覆盖，但不能替代完整认证 fixture 集合。需将其接入可追溯的自动测试入口。

## 6. 对照完整旅程的完成度

| 验收项 | 当前实现与判断 |
| --- | --- |
| 三猫出场/闲置、自动输入、钻入气泡、互相 @ | [DemoStep.tsx](../../packages/web/src/components/first-run-quest/DemoStep.tsx) 是静态爪印/名字卡和文本；手动“下一幕”，没有真实消息组件动作。**未完成** |
| 初稿 → 同伴反馈 → 改稿 | 脚本内容已有；动态展现和真实组件验收仍缺 |
| 演示暂停、继续、刷新恢复 | 场景状态可恢复；目前暂停只是阻止手动推进，不是动作时间线暂停验收 |
| 0 个客户端 | 有未安装提示和重新检测；[ClientStep.tsx](../../packages/web/src/components/first-run-quest/ClientStep.tsx) 第 123 行附近无官方安装入口 |
| 未登录客户端 | 第 102 行 startLogin 仅设 pending；第 180 行附近要求用户手动运行终端。重新探测出口有进展，**尚未拉起 CLI 原生登录** |
| 1 个/多个已认证客户端 | OAuth synthetic profile、多配置恢复、唯一别名已有；R1/R3/R4 未闭环 |
| 不把示范成员当真 | 已明确“演示结束后创建真实团队”；单客户端能力诚实说明仍需实际界面验收 |
| 解说猫交接 F229 | 没有真实成员 ID 与 F229 常驻前台身份一致的验收证据 |
| 默认钉选 members/accounts | 已实现且保留用户主动取消；需新安装界面验证 |
| F155 非阻塞提醒 | flow、入口说明和 nonBlocking 已补；R5 未闭环 |
| 首条真实消息后完成 | 已有发送成功回调和线程匹配；真实 API/CLI 成功与失败、刷新后状态持久的完整证据仍缺 |
| 真正空安装自动入口 | ChatContainer 第 461 行 `storeThreads.length===0` 提前返回；上层是否先创建线程尚需完整启动路径验证，暂列待核实，不能只凭该行判必然失败 |
| 任意阶段退出可继续 | 配置草稿/选择恢复已有；创建阶段不能可靠对账，见 R4 |
| 应用/Web/主站图标、DMG 视觉 | 本轮未逐项验收，不标已完成 |
| Windows 安装器（额外交付） | 没有本 HEAD 安装器证据；旧 `desktop/dist/win-unpacked/Clowder AI.exe` 是主程序，不是 Inno Setup 安装器 |

没有产品方向跑偏，但若继续用单测数量替代这张表里的实际行为，就会形成完成度误判。首条消息“发送成功”与“模型返回成功”应分别记录；原始 Issue 强调发出第一句话和效果可兑现，不应在没有约定时混成同一个信号。

## 7. PR #1519 意见纳入情况

已读取 #1519 当前可见的普通评论、作者回复、正式 review 与 review thread；当前没有正式 review verdict，也没有行内 review thread。下面按评论来源记录实际处理状态：

| 来源 | 原始意见 | 当前处置 |
| --- | --- | --- |
| [维护者分诊 5771522887](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5771522887) | 保留原 Issue/PR，刷新 main，证据可复现，pending/first-real-message 门禁明确 | 已更新同一 PR、解除冲突、CI 启动；真实旅程和完整验证仍未完成 |
| [设计复核 5771560224](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5771560224) | 探测原生 OAuth；pending 有真实出口；未安装单独状态；解释两个 rail 入口 | 已补本机凭证读取、pending 重探测、not_installed、F155 rail 说明；原生登录动作、身份一致性和 R5 仍未闭环 |
| [CI 复核 5771627992](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5771627992) | 空 checks 不等于绿色 | 原则仍成立；事实已从“冲突导致没有检查”推进到“新提交正在跑 CI”，旧 HEAD 曾有真实 Lint 失败 |
| [作者回复 5792543123](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5792543123)、[5792545336](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5792545336)、[5792547371](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5792547371) | 更新实现及验证说明 | 本轮读取 GitHub API 时三条正文已保存为乱码；已告知用户，用户负责修正，本轮不编辑公开评论 |
| [设计复核 5792611285](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5792611285) | 认可首启原生认证、Codex 当前 provider、pending/not_installed、F155 non-blocking 的修复；指出 Kimi/OpenCode 原生登录态仍未覆盖；确认三条作者回复发生过编码损坏；强调该评论不是正式批准 | Kimi/OpenCode 已登记为 R7/P2 覆盖缺口；评论乱码已由用户处理；本轮不把 advisory 复核当作合入批准 |
| [维护者新要求 5793905290](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5793905290) | 要求提交当前实现的屏幕演示并贴回 PR，标明 commit SHA、运行环境及脚本/mock API/真实 CLI/模型边界；主路径需连续展示三猫演示、已登录 CLI 探测、真实成员/线程创建、F229 前台猫交接、首句及真实模型回应；另需一段恢复场景录屏；幂等、环境 key 空账号库、F155 刷新/线程归属、认证测试进入 CI 仍要用实现和测试证据收口；录屏需遮挡个人路径和凭证；完成后再安排非作者正式 review | 已录制并归档当前 UI 的两段 **全 mock API** 演示，见第 7.2 节；真实 CLI、持久写入、F229、首句与模型回应仍未覆盖。认证 6 项测试已改接 Public test 文件发现，`e6475a04b` 及 `63b226698` 的同 SHA GitHub 检查最终通过；后者 Windows Smoke 首次遇到测试临时目录清理 `EPERM`，同 SHA 重跑通过。完整产品演示和正式 review 仍未完成 |
| [维护者文档复核 5806685454](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5806685454) | 指出第 12 节“必须选模型／配置页卡住”不符代码；要求聚焦默认模型下探针与首条真实调用的 provider、身份、模型一致性，不把 UX 建议写成硬 AC | 已复核 `ConfigStep`、`ProfileCard` 和可选 `model` 探针，改正第 12 节确定性误述；R7 仍需纵向运行证据，UX 点击目标仍仅是待验证建议 |

乱码通过直接读取 API 的 UTF-8 JSON 与 Unicode 码点再次确认，不只是终端显示问题。表现符合文本编码错配，但没有发布命令/原始文件证据，不把“PowerShell 的某个环节”写成已经证明的根因。修复后应回读 GitHub 正文确认，不仅看本地文件。

GitHub `reviews=[]`；设计方评论属于 advisory，维护者分诊也不是 APPROVE。当前认证 GitHub 账号与 PR 作者相同，本轮不发布正式 review，也不把本地验收报告当作非作者合入批准。

### 7.1 zts 新增的屏幕演示与证据要求

这条评论不是“再跑一次单测”的建议，而是针对用户可见首启旅程的 **dogfood/产品验收证据要求**。它需要把当前实现实际走一遍，并让审查者能区分承诺、脚本模拟和真实运行：

| 要求 | 当前状态 | 完成判据 |
| --- | --- | --- |
| 当前实现屏幕演示 | 两段 mock 视频已归档；PR 链接待本次推送后发布 | PR 评论提供视频链接，并注明录制 commit SHA、操作系统/运行环境、应用启动方式 |
| 主路径连续演示 | 仅录到 mock “团队已就绪”；真实链路未完成 | 首次打开 → 三猫示范初稿/互相 `@`/改稿 → 探测本机已登录 CLI → 创建真实成员和线程 → 解说猫交接真实界面/F229 → 发送第一句并看到真实模型回应 |
| 证据边界标注 | 已在证据 README 标注；PR 评论待发布 | 视频说明哪些是脚本、mock API、真实 CLI、真实模型；静态卡片或手动“下一幕”必须如实标注 |
| 恢复场景演示 | 已录 mock pending→刷新→重新探测；真实登录未验证 | 至少录制一次 pending 重新探测或无客户端离开安装后返回，并展示从中断步骤继续 |
| 安全录制 | 测试 fixture 画面已抽帧检查；视频无真实本机路径或凭证 | 遮挡个人路径、用户名、环境变量、token、URL 凭证和其他本机敏感信息 |
| 代码/测试收口 | 部分完成 | R3–R6、创建幂等、F155 刷新/线程归属和认证测试 CI 接入仍需对应实现及测试证据 |
| 非作者正式 review | 未开始 | 视频和剩余验收项齐备后，绑定最终 exact HEAD，安排非作者 reviewer；当前 advisory 评论不替代正式 verdict |

在视频出现前，不能把“本地 mock 6/6”或“模拟调用通过”扩大成完整产品旅程已验证。视频本身也不能替代测试：它用于核验用户实际走到哪里，幂等、凭证安全、认证来源和 F155 生命周期仍需可重放的自动证据。

### 7.2 当前实现录屏与 R6 更新（2026-09-24）

已用 Playwright Chromium headless 录制隔离 Next dev 页面，基线 `dff40e41a`、Windows、Node v24.16.0。视频、时长、SHA256 和逐段证据边界见[录屏证据说明](../bug-report/onboarding-browser-recovery/artifacts/README.md)。两段分别显示现有示范卡片/模拟创建到“团队已就绪”，以及模拟未登录→pending→刷新→重新探测。所有 API 响应均为 fixture；没有真实 CLI、真实写入、F229 交接、首句和模型回应。真实产品录制仍需在剩余实现完成后补拍；如本机屏幕录制/真实环境不便由本执行方完成，可交由用户录制并据实标注环境与 SHA。

R6 的六项认证 fixture 从 `.test.ts` 转为常规 `.test.js`，引用构建后的 API 模块；Public test resolver 已将 `test/first-run-auth.test.js` 纳入清单，本地直接运行 6/6。`e6475a04b` 与 `63b226698` 的同 SHA Public test 分片和证据汇总均已通过；这证明测试进入常规清单，但不替代真实 CLI/模型验收。

## 8. 验证结果与复现边界

### 8.1 本轮亲自复跑/核验

| 验证 | 实际结果 | 范围 |
| --- | --- | --- |
| `node --import tsx --test packages/api/test/first-run-auth.test.ts` | **6/6 通过** | 使用 fixture；当前总数是 6，不是“4＋新增6” |
| API 编译 `pnpm --filter @cat-cafe/api exec tsc` | **通过** | 先更新 dist，避免路由测试误测旧构建 |
| `node --test packages/api/test/first-run-quest.test.js` | **36/36 通过** | 临时用户目录/配置、隔离环境变量及测试 stub；不是实际联网 CLI |
| Web 3 文件定向 Vitest | **8/8 通过** | config-step、native-profile、client-step；进程内 NODE_ENV=test |
| API `tsc --noEmit` | **通过** | 本轮进程 exit 0 |
| 初次 Biome 定向检查 | **4 文件通过** | client-auth、首启路由及两个 API 测试文件 |
| 最新格式提交 Biome 检查 | **8 文件通过** | d1b710b63 涉及文件；不等于全仓所有 gate |
| Codex 调用参数模拟探针 | **复现 R1** | 临时 config、假 bearer、模拟 spawn；实际传入 OpenAI provider 覆盖 |
| 连接错误模拟探针 | **复现 R2** | 仅假 URL/秘密标记；异常回传未脱敏 |

补充限制/失败必须保留：

- Web 标准入口 `scripts/run-with-node-env-test.mjs` 未成功启动测试：`browser-test-resource-lease.mjs` 引用缺失的 `scripts/lib/process-resource-lease.mjs`，报 ERR_MODULE_NOT_FOUND。8/8 来自设置进程环境后直接调用 Vitest，不能写成标准 wrapper 已通过。
- 尝试现有 `codex-agent-service.test.js` 两项 OAuth provider 用例，Windows 下命令解析报 “Invalid pattern … path:pattern”，mock spawn 未被调用，两个用例失败。随后独立内存探针以可解析的 `cliCommand=node` 注入模拟 spawn 成功捕获参数；这只验证 R1，不把原有失败用例改记为通过。
- React 测试有 act 环境警告，未导致上述 8 项失败。
- 没有读取用户真实凭证正文、联网调用模型、启动生产服务或执行安装器。临时 fixture/编译产物不是业务代码修改。

### 8.2 历史记录与作者当前报告

| 来源 | 记录 | 本轮如何使用 |
| --- | --- | --- |
| 旧文档 | 浏览器 mock 5/5、Web 9 文件40项、guide loader 16项、catalog 10 flow、Web 类型检查通过 | 保留为历史记录，不视为最新提交重跑结果 |
| 当前 PR 正文作者报告 | 浏览器 mock 6/6、Web 19/19、API＋guide 52/52、认证6/6、两端类型检查通过 | 作者自报；本轮直接确认 API 36、认证6、Web8和 API 类型，其余未完整重跑 |
| 当前 PR 正文作者报告 | Windows 全量构建遇到 collective-client 的 Unix rm 命令问题 | 本轮未重跑安装构建，不将该原因视为已独立复现 |
| 本地旧产物 | win-unpacked/Clowder AI.exe，2026-09-22 的旧文件 | 不是本 HEAD 的安装器或安装后体验证据 |

各组测试有重叠，不能把数字相加冒充新增覆盖。mock 浏览器、真实 CLI E2E、CI、正式独立 review、安装器验收是不同证据，分别记录。

## 9. 后续实施与再验收顺序

| 顺序 | 应完成的工作 | 再验收证据 |
| --- | --- | --- |
| 1 | 固定待验提交并完成 CI；认证测试已改接常规 Public test，仍需确认新 SHA 的 CI 与标准 Web test wrapper | 同 SHA 的检查链接、可从干净 checkout 运行的命令、真实测试清单 |
| 2 | 修正 R1/R3 的认证来源和运行身份契约 | OAuth/custom provider/env key × 空账号库/已有账号的测试；探测、probe、exec/app-server 目标一致；真实自定义 provider 对话一次 |
| 3 | 修正 R2 的错误信息边界 | 假秘密进入异常 stdout/stderr/error 后，客户端响应及相关日志不含原值 |
| 4 | 修正 R4 的创建幂等和恢复 | 同一 journey 在丢响应、部分成功、刷新、并发重试后只对应一组成员和一个线程 |
| 5 | 完成原生登录/安装入口与 R5 | 官方安装入口、启动 CLI 原生认证、取消/失败/重新探测；F155 刷新可恢复且只属于首启线程 |
| 6 | 完成三猫真实组件分镜和 F229 身份交接 | 自动输入、气泡动作、互相 @、暂停/继续/刷新；0/1/多客户端的实际行为与能力提示 |
| 7 | 真实首启端到端验收 | 空安装进入；创建真实团队/线程；发送失败不完成、其他线程不误完成、成功后状态持久；记录模型响应及耗时 |
| 8 | 品牌与额外安装交付 | 图标/DMG视觉逐项确认；安装器单列源码 SHA、绝对路径、大小、SHA256及安装/启动结果，标明 #1452/#1459 依赖 |
| 9 | 将当前 mock 录屏链接贴回 PR，并在真实链路完成后补录主路径和恢复场景 | 视频标明 commit、环境、脚本/mock/真实边界；真实成员/线程、F229、首句及模型回复可见；凭证与个人信息不可见 |
| 10 | 非作者正式 review 与合入判断 | 评审意见关闭证据、同提交 CI 完成、产品验收记录；再进入 merge-gate |

建议先打通“一个已有 Codex 自定义 provider 的用户，从探测到第一条真实对话”这条最小纵向链路，再扩展多客户端和完整视觉。原始验收项没有得到明确范围调整前，不能以“后续再补”为由关闭 #1466。

## 10. 本次纠正与决策记录

- 旧远端 ec0e573 / 本地 d336ed811、未推送、CONFLICTING、空 CI 的快照已过期。
- 认证测试当前总数为 6；本轮首启 API 为 36，不能沿用旧 35。
- 当前 PR 是 Refs #1466，无自动关闭引用；不是仍为 Closes。
- #1452/#1459 与 #1519/#1466 分工独立；Windows 安装器正确性不能误记为 #1466 原始范围。
- “不泄漏凭证”收窄为已验证的检测响应；连接错误回显另记 R2。
- “本机身份可被探测”不能替代真实运行身份一致性；R1 是本次最关键功能阻塞。
- 格式、网络和测试 harness 失败分别记录，不合并成一个“测试全通过/全失败”结论。
- 没有修代码、修改 PR、发公开评论、删除产物、提交或推送；公开乱码回复由用户处理。

**当前可用完成声明：首启基础与认证探测明显推进，工作线正确；本轮六项局部验证有明确成果，但完整功能验收不通过，先修身份/凭证边界，再完成恢复、真实旅程及交付证据。**

## 11. 作者后续修复记录（2026-09-23）

此节更新 R1/R2 的处理状态；前文保留原始复现证据和 `d1b710b63` 验收快照。修复在 `feat/onboarding-first-run` 上进行，尚未将 #1466 整体标为完成。

- **R1：代码已修复，真实联网对话仍待验收。** 空账号库的 synthetic builtin 身份现在带有 `syntheticNative` 标识。首启明确绑定该身份时传 `CODEX_AUTH_MODE=auto`，Codex CLI 保留 `config.toml` 当前 provider；持久化的显式 OAuth 账号继续强制 OpenAI provider，显式 API Key 继续使用账号凭证，未绑定的环境认证路径不被改写。模拟调用覆盖了这三条分支及旧环境路径。Codex exec 与 app-server 的参数构造都消费同一 provider 参数，但本轮没有真实自定义 provider 模型回复证据。
- **R2：API 返回已改为固定安全文案。** CLI stdout、stderr、异常 message 和启动失败不再直接回传；假 URL 凭证回归覆盖多条错误路径。另修复 URL 用户信息包含 `rate-limit` 时将失败误判为成功的问题。未声称 CLI 自身日志或其他 API 的所有错误面已完成安全审计。
- **验证**：API 编译通过；首启连接与账号解析测试 58/58，通过；Codex 真实服务的模拟 spawn 对 auto、显式 OAuth、显式 API Key 3/3 通过；调用层 synthetic、显式 OAuth 与无绑定环境路径 3/3 通过；改动文件 Biome 无 error，`git diff --check` 通过。旧 Codex 服务全文件在本机 Windows 定向运行仍有 `path:pattern`/缺少默认模型的前置问题，不列为绿色证据。
- **仍阻塞完整首启验收**：R3–R6、真实 CLI/模型首条对话、创建恢复、三猫视觉分镜、F229 交接、品牌资产及非作者正式 review。#1452 安装器仍按独立交付线验收。

## 12. 新增覆盖缺口：Kimi/OpenCode 原生认证（R7）

设计复核 5792611285 指出，当前首启客户端列表包含 Kimi 与 OpenCode，但 `client-auth.ts` 的本机凭证路径只覆盖 Claude、Codex、Gemini；Kimi/OpenCode 在没有 Clowder 账号记录或环境 key 时会直接落到未认证状态。该意见与 #1466 的“复用已登录 CLI”原则一致，不能因为评论标注为 follow-up 就从完整 Issue 验收中删除。

- Kimi 可参考 `KIMI_SHARE_DIR` / `~/.kimi` 的配置边界，但仍需确认哪些字段只能用于存在性判断；不能把配置内容传到前端。
- OpenCode 的凭证位置和登录语义尚未在本次审查中确认，不能凭名称推断路径或认证成功条件。
- 在范围未明确缩减前，R7 作为 P2 覆盖缺口；需补 fixture、空账号库浏览器路径和真实 CLI 运行身份一致性验证。

2026-09-24 追加源码核验：[Kimi CLI 数据位置文档](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/configuration/data-locations.md)说明 OAuth 文件位于 `KIMI_SHARE_DIR/credentials/`；[实现](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/auth/oauth.py)的 Kimi Code key 是 `oauth/kimi-code`，文件名因此为 `kimi-code.json`，token 字段为 `access_token`/`refresh_token`。Kimi 还支持 `config.toml` 的 provider `api_key`，须对齐当前 `default_model` 所指的 provider，不能只看文件存在。[OpenCode Auth 实现](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/auth/index.ts)将 OAuth/API credential 存为 `Global.Path.data/auth.json` 的 provider 映射；`Global.Path.data` 的跨平台路径、当前选择的 provider 与 credential 对应关系还需确认。以上是上游源码事实，不等于本项目已接入或已有真实 CLI 身份一致性证据。

进一步对照本项目配置页发现：`cat-template.json` 的 `clientDefaults` 目前只有 Claude/Codex/Gemini，但这**不等于** Kimi/OpenCode 必须先选模型或会卡在配置页。`ConfigStep` 对 synthetic native OAuth 账号允许模型留空，仍可执行连接测试；测试成功后可继续创建，`ProfileCard` 明示“未指定模型，将使用 CLI 默认模型”，后端探针的 `model` 也是可选的。实际风险是：探针使用 CLI 默认值时，首次真实调用是否沿用**同一当前 provider、认证身份和模型**，尚无证据。Kimi 的文件 OAuth 还要与当前 `default_model → models[].provider → providers[].oauth` 引用一致，不能因为磁盘上留有旧 token 就宣布可用。R7 应把只读认证识别、可选默认模型、连接探针和第一条真实调用放在同一纵向验证中；只有默认值不可确定或两次调用不一致时，才需要给用户明确的模型选择与恢复入口。单补 `client-auth.ts` 的布尔判断不能证明这条链路完整。

当前状态：**评论已记录，意见合理，尚未完成实现和验收。**

## 13. 录屏体验评审：不仅做完，还要连贯、易懂和简短

本节落实用户新增的验收要求：不以“功能存在、测试通过、视频已交”替代体验判断，还要检查角色/状态连续性、首次使用负担、操作可预测性和引导是否打扰。结论是：**当前录屏完成了展示实现现状的阶段性任务，但尚不足以判定首启体验足够好；应优先减少无必要的选择和点击，而非继续增加解释页面。** 以下是评审意见与改进建议，未执行实现或 PR 修改。

证据是第 7.2 节两段视频，录制代码为 `dff40e41a`，视频归档提交为 `e6475a04b2b5bb66bdd4c7693f0d8b2975e06a31`；两份 SHA256 与证据 README 一致。本轮按每 2 秒抽帧，并补查关键转场画面与对应组件代码。视频为 1440×900、25 fps、无音轨；这是画面/交互流程评审，不是实际用户研究或完整运行验收。

### 13.1 具体体验发现与建议

| 编号 | 画面/源码证据 | 用户体验问题 | 建议与验收重点 |
| --- | --- | --- | --- |
| UX1 | 主片约 1–7 秒；DemoStep/advanceDemo | 看演示必须点击“开始演示→下一幕→下一幕→进入真实配置”；未开始时已有“暂停”，没有明确的“跳过演示”入口 | 一次开始后让脚本自动推进；提供暂停/重看和“跳过演示，开始设置”。跳过的是教学，不能跳过真实认证与创建条件；保留用户控制及减少动态效果选项 |
| UX2 | 主片约 4–6 秒；demo-script | 初稿是“把新用户带到第一次真实对话”，审查却说 `handoff` 太抽象，初稿中没有该词。显示的是三张角色卡和叙述，用户没有看到谁 @ 谁、同一结果如何改好 | 换成用户可理解的小任务，如欢迎文案；初稿里确有被指出的问题，另一只猫指出后在同一结果上改好。用真实消息组件表达接力，避免首启教程讲解“如何设计首启” |
| UX3 | 主片约 6.8–8 秒；Wizard 在 scene=handoff 时立即切 template | 从三只示范猫直接跳到角色模板；“刚才是示范”交接场景虽定义在脚本里，却没有通过 DemoStep 展示。解说猫与随后选的角色缺少可见连续性 | 同一形象/名字从演示留下并映射到第一位真实伙伴，结合实际客户端数量解释“先从你和它开始”；角色自定义允许以后再改，不让用户重新理解一套身份 |
| UX4 | 主片约 7–11.4 秒；单个 Codex、单个模板的路径 | 只有一个可用选项仍依次要求选角色、选客户端、手动测试连接、创建；最短顺利路径在能开始聊天前已有 8 次推进/确认点击，不含第一条消息 | 默认给出推荐伙伴和可用工具摘要，角色/账号/模型设为可展开的设置；用户确认使用后执行连接验证与创建，不再让用户管理每项机械步骤。验证进度与失败重试仍需清楚可见，不能假成功或悄悄切换 provider |
| UX5 | 主片约 8.8–11.4 秒；恢复片约 14.6 秒 | 客户端行右侧操作也只叫“Codex”；下一页又出现“认证和模型配置/OAuth/新建账号认证”。用户刚看到“可用”，却像是仍要重新配置 | 行操作使用“使用 Codex”等明确动词；原生身份显示“沿用本机配置”，避免把自定义 provider 误称为 OAuth。只在失败、多账号冲突或用户主动展开时呈现详细设置 |
| UX6 | 恢复片约 8–14.6 秒；startLogin | “去登录”没有打开登录，只转成等待并显示终端指令；重新检测是较弱的小文字操作。好的一面是 pending 经刷新保留，没有把点击当成功 | 接通原生登录后按钮才称“打开 Codex 登录”；若暂时只能手动，明确标为“查看登录步骤”。返回应用后可只读重探测，保留显眼的“我已登录，重新检测”及失败/取消出口，不要求重看示范 |
| UX7 | 主片约 12–14.4 秒 | 录屏以“团队已就绪、发送第一条消息”结束，却没有输入框与真实伙伴；还不能验证前段体验是否自然交到实际使用 | 在真实主界面继续验收：身份清楚、输入框可直接使用、可编辑的起步建议非强制。这里不是已证实的生产卡死：测试页 onCreated 为空，而正式 ChatContainer 会关 wizard 并导航，必须区分测试载体与产品缺陷 |
| UX8 | first-run-entry.yaml：三步 advance=next；本次视频未展示 | nonBlocking 只证明没有强制遮挡，不保证没有认知打扰。发送、成员、账号逐步提示可能让用户误以为还需完成一套课程 | 保留 F155，真实界面出现后用简短、可忽略的入口提醒同时说明成员/账号，详细讲解按需展开；不抢焦点、不要求点完、不因发送/刷新/换线程反复浮现。该项需补实际主窗口体验证据 |

保留已做好的部分：示范与真实配置的概念有区分；连接测试结果有明确反馈；pending、未安装、可用被分开；恢复片没有让用户重看开场。录屏里的 Planner、gpt-test 是 fixture 值，不据此判定正式产品语言或模型列表错误。片头空白、刷新时空白也可能来自 Next dev 测试环境，不在没有正式运行证据时归因为发布版性能问题。

### 13.2 建议的最短用户路径

建议为“开始观看或跳过示范 → 确认使用已检测到的伙伴 → 进入真实对话”。演示播放时可以只读探测安装/凭证存在性；有费用或外部请求的连接验证在用户确认使用之后执行，结果不能被省略。多人多账号保留选择和修改能力，但单客户端、已登录用户无需先理解角色模板、认证类型、模型名和账号管理。多个客户端可以一页确认后统一准备，逐项显示进度与失败，不要求逐页操作同一套配置。

建议把“已登录、单客户端”路径的必要推进/确认控制在 **2–3 次**（不含输入和发送），作为待验证的设计目标，不是已批准的新硬性 AC。删步骤不能以牺牲认证真实性、费用知情、用户选择或恢复可靠性为代价。原有三猫叙事和 F155/F229 仍保留，减少的是机械点击和过早设置。

### 13.3 后续体验验收判据

| 维度 | 通过证据 |
| --- | --- |
| 看懂价值 | 未参与实现的人看完能说明“同伴为什么加入、结果哪里更好”，无需先学习 handoff/CLI/OAuth 等词；记录误解，不以 reviewer 的感觉代替用户反馈 |
| 快速开始 | 在真实已登录单客户端路径记录必要点击、主动选择、等待和到第一条消息的时间；与需安装/登录的用户分开。14.40/15.92 秒是自动化录像时长，不是新人完成时间 |
| 连贯一致 | 示范解说猫、真实成员、F229 身份连续；按钮准确描述结果；配置后不用用户找关闭按钮或猜下一步 |
| 不打扰 | 演示可跳过/重看，退出后可继续；进入真实主窗口即可输入；F155 轻提示可忽略，取消后不反复出现，已有用户不被强制重走 |
| 异常可恢复 | 真实登录返回、失败重试、刷新、部分创建成功和丢响应均有明确状态；用户不用重新填已提供的信息或重复创建 |

本轮只补充体验审查和验收建议，不把 zts 要求的阶段性录屏贬为无效，也不把它扩大为完整产品体验通过。后续应在实际主窗口以正常阅读和操作速度录制，再结合首次使用者反馈检查简化是否有效。
## 14. 2026-09-24 复核更新：R3/R4/R5/R7 局部闭环，整体验收仍阻塞

本轮根据复核意见补齐了可以在当前代码与 fixture 中验证的边界，并重新运行了定向检查。结论仍是：**Issue #1466 整体不能验收通过、不能关闭或合入；PR #1519 继续保持 `REVIEW_REQUIRED / BLOCKED`，正式非作者 review 仍为 0。**

已落地并有证据的部分：

- **R3 P2：环境 key + 空账号库路径**：`resolveForClient`/`resolveByAccountRef` 在空账号目录下保留环境 key 以及 CLI 自有身份；synthetic native profile 不再因为账号库为空而丢失。Codex 自定义 URL＋Key 继续保留当前 CLI provider 语义，不能用 `codex login status` 替代 URL＋Key 可用性判断。账号解析定向测试通过。
- **R4 P2：成员与首启线程幂等**：成员 ID 由 journey/template/client 稳定派生；成员创建带 `Idempotency-Key`，目录写入使用进程内串行和文件锁；线程使用用户隔离的 journey ID，Redis 使用 Lua 原子创建。内存 store 与 Redis store 的 ensure 接口返回 `created`，所以并发首个 POST 返回 201、重试返回 200，并返回同一线程。`bootcamp-flow.test.js` 的并发/服务端完成状态测试通过。
- **R5 P2：F155 完成状态恢复**：首句成功后先 PATCH 服务端线程的 `bootcampState.completedAt`，PATCH 成功才写本地完成状态；刷新时优先读取服务端完成状态，并校验 journey 与 thread 归属。Web onboarding 状态测试通过；这证明状态边界，不等于完整浏览器主窗口验收。
- **R7 P2：Kimi/OpenCode 原生认证识别**：加入 Kimi `KIMI_SHARE_DIR/credentials/kimi-code.json` 与 OpenCode `XDG_DATA_HOME/opencode/auth.json` 的只读存在性识别，并只返回状态，不返回凭证内容。该部分有 fixture 覆盖，但真实 CLI 当前 provider、模型和首句调用的一致性仍未证明。
- **凭证回显防护**：连接探测错误返回固定安全文案；fixture 验证 URL/token 不出现在响应。该结论只覆盖当前探测接口与 fixture，不扩展为所有生产错误路径已完成安全审计。
- **项目级乱码规避**：worktree `AGENTS.md` 已加入 GitHub 中文 PR/Issue/评论的 UTF-8 无 BOM、`--body-file`/JSON 文件提交、发布后 API 回读、原位修复乱码评论的规则；根目录 AGENTS.md 中已有同一规则，后续以两处规则共同约束。

本轮实际运行结果：

- `pnpm --filter @cat-cafe/shared build`：通过。
- `pnpm --filter @cat-cafe/api exec tsc --noEmit`：通过。
- `pnpm --filter @cat-cafe/web exec tsc --noEmit --incremental false`：通过。
- `pnpm --filter @cat-cafe/api exec node --test --test-concurrency=1 test/first-run-auth.test.js test/account-resolver.test.js`：31/31 通过。
- `pnpm --filter @cat-cafe/api exec node --test --test-concurrency=1 test/bootcamp-flow.test.js`：2/2 通过。
- `pnpm --filter @cat-cafe/web exec vitest run src/components/first-run-quest/__tests__/onboarding-journey.test.ts`：8/8 通过。
- `git diff --check`：通过。Biome 定向检查未发现本轮新增格式错误，但报告了仓库既有复杂度、可访问性和 hook 依赖警告；未把这些既有警告写成整体验收通过。

仍未闭环、必须保留为阻塞项：

- R3/R7 只有只读检测与 fixture；真实 Codex/Kimi/OpenCode CLI 探测、当前 provider/模型绑定、网络连接和第一条真实模型回复尚无证据。
- 真实端到端链路仍缺：成员/线程持久化后的刷新恢复、F229 交接、首句发送和真实模型回复未在同一条旅程中完成；mock API 录屏不能替代这些证据。
- 三猫仍是静态卡片与手动“下一幕”，没有 Issue #1466 要求的真实消息组件、自然身份连续性和真实交接；主路径仍有多次机械点击，跳过演示入口和“确认已检测伙伴后直接对话”的收敛方案尚未实现。
- “去登录”仍主要显示手动终端步骤，按钮语义和行为尚未完全一致；F155 非阻塞提示的完整生命周期、刷新恢复和线程归属仍需真实主窗口证据。
- PR #1519 当前正式 reviews=0、review threads=0，尚未满足“非作者正式 review”要求；因此不能进入 merge-gate。

因此当前状态继续标记为：**P1 修复有效，R3/R4/R5/R7 局部实现及定向测试通过；Issue #1466 整体仍未验收通过，PR 不得关闭或合入。**
