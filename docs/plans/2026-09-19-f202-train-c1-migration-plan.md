---
feature_ids: [F202]
topics: [plugin-framework, train-c1, migration, connector, cutover]
doc_kind: plan
created: 2026-09-19
architecture-cell: plugin
---

# F202 Train C1 — 冻结 inventory、安全契约与两仓串行计划（Phase 1 交付）

> 本文是 Train C1 的实施前计划，不是实现。结论全部 code-derived at the frozen baseline。

> **车道边界（2026-09-19 scope correction）**：本计划只承载 **Core deletion-dominant lane**。
> Plugins 聚合迁移由独立 thread `thread_mrkn6povq4zzgh45` 拥有，其冻结的 11 行 C1 migration set
> 是本计划的**输入**（§2.0），不是本计划的实施范围；本 worktree 不写 Plugins 业务代码。
> TTS/ASR 与任何新 public hook / UI slot 属于 C2，不混入 C1。

## 1. 冻结基线

| 仓 | 精确坐标 | 说明 |
|---|---|---|
| Core `zts212653/clowder-ai` | `9ab0eaf287381efcb209781463f38cc5f23870ea` | 即 Train B Core 聚合 PR #1477 的 merge commit |
| Plugins `zts212653/clowder-ai-plugins` | `123112c3e7458b09eab28c201deeb018a0173503` | Train B Plugins 聚合 PR #45 之后的 main |

已发布物（npm `next`）：`@clowder-ai/plugin-contract` `0.1.0-beta.16`、`@clowder-ai/plugin-sdk`
`0.1.0-beta.11`、`@clowder-ai/video-analysis` `0.1.0-alpha.1`（Train B 真实消费者，digest-matched）。

Train B 进入条件已满足：Plugins #45 与 Core #1477 均已合入，maintainer APPROVED（review `5250628473`）。

## 2. 冻结 inventory（INV-R2 全量守恒）

plugins 仓 roadmap §6.4 的 census 日期为 2026-08-25。本次在冻结基线上**重新 code-derive**，不照抄旧清单。
INV-R2 规定"沉默遗漏不等于排除"，因此下表把新发现 entry 显式列入并标注 disposition。

### 2.0 C1 migration set — 11 行（Plugins owner thread 已冻结）

权威来源：Plugins owner thread 在 Core `9ab0eaf287381efcb209781463f38cc5f23870ea` + Plugins
`123112c` 上冻结该集合并置于 RED contract 之下。**Core 侧按这 11 行推导 config/binding/data 映射
与删除面，不自行增删。**

| # | package | catalog id | 本文对应节 |
|---|---|---|---|
| 1 | `@clowder-ai/connector-dingtalk` | `official.connector.dingtalk` | §2.1 |
| 2 | `@clowder-ai/connector-feishu` | `official.connector.feishu` | §2.1 |
| 3 | `@clowder-ai/connector-telegram` | `official.connector.telegram` | §2.1 |
| 4 | `@clowder-ai/connector-wecom-agent` | `official.connector.wecom-agent` | §2.1 |
| 5 | `@clowder-ai/connector-wecom-bot` | `official.connector.wecom-bot` | §2.1 |
| 6 | `@clowder-ai/connector-weixin` | `official.connector.weixin` | §2.1 |
| 7 | `@clowder-ai/connector-xiaoyi` | `official.connector.xiaoyi` | §2.1 |
| 8 | `@clowder-ai/github-operations` | `official.github-operations` | §2.2 |
| 9 | `@clowder-ai/video-generation` | `dev.clowder.video-generation` | §2.2 |
| 10 | `@clowder-ai/wechat-visible-reader` | `official.wechat-visible-reader` | §2.2 |
| 11 | `@clowder-ai/weixin-mp` | `official.weixin-mp` | §2.2 |

**三个 external baseline —— 不是 migration row，但各自的 Core cutover/delete 义务不同。**
它们的共同点只有"Plugins 侧不需要重新迁移"；发布状态与 Core 侧动作必须逐项区分，
不能一句"已发布的消费者证据"带过（该表述对 Personal Chrome 不成立）。

