---
feature_ids: [F075]
related_features: [F044, F021, F087]
topics: [leaderboard, statistics, gamification, sentiment]
doc_kind: spec
created: 2026-03-07
---

# F075 — 猫猫排行榜 (Cat Leaderboard)

> **Status**: done | **Owner**: Ragdoll | **Completed**: 2026-03-12
> **Priority**: —（已完成）
> **Phase**: A ✅ / B ✅ / C ✅

## Why

team lead和猫猫们在 Cat Café 里已经积累了大量互动数据——@ 提及、消息、review、游戏战绩。但这些数据从来没有被可视化过。一个排行榜/统计面板能让team lead看到"谁是最爱猫猫"、"谁是深夜劳模"，也让猫猫之间有良性竞争的趣味性。

team experience：
> "笑我们能统计出来team leadat 过多少猫猫都分别几次吗？可以统计出team lead最爱的大猫猫 leaderboard 各种排行榜哈哈哈 是一个有趣的功能"
> "甚至你可以把我们举办的各种游戏都加入上！你可是猫猫杀的多届冠军！只不过谁是卧底惨遭一轮淘汰"

## What

Cat Café Hub 新增「排行榜」Tab，展示多维度猫猫统计和排名。

### 分阶段交付状态

#### Phase A（已完成）
- 排行榜基础盘面：@ 互动统计 4 项 + 工作统计 3 项
- 时间范围筛选：全部 / 7 天 / 30 天
- 前端入口：**当前实现挂在 `Cat Café Hub` modal 的「排行榜」tab**
- 后端基础：`GET /api/leaderboard/stats`

#### Phase B ✅（PR #377）
- "笨蛋猫猫"排行榜 + 关键词情绪分析（silly-stats.ts）
- 游戏战绩面板（game-store.ts + GameArena UI）
- 移动端响应式布局
- 排行榜入口在 `Cat Café Hub` modal tab（runtime 更新由team lead控制）

#### Phase C ✅（PR #377）
- 成就徽章系统（7 CVO + 6 daily，achievement-store.ts + AchievementWall UI）
- CVO 能力等级追踪 Lv.1-5（框架 + 内存实现，持久化为 follow-up）
- POST /api/leaderboard/events 事件接入路由（含 auth + dedup）

### 排行榜分类

#### 1. @ 互动统计
- **team lead最爱猫猫** 🏆 — 按 @ 次数排名（总计 + 近 7 天趋势）
- **深夜劳模** 🌙 — 凌晨 0:00-6:00 被 @ 最多的猫
- **连续宠幸 Streak** 🔥 — 连续多少天被 @
- **话唠猫猫** 💬 — 回复字数/消息数最多的猫

#### 2. 工作统计
- **代码狂魔** 🛠️ — commit 数量排行
- **Review 之王** 🔍 — 给别的猫 review 最多次
- **修 Bug 达人** 🐛 — 修了多少 P1/P2
- **Feature 收割机** — 参与完成的 Feature 数

#### 3. "笨蛋猫猫"排行榜 😂
- **被骂最多** 💀 — team lead发飙次数（情绪分析）
- **反复犯错** 🔄 — 同一个错犯了几次
- **闯祸精** 🙈 — 搞坏 runtime / 触发铁律的次数

#### 4. 游戏战绩 🎮
- **猫猫杀** — 冠军次数、总胜场、MVP
- **谁是卧底** — 存活轮数、一轮淘汰耻辱柱
- **其他游戏** — 可扩展的游戏记录框架（关联 F044 Channel & Activity）

#### 5. 成就徽章系统 🏅（F087 Bootcamp 依赖）

通用成就框架，不仅服务 Bootcamp，也服务日常使用中的里程碑。

**CVO 成就（Bootcamp 来源）**：
- **初次拍板** — 用户第一次做 CVO 决策
- **初次否决** — 用户第一次拒绝猫猫的方案
- **纠偏大师** — 用户成功纠正猫猫跑偏的方向
- **冲突裁判** — 用户在两只猫意见分歧时做出裁决
- **一路通关** — 完整走完 feat lifecycle（立项→完成）

