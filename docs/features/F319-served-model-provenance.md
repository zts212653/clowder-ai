---
feature_ids: [F319]
related_features: [F061, F306, F212, F254]
topics: [codex, provider-identity, observability, cost]
doc_kind: spec
created: 2026-09-21
description: "每条 Codex 回复携带上游实际应答的模型（servedModel），与请求的 slug 不一致时对猫和operator可见，成本按实际模型记"
description_source: human
description_author: fable-5
description_updated_at: 2026-09-21T08:20:00Z
---

# F319: Served Model Provenance｜请求的模型 vs 上游实际应答的模型

> **Status**: **failed-close (partial-value-preserved) 2026-09-24** — 已合入的 Phase A–F（`servedModel` 落账、徽标、换模提示、猫能看到的 `⚠` 标记）保留、零成本继续运行；「可靠识别上游实际应答模型」这个目标做不到了：上游收掉了 `response.model`（改为回显）和 turn-state（改为加密令牌），剩下能用的信号全部由上游控制。operator 签字见 Close Summary | **Owner**: Ragdoll (fable-5 → opus55 收口) | **Priority**: P0

## Why

operator 2026-09-21 原话："打开猫咖有消息进来你可能就会找Maine Coon，但是天知道是皮套Maine Coon还是正版Maine Coon……他会用 luna 收星星的价格。"

Clowder AI 的信任建立在"签名 = 那只猫"上（铁律 3）。今天这条链在供应商那一层是断的：我 @ 星星做架构 review，收回来的可能是另一个模型写的意见，签名却是星星，成本账本也按星星记。猫不知道，operator不知道，事后也追不回来。本 feature 让"上游实际应答的是谁"成为每条消息上可回查的事实，而不是 config 回显。

## Current State / 现状基线

实测（2026-09-21，codex-cli 0.155.1，ChatGPT OAuth，证据 `~/Desktop/openai-model-routing-evidence-2026-09-21/`，方法见 memory `reference_codex_served_model_observation`）：

