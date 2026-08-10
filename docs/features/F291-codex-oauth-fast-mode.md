---
feature_ids: [F291]
related_features: [F016, F127, F254, F262]
topics: [codex, oauth, fast-mode, service-tier, thread-settings, hub]
doc_kind: spec
created: 2026-08-08
description: "让 Codex OAuth 猫拥有成员默认与对话级独立速度档位，同时明确区分请求档位、思考深度和 API Priority 计费语义。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-09T05:11:52Z
---

# F291: Codex OAuth Fast Mode — 成员默认与对话级速度档位

> **Status**: done | **Completed**: 2026-08-09 | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

> **operator UX signoff**: 2026-08-08 — “只有接了oauth的codex 才能看到这个配置项”；随后授权实现并指定 Terra review。

## Why

operator需要在 Clowder AI 内明确控制 Codex OAuth 猫的 Standard / Fast 请求档位：Sol 可以默认 Fast、Terra 保持 Standard，同一只猫也能在某个 thread 单独覆盖，而不用反复修改共享 Codex App 配置并猜测哪一轮是否继承成功。该能力必须把速度、思考深度与 API Key Priority 三种不同语义分开，避免误导性开关和不可见的 credits 消耗。

operator experience（2026-08-08）：

> “这个能单独比如说sol 开 然后ter不开，甚至某个thread的你开吗？类似图2思考档位”

> “v1 先做 Codex OAuth 的 Standard / Fast……只有接了oauth的codex 才能看到这个配置项！”

## Current State / 现状基线

1. Clowder AI 当前不建模 service tier；仓内 `serviceTier / service_tier` 没有 runtime 实现。`CliConfig` 只有 effort、context window 与 Codex carrier（`packages/shared/src/types/cat-breed.ts:34-54`）。
2. 成员编辑器只有结构化 `CLI Effort` 和原始“额外 CLI 参数”（`packages/web/src/components/hub-cat-editor-advanced.tsx:107-136`）。原始参数能偶然覆盖全局配置，但没有 OAuth/模型校验、thread 覆盖或用户可见的生效来源。
3. app-server bridge 的 `ThreadParamsInput` 尚未传 `serviceTier`（`packages/api/src/domains/cats/services/agents/providers/codex-app-server-client-helpers.ts:5-26`），因此 Clowder AI invocation 只能跟随 Codex 用户配置。
4. F262 已提供可复用的 `(threadId, catId)` 持久覆盖、collection GET/PATCH、每轮重新解析和参与猫优先 UI，但它只承载 reasoning effort；速度档位不能混入思考档位。
5. 当前 Codex 0.146.0 app-server schema 接受 `thread/start` / `thread/resume` 的 `serviceTier?: string | null`：省略表示继承用户配置，`null` 表示显式 Standard，Fast 请求值由 Codex 归一化为其 provider service tier。

## Design Contract / 设计契约

### 1. 两层配置与一条解析链

```text
thread × cat speed override > member cli.serviceTier > Codex user config
```

- 用户语义只暴露 `inherit | standard | fast`；`inherit` 用“不持久化 override / 不发送字段”表达。
- `standard` 必须显式覆盖全局 Fast：app-server 发送 `serviceTier: null`；exec carrier 发送 `service_tier="default"`。
- `fast` 由 adapter 映射到 Codex 原生请求值，不能让 UI/Store 持久化 `priority` 等 provider wire 名称。
- 每次 invocation（含 resume）按实际路由出的 `catId` 重新解析，下一次回复生效，不修改 preferred-cat 或 session-chain 语义。

### 2. 可见性与兼容性

- 成员 surface 仅当 `clientId = openai` 且后端解析出的 effective account `authType = oauth` 时显示；前端 profile 仅用于即时预览，后端是最终真相源。
- Thread surface 只列出 effective OAuth Codex 猫；API Key、其他 client、cloud-only/ACP transport 不出现，避免把 API Priority 误叫 Fast。
- v1 通过一个共享 model helper 支持当前 Codex Fast model family；模型不支持或无法判定时保留 OAuth 成员设置入口，但禁用 Fast 并说明原因。
- 从 OAuth 切到同一 Codex client 的 API Key 后，已有成员/对话 raw intent 作为 dormant state 保留但不生效；切回 OAuth 后重新按当前模型判定兼容性。

### 3. 持久化与 API

- 成员默认值存入 `cli.serviceTier?: 'standard' | 'fast'`；缺失表示跟随 Codex 用户配置。
- Thread raw override 按 `(threadId, catId)` 持久化，TTL=0；`null` PATCH 清除 override，soft-delete/restore 保留，hard-delete 随 thread detail 删除。
- 独立 API：
  - `GET /api/threads/:id/members/speed`
  - `PATCH /api/threads/:id/members/:catId/speed`
- GET row 返回 `catId / displayName / options / override / inherited / requested / source / compatibility / isParticipant`。`requested` 只表示本轮将向 Codex 请求的档位，不冒充上游实际 serviced tier。
- Route 校验 owner/thread access、shared-default-thread 隔离、effective account authType、client/carrier/model capability 与输入枚举。