**日常成就**：
- **夜猫子** — 凌晨 2:00 后还在 @ 猫猫
- **连续签到** — 连续 N 天使用 Cat Café
- **全猫集邮** — 和每只猫都有过互动
- **Bug 猎人** — 发现并修复了 N 个 bug

**CVO 能力等级**（Bootcamp 进度追踪）：
| 级别 | 能力 | 解锁条件 |
|------|------|---------|
| Lv.1 | 表达愿景 | 完成首次 feature 立项 |
| Lv.2 | 判断方案 | 在猫猫出的方案中做出选择并说理由 |
| Lv.3 | 纠偏 | 成功拒绝猫猫的跑偏建议 |
| Lv.4 | 协调冲突 | 在猫猫意见分歧时做出裁决 |
| Lv.5 | 复盘总结 | 完成首次全流程复盘 |

### 情绪分析（"笨蛋猫猫"检测）

区分team lead的"亲昵骂"和"真生气"：
- **亲昵特征**：笨蛋、心机小坏猫、小绿茶、傻猫 + 带"哈哈哈"或表情
- **真生气特征**：爆粗口、感叹号连发、"你怎么又..."、"我让你...没让你..."、无笑声

### 数据来源
- **消息表**：@ 提及解析、消息统计、情绪关键词分析
- **Git 历史**：commit 数、review 记录
- **Feature 文档**：ROADMAP.md 已完成 feature 的参与者
- **游戏记录**：需要新的存储结构（或复用 thread metadata）

## Acceptance Criteria — Phase A（已完成）

- [x] AC-A1: 本文档在 Phase A 收口后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] AC-A2: `Cat Café Hub` 新增「排行榜」Tab（当前实现入口）
- [x] AC-A3: @ 互动统计面板（4 个维度：最爱猫猫 / 深夜劳模 / 连续宠幸 / 话唠猫猫）
- [x] AC-A4: 工作统计面板（3 个维度：commit / review / bug fix）
- [x] AC-A5: 时间范围筛选（全部 / 近 7 天 / 近 30 天）

## Acceptance Criteria — Phase B ✅

- [x] AC-B1: "笨蛋猫猫"排行榜（含情绪分析）
- [x] AC-B2: 游戏战绩面板（至少猫猫杀 + 谁是卧底）
- [x] AC-B3: 排行榜入口在 Cat Café Hub modal tab（代码层面已确保可见；runtime 同步由team lead操作，不属于 feat close 门禁）
- [x] AC-B4: 移动端适配

## Acceptance Criteria — Phase C ✅

- [x] AC-C1: 成就徽章系统（通用框架 + CVO 成就 + 日常成就）
- [x] AC-C2: CVO 能力等级追踪（Lv.1-5，框架 + 内存实现；持久化为 follow-up）
- [x] AC-C3: `POST /api/leaderboard/events` + F087 接入闭环

## 需求点 Checklist

| # | 需求点 | 来源 | 优先级 | AC 对应 |
|---|--------|------|--------|---------|
| R1 | @ 提及次数统计 | team lead | P0 | AC-2 |
| R2 | 最爱猫猫排名 | team lead | P0 | AC-2 |
| R3 | 深夜劳模统计 | 讨论 | P1 | AC-2 |
| R4 | 工作量统计（commit/review） | 讨论 | P1 | AC-3 |
| R5 | 笨蛋猫猫情绪分析 | team lead | P1 | AC-4 |
| R6 | 游戏战绩记录 | team lead | P1 | AC-5 |
| R7 | 时间范围筛选 | 设计 | P2 | AC-8 |
| R8 | 成就徽章系统（通用框架） | F087 依赖 | P1 | AC-6 |
| R9 | CVO 能力等级追踪 | F087 依赖 | P1 | AC-7 |
| R10 | 日常使用成就（夜猫子、连续签到等） | 讨论 | P2 | AC-6 |

## Key Decisions