- 06:29–06:53Z：请求 `gpt-6-astra` 的 5/5 条新 thread，上游 `response.created` / `response.completed` 的 `response.model` = `gpt-5.6-luna`；同窗口各 slug 共 16 次请求里 6 次 `server_is_overloaded`。
- 07:04–07:07Z：同一命令 4/4 回 `gpt-6-astra`。
- 对照 `gpt-5.5` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` 全程回声自身。
- 同一 prompt 下 luna 应答与 astra 应答的行为可区分（iPhone 15 vs iPhone 17）；模型自报的 knowledge cutoff 不可信（sol 自报 June 2024 却答对 2025-09 的 iPhone 17）。
- 全程无用户可见提示：ChatGPT 后端不发 `openai-model` 响应头，而 Codex 0.155.1 只从这个头触发 `ModelReroute`，不看 `response.model`（`codex-rs/codex-api/src/sse/responses.rs` 只在 `trace!` 里转储原始 SSE）。

Clowder AI 侧：

- `MessageMetadata.model` = 请求的 `cliModel`（`CodexAgentService.ts:1691`），成本估算把它当"actual model that ran"（`CodexAgentService.ts:2650` 注释原文）。
- `MessageMetadata.modelVerified`（F061）存在但 Codex 路径从不设置。
- `cli-spawn.ts:594` 把子进程 stderr 无上限拼进 `stderrBuffer`；stderr 只用于退出诊断，没有行级观察点。
- **载体（2026-09-21 Phase A 合入后纠正）**：立项时写"当前生产载体是 `exec_json`"是只查了 cat-config 与仓库 `.env`；alpha 验收（thread `[thread-id]`）证明进程环境里 `CAT_CAFE_CODEX_CARRIER=app_server`（继承自登录 shell），alpha 与生产实际跑 **app_server**，Phase A 的 exec_json 观测对该路径零覆盖——sol 在 alpha 回了 OK，消息 metadata 无 `servedModel`。默认 OAuth 传输 `builtin`（websocket），该路径上 stock 二进制观测不到 `response.model`；HTTPS 传输（`CAT_CAFE_CODEX_OAUTH_TRANSPORT=https`，2026-07-01 事故留下的回退开关）路径上 `RUST_LOG=codex_api::sse::responses=trace` 会逐条转储 SSE 事件。app-server host 的启动参数已含同一套 provider args，env 已含同一 `RUST_LOG`（Phase A 的 `codexEnv` 派生），只是 host stderr 只留 8 KB、无人消费。

- **认证标签（2026-09-21 AC-B4 第二次 FAIL 后纠正）**：alpha 与生产共用 `~/.cat-cafe`（`cat-catalog.json` / `accounts.json`）。Codex 猫（`codex-sol` 等）没有 `accountRef`，默认账号遍历（`account-resolver.ts` `resolveForClient`，clowder-ai#340 有意优先带凭据的账号）选中 `installer-openai`（api_key）而不是 `codex`（oauth）→ `callbackEnv.CODEX_AUTH_MODE = api_key`（alpha 日志 `[codex-diag] Auth + env setup` 10:00Z / 10:11Z / 10:42Z 三次都是 `authMode: api_key, customBaseUrl: null, hasOpenaiKey: true`）。而 Codex 二进制自己的凭据优先级（codex-rs `login/src/auth/manager.rs` `load_auth`，2026-08-23 clone）是 `CODEX_API_KEY` env → 临时存储 → `auth.json`（ChatGPT 登录），`OPENAI_API_KEY` env 排在 `auth.json` 之后：本机 `auth.json` 在，请求实际仍由 ChatGPT 订阅签发（应答 `gpt-5.6-sol`；今晨 refresh token 被吊销时 sol 立刻断）。**Clowder AI 的认证标签 ≠ 线上认证**。Phase A/B 的观测开关条件 `authMode === 'oauth'` 因此在 alpha 上恒为 false → 全程"未观测"；生产与 alpha 走同一 resolver、同一份 catalog / accounts，标签结果应相同（**推论**，未直接读生产日志——runtime 圣域；kimi Phase B.1 R1 ④）。AC-A7 的第一次 FAIL 也同时含此因（当时只归因到载体）。Phase B.1 把观测条件改为"无自定义 base_url"，与标签解耦。**更正（2026-09-22 03:0xZ，opus5，Phase D 取证）**："alpha 与生产共用 `~/.cat-cafe` 的 catalog"与"生产同源推论"都不成立：catalog 路径是 `<projectRoot>/.cat-cafe/cat-catalog.json`（`cat-catalog-store.ts` `resolveCatCatalogPath`），只有 accounts/services 等是全局的。alpha 读 `cat-cafe-alpha/.cat-cafe/cat-catalog.json`（2026-09-20 生成，Sol 仍是 `maine-coon` 下的 variant `codex-sol`、无 `accountRef`，无独立 `codex-sol` breed）→ 默认遍历 → `installer-openai`。生产读 `cat-cafe-runtime/.cat-cafe/cat-catalog.json`（只读 Read 核对）：`maine-coon` 只剩 `codex-default/gpt52/spark`，`codex-sol` / `codex-terra` / `codex-luna` / `codex-astra` 都是独立 breed、默认 variant `accountRef: codex`（oauth）——**生产标签本来就是 oauth**（由数据 + 代码推出；生产 `[codex-diag]` 日志圣域未读）。同形 catalog 副本在 alpha dist 上跑 `loadResolvedCatConfig` + `toAllCatConfigs`：`codex-sol` → `{breedId: codex-sol, isDefaultVariant: true, accountRef: codex}`，`removeUnavailableTemplateVariants` 已按 catId 占用剔除模板里的遗留 variant。

- **上游头信息核查（2026-09-21 晚，operator问 Sub2API 0.2.6 说的"292 位 `x-codex-turn-state`"）**：codex-rs `core/src/client.rs`（2026-08-23 clone；0.155.1 二进制含同名字符串）——`x-codex-turn-state` 是**同一 turn 内的 sticky-routing 票据**：turn 开始时服务端在响应头下发，客户端在该 turn 后续请求（重试 / 续传）里原样回传，注释明写 "must not send it between different turns… can cause routing bugs"。源码里没有任何"长度 = 路由类别 / 流控"的语义；"292 位 = 正常路由，否则流控"只是 Sub2API（订阅额度分发 / 中转产品，有直接利益）发布说明里的经验说法，无一手依据；它们"后台采集并在生产请求中复用 1 小时"恰恰是跨 turn 复用票据，属于中转行为，与本 feature 的硬约束（不加代理 / 不碰 token）相悖。stock 二进制不记录响应头（`codex_api::sse::responses` trace 只转储 SSE 事件），要拿到它得给 codex 打一行 trace 补丁；作为信号它弱于已有的 `response.model`。另：0.155.1 含 `x-codex-safety-buffering-enabled / -faster-model` 头与 `model/safetyBuffering/updated` 通知——那是 OpenAI 公开的「生物 / 网络安全请求附加安全检查」机制（help 20001326：请求被额外审查时客户端可**选择**换更快模型重试，用户可见），alpha 日志从未出现该通知（生产日志圣域未读），与我们观察到的静默 `response.model` 替换不是同一机制。

- **websocket 帧观测（2026-09-21 23:5xZ，operator提议"看 websocket 帧里 response.metadata 的 x-codex-turn-state"）**：stock 0.155.1 在默认 builtin（websocket）传输上，`RUST_LOG=tungstenite::protocol=trace` 会把每个帧的 JSON 打到 stderr（payload 只出现在 `tungstenite::protocol` target，每 turn ~18 行；`tokio_tungstenite` / `compat` / `deflate` target 只是噪声）。`codex.response.metadata` 帧带 `headers`（`x-codex-turn-state` / `x-codex-safety-buffering-enabled` / `x-codex-safety-buffering-faster-model` / `x-models-etag`），`response.created` 帧带 `response.model` **和 `prompt_cache_key`**（Phase B 注册表关联字段）。HTTPS SSE 流里没有 `response.metadata` 事件（turn-state 在 HTTP 头里，stock 不记录）。实测三组（own OAuth，"Reply exactly OK"）：sol→sol / terra→terra / **astra→luna**；三组 `x-codex-turn-state` 长度**都是 312**，`safety-buffering-enabled=true`、`faster-model=gpt-5.6-luna` 三组相同——**票据长度与 safety-buffering 头都不携带换模信息**；"292 位 = 正常路由"在本账号 / 本版本上不成立。`model_verifications` 在源码里只有 `TrustedAccessForCyber`（账号资质），与权重无关。结论：per-turn 可得的仍是上游自述 `response.model`；但观测可以回到默认 websocket 传输（去掉 F319 强加的 HTTPS 覆盖）→ Phase B.2。原始 trace 含握手头，提取后已清空，不入库。

- **行为指纹实验（2026-09-22 00:1x–01:4xZ，operator给的 ModelTrace，xqy2006/ModelTrace）**：方法 = 三道"凭第一反应输出 292/319/323 个 1–355 整数"挑战，数字分布 Hellinger 相似度 + 有序区块特征，softmax 归因到 13 模型库（gpt-5.4/5.5/5.6-sol/terra/luna/6-astra + Claude 系；作者自述"非决定性证据、system prompt 影响大"）。我用 `codex exec -m <model>`（own OAuth、stock 0.155.1、默认 websocket，每条应答的 `response.model` 一并记录）跑五组，答案喂回它的本地计算：

  | 请求 | 每条 `response.model` | ModelTrace 归因 | 相似度 top / 自身条目 |
  |---|---|---|---|
  | gpt-5.6-luna（同代对照） | luna ×3 | luna 99.8% | 85.5 / —（sol 83.7） |
  | gpt-5.6-sol | sol ×3 | **luna** 100% | 87.0 / sol 84.9 |
  | gpt-5.6-terra | terra ×3 | **luna** 100% | 84.6 / terra 81.3 |
  | gpt-6-astra | luna ×3（协议层替换） | luna 100% | 80.9 / astra 78.6 |
  | **gpt-5.5（跨代对照）** | 5.5 ×2 | **luna** 100% | 82.9 / 5.5 79.6（第 5 名） |

  **结论**：跨代对照失败——工具连库里有的 gpt-5.5 都归到 luna，说明在我们的环境（codex exec 的 developer instructions + 采样）里它测到的是"GPT-5.x 家族 + 环境方向"，不是兄弟模型的权重差；所有 5.x 输出的开头都是同一串（`247, 18/19, 331…`）。因此 "sol / terra 指纹像 luna" **既不能支持也不能否定**"上游自述 sol 实际是 luna"的怀疑；论坛用户用同一工具得到的 "4 轮 sol / 6 轮 luna" 也受同样限制。当前能拿到的最硬信号仍是协议层 `response.model`（能抓上游承认的替换 astra→luna，抓不到不承认的）；权重级验证在用户侧不可得（客服回信亦明说不识别 "underlying physical weights"）。原始输出在 `/tmp/mt-*.out`（不入库）。

## What

### Phase A: exec_json 载体上的 servedModel 事实

1. **观测通道**：Codex OAuth 且开启本功能时，spawn 时注入 `RUST_LOG=codex_api::sse::responses=trace` 并强制 HTTPS 传输 provider args（复用现有 `openai_https` 参数集）。`cli-spawn` 新增 `onStderrLine` 观察点（行级、不缓冲、不影响 timeout/liveness），并把 `stderrBuffer` 改为有界尾部（保留退出诊断语义）。
2. **解析**：只认 `SSE event: {"type":"response.created"|"response.completed"|"response.failed", ...}` 行，提取 `response.id` / `response.model` / `response.prompt_cache_key`；解析失败 = 独立"未观测"态，不折叠成默认值。
3. **落账**：`MessageMetadata` 新增 `servedModel?: string`、`servedModelSource?: 'sse_response_object'`、`servedResponseId?: string`；观测到时 `modelVerified = true`。成本估算改用 `servedModel ?? model`。
4. **不一致可见**：`servedModel` 与请求 `model` 大小写无关不等时，发一条 F306 已有契约的 `warning` 语义事件（`category: 'model_reroute'`, `severity: 'warning'`），消息正文说明"请求 X，上游应答 Y"；同时 `MetadataBadge` 在 `servedModel` 存在且不等于 `model` 时显示 `X → Y（上游应答）`。
5. **开关**：`CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION=on|off`，默认 `on`（operator 2026-09-21 明确要现在做）；`off` 时行为与今天完全一致（不改传输、不加 RUST_LOG）。env-registry 登记。

### Phase B: app-server 载体

暖池 host 一个进程多 thread，stderr 在 `spawnCodexAppServerHost` / `DirectAgentCarrierSession` 只留 8 KB。Phase B：两条 app-server spawn 路径都把 stderr 换成 `createStderrTail`（尾部仍 8 KB，逐行喂给进程级 `codexHostServedModels` 注册表），注册表按 `prompt_cache_key`（= Codex thread id）保存最新观测（有界 2000 条）；invocation 收尾时用 `metadata.sessionId`（= Codex thread id）查注册表，**只接受本次 invocation 开始之后的观测**（`sinceMs` 围栏，避免把上一 turn 的观测算到这一 turn 头上），命中则与 Phase A 同路落账 + 发 `model_reroute`（provenance carrier=`app_server`）。已知简化：仍是 message 级、取最新一次 response（同 P3-2）。

### Phase B.2: 观测回到默认 websocket 传输（2026-09-21 立项）

去掉 Phase A 强加的 `openai_https` 传输覆盖，改为在 Codex 原生 builtin（websocket）传输上用 `RUST_LOG=…,tungstenite::protocol=trace` 观测帧：`response.created`（`response.model`、`prompt_cache_key`）与 `codex.response.metadata`（`x-codex-turn-state` 长度、safety-buffering 头）。每 turn 落 `servedModel`（语义不变）+ `upstreamTurnStateLength` + `upstreamSafetyBufferingFasterModel` 进 metadata；徽标逻辑不变（不一致 `A → B`），tooltip 改为"上游自述，非权重指纹"。`off` 仍精确回旧启动。风险面比 Phase A 小（不再改传输）。

### Phase B.3: 载体感知的传输（2026-09-22 立项，B.2 的 alpha FAIL 修正）

B.2 合入后 alpha（app_server）验收 FAIL：host 环境里 `RUST_LOG` 两条指令都在，但 `codex app-server` 的 stderr 里没有任何 tungstenite 帧行（直连 app-server smoke 复现 `registrySize=0`；`codex exec` 同一指令能出帧）。两个二进制的 tracing 初始化都只装 stderr fmt layer + `EnvFilter`，差别在 `log` crate 记录（tungstenite 用 `log`）是否桥到 tracing——exec 有，app-server 没有（实测；机制推断，未读到显式 `LogTracer` 差异）。因此 app_server 载体上 websocket 帧不可观测，只有 HTTPS SSE trace 可观测。修正：`observeServedModel && carrierMode === 'app_server'` → 强制 `openai_https`（B.1 行为）；exec 载体保留 B.2；`off` 不变。**教训**：验证观测通道必须用生产载体的那个二进制（app-server）跑一次，exec 上的结论不迁移。

> **B.3 根因更正（2026-09-22 03:05Z，opus5，B.4 实测）**：上面"app-server 不把 `log` 记录桥到 stderr"是错的。原生 JSON-RPC 直连 `codex app-server --stdio`（stock 0.155.1、默认 websocket、`RUST_LOG=error,tungstenite::protocol=trace,codex_api::sse::responses=trace`），stderr 里 19 条 `Received message {…}` 解码帧齐全（含 `codex.response.metadata` 的 `x-codex-turn-state`）。真正的差异是 **ANSI 颜色**：app-server 的 fmt layer（`app-server/src/lib.rs` 0.155.1）从不关 ansi，exec 的 fmt layer 在 stderr 非 tty 时关（`exec/src/lib.rs` `with_ansi(stderr_with_ansi)`）；于是 app-server 行里 `tungstenite::protocol` 与 `:` 之间夹着 `ESC[0m ESC[2m`，我们的标记 `'tungstenite::protocol: Received message '` 永远不命中。`SSE event: ` 是连续串，所以 B.3 的 HTTPS 路径能匹配——B.3 "修好了"是巧合绕开，不是对根因的修复。B.2 alpha FAIL 的 `registrySize=0` 同源。

### Phase B.4: 生产载体拿回 turn-state（2026-09-22 立项并完成实现）

解析器在找标记前剥掉 SGR 转义（合法 JSON 不含裸 ESC，剥除不伤 payload）；撤掉 B.3 的 `observationForcesHttps`，两个载体都回到 Codex 原生 builtin websocket（即 F319 之前的传输）+ trace。生产 app_server 由此每 turn 同时拿到 `servedModel`（source=ws）与 `upstreamTurnStateLength`；运维 HTTPS 回退开关（`CAT_CAFE_CODEX_OAUTH_TRANSPORT=https`）照旧可用，此时只有 servedModel、turn-state 为「未观测」（HTTPS 头不进 trace）。

### Phase E: 徽标三事实（2026-09-22 立项，OQ-4 已批）

`MetadataBadge` 在**有 `servedModel`（本 turn 被观测过）**时显示三个原始事实，不下判断：① 自述与请求一致 → 轻量 ✓，tooltip「上游自述一致（response.model，非权重验证）· turn-state N」；不一致 → 仍 `A → B（上游应答）`；② `upstreamTurnStateLength` 可见（`turn-state N`），缺省写「turn-state 未观测」而不是隐藏——生产 app_server（HTTPS）上当前恒为未观测，这正是要让人看见的事实；③ 所有文案"非权重指纹 / verified"统一为"自述 / 非权重验证"。无 `servedModel` 的消息（非 Codex、观测关闭、没抓到）渲染与 F319 前完全一致——没有 ✓ 本身就是"没核"的信号，不在这些消息上刷"turn-state 未观测"噪音。`modelVerified` 字段名不动（F061 契约）。

### Phase F: 换模事实送到猫手里 + 警告贴回原回复（2026-09-22 立项，operator批）

**缺口（opus55 查证）**：Primary Journey 第 3 步「猫在同一 thread 里读到这条事件」从未实现——`model_reroute` 警告是纯实时 UI 事件：`provider_signal→system_info` 没有 `content`，`route-serial` 的持久化只收 `content`，于是不落库（刷新即消失）；即便落库，prompt 历史（`assembleIncrementalContext` / `assembleContext`）也过滤 system 消息；而所有给猫看的发言人标签只读 config（`getSenderName`），不读 `metadata`。AC-A4 只验了"产出事件"，没验"猫收到"。

**修法**：真相源就是已持久化的 `metadata.servedModel`（vs `metadata.model`），不另存警告。新增 `servedModelMarker` / `getMessageSpeakerName`：自述与请求不一致时发言人标签加 ` ⚠上游实际应答=<served>`，一致 / 未观测 / 请求模型未知 / 人类消息一律无标记（诚实未知不是换模证据）。覆盖猫读历史的全部入口：prompt 历史 `formatMessage`（含 reply-to 预览）、F148 anchors、`get_thread_context`（anchor / full / oversized）、`get_message`、`get_pending_mentions`。UI：删掉脱离原回复、刷新即失的蓝色 info 横幅（`model_reroute` 语义事件在前台 suppress），改为回复徽标内琥珀色 `⚠ 上游换模` 胶囊（tooltip：请求 / 实际应答 / response id，上游自述非权重验证），点开徽标可选中完整 response id。

### Phase C: 上游修复

给 openai/codex 提 PR：`openai-model` 头缺失时从 `response.created.response.model` 回退推 `ServerModel`，让现有 `ModelReroute` / warning / app-server `model/rerouted` 自动生效。合入后 Phase A 的 trace 通道可退役。

## User Journey

### Primary Journey: 看出这条回复是谁答的
- **Scope unit**: message
- **Actor**: operator / 猫猫
- **Entry**: 任意 thread 里一条 Codex 猫的回复
- **Flow**:
  1. 回复底部的 metadata 徽标平时显示 `gpt-6-astra · openai`（与今天一致）
  2. 当上游实际应答的模型不同时，徽标显示 `gpt-6-astra → gpt-5.6-luna（上游应答）`，同时消息流里出现一条 warning 语义事件"请求 gpt-6-astra，上游应答 gpt-5.6-luna"
  3. 猫在同一 thread 里读到这条事件，知道这一棒的 review 意见来自哪个模型
- **Success evidence**: 真实 Hub 里一条被替换的消息截图 + 一条正常消息截图；单测覆盖两种状态
- **Non-goals**: 不判断 luna 是不是 astra 的别名；不改 OpenAI 计费；不阻断或重试被替换的请求（Phase A 只做可见）

## 需求点 Checklist

| # | 需求点 | 来源 | AC |
|---|--------|------|----|
| R1 | 每条 Codex 消息记录上游实际应答模型 | operator 09-21 | AC-A1, AC-A2 |
| R2 | 不一致时猫和operator在消息现场看得见 | operator 09-21 "皮套Maine Coon" | AC-A4, AC-A5 |
| R3 | 成本按实际模型记 | operator 09-21 "luna 收星星的价格" | AC-A3 |
| R4 | 拿不到时诚实标未观测，不用 config 回显冒充 | operator 09-21 上一轮"不要拿 config 回显冒充" | AC-A2 |
| R5 | 可一键回到今天的行为 | 传输层变更风险 | AC-A6 |

## Acceptance Criteria

### Phase A（exec_json 载体上的 servedModel 事实）
- [x] AC-A1: `cli-spawn` 提供 `onStderrLine`，逐行回调、不进 `stderrBuffer` 上限之外、不重置 timeout；`stderrBuffer` 有界 — `packages/api/test/cli-spawn-stderr-line-tap.test.js`（4 项，含语义完成前已写入 stderr 的 drain 与 64 KB 尾部保留）
- [x] AC-A2: 给定含 `response.created` 的 stderr 行，`done` 消息 `metadata.servedModel` / `servedResponseId` 正确、`modelVerified === true`；无此行时三个字段缺省 — `packages/api/test/codex-agent-service-f319-served-model.test.js`
- [x] AC-A3: `metadata.usage.costUsd` 估算以 `servedModel` 为准 — 同上（请求 gpt-5.4、应答 gpt-5.3-codex，估算用后者价格）
- [x] AC-A4: 不一致时产出 `kind: 'warning', category: 'model_reroute'` 语义事件（`provider_signal`，先于 `done`），一致时不产出 — 同上
- [x] AC-A5: `MetadataBadge` 不一致时渲染 `model → servedModel（上游应答）`，一致或缺省时与今天一致 — `packages/web/src/components/__tests__/MetadataBadge-served-model.test.tsx`
- [x] AC-A6: `off` 时 spawn args / env 与 F319 之前一致；默认 on 时 HTTPS provider args + `RUST_LOG`（保留 codex exec 默认 `error,…` 再追加 trace）；API-key / 自定义 base_url 路径不受影响 — 同 AC-A2 文件 + `codex-agent-service.test.js` 原 transport 契约改为显式 off
- [ ] AC-A7: 真实 alpha 上一条 Codex 猫回复带 `servedModel`（截图 + Redis 记录）。**部署载体是 app_server，alpha 不跑 exec_json：本条在部署载体上由 AC-B4 覆盖；exec_json 只有下文的 worktree dist 级真机 smoke，若哪天切回 exec_json 再在 alpha 验，不在此假装勾掉。****worktree dist 级 smoke（2026-09-21 07:38–07:39Z，真实 codex 0.155.1 + ChatGPT OAuth）**：请求 `gpt-6-astra` 两次均遇上游 `server_is_overloaded`、codex exit 1，但 `servedModel = gpt-5.6-luna`（`resp_0b3524b5…`、`resp_025c8e8d…`）与 `model_reroute` 事件仍落账；对照 `gpt-5.6-sol` 完整回合 `servedModel = gpt-5.6-sol`、无事件、回复带Maine Coon签名

### Phase B（app-server 载体）
- [x] AC-B1: 进程级注册表按 `prompt_cache_key` 保存最新观测、有界、无 key 的行忽略、`sinceMs` 围栏生效 — `packages/api/test/codex-served-model.test.js`（Phase B describe，3 项）
- [x] AC-B2: app-server 载体（`carrierMode: 'app_server'`）的 invocation：host 在本次 invocation 期间的观测落到 `done.metadata.servedModel / servedResponseId / modelVerified`，不一致时先于 done 发 `model_reroute`（carrier=`app_server`）；invocation 之前的观测不被归属；`off` 时不查注册表 — `packages/api/test/codex-agent-service-f319-app-server-served-model.test.js`（3 项）
- [x] AC-B3: 两条 spawn 路径（`spawnCodexAppServerHost`、`DirectAgentCarrierSession`）的 stderr 诊断仍 8 KB、仍取最后 1000 字；**窗口由"前 8 KB（写满即停）"改为"后 8 KB"**——host 的 socket-ready 诊断点两者等价，直连会话的 exit excerpt 新版更优（kimi R1 ④ 纠正了我 packet 里"语义不变"的说法）— app-server 套件 216/219，3 项失败（`codex-app-server-interaction` Pencil consent ×1、`codex-app-server-pooling` credential path ×2）在 Phase A 同环境基线上同样失败、`OBSERVATION=off` 下同样失败，与本改动无关
- [x] AC-B4: 真实 alpha（app_server 载体）上一条 Codex 猫回复带 `servedModel`（Redis 记录 + 徽标截图）。**PASS（第三次，2026-09-21 11:35:39Z，alpha @ `b3ffd83f`，app_server 载体、暖池 host、resumed session `01a0c373…`）**：sol msg `private-source-id` metadata `servedModel=gpt-5.6-sol`、`servedResponseId=resp_053ef393…`、`servedModelSource=sse_response_object`、`modelVerified=true`；同 thread 前两条（10:11Z / 10:42Z）为 null，前后对照干净；alpha 日志 `[codex-diag]` 同刻 `authMode:api_key, servedModelObservation:on, oauthTransport:https`（AC-B6 在 alpha 落地）；截图 `.playwright-mcp/f319-alpha-b1-badge.png`（一致时徽标与今天相同，见 OQ-4）。**Phase B 合入后 alpha 第二次 FAIL（2026-09-21 10:42Z，sol msg `private-source-id`，`servedModel: null`）根因 = 认证标签 `api_key` 使观测开关恒关（见 Current State「认证标签」），不是载体问题；Phase B.1 解耦后重验。****worktree dist 级 smoke（2026-09-21 10:24Z，真实 codex 0.155.1 app-server 直连会话 + ChatGPT OAuth）**：请求 `gpt-5.6-sol` → `servedModel=gpt-5.6-sol`、无事件（`resp_0f052ff6…`）；请求 `gpt-6-astra` → `servedModel=gpt-5.6-luna` + `model_reroute` 事件（`resp_023acd01…`），注册表以 sessionId 命中

### Phase B.1（观测与认证标签解耦）
- [x] AC-B5: `CODEX_AUTH_MODE=api_key` 且无自定义 base_url 的 invocation，默认 on 时 spawn 带 `openai_https` provider args + `RUST_LOG` trace，`response.created` 行落到 `done.metadata.servedModel`（exec 与 app_server 两条路径）；自定义 base_url 路径仍不受影响；`off` 时 api_key 会话的启动与 F319 之前完全一致（不强制 HTTPS、不 pin builtin） — `codex-agent-service-f319-served-model.test.js`（+2）、`codex-agent-service-f319-app-server-served-model.test.js`（+1）；RED 在未改代码的 alpha dist（1fb59cd5）上只红这一项（"observation requires the HTTPS transport"）。**真实二进制 smoke（2026-09-21 11:09–11:11Z，codex 0.155.1 app-server 直连会话，标签 api_key + 环境里放假的 `OPENAI_API_KEY`）**：请求 `gpt-5.6-sol` → `servedModel=gpt-5.6-sol`（`resp_019ab855…`）、回复 OK；请求 `gpt-6-astra` → `servedModel=gpt-5.6-luna`（`resp_0274af91…`）+ `model_reroute` 事件。假 key 未生效 = Codex 用的是 `auth.json` 的 ChatGPT 登录，与源码优先级一致
- [x] AC-B6: `[codex-diag] Auth + env setup` 日志行带 `servedModelObservation`（`on` / `off:env` / `off:custom_base_url`）与 `oauthTransport`，在 alpha 日志里一眼能看出观测为何没开 — 上述 smoke 的日志行：`"authMode":"api_key",…,"servedModelObservation":"on","oauthTransport":"https"`

### Phase B.2（观测回到默认 websocket 传输）
- [x] AC-B2-1: 解析器同时识别 HTTPS `SSE event: {…}` 与 websocket `tungstenite::protocol: Received message {…}` 两种 stderr 行；`response.created/completed/failed` 给出 `servedModel / responseId / prompt_cache_key / safety_buffering`，`codex.response.metadata` 给出 `x-codex-turn-state` **长度**（token 本身不保留）与 safety-buffering 头；delta / 非 JSON 行 = 未观测 — `codex-served-model-ws.test.js`
- [x] AC-B2-2: 默认 on 时启动**不再强制 HTTPS**：OAuth 保持 builtin pin、api_key 标签无 provider 覆盖，`RUST_LOG` 同时带 `codex_api::sse::responses=trace` 与 `tungstenite::protocol=trace`；`off` 精确回旧启动 — `codex-agent-service-f319-served-model.test.js`、`codex-served-model.test.js`（RUST_LOG 契约）
- [x] AC-B2-3: metadata 帧归属规则：exec（单进程）归属到下一条 response；app-server host 流上只有**唯一**未消费帧且在 5 s 窗口内才归属，两帧并发即视为不明并丢弃（诚实缺省，不猜）；`done.metadata` 新增 `servedModelSource=ws_response_object`、`upstreamTurnStateLength`、`upstreamSafetyBufferingFasterModel`、`upstreamSafetyBuffering` — 同上两文件 + `codex-agent-service-f319-app-server-served-model.test.js`
- [x] AC-B2-4: 徽标逻辑不变（不一致 `A → B`），tooltip 写明"上游自述（response.model），非权重指纹"并带 turn-state 长度 — `MetadataBadge.tsx`
- [ ] AC-B2-5（**FAIL，转 AC-B3-2**）: 真实 alpha（app_server、默认 websocket 传输）上一条 Codex 猫回复带 `servedModel`（source=ws）+ `upstreamTurnStateLength`（Redis 记录 + 截图）

### Phase B.3（载体感知的传输）
- [x] AC-B3-1: `carrierMode === 'app_server'` 且 observation on 时启动强制 `openai_https`（回到 Phase A/B.1 的可观测路径），`RUST_LOG` 仍双指令；exec 载体不强制（保留 B.2 的 websocket 观测）；`off` 时两载体都精确回旧启动 — `codex-agent-service-f319-app-server-served-model.test.js`（+2）、`codex-agent-service-f319-served-model.test.js`（exec 不变）
- [x] AC-B3-2: 真实 alpha（app_server）上一条 Codex 猫回复带 `servedModel`（source=sse）— B.2 后的第四次验收（Redis 记录 + 截图）。**PASS 2026-09-22 02:13Z**（alpha @ `6d867211`，sol msg `private-source-id`：`servedModel=gpt-5.6-sol`、`servedModelSource=sse_response_object`、`modelVerified=true`、`resp_053ef393cc9116e5016ab1e45edacc87d1827859d123405760`；截图 `.playwright-mcp/f319-alpha-ac-b3-2-sol-servedmodel-badge.png`）

### Phase B.4（生产载体拿回 turn-state）
- [x] AC-B4-1: 解析器接受 ANSI 着色的 app-server stderr 行（真实 0.155.1 行形，token 以同长填充替换）：metadata 帧给出 turn-state 长度、response.created 给出 servedModel（source=ws）、着色 SSE 行仍可解析、host 注册表端到端归属；JSON 内 `\u001b` 转义不受影响 — `codex-served-model-ws.test.js`（+5，RED 4 项在未改解析器上失败；着色 SSE 一项本就绿）
- [x] AC-B4-2: app_server 载体 observation on 时**不再**强制 HTTPS：OAuth 保持 builtin pin、`RUST_LOG` 双指令；运维 `CAT_CAFE_CODEX_OAUTH_TRANSPORT=https` 仍生效；着色帧经 host 注册表落到 `done.metadata.upstreamTurnStateLength` — `codex-agent-service-f319-app-server-served-model.test.js`（B.3 强制 HTTPS 的断言改为 B.4 契约 + 新增 2 项；RED 2 项）；`off` 精确回旧启动的既有契约不变
- [x] AC-B4-3: **生产载体直连 smoke**（本 PR dist，真实 `codex app-server`、ChatGPT OAuth、标签 oauth，2026-09-22 03:11–03:12Z）：`gpt-5.6-sol` → `servedModel=gpt-5.6-sol`、`servedModelSource=ws_response_object`、`upstreamTurnStateLength=312`（`resp_0d3539b5…`）；`gpt-6-astra` → `servedModel=gpt-5.6-luna` + `model_reroute` 事件、turn-state 312（`resp_047f4bab…`）
- [x] AC-B4-4: 真实 alpha（app_server）一条 Codex 回复 metadata 带 `upstreamTurnStateLength`，徽标显示 `turn-state N`（依赖 Phase E 合入）。**PASS 2026-09-22 03:47Z**（alpha @ `0d3d96a6`，暖池 host、resumed session `01a0c373…`）：sol msg `private-source-id` metadata `servedModel=gpt-5.6-sol`、`servedModelSource=ws_response_object`、`upstreamTurnStateLength=312`、`upstreamSafetyBufferingFasterModel=gpt-5.6-luna`、`modelVerified=true`（`resp_053ef393…`）；徽标（页面重载后）`gpt-5.6-sol · openai✓ · turn-state 312`，截图 `.playwright-mcp/f319-alpha-ac-e3-b4-4-sol-turnstate-badge.png`；同刻 `[codex-diag]` `authMode:oauth, servedModelObservation:on, oauthTransport:builtin`（Phase D alpha 数据修正生效）。**发现**：实时到达时徽标不显示任何 served 事实，重载后才有 → Phase E.1

### Phase E（徽标三事实）
- [x] AC-E1: 观测到且一致 → ✓ + 可见 `turn-state N` + tooltip「上游自述一致（response.model，非权重验证）· turn-state N」；一致但无长度 → 可见「turn-state 未观测」（`data-turn-state="unobserved"`），长度 0 是观测值不是未观测；不一致 → `A → B（上游应答）` + 长度、无 ✓；请求模型缺失 → 无 ✓（没有可比对象），tooltip「上游自述 X · 请求模型未知」（kimi R1 P2）；非有限长度 = 未观测；无 `servedModel` → 可见文本与 F319 前逐字相同；任何状态不出现 verified / 已验证 / 已核对 — `packages/web/src/components/__tests__/MetadataBadge-served-model.test.tsx`（10 项；R0 RED 5 项、R1 RED 1 项在修复前失败）
- [x] AC-E2: author 视觉预览四态（一致有长度 / 一致未观测 / 不一致 / 未观测消息）— `.playwright-mcp/f319-phase-e-badge-three-facts-preview.png`（Hub Tailwind + token CSS 静态渲染）
- [x] AC-E3: 真实 alpha 一条 Codex 回复徽标显示 ✓ + turn-state 事实。**PASS（重载后）2026-09-22 03:50Z**：见 AC-B4-4 同一条消息与截图；B.4 合入后 app_server 上是 `turn-state 312`，而非立项时预期的「未观测」；同 thread 两条 B.3 时期（HTTPS）的旧消息如实显示 `✓ · turn-state 未观测`。实时路径缺口见 Phase E.1

### Phase E.1（served 事实走实时通道）
- [x] AC-E1-1: 根因——实时气泡的 metadata 只来自首个 text 事件（provider/model）与 `invocation_usage`（usage）；served 事实只在 `done.metadata`，前台 `setMessageMetadata` 又是先写者赢，于是实时气泡永远拿不到，只有历史重载（Redis 整对象）才有。修法：API 在 `invocation_usage` 上附 `served`（仅观测到时出现，字段原样），web 两个处理点合并进消息 metadata（前台新增合并式 `mergeMessageServedFacts`，后台用已有的合并 setter）；类型不符的字段丢弃不强转，无 `servedModel` = 未观测、不出现 `served` 键 — `packages/api/test/invoke-single-cat.test.js`（+2，RED 1 项：去掉 payload 一行即红）、`packages/web/src/lib/__tests__/served-model-facts.test.ts`（3）、`useAgentMessages-invocation-usage-footer.test.ts`（+2）、`useAgentMessages-background.test.ts`（+1）、`chatStore-usage.test.ts`（+2）；web RED 4 项
- [x] AC-E1-2: 真实 alpha 上一条 Codex 回复**不刷新**即显示 `✓ · turn-state N`。**PASS 2026-09-22 04:50Z**（alpha @ `b685584d`，新 API 进程 04:48:43Z 启动）：sol msg `private-source-id`，页面打开后未重载（`performance` navigation 条目 = 1），实时气泡即为 `gpt-5.6-sol · openai✓ · turn-state 312`、tooltip「上游自述一致（response.model，非权重验证）· turn-state 312」；Redis metadata `servedModelSource=ws_response_object`、`upstreamTurnStateLength=312`（`resp_053ef393…`）；截图 `.playwright-mcp/f319-alpha-ac-e1-2-live-turnstate-no-reload.png`

### Phase F（换模事实送到猫手里）
- [x] AC-F1: 猫读到的发言人标签在换模时带 `⚠上游实际应答=<served>`，一致 / 未观测 / 请求未知 / 人类消息不带 — `packages/api/test/f319-served-model-attribution.test.js`（5 项：marker 判定、上游字符串注入防护（`]`/换行/U+2028/控制字符/超长 → slug 字母表 + 64 上限，sol R1 P1，RED 已观测）、prompt 历史 `formatMessage`、reply-to 预览、F148 anchors；RED 4 项已观测）、`callback-routes.test.js`「F319 Phase F」（thread-context anchor/full + get-message）
- [x] AC-F2: 徽标内琥珀色「上游换模」胶囊（设计 SVG 三角图标，过 `test:guards` 无原始字形，sol R1 P1），一致 / 未观测 / 请求未知不出现；`model_reroute` 不再生成独立横幅；展开后完整 response id 渲染在 `<button>` 之外（button 内文字在 Chromium 不可选中，浏览器实测）— `MetadataBadge-served-model.test.tsx`（+3，RED 1 项）、`useAgentMessages-telemetry-suppression.test.ts`（+1）。**浏览器实测（2026-09-22 18:05Z，worktree `next dev :5132` 临时 dev 页挂真实组件，未提交）**：640/360/260px 三宽度左对齐换行、`turn-state N` 与胶囊不断词；胶囊 `title` = 请求 / 实际应答 / response id；点徽标展开 → 双击 id 得 `window.getSelection()` = 完整 `resp_…`（修前 button 内为空串）；截图 `.playwright-mcp/f319-phase-f-badge-widths-r2.png`、`f319-phase-f-badge-r3-640-id-selected.png`
- [ ] AC-F3: 真实 alpha 上一条被换模的 Codex 回复：徽标胶囊可见、无蓝色横幅；下一只猫的 prompt / `get_thread_context` 里该条发言人带标记（换模不可控，需等真实 reroute 发生或用本账号 astra 触发）

## Dependencies

- **Evolved from**: F061（`modelVerified` 字段，Codex 路径从未填过）
- **Related**: F306（`model_reroute` 语义事件契约已在 AC-C3 落地，本 feature 是它的第一个真实生产者）、F212（cliDiagnostics 用 stderr，本 feature 给 stderr 加上限须保留其语义）、F254（OAuth 传输开关的来历）

## Risk

| 风险 | 缓解 |
|------|------|
| 强制 HTTPS 传输改变 Codex 的重连/恢复行为（2026-07-01 事故正是在 websocket 上，HTTPS 是当时的稳定回退） | 默认 on 但一个 env 回退；alpha 验收观察一天 |
| `codex_api::sse::responses=trace` 每个 delta 一行，长 turn 数 MB stderr | 行级消费即丢，`stderrBuffer` 有界；只解析三种事件类型 |
| Codex 升级改了 trace 行格式 → 静默变成"未观测" | `servedModel` 缺省 = 诚实态；alpha smoke 断言至少一条消息有 `servedModel`，格式漂移时红 |
| 与 PR #3467（stale，8 月）在 `cli-spawn.ts` 冲突 | 该 PR 一个多月未动，合入时 rebase |
| 定价表没有 5.6/6 系列条目 → 成本仍 null | 不在本 feature 编造价格；OQ-1 |
| 一个 turn 含多次上游 response（工具循环）时只记最后一次的模型；A→B→A 的中途替换不可见，整 turn token 按最终模型估价 | Phase A 有意的 message 级简化（kimi R1 P3-2）；需要 per-response 账时另开切片，不在本 feature 假装做到 |
| stderr 行观察者的半行 carry 在无换行流下可能无界增长 | `stderr-tail.ts` 半行上限 4 MiB（`DEFAULT_STDERR_MAX_LINE_CHARS`），超限整行丢弃、观察者不见、尾部仍有界（kimi R1 P3-1，已修） |
| Phase B 注册表的 `observedAt` 是落库时刻不是上游事件时刻：上一 turn 迟到的 stderr 行若在本 invocation 开始后才入管道，会被本 turn 归属（同 thread、通常同模型，最坏一条陈旧 reroute warning） | 窗口 = 管道延迟（亚秒）；接受为已知简化（kimi Phase B R1 P3-1），出现真实误报再改为按 response id 去重 |
| 暖池 host 的环境在出生时定型：F319 之前出生的 host 不出 trace → 诚实缺省；带 trace 出生的 host 对后来 `off` 的 invocation 照出 trace 但不查表 | 行为自洽（kimi Phase B R1 P3-2）；`pnpm runtime:restart` 后所有 host 按当前开关重生 |
| 存量红测试 3 项（`codex-app-server-interaction` Pencil consent ×1、`codex-app-server-pooling` credential path ×2）在本机环境与 Phase A 基线同样红 | 不属于 F319 的 AC；作为家里的存量债记录在此，待 owner（kimi Phase B R1 P3-3） |
| 观测与认证标签解耦后，标签为 `api_key` 的会话（本机默认遍历的结果）在 on 时也走 HTTPS 传输 + trace | `openai_https` 只是 builtin `openai` 的 HTTPS 副本（`requires_openai_auth=true`），凭据仍由 Codex 自己按其优先级选；无 `auth.json` 的纯 API-key 用户本来就走 HTTPS；自定义 base_url 仍排除；`off` 精确回到旧启动（AC-B5 有 off + api_key 的契约测试） |
| `CODEX_API_KEY` env 的优先级高于 `auth.json`（codex-rs `load_auth` 第一分支；kimi Phase B.1 R1 ②）：谁在子进程环境设了它，签发人就换成 API key，而 Clowder AI 的标签仍写 oauth | 本仓 callbackEnv 只传 `OPENAI_API_KEY`、不传 `CODEX_API_KEY`；`[codex-diag]` 的 `envKeysCallbackEnv` 会列出所有 key 名，出现 `CODEX_API_KEY` 即异常信号；servedModel 观测本身不受影响（看的是应答对象） |
| Phase B.2：上游在重试 / 错误路径上可能不发 `codex.response.metadata` 帧，或 host 流上帧与 response 错配 | metadata 帧只影响 informational 字段（turn-state 长度、safety-buffering 头）；`servedModel` 始终按 `prompt_cache_key` 键控，不受帧归属影响；并发帧按不明丢弃（kimi Phase B.2 R1 ①） |
| Phase B.2：两条 trace 指令各管一条传输（`tungstenite::protocol` 只在 websocket 出帧，`codex_api::sse::responses` 只在 HTTPS 出事件），另一条传输上静默——按 RUST_LOG 语义推断，未做双传输并跑实测 | 任一传输都有观测通道，无盲区；若某版本 codex 改了 logger target，退化方向是"未观测"（诚实缺省），AC-B2-5 alpha 验收即是实机核对（kimi Phase B.2 R1 ②）。**实测 FAIL（AC-B2-5，2026-09-22）**：`codex app-server` 不把 tungstenite 的 `log` 记录桥到 stderr，websocket 通道在该载体静默——"无盲区"不成立；Phase B.3（PR #4688）改为载体感知：app_server 观测时强制 HTTPS/SSE，exec 保留 websocket。**再更正（B.4）**：app-server 其实照常出帧，只是 ANSI 着色让标记失配；B.4 剥 SGR 后两载体都回到 websocket 观测 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不改 Codex 源码、不打补丁二进制，用 stock 二进制自带的 trace 转储 | 投诉材料要求"官方未修改客户端"；本机无 Rust 工具链；灰猫的未编译 Rust 改动已回滚 | 2026-09-21 |
| KD-2 | 复用 F306 `model_reroute` 语义事件而不是新 UI | 契约已存在且已被 Workspace 消费；坐标变换不是堆项 | 2026-09-21 |
| KD-3 | 默认 on | operator明确"现在需要做"；一个 env 可回退 | 2026-09-21 |

## Design Gate

- 类型：纯后端 + 叠加一个既有徽标的文案状态（Trivial 级 UI 增量，不改布局）
- Architecture cell: `identity-session`
- Map delta: none
- Why: 扩展该 cell 已有的 agent identity 真相（F061 `modelVerified`）为"请求 vs 应答"两个值，不新增 owner / store / 通道
- 猫咖离线（2026-09-21），无法拉猫讨论；纯后端契约按 KD-1..3 自决，review 阶段补跨个体审视
- in_context_observability: `primary_surface` = 消息 metadata 徽标 + 同 thread warning 事件；`why_not_dashboard_only` = 猫在接球现场就要知道这一棒是谁答的；`deep_dive_surface` = `metadata.servedResponseId` 可拿去找 OpenAI 查单；`noise_dedup_policy` = 每条消息最多一条 warning，一致时零噪音

## Tips Contribution（F244）

- 计划 1 条 tip：「回复徽标出现 `→` 说明上游没按你选的模型应答，复制 responseId 可向供应商查询」→ sourceRef 本 spec Primary Journey。

## Close Summary (2026-09-24)

**Status transition**: `in-progress` → **`failed-close (partial-value-preserved)`**

**operator 签字原话**（`[thread-id]`，message `private-source-id`，2026-09-24 09:42 UTC）：

> 「我们的 f319 这里我们先标识成冻结或者 close 吧，这个 feat 其实不合适继续了，这个你也可以记得 close 一下」

### 为什么是 failed-close 而不是 done

Why 里的目标是让「上游实际应答的是谁」成为每条消息上可回查的事实。立项时这件事靠上游自述的 `response.model` 就能做到，而且 09-21 确实抓到过 astra→luna。到了 09-24：

- `response.model` 改成了回显界面上选的模型（operator 09-24 07:09Z 更正），静默替换只会显示成 ✓；
- turn-state 改成了用服务器密钥加密的 Fernet 令牌，长度信号没有了；
- 剩下能用的行为信号（知识分层探针、每次请求的出字速度）都能区分 astra 和 luna，但同样由上游控制，随时可能被收掉；而且检测只能确认、修不了任何东西；
- 根本问题（账号级限制）已由 OpenAI Support 确认（case 15498375），判定方式不公开。

所以目标在用户侧已经做不到，继续投入只是一场上游完全掌控的军备竞赛。

### 保留 vs 撤退

| 部分 | 处置 | 理由 |
|------|------|------|
| Phase A / B / B.1–B.4：`servedModel` 落账、app_server 观测、turn-state 长度 | ✅ 代码保留 | 零成本；上游一旦再承认换模，仍能记下来 |
| Phase E / E.1：徽标三事实（✓ / turn-state / 实时通道） | ✅ 保留；**✓ 的含义已知失真** | 在回显策略下，✓ 只代表「上游回显了我们请求的模型」。撤不撤 ✓ 属于低优先级 UI 取舍，关闭时不做，operator 需要时单独提 |
| Phase F：猫能看到的 `⚠上游实际应答=` 标记 + 琥珀胶囊 | ✅ 保留 | 同上：上游承认换模时仍然有效 |
| Phase C：给 openai/codex 提上游修复 | ❌ 撤销 | 上游已改成回显，这个修复不再成立 |
| 09-23/24 的账号对照、知识探针、速度指纹 | 📝 只作为记录保留在 Timeline | operator 09:24Z 决定停止；不开新 Phase |

### Close Gate Report

```
其余 29 条 AC  ✅ met — 已在文中勾选（`grep -cE '^- \[x\] AC-'` = 29），证据见各条原文所附 commit / PR / 测试 / alpha 记录
AC-A7   ❌ unmet → delete(why: 部署载体是 app_server，alpha 不跑 exec_json；该条在部署载体上已由 AC-B4 覆盖，原文已注明)
AC-B2-5 ❌ unmet → delete(why: 原文已标「FAIL，转 AC-B3-2」，由 Phase B.3 的 AC 取代并已通过)
AC-F3   ❌ unmet → cvo_signoff(proposal=private-source-id, cvo=private-source-id,
          quote=「这个 feat 其实不合适继续了」, accepted_scope=Phase F 代码已合入保留，不再等真实 reroute 做 alpha 验收)
Phase C（上游修复） → cvo_signoff（同上一条消息；理由见上表）
OQ-1（5.6 / 6 系列定价） → cvo_signoff（同上一条消息；随 feat 关闭不再跟进）
```

- `guardian`: not-triggered — reason: operator 主动终止，关闭时没有新增交付声明；已交付的 A–F 在各自合入时都经过了独立 review。
- `harness_feedback`: none — reason: 作者层面的教训（连续两天没有主动报 ROI；把上游自述写成了事实）已记在 Timeline 和作者记忆里，不涉及 harness 机制缺陷。
- **live 状态**：Phase F 合入时记为 `live=dormant`；此后生产有没有 restart，本次关闭没有核查，不做声明。
