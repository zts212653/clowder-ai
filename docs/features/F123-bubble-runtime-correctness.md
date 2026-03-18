---
feature_ids: [F123]
related_features: [F081, F097, F098, F117, F122]
topics: [bubble, message-identity, reconcile, hydration, state-machine, observability]
doc_kind: spec
created: 2026-03-14
---

# F123: Bubble Runtime Correctness（消息身份契约 + Reconcile 状态机）

> **Status**: done | **Owner**: Maine Coon/Maine Coon | **Priority**: P1 | **Completed**: 2026-03-16

## Why

team lead关于“气泡为什么又双影 / 又丢 / 又要 F5 才正常”的痛点，从第一天修到现在还在复发。`F081` 已经完成了第一阶段的连续性修复和写路径审计，但现状仍然是：

- 现场症状反复换壳：瞬时双影、replace hydration 后不一致、stream 中途停更、draft/hydration 身份断层
- 修复散落在多个 hotfix / bug report / follow-up commit 里，没有一个 active feature 在 owning 这条线
- 代码层的共同域已经很明确：不是单一 UI 症状，而是 `messages` 多入口写入、身份契约不统一、reconcile / hydration 状态机缺少系统性防线

这说明我们现在需要的不是“再修一个 bubble bug”，而是一个从 `F081` 演进而来的第二阶段 feature：把 bubble 的身份模型、写入规则、恢复语义和可观测性真正收口。

最新现场症状也说明了这点：**切线程时气泡仍可能先裂成两个，随后在 F5 后重新合成一个**。这不是一个值得用“偷偷刷新”去掩盖的 UI 小毛病，而是同一条 bubble 在 thread switch / hydration / reconcile 之间没有满足单调可见性的表现，属于 F123 的核心攻击面。

## What

### Phase A: Truth Model & Replay Harness

先定义 message / bubble 的真相模型，再动热路径代码。

- 明确 assistant bubble 的稳定身份字段和升级规则：`messageId`、`invocationId`、`origin`、`provenance`、`isStreaming`
- 明确允许的状态迁移：创建、追加、替换、完成、hydrate 恢复、draft merge、history replace
- 建 replay / golden harness，把历史现场症状变成可重复的事件回放，不再靠截图抓鬼
- 第一批 fixture 先覆盖两条主路径：
  - active path：`invocation_created` 晚于第一条 text/tool → bubble 缺 identity → hydration 双影
  - background path：active→background 后 ref 丢失 → 后续 chunk 写空 → stream 中途停更

### Phase B: Writer Convergence & Identity Hardening

把 active/background/callback/history/draft/queue 这些写路径收敛到同一套身份与 reconcile 规则。

- 减少“每条路径各写各的 `messages`”导致的局部语义漂移
- 统一 placeholder → formal message 的升级规则，避免匿名 bubble 或影子 bubble
- 同一 `(catId, invocationId)` 下，语义重叠的 callback text 应替换 stream text，而不是长期并存成两条 bubble
- Phase B 先走 shared reconcile helper + invariant，不先上统一 `MessageWriter`
- 为 dev/test 提供 invariant 检查，阻止“同一身份的两条 assistant bubble”进入 store

### Phase C: Monotonic Recovery & Observability Closure

把 F5 / thread switch / replace hydration / draft recovery 统一成“单调可见”的恢复语义。

- 恢复只能补齐或替换为“同一身份的更强版本”，不能再凭空制造第二个影子 bubble
- 先完成 `window.__catCafeDebug.dumpBubbleTimeline()` 级别的 dump，让现场问题可导出、可回放、可定位
- 用 replay tests 封住我们已经踩过的整组历史 case

## Acceptance Criteria

### Phase A（Truth Model & Replay Harness）
- [x] AC-A1: 产出一份 code-backed bubble state model，逐条映射当前真实写入入口与字段职责
- [x] AC-A2: replay harness 的首批 fixture 至少覆盖 active late-bind 双影 + background ref-lost 停更 两条主路径
- [x] AC-A3: 每个进入 F123 的现场症状都能映射到某个 fixture，而不是只保留口头描述