| baseline | 冻结树中的发布状态 | Core C1 义务 |
|---|---|---|
| `video-analysis` | **已发布** `0.1.0-alpha.1`；catalog 有 `dev.clowder.video-analysis` 行 | **有删除面，且今天未删**：Core 切到 alpha.1 外部包，并删除 `packages/api/src/plugins/` 下的 repository-local duplicate。`index.ts:5027-5032` 的 `replacesRepositoryPluginId` 策略已在位，**但它只抑制 Plugin Manager 列表、不做运行时替换**（无运行时替换机制，未删时只证得出"两份并存"）——repo-local 实现今天完整存在且 toolset 仍注册，故删除是 parity 验收的**前置**而非收尾 |
| `personal-chrome-companion` | **未发布**——`packages/personal-chrome-companion/README.md:42`"This package is a review candidate only. It does not publish to npm or the Chrome Web Store"；catalog **无**该行 | **拆成两半**：可外置的 extension / native-host payload 跟随 Plugins 车道，**不在 C1**；Host 侧 installer / pairing / Settings / receipt authority **保留且删除面必须绕开**（§2.2） |
| `feishu-meeting-intake` | 已有独立 npm/stdio package（roadmap §2.1 记 `next = 0.1.0-alpha.9`）；catalog 无该行 | **无删除面**：既有 package 继续存在，Core 侧保留其 Host wiring，不迁移不删除 |

把这三行计入 11 行 migration set 会虚增 C1 范围；反过来，把它们一律标成"无 Core 动作"
会漏掉 `video-analysis` 的 duplicate 删除——两个方向都是错的。

**Core 保留的 Host truth（不随 provider 实现一起删）**：inventory/grants/config/secrets、
connector-thread bindings、durable cursor/checkpoint 与 dedup state、delivery retry/dead-letter、
通用 schedule/webhook activation、lifecycle 与 no-double-run 开关。

> **这一行说的是归属，不是现状实现度**（第九轮 review 精确化）：它规定这些面**留在 Host、不随
> provider 实现一起删**，不代表每一项在冻结基线上都已有持久实现。code-derived 现状：
> `MessagingLedger` 的 `idempotencyKey` 幂等门**是持久的**（`ledger.ts:12`：claim TTL 60s、
> settled 保留 7 天）；connector 入站 dedup 目前是**进程内** `Map`（`InboundMessageDedup.ts:6`），
> 重启即失忆；**声明式 checkpoint 面今天不存在**（缺口 E）。E 的新 ABI 设计不属于 C1，
> 重启行为因此逐 provider 用 package parity 证据验，作为该 connector 行的删除门。

### 2.1 IM providers — 7 项，与旧清单精确一致（无静默新增）

枚举源：`packages/api/src/infrastructure/connectors/im-connector-loader.ts:22-30`（硬编码 7 元
`Promise.all`），与 7 个 `connector.yaml`、7 个 `IMConnectorPlugin` 默认导出模块三方互证。

| entry | 代码 owner | 配置/secret | 自有持久数据 | 专属 journey |
|---|---|---|---|---|
| `feishu` | `im-connectors/feishu/`（1723 LOC） | `FEISHU_APP_ID/APP_SECRET/VERIFICATION_TOKEN/CONNECTION_MODE/BOT_OPEN_ID/ADMIN_OPEN_IDS/GROUP_BOT_MENTIONS_JSON` | `.cat-cafe/im-connector-config/feishu.json`（含 `_operations.feishu_qr_login`）；`connector-binding:feishu:*`；`connector-perm{,-groups}:feishu` | `connector-hub.ts` 3 条 QR 路由；guide `connect-feishu.yaml` |
| `weixin` | `im-connectors/weixin/`（2057 LOC） | `WEIXIN_BOT_TOKEN` + 3 个直读 `process.env` 的 voice 变量 | Redis `connectors:weixin:session-state`（长轮询游标 + context tokens）；`weixin.json`（含 `_operations.weixin_qr_login`）；`connector-binding:weixin:*` | `connector-hub.ts` 4 条路由；guide `connect-wechat.yaml` |
| `wecom-bot` | `im-connectors/wecom-bot/`（1151 LOC） | `WECOM_BOT_ID/SECRET` | Redis set `wecom-bot-group-chat-ids`；`wecom-bot.json`（含 `_operations.wecom_validate`）；binding + perm | `connector-hub.ts` 2 条路由 |
| `dingtalk` | `im-connectors/dingtalk/`（1079 LOC） | `DINGTALK_APP_KEY/APP_SECRET` | Redis set `dingtalk-group-chat-ids`；config + binding + perm | 无 |
| `wecom-agent` | `im-connectors/wecom-agent/`（853 LOC） | `WECOM_CORP_ID/AGENT_ID/AGENT_SECRET/TOKEN/ENCODING_AES_KEY` | config + binding | 无（走通用 webhook；但 XML content-type parser 专为它加在共享路由 `connector-webhooks.ts:51-66`） |
| `telegram` | `im-connectors/telegram/`（896 LOC） | `TELEGRAM_BOT_TOKEN` | config + binding | 无（但 token 校验规则硬编码进 Core `connector-secret-write-guards.ts`） |
| `xiaoyi` | `im-connectors/xiaoyi/`（714 LOC） | `XIAOYI_AK/SK/AGENT_ID` | config + binding（chatId = `{agentId}:{sessionId}`） | 无 |

