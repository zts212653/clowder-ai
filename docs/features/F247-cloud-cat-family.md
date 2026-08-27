---
feature_ids: [F247]
related_features: [F178, F061, F174, F236, F237]
topics: [cloud-cat, chatgpt-pro, mcp, multi-provider, custom-instructions, github-connector, chrome-extension, native-messaging]
doc_kind: spec
description: Productized cloud-cat platform for connecting ChatGPT Pro and future cloud LLM providers into Clowder AI as first-class collaborators.
tips_exempt: "Renewed for v21 same-turn real-ID receipt observation: this only stabilizes the existing owner-only Developer Preview path and adds no public Chrome Web Store listing or teachable UI entry; add a tip only after signed publication creates a public onboarding surface."
description_source: model
description_author: codex
description_updated_at: 2026-07-06T11:45:00Z
description_generated_by: gpt-5.5/codex
description_generated_at: 2026-07-06T11:45:00Z
description_confirmed_by: codex
created: 2026-06-21
revision_history: |
  v1 (2026-06-21, commit 00a533f71): 立项
  v2 (2026-06-21, this revision): Maine Coon R3+R4+R5 跨族 review fix
    - P1 R3-1: Phase B auth split B0 harness / B1 production
    - P1 R3-2: yanyan-cloud → gpt-pro 全局统一
    - P1 R3-3 + R4: startup polling 完全砍掉，不偷换 search_evidence 伪装
    - P2 R3-1: AC-A3 footnote Checkpoint #3
    - P2 R3-2: KD-1 rewrite (F178 owns single-agent-key research, F247 owns productized platform)
    - P2 R3-4: mint roster allowlist only + Phase C breeds.variants task
    - R5: 1175 L0 hold_ball → 工具无关表述
  v3 (2026-08-12): 个人版实时召唤路线收敛
    - Personal Chrome Host Adapter 成为个人 ChatGPT Pro 主路径
    - Clowder AI plugin 统一编排 Chrome extension + Native Messaging helper 安装与配对
    - 用户通过富文本预览显式授权转发；Scheduled Tasks 降为非实时可选兜底
    - 没有真实 hostMessageId 不宣称发送成功，自动化失败降级为复制并打开
  v4 (2026-08-12): cloud invocation terminal contract 修复
    - cloud-only route 创建 durable child invocation，不再提前 silent done
    - Host transport 只等待有界 receipt/failure，不等待云端猫回复
    - exact A2A source 写 completed disposition；缺 adapter 只显示一次可读状态并终结 source
    - Personal Chrome adapter 可由 socket + pairing secret 显式配置激活，安装/配对仍属 Phase E/F
  v5 (2026-08-13): Personal Chrome Phase E0 安装闭环
    - 可撤销 Host-owned helper/manifest/pairing 安装事务 + fixed extension identity
    - API 每次投递读取 canonical pairing record，无需重启即可 install/uninstall
    - 真实隔离 Chrome 已启动 helper；登录态 /c 会话未出现，消息 gate 诚实记为 NOT_OBSERVED
  v6 (2026-08-20): You 日常 Chrome in-place live gate
    - 修复 Native Host launcher 对 GUI PATH 中 node 的隐式依赖，安装时固化绝对 Node runtime
    - 不退出/重启 Chrome，不复制 profile/cookie，真实登录态后台投递返回 DOM hostMessageId
    - 同一 idempotency key 重试返回同一 ID，control tab 保持前台；AC-FS1/2/3 全部关闭
  v7 (2026-08-21): 一次显式绑定 + zero-focus Host contract
    - 扩展在目标 ChatGPT conversation 提供一次“绑定此会话”，Host 原子持久化 mode-0600 exact conversation authorization
    - 日常 append 在 ledger admission 前要求 Clowder AI route conversation ID 与 Host authorization 精确一致；未绑定返回 typed NEEDS_BINDING
    - 删除 in-place gate 的 AppleScript target/control 捕获与切换协议；health、gate、retry、delivery 均无 tab/window/focus/navigation mutation surface
  v8 (2026-08-21): owner-friendly Developer Preview 安装卡
    - Console 插件页新增 owner-only Personal ChatGPT Pro 卡，显式 install/repair/uninstall 既有 Host primitives
    - artifact/config/authorization/intent/live 五轴独立投影；helper ready 只显示“待绑定”，不冒充“已配置/运行中”
  v9 (2026-08-21): 产品安装旅程 + 多会话授权集合
    - 单 binding 无损迁移为严格 schema-v2、mode-0600、原子且最多 32 项的 authorized-conversation collection
    - “授权此会话”追加且幂等；Settings owner-only 展示数量/列表并支持逐项撤销，卸载清空集合
    - Settings 与 MV3 manifest 使用正式 gpt-pro 资产；移除 unpacked 路径，把 Web Store 集成就绪与公开发布分开
    - 无 listing 时 Host 安装前 typed 阻断；有可信 listing 时一次 Settings 操作准备 Host 并打开 Chrome 原生确认旅程
    - Windows 稳定返回 unsupported 且零安装读取；签名扩展发行与 thread-route wiring 继续独立收口
  v10 (2026-08-22): owner-Chrome dogfood compatibility repair
    - 页面提交改为验证空 composer → 插入 exact text → bounded 等待 input 后出现的发送按钮 → 单击一次 → 观察真实 DOM message ID
    - 按钮缺失/disabled/DOM 异常在点击前恢复精确空状态；owner 非空草稿在任何 mutation 前 typed fail-closed
    - Host inspect 同时验证 recorded artifact 完整性与 current runtime digest；完整但过期投影 stale/restart_required，不再冒充 ready
    - 现有 Developer Preview repair 不受 Web Store publication blocker 误伤；活跃旧 Helper 返回 typed actionable 状态且零 pairing 指针变更
    - stale+active 时 Settings 只投影 schema-v1 authorization、不落盘迁移；Helper inactive 后 repair 保留 secret/installedAt/authorization/ledger 并由新版读写 v2
  v11 (2026-08-23): source-bound return + durable outbound audit
    - PR #3857 后 owner-click + extension/page refresh 的真实 background delivery、同-key retry 与 Remote MCP thread roundtrip 标为 OBSERVED/PASS
    - runtime delta 加入 exact sourceMessageId；缺 exact source fail closed，云端回程复用 F264 replyTo
    - normal cloud dispatch 在 thread 时间线持久化 typed outbound receipt；正文预览继续从 exact source 水合
    - in-place live gate 只发送内部 nonce，并明确输出 diagnostic receipt，不再支持任意正文旁路
  v12 (2026-08-23): owner-Chrome product-chain completion
    - Settings 把 Host authorization collection 与当前 Clowder AI thread route 分成两个可完成步骤；owner 从已授权会话中为当前 thread 选择精确一项
    - current-thread route 只消费既有 owner-only cloud-bindings API；默认 thread payload / memory / export / cross-post 继续 privacy-by-absence
    - contenteditable 多行 runtime delta 使用精确 block-DOM 文本等价；conversation / owner draft / composer / send-button mutation 仍 fail closed
    - focused gate 新增 normal dispatch durable receipt + exact source-bound Remote MCP return 回归；AC-F8 仍等待合入后的真实 owner journey
  v13 (2026-08-23): ProseMirror transaction + revision-honest managed gate
    - 真实 ProseMirror shape 证明 direct DOM projection 会被 editor state 回滚；contenteditable 改用原生编辑事务且无 direct-DOM fallback
    - bounded text-free fingerprint 给出首个 unsupported path；producer 将不可表示 tag 安全降级为 node type、按 DOM `uint32` 精确保留 index/count，失败诊断沿 Host receipt allowlist 持久化
    - runtime / Helper / extension / page adapter 增加 expected→observed revision handshake，socket connected 不再冒充 adapter ready
    - repair 可先 staging immutable Helper generation；extension reload 后自动重注入 content script，无需再刷新会话页
    - normal-dispatch managed gate 只读正式链路，必须同时观察 hostMessageId 与 exact source-bound gpt-pro return；AC-F8 保持待一次 live 授权
  v14 (2026-08-24): owner-observed ProseMirror trailing-break contract
    - 首次 bounded owner diagnostic 捕获到插入后的真实结构：非空 P 会在正文后附 `BR.ProseMirror-trailingBreak`
    - exact serializer 仅忽略真正位于 direct block 末尾的 editor filler；普通 BR 继续表示用户换行，错位 trailingBreak 继续 fail closed
    - production fixture 同时锁住实机形态、普通 BR、空段、unknown/nested DOM、恢复与 zero-click
    - 唯一 live nonce 以 `COMPOSER_INSERT_FAILED` 终止且无 hostMessageId/回程；本 revision 不重放 nonce，AC-F8 继续保持 pending
  v15 (2026-08-24): MV3 Native Messaging self-recovery contract
    - owner 授权 collection 与 thread route 在 runtime 重启后继续有效，Helper dormant 不得被解释为需要重新授权
    - service worker 保留 1 秒 transient reconnect fast path，同时用 browser-owned Alarm 提供 worker 被回收后的 durable wake/reconnect
    - extension revision 升至 `0.2.1`，runtime / Helper / worker / content script 的 revision handshake 可识别旧 reconnect 代码
    - normal dispatch 失败不再要求 owner 点击扩展图标唤醒；AC-F8 仍须 post-merge 真实 host receipt + exact source-bound return
  v16 (2026-08-24): authorization writer serialization contract
    - source full gate 在同一 exact main 上两次复现双会话授权只落一条，历史 #3900 的有限 lease 重试再次耗尽
    - 同进程 mutation 先把 absolute authorization path 做 lexical normalization，再按同一 normalized path 经 FIFO 串行化，最后获取原有跨进程 filesystem lease；不延长 retry budget、不削弱 live-owner exclusion
    - `AUTHORIZATION_BUSY` 可作为 bounded binding result 诊断，其他底层写入错误继续折叠为 `BINDING_WRITE_FAILED`
    - 6.5 秒真实 durable sync RED→GREEN 覆盖同一文件的 canonical/alias 两种拼写，同时保护不同 normalized path 并行、两条 authorization 与持久化 schema-v2；AC-F8 仍待真实 live receipt + exact return
  v17 (2026-08-24): reload-safe content-script bootstrap
    - owner Chrome 错误页与 normal health 同时确认 `content-script.js` 的 runtime dynamic import 在扩展更新后的既有会话页失败，adapter listener 从未注册
    - page adapter 与其两层依赖在仓内确定性打包为单一 classic content script；manifest 不再公开三份 module resource，重注入不依赖 extension-resource fetch
    - 真实隔离 Chrome fixture 主动拒绝所有 runtime `.mjs` fetch：旧实现复现同一 `Failed to fetch dynamically imported module`，新实现零 module fetch 且 Host receipt / retry / zero-focus 全绿
    - extension revision 升至 `0.2.2`；本实现不触碰 owner Chrome、不重放 nonce，AC-F8 继续等待 post-merge 真实 receipt + exact return
  v19 (2026-08-25): route-exact watchdog detail moved to focused bug truth；gpt-pro return/proactive auth 按语义分流，严格回程绑定不变，独立消息仅走 append-only agent-key 通道
  v20 (2026-08-26): enclosing-turn receipt、dedicated principal 与 artifact freshness；v21 (2026-08-27): bounded same-turn unique real-ID lookup + extension `0.2.5` / adapter `2026-08-27.1`，零/多候选 fail closed，AC-F8 仍待 fresh live receipt + exact return
---

# F247: 云端猫 Family + 多 provider 接入平台

> **Status**: active | **Owner**: Ragdoll (Ragdoll opus-47) | **Reviewer**: Maine Coon (Maine Coon codex/gpt-5.5) | **Vision Guard**: Ragdoll (opus-48) | **Priority**: P1 | **Created**: 2026-06-21

Architecture cell: plugin + callback-auth + transport + dispatch
Map delta: none for v21; the existing plugin + callback-auth + dispatch + transport cells still own extension bootstrap, revision handshake, Host receipt, source-bound return, proactive append, lifecycle recovery, authorization writer, Remote MCP artifact identity, and ThreadStore route boundary. Host receipt observation remains bounded to one conversation turn and grants no document-wide search authority. The dedicated gpt-pro process binds its one authorized principal server-side; shared multi-key runtimes still require an explicit selector, and no principal, thread scope, replacement, review, coordination, action, focus mutation, or external origin authority is added (last updated 2026-08-27).
Why: F247 consumes the F178 principal lifecycle, adds a Host-governed conversation append seam, settles cloud-only A2A work through the existing exact-source dispatch contract, and owns the durable outbound receipt projection on the canonical transport timeline without claiming provider capability. V20 fixed enclosing-turn receipt ownership, deployment-owned service identity, and loaded-artifact identity; v21 closes the remaining DOM-coordinate mismatch where the real ID can be a sibling or descendant inside the same conversation turn rather than an ancestor of the user-role node.
Canonical source: `packages/api/src/routes/callbacks.ts` + `packages/api/scripts/f247-personal-chrome-install.mjs` + `packages/api/src/plugins/cloud-cat-personal-host/extension/service-worker.js`.
Consumer evidence: both `post_message` and `cross_post_message` use `/api/callbacks/post-message`; collection inspect calls the live probe without a route; exact-route inspect accepts only an authorization-collection member; service-worker bootstrap creates the named periodic alarm before the first Native Messaging connection.
Claim guard: a gpt-pro post with neither return field persists independently; either return field alone fails typed before persistence, and a mismatched signed pair fails 403; collection state never guesses an authorization; a service worker that never receives `onDisconnect` still has a browser-owned alarm capable of rebootstrap; receipt observation accepts exactly one real ID in the bounded same-turn scope and rejects zero or ambiguous candidates.
Characterization/contract test: `pnpm -C packages/api run test:f247-chrome-host-spike`.
Code-derived consumer census: `rg -n "content-script\.js|content-script-entry|web_accessible_resources|import\(" packages/api/src/plugins/cloud-cat-personal-host packages/api/scripts packages/api/test/personal-chrome-*`.
Migration/restart/rollback evidence: authorization schema-v2, pairing secret, Helper launcher, receipt ledger, exact routes, and message protocol remain unchanged. Extension `0.2.5` / page adapter `2026-08-27.1` force the browser to reject the ancestor-only turn-observation logic; the Remote MCP lifecycle restarts a healthy process when its loaded artifact digest differs from the current build. Rollback is data-compatible but restores ancestor-chain-only receipt observation and therefore can reintroduce `HOST_MESSAGE_NOT_OBSERVED` when the real ID is elsewhere in the same turn.

## Why (R3 P2-2 rewrite)

**F247 owns productized cloud-cat platform vision**：multi-provider 接入、avatars/bubbles、config UI、pluginization。

F178 §12 升级条件给出新 F 号触发集合（self OAuth AS / multi-tenant / write expansion / persisted bridge state），但 F247 真正的立项动力**不是公网 auth shape**——而是operator给的产品愿景升级（2026-06-21 06:15 PT 原话）：

> "全量版本 mcp 接入完成之后还要升级一下。比如说 gpt pro 接入进来他要是发消息了 我们猫咖前端有他的头像，甚至这个能力得做成一个能给其他社区小伙伴 类似于我们家的插件 or 其他开源项目安装那样的能迁移的呀！这样我们未来在配置猫猫上如果选择配置 chatgpt 云端 然后选模型 就能和云端的猫沟通了呀。这样甚至他就是独立的一只有自己完整头像的猫了，Maine Coon pro 版本他发消息你们也能看到气泡（或者说我能看到），他写 plan 让你们执行等等"