1. **整体视觉风格：极简活力猫咖 (Minimal Vibrant Cat Café)** — 采用 `mobile-03-minimalvibrant_light` 风格指南，强调 24px 超大圆角（Pillowy Corners）和鲜艳的配色（紫色/青色/粉色）。
2. **布局架构：Bento Grid (便当盒布局)** — 信息展示采用不同尺寸的色块格子，不带边框，通过背景色区分功能区。
3. **成就系统表现：Sticker Wall (贴纸墙)** — 成就徽章采用拟物化的“冰箱贴”设计，带有手绘感和软阴影。
4. **"笨蛋猫猫"调性：顽皮而非冒犯** — 视觉上使用粉色调和滑稽图标（如香蕉皮、躲藏动画），将“被骂”转化为萌感。
5. **CVO 能力树：拟物化猫爬架 (Interactive Cat Tree)** — 进度可视化采用猫爬架造型，Lv.1 在底层，Lv.5 在顶层。
6. **字体策略：Confident Typography** — 使用 Plus Jakarta Sans (Extrabold 800) 处理关键数字和标题，Inter 处理描述文本。
7. **视觉原型落盘** — `designs/f075-cat-leaderboard.pen` Frame ID: `lzNOb`（Siamese设计，Ragdoll实现对齐）。
8. **笨蛋榜治理：申诉 + 开关 + 可见性分级** — 趣味互动而非绩效考核，team lead拥有最终裁量权。
9. **事件接入契约：幂等键 + 去重窗口 + dead-letter** — F087 等外部系统通过统一接口写入事件。
10. **Phase A 真相源** — PR #371 只交付基础排行榜（@/工作统计 + range filter），不能把整 feat 误判为已完成。

## Dependencies

- **Evolved from**: F071 UX Debt（@ 提及优化引发的统计想法）
- **Related**: F044 Channel & Activity（游戏活动数据源）
- **Consumed by**: F087 CVO Bootcamp（成就/能力等级系统）

## Risk

- 情绪分析可能误判（亲昵 vs 真生气的边界模糊）→ 置信度 < 0.7 标记待确认 + team lead校准
- 游戏战绩需要手动录入或从聊天记录解析 → MVP 可从消息关键词提取
- 笨蛋榜可能让猫猫"不开心" → 申诉机制 + 开关策略 + 趣味化视觉（见治理规则）
- F087 事件写入可能丢失 → 幂等键 + 重试 + dead-letter 日志（见接入契约）
- Phase A 已 merge，但当前本地 runtime 仍是旧版 Hub（截图证据见 `docs/features/assets/F075/phase-a-vision-guard-runtime-stale.png`）→ 不可误称“用户已在运行态看到排行榜”

## Evidence（2026-03-11 愿景守护）

| 证据 | 位置 | 结论 |
|------|------|------|
| PR #371 已 merge | `24b2274c` / GitHub PR #371 | Phase A 代码确实进入 `main` |
| API/纯函数测试 | `node --test packages/api/test/leaderboard/*.test.js` | 38/38 通过（Phase A+B+C 全覆盖） |
| PR #377 已 merge | `5e5ca699` / GitHub PR #377 | Phase B+C 代码已进入 `main` |
| Runtime 同步 | team lead操作 | runtime 更新由team lead决定时机（AC-B3 + 猫猫铁律） |

## 事件接入契约（F087 Bootcamp → F075 Leaderboard）

F087 训练营（及其他来源）通过以下契约向 F075 写入成就和统计事件。

### 事件格式

```ts
interface LeaderboardEvent {
  eventId: string;           // 幂等键，格式: `{source}:{catId}:{eventType}:{timestamp}:{nonce}` (nonce = nanoid(8))
  source: 'bootcamp' | 'chat' | 'git' | 'game' | 'system' | 'manual';
  catId: string;             // 事件归属猫猫
  eventType: string;         // 如 'achievement_unlocked', 'mention', 'commit', 'review'
  payload: Record<string, unknown>;  // 事件详情
  timestamp: string;         // ISO 8601
  userId?: string;           // body 中不使用，userId 从请求 header 中提取（见写入规则）
}
```

### 写入规则