### 4. Runtime 与现场可见性

- invocation 通过 typed `AgentServiceOptions` 传递 speed override；禁止塞入 `callbackEnv` 或 raw `cliConfigArgs`。
- app-server start/resume 都携带显式 override；exec-json 使用等价 `--config` 覆盖。两条 carrier 必须有 argv/params 测试。
- 读取 thread override 失败时降级到成员默认并输出一次 `system_info`；不静默声称 thread 设置生效。
- UI 显示“请求 Fast / 请求 Standard / 跟随 Codex 默认”及来源；上游可能降级时不显示“实际已用 Fast”。

## What

### Architecture Ownership

Architecture cell: identity-session

Map delta: update required

Why: F291 扩展既有成员 runtime config 与 thread-scoped cat config 链，在 actual-cat routing 后解析并投影到 Codex carrier；不改变 routing 或 thread-navigation 归属。

### Phase A: Typed Contract, Persistence, API and Provider Wiring — ✅ PR #3496

1. 增加共享 speed type、成员 `cli.serviceTier` schema/payload 与 OAuth/model capability resolver。
2. 按 F262 形状增加 ThreadStore / Redis / Memory 持久化和 guarded GET/PATCH route。
3. 每轮解析 `thread > member > Codex config`，接入 Codex exec-json 与 app-server start/resume。
4. 更新 `identity-session` ownership cell 的 canonical anchors。

### Phase B: Member and Thread Speed Surfaces — ✅ Alpha + operator UAT passed

1. 成员高级运行时参数中，紧邻 `CLI Effort` 增加独立“速度档位”，只对 effective Codex OAuth 可见。
2. Thread `⋮` 菜单在“思考档位”之后增加平级“速度档位”，复用 participant-first/search/popover 交互。
3. 覆盖 inherit / Standard / Fast、dormant、unsupported model、保存失败回滚与窄屏状态。
4. 增加一条指向真实入口的 F244 capability tip。

## User Journey

### Primary Journey: 为成员设置默认速度，再为单个对话覆盖

- **Scope unit**: member default + thread × cat
- **Actor**: operator
- **Entry**: Hub 成员配置，或 ThreadSidebar 目标对话的 `⋮`
- **Flow**:
  1. operator编辑绑定 Codex OAuth 的 Sol → 看到独立“速度档位”，选择 Fast；编辑 API Key/非 Codex 成员时该项不出现。
  2. Terra 保持 Standard，因此不同成员可有不同默认速度。
  3. operator打开某个 thread 的 `⋮ → 速度档位` → 面板只列符合条件的 Codex OAuth 猫，并显示 `继承（成员 Fast）` 等来源。
  4. 将本 thread 的 Sol 改为 Standard → 保存成功并提示“从下一次回复生效”；其他 thread 继续继承 Sol 的 Fast。
  5. 清除 override → 本 thread 恢复成员默认；成员也选择继承时，不传 service tier，继续跟随 Codex 用户配置。
- **Success evidence**: targeted API/provider/component tests + Alpha 三张截图（成员 OAuth 可见性、thread 多猫档位、非 OAuth 隐藏）+ 15 秒切换录屏。
- **Non-goals**: 不改变 reasoning effort；不支持 API Key Priority/Flex；不改写 `~/.codex/config.toml`；不承诺 upstream 实际 serviced tier；不为所有 Provider 建通用速度抽象。

## UI Wireframe（operator 已确认语义）

```text
成员配置 / 高级运行时参数
┌──────────────────────────────┐
│ CLI Effort       xhigh       │
│ 速度档位          Fast ▾      │  ← 仅 effective Codex OAuth
│                  Standard     │
│                  跟随 Codex   │
└──────────────────────────────┘

Thread ⋮
┌──────────────────┐
│ 设置默认猫猫      │
│ 思考档位          │
│ 速度档位          │  ← 独立平级入口
│ 重命名对话        │
└──────────────────┘

这个对话的速度档位
┌─────────────────────────────────┐
│ 🐱 Sol    继承（成员 Fast）  ▾  │
│ 🐱 Terra  Standard           ▾  │
│ 仅影响本对话；下次回复生效       │
└─────────────────────────────────┘
```

## Acceptance Criteria

### Phase A（Typed Contract, Persistence, API and Provider Wiring）

- [x] AC-A1: Shared resolver 对 `inherit / standard / fast`、OAuth/client/model compatibility 与 `thread > member > Codex config` 优先级有表驱动测试；wire 名称不泄漏到持久化/UI。
- [x] AC-A2: Cat create/update schema、catalog round-trip 与 Hub payload 能持久化/清除 `cli.serviceTier`，后端拒绝非 Codex OAuth 的显式值；切到 API Key 时 intent dormant 而非误生效。
- [x] AC-A3: Memory/Redis ThreadStore 能按 `(threadId, catId)` 写、批读、单读和清除 speed override，TTL=0，并覆盖 ghost/shared-default/soft-delete/hard-delete 隔离。
- [x] AC-A4: GET/PATCH route 返回 requested/source/compatibility，覆盖 auth/access/invalid enum/non-OAuth/unsupported model；collection 不做逐猫 store N+1。
- [x] AC-A5: invocation 每轮按实际 catId 读取 override；读取失败降级到成员默认并产生一次可见诊断。
- [x] AC-A6: Codex exec-json 参数测试证明 Standard 覆盖全局 Fast、Fast 显式请求、inherit 不传；app-server start/resume params 有同等三态证据。
- [x] AC-A7: ownership map 纳入 speed store/API/invocation/provider anchors，架构归属仍为 `identity-session`。