**触发证据（spike PASS 真理时刻 2026-06-21 06:08 UTC）**：ChatGPT Pro Maine Coon通过 cloudflared quick tunnel + Streamable HTTP MCP 成功调到 cat-cafe MCP 的 echo 工具（mock harness 验证 transport 层），亲口说"猫咖小管道通了 🐾"。

**护城河升级**：
- 现状：本地 Claude/Codex 家族 → 单 vendor 风险
- 愿景：multi-provider 聚集地 → 任何能跑 MCP connector 的云端 LLM 都能成为家庭成员

**operator signoff**：operator 2026-06-21 08:11 UTC "可以更新 feat md 了嘛？" + 08:40 UTC "先更新你的 feat md 然后再开始写代码"。

## Current State / 基线（截至 2026-08-25）

### 已验证 ✅
- MCP transport（Streamable HTTP）+ ChatGPT Developer mode connector 兼容（spike B0 mock harness）
- cloudflared **named tunnel** mcp.clowder-ai.com + `?token=` + 真 10 工具白名单端到端通（B1a, 2026-06-22）
- ChatGPT 内置 GitHub Connector Maine Coon可访问 cat-cafe 公开 repo（PR/code/diff/commit）
- CodexPro 拆解：他们用 `.ai-bridge` 文件桥做 async pull，**明示拒绝** automate ChatGPT（守 ToS）
- **fable phase0 10 工具白名单实际不含** `get_pending_mentions / ack_mentions / task tools / hold_ball`（Maine Coon R3 R5 verify）
- **B1a end-to-end 真理时刻 (2026-06-22 06:47 PT)**：
  - gpt-pro agent-key mint ✅
  - 公网 mcp.clowder-ai.com + tunnel + ingress ✅
  - MCP annotations (readOnlyHint / destructiveHint / openWorldHint) fix ✅
  - spike server pure agent-key 模式 (env -u 5 项 + AGENT_KEY_FILES override) ✅
  - cat-cafe API hot-add gpt-pro via `POST /api/cats` (0 重启) ✅
  - dry-run `cat_cafe_post_message` 真写入 thread, speaker 显示 "Maine CoonPro(Pro Cloud (ChatGPT))" ✅
- **2026-08-08 principal lifecycle hardening + live recovery proof**：45-day Redis TTL 到期而 sidecar 残留导致 `agent_key_unknown`；共享 provisioner 已实现 verify/preserve/rotate/replace + daily renewal。授权 runtime reconcile 后，公网 Remote MCP 以 `gpt-pro` 写入 `[thread-id]` 并返回 message ID `0001786245288454-000558-7b3fc130`，full thread read 精确确认一次。
- **Host Adapter contract**：`append_message(conversationId, text, idempotencyKey) -> {hostMessageId, idempotentReplay?}` 已落窄接口与 fail-closed tests；Personal Chrome Host 在 owner 授权的 exact conversation 上已有真实 background append 证据，但不外推为任意 provider / conversation，也不冒充 Chrome Web Store 公开发行。Legacy PinchTab 仅 `CAT_CAFE_ENABLE_LEGACY_PINCHTAB_BRIDGE=1` 显式启用，默认不接管前台 UI。
- **历史个人版双向 E2E 已实锤**（2026-06-30）：旧 PinchTab bridge 将 Clowder AI mention 投进绑定的 ChatGPT conversation；云端 `gpt-pro` 随后通过 Remote MCP 真写回 Clowder AI，消息 `0001782785550318-000160-3b0dbc66` 可精确读取。它证明产品闭环可行，但不把前台浏览器自动化升级为稳定公共契约。
- **Personal Chrome Host Adapter 隔离 spike（2026-08-12）**：35 项 focused 契约全部通过。真实 Chrome + 临时 profile + unpacked MV3 extension 在拦截的 `chatgpt.com/c/<id>` fixture 上完成后台 tab 投递，前台 tab 未变化；首次返回 DOM message ID `fixture-host-message-1`，同一 idempotency key 重试返回同一 ID 且 send count 保持 1。独立 full-seam integration 另行穿过真实 `PersonalChromeHostAdapter`、Unix socket bridge、Native Messaging framing、service-worker `connectNative`/`dispatchAppend`、tab receipt 与 0600 durable ledger；helper socket 由跨进程原子 owner lease 守住，live/仍在落盘的旧 helper 不会被重叠启动替换，dead helper 遗留的 lease 可安全回收；POSIX install contract 还直接启动 manifest 写入的 executable path 并交换真实 stdio frame，防止进程内 mock 或 DOM-only fixture 绕过 helper/port 后仍误报机制通过。该证据只关闭 fixture/本地协议 gate，不冒充已安装原生宿主或登录态真实 ChatGPT DOM 证据。
- **Cloud invocation terminal contract（2026-08-12）**：`openai-chatgpt-pro` 不再从 KD-17 guard 提前 `done`。它先创建 durable child、暴露 exact source body，再等待 Host transport 的有界 `sent | fallback | error`；随后发布一条可读 `cloud_bridge_status`，为 A2A source 写精确 `completed` disposition，并用同一 child `done` 收口。Host 缺失是一次显式 unavailable，不再被 F167 判成 disposition missing 后重排队。
- **Operator-only runtime activation（2026-08-12；v13 收紧）**：API 仅在 `CAT_CAFE_PERSONAL_CHROME_SOCKET`、`CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET` 与 `CAT_CAFE_PERSONAL_CHROME_HELPER_ARTIFACT_REVISION` 同时存在且合法时构造 Personal Chrome Host Adapter；缺一项时 fail closed，日志只记录 presence bit，不记录 secret。canonical pairing record 路径自动读取 artifact revision。该 seam 不安装 helper/extension、不授予浏览器权限，也不等于 Phase E/F 产品化完成。
- **Personal Chrome Phase E0 安装闭环（2026-08-13）**：Host 现在可原子 install/inspect/repair/uninstall content-addressed helper、稳定 launcher、profile-scoped Native Messaging manifest 与 mode-0600 canonical pairing record；API 在每次 append 前重新验证该 record，安装/卸载无需重启即可生效。固定扩展 ID `mjpbglbfkbjhnamnafkodgdpgfhjoife` 已在真实隔离 Chrome 中加载，Chrome 确实启动安装后的 launcher，helper socket 在 15 分钟窗口内健康。首次消息 gate 使用空的隔离 profile，因此没有出现登录态 `/c/<id>`、没有发送 nonce；该缺口不是产品失败，而是验证坐标不含登录态。现有-profile dogfood 模式现显式选择 Chrome `Local State` 注册的 profile，拒绝复制 Cookie，并在日常 Chrome 持有 SingletonLock 时返回 `CHROME_PROFILE_IN_USE`。developer Host 已安装；unpacked extension 仍等 Chrome 原生用户确认，消息 DOM ID / retry / foreground invariants 继续为 `NOT_OBSERVED`。
- **You in-place message live gate（2026-08-20）**：operator在日常 You profile 确认 unpacked extension 后，gate 复用已运行 Chrome；没有 launch/close/restart 浏览器，也没有复制 profile 或读取 Cookie。Gate 先经 `NSRunningApplication` 确认 owner Chrome 已在运行，并把后续 Scripting Bridge 事件固定到该次观察到的 PID；不存在 bundle/name fallback，因此进程在检查后退出也只会让 PID target 失败，不能由 gate 重新启动 Chrome。未运行时以 `OWNER_CHROME_NOT_RUNNING` 终止；每次 append 前还会重验同一 control tab，目标 conversation 被重新选中即以 `TARGET_TAB_RESELECTED` 零发送终止。Chrome 从 per-user manifest 启动 content-addressed helper，真实登录态后台 conversation 返回 DOM-owned `hostMessageId`；相同 idempotency key 重试返回同一 ID，control tab 全程保持前台。旧 launcher 的 `#!/usr/bin/env node` 在 Chrome GUI PATH 下不可达，现改为安装时固化经验证的绝对 `process.execPath` + `native-host-cli.mjs`；无 secret 进入 launcher。focused gate build + 62/62 PASS，AC-FS1/2/3 均关闭。
- **Zero-focus multi-authorization correction（2026-08-21）**：扩展只在用户主动点击“授权此会话”时把 canonical `/c/<id>` 交给 Native Host；Host 把原 schema-v1 单 binding 无损迁移为 schema-v2 collection，mode-0600 原子持久化且最多 32 项。新授权按 exact ID 追加，重复点击 byte-idempotent，不覆盖其他会话；损坏集合 fail closed，既不能发送也不能被新授权静默覆盖。每次 append 在 ledger admission 前要求 owner-only `cloudCatBindings` 路由 ID 属于 Host authorization collection；缺失、不匹配、损坏均 typed 零 Chrome dispatch。自动化 full seam 已同时授权 `conversation-7/8`，让两个 Clowder AI thread 的不同 source key 分别投递且各自重试只触发一次 tab send。扩展与 gate 静态契约继续禁止 tab/window/focus/navigation mutation、Cookie/profile copy与 private API。
- **Owner-friendly product card（2026-08-21）**：Console 插件页使用仓内正式 `/avatars/gpt-pro.png`，MV3 manifest 使用从同一资产确定性生成的 16/32/48/128 图标。owner-only/local-only API 投影 Web Store publication、Host、authorization collection 与 live 状态，并支持精确单项撤销；非 owner、非 loopback、forwarded 或不可信 Origin 在读取前拒绝。卡片不再输出 repository/source path 或 `chrome://extensions` 指令。`CAT_CAFE_PERSONAL_CHROME_WEB_STORE_URL` 只有严格匹配 `chromewebstore.google.com` 与固定 extension ID 时才算 `published`；为空时显示“集成已就绪、尚未公开发布”并在 Host mutation 前返回 `CHROME_WEB_STORE_LISTING_NOT_CONFIGURED`。配置可信 listing 后，一次 Settings 安装操作准备 Host 并打开 Web Store，仍只由 Chrome 完成“添加扩展/权限”原生确认。Windows 稳定 unsupported。当前外部 blocker 是公共 package PR 与 Chrome Web Store listing/发布权限，不能宣称已经公开发布。
- **Authorization → current-thread route product completion（2026-08-23）**：Settings 现在明确展示两个不同 authority：扩展/Host 的最多 32 项 exact conversation authorization collection，以及当前 Clowder AI thread 的 owner-only `cloudCatBindings.gpt-pro` 一对一路由。owner 只从已授权 collection 中选择当前 thread 的目标；route 指向已撤销 authorization 时投影 degraded + replacement，不自动猜绑。该 consumer 只调用既有 owner-only sidecar API，不把 conversation route 放回默认 thread context、memory、export 或 cross-post。
- **Multiline contenteditable normalization repair（2026-08-23）**：正式 runtime delta 的多行文本允许 ChatGPT 把单 text node 等价规范化为 direct `<p>` / `<div>` blocks，每个 block 只接受直接 text / `<br>`；adapter 以不 trim、不折叠字符的 exact DOM-text serializer 完成插入与 submit 前 recheck。nested block、unknown/mixed DOM、改变一个字符、conversation、owner draft 或 send button 仍在 click 前 typed fail closed 并恢复空 composer。deterministic regression 覆盖真实 `<thread-runtime>\nJSON\n...</thread-runtime>\n\nintent` 形状与 nested-DIV 零点击反例。
- **PR #3857 后 owner-click real dogfood（2026-08-23, OBSERVED/PASS）**：刷新扩展与目标 ChatGPT page 后，You 登录态 conversation 经 Native Messaging 完成 background append，DOM `hostMessageId=9d752dbe-fe46-4222-901b-9f9a3b406012`；相同 source key 重试返回同一 ID，Chrome 生命周期与前台焦点均未变化。刷新前的失败保留为诊断历史：运行中的 extension worker 使用 stale dynamic import / artifact，不能用“仓内代码已更新”推断浏览器已加载；刷新后才形成有效 live evidence。随后 gpt-pro 通过 Remote MCP 回到原 thread，消息 `0001787473882500-000044-5017a9e1` 与 `0001787474150083-000059-86e0d67b` 可追溯。该证据关闭真实 background delivery（AC-F5），但 operator diagnostic script 不是从富卡授权开始，故不关闭 AC-F4/AC-F8。
- **Source-bound return + proactive append split（2026-08-23，2026-08-25 scope correction）**：正常 cloud runtime delta 现在携带 exact `sourceMessageId` 与 server-signed opaque `cloudReturnBinding`。gpt-pro 一旦提交 `replyTo` 或 binding 就进入严格 source-bound return 通道：两者必须同时存在，服务端把 token 绑定到 owner user / thread / exact source / dispatch / target cat，缺失、替换或跨 scope 一律拒绝，仍复用 F264 `replyTo` 投影而不造第二套 reply linkage。没有 source/reply 语义的独立主动消息不伪造这对字段，继续走 agent-key append-only 通道；该通道仍拒绝 replace-final、review verdict、coordination 与 structured action。normal dispatch 同时在原 thread 持久化 refs-only typed receipt，且落盘前验证 source 同 thread、published/public-safe、sender invocation、dispatch invocation 与 target；历史坏 receipt 的 F5 preview 也走 same-thread gate。receipt 保留 source/sender invocation/dispatch invocation/target/status/transport/hostMessageId/idempotent replay truth；conversation ID、pairing secret、Cookie 与完整 payload 不进入 durable audit。旧 PinchTab 没有真实 host receipt 时只能投影 `unknown`，不能冒充 `sent`。Settings 仍只承担健康摘要，canonical audit 在 thread 时间线。
- **ProseMirror transaction + revision-honest gate（2026-08-23, deterministic PASS / owner live pending）**：公开的当前 ChatGPT ProseMirror 实页捕获与五次 owner failure 共同推翻 #3903 的 jsdom-only direct DOM projection。adapter 现只用浏览器原生 editor transaction，真实 text-free shape 固化为 fixture；unknown/nested/mixed 节点返回首个 path 与最多 12 节点 fingerprint，producer 对超长/不可表示 tag 降级为 bounded node type、按 DOM `uint32` 精确保留 child index/count，prompt/conversation/token/credential 不进入诊断。真实 comment、长 custom tag 与 index `10000` 的 product-chain regressions 均穿过 native/shared durable receipt；超界 forged diagnostics 仍 fail closed。normal append 与 health 使用 protocol v2，验证 Helper artifact digest、extension `0.2.0`、page adapter `2026-08-23.1`；legacy v1 在 Chrome dispatch 前拒绝，Settings 区分 `connected` / `stale_adapter`。managed live gate 不 append nonce，只等待 canonical Host receipt 与 exact source-bound gpt-pro return；实现 thread 未触碰 owner Chrome，故不冒充 AC-F8 live PASS。
- **Owner-observed trailingBreak correction（2026-08-24, deterministic PASS / AC-F8 pending）**：唯一获授权的 managed live nonce（source `0001787559631890-000038-ad2fd178`）在 runtime / Helper / extension / page revision 全部一致后仍以 `COMPOSER_INSERT_FAILED` 结束，零 click、无 `hostMessageId`、无 gpt-pro 回程。bounded diagnostic 首次捕获插入后的 production shape：首个非空 `P` 为 direct text 后跟 `BR.ProseMirror-trailingBreak`，另有 sole-BR 空段。旧 serializer 把该 filler 计作 `\n`，外层 block join 又补一个 `\n`，造成语义双换行。v14 仅忽略真正位于 direct block 末尾的 trailing filler；普通 BR 仍是用户硬换行，错位 filler 与 unknown/nested DOM 继续 fail closed 并恢复空 composer。production fixture 与 RED→GREEN 回归覆盖这些边界；没有发送第二枚 nonce或操作 owner Chrome，因此 AC-F8 仍保持 pending。
- **MV3 Native Messaging self-recovery（2026-08-24, deterministic PASS / owner live pending）**：post-merge normal source `0001787580153525-000024-5322217a` 在 authorization count=2、current-thread exact route 与 runtime revision 均有效时仍以“无可用 Host Adapter”终止，零 host receipt。根因不是授权失效：service worker 的 `onDisconnect` 只注册 `setTimeout`，而 MV3 worker 被回收时 timer 会随之消失。v15 保留 1 秒 fast retry，并新增 `chrome.alarms` browser-owned fallback：alarm 事件会唤醒 worker，重新建立 `connectNative`；owner 不再重复授权或点击扩展图标。extension revision 升至 `0.2.1`，避免旧 `0.2.0` worker 冒充 current。实现阶段没有触碰 owner Chrome或重放消息；AC-F8 继续等待合入后真实 `hostMessageId` 与 exact source-bound gpt-pro return。
- **Reload-safe content-script bootstrap（2026-08-24, deterministic PASS / owner live pending）**：owner source `0001787621647407-000027-f4ea9782` 在 runtime 与磁盘 artifact 已新鲜时仍捕获 `Failed to fetch dynamically imported module: …/chatgpt-page-adapter.mjs`；normal health 同时返回 `CONTENT_SCRIPT_UNAVAILABLE`。v17 把 adapter module graph 确定性打包进单一 classic `content-script.js`，删除 module web exposure，并将 extension revision 升至 `0.2.2`。真实 Chrome fixture 主动拒绝所有 runtime `.mjs` fetch：旧版精确 RED，新版 `runtimeModuleFetchCount=0` 且 Host receipt / idempotent retry / zero-focus 全绿。实现阶段未操作 owner Chrome、未重放 nonce；AC-F8 继续等待 post-merge 真实 `hostMessageId` 与 exact source-bound gpt-pro return。