### 2.2 repository-local business plugins — 4 项在 C1 migration set，1 项为既有 baseline，**另发现 1 项静默新增**

manifest 根：`packages/api/src/plugins/`（`index.ts:4317` 硬编码）；枚举器 `PluginRegistry.scan`。

| entry | 资源声明 | 配置/secret | 自有持久数据 | disposition |
|---|---|---|---|---|
| `github` | 7 个 schedule | `GITHUB_TOKEN`、`GITHUB_MCP_PAT`、`GITHUB_SETUP_NOISE_BOT_LOGINS` | `schedule:github:*` ×7；`capabilities.json` ownership；迁移标记 `.cat-cafe/f202-phase2-github-schedule-migrated`、`.cat-cafe/f168-github-schedule-backfilled`；Redis `community:repo-comment:cursor:{repo}` | in-scope C1 |
| `video-analysis` | 1 个 mcp | 5 个 `VIDEO_ANALYSIS_*` | `capabilities.json` + 生成的 CLI MCP config | **既有 external baseline，非 C1 migration row**（alpha.1 已发布，`index.ts:5027-5032` 的 `replacesRepositoryPluginId` 策略已在位——**仅列表抑制，非运行时替换**）；**但有 Core 删除面且今天未删**：切到 alpha.1 外部包并删除本地 duplicate（§2.0 baseline ledger；删除阶段先删本地 duplicate 再取证） |
| `video-gen` | 1 个 mcp | 7 个 `VIDEO_GEN_*` | 同上 | in-scope C1 |
| `weixin-mp` | limb + skill | `WEIXIN_MP_APP_ID/APP_SECRET` | `capabilities.json` ×2；skill 挂载副作用（跨项目级联）；限时 access token | in-scope C1 |
| `wechat-visible-reader` | limb | 无 | 仅内存 arm 授权窗口（无持久化） | in-scope C1 |
| **`personal-chrome-host`** ⚠ | **无 `plugin.yaml`** | 5 个 `CAT_CAFE_PERSONAL_CHROME_*`（env-only，不走 plugin config 边界） | **自有目录** `.cat-cafe/plugin-host/personal-chrome-host/{pairing,conversation-binding,delivery-ledger}.json`；Unix socket | **非 C1 migration row**；Host authority 受保护（§2.2 裁定） |

`personal-chrome-host` 位于 manifest 根目录内（`plugins/cloud-cat-personal-host/`），以
`pluginId: 'personal-chrome-host'` 对外呈现，拥有独立 `/api/plugins/personal-chrome*` 路由与
独立 Settings 面板，但因无 `plugin.yaml` 被 `PluginRegistry.scan` 静默跳过
（`PluginRegistry.ts:59-60`）。**任何以 `find -name plugin.yaml` 为准的 census 都会漏掉它。**

