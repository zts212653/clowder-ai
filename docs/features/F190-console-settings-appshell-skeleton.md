---
feature_ids: [F190]
related_features: [F056, F063, F116, F183, F184, F195]
topics: [console, settings, app-shell, community, inbound-pr, frontend, service-manifest]
doc_kind: spec
created: 2026-05-07
community_pr: clowder-ai#645, clowder-ai#662, clowder-ai#669
---

# F190: Console Settings/AppShell Skeleton — 社区 Console 重构的可控切片

> **Status**: done | **Completed**: 2026-05-13 (A-C), 2026-05-17 (F/G/S-2/token convergence), 2026-05-18 (S-4/S-5 CSS execution) | **Owner**: Community + Maintainers | **Priority**: P1

## Why

社区 PR [clowder-ai#645](https://github.com/zts212653/clowder-ai/pull/645) 提供了一个有价值的方向：把旧 Hub/modal 式配置入口升级为 macOS System Settings 风格的 Console/AppShell + Settings rail，并附带 Pencil 设计稿。

但 #645 当前把 Settings shell、Service Manifest、voice refAudio、MCP 管理、IM 配置、Mission Hub 改造、F183/F184 敏感聊天渲染链路、以及 feature 编号迁移混在一个大 PR 中。即使 CI 变绿，仍然不可作为 merge candidate。F190 的目标是把其中**用户可感知且方向正确的 Console/Settings skeleton**提炼成可 review、可回滚、不会覆盖家里 invariants 的第一片。

## What

Architecture cell: action-plane
Map delta: none — F190 只把现有 settings/action surfaces 收口到 Console；Service Manifest 第一刀是 read-only visibility surface，不建立新的 lifecycle owner。
Why: service lifecycle 的 start/stop/install/uninstall 仍 deferred；本 slice 不新增外部动作执行器、资源句柄或并行 registry truth source。

### Phase A: Settings/AppShell Skeleton

从最新 `clowder-ai main` 开新 PR，只提交 Console/Settings 的最小骨架：

- AppShell / Activity Rail 基础布局
- `/settings` route
- Settings 左侧导航与空态/占位内容
- Console 设计 tokens / CSS 基础
- Pencil 设计稿与设计系统文档

明确不迁移旧 Hub 各 tab 的业务逻辑，不接 Service Manifest，不接 voice refAudio，不改聊天渲染链路。

### Phase B: Settings Section Migrations

在 Phase A 合入并稳定后，再按 section 拆分小 PR 迁移实际内容。每个 section PR 必须有独立测试与手工 alpha 走查证据。

### Phase C: Follow-up Systems

Service Manifest、MCP install/manage 写接口、voice refAudio upload、IM connector write endpoints 等属于 F190 后续高风险 slice，不并入 Phase A，也不得夹带进普通 settings section migration。

## Current Intake Snapshot

| Slice | Source | 家里状态 | 口径 |
|-------|--------|----------|------|
| AppShell / ActivityBar / Settings skeleton | clowder-ai#662 | 已合入 main | Phase A |
| Rules/SOP settings | clowder-ai#669 | 已合入 main via cat-cafe#1650 | read-only |
| Ops subtabs | clowder-ai#669 | 已合入 main via cat-cafe#1650 | wrapper + existing panels |
| Marketplace settings | clowder-ai#669 | 已合入 main via cat-cafe#1650 | existing marketplace panel |
| MCP settings entry | clowder-ai#669 | 已合入 main via cat-cafe#1650 | read-only capability board filter；不接写接口 |
| Skill preview modal | clowder-ai#669 | 已合入 main via cat-cafe#1650 | read-only `SKILL.md` preview |
| MCP install/manage write path hardening | clowder-ai#669 + home F146/F193 route | 已合入 main via cat-cafe#1651 | owner-gated secret write hardening；不接 Plugins UI 写回 |
| Service Manifest read-only status | clowder-ai#669 | 已合入 main via cat-cafe#1652 | auth-gated manifest/status/endpoints；不接 lifecycle writes |
| Service lifecycle writes | clowder-ai#669 | deferred | start/stop/install/uninstall 需要独立 runtime source + security review |
| refAudio upload | clowder-ai#669 + home F103/F195 boundary | 已合入 main via cat-cafe#1654 | auth-gated multipart upload + `/uploads` path resolver；不接 F195 meeting audio runtime |
| IM connector write | clowder-ai#669 + home F132/F134/F136/F137 routes | 已合入 main via cat-cafe#1655 | harden existing credential writes；不新增 callback URL / provider endpoint 写面 |
| Chat rendering / bubble behavior | clowder-ai#669 | not in F190 | F183/F184/F194 ownership；F190 不触碰 |
| Service install pipeline + async lifecycle | clowder-ai#674 | **BLOCKED** — REQUEST_CHANGES | P1: F198 编号撞车（家里 F198 = Subscription Carrier）；需改号或折入 F190 sub-scope。111 files / 9k 行需 manual-port，不可 cherry-pick |

Phase C complete: all four high-risk slices (MCP write / Service Manifest read-only / refAudio upload / IM connector write) merged to main. AC-A7 alpha walkthrough completed via Codex + Sonnet smoke on PR #1658.

## Acceptance Criteria

### Phase A（Settings/AppShell Skeleton）
- [x] AC-A1: `clowder-ai#645` 标记为 prototype/reference，不作为 merge candidate；新的 skeleton PR 从最新 `clowder-ai main` 创建。
- [x] AC-A2: 新 PR 只包含 Settings/AppShell skeleton、设计 token、Pencil/design docs；不得迁移 Service Manifest、voice refAudio、IM write endpoints、Mission Hub parity 等业务逻辑。
- [x] AC-A3: 新 PR diff 不包含 F183/F184 敏感路径：
  - `packages/web/src/components/ChatMessage.tsx`
  - `packages/web/src/components/ChatContainer.tsx`
  - `packages/web/src/components/ChatContainerHeader.tsx`
  - `packages/web/src/stores/chatStore.ts`
  - `packages/web/src/app/(chat)/thread/[threadId]/page.tsx`
- [x] AC-A4: 新 PR 不 rename / overwrite 既有 feature docs，不新增重复 `feature_ids`；尤其不得改动 F179/F185/F186 既有真相源。
- [x] AC-A5: 新 PR 必须通过 `pnpm check:features`，并针对 Settings/AppShell 导航补充 focused web tests。
- [x] AC-A6: F183/F184 路由与 mount 保护测试保持通过；thread route marker 必须继续使用真实 `threadId`。
- [x] AC-A7: alpha 走查 `/settings`、`/settings?s=members`、`/settings?s=mcp`、`/settings?s=ops`，无 blocking console error，且旧 chat 首页可继续进入。Proof: PR #1658 `pnpm gate` + alpha smoke `/`, `/settings?s=members`, `/settings?s=mcp`, `/settings?s=ops`, `/settings?s=plugins`, `/settings?s=im`, `/settings?s=rules`, `/settings?s=voice` all returned 200 after `c1cfa294e`. Follow-up visual compare found missing settings nav SVG paths and PR #1659 restored the `box` / `puzzle` icon registry entries with focused regression coverage.

### Phase B（Settings Section Migrations）
- [x] AC-B1: 每个 settings section 独立 review slice，单 slice 不超过一个业务域。Proof: PR #1650 按 read-only settings wrapper / rules / ops / marketplace / MCP / skill preview 等 slice 分段 review；Phase C high-risk writes 独立 PR #1651/#1652/#1654/#1655。
- [x] AC-B2: 每个 section PR 写清 `Source Behavior`、`Must Preserve Home Behavior`、`Proof`。Proof: #1650 与 Phase C 四刀 review request 均带 manual-port 决策表与 focused proof。
- [x] AC-B3: 涉及 high-risk 文件（route 注册、auth/callback、env registry、allowlist、service lifecycle）时必须走 manual-port review。Proof: MCP write / Service Manifest / refAudio / IM connector write 分别经 #1651/#1652/#1654/#1655 独立 review + 云端 review。

### Phase C（High-risk Follow-up Systems）
- [x] AC-C1: MCP write path hardening 第一刀只扩展既有 `capabilitiesMcpWriteRoutes`，不新增并行写路径。
- [x] AC-C2: Service Manifest 第一刀只提供 auth-gated read-only manifest/status/endpoints；不得暴露 start/stop/install/uninstall 写路由或脚本句柄。
- [x] AC-C3: refAudio upload 独立 slice，必须覆盖 path traversal、文件类型/大小限制与清理证明。
- [x] AC-C4: IM connector write 独立 slice，必须覆盖 connector auth/callback proof、secret redaction 与 public sync 泄漏防护。

## Dependencies

- **Evolved from**: [clowder-ai#645](https://github.com/zts212653/clowder-ai/pull/645)（Console Architecture Restructure prototype）
- **Related**: F056（Cat Café design language）
- **Related**: F063（Hub Workspace Explorer）
- **Related**: F116（Open-Source Ops inbound/intake gate）
- **Must preserve**: F183 / F184（Bubble pipeline + ChatMessage mount/rendering invariants）

## Risk

| 风险 | 缓解 |
|------|------|
| 大 PR 继续修导致 review 面积不可控 | #645 只保留为 prototype/reference；新 PR 从 latest main 开 clean branch |
| Settings shell 顺手改到聊天渲染链路 | Phase A denylist 硬卡 ChatMessage / ChatContainer / chatStore / thread route |
| 社区 PR 误改 feature 编号污染知识图谱 | Feat Anchor Guard：不得 rename F179/F185/F186；新增 F190 真相源作为唯一锚点 |
| 设计稿好看但运行态破坏旧入口 | alpha 走查 Settings 与旧 chat 首页；focused web tests 覆盖 Activity Rail 导航 |
| 后续 service/voice/MCP 能力继续膨胀 scope | Phase B/C 明确拆分，high-risk 文件必须 manual-port + proof |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F190 只接收 Console/Settings skeleton 第一片，不接收 #645 whole diff | 方向有价值，但 #645 混入 500+ files、F183/F184 敏感路径和重复 feature 编号 | 2026-05-07 |
| KD-2 | #645 保留为 prototype/reference，新 PR 从最新 main 开 clean branch | clean diff 才能让 reviewer 验证“不改原本东西”；在大 PR 内删改审计成本更高 | 2026-05-07 |
| KD-3 | Phase A denylist 硬卡 ChatMessage / ChatContainer / chatStore / thread route | 这些路径受 F183/F184 保护，Console shell 不应触碰聊天渲染/mount invariants | 2026-05-07 |
| KD-4 | #662 + #669 是当前社区路径；家里 intake 采用 staging branch manual-port，不直接 overlay #669 | #669 是大 follow-up，source 已验证但与家里 F183/F184/F194/F195 分叉，需要逐 slice replay source intent | 2026-05-12 |
| KD-5 | Service Manifest / refAudio / secret write-back 是 F190 Phase C high-risk deferred surface；chat rendering 归 F183/F184/F194 ownership | 服务生命周期、音频文件、secret 写回必须独立 slice + security review + focused proof；气泡/read model 不是 F190 责任面，F190 不触碰。如未来正式立项独立 feature，可迁出到新 F 号，由 maintainer 评估 | 2026-05-12 |
| KD-6 | MCP write path 第一刀只硬化现有 `capabilitiesMcpWriteRoutes`，不新增并行写路径 | 复用 F146/F193 既有 lock/read/write/audit/topology heal；先锁住 secret 丢失、placeholder 写入、owner gate，再单独做 UI 写回 | 2026-05-12 |
| KD-7 | Service Manifest 第一刀只暴露服务清单、endpoint 与 health status，不 port #669 的 lifecycle scripts / process killing / install flows | 家里还没有单一 service lifecycle truth source；直接搬 spawn/SIGTERM/install script 会把运行态控制伪装成已验证平台能力 | 2026-05-13 |
| KD-8 | Service Manifest 可显示 `audio-capture` health probe，但不接管 F195 meeting audio ownership | F190 只 own service status visibility surface；F195 仍 own meeting audio recording/transcript runtime 与 refAudio/upload 边界，F190 不顺手扩到 audio service 控制面 | 2026-05-13 |
| KD-9 | Service Manifest routes 必须使用 `request.sessionUserId` 严格 session identity，不调用 `resolveUserId`/trusted Origin fallback | 可信 Origin header 可被非浏览器客户端伪造；read-only 服务清单仍暴露内部服务拓扑与 endpoint，不能以 `default-user` 兼容回退放行 | 2026-05-13 |
| KD-10 | refAudio upload 第一刀只接 TTS reference-audio 上传与 cat voiceConfig 写回，不接管 F195 meeting audio runtime | 上传 route 必须使用真实 session identity，生成文件名并写入 `UPLOAD_DIR`，`cat-voices` 只允许 `/uploads/...` 解析回 upload dir；录音、转写、会议音频存储仍属 F195 | 2026-05-13 |
| KD-11 | `voiceConfig.refAudio` 的期望格式是上传 route 返回的 `/uploads/<server-generated>`，或 legacy character voice dir 内的相对/绝对路径 | cats 写路径保留字符串兼容性；读端 resolver 对空值、traversal、越界路径 fail-safe 到 `invalid-ref`，所以手写异常路径可以持久化但不会被 TTS 使用 | 2026-05-13 |
| KD-12 | IM connector write 第一刀只 harden 现有 `/api/config/secrets` 与 guided connector credential routes，不新增 callback URL / provider endpoint 写面 | 写路径必须使用真实 session identity + explicit owner fail-closed，拒写 redacted placeholder，保留 omitted secret / `null` 删除 / F136 hot reload；F190 不接管 F088/F124 connector runtime、transport、message routing | 2026-05-13 |

## Known Limitations

| # | 限制 | 当前处置 | 后续候选 |
|---|------|----------|----------|
| KL-1 | MCP env patch / install update 只新增或覆盖 env/header secret，不删除单个 env key | 保护现有 secret 不被 UI omit 清空；删除需求暂不混入本安全 slice | 独立设计 `DELETE /api/capabilities/mcp/:id/env/:key` 或 PATCH `null` 删除语义 |
| KL-2 | install/delete 是 owner-configured enforcement；未配置 `DEFAULT_OWNER_USER_ID` 的多用户/LAN 部署仍沿用既有身份 gate | 保持 localhost/dev 兼容，secret env patch 已 fail-closed | UI/ops docs 明确多用户部署必须配置 `DEFAULT_OWNER_USER_ID`；可加 telemetry warning |
| KL-3 | Connector secret writes 在 audit append 失败时仍返回成功 | 凭据已经落盘并触发热生效，audit 是 side channel；失败会写 warn 日志但不回滚主写入 | 若引入 audit retry / queue / outbox 机制，可补偿丢失的 audit append |

## Vision Guard Evidence

| team experience / 关切 | 当前实际状态（证据） | 匹配？ |
|-------------------|----------------------|--------|
| "我们不就是 intake 一个前端回家" | F190 只 intake Console/Settings rail 方向：Phase A skeleton + #1650 read-only section wrappers；没有接收 #645/#669 whole diff | ✅ |
| "搞完别出太多 bug，我们家后续的那些功能别改坏了，包括气泡的那些" | Opus-46 愿景守护验证 Phase C 4/4 已合入 main、F183/F184/F194 红区 12 文件零触碰；PR #1658 alpha smoke 旧 chat 首页 + settings 7 路由全 200 | ✅ |
| "pnpm alpha:start 这个你能跑吧？alpha 测试！" | Codex 启动 alpha 隔离环境并定位 dev CSP + ThreadCatPill alpha blocker；Sonnet 复跑 alpha smoke PASS；hotfix PR #1658 merged `c1cfa294e` | ✅ |

## Close Gate Report

```yaml
close_gate_report:
  feature_id: F190
  spec_path: docs/features/F190-console-settings-appshell-skeleton.md
  head_sha: "01f468758 + close sync commit"
  report_date: 2026-05-13
  harness_feedback:
    status: none
    reason: "F190 是 Console/Settings intake 与配置面 hardening；未新增 harness/skill/MCP 行为模式，相关 trace anomalies 已在 Phase C review lessons 中沉淀"
  ac_matrix:
    - ac_id: AC-A1..AC-A7
      status: met
      evidence:
        - kind: pr
          ref: "PR #1645 / #1650 / #1658"
          description: "Phase A skeleton + read-only intake + AC-A7 alpha unblock and smoke"
        - kind: test
          ref: "pnpm gate at PR #1658"
          description: "Full merge gate passed after alpha hotfix"
        - kind: doc
          ref: "Opus-46 vision guardian PASS"
          description: "Source intent preserved and red-zone zero-touch verified"
      resolution: null
    - ac_id: AC-B1..AC-B3
      status: met
      evidence:
        - kind: pr
          ref: "PR #1650"
          description: "Read-only settings migrations reviewed as manual-port slices with Source/Preserve/Proof"
        - kind: pr
          ref: "PR #1651 / #1652 / #1654 / #1655"
          description: "High-risk route/auth/env/service surfaces split into independent Phase C PRs"
      resolution: null
    - ac_id: AC-C1..AC-C4
      status: met
      evidence:
        - kind: pr
          ref: "PR #1651"
          description: "MCP write path hardening"
        - kind: pr
          ref: "PR #1652"
          description: "Service Manifest read-only status"
        - kind: pr
          ref: "PR #1654"
          description: "refAudio upload + voiceConfig persistence/hydration/drain fixes"
        - kind: pr
          ref: "PR #1655"
          description: "IM connector credential write hardening"
      resolution: null
```

## Phase F: Console IA Convergence — 入口去重 + Shell 一致性（验证后 Gap 清单）

> **Status**: ✅ merged (PR #1720, `94c9cee49`) | **Trigger**: CVO 2026-05-14 post-F199-close 实测发现多处入口重复 + 视觉不一致
> **方向**: F190 follow-up fix PR，不开新 Feature（CVO: "禁止新开feat了 原本你们的f199就不应该存在 就是f190的follow up"）
> **验证基线**: main `a9d27674a` (2026-05-16)。下方"已修"项均经 grep 实地确认。

### 设计原则（CVO 确认）

- Settings page 是 canonical home（URL-routable），Hub 只展示摘要 + deep-link，不重复完整配置 UI
- 三层 shell 各司其职：ActivityBar（全局导航，唯一入口）、ChatContainerHeader（当前 thread 操作）、ThreadSidebar（thread 管理 + 过滤）
- 入口唯一性：同一功能只在一个 shell 层有入口按钮，不重复

### 审计发现

#### 1. ChatContainerHeader.tsx（🔴 红区文件 — 修改需 CVO override）

对比 clowder-ai 开源 main，本地多出 7 项：

| # | 组件 | 来源 | 处置建议 |
|---|------|------|----------|
| 1 | CatCafeLogo | 本地品牌 | ✅ **保留**（CVO 确认） |
| 2 | DaemonActiveIndicator | F198 | ✅ **保留**（CVO 确认，本地独有） |
| 3 | ThreadCatPill | F154 | ✅ **保留**（CVO 确认，本地独有） |
| 4 | LiveAudioToggle（🎤 麦克风） | F195 会议副驾驶 | ✅ **保留**（本地独有功能） |
| 5 | ~~Signal Inbox bell（🔔 铃铛）~~ | Signals | ✅ **已删除**（2026-05-16 grep 验证：ChatContainerHeader 0 匹配） |
| 6 | ~~ThemeToggle~~ | — | ✅ **已删除**（同上） |
| 7 | ~~HubButton~~ | — | ✅ **已删除**（同上） |

#### 2. ThreadSidebar.tsx（非红区）

对比 clowder-ai 开源 main，"新对话"按钮旁本地多出 4 项：

| # | 组件 | 来源 | 处置建议 |
|---|------|------|----------|
| 1 | ~~Memory Hub 按钮~~ | — | ✅ **已删除**（2026-05-16 grep 验证：ThreadSidebar 0 匹配） |
| 2 | ~~IM Hub 按钮~~ | — | ✅ **已删除**（同上） |
| 3 | Mission Hub section | 本地功能 | 保留（开源只有猫猫训练营） |
| 4 | LabelFilterBar | 本地功能 | 保留（thread 过滤） |

#### 3. Hub 内容与 Settings 页面重复

| Hub 入口 | Settings 入口 | 复用的组件 | 处置建议 |
|----------|---------------|-----------|----------|
| system → im | /settings?s=im | HubConnectorConfigTab | Hub 仅展示摘要 + deep-link |
| system → env | /settings?s=system | HubEnvFilesTab | Hub 仅展示摘要 + deep-link |
| monitor → governance | /settings?s=rules | HubGovernanceTab | Hub 仅展示摘要 + deep-link |

#### 4. ActivityBar

两仓一致：Home / Memory / Mission / Signals / theme toggle / settings。本地仅提取了 helper 函数（代码重构），无 UI 差异。**无需修改。**

#### 4b. AppShell / ChatContainer ownership（Codex 二轮审计补充）

clowder-ai source 已把桌面 ThreadSidebar 归到 `AppShell`：非 `/settings` / `/signals` / `/memory` / `/mission` 路由时，由 shell 固定渲染 260px desktop rail；`ChatContainer` 只保留 mobile overlay。家里当前仍由 `ChatContainer` 控制 desktop sidebar，导致：

| 差异 | 开源 | 本地 | 影响 |
|------|------|------|------|
| Desktop ThreadSidebar owner | AppShell | ChatContainer | 三层 shell 责任不一致，顶栏 hamburger 在 desktop 仍可见 |
| Hidden routes | AppShell `SIDEBAR_HIDDEN_ROUTES` | 分散在 chat 容器状态 | settings/signals/memory/mission 的 sidebar 展示规则不够集中 |
| ChatContainer desktop layout | 只负责 chat content | 同时负责 sidebar + chat | 后续顶栏/状态栏视觉对齐会继续互相牵扯 |

**处置建议**：Phase F intake 时恢复 source 的 AppShell ownership，但必须保留家里 F154/F194/F195/F198 顶栏能力；不能整文件覆盖 `ChatContainer` / `ChatContainerHeader`。

#### 5. Settings 页面功能丢失（代码级全量对比 clowder-ai vs local）

##### 5a. /settings?s=im（IM 配置）— ⚠️ 大部分已修，仅连接测试缺

> **2026-05-16 实地验证更新**：大部分功能已在后续 PR 修复。

| 丢失项 | 说明 | 状态（2026-05-16 验证） |
|--------|------|------------------------|
| Connection State 监控 | `connectionState`/`lastHeartbeat`/`category` | ✅ **已有** — `connStatePill` import + `lastHeartbeat` + `formatHeartbeat` |
| HubPermissionsTab 集成 | 飞书/企微/钉钉权限管理 UI | ✅ **已接入** — `HubConnectorConfigTab.tsx:22` lazy import + `:259`/`:401` 渲染 |
| 连接测试 | `handleTestConnection()` 未实现 | ❌ **仍缺** — 0 匹配 |
| Heartbeat 显示 | 平台名称下方的心跳时间 | ✅ **已有** — line 208-209 |
| 群管理入口 | PERMISSION_CONNECTORS 映射 | ✅ **已有** — 随 HubPermissionsTab 接入 |

##### 5b. /settings?s=members（成员管理）— ✅ 已修复

> **2026-05-16 实地验证**：全部功能已恢复。`SettingsContent.tsx` line 9-10 import `HubCatEditor`/`HubCoCreatorEditor`，line 15 `useConfirm`，line 66 `handleToggleAvailability`，line 91 `handleDeleteMember`。完整 CRUD 可用。

##### 5c. /settings?s=system（系统配置）— ✅ 已修复

> **2026-05-16 实地验证**：`SettingsContent.tsx:162` 已有 `excludeCategories={['connector']}`。

##### 5d. 其他 Settings 页面

| 页面 | 状态 | 说明 |
|------|------|------|
| accounts（账户与密钥） | ✅ 一致 | — |
| skills（Skill 管理） | ✅ 本地多 SkillConflictBanner | F199 Phase E 新增 |
| mcp（MCP 管理） | ✅ 一致 | — |
| plugins（插件/集成） | ✅ 一致 | — |
| marketplace（能力市场） | ✅ 一致 | — |
| voice（语音管理） | ✅ 一致 | — |
| rules（规则与 SOP） | ✅ 本地多 HubGovernanceTab + BrakeSettingsPanel | 本地更丰富 |
| notify（通知） | ✅ 一致 | — |
| ops（运维监控） | ✅ 一致 | — |

##### 5e. /mission route alias — ✅ 已修复

> **2026-05-16 实地验证**：`app/mission/page.tsx` 已存在。

#### 6. 状态栏样式差异

| 组件 | 差异类型 | 说明 |
|------|---------|------|
| ConnectionStatusBar | ✅ V-7 已修 | `cocreator-*` → `--console-border-soft` / `--console-hover-bg` / `conn-amber-text` (PR #1705) |
| ParallelStatusBar | ✅ V-8 已修 | hardcoded Tailwind → `conn-*` semantic colors; `rounded-full` → `rounded-xl` + console border (PR #1705) |
| RightStatusPanel | ✅ V-9 已修 | buttons → `console-pill` class; badges → `conn-amber-*` / `conn-emerald-*` (PR #1705) |
| RightStatusPanel | ~~extra Hub gear~~ | ✅ **已删除**（2026-05-16 grep 验证：0 匹配） |
| 字号 | text-xs vs text-[11px] | 本地略小 |

注意：`ParallelStatusBar` / `RightStatusPanel` 含家里 F194/F154 行为补丁（例如 active cat intent mode），Phase F 只能做入口/视觉收敛，不能整文件 source-replace。

#### 7. Hub 导航 vs Settings 导航孤立组件

Hub（CatCafeHub.tsx）使用 accordion 分 3 组 19 tab，Settings 使用 flat 12 section。以下组件**文件存在但未接入任何导航**：

| 孤立组件 | 说明 | 状态（2026-05-16 验证） |
|---------|------|------------------------|
| ~~HubPermissionsTab.tsx~~ | 权限管理 UI | ✅ **已接入** HubConnectorConfigTab lazy import |
| ~~HubCatEditor.tsx~~ | 成员编辑器 | ✅ **已接入** SettingsContent line 9 |
| ~~HubCoCreatorEditor.tsx~~ | 共创者编辑器 | ✅ **已接入** SettingsContent line 10 |

#### 7b. ThreadSidebar 训练营入口行为（Codex 二轮审计补充）

开源 ThreadSidebar 的训练营按钮会打开 `BootcampListModal`，展示已有训练营并允许继续。

> **2026-05-16 实地验证**：✅ **已修复**。`ThreadSidebar.tsx` line 9 import `BootcampListModal` + line 1089 渲染。Memory/IM 重复按钮也已删除。

#### 8. Signal 页面差异（SignalInboxView / SignalArticleDetail）

Signal 页面两仓**双向分叉**：本地功能更多，但开源有 2 项我们缺的。

##### 本地有、开源没有（保留，无需改）

| 功能 | 组件/位置 |
|------|----------|
| Stats Cards（今日/未读/7 日） | SignalStatsCards.tsx |
| Batch Actions（多选/批量已读/归档/标签/删） | BatchActionBar.tsx |
| Study Timeline | StudyTimeline.tsx |
| Tier Filter（T1-T4 筛选） | SignalInboxView toSignalTier() |
| 返回线程按钮 | SignalNav.tsx 返回链接 |

##### 开源有、本地缺（❌ 需补）— ✅ 2026-05-17 审计纠正：两项均已实现

| 丢失项 | 说明 | 2026-05-17 复核 |
|--------|------|----------------|
| Content Enrichment | `/api/signals/articles/{id}/enrich` 全文抓取 | ✅ **已有** — `enrich-article.ts` + `webpage-fetcher.ts` + `signals.ts` route + SignalArticleDetail UI（enrichedContent/enriching/enrichError 状态完整） |
| Thread 讨论导航 | `getThreadHref` 从 Signal 文章跳转关联 thread | ✅ **已有** — `thread-navigation.ts` + `POST /api/signals/articles/:id/discuss` + StudyFoldArea"在对话中讨论"按钮 + 双向 link/unlink API |

##### 布局风格分叉

| 维度 | 本地 | 开源 |
|------|------|------|
| 整体风格 | Dashboard 卡片式（stats 突出） | Console panel 式（sidebar + content 紧凑） |
| 主面板 | `lg:grid-cols-[1.25fr_1fr]` 非对称 | 左 `[420px]` 固定 + 右 `flex-1` |
| 色彩 | Tailwind token（cocreator-primary 等） | CSS 变量（--console-panel-bg 等） |
| 圆角 | `rounded-2xl` / `rounded-xl` | `rounded-[18px]` / `rounded-[14px]` |
| Nav 标签 | `'Signals'` / `'Sources'` | `'收件箱'` / `'信号源'` |

**布局待决策**：两种风格哪个保留？需 CVO 拍板。

#### 9. Tailwind 原色硬编码全局审计（2026-05-16 CVO 拍板）

本地 `packages/web/src/` 共 ~1361 处 Tailwind 原色硬编码（`bg-green-400` / `text-red-500` / `border-amber-300` 等），分布在 201 个文件。以下 9 文件为**第一梯队**——开源已全量迁移到 `conn-*` / `console-*` 语义 token，我们可以直接参考 migration path。

##### 第一梯队：开源已修、本地待修（V-10 ~ V-18）

| # | 文件 | 硬编码数 | 开源 token | 状态 |
|---|------|---------|-----------|------|
| V-10 | `rich/InteractiveBlock.tsx` | 85 | `conn-amber/emerald/red` + `console-card-bg/pill-bg/border-soft` | ✅ PR #1736 |
| V-11 | `capability-board-ui.tsx` | 68 | `conn-*` 语义色 | ✅ PR #1736 |
| V-12 | `HubSkillsTab.tsx` | 31 | `conn-*` | ✅ PR #1736 |
| V-13 | `PushSettingsPanel.tsx` | 29 | `conn-*` | ✅ PR #1734 |
| V-14 | `HubTraceTree.tsx` | 28 | 部分迁移（剩 4 处 tree node 类型色） | ✅ PR #1736 |
| V-15 | `memory/EvidenceSearch.tsx` | 22 | `console-form-input/card-soft-bg` | ✅ PR #1736 |
| V-16 | `EvidenceCard.tsx` | 19 | `conn-*` | ✅ PR #1736 |
| V-17 | `BrakeModal.tsx` | 15 | `conn-emerald-text/red-text` + `console-card-bg/overlay` | ✅ PR #1736 |
| V-18 | `workspace/SchedulePanel.tsx` | 13 | `conn-emerald/purple/red` + `console-pill-bg` | ✅ PR #1736 |

**小计：310 处**。参考开源 `conn-*` / `console-*` token 逐文件迁移，CSS-only 不改行为。

##### 第二梯队：两边都硬编码（暂缓，无现成 path）

| 文件 | 硬编码数 | 说明 |
|------|---------|------|
| HubPermissionsTab.tsx | 43 | 开源结构不同，需设计性迁移 |
| BootstrapSummaryCard.tsx | 30 | 开源删了但没用 token |
| marketplace-badges.tsx | 23 | 两边都硬编码 |
| DiffViewer.tsx | 22 | 语法高亮色，可能有意为之 |
| ChatContainer.tsx | 22 | 两边都硬编码 |
| AuthorizationCard.tsx | 22 | 两边都硬编码 |
| TriageBadge.tsx | 18 | 状态标签色 |
| CapabilityAuditLog.tsx | 18 | 审计日志色 |

##### 色系分布（全局）

gray/slate 300+ | amber 180+ | red 140+ | green 120+ | blue 110+ | 其他 ~130

#### 9b. 其他待审计

| 区域 | team lead提到的问题 | 审计状态 |
|------|-----------------|----------|
| 字体 | Settings 里字体不一样 | 🔲 待视觉对比 |
| Thread 管理栏 | thread sidebar 视觉差异 | 🔲 待对比 |
| 顶栏视觉 | 顶栏视觉差异（非按钮） | 🔲 待对比 |

#### 10. Codex 二轮审计结论（2026-05-15）

46 的首轮审计覆盖了大部分功能缺口；二轮补充集中在“入口归属”和“文件存在但 contract 不可直接接回”的问题：

| # | 补充发现 | 结论 |
|---|----------|------|
| C-1 | AppShell 未接管 desktop ThreadSidebar | 需要修。否则顶栏/侧栏责任继续混在 ChatContainer，视觉修不干净 |
| C-2 | ThreadSidebar 训练营按钮从列表入口变成直接创建 | 需要修。恢复 BootcampListModal 入口语义 |
| C-3 | RightStatusPanel 仍有 Hub 齿轮 | 需要修。也是设置入口重复 |
| C-4 | Signal enrichment 缺后端 service + route | 需要修。F-5 不是纯前端补状态 |
| C-5 | HubPermissionsTab contract 与开源分叉 | 需要设计性接回，不能只补 import |
| C-6 | `/mission` alias 缺失 | 可顺手补，兼容 source/历史链接 |
| C-7 | theme token packaging / font-size token drift | 先记录，视觉刀再统一；不要盲目全局 import xterm CSS |

#### 11. Visual Design Pattern Gaps — Thread Sidebar + 全局 Line Divider（CVO 2026-05-15）

CVO 对比开源截图后确认以下设计模式需要跟进：

##### 11a. Thread List: Line Divider → Card Gap

| 维度 | 本地 | 开源 |
|------|------|------|
| 分隔方式 | `border-b border-gray-50`（线分隔） | `mx-2 rounded-[14px]` + padding（卡片间距） |
| Active 状态 | `bg-cocreator-light` | `bg-[var(--console-active-bg)]` |
| Hover 状态 | `hover:bg-cafe-surface-elevated` | `hover:bg-[var(--console-hover-bg)]` |

##### 11b. "新对话" Button Depth

本地：`bg-cocreator-primary text-white hover:bg-cocreator-dark text-xs`，视觉扁平。
开源：`console-button-primary` CSS class — `color-mix` accent/card-bg 深色混合 + `font-weight: 600`。

##### 11c. Trash Area Styling

本地：`border-t border-[var(--console-border-soft)]` 纯文本行 + `text-cafe-muted`。
开源：`bg-[var(--console-code-bg)] rounded-xl h-9` 样式化工具行 + `hover:opacity-80`。

##### 11d. "全部已读" Affordance

本地：`text-[10px] text-cafe-muted`（纯文字链接，无容器）。
CVO 要求：改为 button 或 card 样式，提供可点击视觉暗示。

##### 11e. Tag Label Visual Distinction

ThreadItem 内 `LabelDots` 渲染 `w-1.5 h-1.5` 色点堆叠，视觉区分度低。CVO 要求优化为可辨识标签。

##### 11f. Line Divider Audit — 全局高优先级项

| 文件 | 组件 | 当前模式 | 建议 |
|------|------|----------|------|
| ThreadItem.tsx | Thread 列表项 | `border-b border-gray-50` | 改 card gap |
| QueueEntryRow.tsx | 队列行 | `border-b last:border-b-0` | 改 card gap |
| IndexStatus.tsx | 状态行（×3） | `border-b border-cafe/50 last:border-b-0` | 改 card gap |
| CommunityPanel.tsx | 统计/分区 | `border-b border-cocreator-light/20` | 改 card gap |
| SchedulePanel.tsx | 任务行（×3） | `border-b border-[#E8DFD4]` | 改 card gap |
| TranslationMatrix.tsx | 表格行 | `divide-y divide-[#F0E8DB]` | 保持（表格合理） |
| HubGovernanceTab.tsx | 表格行 | `divide-y divide-gray-100` | 保持（表格合理） |

---

## Phase G: Token 收敛 + 视觉降噪（能力保留）

> **Status**: ✅ merged (PR #1712) | **Trigger**: 2026-05-16 三猫对比审计收敛 + CVO 拍板
> **原则**：能力保留，视觉降噪。不为好看砍功能——开源天然清爽是因为能力少，我们的路线是 token 收敛让现有功能视觉统一。
> **根因**：cafe-/console-/cocreator- 三套 token 并存，globals.css 623 行（开源 300 行），13 个组件同文件混用多套 token → 系统性视觉熵

### AC

| # | 内容 | 优先级 | 验收标准 |
|---|------|--------|----------|
| G-1 | Token 体系收敛：三轨→单轨 | P0 | ✅ globals.css 623→334 行；cocreator-* 定义全删；组件统一引用 cafe-/console-/conn-* 单一源；重复定义清除 |
| G-2 | ThreadSidebar 二级控件 + DirectoryPickerModal 统一 console token | P1 | ⚠️ **部分完成**：主壳 + 高频 hover controls 已迁 conn-*/console-*；DirectoryPickerModal 主结构改用 `rounded-[28px]` + `console-card-bg`，但二级控件仍有 45 处 `border-cafe`/`bg-cafe-surface*` 残留（9 文件，DirectoryPickerModal 16 处最多）。后续 V-10~V-18 梯队一并清理 |
| G-3 | Modal/Overlay 色语义化 | P1 | ✅ 所有 `bg-black/[0-40%]` 硬编码替换为 `var(--console-overlay-backdrop)` / `var(--console-overlay-medium)` |
| G-4 | CardBlock info/success/danger 改 conn-* 语义色 | P2 | ✅ info/success/danger/warning 四态全迁到 conn-* 语义色 |
| G-5 | Workspace 面板 line-divider audit | P2 | ✅ 列表类（SchedulePanel）改 card gap；密集内容（DiffViewer/ConsolePanel/BrowserPanel）保留语义化 border |
| G-6 | 统一动画体系 | P3 | ✅ `pulse-subtle`/`shake` 迁入 tailwind.config.js；复杂动画（reduced-motion, CSS var timing）保留 globals.css |

### PR 规划：1 个 PR 收敛（CVO: "别给我搞成六个PR"）

G-1~G-6 全是 CSS class 替换，无逻辑改动。一个 PR 让 reviewer 做一次完整 token 审计比拆碎更高效。

执行顺序（同 PR 内分 commit）：
1. globals.css 清理（G-1 基建）— cocreator-* 删定义 + 重复清除
2. 组件 token 迁移（G-1 组件层 + G-2 + G-4 + V-10~V-18）— 逐文件机械替换
3. Modal overlay 语义化（G-3）
4. Line-divider audit（G-5）
5. 动画收敛（G-6）

### 依赖与约束

- G-1 基建 commit 先行，后续 commit 基于收敛后的 token 源
- V-10~V-18（第一梯队 310 处）并入 G-1 组件层 commit
- 不碰 F183/F184/F194 红区文件（ChatContainerHeader 已在 PR #1708 修完）
- CSS-only 变更为主，无逻辑改动

---

### 修改清单汇总（按优先级排序）

> **方向**：F190 follow-up PR，不开新 Feature。

#### 已修好（2026-05-16 grep 验证 main `a9d27674a`）

| # | 原问题 | 验证 |
|---|--------|------|
| ~~F-1~~ | IM 权限管理断线 | ✅ HubPermissionsTab lazy import + 渲染 |
| ~~F-2~~ | IM 连接状态/心跳丢失 | ✅ connStatePill + lastHeartbeat + formatHeartbeat |
| ~~F-4~~ | 成员管理只读 | ✅ HubCatEditor/CoCreatorEditor/useConfirm/handleDelete/handleToggle |
| ~~D-1~~ | Header ThemeToggle 重复 | ✅ 已删除 |
| ~~D-2~~ | Header HubButton 重复 | ✅ 已删除 |
| ~~D-3~~ | Header Signal bell 重复 | ✅ 已删除 |
| ~~D-4~~ | Sidebar Memory Hub 重复 | ✅ 已删除 |
| ~~D-5~~ | Sidebar IM Hub 重复 | ✅ 已删除 |
| ~~D-6~~ | RightStatusPanel Hub 齿轮 | ✅ 已删除 |
| ~~D-8~~ | 训练营入口语义丢失 | ✅ BootcampListModal 已接入 |
| ~~S-1~~ | excludeCategories 缺失 | ✅ SettingsContent.tsx:162 |
| ~~S-3~~ | /mission alias 缺失 | ✅ app/mission/page.tsx |

#### 仍缺（3 项）

| # | 区域 | 问题 | 修改内容 | 优先级 |
|---|------|------|----------|--------|
| ~~F-3~~ | IM 配置页 | 连接测试按钮丢失 | 补 handleTestConnection() + `/api/connector/{id}/test` | ✅ PR #1720 |
| ~~F-5~~ | Signal 详情 | Content Enrichment 丢失 | 补后端 enrich route + 前端 enrichedContent 状态 | ✅ PR #1720 |
| ~~F-6~~ | Signal 详情 | Thread 导航丢失 | 补 getThreadHref 跳转关联 thread | ✅ PR #1720 |

#### 架构级（中期 follow-up）

| # | 区域 | 问题 | 修改内容 | 优先级 |
|---|------|------|----------|--------|
| D-7 | AppShell / ChatContainer（🔴 红区） | desktop sidebar owner 错位 | AppShell 接管 desktop ThreadSidebar | **Deferred**（CVO 2026-05-17: "先不做，记录一下"） |
| S-2 | Hub/Settings 重复 | IM/Env/Governance 三处 | Hub 改为摘要 + deep-link | ✅ **已清理** (PR #1742)：CatCafeHub modal + 8 Hub-only 组件 + 6 test 删除（~3,100 行）；3 callers 重定向到 `/settings` deep-link；OpsContent URL deep-linking (`ops=`/`obs=`) |
| S-4 | Console tokens | font / color token drift | 字号五档收敛（见下方 spec）；消灭 raw px 值 | ✅ PR #1748 merged（133 files CSS-only，Maine Coon review PASS + cloud review 0 P1/P2） |
| S-5 | Thread/Top/Status visual | 视觉不一致 | 间距/圆角 role-based 规范（见下方 spec）；不一刀切 | ✅ PR #1748 merged（同 PR，border-radius 四档统一） |

#### P1 — Visual Design Pattern 跟进（CVO 2026-05-15 确认）

| # | 区域 | 问题 | 修改内容 |
|---|------|------|----------|
| V-1 | ThreadItem | Line divider → card gap | ✅ `mx-2 rounded-[14px]` + `console-active-bg`/`console-hover-bg` |
| V-2 | ThreadSidebar 新对话 | 按钮视觉扁平 | ✅ `console-button-primary` class |
| V-3 | ThreadSidebar 回收站 | 纯文字行 | ✅ `bg-[var(--console-code-bg)] rounded-xl h-9` 样式化行 |
| V-4 | ThreadSidebar 全部已读 | 纯文字链接 | ✅ `rounded-md bg-[var(--console-field-bg)]` button 样式 |
| V-5 | ThreadItem LabelDots | 色点堆叠无区分 | ✅ `rounded-full px-1 py-px` label pill 展示标签名 |
| V-6 | 全局 line divider | 高优 border-b 列表项 | ✅ QueueEntryRow / IndexStatus / CommunityPanel / SchedulePanel 均改 card gap |
| V-7 | ConnectionStatusBar | `cocreator-*` → console tokens | 降级/离线/错误框全换 `--console-border-soft` / `--console-hover-bg`；保留 `gap-4` 不跟开源 `gap-3` |
| V-8 | ParallelStatusBar | Tailwind 硬编码色 → `conn-*` 语义色 | pill 形状 `rounded-full` → `rounded-xl` + border；状态点/停止按钮用 `conn-emerald/red/amber`；hover → opacity；保留家里 `gap-4` |
| V-9 | RightStatusPanel | 按钮/卡片/badge 收敛 | 按钮用 `console-pill` 模式（hover:text 而非 hover:bg）；badge 用 `conn-*` 色；卡片加投影；保留家里 `gap-4` + 288px 宽度 |

#### 待 CVO 拍板

| # | 区域 | 问题 | 等什么 |
|---|------|------|--------|
| ~~W-1~~ | ~~状态栏~~ | ~~CSS 变量 vs Tailwind 硬编码色~~ | **已拍板（2026-05-16）**：跟进开源 console token 体系，但 `gap-4` 保留家里的（开源 `gap-3` 太拥挤）。详见 V-7/V-8/V-9 |
| ~~W-2~~ | Signal 页面布局 | Dashboard 卡片式 vs Console panel 式 | **已拍板**：保留家里全部功能（stats/batch/timeline/tier），可学习开源样式 |
| ~~W-3~~ | 字体/Thread 管理栏/顶栏视觉 | 未完成对比 | **已被 S-4/S-5 spec 覆盖**（字号 + 间距规范解决大部分视觉差异） |

### S-4/S-5 执行 Spec（三猫讨论收敛 2026-05-17）

> 参与：opus（提案）+ codex（review 意见）+ opus-47（独立观点）。CVO 授权猫猫自决，约束："别太夸张"、gap-4 保留。
> 原则：**role-based 规范**，不一刀切。Console 是密集工具界面，header/sidebar/settings panel 密度本来不同。
> 分歧裁决：16px 保留（Maine Coon ✓）；圆角 md=8px（Maine Coon ✓）；gap-3 保留（Maine Coon ✓）；10px budget + lint（47 ✓）；density scale 命名（47 ✓）。

#### 字号体系（S-4）

| 档位 | Tailwind 类 | 像素 | 使用场景 | 禁止场景 |
|------|------------|------|----------|----------|
| micro | `text-[10px]` | 10 | badge 数字、daemon short id、极小状态标注 | 可读标签、按钮文案 |
| xs | `text-xs` | 12 | 正文标签、按钮文字、sidebar 条目、list item | — |
| sm | `text-sm` | 14 | section 标题、卡片正文、设置项 label | — |
| base | `text-base` | 16 | 二级标题、弹窗正文小标题、settings panel 局部标题 | 重复列表 |
| lg | `text-lg` | 18 | 页面标题、弹窗主标题 | section title（用 sm/base） |

**执行规则**：
- 禁止：`text-[11px]`、`text-[12px]`、`text-[14px]`、`text-[16px]`、`text-[18px]` — 全部迁到对应 Tailwind 标准类
- 唯一允许的自定义值：`text-[10px]`（Tailwind 无对应标准类）
- **10px budget**（opus-47 提案）：全局 ≤30 处，新增必须 PR review 确认必要性。后续加 biome lint 规则禁止新增非标准像素值。**注：当前存量 ~475 处（历史积累），本轮 S-4 只做 raw px 归类，budget 收敛是独立后续任务**
- 落地顺序：先清 `text-[11px]`（全部→`text-xs`），再清 Settings raw text size

#### 间距体系（S-5）

**内边距 — 三档 Density Scale（opus-47 提案，不追求全局统一）**：

| Density | Padding | 场景 | 当前对应 |
|---------|---------|------|----------|
| **dense** | `px-2 py-1` ~ `px-3 py-1.5` | list items、inline pills、badge | ThreadItem 内部 |
| **default** | `px-3 py-2` ~ `px-4 py-3` | form fields、buttons、sidebar 条目 | ThreadSidebar `px-3` ✅ |
| **spacious** | `px-5 py-3` ~ `px-5 py-4` | page header、modal header、shell | ChatContainerHeader `px-5 py-3` ✅ |

Header 和 Sidebar 松紧不同**是设计意图**（spacious vs default），不是 bug。新组件按"surface 层级"选档位。

**Gap — 五档**：

| 档位 | 值 | 场景 |
|------|------|------|
| micro | `gap-1` / `gap-1.5` | icon + text、micro cluster |
| tight | `gap-2` | pill/button 内部、小控件组 |
| normal | `gap-3` | compact card/list row 内部 |
| section | `gap-4` | 组件之间、状态栏 cluster（**已拍板保留**） |
| page | `gap-6` | settings/content section stack，不进 sidebar/header 密集区 |

**圆角 — 四档**：

| 档位 | Tailwind | 像素 | 场景 |
|------|----------|------|------|
| sm | `rounded-md` | 6 | badge、小按钮、小 pill |
| md | `rounded-lg` | 8 | 重复 card/list item/input（默认上限） |
| lg | `rounded-xl` | 12 | panel、toolbar、较大设置块 |
| xl | `rounded-2xl` / `rounded-[18px]` | 16-18 | outer shell / modal frame（不进重复元素） |

**独立轨**：`rounded-full`（avatar、pill）— 不进四档系统，独立使用。

**执行规则**：
- 禁止：`rounded-[24px]`、`rounded-[16px]`、`rounded-[10px]` 等 raw 值 — 迁到最近的标准档
- 不统一 header 与 sidebar 的 padding — 密度差异是设计意图（spacious vs default）
- 只改明显不合角色的间距，不为了统一而统一
- **Lint 护栏**（后续加）：禁止新增非标准 `rounded-[Xpx]`（除 18）和非标准 gap 值（gap-3/5/7 等 magic number）

#### 落地计划

1. 先清 `text-[11px]` + Settings raw text size（最机械、风险最低）
2. 再清 radius raw 值（`rounded-[24px]` → `rounded-2xl` 等）
3. 最后审视 gap/padding 明显不合角色的（逐 case 判断，不全局扫）
4. 一个 PR，CSS-only，不改逻辑

### 修改约束

- ChatContainerHeader.tsx 是 F183/F184/F194 红区文件，D-1/D-2/D-3 修改前必须获得 CVO override 确认
- ChatContainer/AppShell ownership 涉及 F183/F184/F194 红区，D-7 必须小刀修改 + focused smoke，不得整文件覆盖
- 不开新 Feature，以 F190 follow-up PR 形式修复
- 所有入口去重必须确保 ActivityBar 对应入口仍在且可用
- IM connector 修复必须保留家里 owner-gated secret write / redaction / hot reload 语义；恢复 source UX，不回退安全边界
- Signal 修复必须保留家里 stats/batch/timeline/tier filter，只补开源缺口

## Review Gate

- Phase A PR：必须由 maintainer 以 inbound PR 口径 review；先核 diff allowlist/denylist，再看 UI。
- Phase B/C PR：每个业务域单独 review；high-risk 文件默认 manual-port。