### 待验证 ⚠️
- **ChatGPT Scheduled Tasks 能否调 Custom MCP Connector**（spike log 0 收到 + operator R1 指出 AI Blog Patrol 也可能没真跑：**待验证不写硬结论**；即使可用也仅作非实时兜底，不承担即时 `@gpt-pro`）
- **Custom Instructions 实际字符上限**（需 You 当前 UI 实测）
- **Custom GPT 不读 ChatGPT 主流 memory**（operator实测确认）→ 路径修正为 Custom Instructions

### B1a 已知限制（OpenAI 平台行为，不可控）
- ChatGPT 端**对 `readOnlyHint=false` 工具 safety check 更严格**：
  - Maine Coon云端调 `post_message` / `cross_post_message` 时偶尔被 "OpenAI 安全检查屏蔽"
  - read 工具（list_threads / search_evidence 等）后期不被拦
  - 写工具看起来需要 user 显式确认（ChatGPT UI 弹 confirm button）
  - 修不了：这是 OpenAI 平台设计，B1b 升级可考虑 OAuth bearer / user-in-loop 减少 user friction

### 未做 ❌
- 公网 endpoint 真 auth（B0 disposable token-in-URL ≠ production；B1**a interim** 公网 + `?token=` 单防线接受降级；B1**b** 必须 verified CF Access OAuth 或 header-auth）
- 前端 bubble 渲染优化（catalog hot-add 显示 "Maine CoonPro(Pro Cloud (ChatGPT))" + fallback avatar 已 work；Phase C 升级真头像 + 气泡风格）
- 多 provider 配置 UI（"配置云端猫"页面）
- Chrome Web Store 签名 extension 的实际公开 listing；Clowder AI listing 集成与发布阻断状态已就绪，但当前没有发布权限/URL，不能宣称已经公开发布

## User Journey

1. operator在 Clowder AI 插件市场点击安装 Cloud Cat plugin；向导安装本地 Native Messaging helper，并打开官方 Chrome Web Store 页面。Chrome 仍要求用户确认一次“添加扩展/权限”，插件不得静默绕过浏览器授权。
2. 用户可在多个 ChatGPT conversation 分别点击“授权此会话”；Native Host 追加 exact conversation authorization，重复点击不覆盖其它项。回到 Clowder AI Settings 后，“当前 thread 路由”从该 authorization collection 中选择精确一个 conversation 并写入 owner-only `cloudCatBindings(threadId, gpt-pro)`；不要求手写 API/URL，也不把 route 暴露到默认 thread payload。正常投递要求 route ID 仍位于 Host authorization collection。
3. 用户在 Clowder AI `@gpt-pro` 后先看到转发富文本：目标 conversation、实际唤醒胶囊和数据边界一目了然。点击“发送并唤醒”才签发一次性 delivery ticket；也可选择“复制并打开”或取消。
4. Chrome extension 通过 Native Messaging 向本地 helper 接单，在不聚焦窗口、不读取 Cookie、不调用 ChatGPT 私有 API 的前提下，把唤醒胶囊送进绑定 conversation。只有观察到真实 `hostMessageId` 才显示“已发送”；否则停在“已填入”或降级为“已复制并打开”。
5. 云端猫收到胶囊后用自己的 `catId` / agent-key 读取完整 thread context，完成任务并通过 `post_message` / `cross_post_message` 回到猫咖；胶囊本身不复制整段历史。
6. Hub 显示云端猫的独立身份、头像、气泡颜色、provider 来源与投递状态，让用户能阅读、追责和重试，而不是把云端输出混进本地猫身份。

## What

6 个核心能力 + 6 个 Phase。

### 2.1 云端猫身份系统

**catId / runtime identity / agent-key subject 统一为 `gpt-pro`**（Maine Coon R2 verdict + R3 confirm）。**不留** `yanyan-cloud` 作为持久 identity 或 codename 双 vocabulary（R3 P1-2 要求）。

**身份注册有两层（B1a 实测后修正自Maine Coon R3 P2-4）**：

1. **`cat-config.json` roster — mint allowlist only**（`mint-agent-key/parse.ts:95-105` 消费）。
   只用字段：family / roles / lead / available / evaluation。
   **不消费**：provider / model_handle / avatar / color（roster 没这些字段）。

```json
"gpt-pro": {
  "family": "maine-coon-cloud",
  "roles": ["design-gate", "peer-reviewer", "vision-guard"],
  "lead": false,
  "available": true,
  "evaluation": "云端 ChatGPT Pro Maine Coon Pro，高阶判断席位"
}
```

2. **`.cat-cafe/cat-catalog.json` runtime catRegistry — runtime cat / callback API routing**（`packages/api/src/routes/cats.ts:485 catRegistry.register(id, config)` 消费）。
   **正确做法**：通过 `POST /api/cats` API endpoint 注入，**0 重启**（详见 LL-cat-cafe-api-has-hot-reload）。
   **错误推测**（R3 P2-4 + 47 B1a 早期）：以为要改 `cat-config.json` 的 `breeds[].variants[]` + 重启 API。
   **实际**：runtime 不读 `cat-config.json` 的 breeds，读 `.cat-cafe/cat-catalog.json` runtime data 文件。POST API 会持久化到 runtime catalog。

3. **`breeds[].variants[]` (cat-config.json)** — **design-time** template，影响 UI render 默认值 + breed catId mapping。**不参与 runtime catRegistry**。Phase C scope 简化为：avatar / bubble UX 设计 + UI render verify，不需要为 gpt-pro 加 breeds entry。

displayName "Maine CoonPro"（变体: "Pro Cloud (ChatGPT)"），昵称 "Maine CoonPro"，签名 `[Maine CoonPro/gpt-pro🐾]`，与本地 `codex`（@gpt-5.5）词面区分。

### 2.2 前端 bubble/avatar 渲染（Phase C 范围）

> **R13.5 corrected (48 实测推翻 47 R13 KD-16)**：B1a 的 `POST /api/cats` **已正确持久化** gpt-pro 到主服务实例 `cat-cafe-runtime/.cat-cafe/cat-catalog.json`（line 1394 顶层 breed entry + variant，mtime 6-22 = B1a 注册时间，`createRuntimeCat` writeFileSync 落盘 + 启动 load 恢复 OK）。47 R13 grep 错坐标看了 worktree 系死 catalog（mtime 6-15）。真 P1 = runtime catalog 中 gpt-pro entry 的 `avatar` 字段值 stale `/avatars/gpt52.png`（B1a 占位 fallback），需 `PATCH /api/cats/gpt-pro {avatar}` 走 `updateRuntimeCat` 改成 `/avatars/gpt-pro.png` 让 live 头像真换。同时 gpt52 R13 P1-2 仍对：bootstrap 真相源 = `cat-template.json` + `pickSeedBreed` 只 seed `breeds[0]`=ragdoll → 改 cat-config.json 对 live + fresh install 都不生效，撤回。Phase C scope = asset + doc（this PR）+ runtime avatar 字段切换 (AC-C-1b post-merge ops)：

- 头像设计由 **云端Maine Coon self-design** ✅（用 F229 `yanyan-codex-character-base-v1.png` 母图作 reference；KD-15）；@gemini（Siamese）从原画作者改为 **审美 verifier**（AC-C-2）
- ChatMessage 组件 verify `Maine CoonPro(Pro Cloud (ChatGPT))` 渲染正确（B1a 实测已显示对，Phase C 抛光）
- 云端猫气泡背景按 catId color theme（B1a `#2196F3` 蓝已注册到 runtime catalog 持久化，live 已生效）
- 左下角 "via ChatGPT Pro" tag（透明度低，提示来源）
- Cat picker UX 加 cloud cat 类别 + provider tag

### 2.3 多 provider 接入框架（Phase D 范围）

Console settings "配置云端猫" 流程：
1. 选 provider：ChatGPT Web / Claude.ai Web / Gemini Web / 其他
2. 选 model：从 provider available models 列表选
3. 系统自动生成 token + URL，复制到剪贴板
4. 用户在 provider Web 创建 connector 填 URL
5. 系统调 `POST /api/cats` 热加载新云端猫到 catRegistry + 持久化 catalog（runtime 路径，不动 cat-config.json breeds.variants）

### 2.4 ChatGPT 端协同协议（Custom Instructions 路径）

- Settings → Personalization → **Custom Instructions** 灌"短 L0"（精简身份 + 真相源优先级 + 自治边界 + 路由协议 + 质量门禁 + 工具无关的等待表述）
- ChatGPT memory 持久 → Maine Coon跨 thread 保留跟operator聊过的事
- 普通对话 + Custom Instructions + cat-cafe-toolkits Connector + GitHub Connector = Maine Coon Pro 完整工作配置

短 L0 工件位置：`cat-cafe-skills/refs/gpt-pro-custom-instructions.md`（采用Maine Coon R3 1175 字符版本 + R5 工具无关替换）。

### 2.5 召唤机制（user-driven，**R4 + R5 corrected**）

> **R4 关键 correction**：**不能用 `search_evidence + list_recent` 伪装 pending polling 语义**。语义不等价（无 cursor、无 ack），会引回历史 bug（LL 2026-02-16 跨 session 重复处理根因）。

**B0 harness（mock）召唤**：
- **无 polling**（无论 ChatGPT 端 Tasks 还是 startup 自检都 disabled）
- operator**手动**让Maine Coon调 stub 验证 transport
- Custom Instructions L0 段**砍掉**任何 "启动 polling / 自检 pending" 指令

**B1 production 召唤**：
- 已验证基线仍是 **user-driven**：operator启 ChatGPT 对话指明 context → Maine Coon用 `list_threads` / `get_thread_context` 定位 → 处理 → `post_message` 推回
- 复用 fable phase0 10 工具白名单（5 collab + 5 memory），**不含** `get_pending_mentions / ack_mentions / task tools / hold_ball`
- **不声称** pending polling 能力

**个人版实时召唤目标 — Personal Chrome Host Adapter（2026-08-12 operator 收敛）**：
- `@gpt-pro` 先产生一张 user-visible 转发卡，不立即碰 ChatGPT：展示目标 conversation、唤醒胶囊与三种 disposition（发送并唤醒 / 复制并打开 / 取消）
- 用户点击“发送并唤醒”是本次 delivery 的显式授权；Clowder AI 以持久化 source message ID 作为 `idempotencyKey`，签发一次性、短时、绑定 conversation 的 delivery ticket
- Clowder AI plugin 管安装/配对，Chrome extension 管 `chatgpt.com` 页面内投递，Native Messaging helper 管本地可信边界；扩展不读取 Cookie、不调用私有 ChatGPT API、不使用系统鼠标
- extension 可操作已绑定的非前台 tab；只有观察到 ChatGPT 真实 user-message ID，才履行现有 `append_message(...) -> {hostMessageId}` 契约并显示“已发送”
- DOM、登录态、tab 或 message-ID 观察任一步失败均 fail closed：优先停在“已填入，等待用户发送”，再降级“复制并打开准确 conversation”；不得用 extension receipt 冒充 host receipt
- 唤醒胶囊只携带 `threadId/sourceMessageId/intent/traceNonce` 等运行时增量；云端Maine Coon通过 MCP 拉完整上下文并回写，避免浏览器桥复制整段 thread

**真自动 polling — 非实时可选兜底（独立 spec）**：
- 必须**成对**引入 `get_pending_mentions + ack_mentions`（cursor + explicit ack）
- 必须做单独安全 review（白名单扩张、跨 session cursor 持久性、ack idempotency）
- **不能用 `search_evidence` 伪装 polling 语义**
- 触发条件：实测 ChatGPT Tasks 真能调 Custom Connector + bench Maine Coon polling 流的安全/语义/UX → 才考虑升级；即使成立也不替代实时 Chrome Host Adapter，因为小时级唤醒不满足即时 `@` 体验

### 2.6 GitHub Connector 集成 ✅ 确认

operator 2026-06-21 06:54 UTC 确认：**ChatGPT 官方 GitHub Connector 已用**。Maine Coon通过 GitHub Connector 访问 `github.com/zts212653/cat-cafe`：看 PR diff / code / commit log。

**Scope 简化**：cat-cafe MCP 不暴露 file_slice 等 code 工具，code 走 GitHub Connector。cat-cafe MCP 只暴露 cat-cafe 独有（thread / message / memory），**48 R2 P0 暴露面减一档**。

## Phase 划分

### Phase A — Design Gate + 策略明确 ✅ done

### Phase B — gpt-pro 单云端猫 production 接入

**B0 (transport / mock harness)** —— 不涉及 6399 / 不涉及 agent-key / 不接真 cat-cafe data：

1. spike server v2（commit `995a9fb2b`）：echo + 5 mock `_stub` tools，redact 模块，token middleware
2. **disposable harness guard**：`?token=<secret>` query param + Bearer header；**短期一次性，spike 结束时 explicit cleanup**（删 token + revoke quick tunnel）
3. 不叫"production-ready"——这是 harness
4. Maine Coon ChatGPT 端能 list 6 工具 + 调 stub 拿 wiring OK 证据

**B1 (real toolset gate)** —— 涉及真 cat-cafe data：

1. **必须**：verified CF Access OAuth **或** verified header-auth（实测 ChatGPT connector 支持何种 → 选定）
2. **禁用** `?token=` 作为长期 production auth（OWASP 反对 secret-in-URL；48 R1 R2 严守）
3. mint gpt-pro agent-key（dry-run report 给 operator 过目，等明确 OK）
4. cat-config.json roster 注册 gpt-pro（mint allowlist only）
5. 升级 spike → `remote.ts`：替换 5 stub 为真 toolset 注册（复用 fable phase0 同 10 项白名单：post_message / cross_post_message / get_thread_context / list_threads / get_message + search_evidence / graph_resolve / list_recent / list_session_chain / read_session_digest）
6. 加 agent-key principal injection + `CAT_CAFE_DESKTOP_MODE=cloud-pro-phase0`（或同语义 mode）