**裁定（reviewer ruling，2026-09-19）：既不是 C1 migration row，也不是 `PluginManifest` / installer。**
权威依据是 Plugins roadmap §2.2「成熟度判断 · 存量迁移」行——"Feishu/Chrome 是外部 package 先例"，
即 Chrome 路径被列为**既有先例**而非待迁移项；`docs/architecture/ownership/cells/plugin.md:131` 同样
把它定性为 "one concrete, explicitly user-installed adapter"。

> **勘误**：本文初版在此引用"roadmap §2.1 已将 Personal Chrome 列为'既有独立候选…'"。roadmap §2.1
> 是「精确坐标」表，不含该表述——该引用不成立，已替换为上述可核验来源。

因此 Core C1 的删除面**必须显式绕开**它：安装、配对、Settings 面板与 receipt authority 仍归 Host，
**不得**随旧通用 plugin 管理面一并删除——删除阶段必须显式排除它。

### 2.3 第二处静默缺口 — enterprise workflow 的 provider-specific 实现

`packages/api/src/infrastructure/enterprise/` 下的 `LarkActionService.ts`、`LarkCliExecutor.ts`、
`WeComActionService.ts`、`WeComCliExecutor.ts` 及回调路由 `callback-lark-action-routes.ts`、
`callback-wecom-action-routes.ts`，是 Feishu/WeCom **平台专属业务实现**，位于 IM connector plane
之外，不在旧 census 任一类别中。凭据来自 `lark-cli`/`wecom-cli` 自身配置（本树内不可见）。

**裁定（reviewer ruling，2026-09-19）：不进 C1 inventory。** 它们是受保护的独立业务消费者
（enterprise workflow 旅程），**不因代码里出现"provider-specific"字样就自动被 C1 收编**——
plugins 仓 roadmap §6.4 的判据针对的是 **IM connector 控制面**，不是任意平台业务实现。
Core C1 对它们只有一条义务：删除 IM / plugin 管理面时**不得波及**这两条业务路径及其回调路由。

### 2.4 concrete managed services — 旧清单 5 项存在，**另发现 2 项静默新增 + 1 项悬挂**

枚举源：`packages/api/src/domains/services/service-manifest.ts:178`（硬编码字面量数组，
是该 plane 的唯一 registry）。

| entry | 注册方式 | artifact 通道 | 备注 |
|---|---|---|---|
| `whisper-stt` | `SERVICE_MANIFESTS` | HuggingFace（5 个 MLX 模型）+ venv | — |
| `mlx-tts` | `SERVICE_MANIFESTS` | HuggingFace + **Piper `.onnx` 直链**（非 HF 通道）+ venv | 双 artifact 通道 |
| `embedding-model` | `SERVICE_MANIFESTS` | HuggingFace + venv | 唯一有 `onServiceReady` 回调特判（`index.ts:5968-6014`）；换模型会使 `evidence.sqlite` 向量失效 |
| `llm-postprocess` | `SERVICE_MANIFESTS` | HuggingFace（~20GB，最大） | 仅浏览器端消费，API 侧无消费者 |
| `audio-capture` ⚠ | `SERVICE_MANIFESTS` | **ModelScope**（第三个通道）+ Swift 采集二进制 | **悬挂**：安装/启动脚本硬依赖 `scripts/meeting-copilot/*`，该目录**不在本树中**。不是干净的 1:1 迁移对象 |
| **`collective-service`** ⚠ | **不在 registry**，`index.ts:5134-5141` 硬编码 | 无（纯 TS workspace 包） | 自有 `~/.cat-cafe/collective-service/`（含 `pairing`/bootstrap **secret**）、自有 health 契约、自有 `/api/plugins/collective-connector/service/provision` 路由 |
| **`personal-chrome-host`** ⚠ | **不在 registry**，`index.ts:5178-5188` 硬编码 | Chrome MV3 扩展 + 内容寻址 native host artifact | 与 §2.2 同一 entry；**还会写仓外**（OS 级 Chrome NativeMessagingHosts 目录 + Windows 注册表） |

两个静默新增都由 `packages/api/src/index.ts` 硬编码 wiring 注册而非任何 registry——
**这正是只查 registry 的 census 会漏掉它们的原因**。