### Phase B（Writer Convergence & Identity Hardening）
- [~] AC-B1: active / background / history / draft / queue 的 assistant bubble 创建路径统一遵守同一身份 contract → 转 `TD111`
- [~] AC-B2: 同一 `catId + invocationId + bubble kind` 不会在 store 中稳定存在两条 text bubble → 转 `TD112`
- [~] AC-B3: placeholder 升级为正式消息时遵守单调规则，不会因 id swap / hydration / late bind 产生影子 bubble → 转 `TD113`
- [x] AC-B4: 同一 invocation 下，语义重叠的 callback text 到达时会替换对应 stream text，而不是新增第二条 bubble
- [~] AC-B5: dev/test 模式下提供 invariant 断言或诊断日志，能直接指出 duplicate 是在哪个入口创建的 → 转 `TD114`

### Phase C（Monotonic Recovery & Observability Closure）
- [x] AC-C1: F5、thread switch、replace hydration、draft recovery 后，用户看到的同一条消息满足单调可见性
- [x] AC-C2: 针对已知历史症状的 replay/golden tests 全绿：瞬时双影、stream 停更、draft/hydration 身份断层、rich block 落错 bubble、queue/hydration 乱序
- [x] AC-C3: 提供 bubble provenance / timeline dump 的最小可用调试能力，能导出一次 invocation 的关键 lifecycle
- [x] AC-C4: F123 完成时，剩余未解问题必须明确分流为 provider/runtime 问题或 follow-up feature，不能再以“散装 bug”留在空气里

## Current State Snapshot（2026-03-16）

当前代码已经 merge 的是 8 个切片，不是整条 F123 的完成态：

| PR | Merge Commit | 实际落地 | 对齐 AC |
|----|--------------|----------|---------|
| #460 | `1862e4f1` | active/background 首批 fixture、callback 替换 stream、late-stream suppression、`dumpBubbleTimeline()` | AC-A2, AC-B4, AC-C3 |
| #464 | `74e4663e` | hydration reconcile 中 `callback > stream` 的 phase priority | 部分推进 AC-C1（未完成） |
| #465 | `5c3f9ac4` | 保持 late-stream suppression 到观察到不同 `invocationId` 为止，封住 #464 merge 后的 ghost bubble 回归 | 部分推进 AC-C1（未完成） |
| #493 | `b7123839` | `bubbleIdentity.ts` truth-model helper、thread switch 遇到 unstable cache 时强制 replace hydration、callback↔callback authoritative ordering、R7 现场 replay | 部分推进 AC-A1, AC-C1, AC-C2（均未完成） |
| #494 | `aba1e8c2` | truth-model descriptor、bubble state model 资产、symptom-fixture matrix | AC-A1，部分推进 AC-A3 |
| #495 | `5864fcc5` | queue/hydration 乱序 replay、`fetchQueue()` secondary hydration 改为 thread-scoped status write、symptom-fixture matrix 将 queue/hydration 从 partial 提升到 covered | 部分推进 AC-A3, AC-C2（均未完成） |
| #496 | `9a7f9140` | 真实 draft payload replay、draft/hydration 身份断层从 gap 提升到 covered、旧世界 fixture 与现网 draft contract 对齐 | 部分推进 AC-A3, AC-C2（均未完成） |
| #506 | `70082cb7` | CLI Output / rich-block-only 首事件的 invocationless stream 占位在 callback text 到达时直接升级为 formal bubble，不再额外生成第二个 assistant 气泡 | 对 F123 已关闭症状的窄口热修；`rich block 落错 bubble` / CLI Output duplicate 现场继续保持 covered |

因此，F123 最终收口后的状态是：

