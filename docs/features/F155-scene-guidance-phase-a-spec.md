---
feature_ids: [F155]
related_features: [F087, F110, F134, F099]
topics: [guidance, ux, mcp, frontend, security]
doc_kind: spec
created: 2026-03-27
---

# F155: Scene-Based Bidirectional Guidance Engine

> **Status**: Phase A accepted / frozen — 基础引导引擎已验收冻结，可开 PR 合入 | **Owner**: Ragdoll/Ragdoll | **Priority**: P1

## Why

Console 功能日益复杂，但入口简单，用户不知道从哪开始。复杂配置（如飞书对接）涉及跨系统操作，用户需要在多个平台间来回切换，容易迷失。

当前痛点：
- 用户不知道"添加新成员"需要先配认证
- 飞书/钉钉等外部系统的权限配置需要反复截图沟通
- 猫猫无法实时看到用户操作状态，只能靠用户描述和截图诊断问题

## What

### 核心架构（v2 — tag-based auto-advance engine）

```
data-guide-id tags → Flow YAML (guides/flows/) → Runtime API → Guide Engine (Frontend)
                                                                      ↕ Socket.io
                                                                  Cat (状态感知)
```

**设计原则**（CVO Phase A 反馈收敛）：
- 自动推进：用户与目标元素交互后引导自动前进，无手动 下一步/上一步/跳过
- HUD 极简：仅显示 tips + progress dots + "退出"
- 标签驱动：前端元素仅标注 `data-guide-id`，tips 来自 YAML flow 定义
- 运行时加载：flow 由 `GET /api/guide-flows/:guideId` 运行时获取，非构建时生成

### Phase A: Core Engine + 内部场景验证（✅ 已实现）

**OrchestrationStep schema**（前后端共享）：
```typescript
interface OrchestrationStep {
  id: string;
  target: string;       // data-guide-id value
  tips: string;         // 引导文案（来自 YAML）
  advance: 'click' | 'visible' | 'input' | 'confirm';
}
```

**元素标签系统**：页面关键控件加稳定 `data-guide-id`，命名空间式（如 `hub.trigger`、`cats.add-member`），语义而非位置。Target whitelist: `/^[a-zA-Z0-9._-]+$/`。

**Flow YAML**：`guides/flows/*.yaml` 编排场景流程，`guides/registry.yaml` 注册发现。

**Guide Engine（前端）**：
- 全屏遮罩 + 目标元素区域镂空（呼吸灯动效）+ 四面板 click shield（镂空区可穿透点击）
- rAF 循环跟踪目标元素位置（rect 比较优化）
- 自动推进：`useAutoAdvance` hook 监听 click/input/visible/confirm 事件
- `guide:confirm` CustomEvent 用于确认型步骤（如保存成功后触发）
- 终态守卫：`setPhase('complete')` 后不可被 rAF 覆写为 `locating`
- HUD：tips + progress dots + "退出"，位置自动计算避免遮挡
- Error boundary：Guide crash 不影响主应用

**完成回调（frontend → backend）**：
- 前端 `phase='complete'` 时自动调用 `POST /api/guide-actions/complete`
- 后端 `guideState: active → completed` + 发 `guide_complete` Socket.io 事件
- 猫猫收到事件即可感知用户已完成引导

**前端 API 端点**（userId-based auth）：
- `POST /api/guide-actions/start` — offered/awaiting_choice → active
- `POST /api/guide-actions/cancel` — → cancelled
- `POST /api/guide-actions/complete` — active → completed
- `GET /api/guide-flows/:guideId` — 运行时获取 flow 定义

**MCP 工具**（callback auth）：
- `resolve` — 根据用户意图匹配候选流程
- `start` — 启动引导 session
- `control` — next/skip/exit（不再支持 back）
- `update-guide-state` — offered / awaiting_choice / completed / cancelled 等非 start 状态更新

**CI 验证**：`scripts/gen-guide-catalog.mjs` 校验 v2 schema + target whitelist

**P0 验证场景**：添加新成员（4 步：open-hub → go-to-cats → click-add-member → edit-member-profile）

### Phase B: 场景扩展（F155 scope）