**裁定（reviewer ruling，2026-09-19）**：5 个 managed services **明确归 C2**——本类依赖尚不存在的
typed hook / UI slot seam，而"新 seam 带第一个真实消费者一起开"正是 C2 的定义。
`audio-capture` 的悬挂状态**作为 C2 风险显式记录**，不在 C1 处置。
`collective-service` 记入 **supplemental census**（证明 census 方法学完备），
**但不是 §2.0 十一行 C1 migration entry 之一**。

Train C 完成线仍要求 inventory 100% disposition——C1 之后 Train C 未闭环是**预期状态**；
C1 PR 需把本类条目显式标为 `deferred → C2`，而不是不提。

`personal-chrome-host` 会写入仓库与 `.cat-cafe/` 之外的 OS 级位置（Chrome native messaging
manifest、Windows 注册表），其 uninstall 数据处置需单独审查，不能套用通用 plugin 策略。

### 2.5 INV-R2 守恒偏差汇总（共 4 项，**均已裁定**，见下表末列）

| # | 偏差 | 类型 | 为什么旧 census 会漏 | C1 disposition（已裁定） |
|---|---|---|---|---|
| 1 | `personal-chrome-host` | 新增 | manifest 根目录内但无 `plugin.yaml`，被 `PluginRegistry.scan` 静默跳过 | 非 migration row；Host 安装/配对/Settings/receipt authority 受保护，删除面绕开（§2.2） |
| 2 | `collective-service` | 新增 | 不在 `SERVICE_MANIFESTS`，由 `index.ts` 硬编码 | supplemental census，非 C1 entry（§2.4） |
| 3 | `infrastructure/enterprise/` 的 Lark/WeCom action service | 新增 | 既非 IM connector plane 也非 plugin plane，不属旧清单任一类别 | 不进 C1 inventory；受保护业务消费者（§2.3） |
| 4 | `audio-capture` | 状态偏差 | 在清单内，但 runtime payload 已不在树中 → 无法按 1:1 迁移处置 | C2 风险记录（§2.4） |

**方法学教训**：以 `find -name plugin.yaml` 或"读 registry 数组"为准的 census 都会漏。
守恒检查必须以 `readdirSync(pluginsDir)` + 追 `index.ts` 硬编码 wiring 为准。

## 4. no-double-run / rollback / persistent-data 安全契约

### 4.1 迁移涉及的持久数据全集（code-derived）

| 载体 | key/路径 | 用户可见 |
|---|---|---|
| Redis | `connector-binding:<provider>:<externalChatId>`、`connector-binding-rev:<threadId>`、`connector-binding-user:<provider>:<userId>` | **是**（决定消息落到哪个 thread） |
| Redis | `connector-perm:<provider>`、`connector-perm-groups:<provider>` | **是**（授权） |
| Redis | `dingtalk-group-chat-ids`、`wecom-bot-group-chat-ids`（set） | 是 |
| Redis | `connectors:weixin:session-state`（长轮询游标 + context tokens） | 否，但丢失会导致消息重放/丢失 |
| Redis | `community:repo-comment:cursor:{repo}` | 否，同上 |
| 文件 | `.cat-cafe/im-connector-config/<id>.json` ×7（含 `_operations` 状态机） | 是（配置与登录态） |
| 文件 | `.cat-cafe/plugin-config/<id>.json` | 是 |
| 文件 | `.cat-cafe/capabilities.json` 的 `pluginId` ownership 记录 | 是 |
| 文件 | `.cat-cafe/plugin-host/personal-chrome-host/*.json` | 是 |
| thread 记录 | 内嵌 `ConnectorHubStateV1{connectorId, externalChatId}` | **是** |
| scheduler | `schedule:github:<name>` ×7 | 是 |

**契约 D1 — TTL=0**：以上标记"用户可见"的数据在迁移前后一律保持 TTL=0。迁移不得引入 TTL，
不得以"迁移期临时数据"为由缩短留存。

**契约 D2 — 只读镜像，不移动**：cutover 阶段对旧载体只做**读取与镜像**，不 move/不 delete。
旧数据的删除是 soak 之后单独审批的一步，不与默认路径切换同一 PR。

