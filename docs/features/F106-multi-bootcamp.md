---
feature_ids: [F106]
related_features: [F087, F096]
topics: [onboarding, bootcamp, ux]
doc_kind: spec
created: 2026-03-12
---

# F106: 多训练营支持 + 训练营列表页

> **Status**: done | **Owner**: Ragdoll | **Priority**: P2 | **Completed**: 2026-03-12
> **Evolved from**: F087（operator Bootcamp — 当前只支持单训练营）

## Why

operator体验训练营后发现候选任务很多都很好玩，想同时开多个训练营。当前限制：前端 CTA 用 `find(t => t.bootcampState)` 找到第一个就只显示"继续"，不让开新的。后端无限制。

### operator experience（2026-03-12）

> "我们能开多个训练营吗？好像很多都很好玩。我们的训练营好像现在只开一个？"
> "我希望训练营列表页，展示每个训练营的 phase 进度，然后点击训练营应该不是新建新的而是选择新的还是去哪个老的。"

## What

### 核心改动

1. **训练营列表页（新 UI）**：点击训练营入口 → 不是直接创建新 thread，而是进入一个列表页/面板
   - 展示用户所有训练营 thread：标题、当前 Phase 进度、选择的任务、创建时间
   - 每个训练营可点击跳转到对应 thread
   - 底部"开始新训练营"按钮

2. **前端 CTA 逻辑调整**：
   - 有训练营 → "我的训练营(N)" → 打开列表 modal
   - 无训练营 → "开始猫猫训练营" → 打开列表 modal（空态 + 创建按钮）

3. **Phase 进度可视化**：列表中每个训练营显示当前 phase（如 Phase 5/11）

### 不需要改的

- 后端：`POST /api/threads` + `bootcampState` 已支持多个
- 状态机：per-thread，天然支持
- `GET /api/bootcamp/thread`：改为返回数组（或新增 `/api/bootcamp/threads`）

## Acceptance Criteria

- [x] AC-A1: 用户可以创建多个训练营 thread（前端不再阻止）
- [x] AC-A2: 训练营列表页展示所有训练营的 phase 进度
- [x] AC-A3: 点击列表中的训练营跳转到对应 thread
- [x] AC-A4: 列表底部有"开始新训练营"入口
- [x] AC-A5: 空消息态 CTA 适配：有训练营→"我的训练营(N)"打开列表 modal，无训练营→"开始猫猫训练营"打开列表 modal（显示空态+创建按钮）

## Dependencies

- **Evolved from**: F087（operator Bootcamp — 单训练营基座）
- **Related**: F096（Interactive Rich Blocks）

## Risk

| 风险 | 缓解 |
|------|------|
| 训练营太多导致列表拥挤 | 按时间排序，完成的训练营灰显/折叠 |
| 多个进行中训练营让新手困惑 | 高亮最近活跃的那个 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 点击入口进列表页而非直接创建新训练营 | operator明确要求"选择新的还是去哪个老的" | 2026-03-12 |

## Review Gate

- codex: 3 轮本地 review 放行（P1 data source + P2 spec sync + P2 refresh/fallback）
- cloud: 1 P2 duplicate fetch → fixed in f77d3694