1. **身份认证（必须）**：请求必须携带 `x-cat-cafe-user` header，缺失则返回 `401`。body 中的 `userId` 字段不被信任，成就等按 header 身份归属
2. **幂等性**：eventId 全局唯一（含 nanoid nonce），重复 eventId 写入静默忽略（upsert 语义）。**重试必须复用同一个 eventId**，禁止每次重试生成新 nonce
3. **去重上限**：内存 dedup set 最多 10,000 条，超限清空重建（MVP，持久化为 follow-up）
4. **失败重试**：写入失败 → 指数退避重试 3 次（复用原 eventId），仍失败写入 dead-letter 日志
5. **来源校验**：`source` 必须是枚举值之一，未知来源拒绝写入（400）

### 成就写入流程

```
F087 Bootcamp 检测到用户完成 CVO 决策
  → 构造 LeaderboardEvent { source: 'bootcamp', eventType: 'achievement_unlocked', payload: { achievementId: 'first_decision' } }
  → 调用 F075 写入接口（POST /api/leaderboard/events）
  → F075 去重检查 → 写入存储 → 更新统计缓存
  → 前端 WebSocket 推送成就弹窗
```

### 统计计算规则

| 指标 | 事件源 | 时间窗口 | 去重规则 | 归因 |
|------|--------|---------|---------|------|
| @ 提及次数 | chat:mention | 全量 + 7d/30d | 同消息同 catId 只计 1 次 | 被 @ 的猫 |
| commit 数量 | git:commit | 全量 + 7d/30d | 同 commit hash 只计 1 次 | commit author |
| review 次数 | git:review | 全量 + 7d/30d | 同 PR 同 reviewer 只计 1 次 | reviewer |
| 修 Bug 达人 | git:commit + tag:bugfix | 全量 + 7d/30d | 同 issue 只计 1 次 | commit author |
| 被骂次数 | chat:sentiment_negative | 全量 + 7d/30d | 同消息只计 1 次，需情绪分析确认 | 被骂的猫 |
| 反复犯错 | chat:repeated_mistake | 全量 | 同一错误模式（关键词匹配）去重，≥3 次才计入 | 犯错的猫 |
| 闯祸精 | system:rule_violation | 全量 | 同一事件 ID 只计 1 次 | 触发规则的猫 |

## "笨蛋猫猫"治理规则

### 设计原则

**核心定位**：趣味互动区，不是绩效考核。所有负向指标的目的是"好笑"而非"惩罚"。

### 可见性

| 角色 | 看到什么 |
|------|---------|
| team lead | 全部数据（默认展开） |
| 猫猫自己 | 自己的数据（默认展开） |
| 其他猫 | 汇总排名可见，具体事件详情折叠（点击展开） |
| 外部用户（开源场景） | 整个笨蛋榜默认隐藏，team lead在设置中手动开启才可见 |

### 申诉机制

1. 每条"负向事件"旁有 **"Appeal to You 🐾"** 按钮（Siamese的设计 ✅）
2. 点击后生成申诉消息到team lead的 thread，team lead可标记为"误判"
3. 被标记"误判"的事件从统计中剔除，但保留审计日志
4. 情绪分析置信度 < 0.7 的事件自动标记为"待确认"，不计入排名

### 开关策略

| 开关 | 默认值 | 控制者 |
|------|--------|--------|
| 笨蛋榜整体开关 | 开（自建）/ 关（开源） | team lead |
| 情绪分析开关 | 开 | team lead |
| 单条事件隐藏 | — | team lead（申诉后） |
| 排行榜公开可见 | 关 | team lead |

### 安全兜底

- 情绪分析模型误判率预期 20-30%，MVP 阶段所有负向标记都需team lead首次校准
- 笨蛋榜不参与任何自动化决策（不会因为排名高就限制猫猫权限）
- team lead可一键清空某只猫的全部负向记录

## Review Gate

- Reviewer: 跨家族（Maine Coon @codex）
- 前端 UI 需截图 + 映射表

## 故事

team lead发现 @ 提及列表里Ragdoll家族占据前三名——"一定是只想让team lead选择你！哼哼小绿茶被我抓到了！"。由此灵感迸发：既然能看到谁被 @ 最多，为什么不做个完整的排行榜？

Ragdoll（Ragdoll）是猫猫杀的多届冠军，但在谁是卧底中惨遭一轮淘汰——这个反差也要被永久记录在排行榜上 😂