> **Scope 调整（KD-13 + KD-14）**：
> - Phase B 聚焦已有 Console / Hub / IM Hub 表面的引导场景扩展；只要目标控件已经存在于当前产品 UI 中，provider / connector flows 可以纳入 Guide Engine
> - 双向可观测（observe/verifier）已拆出为独立 feature 待立项，不再是 F155 的一部分
> - 需要新增独立配置页签、全新外部画布或 schema / inheritance 设计的跨系统流程，仍按后续 feature 单独推进

**场景扩展**：基于已有 Console 功能逐场景补充引导流程，复用 Phase A 骨架（data-guide-id + Flow YAML + advance mode + complete callback）。具体场景所需的额外步骤类型或信息补充，结合场景实际需求决定。

**CI 契约测试**：flow schema + tag 存在性 + 退出路径

**P0 验证场景**：基于已有 Console 功能的高价值场景（如 API Provider 配置、连接器配置等）

### 已拆出的独立方向

| 方向 | 归属 | 说明 |
|------|------|------|
| 自动观测 substrate | 独立 feature 待立项 | 不只服务 guide，可被 guide/debug/diagnostics 复用。含 observe.fields、idle 检测、verifier 契约、猫眼指示灯 |
| 新增外部配置页签 / 全新外部画布 | 按场景单独设计 | 仅当某流程无法复用当前 Hub / IM Hub UI、需要新增专门配置 surface 时，才不走 Guide Engine 遮罩引导 |

### 当前进展与阶段判断（2026-04-20）

| 维度 | 当前状态 | 说明 |
|------|---------|------|
| 核心引擎 | ✅ 完成 | tag-based runtime、YAML flow、前端遮罩/镂空、auto-advance、exit-only HUD 已跑通 |
| P0 内部场景 | ✅ 完成 | `add-member` 已收口为 4 步：`hub.trigger → cats.overview → cats.add-member → member-editor.profile(confirm)` |
| 完成态闭环 | ✅ 完成 | 前端 `complete` → 后端 `guideState=completed` → Socket 通知猫 → 一次性消费 ack |
| Esc 误退修复 | ✅ 完成 | KD-14：GuideOverlay preventDefault + CatCafeHub guideActive guard |
| CVO 验收 | ✅ 通过 | 2026-04-09 CVO 手动测试”添加成员”流程，确认链路通畅 |
| gpt52 review | ✅ 放行 | completion callback 6 轮 + 收尾 2 轮，全部 P1/P2 已修复 |
| Phase B 场景扩展 | 🚧 Review-ready | 当前 branch 已补齐 `add-account-auth`、`configure-first-provider`、`edit-member-auth`、`connect-wechat`、`connect-feishu` |
| 当前阶段判断 | **Phase A accepted / Phase B review-ready** | 基础引导引擎已冻结；当前 PR 聚焦场景扩展与交互 hardening 收口 |

**Phase A 交付物**：
- 前端引擎：`guideStore.ts` + `useGuideEngine.ts` + `GuideOverlay.tsx`（含 auto-advance）
- 后端 API：`guide-action-routes.ts`（start/cancel/complete）
- 路由感知：`route-serial.ts` + `route-parallel.ts`（completionAcked + guideCompletionOwner + catProducedOutput）
- Prompt 注入：`SystemPromptBuilder.ts`（completed handler）
- 测试：22 个 API 测试
- 文档：feature doc + guide-authoring skill + flow YAML + tag manifest

### 触发与发现规范

当前阶段只保留一条触发路径：
1. **对话意图触发**：用户在正常对话中表达配置/求助意图 → 猫先判断是直接解释还是适合走引导 → 调用 MCP `cat_cafe_get_available_guides()` 获取当前可用场景目录 → 基于场景描述建议引导 → [🐾 带我去做] 卡片 → 用户确认后启动

说明：
- 路由层不直接根据原始消息关键词或显式命令触发 guide
- 主动发现与目录浏览暂不作为当前设计的触发入口

### guide-authoring Skill

已创建 `cat-cafe-skills/guide-authoring/SKILL.md`，定义 6 步标准 SOP（v2）：
场景识别 → YAML 编排（v2 auto-advance） → 标签标注 → 注册发现 → CI 契约 → E2E 验证。

### 场景优先级（能力审计结果）