### Phase C — 前端 bubble/avatar UX 优化（runtime avatar 切换）🔄 in-progress (AC-C-1a/1b done 2026-06-24, AC-C-2/3/4 pending)

> **48 R13.5 实测推翻 47 R13 KD-16**：47 R13 "B1a 没持久化、重启即丢" 是 grep 错坐标的 wrong finding。
> 真相是：B1a `POST /api/cats` **已正确持久化** gpt-pro 到主服务实例（`cat-cafe-runtime`）的 runtime catalog
> （`cat-cafe-runtime/.cat-cafe/cat-catalog.json` 顶层 breed entry，mtime 6-22 B1a 注册时间，重启从文件 load 恢复 OK）。
> 我之前 grep 的是 `cat-cafe/.cat-cafe/cat-catalog.json`（worktree 系隔离 runtime state，死文件 mtime 6-15）——
> **运行实例的 projectRoot 跟 worktree projectRoot 不同**，这是第三次 grep 错坐标（详见 47 自审段 + LL-todo）。
>
> **真正的 P1（gpt52 R12 + 48 R13.5 双 confirm）**：runtime catalog `gpt-pro.avatar` 字段值 **= `/avatars/gpt52.png`**
> （B1a 注册时占位 fallback），需 `updateRuntimeCat` (`PATCH /api/cats/gpt-pro {avatar}`) 改成 `/avatars/gpt-pro.png` —— 这是让 live 头像真换的动作（gpt52 R12 P1 本意）。
>
> **关于 cat-config.json**（gpt52 R13 P1-2）：bootstrap 真相源是 `cat-template.json`，且 `pickSeedBreed` 只 seed `breeds[0]`=ragdoll，
> maine-coon 跳过 → 改 cat-config.json 对 live + fresh install 都 0 生效，撤回保持 PR scope 最小（asset + doc only）。

- [x] **AC-C-1a — asset + doc 落地**（2026-06-24）— 云端Maine Coon self-design avatar（用 F229 `yanyan-codex-character-base-v1.png` 母图作 reference，operator 选 candidate A）：
  - asset `packages/web/public/avatars/gpt-pro.png` 上线（runtime catalog avatar 字段切换后 reference 的目标路径）
  - 视觉元素：Clowder AI 招牌 + 蓝霓虹 cloud icon + "Maine Coon Pro" 标题 + "gpt-pro" 杯 + "补锅中"飘带（Maine Coon self-aware 彩蛋）→ 跟本地 gpt52 视觉强区分（KD-15）
- [x] **AC-C-1b — runtime avatar 字段切换**（post-merge ops done 2026-06-24 19:42 PT）— 主服务实例 `cat-cafe-runtime` 的 runtime catalog gpt-pro entry avatar 字段 `PATCH /api/cats/gpt-pro` 切到 `/avatars/gpt-pro.png`：
  - 执行：`curl -X PATCH http://localhost:3004/api/cats/gpt-pro -H 'X-Cat-Cafe-User: opus-47' -d '{"avatar":"/avatars/gpt-pro.png"}'` → response cat.avatar = `/avatars/gpt-pro.png`
  - Live verify：`GET /api/cats` 返回 gpt-pro.avatar = `/avatars/gpt-pro.png` ✅
  - Persisted verify：`cat-cafe-runtime/.cat-cafe/cat-catalog.json` breed.avatar = `/avatars/gpt-pro.png` ✅（落盘 + 重启不丢）
