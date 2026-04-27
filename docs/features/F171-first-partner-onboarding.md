---
feature_ids: [F171]
related_features: [F059, F087, F110, F127, F155]
topics: [onboarding, open-source, cold-start, partner-setup, account-config]
doc_kind: spec
created: 2026-04-22
community_pr: ["clowder-ai#520"]
---

# F171: First Partner Onboarding — 领养第一只猫 / 配置第一位伙伴

> **Status**: done | **Owner**: Maine Coon/gpt52 | **Priority**: P1 | **Completed**: 2026-04-25

## Why

我们家当前对开源小白不够友好。现有默认心智是“家里已经有猫、你知道每只猫是谁、也知道该先配什么账号”，但真实新用户往往并不具备这些背景知识。

team lead判断（2026-04-21）：
> “我们家现在对于开源小白不太友好所以才想接受他的产品语意。”
> “不是每个人都是你的landy这么了解你们每只猫 每只猫猫的agent 且还是正版订阅用户。”

因此需要把冷启动产品语意从“开始猫猫训练营”收敛成更基础、更普适的：

1. 不假设用户已经理解所有猫猫和账号体系
2. 第一次进入时，先帮助用户**领养/配置第一只猫**
3. 先获得**第一次成功协作**
4. 再逐步引导到更多猫、更多 guide、更多高级能力

这不是 F110 那种“训练营中后段的愿景采访增强”，而是 open-source 冷启动产品语意重写。

## What

### Phase A: 产品语意重写（去训练营化）

- 把对外 framing 从“新手训练营”改成“领养第一只猫 / 配置第一位伙伴”
- 首次进入默认目标不是“走完整 training flow”，而是“完成第一只猫配置并成功发出第一条有效消息”
- 对外文案弱化 bootcamp/task/gamification，保留陪伴感、成功感和最小引导
- F087 里“训练营”的完整生命周期仍保留为可选进阶体验，不再作为冷启动默认叙事

### Phase B: 冷启动流程定义

- 冷启动判定：用户首次进入且当前没有活跃成员时，触发 first-partner onboarding
- 主流程收敛为：
  1. 选模板 / 理解猫的角色
  2. 配账号与模型
  3. 验证连通性
  4. 创建第一只猫
  5. 进入可工作的对话态
- “先成功一次”优先于“先理解全局体系”

### Phase C: 与现有能力边界对齐

- **F127** 承接账号体系与运行时建猫：账户配置、猫实例创建、绑定模型/accountRef
- **F155** 承接必要的场景式引导：仅保留对冷启动最关键的 overlay/guide，不把完整 bootcamp 机制硬塞进首屏
- **F110** 保持为训练营中后段能力：愿景采访、隐藏需求发现、SOP 显式加载
- **F087** 退居为“进阶引导/完整体验”来源，不再承担默认冷启动入口

### Phase D: 吸收社区方向（Selective Intake）

- 参考 `clowder-ai#520` 的产品方向，但不照搬其 feature 编号与 bootcamp 命名
- 可吸收：
  - `0 active members` 的冷启动契约
  - 首只猫配置优先于复杂协作概念
  - 账号配置与第一只猫创建的一体化入口
- 不直接照搬：
  - “新手训练营”命名
  - 完整 bootcamp storyline
  - 与家里既有 guide / runtime 语义冲突的部分

### Phase E: 回家吸收与 follow-up

- `clowder-ai#520` 已合入开源仓，cat-cafe 侧通过 intake PR `cat-cafe#1395` 吸收可复用实现
- 吸收范围以 “First Partner Onboarding” 产品语意为准：保留 F171 的领养第一只猫 / 配置第一位伙伴 framing
- 现有项目迁移、完整 E2E、README/SETUP 公开文档更新仍作为后续闭环，不作为本次 intake 的完成条件

## Acceptance Criteria

### Phase A（产品语意重写）
- [x] AC-A1: 冷启动默认文案不再要求用户先理解“训练营”概念，而是明确指向“配置第一位伙伴”
- [x] AC-A2: 首次进入的主 CTA 与空状态文案能让开源新用户理解下一步是“领养第一只猫”

### Phase B（冷启动流程）
- [x] AC-B1: 首次进入且无活跃成员时，用户可在一个连续流程中完成模板选择、账号配置、连通性验证、创建第一只猫
- [x] AC-B2: 完成第一只猫创建后，用户可立即进入可工作的对话态
- [x] AC-B3: 首次成功协作前，不要求用户先理解多猫协作全貌

### Phase C（边界对齐）
- [x] AC-C1: F171 的产品语意与 F127 / F155 / F110 的职责边界在 feature docs 中明确写清
- [x] AC-C2: 不再把 cold-start onboarding 错挂到 F110 或复写到已完成的 F087

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “我们家现在对于开源小白不太友好” | AC-A1, AC-B1 | 文案 review + 手动走查 | [x] |
| R2 | “不是每个人都这么了解每只猫、每只猫猫的 agent” | AC-A2, AC-B3 | 产品流程 review | [x] |
| R3 | “我支持吸收他的产品语意，但改写成领养第一只猫 / 配置第一位伙伴” | AC-A1, AC-C2 | feature spec review | [x] |
| R4 | “给他一个新的 feat 号，我们家这走 feat 立项流程” | AC-C2 | feature index / BACKLOG / 社区 comment | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（若适用）

## Dependencies

- **Evolved from**: F087（CVO Bootcamp — 原先承担 open-source onboarding 的完整训练营体验）
- **Related**: F110（训练营愿景引导增强 — 处理中后段引导，不是冷启动主语）
- **Related**: F127（猫猫管理重构 — 账户配置与运行时建猫的技术底座）
- **Related**: F155（Scene-Based Guidance Engine — 必要引导能力的承载层）
- **Related**: F059（开源计划 — open-source newbie onboarding 需求来源）

## Risk

| 风险 | 缓解 |
|------|------|
| 把“训练营”整套拿掉后失去家里的陪伴感 | 保留猫猫人格与陪伴文案，但把主目标聚焦到“成功配置第一位伙伴” |
| 与 F127/F155/F110 边界再度重叠 | 在本 spec 中显式写清各 feature 负责什么、不负责什么 |
| 吸收社区方向时把 upstream feature 编号污染回家里 | 新开 F171，不复用 upstream 的 F140 命名 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新开 F171，不复用 F140/F110/F087 | 这是独立的 cold-start 产品语意，不是 F110 的访谈增强，也不该污染我们家的 F140 | 2026-04-22 |
| KD-2 | 产品 framing 从“训练营”收敛到“第一位伙伴 onboarding” | 对开源小白更友好，更符合首次进入的认知负担 | 2026-04-22 |
| KD-3 | 技术上复用 F127/F155，产品上从 F087 演化 | 保持产品语意与技术底座解耦 | 2026-04-22 |

## Review Gate

- Phase A: ✅ team lead确认冷启动产品语意（“领养第一只猫 / 第一位伙伴”）
- Phase B: ✅ Maine Coon + Ragdoll确认与 F127/F155/F110 的边界
- Completion: ✅ GPT-5.4 守护审计确认 `merge + intake` 全流程闭环，无 brand 污染、无明显漏吸、定向回归通过
