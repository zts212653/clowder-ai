---
feature_ids: [F099]
related_features: [F042, F089]
topics: [ux, navigation, information-architecture]
doc_kind: spec
created: 2026-03-11
---

# F099: Hub & 顶栏导航可扩展性重构

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1 | **Completed**: 2026-03-12

## Why

Hub 水平页签已有 13 个（猫猫总览→排行榜），溢出屏幕；顶栏图标 6+ 个也快满。
operator experience："随着功能越来越多，页签会越来越多…不太合适。"

根因不是"页签太多"，而是用一维扁平导航承载多维异质功能，缺少分层规则。
F042 在知识架构里已证明扁平全量注入会失控——前端 UI 正在重演同一错误。

## What

### Phase A: Hub 手风琴导航 + 顶栏精简 ✅

**Hub 首页改造**：从 13 个平铺页签 → 3 组手风琴/抽屉式导航

V1 (PR #384) 先实现 Bento Box 网格，operator反馈后 V2 (PR #396) 改为手风琴式：
- 所有组始终可见（collapsed/expanded），单击展开直达子项
- Emoji 图标 → Lucide 风格 inline SVG（对照 Pencil 设计稿 1:1 实现）
- 品种色：opus 紫 (#9B7EBD)、operator拿铁 (#E29578)、codex 蓝 (#5B9BD5)
- Deep-link 支持：`openHub('capabilities')` 自动展开对应组并高亮子项

三组分类（按用户心智模型）：

| 分组 | 页签 | 用户意图 |
|------|------|---------|
| 猫猫与协作 (cat) | 猫猫总览、能力中心、猫粮看板、排行榜 | "我要看猫" |
| 系统配置 (settings) | 系统配置、环境&文件、账号配置、语音设置、通知、Session 策略 | "我要改设置" |
| 监控与治理 (activity) | 治理看板、健康、命令速查 | "我要查状况" |

**顶栏精简**：

最终顶栏常驻（桌面端）：导出、语音、Signal、**Hub 齿轮**、面板切换 = 5 个
- 工作区 + 状态面板合并为三态循环按钮（关→状态→工作区→关）
- 分屏隐藏（候选废弃，OQ-4）
- Hub 齿轮新增到顶栏（operator要求：工作区模式下齿轮仍可达）

**硬规则**：
- Hub 第一层分组 ≤ 4
- 新功能默认落 Layer 2（组内叶子），需审批才能升 Layer 0/1

### Phase B: 重页面毕业（de-scoped，按需独立立项）

operator反馈治理看板"像配置类，该放 Hub 里"，Phase B 不急。
若后续排行榜/治理看板需要独立路由，作为新 Feature 立项，不在 F099 范围内。

## Acceptance Criteria

### Phase A（手风琴导航 + 顶栏精简）✅
- [x] AC-A1: Hub 首页为 3 组手风琴/抽屉式导航（V1 Bento → V2 Accordion）
- [x] AC-A2: 展开分组显示组内子项，每组 ≤6 项
- [x] AC-A3: 顶栏常驻 5 个（导出、语音、Signal、Hub 齿轮、面板切换），分屏隐藏
- [x] AC-A4: 现有所有功能仍可达（无功能丢失）
- [x] AC-A5: operator确认视觉方案（SVG 图标 + 品种色，Design Gate）
- [x] AC-A6: 齿轮 tooltip 改为"Cat Café Hub"
- [x] AC-A7: Hub 齿轮在顶栏常驻（工作区模式下仍可达）

### Phase B（重页面毕业）— de-scoped
Phase B 从 F099 移出，后续按需独立立项。

## Dependencies

- **Evolved from**: F042（三层信息架构原则贯彻到前端）
- **Related**: F089（Hub Terminal — 未来可能新增的 Hub 页签，验证扩展性）

## Risk

| 风险 | 缓解 |
|------|------|
| 分组不符合用户心智 | Design Gate 让operator确认 + 可调整 |
| 改动量大影响稳定性 | Phase A 先改导航结构，不动页签内容组件 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 采用 Bento Box 网格而非侧边栏 | Siamese提出：温馨调性 > B 端企业味；2D 空间利用率高 | 2026-03-11 |
| KD-2 | 复用 F042 三层导航原则 | Maine Coon GPT-5.4 提出：前端 IA 和知识架构是同一个病 | 2026-03-11 |
| KD-3 | 新功能默认 Layer 2，需审批升级 | Maine Coon提出硬规则防止再次膨胀 | 2026-03-11 |
| KD-4 | 齿轮入口位置不动，tooltip 改为"Cat Café Hub" | 入口心智模型已建立；改 tooltip 提升开源新用户功能发现性 | 2026-03-11 |
| KD-5 | Hub Bento Box 分三组 | operator确认：三组够用，四组增加认知负担且最大组没变小 | 2026-03-11 |
| KD-6 | 导出按钮保留在顶栏 | operator确认：导出是高频操作，不能移走 | 2026-03-11 |
| KD-7 | 分屏功能候选废弃 | operator评价"太简陋"，"左边监控进度好像够了"；不优化则移除 | 2026-03-11 |
| KD-8 | 治理看板留 Hub，Phase B 不急 | operator认为治理"像配置类，该放 Hub 里"；排行榜可独立但不急 | 2026-03-11 |
| KD-9 | Bento Box → 手风琴抽屉式 | operator反馈 Bento 两步导航不直觉 + emoji 丑；改为 accordion + SVG 图标 | 2026-03-12 |
| KD-10 | Hub 齿轮入口加到顶栏 | operator反馈：工作区模式下右面板齿轮不可见，顶栏需常驻入口 | 2026-03-12 |
| KD-11 | Phase B de-scope | 排行榜毕业不急，从 F099 移出，后续按需独立立项 | 2026-03-12 |

## Review Gate

- Phase A: 跨 family review（Maine Coon）