**契约 D3 — 幂等可重入**：每个 mapping 必须可重复执行且收敛到同一结果（参照 github 已有的
`.cat-cafe/f202-phase2-*-migrated` 标记文件模式，但标记文件本身不得成为唯一真相）。

### 4.2 no-double-run 强制点（INV-PM8 / INV-R3）

按 `connectorId` 建立 Host 级**排他 claim**：同一 provider 在任一时刻只能有
{legacy `ConnectorRouter` 路径, migrated plugin 路径} 之一处于 active。
该排他性必须由 Host 的 lease/fence 保证，**不能靠配置约定或启动顺序**。

验收：对每个 provider 跑「双路径同时配置 → 断言只有一条消费入站事件、只产生一条消息、
只唤醒一次」，并覆盖 restart 与 disable/re-enable。

### 4.3 已识别的具体迁移陷阱

1. **`isStaticConnectorId` 会阻止迁移包认领自己的 id**。provider 身份今天重复存在于三处
   （per-provider `index.ts` 的 `definition`、`packages/shared/src/types/connector.ts` 的
   `CONNECTOR_DEFINITIONS`、`connector.yaml`），且共享列表被设为权威并**禁止外部插件复用这 7 个 id**。
   不先反转这条规则，迁移后的包根本装不上。
2. **4 个 env 变量不在 allowlist / reload keys 内**：`FEISHU_GROUP_BOT_MENTIONS_JSON`、
   `WEIXIN_VOICE_ITEM_MODE`、`WEIXIN_ENABLE_UNSAFE_VOICE_MODES`、`WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA`。
   只走 Hub UI 的配置迁移会**静默丢掉**它们，必须显式 mapping 或显式放弃并签字。
3. **新 Manager 今天反向依赖旧 registry**：`plugin-manager-compatibility.ts` 经
   `loadRepositoryPluginInfo`（`index.ts:4325-4333` 对 `pluginRegistry` 的闭包）读取 repository 行，
   且 `index.ts:5031-5033` 在其缺失时直接抛错。**旧 registry 不能先删**，必须先把 compatibility
   provider 换源。
4. **默认 Console 仍是旧面**：新 Manager 被 `?pluginManagerDemo=1` / `?pluginManagerLive=1` 门控
   （`plugin-manager-design-gate.ts`），`/settings?section=plugins` 默认仍渲染旧的 `PluginsContent.tsx`。
   "默认路径切换"在 Console 侧就是翻这个门控。
5. **`connector-gateway-bootstrap.ts` 含 4 处 provider 专属分支**（wecom-bot ×1、weixin ×3）
   外加 feishu 测试覆写分支，须随迁移一并拆掉。
6. **skill 挂载有跨项目级联副作用**（`PluginResourceActivator.ts:331-366`），`weixin-mp` 迁移时
   必须证明卸载能完整回收，不留悬挂 symlink。

## 5. 终态验收标准（operator 裁定，2026-09-20）

> 这个 pr 必须做到终态；除了那个 c2 阶段明确是涉及到前端的
>
> 这个 pr 的验收标准就是：我们的插件 / im connector 的代码一行都不应该在 clowder-ai host 出现；
> 全部都在插件仓；插件仓那边的插件都可以在我们这里独立安装卸载和使用的

> 我们不应该留下任何定制的专属接口和能力

**不得以 follow-up 形式外移删除面。**

## 6. 当前设计真相源

接口全集、缺口清单、删除清单、执行顺序，全部在：

**`docs/plans/2026-09-20-f202-c1-host-plugin-interface-contract.md`**

本文件只保留两样不随设计变化的东西：**要迁什么**（§2 inventory）与
**迁移不能弄丢什么**（§4 持久数据安全契约）。

## 7. 本文件为什么变短了

原文 1613 行。原 §5（两仓串行计划）已被上面的验收标准明文覆盖、原 §7 是流程记账、
原 §8 内含多处自我作废、原 §9 是三轮自我更正——全文 20+ 处「撤回 / 作废 / 取代」标记。
读者无法在不重读全部推导史的情况下知道哪句还成立，这违反单一真相源。

推导史不是没价值，但它属于 git，不属于一份活文档。完整历史见 `3e041c885`。