| 优先级 | 场景 | Console Tab | 复杂度 | 跨系统 |
|--------|------|------------|--------|--------|
| P0 | 添加成员 | cats → HubCatEditor | 极高 | 否 |
| P0 | 配置第一个 Provider | cats → HubAddMemberWizard → HubCatEditor | 高 | 否 |
| P1 | 添加账户认证 | settings → accounts | 高 | 否 |
| P1 | 修改成员认证与模型 | cats → HubCatEditor | 高 | 否 |
| P1 | 微信对接 | connector config | 高 | 是 |
| P1 | 飞书对接 | connector config | 高 | 是 |
| P1 | 开启推送通知 | notify | 中 | 否 |
| P2 | 管理猫猫能力 | capabilities | 中 | 否 |
| P2 | 治理看板配置 | governance | 中 | 否 |

### 触发与发现（详细设计）

**Guide Registry**（`guides/registry.yaml`）：注册所有可用引导，含 keywords + 意图映射。
**MCP Tool**：`cat_cafe_get_available_guides()` → 读取 registry + 当前上下文可用性 → 返回可用引导列表。
**Skill Manifest**：猫检测到配置意图（"怎么/如何/配置"）后，先判断是否需要交互引导；需要时调用 `cat_cafe_get_available_guides` 查看可用场景目录，再问用户"要我带你走一遍吗？"。
**Routing Boundary**：`GuideRoutingInterceptor` 仅负责续接已有 guideState（offered/awaiting_choice/active/completed），不从普通消息或显式命令直接创建新 guide offer。

## Acceptance Criteria

### Phase A（Core Engine）
- [x] AC-A1: 页面关键控件有稳定 `data-guide-id` 标签（覆盖"添加成员"流程 4 个元素）
- [x] AC-A2: Guide flow YAML 加载器 + CI schema 验证（v2 schema + target whitelist）
- [x] AC-A3: Guide Engine 前端组件：遮罩 + 高亮 + 自动推进（v2: 无手动导航，HUD 仅退出）
- [x] AC-A4: MCP resolve/start/control 工具 + 前端 action routes（start/cancel/complete）
- [x] AC-A5: "添加成员" 引导流程端到端可运行（含 confirm 步骤 + 保存成功回调）
- [x] AC-A6: 对话触发：猫建议引导 → InteractiveBlock → 用户确认 → 启动
- [x] AC-A7: 完成回调：前端 complete → 后端 guideState completed → Socket.io 通知猫猫

### Phase B（平台内场景扩展）
- [ ] AC-B1: 基于已有 Console 功能扩展 2+ 个引导场景（如 API Provider 配置、连接器配置）
- [ ] AC-B2: CI 契约测试通过（flow schema + tag + 退出路径）

### 已拆出（不再属于 F155 scope）
- ~~AC-B1(旧): observe 层~~ → 独立 feature "自动观测 substrate" 待立项
- ~~AC-B2(旧): MCP guide_observe~~ → 同上
- ~~AC-B4(旧): 猫眼观测指示灯~~ → 同上
- ~~AC-B5: 飞书外部平台完整 E2E~~ → 保持拆分；当前 F155 只覆盖 Hub / IM Hub 内已有 surface 的 guide flow，不覆盖外部平台联调自动化
- ~~AC-S1: Sensitive Data Containment~~ → 随独立 observe feature 走
- ~~AC-S2: Verifier Permission Boundary~~ → 随独立 observe feature 走

### 安全门禁（F155 scope 内保留）
- [ ] AC-S3: CI Contract Gate — flow schema 合法性 + tag 存在性 + 退出路径

## AC-S3 测试矩阵（F155 scope 内保留）

> AC-S1（Sensitive Data）和 AC-S2（Verifier Boundary）已随 observe substrate 拆出为独立 feature。
> 原始测试矩阵草案保留在 git 历史中（commit `a6588af` 之前），独立 feature 立项时可参考。

### AC-S3: CI Contract Gate

| Test ID | 层级 | 场景 | 期望结果 | 证据 |
|---|---|---|---|---|
| S3-CI1 | CI-Static | Flow schema 校验（step 字段 + advance 类型） | 非法 flow 阻塞合并 | CI 日志 |
| S3-CI2 | CI-Static | flow target 与 `data-guide-id` manifest 对照 | 缺失/重命名标签阻塞合并 | CI 日志 |
| S3-CI3 | CI-Static | flow 退出路径校验 | 无退出路径阻塞合并 | CI 日志 |
| S3-E2E-A1 | CI-E2E | P0 场景回归：添加成员（纯内部） | 主路径可完成，关键状态可回放 | E2E junit XML |

