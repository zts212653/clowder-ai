---
feature_ids: [F327]
related_features: [F202, F205, F247, F325, F290, F314]
topics: [google, gemini, lyria, veo, flow, flow-music, chrome-extension, plugin, media-generation]
doc_kind: spec
created: 2026-10-14
updated: 2026-10-29
tips_exempt: "2026-10-27: PR6159 carries the music tip. Paired previews and follow-up fixes are merged; real Alpha Manager/native generation and project delivery passed. Billing/Ultra-credit verification remains open. Phase B/C have no shipped entry."
description: "把 You 的 Google AI 订阅里家里用得上的能力（音乐、视频、Gemini 网页等）接进 Clowder AI，让猫自己用，不靠人在网页上手点转发。"
description_source: human
description_author: opus55
description_updated_at: 2026-10-15T01:30:00Z
---

# F327: Google Family Suite｜Siamese家全家桶接入

> **Status**: in-progress | **Owner**: 小太阳 @codex61-sol（Phase A 实现），Siamese @gemini-argon（独立 review）；执行 thread `thread_mvosmqalhrabbmvd` | **Priority**: P1

## Why

You 要开 Google AI Ultra（为了只有 Ultra 能用的 Gemini Argon），订阅里还附带音乐、视频和一堆网页工具。他希望这些能力**直接给猫用**，而不是他自己去网页上一条条点、再把结果转回来：

> 「google flow music 和 google flow 我们应该写个插件接入进来？or 看看他们有没有 mcp，这得给你们用……我们得把他们的价值榨干！这个音乐和做视频肯定对你们很有用」（`private-source-id`）
>
> 「我自己去网页点点点，哈哈太麻烦了。你还记得家里的 gpt pro 的插件吗，跟那个一样咯！写个 chrome 的插件」（`private-source-id`）
>
> 「这个出配乐还行，视频烧不起的……总不能我当你们的人肉 mcp 吧？这又要我当路由器？！」（`private-source-id`）
>
> 「单独开一个 feat 号，对接的是Siamese家全家桶，我们用得上的都放那边。多人创意游戏 脑洞大会……可以把这个 feat 投递给他们，我估计他们这个要做个游戏的，google 全家桶的这些对接他们更需要。最开始可以我当路由器的」（`private-source-id`）

一句话：**订阅里付了钱的生成能力，猫自己就能用，You 不当路由器。**

## Current State / 现状基线

