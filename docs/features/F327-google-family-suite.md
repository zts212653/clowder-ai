---
feature_ids: [F327]
related_features: [F205, F247, F325, F290]
topics: [google, gemini, lyria, veo, flow, flow-music, chrome-extension, plugin, media-generation]
doc_kind: spec
created: 2026-10-14
updated: 2026-10-26
tips_exempt: "2026-10-26: API candidate #6159 remains draft. operator clarified the original web intent, then allowed API work after an F314 incident report. Real generation and billing acceptance remain open; Phase B/C have no shipped entry."
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

- **2026-10-26 开工**：operator 在 `[thread-id]#private-source-id` 对 Phase A 开工提议回复「我觉得可以啊哈哈哈新建thread」。仅 Phase A 获准执行；本线程独立实现、自测、review，最终一次回报盘点线程。Phase B/C 保留原范围。
- **2026-10-26 实现候选**：[PR #6159](https://github.com/zts212653/clowder-ai/pull/6159) 提供 `cat_cafe_generate_music`，复用 callback、Google 账户与设置页配置根目录；音频/来源回执持久落盘，不覆盖、不自动重试。126 项定向检查、API/MCP 构建与工具治理校验通过；@gemini-argon 已独立代码审查通过，typed fact 为 `local-review:private-source-id:approved`，覆盖 HEAD `786fc371e574dd11aea3e1e367561d64d7b683b6`。该候选仅实现 API-key 认证；已解析的 Google 账户 `gemini` 为 OAuth，因作者的 key-only 检查而停在 `configuration_required`，尚未向 Google 发出计费请求。该错误不证明官方接口只能用 key，也不构成要求 operator 新建 key 的依据。
- **2026-10-26 认证纠正**：operator 在本执行线程 `private-source-id` 明确「我们之前设定的难道不是走 oauth？」。作者撤回创建 API key／另开计费的操作指引，将 OAuth 纳入明确验收契约；当前候选尚不满足该要求，PR 保持 draft，不进入 merge-gate。官方 Gemini API [支持 OAuth](https://ai.google.dev/gemini-api/docs/oauth)，但该官方 Cloud OAuth 路径与家里 AGY Native 个人登录的授权范围、计费项目及 Ultra 额度适用性仍需核验；没有提取、转发原生登录 token，也没有改走 Phase B 网页通道。下一动作归作者核实并修正认证实现，不是等待 operator 补 key。
- **2026-10-14 实测**：给《AI-native builder 的一天》出配乐时，Sol6.1 只能用 macOS 界面操作 You 的 Chrome 去 Gemini「Create music」逐条抽卡。21 条里 Gemini 只出了 5 条，16 条回复「现在无法生成音频」；剩下的改用 Flow Music（同账号 Plus 权益）才补齐。全程需要 You 授权、开浏览器，猫手动点。记录见 `meow-club/cat-cafe-films` 的 `builder-day/public/builder-day/score/gemini/FIRST-PASS-20261014.md` 与 `flow-music/FLOW-FIRST-PASS-20261014.md`。
- **家里已有、可复用的底座**：
  - F205：视频生成插件的声明式协议引擎（`packages/api/src/plugins/video-gen/`，模板有 jimeng / kling / zhipu；`video-analysis` 有一份 gemini 模板）。它的 AC-C2「用真实密钥跑通一次」仍未关。
  - F247：Personal Chrome Host（MV3 扩展 + Native Messaging 助手 + 配对授权 + 回执账本，`packages/api/src/plugins/cloud-cat-personal-host/`），目前只有 ChatGPT 页面适配器。
  - F325：Antigravity（AGY）原生载体，是Siamese的运行载体，不负责生成能力。
- **还没有**：任何 Google 的音乐/视频生成接口或网页通道接进家里。
- **外部事实（2026-10-14 核 Google 官方页面）**：
  - Gemini API 有 Lyria 3.5（$0.08/首）、Lyria 3 Clip（30 秒，$0.04/首），没有免费档；生成的音频都带 SynthID 水印。
  - Veo 3.1 按秒计费：Fast 1080p $0.12/s，Standard 1080p $0.40/s，没有免费档。
  - Google AI Pro / Ultra 订阅附带每月 Google Cloud 额度（Ultra operational cost/月），可用于 Gemini API，需要在 Google Developer Program 激活（Google 博客 2026-01-27）。
  - Flow、Flow Music 没有找到官方 API 或官方 MCP，只有社区做的、替用户操作网页的 MCP。

## What

### Phase A: 官方接口出音乐

按 operator `private-source-id` 改用 Google Cloud 的 Lyria，核对并使用 Ultra 附带的 Cloud 额度；不充值 AI Studio。猫给一条提示词（可指定时长、纯器乐、WAV），拿回音频文件，落到调用方指定的位置，并记下来源：模型、提示词、时间、费用口径。

承载方式由 owner 定：可以作为 F205 协议引擎的新模板（新增「音乐生成」插件），也可以是一个独立的 MCP 工具。原则是复用家里已有的密钥、配置和插件管理，不另造一套。

**Phase A 执行切口（2026-10-26）**：独立原生 music-gen MCP 入口，经现有 callback 鉴权调用官方音乐 API；当前候选实现使用 Gemini Developer API，待按本轮 Cloud 指令修正接点后验收。凭据沿用现有 Google 账户配置，输出限制在调用线程项目内。与 F205 的视频协议工具分开，音频与 provenance 一起持久落盘，拒绝覆盖已有文件。HTTP 请求不自动重试，配额、安全拒绝、超时均返回结构化失败。时长/节奏是提示词意图，回执不把意图写成已测得的精确时长。需真实生成回执后才勾 AC-A1。

**认证要求的来源修正（2026-10-26）**：作者曾将 operator source `private-source-id` 的 OAuth 纠偏写成 API Cloud OAuth 契约；operator 后在 `private-source-id`、`private-source-id` 明确原意是网页版，撤回这项作者解释。停工后的 source `private-source-id` 允许 API、要求 F314 复盘先行；后续从此账号真实可用的 API 授权核实，不将 Cloud OAuth 设置当作原始人类要求，不拆解 AGY 私有登录或浏览器凭据，也不把网页登录或赠额页面等同于 API 已授权、费用已抵扣。两份旧代码批准保留其实际覆盖范围，真实生成验收仍必需。

Architecture cell: action-plane
Map delta: none
Why: 在现有 typed vendor action、callback、账户与文件边界内增加一个音乐操作；不新增凭据库或后台队列。

Canonical source: `packages/api/src/routes/callback-auth-prehandler.ts#requireCallbackAuth`、`packages/api/src/config/account-resolver.ts#resolveForClient`、`packages/api/src/config/provider-credential-policy.ts#assertProviderCredentialDestination`。
Consumer evidence: PR #6159 中运行 `rg -n --no-ignore 'registerCallbackMusicRoutes|musicTools|musicGenerationSchema' packages/api/src packages/mcp-server/src packages/shared/src`，覆盖注册、callback、service 与共享输入契约。
Claim guard: `packages/api/test/music-generation-journey.test.ts` 经真实本地 HTTP 走 MCP→callback→service→文件；权限、路径、凭据目的地、格式与不重试边界分别由同 PR 的 `callback-music-routes.test.ts`、`music-generation.test.ts`、`music-tools.test.ts` 保护。Google 返回在自动测试中使用 fixture，不替代真实生成验收。

### Phase B: 网页通道（Chrome）出音乐和视频

视频走 Flow 网页里的订阅额度（Veo），音乐也可以走 Flow Music 网页。做法与家里的 GPT Pro 插件一致：复用 F247 的 Chrome 扩展、本机助手和配对授权，为 Flow / Flow Music 加页面适配器。流程是：填提示词 → 生成 → 等待 → 下载 → 文件回到家里。首次安装和授权之外，You 不需要再操作。

### Phase C: 其他网页能力（按消费者需要再定）

Gemini 网页里的 Argon 做成能在 thread 里说话的云端猫（像 gpt-pro）、NotebookLM、Project Genie 等。由第一个真实消费者（脑洞大会 thread 的游戏）提出需要后，再补具体范围和 AC。

## User Journey

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
- [ ] AC-A1: 猫用一条提示词调用音乐生成，得到 MP3 或 WAV，落到指定目录，附模型、提示词、时间与费用口径的来源记录；You 不操作网页。
- [ ] AC-A2: 额度不足、被拒、超时时，调用方拿到明确的失败原因，不静默、不自动重试刷额度。
- [ ] AC-A3: 在 operator `private-source-id` 的 API 许可下，真实核对所用账号、API 认证来源与费用归属，不能用模拟 token、代码单测或网页登录状态替代。原稿将 OAuth 纠偏写成 Cloud OAuth 前置，已按后续原话撤回；后续 `private-source-id` 新明确选择 Google Cloud，必须核实 Cloud 项目及赠金关联，不能倒推为此前网页 OAuth 解释正确，不能静默借用其他账号或 AGY 私有 token。

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

## Review Gate

- Phase A：非作者猫 review；用真实额度跑一次生成作为证据。
- 本轮代码 review 已通过：reviewer `gemini-argon`，HEAD `786fc371e574dd11aea3e1e367561d64d7b683b6`，accepted source revision `17bb4fe946e7daeb02aa63b95808ae6d034b057d`，durable fact `local-review:private-source-id:approved`。批准仅覆盖代码与契约；实际音乐验收仍未通过。
- OAuth 修正代码已独审批准：reviewer `gemini-argon`，HEAD `c0b30645c54c766fdf88d163f71023db328a79b8`，accepted source revision `025ea95452518f66d754ca1590d00b536fc458ab`，durable fact `local-review:private-source-id:approved`。作者已核验相同代码与需求；本次共享状态只登记批准和未验边界，无新实质内容，不为 ACK 重新唤醒 reviewer。
- 下一动作：在指定账号完成首次 Cloud 授权后，仅通过后台 API 核实项目/结算账号/赠金，配置 Cloud 接点并执行单次样张验证。禁止充值、自动扣款与抢占前台；若授权未完成，诚实保留配置缺口。旧批准只覆盖历史 Gemini API 候选，后续 Cloud 接入修正需要风险匹配的验证和独立 review；真实音频与费用验收通过才进入适用的 merge-gate。PR 保持 draft，不把 API 交付写成网页插件已完成。
- Phase B：沿用 F247 Chrome Host 的审查口径；在 You 日常 Chrome 上做一次真实旅程验收。