- **team lead最关心的可见性症状已经压住**：同 invocation 双影、F5 后归一、thread switch 裂两条再合一，这一组现象都已有 hook replay + Alpha 手测双证据
- **bubble truth model / symptom-fixture 真相源已经落盘**，后续不需要再靠口头回忆现场
- **queue/hydration 乱序、draft/hydration 身份断层都已从 partial/gap 收到 covered**
- **CLI Output duplicate bubble 现场已被窄口热修压住**：无 `invocationId` 的 rich-block 占位在 callback text 到达时会被就地升级，不再裂成两条 assistant 气泡
- **Phase B 的防御层没有假装完成**：统一 identity contract、store invariant、placeholder 单调升级、duplicate 断言这 4 条明确转入 `TD111`-`TD114`

换句话说：F123 作为“把 bubble 可见性症状系统性压住”的 feature 已经完成；剩下的是防御性工程化强化，明确归到技术债，不继续伪装成未完成 feature。

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “这个问题从第一天开始就修到现在” | AC-A1, AC-A3 | discussion + spec review | [x] |
| R2 | “F5 前后不能一会两条一会一条” | AC-B2, AC-C1 | replay test + manual | [x] |
| R3 | “不要乱编和瞎猜，一定要看代码” | AC-A1, AC-A2 | code-backed audit + replay fixtures | [x] |
| R4 | “要有一个独立 feature owning 这条线” | AC-C4 | backlog + feature doc | [x] |
| R5 | “不要再靠补丁式修法反复打同类问题” | AC-B1, AC-B3, AC-C2 | code review + replay suite | [~] |
| R6 | “同一 invocation 里正式发言和思考过程不要再双影并存” | AC-B4, AC-C1 | replay test + manual | [x] |
| R7 | “切线程时不能先裂成两个，F5 后又合一” | AC-C1, AC-C2 | replay test + Alpha manual | [x] |

### 覆盖检查
- [ ] 每个需求点都能映射到至少一个 AC
- [ ] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（若适用）

## Dependencies

- **Evolved from**: F081（第一阶段已完成连续性热修和写路径审计；F123 接手第二阶段的系统性收口）
- **Related**: F097（CLI Output bubble 结构）
- **Related**: F098（callback message UX / bubble 边界）
- **Related**: F117（message delivery lifecycle）
- **Related**: F122（dispatch / queue 路径继续增加 message 写入入口）

## Risk

| 风险 | 缓解 |
|------|------|
| 热路径重构影响现有聊天体验 | 先建 replay fixtures 与 invariant，再分层替换入口 |
| 过度去重，把本来应独立存在的消息误并掉 | 先定义 bubble kind / identity contract，再落 dedup 规则 |
| scope 扩散到 provider/runtime 一切问题 | 只处理 bubble identity / writer / recovery；provider hang 单独分流 |
| 又变成“修一堆 case 的大杂烩” | 每一刀都必须挂到 Truth Model / Writer / Recovery 三层之一 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不 reopen F081，单开 F123 follow-up | F081 已 done，且这轮需要 active owner 与新 scope | 2026-03-14 |
| KD-2 | 所有修复必须以代码证据和 replay fixture 为前提 | 避免再次落回“按症状猜修” | 2026-03-14 |
| KD-3 | 先收敛状态机与写路径，再做单点 bug fix | 同类问题已证明单点补丁无法封口 | 2026-03-14 |
| KD-4 | Phase B 先走 shared reconcile helper + invariant，不把统一 MessageWriter 设成前置 | 先定规则再造工具，避免热路径一次性大改 | 2026-03-14 |
| KD-5 | provenance 先落 `dumpBubbleTimeline()` 级别的 debug dump，不做 UI 入口 | 这是调试工具，不是产品功能 | 2026-03-14 |
| KD-6 | 同一 invocation 下，语义重叠的 callback text 取代 stream text，不长期并存 | “正式发言”应赢过“思考过程”，并阻断双影 | 2026-03-14 |

## Review Gate

- Phase A: 设计评审必须带代码入口清单，不接受纯症状描述
- Phase B: 变更必须附 replay / invariant 测试，覆盖 active + background 两条主路径
- Phase C: 必须提交一次可导出的 timeline / provenance 证据样例