- **2026-10-27 11:14 UTC：有界项目音频交付已获 operator 采纳，配对代码已合入。** operator 原消息 `thread_mvosmqalhrabbmvd#private-source-id` 选择“采纳，合入并发布配套预览版”。[Host #6159](https://github.com/zts212653/clowder-ai/pull/6159) 实际合入 `3608aa08d179029cd028c53e02d08864ea4dee30`；[插件仓 #137](https://github.com/zts212653/clowder-ai-plugins/pull/137) 实际合入 `8450bdf57b26671ea43970dcee74f90e3e071b53`，配套 Contract/SDK 预发布流程 `40494590987` 已启动，发布结果仍待 registry 精确版本/完整性核验。原 Argon 对 Host `3aca381f` 的独立安装/边界 10/10 和 API 类型检查批准已消费，公开产品批准及 e60 的包字节连续性也已消费。音乐包仍为 private、未上架。原 Task2559 继续自有 named Alpha 的真实 Manager 配置/显式启用、猫调用、可播放产物与账单验收；对应 AC 仍未关闭。

- **2026-10-27 10:10 UTC：Host 0.3 已配对，进入本次实质增量独审。** #6236 已合入 `8b989adb`，原基线依赖已解除。Host #6159 已推 `3aca381f4d64f503d9077a2349f5530900084533`，消费冻结 main `8c9df913` 并保留删除旧 API 权限表的结果；API、Web 与 SDK 嵌套消费同一份精确 Contract `0.3.1-candidate.0`，音乐归档与公开已审字节一致。新配对实际安装/native/loopback/媒体交付及失败清理等 71/71 隔离检查、完整 API 依赖构建、API/Web 类型、MCP 治理（202、零变化）和 tips 均通过；供应商仍为 fixture。公开 #137 当前 `e60a4e40` 两路 CI 已实际成功，Argon 对 `101e241a` 的产品批准由仅测试断言修复、生产/工作流源码及三份包完全同字节的连续性桥接。新增有界公共项目交付采纳和 Alpha 真实调用/账单仍未完成；不把隔离成功写成正式可用。
- **2026-10-27：公开仓已适配 Contract 0.3 并独审通过，Host 配对仍在续办。** [公开 PR #137](https://github.com/zts212653/clowder-ai-plugins/pull/137) 当前 `101e241a7df07f3c47bb33c1be75347bde43c795` 已正常整合 main `de496d1c`：不恢复已退役 API 权限表或原生 MCP 方法白名单，改用同 feature 的真实 native/media 声明绑定。Argon `private-source-id` 精确批准公开增量，独立托管 11/11 及三包类型检查通过；作者 Contract 646、SDK 228、music/独立安装入口 27、gate 脚本 12 项与 conformance 均通过。当前 [Host #6159](https://github.com/zts212653/clowder-ai/pull/6159) 为 `549b1a4ccb0f17b8f6e34e27f3a052f85799c405`，普通调用内部 producer/lookup 的新增失败检查已 RED→GREEN，6 项输出测试通过。Host 完整 0.3 基线由原维护 Task1136 的 [吸收 PR #6236](https://github.com/zts212653/clowder-ai/pull/6236) 接入；F327 不复制其清理，待接入后替换精确依赖和归档、验证完整安装旅程。这是真实兼容前提，不是 CI 账单等待；未将旧 Host 通过记录当成新配对通过，公共交付范围采纳、Alpha 真实使用和账单验收仍未完成。
- **原安装 RED 与清理问题已分别处置。** Argon `private-source-id` 对 Host `8c96aeeb` 独立托管原 installed journey 和 timeout/abort 清理，3/3、13.96 秒、退出 0。实际修复了 helper 先 reject 而自有 child 未退出及 fixture 清理顺序；原 AGY step65 的 9 秒 RED 仍缺错误栈/退出回执，不能倒推其触发原因。F325 的执行终态诊断归原线；旧代码与服务实测批准各守历史范围。
- **2026-10-27：可安装配对候选已形成，进入独审。** [Host PR #6159](https://github.com/zts212653/clowder-ai/pull/6159) 的 `eb416d23d5f7ee3308536a82870ef0d0eb4b32ec` 与[公开插件 PR #137](https://github.com/zts212653/clowder-ai-plugins/pull/137) 的 `fceb515ea04e02d3438d67fc77b5036f5e40c67f` 成对。模块、manifest、Manager 确认复用/后台 OAuth/恢复、原生 MCP、Cloud 单次生成和持久音频已实现；Host 接可信项目授权、持久派发、真实文件预留与交付，旧内置 Google service/callback/MCP/shared 音乐契约已删除。包保持 private、未发布/上架，公共输出权限尚未采纳，不代表已能在正式环境使用。
- **外部 CI 观察已结算，不阻塞续办**：Host HEAD `eb416d23d5f7ee3308536a82870ef0d0eb4b32ec` 的 Actions run `40451303664` 两项作业均为 `runner_id=0`、`steps=[]`，annotation 明确为账号支付/额度阻止启动；对应两份样式表测试本地 5 项通过。按 [LL-098](../public-lessons.md#ll-098-zero-step-billingspending-limit-是外部基础设施不是新的代码裁决) 与[现行 CI 规则](../../cat-cafe-skills/refs/pr-signals.md#ci-外部基础设施)，归类 `external_infrastructure` 并结束这条不可执行等待；不要求 operator 充值、修账单或关闭 workflow，不冒称托管 CI 通过。公开仓同 HEAD 两项 CI 已实际通过，本地完整 36 步通过。operator 在 `private-source-id` 再次纠正，作者已撤回将此列为阻碍的表述，继续消费本地验证与独审。

## What

### Phase A: 官方接口出音乐

按 operator `private-source-id` 改用 Google Cloud 的 Lyria，核对并使用 Ultra 附带的 Cloud 额度；不充值 AI Studio。猫给一条提示词（可指定时长目标、纯器乐，输出 MP3），拿回音频文件，落到调用方指定的位置，并记下来源：模型、提示词、时间、费用口径。

按 operator `private-source-id` 的现行 F202 要求，最终承载为独立插件包与统一 Plugin Manager，复用公开配置/凭据、声明 action、实际安装/启用、调用归属与生命周期，猫走公开工具发现和调用。Contract 0.3 已撤销重复 API 授权表，F327 不恢复该表。已有 Cloud 授权先核验、复用；不能让用户每次搬链接、复制 token 或手动搬音频。原 Host 内置音乐 MCP 方案保留为底层候选事实，不先合入制造第二套 Google 业务控制面。

**当前插件实现（2026-10-27，主线已集成，音乐包 private）**：公开仓独立 Google Cloud music module 通过现行 Manager 设置和原生 MCP 承载。用户确认复用已有授权或在卡片完成必要的新授权，再明确启用；猫使用 `generate_music` 的稳定 `requestId`，Host 在原 action 调度统一核权限并先预留 MP3/回执，插件才发起单次 Cloud Interactions 请求。插件持久保存音频，Host 复用媒体 ledger 承接和恢复项目交付。默认 Clip、Pro 需明确选用，仅承诺 MP3；不替换模型/账号/项目，不自动重试未知付费效果。时长/BPM 是意图，实际扣费与赠金扣抵仍未知。

**授权来源**：早期将网页 OAuth 纠偏误写成 Cloud OAuth 前置的解释已经撤回。API 来自复盘先行后的 `private-source-id`，Google Cloud 来自 `private-source-id`，新版 F202 旅程来自 `private-source-id`，继续实施来自 `private-source-id`。这些不取消网页范围，也不代替新增公共权限的采纳。候选可以准备和审查，正式 adoption/发布仍守原边界。

Architecture cell: plugin
Map delta: 配对实现已更新 `docs/architecture/ownership/cells/plugin.md`；有界公共输出行为已获 CVO1442 采纳。
Why: 插件拥有 Google 业务和保留的供应商产物，Host 拥有调用者项目授权、持久预留及交付，既有 media ledger 拥有已承接字节；不保留第二套 Host Google 控制面。

Canonical source: `packages/api/src/domains/plugin/outputs/project-output-actions.ts`、`output-dispatch.ts`、`project-output-files.ts`；公开仓的 `packages/music-generation/src/plugin-entrypoint.ts` / `settings.ts` / `music-jobs.ts`。
Consumer evidence: 实际入口由 `carrier/runtime-carrier.ts` 和 `routes/plugin-native-action-routes.ts` 承接；公开 Contract/SDK/manifest 配对，首版只允许可认证的原生 MCP，不开放设置动作或 direct-tool 绕过。
Claim guard: `f327-plugin-package-journey.test.ts` 用实际归档/native 进程和真实本地 HTTP 验证完整隔离旅程；`plugin-project-output.test.ts`、`plugin-output-files.test.ts`、`plugin-output-dispatch.test.ts` 覆盖权限/并发/物理文件和恢复。模拟授权与供应商不能替代真实猫到 Cloud 验收。配对版本集成后由原 Task 在 Alpha 接续真实验证，不以 CI 或草稿状态替代产品完成。

### Phase B: 网页通道（Chrome）出音乐和视频

视频走 Flow 网页里的订阅额度（Veo），音乐也可以走 Flow Music 网页。做法与家里的 GPT Pro 插件一致：复用 F247 的 Chrome 扩展、本机助手和配对授权，为 Flow / Flow Music 加页面适配器。流程是：填提示词 → 生成 → 等待 → 下载 → 文件回到家里。首次安装和授权之外，You 不需要再操作。

### Phase C: 其他网页能力（按消费者需要再定）

Gemini 网页里的 Argon 做成能在 thread 里说话的云端猫（像 gpt-pro）、NotebookLM、Project Genie 等。由第一个真实消费者（脑洞大会 thread 的游戏）提出需要后，再补具体范围和 AC。

## User Journey

### 音乐插件：先检查，再生成

此流程需要当前 Host 已取得兼容音乐插件，并由有权限的人完成必要的配置、授权和启用。更新公开源代码不会自动安装插件，也不证明当前实例已就绪；未获得兼容安装来源时，不应把别的实例的安装记录当作可用凭据。

先在「设置与管理 → 连接与扩展 → 插件集成」检查当前状态。已安装、配置就绪、明确启用且运行正常时，可让同一 Host 下其他获准的线程使用；调用仍受当前成员与项目政策约束，不需要每条线程重装或重复登录。未就绪时由有权限的人沿插件页提示完成对应步骤，沿用已有有效授权。

告诉猫音乐风格、情绪、配器和线程所属项目的目标路径。猫从当前实际工具列表发现 `generate_music`，为这次有意生成保留稳定的 `requestId`，成功后交付可播放的 MP3 和来源回执。重查同一次请求应沿用原编号；未知的付费执行结果不能靠换编号自动重试。

实际扣费与赠金额度抵扣需有真实账单证据，未知时仍记未知。来源回执及音频交付成功不能代替费用核验；本流程不代表网页视频通道已经交付。

### Primary Journey: 猫自己出一段配乐或一个镜头
- **Scope unit**: thread
- **Actor**: 猫猫（You 只在首次安装、授权时出场）
- **Entry**: 任意 thread 里，猫需要一段音乐或一个视频镜头
- **Flow**:
  1. 猫用一句提示词发起生成（音乐走 Phase A 的官方接口，视频走 Phase B 的 Flow 网页通道）
  2. 生成过程在 thread 里看得到状态：排队、生成中、成功或失败及原因
  3. 成功后文件出现在调用方指定的目录，附来源记录；猫继续剪进片子或游戏里
- **Success evidence**: 一次真实生成的回执（文件路径、来源记录、时间），过程中没有 You 手动操作网页
- **Non-goals**: 不做批量刷额度；不绕过 Google 的账号与安全机制；不把视频生成放在按秒计费的 API 上（KD-2）

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | workspace | operator | 插件设置里一次安装扩展、一次配对授权 → 之后不用再管 | 设置页截图 |
| S2 | thread | 猫猫 | 生成失败（额度用完、网页改版、被拒）→ thread 里看得到原因 → 不静默、不重复刷 | 失败回执 |

## Acceptance Criteria

### Phase A（官方接口出音乐）
- [x] AC-A1: 猫用一条提示词调用音乐生成，得到 MP3 或 WAV，落到指定目录，附模型、提示词、时间与费用口径的来源记录；You 不操作网页。2026-10-27 原 Native/CLI 插件调用和 Host 项目双产物自动交付已实证，见上述 Alpha 证据。
- [x] AC-A2: 额度不足、被拒、超时时，调用方拿到明确的失败原因，不静默、不自动重试刷额度。最终插件的拒绝/未知/超时契约及收尾定向实跑通过；本次真实 pending 查询同一操作，生成计数 1。
- [ ] AC-A3: 在 operator `private-source-id` 的 API 许可下，真实核对所用账号、API 认证来源与费用归属，不能用模拟 token、代码单测或网页登录状态替代。原稿将 OAuth 纠偏写成 Cloud OAuth 前置，已按后续原话撤回；后续 `private-source-id` 新明确选择 Google Cloud，必须核实 Cloud 项目及赠金关联，不能倒推为此前网页 OAuth 解释正确，不能静默借用其他账号或 AGY 私有 token。

- [x] AC-A4: 符合现行 F202 的可安装插件交付：用户从 Plugin Manager 完成必要的账号、Cloud 项目/费用归属确认、授权及显式启用，后续猫自行生成并交付到正确项目；失效在同一卡片恢复，安装/配置/auth/启用意图/live 分开，停用/升级/卸载保留应留的作品与来源数据。以真实安装/授权/调用旅程和制品依赖闭包证明，不能用 Host 内置工具或已有服务单测代替（operator `private-source-id`）。2026-10-27 真实 Alpha Manager 安装/连接恢复/明确启用/原生生成/项目交付通过；重启复用及停止后作品保留已实证，最终归档的停用/卸载等保护由独立实跑覆盖。该验收不表示正式 runtime 已部署，费用/赠金未知仍由 AC-A3 承接。

### Phase B（网页通道出音乐和视频）
- [ ] AC-B1: 猫发起一次 Flow Music 生成，经 You 已登录的 Chrome 完成，音频文件自动回到家里；除首次安装和授权外，You 不手点。
- [ ] AC-B2: 同样跑通一次 Flow 视频生成，用的是 Flow 网页的订阅额度，不是按秒计费的 API。
- [ ] AC-B3: 生成节奏有上限；页面改版或拒绝导致失败时，给出可读原因，可以修，不会卡死。

### Phase C（其他网页能力）
- [ ] AC-C1: 由第一个真实消费者提出具体能力后补写，范围经 You 确认再开工。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | 「google flow music 和 google flow……得给你们用」 | AC-A1, AC-B1, AC-B2 | 真实生成回执 | [ ] |
| R2 | 「总不能我当你们的人肉 mcp 吧？这又要我当路由器？！」 | AC-A1, AC-B1 | 回执中无 You 手动步骤 | [ ] |
| R3 | 「出配乐还行，视频烧不起的」 | AC-A1, AC-B2 | 费用口径记录：音乐 API、视频网页额度 | [ ] |
| R4 | 「跟那个（gpt pro 插件）一样咯！写个 chrome 的插件」 | AC-B1 | 复用 F247 Chrome Host 的实现说明与回执 | [ ] |
| R5 | 「我们用得上的都放那边」 | AC-C1 | 消费者提出后补 AC | [ ] |
| R6 | 「我们之前设定的难道不是走 oauth？」；后明确原意为网页版、并非 Cloud OAuth（`private-source-id`、`private-source-id`） | AC-A3, AC-B1 | 将原网页登录旅程与后来获准的 API 认证分开验证，不以一条代另一条 | [ ] |

### 覆盖检查
- [ ] 每个需求点都能映射到至少一个 AC
- [ ] 每个 AC 都有验证方式

## Tips Contribution（F244）

Phase A 交付时新增 1 条 tip：「要配乐时，让猫直接调用音乐生成，不用去网页」，指向本 feature 与插件设置。Phase B 交付时补 1 条：Chrome 插件怎么一次装好、授权。

## Dependencies

- **Evolved from**: 无（全新能力）
- **Related**: F205（插件配置、密钥管理与协议引擎，Phase A 的候选承载；它的 API 实测 AC-C2 单独处理，不靠本 feature 的视频走 API——见 KD-2）、F247（Personal Chrome Host，Phase B 复用）、F325（Siamese的 AGY 载体）、F290（脑洞大会 thread 的多人协作背景）

## Risk

| 风险 | 缓解 |
|------|------|
| 自动操作 Google 的网页属于非官方用法，可能碰到服务条款、影响 You 的账号 | 只用 You 本人账号，节奏放慢、设上限；能走官方 API 的（音乐）优先走 API |
| 网页改版导致适配器失效 | 失败给可读原因；适配器按 F247 的做法做版本握手和回归样本 |
| API 费用超出附带额度 | 视频不走 API（KD-2）；音乐每次调用记费用口径，接近额度时提示 |
| 生成内容对外发布的使用条款 | 来源记录里写清生成服务；对外发布前核条款（SynthID 水印、商用许可） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 单独开 feature，不挂在 F247 下 | operator：「单独开一个 feat 号，对接的是Siamese家全家桶，我们用得上的都放那边」 | 2026-10-14 |
| KD-2 | 音乐可以走官方 API；视频不走按秒计费的 API，只走 Flow 网页的订阅额度 | operator：「这个出配乐还行，视频烧不起的」 | 2026-10-14 |
| KD-3 | 目标是猫自己用，You 不当路由器；起步阶段 You 可以临时当路由器 | operator：「总不能我当你们的人肉 mcp 吧」「最开始可以我当路由器的」 | 2026-10-14 |
| KD-4 | 交给「多人创意游戏 脑洞大会」thread 认领 | operator：他们要做游戏，更需要这些对接 | 2026-10-14 |
| KD-5 | Phase A 从脑洞大会解绑，单独执行；B/C 不在本次开工范围 | operator 同意新建执行 thread；实现 @codex61-sol，review @gemini-argon | 2026-10-26 |
| KD-6 | 明确 OAuth 认证要求，撤回作者提出的 API-key 前置步骤 | operator source `private-source-id`；官方 API 的选择不等于 key-only 认证授权 | 2026-10-26 |
| KD-7 | 撤回作者将 KD-6 写成 Cloud OAuth 的解释；API 获后续新许可，先交 F314 复盘 | operator `private-source-id`、`private-source-id` 明确原网页版意图；`private-source-id` 后允许 API，但不能据此倒推此前解释正确或网页已交付 | 2026-10-26 |
| KD-8 | 后续 API 走 Google Cloud，禁止 AI Studio 充值；配置只在后台执行 | operator `private-source-id`、`private-source-id`；首授权由人主动打开链接，作者不抢占前台 | 2026-10-26 |
| KD-9 | 采纳普通插件经 Host 将当次音频与来源回执新建到获准项目，合入配对候选并发布配套基础包预览版 | operator `private-source-id`；不含任意写入、覆盖或未知结果自动重复付费，音乐包保持 private，真实 Alpha/账单继续原 Task 验收 | 2026-10-27 |

## Review Gate

- Phase A：非作者猫 review；用真实额度跑一次生成作为证据。
- 本轮代码 review 已通过：reviewer `gemini-argon`，HEAD `786fc371e574dd11aea3e1e367561d64d7b683b6`，accepted source revision `17bb4fe946e7daeb02aa63b95808ae6d034b057d`，durable fact `local-review:private-source-id:approved`。批准仅覆盖代码与契约；实际音乐验收仍未通过。
- OAuth 修正代码已独审批准：reviewer `gemini-argon`，HEAD `c0b30645c54c766fdf88d163f71023db328a79b8`，accepted source revision `025ea95452518f66d754ca1590d00b536fc458ab`，durable fact `local-review:private-source-id:approved`。作者已核验相同代码与需求；本次共享状态只登记批准和未验边界，无新实质内容，不为 ACK 重新唤醒 reviewer。
- Cloud 增量已独审批准：`gemini-argon`，HEAD `76d4f4ae5571d8043034da43b9f4d230be30599b`，accepted source revision `deb2752251168440adea415c80fe6dd104c29f3e`，durable fact `local-review:private-source-id:approved`。覆盖 Cloud 实现、主线集成与真实服务样张；不外推为完整 native MCP、实际账单扣抵或网页交付通过。
- 新本地发现接点已独审并合入：`gemini-argon`，HEAD `eb1d512ebba8ebfd1560693a797887d121db20cb`，accepted source `ee863b7162b4cbc8815792dbfc0b6fc29277f7d0`，typed fact `local-review:private-source-id:approved`；实际合入 `e4d06cd5d3c86b716c92058ee615ad478d652e80`。合后原 Task 已完成真实普通猫调用和项目自动交付，不再等待 draft、旧 guard 或 CI 账单。
- 下一动作：原 Task `private-source-id` 继续核 AC-A3 的实际费用与 Ultra/Cloud 赠金关联；未知保持未知，不新增付费生成或重复授权。Phase A Alpha 功能可用，正式 runtime 部署与网页 Phase B 不在本次已验结果内；不擅自重启生产或关闭整项 Feature。
- Phase B：沿用 F247 Chrome Host 的审查口径；在 You 日常 Chrome 上做一次真实旅程验收。