- [x] ChatMessage 组件 verify `Maine CoonPro(Pro Cloud (ChatGPT))` 渲染（B1a 实测已 work，Phase C 抛光）— AC-C-3 (`5d5c84653` / PR #2654): 长 label responsive truncation (`max-w-[140px/200px/280px]`) + title tooltip + timestamp `shrink-0`
- [x] Cat picker 加 cloud cat 类别 + "via ChatGPT Pro" tag — AC-C-4 (`5d5c84653` / PR #2654): `CLOUD_PROVIDER_LABELS` prefix-match table + `CatOption.isCloud/providerLabel` + pill badge UI
- [x] 气泡 color theme UI 渲染抛光（catalog 已持久化 `#2196F3` 蓝，前端微调）— **environmental satisfaction**，无需独立 PR：runtime catalog 持久化 `color: {primary: "#2196F3", secondary: "#90CAF9"}`（B1a 注册时 seed + `12ef8ce05`/PR #2653 同步进 cat-template.json）+ 前端 `catColorVar('gpt-pro', 'primary')` 通过 CSS var `--cat-gpt-pro-primary` 自动 pull through，无 hardcoded color。47 愿景守护 audit verify (2026-06-29 PT) 确认渲染链路自动满足，未来 catalog 改色立刻生效
- [x] @gemini35 愿景守护 avatar 审美 verify（小尺寸 cropped + 跟本地 gpt52 区分度）— AC-C-2 APPROVED by gemini35（视觉区分度极高：正面睁眼+咖啡杯+蓝霓虹 vs gpt52 横卧闭眼+纯白）

### Phase B1c-0 — MCP Wrapper Lifecycle Hygiene Gate（B1c 前置）✅ implementation done

> **B1c 前置 gate**（codex/Maine Coon R0 verdict + operator go）。**B1c spec 在 PR #2553**（open），本 phase 独立修底座。
>
> **背景**：browser-automation 后端（agent-browser / playwright / pinchtab）的 npx MCP wrapper **不退**，每次 cat invocation 累积 zombie（已观察 7 天 zombie + 多 backend 全部累积）。LL-056 + feedback_agent_browser_zombie 5 次 reocurrence；wrapper lifecycle 是工具 design 限制，升级 MCP 也修不了。B1c-0 修底座，B1c 才有意义（不修就让operator手动清，违反"自相矛盾"原则）。

**实现 scope**：
- 扩展 `scripts/cleanup-stale-dev-processes.mjs` 加 3 个 rule（严格白名单 + 8h age threshold）：
  - `stale-agent-browser-mcp-wrapper`：match `agent-browser-mcp`（跟已有 `agent-browser-cli` orphan rule 不冲突，那个 require ppid=1）
  - `stale-playwright-mcp-wrapper`：match `@playwright/mcp` 或 `playwright-mcp`
  - `stale-pinchtab-mcp-wrapper`：match `pinchtab ... mcp` / `pinchtab-mcp`，**显式排除** `pinchtab server` / `pinchtab bridge`（长寿命非 MCP daemon）
- 测试覆盖 22 项新增（8 positive + 14 negative，含 sanctuary fixtures：pinchtab server/bridge 永不杀，<8h fresh 不杀，generic node/npm 不杀，playwright test runner 不杀；**R1 加 6 项 negative**：`pinchtab-darwin-arm64 server/bridge --upstream-mcp-config` 不杀、marker 在 unrelated arg 里不杀、npm exec 非 MCP target 不杀；**R2 加 3 项 positive**：direct `pinchtab-mcp` binary (unqualified / 绝对路径 / npm exec form) 命中 — 修 R2 P2 claim/impl mismatch）
- **R1 matcher 重写**：从 substring search 改成 **command-structure parsing**（executable basename + first subcommand），避免 `pinchtab-darwin-arm64 server --upstream-mcp-config /tmp/x` 被 substring `mcp` 误命中（codex R1 P1 catch）。pinchtab binary 支持 `pinchtab` / `pinchtab-mcp` / 任意 platform 后缀 (`pinchtab-darwin-arm64` / `pinchtab-linux-x64` 等)，但 sub-command 必须 == `mcp`
- `scripts/launchd/cat-cafe.mcp-cleanup.plist.template` + `INSTALL.md` runbook（**模板进 git，不自动 install**——operator 看 dry-run 后手动 `launchctl load`，每天 04:00 跑 `pnpm process:cleanup`）

**hard 约束（codex R0 3 条接受 + 实施落地）**：
1. ❌ 不写独立 kill shell — 只扩展已测试 `pnpm process:cleanup` 入口
2. ❌ launchd 不自动 install — 模板进 PR，operator 手动加载（持久 OS automation 需要 explicit opt-in）
3. ✅ 匹配规则极窄 — pinchtab server/bridge 不杀 / generic node/npm/playwright 不杀，negative test fixture 全覆盖

**Real-system dry-run verify**：实测 process list 命中 3 类 stale MCP wrapper（agent-browser-mcp / @playwright/mcp / pinchtab-mcp），**未误杀** pinchtab server / pinchtab bridge / 已有 agent-browser-cli orphan rule 仍 work。

### Phase B1c — Auto Cloud Invocation Bridge（local @ → cloud notify, thread-bound）📋 spec v2

> **触发起因（2026-06-25 operator challenge）**：B1a 让用户人肉粘贴 prompt 进 ChatGPT 测试 → 跟 cc/cat 自己用 browser automation 跑 deepsearch + image gen 自相矛盾。**KD-6 "user-driven" 不该被误解成"user 手指必须动"**——browser automation 用 user chrome session + user account 是合法 user-driven 代理。
>
> **Phase B1c-0 prerequisite ✅ done** (PR #2556 squash `301f29eba`): MCP wrapper lifecycle hygiene gate landed，底座修了。B1c 现可在干净底座上 implement.
>
> **operator R1 catch (2026-06-25 23:46 PT)**：bridge 投递到 ChatGPT 端**哪个 chat**？v1 spec 漏了这层架构——每次 mention 新建 chat = sidebar 爆炸 + Maine Coon Pro 失去 conversation continuity；投到 active chat = 打断他当前讨论。**必须做 thread↔chat binding (KD-20)**。

**目标**：本地猫 @ gpt-pro → cat-cafe 通过宿主提供的 background Host Adapter，向 **该 thread 已绑定的 conversation** 追加 mention 通知（带 thread context）→ Maine Coon Pro 看到后 MCP read 拉详情 + 写回复。**全程零人肉粘贴、零前台 UI 接管。** Host 未暴露能力时明确 fallback；只有 operator 显式 opt-in 才允许旧 PinchTab 路径创建/修复 binding。

#### Design 要点

**1. Backend priority = Host Adapter；PinchTab 降级为显式 opt-in legacy**（2026-08-08 supersedes 原“PinchTab 单一”）
- 首选 Host-owned 窄接口：`append_message(conversationId, text, idempotencyKey)`，成功必须返回 non-empty host message ID；conversation ID 来自 owner-only thread binding，idempotency key 来自持久化 source message ID
- Host Adapter 缺失 / receipt 无效 / append 失败：typed fallback，**不**自动启动 PinchTab / composer / CGEvent；这保证后台服务不会抢用户鼠标和前台画面
- 当前 OpenAI 公共 Host 能力只证明 Codex Quick Chat 可引用 ChatGPT conversation，不足以证明 server 可向任意 conversation 追加并取回 host message ID；provider 保持 `null`，直到官方能力真实出现
- PinchTab 旧路径只在 operator 显式设置 `CAT_CAFE_ENABLE_LEGACY_PINCHTAB_BRIDGE=1` 时启用，用于兼容/诊断，不再是默认行为

**历史实现：PinchTab adapter**
- 跨族（Maine Coon/Siamese/Ragdoll都能用），不像 claude-in-chrome 仅 Anthropic 系
- attach 现有 chrome session（不开新 browser profile，减少 zombie 面）
- **可用工具实测**（codex R1 P1-A + 47 ref verify）：`pinchtab_eval` / `pinchtab_get_text` / `pinchtab_navigate` (localhost only) / `pinchtab_screenshot` / `pinchtab_snapshot`。**没有** `pinchtab_get_url` / `pinchtab_list_tabs` / `pinchtab_click` / `pinchtab_type` / `pinchtab_press`——v1 spec 误写
- **外网导航必须走 eval**（refs/pinchtab.md：Clash TUN 下 `pinchtab_navigate` 外网 403；eval 让浏览器自己走代理）
- **不抽象多 backend layer**（"只搞一个"，agent-browser 作 PinchTab 失败时 fallback 由 future PR 引入）

**2. Thread↔Chat Binding (KD-20) — operator R1 拍板**

数据 model：cat-cafe thread metadata 新增字段 `cloudCatBindings: {[catId]: chatUrl}`，例如：
```json
{
  "threadId": "[thread-id]",
  "cloudCatBindings": {
    "gpt-pro": "https://chatgpt.com/c/<conversation-id>"
  }
}
```

绑定 lifecycle（lazy + auto-self-heal）：
- **Lazy 不预绑**：thread 创建时**不**预先开 chat
- **首次 @ gpt-pro**：bridge 在 ChatGPT 端开新 chat → URL 包含 `chatgpt.com/c/<conversation-id>` → capture URL → 写 thread metadata
- **后续 @ 同 thread**：bridge 查 thread metadata → 找到 bound URL → navigate to bound chat → 投通知
- **Binding stale**（你删了 chat / ChatGPT 端 reset）：bridge navigate 失败检测 → 自动 re-open new chat + update binding，不要求用户手动重绑
- **多云端猫场景**：每只 cloud cat 一条 binding（`cloudCatBindings.gpt-pro` / `cloudCatBindings.claude-pro` 互不冲突）

**3. 触发点**（跟 KD-17 dispatch guard 集成）
- `invokeSingleCat` 看到 `provider === 'openai-chatgpt-pro'` → 跳过 provider CLI，但仍创建 durable child invocation，并在 prompt exposure 后触发 cloud-invoke-bridge
- bridge 返回有界 Host transport outcome；本地 invocation **不等待云端猫回复**，但必须等待该 outcome 后发布一条可读状态
- A2A source 由同一 child 写 exact `completed` disposition，再 `done`；缺 adapter/receipt 也终结该 source，禁止 silent completion → governance error → Queue replay
- API composition 仅在 socket + pairing secret 同时配置时启用 Personal Chrome Host Adapter；否则 typed unavailable。Legacy PinchTab 仍只允许显式 opt-in

**4. 载荷模板**（thread context-aware）

```
⚡ Clowder AI mention

From: @{sourceCatId}
Thread: {threadTitle} (id={threadId})
Reason: {mentionInlineContent}
Triggered: {ISO timestamp}

Action expected:
1. cat_cafe_get_thread_context(threadId="{threadId}", agentKeyCatId="gpt-pro", limit=10)
2. cat_cafe_post_message(threadId="{threadId}", agentKeyCatId="gpt-pro", content="...")
```

**5. Legacy browser 控制流程**（仅显式 opt-in；all-eval pattern, Clash TUN safe, lock-first ordering）

```
trigger → bridge enter
  → acquire singleflight lock (threadId, "gpt-pro") — see §8
  → re-read thread metadata cloudCatBindings["gpt-pro"]
       (MUST be inside lock — second concurrent invocation sees the
       binding written by the first one, doesn't open a duplicate chat)
  → if bound URL exists:
       pinchtab_eval(`window.location.href = ${JSON.stringify(boundUrl)}`)
       wait for navigation (poll readyState or fixed timeout)
       pinchtab_get_text() → detect 404 / chat-not-found marker
       on stale → fallback to "create new" branch below
     else (first time):
       pinchtab_eval(`window.location.href = 'https://chatgpt.com/'`)
       wait for landing — new chat is the default ChatGPT landing surface
  → inject payload via eval (find input via querySelector + dispatch input Event)
       pinchtab_eval(`(() => {
         const input = document.querySelector('<input selector>');
         input.innerText = ${JSON.stringify(payload)};
         input.dispatchEvent(new Event('input', { bubbles: true }));
       })()`)
  → submit via eval (find send button + .click(), or simulate Enter)
       pinchtab_eval(`(() => {
         const btn = document.querySelector('<send button selector>');
         btn.click();
       })()`)
  → wait for ChatGPT to navigate to /c/<conversation-id>
  → capture conversation URL via eval:
       pinchtab_eval(`window.location.href`) → returns captured URL string
  → VALIDATE captured URL before write (§7 boundary):
       MUST match ^https://chatgpt\.com/c/[a-zA-Z0-9-]+/?$
       on validation fail → emit fallback notification, do NOT write metadata
  → if first time / stale (and URL passes validation):
       write thread metadata cloudCatBindings["gpt-pro"] = capturedUrl
  → release singleflight lock
  → yield done
```

> **Eval input safety contract** (codex R2 P1): EVERY string interpolated into a `pinchtab_eval` expression — payload / boundUrl / any future field — MUST go through `JSON.stringify(...)`. Never raw interpolation: `${boundUrl}` is the v1 mistake. Even though `boundUrl` comes from stored metadata via owner-only endpoint, treat persistent state as untrusted at the JS injection boundary.
>
> **Selector reliability**: input box / send button selectors are ChatGPT DOM internals that change. Implementation 前置 spike (AC-B1c-3a) 验证当前 selector + 端到端 eval 流程；selector 失效时 fallback notification (§6).

**6. 失败 fallback**（cat-cafe `system_info` 通知本地 thread）
- Chrome 没 running / ChatGPT.com 没登录 / input box selector 失效
- → invocation 向发起 mention 的本地 thread 持久化**一条** `cloud_bridge_status: unavailable`，同时为 exact A2A source 写 `completed` disposition；不得另发 raw bridge JSON，也不得留下可被 Queue 重放的 governance error

**7. 隐私边界 — `cloudCatBindings` 是 local-only operational sidecar**（codex R1 P1-B catch）

ChatGPT conversation URL 是个人会话坐标——不能默认随 thread context / export / memory index 广播给其他猫。**Privacy contract**：

| Path | 含 `cloudCatBindings`? |
|---|---|
| `cat_cafe_get_thread_context` (默认 read API) | ❌ NEVER |
| Thread export (markdown / JSON / share) | ❌ NEVER |
| Memory index (`search_evidence` / `graph_resolve` / `list_recent`) | ❌ NEVER |
| Cross-thread post / mention | ❌ NEVER |
| 专用 `/api/threads/:id/cloud-bindings` endpoint (owner-only auth) | ✅ ONLY here |

Implementation 选择（择一，implementation PR 决定）：
- **A** (recommended)：thread metadata 加 `cloudCatBindings` field 但 read API path 显式过滤 (`SELECT * EXCLUDE cloudCatBindings`)
- **B**：完全分表 — 独立 `cloud_cat_bindings` table，`(threadId, catId)` 主键，cat-cafe runtime sidecar 维护

两者都满足 privacy contract；选 A 简单，选 B 更彻底。

**URL validation contract** (codex R2 P1)：写 binding 前 capture 的 URL 必须通过 strict regex `^https://chatgpt\.com/c/[a-zA-Z0-9-]+/?$`；失败则视为 capture corruption（DOM hijack / wrong tab / network detour），不写 metadata + emit fallback notification。读 binding 后也 re-validate 一次再 navigate（防 stored 态被绕过 endpoint auth 直接 db-write 注入恶意 URL）。

**8. Singleflight binding lock**（codex R1 P2-B + R2 P2 catch）

两个本地猫同 thread 同时 @ gpt-pro 首次：会 race 开两个 ChatGPT chat 并 race 写 metadata 互相覆盖。**Contract**（lock-first ordering）：

- Lock key: `(threadId, catId)` 唯一
- **bridge 第一动作 = acquire lock**（**先于** any metadata read，避免 codex R2 P2 stale read：pre-lock query 看到 "no binding" → lock 后仍按 first-bind 开第二个 chat）
- acquire lock 后 **必须** re-read metadata `cloudCatBindings[catId]` 决定 branch — second concurrent invocation 在 lock 内 re-query 看到 first holder 已写的 binding → navigate to bound chat（**不开第二个**）
- second invocation read post-lock → AC-B1c-9 explicit test fixture
- lock TTL：30s（覆盖 chat 创建 + URL capture latency；超时 auto-release 让重试）
- 整个 bridge 流程都在 lock 内（read → navigate → submit → capture → write → release）

#### Phase 边界

**B1c IN**：
- 自动 invocation bridge（local @ → cloud paste，零人肉）
- PinchTab 单一 backend
- Thread↔Chat O1 binding via thread metadata
- Auto self-heal stale binding
- 失败 fallback notification

**B1c OUT**：
- B1b OAuth verified auth（不同 layer，平行推进）
- 同步等回（fire-and-forget 起步；OQ-B1c-3）
- 多 provider 框架（Phase D）
- 多 user / 多 ChatGPT account（B1b → Phase D）
- agent-browser fallback（future PR，PinchTab 不稳时再加）

### Phase B1d — Supporting Services Lifecycle Integration 🆕 dogfood-ready 前置

**触发证据（2026-07-06 03:30 PT dogfood friction）**：operator 重启 cat-cafe runtime 后 `pnpm start` 只把 API (3002) 拉起来，**F247 三个 supporting services 全部离线**——Maine Coon云端 MCP 到不了 origin（HTTP 530 / "上游挂了"），forward 链路 `b1c_bridge_fallback` 报 `PinchTab Chrome unreachable`。**双向都断**。grep 全仓 0 hit 确证：F247 supporting services 从未集成到 `pnpm start` / launchd / 任何自动化入口——完全"手动起"状态。

**根因分类**：Phase B/C 只解决 **code 层 done**，运维层 zero-integration = "重启一次全炸"。dogfood 走通 = 需要 code + 运维双 done。属于 Phase F (KD-22 plug-and-play onboarding) 的**运维前置**——外部用户重启机器后不能自愈 = onboarding 白搭。

**B1d IN**：
- `pnpm start` 或 `pnpm start:cloud` supporting services 阶段（3 项）
- launchd/systemd 层重启后自愈（cloudflared daemon KeepAlive）
- 健康探针 + 失联自动 restart（先支持 cloudflared，spike server 起手）
- `pnpm cloud:status` / `pnpm cloud:doctor` operator 一眼看三层状态

**B1d OUT**：
- Personal Chrome Host Adapter 的扩展安装、helper 配对与会话绑定（涉及 UX + 浏览器权限，进 Phase E/F）；legacy PinchTab auto-open 不再作为默认 wizard 行为
- token rotation / TTL 管理（Phase B1b 范围）
- 多 provider 多 tunnel（Phase D 落地时统一改）

**关键约束**（LL from B1c-0）：
- 不新写独立 launchd plist——复用 `scripts/launchd/` 模板 + INSTALL runbook 模式，operator opt-in
- 不硬编码 token / agent-key path 到启动器——env 或 file lookup；显式 `pnpm start:cloud` 缺配置或探针失败时 fail-closed
- 故障域隔离——`pnpm start` 中 F247 是 optional capability：缺配置时 skip + WARN；supporting service、公网 tunnel、authenticated MCP 或 cloud principal 失败时 cleanup + degraded + WARN，**不得终止本地 frontend/API/Redis**
- 探针重试只覆盖瞬时故障（network/timeout/408/425/429/5xx），预算有界；401/403 等确定性 auth 错误立即降级或失败，不重试

**B1d lifecycle runbook (PR-C implementation)**：

```bash
# Status only; no side effects.
pnpm cloud:status

# Diagnostic tree + exact restore commands; never prints token values.

# Now includes authenticated MCP initialize probe — catches token mismatch

# that /health alone cannot detect (green health + 401 authenticated MCP = token drift).
pnpm cloud:doctor

# Copy the connector URL (with token) to clipboard without printing token to stdout.

# Use this to safely paste into ChatGPT connector config.
pnpm cloud:copy-url

# Explicit start; fail-closed if token / agent-key / CF config / remote-spike build is missing.
pnpm start:cloud

# Normal runtime start now runs the same helper in optional mode:

# - incomplete cloud setup -> WARN + skip (frontend/API still start)

# - complete cloud setup -> start cloudflared + remote-spike, then health-check all cloud boundaries

# - any cloud-only failure -> cleanup + WARN + degraded (frontend/API/Redis still start)
pnpm start

# Daemon health remains primary; the output also reports live F247 cloud healthy/degraded/disabled.
pnpm start:status

# Escape hatch for local dev sessions that intentionally do not want cloud services.
CAT_CAFE_F247_CLOUD_AUTOSTART=0 pnpm start
```

**URL-token persistent contract** (B1d followup — 2026-07-08 dogfood friction):

The `?token=<secret>` in the connector URL handed to ChatGPT Developer mode is a **persistent contract**, not a transient credential. ChatGPT connector config may lock the URL after entry (not editable in some UI versions), so **silent local rotation of `~/.cat-cafe/spike-token` permanently breaks the cloud cat** — it will 401 on every authenticated MCP call while `/health` stays green, making the failure invisible to a health-only doctor.

Rules:
- **Never overwrite an existing spike-token file** without explicit operator signoff. The script reads-only; no code path writes to it.
- **`cloud:doctor` probes authenticated MCP initialize** (POST `/mcp?token=...`), not just `/health`. A 401 here means "connector token mismatch likely" — the token in the URL ChatGPT holds differs from the local file.
- **`cloud:copy-url`** copies the current URL (with token) to clipboard via `pbcopy` without printing the token to stdout. Use this to re-paste into ChatGPT when the connector URL is editable.
- If the connector URL is not editable and the token has drifted, the recovery path is: mint a new token → write to `~/.cat-cafe/spike-token` → re-create the ChatGPT connector entry with the new URL. There is no legacy-token allowlist in B1d (documented as future/recovery option for Phase B1b).

Launchd opt-in for cloudflared KeepAlive lives in `scripts/launchd/cat-cafe.cloudflared.plist.template`; install/uninstall steps live in `scripts/launchd/INSTALL.md`. Spike server remains process-managed by `pnpm start` / `pnpm start:cloud` for B1d. Personal Chrome Host Adapter 的安装与配对属于 Phase E/F；legacy PinchTab 只保留显式 opt-in 诊断能力，不进入默认 wizard。

### Phase D — Console "配置云端猫" 多 provider UI

Phase B-C 后启动。Settings 页面新增 "配置云端猫"，支持选 provider / model / 自动 wire up token + URL。

### Phase E — 插件化发行 + Personal Chrome Host Adapter

个人用户优先。Cloud Cat plugin 不是只发一个 npm package，而是编排三个可独立升级、对用户表现为一条向导的组件：

1. **Clowder AI provider plugin**：注册 `gpt-pro` provider、安装/启动本地 helper、提供健康检查与卸载闭环，并把实现绑定到既有 `IConversationHostAdapter` 窄接口。
2. **Chrome Web Store extension**：仅申请完成单一目的所需的最小权限（`chatgpt.com` host access、tabs/scripting、Native Messaging）；负责绑定当前 conversation、页面内填入/提交和观察 host message ID。
3. **Native Messaging helper**：由 Clowder AI plugin 安装到当前用户域，只允许发布版 extension origin；在本地 Clowder AI 与 extension service worker 间传递一次性 delivery ticket、receipt 与健康状态，不保存 ChatGPT Cookie。

“点击安装”定义为**一条引导式安装流**，不是静默安装：plugin 可以自动安装 helper、打开准确的 Chrome Web Store listing 并在扩展启用后自动配对；Chrome 的“添加扩展/权限”确认必须由用户完成。macOS/Windows 社区发行版以 Chrome Web Store 签名包为准，unpacked extension 只用于开发 spike。

**E0 developer install verdict（2026-08-23 owner-click correction）**：2026-08-20 已真实观察 installed helper/socket、登录态后台 exact-ID delivery、DOM `hostMessageId` 与同-key retry；2026-08-21 删掉可见的 target/control automation 后，2026-08-23 又在刷新 extension 与目标 page 的 owner-click 路径真实观察 background delivery、同-key same-ID retry、Chrome 生命周期/焦点不变与后续 Remote MCP thread roundtrip，现为 `OBSERVED/PASS`。刷新前 stale dynamic import / artifact 的诊断历史保留，避免把磁盘新代码误当浏览器运行态。缺 binding 仍诚实返回 `NEEDS_BINDING`，不会自动 foreground target。E0 只证明 Host-owned primitives 与真实投递；下方 E1 单独记录它们进入本地 Console 的产品化范围，签名发行物、富卡起点 hello-world 与完整公开 onboarding 仍不得冒充已关闭。

**E1 product card verdict（2026-08-23 revision-honest correction）**：本地 Console 已把 E0 primitives 收成 owner-only Developer Preview 产品卡，覆盖 Web Store 发布状态、Host install/repair/uninstall、最多 32 项授权的数量/列表/逐项撤销与 live 状态。卡片不再暴露 unpacked 路径；没有可信 listing 时只阻断全新安装，不能阻断已安装 Developer Preview 升级。Host artifact 可在旧 Helper 活跃时先发布 immutable generation 并原子切换 launcher/pairing；旧进程因启动时 artifact revision 不符而 fail closed。live 状态通过 runtime→Helper→extension→page handshake 区分 `connected` 与 `stale_adapter`；新版 extension reload 后自动重注入 content script，无需再刷新会话页。Windows 当前未实现，稳定显示 unsupported。尚未关闭的外部边界是公共插件仓 PR 合入、Chrome Web Store 实际 listing/发布权限与首次公开发行；这些不由“发布集成就绪”代偿。

插件发行终态：
- Clowder AI marketplace 安装 provider plugin
- 向导完成 extension 安装确认 + helper 配对 + conversation binding
- 一键 hello-world 同时验证 host append 与 Remote MCP 回写
- 双向生态仍成立：别人能把 Cloud Cat provider 装进 Clowder AI；未来 provider adapter 继续复用同一 Host Adapter contract

### Phase F — Plug-and-play cloud cat onboarding (planned, post Phase D/E)

**愿景** (operator raise 2026-06-29；2026-08-12 personal-first 收敛)：Phase A-D 全套实施完后，只有 dogfood 用户能用 gpt-pro —
他们手动配 ChatGPT Custom Instructions、维护 cookies、装 PinchTab、理解 sidebar 多 chat 模式；而 Scheduled Tasks 即使可用也无法满足即时 `@`。
**外部用户无法自助** = 护城河 + 复用面双输。

Phase F 把整个 cloud cat onboarding 收成一键体验，让任何装 cat-cafe 的人能自助开通
gpt-pro（以及未来 claude-cloud / gemini-cloud 等其他 cloud cats），不需要读 spec / 改 config / 学 PinchTab。个人版默认走 user-confirmed Chrome Host Adapter；企业 Workspace Agent adapter 明确不作为当前 phase 前置依赖。

**关键 AC（占位，立项时细化）**：

- [ ] AC-F1: Clowder AI Console 提供 "Add Cloud Cat" wizard — 列出可装的 cloud cats (gpt-pro / future) + 安装入口
- [ ] AC-F2: wizard 安装 provider plugin 与 Native Messaging helper，打开准确 Chrome Web Store listing，并在用户确认扩展权限后自动完成一次性配对
- [x] AC-F3: 用户可在多个 ChatGPT conversation 点击“授权此会话”；authorization owner-scoped、可查看、可逐项撤销、卸载时全部清理，thread→conversation 路由仍一对一且投递前 exact-ID 校验
- [ ] AC-F4: `@gpt-pro` 生成转发富文本，展示目标、实际唤醒胶囊与“发送并唤醒 / 复制并打开 / 取消”；未获点击授权时不创建浏览器 delivery
- [x] AC-F5: extension 在不聚焦窗口、不读 Cookie、不调用私有 API 的条件下完成投递；只有真实 `hostMessageId` 才进入 `sent`（2026-08-23 owner-click + refresh real dogfood，DOM ID + same-key retry + Chrome lifecycle/focus PASS）
- [ ] AC-F6: 相同 source message ID 重试不产生重复 ChatGPT 消息；delivery 状态完整持久化为 `staged → approved → extension_received → inserted → submitted → host_observed → cloud_ack`
- [ ] AC-F7: 自动提交失败时诚实降级为“已填入待发送”或“已复制并打开”，并给出针对 tab / 登录态 / DOM / helper / binding 的诊断，不自动启用 legacy PinchTab
- [ ] AC-F8: hello-world nonce 从 Clowder AI 富卡授权开始，经 ChatGPT conversation 唤醒 gpt-pro，再由 Remote MCP 真回写原 thread；两端消息 ID 与 trace nonce 均可核验
- [ ] AC-F9: 走通后 provider plugin 上 Clowder AI marketplace、extension 上 Chrome Web Store（公开/受邀由 operator 拍板）
- [x] AC-F10: thread-level Remote MCP return 已有；runtime delta 现在另带 exact `sourceMessageId` 与 opaque server-signed `cloudReturnBinding`。提交任一回程字段即选择严格 source-bound 通道，两者必须同时携带并由服务端校验现有 `replyTo`；缺失或 scope/source 替换 typed fail closed。没有 source/reply 语义的独立主动消息走 agent-key append-only 通道，仍不能执行 replace-final、review verdict、coordination 或 structured action
- [x] AC-F11: normal cloud dispatch 在原 thread 持久化 typed outbound receipt，区分 `sent / failed / unknown`，保留 refs/transport/host receipt/idempotent retry truth；receipt 落盘验证 exact source/sender/dispatch/target，source body 只经 same-thread public-safe `replyTo` 水合
- [x] AC-F12: durable audit 不保存或展示 raw conversation ID、pairing secret、Cookie、完整重复 payload；Settings 不是 canonical audit
- [x] AC-F13: supported in-place live gate 只生成内部 verification nonce，拒绝任意正文参数，并把输出标为 diagnostic receipt / non-canonical thread projection
- [x] AC-F14: Settings 把 Host authorization 与当前 thread route 分成两个可完成步骤；owner 只从已授权 collection 中为当前 thread 选择 exact conversation，继续复用 owner-only sidecar 与 privacy-by-absence
- [x] AC-F15: runtime → Helper → extension service worker → content/page adapter 在 protocol-v2 health 与 normal append 上交换 expected/observed revision；legacy v1、任一 stale/missing revision 均在 Chrome dispatch 前 fail closed，Settings 不以 socket connected 冒充 ready
- [x] AC-F16: normal-dispatch managed live gate 不创建 diagnostic append；只有 durable `transport=host` + non-empty `hostMessageId` + exact source-bound gpt-pro return 才 PASS，queued/routed/unknown 均不通过
- [x] AC-F17: owner authorization 与 exact thread route 跨 runtime restart 保持有效；Native Messaging 断线后由 browser-owned alarm 唤醒 ephemeral MV3 worker 并重连，恢复不得要求重新授权或点击扩展图标

**前置依赖**：
- Phase B/C/D 已有能力可复用；个人版 Host Adapter spike 先过 message-ID / inactive-tab / idempotency 三道 gate
- Console "配置云端猫" UI（Phase D scope）→ wizard 寄生其上
- Phase E 插件化发行与 Phase F onboarding UX 可并行；企业 Workspace Agent adapter 不阻塞个人版

**Phase F 触发**：operator 2026-06-29 「我们走通后做给外人用」directive；2026-08-12 明确个人版优先，用 Chrome extension + Native Messaging helper 把实时召唤收成插件安装闭环。

### Tips Contribution（F244）

- 插件页在用户首次安装 `gpt-pro` provider 时提示：“需要 Chrome 扩展的一次安装确认；完成后在目标 ChatGPT conversation 点击绑定。”sourceRef 指向本 spec Phase E/F。
- `@gpt-pro` 无可用 binding 时提示：“先绑定 conversation，或选择复制并打开。”不得只显示内部 `HOST_APPEND_UNAVAILABLE`。

## Acceptance Criteria

### Phase A（Design Gate） ✅ done 2026-06-21

- [x] AC-A1: F247 立项 doc 落地（本文件）
- [x] AC-A2: Maine Coon R2 cross_post 五件套 What/Why/Tradeoff/Open/Next 接住
- [x] AC-A4: Tasks 实测 verdict 状态为"待验证"（不写硬结论）
- [x] AC-A5: GitHub Connector 集成确认 + scope 简化（cat-cafe MCP 不暴露 code 工具）
- [x] AC-A6: Maine Coon跨族 review verdict — R3 HOLD → R4/R5 plan correction → R3+R4+R5 fix done in this revision，等Maine Coon focused diff scope re-review APPROVE

### Phase B0 (mock harness)

- [x] AC-B0-1: spike server v2（commit `995a9fb2b`）token middleware + redact + 5 mock tools + echo，本地 + 公网 4 项 verify
- [ ] AC-B0-2: B0 完成时 explicit cleanup（删 token / revoke quick tunnel / 标 harness disposable end-of-life）
- [ ] AC-B0-3: 不声称 B0 是 production-ready，**不依赖 startup polling**

### Phase B1a (interim — `?token=` 单防线 + 真 toolset) ✅ done 2026-06-22

- [x] AC-B1a-1: cloudflared **named tunnel** `mcp.clowder-ai.com` + DNS CNAME + ingress route 配 localhost:3098（CF API PUT，dashboard 死代码避开）
- [x] AC-B1a-2: gpt-pro agent-key minted（agentKeyId `ak_6ac359d6370d481bb9c956b292dd49c8`，sidecar 0600）
- [x] AC-B1a-3: cat-config.json roster gpt-pro entry merged（commit `09172b5f0`，main）
- [x] AC-B1a-4: `remote-spike.ts` v4 真 toolset 注册（registerCollabToolset + registerMemoryToolset，cloud-pro-phase0 mode 收窄 10 项）
- [x] AC-B1a-5: Custom Instructions 短 L0 完成（commit `6b3390663`+，Maine Coon R3 1175 字符 + R5 工具无关替换 + R4 砍 polling）
- [x] AC-B1a-6: Maine Coon ChatGPT 端实际能调 read 工具 + dry-run via spike 写工具真写入 thread（speaker 显示 "Maine CoonPro(Pro Cloud (ChatGPT))"，messageId `0001782136023449-000294-5434e1fd`）
- [x] AC-B1a-7: 接受 `?token=` 单防线（KD-7 interim 设计）+ B1a 风险表 §C 风险知情 + Rotation SOP 沉淀
- [x] AC-B1a-8: MCP annotations (readOnlyHint / destructiveHint / openWorldHint) fix（commit `994dfa665`，绕过 OpenAI safety check 对 read 工具）
- [x] AC-B1a-9: cat-cafe API hot-add via `POST /api/cats`（0 重启，避开误判 file-only 路径）
- [x] AC-B1a-10: spike env 污染清理（`env -u` 5 项 + AGENT_KEY_FILES override 含 gpt-pro）

### Phase B1b (production verified auth) — 未排期

- [ ] AC-B1b-1: 公网真 auth 方案选定（verified CF Access OAuth 或 verified header-auth）+ 实测兼容 ChatGPT connector OAuth flow
- [ ] AC-B1b-2: 重新挂 CF Access App on `mcp.clowder-ai.com` + 配 OIDC IDP
- [ ] AC-B1b-3: spike server 升级解析 Bearer JWT + verify CF Access JWT signature
- [ ] AC-B1b-4: token rotate 通过 OAuth provider 后端完成（不影响Maine Coon云端 connector URL）
- [ ] AC-B1b-5: **禁用** `?token=` 作长期 auth；B1b only verified auth shape

### Phase C AC（B1a 落地后逐步细化）

- [x] **AC-C-1a**: gpt-pro 专属头像 asset 上线（PR #2530 squash SHA `284e9b2b8` merged 2026-06-24 19:42 PT）— `packages/web/public/avatars/gpt-pro.png` 进 git；operator 拍板 candidate A
- [x] **AC-C-1b**: runtime avatar 字段切换 done（post-merge ops 2026-06-24 19:42 PT）— `PATCH /api/cats/gpt-pro {avatar:"/avatars/gpt-pro.png"}` 执行成功；live verify + persisted verify 双过
- [ ] AC-C-2: Siamese愿景守护 avatar 视觉 + 跟本地 gpt52 区分度 OK
- [ ] AC-C-3: ChatMessage / Cat picker 渲染 `Maine CoonPro(Pro Cloud (ChatGPT))` Phase C 抛光稿
- [ ] AC-C-4: cloud cat 类别 + "via ChatGPT Pro" tag UI（可滚到 Phase D）

### Phase B1c-0 AC

- [x] **AC-B1c-0-1**: 扩展 `cleanup-stale-dev-processes.mjs` 加 3 rule（agent-browser-mcp / @playwright/mcp / pinchtab-mcp），白名单严格 + 8h 阈值
- [x] **AC-B1c-0-2**: 测试覆盖 22 项 — 8 positive + 14 negative（R1 +6 negative / R2 +3 positive），含 pinchtab `pinchtab-darwin-arm64` 真 binary form sanctuary + R2 direct binary 三种 form 全覆盖
- [x] **AC-B1c-0-3**: launchd plist template + INSTALL.md runbook 进 git（不自动 install）
- [x] **AC-B1c-0-4**: real-system dry-run verify 实测 process list（3 类 wrapper 命中 + sanctuary 未误杀）
- [ ] **AC-B1c-0-5** (post-merge ops)：operator 看 dry-run → 手动 `launchctl load` 启用每日 cleanup

### Phase B1c AC (spec v2 — 立项后实施时细化)

- [x] **AC-B1c-1** (`edd8a28ed` / PR #2627): cat-cafe API thread metadata 加 `cloudCatBindings: {[catId]: chatUrl}` field（持久化 + owner-only `/api/threads/:id/cloud-bindings` GET/PATCH endpoint，**不**进默认 thread context export 路径）。**gpt52 4 轮 review**：R1 race + contract / R2 auth bypass on system threads / R3 header literal `system` spoof / R4 APPROVE
- [x] **AC-B1c-2** (`8f09e2f16` / PR #2632, library + call-site only — 真 runtime wiring 在 PR #2634；2026-08-12 terminal-contract repair): `cloud-invoke-bridge` service — `invokeSingleCat` 对 cloud provider 跳过 provider CLI，但保留 durable child；只等待有界 transport outcome，不等待云端猫回复。**gpt52 4 轮 review**：R1 dead code + wrong-layer fields / R2 non-intent overflow / R3 envelope contract / R4 APPROVE
- [x] **AC-B1c-3** (`aa6d3f2f0` / PR #2634, by opus-46 同族 handoff): bridge 用 PinchTab 完成投递流程（query binding / eval-based navigate / inject payload / submit / capture URL via `window.location.href` eval / write binding）。CDP raw WebSocket port 9870（`145beb996` / #2640 hotfix 注册 PINCHTAB_CDP_PORT env + 补 doc User Journey）
- [x] **AC-B1c-3a** (gate, pre-impl, spike PASS 2026-06-26): PinchTab 实测 spike — verify 当前 ChatGPT input/send selector + eval-based 导航 Clash TUN safe + URL capture 可靠。**spike PASS verdict in `feedback_pinchtab_chatgpt_spike_findings.md`**
- [x] **AC-B1c-4** (`8f09e2f16` / PR #2632): 失败 fallback notification 投到本地 thread (`system_info` rich block) — chrome down / not logged in / selector fail。Wire-up 完整化在 PR #2634 (composition root → messageStore.append + Hub broadcast)
- [x] **AC-B1c-5** (2026-06-29 22:12 PT — **真双向 live e2e PASS**): 端到端活体实测 forward + reverse 全通。**Forward (cat-cafe → ChatGPT)**：(1) `cat_cafe_post_message @gpt-pro` routing 成功；(2) KD-17 dispatch guard fire；(3) cloud-invoke-bridge fire-and-forget；(4) PinchTab CDP raw WebSocket inject delta payload (`<thread-runtime v=1 format=json>`)；(5) ChatGPT 新建 chat `chatgpt.com/c/6a43238f-b1ac-83e8-8d09-0655afd915c5`；(6) thread metadata `cloudCatBindings.gpt-pro = chat URL` 自动写回；(7) 云端Maine Coon reply 保 signature `[Maine CoonPro/gpt-pro🐾]`。**Reverse (ChatGPT → cat-cafe)**：云端Maine Coon通过 `cat_cafe_post_message` MCP 工具写回 cat-cafe thread，messageId `0001782785550318-000160-3b0dbc66` 真持久化（speaker=`Maine CoonPro(Pro Cloud (ChatGPT))`, timestamp=`1782785550318`, threadId=`[thread-id]`, routed=`["opus-47"]`, clientMessageId=`b1c5-reverse-001-yanyan-ack`）。**KD-13 note**：云端Maine Coon admit `cat_cafe_get_thread_context` 当时被 OpenAI 安全检查屏蔽（read tool stochastic block）但 `cat_cafe_post_message` 写入成功 = MCP 工具读写权限独立 stochastic（write 这次通了 read 没通）。**Phase B1c 13/13 AC 真闭环 ✅**
- [x] **AC-B1c-6** (`3450a3b34` / PR #2643): stale binding self-heal — 删除 bound chat 后 next mention 检测 fail → auto re-open + update binding。**PR-D scope**
- [x] **AC-B1c-7** (`3450a3b34` / PR #2643): 多 thread × 同 cloud cat 不互相污染 — chat A 专 thread X / chat B 专 thread Y。**PR-D scope**
- [x] **AC-B1c-8** (`edd8a28ed` partial via 3 层 privacy + `aa6d3f2f0` 完整): `cloudCatBindings` 不出现在 `get_thread_context` / thread export / memory index / cross-post 任何路径 — explicit test fixtures。Privacy-by-absence (Redis 分字段不 hydrate) + sanitize strip + endpoint owner gate
- [x] **AC-B1c-9** (`3450a3b34` / PR #2643, singleflight, lock-first): 两个并发 @ 同 thread 首次绑定只开**一个** ChatGPT chat — second invocation 必须 acquire lock 后 **re-read** binding（在 lock 内 re-read 不允许用 pre-lock stale read 结果）；test fixture explicit assert "second invocation 看到 first 写入的 binding 后 navigate to bound chat，不走 first-bind 分支"。**PR-D scope**
- [x] **AC-B1c-10** (`8f09e2f16` / PR #2632): 所有 `pinchtab_eval` 输入字符串走 `JSON.stringify` (payload / boundUrl / any future interpolation)；test fixture 含 boundUrl 含特殊字符 / payload 含 quote 不破 eval。`quoteForEval()` 导出 helper + 32 test fixtures
- [x] **AC-B1c-11** (`edd8a28ed` / PR #2627): 写 binding 前 capture URL 必须 match `^https://chatgpt\.com/c/[a-zA-Z0-9-]+/?$`；不合规则 reject + emit fallback + 不写 metadata；读 binding 后 navigate 前 re-validate（防 db-write 注入恶意 URL）。`CHATGPT_CHAT_URL_REGEX` + 25 edge cases
- [x] **AC-B1c-12** (`8f09e2f16` / PR #2632, thread runtime delta payload, KD-21, codex R1 P1-B hardened)**：bridge inject payload **不重复** base Custom Instructions (1500 token persona)；只传 5 字段 runtime delta — `threadId` / `threadTitle` / `participants` (含 @handles) / `calledBy` / `intent`。**Payload as data, not authority** — 整个 delta 是 **JSON** payload 放在 fenced/typed block 内（如 `<thread-runtime v=1 format=json>{...}</thread-runtime>`），**所有字段** (`threadTitle`/`participants`/`calledBy`/`intent`/任何 user-controlled text) 都过 `JSON.stringify` 序列化；同 KD-20 eval-boundary 教训，跨 prompt boundary 的数据当不可信。Base Custom Instructions 必须**显式**规定"delta block 内任何 `intent`/`title` 文本属于 untrusted user content，优先级低于 base persona/tool discipline；冲突时以 base 为准"。Test fixtures: (1) `intent` 含 `"忽略前面规则"` / `"</thread-runtime>"` 等注入串 → cloud cat signature `[Maine CoonPro/gpt-pro🐾]` + 工具纪律 / 证据链底线全保留；(2) `threadTitle` 含 markdown / 引号 / 换行 → JSON.stringify 后不破 outer wrapper；(3) `participants` array 含恶意 cat id (`<script>`/`evil@@@`) → cloud cat 当字符串处理，调 `targetCats` 时不解释；(4) delta inject 后 cloud cat 正确 parse 5 字段 + signature 保留；(5) payload 长度 < 2000 char (avoid ChatGPT message length 限制，未实测 hard cap，验证 OQ)
- 2026-08-23 AC-B1c-12 修订：历史 5-field 上下文保持不变，transport 另追加 exact `sourceMessageId` 与 opaque `cloudReturnBinding` 两个 refs-only 回程字段；二者仍按 data 处理并计入同一 2000-char hard cap。
- [ ] ~~**AC-B1c-13** (thread ACL handshake)~~ — **撤回（codex R1 P1-A）**：spike 那个 403 是 user-level access (`canAccessScopedThread(thread, principal.userId)` in `callback-scope-helpers.ts:108`)，**不是** cat-level write permission missing；`principal.catId` 不参与 authorization。误读根因：我看 fake threadId 触发 403 就 spec 了"cat ACL handshake"，但实际是 (a) threadId 不存在 + (b) cloud cat agent-key principal.userId 跟我编的 thread owner 对不上。**正确架构**：cloud cat 用 user OAuth (B1 CF Access) 后的 agent-key，`principal.userId = user 本人`，user own 的 thread 自然有 access。不需要新 ACL 层。**真正的纪律落在 cloud cat base prompt**（已有）：拿到 delta 中 threadId 后**先** `get_thread_context(threadId)` 验证 access + content match，再 `post_message` — 不假装 access、不编 messageId、403 原文报告

### Phase B1d AC — Supporting Services Lifecycle Integration 🆕 (2026-07-06 立项)

**触发**：2026-07-06 03:30 PT dogfood friction —— operator 重启 runtime 后 F247 supporting services 全部离线，`pnpm start` 未覆盖，双向链路同时断（reverse: cloudflared+spike / forward: PinchTab）。

- [x] **AC-B1d-1**: `pnpm start` 与 `pnpm start:cloud` 集成 F247 supporting services 阶段——按顺序拉起：cloudflared daemon → spike server (3098) → 健康探针 verify 公网 `mcp.clowder-ai.com` HTTP 200。**故障域契约**：显式 `pnpm start:cloud` fail-closed；常规 `pnpm start` 把 F247 视为 optional capability，任一 cloud-only 失败都 cleanup + WARN + degraded，本地 frontend/API/Redis 继续运行，不留半开状态。启动器还必须隔离 helper 进程级非零退出，防止 crash/依赖损坏越过 helper 内部契约。
- [x] **AC-B1d-2**: launchd `cloudflared` KeepAlive plist template 进 `scripts/launchd/`（复用 B1c-0 `cat-cafe.mcp-cleanup.plist.template` 模式：模板进 git，`launchctl load` 由 operator 手动执行，不自动 install）。plist 引用 `~/.cloudflared/config.yml` + credentials，重启后自愈。
- [x] **AC-B1d-3**: `pnpm cloud:status` / `pnpm cloud:doctor` 命令——一次输出 3 层状态：(a) cloudflared daemon 进程 + tunnel connection state (`cloudflared tunnel info`) (b) spike server 3098 LISTEN + `/health` 200 (c) 公网 `mcp.clowder-ai.com` HTTP status (250ms timeout)；异常项打印**具体命令**帮 operator 手动恢复（不 auto-fix，保 operator opt-in 原则）。
- [x] **AC-B1d-4**: 环境探测——operator 未 mint `gpt-pro` agent-key 或 `~/.cloudflared/` 未配 named tunnel 时 `pnpm start` **skip cloud stage + WARN**，不 fail，不阻塞常规 dev（cat-cafe / 前端 3003/3004 照常起）。skip 逻辑必须 test fixture 覆盖 (无 agent-key 文件 / 无 CF config / 都无) 三态。
- [x] **AC-B1d-5**: `docs/SOP.md` 或 `docs/features/F247` 内加"F247 lifecycle runbook"——列出 3 项 supporting service 的手动起 / 停 / 状态命令 + 故障排查树（PinchTab 断链 → Chrome profile 检查 / cloudflared 断 → journalctl / spike 断 → dist 是否 build）。
- [ ] **AC-B1d-6** (dogfood verify)：operator 或 sonnet 在 alpha 环境跑一次 "cold restart" 剧本——`pnpm stop` → 重启 mac → `pnpm start` → 验证公网 `mcp.clowder-ai.com` 200 + 云端Maine Coon `cat_cafe_get_thread_context` 一次成功 + 本地 `@gpt-pro` forward 一次触达 chat。
- [x] **AC-B1d-7** (token contract followup — 2026-07-08 dogfood friction)：URL-token persistent contract 防回归。**触发**：ChatGPT connector URL 不可编辑 + 本地 token 被改 → 云端猫永久 401，`/health` 绿灯掩盖。**交付**：(a) `pnpm cloud:doctor` 加 authenticated MCP initialize probe（POST `/mcp?token=...`），401 时报 "connector token mismatch likely"；(b) `pnpm cloud:copy-url` 命令复制 URL（含 token）到剪贴板，stdout 不打印 raw token；(c) 测试覆盖 15 项（copy-url 行为 + authenticated probe + 不打印 token + 不覆盖已有 token 文件防回归）；(d) B1d docs 写清 URL-token 是 persistent contract。
- [x] **AC-B1d-8** (optional failure-domain isolation — 2026-08-10 dogfood incident)：Cloudflare HTTP 530 或 API `auth-probe` startup timeout 不得触发 `start-dev.sh` EXIT cleanup 杀掉本地 runtime。helper 内部 optional failure 返回 degraded success，启动器对 helper 进程级失败再做一次 ownership-safe cleanup + isolation；authenticated MCP / gpt-pro principal 的瞬时失败有界重试，401/403 不重试；`pnpm start:status` 显示 F247 live summary，其独立网络探针并发执行且跳过仅供详细诊断的 tunnel-info，失败路径由最慢的 2 秒探针限定。严格 `pnpm start:cloud` 行为不变。

**B1d 前置**：Phase B1c 13/13 done（已 ✅ 2026-06-29）；spike server 已在 `packages/mcp-server/dist/remote-spike.js` 稳定运行数周（B1a-B1c）。

**B1d 后置**：Phase F wizard 自动化建立在 B1d 手动起法之上（wizard 的第一步就是"跑一遍 B1d supporting services 起法脚本"）。

### Phase F AC (planned, post Phase D — plug-and-play onboarding)

详见 Phase F 段（What 章）。本轮先冻结三项 spike gate，全部通过后才把 adapter 标为可自动提交：

- [x] AC-FS1: You 日常 Chrome 的登录态后台 `chatgpt.com/c/<id>` 可完成填入与提交，全程不改变 control tab；隔离 origin fixture 继续提供确定性回归
- [x] AC-FS2: 2026-08-20 登录态真实 ChatGPT DOM 返回真实 user-message ID；missing-ID fixture 继续证明观察不到时不得返回 `hostMessageId`
- [x] AC-FS3: 同一 `(conversationId, sourceMessageId)` 在 helper 并发/重启 ledger 与 Chrome fixture 重试中得到同一 host receipt，不产生第二次 dispatch/send
- [x] AC-FS4: 用户一次显式绑定后 Host 持久复用 exact conversation authorization；后续 health/gate/delivery 无 foreground mutation surface，未绑定以 typed `NEEDS_BINDING` 零发送终止（2026-08-21 deterministic/full-seam；2026-08-23 owner-click + refresh real dogfood `OBSERVED/PASS`）

Phase F 产品 AC-F1..F9 见上节；Phase D 其余 acceptance criteria 待实施计划细化。

## Risk

| 风险 | 缓解 |
|---|---|
| ChatGPT TOS 跳变（OpenAI 改 Developer mode 规则）| 接受系统性风险；plugin spec 抽象层让我们能换 LLM connector |
| B0 harness disposable 状态滑入 B1 production | AC-B0-2 + AC-B0-3 + AC-B1-7 三重明示；review checklist 守门 |
| gpt-pro confabulate 当本地 codex / 反过来 | 前端 ☁ icon + provider tag + signature 加云端标识；catId `gpt-pro` 与本地 `codex` 词面区分 |
| 插件 spec 设计错 → 外部装坏 | v1 严限 scope + 长 deprecation 期 + breaking changes major version |
| 隐私（云端 LLM 看到 cat-cafe memory）| toolset 收窄（B1 复用 fable phase0 10 项白名单）+ audit log + redact 模块过滤 secret patterns |
| ChatGPT 端 memory + Custom Instructions 容量限制让短 L0 灌不全 | 接受 "核心 L0 注入 + 补丁靠对话学习"，docs/connector README 作为补全真相源 |
| Tasks 不能调 Connector → 召唤需用户主动 | B1 user-driven 起步；future pending polling 是独立 spec 不是 B1 blocker |
| Chrome extension DOM selector 漂移或拿不到真实 message ID | versioned DOM adapter + live smoke；无真实 host receipt 即 fail closed，降级填入/复制，不伪报发送 |
| 扩展权限过宽或暴露 ChatGPT 会话内容 | 权限限 `chatgpt.com` + Native Messaging；不申请 cookies/debugger/all-sites；富卡展示实际发送内容并要求用户显式授权 |
| 普通应用无法静默安装个人 Chrome 扩展 | 一条向导自动安装 helper、打开官方 Web Store listing；保留浏览器原生“添加扩展/权限”确认，不绕过用户 agency |
| extension/service worker 或 helper 断连导致丢单/重单 | delivery ticket + sourceMessageId 幂等 ledger；1 秒 transient retry + browser-owned alarm durable wake；所有授权/路由/状态持久化，可重连续传，未观察 host receipt 不进入 sent |
| production Redis (sacred) mint 操作失误 | operator 明确 OK 才 execute；dry-run report 给operator过目 |
| **roster 注册被误以为是 runtime cat 注册（R3 P2-4, R8 重新分类）**| §2.1 明示双路径：roster = mint allowlist；runtime catRegistry = `POST /api/cats` 热加载（B1a 已用）。`breeds[].variants[]` 是 design-time UI default 不参与 runtime |
| **startup polling 偷换 search_evidence 伪装 pending（R4）**| §2.5 明示禁止；future polling 必须成对 `get_pending_mentions + ack_mentions` 引入 |

## Key Decisions

> 2026-08-12：KD-23 仅替换 KD-22 中“Chrome profile / PinchTab 自动起”的 transport 选择；KD-22 的 plug-and-play 产品愿景继续有效。

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| **KD-1 (R3 P2-2 rewrite)** | **F178 owns single-agent-key bridge/auth research; F247 owns productized cloud-cat platform** | F178 §12 升级条件给触发集合；F247 真正动力是 productized vision（multi-provider/avatars/bubbles/config UI/pluginization）| 2026-06-21 |
| KD-2 | ChatGPT 端走 Custom Instructions 不走 Custom GPT | operator实测 Custom GPT 不读主流 memory | 2026-06-21 |
| KD-3 | Tasks 实测 verdict = 待验证 | operator verify_before_guessing：AI Blog Patrol 也可能没真跑 | 2026-06-21 |
| KD-4 | GitHub code 走 ChatGPT 官方 GitHub Connector | cat-cafe MCP scope 简化 + 暴露面减一档 | 2026-06-21 |
| KD-5 | catId 统一 `gpt-pro`（Maine Coon R3 confirm，无 codename 双 vocabulary）| 与本地 `codex` 词面区分；防 split roster/audit/bubble/routing identity | 2026-06-21 |
| KD-6 | Phase B 起步用 user-driven 召唤 | CodexPro 拆解教训：守 ToS 边界 + 不依赖未实证机制 | 2026-06-21 |
| **KD-7 (R3 P1-1 refined)** | **`?token=` 仅作 B0 harness disposable guard，B1 production 禁用；B1 必须 verified CF Access OAuth 或 verified header-auth** | 48 R1 R2 严守（OWASP 反对 secret-in-URL）；B0/B1 split 防 unsafe path 偷换 | 2026-06-21 |
| KD-8 | B0 工具集起步 mock 5 项 + echo 保留 | 不动 6399 + 不改 main roster + 验证 transport 链路 | 2026-06-21 |
| KD-9 | mint gpt-pro key 等 operator 明确 OK | production Redis (sacred)操作不可逆 | 2026-06-21 |
| **KD-10 (R3 P2-4, **R8 SUPERSEDED**)** | ~~~`cat-config.json` roster 注册只够 mint allowlist；runtime cat / bubble identity 需 `breeds[].variants[]` Phase C 单独注册~~ | **被下行 KD-10 (B1a 实测修正) 替换**；R3 P2-4 当时未实测 `POST /api/cats` runtime register endpoint | 2026-06-21 (superseded 2026-06-22) |
| **KD-11 (new R4)** | **不能用 `search_evidence + list_recent` 伪装 pending polling 语义**；future pending polling 必须成对引入 `get_pending_mentions + ack_mentions` + 安全 review | LL 2026-02-16 bug：无 cursor → 跨 session 重复处理；search_evidence 无 cursor 无 ack | 2026-06-21 |
| **KD-12 (new R5)** | **Custom Instructions L0 用工具无关表述代替具体工具名**（如 hold_ball 不在白名单时） | 工具集变化时 L0 不踩坑；R5 Maine Coon给的"等外部条件时不假装 @ 本地猫... post 状态或等 You 再召唤"是工具无关表述 | 2026-06-21 |
| **KD-10 (修正 B1a 实测)** | **runtime catRegistry 走 `POST /api/cats` 热加载，不需要改 `breeds[].variants[]`**；KD-10 原 R3 P2-4 推测"Phase C 单独工程"修正为 Phase C scope = avatar UX + bubble 渲染优化 | runtime 不读 cat-config.json 的 breeds，读 `.cat-cafe/cat-catalog.json`；POST /api/cats endpoint 实时注入 + 持久化；breeds entry 是 design-time template 不参与 runtime；见 LL-cat-cafe-api-has-hot-reload | 2026-06-22 |
| **KD-13 (new B1a 闭环, R8 wording corrected)** | **ChatGPT MCP 工具的 OpenAI safety/validation 拦截属于平台 stochastic / 策略性行为**（同 payload 不同时刻可能不同结果），write 工具（readOnlyHint=false）触发概率更高。**我们能做的是提供正确 annotations 让平台有依据**；之后是否被拦截不可控 | 实测来源：Maine Coon B1a 三次 retry write tool 仍 stochastic；官方 Apps SDK 文档没有"unset = destructive default = block every call"的硬承诺；B1a 不可 fix（平台行为）；B1b 升级 OAuth bearer + user-in-loop 可能改善 | 2026-06-22 |
| **KD-14 (new B1a 闭环)** | **spike server / sidecar service 必须 explicit unset 5 项继承 env**：`CAT_CAFE_INVOCATION_ID` / `CALLBACK_TOKEN` / `THREAD_ID` / `SUPERVISOR_PARENT_PID` / `AGENT_KEY_FILES`，并重新 set 含 gpt-pro 的 `AGENT_KEY_FILES` map | 见 LL-spike-server-env-contamination + LL-agent-key-vs-invocation-token-threadId；继承污染导致 MCP gate 误判 + AGENT_KEY_FILE single fallback 被屏蔽 | 2026-06-22 |
| **KD-15 (Phase C avatar, R13 corrected)** | **gpt-pro avatar 由云端Maine Coon自己 self-design**（用 F229 `yanyan-codex-character-base-v1.png` 母图作 reference），不让Siamese画；PR scope = asset PNG + doc only；runtime catalog avatar 字段切换 (`PATCH /api/cats/gpt-pro {avatar}` 走 `updateRuntimeCat`) 作为 post-merge ops (AC-C-1b) | 自我延伸 = 护城河（W7 IKEA 效应）：云端Maine Coon画自己的脸 → 身份感 + 团队归属感更强；同时云端Maine Coon有 ChatGPT 内置 image gen 工具，能 reference 母图保 identity fidelity；Siamese视觉守护改为审美 verify 而非原画作者。R13 corrected：cat-config.json 改动对 live + fresh install 都不生效（gpt52 R13 P1-2 实测），撤回；live 切换只走 PATCH | 2026-06-24 (R13 corrected 2026-06-25) |
| **~~KD-16 (撤回 — 47 R13 wrong finding)~~** | ~~B1a 没持久化、重启即丢~~ — **48 R13.5 5 重证据推翻**：主服务实例 `cat-cafe-runtime/.cat-cafe/cat-catalog.json` line 1394 有 gpt-pro 顶层 breed entry + variant，mtime 6-22（B1a 注册时间），`createRuntimeCat` writeFileSync 落盘 + 启动 `readRuntimeCatCatalog` load 恢复正常。47 R13 grep 错坐标：grep 的是 worktree 系隔离 catalog（死文件 mtime 6-15），不是主服务实例 catalog。**真 P1 是 avatar 字段值 stale**（gpt52 R12 + 48 R13.5 双 confirm），见 AC-C-1b。第三次 grep 错坐标自审：见 LL-grep-coordinate-runtime-vs-worktree (TODO) | 2026-06-25 撤回 |
| **KD-17 (B1a 注册 oversight + dispatch guard)** | **cloud-only 猫（Remote MCP）不能被 dispatch**：B1a 时 `POST /api/cats` 注册 gpt-pro，cat-cafe runtime `createRuntimeCat` 看 clientId=`openai` 自动塞 default cli (`{command: "codex"}`)，违反 F247 cat-config.json caution 明示的"cli 字段省略；不被动接 dispatch"。本地 @ gpt-pro 触发 dispatch + spawn codex → 失败 → 弹"模型名不被支持"错误窗。**Root fix 3 处**：(1) updateCatSchema `cli: cliSchema.nullable().optional()` + updateRuntimeCat 处理 `cli:null` 删字段；(2) POST handler 看 provider=`openai-chatgpt-pro` 跳 default cli；(3) invokeSingleCat 入口 guard `provider === 'openai-chatgpt-pro'` → skip dispatch + yield done（用 explicit provider marker 而非 `!cli?.command`，因为 antigravity 也无 cli 但用 ACP/MCP 不同路径——guard 应保守只拦 known cloud Remote MCP providers）；post-merge ops: `PATCH /api/cats/gpt-pro {cli:null}` 清 runtime catalog stale cli 字段。Future cloud providers (anthropic-claude-cloud / google-gemini-cloud 等) 增加时同时加入 POST + dispatch guard 检查列表 | 实测来源：2026-06-25 00:10 PT 本地 @ gpt-pro 触发"模型名不被支持 ×2 + 调用 codex CLI exit 1"弹窗；catalog file inspect 显示 gpt-pro variant 有 `cli: {command: "codex", outputFormat: "json"}`；cat-config.json codex-gpt-pro 反而**没 cli** + caution 字段写"cli 字段省略；不被动接 dispatch"。tests 2 项：POST cloud-only skip default cli ✅ + PATCH cli:null 删字段 ✅ | 2026-06-25 |
| **KD-19 (B1c-0 MCP wrapper lifecycle hygiene)** | **不写新 kill script，扩展已测 cleanup-stale-dev-processes.mjs**：browser-automation MCP wrapper (agent-browser-mcp / @playwright/mcp / pinchtab-mcp) 不退累积 zombie；LL-056 + feedback_agent_browser_zombie 5 次 reoccurrence。codex/Maine Coon R0 verdict 3 硬约束：(1) 只扩 `pnpm process:cleanup` 已测入口不写独立 shell；(2) launchd plist template 进 git 但不自动 install (持久 OS automation 需 operator opt-in)；(3) 匹配规则极窄 (pinchtab server/bridge 永不杀，generic node/npm/playwright 不杀)。**升级 MCP 不修**（已 latest 版，LL-056 早写过 wrapper lifecycle 是 design 限制）。**B1c 前置 gate**：B1c-0 不过 → 不实施 B1c（不然让operator手动清违反"自相矛盾"原则） | 触发：operator 提议"升级 mcp + 定时任务清"。codex 调查发现已有 `pnpm process:doctor / cleanup` + LL-056 教训；47 之前提议的"写新 kill script + launchd plist"被否决（绕开已有护栏）。codex R0 3 硬约束接受 + 47 implementation；real-system dry-run verify pass | 2026-06-25 |
| **KD-20 (B1c thread↔chat binding, operator R1 pick O1 + codex R1+R2 hardening)** | **本地 cat-cafe thread 跟 ChatGPT chat conversation 做 1:1 lazy binding**：thread metadata 新增 `cloudCatBindings: {[catId]: chatUrl}` 字段，**local-only operational sidecar**（不进默认 thread context export / memory index / cross-post）；首次 @ cloud cat → bridge 在 ChatGPT 端开新 chat → capture URL via `pinchtab_eval(window.location.href)` → strict regex validation → 写 metadata；后续 @ 同 thread → bridge navigate to bound chat → 投通知；stale binding (chat 被删) → bridge navigate fail → auto-reopen + update metadata；**`(threadId, catId)` singleflight lock + lock-first ordering**：bridge 第一动作 acquire lock，**lock 内** re-read metadata 决定 branch，second concurrent invocation 在 lock 内看到 first 写入的 binding → navigate to bound（不开第二个）；**eval safety**：所有 `pinchtab_eval` 输入字符串走 `JSON.stringify` (payload / boundUrl / future interpolation 全适用)；**URL strict validation** `^https://chatgpt\.com/c/[a-zA-Z0-9-]+/?$`，写前 + 读后 navigate 前各 validate 一次（防 capture corruption + db-write 注入）。**为什么选 O1 不是 single shared chat (O2) / hybrid (O3) / 不绑 (O4)**：O2 sidebar 看似干净但Maine Coon Pro context 跨 thread 混杂信噪比差；O3 引入 feature_id 复杂度但 thread 不一定有 feature；O4 时间一久 sidebar 仍乱、Maine Coon Pro 跨 chat 分裂；O1 每 chat 专注一 thread，Maine Coon Pro context 隔离 + sidebar 数量 ≈ active threads + lazy 不预绑 + auto-self-heal | 触发：operator 2026-06-25 23:46 PT catch v1 spec 漏 chat binding；codex R1 23:55 PT 加 privacy P1-B + singleflight P2-B；codex R2 00:01 PT 加 eval JSON.stringify safety P1 + lock-first ordering P2 + URL regex validation。47 给 4 options + operator pick O1 + codex 双轮 hardening | 2026-06-25 (v2 codex R1+R2 hardened) |
| **KD-22 (Plug-and-play cloud cat onboarding 愿景, operator 2026-06-29 raise — Phase F 立项前置)** | **Phase A-D 全套实施完后仍只有 dogfood 用户能用 gpt-pro**：他们手动配 ChatGPT Custom Instructions / 维护 cookies / 装 PinchTab / 理解 sidebar 多 chat 模式。外部用户无法自助 = 护城河 + 复用面双输。**Phase F 立项**：cat-cafe Console 提供 "Add Cloud Cat" wizard，把整个 onboarding (OAuth → Chrome profile / PinchTab 自动起 → Custom Instructions 自动注入 → hello-world test) 收成一键体验。前置依赖：B/C/D ship + dogfood 走通 ≥ 1 周（活体验证 bridge 稳定性）+ Phase D Console UI（wizard 寄生其上）。**为啥分独立 Phase 不进 B-E**：Plug-and-play 是 onboarding UX scope，不是 transport / runtime / 插件化 scope；混进 B-E 会让现有 phase scope 蔓延。Phase E 插件化迁移可并行（plugin runtime + plug-and-play UX 两 layer 独立）。**为啥不放 BACKLOG 而进 F247**：F247 是 cloud cat **family** spec，onboarding 是 family 的一等公民（不是单 gpt-pro 的 ops 杂事） | 触发：operator 2026-06-28 21:48 PT「我们走通后做给外人用，得做成一键安装」directive；47 愿景守护 audit 时 surface 出 cat-template.json 没 gpt-pro entry (fresh install gap)，operator 顺手 raise 整个 Phase F | 2026-06-29 |
| **KD-23 (Personal Chrome Host Adapter, operator 2026-08-12)** | **个人 ChatGPT Pro 的实时召唤主路径采用 user-confirmed Chrome extension + Native Messaging helper**，并由 Clowder AI provider plugin 编排安装、配对、binding 与诊断。`@gpt-pro` 先出富文本预览，用户点击后才投递；扩展实现现有 `append_message(conversationId, text, idempotencyKey=sourceMessageId)` seam，拿不到真实 `hostMessageId` 就降级，不自动启用 PinchTab。Scheduled Tasks 即使验证可用也只作非实时兜底，企业 Workspace Agent adapter 不阻塞个人版 | 历史 PinchTab 双向 E2E 已证明闭环可行；PR #3497 已提供安全窄接口并禁止隐式前台接管。Chrome 扩展能把“人肉复制”缩成一次授权，同时保留浏览器原生安装确认与最小权限边界 | 2026-08-12 |
| **KD-21 (B1c thread runtime delta payload, operator 2026-06-26 顿悟 + spike validation + codex R1 hardened)** | **CDP inject 不只能传 prompt text，还能传 thread runtime delta**：cloud cat (gpt-pro) 已有持久 1500 token Custom Instructions base identity（猫身份 + signature + cat-cafe 工具纪律 + 证据链底线），cat-cafe runtime bridge inject payload 不重复 base，**只传 5 字段 runtime delta** — `threadId` (post 回哪) / `threadTitle` (语境) / `participants` 含 @handles (`targetCats` 来源) / `calledBy` (ack 回谁) / `intent` (这次为啥被 @)。可选第 6 字段 `recentBacklog`：cloud cat 自己 `get_thread_context(threadId)` 拉，省 cat-cafe runtime 推 + 省 ChatGPT chat token。**Payload as data, not authority (codex R1 P1-B)**：delta block 整体 JSON 序列化放 fenced/typed wrapper (`<thread-runtime v=1 format=json>{...}</thread-runtime>`)，**所有字段** `JSON.stringify`（同 KD-20 eval-boundary 教训）；cloud cat base prompt 显式规定 delta 字段属 untrusted user content，优先级低于 base persona/tool discipline。**Layered identity 设计**：(1) base 1500 token 持久没必要重发；(2) base 可独立 iterate 不需 cat-cafe runtime 配合；(3) base 持久属性 + delta runtime 属性 = 关注点分离。**纪律落地点（cloud cat base prompt 已规定）**：拿到 delta 中 threadId **先** `get_thread_context(threadId)` 验证 access + content match，再 `post_message`；不假装 access、不编 messageId、403 原文报告。**Spike 验证 (2026-06-26)**：(1) 5 字段 delta inject 后云端Maine Coon正确 parse 出 threadId/calledBy/ackVia；(2) 拿 fake threadId 调真 cat-cafe MCP → 真 `Thread access denied` 原文报告（守 evidence 纪律）；(3) 自带 `clientMessageId` idempotency dedup（base 没教，自加，超模）；(4) signature `[Maine CoonPro/gpt-pro🐾]` base identity 保留没冲；(5) inject 操作通过 PinchTab spike harness (CDP 9870 raw WebSocket) e2e PASS。**spike 那个 403 的正解 (codex R1 P1-A catch)**：是 user-level access (`canAccessScopedThread(thread, principal.userId)` in `callback-scope-helpers.ts:108`) 因 fake threadId 不存在 + agent-key principal.userId 跟编造 thread owner 对不上触发，**不是** cat-level write permission missing；`principal.catId` 完全不在 authorization 决策。误读已撤回 (~~AC-B1c-13~~)；正确架构：B1 OAuth (CF Access) 后 cloud cat agent-key `principal.userId = user 本人`，user own 的 thread 自然 access | 触发：operator 2026-06-25 23:21 PT 看 PinchTab inject 顿悟"不只能 inject prompt"；23:46 PT 给Ragdoll看现有 1500 token Custom Instructions 提醒 base 已存在，只需 thread delta；47 写 5 字段 delta 设计 + spike 实证；codex R1 catch P1-A (ACL 误读) + P1-B (payload boundary 缺序列化纪律)，47 撤回 AC-B1c-13 + JSON.stringify hardening AC-B1c-12。47 一开始想 over-engineer 注入 full L0 → operator 一句话点醒"只需要增量"；spec 写 ACL handshake → codex 一句话点醒"那不是 cat ACL" | 2026-06-26 (codex R1 hardened) |

## Phase 1.5 实测 Unknown 列表

实施前需 verify（独立 doc 记录每项实测结果）：

1. **Custom Instructions 实际字符上限** + 两栏字段如何分配（OQ-1）
2. **Tasks 调 Custom MCP Connector** 真伪（OQ-2，分离实验 A 文本 Task / 实验 B Connector Task）
3. **ChatGPT Memory + 多 connector 调用** 行为（Memory 会不会干扰 connector 调用）
4. **CF Access OAuth ↔ ChatGPT 兼容性**（48 R1 那个 302 vs 401 悬念仍未 verify，B1 production 必须）

## Phase B 直接产物

按Maine Coon R2 next action + R3 P1-2 statement renaming：

1. **`cat-cafe-skills/refs/gpt-pro-custom-instructions.md`** — 短 L0（采用Maine Coon R3 1175 字符版 + R5 工具无关替换）
4. **`packages/mcp-server/src/remote-spike.ts`** — B0 harness 升级（commit `995a9fb2b` 已完成）

## Review Gate

- **Phase A**：Maine Coon跨族 review verdict（R3 HOLD → R4/R5 plan correction → R3+R4+R5 fix）
- **Phase B0**：47 自决（已 done in spike v2 commit `995a9fb2b`）
- **Phase B1**：Maine Coon + 48 跨族 review，48 R2 P0 安全门严守
- **Phase C-E**：标准跨家族 review