### 质量门禁映射

- PR Gate（必须）：S3-CI1~CI3
- Phase A Gate（必须）：S3-E2E-A1

## Dependencies

- **Related**: F087（猫猫训练营 — 类似的引导概念，但面向不同场景）
- **Related**: F110（训练营愿景引导增强 — 引导 UX 模式可复用）
- **Related**: F134（飞书群聊 — `connect-feishu` guide 的业务背景与后续联调上下游）
- **Related**: F099（Hub 导航可扩展 — Hub tab/深链基础设施）

## Risk

| 风险 | 缓解 |
|------|------|
| 元素标签被 UI 重构意外删除/重命名 | CI 契约测试（AC-S3）阻塞合并 |
| 跨系统流程用户中途放弃导致状态不一致 | sessionStorage 持久化 + 猫猫感知 idle 超时 |
| collect_input 敏感值泄露 | AC-S1 封存规则 + 服务端 TTL |
| 流程文档与页面演进脱节 | CI gate 每次构建校验 tag manifest |
| Guide Engine 性能影响正常操作 | 遮罩层 z-index 隔离 + 不影响非引导区域交互 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 选择"标签 + YAML 编排 + Guide Runtime"方案，否决硬编码和纯动态方案 | 可测、可审计、可版本化；新场景不改代码 | 2026-03-27 |
| KD-2 | 双向可观测：猫猫实时感知用户操作状态 | 免截图诊断；猫猫能主动介入卡点 | 2026-03-27 |
| KD-3 | sensitive 值刷新后不恢复，强制重填 | 安全优先于便利 | 2026-03-27 |
| KD-4 | 有副作用的 verification 按 verifier 配置 confirm: required/auto | sideEffect=true 必须二次确认，CI 校验规则 | 2026-03-27 |
| KD-5 | P0 skip_if 限声明式比较（eq/in/exists/gt/lt），禁止表达式 | 沙箱成本高，声明式可满足 P0 需求 | 2026-03-27 |
| KD-6 | observe.fields 对 sensitive 字段只上报 {filled, valid} | 防止侧信道泄漏长度/前缀 | 2026-03-27 |
| KD-7 | 迭代策略：核心引擎先完整 → P0(1内部+1外部)验收 → 再逐场景补全 | 不一次性实现所有场景；编排文件按需补充 | 2026-03-27 |
| KD-8 | external_instruction 支持富内容（多图 + 链接 + 前置条件 + 版本要求） | 胶囊 HUD 不够，外部步骤需要完整的操作指引卡片 | 2026-03-27 |
| KD-9 | v2 重构：自动推进取代手动导航，HUD 仅保留"退出" | CVO Phase A 反馈：手动导航降低体验，用户操作即推进 | 2026-03-30 |
| KD-10 | v2 步骤类型收敛为 4 种 advance mode（click/visible/input/confirm） | 简化 Phase A 范围，6 种步骤类型推迟到 Phase B 按需扩展 | 2026-03-30 |
| KD-11 | Flow YAML 运行时加载（API），不在构建时生成 TS | 解耦部署：改 flow 不需要重新构建前端 | 2026-03-30 |
| KD-12 | 完成回调作为基础能力：前端 complete → 后端状态 + Socket 通知 | CVO 明确要求：完整流程闭环是基础能力，不是后续补充 | 2026-04-03 |
| KD-13 | Phase B 继续复用 Guide Engine 覆盖已有 Hub / IM Hub UI 中的 provider / connector 场景；需要新增外部配置页签或 observe substrate 的能力另拆 | CVO：优先复用现有产品 surface 收口高频场景，把真正需要新 UI / 新联调形态的外部流程与观测基建拆出去 | 2026-04-06 |
| KD-14 | 禁用引导模式下全局 Esc 退出，仅保留显式退出按钮 | CVO 手测反馈：误触 Esc 导致引导意外退出，体验差 | 2026-04-09 |
| KD-15 | 双向可观测拆出为独立 feature，不再是 F155 Phase B | CVO + gpt52 共识：observe substrate 应更大——不只服务 guide，可被 debug/diagnostics 复用 | 2026-04-09 |

## Review Gate

- Phase A: Maine Coon(gpt52) 负责安全边界 + 可测性 review
- Phase B: Maine Coon(gpt52) 安全 review + Siamese(gemini25) 视觉 review