### Phase B（Member and Thread Speed Surfaces）

- [x] AC-B1: 成员编辑器仅对 effective Codex OAuth 显示速度档位；API Key/其他 client/ACP/cloud-only 不显示，Fast 不兼容时禁用并解释。
- [x] AC-B2: Thread `⋮` 的“速度档位”与“思考档位”平级且紧邻；菜单顺序与键盘可访问性有组件测试。
- [x] AC-B3: 面板 participant-first，且只列 OAuth Codex 猫；每行显示 inherit/member/thread 来源、请求档位、unsupported/dormant 状态。
- [x] AC-B4: 保存成功、失败回滚、清除继承、下一轮生效与窄屏 viewport 行为有组件测试，文案不把 requested tier 说成实际 serviced tier。
- [x] AC-B5: Alpha 功能旅程已验证 OAuth-only 列表、Fast/Standard 显式覆盖、清除后继承与非 OAuth fail-closed；三张归档截图与约 15 秒录屏未生成，由 operator 在现场前端 UAT 后签字降级（proposal `0001786251707776-000847-488ca63e`；signoff `0001786272749140-000009-6dd96346`），不冒充视觉素材已归档。
- [x] AC-B6: F244 tip 指向 `成员配置 / thread ⋮ → 速度档位` 的真实入口，不伪造不存在的 action。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “Sol 开、Terra 不开”——成员可以独立选择默认速度 | AC-A2, AC-A6, AC-B1 | catalog/provider/component tests + operator UAT | [x] |
| R2 | “甚至某个 thread 的你开”——支持 thread × cat 覆盖 | AC-A3, AC-A4, AC-A5, AC-B3 | store/API/invocation tests + Alpha lifecycle + operator UAT | [x] |
| R3 | “类似思考档位”但速度与思考深度独立 | AC-A1, AC-B2 | resolver/menu-order tests | [x] |
| R4 | “只有接了 OAuth 的 Codex 才能看到” | AC-A2, AC-A4, AC-B1, AC-B3 | auth matrix tests + Alpha projection + operator UAT | [x] |
| R5 | Terra 独立 review | Review Gate | exact-SHA review verdict | [x] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC。
- [x] 每个 AC 都有自动化测试、截图或录屏验证方式。
- [x] 前端需求已定义需求→证据映射表。

## Tips Contribution（F244）

- 新增 1 条可投放 tip，说明 Codex OAuth 猫可在成员配置设默认速度，并在 thread `⋮ → 速度档位` 单独覆盖。
- sourceRef 指向本 spec `## User Journey`；仅复用现有 tip context/action，若没有真实可达 action 则使用纯提示，不扩协议。

## Dependencies

- **Evolved from**: F262（复用 thread × cat 覆盖与 UI 状态机）
- **Blocked by**: 无
- **Related**: F016（Codex OAuth）、F127（成员配置）、F254（app-server carrier）

## Risk

| 风险 | 缓解 |
|------|------|
| 把 API Key Priority 误标成 OAuth Fast | effective account authType 后端硬校验，非 OAuth 不出 surface |
| `inherit` 与显式 Standard 混淆 | app-server omit vs null、exec absent vs default 的三态测试 |
| upstream 请求 Fast 后实际降级 | UI 只称 requested tier；实际 serviced tier 不在 v1 承诺内 |
| 模型不支持或未来模型变化 | 单一共享 capability helper + incompatible fail-closed + 保留 raw intent |
| thread 覆盖读取失败却静默失效 | 一次性 system_info + warning，降级到成员默认 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 独立“速度档位”，不并入“思考档位” | 推理投入与服务速度/credits 是正交轴 | 2026-08-08 |
| KD-2 | v1 仅 Codex OAuth Standard/Fast | API Key Priority/Flex 计费与语义不同 | 2026-08-08 |
| KD-3 | member default + thread × cat override | 同时覆盖 Sol/Terra 差异和单 thread 临时需求 | 2026-08-08 |
| KD-4 | persisted semantic values，provider adapter 做 wire mapping | 避免把 `priority` 等外部实现细节变成产品契约 | 2026-08-08 |
| KD-5 | 只展示 requested tier，不宣称实际 serviced tier | 上游可能降级，不能用配置状态冒充运行事实 | 2026-08-08 |

## Review Gate

- 实现作者：小太阳·Maine Coon (@codex-sol)
- 独立 reviewer：Terra (@codex-terra)，APPROVE reviewed head `92af3e001`；C1–C3 continuity 桥接至合入 head `2d9e3baf6`。
